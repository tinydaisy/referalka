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
 *   https://plusson.app/l/ivision-7?app=tg&pid=abc123&utm_source=insta
 *   (старое имя `new_partner_id` тоже понимаем — для обратной совместимости)
 *
 * Формат startapp (передаётся в Telegram):
 *   ref_pg{event_slug}[_pid{partner_id}][_src{utm_source}]
 *   Примеры: ref_pgivision-7 · ref_pgivision-7_pidabc123 · ref_pgivision-7_pidabc123_srcinsta
 * ─────────────────────────────────────────────────────────────
 */
(function(){
  if(typeof PAGE_CODE === 'undefined' || !PAGE_CODE) return;
  if(typeof APP_CONFIG === 'undefined' || !APP_CONFIG) return;

  var sp  = new URLSearchParams(window.location.search);
  var app = sp.get('app') || '';
  if(!app) return;

  // pid — короткое имя (новое); new_partner_id — старое (обратная совместимость).
  var pid = sp.get('pid') || sp.get('new_partner_id') || '';
  var src = sp.get('utm_source')     || '';

  // ── Telegram ──────────────────────────────────────────────
  if(app === 'tg' && APP_CONFIG.tg){
    var parts = ['ref', 'pg' + PAGE_CODE];
    if(pid) parts.push('pid' + pid);
    if(src) parts.push('src' + src);
    // CLIENT_ID — подсказка фронту Mini App: какому клиенту принадлежит
    // событие. Нужно когда в BotFather у бота клиента URL Mini App общий
    // (`/tg/` вместо `/c/{N}/tg/`) — иначе откроется HubSelector.
    if(typeof CLIENT_ID !== 'undefined' && CLIENT_ID) parts.push('cid' + CLIENT_ID);
    window.location.replace(APP_CONFIG.tg + '?startapp=' + parts.join('_'));
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
