-- Миграция 174: чаты события — внешний ключ на client_broadcast_chats (база чатов клиента),
-- вместо текстовых tg_chat_id/vk_chat_id/max_chat_id + chat_url_tg/vk/max.
--
-- Идея: клиент добавляет чат ОДИН раз в Каналы→«Чаты для рассылок» (там ID+ссылка),
-- а в настройках события просто ВЫБИРАЕТ чат из списка. Событие хранит ref на чат,
-- ID и ссылка берутся JOIN-ом из client_broadcast_chats.
--
-- Один чат на платформу (по одному ref на TG/VK/MAX).
-- primary_chat_platform, chat_subscriptions_required, chat_button_label, chat_greeting_*
-- НЕ трогаем — они про другое.

-- 1) Новые FK-поля
ALTER TABLE events ADD COLUMN IF NOT EXISTS tg_chat_ref  INTEGER NULL REFERENCES client_broadcast_chats(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS vk_chat_ref  INTEGER NULL REFERENCES client_broadcast_chats(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS max_chat_ref INTEGER NULL REFERENCES client_broadcast_chats(id) ON DELETE SET NULL;

-- 2) Перенос данных: для каждого события с заполненным chat_id ИЛИ chat_url —
--    найти/создать запись в client_broadcast_chats (по client_id+platform+chat_id)
--    и проставить ref. client_id события = первый accepted-владелец.
--    Если chat_id пуст, но есть chat_url (только ссылка-приглашение без слушания) —
--    создаём запись с chat_id = '' (пустой) и chat_url, чтобы кнопка «Вступить» работала;
--    но такие в слушании не участвуют (chat_id пуст).

DO $$
DECLARE
  r RECORD;
  v_client_id INTEGER;
  v_cbc_id INTEGER;
BEGIN
  FOR r IN
    SELECT e.id AS event_id,
           NULLIF(TRIM(e.tg_chat_id), '')  AS tg_id,  NULLIF(TRIM(e.chat_url_tg), '')  AS tg_url,
           NULLIF(TRIM(e.vk_chat_id), '')  AS vk_id,  NULLIF(TRIM(e.chat_url_vk), '')  AS vk_url,
           NULLIF(TRIM(e.max_chat_id), '') AS max_id, NULLIF(TRIM(e.chat_url_max), '') AS max_url
      FROM events e
     WHERE COALESCE(NULLIF(TRIM(e.tg_chat_id),''), NULLIF(TRIM(e.vk_chat_id),''), NULLIF(TRIM(e.max_chat_id),''),
                    NULLIF(TRIM(e.chat_url_tg),''), NULLIF(TRIM(e.chat_url_vk),''), NULLIF(TRIM(e.chat_url_max),'')) IS NOT NULL
  LOOP
    SELECT eo.client_id INTO v_client_id
      FROM event_owners eo
     WHERE eo.event_id = r.event_id AND eo.status = 'accepted'
     ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1;
    IF v_client_id IS NULL THEN CONTINUE; END IF;

    -- TELEGRAM
    IF r.tg_id IS NOT NULL OR r.tg_url IS NOT NULL THEN
      SELECT id INTO v_cbc_id FROM client_broadcast_chats
        WHERE client_id = v_client_id AND platform = 'telegram'
          AND chat_id = COALESCE(r.tg_id, '') LIMIT 1;
      IF v_cbc_id IS NULL THEN
        INSERT INTO client_broadcast_chats (client_id, platform, chat_id, title, chat_url, added_via, is_active, use_for_broadcasts)
        VALUES (v_client_id, 'telegram', COALESCE(r.tg_id, ''),
                'Чат события #' || r.event_id, r.tg_url, 'manual', TRUE, TRUE)
        ON CONFLICT (client_id, platform, chat_id) DO UPDATE SET chat_url = COALESCE(client_broadcast_chats.chat_url, EXCLUDED.chat_url)
        RETURNING id INTO v_cbc_id;
      ELSIF r.tg_url IS NOT NULL THEN
        UPDATE client_broadcast_chats SET chat_url = COALESCE(chat_url, r.tg_url) WHERE id = v_cbc_id;
      END IF;
      UPDATE events SET tg_chat_ref = v_cbc_id WHERE id = r.event_id;
    END IF;

    -- VK
    IF r.vk_id IS NOT NULL OR r.vk_url IS NOT NULL THEN
      SELECT id INTO v_cbc_id FROM client_broadcast_chats
        WHERE client_id = v_client_id AND platform = 'vk'
          AND chat_id = COALESCE(r.vk_id, '') LIMIT 1;
      IF v_cbc_id IS NULL THEN
        INSERT INTO client_broadcast_chats (client_id, platform, chat_id, title, chat_url, added_via, is_active, use_for_broadcasts)
        VALUES (v_client_id, 'vk', COALESCE(r.vk_id, ''),
                'Чат события #' || r.event_id, r.vk_url, 'manual', TRUE, TRUE)
        ON CONFLICT (client_id, platform, chat_id) DO UPDATE SET chat_url = COALESCE(client_broadcast_chats.chat_url, EXCLUDED.chat_url)
        RETURNING id INTO v_cbc_id;
      ELSIF r.vk_url IS NOT NULL THEN
        UPDATE client_broadcast_chats SET chat_url = COALESCE(chat_url, r.vk_url) WHERE id = v_cbc_id;
      END IF;
      UPDATE events SET vk_chat_ref = v_cbc_id WHERE id = r.event_id;
    END IF;

    -- MAX
    IF r.max_id IS NOT NULL OR r.max_url IS NOT NULL THEN
      SELECT id INTO v_cbc_id FROM client_broadcast_chats
        WHERE client_id = v_client_id AND platform = 'max'
          AND chat_id = COALESCE(r.max_id, '') LIMIT 1;
      IF v_cbc_id IS NULL THEN
        INSERT INTO client_broadcast_chats (client_id, platform, chat_id, title, chat_url, added_via, is_active, use_for_broadcasts)
        VALUES (v_client_id, 'max', COALESCE(r.max_id, ''),
                'Чат события #' || r.event_id, r.max_url, 'manual', TRUE, TRUE)
        ON CONFLICT (client_id, platform, chat_id) DO UPDATE SET chat_url = COALESCE(client_broadcast_chats.chat_url, EXCLUDED.chat_url)
        RETURNING id INTO v_cbc_id;
      ELSIF r.max_url IS NOT NULL THEN
        UPDATE client_broadcast_chats SET chat_url = COALESCE(chat_url, r.max_url) WHERE id = v_cbc_id;
      END IF;
      UPDATE events SET max_chat_ref = v_cbc_id WHERE id = r.event_id;
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS events_tg_chat_ref_idx  ON events (tg_chat_ref)  WHERE tg_chat_ref  IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_vk_chat_ref_idx  ON events (vk_chat_ref)  WHERE vk_chat_ref  IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_max_chat_ref_idx ON events (max_chat_ref) WHERE max_chat_ref IS NOT NULL;

-- DROP старых колонок — добавляется в КОНЦЕ после grep-проверки кода (см. ниже).
