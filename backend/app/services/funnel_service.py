"""
Сервис воронок выдачи лид-магнитов и пакетов через бот.

Высокоуровневые операции:
  - run_started(run_id, ...): фиксирует stage=started, шлёт уведомление организатору,
    отправляет Текст 1 + кнопку. Вызывается из бот-handler /start fnl_<run_id>.
  - run_check_subscription(run_id, ...): проверяет подписку через getChatMember,
    при успехе → stage=delivered, шлёт Текст 2 со списком ссылок, ставит таймер на Текст 3.
  - send_text_3(run_id): вызывается из Celery через 30 минут. Выбирает нужную версию
    (delivered/stuck) по текущему stage.

Все взаимодействия с Telegram — через httpx (без aiogram), чтобы вызывать из любого
контекста (FastAPI/Celery/aiogram-handler).
"""
from typing import Optional, Tuple
from urllib.parse import quote
import httpx
import json
import logging
from app.services.channels import get_client_telegram_token
from app.services.social_links import normalize_telegram_link, telegram_api_id, get_founder_tg_channels
from app.config import settings

log = logging.getLogger(__name__)

PLUSSON_TOKEN = lambda: settings.telegram_bot_token  # noqa: E731


async def _get_template(client_id: int, db) -> Optional[dict]:
    return await db.fetchrow(
        """SELECT id, text_1, button_label, text_2, text_3_delivered, text_3_stuck,
                  text_1_media_url, text_1_media_type, text_1_media_file_id,
                  text_2_media_url, text_2_media_type, text_2_media_file_id
             FROM funnel_templates WHERE client_id = $1 AND type = 'lead_magnet'""",
        client_id
    )


async def _get_brand_context(client_id: int, db, platform: str = "telegram") -> dict:
    """Подтягивает плейсхолдеры визитки клиента.

    `platform`:
        'telegram' → subscription_channel = TG-канал клиента (`social_links.telegram`)
        'vk'       → subscription_channel = VK-сообщество клиента (`social_links.vk`)

    Возвращает универсальные поля + платформо-зависимые для проверки подписки:
        - subscription_channel             — https-URL для текста воронки
        - subscription_channel_api         — id для Bot API (TG: @username, VK: не нужен)
        - subscription_channel_chat_id     — числовой id (TG: chat_id, VK: group_id)
    """
    row = await db.fetchrow(
        """SELECT
              COALESCE(NULLIF(brand_name, ''), name) AS brand_name,
              -- ⚠️ Имя основателя с фамилией (миграция 381): уходит в
              -- плейсхолдер {client_owner_name} текстов воронки.
              btrim(CASE WHEN COALESCE(btrim(last_name), '') = '' THEN COALESCE(name, '') ELSE COALESCE(name, '') || ' ' || COALESCE(last_name, '') END) AS owner_name,
              bio,
              owner_positioning,
              owner_achievements,
              social_links,
              -- {owner_telegram} — ЛИЧНЫЙ телеграм основателя (тот, что он указал
              -- при регистрации, Настройки → Профиль). Только Telegram: личных
              -- аккаунтов на VK/MAX у клиента в базе нет.
              telegram_username,
              -- Служба заботы (Настройки → Профиль) — это ДРУГОЕ, не личка основателя.
              -- Отсюда {support_platform} (контакт своей площадки) и {support_link}
              -- (все площадки списком).
              work_tg_username, work_vk, work_max
             FROM clients WHERE id = $1""",
        client_id
    )
    if not row:
        return {}
    social = row["social_links"] or {}
    if isinstance(social, str):
        try:
            social = json.loads(social)
        except Exception:
            social = {}

    sub_channel = ""
    sub_channel_api = ""
    sub_channel_chat_id = ""

    if platform == "vk":
        from app.services.social_links import vk_screen_name_from_link, get_founder_vk_channels
        vk_channels = get_founder_vk_channels(social or {})
        # Для текста — ссылки на ВСЕ VK-сообщества основателя через перенос строки.
        sub_channel = "\n".join(ch["url"] for ch in vk_channels) if vk_channels else ""
        # Первый канал — для legacy-плейсхолдеров и проверки подписки.
        if vk_channels:
            first = vk_channels[0]
            # screen_name VK сообщества — для resolveScreenName.
            sub_channel_api = vk_screen_name_from_link(first["url"])
            # Для прямой проверки подписки нужен числовой group_id.
            raw_group_id = first.get("group_id")
            if raw_group_id is not None and str(raw_group_id).strip():
                try:
                    sub_channel_chat_id = str(int(raw_group_id))
                except (TypeError, ValueError):
                    sub_channel_chat_id = ""
    elif platform == "max":
        from app.services.social_links import get_founder_max_channels
        max_channels = get_founder_max_channels(social or {})
        # Для текста — ссылки на ВСЕ MAX-каналы основателя через перенос строки.
        sub_channel = "\n".join(ch["url"] for ch in max_channels) if max_channels else ""
        if max_channels:
            first = max_channels[0]
            sub_channel_chat_id = first.get("chat_id") or ""
    else:
        # Telegram (default) — массив каналов основателя (миграция 114).
        # Старые legacy-ключи (telegram/telegram_chat_id) подхватываются get_founder_tg_channels
        # как fallback на случай если миграция ещё не накатана.
        tg_channels_full = get_founder_tg_channels(social)
        # Для текста — все ссылки через перенос строки (если 1 канал — один URL без переноса).
        sub_channel = "\n".join(ch["url"] for ch in tg_channels_full) if tg_channels_full else ""
        # Первый канал — для совместимости со старыми плейсхолдерами `subscription_channel_api`
        # и `subscription_channel_chat_id` (используются в VK-логике и устаревших путях кода).
        if tg_channels_full:
            first = tg_channels_full[0]
            sub_channel_api = telegram_api_id(first["url"])
            sub_channel_chat_id = first.get("chat_id") or ""
        # Полный список каналов — для проверки подписки на ВСЕ в run_check_subscription
        # и для построения списка «не подписан на: ...» в handler/funnel.
        # См. функцию `check_telegram_channels_subscription` ниже.

    achievements = row["owner_achievements"] or []
    if isinstance(achievements, str):
        try:
            achievements = json.loads(achievements)
        except Exception:
            achievements = []
    achievements_text = ""
    if achievements:
        parts = []
        for a in achievements:
            label = (a.get("label") or "").strip()
            value = (a.get("value") or "").strip()
            if label and value:
                parts.append(f"• {label}: {value}")
            elif value:
                parts.append(f"• {value}")
        achievements_text = "\n".join(parts)
    # tg_channels — массив всех TG-каналов основателя (для проверки подписки на ВСЕ).
    # Заполняется только для платформы 'telegram'; для 'vk' — пусто.
    tg_channels: list[dict] = []
    if platform != "vk":
        tg_channels = get_founder_tg_channels(social)

    # ── Личка основателя ──────────────────────────────────────────────────────
    # {owner_telegram} — ЛИЧНЫЙ телеграм основателя (clients.telegram_username,
    # указывается при регистрации). ⚠️ Это НЕ служба заботы и НЕ канал основателя.
    # Только Telegram — личных аккаунтов основателя на VK/MAX в базе нет.
    from app.services.support_message import _lines as _support_lines, tg_support_link, support_url_for_platform
    owner_tg_personal = tg_support_link(row["telegram_username"])

    # ── Служба заботы (Настройки → Профиль) ───────────────────────────────────
    support_rows = _support_lines(row["work_tg_username"], row["work_vk"], row["work_max"])
    # {support_platform} — служба заботы на ТОЙ площадке, где человек в воронке
    # (в Telegram — телеграм-контакт, в VK — ВК, в MAX — MAX). Пусто, если на этой
    # площадке контакт не заполнен.
    support_platform = support_url_for_platform(
        platform, row["work_tg_username"], row["work_vk"], row["work_max"])
    # {support_links} — ВСЕ каналы поддержки (ВК / Телеграм / MAX), по строке на каждый.
    # HTML для TG/MAX, VK всё равно срежет теги и оставит URL.
    support_links = "\n".join(
        f'{label}: <a href="{url}">{url}</a>' for label, url in support_rows)

    return {
        "brand_name": row["brand_name"] or "",
        "owner_name": row["owner_name"] or "",
        "owner_bio": row["bio"] or "",
        "owner_positioning": row["owner_positioning"] or "",
        "owner_achievements": achievements_text,
        "subscription_channel": sub_channel,                   # https-ссылка (или список через \n) для текста
        "subscription_channel_api": sub_channel_api,           # TG @username первого канала / VK screen_name
        "subscription_channel_chat_id": sub_channel_chat_id,   # числовой id первого канала (для VK group_id)
        # {owner_telegram} — ЛИЧНЫЙ телеграм основателя (clients.telegram_username,
        # из регистрации). Не служба заботы и не канал. Только Telegram.
        "owner_telegram": owner_tg_personal,
        # {support_platform} — служба заботы на площадке этой воронки.
        "support_platform": support_platform,
        "support_links": support_links,                        # все каналы поддержки, по строке
        "tg_channels": tg_channels,                            # массив для проверки подписки на ВСЕ
    }


async def _referrer_link_params(run: dict, db) -> dict:
    """Значения плейсхолдеров реф-кодов для ссылок лид-магнитов, взятые у
    рефовода этого run (кто привёл человека в воронку — fr.referrer_contact_id):

      {plsn_ref} — плюсоновский реф-код рефовода (contacts.ref_code). Для ссылки
                   регистрации в ПЛЮСОН: pluson.ru/register?pid={plsn_ref}.
                   /register сам резолвит код-контакт спикера в его клиентский
                   аккаунт (services/plusson_referral.py).
      {ext_ref}  — сторонний партнёрский код рефовода (contacts.external_ref_param,
                   напр. gcpc=fdd97). Для внешних систем: landing.ru/?{ext_ref}.

    Нет рефовода / поле пустое → пустая строка (плейсхолдер исчезает)."""
    rid = run.get("referrer_contact_id")
    if not rid:
        return {"plsn_ref": "", "ext_ref": ""}
    row = await db.fetchrow(
        "SELECT ref_code, external_ref_param FROM contacts WHERE id = $1", rid
    )
    if not row:
        return {"plsn_ref": "", "ext_ref": ""}
    return {
        "plsn_ref": row["ref_code"] or "",
        "ext_ref": row["external_ref_param"] or "",
    }


def _apply_link_params(url: str, params: dict) -> str:
    """Раскрыть {plsn_ref}/{ext_ref} внутри URL материала."""
    if not url:
        return url
    for k, v in params.items():
        url = url.replace("{" + k + "}", v or "")
    return url


async def _materials_for_run(run: dict, db) -> list[dict]:
    """Возвращает список материалов воронки:
    [{name, url, description, link_mode, button_label}, ...].
    Для одиночного лид-магнита — список из одного. Для пакета — все вложенные.

    В url каждого материала раскрываются плейсхолдеры {plsn_ref}/{ext_ref}
    (реф-коды рефовода) — см. _referrer_link_params."""
    if run["lead_magnet_id"]:
        rows = await db.fetch(
            "SELECT id, slug, name, url, description, link_mode, button_label, "
            "       link_source, support_prefill "
            "  FROM lead_magnets WHERE id = $1",
            run["lead_magnet_id"]
        )
    else:
        rows = await db.fetch(
            """SELECT lm.id, lm.slug, lm.name, lm.url, lm.description,
                      lm.link_mode, lm.button_label,
                      lm.link_source, lm.support_prefill
                 FROM lead_magnet_package_items pi
                 JOIN lead_magnets lm ON lm.id = pi.lead_magnet_id
                WHERE pi.package_id = $1
             ORDER BY pi.sort_order, lm.name""",
            run["package_id"]
        )
    materials = [dict(r) for r in rows]

    # ─── Ссылка на службу заботы вместо фиксированного адреса (миграция 385) ───
    #
    # ⚠️ РЕЗОЛВ ПО ПЛОЩАДКЕ ЧЕЛОВЕКА, а не «первый заполненный контакт»:
    # пришёл из ВКонтакте — ссылка во ВКонтакте, из MAX — в MAX. Иначе человека
    # отправляли бы писать в мессенджер, которым он не пользуется.
    #
    # ⚠️ Владелец лид-магнита — НЕ обязательно владелец события: у спикера может
    # быть свой кабинет ([[feedback_gift_funnel_link_owner_bot]]). Берём контакты
    # того клиента, чей это лид-магнит.
    if any((m.get("link_source") or "fixed") == "support" for m in materials):
        from app.services.support_message import support_url_for_platform
        sup = await db.fetchrow(
            """SELECT cl.work_tg_username, cl.work_vk, cl.work_max
                 FROM lead_magnets lm
                 JOIN clients cl ON cl.id = lm.client_id
                WHERE lm.id = $1""",
            materials[0]["id"],
        )
        platform = (run.get("platform_slug") or "telegram")
        for m in materials:
            if (m.get("link_source") or "fixed") != "support":
                continue
            url = support_url_for_platform(
                platform,
                sup["work_tg_username"] if sup else None,
                sup["work_vk"] if sup else None,
                sup["work_max"] if sup else None,
            ) if sup else ""
            # ⚠️ Кодовое слово подставляется ТОЛЬКО в Telegram: там `?text=`
            # заполняет поле ввода. У ВКонтакте (`?ref=`) и MAX (`?start=`)
            # параметр читает бот сообщества, текстом сообщения он не станет —
            # дописывать его туда значит ломать ссылку без всякой пользы.
            prefill = (m.get("support_prefill") or "").strip()
            if url and prefill and platform == "telegram":
                sep = "&" if "?" in url else "?"
                url = f"{url}{sep}text={quote(prefill)}"
            m["url"] = url

    # Раскрываем плейсхолдеры реф-кодов ({plsn_ref}/{ext_ref}) в url материалов,
    # только если они реально встречаются — иначе не дёргаем БД за рефоводом.
    # Плейсхолдеры живут в самой ссылке лид-магнита (lead_magnets.url), поэтому
    # раскрываются здесь, а не в тексте шаблона.
    if any("{plsn_ref}" in (m["url"] or "") or "{ext_ref}" in (m["url"] or "") for m in materials):
        params = await _referrer_link_params(run, db)
        for m in materials:
            m["url"] = _apply_link_params(m["url"], params)

    # ⚠️⚠️ `{plsn_bot}` — ГОТОВАЯ ССЫЛКА НА БОТ ПЛЮСОНА, а не голый код.
    # Отличие от `{plsn_ref}`: тот даёт только код, и клиенту приходится самому
    # собирать вокруг него адрес — а адрес РАЗНЫЙ у каждой площадки (у VK код
    # уходит параметром `ref`, а не `start`). Здесь площадка человека уже
    # известна (`run.platform_slug`), поэтому подставляем ссылку на бот ТОЙ
    # площадки, где он сидит: переход в свой мессенджер, а не в чужой.
    #
    # ⚠️⚠️ РЕФ-КОД БЕРЁТСЯ У РЕФОВОДА, А НЕ У ВЛАДЕЛЬЦА БОТА — точно так же,
    # как у `{plsn_ref}` (см. `_referrer_link_params`). Разница существенная:
    # Маша пришла в бот КАТИ по ссылке АЛЁНЫ — регистрация в ПЛЮСОНе должна
    # закрепиться за Алёной, она привела человека. Взять здесь владельца бота
    # значило бы отобрать приведённого у того, кто его привёл.
    #
    # ⚠️ Рефовода нет (человек пришёл по общей ссылке, без чьей-либо метки) →
    # ссылки нет вовсе, плейсхолдер схлопывается в пустоту: безымянная ссылка
    # закрепила бы человека неизвестно за кем.
    _plsn = [m for m in materials
             if "{plsn_bot}" in (m["url"] or "")
             or (m.get("link_source") or "").startswith("plusson_")]
    if _plsn:
        from app.services.plusson_ref_links import plusson_ref_link
        platform = (run.get("platform_slug") or "telegram")

        # Реф-код ВЛАДЕЛЬЦА бота — он же запасной для режима «ссылка рефовода».
        owner_code = await db.fetchval(
            "SELECT referral_code FROM clients WHERE id = $1", run["client_id"]) or ""

        # ⚠️ Код рефовода спрашиваем ОДИН раз на весь забег, а не на каждый
        # материал: у всех подарков одного забега рефовод общий.
        _rp = await _referrer_link_params(run, db)
        referrer_code = _rp.get("plsn_ref") or ""

        for m in _plsn:
            src = (m.get("link_source") or "")
            # ⚠️⚠️ «Ссылка рефовода» — с ЗАПАСНЫМ вариантом на владельца.
            # Рефовода может не быть (человек пришёл по общей ссылке клиента)
            # или он не клиент ПЛЮСОНа — тогда его код никуда не резолвится.
            # Отдать пустоту нельзя: подарок без ссылки хуже, чем подарок,
            # приведший человека владельцу бота.
            code = (referrer_code or owner_code) if src == "plusson_referrer" else owner_code
            link = await plusson_ref_link(db, code, platform)
            if m.get("url"):
                m["url"] = m["url"].replace("{plsn_bot}", link)
            if src.startswith("plusson_") and not (m.get("url") or "").strip():
                m["url"] = link

    # ⚠️⚠️ СРОК ДОСТУПА — ПЛЕЙСХОЛДЕРОМ, А НЕ ЧИСЛОМ В ТЕКСТЕ. Он задаётся в
    # админке (тариф `trial` + бонус за реф-ссылку) и меняется: сегодня 7+7,
    # завтра другое. Число, вписанное в описание подарка, к тому дню начнёт
    # врать людям — а исправлять его пришлось бы у каждого клиента.
    #   {plsn_days}      — сколько дней даёт НАША ссылка (база + бонус)
    #   {plsn_days_base} — сколько получил бы человек без ссылки
    if any(("{plsn_days" in (m.get("description") or ""))
           or ("{plsn_days" in (m.get("name") or "")) for m in materials):
        from app.services.referral_rate import get_trial_bonus_days
        base = await db.fetchval(
            "SELECT default_duration_days FROM tariffs WHERE slug = 'trial'") or 0
        bonus = await get_trial_bonus_days(db)
        subs = {"{plsn_days}": str(int(base) + int(bonus)),
                "{plsn_days_base}": str(int(base))}
        for m in materials:
            for field in ("name", "description"):
                v = m.get(field)
                if not v:
                    continue
                for ph, val in subs.items():
                    v = v.replace(ph, val)
                m[field] = v

    # ⚠️ Материал внутри пакета может требовать свою анкету. Тогда ссылка ведёт
    # не на файл, а на воронку этого подарка в боте — там человека встретит
    # анкета. Делается ЗДЕСЬ, в единой точке сборки материалов: иначе пришлось
    # бы повторять в каждой платформенной ветке и в превью.
    try:
        await _apply_material_surveys(run, materials, db)
    except Exception:
        # fail-open: сбой проверки не должен лишать человека подарка.
        log.exception("survey gate (материалы пакета): пропускаем подмену ссылок")
    return materials


async def _package_description_for_run(run: dict, db) -> str:
    """Описание пакета (lead_magnet_packages.description) — для {materials_list_description}.
    Одиночный лид-магнит пакетом не является → пустая строка."""
    if run.get("package_id"):
        return (await db.fetchval(
            "SELECT description FROM lead_magnet_packages WHERE id = $1",
            run["package_id"],
        )) or ""
    return ""


async def _apply_material_surveys(run: dict, materials: list[dict], db) -> None:
    """Подменить ссылку у материалов, за которыми нужна анкета.

    Материал внутри пакета может требовать свою анкету. Раньше это не
    проверялось вовсе — человек получал такой подарок сразу, минуя анкету
    (у клиента: «сначала анкета» стоит на одном подарке из трёх, а приходят
    все три).

    ⚠️ Ведём СРАЗУ НА АНКЕТУ, а не на воронку этого материала. Заход по ссылке
    воронки (`m_{slug}`) запускает забег С НАЧАЛА: человек снова получил бы
    Текст 1 и снова «подпишись и жми ГОТОВО» — хотя он уже подписан и уже
    нажал. Второй круг человек читает как поломку.

    Ссылка на анкету несёт в себе и человека, и номер подарка, и площадку,
    поэтому после ответа материал приходит сам — туда же, в его мессенджер.
    """
    from app.services.survey_gate import material_surveys_for_run, survey_link_for_run
    pending = await material_surveys_for_run(db, run)
    if not pending:
        return

    for m in materials:
        survey = pending.get(m.get("id"))
        if not survey:
            continue
        # ⚠️ В ссылку кладём НОМЕР ЭТОГО материала, а не пакета: анкета по нему
        # поймёт, какой именно подарок выдать после заполнения.
        run_for_link = dict(run)
        run_for_link["lead_magnet_id"] = m["id"]
        run_for_link["package_id"] = None
        m["url"] = await survey_link_for_run(db, survey, run_for_link)
        # Пометка для текста сообщения: за этим подарком — сначала анкета.
        m["needs_survey"] = True


async def _package_link_mode(run: dict, db) -> Optional[str]:
    """Как пакет велел отдавать свои материалы (или None — решает материал).

    ⚠️ Значение пакета ПЕРЕБИВАЕТ настройку каждого материала: пакет сказал
    «кнопками» — кнопками уходит всё, даже то, у чего лично стоит «ссылкой в
    тексте». Иначе часть пунктов ушла бы кнопками, часть текстом, а нумерация
    подписей разъехалась бы со списком в сообщении.
    """
    if not run.get("package_id"):
        return None
    return await db.fetchval(
        "SELECT link_mode FROM lead_magnet_packages WHERE id = $1",
        run["package_id"],
    )


async def _funnel_buttons(run: dict, materials: list[dict], db) -> list[dict]:
    """Кнопки выдачи материалов: [{label, url}]. Пусто — кнопок нет.

    Сборку правил держим в одном месте (`lead_magnet_buttons`), а не в каждой
    платформенной ветке: иначе надписи и нумерация разъедутся между TG, VK и
    MAX.
    """
    from app.services.lead_magnet_buttons import buttons_for_materials
    return buttons_for_materials(materials, await _package_link_mode(run, db))


def _format_text(template: str, ctx: dict, materials: list[dict],
                 pkg_description: str = "", package_mode: str | None = None) -> str:
    # ⚠️ У материалов, которые уходят ТОЛЬКО кнопкой, ссылку в тексте НЕ
    # печатаем: иначе человек получает одно и то же дважды — строкой и кнопкой
    # (жалоба «выбрала кнопками, а пришло и ссылками, и кнопками»).
    # Режим пакета главнее личной настройки материала.
    from app.services.lead_magnet_buttons import show_link_in_text
    # {materials_list} — нумерованный список названий, названия ЖИРНЫЕ (<b>).
    materials_list = "\n\n".join(
        f"{i + 1}. <b>{m['name']}</b>" for i, m in enumerate(materials)
    )
    # {materials_with_links} — название ЖИРНОЕ (<b>) + ссылка через « — ».
    materials_with_links = "\n\n".join(
        (f"{i + 1}. <b>{m['name']}</b> — {m['url']}"
         if show_link_in_text(m, package_mode)
         else f"{i + 1}. <b>{m['name']}</b>")
        for i, m in enumerate(materials)
    )
    # {materials_list_description} и {materials_list_description_links} — расширенный
    # список: жирное название, под ним НЕжирное описание (через « — »). Пункты
    # разделены двумя переносами. Разница — только в ссылке:
    #   • {materials_list_description}       — БЕЗ ссылок;
    #   • {materials_list_description_links} — ссылка отдельной строкой (без эмодзи).
    # Если у пакета есть описание — оно идёт СВЕРХУ, затем два переноса, затем список.
    # У лид-магнита без описания строка описания опускается.
    # Формат пункта: жирное название на своей строке → НЕжирное описание на
    # следующей строке → (для *_links) ссылка отдельной строкой без эмодзи.
    def _one(i: int, m: dict, with_link: bool) -> str:
        # ⚠️ Между названием и описанием — ПУСТАЯ СТРОКА (два переноса).
        # Вплотную под жирным названием описание слипалось с ним в один абзац,
        # и список подарков читался сплошной стеной текста.
        parts = [f"{i + 1}. <b>{m['name']}</b>"]
        desc = (m.get("description") or "").strip()
        if desc:
            parts.append(desc)
        # За этим подарком сначала анкета — предупреждаем, иначе человек жмёт
        # ссылку в ожидании файла и не понимает, почему открылись вопросы.
        # ⚠️ Слово «подарок» здесь не годится: за ссылкой не всегда подарок —
        # это может быть запись на консультацию, разбор, доступ к чему-то.
        # Пишем нейтрально про ссылку, она приходит в любом случае.
        if m.get("needs_survey"):
            parts.append("📝 Сначала заполните анкету — ссылка придёт сразу после отправки.")
        if with_link and show_link_in_text(m, package_mode):
            url = (m.get("url") or "").strip()
            if url:
                parts.append(url)
        return "\n\n".join(parts)

    def _list_desc(with_link: bool) -> str:
        # ⚠️ Между подарками — разделительная черта, а не просто пустая строка.
        # Внутри пункта пустые строки уже есть (название / описание / ссылка),
        # поэтому без черты пункты сливались в одно полотно и было не понять,
        # где кончается один подарок и начинается следующий.
        body = "\n\n---\n\n".join(_one(i, m, with_link) for i, m in enumerate(materials))
        pkg = (pkg_description or "").strip()
        return f"{pkg}\n\n{body}" if pkg else body

    materials_list_description = _list_desc(with_link=False)
    materials_list_description_links = _list_desc(with_link=True)
    placeholders = {
        "materials_list": materials_list,
        "materials_list_description": materials_list_description,
        "materials_list_description_links": materials_list_description_links,
        "materials_with_links": materials_with_links,
        "client_brand_name": ctx.get("brand_name", ""),
        "client_owner_name": ctx.get("owner_name", ""),
        "client_owner_bio": ctx.get("owner_bio", ""),
        "client_owner_positioning": ctx.get("owner_positioning", ""),
        "client_owner_achievements": ctx.get("owner_achievements", ""),
        "subscription_channel": ctx.get("subscription_channel", ""),
        # ЛИЧНЫЙ телеграм основателя (clients.telegram_username, из регистрации).
        # НЕ служба заботы и НЕ канал основателя. Только Telegram.
        "owner_telegram": ctx.get("owner_telegram", ""),
        # Служба заботы на ТОЙ площадке, где человек в воронке (TG / VK / MAX).
        "support_platform": ctx.get("support_platform", ""),
        # Все каналы службы заботы (ВК / Телеграм / MAX) — по строке на каждый.
        "support_links": ctx.get("support_links", ""),
    }
    out = template
    for k, v in placeholders.items():
        out = out.replace("{" + k + "}", v or "")
    return out


async def _bot_token_for_client(client_id: int, db) -> Optional[str]:
    """Какой бот шлёт сообщения участнику воронки — ТОЛЬКО собственный бот клиента.
    Системный @pluson_bot больше не используется как fallback (он только для самого
    ПЛЮСОНа). Нет своего TG-бота → None (воронка на TG не работает, остаётся email/VK/MAX)."""
    return await get_client_telegram_token(client_id, db)


async def _vk_token_for_client(client_id: int, db) -> Optional[str]:
    """Token собственного VK-сообщества клиента для отправки сообщений участнику воронки.

    Возвращает None если у клиента нет своего активного VK-канала.
    Системный токен ПЛЮСОНа не используем — он принадлежит ПЛЮСОНу и не имеет
    права писать в личку подписчикам клиента."""
    return await db.fetchval(
        """SELECT ch.bot_token
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND cc.is_active = TRUE
              AND ch.platform_slug = 'vk'
              AND ch.is_system = FALSE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            ORDER BY ch.id ASC
            LIMIT 1""",
        client_id,
    )


async def _vk_admin_user_token_for_client(client_id: int, db) -> tuple[Optional[str], Optional[int]]:
    """User-токен админа VK-сообщества клиента (для нативной загрузки video.save)
    + group_id чтобы видео сохранилось в раздел «Видео» сообщества.

    Возвращает (user_token, group_id). Оба None — если клиент не прошёл OAuth
    в дашборде. См. POST /api/v1/channels/vk/admin-token.
    """
    row = await db.fetchrow(
        """SELECT ch.platform_meta
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND cc.is_active = TRUE
              AND ch.platform_slug = 'vk'
              AND ch.is_system = FALSE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            ORDER BY ch.id ASC
            LIMIT 1""",
        client_id,
    )
    if not row:
        return None, None
    import json as _json
    meta = row["platform_meta"] or {}
    if isinstance(meta, str):
        try:
            meta = _json.loads(meta)
        except Exception:
            return None, None
    user_token = meta.get("vk_admin_user_token")
    group_id = meta.get("vk_group_id")
    try:
        group_id = int(group_id) if group_id else None
    except (TypeError, ValueError):
        group_id = None
    return user_token, group_id


# Лимит Telegram на одно сообщение. Длиннее — `400 message is too long`,
# причём сообщение НЕ доходит целиком.
TG_MESSAGE_LIMIT = 4096


def split_long_message(text: str, limit: int = TG_MESSAGE_LIMIT) -> list[str]:
    """Режет длинный текст на части по границе абзаца (иначе — строки, иначе —
    жёстко по лимиту).

    ⚠️ Нужно потому, что текст воронки собирается из плейсхолдеров, и его длину
    клиент не контролирует: у одного клиента `{client_owner_bio}` оказалась на
    5892 символа, и Telegram отверг ВСЁ сообщение — человек получал только фото
    без текста и без кнопки «ГОТОВО», то есть воронка обрывалась (прод,
    2026-08-18). Резать по абзацу, а не по символу: разрыв внутри HTML-тега
    даёт `can't parse entities` и сообщение снова не уходит.
    """
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    rest = text
    while len(rest) > limit:
        chunk = rest[:limit]
        # Ищем, где разорвать: сначала пустая строка, потом перенос, потом пробел.
        cut = max(chunk.rfind("\n\n"), chunk.rfind("\n"), chunk.rfind(" "))
        if cut < limit // 2:      # разумной границы нет — режем по лимиту
            cut = limit
        parts.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        parts.append(rest)
    return parts


async def _send_message(token: str, chat_id, text: str, reply_markup: Optional[dict] = None) -> Optional[int]:
    """Возвращает message_id или None при ошибке.

    ⚠️ Длинный текст уходит НЕСКОЛЬКИМИ сообщениями, кнопка — с последним:
    иначе человек остаётся без кнопки «ГОТОВО» и воронка обрывается.
    """
    chunks = split_long_message(text)
    last_id: Optional[int] = None
    for i, chunk in enumerate(chunks):
        is_last = i == len(chunks) - 1
        payload = {
            "chat_id": chat_id,
            "text": chunk,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        if reply_markup is not None and is_last:
            payload["reply_markup"] = reply_markup
        try:
            async with httpx.AsyncClient(timeout=15) as http:
                r = await http.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    json=payload
                )
                data = r.json()
                if data.get("ok"):
                    last_id = data["result"].get("message_id")
                    continue
                log.warning("sendMessage failed: %s", data)
                return None
        except Exception as e:
            log.warning("sendMessage error: %s", e)
            return None
    return last_id


# Лимит Telegram на caption под фото/видео = 1024 символа. На обычное
# сообщение = 4096. Если итоговый текст влезает в caption — шлём одним
# сообщением (sendPhoto/sendVideo с подписью и inline-кнопкой). Если нет —
# сначала медиа отдельно (без caption), потом текст с кнопкой.
TG_CAPTION_LIMIT = 1024


def _extract_file_id(result: dict, media_type: str) -> Optional[str]:
    """Из ответа sendPhoto/sendVideo извлекаем file_id для кеша."""
    if media_type == "video":
        return (result.get("video") or {}).get("file_id")
    photos = result.get("photo") or []
    return photos[-1]["file_id"] if photos else None


async def _send_media(token: str, chat_id, media_payload: str, media_type: str,
                      caption: Optional[str] = None,
                      reply_markup: Optional[dict] = None) -> tuple[Optional[int], Optional[str]]:
    """sendPhoto или sendVideo. media_payload — file_id (кеш TG) или https-URL.
    Возвращает (message_id, file_id_из_ответа) или (None, None) при ошибке."""
    method = "sendVideo" if media_type == "video" else "sendPhoto"
    field = "video" if media_type == "video" else "photo"
    payload = {"chat_id": chat_id, field: media_payload}
    if caption:
        payload["caption"] = caption
        payload["parse_mode"] = "HTML"
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    try:
        async with httpx.AsyncClient(timeout=120) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/{method}",
                json=payload
            )
            data = r.json()
            if data.get("ok"):
                result = data["result"]
                return result.get("message_id"), _extract_file_id(result, media_type)
            log.warning("%s failed: %s", method, data)

            # ⚠️⚠️ TELEGRAM НЕ СМОГ СКАЧАТЬ ФАЙЛ ПО ССЫЛКЕ — ШЛЁМ ЕГО САМИ.
            #
            # Хранилище может не пускать чужие серверы: наш сервер файл видит,
            # а Telegram получает отказ и отвечает «failed to get HTTP URL
            # content». Для человека это выглядит так, будто воронка молчит —
            # ни картинки, ни текста, ни кнопки.
            #
            # Так легло ВСЁ после переезда хранилища: старые файлы уходили по
            # памяти Telegram (file_id), а любой новый — уже нет.
            #
            # Скачиваем сами и отдаём файлом. Работает независимо от того,
            # пускает ли хранилище посторонних.
            desc = (data.get("description") or "").lower()
            if "failed to get http url content" in desc and str(media_payload).startswith("http"):
                try:
                    async with httpx.AsyncClient(timeout=180, follow_redirects=True) as dl:
                        fr = await dl.get(media_payload)
                    fr.raise_for_status()
                    fname = (media_payload.rsplit("/", 1)[-1].split("?")[0]
                             or ("video.mp4" if media_type == "video" else "photo.jpg"))
                    form = {k: str(v) for k, v in payload.items()
                            if k not in (field, "reply_markup")}
                    if reply_markup is not None:
                        form["reply_markup"] = json.dumps(reply_markup, ensure_ascii=False)

                    # ⚠️⚠️ У ВИДЕО ОБЯЗАТЕЛЬНО ПЕРЕДАТЬ РАЗМЕРЫ И ОБЛОЖКУ.
                    # Раньше Telegram скачивал файл сам и размеры видел сам.
                    # Теперь файл отправляем мы — и без width/height он рисует
                    # видео КВАДРАТОМ, ломая пропорции, а без обложки показывает
                    # серый прямоугольник.
                    if media_type == "video":
                        try:
                            from app.services.video_meta import probe_dimensions, extract_thumbnail
                            dims = await probe_dimensions(fr.content)
                            if dims:
                                w, h, dur = dims
                                form["width"], form["height"] = str(w), str(h)
                                if dur:
                                    form["duration"] = str(dur)
                            form["supports_streaming"] = "true"
                            thumb = await extract_thumbnail(fr.content)
                        except Exception as e:
                            log.warning("видео: не смогли снять размеры/обложку: %s", e)
                            thumb = None
                    async with httpx.AsyncClient(timeout=300) as http2:
                        files = {field: (fname, fr.content,
                                         fr.headers.get("content-type") or "application/octet-stream")}
                        if media_type == "video" and locals().get("thumb"):
                            files["thumbnail"] = ("thumb.jpg", thumb, "image/jpeg")
                            form["thumbnail"] = "attach://thumbnail"
                        r2 = await http2.post(
                            f"https://api.telegram.org/bot{token}/{method}",
                            data=form, files=files,
                        )
                        d2 = r2.json()
                    if d2.get("ok"):
                        res2 = d2["result"]
                        log.info("%s: отправили файлом (ссылку Telegram не осилил)", method)
                        return res2.get("message_id"), _extract_file_id(res2, media_type)
                    log.warning("%s файлом тоже не прошёл: %s", method, d2)
                except Exception as e:
                    log.warning("%s: не смогли скачать и отправить файлом: %s", method, e)
    except Exception as e:
        log.warning("%s error: %s", method, e)
    return None, None


async def _send_text_with_media(token: str, chat_id, text: str,
                                media_url: Optional[str],
                                media_type: Optional[str],
                                file_id: Optional[str] = None,
                                reply_markup: Optional[dict] = None
                                ) -> tuple[Optional[int], Optional[str]]:
    """Универсальная отправка текста с опциональным медиа.

    Возвращает (message_id, fresh_file_id). fresh_file_id — то что TG прислал
    в ответе при отправке URL'а первый раз; нужно сохранить в БД, чтобы
    следующие отправки шли через file_id моментально (без скачивания с R2).

    Если file_id передан — сначала пробуем его (мгновенно). При ошибке (например
    file_id протух при смене бота) — повторяем с URL и обновляем кеш.

    Логика caption:
      - нет медиа → sendMessage.
      - есть медиа и len(text) ≤ 1024 → одно sendPhoto/sendVideo с caption + кнопкой.
      - есть медиа и len(text) > 1024 → sendPhoto/sendVideo без caption + sendMessage с кнопкой.
    """
    if not media_url or media_type not in ("photo", "video"):
        return await _send_message(token, chat_id, text, reply_markup), None

    primary  = file_id or media_url
    fallback = media_url if file_id else None

    if len(text) <= TG_CAPTION_LIMIT:
        msg_id, new_fid = await _send_media(token, chat_id, primary, media_type, caption=text, reply_markup=reply_markup)
        if msg_id is None and fallback:
            # file_id протух — fallback на URL
            msg_id, new_fid = await _send_media(token, chat_id, fallback, media_type, caption=text, reply_markup=reply_markup)
        return msg_id, new_fid

    # Текст не влезает в caption — медиа отдельно, потом текст с кнопкой.
    _, new_fid = await _send_media(token, chat_id, primary, media_type, caption=None, reply_markup=None)
    if new_fid is None and fallback:
        _, new_fid = await _send_media(token, chat_id, fallback, media_type, caption=None, reply_markup=None)
    msg_id = await _send_message(token, chat_id, text, reply_markup)
    return msg_id, new_fid


async def _maybe_cache_file_id(template: dict, slot: str, new_fid: Optional[str], db) -> None:
    """Если шаблон ещё не имел file_id и TG только что отдал свежий — сохраняем.
    slot = 'text_1' | 'text_2'."""
    if not new_fid:
        return
    field = f"{slot}_media_file_id"
    if template.get(field):
        return  # уже закеширован
    template_id = template.get("id")
    if not template_id:
        return
    try:
        await db.execute(
            f"UPDATE funnel_templates SET {field} = $1 WHERE id = $2",
            new_fid, template_id
        )
    except Exception as e:
        log.warning("cache file_id failed: %s", e)


async def _check_subscription(token: str, channel: str, user_id: str) -> bool:
    """Проверяет подписку user_id на channel (например '@brand_channel') через getChatMember.
    Возвращает True если статус member/administrator/creator."""
    if not channel:
        return True  # канал не настроен — пропускаем
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChatMember",
                params={"chat_id": channel, "user_id": user_id}
            )
            data = r.json()
            if data.get("ok"):
                status = data["result"].get("status", "")
                return status in ("member", "administrator", "creator")
            log.info("getChatMember not ok: %s", data)
    except Exception as e:
        log.warning("getChatMember error: %s", e)
    return False


async def _check_subscription_detailed(token: str, channel: str, user_id: str) -> dict:
    """Расширенная версия `_check_subscription`: возвращает причину невозможности проверки.

    Returns:
        {"ok": True}                                         — подписан
        {"ok": False, "reason": "not_subscribed"}            — не подписан (left/kicked)
        {"ok": False, "reason": "bot_not_in_channel"}        — бот сам не в канале/нет прав на getChatMember
        {"ok": False, "reason": "chat_not_found"}            — канал не найден / некорректный chat_id
        {"ok": False, "reason": "network_error"}             — сетевая ошибка / таймаут (fail-open в вызывающем коде)
    """
    if not channel:
        return {"ok": True}
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChatMember",
                params={"chat_id": channel, "user_id": user_id}
            )
            data = r.json()
    except Exception as e:
        log.warning("getChatMember network error for %s: %s", channel, e)
        return {"ok": False, "reason": "network_error"}
    if data.get("ok"):
        status = data["result"].get("status", "")
        if status in ("member", "administrator", "creator"):
            return {"ok": True}
        # left, kicked, restricted — не подписан
        return {"ok": False, "reason": "not_subscribed"}
    desc = (data.get("description") or "").lower()
    # Bot API типичные ошибки:
    #   "chat not found" — канал недоступен боту вообще
    #   "member list is inaccessible" — бот не админ (для приватных каналов)
    #   "bot is not a member of the chat" — бот не подписан
    if "chat not found" in desc:
        return {"ok": False, "reason": "chat_not_found"}
    if "member" in desc and ("inaccessible" in desc or "not a member" in desc):
        return {"ok": False, "reason": "bot_not_in_channel"}
    log.info("getChatMember not ok for %s: %s", channel, data)
    # Любая другая ошибка — считаем что бот не в канале (fail-open для юзера)
    return {"ok": False, "reason": "bot_not_in_channel"}


async def check_telegram_channels_subscription(
    client_id: int, tg_id: str, db
) -> dict:
    """Проверяет подписку tg_id на ВСЕ TG-каналы основателя клиента.

    Returns:
        {
          "ok": bool,                  — True только если подписан на все, или нет каналов
          "missing": list[dict],       — каналы, на которые юзер НЕ подписан
          "bot_not_in": list[dict],    — каналы, в которых бот сам не админ (для авто-отключения гейта)
          "no_token": bool,            — у клиента нет бота для проверки
          "no_channels": bool,         — у клиента нет TG-каналов основателя
        }

    Возвращаемая «ok=True» при пустом списке каналов или при отсутствии токена —
    это сознательный fail-open, чтобы воронка лид-магнита не блокировалась если
    клиент ещё не настроил каналы.
    """
    import asyncio
    ctx = await _get_brand_context(client_id, db, platform="telegram")
    channels: list[dict] = ctx.get("tg_channels") or []
    if not channels:
        return {"ok": True, "missing": [], "bot_not_in": [], "no_token": False, "no_channels": True}
    token = await _bot_token_for_client(client_id, db)
    if not token:
        return {"ok": True, "missing": [], "bot_not_in": [], "no_token": True, "no_channels": False}

    async def _check_one(ch: dict) -> dict:
        # Приоритет: числовой chat_id (надёжнее, работает и для закрытых каналов
        # если бот добавлен админом) → @username (только открытый канал) →
        # пропускаем (fail-open: закрытый канал без chat_id — Bot API не умеет
        # проверить через инвайт-код, доверяем юзеру).
        chat_id = (ch.get("chat_id") or "").strip()
        target = chat_id or telegram_api_id(ch.get("url") or "")
        if not target:
            return {"channel": ch, "result": {"ok": True}}
        result = await _check_subscription_detailed(token, target, str(tg_id))
        return {"channel": ch, "result": result}

    results = await asyncio.gather(*[_check_one(ch) for ch in channels])
    missing: list[dict] = []
    bot_not_in: list[dict] = []
    for item in results:
        res = item["result"]
        ch = item["channel"]
        if res.get("ok"):
            continue
        reason = res.get("reason")
        if reason in ("bot_not_in_channel", "chat_not_found"):
            bot_not_in.append(ch)
            # бот не админ — пользователю показывать канал нет смысла (ложно-отрицательно),
            # но для воронки считаем «не прошёл» чтобы клиент починил
            missing.append(ch)
        elif reason == "network_error":
            # сетевая ошибка — fail-open для конкретного канала (не блокируем юзера)
            continue
        else:
            missing.append(ch)
    return {
        "ok": len(missing) == 0,
        "missing": missing,
        "bot_not_in": bot_not_in,
        "no_token": False,
        "no_channels": False,
    }


async def check_vk_channels_subscription(client_id: int, vk_id: str, db) -> dict:
    """Проверяет подписку vk_id на ВСЕ VK-сообщества основателя клиента.

    Источник — `clients.social_links.vk_channels` (массив с group_id), fallback
    на legacy одиночный `vk_group_id`. Возвращает {ok, missing[], no_channels}.
    fail-open: нет сообществ / не резолвится group_id → ok=True.
    """
    import asyncio
    from app.services.vk_api import is_user_member_of_group
    from app.services.social_links import get_founder_vk_channels

    social = await db.fetchval("SELECT social_links FROM clients WHERE id = $1", client_id)
    if isinstance(social, str):
        try:
            social = json.loads(social)
        except Exception:
            social = {}
    channels = get_founder_vk_channels(social or {})
    channels = [c for c in channels if (c.get("group_id") or "").isdigit()]
    if not channels:
        return {"ok": True, "missing": [], "no_channels": True}

    vk_token = await get_client_vk_token(client_id, db) if "get_client_vk_token" in globals() else None
    if not vk_token:
        from app.services.channels import get_client_vk_token as _gvt
        vk_token = await _gvt(client_id, db)

    async def _one(ch: dict) -> dict:
        gid = int(ch["group_id"])
        member = await is_user_member_of_group(gid, int(vk_id), token=vk_token)
        # member: True/False/None(не удалось) → None = fail-open (не блокируем)
        return {"channel": ch, "member": member}

    results = await asyncio.gather(*[_one(c) for c in channels])
    missing = [r["channel"] for r in results if r["member"] is False]
    return {"ok": len(missing) == 0, "missing": missing, "no_channels": False}


async def _send_organizer_notification(client_id: int, run_id: int, db) -> None:
    """Шлёт уведомление организатору о новом интересе во ВСЕ его каналы (TG+MAX+VK)."""
    _ch = await db.fetchrow(
        """SELECT notifications_telegram_chat_id, notifications_max_chat_id,
                  notifications_vk_peer_id FROM clients WHERE id = $1""",
        client_id,
    )
    if not _ch or not (
        _ch["notifications_telegram_chat_id"]
        or _ch["notifications_max_chat_id"]
        or _ch["notifications_vk_peer_id"]
    ):
        return

    run = await db.fetchrow(
        """SELECT fr.id, fr.platform_slug, fr.platform_user_id, fr.utm,
                  fr.lead_magnet_id, fr.package_id, fr.contact_id, fr.referrer_contact_id,
                  fr.landed_at,
                  COALESCE(lm.name, pkg.name) AS source_name,
                  c.name AS contact_name,
                  pu.username AS contact_username,
                  rc.name AS referrer_name,
                  rpu.username AS referrer_username
             FROM funnel_runs fr
        LEFT JOIN lead_magnets lm        ON lm.id = fr.lead_magnet_id
        LEFT JOIN lead_magnet_packages pkg ON pkg.id = fr.package_id
        LEFT JOIN contacts c             ON c.id = fr.contact_id
        LEFT JOIN platform_users pu      ON pu.contact_id = fr.contact_id AND pu.platform_slug = fr.platform_slug
        LEFT JOIN contacts rc            ON rc.id = fr.referrer_contact_id
        LEFT JOIN platform_users rpu     ON rpu.contact_id = fr.referrer_contact_id AND rpu.platform_slug = fr.platform_slug
            WHERE fr.id = $1""",
        run_id
    )
    if not run:
        return

    utm = run["utm"] or {}
    if isinstance(utm, str):
        try:
            utm = json.loads(utm)
        except Exception:
            utm = {}

    when = run["landed_at"]
    when_str = when.strftime("%d.%m.%Y %H:%M") if when else ""

    # Активный бот клиента — лид-магниты слушает именно он.
    bot_handle = None
    if run["platform_user_id"] and (run["platform_slug"] or "telegram") == "telegram":
        from app.services.channels import get_bot_handle_for_user
        bot_handle = await get_bot_handle_for_user(client_id, str(run["platform_user_id"]), db)

    from .profile_links import nick_html, link_html
    _plat = run['platform_slug'] or 'telegram'
    came_nick = nick_html(_plat, user_id=run['platform_user_id'], username=run['contact_username'])
    came_link = link_html(_plat, user_id=run['platform_user_id'], username=run['contact_username'])
    parts = [
        "🆕 <b>Новый интерес</b>",
        "",
        f"<b>Лид-магнит:</b> {run['source_name'] or '—'}",
        f"<b>Бот:</b> {bot_handle or '—'}",
        f"<b>Когда:</b> {when_str or '—'}",
        "",
        "<b>Кто пришёл</b>",
        f"<b>Никнейм:</b> {came_nick}",
        f"<b>Имя:</b> {run['contact_name'] or '—'}",
        f"<b>ID контакта:</b> {('#' + str(run['contact_id'])) if run['contact_id'] else '—'}",
        f"<b>Платформа:</b> {(run['platform_slug'] or '—').title()}",
        f"<b>ID в платформе:</b> {run['platform_user_id'] or '—'}",
    ]
    if came_link:
        parts.append(f"<b>Ссылка:</b> {came_link}")
    # ⚠️⚠️ У пришедшего из MAX — кликабельное УПОМИНАНИЕ ИМЕНЕМ (то же, что в
    # `#user_message`). Строка «Ссылка: max://user/…» остаётся для Telegram и
    # VK, где схема max:// не кликается, а внутри MAX диалог открывается одним
    # касанием по имени. Без этого уведомление о пришедшем из MAX показывало
    # только сырую схему — написать человеку было нечем.
    if _plat == "max":
        from .profile_links import max_mention_html
        _m = max_mention_html(run["platform_user_id"], run["contact_name"])
        if _m:
            parts.append(f"<b>Профиль в MAX:</b> {_m}")

    src = utm.get("utm_source") if isinstance(utm, dict) else None
    parts.append(f"<b>Источник (utm_source):</b> {src or '—'}")
    if isinstance(utm, dict):
        for k, v in utm.items():
            if k == "utm_source":
                continue
            parts.append(f"<b>{k}:</b> {v}")

    if run["contact_id"]:
        parts.append(f"<b>Карточка:</b> {settings.frontend_url}/dashboard/clients?contact={run['contact_id']}")

    parts.append("")
    if run["referrer_contact_id"]:
        ref_nick = nick_html(_plat, username=run['referrer_username'])
        ref_link = link_html(_plat, username=run['referrer_username'])
        parts.append("<b>Кто привёл</b>")
        parts.append(f"<b>Никнейм:</b> {ref_nick}")
        parts.append(f"<b>Имя:</b> {run['referrer_name'] or '—'}")
        parts.append(f"<b>ID контакта:</b> #{run['referrer_contact_id']}")
        if ref_link:
            parts.append(f"<b>Ссылка:</b> {ref_link}")
        parts.append(f"<b>Карточка:</b> {settings.frontend_url}/dashboard/clients?contact={run['referrer_contact_id']}")
    else:
        parts.append("<b>Кто привёл:</b> —")

    text = "\n".join(parts)
    # Бот: свой (VIP) бот клиента, если есть; иначе системный @pluson_bot (автофолбэк).
    from .channels import notify_organizer_all_channels
    await notify_organizer_all_channels(client_id, text, db)


async def _bind_partner_for_run(db, client_id: int, contact_id: int,
                                referrer_contact_id) -> None:
    """Партнёрское закрепление по забегу воронки (миграции 346-348).

    ⚠️ `funnel_runs.referrer_contact_id` — это «КТО ПРИВЁЛ» (любой человек,
    в том числе не партнёр). Закрепление возникает, только если приведший —
    ЗАРЕГИСТРИРОВАННЫЙ партнёр и место свободно; иначе не делаем ничего.

    ⚠️ Закрепление ведётся в ОБОИХ режимах выплат: иначе при переключении
    кабинета на пассивный у всех окажется пусто, и он включится «с нуля».

    Fail-open: партнёрка — надстройка, её сбой не должен ломать выдачу подарка.
    """
    if not contact_id or not referrer_contact_id:
        return
    try:
        ref_code = await db.fetchval(
            "SELECT ref_code FROM contacts WHERE id = $1", referrer_contact_id)
        if not ref_code:
            return
        from app.services.partner_binding import try_bind_by_ref_code
        await try_bind_by_ref_code(
            db, client_id=client_id, contact_id=contact_id, ref_code=ref_code)
    except Exception as e:  # noqa: BLE001
        log.warning("Партнёрка: закрепление по воронке не удалось: %s", e)


async def run_started(run_id: int, tg_id: str, username: Optional[str],
                      first_name: Optional[str], last_name: Optional[str],
                      db, bot_id: Optional[int] = None) -> None:
    """Бот получил /start fnl_<run_id>. Идемпотентно:
    - привязывает забег к platform_user (создаёт contact если нужно),
    - регистрирует подписку на канал воронки в контексте клиента воронки,
    - проставляет stage=started,
    - шлёт уведомление организатору (один раз),
    - отправляет Текст 1 + кнопку «ГОТОВО»."""
    run = await db.fetchrow(
        """SELECT id, client_id, type, lead_magnet_id, package_id, stage,
                  contact_id, platform_slug, platform_user_id, started_at,
                  utm, referrer_contact_id
             FROM funnel_runs WHERE id = $1""",
        run_id
    )
    if not run:
        log.info("run_started: run %s not found", run_id)
        return

    client_id = run["client_id"]

    # ЧЁРНЫЙ СПИСОК (миграция 228) — воронка не запускается, материалы не выдаются.
    try:
        from app.services.blacklist import is_identity_blacklisted
        if await is_identity_blacklisted(db, client_id, "telegram", str(tg_id)):
            log.info("run_started: contact blacklisted (client %s, tg %s)", client_id, tg_id)
            return
    except Exception as e:  # noqa: BLE001 — fail-open
        log.warning("run_started blacklist check failed: %s", e)
    skeleton_contact_id = run["contact_id"]  # legacy: создан на landing у старых забегов; для новых = NULL

    # Если у человека уже был забег по этому же магниту/пакету (он повторно кликнул
    # ссылку) — переключаемся на существующий забег вместо создания дубликата.
    # Уникальный индекс funnel_runs_unique_per_lm/per_pkg иначе словил бы коллизию.
    existing_run = await db.fetchrow(
        """SELECT id, stage, contact_id
             FROM funnel_runs
            WHERE client_id = $1
              AND platform_slug = 'telegram'
              AND platform_user_id = $2
              AND COALESCE(lead_magnet_id, 0) = COALESCE($3, 0)
              AND COALESCE(package_id, 0)     = COALESCE($4, 0)
              AND id <> $5
            ORDER BY id ASC LIMIT 1""",
        client_id, str(tg_id),
        run["lead_magnet_id"], run["package_id"], run_id
    )
    if existing_run:
        # Подбираем уже известный забег. Удаляем новый skeleton, чтобы не плодить дубли,
        # и осиротевший skeleton-контакт (если ничем не занят).
        if skeleton_contact_id:
            used_elsewhere = await db.fetchval(
                """SELECT EXISTS (
                       SELECT 1 FROM funnel_runs WHERE contact_id = $1 AND id <> $2
                       UNION ALL SELECT 1 FROM event_participants WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM platform_users  WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM collaborators    WHERE contact_id = $1
                   )""",
                skeleton_contact_id, run_id
            )
            await db.execute("DELETE FROM funnel_runs WHERE id = $1", run_id)
            if not used_elsewhere:
                await db.execute("DELETE FROM contacts WHERE id = $1", skeleton_contact_id)
        else:
            await db.execute("DELETE FROM funnel_runs WHERE id = $1", run_id)
        # Перезаписываем run на существующий — все дальнейшие апдейты идут в него
        run_id = existing_run["id"]
        run = await db.fetchrow(
            """SELECT id, client_id, type, lead_magnet_id, package_id, stage,
                      contact_id, platform_slug, platform_user_id, started_at,
                      utm, referrer_contact_id
                 FROM funnel_runs WHERE id = $1""",
            run_id
        )
        skeleton_contact_id = None  # уже не skeleton, а реальный контакт

    # Привязка к контакту через platform_users (telegram per-client)
    pu = await db.fetchrow(
        """SELECT pu.id, pu.contact_id
             FROM platform_users pu
             JOIN contacts c_own ON c_own.id = pu.contact_id
            WHERE c_own.client_id = $1 AND pu.platform_slug = 'telegram' AND pu.platform_user_id = $2""",
        client_id, str(tg_id)
    )
    contact_id: Optional[int] = None
    if pu:
        # У человека уже есть запись в этом клиенте — используем её,
        # скелет от landing становится orphan (если ничем больше не занят — удаляем)
        contact_id = pu["contact_id"]
        await db.execute(
            """UPDATE platform_users
                  SET username = COALESCE(NULLIF($1,''), username),
                      first_name = COALESCE(NULLIF($2,''), first_name),
                      last_name = COALESCE(NULLIF($3,''), last_name)
                WHERE id = $4""",
            username or "", first_name or "", last_name or "", pu["id"]
        )
        if skeleton_contact_id and skeleton_contact_id != contact_id:
            used_elsewhere = await db.fetchval(
                """SELECT EXISTS (
                       SELECT 1 FROM funnel_runs WHERE contact_id = $1 AND id <> $2
                       UNION ALL SELECT 1 FROM event_participants WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM platform_users  WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM collaborators    WHERE contact_id = $1
                   )""",
                skeleton_contact_id, run_id
            )
            if not used_elsewhere:
                await db.execute("DELETE FROM contacts WHERE id = $1", skeleton_contact_id)
    else:
        # Берём skeleton contact, если он есть (легаси: до отказа от скелетов в _landing).
        # Иначе создаём контакт сейчас, копируя UTM/реферера прямо из funnel_runs.
        if skeleton_contact_id:
            contact_id = skeleton_contact_id
            full_name = ((first_name or "") + " " + (last_name or "")).strip() or (username or "")
            await db.execute(
                """UPDATE contacts
                      SET name = COALESCE(name, NULLIF($1, '')),
                          last_contact_at = NOW()
                    WHERE id = $2""",
                full_name, contact_id
            )
        else:
            from app.services.contact_merge import _generate_unique_ref_code
            ref_code = await _generate_unique_ref_code(db)
            # Извлекаем utm_source из JSONB-блока utm на забеге
            run_utm = run["utm"]
            if isinstance(run_utm, str):
                try:
                    run_utm = json.loads(run_utm)
                except Exception:
                    run_utm = {}
            utm_source = (run_utm or {}).get("utm_source")
            contact_id = await db.fetchval(
                """INSERT INTO contacts
                      (client_id, name, ref_code, utm_source,
                       first_referrer_contact_id, last_contact_at)
                   VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id""",
                client_id,
                ((first_name or "") + " " + (last_name or "")).strip() or (username or ""),
                ref_code,
                utm_source,
                run["referrer_contact_id"],
            )
        await db.execute(
            """INSERT INTO platform_users
                  (contact_id, platform_slug, platform_user_id,
                   username, first_name, last_name)
               VALUES ($1, 'telegram', $2, $3, $4, $5)
               ON CONFLICT (contact_id, platform_slug) DO NOTHING""",
            contact_id, str(tg_id),
            username, first_name, last_name
        )

    # Регистрируем подписку в контексте клиента воронки на тот бот, через который
    # пришёл /start. Без этого подписчик не появится у клиента — он будет только
    # у системного клиента (через _record_subscription в bot/handlers/start.py).
    if bot_id:
        try:
            from app.services.channels import find_channel_by_bot_id, register_telegram_subscription
            ch = await find_channel_by_bot_id(int(bot_id), db)
            if ch:
                await register_telegram_subscription(
                    client_id, ch["id"], str(tg_id),
                    username=username or "",
                    first_name=first_name or "",
                    last_name=last_name or "",
                    db=db,
                )
        except Exception as e:
            log.warning("run_started: register subscription failed: %s", e)

    is_new_started = run["stage"] == "landed"
    await db.execute(
        """UPDATE funnel_runs
              SET contact_id = COALESCE(contact_id, $1),
                  platform_slug = 'telegram',
                  platform_user_id = $2,
                  stage = CASE WHEN stage = 'landed' THEN 'started' ELSE stage END,
                  started_at = COALESCE(started_at, NOW())
            WHERE id = $3""",
        contact_id, str(tg_id), run_id
    )

    await _bind_partner_for_run(db, client_id, contact_id, run["referrer_contact_id"])

    # Уведомление организатору — только при первом переходе landed → started
    if is_new_started:
        await _send_organizer_notification(client_id, run_id, db)

    # Шлём Текст 1 с кнопкой
    template = await _get_template(client_id, db)
    if not template:
        # автосоздание дефолтным
        from app.api.funnels import _get_or_create_template
        template = await _get_or_create_template(client_id, "lead_magnet", db)
        template = dict(template)

    ctx = await _get_brand_context(client_id, db)
    materials = await _materials_for_run(dict(run), db)
    pkg_desc = await _package_description_for_run(dict(run), db)
    text_1 = _format_text(template["text_1"], ctx, materials, pkg_desc)

    button_label = template["button_label"] or "ГОТОВО"
    reply_markup = {
        "inline_keyboard": [[{
            "text": button_label,
            "callback_data": f"fnl_check_{run_id}"
        }]]
    }
    token = await _bot_token_for_client(client_id, db)
    if not token:
        log.warning("run_started: no bot token for client %s", client_id)
        return
    msg_id, fresh_fid = await _send_text_with_media(
        token, tg_id, text_1,
        template.get("text_1_media_url"),
        template.get("text_1_media_type"),
        file_id=template.get("text_1_media_file_id"),
        reply_markup=reply_markup,
    )
    await _maybe_cache_file_id(template, "text_1", fresh_fid, db)
    if msg_id:
        await db.execute(
            "UPDATE funnel_runs SET last_message_id = $1 WHERE id = $2",
            msg_id, run_id
        )


async def run_started_vk(run_id: int, vk_id: str, username: Optional[str],
                         first_name: Optional[str], last_name: Optional[str],
                         db, channel_id: int, token: str) -> None:
    """VK-аналог run_started. Вызывается из vk_main.handle_message_new при получении
    ref=fnl_<run_id> от пользователя в чате с сообществом.

    Идемпотентно:
    - привязывает забег к platform_user (vk) — создаёт contact если нужно,
    - регистрирует подписку на client_channel сообщества,
    - ставит stage=started, platform_slug='vk',
    - шлёт уведомление организатору (один раз),
    - отправляет Текст 1 + callback-кнопку «ГОТОВО» через VK API."""
    run = await db.fetchrow(
        """SELECT id, client_id, type, lead_magnet_id, package_id, stage,
                  contact_id, platform_slug, platform_user_id, started_at,
                  utm, referrer_contact_id
             FROM funnel_runs WHERE id = $1""",
        run_id
    )
    if not run:
        log.info("run_started_vk: run %s not found", run_id)
        return

    client_id = run["client_id"]
    skeleton_contact_id = run["contact_id"]

    # ЧЁРНЫЙ СПИСОК (миграция 228) — воронка не запускается.
    try:
        from app.services.blacklist import is_identity_blacklisted
        if await is_identity_blacklisted(db, client_id, "vk", str(vk_id)):
            log.info("run_started_vk: contact blacklisted (client %s, vk %s)", client_id, vk_id)
            return
    except Exception as e:  # noqa: BLE001 — fail-open
        log.warning("run_started_vk blacklist check failed: %s", e)

    # Дедуп забегов на той же платформе.
    existing_run = await db.fetchrow(
        """SELECT id, stage, contact_id
             FROM funnel_runs
            WHERE client_id = $1
              AND platform_slug = 'vk'
              AND platform_user_id = $2
              AND COALESCE(lead_magnet_id, 0) = COALESCE($3, 0)
              AND COALESCE(package_id, 0)     = COALESCE($4, 0)
              AND id <> $5
            ORDER BY id ASC LIMIT 1""",
        client_id, str(vk_id),
        run["lead_magnet_id"], run["package_id"], run_id
    )
    if existing_run:
        if skeleton_contact_id:
            used_elsewhere = await db.fetchval(
                """SELECT EXISTS (
                       SELECT 1 FROM funnel_runs WHERE contact_id = $1 AND id <> $2
                       UNION ALL SELECT 1 FROM event_participants WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM platform_users  WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM collaborators    WHERE contact_id = $1
                   )""",
                skeleton_contact_id, run_id
            )
            await db.execute("DELETE FROM funnel_runs WHERE id = $1", run_id)
            if not used_elsewhere:
                await db.execute("DELETE FROM contacts WHERE id = $1", skeleton_contact_id)
        else:
            await db.execute("DELETE FROM funnel_runs WHERE id = $1", run_id)
        run_id = existing_run["id"]
        run = await db.fetchrow(
            """SELECT id, client_id, type, lead_magnet_id, package_id, stage,
                      contact_id, platform_slug, platform_user_id, started_at,
                      utm, referrer_contact_id
                 FROM funnel_runs WHERE id = $1""",
            run_id
        )
        skeleton_contact_id = None

    # platform_users — VK identity клиента
    pu = await db.fetchrow(
        """SELECT pu.id, pu.contact_id
             FROM platform_users pu
             JOIN contacts c_own ON c_own.id = pu.contact_id
            WHERE c_own.client_id = $1 AND pu.platform_slug = 'vk' AND pu.platform_user_id = $2""",
        client_id, str(vk_id)
    )
    contact_id: Optional[int] = None
    if pu:
        contact_id = pu["contact_id"]
        await db.execute(
            """UPDATE platform_users
                  SET username = COALESCE(NULLIF($1,''), username),
                      first_name = COALESCE(NULLIF($2,''), first_name),
                      last_name = COALESCE(NULLIF($3,''), last_name)
                WHERE id = $4""",
            username or "", first_name or "", last_name or "", pu["id"]
        )
        if skeleton_contact_id and skeleton_contact_id != contact_id:
            used_elsewhere = await db.fetchval(
                """SELECT EXISTS (
                       SELECT 1 FROM funnel_runs WHERE contact_id = $1 AND id <> $2
                       UNION ALL SELECT 1 FROM event_participants WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM platform_users  WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM collaborators    WHERE contact_id = $1
                   )""",
                skeleton_contact_id, run_id
            )
            if not used_elsewhere:
                await db.execute("DELETE FROM contacts WHERE id = $1", skeleton_contact_id)
    else:
        if skeleton_contact_id:
            contact_id = skeleton_contact_id
            full_name = ((first_name or "") + " " + (last_name or "")).strip() or (username or "")
            await db.execute(
                """UPDATE contacts
                      SET name = COALESCE(name, NULLIF($1, '')),
                          last_contact_at = NOW()
                    WHERE id = $2""",
                full_name, contact_id
            )
        else:
            from app.services.contact_merge import _generate_unique_ref_code
            ref_code = await _generate_unique_ref_code(db)
            run_utm = run["utm"]
            if isinstance(run_utm, str):
                try:
                    run_utm = json.loads(run_utm)
                except Exception:
                    run_utm = {}
            utm_source = (run_utm or {}).get("utm_source")
            contact_id = await db.fetchval(
                """INSERT INTO contacts
                      (client_id, name, ref_code, utm_source,
                       first_referrer_contact_id, last_contact_at)
                   VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id""",
                client_id,
                ((first_name or "") + " " + (last_name or "")).strip() or (username or ""),
                ref_code,
                utm_source,
                run["referrer_contact_id"],
            )
        await db.execute(
            """INSERT INTO platform_users
                  (contact_id, platform_slug, platform_user_id,
                   username, first_name, last_name)
               VALUES ($1, 'vk', $2, $3, $4, $5)
               ON CONFLICT (contact_id, platform_slug) DO NOTHING""",
            contact_id, str(vk_id),
            username, first_name, last_name
        )

    # Регистрируем подписку на канал сообщества в контексте этого клиента
    try:
        cc_id = await db.fetchval(
            """SELECT cc.id FROM client_channels cc
                WHERE cc.client_id = $1 AND cc.channel_id = $2 LIMIT 1""",
            client_id, channel_id,
        )
        pu_id = await db.fetchval(
            """SELECT pu.id FROM platform_users pu
                JOIN contacts c_own ON c_own.id = pu.contact_id
                WHERE c_own.client_id = $1 AND pu.platform_slug = 'vk' AND pu.platform_user_id = $2""",
            client_id, str(vk_id),
        )
        # ⚠️⚠️ ФЛАГ «РАЗРЕШИЛ ПИСАТЬ» ЗДЕСЬ НЕ СТАВИМ ВООБЩЕ (05.09.2026).
        #
        # Заход по ссылке воронки — это не разрешение: человек просто открыл
        # ссылку. Раньше здесь стояло глухое `is_unsubscribed=FALSE`, и он
        # попадал в базу рассылки, ничего нам не разрешив; потом это заменили
        # на опрос ВКонтакте — но и опрос тут лишний.
        #
        # Флаг ставит РОВНО ОДНО событие — `message_allow` (снимает
        # `message_deny`), как `my_chat_member` в Telegram. А узнать текущее
        # состояние можно в любой момент у самого ВКонтакте
        # (`is_messages_allowed` в services/vk_api.py) — хранить его копию
        # заранее незачем.
        #
        # ⚠️ Не возвращать сюда запись флага: база рассылки снова разойдётся
        # с реальностью, и сообщения пойдут тем, кому ВК их не доставит.
    except Exception as e:
        log.warning("run_started_vk: register subscription failed: %s", e)

    is_new_started = run["stage"] == "landed"
    await db.execute(
        """UPDATE funnel_runs
              SET contact_id = COALESCE(contact_id, $1),
                  platform_slug = 'vk',
                  platform_user_id = $2,
                  stage = CASE WHEN stage = 'landed' THEN 'started' ELSE stage END,
                  started_at = COALESCE(started_at, NOW())
            WHERE id = $3""",
        contact_id, str(vk_id), run_id
    )

    await _bind_partner_for_run(db, client_id, contact_id, run["referrer_contact_id"])

    if is_new_started:
        await _send_organizer_notification(client_id, run_id, db)

    # Шлём Текст 1 через VK API с callback-кнопкой
    template = await _get_template(client_id, db)
    if not template:
        from app.api.funnels import _get_or_create_template
        template = await _get_or_create_template(client_id, "lead_magnet", db)
        template = dict(template)

    ctx = await _get_brand_context(client_id, db, platform="vk")
    materials = await _materials_for_run(dict(run), db)
    pkg_desc = await _package_description_for_run(dict(run), db)
    text_1 = _format_text(template["text_1"], ctx, materials, pkg_desc)

    from app.services.vk_api import send_message_with_media as vk_send_with_media, tg_inline_to_vk_keyboard
    button_label = template["button_label"] or "ГОТОВО"
    keyboard = tg_inline_to_vk_keyboard([[{
        "text": button_label,
        "callback_data": f"fnl_check_{run_id}"
    }]])
    # Видео в VK-воронке НЕ отправляется (по решению 2026-07-08) — только фото.
    vk_media_url, vk_media_type = _vk_funnel_media(
        template.get("text_1_media_url"), template.get("text_1_media_type"))
    # User-токен админа сообщества для нативной загрузки видео (video.save).
    # Без него видео упадёт в fallback на docs.save — файл вместо плеера.
    vk_user_tok, vk_user_grp = await _vk_admin_user_token_for_client(client_id, db)
    try:
        msg_id = await vk_send_with_media(
            int(vk_id), text_1,
            media_url=vk_media_url,
            media_type=vk_media_type,
            keyboard=keyboard, token=token,
            user_token=vk_user_tok, user_token_group_id=vk_user_grp,
        )
        if msg_id:
            await db.execute(
                "UPDATE funnel_runs SET last_message_id = $1 WHERE id = $2",
                msg_id, run_id
            )
    except Exception as e:
        log.warning("run_started_vk: send text_1 failed: %s", e)


async def _max_token_for_client(client_id: int, db) -> Optional[str]:
    """Токен собственного MAX-бота клиента для отправки участнику воронки.
    Нет своего MAX-бота → None (системный MAX ПЛЮСОНа не используем)."""
    from app.services.channels import get_client_max_token
    return await get_client_max_token(client_id, db)


def _vk_funnel_media(media_url: Optional[str], media_type: Optional[str]
                     ) -> Tuple[Optional[str], Optional[str]]:
    """VK-воронка: видео НЕ отправляется (решение 2026-07-08) — только фото.
    Видео → зануляем медиа (уйдёт только текст). Фото/пусто → как есть."""
    if media_type == "video":
        return None, None
    return media_url, media_type


async def _max_media_for_text(text: str, media_url: Optional[str],
                              media_type: Optional[str], token: str
                              ) -> Tuple[str, Optional[list]]:
    """Готовит медиа для MAX-сообщения воронки. Возвращает (text, attachments).
    Фото → загружаем как attachment (MAX-плеер). Видео в MAX НЕ отправляется —
    ни файлом, ни ссылкой (по решению 2026-07-08): шлём только текст. Ошибка
    загрузки фото → фолбэк на текст без картинки."""
    if not media_url or media_type == "video":
        return text, None
    # фото
    try:
        from app.api.max_webhook import _max_image_attachment_from_url
        att = await _max_image_attachment_from_url(media_url, token)
        if att:
            return text, [att]
    except Exception as e:  # noqa: BLE001
        log.warning("_max_media_for_text: photo attach failed: %s", e)
    return text, None


async def _check_max_founder_subscription(client_id: int, max_user_id: str,
                                          token: str, db) -> list[dict]:
    """MAX-аналог check_telegram_channels_subscription: возвращает список
    MAX-каналов ОСНОВАТЕЛЯ (clients.social_links.max_channels с числовым chat_id),
    на которые пользователь НЕ подписан. Пусто = подписан на всё / нечего
    проверять. Бот не админ канала / нет данных → fail-open (канал пройден)."""
    from app.services.social_links import normalize_max_channels
    from app.services.max_api import check_channel_membership
    row = await db.fetchrow("SELECT social_links FROM clients WHERE id = $1", client_id)
    if not row:
        return []
    social = row["social_links"]
    if isinstance(social, str):
        try:
            social = json.loads(social)
        except Exception:
            social = {}
    channels = normalize_max_channels((social or {}).get("max_channels") or [])
    to_check = [c for c in channels if (c.get("chat_id") or "").strip()]
    not_subscribed: list[dict] = []
    for ch in to_check:
        is_member = await check_channel_membership(ch["chat_id"], max_user_id, token=token)
        if is_member is False:  # None = нет данных (fail-open), False = не подписан
            not_subscribed.append(ch)
    return not_subscribed


async def run_started_max(run_id: int, max_user_id: str, username: Optional[str],
                          first_name: Optional[str], last_name: Optional[str],
                          db, token: str) -> None:
    """MAX-аналог run_started. Вызывается из max_webhook при получении payload
    `fnl_<run_id>` (bot_started / /start). Полностью зеркалит run_started_vk, но
    отправка и подписочный контекст — через MAX.

    Идемпотентно:
    - привязывает забег к platform_user (max) — создаёт contact если нужно,
    - регистрирует подписку на активный MAX client_channel клиента,
    - ставит stage=started, platform_slug='max',
    - шлёт уведомление организатору (один раз),
    - отправляет Текст 1 + callback-кнопку «ГОТОВО» через MAX API."""
    run = await db.fetchrow(
        """SELECT id, client_id, type, lead_magnet_id, package_id, stage,
                  contact_id, platform_slug, platform_user_id, started_at,
                  utm, referrer_contact_id
             FROM funnel_runs WHERE id = $1""",
        run_id
    )
    if not run:
        log.info("run_started_max: run %s not found", run_id)
        return

    client_id = run["client_id"]
    skeleton_contact_id = run["contact_id"]

    # ЧЁРНЫЙ СПИСОК (миграция 228) — воронка не запускается.
    try:
        from app.services.blacklist import is_identity_blacklisted
        if await is_identity_blacklisted(db, client_id, "max", str(max_user_id)):
            log.info("run_started_max: contact blacklisted (client %s, max %s)", client_id, max_user_id)
            return
    except Exception as e:  # noqa: BLE001 — fail-open
        log.warning("run_started_max blacklist check failed: %s", e)

    # Дедуп забегов на MAX той же связки (магнит/пакет).
    existing_run = await db.fetchrow(
        """SELECT id, stage, contact_id
             FROM funnel_runs
            WHERE client_id = $1
              AND platform_slug = 'max'
              AND platform_user_id = $2
              AND COALESCE(lead_magnet_id, 0) = COALESCE($3, 0)
              AND COALESCE(package_id, 0)     = COALESCE($4, 0)
              AND id <> $5
            ORDER BY id ASC LIMIT 1""",
        client_id, str(max_user_id),
        run["lead_magnet_id"], run["package_id"], run_id
    )
    if existing_run:
        if skeleton_contact_id:
            used_elsewhere = await db.fetchval(
                """SELECT EXISTS (
                       SELECT 1 FROM funnel_runs WHERE contact_id = $1 AND id <> $2
                       UNION ALL SELECT 1 FROM event_participants WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM platform_users  WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM collaborators    WHERE contact_id = $1
                   )""",
                skeleton_contact_id, run_id
            )
            await db.execute("DELETE FROM funnel_runs WHERE id = $1", run_id)
            if not used_elsewhere:
                await db.execute("DELETE FROM contacts WHERE id = $1", skeleton_contact_id)
        else:
            await db.execute("DELETE FROM funnel_runs WHERE id = $1", run_id)
        run_id = existing_run["id"]
        run = await db.fetchrow(
            """SELECT id, client_id, type, lead_magnet_id, package_id, stage,
                      contact_id, platform_slug, platform_user_id, started_at,
                      utm, referrer_contact_id
                 FROM funnel_runs WHERE id = $1""",
            run_id
        )
        skeleton_contact_id = None

    # platform_users — MAX identity клиента
    pu = await db.fetchrow(
        """SELECT pu.id, pu.contact_id
             FROM platform_users pu
             JOIN contacts c_own ON c_own.id = pu.contact_id
            WHERE c_own.client_id = $1 AND pu.platform_slug = 'max' AND pu.platform_user_id = $2""",
        client_id, str(max_user_id)
    )
    contact_id: Optional[int] = None
    if pu:
        contact_id = pu["contact_id"]
        await db.execute(
            """UPDATE platform_users
                  SET username = COALESCE(NULLIF($1,''), username),
                      first_name = COALESCE(NULLIF($2,''), first_name),
                      last_name = COALESCE(NULLIF($3,''), last_name)
                WHERE id = $4""",
            username or "", first_name or "", last_name or "", pu["id"]
        )
        if skeleton_contact_id and skeleton_contact_id != contact_id:
            used_elsewhere = await db.fetchval(
                """SELECT EXISTS (
                       SELECT 1 FROM funnel_runs WHERE contact_id = $1 AND id <> $2
                       UNION ALL SELECT 1 FROM event_participants WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM platform_users  WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM collaborators    WHERE contact_id = $1
                   )""",
                skeleton_contact_id, run_id
            )
            if not used_elsewhere:
                await db.execute("DELETE FROM contacts WHERE id = $1", skeleton_contact_id)
    else:
        if skeleton_contact_id:
            contact_id = skeleton_contact_id
            full_name = ((first_name or "") + " " + (last_name or "")).strip() or (username or "")
            await db.execute(
                """UPDATE contacts
                      SET name = COALESCE(name, NULLIF($1, '')),
                          last_contact_at = NOW()
                    WHERE id = $2""",
                full_name, contact_id
            )
        else:
            from app.services.contact_merge import _generate_unique_ref_code
            ref_code = await _generate_unique_ref_code(db)
            run_utm = run["utm"]
            if isinstance(run_utm, str):
                try:
                    run_utm = json.loads(run_utm)
                except Exception:
                    run_utm = {}
            utm_source = (run_utm or {}).get("utm_source")
            contact_id = await db.fetchval(
                """INSERT INTO contacts
                      (client_id, name, ref_code, utm_source,
                       first_referrer_contact_id, last_contact_at)
                   VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id""",
                client_id,
                ((first_name or "") + " " + (last_name or "")).strip() or (username or ""),
                ref_code,
                utm_source,
                run["referrer_contact_id"],
            )
        await db.execute(
            """INSERT INTO platform_users
                  (contact_id, platform_slug, platform_user_id,
                   username, first_name, last_name)
               VALUES ($1, 'max', $2, $3, $4, $5)
               ON CONFLICT (contact_id, platform_slug) DO NOTHING""",
            contact_id, str(max_user_id),
            username, first_name, last_name
        )

    # Регистрируем подписку на активный MAX client_channel клиента.
    try:
        cc_id = await db.fetchval(
            """SELECT cc.id FROM client_channels cc
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1 AND ch.platform_slug = 'max'
                  AND ch.is_system = FALSE
                ORDER BY cc.is_active DESC, cc.id ASC LIMIT 1""",
            client_id,
        )
        pu_id = await db.fetchval(
            """SELECT pu.id FROM platform_users pu
                JOIN contacts c_own ON c_own.id = pu.contact_id
                WHERE c_own.client_id = $1 AND pu.platform_slug = 'max' AND pu.platform_user_id = $2""",
            client_id, str(max_user_id),
        )
        if cc_id and pu_id:
            await db.execute(
                """INSERT INTO platform_user_channels
                       (platform_user_id, client_channel_id, is_unsubscribed, subscribed_at)
                   VALUES ($1, $2, FALSE, NOW())
                   ON CONFLICT (platform_user_id, client_channel_id)
                   DO UPDATE SET is_unsubscribed=FALSE, subscribed_at=NOW(), unsubscribed_at=NULL""",
                pu_id, cc_id,
            )
    except Exception as e:
        log.warning("run_started_max: register subscription failed: %s", e)

    is_new_started = run["stage"] == "landed"
    await db.execute(
        """UPDATE funnel_runs
              SET contact_id = COALESCE(contact_id, $1),
                  platform_slug = 'max',
                  platform_user_id = $2,
                  stage = CASE WHEN stage = 'landed' THEN 'started' ELSE stage END,
                  started_at = COALESCE(started_at, NOW())
            WHERE id = $3""",
        contact_id, str(max_user_id), run_id
    )

    await _bind_partner_for_run(db, client_id, contact_id, run["referrer_contact_id"])

    if is_new_started:
        await _send_organizer_notification(client_id, run_id, db)

    # Шлём Текст 1 через MAX API с callback-кнопкой «ГОТОВО».
    template = await _get_template(client_id, db)
    if not template:
        from app.api.funnels import _get_or_create_template
        template = await _get_or_create_template(client_id, "lead_magnet", db)
        template = dict(template)

    ctx = await _get_brand_context(client_id, db, platform="max")
    materials = await _materials_for_run(dict(run), db)
    pkg_desc = await _package_description_for_run(dict(run), db)
    # MAX парсит inline-HTML (<b>/<i>/<a>) только при parse_mode='html'; блочные
    # теги (<p>/<br>/<ul>) он не понимает — чистим через html_to_telegram (как в
    # рассылках). Иначе теги приходят сырым текстом.
    from app.services.message_builder import html_to_telegram
    text_1 = html_to_telegram(_format_text(template["text_1"], ctx, materials, pkg_desc))

    from app.services.max_api import send_message as max_send, tg_inline_to_max_keyboard
    button_label = template["button_label"] or "ГОТОВО"
    buttons = tg_inline_to_max_keyboard([[{
        "text": button_label,
        "callback_data": f"fnl_check_{run_id}"
    }]])
    # Медиа Текста 1: фото → attachment; видео → ссылкой в текст (MAX-видео тяжёлое).
    text_1, media_att = await _max_media_for_text(
        text_1, template.get("text_1_media_url"), template.get("text_1_media_type"), token)
    # last_message_id не пишем: это BIGINT для TG-mid (редактирование inline-кнопки),
    # а MAX mid — строковый. MAX-воронке редактирование кнопки не требуется.
    try:
        await max_send(
            int(max_user_id), text_1,
            token=token, buttons=buttons, recipient_kind="user",
            attachments=media_att, parse_mode="html",
        )
    except Exception as e:
        log.warning("run_started_max: send text_1 failed: %s", e)


async def run_check_subscription(run_id: int, tg_id: str, db, platform: str = "telegram") -> str:
    """Проверка подписки. Возвращает status:
       'subscribed'             — материалы отправлены (повторный клик = повторная отправка)
       'not_subscribed'         — не подписан на канал клиента
       'no_token'               — у клиента нет TG-бота для отправки
       'not_found'              — забег не найден

    `platform` (telegram/vk) — на какой платформе кликнули «ГОТОВО».
    Для VK: проверка подписки на VK-сообщество (`groups.isMember`) + отправка через VK API.
    """
    run = await db.fetchrow(
        """SELECT id, client_id, stage, lead_magnet_id, package_id,
                  contact_id, platform_slug
             FROM funnel_runs WHERE id = $1""",
        run_id
    )
    # ⚠️ Кнопка «ГОТОВО» живёт в переписке ВЕЧНО, а номер забега в неё зашит
    # намертво. Человек нажимает её через неделю — забега уже может не быть
    # (чистка, перенос данных), и он упирался в «что-то пошло не так», хотя
    # ничего не сделал не так.
    #
    # Поэтому не найден по номеру — ищем ПОСЛЕДНИЙ забег этого же человека за
    # тем же подарком на той же площадке. Так работает и старая кнопка, и
    # новая: нажатие всегда попадает в актуальный забег.
    if not run:
        run = await db.fetchrow(
            """SELECT fr.id, fr.client_id, fr.stage, fr.lead_magnet_id, fr.package_id,
                      fr.contact_id, fr.platform_slug
                 FROM funnel_runs fr
                 JOIN platform_users pu ON pu.contact_id = fr.contact_id
                                       AND pu.platform_slug = fr.platform_slug
                WHERE pu.platform_user_id = $1
                  AND fr.platform_slug = $2
                ORDER BY fr.landed_at DESC NULLS LAST, fr.id DESC
                LIMIT 1""",
            str(tg_id), platform,
        )
    if not run:
        return "not_found"

    # Дальше работаем с НАЙДЕННЫМ забегом: номер из кнопки мог устареть.
    run_id = run["id"]
    client_id = run["client_id"]

    if platform == "vk":
        # Проверка подписки на ВСЕ VK-сообщества основателя (массив vk_channels,
        # fallback на legacy одиночный vk_group_id). Не подписан хоть на одно →
        # not_subscribed. Нет сообществ / ошибка API → выдаём (fail-open).
        vk_sub = await check_vk_channels_subscription(client_id, str(tg_id), db)
        if not vk_sub["ok"]:
            return "not_subscribed"

    # ⚠️ Анкета-шлагбаум проверяется ПОСЛЕ подписки и ДО выдачи материалов
    # (порядок задан владельцем: подписка → анкета → файл). Общая точка на все
    # площадки — `survey_gate`; своей копии в каждом боте быть не должно.
    # Подарок человек получит сразу после отправки анкеты: в ссылке зашит его
    # contact_id, номер подарка и площадка, поэтому возвращать его вручную
    # не нужно. Забег остаётся в текущей стадии — вернётся сюда же, если
    # нажмёт «ГОТОВО» повторно, и уже пройдёт шлагбаум.
    try:
        from app.services.survey_gate import required_survey_for_run
        _survey = await required_survey_for_run(db, dict(run))
    except Exception:
        # ⚠️ fail-open: сбой проверки не должен лишать человека подарка.
        import logging as _logging
        _logging.getLogger(__name__).exception(
            "survey gate: проверка анкеты не удалась, выдаём материалы")
        _survey = None
    if _survey:
        return "survey_required"

    # ⚠️ Выдача материалов VK. Этот блок лежал ВНУТРИ `if _survey:` сразу
    # после `return "survey_required"` — то есть НЕ ВЫПОЛНЯЛСЯ НИКОГДА.
    # Человек нажимал «ГОТОВО», подписка проверялась и проходила, а Текст 2
    # со ссылками не уходил: кнопка крутилась бесконечно, у части клиентов
    # VK показывал «что-то пошло не так».
    if platform == "vk":
        from app.services.vk_api import send_message_with_media as vk_send_with_media
        # Шлём от того же сообщества, через которое прилетел клик. Токен этого
        # канала вычисляется по run.platform_slug='vk' + active client_channel.
        vk_token = await _vk_token_for_client(client_id, db) or None
        is_first_delivery = run["stage"] != "delivered"
        await db.execute(
            """UPDATE funnel_runs
                  SET stage = 'delivered',
                      subscribed_at = COALESCE(subscribed_at, NOW()),
                      delivered_at = COALESCE(delivered_at, NOW())
                WHERE id = $1""",
            run_id
        )
        template = await _get_template(client_id, db)
        if not template:
            from app.api.funnels import _get_or_create_template
            template = await _get_or_create_template(client_id, "lead_magnet", db)
            template = dict(template)
        materials = await _materials_for_run(dict(run), db)
        pkg_desc = await _package_description_for_run(dict(run), db)
        vk_ctx = await _get_brand_context(client_id, db, platform="vk")
        pkg_mode = await _package_link_mode(dict(run), db)
        text_2 = _format_text(template["text_2"], vk_ctx, materials, pkg_desc, pkg_mode)
        # Видео в VK НЕ отправляется — только фото (решение 2026-07-08).
        vk_m2_url, vk_m2_type = _vk_funnel_media(
            template.get("text_2_media_url"), template.get("text_2_media_type"))
        vk_user_tok, vk_user_grp = await _vk_admin_user_token_for_client(client_id, db)
        # Кнопки выдачи материалов. ⚠️ Каждая своей строкой — VK ужимает
        # соседние надписи, а у нас они до 40 символов (это его же предел).
        vk_btns = await _funnel_buttons(dict(run), materials, db)
        vk_kb = ({"inline": True, "buttons": [
            [{"action": {"type": "open_link", "link": b["url"], "label": b["label"]}}]
            for b in vk_btns]} if vk_btns else None)
        try:
            await vk_send_with_media(
                int(tg_id), text_2,
                media_url=vk_m2_url,
                media_type=vk_m2_type,
                token=vk_token,
                keyboard=vk_kb,
                user_token=vk_user_tok, user_token_group_id=vk_user_grp,
            )
        except Exception as e:
            log.warning("VK send text_2 failed for run %s: %s", run_id, e)
        if is_first_delivery:
            try:
                from app.tasks.funnel import send_text_3
                send_text_3.apply_async(args=[run_id], countdown=30 * 60)
            except Exception as e:
                log.warning("Failed to schedule text_3 for run %s: %s", run_id, e)
        return "subscribed"

    if platform == "max":
        # Проверка подписки на MAX-каналы основателя (fail-open: бот не админ /
        # нет каналов → пускаем). Затем выдача Текста 2 через MAX-бот клиента.
        max_ctx = await _get_brand_context(client_id, db, platform="max")
        max_token = await _max_token_for_client(client_id, db)
        if not max_token:
            return "no_token"

        not_sub = await _check_max_founder_subscription(client_id, str(tg_id), max_token, db)
        if not_sub:
            return "not_subscribed"

        is_first_delivery = run["stage"] != "delivered"
        await db.execute(
            """UPDATE funnel_runs
                  SET stage = 'delivered',
                      subscribed_at = COALESCE(subscribed_at, NOW()),
                      delivered_at = COALESCE(delivered_at, NOW())
                WHERE id = $1""",
            run_id
        )
        template = await _get_template(client_id, db)
        if not template:
            from app.api.funnels import _get_or_create_template
            template = await _get_or_create_template(client_id, "lead_magnet", db)
            template = dict(template)
        materials = await _materials_for_run(dict(run), db)
        pkg_desc = await _package_description_for_run(dict(run), db)
        from app.services.message_builder import html_to_telegram
        pkg_mode = await _package_link_mode(dict(run), db)
        text_2 = html_to_telegram(_format_text(template["text_2"], max_ctx, materials, pkg_desc, pkg_mode))
        text_2, media_att2 = await _max_media_for_text(
            text_2, template.get("text_2_media_url"), template.get("text_2_media_type"), max_token)
        from app.services.max_api import send_message as max_send
        # Кнопки выдачи материалов — отдельным вложением-клавиатурой, рядом с
        # медиа: в MAX клавиатура и есть attachment.
        max_btns = await _funnel_buttons(dict(run), materials, db)
        if max_btns:
            media_att2 = list(media_att2 or []) + [{
                "type": "inline_keyboard",
                "payload": {"buttons": [
                    [{"type": "link", "url": b["url"], "text": b["label"]}]
                    for b in max_btns]},
            }]
        try:
            await max_send(int(tg_id), text_2, token=max_token,
                           recipient_kind="user", attachments=media_att2,
                           parse_mode="html")
        except Exception as e:
            log.warning("MAX send text_2 failed for run %s: %s", run_id, e)
        if is_first_delivery:
            try:
                from app.tasks.funnel import send_text_3
                send_text_3.apply_async(args=[run_id], countdown=30 * 60)
            except Exception as e:
                log.warning("Failed to schedule text_3 for run %s: %s", run_id, e)
        return "subscribed"

    ctx = await _get_brand_context(client_id, db)

    token = await _bot_token_for_client(client_id, db)
    if not token:
        return "no_token"

    # Проверяем подписку на ВСЕ TG-каналы основателя (миграция 114).
    # Если каналов нет — пропускаем (fail-open). Если есть — должен быть подписан
    # на каждый. Закрытые каналы без chat_id внутри функции пропускаются (Bot API
    # не умеет проверять через инвайт-код).
    sub = await check_telegram_channels_subscription(client_id, str(tg_id), db)
    if not sub["ok"]:
        return "not_subscribed"

    # подписан → выдаём (или выдаём повторно при повторном нажатии «ГОТОВО»)
    is_first_delivery = run["stage"] != "delivered"
    await db.execute(
        """UPDATE funnel_runs
              SET stage = 'delivered',
                  subscribed_at = COALESCE(subscribed_at, NOW()),
                  delivered_at = COALESCE(delivered_at, NOW())
            WHERE id = $1""",
        run_id
    )

    template = await _get_template(client_id, db)
    if not template:
        from app.api.funnels import _get_or_create_template
        template = await _get_or_create_template(client_id, "lead_magnet", db)
        template = dict(template)

    materials = await _materials_for_run(dict(run), db)
    pkg_desc = await _package_description_for_run(dict(run), db)
    pkg_mode = await _package_link_mode(dict(run), db)
    text_2 = _format_text(template["text_2"], ctx, materials, pkg_desc, pkg_mode)
    # Материалы, помеченные «кнопкой», уходят кнопками под сообщением. Ссылка
    # в абзаце теряется — человек дочитывает и не понимает, куда нажать.
    btns = await _funnel_buttons(dict(run), materials, db)
    # ⚠️ Каждая кнопка СВОЕЙ строкой: в ряд Telegram ужимает надписи до
    # нечитаемых огрызков, а у нас они по 40 символов.
    tg_markup = ({"inline_keyboard": [[{"text": b["label"], "url": b["url"]}] for b in btns]}
                 if btns else None)
    _, fresh_fid = await _send_text_with_media(
        token, tg_id, text_2,
        template.get("text_2_media_url"),
        template.get("text_2_media_type"),
        file_id=template.get("text_2_media_file_id"),
        reply_markup=tg_markup,
    )
    await _maybe_cache_file_id(template, "text_2", fresh_fid, db)

    # Таймер «как там, всё открылось?» — только при первой выдаче, чтобы
    # повторные клики не плодили follow-up'ы.
    if is_first_delivery:
        try:
            from app.tasks.funnel import send_text_3
            send_text_3.apply_async(args=[run_id], countdown=30 * 60)
        except Exception as e:
            log.warning("Failed to schedule text_3 for run %s: %s", run_id, e)

    return "subscribed"


async def send_text_3(run_id: int, db) -> None:
    """Отправляет Текст 3. Версия выбирается по текущему stage:
       delivered → text_3_delivered ; started/subscribed → text_3_stuck.
       landed → не шлём (человек так и не дошёл до бота)."""
    run = await db.fetchrow(
        """SELECT id, client_id, stage, lead_magnet_id, package_id,
                  platform_user_id, text3_sent_at
             FROM funnel_runs WHERE id = $1""",
        run_id
    )
    if not run or run["text3_sent_at"]:
        return
    if run["stage"] == "landed" or not run["platform_user_id"]:
        return

    client_id = run["client_id"]
    template = await _get_template(client_id, db)
    if not template:
        return
    ctx = await _get_brand_context(client_id, db)
    materials = await _materials_for_run(dict(run), db)
    pkg_desc = await _package_description_for_run(dict(run), db)

    if run["stage"] == "delivered":
        pkg_mode = await _package_link_mode(dict(run), db)
        text = _format_text(template["text_3_delivered"], ctx, materials, pkg_desc, pkg_mode)
        kind = "delivered"
    else:
        pkg_mode = await _package_link_mode(dict(run), db)
        text = _format_text(template["text_3_stuck"], ctx, materials, pkg_desc, pkg_mode)
        kind = "stuck"

    token = await _bot_token_for_client(client_id, db)
    if not token:
        return
    await _send_message(token, run["platform_user_id"], text)
    await db.execute(
        "UPDATE funnel_runs SET text3_sent_at = NOW(), text3_kind = $1 WHERE id = $2",
        kind, run_id
    )
