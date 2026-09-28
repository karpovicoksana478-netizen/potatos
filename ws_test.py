"""Тест реалтайм-доставки сообщений: python potatos/ws_test.py"""
import json
import random
import sys
import threading
import time

import httpx
import websocket

BASE = "http://127.0.0.1:8000"
WS = "ws://127.0.0.1:8000/ws"


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    s = str(random.randint(10000, 99999))
    c = httpx.Client(base_url=BASE, timeout=30)
    a = c.post("/api/register", json={"nickname": "A", "username": "ws_a" + s, "password": "1234"}).json()
    b = c.post("/api/register", json={"nickname": "B", "username": "ws_b" + s, "password": "1234"}).json()
    ha = {"Authorization": "Bearer " + a["token"]}
    dm = c.post("/api/chats/dm", headers=ha, json={"username": "ws_b" + s}).json()

    state_a = {"open": False, "events": []}
    state_b = {"open": False}

    def make(name, state, on_msg=None):
        def on_open(ws):
            state["open"] = True
        def on_message(ws, m):
            try:
                d = json.loads(m)
            except Exception:
                return
            state.setdefault("events", []).append(d)
            if on_msg:
                on_msg(d)
        return websocket.WebSocketApp(f"{WS}?token={name}",
                                      on_open=on_open, on_message=on_message)

    got_message = threading.Event()
    ws_a = make(a["token"], state_a, lambda d: got_message.set() if d.get("type") == "message" else None)
    ws_b = make(b["token"], state_b)
    ta = threading.Thread(target=ws_a.run_forever, daemon=True)
    tb = threading.Thread(target=ws_b.run_forever, daemon=True)
    ta.start(); tb.start()

    deadline = time.time() + 5
    while time.time() < deadline and not (state_a["open"] and state_b["open"]):
        time.sleep(0.1)
    time.sleep(0.4)

    c.post(f"/api/chats/{dm['id']}/send", headers=ha,
           data={"text": "привет по ws", "kind": "text"})
    ws_b.send(json.dumps({"type": "typing", "chat_id": dm["id"]}))

    delivered = got_message.wait(timeout=5)
    time.sleep(1.0)
    types = [e.get("type") for e in state_a["events"]]
    ok = state_a["open"] and state_b["open"] and delivered and "typing" in types
    print(("  OK   " if ok else "  FAIL ") + "ws realtime  types=" + str(types))
    try:
        ws_a.close(); ws_b.close()
    except Exception:
        pass
    if not ok:
        sys.exit(1)
    print("== WS PASSED ==")


if __name__ == "__main__":
    main()
