"""Активность — системный чат «Активность» в разделе «Общение».

Вся активность по аккаунту (лайки, подписки, комментарии, ответы, упоминания)
приходит сюда обычными сообщениями. На телефон уходит push с просьбой проверить
раздел «Активность». Здесь же живут push-подписки и приём жалоб.
"""
import base64
import json
import os
import re
import threading

from fastapi import APIRouter, Depends, HTTPException

from . import auth, db, hub

router = APIRouter(prefix="/api")

TITLE = "Активность"
DESCRIPTION = "Лайки, подписки, комментарии и упоминания"
MENTION_RE = re.compile(r"(?:^|\s)@([a-zA-Z0-9_.]{3,24})")
DUP_WINDOW = 120  # сек: одно и то же действие не дублируем


# ---------- системный чат ----------
def ensure_chat(user_id: int) -> int:
    """Чат «Активность» у каждого пользователя: создаётся при регистрации/первом входе."""
    c = db.one("SELECT id FROM chats WHERE type='activity' AND owner_id=?", (user_id,))
    if c:
        return c["id"]
    cid = db.run("INSERT INTO chats (type, title, description, owner_id, created_at) "
                 "VALUES ('activity', ?, ?, ?, ?)", (TITLE, DESCRIPTION, user_id, db.now()))
    db.run("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?,?,?,?)",
           (cid, user_id, "member", db.now()))
    return cid


def _text(kind: str, detail: str) -> str:
    t = (detail or "").strip()[:160]
    if kind == "like":
        return f"❤️ лайкнул ваш пост «{t}»" if t else "❤️ лайкнул ваш пост"
    if kind == "follow":
        return "➕ подписался на вас"
    if kind == "comment":
        return f"💬 прокомментировал ваш пост: «{t}»" if t else "💬 прокомментировал ваш пост"
    if kind == "reply":
        return f"↩️ ответил вам: «{t}»" if t else "↩️ ответил вам"
    if kind == "mention":
        return f"🔔 упомянул вас: «{t}»" if t else "🔔 упомянул вас"
    return t or "активность"


def _payload(m: dict, actor: dict) -> dict:
    return {
        "id": m["id"], "chat_id": m["chat_id"], "user_id": m["user_id"], "kind": m["kind"],
        "text": m["text"], "media": m["media"], "created_at": m["created_at"],
        "author": {"username": actor.get("username"), "nickname": actor.get("nickname"),
                   "avatar": actor.get("avatar")},
    }


def _brief(cid: int, user_id: int, last: dict) -> dict:
    return {
        "id": cid, "type": "activity", "title": TITLE, "avatar": "", "description": DESCRIPTION,
        "link": "", "owner_id": user_id, "members_count": 1, "unread": 0,
        "last": last and {"id": last["id"], "text": last["text"], "kind": last["kind"],
                          "created_at": last["created_at"], "user_id": last["user_id"],
                          "username": (last.get("author") or {}).get("username")},
        "peer": None, "joined": True, "can_post": False, "role": "member", "can_manage": False,
    }


def add(user_id, kind, actor=None, post_id=None, text=""):
    """Кладём событие в чат «Активность», пушим WS и push на телефон."""
    if not user_id:
        return None
    actor_id = actor["id"] if isinstance(actor, dict) else actor
    if not actor_id or actor_id == user_id:
        return None
    a = db.one("SELECT id, username, nickname, avatar FROM users WHERE id=?", (actor_id,))
    if not a:
        return None
    msg_text = _text(kind, text)
    cid = ensure_chat(user_id)
    # то же самое действие повторно в течение двух минут — не спамим
    if db.one("SELECT 1 x FROM messages WHERE chat_id=? AND user_id=? AND kind='activity' "
              "AND text=? AND created_at > ?", (cid, actor_id, msg_text, db.now() - DUP_WINDOW)):
        return None
    mid = db.run("INSERT INTO messages (chat_id, user_id, kind, text, created_at) "
                 "VALUES (?,?,?,?,?)", (cid, actor_id, "activity", msg_text, db.now()))
    m = db.one("SELECT * FROM messages WHERE id=?", (mid,))
    payload = _payload(m, a)
    hub.push([user_id], {"type": "message", "chat_id": cid, "message": payload,
                         "chat": _brief(cid, user_id, payload)})
    short = re.sub(r"^[^\s]+\s*", "", msg_text)[:160]
    threading.Thread(target=send_push, args=(user_id, "Проверьте раздел «Активность»",
                                             f"@{a['username']} {short}"),
                     kwargs={"url": f"/#/chat/{cid}", "tag": "activity"},
                     daemon=True).start()
    return payload


def mentions(text: str):
    """@юзернеймы из текста -> id пользователей."""
    names = list(dict.fromkeys(MENTION_RE.findall(" " + (text or ""))))[:5]
    out = []
    for name in names:
        u = db.one("SELECT id FROM users WHERE username=?", (name,))
        if u:
            out.append(u)
    return out


def push_dm(user_id: int, actor: dict, chat_id: int, preview: str):
    """Личное сообщение: только push на телефон (само сообщение — уже в чате)."""
    if not user_id or not actor or user_id == actor.get("id"):
        return
    threading.Thread(target=send_push, args=(user_id, f"Сообщение от @{actor.get('username')}:",
                                             (preview or "")[:120]),
                     kwargs={"url": f"/#/chat/{chat_id}", "tag": f"dm-{chat_id}"},
                     daemon=True).start()


# ---------- Web Push (уведомления прямо на телефон) ----------
VAPID_SUB = "https://potatos-x7rt.onrender.com"


def _vapid_path() -> str:
    """Ключ подписи VAPID: лежит рядом с базой, создаётся один раз."""
    path = os.path.join(db.DATA, "vapid.pem")
    if not os.path.isfile(path):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        key = ec.generate_private_key(ec.SECP256R1())
        with open(path, "wb") as f:
            f.write(key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.TraditionalOpenSSL,
                serialization.NoEncryption()))
    return path


def public_key() -> str:
    """Открытый ключ для pushManager.subscribe() (base64url без '=')."""
    from cryptography.hazmat.primitives import serialization
    with open(_vapid_path(), "rb") as f:
        key = serialization.load_pem_private_key(f.read(), password=None)
    raw = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def send_push(user_id: int, title: str, body: str = "", tag: str = "", url: str = "/#/home"):
    """Тихо отправляем push; протухшие подписки убираем. Работает в потоке."""
    subs = db.rows("SELECT * FROM push_subs WHERE user_id=?", (user_id,))
    if not subs:
        return
    try:
        from pywebpush import webpush
    except Exception:
        return
    payload = json.dumps({"title": "🥔 potatos",
                          "body": " ".join(x for x in (title, body) if x)[:300],
                          "tag": tag or "potatos", "url": url},
                         ensure_ascii=False)
    for s in subs:
        try:
            webpush(
                subscription_info={"endpoint": s["endpoint"],
                                   "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                data=payload,
                vapid_private_key=_vapid_path(),
                vapid_claims={"sub": VAPID_SUB},
                ttl=86400)
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", 0)
            if status in (404, 410):   # подписка отозвана — больше не шлём
                try:
                    db.run("DELETE FROM push_subs WHERE endpoint=?", (s["endpoint"],))
                except Exception:
                    pass


# ---------- API ----------
@router.get("/push/public-key")
def push_public_key():
    try:
        return {"key": public_key()}
    except Exception:
        raise HTTPException(500, "Push пока недоступен")


@router.post("/push/subscribe")
def push_subscribe(body: dict, user=Depends(auth.current_user)):
    endpoint = (body.get("endpoint") or "").strip()[:1500]
    keys = body.get("keys") or {}
    p256dh = (keys.get("p256dh") or "").strip()[:500]
    authk = (keys.get("auth") or "").strip()[:500]
    if not endpoint or not p256dh or not authk:
        raise HTTPException(400, "Неверная подписка")
    db.run("INSERT OR REPLACE INTO push_subs (endpoint, user_id, p256dh, auth, created_at) "
           "VALUES (?,?,?,?,?)", (endpoint, user["id"], p256dh, authk, db.now()))
    return {"ok": True}


@router.post("/push/unsubscribe")
def push_unsubscribe(body: dict, user=Depends(auth.current_user)):
    db.run("DELETE FROM push_subs WHERE endpoint=? AND user_id=?",
           ((body.get("endpoint") or "")[:1500], user["id"]))
    return {"ok": True}


# ---------- жалобы ----------
@router.post("/reports")
def create_report(body: dict, user=Depends(auth.current_user)):
    kind = (body.get("kind") or "").strip()
    try:
        target_id = int(body.get("id") or 0)
    except (TypeError, ValueError):
        target_id = 0
    reason = (body.get("reason") or "").strip()[:200]
    if kind not in ("post", "comment") or target_id <= 0:
        raise HTTPException(400, "Неверная жалоба")
    table = "videos" if kind == "post" else "comments"
    t = db.one(f"SELECT id, user_id FROM {table} WHERE id=?", (target_id,))
    if not t:
        raise HTTPException(404, "Не найдено")
    if t["user_id"] == user["id"]:
        raise HTTPException(400, "Нельзя пожаловаться на своё")
    ex = db.one("SELECT 1 x FROM reports WHERE reporter_id=? AND kind=? AND target_id=? "
                "AND status='open'", (user["id"], kind, target_id))
    if ex:
        raise HTTPException(400, "Жалоба уже отправлена")
    rid = db.run("INSERT INTO reports (reporter_id, kind, target_id, owner_id, reason, created_at) "
                 "VALUES (?,?,?,?,?,?)",
                 (user["id"], kind, target_id, t["user_id"], reason, db.now()))
    return {"ok": True, "id": rid}
