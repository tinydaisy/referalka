-- 238: Фича «Рассылки по email» (email_broadcasts).
--
-- Зачем. Площадка Email была скрыта из выбора каналов рассылки ЖЁСТКО, константой
-- на фронте (HIDDEN_PLATFORMS в BroadcastChannelPicker.tsx) — то есть у всех без
-- исключения. Движок при этом email рассылать умеет всегда
-- (_send_broadcast_email_part в tasks/broadcast.py).
--
-- Теперь показ площадки Email гейтится ПО ФИЧЕ (не по tariff_slug — см. правило
-- «гейтить только по фичам»). Выдаётся тарифу «Администратор» (admin).
--
-- ⚠️ Триал ВСЕГДА зеркалит pro: если фичу позже привяжут к pro — не забыть
-- продублировать в trial (_mirror_pro_features_to_trial в admin.py делает это сам
-- при правке тарифа через админку).

INSERT INTO features (slug, name, description, sort)
VALUES (
    'email_broadcasts',
    'Рассылки по email',
    'Площадка Email доступна в выборе каналов рассылки (общей и событийной).',
    90
)
ON CONFLICT (slug) DO NOTHING;

-- Привязка к тарифу «Администратор».
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t, features f
 WHERE t.slug = 'admin' AND f.slug = 'email_broadcasts'
ON CONFLICT DO NOTHING;
