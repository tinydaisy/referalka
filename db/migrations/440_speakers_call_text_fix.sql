-- 440: Починить текст шаблона speakers_call — в библиотеке и у уже созданных.
--
-- ⚠️ ЧТО СЛОМАЛОСЬ. Миграция 432 вставила шаблон через ON CONFLICT DO NOTHING.
-- Она накатилась на прод РАНЬШЕ, чем текст шаблона был доправлен (убрали
-- {webinar_room_url}, заголовок стал «заходите в зум через 5 минут», появился
-- {speaker_join_url}). Повторный накат 432 ничего не менял — DO NOTHING молча
-- пропускал уже существующую строку. В итоге в библиотеке остался ПЕРВЫЙ
-- вариант текста, и он же скопировался событиям при добавлении шаблона.
--
-- Урок на будущее: правка ТЕКСТА уже вставленного шаблона требует отдельной
-- миграции с UPDATE. Менять тело INSERT ... ON CONFLICT DO NOTHING бесполезно —
-- на проде это no-op, а расходится только там.
--
-- {webinar_room_url} в коде больше не существует: у эфира одна ссылка
-- {stream_url} (наша комната или сторонний сервис — что выбрано в «Вебинарах»),
-- а вход СПИКЕРА в зум — отдельное поле дня, {speaker_join_url} (миграция 433).

-- ── 1. Библиотека ────────────────────────────────────────────────────────
UPDATE default_broadcast_templates SET
  text =
    '<b>{speaker_name} ({speaker_tg_username}) — заходите в зум через 5 минут</b>' || E'\n\n' ||
    'Ваше выступление в {speaker_time}' || E'\n\n' ||
    'Ссылка для входа (Zoom):' || E'\n' ||
    '{speaker_join_url}' || E'\n\n' ||
    'Ссылка на эфир: {stream_url}' || E'\n\n' ||
    '—————' || E'\n\n' ||
    'Готовится к {next_speaker_time}: {next_speaker_name} ({next_speaker_tg_username})' || E'\n\n' ||
    '—————' || E'\n\n' ||
    'Поставьте реакцию — что вы на связи.',
  updated_at = NOW()
WHERE type = 'speakers_call';

-- ── 2. Уже созданные у событий ───────────────────────────────────────────
-- Чиним ТОЛЬКО те, что содержат мёртвый {webinar_room_url}: этот плейсхолдер
-- в коде не существует и уйдёт получателю сырым. Шаблоны, где клиент уже
-- переписал текст под себя, такого маркера не имеют — их не трогаем.
UPDATE broadcast_templates SET
  text =
    '<b>{speaker_name} ({speaker_tg_username}) — заходите в зум через 5 минут</b>' || E'\n\n' ||
    'Ваше выступление в {speaker_time}' || E'\n\n' ||
    'Ссылка для входа (Zoom):' || E'\n' ||
    '{speaker_join_url}' || E'\n\n' ||
    'Ссылка на эфир: {stream_url}' || E'\n\n' ||
    '—————' || E'\n\n' ||
    'Готовится к {next_speaker_time}: {next_speaker_name} ({next_speaker_tg_username})' || E'\n\n' ||
    '—————' || E'\n\n' ||
    'Поставьте реакцию — что вы на связи.',
  updated_at = NOW()
WHERE type = 'speakers_call'
  AND text LIKE '%{webinar_room_url}%';

-- ── 3. То же в снимках ещё не отправленных рассылок ──────────────────────
-- snapshot_text копируется при генерации очереди. Записи в статусе draft/pending
-- ещё не ушли — там мёртвый плейсхолдер тоже надо убрать.
UPDATE broadcast_schedules SET
  snapshot_text = (SELECT text FROM default_broadcast_templates WHERE type = 'speakers_call')
WHERE type = 'speakers_call'
  AND status IN ('draft', 'pending')
  AND snapshot_text LIKE '%{webinar_room_url}%';
