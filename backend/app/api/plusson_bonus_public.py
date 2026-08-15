"""
Активация бонусного доступа в ПЛЮСОН по ссылке из письма (миграция 308).

Человек переходит по `pluson.ru/bonus/{токен}` → здесь заводится кабинет и
включается доступ, отсчёт дней идёт С ЭТОГО МОМЕНТА.

⚠️ Никакой авторизации: человек ещё не клиент ПЛЮСОНа, войти ему некуда.
Защита — сам токен: он длинный, хранится хешем и срабатывает один раз.

⚠️ Отдаёт HTML, а не JSON: ссылку открывают из почты и мессенджера, там
нужна нормальная страница, а не машинный ответ.
"""
import logging

import asyncpg
from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse

from app.database import get_db
from app.services.plusson_bonus import activate_coupon

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Бонус ПЛЮСОНа"])

_PAGE = """<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
 body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:linear-gradient(45deg,#25455D,#0a1520);color:#fff;
      font-family:Roboto,system-ui,-apple-system,sans-serif;padding:20px}}
 .card{{background:rgba(255,255,255,.06);border:1px solid rgba(255,207,164,.35);
       border-radius:18px;padding:28px;max-width:520px;width:100%;text-align:center}}
 h1{{margin:0 0 14px;font-size:24px;color:#FFCFA4}}
 p{{margin:0 0 12px;line-height:1.6;opacity:.92}}
 a.btn{{display:inline-block;margin-top:16px;padding:13px 26px;border-radius:12px;
       background:#FFCFA4;color:#0a1520;font-weight:700;text-decoration:none}}
 .muted{{font-size:13px;opacity:.7;margin-top:16px}}
</style></head><body><div class="card">{body}</div></body></html>"""


def _html(title: str, body: str, code: int = 200) -> HTMLResponse:
    return HTMLResponse(_PAGE.format(title=title, body=body), status_code=code)


@router.get("/bonus/{token}", summary="Активировать бонусный доступ в ПЛЮСОН")
async def activate(token: str, db: asyncpg.Connection = Depends(get_db)):
    try:
        res = await activate_coupon(db, token)
    except Exception:
        logger.exception("bonus: активация по токену не удалась")
        return _html("Ошибка", (
            "<h1>Что-то пошло не так</h1>"
            "<p>Мы не смогли включить доступ. Напишите нам — разберёмся и всё выдадим.</p>"
            "<p><a class='btn' href='https://telegram.me/pluson_bot'>Написать в поддержку</a></p>"
        ), 500)

    if not res.get("ok"):
        reason = res.get("reason")
        if reason == "used":
            return _html("Доступ уже активирован", (
                "<h1>Доступ уже активирован</h1>"
                "<p>Эта ссылка срабатывает один раз — вы ей уже воспользовались.</p>"
                "<p>Входите в кабинет под своей почтой.</p>"
                "<p><a class='btn' href='https://pluson.ru/login'>Войти в ПЛЮСОН</a></p>"
            ))
        if reason == "expired":
            return _html("Срок ссылки истёк", (
                "<h1>Срок ссылки истёк</h1>"
                "<p>Ссылка на бонус действует ограниченное время, и оно закончилось.</p>"
                "<p>Напишите нам — посмотрим, что можно сделать.</p>"
                "<p><a class='btn' href='https://telegram.me/pluson_bot'>Написать в поддержку</a></p>"
            ))
        return _html("Ссылка не найдена", (
            "<h1>Ссылка не найдена</h1>"
            "<p>Проверьте, что открыли её полностью — почтовые программы иногда "
            "разрывают длинные ссылки на две строки.</p>"
            "<p><a class='btn' href='https://telegram.me/pluson_bot'>Написать в поддержку</a></p>"
        ), 404)

    days = res.get("days")
    if res.get("is_new"):
        pw = res.get("password_url")
        btn = (f"<p><a class='btn' href='{pw}'>Задать пароль и войти</a></p>"
               if pw else "<p><a class='btn' href='https://pluson.ru/login'>Войти в ПЛЮСОН</a></p>")
        return _html("Доступ открыт", (
            "<h1>Готово, доступ открыт</h1>"
            f"<p>Мы завели вам кабинет в iViSiON: ПЛЮСОН на {days} дней — "
            "отсчёт пошёл с этой минуты.</p>"
            "<p>Осталось задать пароль, чтобы входить.</p>" + btn +
            "<p class='muted'>Если кнопка не работает — восстановите пароль на "
            "странице входа, кабинет уже создан на вашу почту.</p>"
        ))

    return _html("Доступ продлён", (
        "<h1>Готово, доступ продлён</h1>"
        f"<p>Мы добавили {days} дня к вашей подписке в iViSiON: ПЛЮСОН.</p>"
        "<p><a class='btn' href='https://pluson.ru/login'>Войти в кабинет</a></p>"
    ))
