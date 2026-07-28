-- 251: Размеры медиа в блоках лендинга + выбор выделенного тарифа (240-250).
--
-- Зачем:
--   card_img_size     — ширина фото в карточках «Для кого» в % от карточки.
--                       Фото занимало всю ширину и выглядело громоздким,
--                       а уменьшить его было нечем.
--   media_size        — ширина карточки галереи в px (фото и видео).
--                       Видео-отзывы шли мелкими, размер не настраивался.
--   show_captions     — показывать подписи под элементами галереи.
--                       На телефоне подписи не помещались и мешали.
--   featured_tariff_id— какой тариф подсветить на лендинге. Раньше признак
--                       жил в самом тарифе (event_tariffs.is_featured) и
--                       менялся только в разделе «Тарифы» — из конструктора
--                       лендинга выбрать было нельзя.
--   offer_id          — оферта в подвале, выбирается из базы оферт клиента.
--                       Раньше подвал брал events.offer_url, и если он пуст,
--                       ссылки на оферту не было вовсе.

ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS card_img_size       INT,
  ADD COLUMN IF NOT EXISTS media_size          INT,
  ADD COLUMN IF NOT EXISTS show_captions       BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS featured_tariff_id  INT,
  ADD COLUMN IF NOT EXISTS offer_id            INT
    REFERENCES client_offers(id) ON DELETE SET NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
