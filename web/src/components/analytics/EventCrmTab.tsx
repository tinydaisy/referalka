'use client'

/**
 * CRM события: люди по этапам — четыре колонки.
 *
 * Не зарегистрированы → Зарегистрированы → Перешли в чат → Были в эфире.
 * В шапке колонки процент и число, внутри — список людей; список
 * сворачивается до шапки, чтобы на телефоне можно было листать колонки.
 *
 * ⚠️ В коллаб-событии каждый организатор видит ТОЛЬКО СВОИХ приведённых —
 * так устроена коллаборация: каждый ведёт свою базу через своего бота.
 * Об этом прямо написано плашкой, иначе цифры выглядят заниженными.
 */

import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { api } from '@/lib/api'
import PeopleColumnBase from './PeopleColumnBase'

const TITLES: Record<string, { title: string; hint: string; tone: 'dark' | 'peach' }> = {
  not_registered: { title: 'Не зарегистрированы', hint: 'открыли, но не записались', tone: 'peach' },
  registered:     { title: 'Зарегистрированы',    hint: 'записались на событие',      tone: 'dark' },
  in_chat:        { title: 'Перешли в чат',       hint: 'состоят в чате события',     tone: 'dark' },
  was_live:       { title: 'Были в эфире',        hint: 'открыли трансляцию',         tone: 'dark' },
}

export default function EventCrmTab({ eventId }: { eventId: number }) {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.events.crm(eventId)
      .then(setData)
      .catch((e: any) => setErr(e?.message || 'Не удалось загрузить'))
  }, [eventId])

  if (err) return <p className="text-sm text-red-600">{err}</p>
  if (!data) return <p className="text-sm text-gray-400">Загружаем…</p>

  return (
    <div>
      <p className="mb-3 text-sm text-gray-500">
        Всего людей: <b className="text-gray-800">{data.total}</b>
        {' · '}проценты считаются от них
      </p>

      {data.is_collab && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-[#FFCFA4]/35 p-3 text-sm text-[#25455D]">
          <Info size={16} className="mt-0.5 shrink-0" />
          <span>
            Это общее событие: здесь только <b>ваши</b> приглашённые. Людей,
            которых привели другие организаторы, вы не видите — каждый ведёт
            свою базу через своего бота.
          </span>
        </div>
      )}

      {!data.total ? (
        <p className="text-sm text-gray-400">
          На событие пока никто не заходил.
        </p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-3 scroll-visible">
          {data.columns.map((c: any) => {
            const meta = TITLES[c.key] || { title: c.key, hint: '', tone: 'dark' as const }
            return (
              <PeopleColumnBase key={c.key}
                title={meta.title} hint={meta.hint} tone={meta.tone}
                count={c.count} percent={c.percent} people={c.people} />
            )
          })}
        </div>
      )}
    </div>
  )
}
