"""
Резолв партнёрского параметра внешней платформы клиента (contacts.external_ref_param)
и склейка любого внешнего URL клиента с полным набором GET-параметров о контакте.

**Где используется** (единый список параметров на всех точках):
  - events.landing_url    — лендинг события (Mini App, SSR /l/[slug], landing-redirect)
  - events.vip_url        — кнопка VIP-тарифа в Mini App (ProgramTab, ResultsTab и т.п.)
  - clients.partner_landing_url — партнёрский сервис клиента (миграция 105)

**Стандартный набор GET-параметров** (только непустые значения):
  - pluson_contact_id      — contacts.id
  - pluson_participant_id  — event_participants.id (только для событий)
  - tg_id, vk_id           — ID контакта на платформе
  - email, phone, name     — поля contacts
  - tg_nickname            — username из platform_users
  - external_ref_param контакта (партнёрский код во внешней системе клиента) —
    приклеивается как есть, например `&gcpc=fdd97`
  - utm_source, pid        — для совместимости со старыми формами клиентов
  - event_slug             — только для events.landing_url, для маркировки источника

Клиент в GetCourse/Tilda/Bizon360 настраивает скрытые поля под нужные имена и
получает webhook /integrations/salebot/register с этими значениями — связь
формы со своим контактом в ПЛЮСОНе устанавливается автоматически.

Связывает партнёра ПЛЮСОН (по ref_code контакта) с партнёром во внешней системе
клиента — клиент видит реферал в своей платформе.
"""
import re
import logging
from typing import Optional, Any
from urllib.parse import urlencode
import asyncpg

logger = logging.getLogger(__name__)


_LANDING_FLAG_RE = re.compile(r"^[a-z0-9-]{1,16}$")
_LANDING_FLAGS_MAX = 5


def normalize_landing_flags(raw) -> list[str]:
    """Принимает список строк, CSV или None — возвращает уникальные валидные флаги.

    Алфавит ключа: [a-z0-9-], длина 1..16, не более 5 штук. Лишнее отбрасывается.
    Используется и в /landing-redirect (?q=shpw,vip), и при разборе startapp `_q…`.
    """
    if not raw:
        return []
    items = raw.split(",") if isinstance(raw, str) else list(raw)
    out: list[str] = []
    for s in items:
        k = (s or "").strip().lower()
        if k and _LANDING_FLAG_RE.match(k) and k not in out:
            out.append(k)
        if len(out) >= _LANDING_FLAGS_MAX:
            break
    return out


def parse_landing_flag_pairs(raw) -> list[tuple[str, str | None]]:
    """Разбирает флаги в пары (key, value|None) с сохранением значения.

    Каждый флаг приходит РОВНО как задан клиентом в ссылке:
      • `shwt`     → ("shwt", None)   → на лендинге голый `?shwt`
      • `shwt=1`   → ("shwt", "1")    → на лендинге `?shwt=1`
      • `vip=gold` → ("vip", "gold")  → на лендинге `?vip=gold`
    Валидируется только ключ (алфавит `[a-z0-9-]`, длина 1..16, до 5 шт).
    Значение оставляем как есть (отрезаем только пробелы).
    """
    if not raw:
        return []
    items = raw.split(",") if isinstance(raw, str) else list(raw)
    out: list[tuple[str, str | None]] = []
    seen: set[str] = set()
    for s in items:
        raw_item = (s or "").strip()
        if not raw_item:
            continue
        if "=" in raw_item:
            key, val = raw_item.split("=", 1)
            key = key.strip().lower()
            val = val.strip()
        else:
            key, val = raw_item.lower(), None
        if key and _LANDING_FLAG_RE.match(key) and key not in seen:
            seen.add(key)
            out.append((key, val if val else None))
        if len(out) >= _LANDING_FLAGS_MAX:
            break
    return out


async def resolve_external_ref_param(
    db: asyncpg.Connection,
    client_id: int,
    pid: Optional[str],
) -> Optional[str]:
    """Возвращает строку-параметр (например "gcpc=fdd97") контакта по pid, либо None.

    Ищет contact с ref_code=pid (или в merged_ref_codes) у того же клиента с
    непустым external_ref_param. Любые ошибки → None (основной редирект не должен ломаться).
    """
    if not pid:
        return None
    try:
        return await db.fetchval(
            """SELECT c.external_ref_param
                 FROM contacts c
                WHERE c.client_id = $1
                  AND (c.ref_code = $2 OR c.merged_ref_codes ? $2)
                  AND c.external_ref_param IS NOT NULL
                  AND c.external_ref_param <> ''
                LIMIT 1""",
            client_id, pid,
        )
    except Exception:
        return None


async def resolve_referrer_external_ref_param(
    db: asyncpg.Connection,
    client_id: int,
    *,
    pid: Optional[str] = None,
    participant_id: Optional[int] = None,
    contact_id: Optional[int] = None,
) -> Optional[str]:
    """Резолвит partнёрский код **РЕФОВОДА** для подстановки в URL внешнего лендинга.

    Приоритет источников (первый непустой выигрывает):
    1. `pid` (передан в URL) — реф-код того, кто привёл (Mini App / лендинг).
    2. `event_participants.referrer_ref_code` — кто привёл на ЭТО событие.
    3. `contacts.first_referrer_contact_id` — кто впервые привёл в базу клиента.

    НЕ возвращает external_ref_param САМОГО контакта — это код самого контакта,
    а для events-landing нужен код рефовода (чтобы GetCourse атрибутировал
    регистрацию тому, кто привёл).
    """
    # 1. По pid
    if pid:
        v = await resolve_external_ref_param(db, client_id, pid)
        if v:
            return v
    # 2. По participant.referrer_ref_code
    if participant_id:
        try:
            v = await db.fetchval(
                """SELECT c.external_ref_param
                     FROM event_participants ep
                     JOIN contacts c
                       ON (c.ref_code = ep.referrer_ref_code OR c.merged_ref_codes ? ep.referrer_ref_code)
                    WHERE ep.id = $1
                      AND ep.referrer_ref_code IS NOT NULL AND ep.referrer_ref_code <> ''
                      AND c.client_id = $2
                      AND c.external_ref_param IS NOT NULL AND c.external_ref_param <> ''
                    LIMIT 1""",
                participant_id, client_id,
            )
            if v:
                return v
        except Exception:
            pass
    # 3. По contacts.first_referrer_contact_id
    if contact_id:
        try:
            v = await db.fetchval(
                """SELECT c2.external_ref_param
                     FROM contacts c1
                     JOIN contacts c2 ON c2.id = c1.first_referrer_contact_id
                    WHERE c1.id = $1
                      AND c2.external_ref_param IS NOT NULL AND c2.external_ref_param <> ''
                    LIMIT 1""",
                contact_id,
            )
            if v:
                return v
        except Exception:
            pass
    return None


async def build_event_vip_target(
    db: asyncpg.Connection,
    event_id: int,
    contact_id: Optional[int],
) -> Optional[dict]:
    """Собирает VIP-ссылку события с полным набором GET-параметров контакта +
    внешним партнёрским кодом рефовода — ТА ЖЕ логика, что в кнопке VIP меню.

    Используется командой /vip_link{id} во всех ботах (TG/VK/MAX) и кнопкой
    «Выбрать формат участия» в меню. Единая точка истины.

    :return: {"vip_target": url, "vip_label": str, "title": str} или None если
             у события не задан vip_url.
    """
    ev = await db.fetchrow(
        """SELECT id, slug, title, vip_url, vip_button_label,
                  (SELECT eo.client_id FROM event_owners eo
                    WHERE eo.event_id = events.id AND eo.status = 'accepted'
                    ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id
             FROM events WHERE id = $1 LIMIT 1""",
        event_id,
    )
    if not ev:
        return None
    vip_url = (ev["vip_url"] or "").strip()
    if not vip_url:
        return None
    contact_params = await get_contact_landing_params(db, contact_id) if contact_id else {}
    erp = await resolve_referrer_external_ref_param(
        db, ev["client_id"], contact_id=contact_id,
    )
    vip_target = enrich_external_url(
        vip_url,
        pluson_contact_id=contact_id,
        event_slug=ev["slug"],
        external_ref_param=erp,
        **contact_params,
    )
    vip_label = (ev["vip_button_label"] or "").strip() or "ВЫБРАТЬ ФОРМАТ УЧАСТИЯ"
    return {"vip_target": vip_target, "vip_label": vip_label, "title": ev["title"] or ""}


async def get_contact_landing_params(
    db: asyncpg.Connection,
    contact_id: int,
) -> dict[str, Any]:
    """Подтягивает поля контакта + платформенные идентичности (TG/VK) для подстановки
    в URL стороннего лендинга. Возвращает словарь {имя_параметра → значение}, в
    котором уже отфильтрованы пустые значения.

    Поля контакта: name, email, phone (НЕ external_ref_param — это код самого
    контакта, не относится к URL лендинга; для лендинга нужен код РЕФОВОДА —
    см. `resolve_referrer_external_ref_param`).
    Платформенные: tg_id, tg_nickname, vk_id (берём первую найденную идентичность каждой платформы).
    Любые ошибки → возвращает то, что успело собраться (или пустой dict).
    """
    out: dict[str, Any] = {}
    if not contact_id:
        return out
    try:
        c = await db.fetchrow(
            # Почта — идентичность в platform_users, колонки contacts.email нет
            # (дропнута мигр. 282). Раньше запрос падал целиком, и на сторонний
            # лендинг не уезжали ни имя, ни телефон — ошибку глушил except ниже.
            """SELECT c.name, c.phone,
                      (SELECT pe.platform_user_id FROM platform_users pe
                        WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                        ORDER BY pe.id LIMIT 1) AS email
                 FROM contacts c WHERE c.id = $1""",
            contact_id,
        )
        if c:
            for fld in ("name", "email", "phone"):
                v = (c[fld] or "").strip() if c[fld] else ""
                if v:
                    out[fld] = v
    except Exception:
        pass

    try:
        ids = await db.fetch(
            """SELECT platform_slug, platform_user_id, username
                 FROM platform_users
                WHERE contact_id = $1
                  AND platform_slug IN ('telegram', 'vk')""",
            contact_id,
        )
        # Берём первое значение для каждой платформы (если несколько идентичностей)
        seen: set[str] = set()
        for r in ids:
            ps = r["platform_slug"]
            if ps in seen:
                continue
            seen.add(ps)
            pu_id = (r["platform_user_id"] or "").strip()
            if ps == "telegram":
                if pu_id:
                    out["tg_id"] = pu_id
                un = (r["username"] or "").strip().lstrip("@")
                if un:
                    out["tg_nickname"] = un
            elif ps == "vk":
                if pu_id:
                    out["vk_id"] = pu_id
    except Exception:
        pass

    return out


def enrich_external_url(
    url: str,
    *,
    pluson_contact_id: Optional[int] = None,
    pluson_participant_id: Optional[int] = None,
    tg_id: Optional[str] = None,
    vk_id: Optional[str] = None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    name: Optional[str] = None,
    tg_nickname: Optional[str] = None,
    external_ref_param: Optional[str] = None,
    # Совместимость со старыми эндпоинтами и формами клиентов:
    pid: Optional[str] = None,
    utm_source: Optional[str] = None,
    event_slug: Optional[str] = None,
    extra: Optional[dict] = None,
    # Произвольные флаги для активации блоков на стороннем лендинге.
    # Каждый ключ приклеивается как &{key}=1. Алфавит/лимиты — см.
    # `normalize_landing_flags`. Источник: метки `_q{key}` в startapp/ref
    # прямой ссылки клиента, либо неизвестные GET-параметры на /l/{slug}.
    flags: Optional[list[str]] = None,
) -> str:
    """Склеивает любой URL клиента (events.landing_url, vip_url, partner_landing_url)
    со стандартным набором GET-параметров. Пустые значения не приписываются.

    `external_ref_param` — это уже строка `key=value` (например `gcpc=fdd97`),
    приклеивается в самом конце как есть.
    """
    qs: dict[str, str] = {}

    def _put(k: str, v: Any) -> None:
        if v is None:
            return
        s = str(v).strip()
        if not s:
            return
        qs[k] = s

    _put("pluson_contact_id", pluson_contact_id)
    _put("pluson_participant_id", pluson_participant_id)
    # Legacy-дубль под старым именем: многие лендинги (GetCourse/Tilda) настроены
    # ловить скрытое поле «participant_id» БЕЗ префикса pluson_ (так было до
    # 24.05.2026). Дублируем значение, чтобы webhook getcourse/register получил
    # его независимо от того, под каким именем настроено скрытое поле формы.
    _put("participant_id", pluson_participant_id)
    _put("contact_id", pluson_contact_id)
    _put("tg_id", tg_id)
    _put("vk_id", vk_id)
    _put("email", email)
    _put("phone", phone)
    _put("name", name)
    _put("tg_nickname", tg_nickname)
    _put("pid", pid)
    _put("utm_source", utm_source)
    _put("event_slug", event_slug)
    if extra:
        for k, v in extra.items():
            _put(k, v)

    # Флаги-маркеры тарифа: добавляются РОВНО как задал клиент в ссылке.
    # `shwt` → голый `?shwt`; `shwt=1` → `?shwt=1`. Голые флаги нельзя выразить
    # через urlencode (он всегда делает key=value), поэтому собираем их отдельно.
    flag_tokens: list[str] = []
    for key, val in parse_landing_flag_pairs(flags):
        if key in qs:
            continue  # не перетираем, если клиент уже передал key через extra
        flag_tokens.append(key if val is None else f"{key}={val}")

    sep = "&" if "?" in url else "?"
    out_url = url
    if qs:
        out_url = url + sep + urlencode(qs)
        sep = "&"
    for tok in flag_tokens:
        out_url += sep + tok
        sep = "&"
    if external_ref_param:
        out_url += sep + external_ref_param.lstrip("?&")
    return out_url


def build_external_landing_url(
    landing_url: str,
    *,
    event_slug: str,
    participant_id: Optional[int] = None,
    contact_id: Optional[int] = None,
    pid: Optional[str] = None,
    utm_source: Optional[str] = None,
    external_ref_param: Optional[str] = None,
    # Дополнительные поля контакта (загружены асинхронно через get_contact_landing_params).
    name: Optional[str] = None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    tg_id: Optional[str] = None,
    vk_id: Optional[str] = None,
    tg_nickname: Optional[str] = None,
    flags=None,
) -> str:
    """Совместимость со старой сигнатурой. Внутри использует `enrich_external_url`.

    Имена контакт/участник в URL — `pluson_contact_id` / `pluson_participant_id`
    (стандарт миграции 105+). Старые имена `contact_id` / `participant_id`
    БОЛЬШЕ НЕ ПИШУТСЯ — webhook принимает оба варианта через алиасы.
    """
    return enrich_external_url(
        landing_url,
        pluson_contact_id=contact_id,
        pluson_participant_id=participant_id,
        pid=pid,
        utm_source=utm_source,
        event_slug=event_slug,
        external_ref_param=external_ref_param,
        name=name, email=email, phone=phone,
        tg_id=tg_id, vk_id=vk_id, tg_nickname=tg_nickname,
        flags=flags,
    )


# ⚠️ Логика «в чью базу вести человека» переехала в services/event_client.py —
# это ЕДИНАЯ точка на весь бэкенд (в коллабе владельцев несколько, и «первый
# из event_owners» для работы с людьми неверен). Здесь оставлены псевдонимы,
# чтобы не плодить второй источник правды.
from app.services.event_client import (  # noqa: E402
    is_event_owner as _is_event_owner,
    resolve_event_client as _collab_base_client,
)




async def resolve_or_create_participant(
    db,
    *,
    client_id: int,
    event_id: int,
    platform_slug: str,
    platform_user_id: str,
    username: Optional[str] = None,
    utm_source: Optional[str] = None,
    known_contact_id: Optional[int] = None,
    partner_id: Optional[str] = None,
    source_client_id: Optional[int] = None,
) -> tuple[Optional[int], Optional[int]]:
    """Находит (или создаёт) event_participants.id для пары
    (платформенный пользователь, событие). Возвращает (participant_id, contact_id).

    Если контакта с такой идентичностью ещё нет (ПЕРВОЕ касание человека —
    например, он впервые открыл лендинг по реф-ссылке спикера, не побывав в
    боте раньше) — создаёт контакт + идентичность СИНХРОННО через
    upsert_contact_with_identity. Иначе pluson_contact_id/pluson_participant_id
    не попадали бы в URL стороннего лендинга, и webhook GetCourse приходил бы
    с пустым participant_id (баг до 2026-06-09: контакт создавался только
    фоновой задачей send_event_open_message — уже ПОСЛЕ сборки URL).

    ⚠️ У КОЛЛАБ-события владельцев несколько, а `client_id` приходит сюда
    выбранным как «первый из `event_owners`» (сортировка по роли и id строки) —
    для коллабы это неверно. Суть коллабы: **каждый организатор ведёт СВОЮ базу
    через СВОЕГО бота**, поэтому человек должен попасть в базу того, ЧЕРЕЗ КОГО
    пришёл, а не того, чья строка владельцев оказалась первой. Ниже база
    переопределяется параметром `source_client_id` (см. `_collab_base_client`).

    Что ломалось без этого (проверено на проде 2026-08-17, событие 92): человек
    по ссылке Нурии попадал в базу Лилии, её реф-код искался в базе Лилии, где
    его нет — рефовод молча терялся (`referrer_ref_code = NULL`), привлечение не
    засчитывалось никому, а уведомления слал бот не того организатора.

    Любые ошибки → (None, None).
    """
    if not platform_user_id:
        return None, None
    try:
        # ⚠️ Передаём и площадочный id: если человек УЖЕ участник события,
        # база берётся из его существующего участия — не важно, каким запросом
        # он пришёл и что было в ссылке. Без этого повторный заход без
        # контекста заводил ему второй контакт у другого организатора, и
        # писал чужой бот (прод, 2026-08-18).
        client_id = await _collab_base_client(
            db, event_id=event_id, client_id=client_id,
            partner_id=partner_id, source_client_id=source_client_id,
            platform_slug=platform_slug, platform_user_id=str(platform_user_id),
        )

        row = await db.fetchrow(
            """SELECT c.id, c.merged_into
                 FROM platform_users pu
                 JOIN contacts c ON c.id = pu.contact_id
                WHERE c.client_id = $1
                  AND pu.platform_slug = $2
                  AND pu.platform_user_id = $3
                LIMIT 1""",
            client_id, platform_slug, str(platform_user_id),
        )
        if row:
            contact_id = row["merged_into"] or row["id"]
        else:
            # Контакта ещё нет — создаём синхронно, чтобы ID попал в URL.
            from app.services.contact_merge import upsert_contact_with_identity
            contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
                db,
                client_id=client_id,
                platform_slug=platform_slug,
                platform_user_id=str(platform_user_id),
                username=username or None,
                utm_source=utm_source or None,
                known_contact_id=known_contact_id,
            )

        # Резолвим реферера из pid (если пришёл по реф-ссылке) — нормализуем
        # legacy/смерженные коды через resolve_ref_code.
        resolved_ref_code = None
        referrer_contact_id = None
        if partner_id:
            from app.services.contact_merge import resolve_ref_code
            resolved_ref_code, referrer_contact_id = await resolve_ref_code(
                db, partner_id, client_id=client_id,
            )

        # Вставляем привязку к событию. ON CONFLICT DO NOTHING → RETURNING вернёт
        # id ТОЛЬКО при реальной первой вставке. По этому признаку шлём
        # организатору уведомление «Новый интерес» РОВНО ОДИН РАЗ на
        # (человек × событие) — независимо от пути (бот /start, форма, лендинг,
        # webhook): все они проходят через эту единую функцию.
        pid = await db.fetchval(
            """INSERT INTO event_participants (event_id, contact_id, is_registered, referrer_ref_code)
               VALUES ($1, $2, FALSE, $3)
               ON CONFLICT (event_id, contact_id) DO NOTHING
               RETURNING id""",
            event_id, contact_id, resolved_ref_code,
        )
        is_first = pid is not None
        if not is_first:
            # Запись уже была — достаём её id (нужен для ссылок), уведомление НЕ шлём.
            pid = await db.fetchval(
                "SELECT id FROM event_participants WHERE event_id = $1 AND contact_id = $2 LIMIT 1",
                event_id, contact_id,
            )

        if is_first:
            await _notify_organizer_new_interest(
                db,
                client_id=client_id,
                event_id=event_id,
                contact_id=contact_id,
                platform_slug=platform_slug,
                platform_user_id=str(platform_user_id),
                referrer_contact_id=referrer_contact_id,
            )

        return pid, contact_id
    except Exception:
        return None, None


async def _notify_organizer_new_interest(
    db,
    *,
    client_id: int,
    event_id: int,
    contact_id: int,
    platform_slug: str,
    platform_user_id: str,
    referrer_contact_id: Optional[int] = None,
) -> None:
    """Шлёт организатору уведомление «Новый интерес» о только что созданной
    привязке участника к событию. Вызывается из resolve_or_create_participant
    при ПЕРВОЙ вставке. Реферер передаётся явно (резолвлен из pid) или, если
    не передан, дотягивается из записи участника по referrer_ref_code.
    Любая ошибка — молча проглатывается (не должна ломать создание участника)."""
    try:
        event_title = await db.fetchval("SELECT title FROM events WHERE id = $1", event_id) or ""
        if referrer_contact_id is None:
            referrer_contact_id = await db.fetchval(
                """SELECT ct.id
                     FROM event_participants ep
                     JOIN contacts ct ON ct.ref_code = ep.referrer_ref_code
                    WHERE ep.event_id = $1 AND ep.contact_id = $2
                      AND ep.referrer_ref_code IS NOT NULL AND ep.referrer_ref_code <> ''
                    LIMIT 1""",
                event_id, contact_id,
            )
        from app.services.event_welcome import _send_event_organizer_notification
        await _send_event_organizer_notification(
            db,
            client_id=client_id,
            event_id=event_id,
            event_title=event_title,
            contact_id=contact_id,
            platform_slug=platform_slug,
            referrer_contact_id=referrer_contact_id,
            tg_id=platform_user_id if platform_slug == "telegram" else None,
        )
    except Exception:
        pass
