"""Простой in-memory rate-limiter (скользящее окно).

Держит попытки в памяти процесса — для одного инстанса uvicorn достаточно.
На нескольких процессах нужны внешние хранилища, но potatos — монолит на SQLite.
"""
import threading
import time
from collections import defaultdict

from fastapi import HTTPException

_lock = threading.Lock()
_hits: dict = defaultdict(list)


def check(name: str, key: str, limit: int, window: float):
    """Регистрируем попытку; при превышении — HTTP 429."""
    now = time.time()
    with _lock:
        lst = [t for t in _hits[f"{name}:{key}"] if now - t < window]
        if len(lst) >= limit:
            _hits[f"{name}:{key}"] = lst
            raise HTTPException(429, "Слишком много попыток — подождите немного и попробуйте снова")
        lst.append(now)
        _hits[f"{name}:{key}"] = lst
