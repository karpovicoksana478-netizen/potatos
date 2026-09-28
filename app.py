import asyncio
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware

from . import auth, db, hub
from .chats import router as chats_router
from .edit import router as edit_router
from .users import router as users_router
from .videos import router as videos_router

db.init()

app = FastAPI(title="potatos", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

app.include_router(users_router)
app.include_router(videos_router)
app.include_router(chats_router)
app.include_router(edit_router)

STATIC = os.path.join(db.BASE, "static")


@app.on_event("startup")
async def on_startup():
    hub.bind(asyncio.get_event_loop())


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    token = ws.query_params.get("token", "")
    user = auth.user_by_token(token)
    if not user:
        await ws.close(code=4401)
        return
    uid = user["id"]
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
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
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
