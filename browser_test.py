"""Интерфейсный тест potatos в реальном браузере (Edge headless).
Запуск: python potatos/browser_test.py   (сервер должен быть запущен)"""
import random
import sys
import time

import httpx
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.edge.options import Options
from selenium.webdriver.edge.service import Service
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

BASE = __import__("os").environ.get("POTATOS_BASE", "http://127.0.0.1:8000")
OUT = __import__("os").path.join(__import__("os").path.dirname(__import__("os").path.abspath(__file__)), "shots")
ok = 0


def check(name, cond, extra=""):
    global ok
    print(("  OK   " if cond else "  FAIL ") + str(name) + ((" :: " + str(extra)) if not cond else ""))
    if cond:
        ok += 1
    else:
        print("ПРОВАЛЕНО:", name)
        sys.exit(1)


def wait(driver, css, timeout=12):
    return WebDriverWait(driver, timeout).until(EC.presence_of_element_located((By.CSS_SELECTOR, css)))


def wait_hash(driver, h, timeout=15):
    return WebDriverWait(driver, timeout).until(
        lambda d: d.execute_script("return location.hash") == h)


def shot(driver, name):
    import os
    os.makedirs(OUT, exist_ok=True)
    driver.save_screenshot(f"{OUT}\\{name}.png")
    print("       screenshot:", name + ".png")


def js_errs(driver):
    return driver.execute_script("return window.__errs || []")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    s = str(random.randint(10000, 99999))
    U = "ui" + s

    # готовим контент заранее
    c = httpx.Client(base_url=BASE, timeout=60)
    from PIL import Image
    import io

    def img(color):
        buf = io.BytesIO()
        Image.new("RGB", (400, 700), color).save(buf, "JPEG")
        return buf.getvalue()

    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--window-size=400,860")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--autoplay-policy=no-user-gesture-required")
    opts.add_argument("--use-fake-device-for-media-stream")
    opts.add_argument("--use-fake-ui-for-media-stream")
    try:
        driver = webdriver.Edge(options=opts)
    except Exception as e:
        print("  FAIL не удалось запустить Edge:", e)
        sys.exit(1)
    driver.set_script_timeout(20)

    try:
        driver.get(BASE)
        wait(driver, ".auth", 15)
        check("экран входа", driver.find_element(By.CSS_SELECTOR, ".brand").text.startswith("pota"))
        shot(driver, "01-auth")

        # регистрация
        driver.find_element(By.CSS_SELECTOR, "[data-mode=reg]").click()
        time.sleep(0.3)
        driver.find_element(By.CSS_SELECTOR, "[name=nickname]").send_keys("Тест Картошка")
        driver.find_element(By.CSS_SELECTOR, "[name=username]").send_keys(U)
        driver.find_element(By.CSS_SELECTOR, "[name=password]").send_keys("12345")
        driver.find_element(By.CSS_SELECTOR, "[data-go]").click()
        wait(driver, "#tabbar .tab", 15)
        check("регистрация и вход", driver.execute_script("return !!window.App.me && App.me.username") == U)
        time.sleep(1.2)
        shot(driver, "02-home")
        check("нижняя навигация из 4 кнопок",
              len(driver.find_elements(By.CSS_SELECTOR, "#tabbar .tab")) == 4)

        # наполняем ленту через API этим же пользователем
        token = driver.execute_script("return App.token")
        h = {"Authorization": "Bearer " + token}
        for col in [(255, 200, 60), (90, 200, 160), (240, 110, 140)]:
            c.post("/api/upload", headers=h, files={"file": ("v.jpg", img(col), "image/jpeg")},
                   data={"caption": "тестовая публикация #" + s, "sound": "оригинальный звук"})
        driver.get(BASE + "/#/home")
        time.sleep(2)
        posts = driver.find_elements(By.CSS_SELECTOR, ".post")
        check("лента показывает посты", len(posts) >= 3, len(posts))
        check("в ленте есть действия (лайк/коммент)",
              len(driver.find_elements(By.CSS_SELECTOR, ".post [data-like]")) >= 3)
        shot(driver, "03-feed")

        # лайк
        driver.find_element(By.CSS_SELECTOR, ".post [data-like]").click()
        time.sleep(0.8)
        check("лайк поставился", driver.execute_script(
            "return document.querySelector('.post [data-like]').classList.contains('liked')"))

        # комментарии
        driver.find_element(By.CSS_SELECTOR, ".post [data-comment]").click()
        wait(driver, ".sheet .cmt-input", 10)
        check("открылись комментарии", len(driver.find_elements(By.CSS_SELECTOR, ".sheet .cmt-input")) == 1)
        driver.find_element(By.CSS_SELECTOR, ".sheet .cmt-input input").send_keys("отлично!")
        driver.find_element(By.CSS_SELECTOR, ".sheet .cmt-input .csend").click()
        wait(driver, ".sheet .cmt", 10)
        check("комментарий отправлен", len(driver.find_elements(By.CSS_SELECTOR, ".sheet .cmt")) >= 1)
        # ответ на комментарий
        driver.find_element(By.CSS_SELECTOR, ".sheet .cmt [data-reply]").click()
        wait(driver, ".sheet .cmt-chip", 10)
        check("чип ответа показан", len(driver.find_elements(By.CSS_SELECTOR, ".sheet .cmt-chip")) == 1)
        driver.find_element(By.CSS_SELECTOR, ".sheet .cmt-input input").send_keys("и я!")
        driver.find_element(By.CSS_SELECTOR, ".sheet .cmt-input .csend").click()
        wait(driver, ".sheet .cmt-quote", 10)
        check("ответ отправлен", len(driver.find_elements(By.CSS_SELECTOR, ".sheet .cmt-quote")) == 1)
        driver.find_element(By.CSS_SELECTOR, ".sheet .cmt .u b").click()
        time.sleep(1.5)
        check("профиль автора комментария открыт",
              driver.execute_script("return location.hash").startswith("#/profile/"))
        driver.get(BASE + "/#/home")
        time.sleep(1.5)
        shot(driver, "04-comments")

        # профиль
        driver.find_element(By.CSS_SELECTOR, "#tabbar .tab[data-tab=profile]").click()
        time.sleep(1.5)
        check("профиль открыт", driver.find_element(By.CSS_SELECTOR, ".prof-user").text == "@" + U)
        check("сетка видео", len(driver.find_elements(By.CSS_SELECTOR, ".gcell")) >= 3)
        shot(driver, "05-profile")

        # редактирование профиля
        driver.find_element(By.CSS_SELECTOR, "[data-edit]").click()
        time.sleep(1)
        driver.find_element(By.CSS_SELECTOR, "[data-bio]").clear()
        driver.find_element(By.CSS_SELECTOR, "[data-bio]").send_keys("я тестирую potatos")
        driver.find_element(By.CSS_SELECTOR, "[data-save]").click()
        time.sleep(1.5)
        bio = driver.execute_script("return App.me.bio")
        check("био сохранилось", bio == "я тестирую potatos", bio)
        shot(driver, "06-edit")

        # общение
        driver.find_element(By.CSS_SELECTOR, "#tabbar .tab[data-tab=chats]").click()
        time.sleep(1.2)
        check("экран общения", len(driver.find_elements(By.CSS_SELECTOR, ".topbar .searchbar")) == 1)
        shot(driver, "07-chats")

        # поиск людей
        driver.find_element(By.CSS_SELECTOR, "[data-q]").send_keys(U)
        time.sleep(1.2)
        check("поиск нашёл пользователя",
              U in driver.find_element(By.CSS_SELECTOR, "[data-results]").text)
        shot(driver, "08-search")
        driver.find_element(By.CSS_SELECTOR, "[data-clearq]").click()
        time.sleep(0.6)

        # группа: кнопки создания в интерфейсе убраны — создаём через API и открываем
        g = c.post("/api/chats", headers=h, json={"type": "group", "title": "Тестовый клуб 🥔"}).json()
        check("группа создана через API", g.get("type") == "group", g)
        driver.get(BASE + f"/#/chat/{g['id']}")
        wait(driver, ".convo-head", 12)
        check("группа открыта",
              "Тестовый клуб" in driver.find_element(By.CSS_SELECTOR, ".convo-head").text)
        check("кнопки создания чатов убраны",
              len(driver.find_elements(By.CSS_SELECTOR, "[data-new]")) == 0)
        shot(driver, "09-group")

        # отправка сообщения
        driver.find_element(By.CSS_SELECTOR, "[data-input]").send_keys("привет из теста")
        driver.find_element(By.CSS_SELECTOR, "[data-send]").click()
        wait(driver, ".msg", 10)
        time.sleep(0.4)
        check("сообщение в чате", len(driver.find_elements(By.CSS_SELECTOR, ".msg.me")) == 1,
              (len(driver.find_elements(By.CSS_SELECTOR, ".msg")),
               driver.execute_script(
                   "return [...document.querySelectorAll('.msg')].map(m=>m.className).join('|')"),
               js_errs(driver)))
        shot(driver, "10-message")

        # стикеры
        driver.find_element(By.CSS_SELECTOR, "[data-stickers]").click()
        time.sleep(0.5)
        check("панель стикеров", len(driver.find_elements(By.CSS_SELECTOR, ".stickers button")) >= 20)
        driver.find_elements(By.CSS_SELECTOR, ".stickers button")[0].click()
        wait(driver, ".msg .sticker", 10)
        check("стикер отправлен", len(driver.find_elements(By.CSS_SELECTOR, ".msg .sticker")) == 1)
        shot(driver, "11-sticker")

        # настройки группы: меню -> "Настроить" -> сохранение
        driver.find_element(By.CSS_SELECTOR, "[data-menu]").click()
        wait(driver, ".sheet [data-setup]", 10)
        check("меню чата", len(driver.find_elements(By.CSS_SELECTOR, ".sheet [data-setup]")) == 1)
        shot(driver, "14-chatmenu")
        driver.find_element(By.CSS_SELECTOR, ".sheet [data-setup]").click()
        wait(driver, ".page [data-title]", 10)
        check("экран настроек группы",
              len(driver.find_elements(By.CSS_SELECTOR, ".page [data-title]")) == 1)
        shot(driver, "15-chatsettings")
        ttl = driver.find_element(By.CSS_SELECTOR, ".page [data-title]")
        ttl.clear(); ttl.send_keys("Клуб тестеров 🥔")
        dsc = driver.find_element(By.CSS_SELECTOR, ".page [data-desc]")
        dsc.clear(); dsc.send_keys("тестируем настройки")
        driver.find_element(By.CSS_SELECTOR, ".page [data-save]").click()
        WebDriverWait(driver, 12).until(
            lambda d: "Клуб тестеров" in d.find_element(By.CSS_SELECTOR, ".convo-head").text)
        check("название группы изменилось",
              "Клуб тестеров" in driver.find_element(By.CSS_SELECTOR, ".convo-head").text)

        # права: назначаем второго участника администратором из интерфейса
        cid = driver.execute_script("return +location.hash.split('/')[2]")
        U2 = "ui2" + s
        c.post("/api/register", json={"nickname": "Второй", "username": U2, "password": "12345"})
        check("участник добавлен через API",
              c.post(f"/api/chats/{cid}/members", headers=h, json={"username": U2}).status_code == 200)
        driver.find_element(By.CSS_SELECTOR, "[data-menu]").click()
        WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, ".sheet [data-u]")))
        time.sleep(0.6)
        rows = driver.find_elements(By.CSS_SELECTOR, ".sheet [data-u]")
        check("список участников", len(rows) == 2, len(rows))
        WebDriverWait(driver, 10).until(EC.element_to_be_clickable(rows[1]))
        rows[1].click()
        wait(driver, ".sheet [data-promote]", 10)
        check("панель действий участника",
              len(driver.find_elements(By.CSS_SELECTOR, ".sheet [data-promote]")) == 1)
        shot(driver, "16-member")
        driver.find_element(By.CSS_SELECTOR, ".sheet [data-promote]").click()
        WebDriverWait(driver, 12).until(
            lambda d: "админ" in d.find_element(By.CSS_SELECTOR, ".sheet [data-members]").text)
        check("администратор назначен",
              "админ" in driver.find_element(By.CSS_SELECTOR, ".sheet [data-members]").text)
        shot(driver, "17-admin")
        driver.execute_script("Overlay.close()")
        time.sleep(0.5)

        # карандаш: фото -> рисуем -> публикуем (вместо старого редактора)
        import os as _os
        import tempfile as _tf
        edjpg = _os.path.join(_tf.gettempdir(), "potatos-ed.jpg")
        Image.new("RGB", (900, 1600), (120, 180, 255)).save(edjpg, "JPEG")
        driver.get(BASE + "/#/plus")
        time.sleep(1.2)
        check("вкладка редактора убрана",
              len(driver.find_elements(By.CSS_SELECTOR, "[data-m=edit]")) == 0)
        driver.execute_script("var i=document.querySelector('#f-photo'); i.hidden=false;")
        driver.find_element(By.CSS_SELECTOR, "#f-photo").send_keys(edjpg)
        wait(driver, "[data-preview]:not([hidden]) img.preview", 10)
        check("фото в превью", len(driver.find_elements(
            By.CSS_SELECTOR, "[data-preview]:not([hidden]) img.preview")) == 1)
        driver.find_element(By.CSS_SELECTOR, "[data-draw]").click()
        wait(driver, ".draw-modal canvas", 10)
        check("окно рисования", len(driver.find_elements(By.CSS_SELECTOR, ".draw-modal canvas")) == 1)
        check("палитра карандаша", len(driver.find_elements(By.CSS_SELECTOR, ".draw-color")) >= 6)
        from selenium.webdriver.common.action_chains import ActionChains
        cv = driver.find_element(By.CSS_SELECTOR, ".draw-modal canvas")
        ActionChains(driver).move_to_element(cv).click_and_hold().move_by_offset(70, 110).release().perform()
        time.sleep(0.5)
        shot(driver, "21-draw")
        px = driver.execute_script("""
          const c = document.querySelector('.draw-modal canvas');
          const d = c.getContext('2d').getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data;
          return [d[0], d[1], d[2], d[3]];
        """)
        check("линия карандашом на холсте", px[0] > 230 and px[1] > 230 and px[2] > 230, px)
        driver.find_element(By.CSS_SELECTOR, ".draw-modal [data-ok]").click()
        WebDriverWait(driver, 15).until(
            lambda d: len(d.find_elements(By.CSS_SELECTOR, ".draw-modal")) == 0)
        check("окно рисования закрылось",
              len(driver.find_elements(By.CSS_SELECTOR, ".draw-modal")) == 0)
        driver.find_element(By.CSS_SELECTOR, "[data-caption]").send_keys("нарисовано карандашом")
        driver.execute_script("document.querySelector('[data-publish]').scrollIntoView({block:'center'})")
        time.sleep(0.8)
        driver.find_element(By.CSS_SELECTOR, "[data-publish]").click()
        wait_hash(driver, "#/home", 25)
        check("фото опубликовано",
              driver.execute_script("return location.hash") == "#/home")

        # эфир: камера -> запись -> публикация (видео!)
        driver.get(BASE + "/#/plus")
        time.sleep(1)
        driver.find_element(By.CSS_SELECTOR, "[data-m=live]").click()
        time.sleep(0.5)
        driver.find_element(By.CSS_SELECTOR, "[data-camstart]").click()
        # ждём, пока камера реально включится
        WebDriverWait(driver, 20).until(
            lambda d: "Начать эфир" in d.find_element(By.CSS_SELECTOR, "[data-camstart]").text)
        driver.find_element(By.CSS_SELECTOR, "[data-camstart]").click()
        WebDriverWait(driver, 20).until(
            lambda d: d.find_elements(By.CSS_SELECTOR, "[data-livebar]:not([hidden])") != [])
        check("идёт запись эфира", driver.find_elements(By.CSS_SELECTOR, "[data-livebar]:not([hidden])") != [])
        driver.find_element(By.CSS_SELECTOR, "[data-camstop]").click()
        wait(driver, "[data-preview]:not([hidden]) video", 25)
        check("превью эфира готово", driver.find_elements(By.CSS_SELECTOR, "[data-preview]:not([hidden]) video") != [])
        driver.find_element(By.CSS_SELECTOR, "[data-caption]").send_keys("мой первый эфир")
        driver.find_element(By.CSS_SELECTOR, "[data-sound]").send_keys("живой звук")
        driver.find_element(By.CSS_SELECTOR, "[data-publish]").click()
        wait_hash(driver, "#/home", 30)
        check("эфир опубликован", driver.execute_script("return location.hash") == "#/home")
        vids = driver.find_elements(By.CSS_SELECTOR, ".post video")
        check("в ленте есть видео", len(vids) >= 1, len(vids))
        check("живой эфир помечен", len(driver.find_elements(By.CSS_SELECTOR, ".post .live-tag")) >= 1)
        shot(driver, "13-live")

        # настройки профиля и темы оформления
        driver.get(BASE + "/#/profile/" + U)
        time.sleep(1.5)
        driver.find_element(By.CSS_SELECTOR, "[data-settings]").click()
        time.sleep(1)
        check("шестерёнка ведёт в настройки",
              driver.execute_script("return location.hash") == "#/settings")
        check("три темы на выбор",
              len(driver.find_elements(By.CSS_SELECTOR, "[data-th]")) == 3)
        shot(driver, "18-settings")
        driver.find_element(By.CSS_SELECTOR, "[data-th=light]").click()
        time.sleep(0.5)
        check("светлая тема включена",
              driver.execute_script("return document.documentElement.dataset.theme") == "light")
        shot(driver, "20-settings-light")
        driver.get(BASE + "/#/home")
        time.sleep(2)
        check("тема сохранилась после перезагрузки",
              driver.execute_script("return document.documentElement.dataset.theme") == "light")
        check("светлая лента отрисована",
              len(driver.find_elements(By.CSS_SELECTOR, ".post")) >= 3)
        shot(driver, "19-feed-light")
        driver.get(BASE + "/#/settings")
        time.sleep(1)
        driver.find_element(By.CSS_SELECTOR, "[data-th=purple]").click()
        time.sleep(0.5)
        check("фиолетовая тема включена",
              driver.execute_script("return document.documentElement.dataset.theme") == "purple")
        shot(driver, "22-settings-purple")
        driver.get(BASE + "/#/home")
        time.sleep(1.5)
        check("фиолетовая лента отрисована",
              len(driver.find_elements(By.CSS_SELECTOR, ".post")) >= 3)
        shot(driver, "23-feed-purple")
        driver.get(BASE + "/#/settings")
        time.sleep(1)
        driver.find_element(By.CSS_SELECTOR, "[data-th=dark]").click()
        time.sleep(0.5)
        check("тёмная тема включена",
              driver.execute_script("return document.documentElement.dataset.theme") == "dark")

        # админка: вход аккаунтом администратора (данные из кода)
        driver.execute_script("localStorage.removeItem('potatos_token');location.reload()")
        time.sleep(2.5)
        wait(driver, ".auth", 15)
        driver.find_element(By.CSS_SELECTOR, "[name=username]").send_keys("dmitriy444")
        driver.find_element(By.CSS_SELECTOR, "[name=password]").send_keys("19892012Burmalda")
        driver.find_element(By.CSS_SELECTOR, "[data-go]").click()
        wait(driver, "#tabbar .tab", 15)
        time.sleep(1.5)
        check("вход администратором",
              driver.execute_script("return App.me && App.me.is_admin") is True)
        check("пятая вкладка «Админка»",
              len(driver.find_elements(By.CSS_SELECTOR, "#tabbar .tab")) == 5)
        driver.get(BASE + "/#/admin")
        wait(driver, ".admin-row", 15)
        time.sleep(1.5)
        check("список пользователей в админке",
              len(driver.find_elements(By.CSS_SELECTOR, ".admin-row")) >= 2)
        check("статистика админки",
              all(b.strip() and b.strip() != "…" for b in
                  [x.text for x in driver.find_elements(By.CSS_SELECTOR, ".astat b")]))
        check("кнопки бана видны",
              len(driver.find_elements(By.CSS_SELECTOR, ".admin-row [data-ban]")) >= 2)
        shot(driver, "24-admin")

        driver.get(BASE + "/#/chats")
        time.sleep(1)
        check("нет JS-ошибок", not js_errs(driver), js_errs(driver))
        shot(driver, "12-done")

        print(f"\n== UI PASSED {ok} checks ==")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
