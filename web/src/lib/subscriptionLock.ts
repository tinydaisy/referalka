/**
 * Замок «нужна действующая подписка».
 *
 * ⚠️ Это НЕ то же самое, что замок по фиче (`FeatureLock`). Фича отвечает на
 * вопрос «куплено ли», подписка — «оплачен ли тариф сейчас». Клиент может
 * купить модуль «Конференции» отдельно и не продлить Профи: модуль тогда
 * работает, а платные возможности самой платформы закрываются.
 *
 * Список закрытого держим ЗДЕСЬ, одной строкой на все карточки событий —
 * у мероприятия, конференции и конкурса вкладки называются одинаково, и
 * три копии списка неминуемо разъехались бы.
 *
 * Зеркало серверного правила в `app/middleware/subscription_guard.py`
 * (MODULE_FROZEN_EVENT_TAILS). Меняете там — поменяйте и здесь, иначе вкладка
 * будет открыта, а сохранение вернёт 403.
 */

/** Вкладки карточки события, закрытые без действующей подписки. */
export const SUBSCRIPTION_LOCKED_TABS = [
  'landing',              // конструктор лендинга
  'broadcast_templates',  // шаблоны рассылок
  'broadcast_queue',      // очередь рассылок
  'webinar',              // вебинарная комната
  'referral',             // реферальная программа
  'raffle',               // розыгрыш
  'nurture',              // воронка догрева
  'welcome',              // приветственное письмо
  'tariffs',              // платные тарифы события (приём денег)
] as const

/**
 * True — тариф не оплачен (истёк или его нет вовсе).
 *
 * ⚠️ Пока `/auth/me` не ответил (`me === null`), возвращаем false: иначе на
 * долю секунды все вкладки мигали бы замками у клиента с оплаченным тарифом.
 */
export function subscriptionExpired(me: any): boolean {
  if (!me) return false
  return me.subscription?.is_active !== true
}

/**
 * Вкладки ОБЩЕГО события (коллабы), закрытые у клиента с оплаченной
 * Коллабораторной без тарифа. Список короче: коллаба должна работать
 * целиком, кроме того, за что платят подпиской (решение владельца
 * 2026-08-27). Зеркало `_EVENT_STILL_FROZEN` в subscription_guard.py.
 */
export const COLLAB_LOCKED_TABS = [
  'broadcast_templates',
  'broadcast_queue',
  'webinar',
  'referral',
  'nurture',
  'tariffs',
] as const

/**
 * Закрыта ли конкретная вкладка из-за неоплаченного тарифа.
 *
 * @param isCollabEvent событие общее (коллаба) и у клиента оплачен модуль
 *        `collab_hub` — тогда список закрытого короче.
 */
export function tabLockedBySubscription(me: any, tabId: string, isCollabEvent = false): boolean {
  if (!subscriptionExpired(me)) return false
  const collabPaid = isCollabEvent && Array.isArray(me?.features) && me.features.includes('collab_hub')
  const list: readonly string[] = collabPaid ? COLLAB_LOCKED_TABS : SUBSCRIPTION_LOCKED_TABS
  return list.includes(tabId)
}

/** Подпись для замка — одна на все места. */
export const SUBSCRIPTION_LOCK_HINT =
  'Нужен действующий тариф — продлите подписку, чтобы открыть раздел'
