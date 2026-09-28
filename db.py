import os
import sqlite3
import threading
import time

BASE = os.path.dirname(os.path.abspath(__file__))
# Где хранить данные: локально — рядом с кодом, на хостинге — постоянный диск (POTATOS_DATA)
DATA = os.environ.get("POTATOS_DATA") or BASE
if not os.path.isdir(DATA):
    os.makedirs(DATA, exist_ok=True)
DB_PATH = os.path.join(DATA, "potatos.db")
MEDIA = os.path.join(DATA, "media")

_local = threading.local()


def db() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")
        _local.conn = conn
    return conn


def rows(sql, args=()):
    return [dict(r) for r in db().execute(sql, args).fetchall()]


def one(sql, args=()):
    r = db().execute(sql, args).fetchone()
    return dict(r) if r else None


def run(sql, args=()):
    cur = db().execute(sql, args)
    db().commit()
    return cur.lastrowid


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nickname TEXT NOT NULL,
  password TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'video',
  media TEXT NOT NULL,
  thumb TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  sound TEXT NOT NULL DEFAULT '',
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE TABLE IF NOT EXISTS saves (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE TABLE IF NOT EXISTS reposts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, video_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  media TEXT NOT NULL DEFAULT '',
  parent_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'dm',
  title TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reads (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id, id);
"""


def _migrate():
    """Добавляем новые колонки в уже существующие базы."""
    have = {r["name"] for r in db().execute("PRAGMA table_info(comments)")}
    for col, sql in (
        ("parent_id", "ALTER TABLE comments ADD COLUMN parent_id INTEGER"),
        ("media", "ALTER TABLE comments ADD COLUMN media TEXT NOT NULL DEFAULT ''"),
    ):
        if col not in have:
            db().execute(sql)
    db().commit()


def init():
    os.makedirs(os.path.join(MEDIA, "videos"), exist_ok=True)
    os.makedirs(os.path.join(MEDIA, "images"), exist_ok=True)
    os.makedirs(os.path.join(MEDIA, "avatars"), exist_ok=True)
    os.makedirs(os.path.join(MEDIA, "thumbs"), exist_ok=True)
    os.makedirs(os.path.join(MEDIA, "edited"), exist_ok=True)
    db().executescript(SCHEMA)
    db().commit()
    _migrate()


def now():
    return int(time.time())
