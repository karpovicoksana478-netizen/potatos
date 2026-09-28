"""Генератор иконок potatos (картошка). Запуск: python make_icon.py"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
BODY = (206, 143, 79, 255)
BODY_D = (170, 111, 58, 255)
SPOT = (150, 96, 50, 255)
FACE = (74, 45, 22, 255)
HL = (233, 183, 130, 255)


def potato(size, scale=1.0):
    S = size
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = S / 2
    k = (S / 2) * 0.80 * scale

    # тело: несколько перекрывающихся эллипсов -> неровная картошка
    blobs = [(-0.05, -0.02, 1.00, 0.94), (0.12, -0.14, 0.74, 0.70),
             (-0.16, 0.10, 0.70, 0.76), (0.10, 0.16, 0.72, 0.66),
             (-0.06, -0.20, 0.62, 0.58)]
    for ox, oy, w, h in blobs:
        x0 = c + ox * k - (w * k)
        y0 = c + oy * k - (h * k)
        x1 = c + ox * k + (w * k)
        y1 = c + oy * k + (h * k)
        d.ellipse((x0, y0, x1, y1), fill=BODY)

    # тени по краям
    shade = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ds = ImageDraw.Draw(shade)
    ds.ellipse((c - k * 1.05, c - k * 0.9, c + k * 1.05, c + k * 1.12), fill=(120, 70, 30, 110))
    shade = shade.filter(ImageFilter.GaussianBlur(S * 0.045))
    mask = Image.new("L", (S, S), 0)
    dm = ImageDraw.Draw(mask)
    dm.ellipse((c - k, c - k * 0.92, c + k, c + k * 1.05), fill=255)
    img = Image.composite(Image.alpha_composite(img, shade), img, mask)
    d = ImageDraw.Draw(img)

    # «глазки» картошки по краям
    for ox, oy in ((-0.70, 0.10), (0.68, -0.30), (-0.55, 0.55), (0.50, 0.60)):
        x = c + ox * k
        y = c + oy * k
        r = k * 0.07
        d.ellipse((x - r, y - r, x + r, y + r), fill=SPOT)

    # блик
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dh = ImageDraw.Draw(hl)
    dh.ellipse((c - k * 0.62, c - k * 0.74, c - k * 0.02, c - k * 0.24), fill=(255, 255, 255, 70))
    hl = hl.filter(ImageFilter.GaussianBlur(S * 0.035))
    img = Image.alpha_composite(img, hl)
    d = ImageDraw.Draw(img)

    # улыбка
    bw = max(2, int(S * 0.022))
    box = (c - k * 0.40, c - k * 0.10, c + k * 0.40, c + k * 0.62)
    d.arc(box, start=20, end=160, fill=FACE, width=bw)

    # глаза-точки для смайлика
    for ox in (-0.30, 0.30):
        x = c + ox * k
        y = c - k * 0.22
        r = k * 0.10
        d.ellipse((x - r, y - r * 1.15, x + r, y + r * 1.15), fill=FACE)
        r2 = r * 0.34
        d.ellipse((x - r * 0.3, y - r * 0.75, x - r * 0.3 + r2, y - r * 0.75 + r2), fill=(255, 255, 255, 220))

    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    potato(512).save(os.path.join(OUT, "icon-512.png"))
    potato(192).save(os.path.join(OUT, "icon-192.png"))
    potato(180).save(os.path.join(OUT, "favicon.png"))
    potato(512, scale=0.72).save(os.path.join(OUT, "icon-maskable.png"))
    potato(192).save(os.path.join(OUT, "icon-192.png"))
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
           '<rect width="100" height="100" rx="22" fill="#08080c"/>'
           '<ellipse cx="50" cy="52" rx="34" ry="31" fill="#ce8f4f"/>'
           '<ellipse cx="60" cy="42" rx="22" ry="19" fill="#ce8f4f"/>'
           '<ellipse cx="40" cy="62" rx="24" ry="20" fill="#ce8f4f"/>'
           '<circle cx="26" cy="56" r="3.4" fill="#966032"/>'
           '<circle cx="74" cy="44" r="3.4" fill="#966032"/>'
           '<path d="M38 60 q12 12 24 0" stroke="#4a2d16" stroke-width="3.6" fill="none" '
           'stroke-linecap="round"/>'
           '<circle cx="42" cy="47" r="4" fill="#4a2d16"/>'
           '<circle cx="58" cy="47" r="4" fill="#4a2d16"/>'
           '<circle cx="43.4" cy="45.4" r="1.3" fill="#fff"/>'
           '<circle cx="59.4" cy="45.4" r="1.3" fill="#fff"/></svg>')
    with open(os.path.join(OUT, "icon.svg"), "w", encoding="utf-8") as f:
        f.write(svg)
    print("icons ok ->", OUT)


if __name__ == "__main__":
    main()
