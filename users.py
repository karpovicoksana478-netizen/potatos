import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from . import auth, db

router = APIRouter(prefix="/api")

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_.]{3,24}$")


def stats(u: dict, me) -> dict:
    followers = db.one("SELECT COUNT(*) c FROM follows WHERE followee_id=?", (u["id"],))["c"]
    following = db.one("SELECT COUNT(*) c FROM follows WHERE follower_id=?", (u["id"],))["c"]
    videos = db.one("SELECT COUNT(*) c FROM videos WHERE user_id=?", (u["id"],))["c"]
    likes = db.one("SELECT COUNT(*) c FROM likes l JOIN videos v ON v.id=l.video_id WHERE v.user_id=?",
                   (u["id"],))["c"]
    out = {"followers": followers, "following": following, "videos": videos, "likes": likes}
    out["followed"] = False
    out["is_me"] = bool(me and me["id"] == u["id"])
    if me and not out["is_me"]:
        out["followed"] = db.one("SELECT 1 x FROM follows WHERE follower_id=? AND followee_id=?",
                                 (me["id"], u["id"])) is not None
    return out


@router.post("/register")
def register(body: dict):
    nickname = (body.get("nickname") or "").strip()
    username = (body.get("username") or "").strip().lstrip("@")
    password = body.get("password") or ""
    if not nickname or len(nickname) > 32:
        raise HTTPException(400, "Введите ник (до 32 символов)")
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "Юзернейм: 3-24 символа, латиница, цифры, _ и .")
    if len(password) < 4:
        raise HTTPException(400, "Пароль от 4 символов")
    if db.one("SELECT 1 x FROM users WHERE username=?", (username,)):
        raise HTTPException(400, "Такой юзернейм занят")
    uid = db.run("INSERT INTO users (username, nickname, password, created_at) VALUES (?,?,?,?)",
                 (username, nickname, auth.hash_password(password), db.now()))
    db.run("UPDATE users SET last_seen=? WHERE id=?", (db.now(), uid))
    token = auth.create_token(uid)
    user = db.one("SELECT * FROM users WHERE id=?", (uid,))
    return {"token": token, "user": auth.public_user(user)}


@router.post("/login")
def login(body: dict):
    username = (body.get("username") or "").strip().lstrip("@")
    password = body.get("password") or ""
    u = db.one("SELECT * FROM users WHERE username=?", (username,))
    if not u or not auth.verify_password(password, u["password"]):
        raise HTTPException(400, "Неверный юзернейм или пароль")
    if db.banned(u):
        raise HTTPException(403, "Аккаунт заблокирован администратором")
    token = auth.create_token(u["id"])
    db.run("UPDATE users SET last_seen=? WHERE id=?", (db.now(), u["id"]))
    u = db.one("SELECT * FROM users WHERE id=?", (u["id"],))
    return {"token": token, "user": auth.public_user(u)}


@router.post("/logout")
def logout(user=Depends(auth.current_user)):
    token = ""
    db.run("DELETE FROM tokens WHERE user_id=?", (user["id"],))
    return {"ok": True}


@router.get("/me")
def me(user=Depends(auth.current_user)):
    return {"user": auth.public_user(user), "stats": stats(user, user)}


@router.patch("/me")
def edit_me(body: dict, user=Depends(auth.current_user)):
    nickname = (body.get("nickname") if body.get("nickname") is not None else user["nickname"])
    bio = (body.get("bio") if body.get("bio") is not None else user["bio"])
    nickname = (nickname or "").strip()[:32]
    bio = (bio or "").strip()[:200]
    if not nickname:
        raise HTTPException(400, "Ник не может быть пустым")
    db.run("UPDATE users SET nickname=?, bio=? WHERE id=?", (nickname, bio, user["id"]))
    u = db.one("SELECT * FROM users WHERE id=?", (user["id"],))
    return {"user": auth.public_user(u)}


@router.post("/me/avatar")
async def set_avatar(file: UploadFile = File(...), user=Depends(auth.current_user)):
    data = await file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "Аватар слишком большой")
    ext = ".png" if (file.content_type or "") == "image/png" else ".jpg"
    path = auth.save_file(data, "avatars", ext)
    db.run("UPDATE users SET avatar=? WHERE id=?", (path, user["id"]))
    u = db.one("SELECT * FROM users WHERE id=?", (user["id"],))
    return {"user": auth.public_user(u)}


@router.get("/user/{username}")
def profile(username: str, user=Depends(auth.guest_or_user)):
    u = db.one("SELECT * FROM users WHERE username=?", (username,))
    if not u:
        raise HTTPException(404, "Пользователь не найден")
    s = stats(u, user)
    out = {"user": auth.public_user(u), "stats": s}
    # админу показываем статус бана — чтобы кнопки в профиле были понятны
    if user and user.get("is_admin") and user["id"] != u["id"]:
        now = db.now()

        def _on(v):
            return v == -1 or (v or 0) > now
        out["admin"] = {
            "banned": _on(u.get("banned_until")),
            "banned_forever": u.get("banned_until") == -1,
            "banned_until": u.get("banned_until") or 0,
            "posts_blocked": _on(u.get("posts_banned_until")),
            "posts_forever": u.get("posts_banned_until") == -1,
            "posts_until": u.get("posts_banned_until") or 0,
        }
    return out


@router.post("/user/{username}/follow")
def follow(username: str, user=Depends(auth.current_user)):
    u = db.one("SELECT * FROM users WHERE username=?", (username,))
    if not u:
        raise HTTPException(404, "Пользователь не найден")
    if u["id"] == user["id"]:
        raise HTTPException(400, "Нельзя подписаться на себя")
    ex = db.one("SELECT 1 x FROM follows WHERE follower_id=? AND followee_id=?", (user["id"], u["id"]))
    if ex:
        db.run("DELETE FROM follows WHERE follower_id=? AND followee_id=?", (user["id"], u["id"]))
        followed = False
    else:
        db.run("INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?,?,?)",
               (user["id"], u["id"], db.now()))
        followed = True
    count = db.one("SELECT COUNT(*) c FROM follows WHERE followee_id=?", (u["id"],))["c"]
    return {"followed": followed, "followers": count}


@router.get("/user/{username}/followers")
def followers(username: str, user=Depends(auth.guest_or_user), limit: int = 30):
    u = db.one("SELECT * FROM users WHERE username=?", (username,))
    if not u:
        raise HTTPException(404, "Пользователь не найден")
    items = db.rows(
        "SELECT f.follower_id id, us.username, us.nickname, us.avatar FROM follows f "
        "JOIN users us ON us.id=f.follower_id WHERE f.followee_id=? ORDER BY f.created_at DESC LIMIT ?",
        (u["id"], min(limit, 100)))
    return {"items": items}


@router.get("/user/{username}/followees")
def followees(username: str, limit: int = 30):
    u = db.one("SELECT * FROM users WHERE username=?", (username,))
    if not u:
        raise HTTPException(404, "Пользователь не найден")
    items = db.rows(
        "SELECT f.followee_id id, us.username, us.nickname, us.avatar FROM follows f "
        "JOIN users us ON us.id=f.followee_id WHERE f.follower_id=? ORDER BY f.created_at DESC LIMIT ?",
        (u["id"], min(limit, 100)))
    return {"items": items}


@router.get("/search")
def search(q: str = "", user=Depends(auth.guest_or_user)):
    q = (q or "").strip()
    if not q:
        return {"users": [], "chats": []}
    like = f"%{q}%"
    people = db.rows(
        "SELECT * FROM users WHERE username LIKE ? OR nickname LIKE ? ORDER BY username LIMIT 20",
        (like, like))
    from .chats import chat_brief
    my_ids = []
    if user:
        my_ids = [r["chat_id"] for r in db.rows("SELECT chat_id FROM chat_members WHERE user_id=?",
                                                (user["id"],))]
    if my_ids:
        ph = ",".join("?" * len(my_ids))
        chats = db.rows(f"SELECT * FROM chats WHERE (title LIKE ? OR description LIKE ?) AND id NOT IN ({ph}) "
                        "ORDER BY title LIMIT 20", (like, like, *my_ids))
    else:
        chats = db.rows("SELECT * FROM chats WHERE (title LIKE ? OR description LIKE ?) AND type!='dm' "
                        "ORDER BY title LIMIT 20", (like, like))
    return {
        "users": [auth.public_user(u) for u in people],
        "chats": [chat_brief(c, user) for c in chats],
    }
