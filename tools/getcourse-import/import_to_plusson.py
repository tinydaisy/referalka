"""
Заливка выгрузки GetCourse (export.json) в модуль «Продукты» ПЛЮСОНа.

Раскладка (дерево тренингов GetCourse → сущности ПЛЮСОНа):
    узел level 0        → products              (продукт со своим лендингом)
    узел level 1+       → product_sections      (раздел, вложенность любая)
    урок                → materials + material_blocks (содержимое)
    урок ↔ продукт      → product_materials     (место урока в составе)

⚠️ Продукты создаются ЧЕРНОВИКАМИ (status='draft'). Публиковать — решение
владельца: у продукта ещё нет ни цены, ни оферты, а опубликованный лендинг
сразу доступен по ссылке.

⚠️ Материал НЕ принадлежит продукту (он в общей библиотеке кабинета), поэтому
название и порядок урока пишутся в СВЯЗКУ product_materials.title_override —
так задумано в миграции 290.

⚠️ Всё в ОДНОЙ транзакции: наполовину залитый курс хуже незалитого — руками
такое разбирать невозможно, а повторный запуск наплодит дублей.

⚠️ Идемпотентности НЕТ намеренно: повторный запуск создаст вторые копии.
Проверка на существующие продукты — только предупреждением (--force, чтобы
осознанно залить второй раз).

Запуск:
    export DATABASE_URL=postgres://…            # или --dsn
    python3 import_to_plusson.py --client-id 1 --dry-run
    python3 import_to_plusson.py --client-id 1
"""
import argparse
import asyncio
import json
import os
import re
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT = os.path.join(HERE, "export.json")

# Алфавит без визуально похожих символов — как у slug событий и продуктов.
_SLUG_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"


def make_slug() -> str:
    return "".join(secrets.choice(_SLUG_ALPHABET) for _ in range(5))


def plain(html: str, limit: int = 300) -> str:
    """Текст без разметки — для описания продукта."""
    t = re.sub(r"<[^>]+>", " ", html or "").replace("&nbsp;", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t[:limit]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--client-id", type=int, required=True)
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL", ""))
    ap.add_argument("--export", default=EXPORT)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="лить, даже если у клиента уже есть продукты")
    args = ap.parse_args()

    if not args.dsn:
        print("нужен DATABASE_URL или --dsn", file=sys.stderr)
        sys.exit(1)

    with open(args.export, encoding="utf-8") as f:
        data = json.load(f)

    roots = [t for t in data if t["level"] == 0]
    subs = [t for t in data if t["level"] > 0]
    lessons_n = sum(len(t["lessons"]) for t in data)
    blocks_n = sum(len(l["blocks"]) for t in data for l in t["lessons"])
    print(f"к заливке: продуктов {len(roots)}, разделов {len(subs)}, "
          f"уроков {lessons_n}, блоков {blocks_n}")

    if args.dry_run:
        print("\n(dry-run: в базу ничего не пишется)\n")
        for t in data:
            print("  " * t["level"] + f"{t['title'][:60]}  ({len(t['lessons'])} ур.)")
        return

    import asyncpg
    conn = await asyncpg.connect(args.dsn)
    try:
        have = await conn.fetchval(
            "SELECT count(*) FROM products WHERE client_id = $1", args.client_id)
        if have and not args.force:
            print(f"у клиента уже есть {have} продукт(ов). "
                  f"Повторный запуск создаст дубли — если так и надо, "
                  f"добавьте --force", file=sys.stderr)
            sys.exit(1)

        async with conn.transaction():
            # gc_id узла → (product_id, section_id|None)
            placed: dict[int, tuple[int, int | None]] = {}
            n_prod = n_sec = n_mat = n_blk = 0

            for node in data:                       # порядок — сверху вниз
                gc_id, level = node["gc_id"], node["level"]
                parent = node.get("parent_gc_id")

                if level == 0:
                    pid = await conn.fetchval(
                        """INSERT INTO products (client_id, slug, title, description,
                                                 status, sort_order)
                           VALUES ($1, $2, $3, $4, 'draft', $5) RETURNING id""",
                        args.client_id, make_slug(), node["title"][:500],
                        plain(node.get("description") or ""), n_prod * 10)
                    placed[gc_id] = (pid, None)
                    n_prod += 1
                else:
                    # Раздел живёт внутри продукта-корня; родителем может быть
                    # как сам продукт, так и другой раздел (вложенность любая).
                    pp = placed.get(parent)
                    if not pp:
                        print(f"  пропуск «{node['title'][:40]}»: нет родителя",
                              file=sys.stderr)
                        continue
                    prod_id, parent_section = pp
                    sec_id = await conn.fetchval(
                        """INSERT INTO product_sections
                               (product_id, parent_id, title, sort_order)
                           VALUES ($1, $2, $3, $4) RETURNING id""",
                        prod_id, parent_section, node["title"][:500], n_sec * 10)
                    placed[gc_id] = (prod_id, sec_id)
                    n_sec += 1

                prod_id, sec_id = placed[gc_id]

                for i, les in enumerate(node["lessons"]):
                    mat_id = await conn.fetchval(
                        "INSERT INTO materials (client_id, title) VALUES ($1, $2) "
                        "RETURNING id",
                        args.client_id, (les["title"] or "Без названия")[:500])
                    n_mat += 1

                    for j, b in enumerate(les["blocks"]):
                        await conn.execute(
                            """INSERT INTO material_blocks
                                   (material_id, kind, title, body, url, sort_order)
                               VALUES ($1, $2, $3, $4, $5, $6)""",
                            mat_id, b["kind"], b.get("title"),
                            b.get("body"), b.get("url"), j * 10)
                        n_blk += 1

                    await conn.execute(
                        """INSERT INTO product_materials
                               (product_id, material_id, section_id,
                                title_override, sort_order)
                           VALUES ($1, $2, $3, $4, $5)""",
                        prod_id, mat_id, sec_id,
                        (les["title"] or "")[:500], i * 10)

            print(f"\nсоздано: продуктов {n_prod}, разделов {n_sec}, "
                  f"материалов {n_mat}, блоков {n_blk}")
    finally:
        await conn.close()

    print("готово. Продукты созданы ЧЕРНОВИКАМИ — публикуйте из кабинета.")


if __name__ == "__main__":
    asyncio.run(main())
