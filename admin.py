"""Админ-панель: список пользователей, баны, запрет публикаций, жалобы и журнал действий."""
import json
import os
import time

from fastapi import APIRouter, Depends, HTTPException

from . import actions, auth, db, hub

router = APIRouter(prefix="/api/admin")

HOUR = 3600


def admin_user(user=Depends(auth.current_user)):
    if not user.get("is_admin"):
        raise HTTPException(403, "Только для администратора")
    return user


def superadmin_user(user=Depends(auth.current_user)):
    """Главный администратор: полный доступ, включая выдачу админки и верификацию."""
    if not user.get("is_admin") or not user.get("is_superadmin"):
        raise HTTPException(403, "Только для главного администратора")
    return user


def _target(uid: int) -> dict:
    u = db.one("SELECT * FROM users WHERE id=?", (uid,))
    if not u:
        raise HTTPException(404, "Пользователь не найден")
    return u


def _user_brief(u) -> dict:
    return {"id": u["id"], "username": u["username"], "nickname": u["nickname"]}


def _apply(mode: str, hours: int) -> int:
    """mode: perm | temp | unban -> значение banned_until."""
    if mode == "perm":
        return -1
    if mode == "temp":
        return int(time.time()) + max(1, int(hours or 24)) * HOUR
    if mode == "unban":
        return 0
    raise HTTPException(400, "mode: perm, temp или unban")


def _relink(table: str, row: dict) -> None:
    """Вернуть удалённую запись в таблицу с тем же id, если он свободен."""
    cols = list(row.keys())
    exists = db.one(f"SELECT 1 x FROM {table} WHERE id=?", (row.get("id"),))
    if exists:
        row = {k: v for k, v in row.items() if k != "id"}
    ph = ",".join("?" * len(cols))
    db.run(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({ph})", tuple(row.values()))


@router.get("/stats")
def stats(admin=Depends(admin_user)):
    return {
        "users": db.one("SELECT COUNT(*) c FROM users")["c"],
        "videos": db.one("SELECT COUNT(*) c FROM videos")["c"],
        # WebSocket в эфире важнее last_seen: зритель может часами не делать HTTP-запросов
        "online": len({r["id"] for r in db.rows(
            "SELECT id FROM users WHERE last_seen >= ?", (int(time.time()) - 90,))}
            | hub.online_ids()),
        "banned": db.one("SELECT COUNT(*) c FROM users WHERE banned_until=-1 OR banned_until > ?",
                         (int(time.time()),))["c"],
        "reports_open": db.one(
            "SELECT COUNT(*) c FROM reports WHERE status='open'")["c"],
        "streams": db.one(
            "SELECT COUNT(*) c FROM live_streams WHERE ended_at IS NULL")["c"],
    }


@router.get("/users")
def users(q: str = "", limit: int = 100, admin=Depends(admin_user)):
    limit = max(1, min(limit, 300))
    now = int(time.time())
    like = f"%{(q or '').strip()}%"
    rows = db.rows(
        "SELECT u.id, u.username, u.nickname, u.avatar, u.is_admin, u.is_superadmin, u.verified, "
        "u.banned_until, u.posts_banned_until, u.last_seen, u.created_at, "
        "(SELECT COUNT(*) FROM videos v WHERE v.user_id=u.id) videos "
        "FROM users u "
        "WHERE (? = '' OR u.username LIKE ? OR u.nickname LIKE ?) "
        "ORDER BY (u.last_seen >= ?) DESC, u.id DESC LIMIT ?",
        (q or "", like, like, now - 90, limit))
    for r in rows:
        r["online"] = hub.online(r["id"]) or bool(r["last_seen"] and now - r["last_seen"] <= 90)
        r["banned"] = r["banned_until"] == -1 or r["banned_until"] > now
        r["banned_forever"] = r["banned_until"] == -1
        r["posts_blocked"] = r["posts_banned_until"] == -1 or r["posts_banned_until"] > now
        r["posts_forever"] = r["posts_banned_until"] == -1
        r["is_admin"] = bool(r["is_admin"])
        r["is_super"] = bool(r["is_superadmin"])
        r["verified"] = bool(r["verified"])
    return {"items": rows, "now": now}


@router.post("/users/{uid}/verify")
def verify(uid: int, body: dict, admin=Depends(superadmin_user)):
    """Выдать/снять галочку верификации. Только для главного администратора."""
    u = _target(uid)
    on = bool(body.get("on"))
    db.run("UPDATE users SET verified=? WHERE id=?", (1 if on else 0, uid))
    if on != bool(u["verified"]):
        actions.log(admin["id"], "verify", "user", uid,
                    {"on": on, "username": u["username"]})
    return {"ok": True, "verified": on}


@router.post("/grant")
def grant_admin(body: dict, admin=Depends(superadmin_user)):
    """Выдать/снять админку по юзернейму. Только для главного администратора."""
    username = (body.get("username") or "").strip().lstrip("@")
    on = bool(body.get("on", True))
    if not username:
        raise HTTPException(400, "Введите юзернейм")
    u = db.one("SELECT * FROM users WHERE username=?", (username,))
    if not u:
        raise HTTPException(404, "Пользователь не найден")
    if u["id"] == admin["id"]:
        raise HTTPException(400, "Нельзя забрать админку у самого себя")
    db.run("UPDATE users SET is_admin=? WHERE id=?", (1 if on else 0, u["id"]))
    actions.log(admin["id"], "grant_admin" if on else "revoke_admin", "user", u["id"],
                {"on": on, "username": u["username"]})
    return {"ok": True, "username": u["username"], "is_admin": on}


@router.post("/users/{uid}/ban")
def ban(uid: int, body: dict, admin=Depends(admin_user)):
    u = _target(uid)
    if u["id"] == admin["id"]:
        raise HTTPException(400, "Нельзя забанить самого себя")
    prev = u["banned_until"]
    value = _apply((body.get("mode") or ""), body.get("hours") or 0)
    db.run("UPDATE users SET banned_until=? WHERE id=?", (value, uid))
    if value != 0:
        db.run("DELETE FROM tokens WHERE user_id=?", (uid,))
    if prev != value:
        actions.log(admin["id"], "ban", "user", uid,
                    {"prev": prev, "new": value, "username": u["username"]})
    return {"ok": True, "banned_until": value,
            "banned": value == -1 or value > int(time.time())}


@router.post("/users/{uid}/posts")
def posts_ban(uid: int, body: dict, admin=Depends(admin_user)):
    u = _target(uid)
    prev = u["posts_banned_until"]
    value = _apply((body.get("mode") or ""), body.get("hours") or 0)
    db.run("UPDATE users SET posts_banned_until=? WHERE id=?", (value, uid))
    if prev != value:
        actions.log(admin["id"], "posts_ban", "user", uid,
                    {"prev": prev, "new": value, "username": u["username"]})
    return {"ok": True, "posts_banned_until": value,
            "blocked": value == -1 or value > int(time.time())}


# ---------- жалобы пользователей ----------
@router.get("/reports")
def reports(status: str = "open", admin=Depends(admin_user)):
    if status not in ("open", "done", "all"):
        status = "open"
    where, args = ("", ()) if status == "all" else ("WHERE r.status=?", (status,))
    rows = db.rows(
        "SELECT r.*, u.username AS reporter, u.nickname AS reporter_nick "
        "FROM reports r LEFT JOIN users u ON u.id=r.reporter_id " + where +
        " ORDER BY r.id DESC LIMIT 200", args)
    for r in rows:
        r["target"] = None
        if r["kind"] == "post":
            r["target"] = db.one(
                "SELECT v.id, v.kind, v.caption, v.media, v.thumb, v.user_id, u.username AS owner "
                "FROM videos v JOIN users u ON u.id=v.user_id WHERE v.id=?", (r["target_id"],))
        elif r["kind"] == "comment":
            r["target"] = db.one(
                "SELECT c.id, c.text, c.media, c.video_id, c.user_id, u.username AS owner "
                "FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=?", (r["target_id"],))
    return {"items": rows, "open": db.one(
        "SELECT COUNT(*) c FROM reports WHERE status='open'")["c"]}


@router.post("/reports/{rid}/resolve")
def resolve_report(rid: int, body: dict, admin=Depends(admin_user)):
    r = db.one("SELECT * FROM reports WHERE id=?", (rid,))
    if not r:
        raise HTTPException(404, "Жалоба не найдена")
    action = body.get("action") or "close"
    if action not in ("delete", "close"):
        raise HTTPException(400, "action: delete или close")
    prev = r["status"]
    if action == "delete":
        t = None
        if r["kind"] == "post":
            v = db.one("SELECT * FROM videos WHERE id=?", (r["target_id"],))
            if v:
                t = {**_user_brief(db.one("SELECT * FROM users WHERE id=?", (v["user_id"],)) or {}),
                     "caption": v["caption"]}
                try:
                    extra = json.loads(v.get("extra_media") or "[]")
                except Exception:
                    extra = []
                files = [v["media"], v.get("thumb") or ""] + [p for p in extra if isinstance(p, str)]
                detail = {"row": dict(v), "files": files, "summary": v["caption"] or "[медиа]",
                          "owner": (t or {}).get("username"), "reason": r.get("reason") or ""}
                aid = actions.log(admin["id"], actions.ACTION_DELETE_VIDEO, "video",
                                  v["id"], detail)
                actions.trash_paths(files, aid)
                db.run("DELETE FROM videos WHERE id=?", (v["id"],))
        else:
            c = db.one("SELECT * FROM comments WHERE id=?", (r["target_id"],))
            if c:
                owner = db.one("SELECT username FROM users WHERE id=?", (c["user_id"],))
                files = [c.get("media") or ""]
                detail = {"row": dict(c), "files": files,
                          "summary": c["text"][:200], "owner": (owner or {}).get("username"),
                          "reason": r.get("reason") or ""}
                aid = actions.log(admin["id"], actions.ACTION_DELETE_COMMENT, "comment",
                                  c["id"], detail)
                actions.trash_paths(files, aid)
                db.run("DELETE FROM comments WHERE id=?", (c["id"],))
        db.run("UPDATE reports SET status='done' "
               "WHERE id=? OR (kind=? AND target_id=? AND status='open')",
               (rid, r["kind"], r["target_id"]))
        return {"ok": True, "action": "delete"}

    # закрытие без удаления — можно отменить
    db.run("UPDATE reports SET status='done' "
           "WHERE id=? OR (kind=? AND target_id=? AND status='open')",
           (rid, r["kind"], r["target_id"]))
    actions.log(admin["id"], actions.ACTION_CLOSE, "report", rid,
                {"prev": prev, "kind": r["kind"], "target_id": r["target_id"],
                 "reason": r.get("reason") or ""})
    return {"ok": True, "action": "close"}


# ---------- журнал действий модерации ----------
@router.get("/actions")
def actions_list(limit: int = 60, admin=Depends(admin_user)):
    rows = db.rows(
        "SELECT a.*, u.username AS actor, u.nickname AS actor_nick "
        "FROM admin_actions a LEFT JOIN users u ON u.id=a.actor_id "
        "ORDER BY a.id DESC LIMIT ?", (max(1, min(limit, 200)),))
    for r in rows:
        try:
            r["detail"] = json.loads(r["detail"] or "{}")
        except Exception:
            r["detail"] = {}
        r["undoable"] = bool(r["undoable"])
        r["undone"] = bool(r["reversed_at"])
    return {"items": rows}


@router.post("/actions/{aid}/undo")
def undo(aid: int, admin=Depends(admin_user)):
    a = db.one("SELECT * FROM admin_actions WHERE id=?", (aid,))
    if not a:
        raise HTTPException(404, "Действие не найдено")
    if a["reversed_at"]:
        raise HTTPException(400, "Уже отменено")
    try:
        d = json.loads(a["detail"] or "{}")
    except Exception:
        raise HTTPException(400, "Повреждённая запись")

    act = a["action"]
    if act == actions.ACTION_BAN:
        db.run("UPDATE users SET banned_until=? WHERE id=?", (int(d.get("prev", 0)), a["target_id"]))
    elif act == actions.ACTION_POSTS_BAN:
        db.run("UPDATE users SET posts_banned_until=? WHERE id=?",
               (int(d.get("prev", 0)), a["target_id"]))
    elif act in (actions.ACTION_RESOLVE, actions.ACTION_CLOSE):
        db.run("UPDATE reports SET status=? WHERE id=?", (d.get("prev", "open"), a["target_id"]))
    elif act == actions.ACTION_DELETE_VIDEO:
        _relink("videos", d["row"])
        actions.restore_paths(aid, d.get("files") or [])
    elif act == actions.ACTION_DELETE_COMMENT:
        _relink("comments", d["row"])
        actions.restore_paths(aid, d.get("files") or [])
    elif act == "grant_admin":
        u = db.one("SELECT id FROM users WHERE id=?", (a["target_id"],))
        if u:
            db.run("UPDATE users SET is_admin=0 WHERE id=?", (a["target_id"],))
    elif act == "revoke_admin":
        u = db.one("SELECT id FROM users WHERE id=?", (a["target_id"],))
        if u:
            db.run("UPDATE users SET is_admin=1 WHERE id=?", (a["target_id"],))
    elif act == "verify":
        db.run("UPDATE users SET verified=? WHERE id=?", (0 if d.get("on") else 1, a["target_id"]))
    else:
        raise HTTPException(400, "Это действие нельзя отменить")

    db.run("UPDATE admin_actions SET reversed_at=? WHERE id=?", (db.now(), aid))
    actions.log(admin["id"], "undo", a["target_kind"], a["target_id"],
                {"undone_action": act, "summary": d.get("summary") or d.get("username") or ""})
    return {"ok": True}


@router.post("/actions/{aid}/purge")
def purge(aid: int, admin=Depends(admin_user)):
    """Удалить файлы из корзины насовсем (необратимо)."""
    actions.purge_action(aid)
    db.run("UPDATE admin_actions SET reversed_at=? WHERE id=? AND reversed_at IS NULL",
           (db.now(), aid))
    return {"ok": True}
