@echo off
chcp 65001 >nul
title potatos — соцсеть
cd /d "%~dp0.."
echo.
echo   ================================
echo      potatos 🥔  запуск сервера
echo   ================================
echo   Откройте в браузере:  http://localhost:8000
echo   Остановить:  Ctrl+C
echo.
start "" http://localhost:8000
python -m uvicorn potatos.app:app --host 0.0.0.0 --port 8000
pause
