"""
Текст с сайта → в наш бот. ОДИН механизм на весь проект.

Задача, которая повторяется везде: человек на сайте пишет что ему нужно —
и это написанное должно оказаться в боте, у нас перед глазами. Услуги
(«опишите, что вы хотите»), автонастройка, техподдержка — всюду одно и то же.

⚠️⚠️ ПОЧЕМУ ТЕКСТ НЕ ЕДЕТ В ССЫЛКЕ. В `?start=` у Telegram помещается 64
символа и только [A-Za-z0-9_-] — кириллица ссылку просто ломает, она не
откроется (тот же разбор в support_link.py). Поэтому:

    текст остаётся в базе → в ссылку уезжает короткий токен
    → бот по токену забирает текст и показывает его

Побочная польза: текст не теряется, даже если человек нажмёт «Открыть бота»
и дойдёт до него через час. И мы видим написанное ДО того, как он заговорит.

⚠️ ПЛОЩАДКИ И ИМЕНА ПАРАМЕТРОВ берём из support_link.PLATFORMS — второго
словаря соответствий в проекте быть не должно. У Telegram и MAX параметр
`start`, у ВКонтакте `ref`; ВК пока выключен и показывается как «скоро».
"""
import secrets
from typing import Optional

from app.services.support_link import PLATFORMS

# ⚠️ Префикс обязателен: по нему бот отличает «человек пришёл с текстом» от
# всех прочих start-параметров (ref_pg…, bpr_…, question и других). Меняя его,
# надо менять и разбор в ботах всех трёх площадок.
TOKEN_PREFIX = "txt_"

# 12 символов из [a-z0-9] — этого хватает: токен живёт минуты, ничего не
# открывает сам по себе и виден только тому, кто его создал.
_TOKEN_LEN = 12
_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

# Сколько текста принимаем. Больше человек в форму и не напишет, а защищаться
# от гигантской вставки всё равно надо.
MAX_TEXT = 4000


def _new_token() -> str:
    body = "".join(secrets.choice(_ALPHABET) for _ in range(_TOKEN_LEN))
    return f"{TOKEN_PREFIX}{body}"


def is_text_token(payload: str) -> bool:
    """Это start-параметр с текстом? Проверка для ботов всех площадок."""
    return bool(payload) and payload.strip().startswith(TOKEN_PREFIX)


async def save_text(
    db,
    *,
    text: str,
    kind: str = "service",
    name: Optional[str] = None,
    contact_hint: Optional[str] = None,
    client_id: Optional[int] = None,
    contact_id: Optional[int] = None,
) -> str:
    """Сохраняет написанное и возвращает токен для ссылки.

    `kind` — откуда пришло: `service` (услуги), `autosetup`, `support`. По нему
    бот решает, каким текстом встретить человека.
    """
    text = (text or "").strip()[:MAX_TEXT]
    if not text:
        raise ValueError("Пустой текст")

    # Повтор токена практически невозможен, но вставка всё равно должна быть
    # надёжной: пробуем несколько раз, а не падаем на случайном совпадении.
    for _ in range(5):
        token = _new_token()
        row = await db.fetchrow(
            """INSERT INTO bot_text_requests
                   (token, kind, text, name, contact_hint, client_id, contact_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (token) DO NOTHING
               RETURNING token""",
            token, kind, text, name, contact_hint, client_id, contact_id,
        )
        if row:
            return row["token"]
    raise RuntimeError("Не удалось создать токен")


async def take_text(db, token: str, *, platform: str) -> Optional[dict]:
    """Бот забирает текст по токену.

    ⚠️ Не удаляем и не «гасим» запись: человек может открыть ссылку дважды
    (нажал, свернул, вернулся) — и второй раз тоже должен увидеть свой текст.
    Отмечаем только время первого открытия и площадку, чтобы видеть, куда люди
    на самом деле идут.
    """
    token = (token or "").strip()
    if not is_text_token(token):
        return None

    row = await db.fetchrow(
        """UPDATE bot_text_requests
              SET opened_at = COALESCE(opened_at, NOW()),
                  platform  = COALESCE(platform, $2)
            WHERE token = $1
        RETURNING id, kind, text, name, contact_hint, client_id, contact_id,
                  created_at""",
        token, platform,
    )
    return dict(row) if row else None


def bot_links(token: str) -> list[dict]:
    """Ссылки во все наши боты с этим токеном.

    Возвращает список для экрана: слаг, название, ссылка, подключена ли
    площадка. Выключенную (ВК) отдаём с пустой ссылкой — экран покажет её
    серой, и ничего не сломается.
    """
    out: list[dict] = []
    for slug, cfg in PLATFORMS.items():
        enabled = bool(cfg.get("base")) and cfg.get("enabled") is not False
        out.append({
            "slug": slug,
            "label": cfg["label"],
            "enabled": enabled,
            "url": f"{cfg['base']}?{cfg['param']}={token}" if enabled else "",
        })
    return out
