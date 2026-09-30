import os
import secrets

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from . import activity, auth, db, hub

router = APIRouter(prefix="/api")


def _members(chat_id: int):
    return db.rows("SELECT user_id FROM chat_members WHERE chat_id=?", (chat_id,))


def _last_message(chat_id: int):
    return db.one(
        "SELECT m.*, u.username, u.nickname, u.avatar FROM messages m LEFT JOIN users u ON u.id=m.user_id "
        "WHERE m.chat_id=? ORDER BY m.id DESC LIMIT 1", (chat_id,))


def _unread(chat_id: int, user_id: int):
    r = db.one("SELECT last_id FROM reads WHERE chat_id=? AND user_id=?", (chat_id, user_id))
    last = r["last_id"] if r else 0
    return db.one("SELECT COUNT(*) c FROM messages WHERE chat_id=? AND id>? "
                  "AND COALESCE(user_id,0)!=?",
                  (chat_id, last, user_id))["c"]


def member_role(chat_id: int, user) -> str:
    if not user:
        return None
    m = db.one("SELECT role FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, user["id"]))
    return m["role"] if m else None


def can_post(chat: dict, user) -> bool:
    if chat["type"] == "activity":
        return False
    role = member_role(chat["id"], user)
    if not role:
        return False
    if chat["type"] == "channel" and role == "member":
        return False
    return True


def can_manage(chat: dict, user) -> bool:
    """Админ и владелец: настройки чата, добавление/удаление участников (кроме админов)."""
    return member_role(chat["id"], user) in ("owner", "admin")


def can_touch_role(chat: dict, user, target_role: str) -> bool:
    """Права администратора не распространяются на других админов и на владельца."""
    role = member_role(chat["id"], user)
    if role == "owner":
        return True
    if role == "admin":
        return target_role == "member"
    return False


def chat_brief(chat: dict, user) -> dict:
    out = {
        "id": chat["id"], "type": chat["type"], "title": chat["title"], "avatar": chat["avatar"],
        "description": chat["description"], "link": chat["link"], "owner_id": chat["owner_id"],
        "members_count": db.one("SELECT COUNT(*) c FROM chat_members WHERE chat_id=?", (chat["id"],))["c"],
        "unread": 0, "last": None, "peer": None, "joined": False, "can_post": False,
        "role": None, "can_manage": False,
    }
    if user:
        out["unread"] = _unread(chat["id"], user["id"])
        mine = db.one("SELECT role FROM chat_members WHERE chat_id=? AND user_id=?",
                      (chat["id"], user["id"]))
        out["joined"] = mine is not None
        out["role"] = mine["role"] if mine else None
        out["can_post"] = can_post(chat, user)
        out["can_manage"] = can_manage(chat, user)
    last = _last_message(chat["id"])
    if last:
        out["last"] = {
            "id": last["id"], "text": last["text"], "kind": last["kind"],
            "created_at": last["created_at"], "user_id": last["user_id"],
            "username": last.get("username"),
        }
    if chat["type"] == "dm" and user:
        other = db.one(
            "SELECT u.* FROM chat_members cm JOIN users u ON u.id=cm.user_id "
            "WHERE cm.chat_id=? AND cm.user_id!=?", (chat["id"], user["id"]))
        if other:
            out["title"] = other["nickname"]
            out["peer"] = auth.public_user(other)
            out["avatar"] = other["avatar"]
    return out


def _get_chat(chat_id: int) -> dict:
    c = db.one("SELECT * FROM chats WHERE id=?", (chat_id,))
    if not c:
        raise HTTPException(404, "Чат не найден")
    return c


def _member_or_403(chat_id: int, user):
    if not user:
        raise HTTPException(401, "Не авторизован")
    if not db.one("SELECT 1 x FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, user["id"])):
        raise HTTPException(403, "Вы не в этом чате")
    return user


def message_payload(m: dict) -> dict:
    return {
        "id": m["id"], "chat_id": m["chat_id"], "user_id": m["user_id"], "kind": m["kind"],
        "text": m["text"], "media": m["media"], "created_at": m["created_at"],
        "author": {"username": m.get("username"), "nickname": m.get("nickname"), "avatar": m.get("avatar")},
    }


def chat_unread(user_id: int) -> int:
    return db.one(
        "SELECT COUNT(*) c FROM messages m "
        "JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=? "
        "LEFT JOIN reads r ON r.chat_id=m.chat_id AND r.user_id=? "
        "WHERE m.id > COALESCE(r.last_id, 0) AND COALESCE(m.user_id,0) <> ?",
        (user_id, user_id, user_id))["c"]


@router.get("/unread")
def unread(user=Depends(auth.current_user)):
    return {"chats": chat_unread(user["id"])}


@router.get("/chats")
def my_chats(user=Depends(auth.current_user)):
    """Список чатов одним набором запросов: без per-chat выборок (быстро на слабом сервере)."""
    activity.ensure_chat(user["id"])
    list_ = db.rows(
        "SELECT c.* FROM chats c JOIN chat_members m ON m.chat_id=c.id WHERE m.user_id=? "
        "ORDER BY c.id DESC", (user["id"],))
    if not list_:
        return {"items": []}
    uid = user["id"]
    ids = [c["id"] for c in list_]
    ph = ",".join("?" * len(ids))
    roles = {r["chat_id"]: r["role"] for r in db.rows(
        f"SELECT chat_id, role FROM chat_members WHERE user_id=? AND chat_id IN ({ph})",
        (uid, *ids))}
    counts = {r["chat_id"]: r["c"] for r in db.rows(
        f"SELECT chat_id, COUNT(*) c FROM chat_members WHERE chat_id IN ({ph}) GROUP BY chat_id",
        ids)}
    lasts = {r["chat_id"]: r for r in db.rows(
        "SELECT m.*, u.username FROM messages m "
        f"JOIN (SELECT chat_id, MAX(id) mid FROM messages WHERE chat_id IN ({ph}) GROUP BY chat_id) x "
        "ON x.mid=m.id LEFT JOIN users u ON u.id=m.user_id", ids)}
    unreads = {r["chat_id"]: r["c"] for r in db.rows(
        "SELECT m.chat_id, COUNT(*) c FROM messages m "
        "LEFT JOIN reads r ON r.chat_id=m.chat_id AND r.user_id=? "
        f"WHERE m.chat_id IN ({ph}) AND m.id > COALESCE(r.last_id,0) "
        "AND COALESCE(m.user_id,0) != ? GROUP BY m.chat_id", (uid, *ids, uid))}
    peers = {}
    dm_ids = [c["id"] for c in list_ if c["type"] == "dm"]
    if dm_ids:
        dph = ",".join("?" * len(dm_ids))
        for r in db.rows(
                "SELECT cm.chat_id, u.* FROM chat_members cm JOIN users u ON u.id=cm.user_id "
                f"WHERE cm.chat_id IN ({dph}) AND cm.user_id != ?", (*dm_ids, uid)):
            peers[r["chat_id"]] = r
    items = []
    for c in list_:
        role = roles.get(c["id"])
        last = lasts.get(c["id"])
        b = {
            "id": c["id"], "type": c["type"], "title": c["title"], "avatar": c["avatar"],
            "description": c["description"], "link": c["link"], "owner_id": c["owner_id"],
            "members_count": counts.get(c["id"], 0), "unread": unreads.get(c["id"], 0),
            "last": None, "peer": None, "joined": role is not None, "role": role,
            "can_post": bool(role) and c["type"] != "activity"
                        and not (c["type"] == "channel" and role == "member"),
            "can_manage": role in ("owner", "admin"),
        }
        if last:
            b["last"] = {
                "id": last["id"], "text": last["text"], "kind": last["kind"],
                "created_at": last["created_at"], "user_id": last["user_id"],
                "username": last.get("username"),
            }
        if c["type"] == "dm":
            other = peers.get(c["id"])
            if other:
                b["title"] = other["nickname"]
                b["peer"] = auth.public_user(other)
                b["avatar"] = other["avatar"]
            if b["last"] is None and b["peer"]:
                continue
        items.append(b)
    items.sort(key=lambda x: (x["last"]["created_at"] if x["last"] else 0), reverse=True)
    return {"items": items}


@router.post("/chats")
def create_chat(body: dict, user=Depends(auth.current_user)):
    ctype = body.get("type") or "group"
    if ctype not in ("group", "channel"):
        raise HTTPException(400, "Тип: group или channel")
    title = (body.get("title") or "").strip()
    if not title or len(title) > 60:
        raise HTTPException(400, "Введите название (до 60 символов)")
    description = (body.get("description") or "").strip()[:300]
    link = secrets.token_hex(4)
    cid = db.run("INSERT INTO chats (type, title, description, link, owner_id, created_at) "
                 "VALUES (?,?,?,?,?,?)", (ctype, title, description, link, user["id"], db.now()))
    db.run("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?,?,?,?)",
           (cid, user["id"], "owner", db.now()))
    chat = db.one("SELECT * FROM chats WHERE id=?", (cid,))
    return chat_brief(chat, user)


@router.post("/chats/dm")
def open_dm(body: dict, user=Depends(auth.current_user)):
    username = (body.get("username") or "").strip().lstrip("@")
    peer = db.one("SELECT * FROM users WHERE username=?", (username,))
    if not peer:
        raise HTTPException(404, "Пользователь не найден")
    if peer["id"] == user["id"]:
        raise HTTPException(400, "Это вы")
    ex = db.one(
        "SELECT c.* FROM chats c "
        "JOIN chat_members a ON a.chat_id=c.id AND a.user_id=? "
        "JOIN chat_members b ON b.chat_id=c.id AND b.user_id=? "
        "WHERE c.type='dm' LIMIT ?", (user["id"], peer["id"], 1))
    if not ex:
        cid = db.run("INSERT INTO chats (type, title, created_at) VALUES ('dm','',?)", (db.now(),))
        for uid in (user["id"], peer["id"]):
            db.run("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?,?,?,?)",
                   (cid, uid, "member", db.now()))
        ex = db.one("SELECT * FROM chats WHERE id=?", (cid,))
    return chat_brief(ex, user)


@router.get("/chats/{chat_id}")
def chat_info(chat_id: int, user=Depends(auth.current_user)):
    c = _get_chat(chat_id)
    return chat_brief(c, user)


@router.get("/chats/{chat_id}/messages")
def messages(chat_id: int, before: int = 0, user=Depends(auth.current_user)):
    _member_or_403(chat_id, user)
    if before:
        items = db.rows(
            "SELECT m.*, u.username, u.nickname, u.avatar FROM messages m LEFT JOIN users u ON u.id=m.user_id "
            "WHERE m.chat_id=? AND m.id<? ORDER BY m.id DESC LIMIT 50", (chat_id, before))
    else:
        items = db.rows(
            "SELECT m.*, u.username, u.nickname, u.avatar FROM messages m LEFT JOIN users u ON u.id=m.user_id "
            "WHERE m.chat_id=? ORDER BY m.id DESC LIMIT 50", (chat_id,))
    items.reverse()
    return {"items": [message_payload(m) for m in items]}


def _broadcast_message(chat: dict, payload: dict):
    members = [m["user_id"] for m in _members(chat["id"])]
    brief = chat_brief(chat, None)
    brief["unread"] = 0
    hub.push(members, {"type": "message", "chat_id": chat["id"], "message": payload, "chat": brief})


@router.post("/chats/{chat_id}/send")
async def send_message(chat_id: int,
                       text: str = Form(""), kind: str = Form("text"),
                       sticker: str = Form(""), file: UploadFile = File(None),
                       user=Depends(auth.current_user)):
    chat = _get_chat(chat_id)
    _member_or_403(chat_id, user)
    if chat["type"] == "activity":
        raise HTTPException(403, "Это системный чат — сюда нельзя писать")
    if not can_post(chat, user):
        raise HTTPException(403, "Только владелец канала может публиковать")

    media = ""
    text = (text or "").strip()
    if file is not None and file.filename:
        data = await file.read()
        if len(data) > 200 * 1024 * 1024:
            raise HTTPException(413, "Файл слишком большой")
        if (file.content_type or "").startswith("video/"):
            media = auth.save_file(data, "videos", ".mp4")
            kind = "video"
        elif (file.content_type or "").startswith("image/"):
            ext = ".png" if file.content_type == "image/png" else ".jpg"
            media = auth.save_file(data, "images", ext)
            kind = "photo"
        else:
            raise HTTPException(400, "Только фото и видео")
    elif sticker:
        kind, text = "sticker", sticker
    elif not text:
        raise HTTPException(400, "Пустое сообщение")
    else:
        kind = "text"

    mid = db.run("INSERT INTO messages (chat_id, user_id, kind, text, media, created_at) "
                 "VALUES (?,?,?,?,?,?)", (chat_id, user["id"], kind, text[:4000], media, db.now()))
    m = db.one("SELECT m.*, u.username, u.nickname, u.avatar FROM messages m "
               "LEFT JOIN users u ON u.id=m.user_id WHERE m.id=?", (mid,))
    db.run("INSERT OR REPLACE INTO reads (chat_id, user_id, last_id) VALUES (?,?,?)",
           (chat_id, user["id"], mid))
    payload = message_payload(m)
    _broadcast_message(chat, payload)
    # личное сообщение: push на телефон собеседнику (само сообщение уже в чате)
    if chat["type"] == "dm":
        preview = text[:120] if kind == "text" else (
            "📷 Фото" if kind == "photo" else "🎬 Видео" if kind == "video" else "🥔 Стикер")
        for mem in _members(chat_id):
            if mem["user_id"] != user["id"]:
                activity.push_dm(mem["user_id"], user, chat_id, preview)
    return payload


@router.post("/chats/{chat_id}/read")
def read_chat(chat_id: int, user=Depends(auth.current_user)):
    _member_or_403(chat_id, user)
    last = db.one("SELECT COALESCE(MAX(id),0) m FROM messages WHERE chat_id=?", (chat_id,))["m"]
    db.run("INSERT OR REPLACE INTO reads (chat_id, user_id, last_id) VALUES (?,?,?)",
           (chat_id, user["id"], last))
    return {"ok": True}


@router.post("/chats/{chat_id}/join")
def join_chat(chat_id: int, user=Depends(auth.current_user)):
    chat = _get_chat(chat_id)
    if chat["type"] == "activity":
        raise HTTPException(400, "Это системный чат")
    if chat["type"] == "dm":
        raise HTTPException(400, "Нельзя войти в личный чат")
    if not db.one("SELECT 1 x FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, user["id"])):
        db.run("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?,?,?,?)",
               (chat_id, user["id"], "member", db.now()))
    return chat_brief(chat, user)


@router.post("/chats/{chat_id}/leave")
def leave_chat(chat_id: int, user=Depends(auth.current_user)):
    chat = _get_chat(chat_id)
    if chat["type"] == "activity":
        raise HTTPException(400, "Системный чат нельзя покинуть")
    if chat["owner_id"] == user["id"]:
        raise HTTPException(400, "Владелец не может выйти. Удалите чат.")
    db.run("DELETE FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, user["id"]))
    return {"ok": True}


@router.post("/chats/{chat_id}/members")
def add_member(chat_id: int, body: dict, user=Depends(auth.current_user)):
    chat = _get_chat(chat_id)
    _member_or_403(chat_id, user)
    if chat["type"] == "dm" or not can_manage(chat, user):
        raise HTTPException(403, "Добавлять может владелец или администратор")
    username = (body.get("username") or "").strip().lstrip("@")
    u = db.one("SELECT * FROM users WHERE username=?", (username,))
    if not u:
        raise HTTPException(404, "Пользователь не найден")
    if not db.one("SELECT 1 x FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, u["id"])):
        db.run("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?,?,?,?)",
               (chat_id, u["id"], "member", db.now()))
        hub.push([r["user_id"] for r in _members(chat_id)],
                 {"type": "chat_updated", "chat_id": chat_id})
    return chat_brief(chat, user)


@router.patch("/chats/{chat_id}")
def update_chat(chat_id: int, body: dict, user=Depends(auth.current_user)):
    chat = _get_chat(chat_id)
    _member_or_403(chat_id, user)
    if chat["type"] == "dm" or not can_manage(chat, user):
        raise HTTPException(403, "Редактировать может владелец или администратор")
    title = body.get("title")
    desc = body.get("description")
    if title is not None:
        title = title.strip()
        if not title or len(title) > 60:
            raise HTTPException(400, "Название: 1-60 символов")
        db.run("UPDATE chats SET title=? WHERE id=?", (title, chat_id))
    if desc is not None:
        db.run("UPDATE chats SET description=? WHERE id=?", (desc.strip()[:300], chat_id))
    return chat_brief(_get_chat(chat_id), user)


@router.post("/chats/{chat_id}/avatar")
async def chat_avatar(chat_id: int, file: UploadFile = File(...), user=Depends(auth.current_user)):
    chat = _get_chat(chat_id)
    _member_or_403(chat_id, user)
    if chat["type"] == "dm" or not can_manage(chat, user):
        raise HTTPException(403, "Фото меняет владелец или администратор")
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "Фото слишком большое")
    ext = ".png" if (file.content_type or "") == "image/png" else ".jpg"
    path = auth.save_file(data, "avatars", ext)
    db.run("UPDATE chats SET avatar=? WHERE id=?", (path, chat_id))
    return chat_brief(_get_chat(chat_id), user)


@router.post("/chats/{chat_id}/roles")
def set_role(chat_id: int, body: dict, user=Depends(auth.current_user)):
    """Права выдаёт только владелец, и только участникам со статусом 'member'."""
    chat = _get_chat(chat_id)
    _member_or_403(chat_id, user)
    if chat["type"] == "dm":
        raise HTTPException(400, "В личном чате ролей нет")
    if member_role(chat_id, user) != "owner":
        raise HTTPException(403, "Права администратора выдаёт только владелец")
    username = (body.get("username") or "").strip().lstrip("@")
    role = body.get("role")
    if role not in ("admin", "member"):
        raise HTTPException(400, "Роль: admin или member")
    target = db.one("SELECT * FROM users WHERE username=?", (username,))
    if not target:
        raise HTTPException(404, "Пользователь не найден")
    if target["id"] == chat["owner_id"]:
        raise HTTPException(400, "Права владельца нельзя передать")
    cur = db.one("SELECT role FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, target["id"]))
    if not cur:
        raise HTTPException(404, "Этого человека нет в чате")
    if not can_touch_role(chat, user, cur["role"]):
        raise HTTPException(403, "Администратор не может менять права других администраторов")
    db.run("UPDATE chat_members SET role=? WHERE chat_id=? AND user_id=?", (role, chat_id, target["id"]))
    hub.push([r["user_id"] for r in _members(chat_id)],
             {"type": "chat_updated", "chat_id": chat_id})
    return {"username": target["username"], "role": role}


@router.delete("/chats/{chat_id}/members/{uid}")
def remove_member(chat_id: int, uid: int, user=Depends(auth.current_user)):
    chat = _get_chat(chat_id)
    _member_or_403(chat_id, user)
    if chat["type"] == "dm":
        raise HTTPException(400, "В личном чате участников не удаляют")
    actor = member_role(chat_id, user)
    if actor not in ("owner", "admin"):
        raise HTTPException(403, "Удалять может владелец или администратор")
    target = db.one("SELECT role FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, uid))
    if not target:
        raise HTTPException(404, "Этого человека нет в чате")
    if uid == chat["owner_id"]:
        raise HTTPException(403, "Владельца нельзя удалить")
    if not can_touch_role(chat, user, target["role"]):
        raise HTTPException(403, "Администратор не может удалить другого администратора")
    others = [r["user_id"] for r in _members(chat_id) if r["user_id"] != uid]
    db.run("DELETE FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, uid))
    db.run("DELETE FROM reads WHERE chat_id=? AND user_id=?", (chat_id, uid))
    hub.push(others, {"type": "chat_updated", "chat_id": chat_id})
    hub.push([uid], {"type": "removed", "chat_id": chat_id})
    return {"ok": True, "members_count": db.one(
        "SELECT COUNT(*) c FROM chat_members WHERE chat_id=?", (chat_id,))["c"]}


@router.delete("/chats/{chat_id}")
def delete_chat(chat_id: int, user=Depends(auth.current_user)):
    chat = _get_chat(chat_id)
    if chat["type"] == "activity":
        raise HTTPException(400, "Системный чат нельзя удалить")
    if chat["type"] == "dm":
        raise HTTPException(400, "Личные чаты не удаляются")
    if chat["owner_id"] != user["id"]:
        raise HTTPException(403, "Чат удаляет только владелец")
    if chat["avatar"]:
        try:
            os.remove(os.path.join(db.MEDIA, chat["avatar"]))
        except OSError:
            pass
    members_ids = [r["user_id"] for r in _members(chat_id)]
    for t in ("messages", "reads", "chat_members"):
        db.run(f"DELETE FROM {t} WHERE chat_id=?", (chat_id,))
    db.run("DELETE FROM chats WHERE id=?", (chat_id,))
    if members_ids:
        hub.push(members_ids, {"type": "chat_deleted", "chat_id": chat_id})
    return {"ok": True}


@router.delete("/chats/{chat_id}/messages/{mid}")
def delete_message(chat_id: int, mid: int, user=Depends(auth.current_user)):
    chat = _get_chat(chat_id)
    _member_or_403(chat_id, user)
    m = db.one("SELECT * FROM messages WHERE id=? AND chat_id=?", (mid, chat_id))
    if not m:
        raise HTTPException(404, "Сообщение не найдено")
    if m["user_id"] != user["id"]:
        role = member_role(chat_id, user)
        if role not in ("owner", "admin"):
            raise HTTPException(403, "Удалять чужие сообщения может администратор")
        author_role = member_role(chat_id, {"id": m["user_id"]}) if m["user_id"] else None
        if role == "admin" and author_role in ("owner", "admin"):
            raise HTTPException(403, "Администратор не может удалить сообщение другого администратора")
    db.run("DELETE FROM messages WHERE id=?", (mid,))
    hub.push([r["user_id"] for r in _members(chat_id)],
             {"type": "deleted", "chat_id": chat_id, "message_id": mid})
    return {"ok": True}


@router.get("/chats/{chat_id}/members")
def members(chat_id: int, user=Depends(auth.current_user)):
    _member_or_403(chat_id, user)
    items = db.rows(
        "SELECT u.id, u.username, u.nickname, u.avatar, m.role FROM chat_members m "
        "JOIN users u ON u.id=m.user_id WHERE m.chat_id=? ORDER BY m.joined_at", (chat_id,))
    return {"items": items}


@router.get("/chat-by-link/{link}")
def chat_by_link(link: str, user=Depends(auth.current_user)):
    c = db.one("SELECT * FROM chats WHERE link=?", (link,))
    if not c:
        raise HTTPException(404, "Чат не найден")
    return chat_brief(c, user)
