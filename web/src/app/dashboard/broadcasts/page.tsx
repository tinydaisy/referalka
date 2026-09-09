'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Send, XCircle, Eye, Clock, CheckCircle, AlertCircle, Loader2, X,
  Edit2, Trash2, Copy, Users, ChevronDown, ChevronRight, FileText, Upload, Play, Undo2
} from 'lucide-react'
import { api } from '@/lib/api'
import { validateTelegramHtml, validateButton } from '@/lib/validateTelegramHtml'
import BroadcastChannelPicker from '@/components/BroadcastChannelPicker'
import BroadcastTagPicker from '@/components/BroadcastTagPicker'
import BroadcastMediaPicker, { type BroadcastMedia } from '@/components/BroadcastMediaPicker'
import { utcIsoToTzLocalInput, tzLocalInputToEpochMs, nowTzLocalInput } from '@/lib/timezone'
import EmailFunnelStats, { type EmailStats } from '@/components/EmailFunnelStats'
import { useMe } from '@/hooks/useMe'

const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-gray-50 border-gray-100',
  pending: 'bg-amber-50 border-amber-200',
  running: 'bg-blue-50 border-blue-200',
  done: 'bg-green-50 border-green-200',
  cancelled: 'bg-gray-50 border-gray-200',
  recalled: 'bg-purple-50 border-purple-200',
}
const STATUS_ICON: Record<string, React.ReactNode> = {
  draft: <Edit2 size={13} className="text-gray-400" />,
  pending: <Clock size={13} className="text-amber-500" />,
  running: <Loader2 size={13} className="text-blue-500 animate-spin" />,
  done: <CheckCircle size={13} className="text-green-500" />,
  cancelled: <XCircle size={13} className="text-gray-400" />,
  recalled: <Undo2 size={13} className="text-purple-500" />,
}
const STATUS_LABEL: Record<string, string> = {
  draft: 'Черновик', pending: 'Ожидает', running: 'Отправляется',
  done: 'Отправлено', cancelled: 'Отменена', recalled: 'Отозвана',
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
  // Email-причины недоставки (на случай старых записей с сырым текстом лога)
  if (low.includes('spam')) return 'Письмо отклонено как спам'
  if (low.includes('user unknown') || low.includes('does not exist') || low.includes('no such user') || low.includes('mailbox not found') || low.includes('unknown user')) return 'Такого адреса не существует'
  if (low.includes('mailbox full') || low.includes('out of storage') || low.includes('quota')) return 'Ящик получателя переполнен'
  if (low.includes('greylist') || low.includes('try again')) return 'Временно отложено получателем'
  if (!err) return 'Неизвестная ошибка'
  return err.slice(0, 100)
}

// Текущее МОСКОВСКОЕ время минус 1 минута в формате "YYYY-MM-DDTHH:MM".
// Бэк (_parse_fire_at) трактует fire_at как локальное время в tz клиента (МСК),
// поэтому отдаём именно московское время, независимо от tz браузера. Минус минута —
// чтобы fire_at точно был ≤ NOW() и планировщик (тик раз в минуту) взял рассылку сразу.
function nowMoscowMinus1MinLocal(): string {
  const d = new Date(Date.now() - 60_000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const g = (t: string) => parts.find(p => p.type === t)?.value || ''
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`
}

export default function GeneralBroadcastsPage() {
  const [schedules, setSchedules] = useState<any[]>([])
  const [tzLabel, setTzLabel] = useState('МСК (UTC+3)')
  const [msg, setMsg] = useState<{ text: string; type: 'ok' | 'err' } | null>(null)
  const [previewModal, setPreviewModal] = useState<any>(null)
  const [logModal, setLogModal] = useState<{ schedule: any; rows: any[]; emailStats?: EmailStats | null } | null>(null)
  const [customModal, setCustomModal] = useState(false)
  const [bulkModal, setBulkModal] = useState(false)
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set())
  // editModal — содержит initial значения и id рассылки. Если задан —
  // открывается тот же CustomBroadcastModal в режиме «редактирование».
  const [editModal, setEditModal] = useState<null | {
    id: number
    fire_at: string
    is_test: boolean
    text: string
    subject: string
    photo_url: string
    video_url: string
    media_type: 'photo' | 'video' | null
    buttons: { text: string; url: string }[]
    target_channel_ids: number[] | null
    audience_tags_include?: string[] | null
    audience_tags_exclude?: string[] | null
    send_to_client_chats: boolean
    send_to_private_chats: boolean
  }>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [recallingId, setRecallingId] = useState<number | null>(null)

  function showMsg(text: string, type: 'ok' | 'err' = 'ok') {
    setMsg({ text, type })
    setTimeout(() => setMsg(null), 5000)
  }

  const load = useCallback(async () => {
    try {
      const res = await api.broadcasts.list()
      // Сортировка по убыванию даты (новые сверху).
      // ⚠️ Рассылки БЕЗ даты — В НАЧАЛО. Копия создаётся без даты, и раньше она
      // уезжала в самый конец списка: человек нажимал «Копировать» и не понимал,
      // куда делась копия. Без даты = требует действия, поэтому сверху.
      const sorted = [...(res.schedules || [])].sort((a: any, b: any) => {
        const av = a.fire_at_iso || a.fire_at || ''
        const bv = b.fire_at_iso || b.fire_at || ''
        if (!av && !bv) return 0
        if (!av) return -1
        if (!bv) return 1
        return av < bv ? 1 : av > bv ? -1 : 0
      })
      setSchedules(sorted)
      const tz = res.timezone || 'Europe/Moscow'
      setTzLabel(tz === 'Europe/Moscow' ? 'МСК (UTC+3)' : tz)
      setSelectedIds(new Set())
    } catch (e: any) {
      showMsg(e.message || 'Не удалось загрузить', 'err')
    }
  }, [])

  function toggleSelect(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function toggleSelectAll() {
    if (selectedIds.size === schedules.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(schedules.map(s => s.id)))
  }
  // Отметить только черновики — повторный клик снимает выделение.
  function selectAllDrafts() {
    const draftIds = schedules.filter(s => s.status === 'draft').map(s => s.id)
    const allPicked = draftIds.length > 0
      && draftIds.every(id => selectedIds.has(id)) && selectedIds.size === draftIds.length
    setSelectedIds(allPicked ? new Set() : new Set(draftIds))
  }
  async function deleteSelected() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const selected = schedules.filter(s => ids.includes(s.id))
    const active = selected.filter(s => s.status === 'pending' || s.status === 'running')
    let confirmMsg = `Удалить ${selected.length} рассылок? Действие нельзя отменить.`
    if (active.length > 0) confirmMsg = `Среди выбранных ${active.length} активных — они будут отменены и удалены. Продолжить?`
    if (!confirm(confirmMsg)) return
    setDeleting(true)
    for (const s of active) { try { await api.broadcasts.cancel(s.id) } catch {} }
    let ok = 0
    for (const s of selected) {
      try { await api.broadcasts.delete(s.id); ok++ } catch (e: any) { showMsg(`Ошибка #${s.id}: ${e.message}`, 'err') }
    }
    setDeleting(false)
    setSchedules(prev => prev.filter(x => !ids.includes(x.id)))
    setSelectedIds(new Set())
    if (ok > 0) showMsg(`Удалено ${ok} рассылок`)
  }

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
      setLogModal({ schedule: s, rows: r.log || [], emailStats: r.email_stats || null })
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
      // ⚠️ Бэк мог не перенести картинку: медиа рассылок стирается через сутки
      // после отправки. Молча отдать копию без фото нельзя — человек отправит
      // её и удивится, куда делось изображение.
      const r: any = await api.broadcasts.copy(s.id)
      if (r?.warning) alert(r.warning)
      await load()
      showMsg('Создана копия')
    } catch (e: any) { showMsg(e.message, 'err') }
  }
  async function publishOne(s: any) {
    try {
      await api.broadcasts.publish(s.id)
      setSchedules(prev => prev.map(x => x.id === s.id ? { ...x, status: 'pending' } : x))
      showMsg('Рассылка поставлена в очередь')
    } catch (e: any) { showMsg(e.message, 'err') }
  }
  async function publishSelected() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const drafts = schedules.filter(s => ids.includes(s.id) && s.status === 'draft')
    if (drafts.length === 0) return
    let ok = 0, fail = 0
    for (const s of drafts) {
      try { await api.broadcasts.publish(s.id); ok++ }
      catch (e: any) { fail++; showMsg(`Ошибка #${s.id}: ${e.message}`, 'err') }
    }
    await load()
    if (ok > 0) showMsg(`Запущено: ${ok}${fail ? ` · с ошибкой: ${fail}` : ''}`)
  }
  const pendingCount = schedules.filter(s => s.status === 'pending' || s.status === 'draft').length
  const doneCount = schedules.filter(s => s.status === 'done').length
  const nextPending = schedules
    .filter(s => s.status === 'pending' && s.fire_at_iso && new Date(s.fire_at_iso) > new Date())
    .sort((a, b) => (a.fire_at_iso || '') < (b.fire_at_iso || '') ? -1 : 1)[0] || null

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Рассылки</h1>
          <p className="text-sm text-gray-500 mt-1">Произвольные сообщения по всей вашей базе контактов — независимо от конференций.</p>
        </div>
      </div>

      {/* Статусная плашка */}
      <div className="mb-4 rounded-2xl border card-border bg-white p-4">
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
          {nextPending && nextPending.fire_at_local && (
            <div className="ml-auto flex items-center gap-1.5 text-xs bg-amber-50 border border-amber-200 rounded-xl px-3 py-1.5">
              <Clock size={12} className="text-amber-500" />
              <span className="text-amber-700 font-medium">
                Ближайшая: {nextPending.fire_at_local} {tzLabel}
                {nextPending.seconds_until != null && ` (через ${formatTimeLeft(nextPending.seconds_until)})`}
              </span>
            </div>
          )}
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
        {(() => {
          const draftSelected = schedules.filter(s => selectedIds.has(s.id) && s.status === 'draft').length
          return draftSelected > 0 ? (
            <button onClick={publishSelected}
              className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-white bg-emerald-500 hover:bg-emerald-600">
              <Play size={14} /> {`Поставить в очередь (${draftSelected})`}
            </button>
          ) : null
        })()}
        {selectedIds.size > 0 && (
          <button onClick={deleteSelected} disabled={deleting}
            className="flex items-center gap-2 px-3 py-2 border border-red-300 rounded-xl text-sm text-white bg-red-500 hover:bg-red-600 disabled:opacity-50">
            <Trash2 size={14} /> {deleting ? 'Удаляем...' : `Удалить выбранные (${selectedIds.size})`}
          </button>
        )}
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
        <div className="py-16 text-center text-gray-400 bg-white rounded-2xl border card-border">
          <Send size={32} className="mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">Очередь пуста</p>
          <p className="text-xs mt-1">Нажмите «Произвольное» или «Пакетом» чтобы создать рассылку.</p>
        </div>
      ) : (
        <>
        <div className="flex items-center gap-2 mb-2 px-1">
          <input type="checkbox"
            checked={selectedIds.size === schedules.length && schedules.length > 0}
            onChange={toggleSelectAll}
            className="rounded cursor-pointer"
            title="Выбрать все" />
          <span className="text-xs text-gray-400">Выбрать все</span>
          {schedules.some(s => s.status === 'draft') && (
            <button onClick={selectAllDrafts}
              className="text-xs text-blue-600 hover:underline ml-2">
              Выбрать все черновики
            </button>
          )}
        </div>
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
                  <div className={`rounded-xl border p-3.5 ${STATUS_COLOR[s.status] || 'bg-white border-gray-100'} ${selectedIds.has(s.id) ? 'ring-2 ring-blue-300' : ''}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center pt-0.5 shrink-0">
                        <input type="checkbox"
                          checked={selectedIds.has(s.id)}
                          onChange={() => toggleSelect(s.id)}
                          className="rounded cursor-pointer" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="text-xs text-gray-400 font-mono" title="Номер рассылки в системе">#{s.id}</span>
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
                        {s.snapshot_subject && (
                          <p className="text-sm font-semibold text-gray-900 mb-0.5 truncate">{s.snapshot_subject}</p>
                        )}
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
                            {((s.recipients_failed || 0) + (s.recipients_bounced || 0)) > 0 && (
                              <div className="relative group flex items-center gap-1 cursor-help">
                                <span className="text-red-500 font-bold text-sm leading-none">✕</span>
                                <span className="text-sm font-semibold text-red-500">{(s.recipients_failed || 0) + (s.recipients_bounced || 0)}</span>
                                <div className="absolute bottom-full right-0 mb-1.5 w-64 bg-gray-900 text-white text-xs rounded-lg px-3 py-2 hidden group-hover:block z-50 shadow-xl pointer-events-none leading-snug">
                                  Не доставлено {(s.recipients_failed || 0) + (s.recipients_bounced || 0)}. Нажмите «список» — увидите разбивку по причинам.
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
                        {s.status === 'draft' && (
                          <button onClick={() => publishOne(s)}
                            className="p-1.5 border border-emerald-300 rounded-lg text-emerald-600 hover:text-white hover:bg-emerald-500"
                            title="Запустить (в очередь)">
                            <Play size={13} />
                          </button>
                        )}
                        {(s.status === 'draft' || s.status === 'pending') && (
                          <button onClick={() => {
                            // Показываем московское стенное время, а не tz браузера
                            // (иначе у клиента с зарубежной tz время «съезжает»).
                            const local = utcIsoToTzLocalInput(s.fire_at_iso)
                            // snapshot_buttons приходит из бэка как JSONB-массив объектов
                            let btns: { text: string; url: string }[] = []
                            try {
                              const raw = s.snapshot_buttons
                              btns = Array.isArray(raw) ? raw
                                : typeof raw === 'string' ? JSON.parse(raw)
                                : []
                            } catch { btns = [] }
                            setEditModal({
                              id: s.id,
                              fire_at: local,
                              is_test: !!s.is_test,
                              text: s.snapshot_text || '',
                              subject: s.snapshot_subject || '',
                              photo_url: s.snapshot_photo || '',
                              video_url: s.snapshot_video || '',
                              media_type: s.snapshot_media_type || (s.snapshot_photo ? 'photo' : null),
                              buttons: btns.map(b => ({ text: b.text || '', url: b.url || '' })),
                              target_channel_ids: Array.isArray(s.target_channel_ids) ? s.target_channel_ids : null,
                              audience_tags_include: Array.isArray(s.audience_tags_include) ? s.audience_tags_include : [],
                              audience_tags_exclude: Array.isArray(s.audience_tags_exclude) ? s.audience_tags_exclude : [],
                              send_to_client_chats: !!s.send_to_client_chats,
                              send_to_private_chats: !!s.send_to_private_chats,
                            })
                          }}
                            className="p-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-white"
                            title="Редактировать">
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
                        {/* Отозвать — удалить отправленные сообщения (только done, если есть сохранённые ID) */}
                        {s.status === 'done' && (
                          (s.recallable_count || 0) > 0 ? (
                            <button onClick={async () => {
                              if (recallingId) return
                              if (!confirm(
                                'Отозвать рассылку?\n\n' +
                                'Попробуем УДАЛИТЬ уже отправленные сообщения у получателей (Telegram, VK, MAX) и в чатах.\n\n' +
                                'Платформа может отказать удалить слишком старое сообщение или при отсутствии прав у бота — такие попадут в «не удалось» с причиной. Email отозвать нельзя.'
                              )) return
                              setRecallingId(s.id)
                              try {
                                const r: any = await api.broadcasts.recall(s.id)
                                const bp = r.by_platform || {}
                                const parts = [`Удалено: ${r.deleted}`]
                                const plat = [bp.telegram ? `TG ${bp.telegram}` : null, bp.vk ? `VK ${bp.vk}` : null, bp.max ? `MAX ${bp.max}` : null].filter(Boolean).join(', ')
                                if (plat) parts.push(`(${plat})`)
                                if (r.failed) parts.push(`не удалось: ${r.failed}`)
                                if (r.skipped_no_msgid) parts.push(`без ID: ${r.skipped_no_msgid}`)
                                if (r.skipped_email) parts.push(`email (нельзя): ${r.skipped_email}`)
                                let m = parts.join(' · ')
                                if (r.errors && r.errors.length) m += `\nПричины: ${r.errors.join('; ')}`
                                showMsg(m, r.deleted > 0 ? 'ok' : 'err')
                              } catch (e: any) { showMsg(e.message, 'err') }
                              finally { setRecallingId(null) }
                            }}
                              disabled={recallingId === s.id}
                              className="p-1.5 border border-amber-300 rounded-lg text-amber-500 hover:text-white hover:bg-amber-500 disabled:opacity-50"
                              title="Отозвать — удалить отправленные сообщения у получателей">
                              {recallingId === s.id ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
                            </button>
                          ) : (
                            <button disabled
                              className="p-1.5 border border-gray-200 rounded-lg text-gray-300 cursor-not-allowed"
                              title="Отозвать нельзя: у этой рассылки не сохранены ID сообщений (отправлена до появления функции) либо только email.">
                              <Undo2 size={13} />
                            </button>
                          )
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
        </>
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

      {/* Полноценное редактирование draft/pending рассылки. */}
      {editModal && (
        <CustomBroadcastModal
          tzLabel={tzLabel}
          editId={editModal.id}
          initial={{
            fire_at: editModal.fire_at,
            text: editModal.text,
            subject: editModal.subject,
            photo_url: editModal.photo_url,
            video_url: editModal.video_url,
            media_type: editModal.media_type,
            buttons: editModal.buttons,
            is_test: editModal.is_test,
            target_channel_ids: editModal.target_channel_ids,
            audience_tags_include: editModal.audience_tags_include,
            audience_tags_exclude: editModal.audience_tags_exclude,
            send_to_client_chats: editModal.send_to_client_chats,
            send_to_private_chats: editModal.send_to_private_chats,
          }}
          onClose={() => setEditModal(null)}
          onSaved={async () => { setEditModal(null); await load(); showMsg('Сохранено') }}
          onError={(m) => showMsg(m, 'err')}
        />
      )}

      {/* Лог */}
      {logModal && (() => {
        const sentCount = logModal.rows.filter((r: any) => r.status === 'sent').length
        const readCount = logModal.rows.filter((r: any) => r.status === 'sent' && r.read_at).length
        // Email-воронка: 4 цифры по уникальным адресам, считает бэкенд.
        // Рисуется ПОД строкой email-канала в блоке «По каналам отправки».
        const es = logModal.emailStats
        // Для клиента «не доставлено» = всё, что не 'sent' (включая bounced —
        // письмо отвергнуто почтой получателя). Причину показываем по-русски.
        const failed = logModal.rows.filter((r: any) => r.status !== 'sent')
        const reasonMap: Record<string, number> = {}
        for (const r of failed) {
          const reason = humanReason(r.error || 'Письмо не доставлено получателю')
          reasonMap[reason] = (reasonMap[reason] || 0) + 1
        }
        const reasons = Object.entries(reasonMap).sort((a, b) => b[1] - a[1])
        // Разбивка по ботам/сообществам. Старые строки до миграции 085 без channel_id → «Без указания».
        const PLATFORM_LABEL: Record<string, string> = { telegram: 'TG', vk: 'VK', max: 'MAX' }
        const PLATFORM_PILL_CLASS: Record<string, string> = {
          telegram: 'bg-sky-100 text-sky-700 border-sky-200',
          vk: 'bg-indigo-100 text-indigo-700 border-indigo-200',
          max: 'bg-amber-100 text-amber-700 border-amber-200',
        }
        const botMap: Record<string, { sent: number; failed: number; platform: string }> = {}
        for (const r of logModal.rows) {
          const handle = r.channel_handle || r.channel_name || 'Без указания'
          const platform = r.channel_platform || r.user_platform || ''
          const key = platform ? `${platform}::${handle}` : handle
          if (!botMap[key]) botMap[key] = { sent: 0, failed: 0, platform }
          if (r.status === 'sent') botMap[key].sent += 1
          else botMap[key].failed += 1
        }
        const botEntries = Object.entries(botMap)
          .map(([key, st]) => ({ key, handle: key.includes('::') ? key.split('::')[1] : key, ...st }))
          .sort((a, b) => (b.sent + b.failed) - (a.sent + a.failed))
        return (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 max-h-[85vh] flex flex-col">
              <div className="flex justify-between items-center mb-3">
                <div>
                  <h3 className="font-semibold text-gray-800 text-sm">Получатели рассылки</h3>
                  <p className="text-xs text-gray-400">
                    Всего: {logModal.rows.length} · <span className="text-green-600">доставлено {sentCount}</span>
                    {readCount > 0 && <> · <span className="text-blue-600" title="Прочтения отслеживаются только в VK (Telegram Bot API не даёт read receipts)">прочитано {readCount}</span></>}
                    {failed.length > 0 && <> · <span className="text-red-500" title="Письмо/сообщение не дошло до получателя (см. причины ниже)">не доставлено {failed.length}</span></>}
                  </p>
                </div>
                <button onClick={() => setLogModal(null)}><X size={18} /></button>
              </div>
              {botEntries.length > 1 || (botEntries.length === 1 && botEntries[0].handle !== 'Без указания') ? (
                <div className="mb-3 bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-1">
                  <p className="text-xs font-semibold text-blue-700">По каналам отправки:</p>
                  {botEntries.map(e => (
                    <div key={e.key}>
                      <div className="flex items-center justify-between text-xs text-blue-800 gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {e.platform && (
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${PLATFORM_PILL_CLASS[e.platform] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                              {PLATFORM_LABEL[e.platform] || e.platform.toUpperCase()}
                            </span>
                          )}
                          <span className="truncate">{e.handle}</span>
                        </div>
                        <span className="ml-2 shrink-0">
                          <span className="font-bold text-green-700">{e.sent}</span>
                          {e.failed > 0 && <span className="text-red-500"> ✕ {e.failed}</span>}
                        </span>
                      </div>
                      {/* Воронка показывается ПОД своим email-каналом, а не общим блоком сверху. */}
                      {e.platform === 'email' && <EmailFunnelStats stats={es} />}
                    </div>
                  ))}
                </div>
              ) : null}
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
              {previewModal.video && (
                <video src={previewModal.video} controls
                  className="w-full rounded-xl mb-2 bg-black"
                  style={{ maxHeight: '300px' }}
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
  // Если задан editId — режим редактирования: PATCH /schedules/{id} вместо
  // POST add-custom. Initial значения подставляются в форму при открытии.
  editId?: number
  initial?: {
    fire_at?: string
    text?: string
    subject?: string
    photo_url?: string
    video_url?: string
    media_type?: 'photo' | 'video' | null
    buttons?: { text: string; url: string }[]
    is_test?: boolean
    target_channel_ids?: number[] | null
    audience_tags_include?: string[] | null
    audience_tags_exclude?: string[] | null
    send_to_client_chats?: boolean
    send_to_private_chats?: boolean
  }
}) {
  // Новая рассылка — предзаполняем московским «сейчас + 10 мин», чтобы календарь
  // открывался на московской дате, а не на «сегодня» по таймзоне компьютера.
  const [fireAt, setFireAt] = useState(props.initial?.fire_at || nowTzLocalInput(10))
  // Режим отправки: 'schedule' — по дате/времени (календарь), 'now' — немедленно.
  const [sendMode, setSendMode] = useState<'schedule' | 'now'>('schedule')
  const [subject, setSubject] = useState(props.initial?.subject || '')
  const [text, setText] = useState(props.initial?.text || '')
  const [media, setMedia] = useState<BroadcastMedia>({
    photo_url: props.initial?.photo_url || null,
    video_url: props.initial?.video_url || null,
    media_type: props.initial?.media_type || (props.initial?.photo_url ? 'photo' : null),
  })
  const [buttons, setButtons] = useState<{text: string; url: string}[]>(props.initial?.buttons || [])
  const [isTest, setIsTest] = useState(!!props.initial?.is_test)
  const [sendToClientChats, setSendToClientChats] = useState(!!props.initial?.send_to_client_chats)
  const [sendToPrivateChats, setSendToPrivateChats] = useState(!!props.initial?.send_to_private_chats)
  // База чатов клиента (общие/личные каналы) — только с фичей broadcast_chats (Экстра/vip).
  const { me } = useMe()
  const hasChatsFeature = (me?.features || []).includes('broadcast_chats')
  // target_channel_ids: null = «пока не выбрано» (BroadcastChannelPicker
  // проставит все каналы клиента); массив = подмножество.
  const [targetChannels, setTargetChannels] = useState<number[] | null>(
    props.initial?.target_channel_ids ?? null
  )
  // Фильтр аудитории по тегам контактов (миграция 265).
  const [tagsInclude, setTagsInclude] = useState<string[]>(props.initial?.audience_tags_include || [])
  const [tagsExclude, setTagsExclude] = useState<string[]>(props.initial?.audience_tags_exclude || [])
  const [saving, setSaving] = useState(false)
  const [formErrors, setFormErrors] = useState<string[]>([])
  const isEdit = typeof props.editId === 'number'

  const htmlErrors = validateTelegramHtml(text)
  const buttonErrors = buttons.map(b => validateButton(b.text, b.url))
  const hasButtonErrors = buttonErrors.some(errs => errs.length > 0)
  const [testing, setTesting] = useState(false)
  // Итог тестовой отправки показываем ВНУТРИ модалки: родительская плашка
  // ошибок перекрыта этим окном, и клиент видел «кнопка не работает».
  const [testMsg, setTestMsg] = useState('')

  async function sendTestNow() {
    // Текст берём из state: поле обычное (textarea), onChange срабатывает на
    // каждый ввод — расхождения с экраном быть не может. Раньше здесь читали
    // значение из визуального редактора, он убран (терял содержимое).
    const liveText = text
    const plainTest = liveText.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    // Ошибку показываем В МОДАЛКЕ: props.onError рисует её в родителе, а он
    // перекрыт этим же окном — клиент видел «ничего не происходит».
    if (!plainTest) { setTestMsg('Сначала напишите текст рассылки'); return }
    if (htmlErrors.length > 0) { setTestMsg('Исправьте HTML-ошибки в тексте'); return }
    if (hasButtonErrors) { setTestMsg('Исправьте ошибки в кнопках'); return }
    setTestMsg('')
    setTesting(true)
    try {
      const r = await api.broadcasts.testNow({
        text: liveText, subject: subject || null,
        photo_url: media.photo_url, video_url: media.video_url, media_type: media.media_type,
        buttons: buttons.filter(b => b.text && b.url),
      })
      const failed = (r.results || []).filter((x: any) => !x.ok)
      const msg = failed.length > 0
        ? `Доставлено ${r.sent} из ${r.total}. Не ушло: ${failed.map((f: any) => `${f.platform} — ${f.error}`).join('; ')}`
        : `✅ Тест отправлен (${r.sent} шт) на ваши тестовые адреса`
      setTestMsg(msg)
      props.onError(msg)
    } catch (e: any) {
      const msg = e.message || 'Ошибка тестовой отправки'
      setTestMsg(msg)
      props.onError(msg)
    } finally {
      setTesting(false)
    }
  }

  async function save() {
    // Текст из state — поле обычное, значение всегда актуально.
    const liveText = text

    // Собираем все ошибки списком (показываем над кнопкой красным блоком).
    const errs: string[] = []
    // Дата нужна только в режиме «Запланировать». «Немедленно» — fire_at подставим now().
    if (sendMode === 'schedule' && !fireAt) errs.push('Не указана дата и время рассылки')
    // ⚠️ Защита от ошибочной мгновенной отправки: дата в прошлом (частый случай —
    // скопировали старую рассылку). Люфт 2 мин от текущего времени.
    if (sendMode === 'schedule' && fireAt) {
      // Трактуем ввод как МСК (как бэк), а не как tz браузера — иначе у клиента
      // с зарубежной tz валидация ложно срабатывает «дата уже прошла».
      const picked = tzLocalInputToEpochMs(fireAt)
      if (picked < Date.now() - 2 * 60 * 1000) {
        errs.push('Дата отправки уже прошла — укажите будущее время (иначе рассылка ушла бы сразу)')
      }
    }
    // Проверка «пусто» по plain-text (без тегов и &nbsp;)
    const plain = liveText.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    // Диагностика: пишем в Console сколько символов в каждом поле.
    // eslint-disable-next-line no-console
    console.log('[broadcasts.save] subject=', JSON.stringify(subject), 'liveText.length=', liveText.length, 'plain.length=', plain.length, 'plain.first40=', plain.slice(0, 40))
    if (!plain) {
      // Если есть subject — рассылка осмысленна (subject пойдёт в TG/email),
      // но мы всё равно требуем body, чтобы не слать пустые письма.
      errs.push(subject
        ? `Тело сообщения пустое (введён только заголовок «${subject.slice(0, 40)}»). Заполните основной текст под заголовком.`
        : 'Тело сообщения пустое. Введите текст рассылки в редакторе.'
      )
    }
    if (htmlErrors.length > 0) {
      errs.push('Telegram не примет такие HTML-теги: ' + htmlErrors.map(e => '«' + e + '»').join(', '))
    }
    if (buttons.length > 3) errs.push('Максимум 3 кнопки')
    if (hasButtonErrors) {
      buttonErrors.forEach((bErrs, i) => {
        bErrs.forEach(e => errs.push(`Кнопка ${i + 1}: ${e}`))
      })
    }
    setFormErrors(errs)
    if (errs.length > 0) return
    // «Немедленно» = текущее московское время минус минуту (чтобы fire_at точно
    // был ≤ NOW() и планировщик взял рассылку на ближайшем тике, тикает раз в минуту).
    const fireAtToSend = sendMode === 'now' ? nowMoscowMinus1MinLocal() : fireAt

    setSaving(true)
    try {
      const payload: any = {
        fire_at: fireAtToSend,
        text: liveText,
        subject: subject || null,
        photo_url: media.media_type === 'photo' ? media.photo_url : null,
        video_url: media.media_type === 'video' ? media.video_url : null,
        media_type: media.media_type,
        buttons: buttons.filter(b => b.text && b.url),
        is_test: isTest,
        // Общие/личные чаты — только с фичей broadcast_chats. Без неё — принудительно false.
        send_to_client_chats: hasChatsFeature ? sendToClientChats : false,
        send_to_private_chats: hasChatsFeature ? sendToPrivateChats : false,
      }
      // target_channel_ids передаём только когда picker уже отрисовался
      // (после useEffect он точно перешёл из null в массив).
      if (targetChannels !== null) {
        payload.target_channel_ids = targetChannels
      }
      payload.audience_tags_include = tagsInclude
      payload.audience_tags_exclude = tagsExclude
      if (isEdit) {
        await api.broadcasts.update(props.editId!, payload)
      } else {
        await api.broadcasts.addCustom(payload)
      }
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
          <h3 className="font-semibold text-gray-800">{isEdit ? 'Редактирование рассылки' : 'Произвольная рассылка'}</h3>
          <button onClick={props.onClose}><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div className="text-xs bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-blue-800">
            Получатели: вся ваша база контактов (Telegram + VK + MAX — каждый получит через ту платформу, на которую подписан, не отписавшиеся).
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Когда отправить</label>
            <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm mb-2">
              <button type="button" onClick={() => setSendMode('schedule')}
                className={`px-3 py-1.5 ${sendMode === 'schedule' ? 'bg-brand text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                Запланировать
              </button>
              <button type="button" onClick={() => setSendMode('now')}
                className={`px-3 py-1.5 border-l border-gray-200 ${sendMode === 'now' ? 'bg-brand text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                Отправить немедленно
              </button>
            </div>
            {sendMode === 'schedule' ? (
              <input type="datetime-local" value={fireAt} onChange={e => setFireAt(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            ) : (
              <p className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                Рассылка встанет в очередь и уйдёт в течение минуты после сохранения.
              </p>
            )}
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Медиа (опционально) — фото или видео</label>
            <BroadcastMediaPicker value={media} onChange={setMedia} />
            <p className="text-[11px] text-gray-400 mt-1">
              Медиа авто-удалится через сутки после отправки рассылки — хранилище не засоряется.
              Видео в Telegram проигрывается прямо в сообщении; в VK/MAX/email — ссылкой.
            </p>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Заголовок (опционально)</label>
            <input
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Тема для email + жирная первая строка для TG/VK/MAX"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400"
            />
            <p className="text-[11px] text-gray-500 mt-1 leading-snug">
              В email становится темой письма. В Telegram/VK/MAX — первая жирная строка перед основным текстом.
            </p>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Текст (можно {'{first_name}'} — подставится имя)</label>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Привет, {first_name}! ..."
              rows={10}
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm leading-relaxed font-sans"
              style={{ resize: 'vertical', minHeight: '200px' }}
            />
            <div className="text-xs text-gray-500 mt-1">
              Длина: {(text || '').trim().length} символов. HTML-теги Telegram: &lt;b&gt;, &lt;i&gt;, &lt;u&gt;, &lt;a href&gt;
            </div>
            <p className="text-xs text-gray-400 mt-1">Жирный, курсив, подчёркивание и ссылки. Telegram примет это форматирование как есть. Для VK теги срежутся, останется только текст и ссылки.</p>
            {htmlErrors.length > 0 && (
              <div className="mt-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 space-y-0.5">
                <p className="text-xs font-semibold text-red-700">⚠ Ошибки в HTML — Telegram не примет такое сообщение:</p>
                {htmlErrors.map((err, i) => (
                  <p key={i} className="text-xs text-red-700">• {err}</p>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Кнопки (до 3, опционально)</label>
            <div className="space-y-2">
              {buttons.map((b, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <input type="text" value={b.text} placeholder="Что написано на кнопке"
                        onChange={e => setButtons(buttons.map((x, j) => j === i ? { ...x, text: e.target.value } : x))}
                        className={`w-full px-3 py-2 border rounded-lg text-sm ${buttonErrors[i].some(er => er.toLowerCase().includes('текст')) ? 'border-red-300 bg-red-50/30' : 'border-gray-200'}`} />
                      <p className="text-[10px] text-gray-400 mt-0.5 ml-1">текст кнопки</p>
                    </div>
                    <div className="flex-1">
                      <input type="url" value={b.url} placeholder="https://example.com"
                        autoComplete="off" autoCorrect="off" spellCheck={false}
                        onChange={e => setButtons(buttons.map((x, j) => j === i ? { ...x, url: e.target.value } : x))}
                        className={`w-full px-3 py-2 border rounded-lg text-sm font-mono ${buttonErrors[i].some(er => er.toLowerCase().includes('ссылк') || er.toLowerCase().includes('url')) ? 'border-red-300 bg-red-50/30' : 'border-gray-200'}`} />
                      <p className="text-[10px] text-gray-400 mt-0.5 ml-1">URL — куда ведёт кнопка</p>
                    </div>
                    <button onClick={() => setButtons(buttons.filter((_, j) => j !== i))}
                      className="p-1.5 text-red-400 hover:text-red-600 mt-1">
                      <X size={16} />
                    </button>
                  </div>
                  {buttonErrors[i].length > 0 && (
                    <div className="ml-1 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 space-y-0.5">
                      {buttonErrors[i].map((er, k) => (
                        <p key={k} className="text-xs text-red-700">⚠ {er}</p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {buttons.length < 3 && (
                <button onClick={() => setButtons([...buttons, { text: '', url: '' }])}
                  className="text-xs text-indigo-600 hover:text-indigo-800">+ Добавить кнопку</button>
              )}
            </div>
          </div>
          <BroadcastChannelPicker value={targetChannels} onChange={setTargetChannels} />
          <BroadcastTagPicker
            include={tagsInclude} exclude={tagsExclude}
            onChange={(inc, exc) => { setTagsInclude(inc); setTagsExclude(exc) }}
          />
          {hasChatsFeature && (<label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
            <input type="checkbox" checked={sendToClientChats} onChange={e => setSendToClientChats(e.target.checked)}
              className="w-4 h-4 mt-0.5 accent-[#25455D]" />
            <span>
              <span className="block text-sm text-gray-800 font-medium">Отправлять в общие чаты</span>
              <span className="block text-[11px] text-gray-500 mt-0.5">
                В дополнение к базе подписчиков — ещё и в группы/каналы из вашей базы чатов
                (Каналы → «Группы/Каналы для рассылок», без галочки «Личный»).
              </span>
            </span>
          </label>)}
          {hasChatsFeature && (<label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
            <input type="checkbox" checked={sendToPrivateChats} onChange={e => setSendToPrivateChats(e.target.checked)}
              className="w-4 h-4 mt-0.5 accent-[#25455D]" />
            <span>
              <span className="block text-sm text-gray-800 font-medium">Отправлять в личные каналы</span>
              <span className="block text-[11px] text-gray-500 mt-0.5">
                В каналы из базы чатов, помеченные галочкой «Личный».
              </span>
            </span>
          </label>)}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isTest} onChange={e => setIsTest(e.target.checked)} className="rounded" />
            <span className="text-sm text-gray-600">Тестовая рассылка (только тестовым TG / VK / MAX / Email из настроек)</span>
          </label>
        </div>
        {formErrors.length > 0 && (
          <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            <div className="font-semibold mb-1">Не получается поставить в очередь:</div>
            <ul className="list-disc pl-5 space-y-1">
              {formErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}
        <button onClick={sendTestNow} disabled={testing || htmlErrors.length > 0 || hasButtonErrors}
          className="w-full mt-4 py-2 rounded-xl text-sm font-medium border border-indigo-300 text-indigo-700 hover:bg-indigo-50 disabled:opacity-60">
          {testing ? 'Отправляю тест...' : '🧪 Отправить тестовую рассылку немедленно'}
        </button>
        {testMsg && (
          <p className={`text-xs mt-2 text-center rounded-lg px-3 py-2 ${
            testMsg.startsWith('✅')
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {testMsg}
          </p>
        )}
        <p className="text-[11px] text-gray-400 mt-1 text-center">Уйдёт сразу на ваши тестовые Telegram/VK/MAX/Email из настроек (Настройки → Технические).</p>
        <div className="flex gap-2 mt-3">
          <button onClick={save} disabled={saving}
            className="flex-1 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-60"
            style={{
              background: htmlErrors.length > 0 || hasButtonErrors
                ? 'linear-gradient(45deg,#c0392b,#7d1f15)'   // красный — при проблемах
                : 'linear-gradient(45deg,#25455D,#0a1520)',
            }}>
            {saving
              ? 'Сохраняю...'
              : htmlErrors.length > 0 ? `Исправьте HTML (${htmlErrors.length})`
              : hasButtonErrors ? 'Исправьте кнопки'
              : (isEdit ? 'Сохранить изменения' : 'Поставить в очередь')}
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
  const isTest = false   // тест убран из UI — создаём черновики, тест клиент делает сам
  // enqueue=false → черновики (по умолчанию), true → сразу в очередь (отправятся по времени).
  const [enqueue, setEnqueue] = useState(false)
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<{ index: number; errors: string[] }[]>([])
  const [preview, setPreview] = useState<any[] | null>(null)
  const [report, setReport] = useState<{ created: number; warnings: { index: number; message: string }[] } | null>(null)

  function convertDateToIso(s: string): string {
    s = s.trim()
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s
    const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/)
    if (!m) return ''
    const [, d, mo, y, h, mi] = m
    return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${mi}:00`
  }

  function parse(): any[] {
    // Разделитель блоков — строка из звёздочек (***). Тире (---) можно использовать в тексте.
    const chunks = raw.split(/^\s*\*\*\*+\s*$/m).map(c => c.trim()).filter(Boolean)
    const items: any[] = []
    for (const chunk of chunks) {
      const lines = chunk.split('\n')
      let fire_at = ''
      let photo_url = ''
      let subject = ''
      let aud_in: string | null = null
      let aud_ex: string | null = null
      let chat_client = false
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
        if (/^(ВКЛЮЧИТЬ|БАЗА|АУДИТОРИЯ):/i.test(trimmed)) {
          section = 'none'
          const v = trimmed.replace(/^(ВКЛЮЧИТЬ|БАЗА|АУДИТОРИЯ):\s*/i, '').trim().toLowerCase()
          // У общих рассылок основа всегда «вся база клиента». Спец-варианты на будущее.
          if (/зарег/.test(v) && !/незарег/.test(v)) aud_in = 'registered_event'
          else aud_in = 'all_client'
          continue
        }
        if (/^(ИСКЛЮЧИТЬ|КРОМЕ):/i.test(trimmed)) {
          section = 'none'
          const v = trimmed.replace(/^(ИСКЛЮЧИТЬ|КРОМЕ):\s*/i, '').trim().toLowerCase()
          if (/незарег/.test(v)) aud_ex = 'unregistered_event'
          else if (/зарег/.test(v)) aud_ex = 'registered_event'
          else aud_ex = 'none'
          continue
        }
        if (/^ЧАТЫ:/i.test(trimmed)) {
          section = 'none'
          const v = trimmed.replace(/^ЧАТЫ:\s*/i, '').trim().toLowerCase()
          chat_client = /да|yes|вкл|on|чат|рассыл|клиент|общ/.test(v)
          continue
        }
        if (/^ФОТО:/i.test(trimmed)) {
          section = 'none'
          photo_url = trimmed.replace(/^ФОТО:\s*/i, '').trim()
          continue
        }
        if (/^(ЗАГОЛОВОК|ТЕМА):/i.test(trimmed)) {
          section = 'none'
          subject = trimmed.replace(/^(ЗАГОЛОВОК|ТЕМА):\s*/i, '').trim()
          continue
        }
        if (/^ТЕКСТ:\s*$/i.test(trimmed)) { section = 'text'; continue }
        if (/^КНОПКИ:\s*$/i.test(trimmed)) { section = 'buttons'; continue }
        if (section === 'text') text_lines.push(line)
        else if (section === 'buttons' && trimmed) {
          if (/^(нет|—|-|none)\s*$/i.test(trimmed)) continue
          const parts = trimmed.split('|').map(x => x.trim())
          if (parts.length >= 2) buttons.push({ text: parts[0], url: parts[1] })
          else buttons.push({ text: parts[0] || '', url: '' })
        }
      }
      items.push({
        fire_at,
        photo_url: photo_url || null,
        subject: subject || null,
        text: text_lines.join('\n').trim(),
        buttons,
        audience_include: aud_in,
        audience_exclude: aud_ex,
        send_to_client_chats: chat_client,
      })
    }
    return items
  }

  function validateLocally(items: any[]): { index: number; errors: string[] }[] {
    // Клиентская проверка HTML и кнопок — чтобы видеть ошибки до отправки на бэкенд
    const out: { index: number; errors: string[] }[] = []
    for (let i = 0; i < items.length; i++) {
      const errs: string[] = []
      const htmlErrs = validateTelegramHtml(items[i].text || '')
      errs.push(...htmlErrs.map(e => `текст: ${e}`))
      for (let bi = 0; bi < (items[i].buttons || []).length; bi++) {
        const b = items[i].buttons[bi]
        const bErrs = validateButton(b.text, b.url)
        errs.push(...bErrs.map(e => `кнопка #${bi + 1}: ${e}`))
      }
      if (errs.length > 0) out.push({ index: i + 1, errors: errs })
    }
    return out
  }

  async function validate() {
    setValidating(true); setErrors([]); setPreview(null)
    try {
      const items = parse()
      if (items.length === 0) {
        props.onError('Не найдено ни одной задачи (разделитель — строка ***)')
        return
      }
      const localErrors = validateLocally(items)
      if (localErrors.length > 0) {
        setErrors(localErrors)
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
      const localErrors = validateLocally(items)
      if (localErrors.length > 0) {
        setErrors(localErrors)
        props.onError(`HTML-ошибки в ${localErrors.length} задачах — исправьте перед отправкой`)
        return
      }
      const res = await api.broadcasts.bulkAdd({ items, is_test: isTest, dry_run: false, enqueue })
      if (!res.ok) {
        setErrors(res.errors || [])
        props.onError(`Ошибки в ${res.errors.length} задачах — исправьте`)
      } else {
        const warnings = res.warnings || []
        if (warnings.length > 0) setReport({ created: res.created || 0, warnings })
        else props.onSaved(res.created || 0)
      }
    } catch (e: any) {
      props.onError(e.message || 'Ошибка')
    } finally { setSaving(false) }
  }

  const SAMPLE = `***
ВРЕМЯ: 29.04.2026 09:30
ЧАТЫ: чаты для рассылок
ФОТО: https://example.com/photo.jpg
ЗАГОЛОВОК: Скоро запуск нового продукта
ТЕКСТ:
Привет, {first_name}!
Скоро запуск нового продукта.
КНОПКИ:
Подробнее | https://example.com/launch
***
ВРЕМЯ: 29.04.2026 18:00
ТЕКСТ:
Сегодня вечером эфир — приходи!
КНОПКИ: нет
***`

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">Пакетная загрузка рассылок</h3>
          <button onClick={props.onClose}><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div className="text-xs bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-blue-800">
            Получатели: вся ваша база контактов (Telegram + VK + MAX — каждый получит через ту платформу, на которую подписан, не отписавшиеся).
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900">
            <p className="font-semibold mb-1">Формат (разделитель — строка <code className="bg-white px-1 rounded">***</code>):</p>
            <p className="mb-1">1 блок = 1 рассылка. Необязательные строки в блоке:
              <br/>• <b>ЗАГОЛОВОК:</b> (или ТЕМА:) — тема для email + жирная первая строка для TG/VK/MAX
              <br/>• <b>ЧАТЫ:</b> «чаты для рассылок» — слать также в общую базу чатов
              <br/>• <b>КНОПКИ:</b> «нет» либо до 3 строк «Название | ссылка»
              <br/>Создаётся как <b>черновики</b> — отправятся только после запуска очереди.</p>
            <pre className="whitespace-pre-wrap text-[11px] leading-tight">{SAMPLE}</pre>
            <button onClick={() => setRaw(SAMPLE)} className="mt-2 text-indigo-600 hover:text-indigo-800">Вставить пример</button>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Содержимое ({props.tzLabel})</label>
            <textarea value={raw} onChange={e => { setRaw(e.target.value); setErrors([]); setPreview(null); setReport(null) }}
              rows={12}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono" />
          </div>
          <label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
            <input type="checkbox" checked={enqueue} onChange={e => setEnqueue(e.target.checked)}
              className="w-4 h-4 mt-0.5 accent-[#25455D]" />
            <span>
              <span className="block text-sm text-gray-800 font-medium">Сразу поставить в очередь</span>
              <span className="block text-[11px] text-gray-500 mt-0.5">
                {enqueue
                  ? 'Рассылки сразу встанут в очередь и отправятся в указанное время — без ручного запуска.'
                  : 'Сейчас рассылки создаются черновиками — отметите и запустите сами. Включите, чтобы они сразу встали в очередь.'}
              </span>
            </span>
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

          {preview && preview.length > 0 && errors.length === 0 && !report && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 space-y-1">
              <p className="text-sm font-semibold text-green-700">✓ Распарсено {preview.length} задач — всё валидно</p>
              <div className="max-h-40 overflow-y-auto space-y-1 mt-2">
                {preview.map((p, i) => (
                  <div key={i} className="text-xs text-green-900 bg-white/50 rounded px-2 py-1">
                    <b>#{i+1}</b> {p.fire_at} — {p.subject ? <span className="font-semibold">«{p.subject.slice(0, 40)}» </span> : null}{p.text.slice(0, 60)}{p.text.length > 60 ? '…' : ''}
                    {p.send_to_client_chats && <span className="text-gray-500"> +чаты</span>}
                    {p.buttons.length > 0 && <span className="text-gray-500"> · кнопок: {p.buttons.length}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {report && (
            <div className="bg-amber-50 border border-amber-300 rounded-xl p-3 space-y-1">
              <p className="text-sm font-semibold text-amber-800">
                Создано черновиков: {report.created}. Но были проблемы ({report.warnings.length}):
              </p>
              <div className="max-h-48 overflow-y-auto space-y-1 mt-1">
                {report.warnings.map((w, i) => (
                  <div key={i} className="text-xs text-amber-900 bg-white/60 rounded px-2 py-1">
                    <b>Рассылка #{w.index}:</b> {w.message}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-2 mt-5">
          {report ? (
            <button onClick={() => props.onSaved(report.created)}
              className="flex-1 py-2 rounded-xl text-sm font-medium text-white"
              style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
              Готово
            </button>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}
