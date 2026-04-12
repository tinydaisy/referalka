-- ═══════════════════════════════════════════
-- PLUSSON — Индексы БД
-- ═══════════════════════════════════════════

-- Участники
CREATE INDEX IF NOT EXISTS idx_event_participants_event   ON event_participants(event_id);
CREATE INDEX IF NOT EXISTS idx_event_participants_tg      ON event_participants(tg_user_id);
CREATE INDEX IF NOT EXISTS idx_event_participants_refcode ON event_participants(ref_code);

-- Реферальные события
CREATE INDEX IF NOT EXISTS idx_referral_events_ref_code ON referral_events(ref_code);
CREATE INDEX IF NOT EXISTS idx_referral_events_event    ON referral_events(event_id);
CREATE INDEX IF NOT EXISTS idx_referral_events_type     ON referral_events(type);
CREATE INDEX IF NOT EXISTS idx_referral_events_created  ON referral_events(created_at DESC);

-- События
CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id);
CREATE INDEX IF NOT EXISTS idx_events_slug   ON events(slug);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- Конференция
CREATE INDEX IF NOT EXISTS idx_conf_sessions_event      ON conf_sessions(event_id);
CREATE INDEX IF NOT EXISTS idx_conf_sessions_day        ON conf_sessions(event_id, day);
CREATE INDEX IF NOT EXISTS idx_conf_speakers_event      ON conf_speakers(event_id);
CREATE INDEX IF NOT EXISTS idx_conf_broadcasts_event    ON conf_broadcast_messages(event_id);
CREATE INDEX IF NOT EXISTS idx_conf_broadcasts_status   ON conf_broadcast_messages(status);

-- Уведомления
CREATE INDEX IF NOT EXISTS idx_notifications_log_event  ON notifications_log(event_id);
CREATE INDEX IF NOT EXISTS idx_notifications_log_user   ON notifications_log(tg_user_id);

-- Подарки
CREATE INDEX IF NOT EXISTS idx_gift_issuances_participant ON gift_issuances(participant_id);
CREATE INDEX IF NOT EXISTS idx_gift_issuances_status      ON gift_issuances(status);

-- Клиенты
CREATE INDEX IF NOT EXISTS idx_clients_email        ON clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_tariff       ON clients(tariff_slug);
CREATE INDEX IF NOT EXISTS idx_clients_partner_code ON clients(partner_code);
