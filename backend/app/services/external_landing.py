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
from typing import Optional, Any
from urllib.parse import urlencode
import asyncpg


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
            """SELECT name, email, phone
                 FROM contacts WHERE id = $1""",
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
    if flags:
        for k in normalize_landing_flags(flags):
            qs.setdefault(k, "1")  # не перетираем, если клиент уже передал key через extra

    sep = "&" if "?" in url else "?"
    out_url = url
    if qs:
        out_url = url + sep + urlencode(qs)
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


async def resolve_or_create_participant(
    db,
    *,
    client_id: int,
    event_id: int,
    platform_slug: str,
    platform_user_id: str,
    username: Optional[str] = None,
    utm_source: Optional[str] = None,
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

    Любые ошибки → (None, None).
    """
    if not platform_user_id:
        return None, None
    try:
        row = await db.fetchrow(
            """SELECT c.id, c.merged_into
                 FROM platform_users pu
                 JOIN contacts c ON c.id = pu.contact_id
                WHERE pu.client_id = $1
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
            )

        pid = await db.fetchval(
            """INSERT INTO event_participants (event_id, contact_id, is_registered)
               VALUES ($1, $2, FALSE)
               ON CONFLICT (event_id, contact_id) DO UPDATE SET event_id = EXCLUDED.event_id
               RETURNING id""",
            event_id, contact_id,
        )
        return pid, contact_id
    except Exception:
        return None, None
