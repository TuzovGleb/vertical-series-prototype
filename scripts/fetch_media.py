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


def poster(src: Path, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    run([FFMPEG, "-hide_banner", "-loglevel", "error",
         "-ss", "3", "-i", str(src), "-frames:v", "1",
         "-vf", SCALE, "-q:v", "4", "-y", str(dest)])


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

        first = ROOT / eps[0]["src"]
        p = ROOT / s["poster"]
        if first.exists() and not p.exists():
            poster(first, p)
        print(f"    итог: {ok}/{len(eps)}", flush=True)

    shutil.rmtree(TMP, ignore_errors=True)
    print(f"\nВсего готово {total_ok}/{total_all} фрагментов", flush=True)


if __name__ == "__main__":
    main()
