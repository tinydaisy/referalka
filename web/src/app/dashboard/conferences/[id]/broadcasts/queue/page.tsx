'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import {
  Send, Wand2, XCircle, Play, PlusCircle, Eye, Clock,
  CheckCircle, AlertCircle, Loader2, X, Calendar, Edit2, Trash2, Copy, Users,
  ChevronDown, ChevronRight, FileText, Upload
} from 'lucide-react'
import { api } from '@/lib/api'
import { validateTelegramHtml, validateButton } from '@/lib/validateTelegramHtml'
import FileUploader from '@/components/FileUploader'
import { useMe } from '@/hooks/useMe'

const INCLUDE_LABELS: Record<string, string> = {
  all_event: 'Все уч. конфы',
  registered_event: 'Зарег. уч.',
  all_client: 'Вся база',
}
const EXCLUDE_LABELS: Record<string, string> = {
  none: '',
  registered_event: '− зарег.',
  unregistered_event: '− незарег.',
  all_event: '− все уч. конфы',
}
function audienceLabel(inc: string, exc: string): string {
  const incLabel = INCLUDE_LABELS[inc] || inc
  const excLabel = EXCLUDE_LABELS[exc] || (exc && exc !== 'none' ? `− ${exc}` : '')
  return excLabel ? `${incLabel} ${excLabel}` : incLabel
}

const STATUS_COLOR: Record<string, string> = {
  draft:     'bg-gray-50 border-gray-100',
  pending:   'bg-amber-50 border-amber-200',
  running:   'bg-blue-50 border-blue-200',
  done:      'bg-green-50 border-green-200',
  cancelled: 'bg-gray-50 border-gray-200',
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  draft:     <Edit2 size={13} className="text-gray-400" />,
  pending:   <Clock size={13} className="text-amber-500" />,
  running:   <Loader2 size={13} className="text-blue-500 animate-spin" />,
  done:      <CheckCircle size={13} className="text-green-500" />,
  cancelled: <XCircle size={13} className="text-gray-400" />,
}

const STATUS_LABEL: Record<string, string> = {
  draft:     'Черновик',
  pending:   'Ожидает',
  running:   'Отправляется',
  done:      'Отправлено',
  cancelled: 'Отменена',
}

const TYPE_LABELS: Record<string, string> = {
  pre_conf:               'Анонс знакомства со спикерами',
  '5min_before':          'За 5 минут до старта',
  '30min_before':         'За 30 минут до старта',
  gift:                   'Подарок спикера',
  speaker_intro:          'Знакомство со спикером',
  '2h_before_unreg':      'За 2 часа (не зарег.)',
  '2h_before_reg':        'За 2 часа (зарег.)',
  day_before_09_12_unreg: 'За сутки 09:12 (не зарег.)',
  day_before_09_12_reg:   'За сутки 09:12 (зарег.)',
  day_live:               'Старт эфира',
  day_end:                'Итоги дня',
  custom:                 'Произвольное',
  vip_offer:              'VIP-оффер',
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

// Человекочитаемая причина ошибки доставки
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
  if (low.includes('photo') && low.includes('failed')) return 'Не удалось загрузить фото'
  if (low.includes('wrong file identifier') || low.includes('failed to get http url content')) return 'Битая ссылка на фото'
  if (low.includes('message is too long')) return 'Сообщение слишком длинное'
  // Email-причины недоставки
  if (low.includes('spam')) return 'Письмо отклонено как спам'
  if (low.includes('user unknown') || low.includes('does not exist') || low.includes('no such user') || low.includes('mailbox not found') || low.includes('unknown user')) return 'Такого адреса не существует'
  if (low.includes('mailbox full') || low.includes('out of storage') || low.includes('quota')) return 'Ящик получателя переполнен'
  if (low.includes('greylist') || low.includes('try again')) return 'Временно отложено получателем'
  if (!err) return 'Неизвестная ошибка'
  return err.slice(0, 100)
}

export default function QueuePage() {
  const { id } = useParams()
  const eventId = Number(id)

  const [schedules, setSchedules] = useState<any[]>([])
  const [templates, setTemplates] = useState<any[]>([])
  const [timezone, setTimezone] = useState('Europe/Moscow')
  const [nextPendingData, setNextPendingData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ text: string; type: 'ok' | 'err' } | null>(null)
  const [previewModal, setPreviewModal] = useState<any>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [manualModal, setManualModal] = useState(false)
  // Модалка «Сформировать из программы» — выбор шаблонов галочками.
  const [genModal, setGenModal] = useState(false)
  const [genSelectedIds, setGenSelectedIds] = useState<Set<number>>(new Set())
  const [customModal, setCustomModal] = useState(false)
  // Правка существующей произвольной рассылки (передаём в модалку editSchedule).
  const [editCustomSchedule, setEditCustomSchedule] = useState<any>(null)
  const [bulkModal, setBulkModal] = useState(false)
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set())
  const [fireAtModal, setFireAtModal] = useState<any>(null)   // {schedule}
  const [fireAtValue, setFireAtValue] = useState('')
  const [fireAtError, setFireAtError] = useState('')
  const [isTestValue, setIsTestValue] = useState(false)
  const [editAudienceInclude, setEditAudienceInclude] = useState('all_event')
  const [editAudienceExclude, setEditAudienceExclude] = useState('none')
  const [logModal, setLogModal] = useState<{ schedule: any; rows: any[] } | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [manualForm, setManualForm] = useState({
    template_id: '',
    fire_at: '',
    is_test: false,
    audience_include: 'all_event',
    audience_exclude: 'none',
    session_id: '',   // для speaker_intro, gift, pre_start
    day: '',          // для day_*, day_start_30min_*
  })
  const [confSpeakers, setConfSpeakers] = useState<any[]>([])
  const [confSessions, setConfSessions] = useState<any[]>([])
  const [confDays, setConfDays] = useState<any[]>([])
  const [running, setRunning] = useState(false)

  // Выделение чекбоксами
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [runningSelected, setRunningSelected] = useState(false)

  const load = useCallback(async () => {
    const [tmpl, sched, spk, sess, days] = await Promise.all([
      api.conference.templates.list(eventId),
      api.conference.schedules.list(eventId),
      api.conference.speakers.list(eventId),
      api.conference.sessions.list(eventId),
      api.conference.days.list(eventId),
    ])
    setTemplates(tmpl.templates || [])
    // Сортировка по убыванию даты (новые сверху). Без даты (draft) — в конец.
    const sortedSched = [...(sched.schedules || [])].sort((a: any, b: any) => {
      const av = a.fire_at_iso || a.fire_at || ''
      const bv = b.fire_at_iso || b.fire_at || ''
      if (!av && !bv) return 0
      if (!av) return 1
      if (!bv) return -1
      return av < bv ? 1 : av > bv ? -1 : 0
    })
    setSchedules(sortedSched)
    setTimezone(sched.timezone || 'Europe/Moscow')
    setNextPendingData(sched.next_pending || null)
    setConfSpeakers(spk.speakers || [])
    setConfSessions(sess.sessions || [])
    setConfDays(days.days || [])
    setSelectedIds(new Set())
  }, [eventId])

  useEffect(() => { load() }, [load])

  // Сохраняем свёрнутые дни в localStorage
  useEffect(() => {
    try {
      const key = `queue-collapsed-${eventId}`
      const saved = localStorage.getItem(key)
      if (saved) setCollapsedDays(new Set(JSON.parse(saved)))
    } catch {}
  }, [eventId])
  useEffect(() => {
    try {
      const key = `queue-collapsed-${eventId}`
      localStorage.setItem(key, JSON.stringify([...collapsedDays]))
    } catch {}
  }, [collapsedDays, eventId])

  function toggleDay(date: string) {
    setCollapsedDays(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  async function deleteOne(schedule: any) {
    const label = TYPE_LABELS[schedule.template_type] || schedule.type || '#' + schedule.id
    const msg = schedule.status === 'pending' || schedule.status === 'running'
      ? `Задача «${label}» сейчас ${STATUS_LABEL[schedule.status].toLowerCase()}. Отменить и удалить?`
      : `Удалить задачу «${label}»? Это действие нельзя отменить.`
    if (!confirm(msg)) return
    try {
      if (schedule.status === 'pending' || schedule.status === 'running') {
        try { await api.conference.schedules.cancel(eventId, schedule.id) } catch {}
      }
      await api.conference.schedules.delete(eventId, schedule.id)
      setSchedules(prev => prev.filter(x => x.id !== schedule.id))
      setSelectedIds(prev => { const n = new Set(prev); n.delete(schedule.id); return n })
      showMsg('Задача удалена')
    } catch (e: any) {
      showMsg(e.message, 'err')
    }
  }

  // Авто-обновление раз в 30 сек если есть running
  useEffect(() => {
    const hasRunning = schedules.some(s => s.status === 'running')
    if (!hasRunning) return
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [schedules, load])

  function showMsg(text: string, type: 'ok' | 'err' = 'ok') {
    setMsg({ text, type })
    setTimeout(() => setMsg(null), 5000)
  }

  // Открыть модалку выбора шаблонов (по умолчанию отмечены все).
  function openGenModal() {
    setGenSelectedIds(new Set(templates.map((t: any) => t.id)))
    setGenModal(true)
  }

  async function runGenerate() {
    const ids = Array.from(genSelectedIds)
    if (ids.length === 0) { showMsg('Выберите хотя бы один шаблон', 'err'); return }
    setLoading(true)
    try {
      const res = await api.conference.schedules.generate(eventId, ids)
      await load()
      setGenModal(false)
      showMsg(`Создано ${res.created} рассылок, пропущено ${res.skipped}`)
    } catch (e: any) {
      showMsg(e.message, 'err')
    } finally {
      setLoading(false)
    }
  }

  async function runAll() {
    if (!confirm('Активировать всю очередь? Celery начнёт отправлять по расписанию.')) return
    setRunning(true)
    try {
      const res = await api.conference.schedules.runAll(eventId)
      showMsg(res.message || 'Очередь активирована')
      await load()
    } catch (e: any) {
      showMsg(e.message, 'err')
    } finally {
      setRunning(false)
    }
  }

  async function cancelAll() {
    if (!confirm('Отменить все ожидающие рассылки?')) return
    await api.conference.schedules.cancelAll(eventId)
    await load()
    showMsg('Все ожидающие рассылки отменены')
  }

  async function cancelOne(scheduleId: number) {
    await api.conference.schedules.cancel(eventId, scheduleId)
    setSchedules(prev => prev.map(x => x.id === scheduleId ? { ...x, status: 'cancelled' } : x))
  }

  async function openPreview(schedule: any) {
    setPreviewLoading(true)
    setPreviewModal(null)
    try {
      const res = await api.conference.schedules.preview(eventId, schedule.id)
      setPreviewModal({ ...res, schedule })
    } catch {
      showMsg('Не удалось загрузить превью', 'err')
    } finally {
      setPreviewLoading(false)
    }
  }

  async function openLog(schedule: any) {
    setLogLoading(true)
    try {
      const res = await api.conference.schedules.log(eventId, schedule.id)
      setLogModal({ schedule, rows: res.log || [] })
    } catch { showMsg('Не удалось загрузить лог', 'err') }
    finally { setLogLoading(false) }
  }

  function openFireAt(schedule: any) {
    setFireAtModal(schedule)
    // Предзаполняем существующим временем задачи
    if (schedule.fire_at_iso) {
      const d = new Date(schedule.fire_at_iso)
      const pad = (n: number) => String(n).padStart(2, '0')
      const local = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
      setFireAtValue(local)
    } else {
      setFireAtValue('')
    }
    setIsTestValue(schedule.is_test || false)
    setEditAudienceInclude(schedule.audience_include || 'all_event')
    setEditAudienceExclude(schedule.audience_exclude || 'none')
  }

  async function saveFireAt() {
    if (!fireAtModal) return
    if (!fireAtValue) {
      setFireAtError('Укажите дату и время')
      return
    }
    if (new Date(fireAtValue) <= new Date()) {
      setFireAtError('Время уже прошло — выберите будущее время')
      return
    }
    setFireAtError('')
    try {
      await api.conference.schedules.setFireAt(eventId, fireAtModal.id, {
        fire_at: fireAtValue,
        is_test: isTestValue,
        audience_include: editAudienceInclude,
        audience_exclude: editAudienceExclude,
      })
      setFireAtModal(null)
      await load()
      showMsg('Настройки задачи сохранены')
    } catch (e: any) {
      showMsg(e.message, 'err')
    }
  }

  async function addManual() {
    if (!manualForm.template_id || !manualForm.fire_at) {
      showMsg('Выберите шаблон и укажите время', 'err')
      return
    }
    const tpl = templates.find(t => String(t.id) === manualForm.template_id)
    const tplType = tpl?.type || ''
    const isSpeakerType = ['speaker_intro', 'gift', '5min_before'].includes(tplType)
    const isDayType = tplType.startsWith('day_')
    if (isSpeakerType && !manualForm.session_id) {
      showMsg('Выберите спикера', 'err')
      return
    }
    if (isDayType && !manualForm.day) {
      showMsg('Выберите день', 'err')
      return
    }
    try {
      await api.conference.schedules.addManual(eventId, {
        template_id: Number(manualForm.template_id),
        fire_at: manualForm.fire_at,
        is_test: manualForm.is_test,
        audience_include: manualForm.audience_include,
        audience_exclude: manualForm.audience_exclude,
        ...(isSpeakerType && manualForm.session_id ? { session_id: Number(manualForm.session_id) } : {}),
        ...(isDayType && manualForm.day ? { day: Number(manualForm.day) } : {}),
      })
      setManualModal(false)
      await load()
      showMsg('Рассылка добавлена в очередь')
    } catch (e: any) {
      showMsg(e.message, 'err')
    }
  }

  // Чекбоксы — выбор/снятие
  function toggleSelect(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedIds.size === schedules.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(schedules.map(s => s.id)))
    }
  }

  // Удаление выбранных
  async function deleteSelected() {
    const selected = schedules.filter(s => selectedIds.has(s.id))
    const activeOnes = selected.filter(s => s.status === 'pending' || s.status === 'running')
    const hasActive = activeOnes.length > 0

    let confirmMsg = `Удалить ${selected.length} рассылок? Это действие нельзя отменить.`
    if (hasActive) {
      const activeLabels = activeOnes.map(s => `#${schedules.indexOf(s)+1} "${TYPE_LABELS[s.template_type] || s.type}" (${STATUS_LABEL[s.status]})`).join(', ')
      confirmMsg = `Среди выбранных есть ${activeOnes.length} запущенных рассылок:\n${activeLabels}\n\nОни будут отменены и удалены. Продолжить?`
    }
    if (!confirm(confirmMsg)) return

    setDeleting(true)
    // Сначала отменяем активные
    for (const s of activeOnes) {
      try {
        await api.conference.schedules.cancel(eventId, s.id)
      } catch {}
    }
    let deletedCount = 0
    for (const s of selected) {
      try {
        await api.conference.schedules.delete(eventId, s.id)
        setSchedules(prev => prev.filter(x => x.id !== s.id))
        setSelectedIds(prev => { const n = new Set(prev); n.delete(s.id); return n })
        deletedCount++
      } catch (e: any) {
        showMsg(`Ошибка удаления #${s.id}: ${e.message}`, 'err')
      }
    }
    setDeleting(false)
    if (deletedCount > 0) showMsg(`Удалено ${deletedCount} рассылок`)
  }

  async function runSelected() {
    const ids = [...selectedIds]
    const selected = schedules.filter(s => ids.includes(s.id))
    const hasDraft = selected.some(s => s.status === 'draft')
    if (!hasDraft) {
      alert('Среди выбранных нет задач в статусе "Черновик". Запустить можно только черновики.')
      return
    }
    const drafts = selected.filter(s => s.status === 'draft')
    const pastDrafts = drafts.filter(s => s.fire_at_iso && new Date(s.fire_at_iso) <= new Date())
    if (pastDrafts.length > 0) {
      alert(`${pastDrafts.length} задач(и) имеют прошедшее время и не будут запущены. Сначала установите им актуальное время.`)
      return
    }
    const noDrafts = drafts.filter(s => !s.fire_at_iso)
    if (noDrafts.length > 0) {
      alert(`${noDrafts.length} задач(и) без времени отправки. Сначала задайте время через кнопку редактирования.`)
      return
    }
    if (!confirm(`Запустить ${drafts.length} рассылок?\n\nПосле запуска можно отменить любую из них (значок ✕ справа на задаче).`)) return
    setRunningSelected(true)
    try {
      const r = await api.conference.schedules.runSelected(eventId, ids)
      showMsg(`Запущено ${r.queued} рассылок — Celery отправит их по расписанию. Чтобы отменить — кликните ✕ справа на задаче.`)
      await load()
      setSelectedIds(new Set())
    } catch (e: any) {
      showMsg(e.message, 'err')
    } finally {
      setRunningSelected(false)
    }
  }

  const pendingCount = schedules.filter(s => s.status === 'pending' || s.status === 'draft').length
  const nullFireCount = schedules.filter(s => s.status === 'draft' && !s.fire_at).length
  const doneCount = schedules.filter(s => s.status === 'done').length
  // Пересчитываем из актуального списка schedules (обновляется при удалении без reload)
  const nextPending = schedules
    .filter(s => s.status === 'pending' && s.fire_at_iso && new Date(s.fire_at_iso) > new Date())
    .sort((a, b) => (a.fire_at_iso || '') < (b.fire_at_iso || '') ? -1 : 1)[0] || null

  // Форматируем timezone для отображения
  const tzLabel = timezone === 'Europe/Moscow' ? 'МСК (UTC+3)' : timezone

  return (
    <div>
      {/* ── Статусная плашка наверху ── */}
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
          {nextPending && nextPending.fire_at_local && (
            <div className="ml-auto flex items-center gap-1.5 text-xs bg-amber-50 border border-amber-200 rounded-xl px-3 py-1.5">
              <Clock size={12} className="text-amber-500" />
              <span className="text-amber-700 font-medium">
                Ближайшая: {nextPending.fire_at_local} {tzLabel} — {TYPE_LABELS[nextPending.template_type] || nextPending.template_type}
                {nextPending.seconds_until != null && ` (через ${formatTimeLeft(nextPending.seconds_until)})`}
              </span>
            </div>
          )}
        </div>

        {/* Легенда статусов */}
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-500 border-t border-gray-100 pt-3">
          <span className="flex items-center gap-1"><Edit2 size={11} className="text-gray-400" /> Черновик (не запущено)</span>
          <span className="flex items-center gap-1"><Clock size={11} className="text-amber-500" /> Ожидает отправки</span>
          <span className="flex items-center gap-1"><Loader2 size={11} className="text-blue-500" /> Отправляется сейчас</span>
          <span className="flex items-center gap-1"><CheckCircle size={11} className="text-green-500" /> Отправлено (показывает кол-во получателей)</span>
          <span className="flex items-center gap-1"><XCircle size={11} className="text-gray-400" /> Отменена</span>
        </div>
      </div>

      {/* ── Предупреждение если есть speaker_intro без времени ── */}
      {nullFireCount > 0 && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-2 text-sm text-amber-800">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <span>
            У <b>{nullFireCount}</b> рассылок не задано время отправки («Знакомство со спикером»).
            Нажмите <b>«Задать время»</b> рядом с ними перед запуском очереди.
          </span>
        </div>
      )}

      {msg && (
        <div className={`mb-4 text-sm rounded-xl px-4 py-3 flex items-center gap-2 ${
          msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
        }`}>
          {msg.type === 'ok' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {msg.text}
        </div>
      )}

      {/* ── Кнопки управления ── */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {pendingCount > 0 && (
          <button onClick={cancelAll}
            className="flex items-center gap-2 px-3 py-2 border border-red-200 rounded-xl text-sm text-red-500 hover:bg-red-50">
            <XCircle size={14} /> Отменить все
          </button>
        )}
        {selectedIds.size > 0 && (
          <>
            <button onClick={runSelected} disabled={runningSelected}
              className="flex items-center gap-2 px-3 py-2 border border-green-300 rounded-xl text-sm text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">
              <Play size={14} /> {runningSelected ? 'Запускаем...' : `Запустить выбранные (${selectedIds.size})`}
            </button>
            <button onClick={deleteSelected} disabled={deleting}
              className="flex items-center gap-2 px-3 py-2 border border-red-300 rounded-xl text-sm text-white bg-red-500 hover:bg-red-600 disabled:opacity-50">
              <Trash2 size={14} /> {deleting ? 'Удаляем...' : `Удалить выбранные (${selectedIds.size})`}
            </button>
          </>
        )}
        <button onClick={() => setManualModal(true)}
          className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50">
          <PlusCircle size={14} /> По шаблону
        </button>
        <button onClick={() => setCustomModal(true)}
          className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50">
          <FileText size={14} /> Произвольное
        </button>
        <button onClick={() => setBulkModal(true)}
          className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50">
          <Upload size={14} /> Пакетом
        </button>
        <button onClick={openGenModal} disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm text-white font-medium disabled:opacity-50"
          style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
          <Wand2 size={14} /> {loading ? 'Создаю...' : 'Сформировать из программы'}
        </button>
      </div>

      {/* ── Список очереди ── */}
      {schedules.length === 0 ? (
        <div className="py-16 text-center text-gray-400 bg-white rounded-2xl border border-gray-100">
          <Send size={32} className="mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">Очередь пуста</p>
          <p className="text-xs mt-1">Нажмите «Сформировать из программы» — рассылки встанут в очередь автоматически</p>
        </div>
      ) : (
        <>
          {/* Шапка с «выбрать все» */}
          <div className="flex items-center gap-2 mb-2 px-1">
            <input
              type="checkbox"
              checked={selectedIds.size === schedules.length && schedules.length > 0}
              onChange={toggleSelectAll}
              className="rounded cursor-pointer"
              title="Выбрать все"
            />
            <span className="text-xs text-gray-400">Выбрать все</span>
          </div>

          <div className="space-y-2 mb-6">
            {schedules.map((s, idx) => {
              // Разделитель дня: показываем если fire_at_local другой даты чем у предыдущей записи
              const prevDate = idx > 0 && schedules[idx - 1].fire_at_local
                ? schedules[idx - 1].fire_at_local.split(' ')[0]
                : null
              const curDate = s.fire_at_local ? s.fire_at_local.split(' ')[0] : '__no_date__'
              const showDayDivider = curDate && curDate !== prevDate

              // Форматируем дату в читаемый вид: "22 апр", "23 апр" и т.д.
              const RU_SHORT_MONTHS: Record<string, string> = {
                '01': 'янв', '02': 'фев', '03': 'мар', '04': 'апр',
                '05': 'май', '06': 'июн', '07': 'июл', '08': 'авг',
                '09': 'сен', '10': 'окт', '11': 'ноя', '12': 'дек',
              }
              let dividerLabel = curDate === '__no_date__' ? 'Без даты' : (curDate || '')
              if (curDate && curDate !== '__no_date__') {
                const parts = curDate.split('-') // ['2026','04','22']
                if (parts.length === 3) {
                  dividerLabel = `${parseInt(parts[2])} ${RU_SHORT_MONTHS[parts[1]] || parts[1]}`
                }
              }

              const isCollapsed = collapsedDays.has(curDate)
              // Сколько задач в этой группе
              const dayCount = schedules.filter(x => (x.fire_at_local ? x.fire_at_local.split(' ')[0] : '__no_date__') === curDate).length

              return (
              <div key={s.id}>
              {showDayDivider && (
                <button
                  onClick={() => toggleDay(curDate)}
                  className="w-full flex items-center gap-3 py-2 mt-2 text-left group">
                  <div className="flex-1 h-px bg-gray-200" />
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide group-hover:text-gray-700">
                    {isCollapsed
                      ? <ChevronRight size={14} className="text-gray-400" />
                      : <ChevronDown size={14} className="text-gray-400" />}
                    {dividerLabel}
                    <span className="text-gray-400 font-normal normal-case">({dayCount})</span>
                  </span>
                  <div className="flex-1 h-px bg-gray-200" />
                </button>
              )}
              {!isCollapsed && (
              <div
                className={`rounded-xl border p-3.5 ${STATUS_COLOR[s.status] || 'bg-white border-gray-100'} ${selectedIds.has(s.id) ? 'ring-2 ring-blue-300' : ''}`}>
                <div className="flex items-start justify-between gap-3">
                  {/* Чекбокс */}
                  <div className="flex items-center pt-0.5 shrink-0">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(s.id)}
                      onChange={() => toggleSelect(s.id)}
                      className="rounded cursor-pointer"
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    {/* Строка 1: номер + статус + тип */}
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-xs text-gray-400 font-mono" title="Номер рассылки в системе">#{s.id}</span>
                      <span className="flex items-center gap-1 text-xs font-medium text-gray-700">
                        {STATUS_ICON[s.status]}
                        {STATUS_LABEL[s.status] || s.status}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-white/80 border border-gray-200 text-gray-600">
                        {TYPE_LABELS[s.template_type] || s.type}
                      </span>
                      {s.is_test && (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium border border-purple-200">
                          ТЕСТ
                          <span className="relative group cursor-default">
                            <span className="text-purple-400">?</span>
                            <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 w-56 bg-gray-800 text-white text-xs rounded-lg px-2 py-1.5 hidden group-hover:block z-50 pointer-events-none shadow-lg">
                              Уйдёт только тем из тестовых аккаунтов, кто входит в выбранную аудиторию
                            </span>
                          </span>
                        </span>
                      )}
                      {/* Аудитория */}
                      <span className="text-xs text-gray-400">
                        {audienceLabel(s.audience_include || 'all_event', s.audience_exclude || 'none')}
                      </span>
                    </div>

                    {/* Строка 2: спикер + тема */}
                    {(s.speaker_name || s.session_title) && (
                      <div className="flex items-center gap-2 text-xs text-gray-600 mb-1">
                        {s.speaker_name && <span className="font-medium">{s.speaker_name}</span>}
                        {s.session_title && <span className="text-gray-400 truncate max-w-[220px]">{s.session_title}</span>}
                      </div>
                    )}

                    {/* Заголовок + превью текста (как в общих рассылках) */}
                    {s.snapshot_subject && (
                      <p className="text-sm font-semibold text-gray-900 mb-0.5 truncate">{s.snapshot_subject}</p>
                    )}
                    {(() => {
                      const preview = (s.snapshot_text || '').replace(/\s+/g, ' ').trim().slice(0, 80)
                      return preview ? (
                        <p className="text-sm text-gray-700 mb-1 truncate">{preview}{(s.snapshot_text || '').length > 80 ? '…' : ''}</p>
                      ) : null
                    })()}

                    {/* Строка 3: время */}
                    <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                      {s.fire_at_local ? (
                        <span className={`font-medium ${s.is_overdue ? 'text-red-700' : 'text-gray-700'}`}>
                          {s.fire_at_local} {tzLabel}
                        </span>
                      ) : (
                        <span className="text-amber-600 font-medium">⚠ Время не задано</span>
                      )}
                      {s.seconds_until != null && s.status === 'pending' && s.fire_at_local && (
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
                    {/* Overdue + ЧЕРНОВИК — реально не уйдёт сама, пока не запустить очередь. */}
                    {s.is_overdue && s.status === 'draft' && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-red-700 bg-red-50 border border-red-300 rounded-lg px-2.5 py-1.5">
                        <AlertCircle size={12} className="shrink-0" />
                        <span>⚠️ Время прошло, а рассылка в черновике. Запустите очередь (или перенесите время / отмените).</span>
                      </div>
                    )}
                    {/* Overdue + ОЖИДАЕТ (очередь запущена) — Celery подхватит в ближайшую
                        минуту, отправится. Не пугаем «не отправится». */}
                    {s.is_overdue && s.status === 'pending' && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                        <AlertCircle size={12} className="shrink-0" />
                        <span>⏳ Время наступило — отправляется в ближайшую минуту.</span>
                      </div>
                    )}
                    {/* Предупреждение если running слишком долго */}
                    {s.status === 'running' && s.seconds_running != null && s.seconds_running > 300 && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
                        <AlertCircle size={12} className="shrink-0" />
                        <span>Задача висит больше {Math.floor(s.seconds_running / 60)} мин — возможно воркер упал. Нажмите «Перезапустить».</span>
                      </div>
                    )}
                  </div>

                  {/* Количество получателей (только done) */}
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
                              Не доставлено {(s.recipients_failed || 0) + (s.recipients_bounced || 0)} получателям. Нажмите «список» — увидите разбивку по причинам (письмо отклонено как спам, адрес не существует, бот заблокирован, и т.д.).
                            </div>
                          </div>
                        )}
                      </div>
                      {s.duration_seconds != null && (
                        <div className="text-xs text-gray-400 mt-0.5 text-right">{formatDuration(s.duration_seconds)}</div>
                      )}
                      <button
                        onClick={() => openLog(s)}
                        disabled={logLoading}
                        className="flex items-center gap-0.5 text-xs text-indigo-500 hover:text-indigo-700 mt-0.5 ml-auto">
                        <Users size={10} /> список
                      </button>
                    </div>
                  )}

                  {/* Кнопки действий */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* Копировать */}
                    <button onClick={async () => {
                      try {
                        await api.conference.schedules.copy(eventId, s.id)
                        await load()
                      } catch (e: any) { alert(e.message) }
                    }}
                      className="p-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50"
                      title="Создать копию">
                      <Copy size={13} />
                    </button>
                    {/* Превью */}
                    <button onClick={() => openPreview(s)}
                      className="p-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-white"
                      title="Превью сообщения">
                      {previewLoading ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
                    </button>
                    {/* Задать время (для draft без fire_at) */}
                    {(s.status === 'draft' || s.status === 'pending') && !s.fire_at && (
                      <button onClick={() => openFireAt(s)}
                        className="px-2 py-1 border border-amber-300 rounded-lg text-xs text-amber-700 font-medium hover:bg-amber-50">
                        Задать время
                      </button>
                    )}
                    {/* Редактировать: для произвольной (custom) — полная правка
                        текста/фото/кнопок/времени; для шаблонных — только время. */}
                    {(s.status === 'draft' || s.status === 'pending') && s.fire_at && (
                      <button
                        onClick={() => s.type === 'custom' ? setEditCustomSchedule(s) : openFireAt(s)}
                        className="p-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-white"
                        title={s.type === 'custom' ? 'Редактировать рассылку' : 'Редактировать время'}>
                        <Edit2 size={13} />
                      </button>
                    )}
                    {/* Отмена (для draft, pending, running) */}
                    {(s.status === 'draft' || s.status === 'pending' || s.status === 'running') && (
                      <button onClick={async () => {
                        const label = TYPE_LABELS[s.template_type] || s.type
                        if (s.status === 'running') {
                          if (!confirm(`Рассылка «${label}» сейчас отправляется. Отменить?\n\nУже отправленные сообщения не отозвутся, но дальнейшая отправка остановится при следующем тике.`)) return
                        }
                        try {
                          await api.conference.schedules.cancel(eventId, s.id)
                          setSchedules(prev => prev.map(x => x.id === s.id ? { ...x, status: 'cancelled' } : x))
                          showMsg('Рассылка отменена')
                        } catch (e: any) { showMsg(e.message, 'err') }
                      }}
                        className="p-1.5 border border-red-200 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50"
                        title="Отменить">
                        <XCircle size={13} />
                      </button>
                    )}
                    {/* Перезапустить (только running) */}
                    {s.status === 'running' && (
                      <button onClick={async () => {
                        if (!confirm('Перезапустить рассылку? Задача сбросится в «Ожидает» и Celery запустит её снова на следующей минуте.')) return
                        try {
                          await api.conference.schedules.forceReset(eventId, s.id)
                          await load()
                          showMsg('Задача сброшена — Celery подхватит её через ~минуту')
                        } catch (e: any) { showMsg(e.message, 'err') }
                      }}
                        className="px-2 py-1 border border-orange-300 rounded-lg text-xs text-orange-700 font-medium hover:bg-orange-50"
                        title="Аварийный перезапуск задачи">
                        Перезапустить
                      </button>
                    )}
                    {/* Удалить задачу (всегда доступно) */}
                    <button onClick={() => deleteOne(s)}
                      className="p-1.5 border border-red-200 rounded-lg text-red-400 hover:text-white hover:bg-red-500"
                      title="Удалить задачу">
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

      {/* ── Кнопка ЗАПУСТИТЬ ВСЮ ОЧЕРЕДЬ ── */}
      {pendingCount > 0 && (
        <div className="sticky bottom-4">
          <button onClick={runAll} disabled={running}
            className="w-full py-3.5 rounded-2xl text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-lg disabled:opacity-70"
            style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
            {running
              ? <><Loader2 size={16} className="animate-spin" /> Запускаем...</>
              : <><Play size={16} /> Запустить всю очередь ({pendingCount} рассылок)</>
            }
          </button>
        </div>
      )}

      {/* ── Модалка: установить время отправки ── */}
      {fireAtModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">Настройки задачи</h3>
              <button onClick={() => setFireAtModal(null)}><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Дата и время ({tzLabel})</label>
                <input
                  type="datetime-local"
                  value={fireAtValue}
                  onChange={e => { setFireAtValue(e.target.value); setFireAtError('') }}
                  className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none ${fireAtError ? 'border-red-400 bg-red-50' : 'border-gray-200 focus:border-gray-400'}`}
                />
                {fireAtError && <p className="text-xs text-red-500 mt-1">{fireAtError}</p>}
              </div>
              <div className="border border-gray-100 rounded-xl p-3 bg-gray-50 space-y-2">
                <p className="text-xs font-medium text-gray-600">👥 Аудитория</p>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Включить</label>
                  <select value={editAudienceInclude} onChange={e => setEditAudienceInclude(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="all_event">Все участники конфы</option>
                    <option value="registered_event">Зарегистрированные участники</option>
                    <option value="all_client">Вся база клиента</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Исключить</label>
                  <select value={editAudienceExclude} onChange={e => setEditAudienceExclude(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="none">Никого не исключать</option>
                    <option value="registered_event">Зарегистрированных участников</option>
                    <option value="unregistered_event">Незарегистрированных участников</option>
                    <option value="all_event">Всех участников конфы</option>
                  </select>
                </div>
                <p className="text-xs text-indigo-600 font-medium">
                  Итого: {audienceLabel(editAudienceInclude, editAudienceExclude)}
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={isTestValue} onChange={e => setIsTestValue(e.target.checked)}
                    className="rounded" />
                  <span className="text-sm text-gray-600">Тестовая рассылка</span>
                </label>
                <div className="flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <span className="text-amber-500 text-sm mt-0.5">ℹ️</span>
                  <p className="text-xs text-amber-800">
                    Уйдёт только тем из тестовых аккаунтов, кто входит в выбранную аудиторию.
                    Если тестовый не зарегистрирован как участник — он не получит сообщение.
                  </p>
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={saveFireAt}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                Сохранить
              </button>
              <button onClick={() => setFireAtModal(null)}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Модалка: выбор шаблонов для формирования из программы ── */}
      {genModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-semibold text-gray-800">Сформировать из программы</h3>
              <button onClick={() => setGenModal(false)}><X size={18} /></button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Отметьте, какие шаблоны поставить в очередь. Снятые — пропустим.
            </p>

            <div className="flex items-center justify-between mb-2">
              <button
                onClick={() => setGenSelectedIds(new Set(templates.map((t: any) => t.id)))}
                className="text-xs text-blue-600 hover:underline">Выбрать все</button>
              <button
                onClick={() => setGenSelectedIds(new Set())}
                className="text-xs text-gray-500 hover:underline">Снять все</button>
            </div>

            <div className="space-y-1.5 mb-5 max-h-[50vh] overflow-y-auto">
              {templates.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">Шаблонов нет — создайте на вкладке «Шаблоны»</p>
              ) : templates.map((t: any) => {
                const checked = genSelectedIds.has(t.id)
                return (
                  <label key={t.id}
                    className="flex items-center gap-3 p-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 cursor-pointer">
                    <input type="checkbox" checked={checked}
                      onChange={() => {
                        setGenSelectedIds(prev => {
                          const next = new Set(prev)
                          if (checked) next.delete(t.id); else next.add(t.id)
                          return next
                        })
                      }}
                      className="w-4 h-4 accent-[#25455D]" />
                    <span className="text-sm text-gray-800">{t.name}</span>
                  </label>
                )
              })}
            </div>

            <div className="flex gap-2">
              <button onClick={runGenerate} disabled={loading || genSelectedIds.size === 0}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-50"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                {loading ? 'Создаю…' : `Сформировать (${genSelectedIds.size})`}
              </button>
              <button onClick={() => setGenModal(false)}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">Отмена</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Модалка: добавить вручную ── */}
      {manualModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">Добавить рассылку вручную</h3>
              <button onClick={() => setManualModal(false)}><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Шаблон</label>
                <select
                  value={manualForm.template_id}
                  onChange={e => setManualForm({ ...manualForm, template_id: e.target.value, session_id: '', day: '' })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                  <option value="">— выберите шаблон —</option>
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>

              {/* Выбор спикера — для speaker_intro, gift, 5min_before */}
              {(() => {
                const tpl = templates.find(t => String(t.id) === manualForm.template_id)
                const tplType = tpl?.type || ''
                if (tplType === 'speaker_intro') {
                  // speaker_intro использует conf_speaker_events.id
                  return (
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Спикер</label>
                      <select
                        value={manualForm.session_id}
                        onChange={e => setManualForm({ ...manualForm, session_id: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                        <option value="">— выберите спикера —</option>
                        {[...confSpeakers]
                          .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'))
                          .map(s => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                  )
                }
                if (['gift', '5min_before'].includes(tplType)) {
                  // gift / 5min_before используют conf_sessions.id — показываем сессии со спикером
                  const RU_M: Record<string,string> = {'01':'янв','02':'фев','03':'мар','04':'апр','05':'май','06':'июн','07':'июл','08':'авг','09':'сен','10':'окт','11':'ноя','12':'дек'}
                  const sessionsWithSpeaker = confSessions
                    .filter(s => s.speaker_id && s.speaker_name)
                    .sort((a, b) => (a.speaker_name || '').localeCompare(b.speaker_name || '', 'ru'))
                  return (
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Спикер (выступление)</label>
                      <select
                        value={manualForm.session_id}
                        onChange={e => setManualForm({ ...manualForm, session_id: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                        <option value="">— выберите спикера —</option>
                        {sessionsWithSpeaker.map(s => {
                          let timeLabel = ''
                          if (s.start_time && s.day) {
                            timeLabel = ` — День ${s.day}, ${String(s.start_time).slice(0, 5)} МСК`
                          } else if (s.start_time) {
                            timeLabel = ` — ${String(s.start_time).slice(0, 5)} МСК`
                          } else if (s.day) {
                            timeLabel = ` — День ${s.day}`
                          }
                          return (
                            <option key={s.id} value={s.id}>
                              {s.speaker_name}{timeLabel}
                            </option>
                          )
                        })}
                      </select>
                    </div>
                  )
                }
                if (tplType.startsWith('day_')) {
                  return (
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">День конференции</label>
                      <select
                        value={manualForm.day}
                        onChange={e => setManualForm({ ...manualForm, day: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                        <option value="">— выберите день —</option>
                        {confDays.map(d => {
                          const RU_M: Record<string,string> = {'01':'янв','02':'фев','03':'мар','04':'апр','05':'май','06':'июн','07':'июл','08':'авг','09':'сен','10':'окт','11':'ноя','12':'дек'}
                          let dateLabel = ''
                          if (d.day_date) {
                            const s = d.day_date.toString().slice(0,10).split('-')
                            if (s.length === 3) dateLabel = ` — ${parseInt(s[2])} ${RU_M[s[1]] || s[1]}`
                          }
                          return (
                            <option key={d.day_number} value={d.day_number}>
                              День {d.day_number}{dateLabel}
                            </option>
                          )
                        })}
                      </select>
                    </div>
                  )
                }
                return null
              })()}

              <div>
                <label className="text-xs text-gray-500 mb-1 block">Дата и время ({tzLabel})</label>
                <input type="datetime-local"
                  value={manualForm.fire_at}
                  onChange={e => setManualForm({ ...manualForm, fire_at: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
              </div>
              <div className="border border-gray-100 rounded-xl p-3 bg-gray-50 space-y-2">
                <p className="text-xs font-medium text-gray-600">👥 Аудитория</p>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Включить</label>
                  <select
                    value={manualForm.audience_include}
                    onChange={e => setManualForm({ ...manualForm, audience_include: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="all_event">Все участники конфы</option>
                    <option value="registered_event">Зарегистрированные участники</option>
                    <option value="all_client">Вся база клиента</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Исключить</label>
                  <select
                    value={manualForm.audience_exclude}
                    onChange={e => setManualForm({ ...manualForm, audience_exclude: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="none">Никого не исключать</option>
                    <option value="registered_event">Зарегистрированных участников</option>
                    <option value="unregistered_event">Незарегистрированных участников</option>
                    <option value="all_event">Всех участников конфы</option>
                  </select>
                </div>
                <p className="text-xs text-indigo-600 font-medium">
                  Итого: {audienceLabel(manualForm.audience_include, manualForm.audience_exclude)}
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={manualForm.is_test}
                    onChange={e => setManualForm({ ...manualForm, is_test: e.target.checked })}
                    className="rounded" />
                  <span className="text-sm text-gray-600">Тестовая рассылка</span>
                </label>
                <div className="flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <span className="text-amber-500 text-sm mt-0.5">ℹ️</span>
                  <p className="text-xs text-amber-800">
                    Уйдёт только тем из тестовых аккаунтов, кто входит в выбранную аудиторию.
                    Если тестовый не зарегистрирован как участник — он не получит сообщение.
                  </p>
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={addManual}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                Добавить
              </button>
              <button onClick={() => setManualModal(false)}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Модалка: произвольное сообщение ── */}
      {customModal && (
        <CustomBroadcastModal
          onClose={() => setCustomModal(false)}
          onSaved={async () => { setCustomModal(false); await load(); showMsg('Произвольная рассылка добавлена') }}
          onError={(m) => showMsg(m, 'err')}
          eventId={eventId}
          tzLabel={tzLabel}
        />
      )}

      {/* ── Модалка: правка существующей произвольной рассылки ── */}
      {editCustomSchedule && (
        <CustomBroadcastModal
          editSchedule={editCustomSchedule}
          onClose={() => setEditCustomSchedule(null)}
          onSaved={async () => { setEditCustomSchedule(null); await load(); showMsg('Рассылка обновлена') }}
          onError={(m) => showMsg(m, 'err')}
          eventId={eventId}
          tzLabel={tzLabel}
        />
      )}

      {/* ── Модалка: пакетная загрузка ── */}
      {bulkModal && (
        <BulkBroadcastModal
          onClose={() => setBulkModal(false)}
          onSaved={async (count) => { setBulkModal(false); await load(); showMsg(`Добавлено ${count} рассылок`) }}
          onError={(m) => showMsg(m, 'err')}
          eventId={eventId}
          tzLabel={tzLabel}
        />
      )}

      {/* ── Модалка: лог получателей ── */}
      {logModal && (() => {
        const sentCount = logModal.rows.filter(r => r.status === 'sent').length
        // «Не доставлено» = всё, что не 'sent' (включая bounced — письмо отвергнуто почтой).
        const failed = logModal.rows.filter(r => r.status !== 'sent')
        // Группируем ошибки по тексту
        const reasonMap: Record<string, number> = {}
        for (const r of failed) {
          const reason = humanReason(r.error || 'Письмо не доставлено получателю')
          reasonMap[reason] = (reasonMap[reason] || 0) + 1
        }
        const reasons = Object.entries(reasonMap).sort((a, b) => b[1] - a[1])
        // Разбивка по ботам (channel_handle).
        // Старые строки (до миграции 085) не имеют channel_id — попадают в «Без указания».
        const botMap: Record<string, { sent: number; failed: number }> = {}
        for (const r of logModal.rows) {
          const key = r.channel_handle || r.channel_name || 'Без указания'
          if (!botMap[key]) botMap[key] = { sent: 0, failed: 0 }
          if (r.status === 'sent') botMap[key].sent += 1
          else botMap[key].failed += 1
        }
        const botEntries = Object.entries(botMap).sort((a, b) => (b[1].sent + b[1].failed) - (a[1].sent + a[1].failed))
        return (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 max-h-[85vh] flex flex-col">
            <div className="flex justify-between items-center mb-3">
              <div>
                <h3 className="font-semibold text-gray-800 text-sm">Получатели рассылки</h3>
                <p className="text-xs text-gray-400">
                  Всего: {logModal.rows.length} · <span className="text-green-600">доставлено {sentCount}</span>
                  {failed.length > 0 && <> · <span className="text-red-500">не доставлено {failed.length}</span></>}
                </p>
              </div>
              <button onClick={() => setLogModal(null)}><X size={18} /></button>
            </div>
            {/* Разбивка по ботам */}
            {botEntries.length > 1 || (botEntries.length === 1 && botEntries[0][0] !== 'Без указания') ? (
              <div className="mb-3 bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-1">
                <p className="text-xs font-semibold text-blue-700">По ботам:</p>
                {botEntries.map(([handle, st]) => (
                  <div key={handle} className="flex items-center justify-between text-xs text-blue-800">
                    <span className="truncate flex-1">{handle}</span>
                    <span className="ml-2">
                      <span className="font-bold text-green-700">{st.sent}</span>
                      {st.failed > 0 && <span className="text-red-500"> ✕ {st.failed}</span>}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {/* Статистика по причинам недоставки */}
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
              {logModal.rows.map((r, i) => {
                const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.username || `tg:${r.tg_id}`
                const username = r.username ? `@${r.username}` : ''
                const ok = r.status === 'sent'
                const bot = r.channel_handle || r.channel_name
                return (
                  <div key={i} className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-xs ${ok ? 'bg-gray-50' : 'bg-red-50'}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={ok ? 'text-green-500' : 'text-red-400'}>{ok ? '✓' : '✗'}</span>
                      <span className="font-medium text-gray-800 truncate">{name}</span>
                      {username && <span className="text-gray-400 shrink-0">{username}</span>}
                      {bot && <span className="text-blue-500 shrink-0 text-[10px] bg-blue-50 px-1.5 py-0.5 rounded">{bot}</span>}
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

      {/* ── Модалка: превью сообщения ── */}
      {previewModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800 text-sm">
                Превью: {TYPE_LABELS[previewModal.template_type] || previewModal.template_type}
              </h3>
              <button onClick={() => setPreviewModal(null)}><X size={18} /></button>
            </div>
            {/* Telegram-bubble */}
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
              {previewModal.buttons && previewModal.buttons.length > 0 ? (
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
              ) : previewModal.button_text ? (
                <>
                  <div className="mt-3 w-full py-2 px-3 rounded-xl text-center text-sm font-medium text-blue-600 bg-white border border-gray-200">
                    {previewModal.button_text}
                  </div>
                  {previewModal.button_url && (
                    <p className="text-xs text-gray-400 mt-1 text-center break-all">
                      {previewModal.button_url}
                    </p>
                  )}
                </>
              ) : null}
            </div>
            <p className="text-xs text-gray-400 mt-3 text-center">
              Данные подставлены из БД на момент открытия превью
            </p>
            <button onClick={() => setPreviewModal(null)}
              className="w-full mt-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
              Закрыть
            </button>
          </div>
        </div>
      )}
    </div>
  )
}


// ─── Модалка: произвольное сообщение ─────────────────────────────────────────

function CustomBroadcastModal(props: {
  onClose: () => void
  onSaved: () => void
  onError: (m: string) => void
  eventId: number
  tzLabel: string
  editSchedule?: any   // если задан — режим правки существующей произвольной рассылки
}) {
  const ed = props.editSchedule
  // datetime-local ждёт "YYYY-MM-DDTHH:mm" по локали клиента (МСК).
  const initFireAt = (() => {
    if (!ed?.fire_at) return ''
    try {
      const d = new Date(ed.fire_at)
      // Берём МСК-представление
      const msk = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }))
      const p = (n: number) => String(n).padStart(2, '0')
      return `${msk.getFullYear()}-${p(msk.getMonth() + 1)}-${p(msk.getDate())}T${p(msk.getHours())}:${p(msk.getMinutes())}`
    } catch { return '' }
  })()
  const [fireAt, setFireAt] = useState(initFireAt)
  const [text, setText] = useState(ed?.snapshot_text || '')
  const [photoUrl, setPhotoUrl] = useState(ed?.snapshot_photo || '')
  const [buttons, setButtons] = useState<{text: string; url: string}[]>(
    Array.isArray(ed?.snapshot_buttons) ? ed.snapshot_buttons.map((b: any) => ({ text: b.text || '', url: b.url || '' })) : []
  )
  const [isTest, setIsTest] = useState(!!ed?.is_test)
  const [audIn, setAudIn] = useState(ed?.audience_include || 'all_event')
  const [audEx, setAudEx] = useState(ed?.audience_exclude || 'none')
  const [sendToChats, setSendToChats] = useState(!!ed?.send_to_event_chats)
  const [sendToClientChats, setSendToClientChats] = useState(!!ed?.send_to_client_chats)
  const { me } = useMe()
  const hasChatsFeature = (me?.features || []).includes('broadcast_chats')
  const [saving, setSaving] = useState(false)

  const htmlErrors = validateTelegramHtml(text)
  const buttonErrors = buttons.map(b => validateButton(b.text, b.url))
  const hasButtonErrors = buttonErrors.some(errs => errs.length > 0)

  async function save() {
    if (!fireAt) { props.onError('Укажите дату и время'); return }
    if (!text.trim()) { props.onError('Пустой текст'); return }
    if (htmlErrors.length > 0) { props.onError('Исправьте HTML-ошибки в тексте перед отправкой'); return }
    if (buttons.length > 3) { props.onError('Максимум 3 кнопки'); return }
    if (hasButtonErrors) { props.onError('Исправьте ошибки в кнопках'); return }
    setSaving(true)
    try {
      const payload = {
        fire_at: fireAt,
        text: text,
        photo_url: photoUrl || null,
        buttons: buttons.filter(b => b.text && b.url),
        is_test: isTest,
        audience_include: audIn,
        audience_exclude: audEx,
        send_to_event_chats: sendToChats,
        send_to_client_chats: hasChatsFeature ? sendToClientChats : false,
      }
      if (ed?.id) {
        await api.conference.schedules.editCustom(props.eventId, ed.id, payload)
      } else {
        await api.conference.schedules.addCustom(props.eventId, payload)
      }
      props.onSaved()
    } catch (e: any) {
      props.onError(e.message || 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">{ed?.id ? 'Редактировать рассылку' : 'Произвольная рассылка'}</h3>
          <button onClick={props.onClose}><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Дата и время ({props.tzLabel})</label>
            <input type="datetime-local" value={fireAt} onChange={e => setFireAt(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Фото (опционально)</label>
            <FileUploader
              mode="single"
              value={photoUrl || null}
              onChange={(url) => setPhotoUrl(url || '')}
              kind="broadcast_photo"
              accept="image/*"
              aspectClass="aspect-video"
              emptyText="Перетащите фото или нажмите «Загрузить»"
              buttonLabel="Загрузить фото"
            />
            <p className="text-[11px] text-gray-400 mt-1">
              Фото авто-удалится через 10 минут после отправки рассылки — хранилище не засоряется.
            </p>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Текст (можно {'{first_name}'} — подставится имя)</label>
            <textarea value={text} onChange={e => setText(e.target.value)}
              rows={6}
              placeholder="Привет, {first_name}! ..."
              className={`w-full px-3 py-2 border rounded-lg text-sm font-mono ${htmlErrors.length > 0 ? 'border-red-300 bg-red-50/30' : 'border-gray-200'}`} />
            <p className="text-xs text-gray-400 mt-1">HTML-разметка Telegram: &lt;b&gt;, &lt;i&gt;, &lt;u&gt;, &lt;s&gt;, &lt;code&gt;, &lt;a href="..."&gt;</p>
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
          <div className="border border-gray-100 rounded-xl p-3 bg-gray-50 space-y-2">
            <p className="text-xs font-medium text-gray-600">👥 Аудитория</p>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Включить</label>
              <select value={audIn} onChange={e => setAudIn(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                <option value="all_event">Все участники конфы</option>
                <option value="registered_event">Зарегистрированные участники</option>
                <option value="all_client">Вся база клиента</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Исключить</label>
              <select value={audEx} onChange={e => setAudEx(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                <option value="none">Никого не исключать</option>
                <option value="registered_event">Зарегистрированных участников</option>
                <option value="unregistered_event">Незарегистрированных участников</option>
                <option value="all_event">Всех участников конфы</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isTest} onChange={e => setIsTest(e.target.checked)} className="rounded" />
            <span className="text-sm text-gray-600">Тестовая рассылка (только тестовым Telegram ID)</span>
          </label>
          {/* Галочка «чаты события» убрана — теперь только общие чаты. */}
          {hasChatsFeature && (
            <label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={sendToClientChats} onChange={e => setSendToClientChats(e.target.checked)}
                className="w-4 h-4 mt-0.5 accent-[#25455D]" />
              <span>
                <span className="block text-sm text-gray-800 font-medium">Отправлять в общие чаты</span>
                <span className="block text-[11px] text-gray-500 mt-0.5">
                  Ещё и в группы/каналы из вашей базы чатов (Каналы → «Чаты для рассылок»).
                </span>
              </span>
            </label>
          )}
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={save} disabled={saving || htmlErrors.length > 0 || hasButtonErrors}
            className="flex-1 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-60"
            style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
            {saving ? 'Сохраняю...' : htmlErrors.length > 0 ? 'Исправьте HTML' : hasButtonErrors ? 'Исправьте кнопки' : 'Поставить в очередь'}
          </button>
          <button onClick={props.onClose}
            className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
            Отмена
          </button>
        </div>
      </div>
    </div>
  )
}


// ─── Модалка: пакетная загрузка ───────────────────────────────────────────────

function BulkBroadcastModal(props: {
  onClose: () => void
  onSaved: (count: number) => void
  onError: (m: string) => void
  eventId: number
  tzLabel: string
}) {
  const [raw, setRaw] = useState('')
  // Аудитория/тест больше не редактируются в UI: всё задаётся в тексте блока,
  // создаётся черновиками. Дефолты — fallback, если в блоке базу не указали.
  const isTest = false
  const audIn = 'all_event'
  const audEx = 'none'
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<{ index: number; errors: string[] }[]>([])
  const [preview, setPreview] = useState<any[] | null>(null)
  const [report, setReport] = useState<{ created: number; warnings: { index: number; message: string }[] } | null>(null)

  // Парсер формата (1 блок = 1 сегмент = 1 сообщение):
  // ---
  // ВРЕМЯ: 29.04.2026 09:30
  // ВКЛЮЧИТЬ: Вся база клиента        ← аудитория (названия как в интерфейсе)
  // ИСКЛЮЧИТЬ: Зарегистрированные      ← кого убрать (необязательно)
  // ЧАТЫ: чаты для рассылок            ← слать также в чаты (необязательно)
  // ФОТО: https://...
  // ТЕКСТ:
  //   много строк
  // КНОПКИ:
  // Текст | https://...
  // ---
  function parse(): any[] {
    // Разделитель блоков — строка из звёздочек (***). Тире (---) можно свободно
    // использовать внутри текста как стиль.
    const chunks = raw.split(/^\s*\*\*\*+\s*$/m).map(c => c.trim()).filter(Boolean)
    const items: any[] = []
    for (const chunk of chunks) {
      const lines = chunk.split('\n')
      let fire_at = ''
      let photo_url = ''
      let aud_in: string | null = null
      let aud_ex: string | null = null
      let chat_event = false
      let chat_client = false
      const text_lines: string[] = []
      const buttons: { text: string; url: string }[] = []
      let section: 'none' | 'text' | 'buttons' = 'none'
      for (const line of lines) {
        const trimmed = line.trim()
        if (/^ВРЕМЯ:/i.test(trimmed)) {
          section = 'none'
          fire_at = convertDateToIso(trimmed.replace(/^ВРЕМЯ:\s*/i, '').trim())
          continue
        }
        if (/^(ВКЛЮЧИТЬ|БАЗА|АУДИТОРИЯ):/i.test(trimmed)) {
          section = 'none'
          aud_in = mapAudienceInclude(trimmed.replace(/^(ВКЛЮЧИТЬ|БАЗА|АУДИТОРИЯ):\s*/i, '').trim())
          continue
        }
        if (/^(ИСКЛЮЧИТЬ|КРОМЕ):/i.test(trimmed)) {
          section = 'none'
          aud_ex = mapAudienceExclude(trimmed.replace(/^(ИСКЛЮЧИТЬ|КРОМЕ):\s*/i, '').trim())
          continue
        }
        if (/^ЧАТЫ:/i.test(trimmed)) {
          section = 'none'
          const v = trimmed.replace(/^ЧАТЫ:\s*/i, '').trim().toLowerCase()
          // «чаты события» → event, «чаты для рассылок/клиента» → client, иначе (да/чаты) → оба
          if (/событ/.test(v)) { chat_event = true }
          else if (/рассыл|клиент|общ/.test(v)) { chat_client = true }
          else if (/^(да|yes|вкл|on|чат)/.test(v)) { chat_event = true; chat_client = true }
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
          // «нет» / «-» = кнопок нет
          if (/^(нет|—|-|none)\s*$/i.test(trimmed)) continue
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
        audience_include: aud_in,
        audience_exclude: aud_ex,
        send_to_event_chats: chat_event,
        send_to_client_chats: chat_client,
      })
    }
    return items
  }

  // Русское название аудитории → код сервера (как в выпадашках выше).
  function mapAudienceInclude(s: string): string | null {
    const v = s.toLowerCase()
    if (!v) return null
    if (/вся\s+база|вся\s+аудитор|все\s+контакт|клиент/.test(v)) return 'all_client'
    if (/зарег/.test(v)) return 'registered_event'   // «зарег.», «зарегистрированные»
    if (/все\s+участ|вся\s+конф|все\s+уч/.test(v)) return 'all_event'
    return 'all_event'
  }
  function mapAudienceExclude(s: string): string | null {
    const v = s.toLowerCase()
    if (!v || /^(нет|none|—|-)$/.test(v)) return 'none'
    if (/незарег/.test(v)) return 'unregistered_event'
    if (/зарег/.test(v)) return 'registered_event'
    if (/все\s+участ|вся\s+конф|все\s+уч/.test(v)) return 'all_event'
    return 'none'
  }

  // "29.04.2026 09:30" → "2026-04-29T09:30:00"
  function convertDateToIso(s: string): string {
    s = s.trim()
    // Уже ISO — вернуть как есть
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s
    const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/)
    if (!m) return ''
    const [, d, mo, y, h, mi] = m
    return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${mi}:00`
  }

  function validateLocally(items: any[]): { index: number; errors: string[] }[] {
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
    setValidating(true)
    setErrors([])
    setPreview(null)
    try {
      const items = parse()
      if (items.length === 0) {
        props.onError('Не найдено ни одной задачи (разделитель — строка ***)')
        return
      }
      const localErrors = validateLocally(items)
      if (localErrors.length > 0) { setErrors(localErrors); return }
      const res = await api.conference.schedules.bulkAdd(props.eventId, {
        items,
        is_test: isTest,
        audience_include: audIn,
        audience_exclude: audEx,
        dry_run: true,
      })
      if (res.ok) {
        setPreview(items)
      } else {
        setErrors(res.errors || [])
      }
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
      const res = await api.conference.schedules.bulkAdd(props.eventId, {
        items,
        is_test: isTest,
        audience_include: audIn,
        audience_exclude: audEx,
        dry_run: false,
      })
      if (!res.ok) {
        setErrors(res.errors || [])
        props.onError(`Ошибки в ${res.errors.length} задачах — исправьте их`)
      } else {
        const warnings = res.warnings || []
        if (warnings.length > 0) {
          // Показываем отчёт прямо в модалке — клиент видит, у каких писем не загрузилось фото.
          setReport({ created: res.created || 0, warnings })
        } else {
          props.onSaved(res.created || 0)
        }
      }
    } catch (e: any) {
      props.onError(e.message || 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  const SAMPLE = `***
ВРЕМЯ: 29.04.2026 09:30
ВКЛЮЧИТЬ: Вся база клиента
ИСКЛЮЧИТЬ: Зарегистрированные
ФОТО: https://example.com/photo.jpg
ТЕКСТ:
Привет, {first_name}!
Сегодня стартует День 1 — эфир через 30 минут.
КНОПКИ: нет
***
ВРЕМЯ: 29.04.2026 09:30
ВКЛЮЧИТЬ: Зарег. участники
ЧАТЫ: чаты для рассылок
ТЕКСТ:
Уже начинаем! Заходите в эфир.
КНОПКИ:
Смотреть эфир | https://stream.example.com
Программа | https://example.com/program
***`

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-800">Пакетная загрузка рассылок</h3>
          <button onClick={props.onClose}><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900">
            <p className="font-semibold mb-1">Формат (разделитель — строка <code className="bg-white px-1 rounded">***</code>):</p>
            <p className="mb-1">1 блок = 1 рассылка. Базу можно задать прямо в блоке:
              <br/>• <b>ВКЛЮЧИТЬ:</b> кому слать — «Вся база клиента» / «Зарег. участники» / «Все участники конфы»
              <br/>• <b>ИСКЛЮЧИТЬ:</b> кого убрать (необязательно) — «Зарегистрированные» / «Незарегистрированные»
              <br/>• <b>ЧАТЫ:</b> «чаты для рассылок» или «чаты события» (необязательно)
              <br/>• <b>КНОПКИ:</b> «нет» либо до 3 строк «Название | ссылка»
              <br/>Если в блоке базу не указать — возьмётся выбранная ниже. Всё создаётся как <b>черновики</b>.</p>
            <pre className="whitespace-pre-wrap text-[11px] leading-tight">{SAMPLE}</pre>
            <button onClick={() => setRaw(SAMPLE)} className="mt-2 text-indigo-600 hover:text-indigo-800">Вставить пример</button>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Содержимое ({props.tzLabel})</label>
            <textarea value={raw} onChange={e => { setRaw(e.target.value); setErrors([]); setPreview(null); setReport(null) }}
              rows={12}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono" />
          </div>
          <div className="border border-gray-100 rounded-xl p-3 bg-gray-50 text-xs text-gray-600">
            Аудиторию задавайте прямо в блоке строками <b>ВКЛЮЧИТЬ:</b> / <b>ИСКЛЮЧИТЬ:</b> / <b>ЧАТЫ:</b>.
            Если в блоке не указать — уйдёт всем участникам события. Все рассылки создаются <b>черновиками</b> — отметите и запустите сами.
          </div>

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
              <p className="text-sm font-semibold text-green-700">✓ Распарсено {preview.length} задач — всё валидно, можно создавать</p>
              <div className="max-h-40 overflow-y-auto space-y-1 mt-2">
                {preview.map((p, i) => (
                  <div key={i} className="text-xs text-green-900 bg-white/50 rounded px-2 py-1">
                    <b>#{i+1}</b> {p.fire_at} — {p.text.slice(0, 60)}{p.text.length > 60 ? '…' : ''}
                    <span className="text-gray-500"> · база: {audienceLabel(p.audience_include || audIn, p.audience_exclude || audEx)}</span>
                    {(p.send_to_event_chats || p.send_to_client_chats) && <span className="text-gray-500"> +чаты</span>}
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
              <p className="text-[11px] text-amber-700">Эти рассылки уже в очереди как черновики — откройте их и добавьте фото вручную.</p>
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
                {saving ? 'Создаю...' : 'Создать задачи'}
              </button>
              <button onClick={props.onClose}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                Отмена
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
