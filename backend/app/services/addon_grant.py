"""Выдача и продление модуля клиенту — ОДНА точка на весь проект.

⚠️⚠️ Почему функция общая, а не по копии в каждом месте (12.09.2026, ПРОД).
Модуль выдаётся из ЧЕТЫРЁХ мест: оплата (`addons.py`), ручная выдача админом
(`admin.py`), бонус ПЛЮСОНа (`plusson_bonus.py`), комплект «тариф + модуль»
(`tariff_plusson_bonus.py`). Во всех четырёх лежал один и тот же код — «найти
действующий → продлить, иначе вставить» — и во всех четырёх он падал:

    asyncpg.exceptions.UniqueViolationError:
        duplicate key value violates unique constraint "uq_client_addon_active"

⚠️ Причина — РАСХОЖДЕНИЕ УСЛОВИЙ. Поиск действующего модуля шёл по
`status='active' AND expires_at > NOW()`, а уникальный индекс в базе —
`UNIQUE (client_id, feature_id) WHERE status='active'`, **без даты**. Строка с
истёкшим сроком, но статусом `active` (а таких на проде 19 — статус в `expired`
не переводит никто) поиском НЕ находится, код идёт вставлять новую — и упирается
в индекс. Наружу это выглядело так: в LeadPay оплата прошла, у нас заказ
навсегда «Создан, ждём оплаты», модуль не выдан, деньги у клиента списаны.
Вебхук при этом отвечал 500, и платёжка долбила его повторами впустую.

Правило: условие поиска ОБЯЗАНО совпадать с условием индекса. Здесь это
обеспечено тем, что поиска нет вовсе — один `INSERT ... ON CONFLICT`, который
выводит конфликт из того же частичного индекса. Заодно снимается гонка: два
одновременных вебхука (а LeadPay шлёт повторы) больше не могут разойтись.
"""
from typing import Optional

import asyncpg


async def grant_addon(
    db: asyncpg.Connection,
    *,
    client_id: int,
    feature_id: int,
    days: int,
    source: str = "paid",
    add_months: int = 1,
    price: Optional[int] = None,
) -> asyncpg.Record:
    """Выдаёт модуль или продлевает уже выданный. Возвращает строку client_addons.

    Поведение по сроку:
      • модуль ДЕЙСТВУЕТ  → `days` прибавляются к его концу (оплаченные дни не
        сгорают у того, кто заплатил заранее);
      • модуль ИСТЁК      → отсчёт с сегодня, `started_at` переставляется на
        сегодня (началcя новый период, а не продолжился прошлогодний);
      • модуля НЕТ вовсе  → создаётся.

    ⚠️ `source` при продлении НЕ перезаписывается: ручная выдача поверх
    оплаченного модуля не должна стирать признак оплаты в отчётах.

    ⚠️ Флаги предупреждений сбрасываются всегда — иначе таск `addon_expiry`
    решит, что об истечении уже уведомлял, и клиент не получит предупреждений
    по новому сроку.
    """
    return await db.fetchrow(
        """
        INSERT INTO client_addons
            (client_id, feature_id, started_at, expires_at,
             status, source, months, price)
        VALUES ($1, $2, NOW(), NOW() + ($3 || ' days')::interval,
                'active', $4, $5, $6)
        ON CONFLICT (client_id, feature_id) WHERE status = 'active'
        DO UPDATE SET
            -- GREATEST: действующий продлеваем от его конца, истёкший — от сегодня
            expires_at  = GREATEST(client_addons.expires_at, NOW())
                          + ($3 || ' days')::interval,
            started_at  = CASE WHEN client_addons.expires_at <= NOW()
                               THEN NOW() ELSE client_addons.started_at END,
            months      = client_addons.months + $5,
            price       = COALESCE($6, client_addons.price),
            notified_7d = FALSE,
            notified_3d = FALSE,
            notified_1d = FALSE,
            updated_at  = NOW()
        RETURNING id, expires_at, started_at
        """,
        client_id, feature_id, str(int(days)), source, int(add_months), price,
    )
