"""Проверка безопасности загружаемых файлов (п. 7.10 Публичной оферты).

Одна точка на всю платформу. Проверок несколько (расширение, двойное
расширение, MIME-тип), и разносить их по местам загрузки нельзя — они
разъедутся: файл, отклонённый в кабинете, проехал бы через бота.

⚠️ Загрузка идёт из ДВУХ мест с разной природой:
  • кабинет клиента (`api/uploads.py`) — грузит сам клиент;
  • переписка в боте (`services/dialog_archive.py`) — грузит участник, и
    запретить ему выбрать файл мы физически не можем, поэтому опасное
    просто не скачиваем.

⚠️ Проверяем ПО ИМЕНИ ФАЙЛА, а не только по MIME: браузер и мессенджеры
подставляют MIME по своему усмотрению, и `application/octet-stream` стоит
у половины вложений. Расширение подделать сложнее — оно нужно системе
получателя, чтобы файл запустился.
"""
from typing import Optional

# Перечень из п. 7.10.1 Оферты. Дополняется без миграции — это код, а не БД.
BLOCKED_EXTENSIONS = {
    # исполняемые файлы и установщики
    "exe", "com", "bat", "cmd", "msi", "msp", "scr", "app", "apk", "ipa",
    "dmg", "pkg", "deb", "rpm", "appimage",
    # скрипты и сценарии
    "ps1", "vbs", "js", "rb", "php", "sh", "bash", "cgi", "asp", "aspx", "jsp",
    # макросы и потенциально опасные документы
    "docm", "xlsm", "pptm", "dotm", "xlam",
    # библиотеки и системные компоненты
    "dll", "sys", "drv", "ocx",
    # иные потенциально опасные типы
    "jar", "class", "swf", "hta", "chm", "reg", "html", "htm",
}

# MIME-типы, по которым файл опасен независимо от расширения.
BLOCKED_CONTENT_TYPES = {
    "application/x-msdownload", "application/x-msdos-program",
    "application/x-executable", "application/x-dosexec",
    "application/vnd.microsoft.portable-executable",
    "application/x-sh", "application/x-shellscript",
    "application/x-httpd-php", "application/java-archive",
    "text/html",
}


def file_extension(filename: Optional[str]) -> str:
    """Расширение в нижнем регистре без точки. Нет расширения → ''."""
    name = (filename or "").strip()
    if "." not in name:
        return ""
    return name.rsplit(".", 1)[-1].lower().strip()


def is_blocked_file(filename: Optional[str], content_type: Optional[str] = None) -> bool:
    """
    TRUE, если файл запрещён к загрузке (п. 7.10 Оферты).

    ⚠️ Смотрим ВСЕ расширения в имени, а не только последнее: «отчёт.exe.pdf»
    для человека выглядит как PDF, но система получателя может запустить его
    как исполняемый. Поэтому запрещённое расширение в ЛЮБОЙ позиции блокирует
    файл целиком.
    """
    name = (filename or "").strip().lower()
    if name:
        parts = [p.strip() for p in name.split(".")[1:]]
        if any(p in BLOCKED_EXTENSIONS for p in parts):
            return True

    ct = (content_type or "").split(";")[0].strip().lower()
    if ct and ct in BLOCKED_CONTENT_TYPES:
        return True

    return False


def blocked_file_message(filename: Optional[str] = None) -> str:
    """Понятный текст отказа — его видит клиент, а не разработчик."""
    ext = file_extension(filename)
    what = f"«.{ext}»" if ext else "такого типа"
    return (
        f"Файл {what} загрузить нельзя: программы, скрипты и документы с макросами "
        "могут содержать вредоносный код. Если это ваш материал — заархивируйте его "
        "или выложите на файловое хранилище и дайте ссылку."
    )
