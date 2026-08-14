"""
Клиент GetCourse: вход в аккаунт и чтение структуры тренингов/уроков.

⚠️ У GetCourse НЕТ публичного API для контента. Их официальное API
(/pl/api/account/...) отдаёт только пользователей, заказы и сделки — уроков там
нет вообще. Поэтому читаем так же, как это делает браузер: логинимся формой
админки и разбираем страницы.

⚠️ Три неочевидные вещи, на которых ломается наивная реализация:

1. Формы <form> на странице входа НЕТ — она рисуется JavaScript'ом. Логин идёт
   POST-ом multipart на /pl/api/user/auth/login (контракт подсмотрен в бандле
   /nassets/*/index.js, функция с "params[action]=login").

2. Запрос подписан: нужны requestTime + requestSimpleSign со страницы входа.
   Они лежат в JSON внутри HTML под ключом authPageInfo.

3. Нужны ещё 4 значения счётчика — gcSession/gcVisit/gcVisitor/gcSessionHash.
   В браузере их кладёт в localStorage скрипт /public/js/gccounter-new.js,
   дёргая /stat/counter, а тот отдаёт готовый JS с localStorage.setItem.
   Без них сервер отвечает «Ошибка валидации входных данных».

Реквизиты — через переменные окружения, в коде их не держим:
    export GC_BASE=https://ваш-аккаунт.getcourse.ru
    export GC_LOGIN=you@example.com
    export GC_PASSWORD='пароль'

Cookies кладутся рядом в cookies.pkl, чтобы не логиниться на каждый запуск.
"""
import json
import os
import pickle
import re
import sys
import warnings

warnings.filterwarnings("ignore")

import requests

BASE = os.environ.get("GC_BASE", "").rstrip("/")
LOGIN = os.environ.get("GC_LOGIN", "")
PASSWORD = os.environ.get("GC_PASSWORD", "")

HERE = os.path.dirname(os.path.abspath(__file__))
COOKIE_FILE = os.path.join(HERE, "cookies.pkl")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


# ── Сессия ────────────────────────────────────────────────────────────────

def _new_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9"})
    return s


def _logged_in(s: requests.Session) -> bool:
    r = s.get(f"{BASE}/teach/control", allow_redirects=True, timeout=30)
    return r.status_code == 200 and "/cms/system/login" not in r.url


def _auth_page_info(html: str) -> dict:
    """Подписанные параметры формы входа (ключ authPageInfo в HTML)."""
    info = {}
    m = re.search(r'"authPageInfo"\s*:\s*\{(.*?)"assets"', html, re.S)
    if not m:
        return info
    raw = m.group(1)
    for key in ("action", "requestSimpleSign"):
        mm = re.search(rf'"{key}"\s*:\s*"([^"]*)"', raw)
        if mm:
            info[key] = mm.group(1)
    for key in ("xdgetId", "requestTime"):
        mm = re.search(rf'"{key}"\s*:\s*(\d+)', raw)
        if mm:
            info[key] = mm.group(1)
    return info


def _tracking(s: requests.Session, page_url: str) -> dict:
    """Значения счётчика: /stat/counter отдаёт JS с localStorage.setItem."""
    r = s.get(
        f"{BASE}/stat/counter",
        params={"ref": "", "loc": page_url, "tzof": "2026-1-1 12:00"},
        headers={"Referer": page_url},
        timeout=30,
    )
    out = {}
    for key in ("session", "visit", "visitor", "hash"):
        m = re.search(rf"localStorage\.setItem\('{key}',\s*(.+?)\);", r.text)
        if not m:
            continue
        raw = m.group(1).strip()
        if raw.startswith("JSON.stringify("):
            raw = raw[len("JSON.stringify("):-1]
        out[key] = raw.strip().strip("'")
    return out


def _login(s: requests.Session) -> bool:
    page_url = f"{BASE}/cms/system/login"
    info = _auth_page_info(s.get(page_url, timeout=30).text)
    if not info:
        print("не нашёл authPageInfo на странице входа", file=sys.stderr)
        return False

    track = _tracking(s, page_url)
    if len(track) < 4:
        print(f"счётчик отдал не всё: {list(track)}", file=sys.stderr)
        return False

    fields = {
        "action": info.get("action", "processXdget"),
        "xdgetId": info.get("xdgetId", ""),
        "requestTime": info.get("requestTime", ""),
        "requestSimpleSign": info.get("requestSimpleSign", ""),
        "params[action]": "login",
        "params[email]": LOGIN,
        "params[password]": PASSWORD,
        "params[url]": page_url,
        "params[object_type]": "cms_page",
        "params[object_id]": "-1",
        "gcSession": track["session"],
        "gcVisit": track["visit"],
        "gcVisitor": track["visitor"],
        "gcSessionHash": track["hash"],
    }
    r = s.post(
        f"{BASE}/pl/api/user/auth/login",
        files={k: (None, v) for k, v in fields.items()},
        headers={"Referer": page_url, "X-Requested-With": "XMLHttpRequest",
                 "Origin": BASE},
        timeout=30,
    )
    try:
        ok = r.json().get("success") is True
    except ValueError:
        ok = False
    if not ok:
        print(f"вход отклонён: {r.text[:200]}", file=sys.stderr)
    return ok and _logged_in(s)


def get_session() -> requests.Session:
    """Готовая авторизованная сессия (переиспользует cookies с прошлого раза)."""
    if not (BASE and LOGIN and PASSWORD):
        print("задайте GC_BASE, GC_LOGIN, GC_PASSWORD в переменных окружения",
              file=sys.stderr)
        sys.exit(1)

    s = _new_session()
    if os.path.exists(COOKIE_FILE):
        with open(COOKIE_FILE, "rb") as f:
            s.cookies.update(pickle.load(f))
        if _logged_in(s):
            return s
        s = _new_session()

    if not _login(s):
        print("ЛОГИН НЕ ПРОШЁЛ", file=sys.stderr)
        sys.exit(1)

    with open(COOKIE_FILE, "wb") as f:
        pickle.dump(s.cookies, f)
    return s


# ── Разбор страниц ────────────────────────────────────────────────────────

def json_after(html: str, key: str):
    """
    Вырезает сбалансированный JSON-массив, идущий после `"key":[`.

    Данные страниц GetCourse встроены в HTML одним большим JSON: список
    тренингов лежит под "trainings", уроки тренинга — под "lessons".
    Регулярка тут не годится — внутри вложенные скобки и строки со слэшами.
    """
    i = html.find(f'"{key}":[')
    if i < 0:
        return None
    start = html.index("[", i)
    depth = 0
    in_str = False
    esc = False
    for j in range(start, len(html)):
        ch = html[j]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return json.loads(html[start:j + 1])
    return None


def json_object_after(html: str, key: str):
    """То же, что json_after, но для объекта `"key":{`  (блоки урока)."""
    i = html.find(f'"{key}":{{')
    if i < 0:
        return None
    start = html.index("{", i)
    depth = 0
    in_str = False
    esc = False
    for j in range(start, len(html)):
        ch = html[j]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(html[start:j + 1])
    return None


def list_trainings(s: requests.Session) -> list:
    """Все тренинги аккаунта."""
    html = s.get(f"{BASE}/teach/control", timeout=30).text
    return json_after(html, "trainings") or []


def list_lessons(s: requests.Session, training_id: int) -> list:
    """Уроки тренинга. Пустой список — нормально: бывают тренинги-контейнеры."""
    html = s.get(f"{BASE}/teach/control/stream/view/id/{training_id}",
                 timeout=30).text
    return json_after(html, "lessons") or []


def lesson_page(s: requests.Session, lesson_id: int) -> str:
    """HTML страницы урока."""
    return s.get(f"{BASE}/pl/teach/control/lesson/view",
                 params={"id": lesson_id}, timeout=30).text


def lesson_blocks(s: requests.Session, lesson_id: int) -> dict:
    """
    Блоки урока НОВОГО формата: словарь {порядковый номер: блок}, тип блока —
    в поле `type` (lesson-text, lesson-image, video-common и т.п.).

    ⚠️ Пустой словарь не значит «урок пуст» — в аккаунте уживаются два движка
    уроков, и у старого никакого JSON на странице нет, содержимое лежит готовой
    разметкой. Такие уроки разбирает parse_blocks_html() в export_getcourse.py.
    """
    return json_object_after(lesson_page(s, lesson_id), "blocks") or {}


if __name__ == "__main__":
    s = get_session()
    print("логин ок")
    for t in list_trainings(s):
        print(f"  {t['id']}  {t['title'][:60]}")
