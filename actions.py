"""Журнал действий администраторов: всё, что делает модерация.

Каждое действие админа логируется, чтобы его можно было увидеть
и при необходимости отменить (включая действия без жалобы).
"""
import json
import os
import shutil

from . import db

ACTION_BAN = "ban"
ACTION_POSTS_BAN = "posts_ban"
ACTION_RESOLVE = "report_resolve"
ACTION_CLOSE = "report_close"
ACTION_DELETE_VIDEO = "delete_video"
ACTION_DELETE_COMMENT = "delete_comment"

UNDOABLE = {ACTION_BAN, ACTION_POSTS_BAN, ACTION_RESOLVE, ACTION_CLOSE,
            ACTION_DELETE_VIDEO, ACTION_DELETE_COMMENT}


def log(actor_id, action, target_kind, target_id, detail=None):
    detail_json = json.dumps(detail or {}, ensure_ascii=False)
    undoable = 1 if action in UNDOABLE else 0
    aid = db.run(
        "INSERT INTO admin_actions (actor_id, action, target_kind, target_id, detail, undoable, created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (actor_id, action, target_kind, target_id, detail_json, undoable, db.now()))
    return aid


def trash_paths(rel_paths, action_id):
    """Перемещает файлы в корзину media/trash/<action_id>/ для отката."""
    moved = []
    if not rel_paths:
        return moved
    for rel in rel_paths:
        if not rel:
            continue
        folder, name = rel.split("/", 1) if "/" in rel else ("", "")
        if folder not in ("videos", "images", "thumbs", "edited", "avatars", "banners"):
            continue
        if not name or ".." in name:
            continue
        src = os.path.join(db.MEDIA, folder, name)
        dst_dir = os.path.join(db.MEDIA, "trash", str(action_id))
        try:
            os.makedirs(dst_dir, exist_ok=True)
            os.rename(src, os.path.join(dst_dir, name))
            moved.append(rel)
        except OSError:
            pass
    return moved


def restore_paths(action_id, rel_paths):
    for rel in rel_paths or []:
        folder, name = rel.split("/", 1) if "/" in rel else ("", "")
        src = os.path.join(db.MEDIA, "trash", str(action_id), name)
        dst = os.path.join(db.MEDIA, folder, name)
        if os.path.isfile(src):
            try:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                os.rename(src, dst)
            except OSError:
                pass


def purge_action(action_id):
    row = db.one("SELECT detail FROM admin_actions WHERE id=?", (action_id,))
    if not row:
        return
    try:
        d = json.loads(row["detail"] or "{}")
    except Exception:
        return
    for rel in d.get("files", []) or []:
        folder, name = rel.split("/", 1) if "/" in rel else ("", "")
        if folder and name and ".." not in name:
            path = os.path.join(db.MEDIA, "trash", str(action_id), name)
            if os.path.isfile(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
