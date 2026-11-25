"""Прямые эфиры (live) с чатом.

Транспорт видео — WebRTC mesh: стример отдаёт поток каждому зрителю напрямую,
сервер только сигналит (SDP/ICE через /ws) и держит комнаты в памяти.
Камера на ПК — 720p@30, на телефоне — 540p@24; экран — до 720p@30. Качество отправки
(в live.js) стартует на ступень скромнее целевого профиля и по статистике
WebRTC (CPU/потери) понижается, чтобы не было лагов. Звук — моно 64 кбит/с.
Не более 3 эфиров одновременно, лимит зрителей на эфир — MAX_VIEWERS.
"""
import threading
import time

from fastapi import APIRouter, Depends, HTTPException

from . import activity, auth, db, hub

router = APIRouter(prefix="/api/live")

MAX_STREAMS = 3
MAX_VIEWERS = 40
TITLE_MAX = 80
CHAT_MAX = 300
LIKE_MIN_INTERVAL = 0.12   # секунд между лайками от одного зрителя
LIKE_PUSH_INTERVAL = 0.25  # секунд между WS-рассылками счётчика
BROADCASTER_GRACE = 12.0   # секунд на переподключение стримера после обрыва WS

_lock = threading.Lock()
ROOMS: dict = {}   # sid -> {"broadcaster": int, "members": set[int]}
_last_like: dict = {}
_last_push: dict = {}
_throttle_lock = threading.Lock()


# ---------- комнаты ----------
def _viewers(room: dict) -> int:
    return len(room["members"] - {room["broadcaster"]})


def _announce(sid: int, room: dict):
    members = list(room["members"])
    viewers = _viewers(room)
    hub.push(members, {"type": "live-viewers", "sid": sid, "viewers": viewers})


def _cancel_end_timer(room: dict):
    timer = room.pop("end_timer", None)
    if timer is not None:
        try:
            timer.cancel()
        except Exception:
            pass


def _broadcaster_gone(sid: int):
    """Стример не вернулся за отведённое время — эфир действительно закончен."""
    with _lock:
        room = ROOMS.get(sid)
        if not room or "broadcaster_gone_at" not in room:
            return
        room.pop("end_timer", None)
    end_stream(sid)


def end_stream(sid: int):
    """Завершаем эфир: помечаем в БД, выгоняем комнату, уведомляем зрителей."""
    with _lock:
        room = ROOMS.pop(sid, None)
        members = list(room["members"]) if room else []
        if room:
            _cancel_end_timer(room)
    db.run("UPDATE live_streams SET ended_at=? WHERE id=? AND ended_at IS NULL",
           (db.now(), sid))
    with _throttle_lock:
        for k in [k for k in _last_like if k[0] == sid]:
            _last_like.pop(k, None)
        _last_push.pop(sid, None)
    if members:
        hub.push(members, {"type": "live-end", "sid": sid})


def _stream_payload(l: dict) -> dict:
    u = db.one("SELECT * FROM users WHERE id=?", (l["user_id"],))
    with _lock:
        room = ROOMS.get(l["id"])
        viewers = _viewers(room) if room else 0
    likes = db.one("SELECT COUNT(*) c FROM live_likes WHERE stream_id=?", (l["id"],))["c"]
    return {
        "id": l["id"],
        "title": l["title"],
        "created_at": l["created_at"],
        "viewers": viewers,
        "likes": likes,
        "user": auth.public_user(u) if u else None,
    }


def _push_likes(sid: int, likes: int):
    with _throttle_lock:
        now = time.time()
        if now - _last_push.get(sid, 0) < LIKE_PUSH_INTERVAL:
            return
        _last_push[sid] = now
    room = ROOMS.get(sid)
    if room:
        hub.push(list(room["members"]), {"type": "live-like", "sid": sid, "likes": likes})


# ---------- REST ----------
@router.post("/start")
def start(body: dict, user=Depends(auth.current_user)):
    body = body or {}
    title = (body.get("title") or "").strip()[:TITLE_MAX] or "Прямой эфир"
    if db.posts_blocked(user):
        raise HTTPException(403, "Вам запрещено публиковать — начать эфир нельзя")
    with _lock:
        mine_id = db.one("SELECT id FROM live_streams WHERE user_id=? AND ended_at IS NULL",
                         (user["id"],))
        if mine_id:
            raise HTTPException(400, "У вас уже идёт эфир")
        active = db.one("SELECT COUNT(*) c FROM live_streams WHERE ended_at IS NULL")["c"]
        if active >= MAX_STREAMS:
            raise HTTPException(400, "Сейчас уже идёт 3 эфира — попробуйте позже")
        sid = db.run("INSERT INTO live_streams (user_id, title, created_at) VALUES (?,?,?)",
                     (user["id"], title, db.now()))
    # уведомляем подписчиков в «Активность»
    followers = [r["follower_id"] for r in db.rows(
        "SELECT follower_id FROM follows WHERE followee_id=?", (user["id"],))]
    for fid in followers:
        activity.add(fid, "live", actor=user, post_id=sid,
                     text=f"{title} · /#/live/{sid}")
    return {"id": sid, "title": title, "max_streams": MAX_STREAMS}


@router.post("/{sid}/like")
def like(sid: int, user=Depends(auth.current_user)):
    st = db.one("SELECT * FROM live_streams WHERE id=?", (sid,))
    if not st or st["ended_at"]:
        raise HTTPException(404, "Эфир не найден или уже закончился")
    now = time.time()
    with _throttle_lock:
        last = _last_like.get((sid, user["id"]), 0)
        if now - last < LIKE_MIN_INTERVAL:
            raise HTTPException(429, "Слишком быстро — подождите секунду")
        _last_like[(sid, user["id"])] = now
    db.run("INSERT INTO live_likes (stream_id, user_id, created_at) VALUES (?,?,?)",
           (sid, user["id"], db.now()))
    likes = db.one("SELECT COUNT(*) c FROM live_likes WHERE stream_id=?", (sid,))["c"]
    _push_likes(sid, likes)
    return {"likes": likes}


@router.post("/end")
def end(body: dict = None, user=Depends(auth.current_user)):
    body = body or {}
    sid = int(body.get("id") or 0)
    if sid:
        st = db.one("SELECT * FROM live_streams WHERE id=?", (sid,))
        if not st or (st["user_id"] != user["id"] and not user.get("is_admin")):
            raise HTTPException(403, "Это не ваш эфир")
    else:
        st = db.one("SELECT * FROM live_streams WHERE user_id=? AND ended_at IS NULL",
                    (user["id"],))
        if not st:
            raise HTTPException(404, "У вас нет активного эфира")
        sid = st["id"]
    end_stream(sid)
    return {"ok": True}


@router.get("")
def list_active(user=Depends(auth.guest_or_user)):
    rows = db.rows("SELECT * FROM live_streams WHERE ended_at IS NULL ORDER BY id DESC")
    return {"items": [_stream_payload(l) for l in rows], "max": MAX_STREAMS}


@router.get("/{sid}")
def info(sid: int, user=Depends(auth.guest_or_user)):
    l = db.one("SELECT * FROM live_streams WHERE id=?", (sid,))
    if not l:
        raise HTTPException(404, "Эфир не найден")
    if l["ended_at"]:
        raise HTTPException(410, "Эфир уже закончился")
    return _stream_payload(l)


# ---------- WebSocket: сигнализация и чат ----------
def _room_of(sid: int):
    with _lock:
        return ROOMS.get(sid)


def ws_join(uid: int, data: dict):
    try:
        sid = int(data.get("sid") or data.get("stream_id") or 0)
    except (TypeError, ValueError):
        sid = 0
    st = db.one("SELECT * FROM live_streams WHERE id=?", (sid,))
    if not st or st["ended_at"]:
        hub.push([uid], {"type": "live-error", "sid": sid, "detail": "Эфир не найден или закончен"})
        return
    with _lock:
        room = ROOMS.setdefault(sid, {"broadcaster": st["user_id"], "members": set()})
        is_broadcaster = uid == st["user_id"]
        # WS мог переподключиться, а старый участник ещё числиться в комнате.
        # Если не убрать его, стример не пришлёт новый offer и зритель висит на загрузке.
        stale = uid in room["members"] and not is_broadcaster
        if uid in room["members"]:
            room["members"].discard(uid)
        if is_broadcaster:
            # вернулся после обрыва связи — эфир ещё жив, таймер завершения снимаем
            _cancel_end_timer(room)
            room.pop("broadcaster_gone_at", None)
            room["broadcaster"] = st["user_id"]
        if not is_broadcaster and _viewers(room) >= MAX_VIEWERS:
            full = True
        else:
            full = False
            room["members"].add(uid)
            viewers = _viewers(room)
        broadcaster_id = room["broadcaster"]
    if full:
        hub.push([uid], {"type": "live-full", "sid": sid})
        return
    if stale:
        # закрываем у стримера старый PC, чтобы на новый live-peer он создал свежий offer
        hub.push([broadcaster_id], {"type": "live-peer-left", "sid": sid, "from": uid})
    if is_broadcaster:
        # зрители могли зайти раньше стримера — создаём им offer теперь
        for viewer_id in [m for m in room["members"] if m != uid]:
            hub.push([uid], {"type": "live-peer", "sid": sid, "from": viewer_id})
    else:
        # стример создаёт offer для этого зрителя
        hub.push([st["user_id"]], {"type": "live-peer", "sid": sid, "from": uid})
    hub.push(list(room["members"]), {"type": "live-viewers", "sid": sid, "viewers": viewers})


def ws_leave(uid: int, data: dict):
    try:
        sid = int(data.get("sid") or data.get("stream_id") or 0)
    except (TypeError, ValueError):
        sid = 0
    _remove(uid, sid)


def _remove(uid: int, sid: int):
    with _lock:
        room = ROOMS.get(sid)
        if not room or uid not in room["members"]:
            return
        room["members"].discard(uid)
        broadcaster = room["broadcaster"]
        members = list(room["members"])
        if uid != broadcaster:
            viewers = _viewers(room)
        # комната broadcaster'а остаётся живой во время таймера, иначе зрители
        # увидят «эфир завершён» раньше, чем стример переподключится
    if uid == broadcaster:
        # WS мог оборваться на секунду: даём стримеру время переподключиться,
        # а не рубим эфир у всех зрителей сразу
        _cancel_end_timer(room)
        room["broadcaster_gone_at"] = time.time()
        timer = threading.Timer(BROADCASTER_GRACE, _broadcaster_gone, args=(sid,))
        timer.daemon = True
        room["end_timer"] = timer
        timer.start()
    else:
        hub.push([broadcaster], {"type": "live-peer-left", "sid": sid, "from": uid})
        hub.push(members, {"type": "live-viewers", "sid": sid, "viewers": viewers})


def ws_relay(uid: int, data: dict):
    try:
        sid = int(data.get("sid") or data.get("stream_id") or 0)
        to = int(data.get("to") or 0)
    except (TypeError, ValueError):
        return
    room = _room_of(sid)
    if not room or uid not in room["members"] or to not in room["members"]:
        return
    msg = {"type": data.get("type"), "sid": sid, "from": uid}
    if "sdp" in data:
        msg["sdp"] = data["sdp"]
    if "cand" in data:
        msg["cand"] = data["cand"]
    hub.push([to], msg)


def ws_chat(uid: int, data: dict):
    try:
        sid = int(data.get("sid") or data.get("stream_id") or 0)
    except (TypeError, ValueError):
        return
    room = _room_of(sid)
    if not room or uid not in room["members"]:
        return
    text = str(data.get("text") or "").strip()[:CHAT_MAX]
    if not text:
        return
    u = db.one("SELECT username, nickname, avatar FROM users WHERE id=?", (uid,))
    if not u:
        return
    hub.push(list(room["members"]), {
        "type": "live-chat", "sid": sid, "uid": uid,
        "username": u["username"], "nickname": u["nickname"], "avatar": u["avatar"],
        "text": text, "created_at": db.now()})


def disconnect(uid: int):
    """WS закрылся — выкидываем пользователя из всех комнат; стример = конец эфира."""
    with _lock:
        sids = [sid for sid, room in ROOMS.items() if uid in room["members"]]
    for sid in sids:
        _remove(uid, sid)
