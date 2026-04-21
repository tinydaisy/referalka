'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import {
  Send, Wand2, XCircle, Play, PlusCircle, Eye, Clock,
  CheckCircle, AlertCircle, Loader2, X, Calendar, Edit2, Trash2, Copy, Users
} from 'lucide-react'
import { api } from '@/lib/api'

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
  pre_conf:              'Анонс конференции',
  pre_start:             'Анонс спикера',
  gift:                  'Подарок спикера',
  speaker_intro:         'Знакомство со спикером',
  day_start_30min_unreg: 'За 30 мин (не зарег.)',
  day_start_30min_reg:   'За 30 мин (зарег.)',
  day_live:              'Старт эфира',
  day_end:               'Итоги дня',
}

function formatTimeLeft(sec: number): string {
  if (sec > 3600) return `${Math.floor(sec / 3600)}ч ${Math.floor((sec % 3600) / 60)}мин`
  if (sec > 60) return `${Math.floor(sec / 60)} мин`
  return `${sec} сек`
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
  const [confDays, setConfDays] = useState<any[]>([])
  const [running, setRunning] = useState(false)

  // Выделение чекбоксами
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [runningSelected, setRunningSelected] = useState(false)

  const load = useCallback(async () => {
    const [tmpl, sched, spk, days] = await Promise.all([
      api.conference.templates.list(eventId),
      api.conference.schedules.list(eventId),
      api.conference.speakers.list(eventId),
      api.conference.days.list(eventId),
    ])
    setTemplates(tmpl.templates || [])
    setSchedules(sched.schedules || [])
    setTimezone(sched.timezone || 'Europe/Moscow')
    setNextPendingData(sched.next_pending || null)
    setConfSpeakers(spk.speakers || [])
    setConfDays(days.days || [])
    setSelectedIds(new Set())
  }, [eventId])

  useEffect(() => { load() }, [load])

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

  async function generate() {
    setLoading(true)
    try {
      const res = await api.conference.schedules.generate(eventId)
      await load()
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
    const isSpeakerType = ['speaker_intro', 'gift', 'pre_start'].includes(tplType)
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
    const hasActive = selected.some(s => s.status === 'pending' || s.status === 'running')
    if (hasActive) {
      alert('Среди выбранных есть активные рассылки. Сначала остановите их или дождитесь завершения.')
      return
    }
    if (!confirm(`Удалить ${selected.length} рассылок? Это действие нельзя отменить.`)) return
    setDeleting(true)
    let deletedCount = 0
    for (const s of selected) {
      try {
        await api.conference.schedules.delete(eventId, s.id)
        // Убираем строку из UI сразу после успешного удаления
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
    if (!confirm(`Запустить ${drafts.length} рассылок?`)) return
    setRunningSelected(true)
    try {
      const r = await api.conference.schedules.runSelected(eventId, ids)
      alert(`Запущено: ${r.queued} рассылок. Celery отправит их по расписанию.`)
      await load()
      setSelectedIds(new Set())
    } catch (e: any) {
      alert(e.message)
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
          <PlusCircle size={14} /> Добавить вручную
        </button>
        <button onClick={generate} disabled={loading}
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
              const curDate = s.fire_at_local ? s.fire_at_local.split(' ')[0] : null
              const showDayDivider = curDate && curDate !== prevDate

              // Форматируем дату в читаемый вид: "22 апр", "23 апр" и т.д.
              const RU_SHORT_MONTHS: Record<string, string> = {
                '01': 'янв', '02': 'фев', '03': 'мар', '04': 'апр',
                '05': 'май', '06': 'июн', '07': 'июл', '08': 'авг',
                '09': 'сен', '10': 'окт', '11': 'ноя', '12': 'дек',
              }
              let dividerLabel = curDate || ''
              if (curDate) {
                const parts = curDate.split('-') // ['2026','04','22']
                if (parts.length === 3) {
                  dividerLabel = `${parseInt(parts[2])} ${RU_SHORT_MONTHS[parts[1]] || parts[1]}`
                }
              }

              return (
              <div key={s.id}>
              {showDayDivider && (
                <div className="flex items-center gap-3 py-2 mt-2">
                  <div className="flex-1 h-px bg-gray-200" />
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                    {dividerLabel}
                  </span>
                  <div className="flex-1 h-px bg-gray-200" />
                </div>
              )}
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
                      <span className="text-xs text-gray-400 font-mono">#{idx + 1}</span>
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

                    {/* Строка 3: время */}
                    <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                      {s.fire_at_local ? (
                        <span className="font-medium text-gray-700">{s.fire_at_local} {tzLabel}</span>
                      ) : (
                        <span className="text-amber-600 font-medium">⚠ Время не задано</span>
                      )}
                      {s.seconds_until != null && s.status === 'pending' && s.fire_at_local && (
                        <span className="text-amber-600">через {formatTimeLeft(s.seconds_until)}</span>
                      )}
                      {s.error_log && (
                        <span className="text-red-500 truncate max-w-[200px]" title={s.error_log}>⚠ {s.error_log}</span>
                      )}
                    </div>
                  </div>

                  {/* Количество получателей (только done) */}
                  {s.status === 'done' && s.recipients_sent != null && (
                    <div className="shrink-0 text-right">
                      <span className="text-sm font-semibold text-green-700">{s.recipients_sent}</span>
                      <div className="text-xs text-gray-400 leading-tight">чел.</div>
                      <button
                        onClick={() => openLog(s)}
                        disabled={logLoading}
                        className="flex items-center gap-0.5 text-xs text-indigo-500 hover:text-indigo-700 mt-0.5">
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
                    {/* Редактировать настройки (если уже задано время) */}
                    {(s.status === 'draft' || s.status === 'pending') && s.fire_at && (
                      <button onClick={() => openFireAt(s)}
                        className="p-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-white"
                        title="Редактировать">
                        <Edit2 size={13} />
                      </button>
                    )}
                    {/* Отмена (для draft и pending) */}
                    {(s.status === 'draft' || s.status === 'pending') && (
                      <button onClick={() => cancelOne(s.id)}
                        className="p-1.5 border border-red-200 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50"
                        title="Отменить">
                        <XCircle size={13} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
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

              {/* Выбор спикера — для speaker_intro, gift, pre_start */}
              {(() => {
                const tpl = templates.find(t => String(t.id) === manualForm.template_id)
                const tplType = tpl?.type || ''
                if (['speaker_intro', 'gift', 'pre_start'].includes(tplType)) {
                  return (
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Спикер</label>
                      <select
                        value={manualForm.session_id}
                        onChange={e => setManualForm({ ...manualForm, session_id: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                        <option value="">— выберите спикера —</option>
                        {confSpeakers.map(s => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
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

      {/* ── Модалка: лог получателей ── */}
      {logModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 max-h-[80vh] flex flex-col">
            <div className="flex justify-between items-center mb-3">
              <div>
                <h3 className="font-semibold text-gray-800 text-sm">Получатели рассылки</h3>
                <p className="text-xs text-gray-400">{logModal.rows.length} чел.</p>
              </div>
              <button onClick={() => setLogModal(null)}><X size={18} /></button>
            </div>
            <div className="overflow-y-auto flex-1 space-y-1">
              {logModal.rows.length === 0 && (
                <p className="text-sm text-gray-400 text-center py-6">Лог пуст</p>
              )}
              {logModal.rows.map((r, i) => {
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
                      <span className="text-red-400 truncate max-w-[140px] ml-2" title={r.error}>{r.error}</span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

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
              <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed"
                dangerouslySetInnerHTML={{ __html: previewModal.text || '' }} />
              {previewModal.button_text && (
                <div className="mt-3 w-full py-2 px-3 rounded-xl text-center text-sm font-medium text-blue-600 bg-white border border-gray-200">
                  {previewModal.button_text}
                </div>
              )}
              {previewModal.button_url && (
                <p className="text-xs text-gray-400 mt-1 text-center break-all">
                  {previewModal.button_url}
                </p>
              )}
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
