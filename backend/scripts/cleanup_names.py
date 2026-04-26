"""
Чистит дубли в именах контактов и platform_users.

Кейсы которые лечит:
- contacts.name = 'Сергей Анисимов Анисимов' -> 'Сергей Анисимов'
- platform_users.first_name = 'Сергей Анисимов' + last_name = 'Анисимов'
  -> first_name = 'Сергей Анисимов', last_name = NULL
- 'Усенко Усенко' (дубль внутри одного поля) -> 'Усенко'

Источник: при импорте из Salebot/Event_leads разделение имени на части
сломалось — фамилия частично попала и в first_name, и в last_name.

Запуск (на сервере):
  cd /var/www/plusson/backend
  set -a && . ./.env && set +a
  venv/bin/python scripts/cleanup_names.py
"""
import asyncio
import asyncpg
import os


def dedup_words(s):
    """Схлопывает подряд идущие повторы слов (case-insensitive)."""
    if not s:
        return s
    parts = s.strip().split()
    out = []
    for p in parts:
        if not out or out[-1].lower() != p.lower():
            out.append(p)
    return " ".join(out) if out else None


async def main():
    conn = await asyncpg.connect(dsn=os.environ["DATABASE_URL"])

    # 1) contacts.name
    rows = await conn.fetch(
        "SELECT id, name FROM contacts WHERE name IS NOT NULL AND name <> ''"
    )
    fixed_c = 0
    samples = []
    for r in rows:
        new = dedup_words(r["name"])
        if new != r["name"]:
            await conn.execute(
                "UPDATE contacts SET name = $1 WHERE id = $2", new, r["id"]
            )
            fixed_c += 1
            if len(samples) < 5:
                samples.append((r["id"], r["name"], new))
    print(f"contacts.name updated: {fixed_c}")
    for s in samples:
        print(f"  contact {s[0]}: {s[1]!r} -> {s[2]!r}")

    # 2) platform_users — dedup внутри + удаление last_name если он дублирует хвост first_name
    rows = await conn.fetch(
        "SELECT id, first_name, last_name FROM platform_users "
        "WHERE first_name IS NOT NULL OR last_name IS NOT NULL"
    )
    fixed_p = 0
    samples = []
    for r in rows:
        fn = r["first_name"]
        ln = r["last_name"]
        new_fn = dedup_words(fn) if fn else fn
        new_ln = dedup_words(ln) if ln else ln
        # Если last_name == последнее слово first_name → убираем last_name
        if new_fn and new_ln:
            fn_words = new_fn.split()
            if fn_words and fn_words[-1].lower() == new_ln.lower():
                new_ln = None
        if new_fn != fn or new_ln != ln:
            await conn.execute(
                "UPDATE platform_users SET first_name = $1, last_name = $2 WHERE id = $3",
                new_fn,
                new_ln,
                r["id"],
            )
            fixed_p += 1
            if len(samples) < 5:
                samples.append((r["id"], (fn, ln), (new_fn, new_ln)))
    print(f"platform_users updated: {fixed_p}")
    for s in samples:
        print(f"  pu {s[0]}: {s[1]} -> {s[2]}")

    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
