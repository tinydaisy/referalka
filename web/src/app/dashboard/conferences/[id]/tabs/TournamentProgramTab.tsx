'use client'
import { useState, useEffect, useRef } from 'react'
import { Plus, Calendar, Trash2, ChevronLeft, ChevronRight, ChevronDown, Layers, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import ShiftTimingModal from '@/components/ShiftTimingModal'
import { Spinner } from '@/components/Spinner'

// AJAX-режим (2026-06-27): НИКАКОГО локального буфера и кнопки «Сохранить
// программу». Каждое действие сразу пишется в БД:
//  • Добавить/удалить этап, день, слот — POST/DELETE сразу по клику.
//  • Текстовые поля (название, даты, описание, время) — PATCH на blur (уход
//    из поля), чтобы не спамить сервер на каждую букву.
//  • Спикер/тема/время слота — POST/PATCH по «Сохранить слот».
//  • Порядок этапов (стрелки ← →) — PATCH sort_order сразу.
// load() НЕ дёргается после каждого действия — обновляем только нужный кусок
// стейта ответом сервера (фокус и значения других полей не сбрасываются).

type Stage = {
  id: number
  sort_order: number
  title: string
  subtitle: string | null
  description: string | null
  start_date: string | null
  end_date: string | null
}
type Day = {
  day_number: number
  day_date: string | null
  open_time: string | null
  close_time: string | null
  stream_url: string | null
  stage_id: number | null
  title: string | null
  show_for_speakers?: boolean
}
type Sess = {
  id: number
  day: number
  start_time: string | null
  end_time: string | null
  title: string
  speaker_id?: number | null
  speaker_name?: string | null
  sort_order: number
}

// Спец-id «вкладки» для дней без этапа.
const ORPHAN_TAB = 0

// Дата дня (conf_days.day_date) — это чистая КАЛЕНДАРНАЯ дата "YYYY-MM-DD",
// не привязанная к часовому поясу. Форматируем разбором строки, БЕЗ new Date()/timeZone,
// иначе полночь трактуется в поясе браузера и при выводе в МСК уезжает на сутки назад.
const DAY_MONTHS_SHORT = ['янв.', 'фев.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сен.', 'окт.', 'ноя.', 'дек.']
function formatDayDateLabel(d?: string | null): string {
  if (!d) return ''
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return d
  return `${parseInt(m[3], 10)} ${DAY_MONTHS_SHORT[parseInt(m[2], 10) - 1]}`
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export default function TournamentProgramTab({ eventId }: { eventId: number }) {
  const [stages, setStages] = useState<Stage[]>([])
  const [days, setDays] = useState<Day[]>([])
  const [sessions, setSessions] = useState<Sess[]>([])
  const [speakers, setSpeakers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  // Индикатор фонового сохранения (показывается ненавязчиво в углу).
  const [busy, setBusy] = useState(false)

  // Активная вкладка-этап (id этапа, либо ORPHAN_TAB для «без группировки»).
  const [activeTab, setActiveTab] = useState<number | null>(null)
  // Раскрытые дни внутри активного этапа (по day_number).
  const [openDays, setOpenDays] = useState<Set<number>>(new Set())

  // Модалка добавления/редактирования слота
  const [sessionModal, setSessionModal] = useState<{ day: number; editId: number | null } | null>(null)
  const [sessionForm, setSessionForm] = useState({ title: '', topic_id: '', speaker_id: '', start_time: '', end_time: '' })
  const [speakerTopics, setSpeakerTopics] = useState<{ id: number; topic: string }[]>([])
  const [customTitle, setCustomTitle] = useState(false)
  const [savingSession, setSavingSession] = useState(false)
  // Тайминг дня — авто-генерация N пустых слотов
  const [timingModal, setTimingModal] = useState<{ day: number } | null>(null)
  // Сдвиг тайминга дня — двигаем слоты (и их рассылки) начиная с выбранного.
  const [shiftModal, setShiftModal] = useState<{ day: number } | null>(null)
  const [timingForm, setTimingForm] = useState({ start_time: '10:00', speaker_count: '10', talk_duration: '20', break_duration: '10' })
  const [savingTiming, setSavingTiming] = useState(false)

  async function saveTiming() {
    if (!timingModal) return
    const count = parseInt(timingForm.speaker_count, 10)
    const talk = parseInt(timingForm.talk_duration, 10)
    const brk = parseInt(timingForm.break_duration, 10)
    if (!count || count < 1) { alert('Укажите количество спикеров'); return }
    if (!talk || talk < 1) { alert('Укажите длительность выступления'); return }
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(timingForm.start_time)) { alert('Укажите время начала в формате ЧЧ:ММ'); return }
    setSavingTiming(true)
    try {
      await api.conference.sessions.generateTiming(eventId, {
        day: timingModal.day,
        start_time: timingForm.start_time,
        speaker_count: count,
        talk_duration: talk,
        break_duration: isNaN(brk) ? 0 : brk,
      })
      setTimingModal(null)
      load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось сгенерировать слоты')
    } finally { setSavingTiming(false) }
  }

  // Обёртка для любого фонового запроса: ставит busy, ловит ошибку алертом.
  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true)
    try {
      return await fn()
    } catch (err: any) {
      alert(err?.message || 'Не удалось сохранить. Попробуйте ещё раз.')
      return null
    } finally {
      setBusy(false)
    }
  }

  async function load(keepTab = true) {
    setLoading(true)
    try {
      const [stRes, dRes, sRes, spRes] = await Promise.all([
        api.conference.stages.list(eventId),
        api.conference.days.list(eventId),
        api.conference.sessions.list(eventId),
        api.conference.speakers.list(eventId),
      ])
      const loadedStages: Stage[] = (stRes.stages || []).map((s: any) => ({
        id: s.id, sort_order: s.sort_order,
        title: s.title || '', subtitle: s.subtitle || '', description: s.description || '',
        start_date: s.start_date || '', end_date: s.end_date || '',
      }))
      const loadedDays: Day[] = (dRes.days || []).map((d: any) => ({
        day_number: d.day_number,
        day_date: d.day_date || '', open_time: d.open_time || '', close_time: d.close_time || '',
        stream_url: d.stream_url || '', stage_id: d.stage_id ?? null, title: d.title || '',
        show_for_speakers: d.show_for_speakers ?? true,
      }))
      setStages(loadedStages)
      setDays(loadedDays)
      setSessions(sRes.sessions || [])
      setSpeakers(spRes.speakers || [])
      setActiveTab(prev => {
        const sortedIds = [...loadedStages].sort((a, b) => a.sort_order - b.sort_order).map(s => s.id)
        const hasOrphans = loadedDays.some(d => d.stage_id == null)
        if (keepTab && prev != null && (sortedIds.includes(prev) || (prev === ORPHAN_TAB && hasOrphans))) return prev
        if (sortedIds.length > 0) return sortedIds[0]
        if (hasOrphans) return ORPHAN_TAB
        return null
      })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [eventId])

  // ─── Этапы ───────────────────────────────────────────────────────────────────

  async function addStage() {
    const nextOrder = stages.length > 0 ? Math.max(...stages.map(s => s.sort_order)) + 1 : 0
    const res = await run(() => api.conference.stages.create(eventId, {
      title: `Этап ${stages.length + 1}`, subtitle: null, description: null,
      start_date: null, end_date: null, sort_order: nextOrder,
    }))
    if (!res?.stage) return
    const s = res.stage
    const newStage: Stage = {
      id: s.id, sort_order: s.sort_order,
      title: s.title || '', subtitle: s.subtitle || '', description: s.description || '',
      start_date: s.start_date || '', end_date: s.end_date || '',
    }
    setStages(prev => [...prev, newStage])
    setActiveTab(newStage.id)
  }

  async function deleteStage(stageId: number) {
    const stageDays = days.filter(d => d.stage_id === stageId)
    if (stageDays.length === 0) {
      if (!confirm('Удалить этап?')) return
      const ok = await run(() => api.conference.stages.delete(eventId, stageId))
      if (ok == null) return
      setStages(prev => prev.filter(s => s.id !== stageId))
      if (activeTab === stageId) setActiveTab(null)
      return
    }
    const withDays = confirm(
      `В этапе ${stageDays.length} ${stageDays.length === 1 ? 'день' : 'дня(дней)'}.\n\n` +
      `ОК — удалить этап ВМЕСТЕ с этими днями и их слотами.\n` +
      `Отмена — оставить дни «без группировки».\n\n` +
      `Что выбрать?`
    )
    const ok = await run(async () => {
      if (withDays) {
        for (const d of stageDays) await api.conference.days.delete(eventId, d.day_number)
      } else {
        // Открепляем дни от этапа на сервере (stage_id=null), потом удаляем этап.
        for (const d of stageDays) {
          await api.conference.days.upsert(eventId, d.day_number, {
            day_date: d.day_date || null, open_time: d.open_time || null,
            close_time: d.close_time || null, stream_url: d.stream_url || null,
            stage_id: null, title: d.title || null,
          })
        }
      }
      return api.conference.stages.delete(eventId, stageId)
    })
    if (ok == null) return
    if (withDays) {
      const delNums = new Set(stageDays.map(d => d.day_number))
      setDays(prev => prev.filter(d => !delNums.has(d.day_number)))
      setSessions(prev => prev.filter(s => !delNums.has(s.day)))
    } else {
      setDays(prev => prev.map(d => d.stage_id === stageId ? { ...d, stage_id: null } : d))
    }
    setStages(prev => prev.filter(s => s.id !== stageId))
    if (activeTab === stageId) setActiveTab(null)
  }

  async function deleteAllOrphans() {
    const orphans = days.filter(d => !d.stage_id)
    if (orphans.length === 0) return
    if (!confirm(`Удалить все ${orphans.length} ${orphans.length === 1 ? 'день' : 'дня(дней)'} без группировки? Все слоты в них тоже удалятся.`)) return
    const ok = await run(async () => {
      for (const d of orphans) await api.conference.days.delete(eventId, d.day_number)
      return true
    })
    if (ok == null) return
    const delNums = new Set(orphans.map(d => d.day_number))
    setDays(prev => prev.filter(d => !delNums.has(d.day_number)))
    setSessions(prev => prev.filter(s => !delNums.has(s.day)))
    if (activeTab === ORPHAN_TAB) setActiveTab(null)
  }

  // Перемещает активный этап в табах влево/вправо — меняем sort_order пары на сервере.
  async function moveStage(stageId: number, dir: -1 | 1) {
    const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order)
    const idx = sorted.findIndex(s => s.id === stageId)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= sorted.length) return
    const a = sorted[idx], b = sorted[target]
    const ok = await run(async () => {
      await api.conference.stages.update(eventId, a.id, { sort_order: b.sort_order })
      await api.conference.stages.update(eventId, b.id, { sort_order: a.sort_order })
      return true
    })
    if (ok == null) return
    setStages(prev => prev.map(s => {
      if (s.id === a.id) return { ...s, sort_order: b.sort_order }
      if (s.id === b.id) return { ...s, sort_order: a.sort_order }
      return s
    }))
  }

  // Локальная правка поля этапа (без запроса — запрос уйдёт на blur).
  function patchStageLocal(stageId: number, patch: Partial<Stage>) {
    setStages(prev => prev.map(s => s.id === stageId ? { ...s, ...patch } : s))
  }
  // Сохранение поля этапа на сервере (на blur).
  async function commitStage(stageId: number) {
    const s = stages.find(x => x.id === stageId)
    if (!s) return
    await run(() => api.conference.stages.update(eventId, stageId, {
      title: s.title || 'Без названия',
      subtitle: s.subtitle || null,
      description: s.description || null,
      start_date: s.start_date || null,
      end_date: s.end_date || null,
      sort_order: s.sort_order,
    }))
  }

  // ─── Дни ─────────────────────────────────────────────────────────────────────

  async function addDayToStage(stageId: number | null) {
    const nextNum = days.length > 0 ? Math.max(...days.map(d => d.day_number)) + 1 : 1
    const res = await run(() => api.conference.days.upsert(eventId, nextNum, {
      day_date: null, open_time: null, close_time: null, stream_url: null,
      stage_id: stageId, title: null,
    }))
    if (!res?.day) return
    const d = res.day
    setDays(prev => [...prev, {
      day_number: d.day_number, day_date: d.day_date || '', open_time: d.open_time || '',
      close_time: d.close_time || '', stream_url: d.stream_url || '',
      stage_id: d.stage_id ?? null, title: d.title || '',
    }])
    setOpenDays(prev => new Set(prev).add(nextNum))
  }

  async function deleteDay(dayNum: number) {
    if (!confirm(`Удалить день и все его слоты?`)) return
    const ok = await run(() => api.conference.days.delete(eventId, dayNum))
    if (ok == null) return
    setDays(prev => prev.filter(d => d.day_number !== dayNum))
    setSessions(prev => prev.filter(s => s.day !== dayNum))
  }

  function patchDayLocal(dayNum: number, patch: Partial<Day>) {
    setDays(prev => prev.map(d => d.day_number === dayNum ? { ...d, ...patch } : d))
  }
  // Сохранение полей дня (на blur, и сразу при смене этапа в селекте).
  async function commitDay(dayNum: number, override?: Partial<Day>) {
    const cur = days.find(d => d.day_number === dayNum)
    if (!cur) return
    const d = { ...cur, ...(override || {}) }
    await run(() => api.conference.days.upsert(eventId, dayNum, {
      day_date: d.day_date || null,
      open_time: d.open_time || null,
      close_time: d.close_time || null,
      stream_url: d.stream_url || null,
      stage_id: d.stage_id ?? null,
      title: d.title || null,
      show_for_speakers: d.show_for_speakers ?? true,
    }))
  }

  function toggleDayOpen(dayNum: number) {
    setOpenDays(prev => {
      const n = new Set(prev)
      if (n.has(dayNum)) n.delete(dayNum); else n.add(dayNum)
      return n
    })
  }

  // ─── Слоты ───────────────────────────────────────────────────────────────────

  function onSpeakerChange(speakerId: string) {
    const sp = speakers.find((s: any) => String(s.id) === speakerId)
    const topics: { id: number; topic: string }[] = sp?.topics && sp.topics.length > 0 ? sp.topics : []
    setSpeakerTopics(topics)
    setCustomTitle(false)
    const autoTopicId = topics.length === 1 ? String(topics[0].id) : ''
    const autoTitle = topics.length === 1 ? topics[0].topic : ''
    setSessionForm(f => ({ ...f, speaker_id: speakerId, topic_id: autoTopicId, title: autoTitle }))
  }

  function openSessionEdit(s: Sess) {
    const sp = speakers.find((x: any) => String(x.id) === String(s.speaker_id ?? ''))
    const topics: { id: number; topic: string }[] = sp?.topics && sp.topics.length > 0 ? sp.topics : []
    setSpeakerTopics(topics)
    // если у слота есть тема, совпадающая с темой спикера — выставляем topic_id (для селекта при 2+ темах)
    const matched = topics.find(t => t.topic === s.title)
    setCustomTitle(false)
    setSessionForm({
      title: s.title || '',
      topic_id: matched ? String(matched.id) : (topics.length === 1 ? String(topics[0].id) : ''),
      speaker_id: s.speaker_id != null ? String(s.speaker_id) : '',
      start_time: s.start_time || '',
      end_time: s.end_time || '',
    })
    setSessionModal({ day: s.day, editId: s.id })
  }

  function closeSessionModal() {
    setSessionModal(null)
    setSessionForm({ title: '', topic_id: '', speaker_id: '', start_time: '', end_time: '' })
    setSpeakerTopics([])
    setCustomTitle(false)
  }

  async function saveSession() {
    if (!sessionModal) return
    const speakerId = sessionForm.speaker_id ? Number(sessionForm.speaker_id) : null
    // Без спикера тема обязательна. Со спикером — тема живёт по topic_id;
    // если её нет, ставим заглушку «Тема будет уточнена позже».
    if (!speakerId && !sessionForm.title.trim()) return
    const speakerName = speakerId != null ? (speakers.find((s: any) => s.id === speakerId)?.name || null) : null
    const topicId = sessionForm.topic_id ? Number(sessionForm.topic_id) : null
    const start_time = sessionForm.start_time || null
    const end_time = sessionForm.end_time || null
    const title = sessionForm.title.trim() || (speakerId ? 'Тема будет уточнена позже' : '')
    const payload = {
      day: sessionModal.day,
      title,
      topic_id: topicId,
      speaker_id: speakerId,
      start_time,
      end_time,
    }
    setSavingSession(true)
    try {
      if (sessionModal.editId != null) {
        const res = await api.conference.sessions.update(eventId, sessionModal.editId, payload)
        const srv = res?.session
        setSessions(prev => prev.map(s => s.id === sessionModal.editId
          ? { ...s, title, speaker_id: speakerId, speaker_name: speakerName, start_time, end_time, ...(srv ? {} : {}) }
          : s))
      } else {
        const res = await api.conference.sessions.create(eventId, payload)
        const srv = res?.session
        const daySessions = sessions.filter(s => s.day === sessionModal.day)
        const nextSort = daySessions.length > 0 ? Math.max(...daySessions.map(s => s.sort_order)) + 1 : 0
        setSessions(prev => [...prev, {
          id: srv?.id ?? -Date.now(),
          day: sessionModal.day,
          title, speaker_id: speakerId, speaker_name: speakerName,
          start_time, end_time,
          sort_order: srv?.sort_order ?? nextSort,
        }])
      }
      closeSessionModal()
    } catch (err: any) {
      alert(err?.message || 'Не удалось сохранить слот')
    } finally {
      setSavingSession(false)
    }
  }

  async function deleteSession(id: number) {
    if (!confirm('Удалить этот слот?')) return
    const ok = await run(() => api.conference.sessions.delete(eventId, id))
    if (ok == null) return
    setSessions(prev => prev.filter(s => s.id !== id))
  }

  if (loading) return <div className="flex justify-center py-12"><Spinner className="text-brand text-2xl" /></div>

  const stagesSorted = [...stages].sort((a, b) => a.sort_order - b.sort_order)
  const dayDate = (d: Day) => d.day_date || ''
  const daysByStage = (stageId: number | null) =>
    days.filter(d => d.stage_id === stageId).sort((a, b) => {
      const da = dayDate(a), db_ = dayDate(b)
      if (da && db_) return da < db_ ? -1 : da > db_ ? 1 : a.day_number - b.day_number
      if (da) return -1
      if (db_) return 1
      return a.day_number - b.day_number
    })
  const orphanDays = daysByStage(null)
  const hasOrphans = orphanDays.length > 0

  const activeStage = activeTab != null && activeTab !== ORPHAN_TAB
    ? stagesSorted.find(s => s.id === activeTab) || null
    : null
  const activeStageIdx = activeStage ? stagesSorted.findIndex(s => s.id === activeStage.id) : -1
  const activeStageDays = activeStage ? daysByStage(activeStage.id) : []

  // Пустое состояние — ни этапов, ни дней.
  if (stages.length === 0 && days.length === 0) {
    return (
      <div className="max-w-3xl">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center text-gray-400">
          <Layers size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm mb-2">У турнира пока нет программы.</p>
          <p className="text-xs text-gray-400 mb-4">Создайте первый этап (например, «Предстарт» или «Основной этап»). В этап можно добавить дни — с программой по спикерам.</p>
          <button onClick={addStage} disabled={busy} className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2 mx-auto disabled:opacity-60">
            <Plus size={15} /> Добавить этап
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl pb-16">
      {/* Индикатор фонового сохранения */}
      {busy && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-xs px-3 py-2 rounded-xl shadow-lg flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Сохраняю…
        </div>
      )}

      {/* Кнопка «Добавить этап» НАД вкладками */}
      <div className="flex items-center justify-between mb-3 gap-3">
        <p className="text-xs text-gray-400">
          Каждый этап — на отдельной вкладке. Стрелки ← → меняют порядок этапа. Всё сохраняется автоматически.
        </p>
        <button
          onClick={addStage}
          disabled={busy}
          className="btn-gold px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5 shrink-0 disabled:opacity-60"
        >
          <Plus size={15} /> Добавить этап
        </button>
      </div>

      {/* Ряд вкладок-этапов (+ вкладка «Без группировки») */}
      <div className="flex items-end gap-1 overflow-x-auto -mb-px">
        {stagesSorted.map((stage, i) => {
          const active = activeTab === stage.id
          return (
            <button
              key={stage.id}
              onClick={() => setActiveTab(stage.id)}
              className={`shrink-0 max-w-[220px] px-4 py-2.5 rounded-t-xl border border-b-0 text-sm font-semibold transition-colors flex items-center gap-2 ${
                active
                  ? 'bg-white border-gray-200 text-gray-900 relative z-10'
                  : 'bg-gray-100 border-transparent text-gray-500 hover:bg-gray-200/70'
              }`}
              title={stage.title || `Этап ${i + 1}`}
            >
              <span className="truncate">
                {stage.title?.trim() || `Этап ${i + 1}`}
              </span>
            </button>
          )
        })}
        {hasOrphans && (
          <button
            onClick={() => setActiveTab(ORPHAN_TAB)}
            className={`shrink-0 px-4 py-2.5 rounded-t-xl border border-b-0 text-sm font-semibold transition-colors flex items-center gap-2 ${
              activeTab === ORPHAN_TAB
                ? 'bg-white border-gray-200 text-gray-900 relative z-10'
                : 'bg-gray-100 border-transparent text-gray-500 hover:bg-gray-200/70'
            }`}
          >
            <Calendar size={13} className="opacity-60" />
            Без группировки
          </button>
        )}
      </div>

      {/* Тело активной вкладки */}
      <div className="bg-white rounded-2xl rounded-tl-none border border-gray-200 shadow-sm p-5">
        {activeStage && (
          <>
            <div className="flex items-center justify-between gap-2 mb-4">
              <div className="flex items-center gap-2 text-gray-400 text-sm">
                <Layers size={16} className="opacity-70" />
                <span>Этап {activeStageIdx + 1} из {stagesSorted.length}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => moveStage(activeStage.id, -1)}
                  disabled={activeStageIdx === 0 || busy}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-brand hover:bg-gray-50 disabled:opacity-20 disabled:hover:text-gray-400 disabled:hover:bg-transparent transition-colors"
                  title="Передвинуть этап левее"
                >
                  <ChevronLeft size={17} />
                </button>
                <button
                  onClick={() => moveStage(activeStage.id, 1)}
                  disabled={activeStageIdx === stagesSorted.length - 1 || busy}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-brand hover:bg-gray-50 disabled:opacity-20 disabled:hover:text-gray-400 disabled:hover:bg-transparent transition-colors"
                  title="Передвинуть этап правее"
                >
                  <ChevronRight size={17} />
                </button>
                <button
                  onClick={() => deleteStage(activeStage.id)}
                  disabled={busy}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors ml-1 disabled:opacity-40"
                  title="Удалить этап"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            <div className="space-y-3 mb-5">
              <div>
                <label className="label">Название этапа</label>
                <input
                  type="text"
                  value={activeStage.title || ''}
                  onChange={e => patchStageLocal(activeStage.id, { title: e.target.value })}
                  onBlur={() => commitStage(activeStage.id)}
                  className="input"
                  placeholder="Например, «Предстарт: Живой автор в контенте»"
                />
              </div>
              <div>
                <label className="label">Подпись (опционально)</label>
                <input
                  type="text"
                  value={activeStage.subtitle || ''}
                  onChange={e => patchStageLocal(activeStage.id, { subtitle: e.target.value })}
                  onBlur={() => commitStage(activeStage.id)}
                  className="input"
                  placeholder="«2 недели», «офлайн», «финал»"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Дата старта</label>
                  <input
                    type="date"
                    value={activeStage.start_date || ''}
                    onChange={e => patchStageLocal(activeStage.id, { start_date: e.target.value })}
                    onBlur={() => commitStage(activeStage.id)}
                    className="input"
                  />
                </div>
                <div>
                  <label className="label">Дата окончания</label>
                  <input
                    type="date"
                    value={activeStage.end_date || ''}
                    onChange={e => patchStageLocal(activeStage.id, { end_date: e.target.value })}
                    onBlur={() => commitStage(activeStage.id)}
                    className="input"
                  />
                </div>
              </div>
              <div>
                <label className="label">Описание (опционально)</label>
                <textarea
                  rows={2}
                  value={activeStage.description || ''}
                  onChange={e => patchStageLocal(activeStage.id, { description: e.target.value })}
                  onBlur={() => commitStage(activeStage.id)}
                  className="input resize-none"
                  placeholder="Что происходит на этом этапе"
                />
              </div>
            </div>

            <div className="border-t border-gray-100 pt-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-gray-700">
                  Дни этапа{activeStageDays.length > 0 ? ` (${activeStageDays.length})` : ''}
                </span>
              </div>
              {activeStageDays.length === 0 && (
                <p className="text-xs text-gray-400 py-2">
                  В этом этапе пока нет дней. Этап может оставаться «анонсом» (только заголовок и даты) — или добавьте программу по дням.
                </p>
              )}
              <div className="space-y-2">
                {activeStageDays.map((day, dIdx) => (
                  <DayAccordion
                    key={day.day_number}
                    day={day}
                    indexInStage={dIdx + 1}
                    open={openDays.has(day.day_number)}
                    onToggle={() => toggleDayOpen(day.day_number)}
                    sessions={sessions.filter(s => s.day === day.day_number).sort((a, b) => a.sort_order - b.sort_order)}
                    stages={stagesSorted}
                    busy={busy}
                    onPatchLocal={(patch) => patchDayLocal(day.day_number, patch)}
                    onCommit={(override) => commitDay(day.day_number, override)}
                    onDelete={() => deleteDay(day.day_number)}
                    onAddSession={() => setSessionModal({ day: day.day_number, editId: null })}
                    onEditSession={openSessionEdit}
                    onDeleteSession={deleteSession}
                    onTiming={() => setTimingModal({ day: day.day_number })}
                    onShift={() => setShiftModal({ day: day.day_number })}
                  />
                ))}
              </div>
              <button
                onClick={() => addDayToStage(activeStage.id)}
                disabled={busy}
                className="mt-3 w-full py-2.5 rounded-xl border border-dashed border-gray-200 text-sm text-gray-400 hover:border-brand hover:text-brand transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <Plus size={14} /> Добавить день в этап
              </button>
            </div>
          </>
        )}

        {activeTab === ORPHAN_TAB && (
          <>
            <div className="flex items-center justify-between gap-2 mb-4">
              <div className="flex items-center gap-2 text-gray-400 text-sm">
                <Calendar size={15} className="opacity-70" />
                <span>Дни без этапа ({orphanDays.length})</span>
              </div>
              <button
                onClick={deleteAllOrphans}
                disabled={busy}
                className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1 disabled:opacity-40"
                title="Удалить все дни без группировки"
              >
                <Trash2 size={12} /> Удалить все
              </button>
            </div>
            <div className="space-y-2">
              {orphanDays.map((day, dIdx) => (
                <DayAccordion
                  key={day.day_number}
                  day={day}
                  indexInStage={dIdx + 1}
                  open={openDays.has(day.day_number)}
                  onToggle={() => toggleDayOpen(day.day_number)}
                  sessions={sessions.filter(s => s.day === day.day_number).sort((a, b) => a.sort_order - b.sort_order)}
                  stages={stagesSorted}
                  busy={busy}
                  onPatchLocal={(patch) => patchDayLocal(day.day_number, patch)}
                  onCommit={(override) => commitDay(day.day_number, override)}
                  onDelete={() => deleteDay(day.day_number)}
                  onAddSession={() => setSessionModal({ day: day.day_number, editId: null })}
                  onEditSession={openSessionEdit}
                  onDeleteSession={deleteSession}
                  onTiming={() => setTimingModal({ day: day.day_number })}
                    onShift={() => setShiftModal({ day: day.day_number })}
                />
              ))}
            </div>
          </>
        )}

        {!activeStage && activeTab !== ORPHAN_TAB && (
          <div className="text-center text-gray-400 text-sm py-8">
            Выберите этап сверху или создайте новый.
          </div>
        )}
      </div>

      <button
        onClick={() => addDayToStage(null)}
        disabled={busy}
        className="mt-4 text-xs text-gray-400 hover:text-brand transition-colors flex items-center gap-1.5 disabled:opacity-50"
      >
        <Plus size={13} /> Добавить день без этапа
      </button>

      {/* Модалка добавления/правки слота */}
      {sessionModal && (
        <Modal title={`${sessionModal.editId != null ? 'Редактировать слот' : 'Слот'}`} onClose={closeSessionModal}>
          <div className="space-y-3">
            <div>
              <label className="label">Спикер</label>
              <select value={sessionForm.speaker_id} onChange={e => onSpeakerChange(e.target.value)} className="input bg-white" autoFocus>
                <option value="">— без спикера —</option>
                {[...speakers].sort((a: any, b: any) =>
                  (a.name || '').localeCompare(b.name || '', 'ru')
                ).map((sp: any) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
              </select>
            </div>
            {/* Тема: поле вписывается ТОЛЬКО когда спикер не выбран.
                Со спикером — тема живёт в его карточке (live по topic_id):
                0 тем → подсказка, 1 тема → показываем её, 2+ → выбор. */}
            {!sessionForm.speaker_id ? (
              <div>
                <label className="label">Тема выступления</label>
                <input type="text" value={sessionForm.title}
                  onChange={e => setSessionForm(f => ({ ...f, title: e.target.value, topic_id: '' }))}
                  className="input" placeholder="Например: Тема будет уточнена позже" />
              </div>
            ) : speakerTopics.length > 1 ? (
              <div>
                <label className="label">Тема выступления спикера</label>
                <select
                  onChange={e => {
                    const t = speakerTopics.find(x => String(x.id) === e.target.value)
                    setSessionForm(f => ({ ...f, topic_id: e.target.value, title: t?.topic || '' }))
                  }}
                  value={sessionForm.topic_id}
                  className="input bg-white"
                >
                  <option value="">— выберите тему —</option>
                  {speakerTopics.map(t => <option key={t.id} value={t.id}>{t.topic}</option>)}
                </select>
                <p className="text-xs text-gray-400 mt-1">У спикера несколько тем — выберите для этого слота.</p>
              </div>
            ) : speakerTopics.length === 1 ? (
              <div>
                <label className="label">Тема выступления</label>
                <div className="input bg-gray-50 text-gray-700">{speakerTopics[0].topic}</div>
                <p className="text-xs text-gray-400 mt-1">Тема берётся из карточки спикера и обновится автоматически, если он её изменит.</p>
              </div>
            ) : (
              <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5">
                <p className="text-xs text-amber-800">
                  У спикера пока не задана тема — в программе будет «Тема будет уточнена позже».
                  Как только спикер впишет тему в своей карточке, она подставится сюда автоматически.
                </p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Начало (МСК)</label>
                <input type="time" value={sessionForm.start_time}
                  onChange={e => setSessionForm(f => ({ ...f, start_time: e.target.value }))}
                  className="input" />
              </div>
              <div>
                <label className="label">Конец (МСК)</label>
                <input type="time" value={sessionForm.end_time}
                  onChange={e => setSessionForm(f => ({ ...f, end_time: e.target.value }))}
                  className="input" />
              </div>
            </div>
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={saveSession} disabled={(!sessionForm.speaker_id && !sessionForm.title.trim()) || savingSession}
              className="btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60">
              {savingSession ? <Spinner /> : null}
              {sessionModal.editId != null ? 'Сохранить слот' : 'Добавить слот'}
            </button>
            <button onClick={closeSessionModal} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">Отмена</button>
          </div>
        </Modal>
      )}

      {timingModal && (
        <Modal title="Задать тайминг дня" onClose={() => setTimingModal(null)}>
          <p className="text-xs text-gray-500 mb-4">
            Сгенерируем пустые слоты по порядку — спикеры сами займут их в своём кабинете.
            Слоты <b>добавятся</b> к уже существующим в этом дне.
          </p>
          <div className="space-y-3">
            <div>
              <label className="label">Время начала (МСК)</label>
              <input type="time" value={timingForm.start_time}
                onChange={e => setTimingForm(f => ({ ...f, start_time: e.target.value }))}
                className="input" />
            </div>
            <div>
              <label className="label">Количество спикеров (слотов)</label>
              <input type="number" min={1} max={100} value={timingForm.speaker_count}
                onChange={e => setTimingForm(f => ({ ...f, speaker_count: e.target.value }))}
                className="input" placeholder="10" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Выступление (мин)</label>
                <input type="number" min={1} value={timingForm.talk_duration}
                  onChange={e => setTimingForm(f => ({ ...f, talk_duration: e.target.value }))}
                  className="input" placeholder="20" />
              </div>
              <div>
                <label className="label">Перерыв (мин)</label>
                <input type="number" min={0} value={timingForm.break_duration}
                  onChange={e => setTimingForm(f => ({ ...f, break_duration: e.target.value }))}
                  className="input" placeholder="10" />
              </div>
            </div>
            {(() => {
              const c = parseInt(timingForm.speaker_count, 10), t = parseInt(timingForm.talk_duration, 10), b = parseInt(timingForm.break_duration, 10)
              if (!c || !t) return null
              const total = c * t + Math.max(0, c - 1) * (isNaN(b) ? 0 : b)
              const [hh, mm] = timingForm.start_time.split(':').map(Number)
              const endMin = (hh * 60 + mm + total) % (24 * 60)
              const endStr = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`
              return <p className="text-xs text-gray-500">Итого: {c} слот(ов), с {timingForm.start_time} до ~{endStr} МСК.</p>
            })()}
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={saveTiming} disabled={savingTiming}
              className="btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60">
              {savingTiming ? <Spinner /> : null}
              Сгенерировать слоты
            </button>
            <button onClick={() => setTimingModal(null)} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">Отмена</button>
          </div>
        </Modal>
      )}

      {shiftModal && (
        <ShiftTimingModal
          eventId={eventId}
          day={shiftModal.day}
          sessions={sessions.filter(s => s.day === shiftModal.day)}
          onClose={() => setShiftModal(null)}
          onDone={() => load()}
        />
      )}
    </div>
  )
}

// ─── Подкомпонент: день-аккордеон ──────────────────────────────────────────────

function DayAccordion({
  day, indexInStage, open, onToggle, sessions, stages, busy,
  onPatchLocal, onCommit, onDelete, onAddSession, onEditSession, onDeleteSession, onTiming, onShift,
}: {
  day: Day
  indexInStage: number
  open: boolean
  onToggle: () => void
  sessions: Sess[]
  stages: Stage[]
  busy: boolean
  onPatchLocal: (patch: Partial<Day>) => void
  onCommit: (override?: Partial<Day>) => void
  onDelete: () => void
  onAddSession: () => void
  onEditSession: (s: Sess) => void
  onDeleteSession: (id: number) => void
  onTiming: () => void
  onShift: () => void
}) {
  const dateLabel = formatDayDateLabel(day.day_date)
  // Подпись по умолчанию — порядковый номер дня ВНУТРИ этапа (а не глобальный day_number).
  const defaultLabel = `День ${indexInStage}`
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-2 bg-gray-50 hover:bg-gray-100/70 transition-colors">
        <button onClick={onToggle} className="flex items-center gap-2 flex-1 px-3 py-2.5 text-left min-w-0">
          <ChevronDown
            size={16}
            className={`text-gray-400 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
          />
          <span className="font-semibold text-sm text-gray-800 truncate">
            {day.title?.trim() || defaultLabel}
          </span>
          {dateLabel && <span className="text-xs text-gray-400 shrink-0">· {dateLabel}</span>}
          {sessions.length > 0 && (
            <span className="text-[11px] text-gray-400 shrink-0">· {sessions.length} слот.</span>
          )}
        </button>
        <button onClick={onDelete} disabled={busy} className="text-gray-300 hover:text-red-400 transition-colors p-2 shrink-0 disabled:opacity-40" title="Удалить день">
          <Trash2 size={14} />
        </button>
      </div>

      {open && (
        <div className="bg-white">
          <div className="px-4 py-3 space-y-3 border-b border-gray-50">
            <div>
              <label className="label">Название дня (опционально)</label>
              <input
                type="text"
                value={day.title || ''}
                onChange={e => onPatchLocal({ title: e.target.value })}
                onBlur={() => onCommit()}
                className="input"
                placeholder={`По умолчанию — «${defaultLabel}»`}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Дата</label>
                <input
                  type="date"
                  value={day.day_date || ''}
                  onChange={e => onPatchLocal({ day_date: e.target.value })}
                  onBlur={() => onCommit()}
                  className="input"
                />
              </div>
              <div>
                <label className="label">Этап</label>
                <select
                  value={day.stage_id == null ? '' : String(day.stage_id)}
                  onChange={e => {
                    const v = e.target.value === '' ? null : Number(e.target.value)
                    onPatchLocal({ stage_id: v })
                    onCommit({ stage_id: v })  // смена этапа — сохраняем сразу
                  }}
                  className="input bg-white"
                >
                  <option value="">— без этапа —</option>
                  {stages.map((s, i) => <option key={s.id} value={s.id}>Этап {i + 1}: {s.title}</option>)}
                </select>
              </div>
            </div>
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={day.show_for_speakers ?? true}
                onChange={e => { onPatchLocal({ show_for_speakers: e.target.checked }); onCommit({ show_for_speakers: e.target.checked }) }}
                className="mt-0.5 accent-[#25455D]"
              />
              <span className="text-xs text-gray-600 leading-snug">
                Показывать этот день спикерам в их кабинете
                <span className="block text-gray-400">Выключите для орг-встреч и других дней, которые спикерам видеть не нужно.</span>
              </span>
            </label>
          </div>

          <div className="px-4 py-2.5">
            {sessions.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-2">Нет слотов</p>
            ) : (
              <div className="space-y-1 mb-2">
                {sessions.map(s => {
                  // Незанятый слот (нет спикера) — подсвечиваем красным.
                  const free = s.speaker_id == null
                  return (
                  <div key={s.id}
                    className={`flex items-start gap-3 group py-1 rounded-lg ${free ? 'bg-red-50 border border-red-200 px-2' : ''}`}>
                    <button
                      onClick={() => onEditSession(s)}
                      className={`flex items-start gap-3 flex-1 text-left rounded-lg -mx-1 px-1 transition-colors ${free ? 'hover:bg-red-100/50' : 'hover:bg-gray-50'}`}
                      title="Редактировать слот"
                    >
                      <span className="text-[11px] text-gray-400 w-32 shrink-0 pt-0.5 font-mono whitespace-nowrap">
                        {s.start_time || ''}{s.end_time ? ` — ${s.end_time}` : ''}{s.start_time ? ' МСК' : ''}
                      </span>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-900 group-hover:text-brand transition-colors">{s.title}</p>
                        {s.speaker_name && <p className="text-xs text-gray-400">{s.speaker_name}</p>}
                      </div>
                    </button>
                    <button onClick={() => onDeleteSession(s.id)} disabled={busy}
                      className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition-all p-1 rounded shrink-0 disabled:opacity-40">
                      <Trash2 size={12} />
                    </button>
                  </div>
                  )
                })}
              </div>
            )}
            <div className="flex items-center gap-4">
              <button onClick={onAddSession}
                className="text-xs text-brand hover:text-brand/80 flex items-center gap-1.5 transition-colors">
                <Plus size={13} /> Добавить слот
              </button>
              <button onClick={onTiming}
                className="text-xs text-[#25455D] hover:opacity-80 flex items-center gap-1.5 transition-colors font-medium">
                ⏱ Задать тайминг
              </button>
              {sessions.some(s => s.start_time) && (
                <button onClick={onShift}
                  className="text-xs text-[#25455D] hover:opacity-80 flex items-center gap-1.5 transition-colors font-medium">
                  ↔ Сдвинуть тайминг
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
