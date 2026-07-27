-- 236: продающий блок вебинара «Регистрация на событие» (kind='event_reg').
-- Клиент выбирает предстоящее событие (напр. конференцию) из выпадающего списка,
-- задаёт свой текст кнопки. Зритель жмёт → сразу регистрируется на это событие
-- (у него уже есть contact_id — форма не нужна). Если он в наших ботах — бот шлёт
-- «вы зарегистрированы»; если нет — страница «Выберите удобный мессенджер»
-- с кнопками площадок клиента (TG/MAX/VK).
-- kind у webinar_blocks — свободный TEXT (CHECK нет), новую константу добавлять не надо.

ALTER TABLE webinar_blocks
  ADD COLUMN IF NOT EXISTS reg_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_blocks TO plusson;
