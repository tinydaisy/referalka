/**
 * app_config.js — настройки платформ для redirect_web_app
 * ─────────────────────────────────────────────────────────────
 * Это единственное место где прописываются ссылки на Mini App.
 * При смене бота или названия Mini App — редактировать только этот файл.
 *
 * Подключается в <head> каждой страницы ДО redirect_web_app.js:
 *   <script src="/redirect_web_app/app_config.js"></script>
 *   <script src="/redirect_web_app/redirect_web_app.js"></script>
 */
var APP_CONFIG = {
  tg: 'https://t.me/pluson_bot/plusson'
  // max: 'https://...'   // будущая поддержка Max
};
