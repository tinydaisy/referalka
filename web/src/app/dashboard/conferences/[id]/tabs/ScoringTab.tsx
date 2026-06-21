'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { Plus, Trash2, ChevronDown, ChevronRight, Camera, Pencil, ExternalLink, Copy, Check } from 'lucide-react'
import { useUrlTab, useActiveTabRef } from '@/hooks/useUrlTab'

type SubTab = 'criteria' | 'assignments' | 'leaderboard' | 'reports' | 'taskcontrol'

function ScoringTabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  const ref = useActiveTabRef<HTMLButtonElement>(active)
  return (
    <button ref={ref} onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        active ? 'border-[#FFCFA4] text-[#25455D]' : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}>
      {label}
    </button>
  )
}

export default function ScoringTab({ eventId }: { eventId: number }) {
  const [sub, setSub] = useUrlTab<SubTab>('sub', 'criteria', ['criteria', 'assignments', 'leaderboard', 'reports', 'taskcontrol'])
  const tabs: { id: SubTab; label: string }[] = [
    { id: 'criteria', label: 'Критерии' },
    { id: 'assignments', label: 'Распределение' },
    { id: 'leaderboard', label: 'Турнирная таблица' },
    { id: 'reports', label: 'Отчёты' },
    { id: 'taskcontrol', label: 'Контроль заданий' },
  ]
  return (
    <div>
      <div className="border-b border-gray-200 mb-6 flex items-center gap-1 -mt-2 overflow-x-auto">
        {tabs.map(t => (
          <ScoringTabBtn key={t.id} active={sub === t.id} onClick={() => setSub(t.id)} label={t.label} />
        ))}
      </div>
      {sub === 'criteria'    && <CriteriaSub eventId={eventId} />}
      {sub === 'assignments' && <AssignmentsSub eventId={eventId} />}
      {sub === 'leaderboard' && <LeaderboardSub eventId={eventId} />}
      {sub === 'reports'     && <ReportsSub eventId={eventId} />}
      {sub === 'taskcontrol' && <TaskControlSub eventId={eventId} />}
    </div>
  )
}

// ─────────────────────── Критерии (конструктор) ───────────────────────

function CriteriaSub({ eventId }: { eventId: number }) {
  const [loading, setLoading] = useState(true)
  const [packages, setPackages] = useState<any[]>([])
  const [stages, setStages] = useState<any[]>([])

  const [stageFilter, setStageFilter] = useState<number | null>(null)
  const [stagesInit, setStagesInit] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.tournament.criteria(eventId)
      const st = r.stages || []
      setPackages(r.packages || []); setStages(st)
      if (!stagesInit) {
        setStagesInit(true)
        if (st.length > 0 && stageFilter == null) setStageFilter(st[0].id)
      }
    } finally { setLoading(false) }
  }, [eventId, stagesInit, stageFilter])
  useEffect(() => { load() }, [load])

  const addPackage = async () => {
    const title = prompt('Название пакета (например «Оценка жюри», «Вовлечение»):')
    if (!title?.trim()) return
    // новый пакет наследует выбранный этап
    await api.tournament.createPackage(eventId, { title: title.trim(), sort_order: packages.length, stage_id: stageFilter })
    load()
  }

  if (loading) return <Spinner />

  // Этап — на уровне ПАКЕТА (как в БД). Показываем пакеты выбранного этапа
  // + общие (stage_id=null, «весь турнир»). Критерии внутри пакета не фильтруем.
  const visiblePackages = packages.filter(
    (p: any) => p.stage_id === stageFilter || p.stage_id == null
  )

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Пакет — смысловая группа критериев со своим весом. Этап выбирается у пакета: пакет считается на своём этапе («Весь турнир» — на каждом). У критерия выбираете, кто ставит балл.
      </p>
      {stages.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-gray-500">Этап:</span>
          <select className="border rounded-lg px-2 py-1.5" value={stageFilter ?? ''}
            onChange={(e) => setStageFilter(e.target.value ? Number(e.target.value) : null)}>
            {stages.map((s: any) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
          <span className="text-xs text-gray-400">— пакеты выбранного этапа (и общие «весь турнир»)</span>
          {stageFilter != null && (
            <a href={`/t/${eventId}/${stageFilter}/reglament`} target="_blank" rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs text-[#25455D] underline">
              📋 Регламент подсчёта (публичная страница)
            </a>
          )}
        </div>
      )}
      {visiblePackages.map(pkg => <PackageCard key={pkg.id} eventId={eventId} pkg={pkg} stages={stages} defaultStage={stageFilter} onChange={load} />)}
      <button onClick={addPackage} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-[#25455D] text-[#FFCFA4] hover:opacity-90">
        <Plus size={16} /> Добавить пакет
      </button>
    </div>
  )
}

function PackageCard({ eventId, pkg, stages, defaultStage, onChange }: any) {
  const [weight, setWeight] = useState(String(pkg.weight))
  const [normalize, setNormalize] = useState(!!pkg.normalize)
  const [sumMode, setSumMode] = useState(pkg.aggregate === 'sum')

  // Правки полей пакета не требуют рефетча — локальный state/uncontrolled-инпуты
  // уже отражают значение, расчёт ИТОГ в этой подвкладке не показывается.
  const savePkg = async (patch: any) => { await api.tournament.updatePackage(eventId, pkg.id, patch) }
  const delPkg = async () => {
    if (!confirm(`Удалить пакет «${pkg.title}» со всеми критериями и оценками?`)) return
    await api.tournament.deletePackage(eventId, pkg.id); onChange()
  }
  const addCrit = async () => {
    const title = prompt('Название критерия:')
    if (!title?.trim()) return
    // этап у пакета — критерий привязки к этапу не имеет
    await api.tournament.createCriterion(eventId, { package_id: pkg.id, title: title.trim(), scorer: 'jury', scale_max: 10, weight: 1, sort_order: (pkg.criteria?.length || 0) })
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
        <label className="text-xs text-gray-500 flex items-center gap-1" title="Складывать баллы критериев, а не усреднять. По умолчанию балл пакета = среднее по критериям. Включите, если хотите, чтобы баллы за задания суммировались (6 заданий по 6 → 36, а не 6).">
          <input type="checkbox" checked={sumMode} onChange={(e) => { setSumMode(e.target.checked); savePkg({ aggregate: e.target.checked ? 'sum' : 'avg' }) }} />
          складывать, не усреднять (?)
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
  // reload=false: значение уже в uncontrolled-поле, рефетч не нужен (без мигания).
  // reload=true: правка меняет структуру UI (scorer/auto_kind) — нужен перечит.
  const save = async (patch: any, reload = false) => { await api.tournament.updateCriterion(eventId, crit.id, patch); if (reload) onChange() }
  const del = async () => { if (confirm('Удалить критерий?')) { await api.tournament.deleteCriterion(eventId, crit.id); onChange() } }
  return (
   <div className="bg-gray-50 rounded-lg px-3 py-2 space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1.5 flex-1 min-w-[150px]">
        <Pencil size={12} className="text-gray-400 shrink-0" />
        <input className="flex-1 bg-white border border-gray-200 rounded-md px-2 py-1 text-sm outline-none hover:border-gray-300 focus:border-[#FFCFA4] focus:ring-1 focus:ring-[#FFCFA4] placeholder:text-gray-300 placeholder:italic"
          defaultValue={crit.title} title="Нажмите, чтобы переименовать критерий" placeholder="Название критерия"
          onBlur={(e) => e.target.value.trim() && e.target.value !== crit.title && save({ title: e.target.value.trim() })} />
      </div>
      <select className="text-xs border rounded px-1.5 py-1" value={crit.scorer} onChange={(e) => save({ scorer: e.target.value }, true)}>
        <option value="jury">Ставит: Жюри</option>
        <option value="vote">Ставит: Народное</option>
        <option value="manual">Ставит: Ручной</option>
        <option value="auto">Ставит: Авто</option>
      </select>
      {crit.scorer === 'auto' && (
        <select className="text-xs border rounded px-1.5 py-1" value={crit.auto_kind || 'referrals'} onChange={(e) => save({ auto_kind: e.target.value }, true)}>
          <option value="referrals">Привёл по реф-ссылке</option>
          <option value="lead_magnet">Пришло в лид-магнит</option>
        </select>
      )}
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
    {/* Описание критерия — что это и как оценивать (видят жюри в кабинете) */}
    <textarea
      className="w-full bg-white border border-gray-200 rounded-md px-2 py-1 text-xs outline-none hover:border-gray-300 focus:border-[#FFCFA4] focus:ring-1 focus:ring-[#FFCFA4] resize-y placeholder:text-gray-300 placeholder:italic"
      rows={crit.description ? 2 : 1}
      defaultValue={crit.description || ''}
      placeholder="Описание критерия — что это, как оценивать (увидят жюри в своём кабинете)"
      onBlur={(e) => { const v = e.target.value.trim(); if (v !== (crit.description || '')) save({ description: v || null }) }} />
    {crit.scorer === 'manual' && (
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-gray-500 shrink-0">Кодовая фраза</span>
        <input className="flex-1 bg-white border border-amber-200 rounded-md px-2 py-1 text-xs font-mono outline-none focus:border-[#FFCFA4] focus:ring-1 focus:ring-[#FFCFA4] placeholder:text-gray-300 placeholder:italic placeholder:font-sans"
          defaultValue={crit.code_phrase || ''}
          placeholder="не задана — напр. #дз1"
          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (crit.code_phrase || '')) save({ code_phrase: v || null }) }} />
      </div>
    )}
   </div>
  )
}

// ─────────────────────── Распределение ───────────────────────

function AssignmentsSub({ eventId }: { eventId: number }) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<any>(null)
  const [pairs, setPairs] = useState<Set<string>>(new Set())
  const [stageId, setStageId] = useState<number | null>(null)
  const [stagesInit, setStagesInit] = useState(false)
  const [autoOpen, setAutoOpen] = useState(false)
  const [autoSpeakers, setAutoSpeakers] = useState(false)
  const [autoParticipants, setAutoParticipants] = useState(true)
  const [perJuror, setPerJuror] = useState<string>('')
  const [suggest, setSuggest] = useState<any>(null)
  const [autoBusy, setAutoBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.tournament.assignments(eventId, stageId)
      setData(r); setPairs(new Set((r.pairs || []).map((p: any) => `${p.juror_ec_id}|${p.key}`)))
      // дефолт — первый этап (распределение всегда в рамках этапа)
      if (!stagesInit) {
        setStagesInit(true)
        if ((r.stages || []).length > 0 && stageId == null) setStageId(r.stages[0].id)
      }
    } finally { setLoading(false) }
  }, [eventId, stageId, stagesInit])
  useEffect(() => { load() }, [load])

  // конфликт: данное жюри привело этого участника (referrer_ref_code = ref_code жюри)
  const isConflict = (s: any, juror: number) =>
    Array.isArray(s.referrer_juror_ec_ids) && s.referrer_juror_ec_ids.includes(juror)

  const toggle = async (s: any, juror: number) => {
    const key = s.key
    const k = `${juror}|${key}`
    const assigned = !pairs.has(k)
    // Предупреждение только при НАЗНАЧЕНИИ жюри, которое ПРИВЕЛО этого участника.
    if (assigned && isConflict(s, juror)) {
      const jname = data.jurors.find((j: any) => j.juror_ec_id === juror)?.name || 'это жюри'
      const ok = confirm(
        `⚠️ Конфликт интересов\n\n«${jname}» привёл участника «${s.name}» по своей реф-ссылке.\n\n` +
        `Если жюри оценивает того, кого само привело — это может повлиять на объективность.\n\nВсё равно назначить?`
      )
      if (!ok) return
    }
    const next = new Set(pairs); assigned ? next.add(k) : next.delete(k); setPairs(next)
    try {
      await api.tournament.setAssignment(eventId, { juror_ec_id: juror, key, assigned, stage_id: stageId })
    } catch (e: any) {
      // запрет снятия жюри, которое уже выставило оценку — откатываем галочку
      const revert = new Set(pairs); assigned ? revert.delete(k) : revert.add(k); setPairs(revert)
      alert(e?.message || 'Не удалось изменить распределение.')
    }
  }
  const allAll = async (clear: boolean) => { await api.tournament.setAllAssignments(eventId, clear, stageId); load() }

  // открыть модалку автораспределения + подтянуть рекомендацию
  const openAuto = async () => {
    setAutoOpen(true); setSuggest(null)
    try {
      const s = await api.tournament.autoAssignSuggest(eventId, autoSpeakers, autoParticipants)
      setSuggest(s); if (!perJuror) setPerJuror(String(s.recommended_per_juror || ''))
    } catch {}
  }
  // пересчитать рекомендацию при смене типов
  const refreshSuggest = async (sp: boolean, pa: boolean) => {
    try {
      const s = await api.tournament.autoAssignSuggest(eventId, sp, pa)
      setSuggest(s); setPerJuror(String(s.recommended_per_juror || ''))
    } catch {}
  }
  const runAuto = async () => {
    if (!autoSpeakers && !autoParticipants) { alert('Выберите хотя бы один тип: спикеры или участники.'); return }
    const n = perJuror ? Number(perJuror) : null
    const msg = n
      ? `Распределить по ${n} ${n === 1 ? 'участнику' : 'участников'} на каждое жюри? Текущее распределение для выбранных типов будет заменено.`
      : 'Распределить автоматически (по рекомендации)? Текущее распределение для выбранных типов будет заменено.'
    if (!confirm(msg)) return
    setAutoBusy(true)
    try {
      const r: any = await api.tournament.autoAssign(eventId, {
        include_speakers: autoSpeakers, include_participants: autoParticipants,
        per_juror: n, stage_id: stageId,
      })
      setAutoOpen(false)
      await load()
      alert(`Готово. По ${r.per_juror} на жюри · назначено пар: ${r.assigned_pairs} · участников: ${r.subjects_count} · жюри: ${r.jurors_count}.`)
    } catch (e: any) {
      alert(e?.message || 'Не удалось распределить.')
    } finally { setAutoBusy(false) }
  }

  if (loading) return <Spinner />
  if (!data?.jurors?.length) return <p className="text-sm text-gray-500">Нет жюри. Добавьте коллабораторов с ролью «Жюри» на вкладке «Спикеры».</p>
  if (!data?.subjects?.length) return <p className="text-sm text-gray-500">Нет участников и спикеров для оценки.</p>

  const speakers = data.subjects.filter((s: any) => s.is_speaker)
  const participants = data.subjects.filter((s: any) => !s.is_speaker)

  // счётчик жюри у участника: всего / не-конфликтные / конфликтные (привели)
  const counts = (s: any) => {
    let total = 0, conflict = 0
    for (const j of data.jurors) {
      if (pairs.has(`${j.juror_ec_id}|${s.key}`)) {
        total++
        if (isConflict(s, j.juror_ec_id)) conflict++
      }
    }
    return { total, normal: total - conflict, conflict }
  }

  const rowGroup = (title: string, list: any[]) => list.length > 0 && (
    <>
      <tr>
        <td className="px-3 py-1.5 text-xs font-semibold text-[#25455D] bg-[#FFCFA4] uppercase sticky left-0 z-20">{title}</td>
        <td className="bg-[#FFCFA4] sticky left-[220px] z-20"></td>
        <td colSpan={data.jurors.length} className="bg-[#FFCFA4]"></td>
      </tr>
      {list.map((s: any) => {
        const c = counts(s)
        return (
        <tr key={s.key} className="border-t">
          <td className="px-3 py-2 sticky left-0 bg-white z-10 w-[220px] min-w-[220px] max-w-[220px]">
            <div className="font-medium text-gray-800 truncate" title={s.name}>{s.name}</div>
            {s.referrer_name && (
              <div className={`text-[11px] leading-tight truncate ${s.referrer_juror_ec_ids?.length ? 'text-red-500' : 'text-gray-400'}`} title={`Привёл: ${s.referrer_name}`}>
                привёл: {s.referrer_name}
              </div>
            )}
          </td>
          {/* счётчик жюри: всего / не-конфликт / конфликт — закреплён */}
          <td className="px-3 py-2 text-center whitespace-nowrap tabular-nums font-semibold sticky left-[220px] bg-white z-10 border-r">
            <span className="text-[#229ED9]" title="Всего жюри назначено">{c.total}</span>
            <span className="text-gray-300 mx-0.5">/</span>
            <span className="text-emerald-600" title="Без конфликта">{c.normal}</span>
            <span className="text-gray-300 mx-0.5">/</span>
            <span className="text-red-500" title="Привели этого участника (конфликт)">{c.conflict}</span>
          </td>
          {data.jurors.map((j: any) => {
            const checked = pairs.has(`${j.juror_ec_id}|${s.key}`)
            const conflict = isConflict(s, j.juror_ec_id)
            return (
              <td key={j.juror_ec_id} className={`text-center px-3 py-2 ${checked && conflict ? 'bg-red-50' : ''}`}>
                <input type="checkbox" className={conflict ? 'accent-red-500' : ''}
                  checked={checked} onChange={() => toggle(s, j.juror_ec_id)} />
              </td>
            )
          })}
        </tr>
        )
      })}
    </>
  )

  return (
    <div>
      <p className="text-sm text-gray-500 mb-2">Отметьте, кого оценивает каждое жюри на выбранном этапе. Жюри видит в кабинете только привязанных к нему.</p>
      {(data.stages || []).length > 0 && (
        <div className="flex items-center gap-2 text-sm mb-2">
          <span className="text-gray-500">Этап:</span>
          <select className="border rounded-lg px-2 py-1.5" value={stageId ?? ''} onChange={(e) => setStageId(e.target.value ? Number(e.target.value) : null)}>
            {data.stages.map((s: any) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
          <span className="text-xs text-gray-400">— распределение отдельное на каждом этапе</span>
        </div>
      )}
      <p className="text-xs text-gray-400 mb-3">
        Счётчик у участника: <span className="text-[#229ED9] font-semibold">всего</span> /
        <span className="text-emerald-600 font-semibold"> без конфликта</span> /
        <span className="text-red-500 font-semibold"> привели его</span>. Красная цифра — жюри, которое само привело участника по реф-ссылке.
      </p>
      <div className="overflow-auto border rounded-xl" style={{ WebkitOverflowScrolling: 'touch', maxHeight: '70vh' }}>
        <table className="text-sm min-w-max">
          <thead className="sticky top-0 z-30">
            <tr className="bg-gray-50">
              <th className="text-left px-3 py-2 sticky left-0 bg-gray-50 z-20 w-[220px] min-w-[220px] max-w-[220px]">Участник</th>
              <th className="px-3 py-2 font-medium text-gray-600 whitespace-nowrap text-center sticky left-[220px] bg-gray-50 z-20 border-r">Жюри</th>
              {data.jurors.map((j: any) => <th key={j.juror_ec_id} className="px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{j.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rowGroup('Спикеры', speakers)}
            {rowGroup('Участники', participants)}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        <button onClick={openAuto} className="px-3 py-1.5 rounded-lg text-sm bg-[#FFCFA4] text-[#25455D] font-medium">✨ Автораспределение</button>
        <button onClick={() => allAll(false)} className="px-3 py-1.5 rounded-lg text-sm bg-[#25455D] text-[#FFCFA4]">Назначить всех всем</button>
        <button onClick={() => allAll(true)} className="px-3 py-1.5 rounded-lg text-sm border text-gray-600">Очистить</button>
      </div>

      {autoOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !autoBusy && setAutoOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-[#25455D] mb-1">Автораспределение по жюри</h3>
            <p className="text-xs text-gray-500 mb-4">Система раскидает выбранных участников по жюри равномерно, стараясь не назначать жюри тех, кого оно само привело.</p>

            <div className="space-y-2 mb-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={autoParticipants} onChange={(e) => { setAutoParticipants(e.target.checked); refreshSuggest(autoSpeakers, e.target.checked) }} />
                Участники
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={autoSpeakers} onChange={(e) => { setAutoSpeakers(e.target.checked); refreshSuggest(e.target.checked, autoParticipants) }} />
                Спикеры
              </label>
            </div>

            {suggest && (
              <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-3 mb-3">
                Участников к распределению: <b>{suggest.subjects_count}</b> · жюри: <b>{suggest.jurors_count}</b>.<br />
                {suggest.jurors_count > 0 && suggest.subjects_count > suggest.jurors_count
                  ? <>Участников больше, чем жюри. Рекомендуем минимум <b>{suggest.recommended_per_juror}</b> на каждое жюри (чтобы каждого оценило ~{suggest.recommended_views_per_subject} жюри).</>
                  : <>Рекомендуем <b>{suggest.recommended_per_juror}</b> на каждое жюри.</>}
              </div>
            )}

            <label className="block text-sm mb-1 text-gray-600">Участников на 1 жюри</label>
            <input type="number" min={1} value={perJuror} onChange={(e) => setPerJuror(e.target.value)}
              placeholder={suggest ? String(suggest.recommended_per_juror) : 'авто'}
              className="w-full border rounded-lg px-3 py-2 text-sm mb-1" />
            <p className="text-xs text-gray-400 mb-4">Пусто — система сама подберёт по рекомендации.</p>

            <div className="flex gap-2 justify-end">
              <button onClick={() => setAutoOpen(false)} disabled={autoBusy} className="px-3 py-1.5 rounded-lg text-sm border text-gray-600 disabled:opacity-50">Отмена</button>
              <button onClick={runAuto} disabled={autoBusy} className="px-4 py-1.5 rounded-lg text-sm bg-[#25455D] text-[#FFCFA4] disabled:opacity-50">
                {autoBusy ? 'Распределяю…' : 'Распределить'}
              </button>
            </div>
          </div>
        </div>
      )}
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
    const num = Number(value)
    if (isNaN(num) || num < 0) { alert('Балл не может быть отрицательным.'); load(); return }
    const col = (board?.columns || []).find((c: any) => c.criterion_id === criterionId)
    const mx = col ? Number(col.scale_max) : null
    if (mx != null && !isNaN(mx) && num > mx) { alert(`Балл не может быть больше максимума (${mx}).`); load(); return }
    // Бэк возвращает пересчитанную таблицу — обновляем без полного рефетча (без мигания).
    const r = await api.tournament.manualScore(eventId, { criterion_id: criterionId, key, value: num, stage_id: stageId })
    if (r?.board) setBoard(r.board)
    else load()
  }

  if (loading) return <Spinner />
  if (!board?.table?.length) return <p className="text-sm text-gray-500">Нет участников/спикеров или критериев. Заведите критерии; участники появятся после регистрации, спикеры — на вкладке «Спикеры».</p>

  const cols: any[] = board.columns || []
  // группировка колонок по пакетам для шапки
  const groups: { title: string; weight: number; span: number; normalize: boolean; aggregate: string }[] = []
  cols.forEach((c) => {
    const last = groups[groups.length - 1]
    if (last && last.title === c.package_title) last.span++
    else {
      const pkg = board.packages.find((p: any) => p.id === c.package_id)
      groups.push({ title: c.package_title, weight: pkg?.weight ?? 1, span: 1, normalize: !!pkg?.normalize, aggregate: pkg?.aggregate || 'avg' })
    }
  })
  // подпись режима пакета: вес, сумма/среднее, нормализация
  const pkgMode = (p: any) => {
    const parts: string[] = [`вес ×${p.weight ?? 1}`]
    parts.push((p.aggregate || 'avg') === 'sum' ? 'сумма' : 'среднее')
    if (p.normalize) parts.push('норм. 0–1')
    return parts.join(' · ')
  }
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
      <div className="overflow-auto border rounded-xl" style={{ maxHeight: '75vh' }}>
        <table className="text-sm w-full border-separate" style={{ borderSpacing: 0 }}>
          <thead>
            {/* верхняя строка шапки: группировки */}
            <tr className="bg-gray-50 text-gray-600">
              <th rowSpan={2} className="px-3 py-2 text-left sticky top-0 left-0 z-40 bg-gray-50" style={{ width: 56, minWidth: 56 }}>Место</th>
              <th rowSpan={2} className="px-2 py-2 text-left sticky top-0 z-40 bg-gray-50 border-r whitespace-normal break-words" style={{ left: 56, width: 180, minWidth: 180, maxWidth: 180 }}>Участник</th>
              <th rowSpan={2} className="px-3 py-2 sticky top-0 z-30 bg-gray-50">Готово</th>
              <th rowSpan={2} className="px-3 py-2 font-semibold text-[#25455D] border-l sticky top-0 z-30 bg-gray-50">ИТОГ</th>
              {/* итоговые баллы пакетов */}
              <th colSpan={board.packages.length} className="px-3 py-1.5 text-center border-l sticky top-0 z-30 bg-gray-50">Баллы по пакетам</th>
              {/* критерии, сгруппированные по пакетам — с режимом расчёта */}
              {groups.map((g, i) => (
                <th key={i} colSpan={g.span} className="px-2 py-1.5 text-center border-l align-top sticky top-0 z-30 bg-gray-50">
                  <div>{g.title}</div>
                  <div className="text-[10px] font-normal text-gray-400 normal-case">{pkgMode(g)}</div>
                </th>
              ))}
              <th rowSpan={2} className="px-3 py-2 border-l sticky top-0 z-30 bg-gray-50">Детализация</th>
            </tr>
            <tr className="bg-gray-50 text-gray-500 text-xs">
              {board.packages.map((p: any, i: number) => (
                <th key={p.id} className={`px-2 py-1.5 font-medium align-top sticky z-30 bg-gray-50 ${i===0?'border-l':''}`} style={{ minWidth: 70, maxWidth: 110, top: 33 }}>
                  <div className="whitespace-normal break-words leading-tight">{p.title}</div>
                  <div className="text-[10px] font-normal text-gray-400 normal-case">{pkgMode(p)}</div>
                </th>
              ))}
              {cols.map((c, i) => (
                <th key={c.criterion_id} className={`px-1.5 py-1.5 align-top font-medium sticky z-30 bg-gray-50 ${i===0?'border-l':''}`} style={{ minWidth: 64, maxWidth: 90, top: 33 }} title={c.scorer}>
                  <div className="whitespace-normal break-words leading-tight">{c.title}{normalizeOf(c.criterion_id) && <NormBadge />}</div>
                  <div className="text-[10px] font-normal text-gray-400">×{c.weight ?? 1}</div>
                  {c.description && (
                    <div className="text-[10px] font-normal text-gray-400 leading-tight whitespace-pre-line mt-0.5 normal-case">{c.description}</div>
                  )}
                  {c.code_phrase && (
                    <div className="text-[9px] font-semibold text-amber-700 leading-tight mt-1 normal-case font-mono whitespace-normal break-words">Кодовая фраза для выкладки отчёта:<br/>«{c.code_phrase}»</div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {board.table.map((row: any) => {
              const fbs = feedback.filter((f: any) => f.key === row.key)
              const isOpen = expanded === row.key
              return (
                <>
                  <tr key={row.key} className="border-t hover:bg-gray-50 group">
                    <td className="px-3 py-2 sticky left-0 z-20 bg-white group-hover:bg-gray-50 border-t" style={{ width: 56, minWidth: 56 }}>{row.place <= 3 ? ['🥇','🥈','🥉'][row.place-1] : row.place}</td>
                    <td className="px-2 py-2 whitespace-normal break-words sticky z-20 bg-white group-hover:bg-gray-50 border-t border-r" style={{ left: 56, width: 180, minWidth: 180, maxWidth: 180 }}>{row.name}{!row.is_speaker && <span className="ml-1 text-[10px] text-gray-400">участник</span>}{row.username && <div className="text-[10px] text-gray-400 leading-tight">@{row.username}</div>}</td>
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
                            <input type="number" min={0} className="w-16 border rounded px-1 py-0.5 text-sm text-center" defaultValue={val ?? ''}
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


// ─────────────────────── Контроль заданий ───────────────────────
function ChannelStatusCard({ ch, eventId }: { ch: any; eventId: number }) {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<any>(null)
  const verify = async () => {
    setChecking(true); setResult(null)
    try {
      const r = await api.tournament.verifyChat(eventId, ch.platform)
      setResult(r)
    } catch (e: any) {
      setResult({ ok: false, message: 'Не удалось проверить: ' + (e?.message || 'ошибка') })
    } finally { setChecking(false) }
  }
  // 3 состояния. Приоритет: свежий результат кнопки → сохранённый в БД статус
  // (ch.checked, «прилипает» после перезагрузки) → «не проверено» (жёлтый).
  const state: 'ok' | 'fail' | 'unknown' =
    result ? (result.ok ? 'ok' : 'fail')
    : ch.checked ? (ch.ok ? 'ok' : 'fail')
    : (ch.has_id || ch.chat_id ? 'unknown' : 'fail')
  const border = state === 'ok' ? 'border-green-200 bg-green-50'
    : state === 'fail' ? 'border-gray-200 bg-gray-50'
    : 'border-amber-200 bg-amber-50'
  const icon = state === 'ok' ? '✓' : state === 'fail' ? '✕' : '•'
  const iconColor = state === 'ok' ? 'text-green-600' : state === 'fail' ? 'text-gray-400' : 'text-amber-500'
  // подпись-чип у заголовка
  const tag = state === 'ok' ? <span className="text-[10px] text-green-600">слушает ✓</span>
    : state === 'fail' && ch.checked ? <span className="text-[10px] text-gray-500">проблема</span>
    : state === 'unknown' ? <span className="text-[10px] text-amber-600">не проверено</span>
    : null
  // дата прошлой проверки
  const fmtAt = ch.checked_at ? new Date(ch.checked_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null
  return (
    <div className={`rounded-lg border p-3 ${border}`}>
      <div className="flex items-center gap-2">
        <span className={`text-lg ${iconColor}`}>{icon}</span>
        <span className="font-medium text-gray-800">{ch.label}</span>
        {tag}
      </div>
      <div className="text-xs text-gray-500 mt-1">
        {ch.chat_id ? `ID чата: ${ch.chat_id}` : (ch.hint || 'ID чата не задан')}
      </div>
      {/* сохранённый результат прошлой проверки (если кнопку сейчас не жали) */}
      {!result && ch.checked && ch.checked_message && (
        <div className={`text-xs mt-2 leading-snug ${ch.ok ? 'text-green-700' : 'text-amber-700'}`}>
          {ch.checked_message}{fmtAt && <span className="text-gray-400"> · проверено {fmtAt}</span>}
        </div>
      )}
      {result && (
        <div className={`text-xs mt-2 leading-snug ${result.ok ? 'text-green-700' : 'text-amber-700'}`}>{result.message}</div>
      )}
      {(ch.chat_id || ch.has_id) && (
        <button onClick={verify} disabled={checking}
          className="mt-2 text-xs px-2.5 py-1 rounded-md bg-[#25455D] text-white hover:bg-[#1b3242] disabled:opacity-50">
          {checking ? 'Проверяю…' : 'Проверить, что бот слушает'}
        </button>
      )}
    </div>
  )
}

function TaskControlSub({ eventId }: { eventId: number }) {
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [channels, setChannels] = useState<any[]>([])
  const [submissions, setSubmissions] = useState<any[]>([])
  const [stages, setStages] = useState<any[]>([])
  const [criteria, setCriteria] = useState<any[]>([])
  // фильтры
  const [fCriterion, setFCriterion] = useState<number | ''>('')
  const [fSubject, setFSubject] = useState<string>('')
  const [fRecognized, setFRecognized] = useState<'' | 'yes' | 'no'>('')
  const [sort, setSort] = useState<'date_desc' | 'date_asc'>('date_desc')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: any = { sort }
      if (fCriterion) params.criterion_id = fCriterion
      if (fSubject) params.subject = fSubject
      if (fRecognized) params.recognized = fRecognized
      const [tc, crit] = await Promise.all([
        api.tournament.taskControl(eventId, params),
        api.tournament.criteria(eventId),
      ])
      setEnabled(!!tc.enabled)
      setChannels(tc.channels || [])
      setSubmissions(tc.submissions || [])
      setStages((crit.stages || []))
      const allCrit: any[] = []
      ;(crit.packages || []).forEach((p: any) => (p.criteria || []).forEach((c: any) => {
        if (c.scorer === 'manual') allCrit.push(c)
      }))
      setCriteria(allCrit)
    } finally { setLoading(false) }
  }, [eventId, sort, fCriterion, fSubject, fRecognized])

  useEffect(() => { load() }, [load])

  const toggleListen = async () => {
    await api.tournament.toggleTaskListen(eventId, !enabled)
    setEnabled(!enabled)
  }
  // role: 'all' | 'registered' | 'speakers' | 'jury' | 'none'
  // 'none' (Не слушать) = пустой набор; 'all' взаимоисключающ с конкретными ролями.
  const setAudience = async (stageId: number, role: string) => {
    const st = stages.find(s => s.id === stageId)
    const cur: string[] = st?.listen_audiences || []
    let next: string[]
    if (role === 'none') {
      next = []                                   // Не слушать — гасим всё
    } else if (role === 'all') {
      next = cur.includes('all') ? [] : ['all']   // Все — взаимоисключающе
    } else {
      // конкретная роль: убираем 'all', тогглим саму роль
      const base = cur.filter(r => r !== 'all')
      next = base.includes(role) ? base.filter(r => r !== role) : [...base, role]
    }
    setStages(stages.map(s => s.id === stageId ? { ...s, listen_audiences: next } : s))
    await api.tournament.setStageAudience(eventId, stageId, next)
  }

  // уникальные участники для фильтра (из submissions)
  const subjects = Array.from(new Map(
    submissions.filter(s => s.subject_kind && s.subject_id)
      .map(s => [`${s.subject_kind}:${s.subject_id}`, s.participant_name || `#${s.subject_id}`])
  ).entries())

  if (loading) return <div className="py-10 flex justify-center"><Spinner /></div>

  return (
    <div className="space-y-5">
      {/* Большая галка включения слушания */}
      <div className="bg-gradient-to-br from-[#25455D] to-[#0a1520] rounded-xl p-5 text-white flex items-center justify-between gap-4">
        <div>
          <div className="text-lg font-semibold">Слушание заданий в чатах</div>
          <div className="text-sm text-white/70 mt-0.5">
            Бот ловит сообщения с кодовыми фразами критериев и автоматически ставит баллы.
          </div>
          <a href="/dashboard/help/tournament-task-control" target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1 text-xs text-[#FFCFA4] hover:underline mt-2">
            📖 Как настроить — пошаговая инструкция
          </a>
        </div>
        <button onClick={toggleListen}
          className={`relative w-16 h-9 rounded-full transition-colors shrink-0 ${enabled ? 'bg-[#FFCFA4]' : 'bg-white/20'}`}>
          <span className={`absolute top-1 left-1 w-7 h-7 rounded-full bg-white transition-transform ${enabled ? 'translate-x-7' : ''}`} />
        </button>
      </div>

      {/* Статус соцсетей */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {channels.map(ch => (
          <ChannelStatusCard key={ch.platform} ch={ch} eventId={eventId} />
        ))}
      </div>

      {/* Настройка этапов — кого слушаем (выпадающий список с галочками) */}
      {stages.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="text-sm font-semibold text-gray-800 mb-1">Кого слушаем в каждом этапе</div>
          <div className="text-xs text-gray-500 mb-3">
            Выберите в списке, чьи сообщения слушать на этапе. Можно отметить несколько.
          </div>
          <div className="space-y-2">
            {stages.map(st => (
              <div key={st.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <span className="text-sm text-gray-700">{st.title}</span>
                <AudienceDropdown
                  value={st.listen_audiences || []}
                  onToggle={(role) => setAudience(st.id, role)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Фильтры */}
      <div className="flex flex-wrap items-center gap-2">
        <select className="text-xs border rounded px-2 py-1.5" value={fCriterion} onChange={e => setFCriterion(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Все задания</option>
          {criteria.map(c => <option key={c.id} value={c.id}>{c.title}{c.code_phrase ? ` (${c.code_phrase})` : ''}</option>)}
        </select>
        <select className="text-xs border rounded px-2 py-1.5" value={fSubject} onChange={e => setFSubject(e.target.value)}>
          <option value="">Все участники</option>
          {subjects.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
        </select>
        <select className="text-xs border rounded px-2 py-1.5" value={fRecognized} onChange={e => setFRecognized(e.target.value as any)}>
          <option value="">Все</option>
          <option value="yes">Опознанные</option>
          <option value="no">Неопознанные</option>
        </select>
        <select className="text-xs border rounded px-2 py-1.5" value={sort} onChange={e => setSort(e.target.value as any)}>
          <option value="date_desc">Сначала новые</option>
          <option value="date_asc">Сначала старые</option>
        </select>
        <span className="text-xs text-gray-400">Найдено: {submissions.length}</span>
      </div>

      {/* Таблица */}
      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-2 py-2 text-left font-medium">Участник</th>
              <th className="px-2 py-2 text-left font-medium">Соцсеть</th>
              <th className="px-2 py-2 text-left font-medium">Дата</th>
              <th className="px-2 py-2 text-left font-medium">Задание</th>
              <th className="px-2 py-2 text-left font-medium">Фраза</th>
              <th className="px-2 py-2 text-left font-medium">Текст</th>
              <th className="px-2 py-2 text-left font-medium">Сообщение</th>
              <th className="px-2 py-2 text-left font-medium">Вложения</th>
            </tr>
          </thead>
          <tbody>
            {submissions.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">Пока ничего не поймано</td></tr>
            )}
            {submissions.map(s => {
              const platLabel = s.platform === 'vk' ? 'ВКонтакте' : s.platform === 'max' ? 'MAX' : 'Telegram'
              const d = s.sent_at ? new Date(s.sent_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—'
              const atts = Array.isArray(s.attachments) ? s.attachments : []
              return (
                <tr key={s.id} className={`border-t border-gray-100 ${!s.recognized ? 'bg-red-50' : ''}`}>
                  <td className="px-2 py-1.5">
                    {s.recognized
                      ? <>
                          <div>{s.participant_name || `#${s.subject_id}`}</div>
                          {s.username && <div className="text-[10px] text-gray-400 leading-tight">@{s.username}</div>}
                        </>
                      : <>
                          <span className="text-red-600 font-medium">{s.author_name || s.username || s.platform_user_id} · не опознан</span>
                          {s.username && <div className="text-[10px] text-gray-400 leading-tight">@{s.username}</div>}
                        </>}
                  </td>
                  <td className="px-2 py-1.5">{platLabel}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{d}</td>
                  <td className="px-2 py-1.5">{s.criterion_title || '—'}</td>
                  <td className="px-2 py-1.5 font-mono">{s.code_phrase || '—'}</td>
                  <td className="px-2 py-1.5 max-w-[240px] truncate" title={s.text || ''}>{s.text || '—'}</td>
                  <td className="px-2 py-1.5">
                    {s.message_link ? <a href={s.message_link} target="_blank" rel="noreferrer" className="text-[#25455D] underline">открыть</a> : '—'}
                  </td>
                  <td className="px-2 py-1.5">
                    {atts.length === 0 ? '—' : atts.map((a: any, i: number) => (
                      a.url ? <a key={i} href={a.url} target="_blank" rel="noreferrer" className="text-[#25455D] underline mr-1">{a.kind}</a>
                            : <span key={i} className="text-gray-400 mr-1">{a.kind}</span>
                    ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─────────── Выпадающий список с галочками «Кого слушаем» ───────────
const AUDIENCE_OPTS: { v: string; label: string }[] = [
  { v: 'all', label: 'Все' },
  { v: 'registered', label: 'Зарегистрированные' },
  { v: 'speakers', label: 'Спикеры' },
  { v: 'jury', label: 'Жюри' },
  { v: 'none', label: 'Не слушать' },
]

function AudienceDropdown({ value, onToggle }: { value: string[]; onToggle: (role: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // подпись на кнопке
  let summary: string
  if (value.length === 0) summary = 'Не слушать'
  else if (value.includes('all')) summary = 'Все'
  else summary = AUDIENCE_OPTS.filter(o => value.includes(o.v)).map(o => o.label).join(', ')

  const isChecked = (v: string) =>
    v === 'none' ? value.length === 0 : value.includes(v)

  return (
    <div className="relative w-full sm:w-64" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 text-sm border rounded-lg px-3 py-1.5 bg-white hover:border-gray-400">
        <span className="truncate text-gray-700">{summary}</span>
        <ChevronDown size={16} className="text-gray-400 shrink-0" />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg py-1">
          {AUDIENCE_OPTS.map(o => (
            <label key={o.v}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 cursor-pointer select-none">
              <input type="checkbox" className="accent-[#25455D] w-4 h-4"
                checked={isChecked(o.v)}
                onChange={() => onToggle(o.v)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
