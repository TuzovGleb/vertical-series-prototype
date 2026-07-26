"""Проверяет комплектность и целостность материала перед показом.

Сверяет data/content.json с тем, что реально лежит в media/: каждый ли
заявленный фрагмент на месте, открывается ли он и не обрезан ли.

    python scripts/check_media.py
"""
import json, subprocess, sys, re
from pathlib import Path

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parent.parent
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
DUR = re.compile(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)")


def probe(path: Path):
    """Возвращает длительность в секундах или None, если файл не читается."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)],
                       capture_output=True, encoding="utf-8", errors="replace")
    m = DUR.search(r.stderr or "")
    if not m:
        return None
    h, mn, s = m.groups()
    return int(h) * 3600 + int(mn) * 60 + float(s)


def main():
    content = json.loads((ROOT / "data" / "content.json").read_text(encoding="utf-8"))
    missing, broken, short, ok = [], [], [], 0

    for s in content["series"]:
        want = s.get("source", {}).get("len", 28)
        print(f"\n[{s['id']}] {s['title']}")
        for ep in s["episodes"]:
            p = ROOT / ep["src"]
            label = f"серия {ep['n']:>2}"
            if not p.exists():
                missing.append(ep["src"])
                print(f"    {label}: НЕТ ФАЙЛА")
                continue
            d = probe(p)
            if d is None:
                broken.append(ep["src"])
                print(f"    {label}: НЕ ЧИТАЕТСЯ")
            elif d < want * 0.6:
                short.append(ep["src"])
                print(f"    {label}: обрезан — {d:.1f} с вместо {want}")
            else:
                ok += 1

        poster = ROOT / s["poster"]
        if not poster.exists():
            print(f"    постер: НЕТ ФАЙЛА ({s['poster']})")

    total = sum(len(s["episodes"]) for s in content["series"])
    print(f"\n{'─' * 46}")
    print(f"Готово к показу: {ok} из {total}")
    for name, items in (("нет файла", missing), ("не читается", broken), ("обрезаны", short)):
        if items:
            print(f"  {name}: {len(items)} — {', '.join(items)}")
    if ok < total:
        print("\nДотянуть недостающее:  python scripts/fetch_media.py")
    return 0 if ok == total else 1


if __name__ == "__main__":
    sys.exit(main())
