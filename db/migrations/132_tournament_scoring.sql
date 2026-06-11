-- Миграция 132 (2026-06-11) — Универсальная система оценки участников турнира.
--
-- Только для событий с module_slug='turnir'. Жюри (коллабораторы с role='jury')
-- оценивают участников (коллабораторов с role='speaker'/'headliner') по критериям.
--
-- Модель «Пакеты → Критерии → Баллы»:
--   • Пакет (tournament_packages)  — смысловая группа критериев: название, вес,
--     этап (stage_id), галочка нормализации. Примеры: «Оценка жюри», «Вовлечение».
--   • Критерий (tournament_criteria) — внутри пакета, всегда даёт число (балл).
--     scorer = кто ставит: 'jury' | 'vote' (народное) | 'manual' (ручной ввод) | 'auto'.
--     auto-критерии считаются сами (referrals / lead_magnet), балл в БД не пишут.
--   • Балл (tournament_scores) — сырое значение. Для jury — строка на каждое жюри
--     (балл критерия = среднее по жюри). Для vote/manual — одна строка, juror=NULL.
--
-- Распределение (tournament_jury_assignments) — many-to-many жюри ↔ участник.
-- Жюри видит в кабинете ТОЛЬКО привязанных к нему участников.
--
-- Обратная связь (tournament_feedback) — один текстовый комментарий от жюри
-- участнику (на этап): «почему такие оценки + что рекомендую». Видят организатор
-- и сам участник (в кабинете спикера).
--
-- Снимки отчётов (tournament_snapshots + _rows + _scores) — по кнопке «Сохранить
-- отчёт» замораживается полная картина результатов на дату (итоги, баллы пакетов,
-- каждый сырой балл каждого жюри + комментарии). Старые снимки не меняются —
-- видна динамика. Это НЕ слепок всей БД, только результаты оценивания.
--
-- ВАЖНО про идентификаторы:
--   subject_ec_id / juror_ec_id ссылаются на event_collaborators.id (коллаб-в-этом-
--   событии), а НЕ на collaborators.id — так роль и принадлежность событию явные.

-- ───────────── Пакеты оценок ─────────────
CREATE TABLE IF NOT EXISTS tournament_packages (
    id          BIGSERIAL PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    stage_id    BIGINT  REFERENCES conf_stages(id) ON DELETE SET NULL,  -- NULL = весь турнир
    title       TEXT    NOT NULL,
    weight      NUMERIC NOT NULL DEFAULT 1 CHECK (weight >= 0),         -- вес пакета в итоге
    normalize   BOOLEAN NOT NULL DEFAULT FALSE,                          -- привести критерии к доле от лучшего
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tournament_packages_event_idx
    ON tournament_packages (event_id, sort_order, id);

-- ───────────── Критерии внутри пакета ─────────────
CREATE TABLE IF NOT EXISTS tournament_criteria (
    id          BIGSERIAL PRIMARY KEY,
    package_id  BIGINT  NOT NULL REFERENCES tournament_packages(id) ON DELETE CASCADE,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- денорм для быстрых выборок
    title       TEXT    NOT NULL,
    description TEXT,                                                       -- подсказка жюри
    scorer      TEXT    NOT NULL DEFAULT 'jury'
                CHECK (scorer IN ('jury', 'vote', 'manual', 'auto')),
    auto_kind   TEXT    CHECK (auto_kind IN ('referrals', 'lead_magnet')), -- только для scorer='auto'
    scale_max   NUMERIC NOT NULL DEFAULT 10 CHECK (scale_max > 0),         -- максимум балла (шкала)
    weight      NUMERIC NOT NULL DEFAULT 1 CHECK (weight >= 0),            -- вес критерия внутри пакета
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tournament_criteria_pkg_idx
    ON tournament_criteria (package_id, sort_order, id);
CREATE INDEX IF NOT EXISTS tournament_criteria_event_idx
    ON tournament_criteria (event_id);

-- ───────────── Сырые баллы ─────────────
-- scorer денормализован в строку, чтобы CHECK мог гарантировать инвариант
-- «jury ⇒ есть juror; иначе juror пуст».
CREATE TABLE IF NOT EXISTS tournament_scores (
    id            BIGSERIAL PRIMARY KEY,
    event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    criterion_id  BIGINT  NOT NULL REFERENCES tournament_criteria(id) ON DELETE CASCADE,
    subject_ec_id BIGINT  NOT NULL REFERENCES event_collaborators(id) ON DELETE CASCADE,  -- кого оценивают
    juror_ec_id   BIGINT  REFERENCES event_collaborators(id) ON DELETE CASCADE,           -- кто поставил (NULL для vote/manual/auto)
    scorer        TEXT    NOT NULL CHECK (scorer IN ('jury', 'vote', 'manual', 'auto')),
    value_number  NUMERIC NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((scorer = 'jury') = (juror_ec_id IS NOT NULL))
);
-- Жюри: одна оценка на (критерий, участник, жюри).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_scores_jury
    ON tournament_scores (criterion_id, subject_ec_id, juror_ec_id)
    WHERE juror_ec_id IS NOT NULL;
-- Не-жюри (народное/ручной/авто): одно значение на (критерий, участник).
-- Частичный индекс ОБЯЗАТЕЛЕН: обычный UNIQUE с NULL не защищает (NULL <> NULL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_scores_nonjury
    ON tournament_scores (criterion_id, subject_ec_id)
    WHERE juror_ec_id IS NULL;
CREATE INDEX IF NOT EXISTS tournament_scores_subject_idx
    ON tournament_scores (event_id, subject_ec_id);

-- ───────────── Распределение участник ↔ жюри (many-to-many) ─────────────
CREATE TABLE IF NOT EXISTS tournament_jury_assignments (
    id            BIGSERIAL PRIMARY KEY,
    event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    juror_ec_id   BIGINT  NOT NULL REFERENCES event_collaborators(id) ON DELETE CASCADE,
    subject_ec_id BIGINT  NOT NULL REFERENCES event_collaborators(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (juror_ec_id, subject_ec_id)
);
CREATE INDEX IF NOT EXISTS tournament_assignments_juror_idx
    ON tournament_jury_assignments (event_id, juror_ec_id);
CREATE INDEX IF NOT EXISTS tournament_assignments_subject_idx
    ON tournament_jury_assignments (event_id, subject_ec_id);

-- ───────────── Обратная связь жюри → участник ─────────────
CREATE TABLE IF NOT EXISTS tournament_feedback (
    id            BIGSERIAL PRIMARY KEY,
    event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    stage_id      BIGINT  REFERENCES conf_stages(id) ON DELETE SET NULL,  -- NULL = по всему турниру
    juror_ec_id   BIGINT  NOT NULL REFERENCES event_collaborators(id) ON DELETE CASCADE,
    subject_ec_id BIGINT  NOT NULL REFERENCES event_collaborators(id) ON DELETE CASCADE,
    body          TEXT    NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Один комментарий от жюри участнику на конкретном этапе.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_feedback_stage
    ON tournament_feedback (juror_ec_id, subject_ec_id, stage_id)
    WHERE stage_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_feedback_nostage
    ON tournament_feedback (juror_ec_id, subject_ec_id)
    WHERE stage_id IS NULL;
CREATE INDEX IF NOT EXISTS tournament_feedback_subject_idx
    ON tournament_feedback (event_id, subject_ec_id);

-- ───────────── Снимки отчётов ─────────────
-- Шапка отчёта: один на каждое нажатие «Сохранить отчёт».
CREATE TABLE IF NOT EXISTS tournament_snapshots (
    id          BIGSERIAL PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    stage_id    BIGINT  REFERENCES conf_stages(id) ON DELETE SET NULL,  -- по какому этапу зафиксировано (NULL = все)
    title       TEXT    NOT NULL DEFAULT '',                            -- произвольная подпись отчёта
    frozen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tournament_snapshots_event_idx
    ON tournament_snapshots (event_id, frozen_at DESC);

-- Строки отчёта: итог + балл пакета + место на участника, заморожено.
CREATE TABLE IF NOT EXISTS tournament_snapshot_rows (
    id            BIGSERIAL PRIMARY KEY,
    snapshot_id   BIGINT  NOT NULL REFERENCES tournament_snapshots(id) ON DELETE CASCADE,
    subject_ec_id BIGINT,                          -- ссылка не FK: коллаб мог быть удалён, имя сохраняем строкой
    subject_name  TEXT    NOT NULL DEFAULT '',
    package_id    BIGINT,                          -- какой пакет (NULL = строка-итог)
    package_title TEXT    NOT NULL DEFAULT '',
    package_score NUMERIC,                          -- балл пакета на дату
    total_score   NUMERIC NOT NULL DEFAULT 0,       -- итоговый балл участника
    place         INTEGER                           -- место в таблице
);
CREATE INDEX IF NOT EXISTS tournament_snapshot_rows_idx
    ON tournament_snapshot_rows (snapshot_id, place, subject_ec_id);

-- Сырые баллы на дату: каждый критерий × каждое жюри + комментарии. Полная глубина.
CREATE TABLE IF NOT EXISTS tournament_snapshot_scores (
    id              BIGSERIAL PRIMARY KEY,
    snapshot_id     BIGINT  NOT NULL REFERENCES tournament_snapshots(id) ON DELETE CASCADE,
    subject_ec_id   BIGINT,
    subject_name    TEXT    NOT NULL DEFAULT '',
    package_title   TEXT    NOT NULL DEFAULT '',
    criterion_title TEXT    NOT NULL DEFAULT '',
    juror_name      TEXT,                            -- кто поставил (NULL для не-жюри)
    value_number    NUMERIC,
    feedback_body   TEXT                             -- комментарий жюри (если был)
);
CREATE INDEX IF NOT EXISTS tournament_snapshot_scores_idx
    ON tournament_snapshot_scores (snapshot_id, subject_ec_id);

COMMENT ON TABLE tournament_packages           IS 'Пакеты оценок турнира (название + вес + этап + нормализация)';
COMMENT ON TABLE tournament_criteria           IS 'Критерии внутри пакета (балл, кто ставит, вес)';
COMMENT ON TABLE tournament_scores             IS 'Сырые баллы: участник × жюри × критерий';
COMMENT ON TABLE tournament_jury_assignments   IS 'Распределение: кого какое жюри оценивает (many-to-many)';
COMMENT ON TABLE tournament_feedback           IS 'Обратная связь жюри → участник (текст)';
COMMENT ON TABLE tournament_snapshots          IS 'Снимок отчёта результатов турнира на дату';
COMMENT ON TABLE tournament_snapshot_rows      IS 'Итоги/пакеты/места участников в снимке';
COMMENT ON TABLE tournament_snapshot_scores    IS 'Сырые баллы + комментарии в снимке (полная глубина)';

-- ───────────── GRANTы (роль БД = plusson) ─────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plusson') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON tournament_packages, tournament_criteria, tournament_scores, tournament_jury_assignments, tournament_feedback, tournament_snapshots, tournament_snapshot_rows, tournament_snapshot_scores TO plusson';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plusson';
  END IF;
END $$;
