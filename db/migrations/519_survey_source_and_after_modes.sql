-- 519: источник заявки + варианты «что показать после отправки» (26.09.2026)
--
-- ⚠️⚠️ Зачем — ИСТОЧНИК. У ответа на анкету не было поля «с какого события»:
-- заявку с формы заявки события нельзя было отличить от ответа по прямой
-- ссылке, которую организатор отправил сам, а список «заявки этого события»
-- построить было не на чем (одна анкета стоит на нескольких событиях).
-- Лид-магнит уже записывался (`lead_magnet_id` / `package_id`).
--
-- ⚠️ ON DELETE SET NULL: удалили событие — заявка остаётся в анкете, просто
-- без подписи, откуда пришла.

ALTER TABLE survey_responses
  ADD COLUMN IF NOT EXISTS event_id   INTEGER REFERENCES events(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_survey_responses_event
    ON survey_responses(event_id, created_at DESC) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_survey_responses_product
    ON survey_responses(product_id, created_at DESC) WHERE product_id IS NOT NULL;

-- ── «Что показать после отправки»: четыре варианта ─────────────────────────
--   thanks  — только текст «спасибо»
--   gift    — текст + подарок (лид-магнит или пакет, поля gift_* уже есть)
--   support — текст + кнопки службы заботы (рабочие контакты кабинета) и
--             кодовое слово, которое человек напишет («Хочу стать спикером»)
--   url     — перевести на свою ссылку
-- ⚠️ Подарок теперь выдаётся ТОЛЬКО в режиме gift. Раньше он шёл при любом
-- режиме, если поле заполнено, — переводим такие анкеты в gift, чтобы
-- поведение не поменялось (на проде 26.09 таких нет).
ALTER TABLE surveys ADD COLUMN IF NOT EXISTS support_keyword TEXT;

ALTER TABLE surveys DROP CONSTRAINT IF EXISTS surveys_after_mode_check;
ALTER TABLE surveys ADD CONSTRAINT surveys_after_mode_check
  CHECK (after_mode = ANY (ARRAY['thanks', 'gift', 'support', 'url']));

UPDATE surveys SET after_mode = 'gift'
 WHERE after_mode = 'thanks'
   AND (gift_lead_magnet_id IS NOT NULL OR gift_package_id IS NOT NULL);

-- ── Текст «спасибо» — ОДНО место: анкета ──────────────────────────────────
-- ⚠️ Был ещё `request_forms.success_text`, и он доходил только до Mini App;
-- лендинг и /f/{slug} показывали текст анкеты — два места задавали одно и то
-- же и разъезжались. Переносим непустой текст формы в анкету, где своего нет,
-- и убираем колонку (решение владельца 26.09.2026).
UPDATE surveys s
   SET thanks_text = rf.success_text
  FROM request_forms rf
 WHERE rf.survey_id = s.id
   AND NULLIF(btrim(COALESCE(s.thanks_text, '')), '') IS NULL
   AND NULLIF(btrim(COALESCE(rf.success_text, '')), '') IS NOT NULL;

ALTER TABLE request_forms DROP COLUMN IF EXISTS success_text;
