"""Готовит видеоматериал прототипа из источников, описанных в data/content.json.

Каждый фрагмент качается отдельным коротким отрезком и пережимается под 720x1280.
Отдельно — потому что соединение рвётся на длинных отрезках, и обрыв не должен
уносить с собой весь сериал.

Повторный запуск пропускает готовые файлы — можно прерывать и продолжать.

    python scripts/fetch_media.py          # всё, чего не хватает
    python scripts/fetch_media.py s3 s4    # только указанные сериалы
"""
import json, subprocess, sys, shutil
from pathlib import Path

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parent.parent
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
TMP = ROOT / "media" / "_src"

W, H = 720, 1280
SCALE = (f"scale={W}:{H}:force_original_aspect_ratio=decrease,"
         f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1")
TRIES = 3
MIN_RAW = 250_000      # меньше — считаем обрывом
MIN_OUT = 100_000


def run(cmd):
    return subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")


def grab(vid: str, start: int, length: int, dest: Path) -> bool:
    """Качает один отрезок. Возвращает False, если после всех попыток пусто."""
    for attempt in range(1, TRIES + 1):
        dest.unlink(missing_ok=True)
        run([
            sys.executable, "-m", "yt_dlp", "--no-warnings", "--quiet",
            "--no-part", "--retries", "5", "--socket-timeout", "20",
            "-f", f"bestvideo[height<={H}]+bestaudio/best[height<={H}]/best",
            "--download-sections", f"*{start}-{start + length}",
            "--ffmpeg-location", FFMPEG,
            "--merge-output-format", "mp4",
            "-o", str(dest),
            vid,
        ])
        if dest.exists() and dest.stat().st_size >= MIN_RAW:
            return True
        if attempt < TRIES:
            print(f"      обрыв, попытка {attempt + 1}/{TRIES}")
    return False


def encode(src: Path, dest: Path) -> bool:
    """Пережимает фрагмент под вертикаль 720x1280."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    run([
        FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(src),
        "-vf", SCALE,
        "-c:v", "libx264", "-crf", "28", "-preset", "veryfast",
        "-profile:v", "main", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k", "-ac", "2",
        "-movflags", "+faststart", "-y", str(dest),
    ])
    if dest.exists() and dest.stat().st_size >= MIN_OUT:
        return True
    dest.unlink(missing_ok=True)
    return False


SUB_TOP, SUB_BOTTOM = 0.58, 0.93   # полоса, где у исходников сидят субтитры
POSTER_TRIM = 0.92                 # сколько высоты оставляем на обложке
CLEAN_ENOUGH = 0.0015              # доля почти-белых пикселей, считаемая «чисто»

# Нижние 8% отрезаются, а в замер не входят: у части исходников там намертво
# вшит дисклеймер платформы. Подбором кадра его не убрать — он в каждом кадре,
# — зато он мешал бы выбирать по-настоящему чистые кадры.


def subtitle_load(src: Path, at: float) -> float:
    """Доля почти-белых пикселей в полосе субтитров — прокси наличия текста.

    Субтитры вшиты в картинку: белые буквы с тёмной обводкой. Если в полосе
    почти нет ярких пикселей, значит в этот момент реплики на экране нет."""
    y0 = int(H * SUB_TOP)
    height = int(H * SUB_BOTTOM) - y0
    # Полосу нельзя сильно ужимать: субтитры — тонкие белые штрихи, при
    # уменьшении до пары сотен пикселей они усредняются с тёмным фоном в серый
    # и перестают отличаться от чистого кадра. Меряем близко к оригиналу.
    r = subprocess.run([
        FFMPEG, "-v", "error", "-ss", f"{at:.2f}", "-i", str(src), "-frames:v", "1",
        "-vf", f"{SCALE},crop={W}:{height}:0:{y0},format=gray",
        "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ], capture_output=True)
    data = r.stdout
    if not data:
        return 1.0
    return sum(1 for b in data if b > 215) / len(data)


def poster(episodes: list, dest: Path):
    """Подбирает для обложки кадр без субтитров.

    Брать первый попавшийся кадр нельзя: на обложке оказывается чужая реплика,
    местами иероглифами, и это первое, что видно на витрине. Поэтому
    просматриваем моменты по нескольким сериям и берём тот, где полоса
    субтитров пустая."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    best = None                                    # (загрязнённость, файл, момент)

    for ep in episodes:
        src = ROOT / ep["src"]
        if not src.exists():
            continue
        for at in [2 + 2.4 * i for i in range(11)]:
            load = subtitle_load(src, at)
            if best is None or load < best[0]:
                best = (load, src, at)
            if load < CLEAN_ENOUGH:
                break
        if best and best[0] < CLEAN_ENOUGH:
            break

    if not best:
        return
    load, src, at = best
    run([FFMPEG, "-hide_banner", "-loglevel", "error",
         "-ss", f"{at:.2f}", "-i", str(src), "-frames:v", "1",
         "-vf", f"{SCALE},crop={W}:{int(H * POSTER_TRIM)}:0:0",
         "-q:v", "4", "-y", str(dest)])
    print(f"    обложка: {src.name} @ {at:.1f}с, субтитров {load * 100:.2f}%")


def main():
    only = set(sys.argv[1:])
    content = json.loads((ROOT / "data" / "content.json").read_text(encoding="utf-8"))
    TMP.mkdir(parents=True, exist_ok=True)
    total_ok = total_all = 0

    for s in content["series"]:
        if only and s["id"] not in only:
            continue
        cfg = s.get("source")
        if not cfg:
            print(f"[{s['id']}] нет источника — пропуск", flush=True)
            continue

        eps = s["episodes"]
        print(f"\n[{s['id']}] {s['title']}  ←  {cfg['id']}", flush=True)
        ok = 0
        for i, ep in enumerate(eps):
            total_all += 1
            dest = ROOT / ep["src"]
            if dest.exists() and dest.stat().st_size >= MIN_OUT:
                ok += 1
                total_ok += 1
                continue

            raw = TMP / f"{s['id']}_{ep['n']:02d}.mp4"
            at = cfg["start"] + cfg["step"] * i
            if not grab(cfg["id"], at, cfg["len"], raw):
                print(f"    серия {ep['n']:>2}: не скачалась", flush=True)
                continue
            if encode(raw, dest):
                ok += 1
                total_ok += 1
                print(f"    серия {ep['n']:>2} → {dest.stat().st_size / 1e6:.1f} МБ",
                      flush=True)
            else:
                print(f"    серия {ep['n']:>2}: не пережалась", flush=True)
            raw.unlink(missing_ok=True)

        p = ROOT / s["poster"]
        if not p.exists():
            poster(eps, p)
        print(f"    итог: {ok}/{len(eps)}", flush=True)

    shutil.rmtree(TMP, ignore_errors=True)
    print(f"\nВсего готово {total_ok}/{total_all} фрагментов", flush=True)


if __name__ == "__main__":
    main()
