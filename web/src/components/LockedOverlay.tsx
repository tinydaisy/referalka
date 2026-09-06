'use client'

/**
 * Раздел закрыт (истёк тариф или нет фичи) — содержимое ВИДНО, но замылено.
 *
 * ⚠️⚠️ Решение владельца: НЕ прятать и НЕ вырезать. Пропавший раздел человек
 * читает как «такого в продукте нет» или «у меня всё удалили» — так уже вышло
 * с «Лендингом» и с ботами Виктории: она решила, что подключённые боты
 * исчезли, хотя они лежали в базе целыми.
 *
 * Поэтому: данные остаются на экране (видно, что всё живо и что-то есть), но
 * нечитаемы и некликабельны, а поверх — объяснение и путь к оплате.
 *
 * ⚠️ Замыливание — это НЕ защита данных. Содержимое приходит в браузер и
 * достаётся из вёрстки. Настоящий запрет живёт на сервере
 * (subscription_guard + гейты фич); здесь только показ.
 */
import Link from 'next/link'
import { Lock } from 'lucide-react'

export default function LockedOverlay({
  children,
  title = 'Подписка истекла — раздел закрыт',
  hint = 'Данные на месте: продлите подписку, и всё сразу заработает.',
  href = '/dashboard/subscription#tariffs',
  cta = 'Продлить подписку',
}: {
  children: React.ReactNode
  title?: string
  hint?: string
  href?: string
  cta?: string
}) {
  return (
    <div className="relative">
      {/* Плашка НАД содержимым и не замылена — иначе объяснение нечитаемо
          вместе со всем остальным. */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
        <Lock className="h-5 w-5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-gray-900">{title}</div>
          <div className="mt-0.5 text-xs text-gray-700">{hint}</div>
        </div>
        <Link
          href={href}
          className="btn-gold shrink-0 rounded-xl px-4 py-2 text-sm font-bold"
        >
          {cta}
        </Link>
      </div>

      {/* ⚠️ `pointer-events-none` обязателен вместе с blur: без него по
          замыленным кнопкам всё ещё можно кликать, и человек нажимает
          вслепую. `select-none` — чтобы текст не выделяли и не копировали
          из-под размытия. */}
      <div
        aria-hidden
        className="select-none"
        style={{ filter: 'blur(3px)', pointerEvents: 'none', opacity: 0.75 }}
      >
        {children}
      </div>
    </div>
  )
}
