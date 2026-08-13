"""
Анкета как шлагбаум перед выдачей подарка (миграция 280).

⚠️ Одна точка на все три бота (TG/VK/MAX) — как `event_signup.py` у регистрации.
Копии на каждый мессенджер быть не должно: разъедется при первой же правке.

Порядок в воронке: подписка на канал → АНКЕТА → файл. Подписка первой —
решение владельца (2026-08-12).

Цикла «анкета выдаёт подарок, который требует эту же анкету» тут быть не может:
анкета подарки не выдаёт сама по себе, выдача включается только полем
`lead_magnets.require_survey_id` / `lead_magnet_packages.require_survey_id`.
"""
from typing import Optional

from app.services.client_domains import client_public_url


async def required_survey_for_run(db, run: dict) -> Optional[dict]:
    """Какую анкету нужно заполнить перед выдачей материалов этого забега.

    Возвращает строку анкеты либо None, если:
      - у лид-магнита/пакета анкета не требуется (по умолчанию — не требуется);
      - анкета выключена (`is_active=FALSE`) — тогда шлагбаум просто не работает,
        а не блокирует выдачу навсегда;
      - человек её УЖЕ заполнял (проверяем факт ответа, а не факт настройки).
    """
    survey_id = None
    if run.get("lead_magnet_id"):
        survey_id = await db.fetchval(
            "SELECT require_survey_id FROM lead_magnets WHERE id = $1",
            run["lead_magnet_id"])
    elif run.get("package_id"):
        survey_id = await db.fetchval(
            "SELECT require_survey_id FROM lead_magnet_packages WHERE id = $1",
            run["package_id"])
    if not survey_id:
        return None

    survey = await db.fetchrow(
        "SELECT * FROM surveys WHERE id = $1 AND is_active = TRUE", survey_id)
    if not survey:
        return None

    # Уже заполнял → шлагбаум открыт. Проверяем по факту ответа, поэтому
    # повторно человека не гоняем даже если он вернулся за подарком позже.
    contact_id = run.get("contact_id")
    if contact_id:
        done = await db.fetchval(
            "SELECT 1 FROM survey_responses WHERE survey_id = $1 AND contact_id = $2 LIMIT 1",
            survey_id, contact_id)
        if done:
            return None
    return dict(survey)


async def survey_link_for_run(db, survey: dict, run: dict) -> str:
    """Ссылка на анкету с зашитым контекстом: кто человек, за каким подарком
    пришёл и с какой площадки.

    ⚠️ Именно так подарок находит дорогу назад: после отправки анкета видит в
    ссылке номер подарка и площадку, поэтому выдаёт файл сразу и дублирует его
    в тот же мессенджер, из которого человек ушёл заполнять. Отдельного
    «вернуть человека» делать не нужно.

    ⚠️ Домен берём у ВЛАДЕЛЬЦА лид-магнита (client_id забега) — то же правило,
    что и для ссылок воронок: клиент со своим доменом раздаёт свой адрес.
    """
    base = (await client_public_url(db, run["client_id"])).rstrip('/')
    parts = [f"{base}/f/{survey['slug']}?c={run['contact_id']}"]
    if run.get("lead_magnet_id"):
        parts.append(f"lm={run['lead_magnet_id']}")
    if run.get("package_id"):
        parts.append(f"pkg={run['package_id']}")
    platform = run.get("platform_slug")
    if platform:
        short = {'telegram': 'tg', 'vk': 'vk', 'max': 'max'}.get(platform, platform)
        parts.append(f"to={short}")
    return parts[0] + ('&' + '&'.join(parts[1:]) if len(parts) > 1 else '')


DEFAULT_SURVEY_TEXT = (
    "Чтобы получить материал, ответьте на несколько вопросов — "
    "они помогут нам сформировать полезный контент и продукты.\n\n"
    "После заполнения анкеты материал придёт вам сюда."
)


def survey_prompt_text(survey: dict, custom: str | None = None) -> str:
    """Текст-приглашение, когда человек упёрся в анкету по дороге за подарком.

    ⚠️ Это ОТДЕЛЬНОЕ сообщение, которое уходит ПОСЛЕ подписки на канал и
    ДО выдачи материала. В Текст 1 требование заполнить анкету класть
    нельзя: человек ещё не подписался, а ему уже второе требование — два
    условия сразу не разбираются.

    `custom` — текст из шаблона воронки клиента (`funnel_templates.text_survey`).
    Пусто → дефолт. Плейсхолдер `{survey_title}` подставляет название анкеты.
    """
    title = survey.get("title") or "анкету"
    text = (custom or "").strip() or DEFAULT_SURVEY_TEXT
    return text.replace("{survey_title}", title)


async def survey_text_for_client(db, client_id: int) -> str | None:
    """Свой текст клиента для шага «сначала анкета» (пусто → дефолт)."""
    if not client_id:
        return None
    return await db.fetchval(
        """SELECT text_survey FROM funnel_templates
            WHERE client_id = $1 AND type = 'lead_magnet'""",
        client_id,
    )
