"""
Резолв партнёрского параметра внешней платформы клиента (contacts.external_ref_param)
и склейка URL стороннего лендинга с этим параметром.

Используется во ВСЕХ точках, где открывается events.landing_url с пробросом pid:
  - GET /api/v1/public/events/{slug}/landing-redirect (Mini App index.html, ДО React)
  - GET /api/v1/public/events/{slug}/external-ref     (вспомогательный — для SSR /l/[slug] и Mini App SPA)
  - SSR Next.js /l/[slug]/page.tsx (301-редирект веб-входа)
  - mini-app/src/pages/EventPage.tsx (useEffect и handleWantParticipate)

Связывает партнёра ПЛЮСОН (по ref_code контакта) с партнёром во внешней системе клиента
(GetCourse / Bizon360 / Tilda) — клиент видит реферал в своей платформе.
Партнёром может быть ЛЮБОЙ контакт, не только коллаборатор.
"""
from typing import Optional
from urllib.parse import urlencode
import asyncpg


async def resolve_external_ref_param(
    db: asyncpg.Connection,
    client_id: int,
    pid: Optional[str],
) -> Optional[str]:
    """Возвращает строку-параметр (например "gcpc=fdd97") контакта по pid, либо None.

    Ищет contact с ref_code=pid (или в merged_ref_codes) у того же клиента с
    непустым external_ref_param.
    Любые ошибки → None (основной редирект не должен ломаться).
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


def build_external_landing_url(
    landing_url: str,
    *,
    event_slug: str,
    contact_id: Optional[int] = None,
    pid: Optional[str] = None,
    utm_source: Optional[str] = None,
    external_ref_param: Optional[str] = None,
) -> str:
    """Склеивает URL стороннего лендинга со стандартными query-параметрами и
    в самом конце дописывает партнёрский параметр клиента (например &gcpc=fdd97).

    Параметр идентификации участника:
      - contact_id — ID контакта в ПЛЮСОНе. Клиент в GetCourse/Tilda настраивает
        «Сохранять GET-параметры в форме» → скрытое поле формы → webhook
        регистрации находит контакта по этому id (никаких tg_id/vk_id не нужно —
        одно поле работает для всех платформ).
    """
    qs = {"event_slug": event_slug}
    if contact_id is not None:
        qs["contact_id"] = str(contact_id)
    if pid:
        qs["pid"] = pid
    if utm_source:
        qs["utm_source"] = utm_source
    sep = "&" if "?" in landing_url else "?"
    url = landing_url + sep + urlencode(qs)
    if external_ref_param:
        url += "&" + external_ref_param.lstrip("?&")
    return url


async def resolve_contact_id_by_platform_user(
    db,
    *,
    client_id: int,
    platform_slug: str,
    platform_user_id: str,
) -> Optional[int]:
    """Находит contact_id (главного, с учётом merged_into) по идентичности
    на платформе. Используется в /landing-redirect, чтобы подсунуть в URL
    стороннего лендинга готовый ID без участия фронта."""
    if not platform_user_id:
        return None
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
        if not row:
            return None
        return row["merged_into"] or row["id"]
    except Exception:
        return None
