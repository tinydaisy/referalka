"""
Досинхронизация содержимого блоков уже залитых материалов.

Зачем. Заливка в базу прошла РАНЬШЕ, чем в разборе выгрузки починили
контейнерные блоки GetCourse (onecolumn-common) и заголовки. В итоге у части
уроков текст в базе короче настоящего: терялись куски внутри контейнеров —
в одном месте пропала ссылка на сайт, в другом целый абзац.

⚠️ Скрипт НЕ трогает структуру: продукты, разделы, состав и порядок остаются
как есть. Обновляется только содержимое блоков (body/url) — по совпадению
названия материала и позиции блока.

⚠️ Обновляем ТОЛЬКО когда в выгрузке текст ДЛИННЕЕ, чем в базе. Если человек
уже правил урок в кабинете, его правка не должна затираться выгрузкой.

Запуск:
    export DATABASE_URL=…
    python3 resync_blocks.py --client-id 1 --dry-run
    python3 resync_blocks.py --client-id 1
"""
import argparse
import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT = os.path.join(HERE, "export.json")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--client-id", type=int, required=True)
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL", ""))
    ap.add_argument("--export", default=EXPORT)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(args.export, encoding="utf-8") as f:
        data = json.load(f)

    # (название урока, позиция блока) → содержимое из выгрузки
    want: dict[tuple[str, int], dict] = {}
    for t in data:
        for les in t["lessons"]:
            title = (les["title"] or "Без названия")[:500]
            for i, b in enumerate(les["blocks"]):
                want[(title, i * 10)] = b

    import asyncpg
    conn = await asyncpg.connect(args.dsn)
    try:
        rows = await conn.fetch(
            """SELECT mb.id, m.title, mb.sort_order, mb.kind,
                      coalesce(mb.body, '') AS body, coalesce(mb.url, '') AS url
                 FROM material_blocks mb
                 JOIN materials m ON m.id = mb.material_id
                WHERE m.client_id = $1""",
            args.client_id,
        )

        fixes = []
        for r in rows:
            b = want.get((r["title"], r["sort_order"]))
            if not b or b["kind"] != r["kind"]:
                continue
            new_body = b.get("body") or ""
            new_url = b.get("url") or ""
            # Только если выгрузка ДЛИННЕЕ — чужие правки не затираем.
            if len(new_body) > len(r["body"]) or len(new_url) > len(r["url"]):
                fixes.append((r["id"], r["title"], len(r["body"]),
                              len(new_body), new_body or None, new_url or None))

        print(f"блоков в базе: {len(rows)} | требуют обновления: {len(fixes)}")
        for _id, title, old, new, *_ in fixes[:20]:
            print(f"  #{_id} {title[:44]:<46} {old} → {new}")

        if args.dry_run:
            print("\n(dry-run: в базу ничего не пишется)")
            return

        async with conn.transaction():
            for _id, _t, _o, _n, body, url in fixes:
                await conn.execute(
                    "UPDATE material_blocks SET body=$2, url=$3, updated_at=NOW() "
                    "WHERE id=$1",
                    _id, body, url,
                )
        print(f"\nобновлено блоков: {len(fixes)}")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
