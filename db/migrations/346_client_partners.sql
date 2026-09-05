-- 346: Партнёрская программа клиента — партнёр как сущность + закрепление
--
-- Зачем. Клиент хочет, чтобы его аудитория рекомендовала его события и продукты
-- за деньги. Платформа считает вознаграждение и даёт кабинет; ДЕНЬГИ КЛИЕНТ
-- ПЛАТИТ САМ (решение № 1) — мы их не держим и не переводим.
--
-- ⚠️⚠️ НЕ ПУТАТЬ С РЕФЕРАЛКОЙ СОБЫТИЯ. Это два независимых учёта, и вся
-- путаница в проектировании шла от одного слова «реферер» на две задачи:
--
--   event_participants.referrer_ref_code — «кто привёл НА ЭТО СОБЫТИЕ».
--     Может быть ЛЮБОЙ участник, живёт внутри события, заново на каждом,
--     даёт ПОДАРКИ и рейтинг. Партнёрка это поле не читает и не меняет.
--
--   contacts.partner_id (здесь) — «за каким ПАРТНЁРОМ закреплён человек».
--     Только зарегистрированный партнёр (оферта + налоговый статус),
--     живёт на человеке НАВСЕГДА, даёт ДЕНЬГИ.
--
-- ⚠️ Таблицы `partners`, `referral_events`, `referral_levels` из первой схемы
-- ПУСТЫЕ (0 строк) и не переиспользуются: имена путают, связей нет.

-- ── Партнёр клиента ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_partners (
    id           SERIAL PRIMARY KEY,
    client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    accepted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_ip  TEXT,
    tax_status   TEXT NOT NULL,
    payout_mode  TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT client_partners_unique UNIQUE (client_id, contact_id),
    CONSTRAINT client_partners_payout_mode_chk
        CHECK (payout_mode IS NULL OR payout_mode IN ('active', 'passive')),
    CONSTRAINT client_partners_tax_status_chk
        CHECK (tax_status IN ('self_employed', 'ip', 'individual', 'company'))
);

CREATE INDEX IF NOT EXISTS idx_client_partners_client ON client_partners(client_id);
CREATE INDEX IF NOT EXISTS idx_client_partners_contact ON client_partners(contact_id);

COMMENT ON TABLE client_partners IS
  'Партнёр КЛИЕНТА (не платформы). Вход осознанный: акцепт оферты + налоговый статус. Деньги платит клиент сам, платформа только считает.';
COMMENT ON COLUMN client_partners.accepted_at IS
  'Факт и дата акцепта оферты. ⚠️ Версии оферты НЕТ (решение № 45) — поля версии сознательно не заводим.';
COMMENT ON COLUMN client_partners.tax_status IS
  'Налоговый статус: деньги платим только тем, кто может их легально принять (решение № 14).';
COMMENT ON COLUMN client_partners.payout_mode IS
  'ЛИЧНЫЙ режим выплат этого партнёра: active | passive | NULL = общий режим кабинета (решение № 43). Клиент вправе договариваться с разными людьми по-разному; смена общего режима партнёров с личной настройкой не трогает.';
COMMENT ON COLUMN client_partners.is_active IS
  'Отключение партнёра без удаления: начисления и история выплат обязаны остаться.';

-- ⚠️ Поля «кто позвал в партнёрку» здесь НЕТ (решение № 44). Дерево уровней
-- целиком держится на contacts.partner_id: партнёр — тоже контакт, поэтому
-- рекурсия вверх идёт по тому же полю. Отдельная таблица связей между
-- партнёрами обсуждалась (invited_by_partner_id) и отвергнута как лишняя.

-- ── Закрепление человека за партнёром ────────────────────────────────────────
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS partner_id INTEGER
    REFERENCES client_partners(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS partner_bound_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_partner ON contacts(partner_id)
    WHERE partner_id IS NOT NULL;

COMMENT ON COLUMN contacts.partner_id IS
  'За каким партнёром закреплён человек. Возникает ОДИН раз — при переходе по ссылке зарегистрированного партнёра на свободное место — и НЕ МЕНЯЕТСЯ НИКОГДА (решения № 13, № 16): ни клиентом, ни админом. Держит всё дерево уровней (№ 44).';
COMMENT ON COLUMN contacts.partner_bound_at IS
  'Дата закрепления — для разбора споров «почему не мне начислили».';

-- ⚠️ ON DELETE SET NULL, а не CASCADE: удаление партнёра не должно уносить
-- контакты его приведённых — это люди клиента, а не имущество партнёра.

-- ⚠️ РЕТРОАКТИВНОГО ЗАКРЕПЛЕНИЯ НЕТ (решение № 28). Бэкфилла в этой миграции
-- нет и быть не должно: прошлые заслуги (кого партнёр привёл ДО того, как им
-- стал) не засчитываются. «Не засчитывать старых» — это не проверка, которую
-- можно забыть, а ОТСУТСТВИЕ кода, который ходит по истории.

-- ── Фича ─────────────────────────────────────────────────────────────────────
-- ⚠️ На время разработки — ТОЛЬКО admin (решение № 9). Экстра подключается
-- потом одной строкой в tariff_features, без правок кода.
INSERT INTO features (slug, name, description)
VALUES ('partner_program', 'Партнёрская программа',
        'Свои партнёры клиента: реф-ссылки, закрепление, вознаграждение, кабинет партнёра')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id FROM tariffs t, features f
 WHERE t.slug = 'admin' AND f.slug = 'partner_program'
ON CONFLICT DO NOTHING;

-- ⚠️ GRANT обязателен: роль plusson не владелец таблиц, без него API получит
-- permission denied. Sequence — отдельной строкой, о ней забывают чаще всего.
GRANT SELECT, INSERT, UPDATE, DELETE ON client_partners TO plusson;
GRANT USAGE, SELECT ON SEQUENCE client_partners_id_seq TO plusson;
