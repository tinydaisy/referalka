'use client'

/**
 * Замораживает содержимое кабинета, когда подписка истекла.
 *
 * ⚠️⚠️ Решение владельца: разделы НЕ прячем и НЕ подменяем заглушкой — всё
 * остаётся на экране, но замылено и некликабельно. Причина: пропавший раздел
 * человек читает как «у меня всё удалили». Ровно так и вышло на кабинете
 * Виктории Ивановой: её боты (10 466 подписчиков) исчезли из «Каналов», и она
 * решила, что данные потеряны, хотя они лежали в базе целыми.
 *
 * ⚠️ Стоит В МАКЕТЕ, а не на каждой странице: разделов два десятка, и обходить
 * их по одному значит забыть половину — на этом уже спотыкались. Здесь это
 * одна точка, которая накрывает весь кабинет разом.
 *
 * ⚠️ Замыливание — ПОКАЗ, а не защита: содержимое приходит в браузер и
 * достаётся из вёрстки. Настоящий запрет живёт на сервере
 * (subscription_guard + гейты фич).
 *
 * ⚠️ Страницы оплаты и партнёрки НЕ замораживаем: именно через них человек
 * возвращает доступ. Заблокировать их значило бы запереть его снаружи —
 * ту же ошибку уже ловили в subscription_guard, когда для продления подписки
 * требовалась действующая подписка.
 */
import { usePathname } from 'next/navigation'
import { useMe } from '@/hooks/useMe'

/** Куда пускаем даже с истёкшей подпиской — это путь обратно к оплате. */
const ALWAYS_OPEN = [
  '/dashboard/subscription',
  '/dashboard/partner-program',
  '/dashboard/my-partners',
  '/dashboard/settings',
  '/dashboard/help',
]

export default function FrozenContent({ children }: { children: React.ReactNode }) {
  const { subFrozen } = useMe()
  const pathname = usePathname() || ''

  const open = ALWAYS_OPEN.some(p => pathname.startsWith(p))
  if (!subFrozen || open) return <>{children}</>

  return (
    <div
      aria-hidden
      className="select-none"
      style={{ filter: 'blur(3px)', pointerEvents: 'none', opacity: 0.75 }}
    >
      {children}
    </div>
  )
}
