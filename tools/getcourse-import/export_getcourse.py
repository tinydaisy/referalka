"""
Выгрузка тренингов и уроков из GetCourse в JSON под структуру ПЛЮСОНа.

Что получается на выходе (export.json):
    [
      {"gc_id": 934770323, "title": "...", "lessons": [
          {"gc_id": 344244153, "title": "...", "blocks": [
              {"kind": "text",  "body": "<p>…</p>"},
              {"kind": "video", "url": "https://youtube.com/watch?v=…"},
              {"kind": "image", "url": "https://fs.getcourse.ru/…"},
              {"kind": "file",  "url": "…", "title": "Презентация.pdf"}
          ]}
      ]}
    ]

Типы блоков совпадают с `material_blocks.kind` (миграция 294): text, image,
video, file, audio, button — поэтому заливка в базу становится прямым
переносом, без второго преобразования.

⚠️ Видео НЕ скачиваются — в блоке хранится ссылка на YouTube/Rutube/VK, ровно
как и задумано в ПЛЮСОНе («своё видео не храним»).

⚠️ Картинки и файлы выгружаются ССЫЛКАМИ на fs.getcourse.ru. Скачать их
локально — ключ --download; тогда рядом появится папка files/, а в блоках
добавится поле local_path.

Запуск:
    export GC_BASE=https://ваш-аккаунт.getcourse.ru
    export GC_LOGIN=you@example.com
    export GC_PASSWORD='пароль'
    python3 export_getcourse.py                 # всё
    python3 export_getcourse.py --training 934770323   # один тренинг
    python3 export_getcourse.py --download      # + скачать картинки и файлы
"""
import argparse
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from getcourse_client import (
    BASE, get_session, list_trainings, list_lessons, lesson_page,
    json_object_after,
)

HERE = os.path.dirname(os.path.abspath(__file__))
FILES_DIR = os.path.join(HERE, "files")

# Хранилище файлов GetCourse. Картинка блока лежит по хешу.
FS_BASE = "https://fs.getcourse.ru/fileservice/file/download/a"


def _img_url(image: dict) -> str:
    """Ссылка на картинку блока. В params.image лежит {hash, fileName}."""
    h = (image or {}).get("hash") or ""
    return f"{FS_BASE}/{h}" if h else ""


# Текст-рыба, которой GetCourse заполняет только что созданный блок. Клиент её
# не писал, переносить в ПЛЮСОН нечего — узнаём по характерному началу.
_PLACEHOLDER_MARKERS = (
    "Сущность и концепция маркетинговой программы",
    "Стратегическое планирование уравновешивает культурный имидж",
    "Рекламное сообщество, не меняя концепции",
    "Lorem ipsum",
)


def _clean_html(html: str) -> str:
    """
    Убираем инлайновые стили GetCourse: они тянут за собой их шрифты, отступы
    и цвета, и в нашем редакторе выглядят чужеродно. Разметку (абзацы, списки,
    жирный, ссылки) оставляем как есть.

    ⚠️ Заодно вырезаем <script> и <style>: в старом формате разметка блока
    идёт вперемешку с JS живого обновления (websocket-подписки), и без этого
    он попадает прямо в текст урока.
    """
    if not html:
        return ""
    html = re.sub(r"<script\b.*?</script>", "", html, flags=re.S | re.I)
    html = re.sub(r"<style\b.*?</style>", "", html, flags=re.S | re.I)
    html = re.sub(r'\s*style="[^"]*"', "", html)
    html = re.sub(r'\s*class="[^"]*"', "", html)
    html = re.sub(r"<div>\s*</div>", "", html)
    return html.strip()


def _is_placeholder(html: str) -> bool:
    """Блок-рыба, оставшийся от шаблона GetCourse."""
    plain = re.sub(r"<[^>]+>", " ", html or "")
    return any(m in plain for m in _PLACEHOLDER_MARKERS)


def _walk_parts(parts: dict, out: list) -> None:
    """
    Разбор контейнерных блоков (onecolumn-common и подобных): внутри лежит
    items.parts со вложенными кусочками — текстом, картинками, кнопками.
    """
    for part in (parts or {}).values():
        if not isinstance(part, dict):
            continue
        ptype = part.get("partType")
        inner = part.get("inner") or {}

        if ptype == "text":
            body = _clean_html(inner.get("text", ""))
            if body and not _is_placeholder(body):
                out.append({"kind": "text", "body": body})

        elif ptype == "image":
            url = _img_url(inner.get("image") or {})
            if url:
                out.append({"kind": "image", "url": url})

        elif ptype == "button":
            out.append({
                "kind": "button",
                "title": inner.get("text") or "Открыть",
                "url": inner.get("url") or inner.get("link") or "",
            })

        elif ptype == "video":
            link = ((inner.get("source") or {}).get("src_video_link")) or ""
            if link:
                out.append({"kind": "video", "url": link})

        # Вложенные контейнеры внутри контейнера.
        nested = (part.get("items") or {}).get("parts")
        if nested:
            _walk_parts(nested, out)


def parse_blocks(raw: dict) -> list:
    """Блоки урока GetCourse → список блоков в формате material_blocks."""
    out = []
    # Ключи словаря — строковые номера ("1", "2", …), важен порядок.
    for key in sorted(raw.keys(), key=lambda k: int(k) if str(k).isdigit() else 0):
        block = raw[key]
        if not isinstance(block, dict):
            continue
        btype = block.get("type") or ""
        params = block.get("params") or {}

        if btype == "lesson-text" or btype.endswith("-text"):
            body = _clean_html(params.get("text", ""))
            if body and not _is_placeholder(body):
                out.append({"kind": "text", "body": body})

        elif btype == "lesson-image" or btype.endswith("-image"):
            url = _img_url(params.get("image") or {})
            if url:
                out.append({"kind": "image", "url": url})

        elif "video" in btype:
            link = ((params.get("source") or {}).get("src_video_link")) or ""
            if link:
                out.append({"kind": "video", "url": link})

        elif "file" in btype or "attach" in btype:
            f = params.get("file") or {}
            h = f.get("hash") or ""
            if h:
                out.append({
                    "kind": "file",
                    "url": f"{FS_BASE}/{h}",
                    "title": f.get("fileName") or "Файл",
                })

        elif "audio" in btype:
            a = params.get("audio") or params.get("file") or {}
            h = a.get("hash") or ""
            if h:
                out.append({"kind": "audio", "url": f"{FS_BASE}/{h}"})

        # Контейнеры: содержимое лежит в items.parts.
        parts = (params.get("items") or block.get("items") or {}).get("parts")
        if parts:
            _walk_parts(parts, out)

    return out


def parse_blocks_html(html: str) -> list:
    """
    Разбор урока СТАРОГО формата.

    ⚠️ В аккаунте уживаются два движка уроков. Новый отдаёт содержимое одним
    JSON в HTML (ключ "blocks") — его читает parse_blocks(). Старый отдаёт
    готовую разметку, и никакого JSON на странице нет вовсе: там блоки — это
    <div class="… lt-lesson-text | lt-lesson-video | lt-lesson-image …">.
    Без этой ветки такие уроки выгружаются пустыми (в аккаунте их было 7 из 47).
    """
    out = []
    # Каждый блок начинается с div, у которого есть data-block-id.
    parts = re.split(r'<div id="ltBlock\d+"[^>]*class="([^"]*)"', html)
    # parts: [до первого, class1, тело1, class2, тело2, …]
    for i in range(1, len(parts) - 1, 2):
        classes, body = parts[i], parts[i + 1]

        if "lt-lesson-text" in classes:
            m = re.search(r'<div[^>]*data-editable="true"[^>]*>(.*?)</div>\s*</div>',
                          body, re.S)
            chunk = m.group(1) if m else body
            cleaned = _clean_html(chunk)
            # Отсекаем куски, где текста нет — только вложенная вёрстка, — и
            # шаблонную рыбу GetCourse.
            if (cleaned and re.sub(r"<[^>]+>", "", cleaned).strip()
                    and not _is_placeholder(cleaned)):
                out.append({"kind": "text", "body": cleaned})

        elif "lt-lesson-video" in classes:
            m = re.search(r'<iframe[^>]+src="([^"]+)"', body)
            if m:
                out.append({"kind": "video", "url": _embed_to_watch(m.group(1))})

        elif "lt-lesson-image" in classes:
            m = re.search(r'<img[^>]+src="([^"]+)"', body)
            if m:
                out.append({"kind": "image", "url": _full_image(m.group(1))})

    return out


def _full_image(url: str) -> str:
    """
    Превью → оригинал.

    ⚠️ В старом формате <img src> ведёт на уменьшенную копию:
        //fs-thb01.getcourse.ru/fileservice/file/thumbnail/h/<хеш>.png/s/f1200x/…
    Перенести такую — значит навсегда потерять качество исходника.

    ⚠️ Собрать прямую ссылку на оригинал (/file/download/a/<хеш>) НЕЛЬЗЯ — она
    отвечает 500: у файлового сервиса свои параметры аккаунта, и в адресе
    превью они уже есть. Поэтому не ломаем ссылку, а лишь поднимаем ширину:
    сервис отдаёт оригинал, если запрошенный размер больше исходного
    (проверено: f1200x → 223 КБ, f9999x → 472 КБ, дальше не растёт).
    """
    if url.startswith("//"):
        url = "https:" + url
    return re.sub(r"/s/f\d+x/", "/s/f9999x/", url)


def _embed_to_watch(url: str) -> str:
    """youtube.com/embed/XXX → youtube.com/watch?v=XXX (наш плеер ждёт обычную)."""
    if url.startswith("//"):
        url = "https:" + url
    m = re.search(r"youtube\.com/embed/([A-Za-z0-9_-]{6,})", url)
    if m:
        return f"https://www.youtube.com/watch?v={m.group(1)}"
    return url


def download_file(session, url: str, name_hint: str = "") -> str:
    """Скачивает файл в files/ и возвращает относительный путь."""
    os.makedirs(FILES_DIR, exist_ok=True)
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", name_hint or url.rsplit("/", 1)[-1])[:80]
    path = os.path.join(FILES_DIR, safe)
    if os.path.exists(path):
        return os.path.relpath(path, HERE)
    try:
        r = session.get(url, timeout=120, stream=True)
        if r.status_code != 200:
            return ""
        with open(path, "wb") as f:
            for chunk in r.iter_content(65536):
                f.write(chunk)
        return os.path.relpath(path, HERE)
    except Exception as e:  # сеть, таймаут — файл пропускаем, выгрузку не роняем
        print(f"    не скачался {url}: {e}", file=sys.stderr)
        return ""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--training", type=int, help="выгрузить только этот тренинг")
    ap.add_argument("--download", action="store_true",
                    help="скачать картинки и файлы в files/")
    ap.add_argument("--keep-header-image", action="store_true",
                    help="оставить картинку-шапку первым блоком урока "
                         "(по умолчанию выбрасывается)")
    ap.add_argument("--out", default=os.path.join(HERE, "export.json"))
    args = ap.parse_args()

    s = get_session()
    trainings = list_trainings(s)
    if args.training:
        trainings = [t for t in trainings if t["id"] == args.training]
        if not trainings:
            print(f"тренинг {args.training} не найден", file=sys.stderr)
            sys.exit(1)

    result = []
    total_lessons = 0
    total_blocks = 0

    for t in trainings:
        lessons_raw = list_lessons(s, t["id"])
        print(f"\n{t['title'][:60]}  (уроков: {len(lessons_raw)})")

        lessons = []
        for les in lessons_raw:
            html = lesson_page(s, les["id"])
            # Новый движок: содержимое одним JSON в HTML. Старый: готовая
            # разметка без JSON — тогда идём во вторую ветку.
            raw = json_object_after(html, "blocks") or {}
            blocks = parse_blocks(raw) if raw else parse_blocks_html(html)

            # ⚠️ Картинка первым блоком — это баннер-шапка тренинга, а не
            # содержимое урока: в выгружаемом аккаунте на 44 картинки пришлось
            # 5 уникальных файлов, и ВСЕ стояли позицией 0 (одна шапка на
            # тренинг, повторяется в каждом его уроке). Тащить её в ПЛЮСОН
            # незачем — оформление там своё. Ссылка не теряется: она уходит в
            # header_image урока, откуда её можно взять обложкой продукта.
            header_image = None
            if not args.keep_header_image and blocks and blocks[0]["kind"] == "image":
                header_image = blocks[0]["url"]
                blocks = blocks[1:]

            if args.download:
                for b in blocks:
                    if b["kind"] in ("image", "file", "audio") and b.get("url"):
                        local = download_file(s, b["url"], b.get("title", ""))
                        if local:
                            b["local_path"] = local

            kinds = {}
            for b in blocks:
                kinds[b["kind"]] = kinds.get(b["kind"], 0) + 1
            summary = ", ".join(f"{k}×{v}" for k, v in sorted(kinds.items())) or "пусто"
            print(f"   • {les['title'][:52]:<54} {summary}")

            lessons.append({
                "gc_id": les["id"],
                "title": (les.get("title") or "").strip(),
                "description": les.get("description") or "",
                "header_image": header_image,
                "blocks": blocks,
            })
            total_lessons += 1
            total_blocks += len(blocks)
            time.sleep(0.3)  # не долбим их сервер

        result.append({
            "gc_id": t["id"],
            "title": t["title"],
            "description": t.get("description") or "",
            "lessons": lessons,
        })

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"\nТренингов: {len(result)} | уроков: {total_lessons} | "
          f"блоков: {total_blocks}")
    print(f"Сохранено: {args.out}")


if __name__ == "__main__":
    main()
