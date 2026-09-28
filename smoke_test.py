import io
import random
import sys

import httpx

BASE = "http://127.0.0.1:8000"
c = httpx.Client(base_url=BASE, timeout=60)
ok = 0


def check(name, cond, extra=""):
    global ok
    print(("  OK   " if cond else "  FAIL ") + name + ((" :: " + str(extra)) if not cond else ""))
    if cond:
        ok += 1
    else:
        sys.exit(1)


def png(px=64):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (px, px), (200, 140, 60)).save(buf, "JPEG")
    return buf.getvalue()


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    print("== potatos smoke test ==")
    S = str(random.randint(10000, 99999))
    U1, U2 = "potato" + S, "friend" + S

    check("health", c.get("/api/health").json().get("ok") is True)

    a = c.post("/api/register", json={"nickname": "Картошка", "username": U1, "password": "1234"}).json()
    b = c.post("/api/register", json={"nickname": "Друг", "username": U2, "password": "1234"}).json()
    check("register", "token" in a and "token" in b)
    ha = {"Authorization": "Bearer " + a["token"]}
    hb = {"Authorization": "Bearer " + b["token"]}

    r = c.post("/api/register", json={"nickname": "x", "username": U1, "password": "1234"})
    check("duplicate username rejected", r.status_code == 400)
    check("bad token rejected", c.get("/api/me").status_code == 401)

    me = c.get("/api/me", headers=ha).json()
    check("me", me["user"]["username"] == U1)

    up = c.post("/api/upload", headers=ha,
                files={"file": ("pic.jpg", png(), "image/jpeg")},
                data={"caption": "первая публикация", "sound": "оригинальный звук"}).json()
    check("upload", bool(up.get("id")) and up["kind"] == "photo", up)

    c.post("/api/upload", headers=hb, files={"file": ("p2.jpg", png(), "image/jpeg")},
           data={"caption": "привет"})
    feed = c.get("/api/feed").json()
    check("feed", len(feed["items"]) >= 2 and feed["items"][0]["user"]["username"] == U2, feed)
    vid = feed["items"][0]["id"]

    check("like", c.post(f"/api/video/{vid}/like", headers=ha).json()["liked"] is True)
    check("like count", c.get("/api/feed").json()["items"][0]["likes"] == 1)
    check("like toggle off", c.post(f"/api/video/{vid}/like", headers=ha).json()["liked"] is False)
    c.post(f"/api/video/{vid}/like", headers=ha)
    check("save", c.post(f"/api/video/{vid}/save", headers=ha).json()["saved"] is True)
    check("repost", c.post(f"/api/video/{vid}/repost", headers=ha).json()["reposted"] is True)
    check("saved list", len(c.get("/api/saved", headers=ha).json()["items"]) == 1)
    cm = c.post(f"/api/video/{vid}/comments", headers=ha, data={"text": "класс!"}).json()
    check("comment", cm["text"] == "класс!")
    check("comments list", len(c.get(f"/api/video/{vid}/comments").json()["items"]) == 1)
    cm2 = c.post(f"/api/video/{vid}/comments", headers=ha,
                 data={"text": "и я!", "parent_id": str(cm["id"])},
                 files={"file": ("cm.jpg", png(80), "image/jpeg")}).json()
    check("comment reply", bool(cm2.get("parent")) and cm2["parent"]["id"] == cm["id"], cm2)
    check("comment photo", cm2.get("media", "").startswith("images/"), cm2)
    check("comment photo served", c.get("/media/" + cm2["media"]).status_code == 200)
    items = c.get(f"/api/video/{vid}/comments").json()["items"]
    check("comments list 2", len(items) == 2, items)
    check("view", c.post(f"/api/video/{vid}/view").status_code == 200)

    check("follow", c.post(f"/api/user/{U2}/follow", headers=ha).json()["followed"] is True)
    prof = c.get(f"/api/user/{U2}", headers=ha).json()
    check("profile stats", prof["stats"]["followers"] == 1 and prof["stats"]["followed"] is True)
    check("followers circles", len(c.get(f"/api/user/{U2}/followers").json()["items"]) == 1)
    check("following feed", len(c.get("/api/feed?scope=following", headers=ha).json()["items"]) == 1)

    check("edit profile",
          c.patch("/api/me", headers=ha, json={"bio": "я картошка"}).json()["user"]["bio"] == "я картошка")
    av = c.post("/api/me/avatar", headers=ha, files={"file": ("a.jpg", png(), "image/jpeg")}).json()
    check("avatar", av["user"]["avatar"].startswith("avatars/"))
    check("user videos", len(c.get(f"/api/user/{U1}/videos").json()["items"]) == 1)

    # --- редактор: обрезка, склейка, публикация обработанного файла ---
    import os
    import subprocess
    import tempfile

    ff = None
    try:
        import imageio_ffmpeg
        ff = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        ff = None
    tmp = tempfile.mkdtemp()
    clip = os.path.join(tmp, "a.mp4")
    if ff:
        subprocess.run([ff, "-hide_banner", "-y", "-f", "lavfi", "-i",
                        "testsrc=duration=2:size=320x240:rate=15",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", clip],
                       capture_output=True, timeout=180)
    if ff and os.path.isfile(clip) and os.path.getsize(clip) > 1000:
        blob = open(clip, "rb").read()
        tr = c.post("/api/edit/trim", headers=ha,
                    files={"file": ("a.mp4", blob, "video/mp4")},
                    data={"start": "0.5", "end": "1.5"}).json()
        check("edit trim", tr.get("media", "").startswith("edited/"), tr)
        cat = c.post("/api/edit/concat", headers=ha,
                     files=[("files", ("a.mp4", blob, "video/mp4")),
                            ("files", ("b.mp4", blob, "video/mp4"))]).json()
        check("edit concat", cat.get("media", "").startswith("edited/"), cat)
        up2 = c.post("/api/upload", headers=ha,
                     files={"thumb": ("t.jpg", png(80), "image/jpeg")},
                     data={"caption": "из редактора", "media": tr["media"]}).json()
        check("upload edited media",
              up2.get("kind") == "video" and up2.get("media") == tr["media"], up2)
        check("edited media served", c.get("/media/" + tr["media"]).status_code == 200)
        check("bad media path rejected",
              c.post("/api/upload", headers=ha,
                     data={"media": "edited/../potatos.db", "caption": "x"}).status_code == 400)
        check("foreign media rejected",
              c.post("/api/upload", headers=ha,
                     data={"media": "videos/x.mp4", "caption": "x"}).status_code == 400)
        check("no media no file rejected",
              c.post("/api/upload", headers=ha, data={"caption": "x"}).status_code == 400)
    else:
        print("  SKIP edit tests (ffmpeg недоступен)")

    g = c.post("/api/chats", headers=ha, json={"type": "group", "title": "Клуб картошки",
                                               "description": "общаемся"}).json()
    check("create group", g["type"] == "group" and g["can_post"] is True)
    ch = c.post("/api/chats", headers=ha, json={"type": "channel", "title": "Новости картошки"}).json()
    check("create channel", ch["type"] == "channel")
    check("channel link", len(ch["link"]) >= 6)

    dm = c.post("/api/chats/dm", headers=ha, json={"username": U2}).json()
    check("open dm", dm["type"] == "dm" and dm["peer"]["username"] == U2)
    dm2 = c.post("/api/chats/dm", headers=ha, json={"username": U2}).json()
    check("dm is stable", dm2["id"] == dm["id"])

    msg = c.post(f"/api/chats/{dm['id']}/send", headers=ha, data={"text": "привет!", "kind": "text"}).json()
    check("send dm", msg["text"] == "привет!")
    msg2 = c.post(f"/api/chats/{dm['id']}/send", headers=hb, data={"text": "и тебе привет", "kind": "text"}).json()
    check("send reply", msg2["user_id"] != msg["user_id"])
    hist = c.get(f"/api/chats/{dm['id']}/messages", headers=hb).json()["items"]
    check("history", len(hist) == 2 and hist[0]["text"] == "привет!", hist)
    check("read", c.post(f"/api/chats/{dm['id']}/read", headers=hb).json()["ok"] is True)
    lst = c.get("/api/chats", headers=hb).json()["items"]
    check("chat list last", any(x["last"] and x["last"]["text"] == "и тебе привет" for x in lst), lst)

    check("join by link", c.post(f"/api/chats/{ch['id']}/join", headers=hb).json()["joined"] is True)
    r = c.post(f"/api/chats/{ch['id']}/send", headers=hb, data={"text": "не твоя ветка", "kind": "text"})
    check("only owner posts in channel", r.status_code == 403)
    st = c.post(f"/api/chats/{ch['id']}/send", headers=ha, data={"text": "стикер", "sticker": "🥔"}).json()
    check("sticker", st["kind"] == "sticker" and st["text"] == "🥔")
    check("add member", c.post(f"/api/chats/{g['id']}/members", headers=ha,
                               json={"username": U2}).json()["members_count"] == 2)
    gm = c.post(f"/api/chats/{g['id']}/send", headers=hb, data={"text": "я в группе", "kind": "text"})
    check("group member can post", gm.status_code == 200)

    s = c.get("/api/search", params={"q": U1}, headers=ha).json()
    check("search people", any(u["username"] == U1 for u in s["users"]), s)
    s2 = c.get("/api/search", params={"q": "Новости"}).json()
    check("search chats", any(x["title"] == "Новости картошки" for x in s2["chats"]), s2)
    s3 = c.get("/api/search", params={"q": "Новости"}, headers=hb).json()
    check("joined chats hidden from search",
          not any(x["id"] == ch["id"] for x in s3["chats"]), s3)
    check("chat by link", c.get(f"/api/chat-by-link/{ch['link']}", headers=hb).json()["id"] == ch["id"])

    # --- права: роли в группе, настройки чата, удаление ---
    U3 = "guest" + S
    d3 = c.post("/api/register", json={"nickname": "Гость", "username": U3, "password": "1234"}).json()
    hc = {"Authorization": "Bearer " + d3["token"]}
    uid1 = c.get("/api/me", headers=ha).json()["user"]["id"]
    uid2 = c.get("/api/me", headers=hb).json()["user"]["id"]
    uid3 = c.get("/api/me", headers=hc).json()["user"]["id"]

    r2 = c.post("/api/chats", headers=ha, json={"type": "group", "title": "Роли",
                                                "description": "старое описание"}).json()
    check("group brief", r2["role"] == "owner" and r2["can_manage"] is True)
    c.post(f"/api/chats/{r2['id']}/members", headers=ha, json={"username": U2})
    c.post(f"/api/chats/{r2['id']}/members", headers=ha, json={"username": U3})

    check("member cannot edit chat",
          c.patch(f"/api/chats/{r2['id']}", headers=hc, json={"title": "взлом"}).status_code == 403)
    check("member cannot add member",
          c.post(f"/api/chats/{r2['id']}/members", headers=hc, json={"username": U1}).status_code == 403)
    check("member cannot set roles",
          c.post(f"/api/chats/{r2['id']}/roles", headers=hc,
                 json={"username": U2, "role": "admin"}).status_code == 403)
    check("member cannot kick",
          c.delete(f"/api/chats/{r2['id']}/members/{uid2}", headers=hc).status_code == 403)
    check("member cannot delete chat",
          c.delete(f"/api/chats/{r2['id']}", headers=hc).status_code == 403)
    check("member cannot upload avatar",
          c.post(f"/api/chats/{r2['id']}/avatar", headers=hc,
                 files={"file": ("x.jpg", png(), "image/jpeg")}).status_code == 403)

    check("owner promotes admin",
          c.post(f"/api/chats/{r2['id']}/roles", headers=ha,
                 json={"username": U2, "role": "admin"}).json()["role"] == "admin")
    gb = c.get(f"/api/chats/{r2['id']}", headers=hb).json()
    check("admin brief", gb["role"] == "admin" and gb["can_manage"] is True)
    check("admin edits chat",
          c.patch(f"/api/chats/{r2['id']}", headers=hb,
                  json={"title": "Новая роль", "description": "новое описание"}).json()["title"] == "Новая роль")
    avc = c.post(f"/api/chats/{r2['id']}/avatar", headers=hb,
                 files={"file": ("c.jpg", png(), "image/jpeg")}).json()
    check("admin chat avatar", avc["avatar"].startswith("avatars/"))
    check("admin cannot promote",
          c.post(f"/api/chats/{r2['id']}/roles", headers=hb,
                 json={"username": U3, "role": "admin"}).status_code == 403)
    check("owner promotes second admin",
          c.post(f"/api/chats/{r2['id']}/roles", headers=ha,
                 json={"username": U3, "role": "admin"}).json()["role"] == "admin")
    check("admin cannot kick admin",
          c.delete(f"/api/chats/{r2['id']}/members/{uid3}", headers=hb).status_code == 403)
    check("owner demotes admin",
          c.post(f"/api/chats/{r2['id']}/roles", headers=ha,
                 json={"username": U3, "role": "member"}).json()["role"] == "member")
    check("admin kicks member",
          c.delete(f"/api/chats/{r2['id']}/members/{uid3}", headers=hb).json()["members_count"] == 2)
    check("admin cannot kick owner",
          c.delete(f"/api/chats/{r2['id']}/members/{uid1}", headers=hb).status_code == 403)

    m1 = c.post(f"/api/chats/{r2['id']}/send", headers=ha,
                data={"text": "сообщение владельца", "kind": "text"}).json()
    m2 = c.post(f"/api/chats/{r2['id']}/send", headers=hb,
                data={"text": "сообщение администратора", "kind": "text"}).json()
    check("admin cannot delete owner message",
          c.delete(f"/api/chats/{r2['id']}/messages/{m1['id']}", headers=hb).status_code == 403)
    check("admin deletes own message",
          c.delete(f"/api/chats/{r2['id']}/messages/{m2['id']}", headers=hb).json()["ok"] is True)
    m3 = c.post(f"/api/chats/{r2['id']}/send", headers=ha,
                data={"text": "второе сообщение владельца", "kind": "text"}).json()
    check("owner deletes other message",
          c.delete(f"/api/chats/{r2['id']}/messages/{m3['id']}", headers=ha).json()["ok"] is True)
    check("gone message is gone",
          len([m for m in c.get(f"/api/chats/{r2['id']}/messages", headers=ha).json()["items"]
               if m["id"] == m3["id"]]) == 0)

    check("owner promotes channel admin",
          c.post(f"/api/chats/{ch['id']}/roles", headers=ha,
                 json={"username": U2, "role": "admin"}).json()["role"] == "admin")
    check("admin posts in channel",
          c.post(f"/api/chats/{ch['id']}/send", headers=hb,
                 data={"text": "админский пост", "kind": "text"}).status_code == 200)
    check("admin cannot delete channel",
          c.delete(f"/api/chats/{ch['id']}", headers=hb).status_code == 403)
    check("admin cannot delete group",
          c.delete(f"/api/chats/{r2['id']}", headers=hb).status_code == 403)
    check("owner deletes group",
          c.delete(f"/api/chats/{r2['id']}", headers=ha).json()["ok"] is True)
    check("group is gone", c.get(f"/api/chats/{r2['id']}", headers=ha).status_code == 404)
    check("group left the list",
          not any(x["id"] == r2["id"] for x in c.get("/api/chats", headers=ha).json()["items"]))

    check("index served", "potatos" in c.get("/").text)
    check("js served", c.get("/static/app.js").status_code == 200)
    check("icon served", c.get("/static/icon-512.png").status_code == 200)
    check("media served", c.get("/media/" + up["media"]).status_code == 200)

    print(f"\n== PASSED {ok} checks ==")


if __name__ == "__main__":
    main()
