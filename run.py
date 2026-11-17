"""Лаунчер для хостинга (Render и т.п.).

Репозиторий — это сам пакет `potatos` (в корне лежат __init__.py, app.py и
относительные импорты `from . import db`). Локально сервер запускается из
родительской папки, где каталог называется `potatos`, а на хостинге код
лежит просто в корне репозитория, и `uvicorn potatos.app:app` не находит
пакет. Этот файл создаёт во временной папке подпакет с именем `potatos`,
указывающий на корень репозитория, и запускает uvicorn.
"""
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
# .env рядом с run.py (в .gitignore) — локальные секреты, например POTATOS_ADMIN_PASSWORD
env_path = os.path.join(ROOT, ".env")
if os.path.isfile(env_path):
    for line in open(env_path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

PKG = os.path.join(tempfile.gettempdir(), "potatos_pkg")
INNER = os.path.join(PKG, "potatos")

os.makedirs(INNER, exist_ok=True)
with open(os.path.join(INNER, "__init__.py"), "w", encoding="utf-8") as f:
    f.write("__path__ = [%r]\n" % ROOT)
sys.path.insert(0, PKG)

import uvicorn

uvicorn.run(
    "potatos.app:app",
    host="0.0.0.0",
    port=int(os.environ.get("PORT", "8000")),
)
