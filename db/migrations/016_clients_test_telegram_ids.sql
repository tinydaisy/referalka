-- Тестовые Telegram ID для рассылок — переносим на уровень клиента (не конференции)
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS test_telegram_ids TEXT[] DEFAULT '{}';
