'use client'

/**
 * Дашборд аналитики — сетка квадратиков-разрезов.
 *
 * ОДИН компонент на два места (движок общий):
 *   • раздел «Аналитика»                → без eventId, считает по всей базе
 *   • карточка события → «Отслеживания» → с eventId, бэк сам добавляет
 *     условие «контакт — участник этого события»
 *
 * Квадратик = разрез (поле контакта ИЛИ вопрос анкеты) + условия-фильтры.
 * Пример: разрез «Рассматривает наставника» + условие «доход из вилок от
 * 200 тысяч» — видно, кто из платёжеспособных готов покупать.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import ConditionBuilder, { SourceMeta, emptyTree } from './ConditionBuilder'

const DARK = '#25455D'
const PEACH = '#FFCFA4'

interface Card {
  id: number
  key: string
  source: 'field' | 'question'
  ref_id: number
  title: string
  kind?: string
  filters: any
  hide_absolute: boolean
  hide_percent: boolean
  scope?: number
  answered?: number
  breakdown?: { option: string; count: number; percent: number }[]
  avg?: number | null
  min?: number | null
  max?: number | null
  missing?: boolean
  error?: string
}

/** Сколько условий в дереве — для подписи на карточке. */
function countConditions(node: any): number {
  if (!node || typeof node !== 'object') return 0
  if (Array.isArray(node.items)) {
    return node.items.reduce((s: number, it: any) => s + countConditions(it), 0)
  }
  return node.ref_id ? 1 : 0
}

function CardTile({ card, sources, dashId, onChanged, readOnly, onHandle }: {
  card: Card
  sources: SourceMeta[]
  dashId: number
  onChanged: () => void
  readOnly: boolean
  onHandle: (on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [filters, setFilters] = useState<any>(card.filters || emptyTree())
  const [saving, setSaving] = useState(false)

  useEffect(() => { setFilters(card.filters || emptyTree()) }, [card.filters])

  const save = async (patch: any) => {
    setSaving(true)
    try {
      await api.analytics.updateCard(dashId, card.id, patch)
      onChanged()
    } finally { setSaving(false) }
  }

  const remove = async () => {
    if (!confirm(`Убрать квадратик «${card.title}»?`)) return
    await api.analytics.deleteCard(dashId, card.id)
    onChanged()
  }

  const condCount = countConditions(card.filters)
  const maxCount = Math.max(1, ...(card.breakdown || []).map(b => b.count))

  return (
    <div className="flex h-full flex-col rounded-2xl border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-start gap-2">
        {!readOnly && (
          <span
            onMouseEnter={() => onHandle(true)}
            onMouseLeave={() => onHandle(false)}
            className="cursor-grab select-none pt-0.5 text-gray-300"
            title="Перетащить"
          >⠿</span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-[#25455D]" title={card.title}>
            {card.title}
          </div>
          {condCount > 0 && (
            <div className="mt-0.5 text-xs" style={{ color: DARK }}>
              с условиями: {condCount}
            </div>
          )}
        </div>
        {!readOnly && (
          <div className="flex shrink-0 gap-1">
            <button onClick={() => setOpen(o => !o)}
                    className="rounded px-1.5 text-gray-400 hover:text-[#25455D]"
                    title="Настроить">⚙</button>
            <button onClick={remove}
                    className="rounded px-1.5 text-gray-400 hover:text-red-500"
                    title="Убрать">✕</button>
          </div>
        )}
      </div>

      {card.missing && (
        <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-700">
          Разрез удалён — поле или анкета больше не существуют.
        </div>
      )}
      {card.error && (
        <div className="rounded-lg bg-red-50 p-2 text-xs text-red-600">{card.error}</div>
      )}

      {!card.missing && !card.error && (
        <>
          {/* ⚠️ Знаменатель процентов — ОТВЕТИВШИЕ, а не все прошедшие условия.
              Молчащий человек не «против», он неизвестен. Показываем обе
              цифры, чтобы была видна полнота разреза. */}
          <div className="mb-2 text-xs text-gray-500">
            ответили {card.answered ?? 0} из {card.scope ?? 0}
          </div>

          {typeof card.avg === 'number' && (
            <div className="mb-2 rounded-lg bg-gray-50 p-2 text-sm">
              среднее <b>{card.avg}</b>
              <span className="ml-2 text-xs text-gray-500">
                от {card.min} до {card.max}
              </span>
            </div>
          )}

          <div className="space-y-1.5">
            {(card.breakdown || []).length === 0 && (
              <div className="text-sm text-gray-400">Нет данных</div>
            )}
            {(card.breakdown || []).map(b => (
              <div key={b.option}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate" title={b.option}>{b.option}</span>
                  <span className="shrink-0 tabular-nums text-gray-600">
                    {!card.hide_absolute && <b className="text-[#25455D]">{b.count}</b>}
                    {!card.hide_absolute && !card.hide_percent && ' · '}
                    {!card.hide_percent && <span>{b.percent}%</span>}
                  </span>
                </div>
                <div className="mt-0.5 h-1.5 w-full rounded bg-gray-100">
                  <div className="h-1.5 rounded"
                       style={{ width: `${Math.round(b.count * 100 / maxCount)}%`, background: PEACH }} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {open && !readOnly && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="mb-2 text-xs font-semibold text-gray-600">
            Считать только тех, кто подходит под условия
          </div>
          <ConditionBuilder value={filters} sources={sources} onChange={setFilters} />

          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={card.hide_absolute}
                     onChange={e => save({ hide_absolute: e.target.checked })} />
              не показывать абсолютные
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={card.hide_percent}
                     onChange={e => save({ hide_percent: e.target.checked })} />
              не показывать проценты
            </label>
          </div>

          <div className="mt-3 flex gap-2">
            <button onClick={() => save({ filters })} disabled={saving}
                    className="btn-gold px-3 py-1.5 text-sm">
              {saving ? 'Сохраняю…' : 'Применить'}
            </button>
            <button onClick={() => { setFilters(emptyTree()); save({ filters: emptyTree() }) }}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600">
              Сбросить условия
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function DashboardView({ eventId, readOnly = false }: {
  eventId?: number
  readOnly?: boolean
}) {
  const [dashboards, setDashboards] = useState<any[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [cards, setCards] = useState<Card[]>([])
  const [sources, setSources] = useState<SourceMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState('')
  const [dragId, setDragId] = useState<number | null>(null)
  // Карточка, на ручке которой сейчас мышь — только её можно тащить.
  const [handleId, setHandleId] = useState<number | null>(null)

  const loadList = useCallback(async () => {
    const [d, s] = await Promise.all([
      api.analytics.dashboards(eventId),
      api.analytics.sources(),
    ])
    setDashboards(d.dashboards || [])
    setSources(s.sources || [])
    return d.dashboards || []
  }, [eventId])

  const loadCards = useCallback(async (id: number) => {
    const r = await api.analytics.dashboard(id)
    setCards(r.cards || [])
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true); setErr('')
      try {
        const list = await loadList()
        if (!alive) return
        if (list.length) {
          setActiveId(list[0].id)
          await loadCards(list[0].id)
        }
      } catch (e: any) {
        if (alive) setErr(e?.message || 'Не удалось загрузить')
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [loadList, loadCards])

  const switchTo = async (id: number) => {
    setActiveId(id); setCards([])
    try { await loadCards(id) } catch (e: any) { setErr(e?.message || '') }
  }

  const createDashboard = async () => {
    const title = prompt('Название дашборда', 'Новый дашборд')
    if (title === null) return
    setBusy(true)
    try {
      const d = await api.analytics.createDashboard({ title, event_id: eventId })
      await loadList()
      setActiveId(d.id)
      await loadCards(d.id)
    } catch (e: any) { alert(e?.message || 'Не получилось') }
    finally { setBusy(false) }
  }

  const renameDashboard = async () => {
    if (!activeId) return
    const cur = dashboards.find(d => d.id === activeId)
    const title = prompt('Название дашборда', cur?.title || '')
    if (!title) return
    await api.analytics.renameDashboard(activeId, title)
    await loadList()
  }

  const removeDashboard = async () => {
    if (!activeId) return
    const cur = dashboards.find(d => d.id === activeId)
    if (!confirm(`Удалить дашборд «${cur?.title}» вместе с квадратиками?`)) return
    await api.analytics.deleteDashboard(activeId)
    const list = await loadList()
    if (list.length) { setActiveId(list[0].id); await loadCards(list[0].id) }
    else { setActiveId(null); setCards([]) }
  }

  const autofill = async () => {
    if (!activeId) return
    setBusy(true)
    try {
      const r = await api.analytics.autofill(activeId)
      await loadCards(activeId)
      if (!r.added) alert('Все подходящие разрезы уже добавлены.')
    } finally { setBusy(false) }
  }

  const addCard = async (key: string) => {
    if (!activeId || !key) return
    const s = sources.find(x => x.key === key)
    if (!s) return
    setAdding('')
    await api.analytics.addCard(activeId, { source: s.source, ref_id: s.ref_id })
    await loadCards(activeId)
  }

  const drop = async (targetId: number) => {
    if (dragId == null || dragId === targetId || !activeId) { setDragId(null); return }
    const from = cards.findIndex(c => c.id === dragId)
    const to = cards.findIndex(c => c.id === targetId)
    if (from < 0 || to < 0) { setDragId(null); return }
    const next = [...cards]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setCards(next)
    setDragId(null)
    try {
      await api.analytics.reorderCards(activeId, next.map(c => c.id))
    } catch {
      await loadCards(activeId)   // не сохранилось — вернём порядок с сервера
    }
  }

  if (loading) return <div className="p-6 text-gray-500">Загрузка…</div>
  if (err) return <div className="p-6 text-red-600">{err}</div>

  const used = new Set(cards.map(c => c.key))
  const free = sources.filter(s => !used.has(s.key))
  const groups: Record<string, SourceMeta[]> = {}
  free.forEach(s => { (groups[s.group] ||= []).push(s) })

  return (
    <div className="space-y-4">
      {/* ── Переключатель дашбордов ── */}
      <div className="flex flex-wrap items-center gap-2">
        {dashboards.map(d => (
          <button key={d.id} onClick={() => switchTo(d.id)}
                  className={`rounded-full px-3 py-1.5 text-sm ${
                    d.id === activeId ? 'text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                  style={d.id === activeId ? { background: DARK } : undefined}>
            {d.title}
          </button>
        ))}
        {!readOnly && (
          <button onClick={createDashboard} disabled={busy}
                  className="rounded-full border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-500 hover:border-[#25455D] hover:text-[#25455D]">
            + дашборд
          </button>
        )}
      </div>

      {!dashboards.length && (
        <div className="rounded-2xl border border-dashed border-gray-300 p-8 text-center">
          <div className="mb-2 font-semibold text-[#25455D]">Дашбордов пока нет</div>
          <div className="mb-4 text-sm text-gray-500">
            Создайте дашборд и соберите квадратики — по полям контакта и вопросам анкет.
          </div>
          {!readOnly && (
            <button onClick={createDashboard} className="btn-gold px-4 py-2">
              Создать дашборд
            </button>
          )}
        </div>
      )}

      {activeId && (
        <>
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 pb-3">
              <button onClick={autofill} disabled={busy} className="btn-gold px-3 py-1.5 text-sm">
                {busy ? 'Собираю…' : 'Собрать автоматически'}
              </button>

              <select value={adding} onChange={e => addCard(e.target.value)}
                      className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
                <option value="">+ добавить квадратик…</option>
                {Object.entries(groups).map(([g, items]) => (
                  <optgroup key={g} label={g}>
                    {items.map(s => <option key={s.key} value={s.key}>{s.title}</option>)}
                  </optgroup>
                ))}
              </select>

              <div className="ml-auto flex gap-2 text-sm">
                <button onClick={renameDashboard} className="text-gray-500 hover:text-[#25455D]">
                  Переименовать
                </button>
                <button onClick={removeDashboard} className="text-gray-400 hover:text-red-500">
                  Удалить
                </button>
              </div>
            </div>
          )}

          {!cards.length ? (
            <div className="rounded-2xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
              Квадратиков нет. Нажмите «Собрать автоматически» — добавятся все
              выпадающие списки и числовые поля.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {cards.map(c => (
                <div key={c.id}
                     // ⚠️ draggable включается ТОЛЬКО когда мышь на ручке ⠿ —
                     // иначе браузер тащит карточку при выделении текста и
                     // при работе с полями конструктора условий.
                     draggable={!readOnly && handleId === c.id}
                     onDragStart={() => setDragId(c.id)}
                     onDragEnd={() => { setDragId(null); setHandleId(null) }}
                     onDragOver={e => e.preventDefault()}
                     onDrop={() => drop(c.id)}
                     className={dragId === c.id ? 'opacity-40' : ''}>
                  <CardTile card={c} sources={sources} dashId={activeId}
                            onChanged={() => loadCards(activeId)} readOnly={readOnly}
                            onHandle={on => setHandleId(on ? c.id : null)} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
