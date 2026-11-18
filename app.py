import asyncio
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth, db, hub, live
from .activity import router as activity_router
from .admin import router as admin_router
from .chats import router as chats_router
from .edit import router as edit_router
from .users import router as users_router
from .videos import router as videos_router
from .live import router as live_router

db.init()

# Пароль админа читается из окружения (POTATOS_ADMIN_PASSWORD); значение по умолчанию —
# только чтобы не сломать уже развёрнутые инстансы. На боевом сервере задайте свой.
ADMIN_USERNAME = os.environ.get("POTATOS_ADMIN_USERNAME", "dmitriy444")
ADMIN_PASSWORD = os.environ.get("POTATOS_ADMIN_PASSWORD", "19892012Burmalda")
ADMIN_NICKNAME = os.environ.get("POTATOS_ADMIN_NICKNAME", "Дмитрий")


def seed_admin():
    """Аккаунт администратора всегда есть в базе (логин/пароль — из кода)."""
    u = db.one("SELECT id FROM users WHERE username=?", (ADMIN_USERNAME,))
    if u:
        db.run("UPDATE users SET is_admin=1, is_superadmin=1, nickname=? WHERE id=?", (ADMIN_NICKNAME, u["id"]))
    else:
        db.run("INSERT INTO users (username, nickname, password, is_admin, is_superadmin, created_at) "
               "VALUES (?,?,?,?,?,?)",
               (ADMIN_USERNAME, ADMIN_NICKNAME, auth.hash_password(ADMIN_PASSWORD), 1, 1, db.now()))


seed_admin()

app = FastAPI(title="potatos", docs_url=None, redoc_url=None)

app.include_router(users_router)
app.include_router(videos_router)
app.include_router(chats_router)
app.include_router(edit_router)
app.include_router(admin_router)
app.include_router(activity_router)
app.include_router(live_router)

STATIC = os.path.join(db.BASE, "static")


_CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; media-src 'self' blob:; "
        "connect-src 'self' ws: wss:; font-src 'self' data:; manifest-src 'self'; "
        "worker-src 'self'; base-uri 'self'; form-action 'self'")


@app.middleware("http")
async def security_headers(request, call_next):
    """Базовые защитные заголовки: запрет кликджекинга, подмены MIME, минимум утечек."""
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    else:
        resp.headers.setdefault("Content-Security-Policy", _CSP)
    return resp


@app.middleware("http")
async def cache_headers(request, call_next):
    """Статика и медиа кэшируются браузером — заметно быстрее на плохом интернете."""
    resp = await call_next(request)
    path = request.url.path
    if path.startswith("/static/"):
        resp.headers.setdefault("Cache-Control", "public, max-age=31536000")
    elif path.startswith("/media/"):
        resp.headers.setdefault("Cache-Control", "public, max-age=604800")
    return resp


@app.on_event("startup")
async def on_startup():
    hub.bind(asyncio.get_event_loop())


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    token = ws.query_params.get("token", "")
    user = auth.user_by_token(token)
    if not user or db.banned(user):
        await ws.close(code=4401)
        return
    uid = user["id"]
    db.run("UPDATE users SET last_seen=? WHERE id=?", (db.now(), uid))
    await hub.connect(uid, ws)
    try:
        await ws.send_json({"type": "hello", "user_id": uid})
        while True:
            data = await ws.receive_json()
            t = data.get("type")
            if t == "typing":
                chat_id = int(data.get("chat_id") or 0)
                members = [m["user_id"] for m in db.rows(
                    "SELECT user_id FROM chat_members WHERE chat_id=?", (chat_id,))]
                hub.push([m for m in members if m != uid],
                         {"type": "typing", "chat_id": chat_id, "user_id": uid,
                          "username": user["username"]})
            elif t == "ping":
                await ws.send_json({"type": "pong"})
            elif t == "live-join":
                live.ws_join(uid, data)
            elif t == "live-leave":
                live.ws_leave(uid, data)
            elif t in ("live-offer", "live-answer", "live-ice"):
                live.ws_relay(uid, data)
            elif t == "live-chat":
                live.ws_chat(uid, data)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        live.disconnect(uid)
        await hub.disconnect(uid, ws)


@app.get("/api/health")
def health():
    return {"ok": True, "app": "potatos"}


app.mount("/media", StaticFiles(directory=db.MEDIA), name="media")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/{full_path:path}")
def spa(full_path: str):
    if full_path.startswith("api/"):
        return JSONResponse({"detail": "Not found"}, status_code=404)
    path = os.path.join(STATIC, full_path)
    if full_path and os.path.isfile(path):
        return FileResponse(path)
    return FileResponse(os.path.join(STATIC, "index.html"))
