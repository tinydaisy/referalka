'use client'

/**
 * Вкладка «Номинации/Туры/Этапы» — раздел Турнир.
 *
 * Зачем отдельная вкладка. Раньше этапы создавались ТОЛЬКО на вкладке
 * «Программа», где они нарисованы вкладками в строку. У премии номинаций
 * бывает 70 — их не пролистать, и заводить по одной кнопкой нереально.
 * Здесь: список с поиском, категории, массовое добавление списком,
 * привязка людей галочками.
 *
 * ⚠️ Номинация = `conf_stages` — та же сущность, что тур и этап. Отдельной
 *    таблицы нет намеренно: на этапы завязаны критерии, распределение жюри,
 *    оценки и дни программы. Разное только слово в интерфейсе.
 */

import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import {
  Plus, Trash2, ChevronDown, ChevronRight, Search, Users, X,
  FolderPlus, ListPlus, Loader2,
} from 'lucide-react'

interface Category { id: number; title: string; sort_order: number; stages_count?: number }
interface Stage {
  id: number; title: string; subtitle?: string | null; description?: string | null
  start_date?: string | null; end_date?: string | null
  sort_order: number; category_id?: number | null
  listen_audiences?: string[]
}
interface Person { ec_id: number; name: string; role: string; stage_ids: number[] }

export default function NominationsTab({ eventId }: { eventId: number }) {
  const [cats, setCats] = useState<Category[]>([])
  const [stages, setStages] = useState<Stage[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [catFilter, setCatFilter] = useState<number | null>(null)
  const [openStage, setOpenStage] = useState<number | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkCat, setBulkCat] = useState<number | null>(null)
  const [peopleFor, setPeopleFor] = useState<number | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [c, s, sp] = await Promise.all([
        api.conference.stageCategories.list(eventId).catch(() => ({ categories: [] })),
        api.conference.stages.list(eventId).catch(() => ({ stages: [] })),
        api.conference.speakers.list(eventId).catch(() => ({ speakers: [] })),
      ])
      setCats(c.categories || [])
      setStages(s.stages || [])
      setPeople((sp.speakers || []).map((x: any) => ({
        ec_id: x.id, name: x.name || 'Без имени', role: x.role || 'speaker',
        stage_ids: x.stage_ids || [],
      })))
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [eventId])

  const catTitle = (id?: number | null) => cats.find(c => c.id === id)?.title || ''

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return stages
      .filter(s => catFilter === null || (s.category_id ?? null) === catFilter)
      .filter(s => !needle
        || (s.title || '').toLowerCase().includes(needle)
        || catTitle(s.category_id).toLowerCase().includes(needle))
      .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ru'))
  }, [stages, q, catFilter, cats])

  // ── Действия ────────────────────────────────────────────────────────
  const addStage = async () => {
    setBusy(true)
    try {
      const r = await api.conference.stages.create(eventId, {
        title: 'Новая номинация',
        sort_order: (stages.reduce((m, s) => Math.max(m, s.sort_order || 0), 0) || 0) + 10,
        category_id: catFilter,
      })
      setStages(p => [...p, r.stage]); setOpenStage(r.stage.id)
    } finally { setBusy(false) }
  }

  const bulkAdd = async () => {
    const titles = bulkText.split('\n').map(t => t.trim()).filter(Boolean)
    if (!titles.length) return
    setBusy(true)
    try {
      const r = await api.conference.stages.bulkCreate(eventId, titles, bulkCat)
      setStages(p => [...p, ...(r.created || [])])
      setBulkOpen(false); setBulkText('')
      if (r.skipped) alert(`Добавлено: ${r.created_count}. Пропущено (уже есть): ${r.skipped}`)
    } finally { setBusy(false) }
  }

  const patchStage = async (id: number, patch: any) => {
    setStages(p => p.map(s => s.id === id ? { ...s, ...patch } : s))
    try { await api.conference.stages.update(eventId, id, patch) } catch { load() }
  }

  const delStage = async (s: Stage) => {
    if (!confirm(`Удалить «${s.title}»?\n\nКритерии, распределение жюри и оценки этой номинации будут удалены. Дни программы останутся — они просто перестанут быть привязаны.`)) return
    setBusy(true)
    try {
      await api.conference.stages.delete(eventId, s.id)
      setStages(p => p.filter(x => x.id !== s.id))
    } finally { setBusy(false) }
  }

  const addCat = async () => {
    const title = prompt('Название категории (например «Медицина»)')?.trim()
    if (!title) return
    const r = await api.conference.stageCategories.create(eventId, {
      title, sort_order: (cats.reduce((m, c) => Math.max(m, c.sort_order || 0), 0) || 0) + 10,
    })
    setCats(p => [...p, r.category])
  }

  const delCat = async (c: Category) => {
    if (!confirm(`Удалить категорию «${c.title}»?\n\nНоминации НЕ удалятся — они просто останутся без категории.`)) return
    await api.conference.stageCategories.delete(eventId, c.id)
    setCats(p => p.filter(x => x.id !== c.id))
    setStages(p => p.map(s => s.category_id === c.id ? { ...s, category_id: null } : s))
    if (catFilter === c.id) setCatFilter(null)
  }

  // Привязка человека к номинации — та же ручка, что на карточке спикера.
  const togglePerson = async (p: Person, stageId: number) => {
    const has = p.stage_ids.includes(stageId)
    const next = has ? p.stage_ids.filter(x => x !== stageId) : [...p.stage_ids, stageId]
    setPeople(prev => prev.map(x => x.ec_id === p.ec_id ? { ...x, stage_ids: next } : x))
    try {
      await api.conference.speakers.update(eventId, p.ec_id, { stage_ids: next })
    } catch (e: any) {
      // 409 = у человека уже есть оценки на снимаемой номинации.
      if (String(e?.message || '').includes('stage_has_scores')) {
        if (confirm('У этого человека уже есть оценки в этой номинации. Убрать вместе с оценками?')) {
          await api.conference.speakers.update(eventId, p.ec_id, { stage_ids: next, force_remove_stage_data: true })
          return
        }
      }
      setPeople(prev => prev.map(x => x.ec_id === p.ec_id ? { ...x, stage_ids: p.stage_ids } : x))
    }
  }

  const countIn = (stageId: number) => people.filter(p => p.stage_ids.includes(stageId)).length

  if (loading) return <div className="py-12 text-center text-gray-400"><Loader2 className="animate-spin inline" size={20} /></div>

  return (
    <div className="space-y-4">
      {/* Пояснение — что это и зачем */}
      <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm text-gray-700">
        Здесь заводятся <b>номинации</b> (в турнире — туры, этапы). У каждой свои критерии,
        своё жюри и своя таблица. Один человек может участвовать в нескольких номинациях.
      </div>

      {/* Категории */}
      <div className="bg-white border rounded-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium">Категории</div>
          <button onClick={addCat} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
            <FolderPlus size={13} /> Добавить категорию
          </button>
        </div>
        {cats.length === 0 ? (
          <div className="text-xs text-gray-400">
            Категорий нет. Они нужны, когда номинаций много: «Медицина» → «Лучший хирург», «Медсестра года».
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {cats.map(c => (
              <span key={c.id} className="inline-flex items-center gap-1.5 px-2 py-1 bg-gray-50 border rounded-full text-xs">
                {c.title}
                <span className="text-gray-400">{stages.filter(s => s.category_id === c.id).length}</span>
                <button onClick={() => delCat(c)} className="text-gray-300 hover:text-red-500"><X size={12} /></button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Панель: поиск + фильтр + кнопки */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder="Поиск по названию…"
            className="w-full pl-8 pr-3 py-2 border rounded-lg text-sm" />
        </div>
        {cats.length > 0 && (
          <select value={catFilter ?? ''} onChange={e => setCatFilter(e.target.value ? Number(e.target.value) : null)}
            className="px-3 py-2 border rounded-lg text-sm">
            <option value="">Все категории</option>
            {cats.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        )}
        <button onClick={() => setBulkOpen(true)} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-1.5 hover:bg-gray-50">
          <ListPlus size={14} /> Добавить списком
        </button>
        <button onClick={addStage} disabled={busy} className="btn-gold px-3 py-2 text-sm flex items-center gap-1.5">
          <Plus size={14} /> Добавить
        </button>
      </div>

      {/* Список номинаций */}
      {visible.length === 0 ? (
        <div className="py-10 text-center text-gray-400 text-sm border rounded-lg bg-white">
          {stages.length === 0 ? 'Пока ни одной номинации. Добавьте первую или загрузите списком.' : 'Ничего не найдено'}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(s => {
            const open = openStage === s.id
            return (
              <div key={s.id} className="bg-white border rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-gray-50"
                     onClick={() => setOpenStage(open ? null : s.id)}>
                  {open ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{s.title}</div>
                    {catTitle(s.category_id) && <div className="text-xs text-gray-400">{catTitle(s.category_id)}</div>}
                  </div>
                  <span className="text-xs text-gray-400 flex items-center gap-1 shrink-0">
                    <Users size={12} /> {countIn(s.id)}
                  </span>
                  <button onClick={e => { e.stopPropagation(); delStage(s) }}
                    className="text-gray-300 hover:text-red-500 shrink-0"><Trash2 size={14} /></button>
                </div>

                {open && (
                  <div className="px-3 pb-3 pt-1 border-t bg-gray-50 space-y-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Название</div>
                        <input defaultValue={s.title} onBlur={e => e.target.value.trim() && patchStage(s.id, { title: e.target.value.trim() })}
                          className="w-full px-2.5 py-1.5 border rounded text-sm" />
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Категория</div>
                        <select value={s.category_id ?? ''} onChange={e => patchStage(s.id, { category_id: e.target.value ? Number(e.target.value) : null })}
                          className="w-full px-2.5 py-1.5 border rounded text-sm bg-white">
                          <option value="">— без категории —</option>
                          {cats.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Описание (необязательно)</div>
                      <textarea defaultValue={s.description || ''} rows={2}
                        onBlur={e => patchStage(s.id, { description: e.target.value })}
                        className="w-full px-2.5 py-1.5 border rounded text-sm" />
                    </div>

                    <button onClick={() => setPeopleFor(peopleFor === s.id ? null : s.id)}
                      className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                      <Users size={13} /> {peopleFor === s.id ? 'Скрыть участников' : `Кто участвует (${countIn(s.id)})`}
                    </button>

                    {peopleFor === s.id && (
                      <div className="bg-white border rounded p-2 max-h-64 overflow-y-auto">
                        {people.length === 0 ? (
                          <div className="text-xs text-gray-400 py-2 text-center">
                            В событии пока нет людей. Добавьте их на вкладке «Спикеры/Номинанты».
                          </div>
                        ) : ['speaker', 'headliner', 'jury', 'organizer'].map(role => {
                          const list = people.filter(p => p.role === role)
                          if (!list.length) return null
                          const label = role === 'jury' ? 'Жюри' : role === 'organizer' ? 'Организаторы' : 'Спикеры/Номинанты'
                          return (
                            <div key={role} className="mb-2 last:mb-0">
                              <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">{label}</div>
                              {list.map(p => (
                                <label key={p.ec_id} className="flex items-center gap-2 py-1 text-sm cursor-pointer hover:bg-gray-50 px-1 rounded">
                                  <input type="checkbox" checked={p.stage_ids.includes(s.id)}
                                    onChange={() => togglePerson(p, s.id)} />
                                  <span className="truncate">{p.name}</span>
                                </label>
                              ))}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {stages.length > 0 && (
        <div className="text-xs text-gray-400">Всего номинаций: {stages.length}</div>
      )}

      {/* Модалка массового добавления. Закрывается только кнопкой — правило проекта. */}
      {bulkOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg p-4" onClick={e => e.stopPropagation()}>
            <div className="text-base font-medium mb-1">Добавить номинации списком</div>
            <div className="text-xs text-gray-500 mb-3">
              По одному названию в строке. Повторы с уже заведёнными пропустятся.
            </div>
            {cats.length > 0 && (
              <select value={bulkCat ?? ''} onChange={e => setBulkCat(e.target.value ? Number(e.target.value) : null)}
                className="w-full px-3 py-2 border rounded-lg text-sm mb-2">
                <option value="">— без категории —</option>
                {cats.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            )}
            <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} rows={10}
              placeholder={'Лучший хирург года\nМедсестра года\nВрач-исследователь'}
              className="w-full px-3 py-2 border rounded-lg text-sm font-mono" />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setBulkOpen(false)} className="px-4 py-2 border rounded-lg text-sm">Отмена</button>
              <button onClick={bulkAdd} disabled={busy} className="btn-gold px-4 py-2 text-sm">
                {busy ? 'Добавляю…' : 'Добавить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
