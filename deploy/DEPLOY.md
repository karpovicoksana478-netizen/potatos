# Деплой potatos на VDS (Ubuntu 22.04 / 24.04)

> Сервер с нуля — около 10–15 минут. Нужен root-доступ и Ubuntu LTS.

## Вариант А — автоматически

```bash
# на сервере под root:
curl -s https://raw.githubusercontent.com/karpovicoksana478-netizen/potatos/main/deploy/deploy.sh -o deploy.sh
bash deploy.sh potatos.ваш-домен.ru      # или без домена: bash deploy.sh
```

Скрипт сам: поставит пакеты, склонирует репозиторий, создаст venv, запишет `.env`, установит systemd-сервис и nginx, откроет порты, при наличии домена — выпустит HTTPS.

## Вариант Б — вручную (по шагам)

### 1. Подготовка
```bash
apt update && apt upgrade -y
apt install -y python3 python3-venv python3-pip python3-dev nginx ufw git ffmpeg
mkdir -p /opt/potatos /opt/potatos-data
```

### 2. Код
```bash
git clone https://github.com/karpovicoksana478-netizen/potatos.git /opt/potatos
```

### 3. Python-окружение и зависимости
```bash
python3 -m venv /opt/potatos/.venv
/opt/potatos/.venv/bin/pip install --upgrade pip wheel
/opt/potatos/.venv/bin/pip install -r /opt/potatos/requirements.txt
```

### 4. Переменные окружения (`/opt/potatos/.env`)
```bash
printf 'POTATOS_DATA=/opt/potatos-data\nPOTATOS_ADMIN_PASSWORD=ваш_надёжный_пароль\n' > /opt/potatos/.env
chmod 600 /opt/potatos/.env
```
`run.py` сам подхватит `.env` из корня проекта. Если не задаёте пароль — используется значение по умолчанию из `app.py` (обязательно смените после первого входа в настройках → «Сменить пароль»).

### 5. systemd-сервис
```bash
cp /opt/potatos/deploy/potatos.service /etc/systemd/system/potatos.service
# если меняли пароль в .env — убедитесь, что в service он совпадает (или удалите Environment=POTATOS_ADMIN_PASSWORD)
systemctl daemon-reload
systemctl enable --now potatos
systemctl status potatos
curl -s http://127.0.0.1:8000/api/health   # -> {"ok":true,...}
```

### 6. Nginx + WebSocket
```bash
cp /opt/potatos/deploy/nginx.conf /etc/nginx/sites-available/potatos
sed -i 's/potatos.example.com/ВАШ_ПОЛНЫЙ_ДОМЕН/' /etc/nginx/sites-available/potatos
ln -sf /etc/nginx/sites-available/potatos /etc/nginx/sites-enabled/potatos
nginx -t && systemctl reload nginx
```
Если домена пока нет — замените `server_name` на `_`, доступ будет по IP.

### 7. Firewall
```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

### 8. HTTPS (когда появится домен)
```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d ВАШ_ДОМЕН
```
Камера и микрофон в эфирах работают **только по HTTPS или localhost** — выпуск HTTPS обязателен.

---

## Обновление
```bash
cd /opt/potatos && git pull --ff-only
/opt/potatos/.venv/bin/pip install -r requirements.txt
systemctl restart potatos
```

## Данные и бэкапы
Всё живёт в `/opt/potatos-data` (база `potatos.db` + папка `media/`). Бэкап:
```bash
tar -czf /root/potatos-$(date +%F).tar.gz -C /opt/potatos-data potatos.db media
```
Раз в сутки — добавить в cron:
```
0 3 * * * /bin/tar -czf /root/potatos-$(date +\%F).tar.gz -C /opt/potatos-data potatos.db media
```
Храните не меньше недели копий. Для восстановления — остановите сервис, распакуйте архив, запустите.

## Производительность на 2 vCPU / 4 GB
- uvicorn в один процесс; этого хватает на сотни активных пользователей;
- медиа отдаётся nginx-ом напрямую? нет — через приложение (это норма для малых инсталляций);
- `/static` кэшируется браузером (заголовки уже стоят);

## Что делать, если не заводится
- `journalctl -u potatos -n 100 --no-pager` — лог приложения;
- `ss -ltnp | grep 8000` — слушает ли приложение порт;
- `nginx -t` — синтаксис nginx;
- `curl -v http://127.0.0.1:8000/api/health` — ответ бэкенда;
- `curl -v http://127.0.0.1/` — ответ nginx.

## Безопасность
- Пароль админа храните только в `.env` (chmod 600), не коммитьте его;
- после первого входа смените пароль (настройки → «Сменить пароль»);
- порты наружу: 22 (SSH), 80/443 (HTTP/HTTPS); 8000 не открывать в firewall;
