"""Веб-регистрация спикером / номинантом — БЕЗ мессенджеров (2026-08-27).

Зачем. Самозапись в состав до сих пор жила только в ботах
(`spkreg_{event_id}` в TG/VK/MAX, [speaker_self_register.py]). У клиента без
подключённых ботов — а модуль «Премии/Турниры» покупают именно ради
организации работы, отдельно от рассылок — ссылки не было вовсе: состав
приходилось заводить руками по одному.

Здесь тот же сценарий на обычной веб-странице: человек заполняет форму,
получает карточку в событии и сразу попадает в свой кабинет.

⚠️ Карточку создаёт ТА ЖЕ `complete_speaker_self_register`, что и боты.
Второй реализации быть не должно: дефолтные тумблеры, номинации по умолчанию
и правило «один коллаб на контакт» живут там, и копия неминуемо разъедётся.

⚠️ Человек резолвится через `upsert_contact_with_identity` по email — своих
SELECT по почте здесь нет, иначе тот же человек заведётся вторым контактом
(см. правило «Резолв контакта — единая точка»).

⚠️ Модуль не гейтим: это публичная страница для приглашённого человека, а не
запись организатора. Как и в ботах — организатор сам решил дать ссылку.
"""
import logging
import re
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/public/speaker-signup", tags=["Веб-регистрация в состав"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$")

NAME_LIMIT = 80
EMAIL_LIMIT = 190
PHONE_LIMIT = 40
TG_LIMIT = 64


async def _load_event(db: asyncpg.Connection, event_slug: str) -> dict:
    """Событие + его клиент-владелец. 404, если события нет."""
    row = await db.fetchrow(
        """SELECT e.id, e.slug, e.title, e.person_wording,
                  (SELECT eo.client_id FROM event_owners eo
                    WHERE eo.event_id = e.id AND eo.status = 'accepted'
                    ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id
             FROM events e WHERE e.slug = $1""",
        event_slug,
    )
    if not row or not row["client_id"]:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return dict(row)


@router.get("/{event_slug}", summary="Данные для страницы веб-регистрации в состав")
async def signup_info(event_slug: str, db: asyncpg.Connection = Depends(get_db)):
    ev = await _load_event(db, event_slug)
    client_id = ev["client_id"]

    cl = await db.fetchrow(
        """SELECT COALESCE(NULLIF(btrim(brand_name), ''), name) AS brand,
                  brand_logo_url, profile_photo_url
             FROM clients WHERE id = $1""",
        client_id,
    )

    # Ссылка на политику ПД — на домене клиента, как и вся страница.
    privacy_url = None
    try:
        from app.services.client_domains import client_public_link
        privacy_url = await client_public_link(db, client_id, f"/c/{client_id}/privacy")
    except Exception:
        logger.exception("speaker-signup: не собралась ссылка на политику")

    # Афиша события — чтобы страница не выглядела пустым бланком.
    # ⚠️ Общая афиша (day IS NULL): дневная подменила бы её на расписание дня.
    poster = await db.fetchval(
        """SELECT url FROM event_posters
            WHERE event_id = $1 AND day IS NULL
            ORDER BY CASE orientation WHEN 'horizontal' THEN 1 WHEN 'square' THEN 2 ELSE 3 END,
                     sort, id
            LIMIT 1""",
        ev["id"],
    )

    return {
        "event_id": ev["id"],
        "event_slug": ev["slug"],
        "event_title": ev["title"],
        "person_wording": ev["person_wording"] or "speaker",
        "brand": (dict(cl)["brand"] if cl else None),
        "brand_logo_url": (cl["brand_logo_url"] if cl else None),
        "poster_url": poster,
        "privacy_url": privacy_url,
    }


class SignupIn(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    telegram_username: Optional[str] = None
    phone: Optional[str] = None
    consent_pd: bool = False


@router.post("/{event_slug}", summary="Зарегистрироваться в состав через веб-форму")
async def signup(
    event_slug: str,
    data: SignupIn,
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    ev = await _load_event(db, event_slug)
    client_id = ev["client_id"]

    first_name = (data.first_name or "").strip()[:NAME_LIMIT]
    last_name = (data.last_name or "").strip()[:NAME_LIMIT]
    email = (data.email or "").strip().lower()[:EMAIL_LIMIT]
    tg = (data.telegram_username or "").strip().lstrip("@")[:TG_LIMIT]
    phone = (data.phone or "").strip()[:PHONE_LIMIT] or None

    # Согласие обязательно — это форма сбора персональных данных (152-ФЗ).
    if not data.consent_pd:
        raise HTTPException(
            status_code=400,
            detail="Без согласия на обработку персональных данных зарегистрироваться нельзя",
        )
    if not first_name:
        raise HTTPException(status_code=422, detail="Укажите имя")
    if not last_name:
        raise HTTPException(status_code=422, detail="Укажите фамилию")
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail="Укажите корректный email")
    if not tg:
        raise HTTPException(status_code=422, detail="Укажите ник в Telegram")
    # Ник Telegram: латиница, цифры и подчёркивания.
    if not re.match(r"^[A-Za-z0-9_]{3,64}$", tg):
        raise HTTPException(
            status_code=422,
            detail="Ник в Telegram — латинские буквы, цифры и «_», без пробелов. Например: ivanov",
        )

    from app.services.contact_merge import (
        upsert_contact_with_identity, set_contact_phone,
    )
    from app.api.collaborators import (
        _upsert_personal_identity, _raise_if_identity_collision,
    )
    from app.services.speaker_self_register import complete_speaker_self_register
    from app.services.collaborator_participant import ensure_collaborator_participant

    # ── Кто пришёл ────────────────────────────────────────────────────────
    # Идентичность — email: единственный канал связи, когда мессенджеров нет.
    # Ник дополнительно ищет уже существующий контакт (lookup_*), чтобы человек,
    # известный клиенту по боту, не завёлся вторым.
    contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
        db,
        client_id=client_id,
        platform_slug="email",
        platform_user_id=email,
        first_name=first_name,
        last_name=last_name,
        email=email,
        phone=phone,
        lookup_telegram_username=tg,
    )

    # Телефон — только через общий хелпер: рядом обязан обновляться
    # phone_normalized, по нему ищутся дубли.
    if phone:
        try:
            await set_contact_phone(db, contact_id=contact_id, phone=phone)
        except Exception:
            logger.exception("speaker-signup: телефон не записался (contact=%s)", contact_id)

    # Псевдо-идентичность Telegram (`@ник`): резолвится в настоящий аккаунт
    # сама, когда человек однажды зайдёт в бот клиента.
    try:
        res_tg = await _upsert_personal_identity(
            db, client_id, contact_id, "telegram", None, tg)
        await _raise_if_identity_collision(db, client_id, "telegram", res_tg)
    except HTTPException as e:
        # Ник занят другим человеком — говорим об этом прямо, а не молча
        # цепляем карточку к чужому контакту.
        raise HTTPException(status_code=409, detail=str(e.detail))
    except Exception:
        logger.exception("speaker-signup: ник не записался (contact=%s)", contact_id)

    # Согласие фиксируем с IP и временем — как в остальных формах.
    ip = (request.client.host if request and request.client else "") or ""
    await db.execute(
        """UPDATE contacts
              SET consent_pd_at = COALESCE(consent_pd_at, NOW()),
                  consent_pd_ip = COALESCE(consent_pd_ip, $2)
            WHERE id = $1""",
        contact_id, ip[:64],
    )

    # ── Карточка в событии ────────────────────────────────────────────────
    try:
        collaborator_id, access_code, _slug, already = await complete_speaker_self_register(
            db,
            event_id=ev["id"],
            client_id=client_id,
            contact_id=contact_id,
            contact_name=f"{first_name} {last_name}".strip(),
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # Имя и фамилия — раздельными полями (миграция 302). Заполняем пустое,
    # уже введённое человеком в кабинете не перетираем.
    await db.execute(
        """UPDATE collaborators
              SET name = CASE WHEN COALESCE(btrim(name), '') = '' THEN $2 ELSE name END,
                  last_name = CASE WHEN COALESCE(btrim(last_name), '') = '' THEN $3 ELSE last_name END
            WHERE id = $1""",
        collaborator_id, first_name, last_name,
    )

    await ensure_collaborator_participant(
        db, event_id=ev["id"], collaborator_id=collaborator_id)

    se_id = await db.fetchval(
        "SELECT id FROM event_collaborators WHERE event_id = $1 AND speaker_id = $2",
        ev["id"], collaborator_id,
    )
    if not se_id:
        raise HTTPException(status_code=500, detail="Карточка не создалась, попробуйте ещё раз")

    # Сразу пускаем в кабинет: код доступа вводить незачем, человек только что
    # подтвердил себя формой. Код всё равно показываем и шлём письмом — он
    # понадобится, чтобы вернуться позже.
    from app.api.speaker_cabinet import _sign
    token = _sign(se_id, collaborator_id, ev["id"])

    email_sent = await _send_access_email(
        db, client_id=client_id, contact_id=contact_id, to_email=email,
        event_slug=ev["slug"], event_title=ev["title"],
        person_wording=ev["person_wording"], access_code=access_code,
    )

    return {
        "ok": True,
        "already": bool(already),
        "speaker_event_id": se_id,
        "access_code": access_code,
        "token": token,
        "cabinet_path": f"/speaker/{ev['slug']}",
        "email_sent": email_sent,
    }


async def _send_access_email(
    db: asyncpg.Connection, *, client_id: int, contact_id: int, to_email: str,
    event_slug: str, event_title: str, person_wording: Optional[str],
    access_code: str,
) -> bool:
    """Письмо с доступом в кабинет. True — ушло.

    ⚠️ Это единственный способ вернуться в кабинет позже: мессенджеров у
    человека может не быть вовсе, ради чего вся эта ссылка и делалась.
    Ошибку глушим — регистрация уже состоялась, ронять её из-за письма нельзя.
    """
    try:
        from app.services.email_sender import EmailSender
        from app.services.unsubscribe_token import make_email_unsubscribe_token
        from app.services.client_domains import client_public_url, public_url_for
        from app.services.person_wording import wording

        ch = await db.fetchrow(
            """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                      ch.email_subdomain, ch.email_from_local, ch.email_from_name
                 FROM client_channels cc
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1 AND cc.is_active = TRUE
                  AND ch.platform_slug = 'email'
                LIMIT 1""",
            client_id,
        )
        if not ch:
            return False

        brand = await db.fetchval(
            "SELECT COALESCE(NULLIF(btrim(brand_name), ''), name) FROM clients WHERE id = $1",
            client_id,
        ) or "ПЛЮСОН"

        w = wording(person_wording)
        base = await client_public_url(db, client_id)
        cabinet_url = public_url_for(base, f"speaker/{event_slug}")

        unsub = make_email_unsubscribe_token(
            client_id=client_id, contact_id=contact_id,
            client_channel_id=ch["client_channel_id"],
        )

        # Свой почтовый домен клиента (миграция 270): письмо уходит от его
        # бренда, и отписка ведёт туда же. ⚠️ Колонки `email_domain` в
        # `channels` нет — домен подставляется этим хелпером.
        channel_dict = dict(ch)
        try:
            from app.services.client_domains import client_mail_domain
            _mail = await client_mail_domain(db, client_id)
            if _mail:
                channel_dict["email_domain"] = _mail["domain"]
                channel_dict["email_from_local"] = _mail["local"]
                if _mail["from_name"]:
                    channel_dict["email_from_name"] = _mail["from_name"]
        except Exception:
            logger.exception("speaker-signup: почтовый домен клиента не подставился")

        subject = f"Вы в составе {w['plural_gen']} — «{event_title}»"
        body = (
            f"Здравствуйте!\n\n"
            f"Вы зарегистрировались в состав {w['plural_gen']} события «{event_title}».\n\n"
            f"Ваш кабинет: {cabinet_url}\n"
            f"Код доступа: {access_code}\n\n"
            f"В кабинете заполните карточку: фото, позиционирование, регалии — "
            f"её увидят зрители и организаторы.\n\n"
            f"Чтобы войти: откройте ссылку, выберите свою фамилию из списка и "
            f"введите код доступа. Сохраните это письмо — код понадобится "
            f"каждый раз при входе с нового устройства.\n\n"
            f"— {brand}"
        )

        EmailSender().send(
            channel=channel_dict,
            client_brand_name=brand,
            to_email=to_email,
            subject=subject,
            body_text=body,
            unsubscribe_token=unsub,
            public_base_url=base,
        )
        return True
    except Exception:
        logger.exception("speaker-signup: письмо с доступом не ушло (contact=%s)", contact_id)
        return False
