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


# ── Сериализация ────────────────────────────────────────────────────────────

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
            # Что показать клиенту в инструкции по DNS
            "dns_instruction": {
                "type": "CNAME",
                "host": row["domain"],
                "value": cd.normalize_domain(cd.platform_base_url()),
                "note": "Если провайдер не даёт CNAME на корне домена — "
                        f"поставьте A-запись на {cmd.SENDING_IP}",
            },
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
