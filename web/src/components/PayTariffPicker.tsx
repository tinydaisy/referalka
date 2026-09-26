'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

/**
 * Разбивка сегментов оплаты рассылки ПО ТАРИФАМ.
 *
 * Тарифы пишутся в само значение audience_include / audience_exclude:
 *   'paid_event'        — оплатили, любой тариф (как было раньше);
 *   'paid_event:19,26'  — оплатили VIP или «С записями».
 * Так выбор тарифа сам переезжает из шаблона в очередь — отдельной
 * колонки, которую надо копировать в двадцати местах, нет.
 * Логика отбора — backend/app/tasks/broadcast.py (_parse_pay_segment/_pay_cond).
 *
 * ⚠️ «Не оплатили · любой тариф» = есть брошенный заказ И НИЧЕГО не
 * оплачено: тому, кто уже купил другой тариф, напоминание не уходит.
 */

export type EventTariff = { id: number; title: string; buyers_count: number; unpaid_count: number }

const PAY_BASES = ['paid_event', 'unpaid_event']

/** 'paid_event:19,26' → 'paid_event'. Кладётся в value у <select>. */
export function audBase(v: string | null | undefined): string {
  return (v || '').split(':')[0]
}

export function audTariffIds(v: string | null | undefined): number[] {
  const rest = (v || '').split(':')[1] || ''
  return rest.split(',').map(x => parseInt(x, 10)).filter(n => !isNaN(n))
}

function withTariffs(base: string, ids: number[]): string {
  return ids.length ? `${base}:${ids.join(',')}` : base
}

// Один запрос на событие на всю страницу: пилюль в очереди десятки.
const cache: Record<number, EventTariff[]> = {}
const inflight: Record<number, Promise<EventTariff[]>> = {}

export function useEventTariffs(eventId: number | null | undefined, enabled = true): EventTariff[] {
  const [items, setItems] = useState<EventTariff[]>(eventId ? cache[eventId] || [] : [])
  useEffect(() => {
    if (!eventId || !enabled) return
    if (cache[eventId]) { setItems(cache[eventId]); return }
    inflight[eventId] ||= api.eventTariffs.list(eventId)
      .then((r: any) => (cache[eventId] = r.items || []))
      .catch(() => [])
    let alive = true
    inflight[eventId].then(list => { if (alive) setItems(list) })
    return () => { alive = false }
  }, [eventId, enabled])
  return items
}

/** Подпись тарифа для пилюли/«Итого»: ' · VIP, КОМБО' или ' · любой тариф'. */
export function payTariffSuffix(v: string | null | undefined, tariffs: EventTariff[]): string {
  if (!PAY_BASES.includes(audBase(v))) return ''
  const ids = audTariffIds(v)
  if (!ids.length) return ' · любой тариф'
  const names = ids.map(id => tariffs.find(t => t.id === id)?.title || `тариф #${id}`)
  return ` · ${names.join(', ')}`
}

export default function PayTariffPicker(props: {
  value: string
  onChange: (v: string) => void
  eventId: number
}) {
  const base = audBase(props.value)
  const tariffs = useEventTariffs(props.eventId, PAY_BASES.includes(base))
  if (!PAY_BASES.includes(base)) return null

  const ids = audTariffIds(props.value)
  const isPaid = base === 'paid_event'

  function toggle(id: number) {
    const next = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]
    props.onChange(withTariffs(base, next))
  }

  return (
    <div className="mt-1.5 ml-1 pl-2 border-l-2 border-[#FFCFA4] space-y-1">
      <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
        <input type="checkbox" checked={ids.length === 0}
          onChange={() => props.onChange(base)} />
        <span className="font-medium">Любой тариф</span>
      </label>
      {tariffs.map(t => (
        <label key={t.id} className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
          <input type="checkbox" checked={ids.includes(t.id)} onChange={() => toggle(t.id)} />
          <span>{t.title}</span>
          <span className="text-gray-400">({isPaid ? t.buyers_count : t.unpaid_count})</span>
        </label>
      ))}
      {!isPaid && ids.length === 0 && (
        <p className="text-[11px] text-gray-400 leading-snug">
          Кто уже оплатил другой тариф, сюда не попадёт.
        </p>
      )}
    </div>
  )
}
