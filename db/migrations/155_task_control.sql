-- Миграция 151: Контроль заданий — кодовые фразы критериев + лог пойманных
-- сообщений-выкладок + настройки слушания по этапам.

-- 1) Кодовая фраза у критерия (только manual). Поиск в тексте сообщения чата
--    события: где угодно, без регистра. ОДНА фраза на критерий.
ALTER TABLE tournament_criteria ADD COLUMN IF NOT EXISTS code_phrase TEXT;
COMMENT ON COLUMN tournament_criteria.code_phrase IS 'Кодовая фраза для авто-зачёта по сообщению в чате (#дз1, «Лицензию получил»). Только manual-критерии.';

-- 2) Глобальная галка «включить слушание заданий» на событие.
ALTER TABLE events ADD COLUMN IF NOT EXISTS task_listen_enabled BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN events.task_listen_enabled IS 'Слушать чаты события и ловить кодовые фразы заданий (вкладка «Контроль заданий»).';

-- 3) Кого слушаем на этапе: viewers (участники event_participants) | speakers (event_collaborators).
ALTER TABLE conf_stages ADD COLUMN IF NOT EXISTS listen_audience TEXT NOT NULL DEFAULT 'viewers';
ALTER TABLE conf_stages ADD CONSTRAINT conf_stages_listen_audience_chk
  CHECK (listen_audience IN ('viewers','speakers'));
COMMENT ON COLUMN conf_stages.listen_audience IS 'Кого слушаем в этом этапе: viewers (участники) | speakers (спикеры/жюри).';

-- 4) Лог пойманных сообщений-выкладок (что засчитали по кодовой фразе).
CREATE TABLE IF NOT EXISTS task_submissions (
    id             BIGSERIAL PRIMARY KEY,
    event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    criterion_id   BIGINT REFERENCES tournament_criteria(id) ON DELETE SET NULL,
    stage_id       BIGINT REFERENCES conf_stages(id) ON DELETE SET NULL,
    code_phrase    TEXT,                          -- какая фраза сработала
    platform       TEXT NOT NULL,                 -- telegram | vk | max
    chat_id        TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,               -- автор (id на площадке)
    username       TEXT,
    author_name    TEXT,
    -- опознанный участник турнира (если нашёлся):
    subject_kind   TEXT,                          -- ec | ep | NULL (не опознан)
    subject_id     BIGINT,                        -- event_collaborators.id | event_participants.id
    contact_id     INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    recognized     BOOLEAN NOT NULL DEFAULT FALSE,-- опознан ли автор как участник турнира
    text           TEXT,
    message_link   TEXT,                          -- ссылка на сообщение в чате (где платформа даёт)
    attachments    JSONB NOT NULL DEFAULT '[]',   -- [{kind, url}] вложения ссылками
    score_applied  BOOLEAN NOT NULL DEFAULT FALSE,-- проставлен ли балл в tournament_scores
    message_ref    TEXT,                          -- id сообщения платформы (дедуп)
    sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT task_submissions_platform_chk CHECK (platform IN ('telegram','vk','max')),
    CONSTRAINT task_submissions_subject_kind_chk CHECK (subject_kind IS NULL OR subject_kind IN ('ec','ep'))
);

-- Дедуп: одно сообщение × один критерий не засчитываем дважды.
CREATE UNIQUE INDEX IF NOT EXISTS task_submissions_dedup_uq
  ON task_submissions (event_id, platform, chat_id, message_ref, criterion_id)
  WHERE message_ref IS NOT NULL AND criterion_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS task_submissions_event_idx ON task_submissions (event_id, sent_at);
CREATE INDEX IF NOT EXISTS task_submissions_criterion_idx ON task_submissions (criterion_id);
CREATE INDEX IF NOT EXISTS task_submissions_subject_idx ON task_submissions (event_id, subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS task_submissions_recognized_idx ON task_submissions (event_id, recognized);

GRANT SELECT, INSERT, UPDATE, DELETE ON task_submissions TO plusson;
GRANT USAGE, SELECT ON task_submissions_id_seq TO plusson;
