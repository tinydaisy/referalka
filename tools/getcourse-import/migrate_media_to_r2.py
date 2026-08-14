"""
Перезаливка картинок и файлов из GetCourse в наш R2.

Зачем. Аккаунт GetCourse закрывается — ссылки на fs.getcourse.ru однажды
перестанут работать, и уроки останутся без картинок. Поэтому всё, на что
ссылается выгрузка, переносим к себе и подменяем ссылки в export.json.

⚠️ ДЕДУП ПО СОДЕРЖИМОМУ, а не по ссылке. Один и тот же баннер лежит в каждом
уроке тренинга: в выгружаемом аккаунте на 44 ссылки пришлось 5 файлов.
Заливать «как есть» — значит положить в R2 сорок четыре копии пяти картинок и
платить за них. Считаем SHA-256 скачанных байтов; повторы получают ссылку на
уже залитый объект.

⚠️ Дедуп идёт именно по БАЙТАМ, а не по адресу: у GetCourse один файл
раздаётся по разным URL (разные параметры превью), и сверка по строке адреса
дубли бы пропустила.

⚠️ Видео НЕ трогаем — они ссылками на YouTube/Rutube, к GetCourse отношения не
имеют и после закрытия аккаунта продолжат работать.

Что переносится: header_image уроков + блоки image/file/audio.

Запуск (из корня проекта, чтобы импортировался backend):
    export GC_BASE=… GC_LOGIN=… GC_PASSWORD=…
    export CF_ACCOUNT_ID=… CF_R2_ACCESS_KEY_ID=… CF_R2_SECRET_ACCESS_KEY=…
    export CF_R2_BUCKET_NAME=referalka CF_R2_PUBLIC_URL=…
    python3 tools/getcourse-import/migrate_media_to_r2.py --client-id 1

    --dry-run  — только посчитать, что и сколько зальётся, без записи
"""
import argparse
import asyncio
import hashlib
import json
import mimetypes
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "backend"))

from getcourse_client import get_session  # noqa: E402

EXPORT = os.path.join(HERE, "export.json")

# Расширение по типу содержимого: имя файла в ссылке GetCourse не всегда
# соответствует реальному формату.
_EXT_BY_TYPE = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
    "image/webp": "webp", "application/pdf": "pdf",
    "audio/mpeg": "mp3", "audio/mp4": "m4a",
}


def _r2_client():
    """
    Клиент R2 напрямую через boto3.

    ⚠️ Намеренно НЕ импортируем app.services.r2_storage: он тянет app.config, а
    тот — pydantic_settings и остальной стек бэкенда, которого на машине
    разработчика может не быть. Инструмент разовый, ключ строим тем же
    правилом, что build_key(kind='material_media').
    """
    import boto3
    from botocore.client import Config as BotoConfig

    acc = os.environ["CF_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{acc}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["CF_R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["CF_R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=BotoConfig(signature_version="s3v4"),
    )


def _put(r2, client_id: int, data: bytes, ext: str, ctype: str) -> str:
    """Кладёт файл в R2 по тому же пути, что kind='material_media'."""
    import uuid

    key = f"clients/{client_id}/materials/media/{uuid.uuid4().hex}.{ext}"
    r2.put_object(
        Bucket=os.environ["CF_R2_BUCKET_NAME"],
        Key=key,
        Body=data,
        ContentType=ctype or "application/octet-stream",
    )
    return f"{os.environ['CF_R2_PUBLIC_URL'].rstrip('/')}/{key}"


def collect_urls(data: list) -> list:
    """Все ссылки на файлы GetCourse в выгрузке (с местом, где они лежат)."""
    out = []
    for t in data:
        for les in t["lessons"]:
            if les.get("header_image"):
                out.append(("header", les, None, les["header_image"]))
            for b in les["blocks"]:
                if b["kind"] in ("image", "file", "audio") and b.get("url"):
                    out.append(("block", les, b, b["url"]))
    return out


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--client-id", type=int, required=True,
                    help="кабинет ПЛЮСОНа, в чьё хранилище кладём")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--export", default=EXPORT)
    args = ap.parse_args()

    with open(args.export, encoding="utf-8") as f:
        data = json.load(f)

    refs = collect_urls(data)
    print(f"ссылок на файлы в выгрузке: {len(refs)}")
    if not refs:
        return

    session = get_session()

    # хеш содержимого → готовый публичный URL в R2
    by_hash: dict = {}
    # адрес GetCourse → его содержимое (чтобы не качать одно и то же дважды)
    seen_url: dict = {}
    replaced = 0
    failed = 0
    total_bytes = 0

    if not args.dry_run:
        r2 = _r2_client()

    for i, (where, lesson, block, url) in enumerate(refs, 1):
        if url in seen_url:
            digest = seen_url[url]
        else:
            try:
                r = session.get(url, timeout=120)
                if r.status_code != 200 or not r.content:
                    print(f"  [{i}/{len(refs)}] не скачался ({r.status_code}): "
                          f"{url[:70]}")
                    failed += 1
                    continue
                content = r.content
            except Exception as e:
                print(f"  [{i}/{len(refs)}] ошибка {e}: {url[:70]}")
                failed += 1
                continue

            digest = hashlib.sha256(content).hexdigest()
            seen_url[url] = digest

            if digest not in by_hash:
                ctype = (r.headers.get("content-type") or "").split(";")[0].strip()
                ext = (_EXT_BY_TYPE.get(ctype)
                       or (mimetypes.guess_extension(ctype) or ".bin").lstrip("."))
                total_bytes += len(content)

                if args.dry_run:
                    by_hash[digest] = f"<r2>/{digest[:12]}.{ext}"
                else:
                    by_hash[digest] = _put(r2, args.client_id, content,
                                           ext, ctype)
                print(f"  [{i}/{len(refs)}] залито {len(content)//1024} КБ  "
                      f"{by_hash[digest][-40:]}")

        new_url = by_hash.get(digest)
        if not new_url:
            continue
        if where == "header":
            lesson["header_image"] = new_url
        else:
            block["url"] = new_url
        replaced += 1

    if not args.dry_run:
        with open(args.export, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    print()
    print(f"ссылок обновлено:   {replaced}")
    print(f"файлов в R2:        {len(by_hash)}  "
          f"(дедуп сэкономил {len(refs) - len(by_hash)} копий)")
    print(f"объём:              {total_bytes/1024/1024:.1f} МБ")
    if failed:
        print(f"не скачалось:       {failed}")
    if args.dry_run:
        print("\n(dry-run: ничего не залито и export.json не изменён)")


if __name__ == "__main__":
    asyncio.run(main())
