'use client'
import { useState, useEffect, useCallback } from 'react'
import {
  Send, XCircle, Eye, Clock, CheckCircle, AlertCircle, Loader2, X,
  Edit2, Trash2, Copy, Users, ChevronDown, ChevronRight, FileText, Upload
} from 'lucide-react'
import { api } from '@/lib/api'

const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-gray-50 border-gray-100',
  pending: 'bg-amber-50 border-amber-200',
  running: 'bg-blue-50 border-blue-200',
  done: 'bg-green-50 border-green-200',
  cancelled: 'bg-gray-50 border-gray-200',
}
const STATUS_ICON: Record<string, React.ReactNode> = {
  draft: <Edit2 size={13} className="text-gray-400" />,
  pending: <Clock size={13} className="text-amber-500" />,
  running: <Loader2 size={13} className="text-blue-500 animate-spin" />,
  done: <CheckCircle size={13} className="text-green-500" />,
  cancelled: <XCircle size={13} className="text-gray-400" />,
}
const STATUS_LABEL: Record<string, string> = {
  draft: 'Черновик', pending: 'Ожидает', running: 'Отправляется',
  done: 'Отправлено', cancelled: 'Отменена',
}

function formatTimeLeft(sec: number): string {
  if (sec > 3600) return `${Math.floor(sec / 3600)}ч ${Math.floor((sec % 3600) / 60)}мин`
  if (sec > 60) return `${Math.floor(sec / 60)} мин`
  return `${sec} сек`
}
function formatDuration(sec: number): string {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}ч ${Math.floor((sec % 3600) / 60)}мин`
  if (sec >= 60) return `${Math.floor(sec / 60)}мин ${sec % 60}сек`
  return `${sec}сек`
}
function humanReason(err: string): string {
  const low = (err || '').toLowerCase()
  if (low.includes('blocked')) return 'Бот заблокирован пользователем'
  if (low.includes('user is deactivated')) return 'Аккаунт удалён'
  if (low.includes('chat not found')) return 'Чат не найден (бот не запущен)'
  if (low.includes("can't initiate conversation") || low.includes('cant initiate conversation')) return 'Бот не запущен пользователем'
  if (low.includes('forbidden')) return 'Бот не запущен пользователем'
  if (low.includes('have no rights') || low.includes('not enough rights')) return 'Нет прав отправлять сообщения'
  if (low.includes('too many requests') || low.includes('flood')) return 'Telegram ограничил скорость (попробуем чуть позже)'
  if (low.includes('timeout') || low.includes('timed out')) return 'Таймаут ответа Telegram'
  if (low.includes('wrong file identifier') || low.includes('failed to get http url content')) return 'Битая ссылка на фото'
  if (low.includes('message is too long')) return 'Сообщение слишком длинное'
  if (!err) return 'Неизвестная ошибка'
  return err.slice(0, 100)
}

export default function GeneralBroadcastsPage() {
  const [schedules, setSchedules] = useState<any[]>([])
  const [tzLabel, setTzLabel] = useState('МСК (UTC+3)')
  const [msg, setMsg] = useState<{ text: string; type: 'ok' | 'err' } | null>(null)
  const [previewModal, setPreviewModal] = useState<any>(null)
  const [logModal, setLogModal] = useState<{ schedule: any; rows: any[] } | null>(null)
  const [customModal, setCustomModal] = useState(false)
  const [bulkModal, setBulkModal] = useState(false)
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set())
  const [editFireAt, setEditFireAt] = useState<{ id: number; fire_at: string; is_test: boolean } | null>(null)

  function showMsg(text: string, type: 'ok' | 'err' = 'ok') {
    setMsg({ text, type })
    setTimeout(() => setMsg(null), 5000)
  }

  const load = useCallback(async () => {
    try {
      const res = await api.broadcasts.list()
      setSchedules(res.schedules || [])
      const tz = res.timezone || 'Europe/Moscow'
      setTzLabel(tz === 'Europe/Moscow' ? 'МСК (UTC+3)' : tz)
    } catch (e: any) {
      showMsg(e.message || 'Не удалось загрузить', 'err')
    }
  }, [])

  useEffect(() => { load() }, [load])

  // localStorage для свёрнутых дней
  useEffect(() => {
    try {
      const saved = localStorage.getItem('broadcasts-collapsed')
      if (saved) setCollapsedDays(new Set(JSON.parse(saved)))
    } catch {}
  }, [])
  useEffect(() => {
    try { localStorage.setItem('broadcasts-collapsed', JSON.stringify([...collapsedDays])) } catch {}
  }, [collapsedDays])

  function toggleDay(date: string) {
    setCollapsedDays(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date); else next.add(date)
      return next
    })
  }

  async function openPreview(s: any) {
    try {
      const r = await api.broadcasts.preview(s.id)
      setPreviewModal({ ...r, schedule: s })
    } catch (e: any) { showMsg('Не удалось загрузить превью', 'err') }
  }
  async function openLog(s: any) {
    try {
      const r = await api.broadcasts.log(s.id)
      setLogModal({ schedule: s, rows: r.log || [] })
    } catch (e: any) { showMsg('Не удалось загрузить лог', 'err') }
  }
  async function deleteOne(s: any) {
    const lbl = `«${(s.snapshot_text || '').slice(0, 40)}…»`
    const ok = s.status === 'pending' || s.status === 'running'
      ? confirm(`Задача ${lbl} ${STATUS_LABEL[s.status].toLowerCase()}. Отменить и удалить?`)
      : confirm(`Удалить задачу ${lbl}? Действие нельзя отменить.`)
    if (!ok) return
    try {
      if (s.status === 'pending' || s.status === 'running') {
        try { await api.broadcasts.cancel(s.id) } catch {}
      }
      await api.broadcasts.delete(s.id)
      setSchedules(prev => prev.filter(x => x.id !== s.id))
      showMsg('Задача удалена')
    } catch (e: any) { showMsg(e.message, 'err') }
  }
  async function cancelOne(s: any) {
    if (s.status === 'running' && !confirm('Рассылка сейчас идёт. Уже отправленные сообщения не отзовутся, но дальнейшая отправка остановится. Отменить?')) return
    try {
      await api.broadcasts.cancel(s.id)
      setSchedules(prev => prev.map(x => x.id === s.id ? { ...x, status: 'cancelled' } : x))
      showMsg('Рассылка отменена')
    } catch (e: any) { showMsg(e.message, 'err') }
  }
  async function copyOne(s: any) {
    try {
      await api.broadcasts.copy(s.id)
      await load()
      showMsg('Создана копия')
    } catch (e: any) { showMsg(e.message, 'err') }
  }
  async function saveFireAt() {
    if (!editFireAt || !editFireAt.fire_at) return
    if (new Date(editFireAt.fire_at) <= new Date()) {
      showMsg('Время уже прошло — выберите будущее время', 'err'); return
    }
    try {
      await api.broadcasts.setFireAt(editFireAt.id, {
        fire_at: editFireAt.fire_at,
        is_test: editFireAt.is_test,
      })
      setEditFireAt(null)
      await load()
      showMsg('Сохранено')
    } catch (e: any) { showMsg(e.message, 'err') }
  }

  const pendingCount = schedules.filter(s => s.status === 'pending' || s.status === 'draft').length
  const doneCount = schedules.filter(s => s.status === 'done').length

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Рассылки</h1>
          <p className="text-sm text-gray-500 mt-1">Произвольные сообщения по всей вашей базе контактов — независимо от конференций.</p>
        </div>
      </div>

      {/* Статусная плашка */}
      <div className="mb-4 rounded-2xl border border-gray-100 bg-white p-4">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-amber-500" />
            <span className="text-gray-500">В очереди:</span>
            <span className="font-semibold text-gray-800">{pendingCount}</span>
          </div>
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-green-500" />
            <span className="text-gray-500">Отправлено:</span>
            <span className="font-semibold text-gray-800">{doneCount}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span>Часовой пояс: <b className="text-gray-600">{tzLabel}</b></span>
          </div>
        </div>
      </div>

      {msg && (
        <div className={`mb-4 text-sm rounded-xl px-4 py-3 flex items-center gap-2 ${
          msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
        }`}>
          {msg.type === 'ok' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {msg.text}
        </div>
      )}

      {/* Панель действий */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button onClick={() => setCustomModal(true)}
          className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50">
          <FileText size={14} /> Произвольное
        </button>
        <button onClick={() => setBulkModal(true)}
          className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50">
          <Upload size={14} /> Пакетом
        </button>
      </div>

      {/* Список */}
      {schedules.length === 0 ? (
        <div className="py-16 text-center text-gray-400 bg-white rounded-2xl border border-gray-100">
          <Send size={32} className="mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">Очередь пуста</p>
          <p className="text-xs mt-1">Нажмите «Произвольное» или «Пакетом» чтобы создать рассылку.</p>
        </div>
      ) : (
        <div className="space-y-2 mb-6">
          {schedules.map((s, idx) => {
            const prevDate = idx > 0 && schedules[idx - 1].fire_at_local
              ? schedules[idx - 1].fire_at_local.split(' ')[0] : null
            const curDate = s.fire_at_local ? s.fire_at_local.split(' ')[0] : '__no_date__'
            const showDayDivider = curDate && curDate !== prevDate
            const RU_M: Record<string,string> = {'01':'янв','02':'фев','03':'мар','04':'апр','05':'май','06':'июн','07':'июл','08':'авг','09':'сен','10':'окт','11':'ноя','12':'дек'}
            let dividerLabel = curDate === '__no_date__' ? 'Без даты' : (curDate || '')
            if (curDate && curDate !== '__no_date__') {
              const parts = curDate.split('-')
              if (parts.length === 3) dividerLabel = `${parseInt(parts[2])} ${RU_M[parts[1]] || parts[1]}`
            }
            const isCollapsed = collapsedDays.has(curDate)
            const dayCount = schedules.filter(x => (x.fire_at_local ? x.fire_at_local.split(' ')[0] : '__no_date__') === curDate).length
            const preview = (s.snapshot_text || '').replace(/\s+/g, ' ').slice(0, 80)

            return (
              <div key={s.id}>
                {showDayDivider && (
                  <button onClick={() => toggleDay(curDate)}
                    className="w-full flex items-center gap-3 py-2 mt-2 text-left group">
                    <div className="flex-1 h-px bg-gray-200" />
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide group-hover:text-gray-700">
                      {isCollapsed ? <ChevronRight size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
                      {dividerLabel}
                      <span className="text-gray-400 font-normal normal-case">({dayCount})</span>
                    </span>
                    <div className="flex-1 h-px bg-gray-200" />
                  </button>
                )}
                {!isCollapsed && (
                  <div className={`rounded-xl border p-3.5 ${STATUS_COLOR[s.status] || 'bg-white border-gray-100'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="text-xs text-gray-400 font-mono">#{idx + 1}</span>
                          <span className="flex items-center gap-1 text-xs font-medium text-gray-700">
                            {STATUS_ICON[s.status]} {STATUS_LABEL[s.status] || s.status}
                          </span>
                          <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-white/80 border border-gray-200 text-gray-600">
                            Произвольное
                          </span>
                          {s.is_test && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium border border-purple-200">ТЕСТ</span>
                          )}
                          <span className="text-xs text-gray-400">Вся база</span>
                          {s.buttons_count > 0 && (
                            <span className="text-xs text-gray-400">· кнопок: {s.buttons_count}</span>
                          )}
                        </div>
                        {preview && (
                          <p className="text-sm text-gray-700 mb-1 truncate">{preview}{(s.snapshot_text || '').length > 80 ? '…' : ''}</p>
                        )}
                        <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                          {s.fire_at_local ? (
                            <span className="font-medium text-gray-700">{s.fire_at_local} {tzLabel}</span>
                          ) : (
                            <span className="text-amber-600 font-medium">⚠ Время не задано</span>
                          )}
                          {s.seconds_until != null && s.status === 'pending' && (
                            <span className="text-amber-600">через {formatTimeLeft(s.seconds_until)}</span>
                          )}
                          {s.status === 'running' && s.seconds_running != null && (
                            <span className={s.seconds_running > 600 ? 'text-red-500 font-medium' : 'text-blue-500'}>
                              отправляется {formatTimeLeft(s.seconds_running)}
                            </span>
                          )}
                          {s.error_log && (
                            <span className="text-red-500 truncate max-w-[200px]" title={s.error_log}>⚠ {s.error_log}</span>
                          )}
                        </div>
                      </div>

                      {s.status === 'done' && s.recipients_sent != null && (
                        <div className="shrink-0 text-right min-w-[64px]">
                          <div className="flex items-center justify-end gap-1.5">
                            <div className="text-center">
                              <span className="text-sm font-semibold text-green-700">{s.recipients_sent}</span>
                              <div className="text-xs text-gray-400 leading-tight">дошло</div>
                            </div>
                            {s.recipients_failed > 0 && (
                              <div className="relative group flex items-center gap-1 cursor-help">
                                <span className="text-red-500 font-bold text-sm leading-none">✕</span>
                                <span className="text-sm font-semibold text-red-500">{s.recipients_failed}</span>
                                <div className="absolute bottom-full right-0 mb-1.5 w-64 bg-gray-900 text-white text-xs rounded-lg px-3 py-2 hidden group-hover:block z-50 shadow-xl pointer-events-none leading-snug">
                                  Не доставлено {s.recipients_failed}. Нажмите «список» — увидите разбивку по причинам.
                                </div>
                              </div>
                            )}
                          </div>
                          {s.duration_seconds != null && (
                            <div className="text-xs text-gray-400 mt-0.5 text-right">{formatDuration(s.duration_seconds)}</div>
                          )}
                          <button onClick={() => openLog(s)}
                            className="flex items-center gap-0.5 text-xs text-indigo-500 hover:text-indigo-700 mt-0.5 ml-auto">
                            <Users size={10} /> список
                          </button>
                        </div>
                      )}

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button onClick={() => copyOne(s)}
                          className="p-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50"
                          title="Копировать">
                          <Copy size={13} />
                        </button>
                        <button onClick={() => openPreview(s)}
                          className="p-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-white"
                          title="Превью">
                          <Eye size={13} />
                        </button>
                        {(s.status === 'draft' || s.status === 'pending') && (
                          <button onClick={() => {
                            const d = s.fire_at_iso ? new Date(s.fire_at_iso) : new Date()
                            const pad = (n: number) => String(n).padStart(2, '0')
                            const local = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
                            setEditFireAt({ id: s.id, fire_at: local, is_test: !!s.is_test })
                          }}
                            className="p-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-white"
                            title="Изменить время">
                            <Edit2 size={13} />
                          </button>
                        )}
                        {(s.status === 'draft' || s.status === 'pending' || s.status === 'running') && (
                          <button onClick={() => cancelOne(s)}
                            className="p-1.5 border border-red-200 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50"
                            title="Отменить">
                            <XCircle size={13} />
                          </button>
                        )}
                        <button onClick={() => deleteOne(s)}
                          className="p-1.5 border border-red-200 rounded-lg text-red-400 hover:text-white hover:bg-red-500"
                          title="Удалить">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Модалки */}
      {customModal && (
        <CustomBroadcastModal
          tzLabel={tzLabel}
          onClose={() => setCustomModal(false)}
          onSaved={async () => { setCustomModal(false); await load(); showMsg('Рассылка добавлена в очередь') }}
          onError={(m) => showMsg(m, 'err')}
        />
      )}
      {bulkModal && (
        <BulkBroadcastModal
          tzLabel={tzLabel}
          onClose={() => setBulkModal(false)}
          onSaved={async (n) => { setBulkModal(false); await load(); showMsg(`Добавлено ${n} рассылок`) }}
          onError={(m) => showMsg(m, 'err')}
        />
      )}

      {/* Edit fire_at */}
      {editFireAt && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">Редактирование</h3>
              <button onClick={() => setEditFireAt(null)}><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Дата и время ({tzLabel})</label>
                <input type="datetime-local" value={editFireAt.fire_at}
                  onChange={e => setEditFireAt({ ...editFireAt, fire_at: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={editFireAt.is_test}
                  onChange={e => setEditFireAt({ ...editFireAt, is_test: e.target.checked })}
                  className="rounded" />
                <span className="text-sm text-gray-600">Тестовая рассылка</span>
              </label>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={saveFireAt}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                Сохранить
              </button>
              <button onClick={() => setEditFireAt(null)}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Лог */}
      {logModal && (() => {
        const sentCount = logModal.rows.filter((r: any) => r.status === 'sent').length
        const failed = logModal.rows.filter((r: any) => r.status !== 'sent')
        const reasonMap: Record<string, number> = {}
        for (const r of failed) {
          const reason = humanReason(r.error || 'Неизвестная ошибка')
          reasonMap[reason] = (reasonMap[reason] || 0) + 1
        }
        const reasons = Object.entries(reasonMap).sort((a, b) => b[1] - a[1])
        return (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 max-h-[85vh] flex flex-col">
              <div className="flex justify-between items-center mb-3">
                <div>
                  <h3 className="font-semibold text-gray-800 text-sm">Получатели рассылки</h3>
                  <p className="text-xs text-gray-400">
                    Всего: {logModal.rows.length} · <span className="text-green-600">доставлено {sentCount}</span>
                    {failed.length > 0 && <> · <span className="text-red-500">не дошло {failed.length}</span></>}
                  </p>
                </div>
                <button onClick={() => setLogModal(null)}><X size={18} /></button>
              </div>
              {reasons.length > 0 && (
                <div className="mb-3 bg-red-50 border border-red-200 rounded-xl p-3 space-y-1">
                  <p className="text-xs font-semibold text-red-700">Почему не дошло:</p>
                  {reasons.map(([reason, count]) => (
                    <div key={reason} className="flex items-center justify-between text-xs text-red-700">
                      <span className="truncate flex-1">{reason}</span>
                      <span className="font-bold ml-2">{count}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="overflow-y-auto flex-1 space-y-1">
                {logModal.rows.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-6">Лог пуст</p>
                )}
                {logModal.rows.map((r: any, i: number) => {
                  const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.username || `tg:${r.tg_id}`
                  const username = r.username ? `@${r.username}` : ''
                  const ok = r.status === 'sent'
                  return (
                    <div key={i} className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-xs ${ok ? 'bg-gray-50' : 'bg-red-50'}`}>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={ok ? 'text-green-500' : 'text-red-400'}>{ok ? '✓' : '✗'}</span>
                        <span className="font-medium text-gray-800 truncate">{name}</span>
                        {username && <span className="text-gray-400 shrink-0">{username}</span>}
                      </div>
                      {!ok && r.error && (
                        <span className="text-red-400 truncate max-w-[140px] ml-2" title={r.error}>{humanReason(r.error)}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Превью */}
      {previewModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800 text-sm">Превью сообщения</h3>
              <button onClick={() => setPreviewModal(null)}><X size={18} /></button>
            </div>
            <div className="bg-[#effdde] rounded-2xl rounded-tr-sm p-3 shadow-sm">
              {previewModal.photo && (
                <img src={previewModal.photo} alt=""
                  className="w-full rounded-xl mb-2"
                  style={{ maxHeight: '300px', objectFit: 'contain', background: '#f0f0f0' }}
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
              )}
              <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed break-words"
                style={{ overflowWrap: 'anywhere' }}
                dangerouslySetInnerHTML={{ __html: previewModal.text || '' }} />
              {previewModal.buttons && previewModal.buttons.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {previewModal.buttons.map((b: any, i: number) => (
                    <div key={i}>
                      <div className="w-full py-2 px-3 rounded-xl text-center text-sm font-medium text-blue-600 bg-white border border-gray-200">
                        {b.text}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5 text-center break-all">{b.url}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => setPreviewModal(null)}
              className="w-full mt-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">Закрыть</button>
          </div>
        </div>
      )}
    </div>
  )
}


// ─── Custom Modal ────────────────────────────────────────────────────────────
function CustomBroadcastModal(props: {
  tzLabel: string
  onClose: () => void
  onSaved: () => void
  onError: (m: string) => void
}) {
  const [fireAt, setFireAt] = useState('')
  const [text, setText] = useState('')
  const [photoUrl, setPhotoUrl] = useState('')
  const [buttons, setButtons] = useState<{text: string; url: string}[]>([])
  const [isTest, setIsTest] = useState(false)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!fireAt) { props.onError('Укажите дату и время'); return }
    if (!text.trim()) { props.onError('Пустой текст'); return }
    if (buttons.length > 3) { props.onError('Максимум 3 кнопки'); return }
    const invalidBtn = buttons.find(b => (b.text && !b.url) || (!b.text && b.url))
    if (invalidBtn) { props.onError('Заполните и текст, и ссылку для каждой кнопки'); return }
    setSaving(true)
    try {
      await api.broadcasts.addCustom({
        fire_at: fireAt,
        text,
        photo_url: photoUrl || null,
        buttons: buttons.filter(b => b.text && b.url),
        is_test: isTest,
      })
      props.onSaved()
    } catch (e: any) {
      props.onError(e.message || 'Ошибка')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">Произвольная рассылка</h3>
          <button onClick={props.onClose}><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div className="text-xs bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-blue-800">
            Получатели: вся ваша база контактов (Telegram, не отписавшиеся).
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Дата и время ({props.tzLabel})</label>
            <input type="datetime-local" value={fireAt} onChange={e => setFireAt(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Фото (URL, опционально)</label>
            <input type="text" value={photoUrl} onChange={e => setPhotoUrl(e.target.value)}
              placeholder="https://..."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Текст (можно {'{first_name}'} — подставится имя)</label>
            <textarea value={text} onChange={e => setText(e.target.value)}
              rows={6}
              placeholder="Привет, {first_name}! ..."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono" />
            <p className="text-xs text-gray-400 mt-1">HTML-разметка Telegram: &lt;b&gt;, &lt;i&gt;, &lt;a href=""&gt;</p>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Кнопки (до 3, опционально)</label>
            <div className="space-y-2">
              {buttons.map((b, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="text" value={b.text} placeholder="Текст кнопки"
                    onChange={e => setButtons(buttons.map((x, j) => j === i ? { ...x, text: e.target.value } : x))}
                    className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                  <input type="text" value={b.url} placeholder="https://..."
                    onChange={e => setButtons(buttons.map((x, j) => j === i ? { ...x, url: e.target.value } : x))}
                    className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                  <button onClick={() => setButtons(buttons.filter((_, j) => j !== i))}
                    className="p-1.5 text-red-400 hover:text-red-600">
                    <X size={16} />
                  </button>
                </div>
              ))}
              {buttons.length < 3 && (
                <button onClick={() => setButtons([...buttons, { text: '', url: '' }])}
                  className="text-xs text-indigo-600 hover:text-indigo-800">+ Добавить кнопку</button>
              )}
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isTest} onChange={e => setIsTest(e.target.checked)} className="rounded" />
            <span className="text-sm text-gray-600">Тестовая рассылка (только тестовым Telegram ID)</span>
          </label>
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={save} disabled={saving}
            className="flex-1 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-60"
            style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
            {saving ? 'Сохраняю...' : 'Поставить в очередь'}
          </button>
          <button onClick={props.onClose}
            className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">Отмена</button>
        </div>
      </div>
    </div>
  )
}


// ─── Bulk Modal ──────────────────────────────────────────────────────────────
function BulkBroadcastModal(props: {
  tzLabel: string
  onClose: () => void
  onSaved: (n: number) => void
  onError: (m: string) => void
}) {
  const [raw, setRaw] = useState('')
  const [isTest, setIsTest] = useState(false)
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<{ index: number; errors: string[] }[]>([])
  const [preview, setPreview] = useState<any[] | null>(null)

  function convertDateToIso(s: string): string {
    s = s.trim()
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s
    const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/)
    if (!m) return ''
    const [, d, mo, y, h, mi] = m
    return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${mi}:00`
  }

  function parse(): any[] {
    const chunks = raw.split(/^---\s*$/m).map(c => c.trim()).filter(Boolean)
    const items: any[] = []
    for (const chunk of chunks) {
      const lines = chunk.split('\n')
      let fire_at = ''
      let photo_url = ''
      const text_lines: string[] = []
      const buttons: { text: string; url: string }[] = []
      let section: 'none' | 'text' | 'buttons' = 'none'
      for (const line of lines) {
        const trimmed = line.trim()
        if (/^ВРЕМЯ:/i.test(trimmed)) {
          section = 'none'
          fire_at = convertDateToIso(trimmed.replace(/^ВРЕМЯ:\s*/i, ''))
          continue
        }
        if (/^ФОТО:/i.test(trimmed)) {
          section = 'none'
          photo_url = trimmed.replace(/^ФОТО:\s*/i, '').trim()
          continue
        }
        if (/^ТЕКСТ:\s*$/i.test(trimmed)) { section = 'text'; continue }
        if (/^КНОПКИ:\s*$/i.test(trimmed)) { section = 'buttons'; continue }
        if (section === 'text') text_lines.push(line)
        else if (section === 'buttons' && trimmed) {
          const parts = trimmed.split('|').map(x => x.trim())
          if (parts.length >= 2) buttons.push({ text: parts[0], url: parts[1] })
          else buttons.push({ text: parts[0] || '', url: '' })
        }
      }
      items.push({
        fire_at,
        photo_url: photo_url || null,
        text: text_lines.join('\n').trim(),
        buttons,
      })
    }
    return items
  }

  async function validate() {
    setValidating(true); setErrors([]); setPreview(null)
    try {
      const items = parse()
      if (items.length === 0) {
        props.onError('Не найдено ни одной задачи (разделитель — строка ---)')
        return
      }
      const res = await api.broadcasts.bulkAdd({ items, is_test: isTest, dry_run: true })
      if (res.ok) setPreview(items)
      else setErrors(res.errors || [])
    } catch (e: any) {
      props.onError(e.message || 'Ошибка валидации')
    } finally {
      setValidating(false)
    }
  }

  async function save() {
    setSaving(true)
    try {
      const items = parse()
      const res = await api.broadcasts.bulkAdd({ items, is_test: isTest, dry_run: false })
      if (!res.ok) {
        setErrors(res.errors || [])
        props.onError(`Ошибки в ${res.errors.length} задачах — исправьте`)
      } else {
        props.onSaved(res.created || 0)
      }
    } catch (e: any) {
      props.onError(e.message || 'Ошибка')
    } finally { setSaving(false) }
  }

  const SAMPLE = `---
ВРЕМЯ: 29.04.2026 09:30
ФОТО: https://example.com/photo.jpg
ТЕКСТ:
Привет, {first_name}!
Скоро запуск нового продукта.
КНОПКИ:
Подробнее | https://example.com/launch
---
ВРЕМЯ: 29.04.2026 18:00
ТЕКСТ:
Сегодня вечером эфир — приходи!
КНОПКИ:
Эфир | https://stream.example.com
---`

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">Пакетная загрузка рассылок</h3>
          <button onClick={props.onClose}><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div className="text-xs bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-blue-800">
            Получатели: вся ваша база контактов (Telegram, не отписавшиеся).
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900">
            <p className="font-semibold mb-1">Формат (разделитель — строка <code className="bg-white px-1 rounded">---</code>):</p>
            <pre className="whitespace-pre-wrap text-[11px] leading-tight">{SAMPLE}</pre>
            <button onClick={() => setRaw(SAMPLE)} className="mt-2 text-indigo-600 hover:text-indigo-800">Вставить пример</button>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Содержимое ({props.tzLabel})</label>
            <textarea value={raw} onChange={e => { setRaw(e.target.value); setErrors([]); setPreview(null) }}
              rows={12}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isTest} onChange={e => setIsTest(e.target.checked)} className="rounded" />
            <span className="text-sm text-gray-600">Тестовая рассылка</span>
          </label>

          {errors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 space-y-1">
              <p className="text-sm font-semibold text-red-700">Ошибки в {errors.length} задачах:</p>
              {errors.map(e => (
                <div key={e.index} className="text-xs text-red-700">
                  <b>Задача #{e.index}:</b> {e.errors.join('; ')}
                </div>
              ))}
            </div>
          )}

          {preview && preview.length > 0 && errors.length === 0 && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 space-y-1">
              <p className="text-sm font-semibold text-green-700">✓ Распарсено {preview.length} задач — всё валидно</p>
              <div className="max-h-40 overflow-y-auto space-y-1 mt-2">
                {preview.map((p, i) => (
                  <div key={i} className="text-xs text-green-900 bg-white/50 rounded px-2 py-1">
                    <b>#{i+1}</b> {p.fire_at} — {p.text.slice(0, 60)}{p.text.length > 60 ? '…' : ''}
                    {p.buttons.length > 0 && <span className="text-gray-500"> · кнопок: {p.buttons.length}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={validate} disabled={validating || saving || !raw.trim()}
            className="px-4 py-2 border border-gray-300 rounded-xl text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            {validating ? 'Проверяю...' : 'Проверить'}
          </button>
          <button onClick={save} disabled={saving || validating || !raw.trim()}
            className="flex-1 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-60"
            style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
            {saving ? 'Создаю...' : 'Поставить в очередь'}
          </button>
          <button onClick={props.onClose}
            className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">Отмена</button>
        </div>
      </div>
    </div>
  )
}
