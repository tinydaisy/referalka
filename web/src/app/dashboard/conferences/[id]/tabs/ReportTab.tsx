'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Plus, Trash2, ChevronDown, BarChart2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

interface ReportMeta {
  id: number
  event_id: number
  created_at: string
  announcements: number
  total_entered: number
  total_registered: number
  speakers_entered: number
  speakers_registered: number
  referrals_entered: number
  referrals_registered: number
}

interface SpeakerRow {
  speaker_event_id: number
  speaker_id: number
  name: string
  username: string
  role: string
  is_commercial: boolean
  ref_code: string
  entered: number
  registered: number
}

interface PersonRow {
  participant_id: number
  name: string
  username: string
  tg_id: string
  entered: number
  registered: number
}

interface ReportDetail extends ReportMeta {
  speakers_data: SpeakerRow[]
  referrals_data: PersonRow[]
  base_data: PersonRow[]
}

function pct(num: number, den: number): string {
  if (!den) return '—'
  return `${(num / den * 100).toFixed(1)}%`
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// Шапка группы (цветная строка)
function GroupHeader({
  label, entered, registered, totalEntered, totalRegistered, color
}: {
  label: string
  entered: number
  registered: number
  totalEntered: number
  totalRegistered: number
  color: 'dark' | 'blue' | 'amber' | 'gray'
}) {
  const cls = {
    dark:  'bg-gradient-to-r from-[#25455D] to-[#1a3348] text-[#FFCFA4]',
    blue:  'bg-blue-100 text-blue-800',
    amber: 'bg-amber-50 text-amber-800 border border-amber-100',
    gray:  'bg-gray-100 text-gray-600',
  }[color]

  return (
    <div className={`flex items-center justify-between px-4 py-2.5 rounded-t-xl font-semibold text-sm ${cls}`}>
      <span>{label}</span>
      <span className="font-bold tabular-nums flex items-center gap-2 flex-wrap justify-end">
        <span>{entered} / {registered}</span>
        <span className="font-normal opacity-75">{pct(registered, entered)}</span>
        <span className="text-xs opacity-50 hidden sm:inline">
          {pct(entered, totalEntered)} / {pct(registered, totalRegistered)}
        </span>
      </span>
    </div>
  )
}

// Строка таблицы — спикер (кликабельный)
function SpeakerRow({ row, i, eventId, totalEntered, totalRegistered }: {
  row: SpeakerRow; i: number; eventId: number; totalEntered: number; totalRegistered: number
}) {
  return (
    <tr className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60">
      <td className="px-4 py-3 text-gray-400 tabular-nums text-sm">{i + 1}</td>
      <td className="px-4 py-3">
        <Link href={`/dashboard/conferences/${eventId}/speakers/${row.speaker_id}`}
          className="font-medium text-[#25455D] hover:underline text-sm">
          {row.username ? `@${row.username}` : row.name || '—'}
        </Link>
        {row.username && row.name && <div className="text-xs text-gray-400">{row.name}</div>}
      </td>
      <td className="px-3 py-3 text-center">
        <span className="font-semibold tabular-nums text-gray-800 text-sm">{row.entered}</span>
        <span className="text-gray-300 mx-1">/</span>
        <span className="font-semibold tabular-nums text-gray-800 text-sm">{row.registered}</span>
      </td>
      <td className="px-3 py-3 text-center text-gray-600 text-sm hidden sm:table-cell">{pct(row.registered, row.entered)}</td>
      <td className="px-3 py-3 text-center text-xs text-gray-400 hidden md:table-cell">
        {pct(row.entered, totalEntered)} / {pct(row.registered, totalRegistered)}
      </td>
    </tr>
  )
}

// Строка таблицы — участник (некликабельный)
function PersonRowEl({ row, i, totalEntered, totalRegistered }: {
  row: PersonRow; i: number; totalEntered: number; totalRegistered: number
}) {
  return (
    <tr className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60">
      <td className="px-4 py-3 text-gray-400 tabular-nums text-sm">{i + 1}</td>
      <td className="px-4 py-3">
        <span className="font-medium text-gray-800 text-sm">
          {row.username ? `@${row.username}` : row.name || '—'}
        </span>
        {row.username && row.name && <div className="text-xs text-gray-400">{row.name}</div>}
      </td>
      <td className="px-3 py-3 text-center">
        <span className="font-semibold tabular-nums text-gray-800 text-sm">{row.entered}</span>
        <span className="text-gray-300 mx-1">/</span>
        <span className="font-semibold tabular-nums text-gray-800 text-sm">{row.registered}</span>
      </td>
      <td className="px-3 py-3 text-center text-gray-600 text-sm hidden sm:table-cell">{pct(row.registered, row.entered)}</td>
      <td className="px-3 py-3 text-center text-xs text-gray-400 hidden md:table-cell">
        {pct(row.entered, totalEntered)} / {pct(row.registered, totalRegistered)}
      </td>
    </tr>
  )
}

const TABLE_HEAD = (
  <thead>
    <tr className="bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
      <th className="text-left px-4 py-2.5 font-medium w-8">№</th>
      <th className="text-left px-4 py-2.5 font-medium">Никнейм / Имя</th>
      <th className="text-center px-3 py-2.5 font-medium">Зашло / Зарег.</th>
      <th className="text-center px-3 py-2.5 font-medium hidden sm:table-cell">Конверсия</th>
      <th className="text-center px-3 py-2.5 font-medium hidden md:table-cell">Доля зашло / зарег.</th>
    </tr>
  </thead>
)

function SummaryCard({ label, entered, registered, totalEntered, totalRegistered, dark }: {
  label: string; entered: number; registered: number
  totalEntered: number; totalRegistered: number; dark?: boolean
}) {
  return (
    <div className={`rounded-xl px-5 py-4 border ${dark ? 'bg-gradient-to-br from-[#25455D] to-[#0a1520] border-[#25455D] text-white' : 'bg-white border-gray-100 shadow-sm'}`}>
      <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${dark ? 'text-[#FFCFA4]' : 'text-gray-400'}`}>{label}</div>
      <div className={`text-2xl font-bold mb-1 ${dark ? 'text-white' : 'text-gray-900'}`}>
        {entered}<span className={`text-base font-normal mx-1 ${dark ? 'text-[#FFCFA4]/60' : 'text-gray-300'}`}>/</span>{registered}
      </div>
      <div className={`text-xs space-y-0.5 ${dark ? 'text-white/70' : 'text-gray-400'}`}>
        <div>Конверсия: <span className="font-medium">{pct(registered, entered)}</span></div>
        {totalEntered > 0 && (
          <div>Доля: <span className="font-medium">{pct(entered, totalEntered)}</span> / <span className="font-medium">{pct(registered, totalRegistered)}</span></div>
        )}
      </div>
    </div>
  )
}

export default function ReportTab({ eventId }: { eventId: number }) {
  const [reports, setReports] = useState<ReportMeta[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<ReportDetail | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [creating, setCreating] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [announcements, setAnnouncements] = useState('')
  const [deletingId, setDeletingId] = useState<number | null>(null)

  async function loadList() {
    setLoadingList(true)
    try {
      const res = await api.conference.reports.list(eventId)
      const list: ReportMeta[] = res.reports || []
      setReports(list)
      if (list.length > 0 && selectedId === null) setSelectedId(list[0].id)
    } finally { setLoadingList(false) }
  }

  async function loadDetail(id: number) {
    setLoadingDetail(true)
    try {
      const res = await api.conference.reports.get(eventId, id)
      setDetail(res.report)
    } finally { setLoadingDetail(false) }
  }

  useEffect(() => { loadList() }, [eventId])
  useEffect(() => { if (selectedId !== null) loadDetail(selectedId) }, [selectedId])

  async function handleCreate() {
    const count = parseInt(announcements)
    if (isNaN(count) || count < 0) { alert('Введите корректное число'); return }
    setCreating(true)
    try {
      const res = await api.conference.reports.create(eventId, { announcements: count })
      const r = res.report
      setReports(prev => [r, ...prev])
      setSelectedId(r.id)
      setShowCreateModal(false)
      setAnnouncements('')
    } catch (e: any) {
      alert(e.message || 'Не удалось создать отчёт')
    } finally { setCreating(false) }
  }

  async function handleDelete(id: number) {
    if (!confirm('Удалить этот отчёт?')) return
    setDeletingId(id)
    try {
      await api.conference.reports.delete(eventId, id)
      const next = reports.filter(r => r.id !== id)
      setReports(next)
      if (selectedId === id) {
        const nextId = next[0]?.id ?? null
        setSelectedId(nextId)
        if (!nextId) setDetail(null)
      }
    } finally { setDeletingId(null) }
  }

  // Разбивка спикеров по группам
  const organizers   = detail?.speakers_data.filter(s => s.role === 'organizer') ?? []
  const regularSpk   = detail?.speakers_data.filter(s => s.role !== 'organizer' && !s.is_commercial) ?? []
  const commercialSpk = detail?.speakers_data.filter(s => s.role !== 'organizer' && s.is_commercial) ?? []
  const baseData     = detail?.base_data ?? []
  const referrals    = detail?.referrals_data ?? []

  const T = detail?.total_entered ?? 0
  const TR = detail?.total_registered ?? 0

  // Группа "Организатор" = организаторы + из базы
  const orgEntered     = organizers.reduce((s, r) => s + r.entered, 0) + baseData.reduce((s, r) => s + r.entered, 0)
  const orgRegistered  = organizers.reduce((s, r) => s + r.registered, 0) + baseData.reduce((s, r) => s + r.registered, 0)

  const spkEntered     = regularSpk.reduce((s, r) => s + r.entered, 0)
  const spkRegistered  = regularSpk.reduce((s, r) => s + r.registered, 0)
  const comEntered     = commercialSpk.reduce((s, r) => s + r.entered, 0)
  const comRegistered  = commercialSpk.reduce((s, r) => s + r.registered, 0)
  const refEntered     = referrals.reduce((s, r) => s + r.entered, 0)
  const refRegistered  = referrals.reduce((s, r) => s + r.registered, 0)

  return (
    <div className="space-y-6">
      {/* Заголовок */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <BarChart2 size={20} className="text-[#25455D]" />
            Отчёты по участникам
          </h2>
          <p className="text-sm text-gray-400 mt-0.5">Трафик от каждого спикера на выбранную дату</p>
        </div>
        <button onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-gradient-to-br from-[#25455D] to-[#0a1520] text-[#FFCFA4] hover:opacity-90 transition-opacity">
          <Plus size={16} /> Создать отчёт
        </button>
      </div>

      {loadingList ? (
        <div className="flex items-center justify-center h-32"><Spinner className="text-brand text-2xl" /></div>
      ) : reports.length === 0 ? (
        <div className="bg-gray-50 rounded-2xl border border-dashed border-gray-200 p-10 text-center">
          <BarChart2 size={36} className="mx-auto text-gray-300 mb-3" />
          <div className="text-gray-500 font-medium">Отчётов пока нет</div>
          <div className="text-sm text-gray-400 mt-1">Нажмите «Создать отчёт», чтобы сделать первый снимок</div>
        </div>
      ) : (
        <>
          {/* Выбор отчёта */}
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-gray-600 whitespace-nowrap">Дата отчёта:</label>
            <div className="relative flex-1 max-w-xs">
              <select value={selectedId ?? ''} onChange={e => setSelectedId(Number(e.target.value))}
                className="w-full appearance-none bg-white border border-gray-200 rounded-xl px-4 py-2 pr-10 text-sm font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#25455D]/30 cursor-pointer">
                {reports.map(r => (
                  <option key={r.id} value={r.id}>
                    {formatDate(r.created_at)} — {r.announcements} анонсов
                  </option>
                ))}
              </select>
              <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>
            {selectedId && (
              <button onClick={() => handleDelete(selectedId)} disabled={deletingId === selectedId}
                className="p-2 rounded-lg text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors" title="Удалить">
                <Trash2 size={16} />
              </button>
            )}
          </div>

          {loadingDetail ? (
            <div className="flex items-center justify-center h-32"><Spinner className="text-brand text-2xl" /></div>
          ) : detail ? (
            <div className="space-y-6">
              {/* Сводка */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <SummaryCard label="Всего" entered={T} registered={TR} totalEntered={T} totalRegistered={TR} dark />
                <SummaryCard label="Спикеры" entered={spkEntered + comEntered} registered={spkRegistered + comRegistered} totalEntered={T} totalRegistered={TR} />
                <SummaryCard label="Организатор" entered={orgEntered} registered={orgRegistered} totalEntered={T} totalRegistered={TR} />
                <SummaryCard label="Рефоводы" entered={refEntered} registered={refRegistered} totalEntered={T} totalRegistered={TR} />
              </div>

              <div className="text-xs text-gray-400 text-right">Зашло в бот / Зарегистрировалось</div>

              {/* СПИКЕРЫ — все вместе по sort_order, коммерческие подсвечены */}
              {(regularSpk.length > 0 || commercialSpk.length > 0) && (() => {
                const allSpk = detail.speakers_data.filter(s => s.role !== 'organizer')
                const allEntered = allSpk.reduce((s, r) => s + r.entered, 0)
                const allReg = allSpk.reduce((s, r) => s + r.registered, 0)
                return (
                  <div>
                    <GroupHeader label="СПИКЕРЫ" entered={allEntered} registered={allReg} totalEntered={T} totalRegistered={TR} color="dark" />
                    <div className="bg-white border border-gray-100 border-t-0 rounded-b-xl overflow-hidden shadow-sm">
                      <table className="w-full">{TABLE_HEAD}<tbody>
                        {allSpk.map((row, i) => (
                          <tr key={row.speaker_event_id}
                            className={`border-b border-gray-50 last:border-0 hover:bg-blue-50/40 ${row.is_commercial ? 'bg-blue-50/30' : ''}`}>
                            <td className="px-4 py-3 text-gray-400 tabular-nums text-sm">{i + 1}</td>
                            <td className="px-4 py-3">
                              <Link href={`/dashboard/conferences/${eventId}/speakers/${row.speaker_id}`}
                                className="font-medium text-[#25455D] hover:underline text-sm">
                                {row.username ? `@${row.username}` : row.name || '—'}
                              </Link>
                              {row.username && row.name && <div className="text-xs text-gray-400">{row.name}</div>}
                              {row.role === 'headliner' && <span className="text-xs text-purple-500 font-medium">хедлайнер</span>}
                              {row.role === 'partner' && <span className="text-xs text-teal-500 font-medium">партнёр</span>}
                            </td>
                            <td className="px-3 py-3 text-center">
                              <span className="font-semibold tabular-nums text-gray-800 text-sm">{row.entered}</span>
                              <span className="text-gray-300 mx-1">/</span>
                              <span className="font-semibold tabular-nums text-gray-800 text-sm">{row.registered}</span>
                            </td>
                            <td className="px-3 py-3 text-center text-gray-600 text-sm hidden sm:table-cell">{pct(row.registered, row.entered)}</td>
                            <td className="px-3 py-3 text-center text-xs text-gray-400 hidden md:table-cell">
                              {pct(row.entered, T)} / {pct(row.registered, TR)}
                            </td>
                          </tr>
                        ))}
                      </tbody></table>
                    </div>
                  </div>
                )
              })()}

              {/* ОРГАНИЗАТОР + ИЗ БАЗЫ */}
              {(organizers.length > 0 || baseData.length > 0) && (() => {
                const baseEntered = baseData.reduce((s, r) => s + r.entered, 0)
                const baseRegistered = baseData.reduce((s, r) => s + r.registered, 0)
                return (
                  <div>
                    <GroupHeader label="ОРГАНИЗАТОР" entered={orgEntered} registered={orgRegistered} totalEntered={T} totalRegistered={TR} color="gray" />
                    <div className="bg-white border border-gray-100 border-t-0 rounded-b-xl overflow-hidden shadow-sm">
                      <table className="w-full">{TABLE_HEAD}<tbody>
                        {organizers.map((row, i) => (
                          <SpeakerRow key={row.speaker_event_id} row={row} i={i} eventId={eventId} totalEntered={T} totalRegistered={TR} />
                        ))}
                        {baseData.length > 0 && (
                          <tr className="border-b border-gray-50 last:border-0 bg-gray-50/50">
                            <td className="px-4 py-3 text-gray-400 tabular-nums text-sm">{organizers.length + 1}</td>
                            <td className="px-4 py-3">
                              <span className="font-medium text-gray-500 text-sm">Из базы (без реф-кода)</span>
                              <div className="text-xs text-gray-400">{baseData.length} чел.</div>
                            </td>
                            <td className="px-3 py-3 text-center">
                              <span className="font-semibold tabular-nums text-gray-800 text-sm">{baseEntered}</span>
                              <span className="text-gray-300 mx-1">/</span>
                              <span className="font-semibold tabular-nums text-gray-800 text-sm">{baseRegistered}</span>
                            </td>
                            <td className="px-3 py-3 text-center text-gray-600 text-sm hidden sm:table-cell">{pct(baseRegistered, baseEntered)}</td>
                            <td className="px-3 py-3 text-center text-xs text-gray-400 hidden md:table-cell">
                              {pct(baseEntered, T)} / {pct(baseRegistered, TR)}
                            </td>
                          </tr>
                        )}
                      </tbody></table>
                    </div>
                  </div>
                )
              })()}

              {/* РЕФЕРАЛЫ */}
              {referrals.length > 0 && (
                <div>
                  <GroupHeader label="РЕФЕРАЛЫ" entered={refEntered} registered={refRegistered} totalEntered={T} totalRegistered={TR} color="amber" />
                  <div className="bg-white border border-gray-100 border-t-0 rounded-b-xl overflow-hidden shadow-sm">
                    <table className="w-full">{TABLE_HEAD}<tbody>
                      {referrals.map((row, i) => (
                        <PersonRowEl key={row.participant_id} row={row} i={i} totalEntered={T} totalRegistered={TR} />
                      ))}
                    </tbody></table>
                  </div>
                </div>
              )}

            </div>
          ) : null}
        </>
      )}

      {/* Модалка */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowCreateModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <h3 className="font-bold text-gray-900 mb-1">Создать отчёт</h3>
            <p className="text-sm text-gray-500 mb-5">Система подсчитает трафик от каждого спикера прямо сейчас. Укажите, сколько анонсов уже сделано.</p>
            <label className="block text-sm font-medium text-gray-700 mb-2">Кол-во сделанных анонсов</label>
            <input type="number" min="0" value={announcements} onChange={e => setAnnouncements(e.target.value)}
              placeholder="Например: 3" className="input w-full mb-5" autoFocus
              onKeyDown={e => e.key === 'Enter' && handleCreate()} />
            <div className="flex gap-3">
              <button onClick={() => setShowCreateModal(false)}
                className="flex-1 px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50">
                Отмена
              </button>
              <button onClick={handleCreate} disabled={creating}
                className="flex-1 px-4 py-2 rounded-xl text-sm font-medium bg-gradient-to-br from-[#25455D] to-[#0a1520] text-[#FFCFA4] hover:opacity-90 disabled:opacity-50">
                {creating ? 'Создаю...' : 'Создать'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
