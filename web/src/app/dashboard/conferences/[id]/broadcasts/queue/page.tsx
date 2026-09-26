'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import {
  Send, Wand2, XCircle, Play, PlusCircle, Eye, Clock,
  CheckCircle, AlertCircle, Loader2, X, Calendar, Edit2, Trash2, Copy, Users,
  ChevronDown, ChevronRight, FileText, Upload, Undo2
} from 'lucide-react'
import { api } from '@/lib/api'
import { validateTelegramHtml, validateButton } from '@/lib/validateTelegramHtml'
import FileUploader from '@/components/FileUploader'
import BroadcastChannelPicker from '@/components/BroadcastChannelPicker'
import PayTariffPicker, { audBase, payTariffSuffix, useEventTariffs, type EventTariff } from '@/components/PayTariffPicker'
import { useMe } from '@/hooks/useMe'
import { utcIsoToTzLocalInput, tzLocalInputToEpochMs, nowTzLocalInput } from '@/lib/timezone'
import EmailFunnelStats, { type EmailStats } from '@/components/EmailFunnelStats'

const INCLUDE_LABELS: Record<string, string> = {
  all_event: 'Все уч. конфы',
  registered_event: 'Зарег. уч.',
  paid_event: 'Оплатившие',
  unpaid_event: 'Неоплаченный заказ',
  all_client: 'Вся база',
}
const EXCLUDE_LABELS: Record<string, string> = {
  none: '',
  registered_event: '− зарег.',
  unregistered_event: '− незарег.',
  paid_event: '− оплатившие',
  unpaid_event: '− неоплаченный заказ',
  all_event: '− все уч. конфы',
}
// Сегменты оплаты несут тарифы в самом значении ('paid_event:19,26') —
// подпись тарифа дописывает payTariffSuffix (PayTariffPicker).
function audienceLabel(inc: string, exc: string, tariffs: EventTariff[] = []): string {
  const incLabel = (INCLUDE_LABELS[audBase(inc)] || inc) + payTariffSuffix(inc, tariffs)
  const excBase = audBase(exc)
  const excLabel = EXCLUDE_LABELS[excBase] !== undefined
    ? (EXCLUDE_LABELS[excBase] ? EXCLUDE_LABELS[excBase] + payTariffSuffix(exc, tariffs) : '')
    : (exc && exc !== 'none' ? `− ${exc}` : '')
  return excLabel ? `${incLabel} ${excLabel}` : incLabel
}

const ROLE_RU: Record<string, string> = {
  organizer: 'Организатор',
  jury: 'Жюри',
  headliner: 'Хедлайнер',
  speaker: 'Спикер',
  general_partner: 'Генеральный партнёр',
  partner: 'Партнёр',
}

const STATUS_COLOR: Record<string, string> = {
  draft:     'bg-gray-50 border-gray-100',
  pending:   'bg-amber-50 border-amber-200',
  running:   'bg-blue-50 border-blue-200',
  done:      'bg-green-50 border-green-200',
  cancelled: 'bg-gray-50 border-gray-200',
  recalled:  'bg-purple-50 border-purple-200',
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  draft:     <Edit2 size={13} className="text-gray-400" />,
  pending:   <Clock size={13} className="text-amber-500" />,
  running:   <Loader2 size={13} className="text-blue-500 animate-spin" />,
  done:      <CheckCircle size={13} className="text-green-500" />,
  cancelled: <XCircle size={13} className="text-gray-400" />,
  recalled:  <Undo2 size={13} className="text-purple-500" />,
}

const STATUS_LABEL: Record<string, string> = {
  draft:     'Черновик',
  pending:   'Ожидает',
  running:   'Отправляется',
  done:      'Отправлено',
  cancelled: 'Отменена',
  recalled:  'Отозвана',
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
  chat_nav:               'Навигация по чату события',
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

// Текущее МОСКОВСКОЕ время минус 1 минута в формате "YYYY-MM-DDTHH:MM".
// Бэк трактует fire_at как локальное время в tz клиента (МСК). Минус минута —
// чтобы fire_at был ≤ NOW() и планировщик (тик раз в минуту) взял рассылку сразу.
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

// Дневные типы рассылок — содержимое зависит от ДНЯ программы (программа дня,
// его дата и время старта). У всех у них в форме показываем селектор «День».
// Выбранный день сохраняется в broadcast_schedules.day и имеет приоритет над
// вычислением дня по дате отправки (для «за сутки» отправка идёт накануне, и по
// дате день не определить — раньше туда уезжала программа первого дня).
const DAY_TYPES = [
  '2h_before_unreg', '2h_before_reg', '30min_before',
  'day_before_09_12_unreg', 'day_before_09_12_reg',
  'day_live', 'day_end',
]

// Дата+время отправки для дневной рассылки: старт первой сессии выбранного дня
// минус offset шаблона. Для «за сутки» — накануне дня в 09:12 МСК (как в
// авто-генерации из программы). Возвращает строку для <input type=datetime-local>.
function fireAtForDay(tplType: string, dayNumber: number, days: any[], sessions: any[]): string {
  const day = days.find(d => Number(d.day_number) === Number(dayNumber))
  if (!day?.day_date) return ''
  const dateStr = day.day_date.toString().slice(0, 10)   // YYYY-MM-DD

  if (tplType.startsWith('day_before_09_12')) {
    const d = new Date(`${dateStr}T09:12:00`)
    d.setDate(d.getDate() - 1)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:12`
  }

  // Остальные — от старта первой сессии дня (fallback: open_time дня).
  const daySessions = sessions
    .filter(s => Number(s.day) === Number(dayNumber) && s.start_time)
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))
  const startHHMM = daySessions[0]?.start_time
    ? String(daySessions[0].start_time).slice(0, 5)
    : (day.open_time ? String(day.open_time).slice(0, 5) : '')
  if (!startHHMM) return ''

  const OFFSETS: Record<string, number> = {
    '2h_before_unreg': 120, '2h_before_reg': 120,
    '30min_before': 30, 'day_live': 5, 'day_end': 0,
  }
  const offset = OFFSETS[tplType] ?? 0
  const d = new Date(`${dateStr}T${startHHMM}:00`)
  d.setMinutes(d.getMinutes() - offset)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

// Дата+время отправки для СПИКЕРСКОЙ рассылки (5min_before / gift): считаем ровно
// как автогенерация из программы — 5min_before = старт слота минус offset шаблона,
// gift = конец слота минус offset (offset_minutes шаблона, по умолчанию 5).
// Время слота (conf_sessions.start_time/end_time) — строка "HH:MM" по МСК, дата дня
// берётся из conf_days.day_date. Собираем строку для <input type=datetime-local>
// вручную, БЕЗ new Date() — иначе браузер во Вьетнаме сдвинет время на свою tz.
function fireAtForSession(tplType: string, sessionId: number, sessions: any[], days: any[], offsetMinutes?: number | null): string {
  const s = sessions.find(x => Number(x.id) === Number(sessionId))
  if (!s) return ''
  const day = days.find(d => Number(d.day_number) === Number(s.day))
  const dateStr = day?.day_date ? String(day.day_date).slice(0, 10) : ''
  const hhmm = tplType === 'gift'
    ? (s.end_time ? String(s.end_time).slice(0, 5) : '')
    : (s.start_time ? String(s.start_time).slice(0, 5) : '')
  if (!dateStr || !hhmm) return ''

  const offset = offsetMinutes ?? 5
  // Минуты вычитаем в «стенных» минутах суток; при переходе через полночь
  // сдвигаем календарную дату (арифметика по UTC — без влияния tz браузера).
  const [h, m] = hhmm.split(':').map(Number)
  let total = h * 60 + m - offset
  let dayShift = 0
  while (total < 0) { total += 24 * 60; dayShift -= 1 }
  while (total >= 24 * 60) { total -= 24 * 60; dayShift += 1 }

  const base = new Date(`${dateStr}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + dayShift)
  const p = (n: number) => String(n).padStart(2, '0')
  const y = base.getUTCFullYear(), mo = p(base.getUTCMonth() + 1), da = p(base.getUTCDate())
  return `${y}-${mo}-${da}T${p(Math.floor(total / 60))}:${p(total % 60)}`
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
  const { me } = useMe()
  // Сегменты по оплате показываем только клиентам с фичей платных тарифов события.
  const hasPayments = (me?.features || []).includes('event_tariffs')
  // Тарифы события — для подписи сегментов оплаты в пилюлях и «Итого».
  const eventTariffs = useEventTariffs(eventId, hasPayments)
  // База чатов клиента (общие/личные) — только с фичей broadcast_chats. «В чаты события» — всем.
  const hasChatsFeature = (me?.features || []).includes('broadcast_chats')

  const [schedules, setSchedules] = useState<any[]>([])
  const [templates, setTemplates] = useState<any[]>([])
  const [timezone, setTimezone] = useState('Europe/Moscow')
  const [nextPendingData, setNextPendingData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ text: string; type: 'ok' | 'err' } | null>(null)
  const [previewModal, setPreviewModal] = useState<any>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  // Площадка превью (Telegram/VK/MAX) — вкладки, если у подарков разные ссылки воронки.
  const [previewPlatform, setPreviewPlatform] = useState<'telegram' | 'vk' | 'max' | 'email'>('telegram')
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
  const [editChannelIds, setEditChannelIds] = useState<number[] | null>(null)
  const [editEventChats, setEditEventChats] = useState(false)
  const [editClientChats, setEditClientChats] = useState(false)
  const [editPrivateChats, setEditPrivateChats] = useState(false)
  const [logModal, setLogModal] = useState<{ schedule: any; rows: any[]; chats?: any[]; emailStats?: EmailStats | null } | null>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [recallingId, setRecallingId] = useState<number | null>(null)
  const [manualForm, setManualForm] = useState({
    template_id: '',
    // Московское «сейчас + 10 мин» — иначе календарь откроется на «сегодня»
    // по таймзоне компьютера (у клиента за границей это уже завтра).
    fire_at: nowTzLocalInput(10),
    is_test: false,
    audience_include: 'all_event',
    audience_exclude: 'none',
    session_id: '',   // для speaker_intro, gift, pre_start
    day: '',          // для day_*, day_start_30min_*
  })
  // Режим: 'schedule' — по дате (календарь), 'now' — отправить немедленно.
  const [manualSendMode, setManualSendMode] = useState<'schedule' | 'now'>('schedule')
  const [confSpeakers, setConfSpeakers] = useState<any[]>([])
  const [confSessions, setConfSessions] = useState<any[]>([])
  const [confDays, setConfDays] = useState<any[]>([])
  const [isCollab, setIsCollab] = useState(false)

  // Выделение чекбоксами
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [runningSelected, setRunningSelected] = useState(false)
  // Какую рассылку запускаем кнопкой на её карточке (id) — чтобы крутилка
  // была только у неё, а не у всех сразу.
  const [runningOne, setRunningOne] = useState<number | null>(null)

  // ── Сдвиг тайминга спикерских рассылок («за 5 мин до выступления» + «подарок после эфира») ──
  const [shiftModal, setShiftModal] = useState(false)
  const [shiftDay, setShiftDay] = useState('')            // day_number выбранного дня
  const [shiftSpeakers, setShiftSpeakers] = useState<any[]>([])
  const [shiftSpeakersLoading, setShiftSpeakersLoading] = useState(false)
  const [shiftFromSession, setShiftFromSession] = useState('')
  const [shiftMinutes, setShiftMinutes] = useState('')
  const [shiftSaving, setShiftSaving] = useState(false)

  const load = useCallback(async () => {
    // ⚠️ У КАЖДОГО запроса свой .catch. Promise.all падает целиком, если
    // сорвался хоть один — и вся страница оставалась ПУСТОЙ. Так и вышло:
    // /conference/speakers отвечал 500 (код требовал колонку, которой ещё не
    // было в базе), а клиент видел «очередь пуста», хотя рассылки были
    // отправлены и лежали в базе. Список рассылок не должен зависеть от того,
    // ответил ли справочник спикеров.
    const [tmpl, sched, spk, sess, days, ev] = await Promise.all([
      api.conference.templates.list(eventId).catch(() => ({ templates: [] })),
      api.conference.schedules.list(eventId).catch(() => ({ schedules: [] })),
      api.conference.speakers.list(eventId).catch(() => ({ speakers: [] })),
      api.conference.sessions.list(eventId).catch(() => ({ sessions: [] })),
      api.conference.days.list(eventId).catch(() => ({ days: [] })),
      api.events.get(eventId).catch(() => null),
    ])
    setIsCollab(!!ev?.event?.is_collab)
    setTemplates(tmpl.templates || [])
    // Сортировка по убыванию даты (новые сверху).
    // ⚠️ Рассылки БЕЗ даты — В НАЧАЛО (см. тот же комментарий в общих рассылках):
    // копия создаётся без даты и раньше терялась в конце очереди.
    const sortedSched = [...(sched.schedules || [])].sort((a: any, b: any) => {
      const av = a.fire_at_iso || a.fire_at || ''
      const bv = b.fire_at_iso || b.fire_at || ''
      if (!av && !bv) return 0
      if (!av) return -1
      if (!bv) return 1
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
    const label = schedule.template_name || TYPE_LABELS[schedule.template_type] || schedule.type || '#' + schedule.id
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

  // ── Сдвиг тайминга ──
  function openShiftModal() {
    setShiftDay('')
    setShiftSpeakers([])
    setShiftFromSession('')
    setShiftMinutes('')
    setShiftModal(true)
  }

  // Сначала выбирается день — потом подгружаются спикеры, у которых в этот день
  // есть неотправленные рассылки «за 5 мин до выступления» / «подарок после эфира».
  async function loadShiftSpeakers(day: string) {
    setShiftDay(day)
    setShiftFromSession('')
    setShiftSpeakers([])
    if (!day) return
    setShiftSpeakersLoading(true)
    try {
      const res = await api.conference.schedules.shiftSpeakers(eventId, Number(day))
      setShiftSpeakers(res.speakers || [])
    } catch (e: any) {
      showMsg(e.message || 'Не удалось загрузить спикеров', 'err')
    } finally {
      setShiftSpeakersLoading(false)
    }
  }

  async function runShiftTiming() {
    const minutes = parseInt(shiftMinutes, 10)
    if (!shiftDay || !shiftFromSession || !Number.isFinite(minutes) || minutes === 0) return
    setShiftSaving(true)
    try {
      const res = await api.conference.schedules.shiftTiming(eventId, {
        day: Number(shiftDay),
        from_session_id: Number(shiftFromSession),
        minutes,
      })
      await load()
      setShiftModal(false)
      const sign = minutes > 0 ? 'позже' : 'раньше'
      showMsg(
        `Сдвинуто ${res.shifted} рассылок и ${res.sessions_shifted ?? 0} слотов программы ` +
        `на ${Math.abs(minutes)} мин ${sign}`
      )
    } catch (e: any) {
      showMsg(e.message || 'Не удалось сдвинуть рассылки', 'err')
    } finally {
      setShiftSaving(false)
    }
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

  const [cancellingSel, setCancellingSel] = useState(false)
  async function cancelSelected() {
    const ids = [...selectedIds]
    const sel = schedules.filter(s => ids.includes(s.id))
    // Снимать можно только те, что реально в очереди / отправляются.
    const cancelable = sel.filter(s => s.status === 'pending' || s.status === 'running')
    if (cancelable.length === 0) {
      alert('Среди выбранных нет рассылок в очереди. Снять можно только «Ожидает отправки» / «Отправляется сейчас».')
      return
    }
    if (!confirm(`Снять с очереди ${cancelable.length} рассылок? Они станут черновиками — их можно будет запустить снова.`)) return
    setCancellingSel(true)
    try {
      for (const s of cancelable) {
        await api.conference.schedules.cancel(eventId, s.id)
      }
      await load()
      setSelectedIds(new Set())
      showMsg(`Снято с очереди: ${cancelable.length} (стали черновиками)`)
    } catch (e: any) {
      showMsg(e.message, 'err')
    } finally {
      setCancellingSel(false)
    }
  }

  async function cancelOne(scheduleId: number) {
    await api.conference.schedules.cancel(eventId, scheduleId)
    setSchedules(prev => prev.map(x => x.id === scheduleId ? { ...x, status: 'draft' } : x))
  }

  async function openPreview(schedule: any) {
    setPreviewLoading(true)
    setPreviewModal(null)
    try {
      const res = await api.conference.schedules.preview(eventId, schedule.id)
      // Активна — первая ПОДКЛЮЧЁННАЯ у клиента площадка (бэк прислал только их).
      // Жёсткий 'telegram' показал бы пустую вкладку клиенту без TG-бота.
      const avail = Object.keys(res?.text_by_platform || {})
      const first = (['telegram', 'vk', 'max'] as const).find(p => avail.includes(p))
      setPreviewPlatform(first || 'telegram')
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
      setLogModal({ schedule, rows: res.log || [], chats: res.chats || [], emailStats: res.email_stats || null })
    } catch { showMsg('Не удалось загрузить лог', 'err') }
    finally { setLogLoading(false) }
  }

  function openFireAt(schedule: any) {
    setFireAtModal(schedule)
    // Предзаполняем существующим временем задачи
    if (schedule.fire_at_iso) {
      // Московское стенное время, независимо от tz браузера клиента.
      setFireAtValue(utcIsoToTzLocalInput(schedule.fire_at_iso))
    } else {
      setFireAtValue('')
    }
    setIsTestValue(schedule.is_test || false)
    setEditAudienceInclude(schedule.audience_include || 'all_event')
    setEditAudienceExclude(schedule.audience_exclude || 'none')
    // Эффективные каналы/флаги: своё значение задачи, иначе унаследованное от шаблона.
    const effCh = Array.isArray(schedule.eff_target_channel_ids) ? schedule.eff_target_channel_ids
      : (Array.isArray(schedule.target_channel_ids) ? schedule.target_channel_ids : null)
    setEditChannelIds(effCh)
    // Галочки чатов. Если рассылку УЖЕ редактировали (chats_overridden=TRUE,
    // миграция 235) — показываем ФАКТИЧЕСКИЕ настройки самой рассылки (не eff-,
    // иначе снятая галочка возвращалась бы значением шаблона). Не редактировали —
    // показываем эффективные (что реально уйдёт: своё + наследие шаблона).
    if (schedule.chats_overridden) {
      setEditEventChats(!!schedule.send_to_event_chats)
      setEditClientChats(!!schedule.send_to_client_chats)
      setEditPrivateChats(!!schedule.send_to_private_chats)
    } else {
      setEditEventChats(!!(schedule.eff_send_to_event_chats ?? schedule.send_to_event_chats))
      setEditClientChats(!!(schedule.eff_send_to_client_chats ?? schedule.send_to_client_chats))
      setEditPrivateChats(!!(schedule.eff_send_to_private_chats ?? schedule.send_to_private_chats))
    }
  }

  const [testingFireAt, setTestingFireAt] = useState(false)
  async function testFireAtNow() {
    if (!fireAtModal) return
    setTestingFireAt(true)
    try {
      const r = await api.conference.schedules.testScheduleNow(eventId, fireAtModal.id)
      const failed = (r.results || []).filter((x: any) => !x.ok)
      if (failed.length > 0) showMsg(`Тест: доставлено ${r.sent}/${r.total}. Ошибки: ${failed.map((f: any) => `${f.platform}:${f.error}`).join('; ')}`, 'err')
      else showMsg(`✅ Тест отправлен (${r.sent} шт) на ваши тестовые ID`)
    } catch (e: any) {
      showMsg(e.message || 'Ошибка тестовой отправки', 'err')
    } finally {
      setTestingFireAt(false)
    }
  }

  async function saveFireAt() {
    if (!fireAtModal) return
    if (!fireAtValue) {
      setFireAtError('Укажите дату и время')
      return
    }
    // Трактуем ввод как МСК (как бэк), а не как tz браузера.
    if (tzLocalInputToEpochMs(fireAtValue) <= Date.now()) {
      setFireAtError('Время уже прошло — выберите будущее время')
      return
    }
    setFireAtError('')
    try {
      // ⚠️ Навигация по чату (chat_nav): у неё в модалке есть ТОЛЬКО время, и
      // шлём мы тоже только его. Остальные поля не отправляем вовсе (в
      // SetFireAtRequest они Optional → None = «не трогать текущее значение»),
      // чтобы не перезаписать то, что шаблон задал жёстко. Главное — НЕ слать
      // `chats_overridden: true`: этот флаг отключает наследование
      // send_to_event_chats/pin_in_chat от шаблона (broadcast.py:247), и
      // навигация после «Задать время» перестала бы уходить в чат и
      // закрепляться. На бэке то же самое продублировано принудительно.
      // ⚠️ Рассылки в ЧАТ СПИКЕРОВ — по тому же правилу, что chat_nav
      // (24.09.2026): у них тоже настраивается только время. Слать
      // `chats_overridden: true` тут нельзя — флаг отключает наследование
      // send_to_speakers_chat/pin_in_chat от шаблона, и после «Задать время»
      // рассылка перестала бы уходить в чат спикеров вовсе.
      const isChatNav = ['chat_nav', 'speakers_call', 'speakers_day', 'speakers_howto']
        .includes(fireAtModal.type)
      await api.conference.schedules.setFireAt(eventId, fireAtModal.id, isChatNav ? {
        fire_at: fireAtValue,
        is_test: false,
      } : {
        fire_at: fireAtValue,
        is_test: isTestValue,
        audience_include: editAudienceInclude,
        audience_exclude: editAudienceExclude,
        target_channel_ids: editChannelIds,
        send_to_event_chats: editEventChats,
        send_to_client_chats: hasChatsFeature ? editClientChats : false,
        send_to_private_chats: hasChatsFeature ? editPrivateChats : false,
        // Пометка «галочки чатов переопределены вручную» — движок больше не
        // подмешивает шаблон, шлёт строго по настройкам этой рассылки (миграция 235).
        chats_overridden: true,
      })
      setFireAtModal(null)
      await load()
      showMsg('Настройки задачи сохранены')
    } catch (e: any) {
      showMsg(e.message, 'err')
    }
  }

  async function addManual() {
    // «Немедленно» — дату не требуем, подставим текущее московское время (−1 мин).
    const isNow = manualSendMode === 'now'
    if (!manualForm.template_id || (!isNow && !manualForm.fire_at)) {
      showMsg('Выберите шаблон и укажите время', 'err')
      return
    }
    // ⚠️ Дата в прошлом при «Запланировать» — рассылка ушла бы сразу. Люфт 2 мин.
    if (!isNow && manualForm.fire_at && tzLocalInputToEpochMs(manualForm.fire_at) < Date.now() - 2 * 60 * 1000) {
      showMsg('Дата отправки уже прошла — укажите будущее время (иначе рассылка ушла бы сразу)', 'err')
      return
    }
    const fireAtToSend = isNow ? nowMoscowMinus1MinLocal() : manualForm.fire_at
    const tpl = templates.find(t => String(t.id) === manualForm.template_id)
    const tplType = tpl?.type || ''
    // expert_day, как и speaker_intro, привязан к event_collaborators.id
    const isSpeakerType = ['speaker_intro', 'expert_day', 'gift', '5min_before'].includes(tplType)
    // День обязателен только у событий с программой (конференция/турнир).
    // У обычного мероприятия дней нет — селектор не показываем и день не шлём.
    const isDayType = DAY_TYPES.includes(tplType) && confDays.length > 0
    if (isSpeakerType && !manualForm.session_id) {
      showMsg('Выберите спикера', 'err')
      return
    }
    if (isDayType && !manualForm.day) {
      showMsg('Выберите день программы', 'err')
      return
    }
    try {
      await api.conference.schedules.addManual(eventId, {
        template_id: Number(manualForm.template_id),
        fire_at: fireAtToSend,
        enqueue: isNow,
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

  // Отметить только черновики — повторный клик снимает выделение.
  function selectAllDrafts() {
    const draftIds = schedules.filter(s => s.status === 'draft').map(s => s.id)
    const allPicked = draftIds.length > 0
      && draftIds.every(id => selectedIds.has(id)) && selectedIds.size === draftIds.length
    setSelectedIds(allPicked ? new Set() : new Set(draftIds))
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

  /** Запуск ОДНОЙ рассылки — кнопкой прямо на её карточке.
   *
   * ⚠️ Проверки те же, что у массового запуска, но ведут себя иначе: там
   * негодные молча пропускаются (запускаем остальные), здесь пропускать
   * нечего — рассылка одна, поэтому объясняем, что именно мешает.
   */
  async function runOne(s: any) {
    if (s.status !== 'draft') return
    if (!s.fire_at_iso) {
      alert('У рассылки не задано время отправки. Нажмите «Задать время» — и запускайте.')
      return
    }
    if (new Date(s.fire_at_iso) <= new Date()) {
      alert('Время отправки уже прошло — планировщик такую задачу не подхватит.\n\nЗадайте время в будущем через «Задать время».')
      return
    }
    if (s.has_empty_placeholder) {
      alert('В сообщении пустая обязательная подстановка — ссылка на эфир или контакты поддержки.\n\nЗаполните её, иначе люди получат сообщение с дырой вместо ссылки.')
      return
    }
    const label = s.template_name || TYPE_LABELS[s.template_type] || s.type
    if (!confirm(`Запустить рассылку «${label}»?\n\nОтменить можно значком ✕ справа на задаче.`)) return

    setRunningOne(s.id)
    try {
      await api.conference.schedules.runSelected(eventId, [s.id])
      showMsg(`Рассылка «${label}» поставлена в очередь — уйдёт в назначенное время.`)
      await load()
    } catch (e: any) {
      showMsg(e.message, 'err')
    } finally {
      setRunningOne(null)
    }
  }

  async function runSelected() {
    const ids = [...selectedIds]
    const selected = schedules.filter(s => ids.includes(s.id))
    const drafts = selected.filter(s => s.status === 'draft')
    if (drafts.length === 0) {
      alert('Среди выбранных нет черновиков. Запустить можно только черновики.')
      return
    }
    // Запускаем ВСЕ годные, а «косячные» просто пропускаем (не блокируем весь запуск):
    //  - без времени отправки (нужно сначала «Задать время»);
    //  - с прошедшим временем (ушли бы мгновенно / не подхватятся планировщиком).
    const noTime = drafts.filter(s => !s.fire_at_iso)
    const pastTime = drafts.filter(s => s.fire_at_iso && new Date(s.fire_at_iso) <= new Date())
    // Пустой обязательный плейсхолдер ({stream_url} без комнаты / {support} без контактов)
    // — не ставим в очередь, пропускаем (как прошедшее время).
    const emptyPh = drafts.filter(s => s.has_empty_placeholder)
    const skipIds = new Set([...noTime, ...pastTime, ...emptyPh].map(s => s.id))
    const runnable = drafts.filter(s => !skipIds.has(s.id))

    if (runnable.length === 0) {
      alert('Все выбранные черновики без времени или с прошедшим временем. Задайте им время через кнопку «Задать время» рядом с рассылкой.')
      return
    }

    // Сколько пропустим — предупреждаем, но запуск не блокируем.
    const skippedParts: string[] = []
    if (noTime.length > 0) skippedParts.push(`${noTime.length} без времени`)
    if (pastTime.length > 0) skippedParts.push(`${pastTime.length} с прошедшим временем`)
    if (emptyPh.length > 0) skippedParts.push(`${emptyPh.length} с пустой ссылкой эфира/поддержки`)
    const skippedNote = skippedParts.length
      ? `\n\nБудет пропущено (запускать не будем): ${skippedParts.join(', ')} — задайте им время отдельно.`
      : ''
    if (!confirm(`Запустить ${runnable.length} рассылок?${skippedNote}\n\nПосле запуска можно отменить любую (значок ✕ справа на задаче).`)) return

    setRunningSelected(true)
    try {
      // Шлём на бэк ТОЛЬКО годные id — косячные и невыбранные игнорируются.
      const runnableIds = runnable.map(s => s.id)
      const r = await api.conference.schedules.runSelected(eventId, runnableIds)
      const tail = skippedParts.length ? ` Пропущено: ${skippedParts.join(', ')}.` : ''
      showMsg(`Запущено ${r.queued} рассылок — Celery отправит их по расписанию.${tail} Отменить — ✕ справа на задаче.`)
      await load()
      setSelectedIds(new Set())
    } catch (e: any) {
      showMsg(e.message, 'err')
    } finally {
      setRunningSelected(false)
    }
  }

  const pendingCount = schedules.filter(s => s.status === 'pending' || s.status === 'draft').length
  const nullFireDrafts = schedules.filter(s => s.status === 'draft' && !s.fire_at)
  const nullFireCount = nullFireDrafts.length
  // Реальные названия типов рассылок без времени (для плашки) — не хардкодим «Знакомство со спикером».
  const nullFireTypeNames = Array.from(new Set(
    nullFireDrafts.map(s => TYPE_LABELS[s.template_type] || s.type || 'без типа')
  ))
  const doneCount = schedules.filter(s => s.status === 'done').length
  // Пересчитываем из актуального списка schedules (обновляется при удалении без reload)
  const nextPending = schedules
    .filter(s => s.status === 'pending' && s.fire_at_iso && new Date(s.fire_at_iso) > new Date())
    .sort((a, b) => (a.fire_at_iso || '') < (b.fire_at_iso || '') ? -1 : 1)[0] || null

  // Форматируем timezone для отображения
  const tzLabel = timezone === 'Europe/Moscow' ? 'МСК (UTC+3)' : timezone

  return (
    <div>
      {/* ⚠️ Заголовок «Моя очередь рассылок» и пояснение — в ШАПКЕ раздела
          (broadcasts/layout.tsx), а не здесь: иначе на экране два заголовка
          подряд, «Рассылки» сверху и «Моя очередь» под ним. */}

      {/* ── Статусная плашка наверху ── */}
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
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[100] max-w-[90vw] text-sm rounded-xl px-4 py-3 flex items-center gap-2 shadow-lg border ${
          msg.type === 'ok' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'
        }`}>
          {msg.type === 'ok' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {msg.text}
        </div>
      )}

      {/* ── Кнопки управления ── */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {selectedIds.size > 0 && (
          <>
            <button onClick={runSelected} disabled={runningSelected}
              className="flex items-center gap-2 px-3 py-2 border border-green-300 rounded-xl text-sm text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">
              <Play size={14} /> {runningSelected ? 'Запускаем...' : `Запустить выбранные (${selectedIds.size})`}
            </button>
            <button onClick={cancelSelected} disabled={cancellingSel}
              className="flex items-center gap-2 px-3 py-2 border border-amber-300 rounded-xl text-sm text-amber-700 hover:bg-amber-50 disabled:opacity-50">
              <XCircle size={14} /> {cancellingSel ? 'Снимаем...' : `Отменить выбранные (${selectedIds.size})`}
            </button>
            <button onClick={deleteSelected} disabled={deleting}
              className="flex items-center gap-2 px-3 py-2 border border-red-300 rounded-xl text-sm text-white bg-red-500 hover:bg-red-600 disabled:opacity-50">
              <Trash2 size={14} /> {deleting ? 'Удаляем...' : `Удалить выбранные (${selectedIds.size})`}
            </button>
          </>
        )}
        <button onClick={() => {
            // Актуализируем дату на момент ОТКРЫТИЯ (страница могла висеть часами).
            setManualForm(f => ({ ...f, fire_at: nowTzLocalInput(10) }))
            setManualModal(true)
          }}
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
        {confDays.length > 0 && (
          <button onClick={openShiftModal}
            className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50">
            <Clock size={14} /> Сдвиг тайминга
          </button>
        )}
        <button onClick={openGenModal} disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm text-white font-medium disabled:opacity-50"
          style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
          <Wand2 size={14} /> {loading ? 'Создаю...' : 'Сформировать из программы'}
        </button>
      </div>

      {/* ── Список очереди ── */}
      {schedules.length === 0 ? (
        <div className="py-16 text-center text-gray-400 bg-white rounded-2xl border card-border">
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
            {schedules.some(s => s.status === 'draft') && (
              <button onClick={selectAllDrafts}
                className="text-xs text-blue-600 hover:underline ml-2">
                Выбрать все черновики
              </button>
            )}
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
                        {s.template_name || TYPE_LABELS[s.template_type] || s.type}
                      </span>
                      {/* Дневная рассылка — какой день программы уйдёт в сообщении */}
                      {s.day && (
                        <span
                          className="text-xs px-2 py-0.5 rounded-full font-medium bg-blue-50 text-blue-700 border border-blue-100"
                          title="В сообщении будет программа этого дня">
                          День {s.day}
                        </span>
                      )}
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
                        {/* ⚠️ У рассылки в чат спикеров получателей в базе НЕТ
                            (audience_exclude='all_event' вычитает всех). Показывать
                            ей «все участники» — прямая ложь: она им не уходит. */}
                        {(s.eff_send_to_speakers_chat ?? s.send_to_speakers_chat)
                          ? 'только чат — участникам не уходит'
                          : s.type === 'chat_nav'
                            ? 'только чат события — участникам не уходит'
                            : audienceLabel(s.audience_include || 'all_event', s.audience_exclude || 'none', eventTariffs)}
                      </span>
                      {/* Закреп — отдельной плашкой: человеку важно видеть, что
                          сообщение не просто придёт в чат, но и встанет в шапку. */}
                      {(s.eff_pin_in_chat ?? s.pin_in_chat) && (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-semibold"
                          style={{ background: '#FFCFA4', color: '#25455D' }}
                          title="После отправки бот закрепит сообщение в чате. Нужны права администратора у бота."
                        >
                          с закрепом
                        </span>
                      )}
                      {/* Отмеченные чаты — итоговые флаги с сервера (учитывают
                          наследование от шаблона и правку в очереди). Видно, куда
                          именно уйдёт рассылка помимо базы. */}
                      {/* ⚠️ Чат СПИКЕРОВ — отдельной плашкой, а не в списке «+ ещё
                          сюда»: для этой рассылки он не дополнение к базе, а
                          ЕДИНСТВЕННЫЙ получатель — участникам она не уходит
                          вовсе. В общем списке это должно читаться сразу. */}
                      {(s.eff_send_to_speakers_chat ?? s.send_to_speakers_chat) && (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded font-semibold bg-orange-500 text-white"
                          title="Уходит только в чат спикеров — участникам события не отправляется"
                        >
                          в чат спикеров
                        </span>
                      )}
                      {(() => {
                        const chats: string[] = []
                        if (s.eff_send_to_event_chats ?? s.send_to_event_chats) chats.push('чаты события')
                        if (s.eff_send_to_client_chats ?? s.send_to_client_chats) chats.push('общие чаты')
                        if (s.eff_send_to_private_chats ?? s.send_to_private_chats) chats.push('личные каналы')
                        if (!chats.length) return null
                        return (
                          <span
                            className="text-xs px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200"
                            title="Кроме базы рассылка уйдёт ещё сюда"
                          >
                            + {chats.join(', ')}
                          </span>
                        )
                      })()}
                    </div>

                    {/* Строка 2: спикер + тема */}
                    {(s.speaker_name || s.session_title) && (
                      <div className="flex items-center gap-2 text-xs text-gray-600 mb-1">
                        {s.speaker_name && <span className="font-medium">{s.speaker_name}</span>}
                        {s.session_title && <span className="text-gray-400 truncate max-w-[220px]">{s.session_title}</span>}
                      </div>
                    )}

                    {/* Заголовок (тема) + превью текста. eff_subject = своя тема у
                        произвольной рассылки, иначе тема шаблона — у шаблонных
                        рассылок snapshot_subject пуст, и тема раньше не показывалась. */}
                    {(s.eff_subject || s.snapshot_subject) && (
                      <p className="text-sm font-semibold text-gray-900 mb-0.5 truncate">
                        {(() => {
                          let sub = String(s.eff_subject || s.snapshot_subject)
                          if (s.speaker_name) sub = sub.replace(/\{speaker_name\}/g, s.speaker_name)
                          return sub
                        })()}
                      </p>
                    )}
                    {(() => {
                      // Сниппет для списка: подставляем имя спикера, убираем HTML-теги и
                      // оставшиеся сырые {плейсхолдеры}, чтобы строка была читаемой.
                      // ⚠️ Это только превью-строка. Реально уходит текст из превью (глазик):
                      // для speaker_intro/expert_day движок берёт свежий шаблон, не snapshot.
                      let raw = (s.snapshot_text || '')
                      if (s.speaker_name) raw = raw.replace(/\{speaker_name\}/g, s.speaker_name)
                      raw = raw.replace(/<[^>]+>/g, '').replace(/\{[a-z_]+\}/gi, '').replace(/\s+/g, ' ').trim()
                      const preview = raw.slice(0, 80)
                      return preview ? (
                        <p className="text-sm text-gray-700 mb-1 truncate">{preview}{raw.length > 80 ? '…' : ''}</p>
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
                    {/* Пустой обязательный плейсхолдер ({stream_url}/{support}) — рассылку
                        нельзя ставить в очередь (запуск заблокирован ниже). */}
                    {s.has_empty_placeholder && s.status !== 'done' && s.status !== 'running' && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-red-700 bg-red-50 border border-red-300 rounded-lg px-2.5 py-1.5">
                        <AlertCircle size={12} className="shrink-0" />
                        <span>⚠️ {s.empty_placeholder_reason}</span>
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
                              Не доставлено {(s.recipients_failed || 0) + (s.recipients_bounced || 0)} получателям. Нажмите «список» — увидите разбивку по причинам (отклонено почтовым сервисом с подозрением на спам, адрес не существует, бот заблокирован, и т.д.).
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
                        // ⚠️ Картинку могли уже стереть (медиа рассылок живёт
                        // сутки после отправки) — предупреждаем, а не молчим.
                        const cr: any = await api.conference.schedules.copy(eventId, s.id)
                        if (cr?.warning) alert(cr.warning)
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
                    {/* ⚠️ ЗАПУСК ОДНОЙ РАССЫЛКИ — прямо здесь (24.09.2026).
                        Раньше запустить можно было только через галочку и
                        кнопку наверху списка: чтобы отправить ОДНУ рассылку,
                        человек отмечал её, прокручивал вверх, жал «Запустить
                        выбранные». Массовый запуск галочками остался — он
                        удобен, когда рассылок много. */}
                    {s.status === 'draft' && (
                      <button
                        onClick={() => runOne(s)}
                        disabled={runningOne === s.id}
                        className="px-2 py-1 rounded-lg text-xs font-semibold disabled:opacity-40 flex items-center gap-1"
                        style={{ background: '#FFCFA4', color: '#25455D' }}
                        title={!s.fire_at_iso
                          ? 'Сначала задайте время отправки'
                          : 'Запустить эту рассылку'}>
                        <Play size={12} />
                        {runningOne === s.id ? 'Запускаю…' : 'Запустить'}
                      </button>
                    )}
                    {/* Задать время (для draft без fire_at) */}
                    {(s.status === 'draft' || s.status === 'pending') && !s.fire_at && (
                      <button onClick={() => openFireAt(s)}
                        className="px-2 py-1 border border-amber-300 rounded-lg text-xs text-amber-700 font-medium hover:bg-amber-50">
                        Задать время
                      </button>
                    )}
                    {/* Редактировать: для произвольной (custom) — полная правка
                        текста/фото/кнопок/времени; для шаблонных — только время.
                        ⚠️ custom показываем ДАЖЕ без fire_at (у скопированной рассылки
                        время пустое — его как раз задают в форме). Для шаблонных
                        «правка времени» без fire_at смысла не имеет — там требуем. */}
                    {(s.status === 'draft' || s.status === 'pending') && (s.type === 'custom' || s.fire_at) && (
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
                    {/* Отозвать — удалить уже отправленные сообщения у получателей (только done).
                        Кнопка активна только если есть сохранённые message_id (recallable_count>0);
                        иначе отзывать нечего (старые рассылки до 16.07.2026 / только email). */}
                    {s.status === 'done' && (
                      (s.recallable_count || 0) > 0 ? (
                        <button onClick={async () => {
                          if (recallingId) return
                          if (!confirm(
                            'Отозвать рассылку?\n\n' +
                            'Попробуем УДАЛИТЬ уже отправленные сообщения у получателей (Telegram, VK, MAX) и в чатах события.\n\n' +
                            'Платформа может отказать удалить слишком старое сообщение или при отсутствии прав у бота — такие попадут в «не удалось» с причиной. Email отозвать нельзя (письмо уже доставлено).'
                          )) return
                          setRecallingId(s.id)
                          try {
                            const r: any = await api.conference.schedules.recall(eventId, s.id)
                            const bp = r.by_platform || {}
                            const parts = [`Удалено: ${r.deleted}`]
                            const plat = [
                              bp.telegram ? `TG ${bp.telegram}` : null,
                              bp.vk ? `VK ${bp.vk}` : null,
                              bp.max ? `MAX ${bp.max}` : null,
                            ].filter(Boolean).join(', ')
                            if (plat) parts.push(`(${plat})`)
                            if (r.failed) parts.push(`не удалось: ${r.failed}`)
                            if (r.skipped_no_msgid) parts.push(`без ID: ${r.skipped_no_msgid}`)
                            if (r.skipped_email) parts.push(`email (нельзя): ${r.skipped_email}`)
                            let msg = parts.join(' · ')
                            if (r.errors && r.errors.length) msg += `\nПричины: ${r.errors.join('; ')}`
                            showMsg(msg, r.deleted > 0 ? 'ok' : 'err')
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
                          title="Отозвать нельзя: у этой рассылки не сохранены ID сообщений (отправлена до появления функции) либо она только по email.">
                          <Undo2 size={13} />
                        </button>
                      )
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

      {/* ⚠️ Кнопки «Запустить всю очередь» тут больше НЕТ (убрана 19.09.2026,
          решение владельца). Запуск — только осознанный, кнопкой «Запустить
          выбранные» сверху: там видно, что именно уйдёт. Кнопка на всю очередь
          отправляла вообще всё одним нажатием, включая то, что человек ещё не
          проверил. Локальная функция runAll и состояние `running` удалены
          вместе с кнопкой. Эндпоинт /schedules/run-all и api.…schedules.runAll
          НЕ трогаем: бэк рабочий, вызвать его при надобности можно снова. */}

      {/* ── Модалка: установить время отправки ── */}
      {/* ⚠️⚠️ РАССЫЛКИ В ЧАТ СПИКЕРОВ — ВЫБОРА ПЛОЩАДКИ НЕТ (24.09.2026).
          `speakers_call` / `speakers_day` / `speakers_howto` уходят РОВНО в чат
          спикеров события, а не по базе: доставка идёт по `send_to_speakers_chat`,
          который бэк для этих типов проставляет принудительно, и
          `target_channel_ids` в этой ветке не читается вовсе. Выбор площадки,
          аудитории и галочки «общие чаты / личные каналы» были настройками,
          которые ни на что не влияют, — а снятая галочка вместе с
          `chats_overridden=TRUE` ещё и отключала наследование от шаблона, и
          рассылка не уходила никуда. Та же логика, что у `chat_nav` выше. */}
      {fireAtModal && (() => {
        const isSpeakersChat = ['speakers_call', 'speakers_day', 'speakers_howto']
          .includes(fireAtModal.type)
        const isChatNav = fireAtModal.type === 'chat_nav' || isSpeakersChat; return (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto scroll-visible">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">{isChatNav ? 'Когда отправить' : 'Настройки задачи'}</h3>
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
              {/* ⚠️ Навигация по чату (chat_nav) — всё, кроме времени, здесь лишнее
                  (правило владельца 22.09.2026). Эта рассылка уходит РОВНО в чаты
                  события: TG/VK/MAX-чат берётся из настроек самого события
                  (`tg_chat_ref` / `vk_chat_ref` / `max_chat_ref`), а в личку не идёт
                  никому — шаблон жёстко держит audience all_event/all_event.
                  Площадку выбирать тоже нечего: `_send_broadcast_to_event_chats`
                  шлёт туда, где чат у события ЗАДАН, и `target_channel_ids` в этой
                  ветке не читается вовсе. Показывать аудиторию, каналы, email и
                  галочки «общие чаты / личные каналы» значило бы предложить
                  настройки, которые ни на что не влияют, — а снятая галочка «чаты
                  события» (вместе с `chats_overridden=TRUE` из saveFireAt) ещё и
                  отключала наследование от шаблона, и рассылка не уходила никуда. */}
              {isChatNav ? (
                <div className="flex items-start gap-1.5 bg-[#FFCFA4]/20 border border-[#FFCFA4] rounded-xl px-3 py-2.5">
                  <span className="text-sm mt-0.5">💬</span>
                  <p className="text-xs text-[#25455D]">
                    {isSpeakersChat ? (<>
                      <b>Уходит в чат спикеров</b> — тот, что указан в настройках
                      события. Участникам не приходит.
                      Настраивать тут больше нечего — только время.
                    </>) : (<>
                      <b>Уходит в чаты события</b> — Telegram, ВК и MAX, где чат указан
                      в настройках события. В личку участникам не приходит.
                      Настраивать тут больше нечего — только время.
                    </>)}
                  </p>
                </div>
              ) : (<>
              <div className="border border-gray-100 rounded-xl p-3 bg-gray-50 space-y-2">
                <p className="text-xs font-medium text-gray-600">👥 Аудитория</p>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Включить</label>
                  <select value={audBase(editAudienceInclude)} onChange={e => setEditAudienceInclude(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="all_event">Все участники конфы</option>
                    <option value="registered_event">Зарегистрированные участники</option>
                    {hasPayments && <option value="paid_event">Оплатившие</option>}
                    {hasPayments && <option value="unpaid_event">Имеют неоплаченный заказ</option>}
                    <option value="all_client">Вся база клиента</option>
                  </select>
                  {hasPayments && <PayTariffPicker eventId={eventId} value={editAudienceInclude} onChange={setEditAudienceInclude} />}
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Исключить</label>
                  <select value={audBase(editAudienceExclude)} onChange={e => setEditAudienceExclude(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="none">Никого не исключать</option>
                    <option value="registered_event">Зарегистрированных участников</option>
                    <option value="unregistered_event">Незарегистрированных участников</option>
                    {hasPayments && <option value="paid_event">Оплативших</option>}
                    {hasPayments && <option value="unpaid_event">Имеющих неоплаченный заказ</option>}
                    <option value="all_event">Всех участников конфы</option>
                  </select>
                  {hasPayments && <PayTariffPicker eventId={eventId} value={editAudienceExclude} onChange={setEditAudienceExclude} />}
                </div>
                <p className="text-xs text-indigo-600 font-medium">
                  Итого: {audienceLabel(editAudienceInclude, editAudienceExclude, eventTariffs)}
                </p>
              </div>

              {/* Каналы для отправки */}
              <BroadcastChannelPicker
                value={editChannelIds}
                onChange={(next) => setEditChannelIds(next)}
              />
              {/* ⚠️ Площадки управляют И ЧАТАМИ (22.09.2026): выбран только
                  Telegram — в MAX- и ВК-чаты события не уйдёт. Раньше чаты
                  слались во все площадки, где чат задан. */}
              <p className="text-[11px] text-gray-500 -mt-2 px-1">
                Площадки действуют и на чаты ниже: снимете Telegram — в чат
                Telegram не уйдёт.
              </p>

              {/* Три независимые галочки: чаты события / общие чаты / личные каналы.
                  Выбранная — синяя рамка+фон (чтобы сразу видеть что реально уйдёт). */}
              <div className="space-y-2">
                <label className={`flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-colors ${editEventChats ? 'border-[#25455D] bg-[#25455D]/5' : 'border-gray-200 bg-gray-50'}`}>
                  <input type="checkbox" checked={editEventChats}
                    onChange={e => setEditEventChats(e.target.checked)}
                    className="w-4 h-4 mt-0.5 accent-[#25455D]" />
                  <span>
                    <span className="block text-sm text-gray-800 font-medium">Отправлять в чаты события {editEventChats && <span className="text-[#25455D]">✓</span>}</span>
                    <span className="block text-[11px] text-gray-500 mt-0.5">В групповые чаты этого события (заданы в настройках события).</span>
                  </span>
                </label>
                {hasChatsFeature && (<label className={`flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-colors ${editClientChats ? 'border-[#25455D] bg-[#25455D]/5' : 'border-gray-200 bg-gray-50'}`}>
                  <input type="checkbox" checked={editClientChats}
                    onChange={e => setEditClientChats(e.target.checked)}
                    className="w-4 h-4 mt-0.5 accent-[#25455D]" />
                  <span>
                    <span className="block text-sm text-gray-800 font-medium">Отправлять в общие чаты {editClientChats && <span className="text-[#25455D]">✓</span>}</span>
                    <span className="block text-[11px] text-gray-500 mt-0.5">В общие группы/каналы из базы чатов (Каналы → «Группы/Каналы для рассылок»).</span>
                  </span>
                </label>)}
                {hasChatsFeature && (<label className={`flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition-colors ${editPrivateChats ? 'border-[#25455D] bg-[#25455D]/5' : 'border-gray-200 bg-gray-50'}`}>
                  <input type="checkbox" checked={editPrivateChats}
                    onChange={e => setEditPrivateChats(e.target.checked)}
                    className="w-4 h-4 mt-0.5 accent-[#25455D]" />
                  <span>
                    <span className="block text-sm text-gray-800 font-medium">Отправлять в личные каналы {editPrivateChats && <span className="text-[#25455D]">✓</span>}</span>
                    <span className="block text-[11px] text-gray-500 mt-0.5">В каналы из базы чатов, помеченные галочкой «Личный».</span>
                  </span>
                </label>)}
              </div>
              </>)}

              {/* ⚠️ Галочка «Тестовая рассылка» для chat_nav не показывается:
                  при is_test=TRUE движок НЕ шлёт в групповые чаты вовсе
                  (broadcast.py, `not schedule["is_test"]` у чатов события) — то
                  есть отмеченная задача навигации тихо не ушла бы никуда.
                  Кнопка разовой тестовой отправки ниже остаётся: она шлёт на
                  личные тестовые ID и настройку задачи не меняет — посмотреть
                  вёрстку пунктов перед отправкой в чат. */}
              {!isChatNav && (
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
              </div>)}
            </div>
            <button onClick={testFireAtNow} disabled={testingFireAt}
              className="w-full mt-4 py-2 rounded-xl text-sm font-medium border border-indigo-300 text-indigo-700 hover:bg-indigo-50 disabled:opacity-60">
              {testingFireAt ? 'Отправляю тест...' : '🧪 Отправить тестовую рассылку немедленно'}
            </button>
            <p className="text-[11px] text-gray-400 mt-1 text-center">Уйдёт сразу на ваши тестовые Telegram/VK/MAX ID — ровно как реальное сообщение.</p>
            <div className="flex gap-2 mt-3">
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
      ) })()}

      {/* ── Модалка: выбор шаблонов для формирования из программы ── */}
      {/* ── Сдвиг тайминга спикерских рассылок ── */}
      {shiftModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto scroll-visible"
               onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-semibold text-gray-800">Сдвиг тайминга</h3>
              <button onClick={() => setShiftModal(false)}><X size={18} /></button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Программа поехала — сдвиньте рассылки «За 5 минут до выступления» и «Подарок после эфира».
              Сдвинутся рассылки выбранного спикера и всех, кто выступает после него в этот день,
              и <b>вместе с ними — слоты программы этого дня</b>. Другие дни не меняются.
            </p>

            <div className="space-y-4">
              {/* Шаг 1 — день */}
              <div>
                <label className="text-xs text-gray-500 mb-1 block">День программы</label>
                <select
                  value={shiftDay}
                  onChange={e => loadShiftSpeakers(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                  <option value="">— выберите день —</option>
                  {confDays.map(d => {
                    const RU_M: Record<string, string> = {'01':'янв','02':'фев','03':'мар','04':'апр','05':'май','06':'июн','07':'июл','08':'авг','09':'сен','10':'окт','11':'ноя','12':'дек'}
                    let dateLabel = ''
                    if (d.day_date) {
                      const s = d.day_date.toString().slice(0, 10).split('-')
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

              {/* Шаг 2 — спикер (только те, у кого есть такие рассылки в этот день) */}
              {shiftDay && (
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Начать сдвиг со спикера</label>
                  {shiftSpeakersLoading ? (
                    <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
                      <Loader2 size={14} className="animate-spin" /> Загружаю спикеров...
                    </div>
                  ) : shiftSpeakers.length === 0 ? (
                    <div className="px-3 py-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                      В этот день нет рассылок «За 5 минут до выступления» и «Подарок после эфира» — сдвигать нечего.
                      Выберите другой день.
                    </div>
                  ) : (
                    <select
                      value={shiftFromSession}
                      onChange={e => setShiftFromSession(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                      <option value="">— выберите спикера —</option>
                      {shiftSpeakers.map(s => (
                        <option key={s.session_id} value={s.session_id}>
                          {s.start_time ? `${s.start_time} — ` : ''}{s.speaker_name || s.session_title || `Слот #${s.session_id}`}
                          {` (${s.schedules_count} рас.`}
                          {/* Сколько из них уйдёт в чат спикеров — в <option>
                              разметка не работает, поэтому текстом. */}
                          {s.speakers_chat_count ? `, из них ${s.speakers_chat_count} в чат спикеров` : ''}
                          {`)`}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Шаг 3 — минуты */}
              {shiftSpeakers.length > 0 && (
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Сдвиг в минутах</label>
                  <input
                    type="number"
                    value={shiftMinutes}
                    onChange={e => setShiftMinutes(e.target.value)}
                    placeholder="например 15"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                  <p className="text-[11px] text-gray-400 mt-1">
                    Положительное число — позже, отрицательное (например −10) — раньше.
                  </p>
                </div>
              )}

              {/* Что именно сдвинется */}
              {shiftFromSession && shiftSpeakers.length > 0 && (() => {
                const idx = shiftSpeakers.findIndex(s => String(s.session_id) === String(shiftFromSession))
                const affected = idx >= 0 ? shiftSpeakers.slice(idx) : []
                const total = affected.reduce((acc, s) => acc + (s.schedules_count || 0), 0)
                return (
                  <div className="space-y-2">
                    <div className="px-3 py-2 rounded-lg bg-gray-50 border border-gray-100 text-xs text-gray-600">
                      Сдвинется {total} рассылок у {affected.length} спикеров:{' '}
                      {affected.map(s => s.speaker_name || `#${s.session_id}`).join(', ')}
                    </div>
                    {/* ⚠️ Сдвиг двигает И рассылки в чат спикеров («вы следующие»).
                        Клиент правит тайминг участниковых и не думает про команду —
                        а спикеров позовут в новое время. Об этом надо сказать
                        ДО нажатия, а не показать постфактум. */}
                    <div className="px-3 py-2 rounded-lg bg-orange-50 border border-orange-200 text-xs text-orange-900 flex items-start gap-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-orange-500 text-white shrink-0 mt-px">
                        в чат спикеров
                      </span>
                      <span>
                        Напоминания «вы следующие» сдвинутся вместе с выступлениями —
                        спикеров позовут в новое время. Программа события тоже
                        сдвинется, не только очередь.
                      </span>
                    </div>
                  </div>
                )
              })()}
            </div>

            <div className="flex gap-2 mt-6">
              <button onClick={() => setShiftModal(false)}
                className="flex-1 px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50">
                Отмена
              </button>
              <button
                onClick={runShiftTiming}
                disabled={
                  shiftSaving || !shiftDay || shiftSpeakers.length === 0 || !shiftFromSession ||
                  !Number.isFinite(parseInt(shiftMinutes, 10)) || parseInt(shiftMinutes, 10) === 0
                }
                className="flex-1 px-4 py-2 rounded-xl text-sm text-white font-medium disabled:opacity-50"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                {shiftSaving ? 'Сдвигаю...' : 'Сдвинуть'}
              </button>
            </div>
          </div>
        </div>
      )}

      {genModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto scroll-visible">
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

            <div className="space-y-1.5 mb-5 max-h-[50vh] overflow-y-auto scroll-visible">
              {templates.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">Шаблонов нет — создайте на вкладке «Шаблоны»</p>
              ) : templates.map((t: any) => {
                const checked = genSelectedIds.has(t.id)
                // Рассылка в чат СПИКЕРОВ — не участникам. Помечаем прямо в
                // списке: иначе её ставят в очередь, не понимая, что получателем
                // будет закрытый чат команды, а не аудитория события.
                const toSpeakers = !!t.send_to_speakers_chat
                return (
                  <label key={t.id}
                    className={`flex items-center gap-3 p-2.5 rounded-xl border cursor-pointer ${
                      toSpeakers
                        ? 'border-[#FFCFA4] bg-[#FFF7F0] hover:bg-[#FFF0E4]'
                        : 'border-gray-200 hover:bg-gray-50'}`}>
                    <input type="checkbox" checked={checked}
                      onChange={() => {
                        setGenSelectedIds(prev => {
                          const next = new Set(prev)
                          if (checked) next.delete(t.id); else next.add(t.id)
                          return next
                        })
                      }}
                      className="w-4 h-4 accent-[#25455D]" />
                    <span className="text-sm text-gray-800 flex-1">{t.name}</span>
                    {toSpeakers && (
                      <span className="shrink-0 px-2 py-0.5 rounded-lg bg-[#25455D] text-white text-[10px] font-semibold whitespace-nowrap">
                        В ЧАТ СПИКЕРОВ
                      </span>
                    )}
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

              {/* Выбор спикера — для speaker_intro, expert_day, gift, 5min_before */}
              {(() => {
                const tpl = templates.find(t => String(t.id) === manualForm.template_id)
                const tplType = tpl?.type || ''
                if (tplType === 'speaker_intro' || tplType === 'expert_day') {
                  // speaker_intro и expert_day используют event_collaborators.id
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
                        onChange={e => {
                          const sid = e.target.value
                          // Выбрали спикера — сразу подставляем дату и время его слота
                          // по правилу шаблона (за 5 минут до старта / подарок в конце),
                          // как это делает авто-генерация из программы. Раньше в поле
                          // оставался дефолт «сейчас + 10 мин» — и рассылка вставала на
                          // сегодня, а не на день выступления.
                          const auto = sid
                            ? fireAtForSession(tplType, Number(sid), confSessions, confDays, tpl?.offset_minutes)
                            : ''
                          setManualForm(f => ({ ...f, session_id: sid, ...(auto ? { fire_at: auto } : {}) }))
                        }}
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
                if (DAY_TYPES.includes(tplType) && confDays.length > 0) {
                  return (
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">День программы</label>
                      <select
                        value={manualForm.day}
                        onChange={e => {
                          const day = e.target.value
                          // Выбрали день — сразу подставляем дату и время отправки
                          // по правилу шаблона (за 2 часа / за 30 мин / за сутки…).
                          const auto = day ? fireAtForDay(tplType, Number(day), confDays, confSessions) : ''
                          setManualForm(f => ({ ...f, day, ...(auto ? { fire_at: auto } : {}) }))
                        }}
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
                              День {d.day_number}{dateLabel}{d.title ? ` · ${d.title}` : ''}
                            </option>
                          )
                        })}
                      </select>
                      <p className="text-[11px] text-gray-400 mt-1">
                        В сообщение попадёт программа этого дня. Дата отправки подставится сама — её можно поправить ниже.
                      </p>
                    </div>
                  )
                }
                return null
              })()}

              <div>
                <label className="text-xs text-gray-500 mb-1 block">Когда отправить</label>
                <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm mb-2">
                  <button type="button" onClick={() => setManualSendMode('schedule')}
                    className={`px-3 py-1.5 ${manualSendMode === 'schedule' ? 'bg-brand text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                    Запланировать
                  </button>
                  <button type="button" onClick={() => setManualSendMode('now')}
                    className={`px-3 py-1.5 border-l border-gray-200 ${manualSendMode === 'now' ? 'bg-brand text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                    Отправить немедленно
                  </button>
                </div>
                {manualSendMode === 'schedule' ? (
                  <input type="datetime-local"
                    value={manualForm.fire_at}
                    onChange={e => setManualForm({ ...manualForm, fire_at: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                ) : (
                  <p className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                    Рассылка встанет в очередь и уйдёт в течение минуты после сохранения.
                  </p>
                )}
              </div>
              <div className="border border-gray-100 rounded-xl p-3 bg-gray-50 space-y-2">
                <p className="text-xs font-medium text-gray-600">👥 Аудитория</p>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Включить</label>
                  <select
                    value={audBase(manualForm.audience_include)}
                    onChange={e => setManualForm({ ...manualForm, audience_include: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="all_event">Все участники конфы</option>
                    <option value="registered_event">Зарегистрированные участники</option>
                    {hasPayments && <option value="paid_event">Оплатившие</option>}
                    {hasPayments && <option value="unpaid_event">Имеют неоплаченный заказ</option>}
                    <option value="all_client">Вся база клиента</option>
                  </select>
                  {hasPayments && <PayTariffPicker eventId={eventId} value={manualForm.audience_include} onChange={v => setManualForm({ ...manualForm, audience_include: v })} />}
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Исключить</label>
                  <select
                    value={audBase(manualForm.audience_exclude)}
                    onChange={e => setManualForm({ ...manualForm, audience_exclude: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="none">Никого не исключать</option>
                    <option value="registered_event">Зарегистрированных участников</option>
                    <option value="unregistered_event">Незарегистрированных участников</option>
                    {hasPayments && <option value="paid_event">Оплативших</option>}
                    {hasPayments && <option value="unpaid_event">Имеющих неоплаченный заказ</option>}
                    <option value="all_event">Всех участников конфы</option>
                  </select>
                  {hasPayments && <PayTariffPicker eventId={eventId} value={manualForm.audience_exclude} onChange={v => setManualForm({ ...manualForm, audience_exclude: v })} />}
                </div>
                <p className="text-xs text-indigo-600 font-medium">
                  Итого: {audienceLabel(manualForm.audience_include, manualForm.audience_exclude, eventTariffs)}
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
        const botMap: Record<string, { sent: number; failed: number; platform: string }> = {}
        for (const r of logModal.rows) {
          const key = r.channel_handle || r.channel_name || 'Без указания'
          if (!botMap[key]) botMap[key] = { sent: 0, failed: 0, platform: r.channel_platform || '' }
          if (r.status === 'sent') botMap[key].sent += 1
          else botMap[key].failed += 1
        }
        const botEntries = Object.entries(botMap).sort((a, b) => (b[1].sent + b[1].failed) - (a[1].sent + a[1].failed))
        // Отправки в ЧАТЫ — отдельным блоком (миграция 220).
        const chats = logModal.chats || []
        const CHAT_KIND_LABEL: Record<string, string> = {
          event: 'Чат события', client_common: 'Общий чат', client_private: 'Личный канал',
        }
        const chatSent = chats.filter((c: any) => c.status === 'sent').length
        const chatFailed = chats.length - chatSent
        // ⚠️ Техническую ошибку моста («WA-bridge POST /sessions/1/send error 409:
        // session not ready») клиенту показывать бессмысленно — по ней не понять
        // ни причины, ни что делать. Переводим на человеческий.
        const chatError = (c: any): string => {
          const e = String(c.error || '')
          if (/session not ready|session not found/i.test(e)) {
            return 'WhatsApp отвязался — привяжите заново'
          }
          return e
        }
        // Слетевшая WhatsApp-сессия — отдельная строка: это чинится в Каналах,
        // а не «само пройдёт», и молчать об этом нельзя.
        const waDeadInReport = chats.some(
          (c: any) => c.chat_platform === 'whatsapp' && /session not ready|session not found/i.test(String(c.error || ''))
        )
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
                  <div key={handle}>
                    <div className="flex items-center justify-between text-xs text-blue-800">
                      <span className="truncate flex-1">{handle}</span>
                      <span className="ml-2">
                        <span className="font-bold text-green-700">{st.sent}</span>
                        {st.failed > 0 && <span className="text-red-500"> ✕ {st.failed}</span>}
                      </span>
                    </div>
                    {/* Воронка — прямо под своим email-каналом. */}
                    {st.platform === 'email' && <EmailFunnelStats stats={logModal.emailStats} />}
                  </div>
                ))}
              </div>
            ) : null}
            {/* По чатам — отправки в групповые чаты (события / общие / личные) */}
            {chats.length > 0 && (
              <div className="mb-3 bg-emerald-50 border border-emerald-200 rounded-xl p-3 space-y-1.5">
                <p className="text-xs font-semibold text-emerald-800">
                  По чатам: <span className="text-green-700">доставлено {chatSent}</span>
                  {chatFailed > 0 && <span className="text-red-500"> · не доставлено {chatFailed}</span>}
                </p>
                {chats.map((c: any, i: number) => {
                  const ok = c.status === 'sent'
                  const plat = (c.chat_platform || '').toUpperCase()
                  return (
                    <div key={i} className={`flex items-center justify-between text-xs px-2 py-1 rounded ${ok ? '' : 'bg-red-50'}`}>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={ok ? 'text-green-500' : 'text-red-400'}>{ok ? '✓' : '✗'}</span>
                        <span className="text-emerald-900 font-medium">{CHAT_KIND_LABEL[c.chat_kind] || c.chat_kind}</span>
                        {plat && <span className="text-[10px] text-emerald-600 bg-emerald-100 px-1.5 py-0.5 rounded shrink-0">{plat}</span>}
                        <span className="text-gray-400 truncate">{c.chat_title || c.chat_ref}</span>
                      </div>
                      {!ok && c.error && <span className="text-red-500 shrink-0 ml-2 truncate max-w-[40%]">{chatError(c)}</span>}
                    </div>
                  )
                })}
                {waDeadInReport && (
                  <div className="mt-2 pt-2 border-t border-emerald-200">
                    <p className="text-xs text-red-700">
                      <b>WhatsApp отвязался.</b> Рассылки в чаты WhatsApp не уходят, пока
                      аккаунт не привязан заново:{' '}
                      <a href="/dashboard/channels" className="underline font-semibold">
                        Каналы → «Добавить канал» → WhatsApp
                      </a>. Выбранные группы сохранены.
                    </p>
                  </div>
                )}
              </div>
            )}
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
          </div>
        </div>
        )
      })()}

      {/* ── Модалка: превью сообщения ── */}
      {previewModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 max-h-[90vh] overflow-y-auto scroll-visible">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800 text-sm">
                Превью: {TYPE_LABELS[previewModal.template_type] || previewModal.template_type}
              </h3>
              <button onClick={() => setPreviewModal(null)}><X size={18} /></button>
            </div>
            {previewModal.is_sent_snapshot && (
              <p className="text-xs text-gray-500 mb-3 -mt-2">
                Это текст, который реально был отправлен. Правки шаблона его не меняют.
              </p>
            )}
            {/* Вкладки площадок — показываем только если в подарках есть ссылки
                воронки (у разных площадок они разные: TG/VK/MAX-бот клиента).
                ⚠️ Только площадки, где у клиента ПОДКЛЮЧЁН свой канал — их
                присылает бэк ключами text_by_platform. Одна площадка → одна
                активная вкладка (не прячем, чтобы было видно, куда уйдёт). */}
            {previewModal.text_by_platform && (
              <div className="flex gap-1 mb-3">
                {([['telegram', 'Telegram'], ['vk', 'VK'], ['max', 'MAX'], ['email', 'Email']] as const)
                  .filter(([pk]) => pk in (previewModal.text_by_platform || {}))
                  .map(([pk, label]) => (
                    <button key={pk} onClick={() => setPreviewPlatform(pk)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition ${
                        previewPlatform === pk
                          ? 'bg-[#25455D] text-white'
                          : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}>
                      {label}
                    </button>
                  ))}
              </div>
            )}
            {/* Telegram-bubble */}
            <div className="bg-[#effdde] rounded-2xl rounded-tr-sm p-3 shadow-sm">
              {previewModal.photo && (
                <img src={previewModal.photo} alt=""
                  className="w-full rounded-xl mb-2"
                  style={{ maxHeight: '300px', objectFit: 'contain', background: '#f0f0f0' }}
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
              )}
              {previewModal.subject && (
                <p className="text-sm font-bold text-gray-900 mb-2 break-words"
                  style={{ overflowWrap: 'anywhere' }}>{previewModal.subject}</p>
              )}
              <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed break-words"
                style={{ overflowWrap: 'anywhere' }}
                dangerouslySetInnerHTML={{ __html: (previewModal.text_by_platform?.[previewPlatform] ?? previewModal.text) || '' }} />
              {/* ⚠️ Кнопки берём ПО ПЛОЩАДКЕ: в письме кнопка регистрации
                  разворачивается в три, в мессенджере остаётся одна. Список
                  считает бэк (_buttons_by_platform) — одной логикой с боевой
                  отправкой. Старый снимок без этого поля → общий список. */}
              {(() => {
                const perPlat = previewModal.buttons_by_platform?.[previewPlatform]
                const btns = (perPlat && perPlat.length) ? perPlat : previewModal.buttons
                return btns && btns.length > 0 ? (
                <div className="mt-3 space-y-1.5">
                  {btns.map((b: any, i: number) => (
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
                  {(previewModal.button_url_by_platform?.[previewPlatform] ?? previewModal.button_url) && (
                    <p className="text-xs text-gray-400 mt-1 text-center break-all">
                      {previewModal.button_url_by_platform?.[previewPlatform] ?? previewModal.button_url}
                    </p>
                  )}
                </>
              ) : null
              })()}
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
  // datetime-local показывает московское стенное время (как трактует бэк),
  // независимо от tz браузера клиента. Новая рассылка — «сейчас + 10 мин» по МСК,
  // иначе календарь откроется на «сегодня» по таймзоне компьютера.
  const initFireAt = ed?.fire_at_iso ? utcIsoToTzLocalInput(ed.fire_at_iso) : nowTzLocalInput(10)
  const [fireAt, setFireAt] = useState(initFireAt)
  const [text, setText] = useState(ed?.snapshot_text || '')
  const [subject, setSubject] = useState(ed?.snapshot_subject || '')   // тема (для email)
  const [photoUrl, setPhotoUrl] = useState(ed?.snapshot_photo || '')
  const [buttons, setButtons] = useState<{text: string; url: string}[]>(
    Array.isArray(ed?.snapshot_buttons) ? ed.snapshot_buttons.map((b: any) => ({ text: b.text || '', url: b.url || '' })) : []
  )
  const [isTest, setIsTest] = useState(!!ed?.is_test)
  const [audIn, setAudIn] = useState(ed?.audience_include || 'all_event')
  const [audEx, setAudEx] = useState(ed?.audience_exclude || 'none')
  const [sendToChats, setSendToChats] = useState(!!ed?.send_to_event_chats)
  const [sendToClientChats, setSendToClientChats] = useState(!!ed?.send_to_client_chats)
  const [sendToPrivateChats, setSendToPrivateChats] = useState(!!ed?.send_to_private_chats)
  const [channelIds, setChannelIds] = useState<number[] | null>(
    Array.isArray(ed?.target_channel_ids) ? ed.target_channel_ids : null)
  const { me } = useMe()
  const hasChatsFeature = (me?.features || []).includes('broadcast_chats')
  const hasPayments = (me?.features || []).includes('event_tariffs')
  const [saving, setSaving] = useState(false)
  // Выбранный спикер/организатор/жюри (event_collaborators.id) — тогда работают
  // спикерские плейсхолдеры и подставляется фото. null = обычное сообщение.
  const [speakerEcId, setSpeakerEcId] = useState<number | null>(ed?.session_id ?? null)
  const [dayNum, setDayNum] = useState<number | null>(ed?.day ?? null)   // привязка ко дню программы
  const [collabs, setCollabs] = useState<any[]>([])
  const [days, setDays] = useState<any[]>([])
  const [enqueue, setEnqueue] = useState(true)
  useEffect(() => {
    api.events.listCollaborators(props.eventId)
      .then((r: any) => setCollabs(Array.isArray(r?.items) ? r.items : (Array.isArray(r) ? r : [])))
      .catch(() => setCollabs([]))
    api.conference.days.list(props.eventId)
      .then((r: any) => setDays(r?.days || []))
      .catch(() => setDays([]))
  }, [props.eventId])
  // Привязка ко дню/спикеру → фото берётся по нашим правилам (афиша дня/спикера),
  // ручная загрузка недоступна.
  const photoLocked = !!speakerEcId || dayNum != null

  const htmlErrors = validateTelegramHtml(text)
  const buttonErrors = buttons.map(b => validateButton(b.text, b.url))
  const hasButtonErrors = buttonErrors.some(errs => errs.length > 0)
  const [testing, setTesting] = useState(false)
  // Итог теста показываем ВНУТРИ модалки — родительская плашка перекрыта окном.
  const [testMsg, setTestMsg] = useState('')

  async function sendTestNow() {
    // Здесь текст набирается в обычной <textarea> с onChange на каждый
    // символ — state всегда актуален, читать редактор отдельно не нужно
    // (в форме общих рассылок стоит WYSIWYG, там приходится брать из ref).
    const plainTest = (text || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    if (!plainTest) { setTestMsg('Сначала напишите текст рассылки'); return }
    if (htmlErrors.length > 0) { setTestMsg('Исправьте HTML-ошибки в тексте'); return }
    if (hasButtonErrors) { setTestMsg('Исправьте ошибки в кнопках'); return }
    setTestMsg('')
    setTesting(true)
    try {
      // Тест шлётся по СОХРАНЁННОЙ рассылке (её снапшоту) — так плейсхолдеры
      // (в т.ч. программа дня {day_date}/{day_program_with_links}) раскрываются
      // ровно как при реальной отправке. Поэтому сначала сохраняем ЧЕРНОВИКОМ
      // (enqueue:false → status='draft', в очередь НЕ ставим), затем тест по id.
      const payload = {
        fire_at: fireAt || nowMoscowMinus1MinLocal(),
        text,
        photo_url: photoLocked ? null : (photoUrl || null),
        buttons: buttons.filter(b => b.text && b.url),
        is_test: isTest,
        audience_include: audIn,
        audience_exclude: audEx,
        send_to_event_chats: sendToChats,
        send_to_client_chats: hasChatsFeature ? sendToClientChats : false,
        send_to_private_chats: hasChatsFeature ? sendToPrivateChats : false,
        target_channel_ids: channelIds,
        speaker_ec_id: speakerEcId,
        day: dayNum,
        subject: subject || null,
        enqueue: false,
      }
      let schedId = ed?.id
      if (schedId) {
        await api.conference.schedules.editCustom(props.eventId, schedId, payload)
      } else {
        const created = await api.conference.schedules.addCustom(props.eventId, payload)
        schedId = created?.id
      }
      if (!schedId) { setTestMsg('Не удалось сохранить черновик для теста'); props.onError('Не удалось сохранить черновик для теста'); return }
      const r = await api.conference.schedules.testScheduleNow(props.eventId, schedId)
      const failed = (r.results || []).filter((x: any) => !x.ok)
      if (failed.length > 0) {
        { const m = `Доставлено ${r.sent} из ${r.total}. Не ушло: ${failed.map((f: any) => `${f.platform} — ${f.error}`).join('; ')}`; setTestMsg(m); props.onError(m) }
      } else {
        { const m = `✅ Тест отправлен (${r.sent} шт) на ваши тестовые адреса. Рассылка сохранена черновиком.`; setTestMsg(m); props.onError(m) }
      }
      props.onSaved()
    } catch (e: any) {
      const m = e.message || 'Ошибка тестовой отправки'
      setTestMsg(m); props.onError(m)
    } finally {
      setTesting(false)
    }
  }

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
        photo_url: photoLocked ? null : (photoUrl || null),
        buttons: buttons.filter(b => b.text && b.url),
        is_test: isTest,
        audience_include: audIn,
        audience_exclude: audEx,
        send_to_event_chats: sendToChats,
        send_to_client_chats: hasChatsFeature ? sendToClientChats : false,
        send_to_private_chats: hasChatsFeature ? sendToPrivateChats : false,
        target_channel_ids: channelIds,
        speaker_ec_id: speakerEcId,
        day: dayNum,
        subject: subject || null,
        enqueue: enqueue,
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
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto scroll-visible">
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

          {/* Выбор спикера/организатора/жюри — тогда работают спикерские плейсхолдеры + фото */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Спикер (для плейсхолдеров и фото) — необязательно</label>
            <select
              value={speakerEcId ?? ''}
              onChange={e => setSpeakerEcId(e.target.value ? Number(e.target.value) : null)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
              <option value="">Без спикера (обычное сообщение)</option>
              {collabs.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.role ? ` — ${ROLE_RU[c.role] || c.role}` : ''}
                </option>
              ))}
            </select>
            {speakerEcId && (
              <p className="text-[11px] text-gray-500 mt-1">
                Работают плейсхолдеры {'{speaker_name}'}, {'{speaker_positioning}'}, {'{speaker_achievements}'}, {'{speaker_socials}'}, {'{speaker_material}'}, {'{stream_url}'} и др. Фото возьмётся из карточки спикера, если своё не загружено.
              </p>
            )}
          </div>

          {/* Привязка ко ДНЮ программы — работают дневные плейсхолдеры. Показываем,
              только если у события есть дни. */}
          {days.length > 0 && (
            <div>
              <label className="text-xs text-gray-500 mb-1 block">День программы (для дневных плейсхолдеров) — необязательно</label>
              <select
                value={dayNum ?? ''}
                onChange={e => setDayNum(e.target.value ? Number(e.target.value) : null)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                <option value="">Без привязки ко дню</option>
                {days.map((d: any) => {
                  const dt = d.day_date ? new Date(d.day_date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }) : ''
                  const ttl = d.title || `День ${d.day_number}`
                  return <option key={d.day_number} value={d.day_number}>{[dt, ttl].filter(Boolean).join(' — ')}</option>
                })}
              </select>
              {dayNum != null && (
                <p className="text-[11px] text-gray-500 mt-1">
                  Работают {'{day_program}'}, {'{day_date}'}, {'{day_datetime}'}, {'{stream_url}'} (комната этого дня) и др.
                </p>
              )}
            </div>
          )}

          <div>
            <label className="text-xs text-gray-500 mb-1 block">Фото (опционально)</label>
            {photoLocked ? (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500">
                Фото берётся автоматически — {speakerEcId ? 'афиша/фото спикера' : 'афиша этого дня события'} (по нашим правилам). Ручная загрузка недоступна при привязке к {speakerEcId ? 'спикеру' : 'дню'}.
                {photoUrl && (
                  <img src={photoUrl} alt="" className="mt-2 max-h-28 rounded-lg object-cover" />
                )}
              </div>
            ) : (
              <>
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
                {/* ⚠️ Срок должен совпадать с cleanup_broadcast_photos (tasks/broadcast.py):
                    24 часа после отправки. Раньше тут стояло «10 минут» — это осталось
                    от старой версии и вводило в заблуждение. */}
                <p className="text-[11px] text-gray-500 mt-1">
                  Файл удалится из хранилища через 24 часа после отправки рассылки — место не занимает.
                </p>
              </>
            )}
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Тема письма <span className="text-gray-400">— для email (в Telegram/VK/MAX — жирная первая строка)</span></label>
            <input value={subject} onChange={e => setSubject(e.target.value)}
              placeholder="Тема — увидят в списке писем email-получатели"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
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
                      <input type="text" value={b.url} placeholder="https://… или {stream_url}"
                        autoComplete="off" autoCorrect="off" spellCheck={false}
                        onChange={e => setButtons(buttons.map((x, j) => j === i ? { ...x, url: e.target.value } : x))}
                        className={`w-full px-3 py-2 border rounded-lg text-sm font-mono ${buttonErrors[i].some(er => er.toLowerCase().includes('ссылк') || er.toLowerCase().includes('url')) ? 'border-red-300 bg-red-50/30' : 'border-gray-200'}`} />
                      <p className="text-[10px] text-gray-400 mt-0.5 ml-1">URL или плейсхолдер: {'{stream_url}'} (эфир), {'{landing_url}'} (регистрация), {'{vip_url}'}, {'{event_chat_tg}'}</p>
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
              <select value={audBase(audIn)} onChange={e => setAudIn(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                <option value="all_event">Все участники конфы</option>
                <option value="registered_event">Зарегистрированные участники</option>
                {hasPayments && <option value="paid_event">Оплатившие</option>}
                {hasPayments && <option value="unpaid_event">Имеют неоплаченный заказ</option>}
                <option value="all_client">Вся база клиента</option>
              </select>
              {hasPayments && <PayTariffPicker eventId={props.eventId} value={audIn} onChange={setAudIn} />}
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Исключить</label>
              <select value={audBase(audEx)} onChange={e => setAudEx(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                <option value="none">Никого не исключать</option>
                <option value="registered_event">Зарегистрированных участников</option>
                <option value="unregistered_event">Незарегистрированных участников</option>
                {hasPayments && <option value="paid_event">Оплативших</option>}
                {hasPayments && <option value="unpaid_event">Имеющих неоплаченный заказ</option>}
                <option value="all_event">Всех участников конфы</option>
              </select>
              {hasPayments && <PayTariffPicker eventId={props.eventId} value={audEx} onChange={setAudEx} />}
            </div>
          </div>
          {!ed?.id && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={!enqueue} onChange={e => setEnqueue(!e.target.checked)} className="rounded" />
              <span className="text-sm text-gray-600">Сохранить черновиком (не ставить сразу в очередь)</span>
            </label>
          )}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isTest} onChange={e => setIsTest(e.target.checked)} className="rounded" />
            <span className="text-sm text-gray-600">Тестовая рассылка (только тестовым Telegram ID)</span>
          </label>
          {/* Каналы для отправки */}
          <BroadcastChannelPicker value={channelIds} onChange={(next) => setChannelIds(next)} />
          {/* Три независимые галочки: чат события / общие чаты / личные каналы. */}
          <label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
            <input type="checkbox" checked={sendToChats} onChange={e => setSendToChats(e.target.checked)}
              className="w-4 h-4 mt-0.5 accent-[#25455D]" />
            <span>
              <span className="block text-sm text-gray-800 font-medium">Отправлять в чаты события</span>
              <span className="block text-[11px] text-gray-500 mt-0.5">
                В групповые чаты этого события (заданы в настройках события).
              </span>
            </span>
          </label>
          {hasChatsFeature && (
            <label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={sendToClientChats} onChange={e => setSendToClientChats(e.target.checked)}
                className="w-4 h-4 mt-0.5 accent-[#25455D]" />
              <span>
                <span className="block text-sm text-gray-800 font-medium">Отправлять в общие чаты</span>
                <span className="block text-[11px] text-gray-500 mt-0.5">
                  В общие группы/каналы из базы чатов (Каналы → «Группы/Каналы для рассылок», без галочки «Личный»).
                </span>
              </span>
            </label>
          )}
          {hasChatsFeature && (
            <label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={sendToPrivateChats} onChange={e => setSendToPrivateChats(e.target.checked)}
                className="w-4 h-4 mt-0.5 accent-[#25455D]" />
              <span>
                <span className="block text-sm text-gray-800 font-medium">Отправлять в личные каналы</span>
                <span className="block text-[11px] text-gray-500 mt-0.5">
                  В каналы из базы чатов, помеченные галочкой «Личный».
                </span>
              </span>
            </label>
          )}
        </div>
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
          <button onClick={save} disabled={saving || htmlErrors.length > 0 || hasButtonErrors}
            className="flex-1 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-60"
            style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
            {saving ? 'Сохраняю...' : htmlErrors.length > 0 ? 'Исправьте HTML' : hasButtonErrors ? 'Исправьте кнопки' : (ed?.id ? 'Сохранить' : (enqueue ? 'Поставить в очередь' : 'Сохранить черновик'))}
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
  // enqueue=false → черновики (по умолчанию), true → сразу в очередь.
  const [enqueue, setEnqueue] = useState(false)
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
      let chat_private = false
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
          if (/личн/.test(v)) { chat_private = true }
          else if (/событ/.test(v)) { chat_event = true }
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
        send_to_private_chats: chat_private,
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
        enqueue,
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
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl p-6 max-h-[92vh] overflow-y-auto scroll-visible">
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
            Если в блоке не указать — уйдёт всем участникам события.
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
