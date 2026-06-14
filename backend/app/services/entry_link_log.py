"""Лог «по какой ссылке зашёл человек».

Пишется ПЕРВОЙ строкой в каждом входном обработчике (TG /start, VK /vk/event,
MAX webhook, веб landing-redirect) — ДО создания контакта/участника, пока сырой
параметр ссылки ещё на руках и ничего не потеряно.

Зачем: VK при «холодном» открытии Mini App иногда теряет startParam (hash после
#) — тогда рефовод (pid) не доезжает до сервера. Этот лог фиксирует сырьё КАЖДОГО
захода независимо от того, создался ли участник. По нему видно по факту: пришёл
ли pid от платформы или нет → можно восстановить рефовода вручную.

Дизайн: best-effort. Любая ошибка логирования НЕ должна ронять основной поток —
оборачиваем в try/except и проглатываем.
"""
import json
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def _parse_pid_slug(raw: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Грубо вытаскивает slug и pid из сырого параметра.

    Понимает форматы: `ref_pg{slug}_pid{ref}_...`, `evl_{slug}_pid{ref}_...`,
    `m_{slug}_pid{ref}`, `p_{slug}_pid{ref}`. Если не распарсилось — None.
    Это только для удобного просмотра; полная истина всегда в raw_param.
    """
    if not raw:
        return None, None
    slug = None
    pid = None
    s = raw
    for prefix in ("ref_pg", "evl_", "m_", "p_"):
        if s.startswith(prefix):
            s2 = s[len(prefix):]
            parts = s2.split("_")
            if parts:
                slug = parts[0] or None
            break
    for p in raw.split("_"):
        if p.startswith("pid") and len(p) > 3:
            pid = p[3:]
            break
    return slug, pid


async def log_entry_link(
    db,
    *,
    platform: str,
    platform_user_id: Optional[str] = None,
    raw_param: Optional[str] = None,
    launch_params: Optional[dict] = None,
    parsed_slug: Optional[str] = None,
    parsed_pid: Optional[str] = None,
) -> None:
    """Пишет одну строку в entry_link_log. Никогда не бросает наружу.

    db — asyncpg connection ИЛИ pool-acquire-совместимый объект с .execute.
    """
    try:
        if parsed_slug is None or parsed_pid is None:
            s, p = _parse_pid_slug(raw_param)
            parsed_slug = parsed_slug or s
            parsed_pid = parsed_pid or p
        lp_json = json.dumps(launch_params) if launch_params else None
        await db.execute(
            """INSERT INTO entry_link_log
                 (platform, platform_user_id, raw_param, parsed_slug, parsed_pid, launch_params)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            platform,
            str(platform_user_id) if platform_user_id is not None else None,
            raw_param,
            parsed_slug,
            parsed_pid,
            lp_json,
        )
    except Exception as e:  # noqa: BLE001 — best-effort, не роняем основной поток
        logger.warning("entry_link_log failed (platform=%s, puid=%s): %s",
                       platform, platform_user_id, e)
