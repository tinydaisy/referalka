/**
 * Единая точка входа в тех.поддержку ПЛЮСОНа.
 *
 * ⚠️ АДРЕС ЗАДАЁТСЯ ЗДЕСЬ И ТОЛЬКО ЗДЕСЬ. Все страницы кабинета и сайдбар
 * ссылаются на SUPPORT_URL — не прописывать путь руками, иначе при смене
 * механики поддержки придётся править десяток файлов.
 *
 * Сейчас: страница с выбором мессенджера.
 * Появится система тикетов → меняем ОДНУ строку ниже на '/dashboard/help/tickets',
 * и весь кабинет автоматически ведёт туда.
 */
export const SUPPORT_URL = '/dashboard/help/contact'

/** Подпись ссылки — тоже в одном месте, чтобы тексты не разъезжались. */
export const SUPPORT_LABEL = 'написать в тех.поддержку'

/** Пункт сайдбара (с заглавной). */
export const SUPPORT_NAV_LABEL = 'Написать в тех.поддержку'


export interface SupportChannel {
  /** telegram | max | vk — им же красится логотип (PLATFORM_COLORS). */
  key: string
  label: string
  hint: string
  url: string
}

/**
 * ⚠️⚠️ СПИСОК МЕССЕНДЖЕРОВ ЖИВЁТ В АДМИНКЕ, А НЕ ЗДЕСЬ (20.09.2026).
 *
 * Раньше он был захардкожен в этом файле, и выключить площадку значило
 * править код и пересобирать сайт. Хуже того, это был ТРЕТИЙ независимый
 * список площадок ПЛЮСОНа: в ссылках Плюсоновского подарка ВК показывался,
 * в «Партнёрке ПЛЮСОНа» его не было вовсе, а здесь не было и подавно —
 * и никто не знал, что это три разных ответа на один вопрос.
 *
 * Теперь площадки отмечаются в админке и приходят с бэкенда
 * (`GET /api/v1/support-channels`, одна общая функция на все три места).
 */
export async function fetchSupportChannels(): Promise<SupportChannel[]> {
  const base = process.env.NEXT_PUBLIC_API_URL || ''
  try {
    const r = await fetch(`${base}/api/v1/support-channels`, { cache: 'no-store' })
    if (!r.ok) return SUPPORT_CHANNELS_FALLBACK
    const j = await r.json()
    const items: SupportChannel[] = j?.items || []
    // Пустой ответ — валиден (все площадки выключены), но показывать пустой
    // экран нельзя: человек пришёл с вопросом. Отдаём запасной список.
    return items.length ? items : SUPPORT_CHANNELS_FALLBACK
  } catch {
    return SUPPORT_CHANNELS_FALLBACK
  }
}

/**
 * Запасной список — на случай, когда API недоступен.
 *
 * ⚠️ Телеграм и MAX, потому что боты платформы на них не меняются. Это НЕ
 * настройка: что показывать на самом деле, решает админка. Правка здесь ничего
 * не включит и не выключит — только подстрахует страницу при сбое API.
 */
export const SUPPORT_CHANNELS_FALLBACK: SupportChannel[] = [
  {
    key: 'telegram',
    label: 'Telegram',
    hint: '@pluson_bot',
    url: 'https://t.me/pluson_bot?start=question',
  },
  {
    key: 'max',
    label: 'MAX',
    hint: 'ПЛЮСОН-СЕРВИС',
    url: 'https://max.ru/id890306512862_1_bot?start=question',
  },
]
