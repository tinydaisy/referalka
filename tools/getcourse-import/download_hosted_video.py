"""
Скачивание видео, залитого ФАЙЛОМ в сам GetCourse (тип блока video-hosting).

⚠️ Прямой ссылки на .mp4 у такого видео НЕТ. GetCourse отдаёт его через
защищённый плеер: страница урока → подписанный iframe (vh-api-*.gceuproxy.com)
→ мастер-плейлист HLS (api3.gcvh.ru) → медиа-плейлист с сегментами .ts.
Подпись привязана к пользователю и уроку, поэтому забирать нужно именно этой
цепочкой, под своей сессией.

Сегменты склеиваются простой конкатенацией — MPEG-TS это допускает, и итоговый
файл играется где угодно. ffmpeg не требуется (на машине его может не быть),
но если он есть, файл можно потом перепаковать в mp4 без перекодирования:
    ffmpeg -i out.ts -c copy out.mp4

Запуск:
    export GC_BASE=… GC_LOGIN=… GC_PASSWORD=…
    python3 download_hosted_video.py --lesson 344613177 --out ../../other_tasks/getcourse
"""
import argparse
import os
import re
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import requests

from getcourse_client import get_session, lesson_page

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"


def player_url(html: str) -> str:
    """Подписанный адрес плеера из разметки урока."""
    i = html.find("data-iframe-src")
    if i < 0:
        raise SystemExit("в уроке нет плеера video-hosting")
    # Фрагмент лежит внутри JSON-строки: слэши и кавычки экранированы.
    raw = html[i:i + 900].replace("\\/", "/").replace('\\"', '"')
    m = re.search(r'data-iframe-src="([^"]+)"', raw)
    if not m:
        raise SystemExit("не разобрал адрес плеера")
    return m.group(1)


def master_url(player_html: str) -> str:
    t = player_html.replace("\\/", "/")
    m = re.search(r"https://api\d*\.gcvh\.ru/api/playlist/master/[^\"'\\ ]+", t)
    if not m:
        raise SystemExit("в плеере нет мастер-плейлиста")
    return m.group(0)


def best_variant(master: str) -> str:
    """Ссылка на поток максимального разрешения."""
    best, best_h = None, -1
    lines = master.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF"):
            m = re.search(r"RESOLUTION=(\d+)x(\d+)", line)
            h = int(m.group(2)) if m else 0
            url = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if url.startswith("http") and h > best_h:
                best, best_h = url, h
    if not best:
        raise SystemExit("не нашёл вариантов потока")
    print(f"качество: {best_h}p")
    return best


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lesson", type=int, required=True, help="id урока в GetCourse")
    ap.add_argument("--out", required=True, help="папка для файла")
    ap.add_argument("--name", default=None, help="имя файла без расширения")
    args = ap.parse_args()

    s = get_session()
    html = lesson_page(s, args.lesson)

    pu = player_url(html)
    print("плеер:", pu[:90], "…")
    ph = s.get(pu, timeout=60,
               headers={"Referer": "https://ivision-medialift.getcourse.ru/"}).text

    mu = master_url(ph)
    hdr = {"Referer": "https://vh-api-1-de.gceuproxy.com/", "User-Agent": UA}
    master = requests.get(mu, timeout=60, headers=hdr).text

    media_url = best_variant(master)
    media = requests.get(media_url, timeout=60, headers=hdr).text

    base = media_url.rsplit("/", 1)[0]
    segs = []
    for line in media.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        segs.append(line if line.startswith("http") else f"{base}/{line}")
    if not segs:
        raise SystemExit("в плейлисте нет сегментов")

    os.makedirs(args.out, exist_ok=True)
    name = args.name or f"lesson_{args.lesson}"
    path = os.path.join(args.out, f"{name}.ts")

    total = 0
    with open(path, "wb") as f:
        for i, u in enumerate(segs, 1):
            r = requests.get(u, timeout=120, headers=hdr)
            if r.status_code != 200:
                print(f"  сегмент {i}/{len(segs)}: {r.status_code}", file=sys.stderr)
                continue
            f.write(r.content)
            total += len(r.content)
            if i % 20 == 0 or i == len(segs):
                print(f"  {i}/{len(segs)} — {total/1024/1024:.1f} МБ")

    print(f"\nготово: {path}  ({total/1024/1024:.1f} МБ)")


if __name__ == "__main__":
    main()
