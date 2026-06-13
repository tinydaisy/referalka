'use client'
import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { Plus, Trash2, ChevronDown, ChevronRight, Camera, Pencil, ExternalLink, Copy, Check } from 'lucide-react'

type SubTab = 'criteria' | 'assignments' | 'leaderboard' | 'reports'

export default function ScoringTab({ eventId }: { eventId: number }) {
  const [sub, setSub] = useState<SubTab>('criteria')
  const tabs: { id: SubTab; label: string }[] = [
    { id: 'criteria', label: 'Критерии' },
    { id: 'assignments', label: 'Распределение' },
    { id: 'leaderboard', label: 'Турнирная таблица' },
    { id: 'reports', label: 'Отчёты' },
  ]
  return (
    <div>
      <div className="border-b border-gray-200 mb-6 flex items-center gap-1 -mt-2 overflow-x-auto">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setSub(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              sub === t.id ? 'border-[#FFCFA4] text-[#25455D]' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>
      {sub === 'criteria'    && <CriteriaSub eventId={eventId} />}
      {sub === 'assignments' && <AssignmentsSub eventId={eventId} />}
      {sub === 'leaderboard' && <LeaderboardSub eventId={eventId} />}
      {sub === 'reports'     && <ReportsSub eventId={eventId} />}
    </div>
  )
}

// ─────────────────────── Критерии (конструктор) ───────────────────────

function CriteriaSub({ eventId }: { eventId: number }) {
  const [loading, setLoading] = useState(true)
  const [packages, setPackages] = useState<any[]>([])
  const [stages, setStages] = useState<any[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.tournament.criteria(eventId)
      setPackages(r.packages || []); setStages(r.stages || [])
    } finally { setLoading(false) }
  }, [eventId])
  useEffect(() => { load() }, [load])

  const [stageFilter, setStageFilter] = useState<number | 'all'>('all')

  const addPackage = async () => {
    const title = prompt('Название пакета (например «Оценка жюри», «Вовлечение»):')
    if (!title?.trim()) return
    await api.tournament.createPackage(eventId, { title: title.trim(), sort_order: packages.length })
    load()
  }

  if (loading) return <Spinner />

  // фильтр критериев по выбранному этапу (общие критерии stage_id=null показываем всегда)
  const matchStage = (c: any) => stageFilter === 'all' || c.stage_id === stageFilter || c.stage_id == null
  const visiblePackages = packages
    .map(p => ({ ...p, criteria: (p.criteria || []).filter(matchStage) }))

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Пакет — смысловая группа критериев со своим весом. У каждого критерия выбираете, кто ставит балл и к какому этапу он относится.
      </p>
      {stages.length > 0 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">Этап:</span>
          <select className="border rounded-lg px-2 py-1.5" value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">Все этапы</option>
            {stages.map((s: any) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
          <span className="text-xs text-gray-400">— показаны критерии выбранного этапа (и общие «весь турнир»)</span>
        </div>
      )}
      {visiblePackages.map(pkg => <PackageCard key={pkg.id} eventId={eventId} pkg={pkg} stages={stages} defaultStage={stageFilter === 'all' ? null : stageFilter} onChange={load} />)}
      <button onClick={addPackage} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-[#25455D] text-[#FFCFA4] hover:opacity-90">
        <Plus size={16} /> Добавить пакет
      </button>
    </div>
  )
}

function PackageCard({ eventId, pkg, stages, defaultStage, onChange }: any) {
  const [weight, setWeight] = useState(String(pkg.weight))
  const [normalize, setNormalize] = useState(!!pkg.normalize)

  const savePkg = async (patch: any) => { await api.tournament.updatePackage(eventId, pkg.id, patch); onChange() }
  const delPkg = async () => {
    if (!confirm(`Удалить пакет «${pkg.title}» со всеми критериями и оценками?`)) return
    await api.tournament.deletePackage(eventId, pkg.id); onChange()
  }
  const addCrit = async () => {
    const title = prompt('Название критерия:')
    if (!title?.trim()) return
    await api.tournament.createCriterion(eventId, { package_id: pkg.id, title: title.trim(), scorer: 'jury', stage_id: defaultStage ?? null, scale_max: 10, weight: 1, sort_order: (pkg.criteria?.length || 0) })
    onChange()
  }

  return (
    <div className="border rounded-xl p-4 bg-white">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="flex items-center gap-1.5">
          <Pencil size={13} className="text-gray-400 shrink-0" />
          <input className="font-semibold text-[#25455D] border border-gray-200 rounded-lg px-2 py-1 hover:border-gray-300 focus:border-[#FFCFA4] focus:ring-1 focus:ring-[#FFCFA4] outline-none"
            defaultValue={pkg.title} title="Нажмите, чтобы переименовать пакет" placeholder="Название пакета"
            onBlur={(e) => e.target.value.trim() && e.target.value !== pkg.title && savePkg({ title: e.target.value.trim() })} />
        </div>
        <label className="text-xs text-gray-500 flex items-center gap-1">вес
          <input type="number" step="0.1" className="w-14 border rounded px-1.5 py-0.5 text-sm" value={weight}
            onChange={(e) => setWeight(e.target.value)} onBlur={() => savePkg({ weight: Number(weight) || 0 })} />
        </label>
        <label className="text-xs text-gray-500 flex items-center gap-1" title="Привести критерии к доле от лучшего результата. Включайте, если в пакете критерии с разными масштабами (например голоса в сотнях и баллы жюри до 10) — тогда большие числа не задавят маленькие.">
          <input type="checkbox" checked={normalize} onChange={(e) => { setNormalize(e.target.checked); savePkg({ normalize: e.target.checked }) }} />
          нормализовать (?)
        </label>
        <button onClick={delPkg} className="ml-auto text-gray-400 hover:text-red-500"><Trash2 size={16} /></button>
      </div>
      <div className="space-y-2">
        {(pkg.criteria || []).map((c: any) => <CriterionRow key={c.id} eventId={eventId} crit={c} stages={stages} onChange={onChange} />)}
      </div>
      <button onClick={addCrit} className="mt-3 flex items-center gap-1.5 text-sm text-[#25455D] hover:opacity-70">
        <Plus size={14} /> Добавить критерий
      </button>
    </div>
  )
}

function CriterionRow({ eventId, crit, stages, onChange }: any) {
  const save = async (patch: any) => { await api.tournament.updateCriterion(eventId, crit.id, patch); onChange() }
  const del = async () => { if (confirm('Удалить критерий?')) { await api.tournament.deleteCriterion(eventId, crit.id); onChange() } }
  return (
    <div className="flex flex-wrap items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
      <div className="flex items-center gap-1.5 flex-1 min-w-[150px]">
        <Pencil size={12} className="text-gray-400 shrink-0" />
        <input className="flex-1 bg-white border border-gray-200 rounded-md px-2 py-1 text-sm outline-none hover:border-gray-300 focus:border-[#FFCFA4] focus:ring-1 focus:ring-[#FFCFA4]"
          defaultValue={crit.title} title="Нажмите, чтобы переименовать критерий" placeholder="Название критерия"
          onBlur={(e) => e.target.value.trim() && e.target.value !== crit.title && save({ title: e.target.value.trim() })} />
      </div>
      <select className="text-xs border rounded px-1.5 py-1" value={crit.scorer} onChange={(e) => save({ scorer: e.target.value })}>
        <option value="jury">Ставит: Жюри</option>
        <option value="vote">Ставит: Народное</option>
        <option value="manual">Ставит: Ручной</option>
        <option value="auto">Ставит: Авто</option>
      </select>
      {crit.scorer === 'auto' && (
        <select className="text-xs border rounded px-1.5 py-1" value={crit.auto_kind || 'referrals'} onChange={(e) => save({ auto_kind: e.target.value })}>
          <option value="referrals">Привёл по реф-ссылке</option>
          <option value="lead_magnet">Пришло в лид-магнит</option>
        </select>
      )}
      <select className="text-xs border rounded px-1.5 py-1" value={crit.stage_id ?? ''} onChange={(e) => save({ stage_id: e.target.value ? Number(e.target.value) : null })} title="Этап, к которому относится критерий">
        <option value="">Весь турнир</option>
        {stages.map((s: any) => <option key={s.id} value={s.id}>{s.title}</option>)}
      </select>
      {crit.scorer === 'jury' && (
        <label className="text-xs text-gray-400 flex items-center gap-1">макс
          <input type="number" className="w-12 border rounded px-1 py-0.5 text-xs" defaultValue={crit.scale_max}
            onBlur={(e) => Number(e.target.value) > 0 && save({ scale_max: Number(e.target.value) })} />
        </label>
      )}
      <label className="text-xs text-gray-400 flex items-center gap-1">вес
        <input type="number" step="0.1" className="w-12 border rounded px-1 py-0.5 text-xs" defaultValue={crit.weight}
          onBlur={(e) => save({ weight: Number(e.target.value) || 0 })} />
      </label>
      <button onClick={del} className="text-gray-300 hover:text-red-500"><Trash2 size={14} /></button>
    </div>
  )
}

// ─────────────────────── Распределение ───────────────────────

function AssignmentsSub({ eventId }: { eventId: number }) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<any>(null)
  const [pairs, setPairs] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.tournament.assignments(eventId)
      setData(r); setPairs(new Set((r.pairs || []).map((p: any) => `${p.juror_ec_id}|${p.key}`)))
    } finally { setLoading(false) }
  }, [eventId])
  useEffect(() => { load() }, [load])

  const toggle = async (juror: number, key: string) => {
    const k = `${juror}|${key}`
    const assigned = !pairs.has(k)
    const next = new Set(pairs); assigned ? next.add(k) : next.delete(k); setPairs(next)
    await api.tournament.setAssignment(eventId, { juror_ec_id: juror, key, assigned })
  }
  const allAll = async (clear: boolean) => { await api.tournament.setAllAssignments(eventId, clear); load() }

  if (loading) return <Spinner />
  if (!data?.jurors?.length) return <p className="text-sm text-gray-500">Нет жюри. Добавьте коллабораторов с ролью «Жюри» на вкладке «Спикеры».</p>
  if (!data?.subjects?.length) return <p className="text-sm text-gray-500">Нет участников и спикеров для оценки.</p>

  const speakers = data.subjects.filter((s: any) => s.is_speaker)
  const participants = data.subjects.filter((s: any) => !s.is_speaker)

  const rowGroup = (title: string, list: any[]) => list.length > 0 && (
    <>
      <tr><td colSpan={data.jurors.length + 1} className="px-3 py-1.5 text-xs font-semibold text-gray-400 bg-gray-50 uppercase">{title}</td></tr>
      {list.map((s: any) => (
        <tr key={s.key} className="border-t">
          <td className="px-3 py-2 sticky left-0 bg-white whitespace-nowrap">{s.name}</td>
          {data.jurors.map((j: any) => (
            <td key={j.juror_ec_id} className="text-center px-3 py-2">
              <input type="checkbox" checked={pairs.has(`${j.juror_ec_id}|${s.key}`)} onChange={() => toggle(j.juror_ec_id, s.key)} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )

  return (
    <div>
      <p className="text-sm text-gray-500 mb-3">Отметьте, кого оценивает каждое жюри. Жюри видит в кабинете только привязанных к нему.</p>
      <div className="overflow-x-auto border rounded-xl">
        <table className="text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="text-left px-3 py-2 sticky left-0 bg-gray-50 z-10">Участник</th>
              {data.jurors.map((j: any) => <th key={j.juror_ec_id} className="px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{j.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rowGroup('Спикеры', speakers)}
            {rowGroup('Участники', participants)}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2 mt-3">
        <button onClick={() => allAll(false)} className="px-3 py-1.5 rounded-lg text-sm bg-[#25455D] text-[#FFCFA4]">Назначить всех всем</button>
        <button onClick={() => allAll(true)} className="px-3 py-1.5 rounded-lg text-sm border text-gray-600">Очистить</button>
      </div>
    </div>
  )
}

// ─────────────────────── Турнирная таблица ───────────────────────

function PublicTableLink({ eventId, stageId, stageTitle }: { eventId: number; stageId: number; stageTitle?: string }) {
  const [copied, setCopied] = useState(false)
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://pluson.ru'
  const url = `${origin}/t/${eventId}/${stageId}`
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-sm bg-[#FFF7F0] border border-[#FFCFA4] rounded-lg px-3 py-2">
      <span className="text-gray-600">Публичная страница{stageTitle ? ` — ${stageTitle}` : ''} (видна всем, для прозрачности):</span>
      <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[#25455D] font-medium underline break-all">
        {url} <ExternalLink size={13} />
      </a>
      <button onClick={copy} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#25455D] text-[#FFCFA4] text-xs">
        {copied ? <><Check size={12} /> Скопировано</> : <><Copy size={12} /> Копировать</>}
      </button>
    </div>
  )
}

function LeaderboardSub({ eventId }: { eventId: number }) {
  const [loading, setLoading] = useState(true)
  const [stageId, setStageId] = useState<number | null>(null)
  const [stagesInit, setStagesInit] = useState(false)
  const [stages, setStages] = useState<any[]>([])
  const [board, setBoard] = useState<any>(null)
  const [feedback, setFeedback] = useState<any[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [b, c, f] = await Promise.all([
        api.tournament.leaderboard(eventId, stageId),
        api.tournament.criteria(eventId),
        api.tournament.feedback(eventId),
      ])
      const st = c.stages || []
      setBoard(b); setStages(st); setFeedback(f.feedback || [])
      // по умолчанию выбираем первый этап (без варианта «Все этапы»)
      if (!stagesInit) {
        setStagesInit(true)
        if (st.length > 0 && stageId == null) setStageId(st[0].id)
      }
    } finally { setLoading(false) }
  }, [eventId, stageId, stagesInit])
  useEffect(() => { load() }, [load])

  const snapshot = async () => {
    const title = prompt('Название отчёта (например «После 2 этапа»):', '')
    if (title === null) return
    setSaving(true)
    try { await api.tournament.createSnapshot(eventId, { title, stage_id: stageId }); alert('Отчёт сохранён — смотрите во вкладке «Отчёты».') }
    finally { setSaving(false) }
  }
  const setManual = async (criterionId: number, key: string, value: string) => {
    if (value === '') return
    await api.tournament.manualScore(eventId, { criterion_id: criterionId, key, value: Number(value) })
    load()
  }

  if (loading) return <Spinner />
  if (!board?.table?.length) return <p className="text-sm text-gray-500">Нет участников/спикеров или критериев. Заведите критерии; участники появятся после регистрации, спикеры — на вкладке «Спикеры».</p>

  const cols: any[] = board.columns || []
  // группировка колонок по пакетам для шапки
  const groups: { title: string; weight: number; span: number; normalize: boolean }[] = []
  cols.forEach((c) => {
    const last = groups[groups.length - 1]
    if (last && last.title === c.package_title) last.span++
    else {
      const pkg = board.packages.find((p: any) => p.id === c.package_id)
      groups.push({ title: c.package_title, weight: pkg?.weight ?? 1, span: 1, normalize: !!pkg?.normalize })
    }
  })
  const scorerOf = (cid: number) => cols.find(c => c.criterion_id === cid)?.scorer
  const normalizeOf = (cid: number) => {
    const c = cols.find(x => x.criterion_id === cid)
    return !!board.packages.find((p: any) => p.id === c?.package_id)?.normalize
  }
  const NormBadge = () => <span className="ml-1 align-middle text-[9px] font-bold text-amber-700 bg-amber-50 border border-[#FFCFA4] rounded px-1" title="Критерий нормализуется: баллы приводятся к доле от лучшего результата">норм.</span>

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <select className="text-sm border rounded-lg px-2 py-1.5" value={stageId ?? ''} onChange={(e) => setStageId(e.target.value ? Number(e.target.value) : null)}>
          {stages.length === 0 && <option value="">Весь турнир</option>}
          {stages.map((s: any) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
        <button onClick={snapshot} disabled={saving} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-[#25455D] text-[#FFCFA4] disabled:opacity-50">
          <Camera size={14} /> Сохранить отчёт
        </button>
      </div>
      {stageId != null && (
        <PublicTableLink eventId={eventId} stageId={stageId} stageTitle={stages.find((s: any) => s.id === stageId)?.title} />
      )}
      <div className="overflow-x-auto border rounded-xl">
        <table className="text-sm w-full">
          <thead>
            {/* верхняя строка шапки: группировки */}
            <tr className="bg-gray-50 text-gray-600">
              <th rowSpan={2} className="px-3 py-2 text-left">Место</th>
              <th rowSpan={2} className="px-3 py-2 text-left">Участник</th>
              <th rowSpan={2} className="px-3 py-2">Готово</th>
              <th rowSpan={2} className="px-3 py-2 font-semibold text-[#25455D] border-l">ИТОГ</th>
              {/* итоговые баллы пакетов */}
              <th colSpan={board.packages.length} className="px-3 py-1.5 text-center border-l">Баллы по пакетам</th>
              {/* критерии, сгруппированные по пакетам */}
              {groups.map((g, i) => <th key={i} colSpan={g.span} className="px-3 py-1.5 text-center border-l">{g.title} <span className="text-gray-400">×{g.weight}</span>{g.normalize && <NormBadge />}</th>)}
              <th rowSpan={2} className="px-3 py-2 border-l">Детализация</th>
            </tr>
            <tr className="bg-gray-50 text-gray-500 text-xs">
              {board.packages.map((p: any, i: number) => (
                <th key={p.id} className={`px-2 py-1.5 whitespace-nowrap font-medium ${i===0?'border-l':''}`}>{p.title}{p.normalize && <NormBadge />}</th>
              ))}
              {cols.map((c, i) => (
                <th key={c.criterion_id} className={`px-2 py-1.5 whitespace-nowrap font-medium ${i===0?'border-l':''}`} title={c.scorer}>{c.title}{normalizeOf(c.criterion_id) && <NormBadge />}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {board.table.map((row: any) => {
              const fbs = feedback.filter((f: any) => f.key === row.key)
              const isOpen = expanded === row.key
              return (
                <>
                  <tr key={row.key} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2">{row.place <= 3 ? ['🥇','🥈','🥉'][row.place-1] : row.place}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{row.name}{!row.is_speaker && <span className="ml-1 text-[10px] text-gray-400">участник</span>}</td>
                    <td className="px-3 py-2 text-center text-xs">{row.assigned_jury ? `${row.done_jury}/${row.assigned_jury}${row.done_jury < row.assigned_jury ? ' ⚠' : ' ✓'}` : '—'}</td>
                    <td className="px-3 py-2 text-center font-semibold text-[#25455D] border-l">{row.total}</td>
                    {/* баллы пакетов */}
                    {board.packages.map((p: any, i: number) => (
                      <td key={p.id} className={`px-2 py-2 text-center text-gray-700 ${i===0?'border-l':''}`}>{row.package_scores?.[String(p.id)] ?? '—'}</td>
                    ))}
                    {/* критерии */}
                    {cols.map((c, i) => {
                      const val = row.cells[String(c.criterion_id)]
                      const editable = c.scorer === 'vote' || c.scorer === 'manual'
                      return (
                        <td key={c.criterion_id} className={`px-2 py-2 text-center ${i===0?'border-l':''}`}>
                          {editable ? (
                            <input type="number" className="w-16 border rounded px-1 py-0.5 text-sm text-center" defaultValue={val ?? ''}
                              onBlur={(e) => setManual(c.criterion_id, row.key, e.target.value)} />
                          ) : (val == null ? <span className="text-gray-300">—</span> : val)}
                        </td>
                      )
                    })}
                    <td className="px-3 py-2 text-center border-l">
                      {(Object.keys(row.jury_detail).length > 0 || fbs.length > 0) ? (
                        <button onClick={() => setExpanded(isOpen ? null : row.key)} className="flex items-center gap-1 text-xs text-[#25455D] mx-auto">
                          {isOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>} подробно
                        </button>
                      ) : <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-gray-50">
                      <td colSpan={4 + board.packages.length + cols.length + 1} className="px-4 py-3">
                        <div className="space-y-2 text-sm">
                          {cols.filter(c => row.jury_detail[String(c.criterion_id)]).map(c => (
                            <div key={c.criterion_id}>
                              <b className="text-[#25455D]">{c.title}:</b>{' '}
                              {row.jury_detail[String(c.criterion_id)].map((d: any, i: number) => (
                                <span key={i} className="text-gray-600">{d.juror_name} = {d.value}{i < row.jury_detail[String(c.criterion_id)].length-1 ? ', ' : ''}</span>
                              ))}
                            </div>
                          ))}
                          {fbs.length > 0 && (
                            <div className="pt-2 border-t">
                              <div className="text-xs text-gray-400 mb-1">Обратная связь жюри:</div>
                              {fbs.map((f: any, i: number) => <div key={i}><b className="text-[#25455D]">{f.juror_name}:</b> {f.body}</div>)}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─────────────────────── Отчёты ───────────────────────

function ReportsSub({ eventId }: { eventId: number }) {
  const [loading, setLoading] = useState(true)
  const [snaps, setSnaps] = useState<any[]>([])
  const [open, setOpen] = useState<any>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { const r = await api.tournament.snapshots(eventId); setSnaps(r.snapshots || []) } finally { setLoading(false) }
  }, [eventId])
  useEffect(() => { load() }, [load])

  const view = async (id: number) => setOpen(await api.tournament.getSnapshot(eventId, id))
  const del = async (id: number) => { if (confirm('Удалить отчёт?')) { await api.tournament.deleteSnapshot(eventId, id); setOpen(null); load() } }

  if (loading) return <Spinner />
  return (
    <div>
      <p className="text-sm text-gray-500 mb-3">Снимки результатов на даты — для динамики. Старые отчёты не меняются.</p>
      {!snaps.length && <p className="text-sm text-gray-400">Пока нет отчётов. Сохраните их во вкладке «Турнирная таблица».</p>}
      <div className="space-y-2">
        {snaps.map(s => (
          <div key={s.id} className="flex items-center gap-3 border rounded-lg px-3 py-2 bg-white">
            <button onClick={() => view(s.id)} className="text-sm text-[#25455D] hover:underline">
              {s.title || 'Отчёт'} · {new Date(s.frozen_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}
            </button>
            <button onClick={() => del(s.id)} className="ml-auto text-gray-300 hover:text-red-500"><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      {open && <SnapshotView snap={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function SnapshotView({ snap, onClose }: any) {
  const itog = (snap.rows || []).filter((r: any) => r.package_id === null)
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-[#25455D] mb-1">{snap.snapshot.title || 'Отчёт'}</h3>
        <p className="text-xs text-gray-400 mb-4">{new Date(snap.snapshot.frozen_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</p>
        <table className="text-sm w-full mb-4">
          <thead><tr className="text-gray-500 text-left"><th className="py-1">Место</th><th>Участник</th><th>Итог</th></tr></thead>
          <tbody>
            {itog.sort((a: any,b: any)=>(a.place||0)-(b.place||0)).map((r: any) => (
              <tr key={r.id} className="border-t"><td className="py-1">{r.place}</td><td>{r.subject_name}</td><td className="font-semibold">{r.total_score}</td></tr>
            ))}
          </tbody>
        </table>
        <details className="text-sm">
          <summary className="cursor-pointer text-[#25455D]">Подробности (все баллы и комментарии)</summary>
          <div className="mt-2 space-y-1 text-xs text-gray-600">
            {(snap.scores || []).map((s: any, i: number) => (
              <div key={i}>
                <b>{s.subject_name}</b> · {s.package_title} · {s.criterion_title}
                {s.juror_name ? ` · ${s.juror_name}` : ''}
                {s.value_number != null ? ` = ${s.value_number}` : ''}
                {s.feedback_body ? ` — «${s.feedback_body}»` : ''}
              </div>
            ))}
          </div>
        </details>
        <button onClick={onClose} className="mt-4 px-4 py-2 rounded-lg text-sm border">Закрыть</button>
      </div>
    </div>
  )
}
