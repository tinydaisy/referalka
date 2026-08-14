"""Предпросмотр черновика — подписанная ссылка вместо заголовка Authorization.

Зачем. Лендинг события и страница продукта нужны клиенту ДО публикации:
«до публикации мне надо понимать, что я публикую и как выглядит лендинг».
Но публичные страницы (`/e/{slug}`, `/pr/{slug}`) рендерятся НА СЕРВЕРЕ
Next.js: он ходит в наш API сам, и заголовка `Authorization` из браузера
у него нет в принципе. Поэтому прежняя проверка «токен кабинета в заголовке»
не срабатывала никогда — черновик оставался недоступен даже владельцу.

Решение — короткоживущий подписанный токен В АДРЕСЕ (`?preview=…`): его
видит и серверная страница, и наш API, куда она этот параметр пробрасывает.

⚠️ Токен привязан к КАБИНЕТУ (`client_id`), а не к конкретной странице:
клиент, открыв предпросмотр, ходит по своим же страницам (лендинг → «спасибо»,
продукт → его лендинг), и требовать отдельный токен на каждую значило бы
ломать переходы. Чужой кабинет по этому токену не откроется — при проверке
сверяется владелец запрошенной страницы.

⚠️ Живёт 2 часа. Это ссылка на ЧЕРНОВИК: попади она к постороннему, тот
увидит неготовую страницу. Час-два хватает на «посмотреть и поправить», а
вечная ссылка расползлась бы по переписке и пережила бы публикацию.

⚠️ Отдельная аудитория `landing-preview`. Без неё токеном кабинета покупателя
или спикера можно было бы открывать чужие черновики — ровно та ошибка, от
которой в кабинете покупателя защищает `aud='product-cabinet'`.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt

from app.config import settings

_AUD = "landing-preview"
_TTL_HOURS = 2


def make_preview_token(client_id: int) -> str:
    """Ссылка-предпросмотр для владельца кабинета."""
    return jwt.encode(
        {
            "aud": _AUD,
            "cl_id": int(client_id),
            "exp": datetime.now(timezone.utc) + timedelta(hours=_TTL_HOURS),
        },
        settings.jwt_secret,
        algorithm="HS256",
    )


def preview_client_id(token: Optional[str]) -> Optional[int]:
    """`client_id` из токена предпросмотра или None.

    Ошибка разбора = None («не владелец»), а не исключение: посторонний с
    мусорным параметром должен получить обычные 404, а не 500.
    """
    if not token:
        return None
    try:
        data = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"],
                          audience=_AUD)
        return int(data["cl_id"])
    except Exception:
        return None


def is_preview_owner(token: Optional[str], client_id) -> bool:
    """Открывает ли черновик его собственный владелец."""
    cid = preview_client_id(token)
    return cid is not None and str(cid) == str(client_id)
