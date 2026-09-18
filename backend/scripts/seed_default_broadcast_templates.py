"""Первичное наполнение библиотеки дефолтных шаблонов (миграция 217).

Переносит DEFAULT_TEMPLATES из кода в таблицу default_broadcast_templates —
один-в-один, чтобы поведение не изменилось. Флаги модулей (for_event /
for_conference / for_turnir), autoseed и multi_instance проставляются по той
логике, что раньше была захардкожена в _allowed_preset_types_for_event().

Идемпотентно: повторный запуск НЕ перезатирает уже отредактированные в админке
шаблоны (ON CONFLICT DO NOTHING по type). Чтобы залить заново — сначала DELETE.

Запуск на сервере:
    cd /var/www/plusson/backend && python3 -m scripts.seed_default_broadcast_templates
"""
import asyncio

import asyncpg

from app.config import settings
from app.api.modules.broadcasts import (
    DEFAULT_TEMPLATES,
    _TURNIR_TEMPLATE_NAMES,
    _TURNIR_TEMPLATE_TEXTS,
)

# Раньше это были константы внутри _allowed_preset_types_for_event().
EVENT_ONLY_TYPES = {
    "30min_before", "2h_before_unreg", "2h_before_reg",
    "day_before_09_12_unreg", "day_before_09_12_reg", "event_live",
}
# Турнир получает в АВТО-СИДЕ (помимо общих).
TURNIR_AUTOSEED_EXTRA = {"speaker_intro", "5min_before", "day_live",
                         "speakers_call", "speakers_day"}
# …и дополнительно может добавить вручную из пресетов.
TURNIR_PRESET_EXTRA = TURNIR_AUTOSEED_EXTRA | {"pre_conf", "gift", "day_end", "expert_day"}

MULTI_INSTANCE = {"vip_offer", "custom", "expert_day"}
# expert_day не сидится автоматически — только через «Добавить шаблон».
NO_AUTOSEED = {"expert_day"}


def flags_for(t: str) -> dict:
    """Кому доступен шаблон — по прежней логике фильтрации."""
    # Мероприятие (без программы по дням): только «общие» типы.
    for_event = t in EVENT_ONLY_TYPES
    # Конференция: всё, кроме event_live (у неё свой day_live).
    for_conference = t != "event_live"
    # Турнир: общие типы + спикерские/дневные из TURNIR_PRESET_EXTRA, кроме event_live.
    for_turnir = (t in EVENT_ONLY_TYPES or t in TURNIR_PRESET_EXTRA) and t != "event_live"
    return {
        "for_event": for_event,
        "for_conference": for_conference,
        "for_turnir": for_turnir,
    }


async def main() -> None:
    conn = await asyncpg.connect(settings.database_url)
    inserted = skipped = 0
    for i, tpl in enumerate(DEFAULT_TEMPLATES):
        t = tpl["type"]
        f = flags_for(t)
        row = await conn.fetchrow(
            """
            INSERT INTO default_broadcast_templates
              (type, name, subject, text, text_event, photo_url, button_text, button_url,
               schedule_mode, offset_minutes, audience_include, audience_exclude,
               allow_custom_datetime, for_event, for_conference, for_turnir,
               autoseed, multi_instance, turnir_name, turnir_text, sort_order,
               send_to_speakers_chat)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
            ON CONFLICT (type) DO NOTHING
            RETURNING id
            """,
            t,
            tpl["name"],
            tpl.get("subject"),
            tpl["text"],
            tpl.get("text_event"),
            tpl.get("photo_url"),
            tpl.get("button_text"),
            tpl.get("button_url"),
            tpl.get("schedule_mode", "fixed_offset"),
            tpl.get("offset_minutes", 0),
            tpl.get("audience_include", "all_event"),
            tpl.get("audience_exclude", "none"),
            bool(tpl.get("allow_custom_datetime", False)),
            f["for_event"], f["for_conference"], f["for_turnir"],
            t not in NO_AUTOSEED,
            t in MULTI_INSTANCE,
            _TURNIR_TEMPLATE_NAMES.get(t),
            _TURNIR_TEMPLATE_TEXTS.get(t),
            i * 10,
            bool(tpl.get("send_to_speakers_chat", False)),
        )
        if row:
            inserted += 1
        else:
            skipped += 1
        print(f"{'+' if row else '=':2} {t:<24} event={f['for_event']:<5} conf={f['for_conference']:<5} turnir={f['for_turnir']}")

    print(f"\nДобавлено: {inserted}, уже было (не тронуто): {skipped}")
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
