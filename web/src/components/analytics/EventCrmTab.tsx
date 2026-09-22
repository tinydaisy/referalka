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
 *
 * ⚠️⚠️ ДВА БЛОКА ПЛЮСОНА — ОТДЕЛЬНЫМ РАЗДЕЛОМ, а не пятой и шестой колонкой
 * общей ветки. Видит их только внедренец (сервер отдаёт `plusson_columns`
 * пустым всем остальным). Отдельно потому, что это ДРУГАЯ воронка: человек
 * может быть зарегистрирован в ПЛЮСОНе и при этом не состоять в чате события,
 * а может не регистрироваться на событие, но давно быть клиентом ПЛЮСОНА.
 * В одной шкале «интерес → рега → чат → эфир» он оказался бы на двух этапах
 * сразу, и проценты перестали бы что-либо значить.
 */

import { useEffect, useState } from 'react'
import { Info, UserCog } from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import CollapsibleGroup from '@/components/CollapsibleGroup'
import PeopleColumnBase from './PeopleColumnBase'

const TITLES: Record<string, { title: string; hint: string; tone: 'dark' | 'peach' }> = {
  not_registered: { title: 'Не зарегистрированы', hint: 'открыли, но не записались', tone: 'peach' },
  registered:     { title: 'Зарегистрированы',    hint: 'записались на событие',      tone: 'dark' },
  in_chat:        { title: 'Перешли в чат',       hint: 'состоят в чате события',     tone: 'dark' },
  was_live:       { title: 'Были в эфире',        hint: 'открыли трансляцию',         tone: 'dark' },

  plusson_interested: {
    title: 'Заинтересовались ПЛЮСОНом',
    hint: 'перешли в бот по вашей ссылке', tone: 'dark',
  },
  plusson_registered: {
    title: 'Зарегистрированы в ПЛЮСОНе',
    hint: 'завели кабинет — виден тариф и срок', tone: 'dark',
  },
}

export default function EventCrmTab({ eventId }: { eventId: number }) {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')
  // Фильтр «купили такой-то тариф». Колонки при этом остаются этапами —
  // видно, докуда дошли именно платные участники выбранного тарифа.
  const [tariffId, setTariffId] = useState<number | null>(null)
  // ⚠️ Тарифы запоминаем отдельно: при выборе фильтра сервер отдаёт только
  // купивших, и список тарифов в ответе схлопнулся бы до одного — выпадашка
  // потеряла бы остальные пункты, и вернуться к «всем» было бы нечем.
  const [tariffs, setTariffs] = useState<any[]>([])
  // Раздача людей менеджерам лидов (миграция 484) — только владельцу кабинета.
  const { isAssistant } = useMe()
  const [managers, setManagers] = useState<any[]>([])
  const [assignBusy, setAssignBusy] = useState(false)
  const [assignNote, setAssignNote] = useState('')

  useEffect(() => {
    if (isAssistant) return
    api.contactAssignments.managers()
      .then((r: any) => setManagers(r?.managers || []))
      .catch(() => setManagers([]))
  }, [isAssistant])

  /** Закрепить всех людей из колонки за менеджером — «раздать пачкой». */
  async function assignColumn(people: any[], grantId: number, label: string) {
    const ids = people.map(p => p.contact_id).filter(Boolean)
    if (!ids.length) return
    const m = managers.find(x => x.grant_id === grantId)
    const who = m?.name || m?.email || 'менеджеру'
    if (!confirm(
      `Закрепить ${ids.length} чел. из колонки «${label}» за ${who}?\n\n` +
      `Если кто-то из них уже закреплён за другим менеджером — закрепление ` +
      `перейдёт к ${who}: у человека может быть только один менеджер.`
    )) return
    setAssignBusy(true)
    setAssignNote('')
    try {
      const r: any = await api.contactAssignments.assign(ids, grantId)
      setAssignNote(`Закреплено: ${r?.assigned ?? ids.length} чел. за ${who}`)
      api.contactAssignments.managers()
        .then((x: any) => setManagers(x?.managers || [])).catch(() => {})
    } catch (e: any) {
      setAssignNote(e?.message || 'Не удалось закрепить')
    } finally {
      setAssignBusy(false)
    }
  }

  useEffect(() => {
    api.events.crm(eventId, tariffId ? { tariff_id: tariffId } : undefined)
      .then((d: any) => {
        setData(d)
        if (!tariffId) setTariffs(d?.tariffs || [])
      })
      .catch((e: any) => setErr(e?.message || 'Не удалось загрузить'))
  }, [eventId, tariffId])

  if (err) return <p className="text-sm text-red-600">{err}</p>
  if (!data) return <p className="text-sm text-gray-400">Загружаем…</p>

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-sm text-gray-500">
          Всего людей: <b className="text-gray-800">{data.total}</b>
          {' · '}проценты считаются от них
        </p>

        {tariffs.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-gray-500">
            Тариф:
            <select
              value={tariffId ?? ''}
              onChange={e => setTariffId(e.target.value ? Number(e.target.value) : null)}
              className="rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-800"
            >
              <option value="">Все участники</option>
              {tariffs.map((t: any) => (
                <option key={t.id} value={t.id}>
                  {t.title} ({t.paid_count})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

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

      {assignNote && (
        <p className="mb-3 text-sm text-[#25455D]">{assignNote}</p>
      )}

      {!data.total ? (
        <p className="text-sm text-gray-400">
          {tariffId
            ? 'С этим тарифом пока никого нет.'
            : 'На событие пока никто не заходил.'}
        </p>
      ) : (
        <>
          <div className="flex gap-3 overflow-x-auto pb-3 scroll-visible">
            {data.columns.map(renderColumn)}
          </div>

          {/* ⚠️ Раздел рисуется, только если сервер прислал блоки — то есть
              человек внедренец. У обычного помощника массив пуст, и здесь
              не появляется ничего: отдельного флага «я внедренец» на фронте
              нет намеренно, он был бы вторым источником правды. */}
          {data.plusson_columns?.length > 0 && (
            <div className="mt-4">
              <CollapsibleGroup title="ПЛЮСОН: кто из них дошёл до платформы"
                                count={data.plusson_columns.length}>
                <p className="mb-3 text-sm text-gray-500">
                  Эти два блока — про вашу работу внедренцем, а не про событие.
                  Здесь только закреплённые за вами люди. Человек может быть в
                  ПЛЮСОНе, но не в чате события — и наоборот, поэтому блоки
                  стоят отдельно от воронки выше.
                </p>
                <div className="flex gap-3 overflow-x-auto pb-1 scroll-visible">
                  {data.plusson_columns.map(renderColumn)}
                </div>
              </CollapsibleGroup>
            </div>
          )}
        </>
      )}
    </div>
  )

  /** Одна колонка воронки. Общая для этапов события и блоков ПЛЮСОНА —
   *  чтобы вид и раздача людей менеджерам были в них одинаковые. */
  function renderColumn(c: any) {
    const meta = TITLES[c.key] || { title: c.key, hint: '', tone: 'dark' as const }
    return (
      <PeopleColumnBase key={c.key}
        title={meta.title} hint={meta.hint} tone={meta.tone}
        count={c.count} percent={c.percent} people={c.people}
        footer={managers.length > 0 && c.count > 0 ? (
          /* Раздать людей колонки менеджерам: выбрал — и все из этой
             колонки закреплены. Так распределяют участников события
             между сотрудниками, не открывая каждого по отдельности. */
          <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <UserCog size={12} className="shrink-0" />
            <select
              value=""
              disabled={assignBusy}
              onChange={e => {
                const v = Number(e.target.value)
                if (v) assignColumn(c.people, v, meta.title)
                e.target.value = ''
              }}
              className="min-w-0 flex-1 rounded border border-gray-200 px-1 py-0.5 text-[11px] disabled:opacity-60"
            >
              <option value="">Закрепить всех за…</option>
              {managers.map((m: any) => (
                <option key={m.grant_id} value={m.grant_id}>
                  {m.name || m.email}
                </option>
              ))}
            </select>
          </label>
        ) : undefined}
      />
    )
  }
}
