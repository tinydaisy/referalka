"""
Ресайз и сжатие картинок перед загрузкой в R2.

Цель: экономить место в хранилище и трафик. Картинки 4000×4000 от пользователя
сжимаются до разумного размера (без потери визуального качества для веб/моб).

Лимиты по kind (макс. длинная сторона):
    event_poster      → 1920px
    referral_material → 1920px
    certificate       → 1600px
    lead_magnet       → 1920px (если картинка)
    speaker_photo     →  800px
    brand_photo       → 1200px
    brand_logo        →  600px (мелкий, для угла страниц)
    owner_photo       → 1200px

PDF и не-картинки пропускаются как есть.
"""
import io
from typing import Tuple
from PIL import Image, ImageOps


MAX_DIM_BY_KIND = {
    "event_poster":      1920,
    "pre_reg_poster":    1920,
    "referral_material": 1920,
    "certificate":       1600,
    "lead_magnet":       1920,
    "speaker_photo":     800,
    # ⚠️ Вырезка на прозрачном фоне (миграция 362) — ИСХОДНИК для сборки афиш,
    # её ставят в макет в полный рост. 800 как у фото в профиле означало бы
    # мыло на афише 1920, поэтому запас как у самих афиш.
    "speaker_cutout":   1920,
    "speaker_poster":   1920,
    "brand_photo":       1200,
    "brand_logo":         600,
    "owner_photo":       1200,
    # Библиотека фото спикера (миграция 323): организатор СКАЧИВАЕТ снимок и
    # вставляет в свою афишу, поэтому нужен запас по размеру — 1920, как у афиш,
    # а не 1200 как у фото в профиле.
    "speaker_gallery":   1920,
    "funnel_media":      1920,
    "broadcast_photo":   1920,
    # Конструктор лендинга (миграция 240): фон секции растягивается на всю
    # ширину экрана — нужен широкий; картинки галереи/отзывов показываются
    # карточкой, 1200 достаточно и страница легче.
    "landing_bg":        1920,
    "landing_media":     1200,
    # Анкеты (миграция 281): обложка и картинки вопросов показываются в
    # колонке шириной ~600px — 1200 хватает с запасом под ретину.
    "survey_media":      1200,
    # Новости платформы (миграция 374): картинка видна на странице новостей в
    # колонке ~700px и в письме — 1200 хватает с запасом под ретину.
    "news_media":        1200,
    # Фон обложки: полотно 1280×720, но фон бывает крупнее — 1920
    # хватает и на ретину, и на возможный больший размер обложки.
    "cover_bg":          1920,
    # ⚠️ Продукты и уроки (миграции 290-294) СЖИМАТЬ ОБЯЗАТЕЛЬНО. Их забыли
    # добавить при появлении раздела, и картинки уходили в хранилище как есть:
    # kind не в этом словаре → process_image молча возвращает файл без обработки.
    # Ширина как у landing_media — показываются такой же карточкой/колонкой.
    "product_media":     1200,
    "material_media":    1200,
    # Отзывы и кейсы: фото показываются карточкой в галерее — 1200 хватает,
    # как у landing_media. ⚠️ Люди грузят снимки экрана с телефона по 3–5 МБ
    # пачками, без сжатия квота уходит за неделю.
    "testimonial":       1200,
}

# ⚠️ ПРАВИЛО: новый kind картинки — сразу СЮДА. Отсутствие в словаре не даёт
# ошибки, файл просто не сжимается, и заметить это можно только по счёту
# за хранилище. Проверка «все ли kind покрыты» — тест ниже по файлу.

JPEG_QUALITY = 85
IMAGE_MIMES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"}


def is_image(content_type: str) -> bool:
    return (content_type or "").lower() in IMAGE_MIMES


def process_image(data: bytes, kind: str, content_type: str) -> Tuple[bytes, str, str]:
    """
    Ресайзит картинку до лимита kind, конвертит в JPEG/PNG.
    Возвращает (новые байты, новый content_type, новое расширение).

    Если kind не в MAX_DIM_BY_KIND или не картинка — возвращаем данные как есть.
    """
    if kind not in MAX_DIM_BY_KIND or not is_image(content_type):
        ext = content_type.split("/")[-1] if "/" in content_type else "bin"
        return data, content_type, ext

    max_dim = MAX_DIM_BY_KIND[kind]
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)  # учесть EXIF-ориентацию

    # Ресайз если превышает лимит
    w, h = img.size
    if max(w, h) > max_dim:
        img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)

    out = io.BytesIO()
    if img.mode in ("RGBA", "LA", "P"):
        # PNG чтобы сохранить прозрачность
        img.save(out, format="PNG", optimize=True)
        return out.getvalue(), "image/png", "png"
    else:
        img = img.convert("RGB")
        img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        return out.getvalue(), "image/jpeg", "jpg"


def uncompressed_image_kinds() -> set:
    """Типы картинок, для которых сжатие НЕ настроено.

    Нужна, потому что забытый kind не даёт ошибки: process_image просто вернёт
    файл как есть, и узнать об этом можно только по размеру хранилища. Так и
    вышло с product_media / material_media — они грузились несжатыми.

    Зовётся из теста и из проверки при старте (см. main.py) — если кто-то
    добавит новый kind картинки и забудет прописать лимит, это будет видно сразу.
    """
    from app.api.uploads import VIDEO_KINDS, IMAGE_UPLOAD_KINDS
    return set(IMAGE_UPLOAD_KINDS) - set(VIDEO_KINDS) - set(MAX_DIM_BY_KIND) - {"lead_magnet"}
