"""Уведомления (точки в интерфейсе + WS + push на телефон), жалобы."""
import base64
import json
import os
import re
import threading

from fastapi import APIRouter, Depends, HTTPException

from . import auth, db, hub

router = APIRouter(prefix="/api")

MENTION_RE = re.compile(r"(?:^|\s)@([a-zA-Z0-9_.]{3,24})")

# ---------- тексты уведомлений ----------
VERBS = {
    "like": "понравился ваш пост",
    "comment": "прокомментировал(а) ваш пост",
    "reply": "ответил(а) вам",
    "mention": "упомянул(а) вас",
    "dm": "написал(а) вам",
}


def _payload(n: dict) -> dict:
    actor = None
    if n.get("actor_id"):
        a = db.one("SELECT id, username, nickname, avatar FROM users WHERE id=?", (n["actor_id"],))
        actor = auth.public_user(a) if a else None
    who = (actor or {}).get("nickname") or (actor or {}).get("username") or "Кто-то"
    verb = VERBS.get(n["kind"], "активность")
    title = f"{who} {verb}"
    body = (n.get("text") or "").strip()
    if n["kind"] == "dm" and body:
        title = f"{who}: {body[:120]}"
        body = ""
    elif body:
        body = body[:160]
    return {
        "id": n["id"], "kind": n["kind"], "post_id": n.get("post_id"),
        "chat_id": n.get("chat_id"), "text": n.get("text") or "",
        "is_read": bool(n.get("is_read")), "created_at": n.get("created_at"),
        "actor": actor, "title": title, "body": body,
    }


def add(user_id, kind, actor=None, post_id=None, chat_id=None, text=""):
    """Ставим уведомление: красная точка, WS-событие и push на телефон."""
    if not user_id:
        return None
    actor_id = actor["id"] if isinstance(actor, dict) else actor
    if actor_id and actor_id == user_id:
        return None
    nid = db.run(
        "INSERT INTO notifications (user_id, actor_id, kind, post_id, chat_id, text, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (user_id, actor_id, kind, post_id, chat_id, (text or "").strip()[:200], db.now()))
    n = db.one("SELECT * FROM notifications WHERE id=?", (nid,))
    item = _payload(n)
    unread = unread_count(user_id)
    hub.push([user_id], {"type": "notify", "unread": unread, "item": item})
    threading.Thread(target=send_push, args=(user_id, item["title"], item["body"]),
                     daemon=True).start()
    return item


def unread_count(user_id: int) -> int:
    return db.one("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0",
                  (user_id,))["c"]


def mentions(text: str):
    """@юзернеймы из текста -> id пользователей."""
    names = list(dict.fromkeys(MENTION_RE.findall(" " + (text or ""))))[:5]
    out = []
    for name in names:
        u = db.one("SELECT id FROM users WHERE username=?", (name,))
        if u:
            out.append(u)
    return out


def chat_unread(user_id: int) -> int:
    return db.one(
        "SELECT COUNT(*) c FROM messages m "
        "JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=? "
        "LEFT JOIN reads r ON r.chat_id=m.chat_id AND r.user_id=? "
        "WHERE m.id > COALESCE(r.last_id, 0) AND COALESCE(m.user_id,0) <> ?",
        (user_id, user_id, user_id))["c"]


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


def send_push(user_id: int, title: str, body: str = "", tag: str = ""):
    """Тихо отправляем push; протухшие подписки убираем. Работает в потоке."""
    subs = db.rows("SELECT * FROM push_subs WHERE user_id=?", (user_id,))
    if not subs:
        return
    try:
        from pywebpush import WebPushException, webpush
    except Exception:
        return
    payload = json.dumps({"title": "🥔 potatos",
                          "body": " ".join(x for x in (title, body) if x)[:300],
                          "tag": tag or "potatos", "url": "/#/home"},
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
@router.get("/notifications")
def notifications(limit: int = 50, user=Depends(auth.current_user)):
    limit = max(1, min(limit, 100))
    items = db.rows("SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT ?",
                    (user["id"], limit))
    return {"items": [_payload(n) for n in items], "unread": unread_count(user["id"])}


@router.post("/notifications/read")
def read_notifications(body: dict = None, user=Depends(auth.current_user)):
    ids = (body or {}).get("ids")
    if isinstance(ids, list) and ids:
        ph = ",".join("?" * len(ids))
        db.run(f"UPDATE notifications SET is_read=1 WHERE user_id=? AND id IN ({ph})",
               (user["id"], *[int(i) for i in ids]))
    else:
        db.run("UPDATE notifications SET is_read=1 WHERE user_id=?", (user["id"],))
    return {"ok": True, "unread": unread_count(user["id"])}


@router.get("/unread")
def unread(user=Depends(auth.current_user)):
    return {"notifications": unread_count(user["id"]), "chats": chat_unread(user["id"])}


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
