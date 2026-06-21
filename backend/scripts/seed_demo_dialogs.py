"""Разовый сидер демо-переписок — чтобы показать раздел «Диалоги» на живых контактах.

Берёт несколько реальных контактов клиента (с TG/VK идентичностью) и создаёт
правдоподобную короткую переписку (входящие от человека + автоответ бота +
ответ оператора). Никому ничего не отправляет — только пишет в БД.

Запуск на сервере:
    cd /path/to/backend && python3 -m scripts.seed_demo_dialogs <client_id> [count]

По умолчанию client_id=1, count=4. Идемпотентность: для контакта пропускаем,
если у него уже есть строки в direct_messages.
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone

from app.database import get_pool

SAMPLE = [
    ("contact", "Здравствуйте! А запись эфира будет потом доступна?"),
    ("bot", "Спасибо, видим ваше сообщение 💛 Чтобы связаться с поддержкой — напишите команду /support."),
    ("operator", "Да, запись будет — пришлём её всем участникам на следующий день после эфира 🙌"),
    ("contact", "Супер, спасибо большое!"),
]


async def main(client_id: int, count: int):
    pool = await get_pool()
    async with pool.acquire() as db:
        contacts = await db.fetch(
            """SELECT DISTINCT c.id, c.name, pu.platform_slug, pu.platform_user_id,
                      (SELECT cc.channel_id FROM client_channels cc
                         JOIN channels ch ON ch.id = cc.channel_id
                        WHERE cc.client_id = $1 AND ch.platform_slug = pu.platform_slug
                        ORDER BY cc.is_active DESC LIMIT 1) AS channel_id
                 FROM contacts c
                 JOIN platform_users pu ON pu.contact_id = c.id AND pu.client_id = $1
                WHERE c.client_id = $1
                  AND pu.platform_slug IN ('telegram','vk','max')
                  AND c.name IS NOT NULL AND c.name <> ''
                  AND NOT EXISTS (SELECT 1 FROM direct_messages dm WHERE dm.contact_id = c.id)
                ORDER BY c.id DESC
                LIMIT $2""",
            client_id, count,
        )
        if not contacts:
            print("Нет подходящих контактов (возможно, у всех уже есть переписка).")
            return

        now = datetime.now(timezone.utc)
        for i, c in enumerate(contacts):
            base = now - timedelta(hours=3 + i)
            for j, (kind, text) in enumerate(SAMPLE):
                direction = "in" if kind == "contact" else "out"
                await db.execute(
                    """INSERT INTO direct_messages
                        (client_id, contact_id, platform, channel_id, platform_user_id,
                         direction, author_kind, text, is_read, sent_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9)""",
                    client_id, c["id"], c["platform_slug"], c["channel_id"],
                    c["platform_user_id"], direction, kind, text,
                    base + timedelta(minutes=j * 4),
                )
            print(f"  ✓ демо-диалог для #{c['id']} {c['name']} ({c['platform_slug']})")
        print(f"Готово: {len(contacts)} демо-диалогов.")


if __name__ == "__main__":
    cid = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    cnt = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    asyncio.run(main(cid, cnt))
