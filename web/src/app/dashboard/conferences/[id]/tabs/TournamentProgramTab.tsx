'use client'
import { useState, useEffect, useMemo } from 'react'
import { Plus, Calendar, Trash2, Save, ChevronLeft, ChevronRight, ChevronDown, Layers } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

// ВАЖНО (2026-06-23): вся работа этой вкладки — ЛОКАЛЬНАЯ, в памяти браузера.
// Добавление/удаление/правка этапов, дней и слотов НЕ ходит на сервер, пока
// пользователь не нажмёт «Сохранить программу». Это убирает баг, когда добавление
// дня вызывало load() и стирало все несохранённые поля.
//
// UI (2026-06-27): этапы — это ВКЛАДКИ сверху (как браузерные табы). Над ними —
// кнопка «Добавить этап». Стрелки ← → меняют порядок активного этапа. Под вкладками
// открывается содержимое только выбранного этапа. Дни внутри этапа — сворачиваемый
// аккордеон (стрелочка ▸), чтобы не было каши из десятков раскрытых форм сразу.
//
// Идентификаторы:
//  • Этапы — серверный id (положительный) или временный (отрицательный, для новых).
//  • Дни — идентифицируются day_number (число дня). Стабильно, через PUT-upsert.
//  • Слоты — серверный id (положительный) или временный (отрицательный).
// При сохранении: создаём новые этапы → маппим временные id → реальные →
// upsert-им дни → синхронизируем слоты (create/update/delete) → удаляем помеченное.

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

let tmpCounter = -1
const nextTmpId = () => tmpCounter--

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
  // Текущее (рабочее) состояние — то, что пользователь видит и правит.
  const [stages, setStages] = useState<Stage[]>([])
  const [days, setDays] = useState<Day[]>([])
  const [sessions, setSessions] = useState<Sess[]>([])
  const [speakers, setSpeakers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [savingAll, setSavingAll] = useState(false)

  // Снимок данных как они лежат на сервере (для вычисления что создать/обновить/удалить).
  const [serverSnap, setServerSnap] = useState<{ stages: Stage[]; days: Day[]; sessions: Sess[] }>({ stages: [], days: [], sessions: [] })
  // Дни, помеченные на удаление (по day_number) — реально удаляются при сохранении.
  const [deletedDayNums, setDeletedDayNums] = useState<number[]>([])
  // Сессии, помеченные на удаление (реальные id) — реально удаляются при сохранении.
  const [deletedSessionIds, setDeletedSessionIds] = useState<number[]>([])

  // Активная вкладка-этап (id этапа, либо ORPHAN_TAB для «без группировки»).
  const [activeTab, setActiveTab] = useState<number | null>(null)
  // Раскрытые дни внутри активного этапа (по day_number).
  const [openDays, setOpenDays] = useState<Set<number>>(new Set())

  // Модалка добавления/редактирования слота
  const [sessionModal, setSessionModal] = useState<{ day: number; editId: number | null } | null>(null)
  const [sessionForm, setSessionForm] = useState({ title: '', topic_id: '', speaker_id: '', start_time: '', end_time: '' })
  const [speakerTopics, setSpeakerTopics] = useState<{ id: number; topic: string }[]>([])
  const [customTitle, setCustomTitle] = useState(false)

  async function load() {
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
      }))
      const loadedSessions: Sess[] = sRes.sessions || []
      setStages(loadedStages)
      setDays(loadedDays)
      setSessions(loadedSessions)
      setSpeakers(spRes.speakers || [])
      // Глубокая копия в снимок
      setServerSnap({
        stages: loadedStages.map(s => ({ ...s })),
        days: loadedDays.map(d => ({ ...d })),
        sessions: loadedSessions.map(s => ({ ...s })),
      })
      setDeletedDayNums([])
      setDeletedSessionIds([])
      // Выбираем активную вкладку: текущая (если ещё существует) → первый этап → орфаны.
      setActiveTab(prev => {
        const sortedIds = [...loadedStages].sort((a, b) => a.sort_order - b.sort_order).map(s => s.id)
        const hasOrphans = loadedDays.some(d => d.stage_id == null)
        if (prev != null && (sortedIds.includes(prev) || (prev === ORPHAN_TAB && hasOrphans))) return prev
        if (sortedIds.length > 0) return sortedIds[0]
        if (hasOrphans) return ORPHAN_TAB
        return null
      })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [eventId])

  // ─── Признак «есть несохранённые изменения» ──────────────────────────────────

  const dirty = useMemo(() => {
    if (deletedDayNums.length > 0 || deletedSessionIds.length > 0) return true
    // новые/изменённые этапы
    if (stages.length !== serverSnap.stages.length) return true
    for (const s of stages) {
      if (s.id < 0) return true
      const orig = serverSnap.stages.find(x => x.id === s.id)
      if (!orig) return true
      if (s.title !== orig.title || (s.subtitle || '') !== (orig.subtitle || '') ||
          (s.description || '') !== (orig.description || '') ||
          (s.start_date || '') !== (orig.start_date || '') ||
          (s.end_date || '') !== (orig.end_date || '') ||
          s.sort_order !== orig.sort_order) return true
    }
    // новые/изменённые дни
    if (days.length !== serverSnap.days.length) return true
    for (const d of days) {
      const orig = serverSnap.days.find(x => x.day_number === d.day_number)
      if (!orig) return true
      const origStageId = orig.stage_id
      const curStageId = d.stage_id
      if ((d.title || '') !== (orig.title || '') || (d.day_date || '') !== (orig.day_date || '') ||
          (d.open_time || '') !== (orig.open_time || '') || (d.close_time || '') !== (orig.close_time || '') ||
          (d.stream_url || '') !== (orig.stream_url || '') || curStageId !== origStageId) return true
    }
    // новые/изменённые слоты
    if (sessions.length !== serverSnap.sessions.length) return true
    for (const s of sessions) {
      if (s.id < 0) return true
      const orig = serverSnap.sessions.find(x => x.id === s.id)
      if (!orig) return true
      if (s.title !== orig.title || (s.speaker_id ?? null) !== (orig.speaker_id ?? null) ||
          (s.start_time || '') !== (orig.start_time || '') || (s.end_time || '') !== (orig.end_time || '') ||
          s.day !== orig.day) return true
    }
    return false
  }, [stages, days, sessions, serverSnap, deletedDayNums, deletedSessionIds])

  // ─── Этапы (локально) ─────────────────────────────────────────────────────────

  function addStage() {
    const nextOrder = stages.length > 0 ? Math.max(...stages.map(s => s.sort_order)) + 1 : 0
    const id = nextTmpId()
    setStages(prev => [...prev, {
      id, sort_order: nextOrder,
      title: `Этап ${prev.length + 1}`, subtitle: '', description: '', start_date: '', end_date: '',
    }])
    setActiveTab(id)
  }

  function deleteStage(stageId: number) {
    const stageDays = days.filter(d => d.stage_id === stageId)
    if (stageDays.length === 0) {
      if (!confirm('Удалить этап?')) return
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
    if (withDays) {
      for (const d of stageDays) removeDayLocal(d.day_number)
    } else {
      // Отвязываем дни от этапа (оставляем «без группировки»)
      setDays(prev => prev.map(d => d.stage_id === stageId ? { ...d, stage_id: null } : d))
    }
    setStages(prev => prev.filter(s => s.id !== stageId))
    if (activeTab === stageId) setActiveTab(null)
  }

  function deleteAllOrphans() {
    const orphans = days.filter(d => !d.stage_id)
    if (orphans.length === 0) return
    if (!confirm(`Удалить все ${orphans.length} ${orphans.length === 1 ? 'день' : 'дня(дней)'} без группировки? Все слоты в них тоже удалятся.`)) return
    for (const d of orphans) removeDayLocal(d.day_number)
  }

  // Перемещает активный этап в табах влево/вправо (меняет его порядок в программе).
  function moveStage(stageId: number, dir: -1 | 1) {
    const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order)
    const idx = sorted.findIndex(s => s.id === stageId)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= sorted.length) return
    const a = sorted[idx], b = sorted[target]
    setStages(prev => prev.map(s => {
      if (s.id === a.id) return { ...s, sort_order: b.sort_order }
      if (s.id === b.id) return { ...s, sort_order: a.sort_order }
      return s
    }))
  }

  function patchStageForm(stageId: number, patch: Partial<Stage>) {
    setStages(prev => prev.map(s => s.id === stageId ? { ...s, ...patch } : s))
  }

  // ─── Дни (локально) ─────────────────────────────────────────────────────────

  function addDayToStage(stageId: number | null) {
    const allNums = [...days.map(d => d.day_number), ...deletedDayNums]
    const nextNum = allNums.length > 0 ? Math.max(...allNums) + 1 : 1
    setDays(prev => [...prev, {
      day_number: nextNum,
      day_date: '', open_time: '', close_time: '', stream_url: '',
      stage_id: stageId, title: '',
    }])
    // Сразу раскрываем новый день, чтобы пользователь его заполнил.
    setOpenDays(prev => new Set(prev).add(nextNum))
  }

  // Удаляет день из локального состояния + помечает на удаление на сервере (если он там есть)
  function removeDayLocal(dayNum: number) {
    const existsOnServer = serverSnap.days.some(d => d.day_number === dayNum)
    if (existsOnServer) setDeletedDayNums(prev => prev.includes(dayNum) ? prev : [...prev, dayNum])
    setDays(prev => prev.filter(d => d.day_number !== dayNum))
    // Слоты этого дня — тоже на удаление (только реальные, новые просто выкидываем)
    setSessions(prev => prev.filter(s => {
      if (s.day !== dayNum) return true
      if (s.id > 0) setDeletedSessionIds(p => p.includes(s.id) ? p : [...p, s.id])
      return false
    }))
  }

  function deleteDay(dayNum: number) {
    if (!confirm(`Удалить день ${dayNum} и все его слоты?`)) return
    removeDayLocal(dayNum)
  }

  function patchDayForm(dayNum: number, patch: Partial<Day>) {
    setDays(prev => prev.map(d => d.day_number === dayNum ? { ...d, ...patch } : d))
  }

  function toggleDayOpen(dayNum: number) {
    setOpenDays(prev => {
      const n = new Set(prev)
      if (n.has(dayNum)) n.delete(dayNum); else n.add(dayNum)
      return n
    })
  }

  // ─── Слоты (локально) ─────────────────────────────────────────────────────────

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
    const matchesTopic = topics.some(t => t.topic === s.title)
    setCustomTitle(topics.length > 1 && !matchesTopic)
    setSessionForm({
      title: s.title || '',
      topic_id: '',
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

  function saveSession() {
    if (!sessionModal || !sessionForm.title.trim()) return
    const speakerId = sessionForm.speaker_id ? Number(sessionForm.speaker_id) : null
    const speakerName = speakerId != null ? (speakers.find((s: any) => s.id === speakerId)?.name || null) : null
    const start_time = sessionForm.start_time || null
    const end_time = sessionForm.end_time || null
    const title = sessionForm.title.trim()
    if (sessionModal.editId != null) {
      setSessions(prev => prev.map(s => s.id === sessionModal.editId
        ? { ...s, title, speaker_id: speakerId, speaker_name: speakerName, start_time, end_time }
        : s))
    } else {
      const daySessions = sessions.filter(s => s.day === sessionModal.day)
      const nextSort = daySessions.length > 0 ? Math.max(...daySessions.map(s => s.sort_order)) + 1 : 0
      setSessions(prev => [...prev, {
        id: nextTmpId(), day: sessionModal.day,
        title, speaker_id: speakerId, speaker_name: speakerName,
        start_time, end_time, sort_order: nextSort,
      }])
    }
    closeSessionModal()
  }

  function deleteSession(id: number) {
    if (!confirm('Удалить этот слот?')) return
    if (id > 0) setDeletedSessionIds(prev => prev.includes(id) ? prev : [...prev, id])
    setSessions(prev => prev.filter(s => s.id !== id))
  }

  // ─── Глобальное сохранение ──────────────────────────────────────────────────

  async function saveAll() {
    if (!dirty) return
    setSavingAll(true)
    try {
      // 1) Удаляем помеченные слоты и дни (сначала, чтобы не мешали).
      for (const sid of deletedSessionIds) {
        try { await api.conference.sessions.delete(eventId, sid) } catch {}
      }
      for (const dn of deletedDayNums) {
        try { await api.conference.days.delete(eventId, dn) } catch {}
      }

      // 2) Этапы: новые (id<0) создаём, существующие — обновляем. Собираем маппинг tmp→real.
      const stageIdMap: Record<number, number> = {}
      const sortedStages = [...stages].sort((a, b) => a.sort_order - b.sort_order)
      for (const s of sortedStages) {
        const payload = {
          title: s.title || 'Без названия',
          subtitle: s.subtitle || null,
          description: s.description || null,
          start_date: s.start_date || null,
          end_date: s.end_date || null,
          sort_order: s.sort_order,
        }
        if (s.id < 0) {
          const res = await api.conference.stages.create(eventId, payload)
          stageIdMap[s.id] = res.stage.id
        } else {
          await api.conference.stages.update(eventId, s.id, payload)
          stageIdMap[s.id] = s.id
        }
      }

      // 3) Дни: upsert по day_number, stage_id переводим через маппинг.
      for (const d of days) {
        const realStageId = d.stage_id == null ? null : (stageIdMap[d.stage_id] ?? d.stage_id)
        await api.conference.days.upsert(eventId, d.day_number, {
          day_date: d.day_date || null,
          open_time: d.open_time || null,
          close_time: d.close_time || null,
          stream_url: d.stream_url || null,
          stage_id: realStageId,
          title: d.title || null,
        })
      }

      // 4) Слоты: новые создаём, существующие обновляем.
      for (const s of sessions) {
        const payload = {
          day: s.day,
          title: s.title || undefined,
          speaker_id: s.speaker_id ?? null,
          start_time: s.start_time || null,
          end_time: s.end_time || null,
        }
        if (s.id < 0) {
          await api.conference.sessions.create(eventId, payload)
        } else {
          await api.conference.sessions.update(eventId, s.id, payload)
        }
      }

      await load()
    } catch (err: any) {
      alert(err.message || 'Не удалось сохранить программу')
    } finally {
      setSavingAll(false)
    }
  }

  if (loading) return <div className="flex justify-center py-12"><Spinner className="text-brand text-2xl" /></div>

  const stagesSorted = [...stages].sort((a, b) => a.sort_order - b.sort_order)
  // Дни выстраиваются по введённой дате; дни без даты — в конце, по номеру.
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

  // Активный этап (если активна вкладка-этап).
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
          <button onClick={addStage} className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2 mx-auto">
            <Plus size={15} /> Добавить этап
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl pb-28">
      {/* Кнопка «Добавить этап» НАД вкладками */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-400">
          Каждый этап — на отдельной вкладке. Стрелки ← → меняют порядок этапа в программе.
        </p>
        <button
          onClick={addStage}
          className="btn-gold px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5 shrink-0"
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
        {/* ── Вкладка этапа ── */}
        {activeStage && (
          <>
            {/* Шапка этапа: порядок + удаление */}
            <div className="flex items-center justify-between gap-2 mb-4">
              <div className="flex items-center gap-2 text-gray-400 text-sm">
                <Layers size={16} className="opacity-70" />
                <span>Этап {activeStageIdx + 1} из {stagesSorted.length}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => moveStage(activeStage.id, -1)}
                  disabled={activeStageIdx === 0}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-brand hover:bg-gray-50 disabled:opacity-20 disabled:hover:text-gray-400 disabled:hover:bg-transparent transition-colors"
                  title="Передвинуть этап левее"
                >
                  <ChevronLeft size={17} />
                </button>
                <button
                  onClick={() => moveStage(activeStage.id, 1)}
                  disabled={activeStageIdx === stagesSorted.length - 1}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-brand hover:bg-gray-50 disabled:opacity-20 disabled:hover:text-gray-400 disabled:hover:bg-transparent transition-colors"
                  title="Передвинуть этап правее"
                >
                  <ChevronRight size={17} />
                </button>
                <button
                  onClick={() => deleteStage(activeStage.id)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors ml-1"
                  title="Удалить этап"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            {/* Поля этапа */}
            <div className="space-y-3 mb-5">
              <div>
                <label className="label">Название этапа</label>
                <input
                  type="text"
                  value={activeStage.title || ''}
                  onChange={e => patchStageForm(activeStage.id, { title: e.target.value })}
                  className="input"
                  placeholder="Например, «Предстарт: Живой автор в контенте»"
                />
              </div>
              <div>
                <label className="label">Подпись (опционально)</label>
                <input
                  type="text"
                  value={activeStage.subtitle || ''}
                  onChange={e => patchStageForm(activeStage.id, { subtitle: e.target.value })}
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
                    onChange={e => patchStageForm(activeStage.id, { start_date: e.target.value })}
                    className="input"
                  />
                </div>
                <div>
                  <label className="label">Дата окончания</label>
                  <input
                    type="date"
                    value={activeStage.end_date || ''}
                    onChange={e => patchStageForm(activeStage.id, { end_date: e.target.value })}
                    className="input"
                  />
                </div>
              </div>
              <div>
                <label className="label">Описание (опционально)</label>
                <textarea
                  rows={2}
                  value={activeStage.description || ''}
                  onChange={e => patchStageForm(activeStage.id, { description: e.target.value })}
                  className="input resize-none"
                  placeholder="Что происходит на этом этапе"
                />
              </div>
            </div>

            {/* Дни этапа — аккордеон */}
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
                {activeStageDays.map(day => (
                  <DayAccordion
                    key={day.day_number}
                    day={day}
                    open={openDays.has(day.day_number)}
                    onToggle={() => toggleDayOpen(day.day_number)}
                    sessions={sessions.filter(s => s.day === day.day_number).sort((a, b) => a.sort_order - b.sort_order)}
                    stages={stagesSorted}
                    onPatchDay={(patch) => patchDayForm(day.day_number, patch)}
                    onDelete={() => deleteDay(day.day_number)}
                    onAddSession={() => setSessionModal({ day: day.day_number, editId: null })}
                    onEditSession={openSessionEdit}
                    onDeleteSession={deleteSession}
                  />
                ))}
              </div>
              <button
                onClick={() => addDayToStage(activeStage.id)}
                className="mt-3 w-full py-2.5 rounded-xl border border-dashed border-gray-200 text-sm text-gray-400 hover:border-brand hover:text-brand transition-colors flex items-center justify-center gap-2"
              >
                <Plus size={14} /> Добавить день в этап
              </button>
            </div>
          </>
        )}

        {/* ── Вкладка «Без группировки» ── */}
        {activeTab === ORPHAN_TAB && (
          <>
            <div className="flex items-center justify-between gap-2 mb-4">
              <div className="flex items-center gap-2 text-gray-400 text-sm">
                <Calendar size={15} className="opacity-70" />
                <span>Дни без этапа ({orphanDays.length})</span>
              </div>
              <button
                onClick={deleteAllOrphans}
                className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1"
                title="Удалить все дни без группировки"
              >
                <Trash2 size={12} /> Удалить все
              </button>
            </div>
            <div className="space-y-2">
              {orphanDays.map(day => (
                <DayAccordion
                  key={day.day_number}
                  day={day}
                  open={openDays.has(day.day_number)}
                  onToggle={() => toggleDayOpen(day.day_number)}
                  sessions={sessions.filter(s => s.day === day.day_number).sort((a, b) => a.sort_order - b.sort_order)}
                  stages={stagesSorted}
                  onPatchDay={(patch) => patchDayForm(day.day_number, patch)}
                  onDelete={() => deleteDay(day.day_number)}
                  onAddSession={() => setSessionModal({ day: day.day_number, editId: null })}
                  onEditSession={openSessionEdit}
                  onDeleteSession={deleteSession}
                />
              ))}
            </div>
          </>
        )}

        {/* Нет активной вкладки (этапов нет, орфанов нет — но что-то есть) */}
        {!activeStage && activeTab !== ORPHAN_TAB && (
          <div className="text-center text-gray-400 text-sm py-8">
            Выберите этап сверху или создайте новый.
          </div>
        )}
      </div>

      {/* Добавить день без этапа (отдельно, мелко) */}
      <button
        onClick={() => addDayToStage(null)}
        className="mt-4 text-xs text-gray-400 hover:text-brand transition-colors flex items-center gap-1.5"
      >
        <Plus size={13} /> Добавить день без этапа
      </button>

      {/* Sticky-кнопка «Сохранить» */}
      {dirty && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
          <button
            onClick={saveAll}
            disabled={savingAll}
            className="btn-gold px-7 py-3 rounded-2xl text-sm font-bold shadow-2xl flex items-center gap-2 disabled:opacity-70"
          >
            {savingAll ? <Spinner /> : <Save size={16} />}
            {savingAll ? 'Сохраняем...' : 'Сохранить программу'}
          </button>
        </div>
      )}

      {/* Модалка добавления/правки слота */}
      {sessionModal && (
        <Modal title={`${sessionModal.editId != null ? 'Редактировать слот' : 'Слот'} · день ${sessionModal.day}`} onClose={closeSessionModal}>
          <div className="space-y-3">
            <div>
              <label className="label">Спикер</label>
              <select value={sessionForm.speaker_id} onChange={e => onSpeakerChange(e.target.value)} className="input bg-white" autoFocus>
                <option value="">— без спикера —</option>
                {speakers.map((sp: any) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Тема выступления</label>
              {speakerTopics.length > 1 && !customTitle ? (
                <select
                  onChange={e => {
                    if (e.target.value === '__custom__') {
                      setCustomTitle(true)
                      setSessionForm(f => ({ ...f, topic_id: '', title: '' }))
                    } else {
                      const t = speakerTopics.find(x => String(x.id) === e.target.value)
                      setSessionForm(f => ({ ...f, topic_id: e.target.value, title: t?.topic || '' }))
                    }
                  }}
                  value={sessionForm.topic_id}
                  className="input bg-white"
                >
                  <option value="">— выберите тему —</option>
                  {speakerTopics.map(t => <option key={t.id} value={t.id}>{t.topic}</option>)}
                  <option value="__custom__">Другая тема...</option>
                </select>
              ) : (
                <div>
                  <input type="text" value={sessionForm.title}
                    onChange={e => setSessionForm(f => ({ ...f, title: e.target.value, topic_id: '' }))}
                    className="input" placeholder="Название слота" />
                  {speakerTopics.length > 1 && (
                    <button type="button" onClick={() => { setCustomTitle(false); setSessionForm(f => ({ ...f, topic_id: '', title: '' })) }}
                      className="text-xs text-gray-400 hover:text-brand mt-1 transition-colors">
                      ← выбрать из тем спикера
                    </button>
                  )}
                </div>
              )}
            </div>
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
            <button onClick={saveSession} disabled={!sessionForm.title.trim()}
              className="btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60">
              {sessionModal.editId != null ? 'Сохранить слот' : 'Добавить слот'}
            </button>
            <button onClick={closeSessionModal} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">Отмена</button>
          </div>
          <p className="text-[11px] text-gray-400 mt-3 text-center">Слот добавится в список. Изменения сохранятся кнопкой «Сохранить программу».</p>
        </Modal>
      )}
    </div>
  )
}

// ─── Подкомпонент: день-аккордеон ──────────────────────────────────────────────

function DayAccordion({
  day, open, onToggle, sessions, stages,
  onPatchDay, onDelete, onAddSession, onEditSession, onDeleteSession,
}: {
  day: Day
  open: boolean
  onToggle: () => void
  sessions: Sess[]
  stages: Stage[]
  onPatchDay: (patch: Partial<Day>) => void
  onDelete: () => void
  onAddSession: () => void
  onEditSession: (s: Sess) => void
  onDeleteSession: (id: number) => void
}) {
  const dateLabel = day.day_date
    ? new Date(day.day_date + 'T00:00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', timeZone: 'Europe/Moscow' })
    : ''
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      {/* Шапка дня — кликабельна, сворачивает/разворачивает */}
      <div className="flex items-center gap-2 bg-gray-50 hover:bg-gray-100/70 transition-colors">
        <button onClick={onToggle} className="flex items-center gap-2 flex-1 px-3 py-2.5 text-left min-w-0">
          <ChevronDown
            size={16}
            className={`text-gray-400 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
          />
          <span className="font-semibold text-sm text-gray-800 truncate">
            {day.title?.trim() || `День ${day.day_number}`}
          </span>
          {dateLabel && <span className="text-xs text-gray-400 shrink-0">· {dateLabel}</span>}
          {sessions.length > 0 && (
            <span className="text-[11px] text-gray-400 shrink-0">· {sessions.length} слот.</span>
          )}
        </button>
        <button onClick={onDelete} className="text-gray-300 hover:text-red-400 transition-colors p-2 shrink-0" title="Удалить день">
          <Trash2 size={14} />
        </button>
      </div>

      {open && (
        <div className="bg-white">
          {/* Поля дня */}
          <div className="px-4 py-3 space-y-3 border-b border-gray-50">
            <div>
              <label className="label">Название дня (опционально)</label>
              <input
                type="text"
                value={day.title || ''}
                onChange={e => onPatchDay({ title: e.target.value })}
                className="input"
                placeholder={`По умолчанию — «День ${day.day_number}»`}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Дата</label>
                <input
                  type="date"
                  value={day.day_date || ''}
                  onChange={e => onPatchDay({ day_date: e.target.value })}
                  className="input"
                />
              </div>
              <div>
                <label className="label">Этап</label>
                <select
                  value={day.stage_id == null ? '' : String(day.stage_id)}
                  onChange={e => onPatchDay({ stage_id: e.target.value === '' ? null : Number(e.target.value) })}
                  className="input bg-white"
                >
                  <option value="">— без этапа —</option>
                  {stages.map((s, i) => <option key={s.id} value={s.id}>Этап {i + 1}: {s.title}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Открытие (МСК)</label>
                <input
                  type="time"
                  value={day.open_time || ''}
                  onChange={e => onPatchDay({ open_time: e.target.value })}
                  className="input"
                />
              </div>
              <div>
                <label className="label">Закрытие (МСК)</label>
                <input
                  type="time"
                  value={day.close_time || ''}
                  onChange={e => onPatchDay({ close_time: e.target.value })}
                  className="input"
                />
              </div>
            </div>
          </div>

          {/* Слоты дня */}
          <div className="px-4 py-2.5">
            {sessions.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-2">Нет слотов</p>
            ) : (
              <div className="space-y-1 mb-2">
                {sessions.map(s => (
                  <div key={s.id} className="flex items-start gap-3 group py-1">
                    <button
                      onClick={() => onEditSession(s)}
                      className="flex items-start gap-3 flex-1 text-left rounded-lg -mx-1 px-1 hover:bg-gray-50 transition-colors"
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
                    <button onClick={() => onDeleteSession(s.id)}
                      className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition-all p-1 rounded shrink-0">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button onClick={onAddSession}
              className="text-xs text-brand hover:text-brand/80 flex items-center gap-1.5 transition-colors">
              <Plus size={13} /> Добавить слот
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
