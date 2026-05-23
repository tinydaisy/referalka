"""
Отправка email-писем через локальный Postfix (127.0.0.1:25).

Postfix настроен с loopback-only inet_interfaces — поэтому подключение
без auth (mynetworks=127.0.0.0/8). OpenDKIM milter автоматически
добавляет DKIM-подпись ко всем исходящим (для домена pluson.ru и его
поддоменов).

Каждое письмо содержит:
- Stable Message-ID с доменом отправителя
- Date в правильном RFC формате
- DKIM-подпись (через OpenDKIM milter)
- Подвал с ссылкой отписки (HTML + plain-text)
- Заголовок List-Unsubscribe с URL отписки
- Заголовок List-Unsubscribe-Post для Gmail one-click отписки

Использование:
    from app.services.email_sender import EmailSender, EmailSendError

    sender = EmailSender()
    try:
        msg_id = sender.send(
            channel=channel_row,                # запись из channels (платформа email)
            client_brand_name="iVision Конференция",
            to_email="user@example.com",
            subject="Завтра встречаемся!",
            body_text="Привет, Маргарита!\n\nЗавтра в 11:00...",
            unsubscribe_token="eyJ...",         # из make_email_unsubscribe_token
            body_html=None,                     # опционально HTML-версия (пока не используется)
        )
    except EmailSendError as e:
        # SMTP-ошибка / отправить не удалось
        ...
"""
import logging
import smtplib
import socket
from email.mime.base import MIMEBase
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate, make_msgid
from typing import Optional

from app.config import settings

# Тип одного inline-вложения для встроенных картинок в письма.
# bytes — сами байты картинки, content_id — без угловых скобок ("img1"),
# subtype — "jpeg" / "png" / "gif".
InlineImage = dict  # {"content_id": str, "data": bytes, "subtype": str}

logger = logging.getLogger(__name__)


# Локальный Postfix всегда слушает 127.0.0.1:25 (см. /etc/postfix/main.cf:
# inet_interfaces = loopback-only).
SMTP_HOST = "127.0.0.1"
SMTP_PORT = 25
SMTP_TIMEOUT_SEC = 30


class EmailSendError(Exception):
    """Любая ошибка отправки email — SMTPException / socket / etc."""


def _build_from_address(channel: dict) -> str:
    """
    Финальный email-адрес отправителя.
    - email_subdomain == NULL → systемный канал → '<local>@pluson.ru'
    - email_subdomain != NULL → '<local>@<subdomain>.pluson.ru'
    """
    local = (channel.get("email_from_local") or "noreply").strip()
    subdomain = (channel.get("email_subdomain") or "").strip()
    if subdomain:
        return f"{local}@{subdomain}.pluson.ru"
    return f"{local}@pluson.ru"


def _build_from_header(channel: dict, client_brand_name: Optional[str]) -> str:
    """
    Формирует значение заголовка From в RFC 5322-совместимом формате.
    - Имя берётся из channel.email_from_name (если задано),
      иначе client_brand_name, иначе просто email без имени.
    - Используется email.utils.formataddr — он сам корректно квотирует
      display-name и кодирует не-ASCII в RFC 2047.
    - Двоеточие «:» в display-name заменяется на тире, иначе Gmail парсит
      «iViSiON: ПЛЮСОН» как RFC 5322 group-syntax (group_name: addrs;)
      и отвечает 550-5.7.1 «multiple addresses in From: header».
    """
    addr = _build_from_address(channel)
    name = (channel.get("email_from_name") or "").strip() or (client_brand_name or "").strip()
    if not name:
        return addr
    # Защита от group-syntax парсинга: : и ; в display-name → " — "
    safe_name = name.replace(":", " —").replace(";", ",")
    return formataddr((safe_name, addr))


def _unsubscribe_url(token: str) -> str:
    """https://pluson.ru/api/v1/email/unsubscribe?token=..."""
    base = settings.frontend_url.rstrip("/")
    return f"{base}/api/v1/email/unsubscribe?token={token}"


def _build_plain_footer(unsub_url: str) -> str:
    # В plain-варианте гипер-ссылку не сделаешь, поэтому пишем URL открытым.
    # Большинство клиентов автоматически превращают такие URL в кликабельные.
    return (
        "\n\n"
        "---\n"
        "Если вы больше не хотите получать письма — отпишитесь по ссылке:\n"
        f"{unsub_url}"
    )


def _build_html_footer(unsub_url: str) -> str:
    # В HTML «отписаться» — гипер-ссылка, URL не показывается явно.
    return (
        '<hr style="margin-top:32px;border:none;border-top:1px solid #eee;">'
        '<p style="color:#999;font-size:12px;line-height:1.5;margin:16px 0;text-align:center;">'
        f'Если вы больше не хотите получать письма — '
        f'<a href="{unsub_url}" style="color:#3D8CB6;text-decoration:underline;">отписаться</a>.'
        "</p>"
    )


def _plain_to_html(text: str) -> str:
    """Превращает plain-текст в простой HTML:
    - экранирует <, >, &
    - переносы строк → <br>
    - URL http(s)://… → <a href="…">…</a>
    Используется когда у нас нет готовой HTML-версии тела письма, но мы
    всё равно хотим отправить multipart/alternative с красивой HTML-частью
    (где гипер-ссылка «отписаться» — это слово, а не голый URL).
    """
    import re as _re
    if not text:
        return ""
    escaped = (text
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;"))
    linked = _re.sub(
        r'(https?://[^\s<]+)',
        r'<a href="\1" style="color:#3D8CB6;text-decoration:underline;">\1</a>',
        escaped,
    )
    return linked.replace("\n", "<br>\n")


def _wrap_html_body(inner_html: str) -> str:
    """Оборачивает «голый» HTML в полный документ с шапкой и centered-контейнером.
    Применяется когда у нас был только plain-text → автогенерируем HTML."""
    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '</head><body style="margin:0;padding:20px;background:#f6f8fa;">'
        '<div style="font-family:Roboto,-apple-system,BlinkMacSystemFont,sans-serif;'
        'font-size:15px;line-height:1.55;color:#25455D;max-width:640px;margin:0 auto;'
        'background:#fff;padding:24px;border-radius:16px;">'
        f'{inner_html}'
        '</div></body></html>'
    )


class EmailSender:
    """
    Тонкая обёртка над smtplib для отправки через локальный Postfix.

    Постфикс не требует auth для loopback. Если на сервере его нет —
    .send() кинет EmailSendError (вызывающий код сам решает что делать —
    retry / failed-лог / тихий пропуск).
    """

    def __init__(self, host: str = SMTP_HOST, port: int = SMTP_PORT,
                 timeout: int = SMTP_TIMEOUT_SEC):
        self.host = host
        self.port = port
        self.timeout = timeout

    def send(
        self,
        *,
        channel: dict,
        client_brand_name: Optional[str],
        to_email: str,
        subject: str,
        body_text: str,
        unsubscribe_token: str,
        body_html: Optional[str] = None,
        inline_images: Optional[list] = None,
    ) -> str:
        """
        Отправляет одно письмо. Возвращает Message-ID при успехе.
        Кидает EmailSendError при любой проблеме.
        """
        if not to_email or "@" not in to_email:
            raise EmailSendError(f"Невалидный email получателя: {to_email!r}")
        if not subject:
            subject = "(без темы)"

        from_address = _build_from_address(channel)
        from_header = _build_from_header(channel, client_brand_name)
        unsub_url = _unsubscribe_url(unsubscribe_token)
        msg_id = make_msgid(domain=from_address.split("@", 1)[1])

        plain_body = (body_text or "") + _build_plain_footer(unsub_url)

        # HTML-версия — есть ВСЕГДА, даже если caller передал только plain-text.
        # Это нужно чтобы подвал «отписаться» в письме был гипер-ссылкой, а не
        # голым уродливым URL. Если body_html уже задан — используем его как есть;
        # иначе автогенерируем из body_text (linkify, переносы, html-doc обёртка).
        if body_html:
            html_body_full = body_html + _build_html_footer(unsub_url)
        else:
            auto_html_inner = _plain_to_html(body_text or "")
            html_body_full = _wrap_html_body(auto_html_inner) + _build_html_footer(unsub_url)

        # MIME-структура (RFC 2387 — самая совместимая для Gmail/Outlook/Apple Mail):
        #   multipart/related
        #     ├── multipart/alternative
        #     │     ├── text/plain
        #     │     └── text/html       (ссылается на cid:<image_id>)
        #     └── image/...              (Content-Disposition: inline; filename=…)
        #
        # Это «внешний related, внутренний alternative» — обратное к тому, что
        # делает EmailMessage.add_alternative + .add_related автоматически.
        # Внутренний alternative некоторые мобильные клиенты Gmail отрисовывают
        # как «прикреплённый файл», поэтому собираем вручную через MIMEMultipart.
        if html_body_full and inline_images:
            related = MIMEMultipart("related")
            alternative = MIMEMultipart("alternative")
            alternative.attach(MIMEText(plain_body, "plain", "utf-8"))
            alternative.attach(MIMEText(html_body_full, "html", "utf-8"))
            related.attach(alternative)
            for i, img in enumerate(inline_images, start=1):
                try:
                    subtype = img.get("subtype", "jpeg")
                    image_part = MIMEImage(img["data"], _subtype=subtype)
                    cid = img["content_id"]
                    image_part.add_header("Content-ID", f"<{cid}>")
                    # filename — нормальное «человеческое» имя файла, чтобы
                    # Gmail/Outlook видели обычную картинку (а не «cid-токен»)
                    # и не помечали её как подозрительное приложение.
                    # Расширение совпадает с реальным subtype: jpeg→.jpg, png→.png и т.п.
                    ext = "jpg" if subtype == "jpeg" else subtype
                    pretty_name = "photo.jpg" if i == 1 and ext == "jpg" else f"photo-{i}.{ext}"
                    image_part.add_header(
                        "Content-Disposition",
                        "inline",
                        filename=pretty_name,
                    )
                    # MIMEImage по умолчанию ставит Content-Transfer-Encoding: base64
                    # уже сам — дополнительно ничего не нужно.
                    related.attach(image_part)
                except Exception as e:
                    logger.warning(f"Не удалось вложить inline-картинку cid={img.get('content_id')}: {e}")
            msg = related
        else:
            # Без inline-картинок — простой multipart/alternative.
            # HTML-версия есть всегда (см. выше): либо из body_html, либо
            # автогенерированная из body_text.
            msg = MIMEMultipart("alternative")
            msg.attach(MIMEText(plain_body, "plain", "utf-8"))
            msg.attach(MIMEText(html_body_full, "html", "utf-8"))

        msg["From"] = from_header
        msg["To"] = to_email
        msg["Subject"] = subject
        msg["Date"] = formatdate(localtime=True)
        msg["Message-ID"] = msg_id
        # Gmail one-click отписка (RFC 8058)
        msg["List-Unsubscribe"] = f"<{unsub_url}>"
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"

        try:
            with smtplib.SMTP(self.host, self.port, timeout=self.timeout) as smtp:
                smtp.send_message(msg)
        except (smtplib.SMTPException, socket.error, OSError) as e:
            logger.warning(
                f"Email send failed: from={from_address} to={to_email} err={e!r}"
            )
            raise EmailSendError(str(e)) from e

        return msg_id
