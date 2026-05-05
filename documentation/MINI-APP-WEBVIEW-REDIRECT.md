# Recipe: автоматический редирект на внешний URL внутри Telegram Mini App

> **Когда применять.** В Telegram Mini App нужно автоматически (без клика
> пользователя) перебросить webview на внешний URL — например, на
> сторонний лендинг клиента (Tilda / GetCourse / Taplink / самописный сайт).
>
> **Цель.** Лендинг открывается **внутри окна Mini App** (с заголовком
> «мини-приложение» сверху и кнопкой «Закрыть»), а не во внешнем браузере —
> пользователь не покидает Telegram. После работы с лендингом редирект
> на `t.me/{bot}/{app}?startapp=...` возвращает обратно в Mini App.

## Что НЕ работает (и почему)

```js
// ❌ НЕ РАБОТАЕТ на iOS из useEffect / любого не-user-gesture контекста:
Telegram.WebApp.openLink(url)
window.open(url, '_blank')
```

iOS WKWebView (на котором собран Telegram iOS) блокирует это как **popup**,
если вызов произошёл вне обработчика `click`/`touch`. Пользователь не
видит ничего, и в консоли тишина — popup-blocker молча отбрасывает.

`Telegram.WebApp.openLink` дополнительно: даже если сработает (по клику) —
на iOS открывает URL **во внешнем Safari**, а не во встроенном браузере
Telegram. Это нативное поведение Telegram iOS, обойти нельзя.

## Что РАБОТАЕТ

```js
// ✅ Прямая навигация webview — не popup, iOS не блокирует:
window.location.replace(url)
// или
window.location.href = url
```

`window.location` — это **смена адреса текущей страницы**, а не открытие
новой вкладки/окна. iOS такие вызовы не блокирует, даже без user-gesture.
Mini App webview просто переходит на новый URL и рендерит лендинг внутри
своего окна. Заголовок «мини-приложение» сверху остаётся.

## Где располагать код

**В inline-скрипте `index.html` ДО загрузки React-bundle.** Если делать
из React useEffect, пользователь успеет увидеть «заглушку» Mini App
(LoadingScreen + первый рендер) на 1-5 секунд, пока React грузится и
делает свои fetch'и. Inline-скрипт стартует сразу после
`Telegram.WebApp.ready()` и пока React тянется — fetch уже летит, и
`window.location.replace` срабатывает раньше.

## Полный рецепт (минимальный)

### 1. Backend: endpoint, который возвращает либо URL, либо пусто

```python
# backend/app/api/landing.py (FastAPI)
@router.get("/api/v1/public/events/{slug}/landing-redirect")
async def landing_redirect(
    slug: str,
    tg_id: int | None = None,
    db: asyncpg.Connection = Depends(get_db),
):
    """Если событию задан внешний URL и пользователь ещё не зарегистрирован —
    возвращает {redirect_url: ...}. Иначе пустой объект."""
    row = await db.fetchrow(
        "SELECT id, landing_url, status FROM events WHERE slug=$1 LIMIT 1",
        slug,
    )
    if not row or row["status"] != "published":
        return {}
    landing_url = (row["landing_url"] or "").strip()
    if not landing_url:
        return {}

    # Логика «не редиректить если уже зарегистрирован» — делаем серверно,
    # чтобы фронту не нужно было делать второй запрос.
    if tg_id is not None:
        is_reg = await db.fetchval(
            """SELECT ep.is_registered FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id
                WHERE ep.event_id=$1 AND pu.platform_user_id=$2 LIMIT 1""",
            row["id"], str(tg_id),
        )
        if is_reg:
            return {}

    # Прокидываем параметры (tg_id и т.п.) в URL — клиент может сматчить
    # запись на своей стороне.
    from urllib.parse import urlencode
    qs = {"event_slug": slug}
    if tg_id is not None: qs["tg_id"] = str(tg_id)
    sep = "&" if "?" in landing_url else "?"
    return {"redirect_url": landing_url + sep + urlencode(qs)}
```

### 2. Frontend: inline-скрипт в `mini-app/index.html`

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script>
  (function () {
    var twa = window.Telegram && window.Telegram.WebApp;
    if (!twa) return;
    try { twa.ready(); } catch (e) {}

    var u  = (twa.initDataUnsafe && twa.initDataUnsafe.user) || null;
    var sp = (twa.initDataUnsafe && twa.initDataUnsafe.start_param) || '';
    if (!u) return;

    // Парсим startapp (формат может быть свой — у нас "ref_pgSLUG_pidX_reg")
    var eventSlug = '', regFlag = false;
    sp.split('_').forEach(function (p) {
      if (p.indexOf('pg') === 0) eventSlug = p.slice(2);
      if (p === 'reg')           regFlag   = true;  // возврат с лендинга → не редиректим
    });

    function maybeRedirect() {
      // ⚠️ Если в startapp есть флаг возврата — НЕ редиректим (иначе петля).
      if (!eventSlug || regFlag) return;
      try {
        fetch('/api/v1/public/events/' + encodeURIComponent(eventSlug)
              + '/landing-redirect?tg_id=' + encodeURIComponent(String(u.id || '')))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (data && data.redirect_url) {
              // ✅ КЛЮЧЕВОЙ ВЫЗОВ: window.location.replace, не openLink/window.open.
              // replace, а не href — чтобы кнопка «Назад» не вернула на пустую заглушку.
              window.location.replace(data.redirect_url);
            }
          })
          .catch(function () {});
      } catch (e) {}
    }

    // requestWriteAccess можно оставить параллельно — оно про подписку бота
    // на отправку сообщений, не блокирует navigation.
    if (typeof twa.requestWriteAccess === 'function') {
      try { twa.requestWriteAccess(function () { maybeRedirect(); }); }
      catch (e) { maybeRedirect(); }
    } else {
      maybeRedirect();
    }
  })();
  </script>
</head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

### 3. Возврат с лендинга обратно в Mini App

Лендинг клиента в настройках формы регистрации указывает редирект **на
эту ссылку** (без своих query-параметров — Telegram отклонит startapp с
лишними символами):

```
https://t.me/{bot_username}/{app_short_name}?startapp=ref_pgSLUG_reg
```

Telegram открывает Mini App. Inline-скрипт видит флаг `_reg` в startapp и
редирект обратно на лендинг **не делает** (иначе бесконечная петля). React
рендерится, видит «зарегистрировался» и показывает welcome / Программу.

## Чек-лист на повторение

- [ ] `window.location.replace(url)` (или `.href`) — НЕ `openLink`/`window.open`
- [ ] Код в **inline-скрипте index.html**, не в React
- [ ] Серверный endpoint решает редиректить или нет (учитывает статус,
      зарегистрирован ли пользователь, есть ли URL) — фронт просто слушается
- [ ] В startapp есть флаг возврата (например `_reg`) — иначе при возврате
      с лендинга снова редиректит на лендинг → петля
- [ ] **Не дописывать свои query-параметры внутрь** `startapp`-значения —
      Telegram принимает только `[a-zA-Z0-9_-]{1,64}`. Параметры передавайте
      ДО `startapp` или через webhook на сервер
- [ ] Если нужно прокинуть данные (`tg_id`, `pid`, `utm_source`) на лендинг —
      добавляйте их **в URL лендинга** (после серверной сборки), а не в startapp

## Почему это работает на iOS, а `openLink` — нет

| Действие | iOS WKWebView блокирует? |
|---|---|
| `window.location.href = url` | Нет — это просто навигация |
| `window.location.replace(url)` | Нет — то же самое |
| `Telegram.WebApp.openLink(url)` без user-gesture | Да — popup-blocker |
| `Telegram.WebApp.openLink(url)` по клику | Нет — но открывает в Safari |
| `window.open(url)` без user-gesture | Да — popup-blocker |

`window.location.*` — это **сама страница** меняет адрес, не открывает
новое окно. Popup-blocker'у нечего блокировать.

## Минусы решения и когда не подходит

- **Mini App webview "уплывает"** на лендинг. Если лендинг долго грузится —
  пользователь видит белый экран (это уже не Mini App, не наша заглушка).
  Решение: на стороне лендинга поставить ранний preload или skeleton.
- **Назад в Mini App** только через `t.me/{bot}/{app}?startapp=...` редирект.
  Просто кнопка «Назад» в браузере вернёт на исходный URL Mini App — это
  переоткроет Mini App на старте, не сохранит позицию.
- **Не подойдёт** если на лендинге стоит `X-Frame-Options: DENY` И
  одновременно блокировка `Sec-Fetch-Site: cross-site` (редко, но бывает).
  `window.location` — не iframe, эти заголовки не применяются, но если
  лендинг сам редиректит куда-то и там опять блокировки — может ломаться.
