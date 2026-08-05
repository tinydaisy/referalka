'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

/**
 * Фильтр аудитории рассылки ПО ТЕГАМ контактов (миграция 265).
 *
 * Два независимых списка:
 *   include — взять ТОЛЬКО тех, у кого есть ХОТЯ БЫ ОДИН из выбранных тегов;
 *   exclude — выбросить тех, у кого есть ХОТЯ БЫ ОДИН из выбранных.
 * Ничего не выбрано = фильтр не применяется (рассылка идёт по всей базе).
 *
 * Исключение сильнее включения: тег в обоих списках → человек НЕ получит.
 */

// Человекочитаемые подписи служебных сегментов платформы.
const SEGMENT_LABELS: Record<string, string> = {
  'plusson:no_sub': 'ПЛЮСОН · без подписки',
  'plusson:sub_no_bot': 'ПЛЮСОН · есть подписка, нет бота',
  'plusson:sub_and_bot': 'ПЛЮСОН · есть подписка и бот',
  'plusson:in_collab': 'ПЛЮСОН · в Коллабораторной',
}

function label(tag: string) {
  return SEGMENT_LABELS[tag] || tag
}

export default function BroadcastTagPicker(props: {
  include: string[]
  exclude: string[]
  onChange: (include: string[], exclude: string[]) => void
}) {
  const [tags, setTags] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState<{ total: number; reachable: number } | null>(null)

  useEffect(() => {
    api.contacts.filterOptions()
      .then((r: any) => setTags(r.tags || []))
      .catch(() => {})
  }, [])

  // Показываем охват, только когда фильтр реально задан — иначе цифра
  // «вся база» сбивает с толку (рассылка и так идёт по всем).
  useEffect(() => {
    if (!props.include.length && !props.exclude.length) { setCount(null); return }
    let cancelled = false
    api.broadcasts.audienceCount({
      audience_tags_include: props.include,
      audience_tags_exclude: props.exclude,
    })
      .then((r: any) => { if (!cancelled) setCount({ total: r.total, reachable: r.reachable }) })
      .catch(() => { if (!cancelled) setCount(null) })
    return () => { cancelled = true }
  }, [props.include, props.exclude])

  function toggle(list: 'in' | 'ex', tag: string) {
    const inc = new Set(props.include)
    const exc = new Set(props.exclude)
    if (list === 'in') {
      inc.has(tag) ? inc.delete(tag) : (inc.add(tag), exc.delete(tag))
    } else {
      exc.has(tag) ? exc.delete(tag) : (exc.add(tag), inc.delete(tag))
    }
    props.onChange([...inc], [...exc])
  }

  const active = props.include.length + props.exclude.length

  return (
    <div className="border border-gray-200 rounded-lg">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm"
      >
        <span className="font-medium text-gray-700">
          Фильтр по тегам {active > 0 && <span className="text-brand">· выбрано {active}</span>}
        </span>
        <span className="text-gray-400">{open ? '▲' : '▼'}</span>
      </button>

      {active > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {props.include.map(t => (
            <span key={t} className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700">
              только: {label(t)}
            </span>
          ))}
          {props.exclude.map(t => (
            <span key={t} className="text-xs px-2 py-0.5 rounded bg-rose-50 text-rose-700">
              кроме: {label(t)}
            </span>
          ))}
        </div>
      )}

      {count && (
        <div className="px-3 pb-2 text-xs text-gray-500">
          Под фильтр попадает <b>{count.total}</b> контактов
          {count.reachable !== count.total && <> · с подключённым мессенджером — <b>{count.reachable}</b></>}
        </div>
      )}

      {open && (
        <div className="border-t border-gray-100 max-h-64 overflow-y-auto">
          {tags.length === 0 && (
            <div className="px-3 py-3 text-xs text-gray-400">
              Тегов пока нет. Теги проставляются в разделе Контакты.
            </div>
          )}
          {tags.map(t => {
            const inInc = props.include.includes(t)
            const inExc = props.exclude.includes(t)
            return (
              <div key={t} className="flex items-center justify-between px-3 py-1.5 hover:bg-gray-50">
                <span className={`text-sm ${SEGMENT_LABELS[t] ? 'text-gray-900 font-medium' : 'text-gray-600'}`}>
                  {label(t)}
                </span>
                <div className="flex gap-1 shrink-0">
                  <button
                    type="button" onClick={() => toggle('in', t)}
                    className={`text-xs px-2 py-0.5 rounded border ${inInc
                      ? 'bg-emerald-500 text-white border-emerald-500'
                      : 'border-gray-200 text-gray-500 hover:border-emerald-400'}`}
                  >только</button>
                  <button
                    type="button" onClick={() => toggle('ex', t)}
                    className={`text-xs px-2 py-0.5 rounded border ${inExc
                      ? 'bg-rose-500 text-white border-rose-500'
                      : 'border-gray-200 text-gray-500 hover:border-rose-400'}`}
                  >кроме</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
