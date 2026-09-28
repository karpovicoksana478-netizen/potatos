import hashlib
import hmac
import os
import secrets

from fastapi import Header, HTTPException

from . import db

ITERATIONS = 120_000


def hash_password(password: str, salt: bytes = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return salt.hex() + "$" + digest.hex()


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = stored.split("$", 1)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), ITERATIONS)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except Exception:
        return False


def create_token(user_id: int) -> str:
    token = secrets.token_hex(32)
    db.run("INSERT INTO tokens (token, user_id, created_at) VALUES (?,?,?)",
           (token, user_id, db.now()))
    return token


def user_by_token(token: str):
    if not token:
        return None
    return db.one("SELECT u.* FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.token=?", (token,))


def current_user(authorization: str = Header(default=""), x_token: str = Header(default="")):
    token = x_token or authorization.replace("Bearer ", "").strip()
    user = user_by_token(token)
    if not user:
        raise HTTPException(401, "Не авторизован")
    return user


def guest_or_user(authorization: str = Header(default=""), x_token: str = Header(default="")):
    token = x_token or authorization.replace("Bearer ", "").strip()
    return user_by_token(token)


def public_user(u: dict, extra: dict = None) -> dict:
    out = {
        "id": u["id"],
        "username": u["username"],
        "nickname": u["nickname"],
        "bio": u.get("bio", ""),
        "avatar": u.get("avatar", ""),
    }
    if extra:
        out.update(extra)
    return out


def save_file(data: bytes, folder: str, ext: str) -> str:
    name = secrets.token_hex(12) + ext
    path = os.path.join(db.MEDIA, folder, name)
    with open(path, "wb") as f:
        f.write(data)
    return f"{folder}/{name}"
