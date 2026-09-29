"""Админ-панель: список пользователей, баны, запрет публикаций."""
import time

from fastapi import APIRouter, Depends, HTTPException

from . import auth, db

router = APIRouter(prefix="/api/admin")

HOUR = 3600


def admin_user(user=Depends(auth.current_user)):
    if not user.get("is_admin"):
        raise HTTPException(403, "Только для администратора")
    return user


def _target(uid: int) -> dict:
    u = db.one("SELECT * FROM users WHERE id=?", (uid,))
    if not u:
        raise HTTPException(404, "Пользователь не найден")
    return u


def _apply(mode: str, hours: int) -> int:
    """mode: perm | temp | unban -> значение banned_until."""
    if mode == "perm":
        return -1
    if mode == "temp":
        return int(time.time()) + max(1, int(hours or 24)) * HOUR
    if mode == "unban":
        return 0
    raise HTTPException(400, "mode: perm, temp или unban")


@router.get("/stats")
def stats(admin=Depends(admin_user)):
    return {
        "users": db.one("SELECT COUNT(*) c FROM users")["c"],
        "videos": db.one("SELECT COUNT(*) c FROM videos")["c"],
        "online": db.one("SELECT COUNT(*) c FROM users WHERE last_seen >= ?",
                         (int(time.time()) - 90,))["c"],
        "banned": db.one("SELECT COUNT(*) c FROM users WHERE banned_until=-1 OR banned_until > ?",
                         (int(time.time()),))["c"],
    }


@router.get("/users")
def users(q: str = "", limit: int = 100, admin=Depends(admin_user)):
    limit = max(1, min(limit, 300))
    now = int(time.time())
    like = f"%{(q or '').strip()}%"
    rows = db.rows(
        "SELECT u.id, u.username, u.nickname, u.avatar, u.is_admin, u.banned_until, "
        "u.posts_banned_until, u.last_seen, u.created_at, "
        "(SELECT COUNT(*) FROM videos v WHERE v.user_id=u.id) videos "
        "FROM users u "
        "WHERE (? = '' OR u.username LIKE ? OR u.nickname LIKE ?) "
        "ORDER BY (u.last_seen >= ?) DESC, u.id DESC LIMIT ?",
        (q or "", like, like, now - 90, limit))
    for r in rows:
        r["online"] = bool(r["last_seen"] and now - r["last_seen"] <= 90)
        r["banned"] = r["banned_until"] == -1 or r["banned_until"] > now
        r["banned_forever"] = r["banned_until"] == -1
        r["posts_blocked"] = r["posts_banned_until"] == -1 or r["posts_banned_until"] > now
        r["posts_forever"] = r["posts_banned_until"] == -1
        r["is_admin"] = bool(r["is_admin"])
    return {"items": rows, "now": now}


@router.post("/users/{uid}/ban")
def ban(uid: int, body: dict, admin=Depends(admin_user)):
    u = _target(uid)
    if u["id"] == admin["id"]:
        raise HTTPException(400, "Нельзя забанить самого себя")
    value = _apply((body.get("mode") or ""), body.get("hours") or 0)
    db.run("UPDATE users SET banned_until=? WHERE id=?", (value, uid))
    if value != 0:
        db.run("DELETE FROM tokens WHERE user_id=?", (uid,))
    return {"ok": True, "banned_until": value,
            "banned": value == -1 or value > int(time.time())}


@router.post("/users/{uid}/posts")
def posts_ban(uid: int, body: dict, admin=Depends(admin_user)):
    u = _target(uid)
    value = _apply((body.get("mode") or ""), body.get("hours") or 0)
    db.run("UPDATE users SET posts_banned_until=? WHERE id=?", (value, uid))
    return {"ok": True, "posts_banned_until": value,
            "blocked": value == -1 or value > int(time.time())}
