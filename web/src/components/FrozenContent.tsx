'use client'

/**
 * Замораживает кабинет, когда подписка истекла.
 *
 * ⚠️⚠️ Решение владельца: разделы НЕ прячем и НЕ подменяем заглушкой — всё
 * остаётся на экране, но замылено и некликабельно. Причина: пропавший раздел
 * человек читает как «у меня всё удалили». Ровно так и вышло на кабинете
 * Виктории Ивановой: её боты (10 466 подписчиков) исчезли из «Каналов», и она
 * решила, что данные потеряны, хотя они лежали в базе целыми.
 *
 * ⚠️ Стоит В МАКЕТЕ, а не на каждой странице: разделов два десятка, и обходить
 * их по одному значит забыть половину — на этом уже спотыкались дважды.
 *
 * ⚠️ Замыливание — ПОКАЗ, а не защита: содержимое приходит в браузер и
 * достаётся из вёрстки. Настоящий запрет живёт на сервере
 * (subscription_guard + гейты фич).
 *
 * ⚠️ Страницы оплаты и партнёрки НЕ замораживаем: именно через них человек
 * возвращает доступ. Заблокировать их значило бы запереть его снаружи — ту же
 * ошибку уже ловили в subscription_guard, когда для продления подписки
 * требовалась действующая подписка.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Lock } from 'lucide-react'
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
    <div className="frozen-wrap">
      {/* Плашка — ВНЕ размытого блока, поэтому читается. Одна на весь кабинет:
          объяснение и путь к оплате в каждом разделе одинаковые. */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
        <Lock className="h-5 w-5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-gray-900">
            Этот раздел доступен в платной подписке
          </div>
          <div className="mt-0.5 text-xs text-gray-700">
            Данные на месте — ничего не удалено. Продлите подписку, и всё сразу заработает.
          </div>
        </div>
        <Link
          href="/dashboard/subscription#tariffs"
          className="btn-gold shrink-0 rounded-xl px-4 py-2 text-sm font-bold"
        >
          Продлить
        </Link>
      </div>

      {/* ⚠️ `filter: none` у потомка НЕ отменяет фильтр родителя: CSS применяет
          фильтр ко всему поддереву как к единому слою. Поэтому размываем не
          контейнер, а каждый элемент содержимого ОТДЕЛЬНО — тогда заголовок
          раздела можно исключить селектором и оставить читаемым.

          ⚠️ Селектором, а не правкой каждой страницы: шапки у всех разделов
          свои, обходить их по одному значит забыть половину. */}
      <style jsx global>{`
        .frozen-wrap > div > * {
          filter: blur(3px);
          opacity: 0.7;
          pointer-events: none;
          user-select: none;
        }
        /* Заголовок раздела и его описание — чёткие: человек должен понимать,
           где находится. Размытая шапка выглядит как сломанная страница.
           :has() есть во всех актуальных браузерах (Chrome 105+, Safari 15.4+);
           где не поддержан — шапка останется размытой, вёрстка не ломается. */
        .frozen-wrap > div > h1,
        .frozen-wrap > div > h1 + p,
        .frozen-wrap > div > *:has(> h1) {
          filter: none;
          opacity: 1;
          user-select: auto;
        }
        /* ⚠️ Но кнопки в шапке («Создать», «Добавить») остаются размытыми и
           неактивными: действие всё равно запрещено на сервере, и живая кнопка
           в закрытом разделе обманывает. */
        .frozen-wrap > div > *:has(> h1) a,
        .frozen-wrap > div > *:has(> h1) button {
          filter: blur(3px);
          opacity: 0.7;
          pointer-events: none;
        }
      `}</style>
      <div aria-hidden>{children}</div>
    </div>
  )
}
