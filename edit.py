import os
import secrets
import shutil
import subprocess
import tempfile

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from . import auth, db

router = APIRouter(prefix="/api")

MAX_EDIT = 400 * 1024 * 1024
MIN_CLIP = 0.2          # минимальная длина куска, сек
VIDEO_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
              "-pix_fmt", "yuv420p"]
AUDIO_ARGS = ["-c:a", "aac", "-b:a", "128k"]


def _ffmpeg() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    p = shutil.which("ffmpeg")
    if not p:
        raise HTTPException(500, "На сервере нет ffmpeg — обработка видео недоступна")
    return p


def _run(args, cwd=None):
    try:
        r = subprocess.run([_ffmpeg(), "-hide_banner", "-y"] + args,
                           capture_output=True, cwd=cwd, timeout=600)
    except subprocess.TimeoutExpired:
        raise HTTPException(400, "Обработка видео заняла слишком много времени")
    except OSError as e:
        print("ffmpeg error:", e)
        raise HTTPException(500, "Не удалось запустить обработку видео")
    if r.returncode != 0:
        tail = (r.stderr or b"").decode("utf-8", "ignore").splitlines()[-6:]
        print("ffmpeg failed:", *tail, sep="\n  ")
        raise HTTPException(400, "Не удалось обработать это видео")
    return r


def _probe(path: str):
    """Длительность и наличие звука — читаем только шапку файла."""
    try:
        r = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path],
                           capture_output=True, timeout=60)
    except (subprocess.TimeoutExpired, OSError):
        return 0.0, False
    out = (r.stderr or b"").decode("utf-8", "ignore")
    dur, audio = 0.0, "Audio:" in out
    for line in out.splitlines():
        if "Duration:" in line:
            try:
                h, m, s = line.split("Duration:")[1].split(",")[0].strip().split(":")
                dur = int(h) * 3600 + int(m) * 60 + float(s)
            except Exception:
                pass
            break
    return dur, audio


def _store(src: str, ext=".mp4") -> str:
    folder = os.path.join(db.MEDIA, "edited")
    os.makedirs(folder, exist_ok=True)
    name = secrets.token_hex(12) + ext
    shutil.move(src, os.path.join(folder, name))
    return "edited/" + name


async def _to_tmp(upload: UploadFile, folder: str) -> str:
    data = await upload.read()
    if not data:
        raise HTTPException(400, "Пустой файл")
    if len(data) > MAX_EDIT:
        raise HTTPException(413, "Файл слишком большой (макс. 400 МБ)")
    ext = os.path.splitext(upload.filename or "")[1].lower()
    if ext not in (".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".3gp", ".qt"):
        ext = ".mp4"
    path = os.path.join(folder, "in_" + secrets.token_hex(4) + ext)
    with open(path, "wb") as f:
        f.write(data)
    return path


def video_frame(media_rel: str):
    """Первый кадр видео в JPEG — для превью (учитывает наложенный рисунок)."""
    src = os.path.join(db.MEDIA, str(media_rel))
    if not os.path.isfile(src):
        return None
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "frame.jpg")
        try:
            _run(["-i", src, "-frames:v", "1", "-q:v", "4", "-y", out])
        except HTTPException:
            return None
        try:
            with open(out, "rb") as f:
                return f.read()
        except OSError:
            return None


def burn_overlay(media_rel: str, png: bytes) -> str:
    """Накладывает рисунок (PNG с прозрачностью) поверх видео, как нарисовали карандашом.

    Возвращает новый путь относительно MEDIA (videos/...). Если наложить не вышло —
    возвращает исходный файл, чтобы публикация всё равно прошла.
    """
    if not png or not str(media_rel).startswith("videos/"):
        return media_rel
    src = os.path.join(db.MEDIA, media_rel)
    if not os.path.isfile(src):
        return media_rel
    with tempfile.TemporaryDirectory() as d:
        inp = os.path.join(d, "in.mp4")
        shutil.copyfile(src, inp)
        ov = os.path.join(d, "draw.png")
        with open(ov, "wb") as f:
            f.write(png)
        out = os.path.join(d, "out.mp4")
        try:
            _run(["-i", inp, "-i", ov,
                  "-filter_complex",
                  "[1:v]format=rgba[ov];[0:v][ov]overlay=0:0:format=auto,"
                  "scale=trunc(iw/2)*2:trunc(ih/2)*2[v]",
                  "-map", "[v]", "-map", "0:a?"]
                 + VIDEO_ARGS + AUDIO_ARGS + ["-movflags", "+faststart", out])
        except HTTPException:
            print("burn_overlay: не удалось наложить рисунок, публикуем оригинал")
            return media_rel
        new_rel = "videos/" + secrets.token_hex(12) + ".mp4"
        shutil.move(out, os.path.join(db.MEDIA, new_rel))
    try:
        os.remove(src)
    except OSError:
        pass
    return new_rel


@router.post("/edit/trim")
async def trim(file: UploadFile = File(...),
               start: float = Form(0), end: float = Form(0),
               user=Depends(auth.current_user)):
    """Обрезка видео по времени: start — начало, end — конец (секунды)."""
    with tempfile.TemporaryDirectory() as d:
        src = await _to_tmp(file, d)
        dur, _ = _probe(src)
        if dur <= 0:
            raise HTTPException(400, "Не удалось прочитать это видео")
        start = max(0.0, float(start or 0))
        end = float(end or 0)
        if end <= 0 or end > dur:
            end = dur
        if end - start < MIN_CLIP:
            raise HTTPException(400, "Кусок слишком короткий — выберите хотя бы 0.2 секунды")
        out = os.path.join(d, "out.mp4")
        _run(["-i", src, "-ss", f"{start:.3f}", "-to", f"{end:.3f}"]
             + VIDEO_ARGS + AUDIO_ARGS + ["-movflags", "+faststart", out])
        path = _store(out)
    return {"media": path, "kind": "video", "seconds": round(end - start, 2)}


@router.post("/edit/concat")
async def concat(files: list[UploadFile] = File(...),
                 user=Depends(auth.current_user)):
    """Склейка нескольких видео в одно (одинаковый размер и частота кадров)."""
    if len(files) < 2:
        raise HTTPException(400, "Выберите минимум два видео")
    if len(files) > 8:
        raise HTTPException(400, "За раз можно склеить до 8 видео")
    scale = "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,fps=30"
    with tempfile.TemporaryDirectory() as d:
        norm = []
        for i, f in enumerate(files):
            src = await _to_tmp(f, d)
            _, has_audio = _probe(src)
            dst = os.path.join(d, f"part{i}.mp4")
            if has_audio:
                args = ["-i", src, "-vf", scale] + VIDEO_ARGS + AUDIO_ARGS + [dst]
            else:
                args = ["-i", src, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                        "-vf", scale, "-map", "0:v:0", "-map", "1:a:0", "-shortest",
                        "-t", "10000"] + VIDEO_ARGS + AUDIO_ARGS + [dst]
            _run(args)
            norm.append(dst.replace("\\", "/"))

        listing = os.path.join(d, "list.txt")
        with open(listing, "w", encoding="utf-8") as fh:
            for n in norm:
                fh.write("file '" + n.replace("'", "'\\''") + "'\n")
        out = os.path.join(d, "out.mp4")
        _run(["-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", out])
        path = _store(out)
    return {"media": path, "kind": "video", "count": len(files)}
