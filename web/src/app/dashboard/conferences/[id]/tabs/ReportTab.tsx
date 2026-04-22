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
  is_commercial: boolean
  ref_code: string
  entered: number
  registered: number
}

interface ReferralRow {
  participant_id: number
  name: string
  username: string
  tg_id: string
  entered: number
  registered: number
}

interface ReportDetail extends ReportMeta {
  speakers_data: SpeakerRow[]
  referrals_data: ReferralRow[]
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

function SummaryBlock({
  label, entered, registered, totalEntered, totalRegistered, highlight
}: {
  label: string
  entered: number
  registered: number
  totalEntered: number
  totalRegistered: number
  highlight?: boolean
}) {
  return (
    <div className={`rounded-xl px-5 py-4 border ${highlight ? 'bg-[#25455D] border-[#25455D] text-white' : 'bg-white border-gray-100 shadow-sm'}`}>
      <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${highlight ? 'text-[#FFCFA4]' : 'text-gray-400'}`}>{label}</div>
      <div className={`text-2xl font-bold mb-1 ${highlight ? 'text-white' : 'text-gray-900'}`}>
        {entered}<span className={`text-base font-normal mx-1 ${highlight ? 'text-[#FFCFA4]/70' : 'text-gray-300'}`}>/</span>{registered}
      </div>
      <div className={`text-xs space-y-0.5 ${highlight ? 'text-white/70' : 'text-gray-400'}`}>
        <div>Конверсия: <span className="font-medium">{pct(registered, entered)}</span></div>
        {totalEntered > 0 && (
          <div>
            Доля: <span className="font-medium">{pct(entered, totalEntered)}</span>
            {' / '}
            <span className="font-medium">{pct(registered, totalRegistered)}</span>
          </div>
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
      if (list.length > 0 && selectedId === null) {
        setSelectedId(list[0].id)
      }
    } finally {
      setLoadingList(false)
    }
  }

  async function loadDetail(id: number) {
    setLoadingDetail(true)
    try {
      const res = await api.conference.reports.get(eventId, id)
      setDetail(res.report)
    } finally {
      setLoadingDetail(false)
    }
  }

  useEffect(() => { loadList() }, [eventId])
  useEffect(() => {
    if (selectedId !== null) loadDetail(selectedId)
  }, [selectedId])

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
    } finally {
      setCreating(false)
    }
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
    } finally {
      setDeletingId(null)
    }
  }

  // Разделяем спикеров: обычные (sort_order) → коммерческие в конце
  const regularSpeakers = detail?.speakers_data.filter(s => !s.is_commercial) ?? []
  const commercialSpeakers = detail?.speakers_data.filter(s => s.is_commercial) ?? []

  const totalEntered = detail?.total_entered ?? 0
  const totalRegistered = detail?.total_registered ?? 0

  function SpeakerTable({ rows, label, commercial }: { rows: SpeakerRow[], label: string, commercial?: boolean }) {
    if (rows.length === 0) return null
    const groupEntered = rows.reduce((s, r) => s + r.entered, 0)
    const groupRegistered = rows.reduce((s, r) => s + r.registered, 0)

    return (
      <div>
        {/* Заголовок группы */}
        <div className={`flex items-center justify-between px-4 py-2.5 rounded-t-xl font-semibold text-sm ${
          commercial
            ? 'bg-blue-100 text-blue-800'
            : 'bg-gradient-to-r from-[#25455D] to-[#1a3348] text-[#FFCFA4]'
        }`}>
          <span>{label}</span>
          <span className="font-bold tabular-nums">
            {groupEntered} / {groupRegistered}
            <span className="ml-3 font-normal opacity-80">{pct(groupRegistered, groupEntered)}</span>
            <span className="ml-2 text-xs opacity-60">
              {pct(groupEntered, totalEntered)} / {pct(groupRegistered, totalRegistered)}
            </span>
          </span>
        </div>
        <div className="bg-white border border-gray-100 border-t-0 rounded-b-xl overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
                <th className="text-left px-4 py-2.5 font-medium w-8">№</th>
                <th className="text-left px-4 py-2.5 font-medium">Никнейм / Имя</th>
                <th className="text-center px-3 py-2.5 font-medium">Зашло / Зарег.</th>
                <th className="text-center px-3 py-2.5 font-medium hidden sm:table-cell">Конверсия</th>
                <th className="text-center px-3 py-2.5 font-medium hidden md:table-cell">Доля зашло / зарег.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.speaker_event_id} className={`border-b border-gray-50 last:border-0 hover:bg-gray-50/60 ${commercial ? 'bg-blue-50/30' : ''}`}>
                  <td className="px-4 py-3 text-gray-400 tabular-nums">{i + 1}</td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/conferences/${eventId}/speakers/${row.speaker_id}`}
                      className="font-medium text-[#25455D] hover:underline"
                    >
                      {row.username ? `@${row.username}` : row.name || '—'}
                    </Link>
                    {row.username && row.name && (
                      <div className="text-xs text-gray-400">{row.name}</div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-center">
                    <span className="font-semibold tabular-nums text-gray-800">
                      {row.entered}
                    </span>
                    <span className="text-gray-300 mx-1">/</span>
                    <span className="font-semibold tabular-nums text-gray-800">
                      {row.registered}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-center hidden sm:table-cell">
                    <span className="text-gray-600">{pct(row.registered, row.entered)}</span>
                  </td>
                  <td className="px-3 py-3 text-center hidden md:table-cell text-xs text-gray-500">
                    {pct(row.entered, totalEntered)} / {pct(row.registered, totalRegistered)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

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
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-gradient-to-br from-[#25455D] to-[#0a1520] text-[#FFCFA4] hover:opacity-90 transition-opacity"
        >
          <Plus size={16} />
          Создать отчёт
        </button>
      </div>

      {loadingList ? (
        <div className="flex items-center justify-center h-32"><Spinner className="text-brand text-2xl" /></div>
      ) : reports.length === 0 ? (
        <div className="bg-gray-50 rounded-2xl border border-dashed border-gray-200 p-10 text-center">
          <BarChart2 size={36} className="mx-auto text-gray-300 mb-3" />
          <div className="text-gray-500 font-medium">Отчётов пока нет</div>
          <div className="text-sm text-gray-400 mt-1">Нажмите «Создать отчёт», чтобы сделать первый снимок статистики</div>
        </div>
      ) : (
        <>
          {/* Выбор отчёта */}
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-gray-600 whitespace-nowrap">Дата отчёта:</label>
            <div className="relative flex-1 max-w-xs">
              <select
                value={selectedId ?? ''}
                onChange={e => setSelectedId(Number(e.target.value))}
                className="w-full appearance-none bg-white border border-gray-200 rounded-xl px-4 py-2 pr-10 text-sm font-medium text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#25455D]/30 cursor-pointer"
              >
                {reports.map(r => (
                  <option key={r.id} value={r.id}>
                    {formatDate(r.created_at)} — {r.announcements} анонсов
                  </option>
                ))}
              </select>
              <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>
            {selectedId && (
              <button
                onClick={() => handleDelete(selectedId)}
                disabled={deletingId === selectedId}
                className="p-2 rounded-lg text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                title="Удалить этот отчёт"
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>

          {loadingDetail ? (
            <div className="flex items-center justify-center h-32"><Spinner className="text-brand text-2xl" /></div>
          ) : detail ? (
            <div className="space-y-6">

              {/* Сводка — три блока */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <SummaryBlock
                  label="Всего"
                  entered={detail.total_entered}
                  registered={detail.total_registered}
                  totalEntered={detail.total_entered}
                  totalRegistered={detail.total_registered}
                  highlight
                />
                <SummaryBlock
                  label="От спикеров"
                  entered={detail.speakers_entered}
                  registered={detail.speakers_registered}
                  totalEntered={detail.total_entered}
                  totalRegistered={detail.total_registered}
                />
                <SummaryBlock
                  label="Рефералы"
                  entered={detail.referrals_entered}
                  registered={detail.referrals_registered}
                  totalEntered={detail.total_entered}
                  totalRegistered={detail.total_registered}
                />
              </div>

              {/* Шапка таблицы — пояснение колонок */}
              <div className="text-xs text-gray-400 text-right pr-1">
                Зашло в бот / Зарегистрировалось
              </div>

              {/* Обычные спикеры */}
              <SpeakerTable rows={regularSpeakers} label="СПИКЕРЫ" />

              {/* Коммерческие спикеры */}
              <SpeakerTable rows={commercialSpeakers} label="КОММЕРЧЕСКИЕ СПИКЕРЫ" commercial />

              {/* Рефералы */}
              {detail.referrals_data.length > 0 && (
                <div>
                  <div className="flex items-center justify-between px-4 py-2.5 rounded-t-xl font-semibold text-sm bg-amber-50 text-amber-800 border border-amber-100">
                    <span>РЕФЕРАЛЫ</span>
                    <span className="font-bold tabular-nums">
                      {detail.referrals_entered} / {detail.referrals_registered}
                      <span className="ml-3 font-normal opacity-80">{pct(detail.referrals_registered, detail.referrals_entered)}</span>
                      <span className="ml-2 text-xs opacity-60">
                        {pct(detail.referrals_entered, detail.total_entered)} / {pct(detail.referrals_registered, detail.total_registered)}
                      </span>
                    </span>
                  </div>
                  <div className="bg-white border border-gray-100 border-t-0 rounded-b-xl overflow-hidden shadow-sm">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
                          <th className="text-left px-4 py-2.5 font-medium w-8">№</th>
                          <th className="text-left px-4 py-2.5 font-medium">Никнейм / Имя</th>
                          <th className="text-center px-3 py-2.5 font-medium">Зашло / Зарег.</th>
                          <th className="text-center px-3 py-2.5 font-medium hidden sm:table-cell">Конверсия</th>
                          <th className="text-center px-3 py-2.5 font-medium hidden md:table-cell">Доля зашло / зарег.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.referrals_data.map((row, i) => (
                          <tr key={row.participant_id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60">
                            <td className="px-4 py-3 text-gray-400 tabular-nums">{i + 1}</td>
                            <td className="px-4 py-3">
                              <span className="font-medium text-gray-800">
                                {row.username ? `@${row.username}` : row.name || '—'}
                              </span>
                              {row.username && row.name && (
                                <div className="text-xs text-gray-400">{row.name}</div>
                              )}
                            </td>
                            <td className="px-3 py-3 text-center">
                              <span className="font-semibold tabular-nums text-gray-800">{row.entered}</span>
                              <span className="text-gray-300 mx-1">/</span>
                              <span className="font-semibold tabular-nums text-gray-800">{row.registered}</span>
                            </td>
                            <td className="px-3 py-3 text-center hidden sm:table-cell">
                              <span className="text-gray-600">{pct(row.registered, row.entered)}</span>
                            </td>
                            <td className="px-3 py-3 text-center hidden md:table-cell text-xs text-gray-500">
                              {pct(row.entered, totalEntered)} / {pct(row.registered, totalRegistered)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </>
      )}

      {/* Модалка создания */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowCreateModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <h3 className="font-bold text-gray-900 mb-1">Создать отчёт</h3>
            <p className="text-sm text-gray-500 mb-5">
              Система подсчитает трафик от каждого спикера прямо сейчас. Укажите, сколько анонсов уже сделано.
            </p>
            <label className="block text-sm font-medium text-gray-700 mb-2">Кол-во сделанных анонсов</label>
            <input
              type="number"
              min="0"
              value={announcements}
              onChange={e => setAnnouncements(e.target.value)}
              placeholder="Например: 3"
              className="input w-full mb-5"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
            />
            <div className="flex gap-3">
              <button
                onClick={() => setShowCreateModal(false)}
                className="flex-1 px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                Отмена
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex-1 px-4 py-2 rounded-xl text-sm font-medium bg-gradient-to-br from-[#25455D] to-[#0a1520] text-[#FFCFA4] hover:opacity-90 disabled:opacity-50"
              >
                {creating ? 'Создаю...' : 'Создать'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
