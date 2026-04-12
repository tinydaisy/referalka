-- ═══════════════════════════════════════════════════════════════════
-- Миграция 003: Рефакторинг спикеров
-- conf_speakers → speakers (глобальная база) + conf_speaker_events (участие в событии)
-- ═══════════════════════════════════════════════════════════════════

-- 1. Глобальная база спикеров (имя, фото, регалии, контакты — хранятся один раз)
CREATE TABLE IF NOT EXISTS speakers (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(255) NOT NULL,
    title               VARCHAR(500),           -- регалии/должность
    company             VARCHAR(255),
    bio                 TEXT,
    achievements        TEXT,
    photo_url           TEXT,
    photo_folder_url    TEXT,                   -- папка с фотографиями
    video_folder_url    TEXT,                   -- папка с видео
    telegram_url        TEXT,
    instagram_url       TEXT,
    website_url         TEXT,
    created_by_client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW()
);

-- 2. Участие спикера в конкретном событии (тема, подарок, роль — своя для каждой конференции)
CREATE TABLE IF NOT EXISTS conf_speaker_events (
    id              SERIAL PRIMARY KEY,
    speaker_id      INTEGER NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    role            VARCHAR(50) DEFAULT 'speaker',  -- speaker/headliner/partner/organizer/commercial/general_partner
    speaker_topic   TEXT,           -- тема выступления в этой конференции
    gift_title      TEXT,           -- подарок от спикера для этой конференции
    gift_url        TEXT,
    poster_url      TEXT,           -- индивидуальная афиша для этой конференции
    partner_url     TEXT,           -- ссылка партнёра (для роли partner)
    extra_info      TEXT,           -- доп. информация под конкретную конференцию
    ref_code        VARCHAR(50) UNIQUE,  -- реферальный код спикера в этом событии
    is_visible      BOOLEAN DEFAULT TRUE,
    sort_order      INTEGER DEFAULT 0,
    created_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(speaker_id, event_id)
);

-- 3. Мигрируем данные из старой таблицы conf_speakers (если она есть)
DO $$
DECLARE
    old_speaker RECORD;
    new_speaker_id INTEGER;
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'conf_speakers') THEN
        FOR old_speaker IN SELECT * FROM conf_speakers LOOP
            -- Проверяем — нет ли уже спикера с таким именем в базе
            SELECT id INTO new_speaker_id FROM speakers WHERE name = old_speaker.name LIMIT 1;

            IF new_speaker_id IS NULL THEN
                -- Создаём в глобальной базе
                INSERT INTO speakers (
                    name, title, company, bio, achievements,
                    photo_url, photo_folder_url, video_folder_url,
                    telegram_url, instagram_url, website_url, created_at
                ) VALUES (
                    old_speaker.name,
                    old_speaker.title,
                    old_speaker.company,
                    old_speaker.bio,
                    old_speaker.achievements,
                    old_speaker.photo_url,
                    old_speaker.photo_folder_url,
                    old_speaker.video_folder_url,
                    old_speaker.telegram_url,
                    old_speaker.instagram_url,
                    old_speaker.website_url,
                    old_speaker.created_at
                ) RETURNING id INTO new_speaker_id;
            END IF;

            -- Создаём запись участия в событии
            INSERT INTO conf_speaker_events (
                speaker_id, event_id, role, speaker_topic,
                gift_title, gift_url, poster_url, partner_url,
                extra_info, ref_code, is_visible, sort_order
            ) VALUES (
                new_speaker_id,
                old_speaker.event_id,
                old_speaker.role,
                old_speaker.speaker_topic,
                old_speaker.gift_title,
                old_speaker.gift_url,
                old_speaker.poster_url,
                old_speaker.partner_url,
                old_speaker.extra_info,
                old_speaker.ref_code,
                old_speaker.is_visible,
                old_speaker.sort_order
            ) ON CONFLICT (speaker_id, event_id) DO NOTHING;

        END LOOP;

        -- 4. Обновляем внешние ключи в зависимых таблицах
        -- conf_sessions: speaker_id теперь ссылается на conf_speaker_events.id
        ALTER TABLE conf_sessions DROP CONSTRAINT IF EXISTS conf_sessions_speaker_id_fkey;

        -- Обновляем значения: speaker_id (старый conf_speakers.id) → conf_speaker_events.id
        UPDATE conf_sessions cs
        SET speaker_id = cse.id
        FROM conf_speakers old_sp
        JOIN conf_speaker_events cse ON cse.event_id = old_sp.event_id
        JOIN speakers sp ON sp.id = cse.speaker_id AND sp.name = old_sp.name
        WHERE cs.speaker_id = old_sp.id AND cs.event_id = old_sp.event_id;

        ALTER TABLE conf_sessions
            ADD CONSTRAINT conf_sessions_speaker_event_fkey
            FOREIGN KEY (speaker_id) REFERENCES conf_speaker_events(id) ON DELETE SET NULL;

        -- conf_secret_codes
        ALTER TABLE conf_secret_codes DROP CONSTRAINT IF EXISTS conf_secret_codes_speaker_id_fkey;

        UPDATE conf_secret_codes csc
        SET speaker_id = cse.id
        FROM conf_speakers old_sp
        JOIN conf_speaker_events cse ON cse.event_id = old_sp.event_id
        JOIN speakers sp ON sp.id = cse.speaker_id AND sp.name = old_sp.name
        WHERE csc.speaker_id = old_sp.id AND csc.event_id = old_sp.event_id;

        ALTER TABLE conf_secret_codes
            ADD CONSTRAINT conf_secret_codes_speaker_event_fkey
            FOREIGN KEY (speaker_id) REFERENCES conf_speaker_events(id) ON DELETE SET NULL;

        -- conf_broadcast_messages
        ALTER TABLE conf_broadcast_messages DROP CONSTRAINT IF EXISTS conf_broadcast_messages_speaker_id_fkey;

        UPDATE conf_broadcast_messages cbm
        SET speaker_id = cse.id
        FROM conf_speakers old_sp
        JOIN conf_speaker_events cse ON cse.event_id = old_sp.event_id
        JOIN speakers sp ON sp.id = cse.speaker_id AND sp.name = old_sp.name
        WHERE cbm.speaker_id = old_sp.id AND cbm.event_id = old_sp.event_id;

        ALTER TABLE conf_broadcast_messages
            ADD CONSTRAINT conf_broadcast_messages_speaker_event_fkey
            FOREIGN KEY (speaker_id) REFERENCES conf_speaker_events(id) ON DELETE SET NULL;

        -- 5. Удаляем старую таблицу
        DROP TABLE conf_speakers;

        RAISE NOTICE 'Миграция выполнена: conf_speakers → speakers + conf_speaker_events';
    ELSE
        -- Таблицы conf_speakers нет — просто добавляем FK к новым таблицам если нужно
        RAISE NOTICE 'conf_speakers не найдена, миграция данных не нужна';
    END IF;
END $$;

-- 6. Индексы
CREATE INDEX IF NOT EXISTS idx_speakers_name ON speakers(name);
CREATE INDEX IF NOT EXISTS idx_conf_speaker_events_speaker ON conf_speaker_events(speaker_id);
CREATE INDEX IF NOT EXISTS idx_conf_speaker_events_event ON conf_speaker_events(event_id);
