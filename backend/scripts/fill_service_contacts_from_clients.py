"""Разовый скрипт: дозаполнить контакты сервисного клиента данными их кабинетов.

Зачем. В @pluson_bot пишут в том числе владельцы кабинетов ПЛЮСОНа. Как
подписчики бота они лежат контактами у сервисного клиента (client_id=3) —
и там у них зачастую только Telegram: ни почты, ни телефона, а имя такое,
каким его отдал Telegram («Марго», «m», иногда пусто). При этом всё это уже
известно — в их собственной карточке клиента (`clients`).

Скрипт связывает одного с другим и переносит недостающее.

⚠️ ПО УМОЛЧАНИЮ — РЕЖИМ ПРЕДПРОСМОТРА, в базу ничего не пишется. Запись
включается явным флагом --apply.

Запуск на сервере:
    cd /var/www/plusson/backend
    python3 -m scripts.fill_service_contacts_from_clients            # посмотреть
    python3 -m scripts.fill_service_contacts_from_clients --apply    # записать

Необязательные параметры:
    --client-id N   сервисный клиент (по умолчанию определяется по
                    clients.is_system_service, иначе 3)
    --with-names    переносить ещё и имена (по умолчанию — нет)

Что переносится и по каким правилам
-----------------------------------
| Поле    | Откуда          | Условие                                       |
|---------|-----------------|-----------------------------------------------|
| Почта   | clients.email   | у контакта нет email-идентичности             |
| Телефон | clients.phone   | contacts.phone пуст                           |
| Имя     | clients.name    | ТОЛЬКО с --with-names (см. ниже)              |

⚠️ ИМЕНА ПО УМОЛЧАНИЮ НЕ ТРОГАЕМ. Почта и телефон однозначны: они либо есть,
либо нет. С именем сложнее — в кабинете может стоять «ООО Ромашка» или
рабочее написание, и в карточке человека оно выглядит хуже пришедшего из
Telegram. Имена разбираем отдельным заходом, посмотрев список глазами.

⚠️ ТОЛЬКО ПУСТЫЕ ПОЛЯ. Ничего уже заполненного не перезаписываем: данные в
контакте могли быть введены руками и оказаться точнее, чем в кабинете.

⚠️ Почта пишется как ИДЕНТИЧНОСТЬ (`platform_users` со slug='email'), а не в
`contacts.email` — такой колонки нет, её дропнули миграцией 282. Телефон —
только через `set_contact_phone`, иначе останется пустым `phone_normalized`,
по которому ищутся дубли.
"""
import argparse
import asyncio
import sys

from app.database import get_pool
from app.services.contact_merge import (
    set_contact_phone,
    sync_email_identity_and_subscription,
)

# Запасной номер сервисного клиента, если в базе не нашлось is_system_service.
FALLBACK_SERVICE_CLIENT_ID = 3


def looks_like_person_name(name: str | None) -> bool:
    """Похоже ли на настоящее «Имя Фамилия»?

    Правило намеренно строгое: переносим имя, только если в нём минимум два
    слова из букв длиной от двух символов. Всё остальное — «margo», «test»,
    «Клиент 12», один ник, пустое — не трогаем: лучше оставить как есть, чем
    записать в карточку мусор.
    """
    raw = (name or "").strip()
    if not raw:
        return False
    words = [w for w in raw.split() if len(w) >= 2 and any(ch.isalpha() for ch in w)]
    return len(words) >= 2


def is_weak_name(name: str | None) -> bool:
    """Стоит ли вообще заменять текущее имя контакта.

    Меняем только «слабое» — пустое или однословное («Марго», «m»). Если в
    контакте уже стоит нормальное «Имя Фамилия», не трогаем: оно могло быть
    введено руками и быть точнее, чем в кабинете.
    """
    return not looks_like_person_name(name)


async def resolve_service_client_id(db, forced: int | None) -> int:
    if forced:
        return forced
    found = await db.fetchval(
        "SELECT id FROM clients WHERE is_system_service = TRUE ORDER BY id LIMIT 1"
    )
    return int(found or FALLBACK_SERVICE_CLIENT_ID)


async def fetch_matches(db, service_client_id: int) -> list[dict]:
    """Подписчики сервисного клиента, у которых нашёлся свой кабинет ПЛЮСОНа.

    Сопоставляем по Telegram двумя способами сразу:
      1) по числовому tg_id — он есть у клиента, если тот заходил в свой бот;
      2) по @нику (clients.telegram_username / work_tg_username).

    ⚠️ Ник сверяем в нижнем регистре и без «@»: в базе он лежит по-разному —
    «@nick», «nick», «https://telegram.me/nick».

    ⚠️ Псевдо-записи `platform_users.platform_user_id = '@ник'` (идентичность,
    не доросшая до числового id) в сопоставление по tg_id не попадут — у них
    в этом поле не число. Это правильно: они и так найдутся по нику.
    """
    rows = await db.fetch(
        """
        WITH sub AS (
            -- Подписчики сервисного бота: контакты сервисного клиента с TG
            SELECT c.id            AS contact_id,
                   c.name          AS contact_name,
                   c.phone         AS contact_phone,
                   pu.platform_user_id AS tg_id,
                   lower(pu.username)  AS tg_nick,
                   (SELECT pe.platform_user_id FROM platform_users pe
                     WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                     ORDER BY pe.id LIMIT 1) AS contact_email
              FROM contacts c
              JOIN platform_users pu
                ON pu.contact_id = c.id AND pu.platform_slug = 'telegram'
             WHERE c.client_id = $1
        ),
        cl AS (
            -- Кабинеты клиентов + их TG: ник из профиля и числовой id, если
            -- клиент когда-либо заходил в бот (ищем его контакт в СВОЕЙ базе).
            SELECT cl.id, cl.name, cl.email, cl.phone,
                   lower(ltrim(regexp_replace(
                       coalesce(cl.telegram_username, cl.work_tg_username, ''),
                       '^https?://(t\\.me|telegram\\.me)/', ''), '@')) AS nick,
                   (SELECT pu2.platform_user_id
                      FROM platform_users pu2
                      JOIN contacts c2 ON c2.id = pu2.contact_id
                     WHERE c2.client_id = cl.id
                       AND pu2.platform_slug = 'telegram'
                       AND lower(pu2.username) = lower(ltrim(regexp_replace(
                             coalesce(cl.telegram_username, cl.work_tg_username, ''),
                             '^https?://(t\\.me|telegram\\.me)/', ''), '@'))
                       AND pu2.platform_user_id ~ '^[0-9]+$'
                     ORDER BY pu2.id LIMIT 1) AS tg_id
              FROM clients cl
             WHERE cl.id <> $1
        )
        SELECT s.contact_id, s.contact_name, s.contact_phone, s.contact_email,
               s.tg_id, s.tg_nick,
               cl.id AS client_id, cl.name AS client_name,
               cl.email AS client_email, cl.phone AS client_phone
          FROM sub s
          JOIN cl
            ON (cl.tg_id IS NOT NULL AND cl.tg_id = s.tg_id)
            OR (cl.nick <> '' AND cl.nick = s.tg_nick)
         -- ⚠️ У одного человека бывает НЕСКОЛЬКО кабинетов (тот же TG-ник,
         -- тот же телефон в разном написании). Берём САМЫЙ СВЕЖИЙ: его данные
         -- актуальнее, а иначе выбор зависел бы от порядка строк в базе — то
         -- есть был бы случайным.
         ORDER BY s.contact_id, cl.id DESC
        """,
        service_client_id,
    )
    # Оставляем по ОДНОЙ строке на контакт (первая — самый свежий кабинет).
    seen: set[int] = set()
    out: list[dict] = []
    dupes: list[tuple[int, int]] = []
    for r in rows:
        if r["contact_id"] in seen:
            dupes.append((r["contact_id"], r["client_id"]))
            continue
        seen.add(r["contact_id"])
        out.append(dict(r))
    if dupes:
        print(f"⚠️ У {len(dupes)} контакт(ов) нашлось по несколько кабинетов — "
              f"взяли самый свежий, остальные пропущены:")
        for cid, skipped in dupes:
            print(f"   контакт #{cid}: пропущен кабинет #{skipped}")
    return out


def plan_for(row: dict, with_names: bool = False) -> dict:
    """Что именно поменяется у этого контакта. Пустой план = трогать нечего."""
    plan: dict[str, str] = {}
    if not (row.get("contact_email") or "").strip() and (row.get("client_email") or "").strip():
        plan["email"] = row["client_email"].strip()
    if not (row.get("contact_phone") or "").strip() and (row.get("client_phone") or "").strip():
        plan["phone"] = row["client_phone"].strip()
    if with_names and is_weak_name(row.get("contact_name")) \
            and looks_like_person_name(row.get("client_name")):
        plan["name"] = row["client_name"].strip()
    return plan


async def main(apply: bool, forced_client_id: int | None, with_names: bool = False) -> None:
    pool = await get_pool()
    async with pool.acquire() as db:
        service_client_id = await resolve_service_client_id(db, forced_client_id)
        total_subs = await db.fetchval(
            """SELECT COUNT(DISTINCT c.id) FROM contacts c
                 JOIN platform_users pu ON pu.contact_id = c.id
                                       AND pu.platform_slug = 'telegram'
                WHERE c.client_id = $1""",
            service_client_id,
        )
        rows = await fetch_matches(db, service_client_id)

        print(f"Сервисный клиент: #{service_client_id}")
        print(f"Подписчиков с Telegram: {total_subs}")
        print(f"Из них опознано как клиенты ПЛЮСОНа: {len(rows)}")
        print("Переносим: почта, телефон"
              + (", имена" if with_names else "  (имена — НЕ трогаем)"))
        print("-" * 78)

        # ⚠️ Один кабинет мог совпасть с несколькими контактами (например, ник
        # сменился, и в базе живут две записи). Показываем такие отдельно —
        # они первый признак дублей, и решать по ним должен человек.
        seen_clients: dict[int, list[int]] = {}
        for r in rows:
            seen_clients.setdefault(r["client_id"], []).append(r["contact_id"])

        n_email = n_phone = n_name = n_touched = 0
        for r in rows:
            plan = plan_for(r, with_names)
            if not plan:
                continue
            n_touched += 1
            n_email += "email" in plan
            n_phone += "phone" in plan
            n_name += "name" in plan
            changes = ", ".join(
                f"{k}: {'(пусто)' if k != 'name' else repr(r['contact_name'])} → {v}"
                for k, v in plan.items()
            )
            print(f"#{r['contact_id']:>6}  {(r['contact_name'] or '—')[:24]:<24} "
                  f"← клиент #{r['client_id']} «{r['client_name']}»")
            print(f"         {changes}")

        print("-" * 78)
        print(f"Будет изменено контактов: {n_touched}")
        print(f"  почта:   {n_email}")
        print(f"  телефон: {n_phone}")
        if with_names:
            print(f"  имя:     {n_name}")
        dups = {cid: cs for cid, cs in seen_clients.items() if len(cs) > 1}
        if dups:
            print(f"\n⚠️ Кабинетов, совпавших с НЕСКОЛЬКИМИ контактами: {len(dups)}")
            for cid, cs in dups.items():
                print(f"   клиент #{cid} → контакты {cs}  (возможные дубли, слить вручную)")

        if not apply:
            print("\nЭто предпросмотр — в базу ничего не записано.")
            print("Записать: python3 -m scripts.fill_service_contacts_from_clients --apply")
            return

        # ── Запись ──────────────────────────────────────────────────────────
        # ⚠️ Каждый контакт — отдельной транзакцией. Если один упадёт (скажем,
        # почта уже занята другим контактом и не проходит UNIQUE), остальные
        # всё равно доедут, а не откатятся все разом.
        ok = failed = 0
        for r in rows:
            plan = plan_for(r, with_names)
            if not plan:
                continue
            try:
                async with db.transaction():
                    if "name" in plan:
                        await db.execute(
                            "UPDATE contacts SET name = $2 WHERE id = $1",
                            r["contact_id"], plan["name"],
                        )
                    if "phone" in plan:
                        # only_if_empty=True: если телефон успели заполнить
                        # между предпросмотром и запуском — не затираем.
                        await set_contact_phone(
                            db, r["contact_id"], plan["phone"], only_if_empty=True,
                        )
                    if "email" in plan:
                        await sync_email_identity_and_subscription(
                            db,
                            client_id=service_client_id,
                            contact_id=r["contact_id"],
                            email=plan["email"],
                        )
                ok += 1
            except Exception as e:  # noqa: BLE001 — один сбой не должен рвать проход
                failed += 1
                print(f"   ✗ контакт #{r['contact_id']}: {e}")

        print(f"\nГотово. Обновлено: {ok}, с ошибкой: {failed}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true",
                    help="записать в базу (без флага — только предпросмотр)")
    ap.add_argument("--client-id", type=int, default=None,
                    help="id сервисного клиента (по умолчанию — is_system_service)")
    # ⚠️ Имена по умолчанию НЕ переносим. Почта и телефон однозначны — они либо
    # есть, либо нет. С именем сложнее: в кабинете может стоять «ООО Ромашка»
    # или рабочее написание, и в карточке человека оно смотрится хуже, чем
    # пришедшее из Telegram. Имена разбираем отдельным заходом, глазами.
    ap.add_argument("--with-names", action="store_true",
                    help="переносить ещё и имена (по умолчанию — только почта и телефон)")
    args = ap.parse_args()
    asyncio.run(main(args.apply, args.client_id, args.with_names))
