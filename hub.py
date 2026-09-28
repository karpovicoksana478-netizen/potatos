import asyncio
from fastapi import WebSocket

loop = None
conns: dict = {}
typing: dict = {}


def bind(l):
    global loop
    loop = l


async def connect(user_id: int, ws: WebSocket):
    conns.setdefault(user_id, set()).add(ws)


async def disconnect(user_id: int, ws: WebSocket):
    s = conns.get(user_id)
    if s:
        s.discard(ws)
        if not s:
            conns.pop(user_id, None)


async def _send(user_id: int, event: dict):
    for ws in list(conns.get(user_id, ())):
        try:
            await ws.send_json(event)
        except Exception:
            disconnect_safely(user_id, ws)


def disconnect_safely(user_id: int, ws: WebSocket):
    s = conns.get(user_id)
    if s:
        s.discard(ws)


def push(user_ids, event: dict):
    """Отправить событие всем онлайн-пользователям из списка (из любого потока)."""
    if loop is None:
        return
    ids = [i for i in set(user_ids) if i in conns]
    if not ids:
        return
    asyncio.run_coroutine_threadsafe(_fanout(ids, event), loop)


async def _fanout(ids, event):
    for uid in ids:
        await _send(uid, event)


def online(user_id: int) -> bool:
    return bool(conns.get(user_id))
