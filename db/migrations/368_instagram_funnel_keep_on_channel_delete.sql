-- 368: удаление аккаунта Instagram НЕ уносит настроенные воронки
--
-- ⚠️⚠️ В миграции 362 у `instagram_funnels.channel_id` стоял ON DELETE CASCADE —
-- и это неверно. Аккаунт переподключают регулярно: истёк токен, отозвали доступ
-- в Facebook, добавили разрешение и нужно выдать его заново. Каждый раз вместе
-- с каналом исчезали ВСЕ воронки клиента — кодовые слова, выбранные рилсы,
-- шесть наборов текстов. Поймано на владельце 2026-09-07: удалила канал ради
-- переподключения и потеряла настроенную воронку.
--
-- Настройка воронки — работа клиента, а канал — техническая привязка к аккаунту.
-- Уносить первое вслед за вторым нельзя.
--
-- Теперь ON DELETE SET NULL: воронка остаётся, `channel_id` обнуляется. Чтобы
-- она не пыталась работать без аккаунта, при обнулении её выключает триггер.

BEGIN;

-- 1. channel_id становится необязательным
ALTER TABLE instagram_funnels ALTER COLUMN channel_id DROP NOT NULL;

ALTER TABLE instagram_funnels DROP CONSTRAINT IF EXISTS instagram_funnels_channel_id_fkey;
ALTER TABLE instagram_funnels
  ADD CONSTRAINT instagram_funnels_channel_id_fkey
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL;

-- 2. Воронка без аккаунта не должна числиться активной.
--
-- ⚠️ Триггером, а не проверкой в коде: канал удаляют из другого места
-- (раздел «Каналы»), и код воронок об этом не знает. Без триггера в списке
-- висела бы «включённая» воронка, которая физически не может сработать.
CREATE OR REPLACE FUNCTION _ig_funnel_deactivate_on_channel_loss()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.channel_id IS NULL AND OLD.channel_id IS NOT NULL THEN
    NEW.is_active := FALSE;
    -- ⚠️ Сбрасываем привязку к КОНКРЕТНЫМ публикациям. Их id принадлежат
    -- аккаунту: после переподключения (а тем более другого аккаунта) они
    -- указывают в пустоту, и воронка молча не срабатывала бы — при том, что
    -- в интерфейсе рилсы выглядели бы выбранными. Возвращаем «любая
    -- публикация»: кодовое слово, тексты и выбранный подарок остаются целы.
    NEW.media_scope := 'any';
    NEW.media_ids := '{}';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ig_funnel_channel_loss ON instagram_funnels;
CREATE TRIGGER trg_ig_funnel_channel_loss
  BEFORE UPDATE OF channel_id ON instagram_funnels
  FOR EACH ROW EXECUTE FUNCTION _ig_funnel_deactivate_on_channel_loss();

COMMIT;
