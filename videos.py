import os
import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from . import auth, db, notifs

router = APIRouter(prefix="/api")

MAX_UPLOAD = 400 * 1024 * 1024
VIDEO_EXT = {".mp4": ".mp4", ".webm": ".webm", ".mov": ".mp4", ".m4v": ".mp4", ".qt": ".mp4",
             ".avi": ".mp4", ".mkv": ".webm", ".3gp": ".3gp"}
IMAGE_EXT = {".jpg": ".jpg", ".jpeg": ".jpg", ".png": ".png", ".webp": ".webp",
             ".gif": ".gif", ".heic": ".jpg", ".bmp": ".jpg"}


def _ext(name: str) -> str:
    return os.path.splitext(name or "")[1].lower()


def video_payloads(items, me=None) -> list:
    """Собираем данные всех роликов одним набором запросов (быстро даже на слабом сервере)."""
    if not items:
        return []
    ids = [v["id"] for v in items]
    ph = ",".join("?" * len(ids))
    uids = sorted({v["user_id"] for v in items})
    uph = ",".join("?" * len(uids))
    users = {u["id"]: u for u in db.rows(f"SELECT * FROM users WHERE id IN ({uph})", tuple(uids))}

    def counts(table):
        return {r["video_id"]: r["c"] for r in db.rows(
            f"SELECT video_id, COUNT(*) c FROM {table} WHERE video_id IN ({ph}) GROUP BY video_id",
            ids)}

    likes = counts("likes")
    comments = counts("comments")
    mine, saved, follows = set(), set(), set()
    if me:
        mid = me["id"]
        mine = {r["video_id"] for r in db.rows(
            f"SELECT video_id FROM likes WHERE user_id=? AND video_id IN ({ph})", (mid, *ids))}
        saved = {r["video_id"] for r in db.rows(
            f"SELECT video_id FROM saves WHERE user_id=? AND video_id IN ({ph})", (mid, *ids))}
        follows = {r["followee_id"] for r in db.rows(
            f"SELECT followee_id FROM follows WHERE follower_id=? AND followee_id IN ({uph})",
            (mid, *tuple(uids)))}
    out = []
    for v in items:
        u = users.get(v["user_id"])
        out.append({
            **v,
            "user": auth.public_user(u) if u else None,
            "likes": likes.get(v["id"], 0),
            "comments_count": comments.get(v["id"], 0),
            "liked": v["id"] in mine,
            "saved": v["id"] in saved,
            "followed": v["user_id"] in follows,
            "mine": bool(me and v["user_id"] == me["id"]),
        })
    return out


def video_payload(v: dict, me) -> dict:
    return video_payloads([v], me)[0]


@router.post("/upload")
async def upload(file: UploadFile = File(None), thumb: UploadFile = File(None),
                 caption: str = Form(""), sound: str = Form(""), kind: str = Form(""),
                 media: str = Form(""), draw: UploadFile = File(None),
                 user=Depends(auth.current_user)):
    if db.posts_blocked(user):
        raise HTTPException(403, "Вам запрещено публиковать посты")
    thumb_url = ""
    requested = (kind or "").strip()

    if media:
        # файл уже обработан редактором и лежит на сервере — перелинковываем пост
        media = media.strip()
        name = media[len("edited/"):] if media.startswith("edited/") else ""
        if not name or "/" in name or "\\" in name or ".." in name:
            raise HTTPException(400, "Ожидался файл из редактора")
        if not os.path.isfile(os.path.join(db.MEDIA, "edited", name)):
            raise HTTPException(400, "Обработанный файл не найден — обработайте его заново")
        media = "edited/" + name
        ext = os.path.splitext(name)[1].lower()
        folder, kind = ("images", "photo") if ext in IMAGE_EXT else ("videos", "video")
        if requested == "live" and folder == "videos":
            kind = "live"
        media_path = media
    else:
        if file is None or not file.filename:
            raise HTTPException(400, "Нужен файл видео или фото")
        data = await file.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, "Файл слишком большой (макс. 400 МБ)")
        if not data:
            raise HTTPException(400, "Пустой файл")

        ext = _ext(file.filename)
        if ext in IMAGE_EXT:
            folder, ext, kind = "images", IMAGE_EXT[ext], "photo"
        elif ext in VIDEO_EXT:
            folder, ext, kind = "videos", VIDEO_EXT[ext], "video"
        elif (file.content_type or "").startswith("image/"):
            folder, ext, kind = "images", ".jpg", "photo"
        elif (file.content_type or "").startswith("video/"):
            folder, ext, kind = "videos", ".mp4", "video"
        else:
            raise HTTPException(400, "Нужен файл видео или фото")
        if requested == "live" and folder == "videos":
            kind = "live"
        media_path = auth.save_file(data, folder, ext)

    # нарисованное поверх видео (карандаш) — накладываем на сервере
    burned = False
    if draw is not None and draw.filename and folder == "videos":
        png = await draw.read()
        if png:
            from .edit import burn_overlay
            burned_media = burn_overlay(media_path, png)
            burned = burned_media != media_path
            media_path = burned_media

    if thumb is not None:
        tdata = await thumb.read()
        if tdata:
            thumb_url = auth.save_file(tdata, "thumbs", _ext(thumb.filename) or ".jpg")

    # превью: если файла нет (или видео с рисунком) — берём кадр из итогового видео
    if folder == "videos" and (not thumb_url or burned):
        from .edit import video_frame
        frame = video_frame(media_path)
        if frame:
            thumb_url = auth.save_file(frame, "thumbs", ".jpg")

    vid = db.run(
        "INSERT INTO videos (user_id, kind, media, thumb, caption, sound, created_at) VALUES (?,?,?,?,?,?,?)",
        (user["id"], kind, media_path, thumb_url, caption.strip()[:500], sound.strip()[:120], db.now()))
    for m in notifs.mentions(caption):
        notifs.add(m["id"], "mention", actor=user, post_id=vid, text=caption.strip()[:200])
    v = db.one("SELECT * FROM videos WHERE id=?", (vid,))
    return video_payload(v, user)


@router.get("/feed")
def feed(cursor: int = 0, limit: int = 12, scope: str = "all", user=Depends(auth.guest_or_user)):
    limit = max(1, min(limit, 20))
    cursor = cursor or 10 ** 12
    now = db.now()
    # ролики забаненных не показываем
    not_banned = "AND NOT (bu.banned_until=-1 OR bu.banned_until > ?)"
    if scope == "following" and user:
        items = db.rows(
            "SELECT v.* FROM videos v JOIN follows f ON f.followee_id=v.user_id "
            "JOIN users bu ON bu.id=v.user_id "
            f"WHERE f.follower_id=? AND v.id < ? {not_banned} ORDER BY v.id DESC LIMIT ?",
            (user["id"], cursor, now, limit))
    else:
        items = db.rows(
            f"SELECT v.* FROM videos v JOIN users bu ON bu.id=v.user_id "
            f"WHERE v.id < ? {not_banned} ORDER BY v.id DESC LIMIT ?",
            (cursor, now, limit))
    out = video_payloads(items, user)
    next_cursor = out[-1]["id"] if out else 0
    return {"items": out, "next": next_cursor}


@router.post("/video/{vid}/view")
def view(vid: int, user=Depends(auth.guest_or_user)):
    db.run("UPDATE videos SET views = views + 1 WHERE id=?", (vid,))
    return {"ok": True}


@router.post("/video/{vid}/like")
def like(vid: int, user=Depends(auth.current_user)):
    v = db.one("SELECT * FROM videos WHERE id=?", (vid,))
    if not v:
        raise HTTPException(404, "Не найдено")
    ex = db.one("SELECT 1 x FROM likes WHERE user_id=? AND video_id=?", (user["id"], vid))
    if ex:
        db.run("DELETE FROM likes WHERE user_id=? AND video_id=?", (user["id"], vid))
        liked = False
    else:
        db.run("INSERT INTO likes (user_id, video_id, created_at) VALUES (?,?,?)", (user["id"], vid, db.now()))
        liked = True
        notifs.add(v["user_id"], "like", actor=user, post_id=vid, text=(v["caption"] or "")[:120])
    count = db.one("SELECT COUNT(*) c FROM likes WHERE video_id=?", (vid,))["c"]
    return {"liked": liked, "likes": count}


@router.post("/video/{vid}/save")
def save(vid: int, user=Depends(auth.current_user)):
    if not db.one("SELECT 1 x FROM videos WHERE id=?", (vid,)):
        raise HTTPException(404, "Не найдено")
    ex = db.one("SELECT 1 x FROM saves WHERE user_id=? AND video_id=?", (user["id"], vid))
    if ex:
        db.run("DELETE FROM saves WHERE user_id=? AND video_id=?", (user["id"], vid))
        saved = False
    else:
        db.run("INSERT INTO saves (user_id, video_id, created_at) VALUES (?,?,?)", (user["id"], vid, db.now()))
        saved = True
    return {"saved": saved}


@router.get("/video/{vid}/comments")
def comments(vid: int, user=Depends(auth.guest_or_user)):
    data = db.rows(
        "SELECT c.*, u.username, u.nickname, u.avatar FROM comments c JOIN users u ON u.id=c.user_id "
        "WHERE c.video_id=? ORDER BY c.id ASC LIMIT 500", (vid,))
    ids = {c["parent_id"] for c in data if c["parent_id"]}
    parents = {}
    if ids:
        ph = ",".join("?" * len(ids))
        for p in db.rows(
            "SELECT c.id, c.text, c.media, u.username, u.nickname, u.avatar "
            "FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id IN (" + ph + ")", tuple(ids)):
            parents[p["id"]] = p
    for c in data:
        p = parents.get(c["parent_id"])
        if p:
            c["parent"] = p
        else:
            c["parent"] = None
    return {"items": data}


@router.post("/video/{vid}/comments")
async def add_comment(vid: int,
                      text: str = Form(""), parent_id: int = Form(0),
                      file: UploadFile = File(None),
                      user=Depends(auth.current_user)):
    if db.posts_blocked(user):
        raise HTTPException(403, "Вам запрещено публиковать посты")
    text = (text or "").strip()
    media = ""
    if file is not None and file.filename:
        data = await file.read()
        if len(data) > 10 * 1024 * 1024:
            raise HTTPException(413, "Фото слишком большое (макс. 10 МБ)")
        if not (file.content_type or "").startswith("image/"):
            raise HTTPException(400, "В комментарии можно отправить только фото")
        ext = ".png" if file.content_type == "image/png" else ".jpg"
        media = auth.save_file(data, "images", ext)
    if not text and not media:
        raise HTTPException(400, "Пустой комментарий")
    if not db.one("SELECT 1 x FROM videos WHERE id=?", (vid,)):
        raise HTTPException(404, "Не найдено")

    parent = None
    if parent_id:
        parent = db.one(
            "SELECT c.id, c.user_id, c.text, c.media, u.username, u.nickname, u.avatar "
            "FROM comments c JOIN users u ON u.id=c.user_id "
            "WHERE c.id=? AND c.video_id=?", (parent_id, vid))
        if not parent:
            raise HTTPException(404, "Комментарий для ответа не найден")

    cid = db.run("INSERT INTO comments (video_id, user_id, text, media, parent_id, created_at) "
                 "VALUES (?,?,?,?,?,?)",
                 (vid, user["id"], text[:1000], media, parent["id"] if parent else None, db.now()))
    _owner = db.one("SELECT user_id FROM videos WHERE id=?", (vid,))["user_id"]
    snippet = (text or "").strip()[:160] or "📷 Фото"
    notified = set()
    if parent:
        notifs.add(parent["user_id"], "reply", actor=user, post_id=vid, text=snippet)
        notified.add(parent["user_id"])
    if _owner not in notified:
        notifs.add(_owner, "comment", actor=user, post_id=vid, text=snippet)
        notified.add(_owner)
    for m in notifs.mentions(text):
        if m["id"] not in notified and m["id"] != user["id"]:
            notifs.add(m["id"], "mention", actor=user, post_id=vid, text=snippet)
            notified.add(m["id"])
    return {"id": cid, "username": user["username"], "nickname": user["nickname"],
            "avatar": user["avatar"], "text": text[:1000], "media": media,
            "parent": parent}


@router.delete("/video/{vid}")
def delete_video(vid: int, user=Depends(auth.current_user)):
    v = db.one("SELECT * FROM videos WHERE id=?", (vid,))
    if not v:
        raise HTTPException(404, "Не найдено")
    if v["user_id"] != user["id"] and not user.get("is_admin"):
        raise HTTPException(403, "Не своё")
    db.run("DELETE FROM videos WHERE id=?", (vid,))
    for folder in ("videos", "images", "thumbs"):
        try:
            os.remove(os.path.join(db.MEDIA, folder, os.path.basename(v["media"])))
        except OSError:
            pass
    return {"ok": True}


@router.get("/saved")
def saved(user=Depends(auth.current_user)):
    items = db.rows(
        "SELECT v.* FROM saves s JOIN videos v ON v.id=s.video_id WHERE s.user_id=? ORDER BY s.created_at DESC",
        (user["id"],))
    return {"items": video_payloads(items, user)}


def _user_videos(user_row: dict, me, table: str):
    # у забаненного профиль для всех, кроме админа, пустой
    if db.banned(user_row) and not (me and me.get("is_admin")):
        return []
    if table == "liked":
        items = db.rows("SELECT v.* FROM likes l JOIN videos v ON v.id=l.video_id "
                        "WHERE l.user_id=? ORDER BY l.created_at DESC", (user_row["id"],))
    else:
        items = db.rows("SELECT * FROM videos WHERE user_id=? ORDER BY id DESC", (user_row["id"],))
    return video_payloads(items, me)


@router.get("/user/{username}/videos")
def user_videos(username: str, tab: str = "videos", user=Depends(auth.guest_or_user)):
    u = db.one("SELECT * FROM users WHERE username=?", (username,))
    if not u:
        raise HTTPException(404, "Пользователь не найден")
    if tab not in ("videos", "liked"):
        tab = "videos"
    if tab == "liked" and (not user or user["id"] != u["id"]):
        raise HTTPException(403, "Лайки скрыты")
    return {"items": _user_videos(u, user, tab)}
