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
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
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
    Формирует значение заголовка From в виде '<Name> <email>'.
    - Имя берётся из channel.email_from_name (если задано),
      иначе client_brand_name, иначе просто email без имени.
    """
    addr = _build_from_address(channel)
    name = (channel.get("email_from_name") or "").strip() or (client_brand_name or "").strip()
    if name:
        return f'"{name}" <{addr}>'
    return addr


def _unsubscribe_url(token: str) -> str:
    """https://pluson.ru/api/v1/email/unsubscribe?token=..."""
    base = settings.frontend_url.rstrip("/")
    return f"{base}/api/v1/email/unsubscribe?token={token}"


def _build_plain_footer(unsub_url: str) -> str:
    return (
        "\n\n"
        "---\n"
        "Это письмо отправлено в рамках вашей подписки. "
        "Если вы больше не хотите получать письма — отпишитесь по ссылке:\n"
        f"{unsub_url}"
    )


def _build_html_footer(unsub_url: str) -> str:
    return (
        '<hr style="margin-top:32px;border:none;border-top:1px solid #eee;">'
        '<p style="color:#999;font-size:12px;line-height:1.4;margin:16px 0;">'
        "Это письмо отправлено в рамках вашей подписки. "
        f'Если вы больше не хотите получать письма — <a href="{unsub_url}" '
        'style="color:#3D8CB6;text-decoration:underline;">отпишитесь по ссылке</a>.'
        "</p>"
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

        msg = EmailMessage()
        msg["From"] = from_header
        msg["To"] = to_email
        msg["Subject"] = subject
        msg["Date"] = formatdate(localtime=True)
        msg["Message-ID"] = msg_id

        # Gmail one-click отписка (RFC 8058)
        msg["List-Unsubscribe"] = f"<{unsub_url}>"
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"

        # Plain-text часть (всегда)
        plain_body = (body_text or "") + _build_plain_footer(unsub_url)
        msg.set_content(plain_body)

        # HTML-альтернатива (опционально)
        if body_html:
            html_body = body_html + _build_html_footer(unsub_url)
            msg.add_alternative(html_body, subtype="html")

            # Inline-картинки — вкладываем внутрь HTML-части как related-attachments.
            # В HTML на них ссылаемся через src="cid:<content_id>". Картинки уезжают
            # внутри письма, поэтому R2 может удалить файл, и Gmail-«блокировка
            # внешних картинок» (особенно в спам-папке) перестаёт мешать.
            if inline_images:
                html_part = msg.get_payload()[-1]  # последняя alternative — это html
                for img in inline_images:
                    try:
                        html_part.add_related(
                            img["data"],
                            maintype="image",
                            subtype=img.get("subtype", "jpeg"),
                            cid=f"<{img['content_id']}>",
                        )
                    except Exception as e:
                        logger.warning(f"Не удалось вложить inline-картинку cid={img.get('content_id')}: {e}")

        try:
            with smtplib.SMTP(self.host, self.port, timeout=self.timeout) as smtp:
                smtp.send_message(msg)
        except (smtplib.SMTPException, socket.error, OSError) as e:
            logger.warning(
                f"Email send failed: from={from_address} to={to_email} err={e!r}"
            )
            raise EmailSendError(str(e)) from e

        return msg_id
