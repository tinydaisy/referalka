-- ═══════════════════════════════════════════
-- Миграция 037: Квоты файлового хранилища
--
-- Каждый клиент получает квоту в R2 (по умолчанию 500 МБ).
-- Таблица client_files учитывает каждый загруженный файл:
--   id, client_id, kind, r2_key, url, size_bytes, content_type, created_at,
--   ref-поля (event_id, collaborator_id, lead_magnet_id) — чтобы знать «к чему файл привязан»
--
-- При загрузке: проверяем (used + new_size <= quota) → 413 если превысил, иначе вставляем строку.
-- При удалении файла: удаляем строку → пересчитываем used.
-- Поле clients.storage_used_bytes — кэш суммы для быстрого доступа без агрегации.
-- ═══════════════════════════════════════════

BEGIN;

-- 1. Поля квоты на клиенте
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS storage_quota_bytes BIGINT NOT NULL DEFAULT 524288000,  -- 500 МБ
  ADD COLUMN IF NOT EXISTS storage_used_bytes  BIGINT NOT NULL DEFAULT 0;

-- 2. Таблица файлов
CREATE TABLE IF NOT EXISTS client_files (
    id              SERIAL PRIMARY KEY,
    client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,            -- event_poster | lead_magnet | certificate | referral_material | speaker_photo
    r2_key          TEXT NOT NULL UNIQUE,     -- путь в бакете: clients/5/events/4/posters/horizontal/abc.jpg
    url             TEXT NOT NULL,            -- полный публичный URL
    size_bytes      BIGINT NOT NULL,
    content_type    TEXT,
    -- к чему привязан (опционально, для удобства cleanup при удалении сущности)
    event_id        INTEGER REFERENCES events(id) ON DELETE SET NULL,
    collaborator_id INTEGER REFERENCES collaborators(id) ON DELETE SET NULL,
    lead_magnet_id  INTEGER REFERENCES lead_magnets(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_files_client ON client_files(client_id);
CREATE INDEX IF NOT EXISTS idx_client_files_event  ON client_files(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_client_files_kind   ON client_files(kind);

COMMIT;
