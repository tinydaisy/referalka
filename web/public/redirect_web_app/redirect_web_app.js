/**
 * redirect_web_app.js
 * ─────────────────────────────────────────────────────────────
 * Универсальный маршрутизатор: Web → Telegram Mini App (→ Max и др. в будущем)
 *
 * Принцип работы:
 *   Страница открывается с параметром ?app=tg (или другим).
 *   Скрипт перехватывает запрос и перенаправляет пользователя
 *   в нужное приложение, передавая туда event slug и UTM-параметры.
 *
 * Как подключить к странице (Next.js компонент lendinga):
 *   PAGE_CODE задаётся динамически = event.slug из БД
 *   <Script>var PAGE_CODE = '{event.slug}';</Script>
 *   <Script src="/redirect_web_app/app_config.js" />
 *   <Script src="/redirect_web_app/redirect_web_app.js" />
 *
 * Формат ссылки для открытия в Telegram:
 *   https://plusson.app/l/ivision-7?app=tg
 *   https://plusson.app/l/ivision-7?app=tg&new_partner_id=123&utm_source=insta
 *
 * Формат startapp (передаётся в Telegram):
 *   ref_pg{event_slug}[_pid{partner_id}][_src{utm_source}]
 *   Примеры: ref_pgivision-7 · ref_pgivision-7_pid123 · ref_pgivision-7_pid123_srcinsta
 * ─────────────────────────────────────────────────────────────
 */
(function(){
  if(typeof PAGE_CODE === 'undefined' || !PAGE_CODE) return;
  if(typeof APP_CONFIG === 'undefined' || !APP_CONFIG) return;

  var sp  = new URLSearchParams(window.location.search);
  var app = sp.get('app') || '';
  if(!app) return;

  var pid = sp.get('new_partner_id') || '';
  var src = sp.get('utm_source')     || '';

  // ── Telegram ──────────────────────────────────────────────
  if(app === 'tg' && APP_CONFIG.tg){
    var parts = ['ref', 'pg' + PAGE_CODE];
    if(pid) parts.push('pid' + pid);
    if(src) parts.push('src' + src);
    var startApp = parts.join('_');

    // Парсим botUsername и appName из APP_CONFIG.tg = 'https://t.me/<bot>/<app>'
    var seg = APP_CONFIG.tg.replace(/^https?:\/\/t\.me\//, '').split('/');
    var bot  = seg[0] || '';
    var name = seg[1] || '';

    // Сперва — нативная схема tg://. Открывает Mini App и в Safari, и в
    // Telegram-webview. Universal Link https://t.me/... в Safari иногда
    // открывает только чат бота, не Mini App — поэтому он только fallback.
    var deepLink = 'tg://resolve?domain=' + bot
      + (name ? '&appname=' + name : '')
      + (startApp ? '&startapp=' + startApp : '');
    var httpsLink = APP_CONFIG.tg + '?startapp=' + startApp;

    window.location.replace(deepLink);

    // Если через 1.5 сек страница всё ещё видна — Telegram не установлен
    // или не подхватил tg://-схему. Откатываемся на https://t.me/...
    setTimeout(function(){
      if(!document.hidden){
        window.location.replace(httpsLink);
      }
    }, 1500);
    return;
  }

  // ── Max (зарезервировано) ──────────────────────────────────
  // if(app === 'max' && APP_CONFIG.max){
  //   var parts = ['ref', 'pg' + PAGE_CODE];
  //   if(pid) parts.push('pid' + pid);
  //   if(src) parts.push('src' + src);
  //   window.location.replace(APP_CONFIG.max + '?startapp=' + parts.join('_'));
  //   return;
  // }
})();
