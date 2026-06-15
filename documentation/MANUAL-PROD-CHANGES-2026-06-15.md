# Ручные правки на проде вне git — 2026-06-15

Все изменения — прямые SQL в БД `plusson` на `194.156.119.17`. Код на сервере НЕ редактировался
(мой код доставлен через git-коммит `804e718`, на прод-файлах он уже присутствовал; рестарт сервисов
передан в другое окно, т.к. событие 24 «Ж.И.В.У.» активно). Чужие 37 незакоммиченных правок,
3 коллаб-миграции (137/145/146) и `.lock` НЕ тронуты.

## 1. Бэкфилл подписчиков MAX клиента 1 (Марго Форбс)

**Зачем.** Баг: при входе в MAX подписка в `platform_user_channels` не создавалась → дашборд
показывал 0 подписчиков, рассылки по MAX не шли. (Код-фикс `register_platform_channel_subscription`
в `max_webhook.py` + `max_event.py` — в коммите 804e718, заработает после рестарта.)

**SQL.** Подписка на активный MAX-канал клиента (`client_channel_id=104`, «Марго Форбс (MAX)»)
для всех реальных MAX-идентичностей клиента 1 без подписки:
```sql
INSERT INTO platform_user_channels (platform_user_id, client_channel_id, is_unsubscribed, subscribed_at)
SELECT pu.id, 104, FALSE, NOW()
  FROM platform_users pu
 WHERE pu.client_id=1 AND pu.platform_slug='max'
   AND pu.platform_user_id ~ '^[0-9]+$'   -- только числовые id, не псевдо-@-записи коллабов
   AND NOT EXISTS (SELECT 1 FROM platform_user_channels puc
                    WHERE puc.platform_user_id=pu.id AND puc.client_channel_id=104)
ON CONFLICT (platform_user_id, client_channel_id) DO NOTHING;
```
**Результат:** `INSERT 0 17` — восстановлено 17 подписчиков. 3 псевдо-записи (`@https://max.ru/u/…`)
пропущены намеренно. Канал 104: 17 подписчиков / 0 отписок.

## 2. Мерж контактов: Нурия Карычева (MAX 194999036 → TG @Nurikary)

primary=4313 (TG, ранний 2026-02-03), secondary=12763 (MAX, 2026-06-15). Транзакция из 8 шагов =
эквивалент `merge_contacts` (перенос идентичностей; реферер per-событие; перенос/удаление участий
с разруливанием FK referrer_participant_id; collaborators; first_referrer; merged_ref_codes; soft-delete).

**Результат:** контакт 4313 = email+max+telegram; регистрация на событии 24 цела (реферер `F4YU8RU5`);
пустое MAX-участие удалено; MAX-подписка на канал 104; 12763 → merged_into=4313, is_active=FALSE,
ref_code `EZSAGRZD` в merged_ref_codes.

## 3. Мерж контактов: Светлана Кашаева (MAX 260944913 → TG @numerosvetoch)

primary=12624 (TG, ранний 2026-06-13), secondary=12769 (MAX, 2026-06-15). Краевые случаи:
само-реферал MAX-участия (referrer_participant_id → TG-участие) + secondary участвовал в доп. событии 4.

**Результат:** контакт 12624 = email+max+telegram; регистрация на событии 24 цела (реферер `VCMVB52N`);
участие в событии 4 перенесено на primary; MAX-участие в событии 24 (с само-рефералом) удалено;
MAX-подписка на канал 104; 12769 → merged, ref_code `LSYUMTUS` в merged_ref_codes.

## Правило мержа (как в коде)
Главный = самый ранний контакт (min created_at/id). Реферер на событие = непустой, иначе от раннего.
В рамках одного клиента. Без кода-подтверждения.
