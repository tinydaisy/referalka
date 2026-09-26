'use client'
/**
 * Подвкладки раздела «Платежи/Заявки» — ДВЕ ЦВЕТНЫЕ ГРУППЫ (решение владельца
 * 26.09.2026):
 *   голубая   — «Тарифы» → «Заказы»        (тариф и его заказы)
 *   персиковая — «Формы заявки» → «Заявки»  (форма и её заявки)
 * Раньше три вкладки стояли в ряд, и не читалось, что «Заказы» — это заказы
 * тарифов, а у формы заявки своего списка не было вовсе.
 *
 * ⚠️ Один компонент на все типы событий (мероприятия, конференции/турниры,
 * премии) — чтобы страницы не разъехались, как уже было с этим разделом.
 * Выбор вкладки — через `onSelect` страницы (у всех `useUrlTab`), здесь только
 * отрисовка.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

export type PaymentsTabKey = 'tariffs' | 'tariff_orders' | 'request_form' | 'request_responses'

const GROUPS: { tint: string; tabs: { key: PaymentsTabKey; label: string }[] }[] = [
  { tint: 'bg-[#25455D]/10', tabs: [
    { key: 'tariffs', label: 'Тарифы' },
    { key: 'tariff_orders', label: 'Заказы' },
  ] },
  { tint: 'bg-[#FFCFA4]/50', tabs: [
    { key: 'request_form', label: 'Формы заявки' },
    { key: 'request_responses', label: 'Заявки' },
  ] },
]

export default function PaymentsSubTabs({ active, onSelect, eventId }: {
  active: string
  onSelect: (key: PaymentsTabKey) => void
  eventId: number
}) {
  // Цифра необработанных заявок — видна, не заходя во вкладку «Заявки».
  const [unprocessed, setUnprocessed] = useState(0)
  useEffect(() => {
    api.requestForms.responses('events', eventId)
      .then((r: any) => setUnprocessed(r?.unprocessed || 0))
      .catch(() => setUnprocessed(0))
  }, [eventId, active])

  return (
    <div className="mb-8 flex flex-wrap gap-3">
      {GROUPS.map((g, i) => (
        <div key={i} className={`flex gap-1 rounded-xl p-1 ${g.tint}`}>
          {g.tabs.map(tb => {
            const isActive = active === tb.key
            return (
              <button key={tb.key} onClick={() => onSelect(tb.key)}
                      className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors ${
                        isActive ? 'bg-white font-semibold text-[#25455D] shadow-sm' : 'text-gray-600 hover:text-[#25455D]'}`}>
                {tb.label}
                {tb.key === 'request_responses' && unprocessed > 0 && (
                  <span className="ml-1.5 rounded-full bg-[#25455D] px-1.5 py-0.5 text-[11px] font-semibold text-white">
                    {unprocessed}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
