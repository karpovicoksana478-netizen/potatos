#!/usr/bin/env bash
# Автоматическая установка potatos на чистый Ubuntu с root-доступом.
# Запуск: sudo bash deploy.sh [домен]
#   sudo bash deploy.sh potatos.example.com
#   sudo bash deploy.sh                 (установка только по IP)
set -euo pipefail

DOMAIN="${1:-}"
REPO="https://github.com/karpovicoksana478-netizen/potatos.git"
APP_DIR="/opt/potatos"
DATA_DIR="/opt/potatos-data"

echo "== apt update =="
apt-get update -y

echo "== installing packages =="
apt-get install -y python3 python3-venv python3-pip python3-dev \
    nginx certbot python3-certbot-nginx ufw git ffmpeg curl

echo "== creating user/dirs =="
mkdir -p "$APP_DIR" "$DATA_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
    git clone "$REPO" "$APP_DIR"
else
    git -C "$APP_DIR" pull --ff-only
fi

echo "== venv + deps (это займёт пару минут) =="
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip wheel
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"

echo "== .env (поменяйте пароль!) =="
read -rsp "POTATOS_ADMIN_PASSWORD (или Enter, чтобы оставить по умолчанию): " ADMIN_PW || true
echo
if [ -n "$ADMIN_PW" ]; then
    printf 'POTATOS_ADMIN_PASSWORD=%s\n' "$ADMIN_PW" > "$APP_DIR/.env"
    printf 'POTATOS_DATA=%s\n' "$DATA_DIR" >> "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"
    echo ".env записан"
else
    printf 'POTATOS_DATA=%s\n' "$DATA_DIR" > "$APP_DIR/.env"
    echo ".env записан с POTATOS_DATA (пароль админа — как в коде, см. DEPLOY.md)"
fi

echo "== systemd service =="
cp "$APP_DIR/deploy/potatos.service" /etc/systemd/system/potatos.service
if [ -n "$ADMIN_PW" ]; then
    sed -i "s#change_me_strong_password#${ADMIN_PW}#" /etc/systemd/system/potatos.service
fi
systemctl daemon-reload
systemctl enable --now potatos

echo "== nginx =="
sed "s#potatos.example.com#${DOMAIN:-_}#" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/potatos
ln -sf /etc/nginx/sites-available/potatos /etc/nginx/sites-enabled/potatos
nginx -t && systemctl reload nginx

echo "== firewall =="
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

if [ -n "$DOMAIN" ]; then
    echo "== HTTPS (certbot) =="
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@"$DOMAIN" || \
        echo "certbot не прошёл — выпустите вручную: certbot --nginx -d $DOMAIN"
fi

echo
echo "== DONE =="
systemctl status potatos --no-pager || true
echo "Проверка: curl -s http://127.0.0.1:8000/api/health"
curl -s http://127.0.0.1:8000/api/health && echo
