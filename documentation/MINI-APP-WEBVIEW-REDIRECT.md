# Полный гид: открытие стороннего лендинга внутри Telegram Mini App

> **Цель.** При открытии Telegram Mini App автоматически (без клика) перебросить
> webview на внешний URL (например, на лендинг клиента — Tilda / GetCourse / Taplink /
> самописный сайт). Лендинг открывается **внутри окна Mini App** (с заголовком
> «мини-приложение» сверху), а не во внешнем браузере. После работы с лендингом
> редирект на `t.me/{bot}/{app}?startapp=...` возвращает обратно в Mini App.
>
> **Чем уникален этот гид:** покрывает ВСЕ четыре точки входа в Mini App
> (прямая ссылка из браузера, открытие из Telegram-чата, клик из Хаба внутри
> Mini App, возврат с лендинга), описывает все задержки и зачем они нужны,
> и как синхронизировать inline-скрипт с React-бандлом, чтобы пользователь
> НЕ видел нашу заглушку даже на 200мс.

---

## 1. Какую функцию использовать (и какую НЕ использовать)

### ❌ НЕ работает на iOS из не-user-gesture контекста (например, useEffect):

```js
Telegram.WebApp.openLink(url)  // popup-blocked iOS
window.open(url, '_blank')      // popup-blocked iOS
```

iOS WKWebView (на котором собран Telegram iOS) считает это **popup**'ом
и молча блокирует, если вызов не происходит в обработчике `click`/`touch`.
Дополнительно: даже если `openLink` сработает по клику — на iOS он открывает
URL **во внешнем Safari**, а не во встроенном браузере Telegram. Это
поведение Telegram iOS, обойти через `try_instant_view: false` или
другие опции нельзя.

### ✅ Работает везде, без user-gesture:

```js
window.location.replace(url)  // используем ЭТО — replace, не href
window.location.href = url    // тоже работает, но оставит запись в history
```

Это **навигация webview** на новый адрес (не открытие popup'а), iOS не
блокирует. `replace` лучше `href` тем, что не оставляет страницу-заглушку
в `history` — кнопка «Назад» сразу вернёт в Telegram-чат, а не на нашу
заглушку.

---

## 2. Четыре точки входа и как обрабатывается каждая

| Точка входа | Где обработка | Что вызывается |
|---|---|---|
| 1. Веб-ссылка `pluson.ru/l/{slug}` без `?app=tg` | Server Component (Next.js) | `redirect()` из `next/navigation` |
| 2. Telegram-ссылка с `?app=tg` или `t.me/{bot}/{app}?startapp=ref_pgX` | Inline-скрипт в `mini-app/index.html` | `window.location.replace()` |
| 3. Клик по событию в Хабе организатора (SPA-навигация) | `App.tsx::openEvent()` | `window.location.replace()` |
| 4. Возврат с лендинга через `?startapp=ref_pgX_reg` | Inline-скрипт пропускает, React видит флаг `_reg` | (редиректа НЕТ — иначе петля) |

**Точка 1 — самая быстрая** (серверный 307/302), но работает только в
браузере без `?app=tg`.

**Точка 2 — главная для Telegram-flow.** Все 7 секунд белого экрана
случались именно тут — потому что React-бандл (242 КБ) грузился ДО
fetch'а, и пользователь видел заглушку. Решение — splash в HTML +
синхронизация через флаг.

**Точка 3 — SPA-навигация в Хабе.** `index.html` уже не загружается, поэтому
inline-скрипт не срабатывает. Перехватываем в `App.tsx::openEvent` ДО
смены state.

**Точка 4 — критично для предотвращения петли.** Если у `_reg`-возврата
снова сработает редирект на лендинг, человек никогда не попадёт в Mini App.

---

## 3. Backend: один endpoint решает редиректить или нет

```python
# backend/app/api/client_profile.py
@public.get("/events/{slug}/landing-redirect")
async def public_event_landing_redirect(
    slug: str,
    tg_id: Optional[int] = None,
    pid: Optional[str] = None,
    utm_source: Optional[str] = None,
    db: asyncpg.Connection = Depends(get_db),
):
    """Если событию задан landing_url И пользователь ещё не зарегистрирован —
    возвращает {redirect_url: "..."} с пробросом параметров. Иначе {}."""
    row = await db.fetchrow(
        "SELECT id, landing_url, status FROM events WHERE slug=$1 LIMIT 1",
        slug,
    )
    if not row or row["status"] != "published":
        return {}
    landing_url = (row["landing_url"] or "").strip()
    if not landing_url:
        return {}
    # Уже зарегистрирован? Не редиректим — Mini App покажет welcome или Программу.
    if tg_id is not None:
        is_reg = await db.fetchval(
            """SELECT ep.is_registered FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id
                WHERE ep.event_id=$1 AND pu.platform_user_id=$2 LIMIT 1""",
            row["id"], str(tg_id),
        )
        if is_reg:
            return {}
    # Прокидываем tg_id/pid/utm_source — клиент сматчит регистрацию.
    from urllib.parse import urlencode
    qs = {"event_slug": slug}
    if tg_id is not None: qs["tg_id"] = str(tg_id)
    if pid:               qs["pid"] = pid
    if utm_source:        qs["utm_source"] = utm_source
    sep = "&" if "?" in landing_url else "?"
    return {"redirect_url": landing_url + sep + urlencode(qs)}
```

**Решения серверно** (зачем): фронт не должен делать 2-3 запроса (проверить
landing_url, проверить is_registered, отфильтровать ended/draft) — это
лишнее время. Один запрос → ответ типа «редиректить туда» или «не надо».

---

## 4. Inline-скрипт в `mini-app/index.html` (точка 2)

Это **главный механизм**. Срабатывает ДО загрузки React-бандла (242 КБ).
Полный код:

```html
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script>
(function () {
  var twa = window.Telegram && window.Telegram.WebApp;
  if (!twa) return;
  try { twa.ready(); } catch (e) {}

  var u  = (twa.initDataUnsafe && twa.initDataUnsafe.user) || null;
  var sp = (twa.initDataUnsafe && twa.initDataUnsafe.start_param) || '';
  if (!u) return;

  // Парсим startapp: ref_pg<slug>_pid<id>_src<utm>_cid<id>_reg
  var eventSlug = '', partnerId = '', utmSource = '', clientId = 0, regFlag = false;
  sp.split('_').forEach(function (p) {
    if (p.indexOf('pg')  === 0) eventSlug = p.slice(2);
    if (p.indexOf('pid') === 0) partnerId = p.slice(3);
    if (p.indexOf('src') === 0) utmSource = p.slice(3);
    if (p.indexOf('cid') === 0) clientId  = parseInt(p.slice(3), 10) || 0;
    if (p === 'reg')            regFlag   = true;
  });

  // ⚡ КЛЮЧЕВОЕ: флаг для синхронизации с React. Ставим СРАЗУ (без ожидания
  // ответа сервера), чтобы React не успел отрендерить EventPage до fetch.
  if (eventSlug && !regFlag) {
    window.__redirectPending = true;
    // Safety: если бэк завис — через 3 сек разблокируем React.
    setTimeout(function () { window.__redirectPending = false; }, 3000);
  }

  function maybeRedirectToLanding() {
    if (!eventSlug || regFlag) return;
    try {
      var qs = '?tg_id=' + encodeURIComponent(String(u.id || ''));
      if (partnerId) qs += '&pid=' + encodeURIComponent(partnerId);
      if (utmSource) qs += '&utm_source=' + encodeURIComponent(utmSource);
      fetch('/api/v1/public/events/' + encodeURIComponent(eventSlug) + '/landing-redirect' + qs)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && data.redirect_url) {
            window.location.replace(data.redirect_url);
            // Не снимаем флаг — webview уже уплывает на лендинг клиента.
          } else {
            window.__redirectPending = false;  // редирект не нужен — пускаем React
          }
        })
        .catch(function () { window.__redirectPending = false; });
    } catch (e) { window.__redirectPending = false; }
  }

  if (typeof twa.requestWriteAccess === 'function') {
    try { twa.requestWriteAccess(function () { fireStart(); maybeRedirectToLanding(); }); }
    catch (e) { fireStart(); maybeRedirectToLanding(); }
  } else {
    fireStart();
    maybeRedirectToLanding();
  }
})();
</script>
```

### Зачем флаг `__redirectPending`

React-бандл качается параллельно с fetch'ом. Если React загрузится быстрее
(например, из кеша) — он смонтирует EventPage и пользователь увидит наш
встроенный лендинг **до** того как сработает редирект. Флаг это чинит:

1. inline-script ставит `__redirectPending=true` СРАЗУ (синхронно, до fetch)
2. React в App.tsx опрашивает флаг и НЕ снимает loading пока он стоит
3. Когда fetch завершается, флаг снимается (если редиректа нет) — React продолжает рендер
4. Если редирект есть — `window.location.replace`, флаг не снимается, webview уже уплыл

### Зачем 3-секундный safety-таймаут

Если бэкенд завис (5xx, network error, timeout) — флаг останется `true` навсегда,
React будет показывать LoadingScreen до конца сессии. Таймаут гарантирует:
через 3 секунды флаг точно снимается, React рендерит обычное событие как
fallback.

---

## 5. Брендированный splash в HTML (бьёт белый экран)

При первом заходе пользователь видит белый экран пока браузер качает
242 КБ JS-бандла Mini App. На медленном канале — до 7 секунд. Решение:
**Splash прямо в HTML, до загрузки JS**:

```html
<head>
  <style>
    html, body {
      margin: 0;
      background: linear-gradient(45deg, #25455D, #0a1520);
      min-height: 100vh;
    }
    #plusson-splash {
      position: fixed; inset: 0; z-index: 1;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 24px;
    }
    #plusson-splash .brand {
      font-size: 36px; font-weight: 700; letter-spacing: 4px;
      color: #FFCFA4; text-transform: uppercase;
    }
    #plusson-splash .spinner {
      width: 40px; height: 40px;
      border: 4px solid rgba(255, 207, 164, 0.25);
      border-top-color: #FFCFA4;
      border-radius: 50%;
      animation: plusson-spin 0.8s linear infinite;
    }
    @keyframes plusson-spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="plusson-splash">
    <div class="brand">ПЛЮСОН</div>
    <div class="sub">реферальный сервис</div>
    <div class="spinner"></div>
  </div>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
```

Когда React успевает запуститься и решает показать настоящий контент —
он удаляет splash из DOM:

```tsx
// App.tsx
if (loading) return null  // splash в index.html виден поверх #root

const splash = typeof document !== 'undefined' ? document.getElementById('plusson-splash') : null
if (splash) splash.remove()
```

Эффект: пользователь видит брендированный градиент с крутилкой **сразу
после парсинга HTML** (≈50мс), а не белый экран на 7 секунд.

---

## 6. React-сторона синхронизации (`mini-app/src/App.tsx`)

```tsx
useEffect(() => {
  // ... парсинг startapp, sendTg events, и т.д. ...

  // Если inline-script запустил fetch на /landing-redirect и ещё не получил
  // ответ — НЕ снимаем loading. React ждёт, чтобы не отрендерить EventPage
  // до redirect.
  const minDelayMs = 600          // минимальная задержка перед скрытием splash
  const startTs = Date.now()
  let cancelled = false
  function tick() {
    if (cancelled) return
    const pending = (window as any).__redirectPending === true
    const elapsed = Date.now() - startTs
    if (!pending && elapsed >= minDelayMs) {
      setLoading(false)
      return
    }
    if (elapsed >= 3500) {
      // Safety: если флаг не снялся за 3.5 сек — фолбэк на обычный flow.
      setLoading(false)
      return
    }
    setTimeout(tick, 50)
  }
  tick()
  return () => { cancelled = true }
}, [])
```

### Зачем именно 600мс minDelay и 50мс polling

- **600мс minDelay** — даже если флаг снимается мгновенно (нет landing_url),
  splash всё равно держится 600мс. Это убирает «моргание» когда на быстрых
  устройствах React успевает загрузиться за 100мс — иначе splash мелькнул бы
  на долю секунды и пропал, пользователь не понял бы что произошло.
- **50мс polling** — через каждые 50мс проверяем флаг. Меньше = лишний CPU,
  больше = задержка между ответом сервера и снятием splash. 50мс — баланс.
- **3500мс hard timeout** — защита от зависшего бэка (3000мс safety в
  inline-script + 500мс на цикл). Если фейл на сервере — пользователь
  всё равно увидит контент через 3.5 сек.

---

## 7. SPA-навигация: точка 3 (клик в Хабе)

Когда пользователь в Хабе кликает на событие — `index.html` НЕ загружается
заново, inline-script не срабатывает. Перехватываем в `App.tsx::openEvent`:

```tsx
async function openEvent(slug: string) {
  setPendingOpen(true)  // показываем SpinnerOverlay поверх Хаба
  try {
    const tgId = tgUser?.id ? String(tgUser.id) : ''
    const qs = new URLSearchParams()
    if (tgId)      qs.set('tg_id', tgId)
    if (partnerId) qs.set('pid', partnerId)
    if (utmSource) qs.set('utm_source', utmSource)
    const url = `${import.meta.env.VITE_API_URL}/api/v1/public/events/${
      encodeURIComponent(slug)
    }/landing-redirect?${qs}`
    const res = await fetch(url)
    if (res.ok) {
      const data = await res.json()
      if (data && data.redirect_url) {
        window.location.replace(data.redirect_url)
        return  // не сбрасываем pendingOpen — webview уплывает
      }
    }
  } catch (_) { /* offline / 5xx — фолбэк на обычный flow */ }
  // Редиректа нет → SPA-навигация на EventPage как обычно
  window.history.pushState({}, '', eventPath(clientId, slug))
  setEventSlug(slug)
  setPendingOpen(false)
}
```

И полупрозрачный оверлей со спиннером:

```tsx
// SpinnerOverlay.tsx
export default function SpinnerOverlay() {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(10, 21, 32, 0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(2px)',
    }}>
      <div style={{
        width: 44, height: 44,
        border: '4px solid rgba(255, 207, 164, 0.25)',
        borderTopColor: '#FFCFA4',
        borderRadius: '50%',
        animation: 'spinner-rot 0.8s linear infinite',
      }} />
      <style>{`@keyframes spinner-rot { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
```

Зачем оверлей: fetch занимает 200-500мс. Без оверлея пользователь думает
«клик не сработал» — Хаб остаётся неподвижным. Полупрозрачный оверлей
со спиннером сразу даёт обратную связь.

---

## 8. EventPage useEffect как страховка (точки 1+3 fallback)

Если человек попал на `/event/{slug}` напрямую через URL (например, переход
с прошлой сессии Mini App, popstate из браузера и т.п.) — ни inline-script,
ни `openEvent` не отработали. Ставим useEffect в EventPage как третий fallback:

```tsx
// mini-app/src/pages/EventPage.tsx
useEffect(() => {
  if (!event) return
  if (loading) return
  if (registered || ended) return
  const landingUrl: string = (event.landing_url || '').trim()
  if (!landingUrl) return

  const params = new URLSearchParams()
  if (tgUser?.id) params.set('tg_id', String(tgUser.id))
  if (partnerId)  params.set('pid', partnerId)
  if (utmSource)  params.set('utm_source', utmSource)
  params.set('event_slug', slug)
  const sep = landingUrl.includes('?') ? '&' : '?'
  window.location.href = landingUrl + sep + params.toString()
}, [event, loading, registered, ended])
```

Этот useEffect срабатывает поздно (после загрузки `event` и `participant`)
и его не нужно избегать — это _последний_ резерв, не основной путь.

---

## 9. Веб-сторона: точка 1 (Server Component Next.js)

```tsx
// web/src/app/l/[slug]/page.tsx
import { redirect } from 'next/navigation'

export default async function EventLandingPage({
  params, searchParams,
}: {
  params: { slug: string }
  searchParams: { app?: string; pid?: string; utm_source?: string }
}) {
  const event = await getEvent(params.slug)

  // Веб-вход без ?app=tg на лендинг клиента: 301-редирект на сторонний лендинг.
  // С ?app=tg — оставляем обычный flow (redirect_web_app.js откроет Telegram,
  // дальше Mini App сам через inline-script покажет лендинг клиента).
  if (event.landing_url && !searchParams?.app) {
    const url = new URL(event.landing_url)
    if (searchParams?.pid)        url.searchParams.set('pid', searchParams.pid)
    if (searchParams?.utm_source) url.searchParams.set('utm_source', searchParams.utm_source)
    url.searchParams.set('event_slug', event.slug)
    redirect(url.toString())  // Next.js → 307 redirect
  }
  // ... обычный рендер с кнопкой «Открыть в Telegram» ...
}
```

---

## 10. Возврат с лендинга и предотвращение петли

После регистрации лендинг клиента делает редирект на:

```
https://t.me/{bot}/{app}?startapp=ref_pg{slug}_reg
```

или (для VIP с собственным ботом и Main Mini App без short_name):

```
https://t.me/{bot_handle}?startapp=ref_pg{slug}_reg
```

Флаг `_reg`:
- Inline-script видит `regFlag = true` → НЕ ставит `__redirectPending`,
  НЕ запускает fetch. React монтируется обычным путём
- React в `App.tsx` парсит флаг → передаёт в EventPage как `regFromLanding={true}`
- EventPage при `regFromLanding && !is_registered` → автоматически вызывает
  `registerParticipant({event_slug, tg_id, ...})` без email/phone
- Бэк создаёт `event_participants(is_registered=true)` → React показывает
  WelcomePage один раз

### ⚠️ Что НЕ должен делать клиент в редиректе

Клиент в своём конструкторе лендинга **не должен** дописывать к ссылке
свои параметры через `?` или `&` (например, `?email={email}&phone={phone}`).
Telegram отклоняет startapp с ошибкой «Произошла ошибка»: значение
параметра `startapp` принимает только `[a-zA-Z0-9_-]{1,64}` — никаких
`?`, `&`, `{}` или кириллицы.

Если клиенту нужно передать к нам email/phone — это решается через
**webhook на стороне его конструктора**, не через URL.

---

## 11. Все задержки и зачем они нужны

| Задержка | Где | Цель |
|---|---|---|
| Splash в HTML виден сразу | `index.html` `<style>` | Покрыть 1-7 сек загрузки 242 КБ JS-бандла. Без этого — белый экран |
| Установка `__redirectPending=true` | `index.html` inline | Синхронно (до fetch) — чтобы React не успел отрендерить EventPage |
| 3000мс safety в inline-script | `setTimeout` для флага | Если бэк завис — флаг точно снимется, React не залипнет |
| 50мс polling в App.tsx | `setTimeout(tick, 50)` | Балланс между задержкой ответа и нагрузкой на CPU |
| 600мс minDelay | App.tsx `tick()` | Убирает «моргание» splash на быстрых устройствах |
| 3500мс hard timeout | App.tsx `tick()` | 3000мс inline + 500мс цикл — фолбэк если флаг не снялся |
| 1800мс «Скопировано» | ExternalLandingBlock | UX-обратная связь о копировании |
| `pendingOpen` оверлей в openEvent | App.tsx | UX-обратная связь о клике (200-500мс fetch) |

---

## 12. Чек-лист повторения в другом проекте

- [ ] **Backend endpoint** `/landing-redirect` с проверкой статуса/регистрации,
      возвращающий `{redirect_url}` или `{}`
- [ ] **`window.location.replace(url)`** для самого редиректа (НЕ `openLink`/`window.open`)
- [ ] **Inline-script в `index.html`** делает fetch и redirect ДО React
- [ ] **Брендированный splash в HTML** для покрытия загрузки JS-бандла
- [ ] **Флаг `window.__redirectPending`** для синхронизации inline-script ↔ React
- [ ] **Safety-таймаут 3 сек** в inline-script — на случай зависшего бэка
- [ ] **600мс minDelay в React** — против «мерцания» splash
- [ ] **`openEvent` в роутере SPA** перехватывает клик и делает fetch + replace ДО рендера события
- [ ] **`SpinnerOverlay` в SPA-навигации** — обратная связь о клике
- [ ] **`useEffect` в EventPage как fallback** на случай прямой URL-навигации
- [ ] **Server Component с `redirect()`** для веб-входа без `?app=tg`
- [ ] **Флаг `_reg` в startapp** — возврат с лендинга, защита от петли
- [ ] **На стороне клиента — точная ссылка без своих query-параметров**
      (`startapp` Telegram принимает только `[a-zA-Z0-9_-]{1,64}`)
- [ ] **Учёт VIP-клиента** — ссылка возврата на его собственный `{bot_handle}`,
      а не на общий `pluson_bot/pluson`

---

## 13. Что НЕ работает / минусы решения

| Минус | Что делать |
|---|---|
| Mini App webview «уплывает» на лендинг — по «Назад» возвращается на стартовый URL Mini App | Использовать `window.location.replace`, не `.href` — тогда страница-источник в history не сохраняется |
| Если лендинг долго грузится (Tilda иногда 1-3 сек) — пользователь видит белый экран | На стороне лендинга — preload/skeleton. На нашей стороне — splash остаётся пока webview не перейдёт |
| iframe-внедрение лендингов невозможно (Tilda/GetCourse/Taplink ставят X-Frame-Options) | `window.location` — это не iframe, эти заголовки не применяются. Идём в эту сторону |
| `Telegram.WebApp.openLink` на iOS открывает в Safari, не во встроенном | Используем `window.location.replace` — он остаётся внутри Mini App webview |
| Клиент дописывает свои `?email=...` к startapp-ссылке | Жирное предупреждение в инструкции дашборда + получение email/phone через webhook, не через URL |

---

## 14. Файлы в проекте

- [`mini-app/index.html`](../mini-app/index.html) — splash, inline-script, флаг
- [`mini-app/src/App.tsx`](../mini-app/src/App.tsx) — синхронизация с флагом, `openEvent`
- [`mini-app/src/components/SpinnerOverlay.tsx`](../mini-app/src/components/SpinnerOverlay.tsx) — оверлей при SPA-навигации
- [`mini-app/src/pages/EventPage.tsx`](../mini-app/src/pages/EventPage.tsx) — useEffect-фолбэк
- [`backend/app/api/client_profile.py`](../backend/app/api/client_profile.py) — endpoint `/landing-redirect`
- [`web/src/app/l/[slug]/page.tsx`](../web/src/app/l/[slug]/page.tsx) — Server Component редирект
- [`web/src/components/ExternalLandingBlock.tsx`](../web/src/components/ExternalLandingBlock.tsx) — UI инструкция в дашборде
