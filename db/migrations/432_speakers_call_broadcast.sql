-- 432: Рассылка «Спикеру — вы следующие» (тип speakers_call).
--
-- Сообщение уходит В ЧАТ СПИКЕРОВ (миграция 431) за 15 минут до выступления
-- по программе: кто выступает сейчас, во сколько, ссылки на эфир и кто
-- готовится следом. Участникам события НЕ уходит — это служебная рассылка
-- для команды спикеров.
--
-- Почему новый флаг, а не send_to_event_chats: чат события — это чат
-- УЧАСТНИКОВ, там такому сообщению не место. Флаги независимы, как и
-- send_to_client_chats / send_to_private_chats (миграции 165, 170, 196).

-- ── 1. Флаг «слать в чат спикеров» у шаблона и у расписания ──────────────
ALTER TABLE broadcast_templates
  ADD COLUMN IF NOT EXISTS send_to_speakers_chat BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE broadcast_schedules
  ADD COLUMN IF NOT EXISTS send_to_speakers_chat BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN broadcast_templates.send_to_speakers_chat
  IS 'Слать в чат спикеров события (tg/vk/max_speakers_chat_ref)';

-- ── 2. Флаг в библиотеке дефолтных шаблонов (миграция 217) ───────────────
ALTER TABLE default_broadcast_templates
  ADD COLUMN IF NOT EXISTS send_to_speakers_chat BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 3. Сам шаблон в библиотеке ───────────────────────────────────────────
-- Только конференция и турнир/премия: у мероприятия нет ни спикеров,
-- ни программы по слотам. autoseed=TRUE — появляется у события сразу.
--
-- Плейсхолдеры:
--   {speaker_name} {speaker_tg_username} {speaker_time} — кто выступает
--   {speaker_join_url} — вход СПИКЕРА в эфир дня (Zoom, миграция 433): спикер
--                        заходит туда, чтобы его картинка попала в комнату.
--   {stream_url}       — вебинарная комната дня — для ЗРИТЕЛЕЙ. Резолвится сама
--                        (наша комната или сторонний эфир — что выбрано в «Вебинарах»).
--   {next_speaker_*}   — кто готовится следом
-- Пустой плейсхолдер убирает свою строку целиком (message_builder).
INSERT INTO default_broadcast_templates
  (type, name, subject, text,
   schedule_mode, offset_minutes, audience_include, audience_exclude,
   allow_custom_datetime, for_event, for_conference, for_turnir,
   autoseed, multi_instance, send_to_speakers_chat,
   turnir_name, sort_order)
VALUES (
  'speakers_call',
  'Спикеру: «вы следующие» (в чат спикеров)',
  NULL,
  '<b>{speaker_name} ({speaker_tg_username}) — заходите в зум через 5 минут</b>' || E'\n\n' ||
  'Ваше выступление в {speaker_time}' || E'\n\n' ||
  'Ссылка для входа (Zoom):' || E'\n' ||
  '{speaker_join_url}' || E'\n\n' ||
  'Ссылка на эфир: {stream_url}' || E'\n\n' ||
  '—————' || E'\n\n' ||
  'Готовится к {next_speaker_time}: {next_speaker_name} ({next_speaker_tg_username})' || E'\n\n' ||
  '—————' || E'\n\n' ||
  'Поставьте реакцию — что вы на связи.',
  'fixed_offset',
  15,                -- за 15 минут до начала выступления
  'all_event',       -- не используется: рассылка идёт только в чат
  'all_event',       -- ← обнуляет список получателей: участникам НЕ уходит
  FALSE,
  FALSE,             -- for_event    — у мероприятия спикеров нет
  TRUE,              -- for_conference
  TRUE,              -- for_turnir
  TRUE,              -- autoseed
  FALSE,             -- multi_instance
  TRUE,              -- send_to_speakers_chat
  'Спикеру/номинанту: «вы следующие» (в чат)',
  245
)
ON CONFLICT (type) DO NOTHING;
