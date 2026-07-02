-- 189: Флаг «выдавать подарки реф-программы через воронку лид-магнита».
--
-- FALSE (default) — как сейчас: подарок = прямая ссылка на файл (lead_magnets.url).
-- TRUE — подарок ведёт на воронку pluson.ru/m/{slug} (проверка подписки на канал
--        + follow-up), а не сразу на файл. Одна настройка на всё событие.
--
-- Не ломает существующие события: FALSE = текущее поведение.

ALTER TABLE event_referral_settings
  ADD COLUMN IF NOT EXISTS gift_via_funnel BOOLEAN NOT NULL DEFAULT FALSE;

-- Роль БД на проде/dev — plusson (не postgres). GRANT'ы на таблицу уже есть,
-- новая колонка их наследует; отдельный GRANT не нужен.
