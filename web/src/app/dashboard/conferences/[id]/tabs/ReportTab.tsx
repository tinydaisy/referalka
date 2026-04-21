'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Plus, Trash2, ChevronDown, Users, Mic, UserCheck, BarChart2 } from 'lucide-react'
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
  tg_id: string
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

function pct(num: number, den: number) {
  if (!den) return '—'
  return `${Math.round((num / den) * 100)}%`
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-4">
      <div className="text-xs text-gray-400 font-medium mb-1 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
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
    if (isNaN(count) || count < 0) {
      alert('Введите корректное число анонсов')
      return
    }
    setCreating(true)
    try {
      const res = await api.conference.reports.create(eventId, { announcements: count })
      const newReport = res.report
      setReports(prev => [newReport, ...prev])
      setSelectedId(newReport.id)
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

  const selected = reports.find(r => r.id === selectedId)

  return (
    <div className="space-y-6">
      {/* Заголовок и кнопки */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <BarChart2 size={20} className="text-[#25455D]" />
            Отчёты по участникам
          </h2>
          <p className="text-sm text-gray-400 mt-0.5">Снимок статистики на выбранную дату</p>
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
        <div className="flex items-center justify-center h-32">
          <Spinner className="text-brand text-2xl" />
        </div>
      ) : reports.length === 0 ? (
        <div className="bg-gray-50 rounded-2xl border border-dashed border-gray-200 p-10 text-center">
          <BarChart2 size={36} className="mx-auto text-gray-300 mb-3" />
          <div className="text-gray-500 font-medium">Отчётов пока нет</div>
          <div className="text-sm text-gray-400 mt-1">Нажмите «Создать отчёт», чтобы сделать первый снимок статистики</div>
        </div>
      ) : (
        <>
          {/* Выпадающий список отчётов */}
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-gray-600 whitespace-nowrap">Отчёт от:</label>
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

          {/* Содержимое выбранного отчёта */}
          {loadingDetail ? (
            <div className="flex items-center justify-center h-32">
              <Spinner className="text-brand text-2xl" />
            </div>
          ) : detail ? (
            <div className="space-y-6">
              {/* Сводка */}
              <div>
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Сводка</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <StatCard label="Анонсов" value={detail.announcements} />
                  <StatCard label="Всего зашло" value={detail.total_entered} />
                  <StatCard
                    label="Всего зарег."
                    value={detail.total_registered}
                    sub={`Конверсия ${pct(detail.total_registered, detail.total_entered)}`}
                  />
                  <StatCard label="От спикеров" value={`${detail.speakers_entered} / ${detail.speakers_registered}`}
                    sub={`Конверсия ${pct(detail.speakers_registered, detail.speakers_entered)}`}
                  />
                  <StatCard label="От рефералов" value={`${detail.referrals_entered} / ${detail.referrals_registered}`}
                    sub={`Конверсия ${pct(detail.referrals_registered, detail.referrals_entered)}`}
                  />
                  <StatCard
                    label="Итого конверсия"
                    value={pct(detail.total_registered, detail.total_entered)}
                  />
                </div>
              </div>

              {/* Таблица спикеров */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Mic size={16} className="text-[#25455D]" />
                  <span className="text-sm font-semibold text-gray-700">
                    Спикеры — {detail.speakers_entered} зашло / {detail.speakers_registered} зарег.
                  </span>
                </div>
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-100">
                        <th className="text-left px-4 py-3 font-medium text-gray-500">№</th>
                        <th className="text-left px-4 py-3 font-medium text-gray-500">Имя</th>
                        <th className="text-left px-4 py-3 font-medium text-gray-500 hidden sm:table-cell">tg_id</th>
                        <th className="text-center px-4 py-3 font-medium text-gray-500">Зашло</th>
                        <th className="text-center px-4 py-3 font-medium text-gray-500">Зарег.</th>
                        <th className="text-center px-4 py-3 font-medium text-gray-500 hidden sm:table-cell">Конверсия</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.speakers_data.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="text-center text-gray-400 py-6 text-sm">Нет данных по спикерам</td>
                        </tr>
                      ) : (
                        detail.speakers_data.map((row, i) => (
                          <tr key={row.speaker_event_id} className="border-b border-gray-50 hover:bg-gray-50/50">
                            <td className="px-4 py-3 text-gray-400">{i + 1}</td>
                            <td className="px-4 py-3 font-medium">
                              <Link
                                href={`/dashboard/conferences/${eventId}/speakers/${row.speaker_id}`}
                                className="text-[#25455D] hover:underline"
                              >
                                {row.name || '—'}
                              </Link>
                            </td>
                            <td className="px-4 py-3 text-gray-400 font-mono text-xs hidden sm:table-cell">
                              {row.tg_id || '—'}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${row.entered ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-400'}`}>
                                {row.entered ? '✓' : '—'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${row.registered ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
                                {row.registered ? '✓' : '—'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center text-gray-500 text-xs hidden sm:table-cell">
                              {pct(row.registered, row.entered)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Таблица рефералов */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Users size={16} className="text-[#25455D]" />
                  <span className="text-sm font-semibold text-gray-700">
                    Рефералы (не спикеры) — {detail.referrals_entered} зашло / {detail.referrals_registered} зарег.
                  </span>
                </div>
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-100">
                        <th className="text-left px-4 py-3 font-medium text-gray-500">№</th>
                        <th className="text-left px-4 py-3 font-medium text-gray-500">Имя</th>
                        <th className="text-left px-4 py-3 font-medium text-gray-500 hidden sm:table-cell">@username</th>
                        <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">tg_id</th>
                        <th className="text-center px-4 py-3 font-medium text-gray-500">Зарег.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.referrals_data.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="text-center text-gray-400 py-6 text-sm">Нет рефералов</td>
                        </tr>
                      ) : (
                        detail.referrals_data.map((row, i) => (
                          <tr key={row.participant_id} className="border-b border-gray-50 hover:bg-gray-50/50">
                            <td className="px-4 py-3 text-gray-400">{i + 1}</td>
                            <td className="px-4 py-3 font-medium text-gray-800">{row.name || '—'}</td>
                            <td className="px-4 py-3 text-gray-400 hidden sm:table-cell">
                              {row.username ? `@${row.username}` : '—'}
                            </td>
                            <td className="px-4 py-3 text-gray-400 font-mono text-xs hidden md:table-cell">
                              {row.tg_id || '—'}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${row.registered ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
                                {row.registered ? '✓' : '—'}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}

      {/* Модалка: создать отчёт */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowCreateModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <h3 className="font-bold text-gray-900 mb-1">Создать отчёт</h3>
            <p className="text-sm text-gray-500 mb-5">
              Система подсчитает участников в базе прямо сейчас. Укажите, сколько анонсов уже сделано — это для статистики.
            </p>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Кол-во сделанных анонсов
            </label>
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
