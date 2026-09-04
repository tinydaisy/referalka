import { useEffect, useState } from 'react'
import { getEventLanding, vkMessagesAllowed } from '../api'

/**
 * Окно-объяснение ПЕРЕД запросом разрешения на сообщения (только ВКонтакте).
 *
 * ⚠️⚠️ ЗАЧЕМ ОНО — ТРЕБОВАНИЕ МОДЕРАЦИИ, А НЕ УКРАШЕНИЕ.
 * Пункт 1.1.2 правил Mini Apps (dev.vk.com/ru/mini-apps-rules): человека
 * обязаны предупредить ЗАРАНЕЕ, до системного окна «Разрешить?», как именно
 * будет использовано право. Без объяснения приложение отклоняли (18.06.2026).
 *
 * ⚠️⚠️ ЭТО ОКНО ПОВЕРХ ПРИЛОЖЕНИЯ, А НЕ ОТДЕЛЬНЫЙ ЭКРАН НА ВХОДЕ.
 * Раньше оно было полноэкранной страницей и обрывало запуск: человек упирался
 * в просьбу разрешить, ещё не увидев ни календаря, ни события. Модерация
 * назвала это «до просмотра функций» (01.09.2026), да и выглядело странно.
 * Теперь приложение открывается сразу, а окно всплывает ЧЕРЕЗ ПАУЗУ поверх
 * того, что человек уже видит.
 *
 * ⚠️ Показывается ОДИН РАЗ на человека, и «уже показывали» мы спрашиваем
 * У БАЗЫ (`/vk/messages-allowed`), а не у localStorage. Отметка в браузере
 * терялась при смене телефона и очистке кеша — человек, разрешивший сообщения
 * месяц назад, снова видел просьбу (жалоба владельца, 03.09.2026).
 * localStorage остался лишь как быстрый локальный кеш поверх ответа базы.
 *
 * ⚠️ У VK Bridge НЕТ метода «а разрешил ли он уже?» — узнать можно только
 * показав системное окно. Поэтому без обращения к своей базе тут не обойтись.
 */

const STORAGE_PREFIX = 'vk_perm_intro_'

/** Пауза перед показом: человек успевает увидеть, куда попал. */
const SHOW_DELAY_MS = 5000

/**
 * Зачем разрешать — своими словами под каждый тип события.
 *
 * ⚠️ Текст НАШ, и только он. Системное окно, которое ВКонтакте показывает
 * следом («Сообщество хочет отправлять вам сообщения»), рисует сама площадка —
 * подставить туда свою причину нельзя.
 *
 * ⚠️ Про имя и фото НЕ пишем: `VKWebAppGetUserInfo` отдаёт их без всякого
 * окна, предупреждать не о чем. Фото людей нам и не нужно.
 *
 * ⚠️ Про подписку на сообщество тоже НЕ пишем — её здесь больше не просят
 * (модерация, п.1.1.2). Она предлагается после регистрации.
 */
const REASON_BY_MODULE: Record<string, string> = {
  conference: 'пришлём напоминание, программу, информацию о спикерах и подарки',
  turnir:     'пришлём напоминание, программу и ссылки на эфиры',
  contest:    'сообщим о старте голосования и результатах',
  base:       'пришлём напоминание о начале и ссылку на эфир',
}

/**
 * ⚠️ Человек открыл приложение БЕЗ события (просто календарь) — обещать ему
 * «ссылку на эфир» нельзя: никакого эфира он не открывал. Раньше сюда
 * подставлялся текст мероприятия, и на календаре это выглядело нелепо.
 */
const REASON_NO_EVENT = 'уведомим о новых событиях и эфирах'

/** Показывали ли уже (локальный кеш поверх ответа базы). */
export function vkIntroWasShown(vkUserId: string | number): boolean {
  if (!vkUserId) return false
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${vkUserId}`) === '1'
  } catch {
    // Приватный режим / запрет хранилища — не повод ломать вход.
    return false
  }
}

function markShown(vkUserId: string | number) {
  try { localStorage.setItem(`${STORAGE_PREFIX}${vkUserId}`, '1') } catch { /* см. выше */ }
}

export default function VkPermissionsIntro({
  vkUserId,
  groupId,
  clientId,
  eventSlug,
  onContinue,
}: {
  vkUserId: string | number
  /** Сообщество, от имени которого просим. Нужен, чтобы спросить базу. */
  groupId?: number
  clientId: number | null
  /** Slug события из ссылки — по нему берём тип и подбираем причину. */
  eventSlug?: string | null
  /** Нажали «Хорошо» → показываем системное окно ВКонтакте. */
  onContinue: () => void
}) {
  const [visible, setVisible] = useState(false)
  const [reason, setReason] = useState<string>(REASON_NO_EVENT)

  // Тип события → своя причина. Без события остаётся текст про новые события.
  //
  // ⚠️ Ошибку глушим молча: не узнали тип — текст остаётся общим. Окно не
  // должно зависеть от того, ответил ли сервер.
  useEffect(() => {
    if (!eventSlug) { setReason(REASON_NO_EVENT); return }
    getEventLanding(eventSlug)
      .then((e: any) => {
        const m = e?.module_slug
        setReason(REASON_BY_MODULE[m] || REASON_BY_MODULE.base)
      })
      .catch(() => setReason(REASON_BY_MODULE.base))
  }, [eventSlug])

  // Спросить базу «уже разрешал?» и, если нет, показать окно через паузу.
  useEffect(() => {
    if (!vkUserId) return
    let cancelled = false
    let timer: any

    ;(async () => {
      // Локальный кеш — чтобы не ходить в сеть при каждом открытии.
      if (vkIntroWasShown(vkUserId)) return
      try {
        const r: any = await vkMessagesAllowed(vkUserId, groupId, clientId)
        if (cancelled) return
        if (r?.allowed) {
          // Разрешение уже есть — окно не нужно вовсе, помечаем и молчим.
          markShown(vkUserId)
          return
        }
      } catch {
        // Не смогли спросить → покажем окно. Лишний раз объяснить не страшно,
        // страшно молча не спросить разрешения и потерять человека.
      }
      if (cancelled) return
      timer = setTimeout(() => { if (!cancelled) setVisible(true) }, SHOW_DELAY_MS)
    })()

    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [vkUserId, groupId, clientId])

  if (!visible) return null

  function accept() {
    markShown(vkUserId)
    setVisible(false)
    onContinue()
  }

  return (
    // ⚠️ Затемнение БЕЗ onClick: окно закрывается только кнопкой. Клик мимо
    // выглядел бы как отказ, которого человек не имел в виду (правило проекта
    // про модалки-формы).
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(10, 21, 32, 0.55)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 430,
          background: '#fff', borderRadius: 20,
          padding: '22px 20px 18px',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.25)',
        }}
      >
        <p style={{
          color: 'var(--dark)', fontSize: 16, lineHeight: 1.5,
          fontWeight: 600, margin: '0 0 18px',
        }}>
          Разрешите отправлять вам сообщения — {reason}
        </p>

        {/* ⚠️ Классы .btn/.btn-gold, а не свой style={{background}} —
            правило проекта: цвет кнопок настраивается в одном месте. */}
        <button onClick={accept} className="btn btn-gold" style={{ width: '100%' }}>
          Хорошо
        </button>
      </div>
    </div>
  )
}
