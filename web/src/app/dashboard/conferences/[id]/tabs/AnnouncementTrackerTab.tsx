'use client'
import { useState, useEffect } from 'react'
import { Plus, Settings2, Trash2, X, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

type Platform = { id: number; label: string; sort_order: number }
type Column = { id: number; title: string; sort_order: number }
type Speaker = { collaborator_id: number; name: string; role: string; title: string | null; photo_url: string | null }
type Cell = { is_done: boolean; content: string }

const ROLE_LABELS: Record<string, string> = {
  organizer: 'Организатор',
  jury: 'Жюри',
  headliner: 'Хедлайнер',
  speaker: 'Спикер',
  general_partner: 'Ген. партнёр',
  partner: 'Партнёр',
}

const NAME_W = 150
const AGREE_W = 190
const CELL_W = 160

const cellKey = (colId: number, platId: number, collabId: number) => `${colId}_${platId}_${collabId}`

export default function AnnouncementTrackerTab({ eventId, moduleSlug }: { eventId: number; moduleSlug?: string }) {
  const [loading, setLoading] = useState(true)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [columns, setColumns] = useState<Column[]>([])
  const [speakers, setSpeakers] = useState<Speaker[]>([])
  const [cells, setCells] = useState<Record<string, Cell>>({})
  const [agreements, setAgreements] = useState<Record<number, string>>({})
  const [showPlatforms, setShowPlatforms] = useState(false)

  // Премия/турнир/конкурс оперируют «жюри», конференция — «спикерами». Текст подсказки.
  const isJury = moduleSlug === 'turnir' || moduleSlug === 'awards' || moduleSlug === 'contest'
  const roleWord = isJury ? 'жюри' : 'спикеров'

  async function load() {
    setLoading(true)
    try {
      const r = await api.announcementTracker.get(eventId)
      setPlatforms(r.platforms || [])
      setColumns(r.columns || [])
      setSpeakers(r.speakers || [])
      setCells(r.cells || {})
      setAgreements(r.agreements || {})
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [eventId])

  function getCell(colId: number, platId: number, collabId: number): Cell {
    return cells[cellKey(colId, platId, collabId)] || { is_done: false, content: '' }
  }

  function setCellLocal(colId: number, platId: number, collabId: number, patch: Partial<Cell>) {
    const k = cellKey(colId, platId, collabId)
    setCells(prev => ({ ...prev, [k]: { ...(prev[k] || { is_done: false, content: '' }), ...patch } }))
  }

  async function persistCell(colId: number, platId: number, collabId: number) {
    const c = getCell(colId, platId, collabId)
    try {
      await api.announcementTracker.saveCell(eventId, {
        collaborator_id: collabId, column_id: colId, platform_id: platId,
        is_done: c.is_done, content: c.content,
      })
    } catch (e: any) { alert(e.message) }
  }

  async function toggleDone(colId: number, platId: number, collabId: number) {
    const cur = getCell(colId, platId, collabId)
    const next = !cur.is_done
    setCellLocal(colId, platId, collabId, { is_done: next })
    try {
      await api.announcementTracker.saveCell(eventId, {
        collaborator_id: collabId, column_id: colId, platform_id: platId,
        is_done: next, content: cur.content,
      })
    } catch (e: any) { alert(e.message); setCellLocal(colId, platId, collabId, { is_done: cur.is_done }) }
  }

  async function persistAgreement(collabId: number) {
    try {
      await api.announcementTracker.saveAgreement(eventId, { collaborator_id: collabId, content: agreements[collabId] || '' })
    } catch (e: any) { alert(e.message) }
  }

  async function addColumn() {
    try {
      const c = await api.announcementTracker.addColumn(eventId)
      setColumns(prev => [...prev, c])
    } catch (e: any) { alert(e.message) }
  }

  async function deleteColumn(id: number) {
    if (!confirm('Удалить этот анонс со всеми отметками по нему?')) return
    try {
      await api.announcementTracker.deleteColumn(eventId, id)
      setColumns(prev => prev.filter(c => c.id !== id))
      // подчистим ячейки этого анонса локально
      setCells(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith(`${id}_`))))
    } catch (e: any) { alert(e.message) }
  }

  async function renameColumn(id: number, title: string) {
    const trimmed = title.trim()
    if (!trimmed) return
    try { await api.announcementTracker.updateColumn(eventId, id, { title: trimmed }) }
    catch (e: any) { alert(e.message) }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-48"><Spinner className="text-brand text-2xl" /></div>
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Трекер анонсов {roleWord}</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Отмечайте, на какую дату и на каких площадках договорились об анонсе и сделан ли он.
            {roleWord === 'спикеров' ? ' Спикеры' : ' Жюри'} подтягиваются автоматически.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowPlatforms(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors whitespace-nowrap">
            <Settings2 size={15} /> Площадки
          </button>
          <button onClick={addColumn}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium bg-[#25455D] text-[#FFCFA4] hover:opacity-90 transition-opacity whitespace-nowrap">
            <Plus size={15} /> Анонс
          </button>
        </div>
      </div>

      {speakers.length === 0 && (
        <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
          Пока нет {roleWord}. Добавьте их во вкладке «Спикеры» — здесь они появятся автоматически.
        </div>
      )}

      {speakers.length > 0 && (
        <div className="overflow-auto max-h-[72vh] rounded-2xl border border-gray-200 bg-white">
          <table className="border-collapse text-sm" style={{ minWidth: NAME_W + AGREE_W + columns.length * platforms.length * CELL_W }}>
            <thead>
              {/* Строка 1 — группы «Анонс N» */}
              <tr>
                <th rowSpan={2} className="sticky left-0 top-0 z-40 bg-gray-50 border-b border-r border-gray-200 px-3 py-2 text-left align-bottom font-semibold text-gray-700"
                    style={{ width: NAME_W, minWidth: NAME_W }}>
                  Спикер
                </th>
                <th rowSpan={2} className="sticky top-0 z-40 bg-gray-50 border-b border-r-2 border-gray-300 px-3 py-2 text-left align-bottom font-semibold text-gray-700"
                    style={{ left: NAME_W, width: AGREE_W, minWidth: AGREE_W }}>
                  Договорённости
                </th>
                {columns.map(col => (
                  <th key={col.id} colSpan={platforms.length}
                      className="sticky top-0 z-20 bg-[#25455D] text-white border-b border-r-2 border-gray-300 px-2 py-1.5 text-center font-semibold">
                    <div className="flex items-center justify-center gap-1">
                      <input
                        defaultValue={col.title}
                        onBlur={e => renameColumn(col.id, e.target.value)}
                        className="bg-transparent text-center text-white placeholder-white/60 font-semibold w-24 focus:outline-none focus:bg-white/10 rounded px-1"
                      />
                      <button onClick={() => deleteColumn(col.id)} title="Удалить анонс"
                        className="text-white/60 hover:text-white transition-colors">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
              {/* Строка 2 — площадки */}
              <tr>
                {columns.map(col => platforms.map((p, pi) => (
                  <th key={`${col.id}_${p.id}`}
                      className={`sticky top-[37px] z-20 bg-[#34576f] text-white border-b border-gray-300 px-2 py-1.5 text-center text-xs font-medium ${pi === platforms.length - 1 ? 'border-r-2 border-gray-300' : 'border-r border-white/15'}`}
                      style={{ minWidth: CELL_W }}>
                    {p.label}
                  </th>
                )))}
              </tr>
            </thead>
            <tbody>
              {speakers.map((sp, idx) => (
                <tr key={sp.collaborator_id} className="group">
                  {/* Имя — закреплено слева */}
                  <td className="sticky left-0 z-30 bg-white group-hover:bg-gray-50 border-b border-r border-gray-200 px-3 py-2 align-top"
                      style={{ width: NAME_W, minWidth: NAME_W }}>
                    <div className="font-medium text-gray-900 leading-tight">{sp.name}</div>
                    <div className="text-[11px] text-gray-400 mt-0.5">{ROLE_LABELS[sp.role] || sp.role}</div>
                  </td>
                  {/* Договорённости — закреплено слева */}
                  <td className="sticky z-30 bg-white group-hover:bg-gray-50 border-b border-r-2 border-gray-300 p-0 align-top"
                      style={{ left: NAME_W, width: AGREE_W, minWidth: AGREE_W }}>
                    <textarea
                      value={agreements[sp.collaborator_id] || ''}
                      onChange={e => setAgreements(prev => ({ ...prev, [sp.collaborator_id]: e.target.value }))}
                      onBlur={() => persistAgreement(sp.collaborator_id)}
                      rows={2}
                      placeholder="Что договорились…"
                      className="w-full h-full min-h-[52px] resize-none bg-transparent px-3 py-2 text-sm text-gray-700 placeholder-gray-300 focus:outline-none focus:bg-amber-50/60"
                    />
                  </td>
                  {/* Ячейки матрицы */}
                  {columns.map(col => platforms.map((p, pi) => {
                    const c = getCell(col.id, p.id, sp.collaborator_id)
                    return (
                      <td key={`${col.id}_${p.id}`}
                          className={`border-b border-gray-200 p-0 align-top ${pi === platforms.length - 1 ? 'border-r-2 border-gray-300' : 'border-r border-gray-100'} ${c.is_done ? 'bg-green-50' : ''}`}
                          style={{ minWidth: CELL_W }}>
                        <div className="flex items-start gap-1 px-1.5 py-1.5">
                          <button
                            onClick={() => toggleDone(col.id, p.id, sp.collaborator_id)}
                            title={c.is_done ? 'Сделано' : 'Отметить «сделано»'}
                            className={`mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${c.is_done ? 'bg-green-500 border-green-500 text-white' : 'border-gray-300 bg-white hover:border-green-400'}`}>
                            {c.is_done && <Check size={11} strokeWidth={3} />}
                          </button>
                          <textarea
                            value={c.content}
                            onChange={e => setCellLocal(col.id, p.id, sp.collaborator_id, { content: e.target.value })}
                            onBlur={() => persistCell(col.id, p.id, sp.collaborator_id)}
                            rows={2}
                            placeholder="дата / заметка"
                            className="w-full min-h-[44px] resize-none bg-transparent text-sm text-gray-700 placeholder-gray-300 focus:outline-none"
                          />
                        </div>
                      </td>
                    )
                  }))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400 mt-3">
        Изменения сохраняются автоматически. Колонку «Спикер» и шапку видно при прокрутке.
        На телефоне таблицу можно листать вбок.
      </p>

      {showPlatforms && (
        <PlatformsModal
          eventId={eventId}
          platforms={platforms}
          onClose={() => setShowPlatforms(false)}
          onChange={setPlatforms}
        />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────
// Модалка настройки площадок
// ──────────────────────────────────────────────

function PlatformsModal({ eventId, platforms, onClose, onChange }: {
  eventId: number
  platforms: Platform[]
  onClose: () => void
  onChange: (p: Platform[]) => void
}) {
  const [list, setList] = useState<Platform[]>(platforms)
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState(false)

  async function add() {
    const label = newLabel.trim()
    if (!label) return
    setBusy(true)
    try {
      const p = await api.announcementTracker.addPlatform(eventId, { label })
      const next = [...list, p]
      setList(next); onChange(next); setNewLabel('')
    } catch (e: any) { alert(e.message) }
    finally { setBusy(false) }
  }

  async function rename(id: number, label: string) {
    const trimmed = label.trim()
    if (!trimmed) return
    try {
      await api.announcementTracker.updatePlatform(eventId, id, { label: trimmed })
      const next = list.map(p => p.id === id ? { ...p, label: trimmed } : p)
      setList(next); onChange(next)
    } catch (e: any) { alert(e.message) }
  }

  async function remove(id: number) {
    if (!confirm('Удалить площадку со всеми отметками по ней?')) return
    try {
      await api.announcementTracker.deletePlatform(eventId, id)
      const next = list.filter(p => p.id !== id)
      setList(next); onChange(next)
    } catch (e: any) { alert(e.message) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900">Площадки для анонсов</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-2">
          {list.map(p => (
            <div key={p.id} className="flex items-center gap-2">
              <input
                defaultValue={p.label}
                onBlur={e => rename(p.id, e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-[#25455D]"
              />
              <button onClick={() => remove(p.id)} className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {list.length === 0 && <p className="text-sm text-gray-400 text-center py-2">Площадок пока нет</p>}

          <div className="flex items-center gap-2 pt-3 border-t border-gray-100 mt-3">
            <input
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add() }}
              placeholder="Новая площадка (напр. Дзен)"
              className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-[#25455D]"
            />
            <button onClick={add} disabled={busy || !newLabel.trim()}
              className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium bg-[#25455D] text-[#FFCFA4] hover:opacity-90 disabled:opacity-40 transition-opacity">
              <Plus size={15} /> Добавить
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
