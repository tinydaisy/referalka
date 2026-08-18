"""Отдача готового PDF клиенту — общая для лендинга события и продукта.

Точек скачивания две (событие и продукт), а поведение у них обязано совпадать:
одинаковое имя файла, одинаковые заголовки, одинаковый текст ошибки. Держать
это в двух местах — гарантированно получить расхождение при первой же правке.
"""
from __future__ import annotations

import re
from urllib.parse import quote

from fastapi import HTTPException
from fastapi.responses import Response

from app.services.landing_pdf import PdfRenderError, render_landing_pdf


def _safe_filename(base: str) -> str:
    """Имя файла из названия события или продукта.

    ⚠️ Кириллицу НЕ транслитерируем: человек ищет файл глазами, и «Конференция
    ВИДЕНИЕ.pdf» узнаётся сразу, а «konferenciya-videnie.pdf» — нет. Само имя
    уходит в заголовке по RFC 5987 (`filename*`), который понимают все браузеры.
    Режем только то, что ломает файловые системы.
    """
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", base or "").strip()
    name = re.sub(r"\s+", " ", name)[:80].strip()
    return name or "Лендинг"


async def pdf_response(url: str, *, filename_base: str) -> Response:
    """Собрать PDF по адресу и вернуть его на скачивание."""
    try:
        data = await render_landing_pdf(url)
    except PdfRenderError as exc:
        # Текст уже человеческий — показываем клиенту как есть.
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    name = _safe_filename(filename_base)
    ascii_fallback = "landing.pdf"          # для старых клиентов без RFC 5987
    disposition = (
        f'attachment; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{quote(name + '.pdf')}"
    )
    return Response(
        content=data,
        media_type="application/pdf",
        headers={
            "Content-Disposition": disposition,
            # Файл собирается каждый раз заново: лендинг мог измениться минуту назад.
            "Cache-Control": "no-store",
        },
    )
