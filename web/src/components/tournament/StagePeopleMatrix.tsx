'use client'

/**
 * Матрица «люди × номинации/туры/этапы» — кто в каких участвует.
 *
 * Зачем. Раньше привязка была только поштучно: зайти в карточку каждого
 * человека и отметить его туры. При 30 спикерах и 5 турах это 30 заходов,
 * а на премии с сотней номинантов — неподъёмно.
 * Здесь всё сразу: строки — люди («Фамилия Имя»), столбцы — номинации,
 * галочка на пересечении.
 *
 * ⚠️ Пишет ту же ручку, что карточка спикера (`stage_ids` целиком), поэтому
 *    поведение совпадает: при снятии человека с номинации, где у него уже
 *    есть оценки, бэк отвечает 409 и мы переспрашиваем.
 */

import { useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { Search, Check } from 'lucide-react'

export interface MatrixPerson { ec_id: number; name: string; role: string; stage_ids: number[] }
export interface MatrixStage { id: number; title: string; category_id?: number | null }

const ROLE_GROUPS: { key: string; label: string; roles: string[] }[] = [
  { key: 'speakers', label: 'Спикеры/Номинанты', roles: ['speaker', 'headliner'] },
  { key: 'jury', label: 'Жюри', roles: ['jury'] },
  { key: 'org', label: 'Организаторы', roles: ['organizer'] },
  { key: 'partners', label: 'Партнёры', roles: ['general_partner', 'partner'] },
]

export default function StagePeopleMatrix({
  eventId, people, stages, categories = [], onChange,
}: {
  eventId: number
  people: MatrixPerson[]
  stages: MatrixStage[]
  categories?: { id: number; title: string }[]
  onChange: (people: MatrixPerson[]) => void
}) {
  const [q, setQ] = useState('')
  const [catFilter, setCatFilter] = useState<number | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const cols = useMemo(() => stages.filter(
    s => catFilter === null || (s.category_id ?? null) === catFilter), [stages, catFilter])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return people.filter(p => !needle || (p.name || '').toLowerCase().includes(needle))
  }, [people, q])

  const write = async (p: MatrixPerson, next: number[], prev: number[]) => {
    try {
      await api.conference.speakers.update(eventId, p.ec_id, { stage_ids: next })
    } catch (e: any) {
      // 409 = на снимаемой номинации у человека уже есть оценки.
      if (String(e?.message || '').includes('stage_has_scores')) {
        if (confirm(`У «${p.name}» уже есть оценки в этой номинации.\n\nУбрать вместе с оценками?`)) {
          await api.conference.speakers.update(eventId, p.ec_id, {
            stage_ids: next, force_remove_stage_data: true })
          return
        }
      }
      onChange(people.map(x => x.ec_id === p.ec_id ? { ...x, stage_ids: prev } : x))
    }
  }

  const toggle = async (p: MatrixPerson, stageId: number) => {
    const prev = p.stage_ids
    const next = prev.includes(stageId) ? prev.filter(x => x !== stageId) : [...prev, stageId]
    onChange(people.map(x => x.ec_id === p.ec_id ? { ...x, stage_ids: next } : x))
    setSaving(`${p.ec_id}|${stageId}`)
    await write(p, next, prev)
    setSaving(null)
  }

  // Отметить/снять всю колонку — «весь этот тур для всех, кто в списке».
  const toggleColumn = async (stageId: number, on: boolean) => {
    const targets = rows.filter(p => p.stage_ids.includes(stageId) !== on)
    if (!targets.length) return
    if (!confirm(on
      ? `Добавить ${targets.length} чел. в эту номинацию/тур/этап?`
      : `Убрать ${targets.length} чел. из этой номинации/тура/этапа?`)) return
    const updated = people.map(p => targets.some(t => t.ec_id === p.ec_id)
      ? { ...p, stage_ids: on ? [...p.stage_ids, stageId] : p.stage_ids.filter(x => x !== stageId) }
      : p)
    onChange(updated)
    for (const p of targets) {
      const next = on ? [...p.stage_ids, stageId] : p.stage_ids.filter(x => x !== stageId)
      await write(p, next, p.stage_ids)
    }
  }

  if (!stages.length) {
    return <div className="text-sm text-gray-400 py-6 text-center border rounded-lg bg-white">
      Сначала заведите хотя бы одну номинацию/тур/этап.
    </div>
  }
  if (!people.length) {
    return <div className="text-sm text-gray-400 py-6 text-center border rounded-lg bg-white">
      В событии пока нет людей. Добавьте их на вкладке «Спикеры/Номинанты».
    </div>
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder="Поиск по фамилии…"
            className="w-full pl-8 pr-3 py-2 border rounded-lg text-sm" />
        </div>
        {categories.length > 0 && (
          <select value={catFilter ?? ''} onChange={e => setCatFilter(e.target.value ? Number(e.target.value) : null)}
            className="px-3 py-2 border rounded-lg text-sm">
            <option value="">Все категории</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        )}
        <span className="text-xs text-gray-400">
          {rows.length} чел. × {cols.length}
        </span>
      </div>

      <div className="overflow-auto border rounded-xl bg-white" style={{ maxHeight: '70vh', WebkitOverflowScrolling: 'touch' }}>
        <table className="text-sm min-w-max">
          <thead className="sticky top-0 z-20">
            <tr className="bg-gray-50">
              <th className="text-left px-3 py-2 sticky left-0 bg-gray-50 z-10 w-[240px] min-w-[240px] border-r">
                Человек
              </th>
              {cols.map(s => (
                <th key={s.id} className="px-2 py-2 border-r last:border-r-0 align-bottom"
                    style={{ minWidth: 46, maxWidth: 46 }}>
                  {/* Заголовок вертикально — иначе 70 колонок не поместятся. */}
                  <div className="flex flex-col items-center gap-1">
                    <div className="text-[11px] text-gray-600 whitespace-nowrap"
                      style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', maxHeight: 150, overflow: 'hidden' }}
                      title={s.title}>
                      {s.title}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <button onClick={() => toggleColumn(s.id, true)} title="Отметить всех в списке"
                        className="text-[10px] text-gray-400 hover:text-blue-600 leading-none">✓</button>
                      <button onClick={() => toggleColumn(s.id, false)} title="Снять всех в списке"
                        className="text-[10px] text-gray-400 hover:text-red-500 leading-none">✕</button>
                    </div>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROLE_GROUPS.map(g => {
              const list = rows.filter(p => g.roles.includes(p.role))
              if (!list.length) return null
              return (
                <>
                  <tr key={`h-${g.key}`}>
                    <td colSpan={cols.length + 1}
                      className="px-3 py-1 text-[11px] uppercase tracking-wide text-gray-400 bg-gray-50 sticky left-0">
                      {g.label} · {list.length}
                    </td>
                  </tr>
                  {list.map(p => (
                    <tr key={p.ec_id} className="border-t hover:bg-gray-50/60">
                      <td className="px-3 py-1.5 sticky left-0 bg-white z-10 border-r truncate"
                          title={p.name}>{p.name}</td>
                      {cols.map(s => {
                        const on = p.stage_ids.includes(s.id)
                        const busy = saving === `${p.ec_id}|${s.id}`
                        return (
                          <td key={s.id} className="text-center border-r last:border-r-0 p-0">
                            <button onClick={() => toggle(p, s.id)} disabled={busy}
                              className={`w-full h-8 flex items-center justify-center transition ${
                                on ? 'bg-blue-50 text-blue-600' : 'text-gray-200 hover:bg-gray-100'}`}
                              title={`${p.name} — ${s.title}`}>
                              {busy ? '…' : on ? <Check size={15} /> : <span className="text-xs">·</span>}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="text-xs text-gray-400">
        Галочка = человек участвует в этой номинации/туре/этапе. ✓ и ✕ в шапке — отметить или снять всю колонку.
      </div>
    </div>
  )
}
