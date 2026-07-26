"""Ищет на YouTube вертикальные сериалы и печатает только те, что реально 9:16.

Запуск:  python scripts/find_vertical.py "запрос 1" "запрос 2" ...
Печатает: id | ШxВ | длительность | название
"""
import sys, json, subprocess

QUERIES = sys.argv[1:] or ["вертикальный сериал все серии"]
PER_QUERY = 8
seen = set()

for q in QUERIES:
    print(f"\n=== {q}", flush=True)
    try:
        out = subprocess.run(
            [sys.executable, "-m", "yt_dlp", "--no-warnings", "--skip-download",
             "--dump-json", f"ytsearch{PER_QUERY}:{q}"],
            capture_output=True, text=True, encoding="utf-8", timeout=300,
        ).stdout
    except subprocess.TimeoutExpired:
        print("  таймаут", flush=True)
        continue

    for line in out.splitlines():
        if not line.startswith("{"):
            continue
        try:
            v = json.loads(line)
        except json.JSONDecodeError:
            continue
        vid = v.get("id")
        if not vid or vid in seen:
            continue
        seen.add(vid)

        # максимальное вертикальное разрешение среди доступных форматов
        best = None
        for f in v.get("formats") or []:
            w, h = f.get("width"), f.get("height")
            if w and h and h > w * 1.5:          # 9:16 и уже
                if best is None or h > best[1]:
                    best = (w, h)
        if not best:
            continue
        dur = v.get("duration") or 0
        print(f"  {vid} | {best[0]}x{best[1]} | {dur//60} мин | {(v.get('title') or '')[:60]}",
              flush=True)
