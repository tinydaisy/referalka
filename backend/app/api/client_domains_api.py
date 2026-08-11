"""
Свои домены клиента (миграция 270) — управление из кабинета.

Клиент подключает:
  • домен для ПУБЛИЧНЫХ страниц (лендинги событий, кабинет спикера и жюри,
    турнирные таблицы, воронки, оферта, политика ПД) — через CNAME;
  • домен для ПОЧТЫ (адрес отправителя рассылок) — через SPF/DKIM/DMARC.

Кабинет клиента (/dashboard) на свой домен НЕ переезжает — там JWT, cookies
и вебхуки платёжек завязаны на один origin.

Гейт — фича `custom_domain` (только по фиче, никогда по tariff_slug).

Endpoints (/api/v1/clients/me/domains):
  GET    /                  — список доменов + что прописать в DNS
  POST   /                  — добавить домен
  POST   /{id}/check-dns    — проверить DNS
  POST   /{id}/issue-cert   — выпустить сертификат (только kind=landing)
  PATCH  /{id}              — настройки отправителя (только kind=mail)
  DELETE /{id}              — отключить домен
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services.assistant_access import assistant_is_restricted
from app.services.features import client_has_feature
from app.services import client_domains as cd
from app.services import client_mail_domain as cmd
from app.services import domain_cert as certs
from app.services import domain_dns as dns

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/clients/me/domains", tags=["Свои домены"])

# Публичный роутер: одна ручка, которой Next.js спрашивает «что показать на
# корне этого домена». Без авторизации — её зовёт серверный код страницы `/`
# ещё до того, как известно, кто пришёл.
public_router = APIRouter(prefix="/public/domain", tags=["Свои домены"])


@public_router.get("/home", summary="Что открывать на корне домена")
async def domain_home(host: str, db: asyncpg.Connection = Depends(get_db)):
    """Путь главной страницы клиентского домена: `/o/62`, `/o/62?tab=about`
    или `/e/{slug}`. `null` → домен не наш, показываем лендинг ПЛЮСОНа.
    """
    return {"path": await cd.domain_home_path(db, host)}


# ── Доступ ──────────────────────────────────────────────────────────────────

async def _assert_feature(db, client_id: int) -> None:
    if not await client_has_feature(db, client_id, "custom_domain"):
        raise HTTPException(
            status_code=403,
            detail="Свой домен доступен на тарифе Экстра. "
                   "Перейдите на него в разделе «Подписка».",
        )


async def _assert_can_edit(user: dict) -> None:
    """Домены меняет только владелец: ошибка тут кладёт публичные страницы."""
    if await assistant_is_restricted(user):
        raise HTTPException(
            status_code=403,
            detail="Настройка домена доступна только владельцу кабинета.",
        )


async def _get_row(db, client_id: int, domain_id: int) -> asyncpg.Record:
    row = await db.fetchrow(
        "SELECT * FROM client_domains WHERE id = $1 AND client_id = $2",
        domain_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Домен не найден")
    return row


# ── Модели ──────────────────────────────────────────────────────────────────

class DomainIn(BaseModel):
    kind: str                       # landing | mail
    domain: str


class MailSettingsIn(BaseModel):
    mail_from_local: Optional[str] = None    # noreply → noreply@домен
    mail_from_name: Optional[str] = None     # отображаемое имя отправителя


class HomePageIn(BaseModel):
    """Что открывать на корне домена: about | events | event (миграция 278)."""
    home_kind: str = "about"
    home_event_id: Optional[int] = None      # только для home_kind='event'


# ── Сериализация ────────────────────────────────────────────────────────────

def _dns_instruction(domain: str) -> dict:
    """Что именно клиенту прописать у регистратора.

    ⚠️ Разные записи для корня и поддомена — не «два способа на выбор»:
    на КОРНЕ домена CNAME невозможен (стандарт DNS: у корня обязаны быть
    NS и SOA, а CNAME означает «других записей нет»). Регистратор такую
    запись просто не сохранит. Раньше кабинет показывал CNAME всем, а
    A-запись прятал в примечание «если провайдер не даёт» — клиент с
    корневым доменом упирался в тупик.
    """
    platform = cd.normalize_domain(cd.platform_base_url())
    if cd.is_apex_domain(domain):
        return {
            "type": "A",
            "host": "@",
            "value": cmd.SENDING_IP,
            "note": f"«@» — это сам домен {domain}. "
                    "CNAME на корне домена поставить нельзя — так устроен "
                    "DNS, поэтому здесь именно A-запись. "
                    "Если у домена уже есть A-запись (обычно на заглушку "
                    "регистратора) — её нужно удалить или изменить на этот IP.",
        }
    return {
        "type": "CNAME",
        "host": domain,
        "value": platform,
        "note": "Если регистратор просит указать только первую часть имени — "
                f"впишите «{domain.split('.')[0]}».",
    }


def _serialize(row: asyncpg.Record) -> dict:
    kind = row["kind"]
    out = {
        "id": row["id"],
        "kind": kind,
        "domain": row["domain"],
        "status": row["status"],
        "is_primary": row["is_primary"],
        "dns_ok": row["dns_ok"],
        "dns_checked_at": row["dns_checked_at"],
        "dns_details": row["dns_details"],
        "last_error": row["last_error"],
        "last_error_at": row["last_error_at"],
    }
    if kind == "landing":
        exp = row["cert_expires_at"]
        out.update({
            "cert_issued_at": row["cert_issued_at"],
            "cert_expires_at": exp,
            "cert_days_left": _days_left(exp),
            # Главная страница домена (миграция 278). Через .get(): если
            # миграция ещё не накатана, колонок нет — отдаём дефолт, а не 500.
            "home_kind": dict(row).get("home_kind") or "about",
            "home_event_id": dict(row).get("home_event_id"),
            # Что показать клиенту в инструкции по DNS.
            # ⚠️ Корню — только A-запись: CNAME на корне запрещён стандартом
            # DNS, его не даст НИ ОДИН регистратор. Поддомену — CNAME: при
            # переезде сервера меняется IP у pluson.ru, и клиентские домены
            # переезжают сами, без просьбы «поправьте у себя запись».
            "dns_instruction": _dns_instruction(row["domain"]),
        })
    else:
        out.update({
            "mail_from_local": row["mail_from_local"],
            "mail_from_name": row["mail_from_name"],
            "dkim_selector": row["dkim_selector"],
            "from_address": f"{row['mail_from_local'] or 'noreply'}@{row['domain']}",
            "dns_records": (
                cmd.dns_records_for(row["domain"], row["dkim_public_key"] or "",
                                    row["dkim_selector"] or cmd.DEFAULT_SELECTOR)
                if row["dkim_public_key"] else []
            ),
        })
    return out


def _days_left(exp: Optional[datetime]) -> Optional[int]:
    if not exp:
        return None
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    return (exp - datetime.now(timezone.utc)).days


# ── Endpoints ───────────────────────────────────────────────────────────────

@router.get("")
async def list_domains(user: dict = Depends(get_current_client),
                       db: asyncpg.Connection = Depends(get_db)):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    rows = await db.fetch(
        "SELECT * FROM client_domains WHERE client_id = $1 ORDER BY kind, id",
        client_id,
    )
    return {
        "domains": [_serialize(r) for r in rows],
        "platform_domain": cd.normalize_domain(cd.platform_base_url()),
    }


@router.post("")
async def add_domain(data: DomainIn,
                     user: dict = Depends(get_current_client),
                     db: asyncpg.Connection = Depends(get_db)):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_edit(user)

    kind = (data.kind or "").strip().lower()
    if kind not in ("landing", "mail"):
        raise HTTPException(status_code=400, detail="Неизвестный тип домена")

    domain, err = cd.validate_domain(data.domain)
    if err:
        raise HTTPException(status_code=400, detail=err)

    busy = await db.fetchrow(
        "SELECT client_id FROM client_domains WHERE domain = $1 AND kind = $2",
        domain, kind,
    )
    if busy:
        if busy["client_id"] == client_id:
            raise HTTPException(status_code=409, detail="Этот домен уже добавлен")
        raise HTTPException(
            status_code=409,
            detail="Домен уже подключён к другому кабинету. "
                   "Если это ваш домен — напишите в поддержку.",
        )

    # Один основной домен каждого вида: новый становится основным,
    # предыдущий теряет флаг (частичный UNIQUE в БД не даст двух сразу).
    async with db.transaction():
        await db.execute(
            "UPDATE client_domains SET is_primary = FALSE, updated_at = NOW() "
            " WHERE client_id = $1 AND kind = $2 AND is_primary",
            client_id, kind,
        )
        row = await db.fetchrow(
            """
            INSERT INTO client_domains (client_id, kind, domain, status, is_primary,
                                        dkim_selector)
            VALUES ($1, $2, $3, 'pending', TRUE, $4)
            RETURNING *
            """,
            client_id, kind, domain,
            cmd.DEFAULT_SELECTOR if kind == "mail" else None,
        )

    # Для почты ключ нужен сразу — клиент должен увидеть, что класть в DNS.
    if kind == "mail":
        try:
            public_key = cmd.generate_dkim_key(domain)
            row = await db.fetchrow(
                "UPDATE client_domains SET dkim_public_key = $2, updated_at = NOW() "
                " WHERE id = $1 RETURNING *",
                row["id"], public_key,
            )
        except cmd.MailDomainError as e:
            logger.warning("DKIM для %s не создан: %s", domain, e)
            row = await db.fetchrow(
                "UPDATE client_domains SET status='error', last_error=$2, "
                "       last_error_at=NOW(), updated_at=NOW() "
                " WHERE id = $1 RETURNING *",
                row["id"], str(e),
            )

    cd.invalidate_cache(client_id=client_id, domain=domain)
    return _serialize(row)


@router.post("/{domain_id}/check-dns")
async def check_dns(domain_id: int,
                    user: dict = Depends(get_current_client),
                    db: asyncpg.Connection = Depends(get_db)):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    row = await _get_row(db, client_id, domain_id)

    domain = row["domain"]
    if row["kind"] == "landing":
        result = await dns.check_landing_dns(
            domain,
            expect_host=cd.normalize_domain(cd.platform_base_url()),
            expect_ip=cmd.SENDING_IP,
        )
        ok = result["ok"]
        details = result
    else:
        result = await dns.check_mail_dns(
            domain,
            dkim_selector=row["dkim_selector"] or cmd.DEFAULT_SELECTOR,
            dkim_public=row["dkim_public_key"],
            spf_include=cmd.SPF_INCLUDE_DOMAIN,
            sending_ip=cmd.SENDING_IP,
        )
        ok = result["ok"]
        details = result

    # Почта включается сразу после успешной проверки — сертификат ей не нужен.
    # Лендингу нужен ещё выпуск сертификата, поэтому только dns_ok.
    if ok and row["kind"] == "mail":
        new_status = "active"
    elif ok:
        new_status = "dns_ok" if row["status"] != "active" else "active"
    else:
        new_status = "pending" if row["status"] != "active" else "active"

    if ok and row["kind"] == "mail":
        # Подпись ставит OpenDKIM — домен должен быть в его таблицах.
        try:
            cmd.register_domain_in_opendkim(domain,
                                            row["dkim_selector"] or cmd.DEFAULT_SELECTOR)
        except cmd.MailDomainError as e:
            logger.error("OpenDKIM не принял домен %s: %s", domain, e)
            new_status = "error"
            await db.execute(
                "UPDATE client_domains SET last_error=$2, last_error_at=NOW() WHERE id=$1",
                domain_id, str(e),
            )

    import json
    updated = await db.fetchrow(
        """
        UPDATE client_domains
           SET dns_ok = $2, dns_checked_at = NOW(), dns_details = $3::jsonb,
               status = $4, updated_at = NOW()
         WHERE id = $1
        RETURNING *
        """,
        domain_id, ok, json.dumps(details, default=str), new_status,
    )
    cd.invalidate_cache(client_id=client_id, domain=domain)
    return {"result": details, "domain": _serialize(updated)}


@router.post("/{domain_id}/issue-cert")
async def issue_cert(domain_id: int,
                     user: dict = Depends(get_current_client),
                     db: asyncpg.Connection = Depends(get_db)):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_edit(user)
    row = await _get_row(db, client_id, domain_id)

    if row["kind"] != "landing":
        raise HTTPException(status_code=400,
                            detail="Сертификат нужен только домену страниц")

    # ⚠️ Пока DNS не сошёлся — не пускаем. Let's Encrypt даёт 5 неудачных
    # попыток в час на домен: если дать жать по неготовому DNS, клиент
    # упрётся в лимит и не сможет выпустить сертификат ещё час — уже тогда,
    # когда DNS наконец дойдёт.
    if not row["dns_ok"]:
        raise HTTPException(
            status_code=400,
            detail="Сначала проверьте DNS — сертификат выпускается только "
                   "после того, как домен начал вести на нас.",
        )

    domain = row["domain"]
    try:
        expires = certs.issue_certificate(domain)
    except certs.CertError as e:
        await db.execute(
            "UPDATE client_domains SET status='error', last_error=$2, "
            "       last_error_at=NOW(), updated_at=NOW() WHERE id=$1",
            domain_id, str(e),
        )
        raise HTTPException(status_code=400, detail=str(e))

    updated = await db.fetchrow(
        """
        UPDATE client_domains
           SET status='active', cert_issued_at = NOW(), cert_expires_at = $2,
               cert_name = $3, last_error = NULL, last_error_at = NULL,
               updated_at = NOW()
         WHERE id = $1
        RETURNING *
        """,
        domain_id, expires, certs.cert_name_for(domain),
    )
    cd.invalidate_cache(client_id=client_id, domain=domain)
    return _serialize(updated)


@router.patch("/{domain_id}")
async def update_domain(domain_id: int, data: MailSettingsIn,
                        user: dict = Depends(get_current_client),
                        db: asyncpg.Connection = Depends(get_db)):
    """Настройки отправителя писем: локальная часть адреса и имя."""
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_edit(user)
    row = await _get_row(db, client_id, domain_id)

    if row["kind"] != "mail":
        raise HTTPException(status_code=400,
                            detail="Эти настройки есть только у почтового домена")

    fs = data.model_fields_set
    sets, args = [], []

    if "mail_from_local" in fs:
        local = (data.mail_from_local or "noreply").strip().lower()
        import re as _re
        if not _re.match(r"^[a-z0-9][a-z0-9._-]{0,62}$", local):
            raise HTTPException(
                status_code=400,
                detail="В адресе до @ можно использовать латиницу, цифры, точку, "
                       "дефис и подчёркивание",
            )
        args.append(local)
        sets.append(f"mail_from_local = ${len(args)}")

    if "mail_from_name" in fs:
        args.append((data.mail_from_name or "").strip() or None)
        sets.append(f"mail_from_name = ${len(args)}")

    if not sets:
        return _serialize(row)

    args.append(domain_id)
    updated = await db.fetchrow(
        f"UPDATE client_domains SET {', '.join(sets)}, updated_at = NOW() "
        f" WHERE id = ${len(args)} RETURNING *",
        *args,
    )
    cd.invalidate_cache(client_id=client_id, domain=row["domain"])
    return _serialize(updated)


@router.put("/{domain_id}/home", summary="Главная страница домена")
async def set_domain_home(domain_id: int, data: HomePageIn,
                          user: dict = Depends(get_current_client),
                          db: asyncpg.Connection = Depends(get_db)):
    """Что открывается на КОРНЕ домена (миграция 278).

    events — витрина событий, about — витрина на вкладке «О проекте»,
    event — лендинг конкретного события клиента.
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_edit(user)
    row = await _get_row(db, client_id, domain_id)

    if row["kind"] != "landing":
        raise HTTPException(status_code=400,
                            detail="Главная страница есть только у домена страниц")

    kind = (data.home_kind or "about").strip()
    if kind not in ("events", "about", "event"):
        raise HTTPException(status_code=400, detail="Неизвестный тип главной страницы")

    event_id = data.home_event_id if kind == "event" else None
    if kind == "event":
        if not event_id:
            raise HTTPException(status_code=400, detail="Выберите событие")
        # ⚠️ Проверяем ВЛАДЕНИЕ: иначе, зная id, можно было бы повесить на свой
        # домен чужой лендинг — и продавать чужое событие под своим брендом.
        owns = await db.fetchval(
            """SELECT 1 FROM event_owners
                WHERE event_id = $1 AND client_id = $2 AND status = 'accepted'""",
            event_id, client_id,
        )
        if not owns:
            raise HTTPException(status_code=404, detail="Событие не найдено")

    updated = await db.fetchrow(
        """UPDATE client_domains
              SET home_kind = $1, home_event_id = $2, updated_at = NOW()
            WHERE id = $3
        RETURNING *""",
        kind, event_id, domain_id,
    )
    cd.invalidate_cache(client_id=client_id, domain=row["domain"])
    return _serialize(updated)


@router.get("/home-events", summary="События для выбора главной страницы")
async def home_events(user: dict = Depends(get_current_client),
                      db: asyncpg.Connection = Depends(get_db)):
    """События клиента с опубликованным лендингом — их можно поставить на корень.

    ⚠️ Только те, у кого лендинг реально опубликован: поставить на главную
    черновик значит отдать посетителям 404.
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    rows = await db.fetch(
        """
        SELECT e.id, e.title, e.slug, e.start_at, e.status
          FROM events e
          JOIN event_owners eo
            ON eo.event_id = e.id AND eo.client_id = $1 AND eo.status = 'accepted'
         WHERE EXISTS (SELECT 1 FROM event_landing_pages lp
                        WHERE lp.event_id = e.id
                          AND lp.kind = 'main'
                          AND lp.is_published)
      ORDER BY COALESCE(e.start_at, e.created_at) DESC
         LIMIT 100
        """,
        client_id,
    )
    return {"items": [dict(r) for r in rows]}


@router.delete("/{domain_id}")
async def delete_domain(domain_id: int,
                        user: dict = Depends(get_current_client),
                        db: asyncpg.Connection = Depends(get_db)):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_edit(user)
    row = await _get_row(db, client_id, domain_id)

    domain, kind = row["domain"], row["kind"]
    try:
        if kind == "landing":
            certs.revoke_domain(domain)
        else:
            cmd.unregister_domain_from_opendkim(domain)
    except Exception as e:
        # Запись всё равно удаляем: клиент нажал «отключить», и висящая
        # строка сделала бы домен неотключаемым. Мусор на сервере разгребём.
        logger.warning("Не удалось до конца отключить %s: %r", domain, e)

    await db.execute("DELETE FROM client_domains WHERE id = $1", domain_id)
    cd.invalidate_cache(client_id=client_id, domain=domain)
    return {"ok": True}
