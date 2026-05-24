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
    "referral_material": 1920,
    "certificate":       1600,
    "lead_magnet":       1920,
    "speaker_photo":     800,
    "speaker_poster":   1920,
    "brand_photo":       1200,
    "brand_logo":         600,
    "owner_photo":       1200,
    "funnel_media":      1920,
    "broadcast_photo":   1920,
}

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
