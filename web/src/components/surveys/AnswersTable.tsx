'use client'

/**
 * Таблица ответов на анкету.
 *
 * Зачем отдельным файлом: страница анкеты уже за тысячу строк, а тут
 * сортировка, фильтры, настройка колонок и правка полей сотрудника прямо в
 * ячейках — вместе они сделали бы файл нечитаемым.
 *
 * ⚠️ Поля сотрудника правятся ОТСЮДА и из карточки ответа. Эндпоинт у обоих
 * общий (`PUT .../staff-answers`), иначе поведение в двух местах разъехалось
 * бы: где-то галочка снимается, где-то нет.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search, Trash2, SlidersHorizontal, ArrowUp, ArrowDown, X, Check, Loader2, Filter,
} from 'lucide-react'
import { api } from '@/lib/api'
import ConditionBuilder, { emptyTree, SourceMeta } from '@/components/analytics/ConditionBuilder'

const DARK = '#25455D'

/** Колонки человека — всегда одни и те же, порядок значим. */
const PERSON_COLUMNS = [
  { key: 'created_at', title: 'Заполнено' },
  { key: 'name', title: 'Имя' },
  { key: 'email', title: 'Почта' },
  { key: 'phone', title: 'Телефон' },
  { key: 'telegram', title: 'Telegram' },
  { key: 'vk', title: 'ВКонтакте' },
  { key: 'max_nick', title: 'MAX' },
]

/** Что показываем, пока клиент ничего не настроил.
 *  ⚠️ Вопросы посетителя по умолчанию скрыты: их бывает под тридцать, и
 *  таблица на тридцать колонок нечитаема. Поля сотрудника, наоборот,
 *  показываем все — ради них таблицу и открывают. */
const DEFAULT_VISIBLE = ['created_at', 'name', 'email', 'phone']

function fmtDate(iso: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
  })
}

export default function AnswersTable({ surveyId }: { surveyId: number }) {
  const router = useRouter()
  const [rows, setRows] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [questions, setQuestions] = useState<any[]>([])
  const [settings, setSettings] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [removing, setRemoving] = useState<number | null>(null)

  const [q, setQ] = useState('')
  const [processed, setProcessed] = useState<'all' | 'yes' | 'no'>('all')
  const [sort, setSort] = useState('created_at')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [showCols, setShowCols] = useState(false)

  // Фильтры — тем же конструктором условий, что в дашбордах: люди одни и те
  // же, и два разных языка отбора клиента бы запутали.
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState<any>(emptyTree())
  const [applied, setApplied] = useState('')          // что реально ушло в запрос
  const [sources, setSources] = useState<SourceMeta[]>([])

  const staffQuestions = useMemo(
    () => questions.filter(x => x.filled_by === 'staff'), [questions])
  const visitorQuestions = useMemo(
    () => questions.filter(x => x.filled_by !== 'staff'), [questions])

  // Настройка видимости живёт на анкете: помощники должны видеть ту же
  // таблицу, что и владелец, иначе они разойдутся в том, что обсуждают.
  const visible: string[] = settings?.visible || [
    ...DEFAULT_VISIBLE, ...staffQuestions.map(x => `q:${x.id}`),
  ]

  const load = async () => {
    const params = new URLSearchParams({ sort, dir, processed })
    if (q.trim()) params.set('q', q.trim())
    if (applied) params.set('filters', applied)
    const [data, survey] = await Promise.all([
      api.surveys.responses(surveyId, params.toString()).catch(() => ({ responses: [], total: 0 })),
      api.surveys.get(surveyId).catch(() => ({ questions: [] })),
    ])
    setRows(data?.responses || [])
    setTotal(data?.total || 0)
    setQuestions(survey?.questions || [])
    if (settings === null) setSettings(survey?.table_settings?.visible ? survey.table_settings : {})
    setLoading(false)
  }

  // ⚠️ Поиск ждёт паузы в наборе: без задержки запрос уходил бы на каждую
  // букву, и на сотне ответов список дёргался бы на каждом нажатии.
  useEffect(() => {
    const t = setTimeout(() => { load() }, q ? 400 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyId, sort, dir, processed, q, applied])

  // Разрезы для конструктора — только вопросы ЭТОЙ анкеты плюс поля контакта.
  useEffect(() => {
    api.analytics.sources(surveyId)
      .then((d: any) => setSources(d?.sources || []))
      .catch(() => setSources([]))   // нет доступа к дашбордам — фильтры просто не покажем
  }, [surveyId])

  const saveVisible = async (next: string[]) => {
    setSettings({ ...(settings || {}), visible: next })
    try {
      await api.surveys.update(surveyId, { table_settings: { ...(settings || {}), visible: next } })
    } catch { /* показ не критичен — не мешаем работе из-за него */ }
  }

  const toggleCol = (key: string) => {
    const next = visible.includes(key)
      ? visible.filter(k => k !== key)
      : [...visible, key]
    saveVisible(next)
  }

  /** Переставить столбец в сохранённом порядке. */
  const moveCol = (i: number, delta: number) => {
    const next = [...visible]
    const j = i + delta
    if (j < 0 || j >= next.length) return
    const [moved] = next.splice(i, 1)
    next.splice(j, 0, moved)
    saveVisible(next)
  }

  /** Подпись столбца по ключу — и для человека, и для вопроса. */
  const titleOf = (key: string) => {
    const p = PERSON_COLUMNS.find(c => c.key === key)
    if (p) return p.title
    const qid = Number(key.replace('q:', ''))
    return questions.find(x => x.id === qid)?.title || key
  }

  const clickSort = (key: string) => {
    if (sort === key) setDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSort(key); setDir(key === 'created_at' ? 'desc' : 'asc') }
  }

  const removeResponse = async (e: React.MouseEvent, r: any) => {
    e.stopPropagation()
    if (!confirm(
      `Удалить это заполнение${r.name ? ` — ${r.name}` : ''}?\n\n` +
      'Ответы пропадут из отчёта. Сам контакт человека и заполненные им поля останутся.'
    )) return
    setRemoving(r.id)
    try {
      await api.surveys.deleteResponse(surveyId, r.id)
      setRows(list => list.filter(x => x.id !== r.id))
      setTotal(t => Math.max(0, t - 1))
    } catch (err: any) {
      alert(err?.message || 'Не удалось удалить')
    } finally { setRemoving(null) }
  }

  /** Ответ по вопросу из строки. */
  const answerOf = (row: any, qid: number) =>
    (row.answers || []).find((a: any) => a.question_id === qid)?.value || ''

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  // ⚠️ Столбцы строим ПО СОХРАНЁННОМУ ПОРЯДКУ (`visible`), а не фильтрацией
  // фиксированных массивов: иначе перестановка в «Настройке отображения»
  // ни на что не влияла бы.
  const shownCols = visible
    .map((key: string) => {
      const p = PERSON_COLUMNS.find(c => c.key === key)
      if (p) return { kind: 'person' as const, key, title: p.title }
      const q = questions.find(x => `q:${x.id}` === key)
      return q ? { kind: 'question' as const, key, title: q.title, q } : null
    })
    .filter(Boolean) as any[]

  return (
    <div>
      {/* ── Панель управления ─────────────────────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          {/* ⚠️ Отступ под лупу задаём INLINE: у класса `.input` свой
              `padding` из globals.css, и Tailwind-утилита `pl-9` его не
              перебивает — тот же слой. Из-за этого текст подсказки налезал
              на иконку. */}
          <input value={q} onChange={e => setQ(e.target.value)}
                 placeholder="Имя, почта, телефон, ник"
                 className="input" style={{ paddingLeft: '2.25rem' }} />
        </div>

        <div className="flex overflow-hidden rounded-lg border border-gray-200">
          {([['all', 'Все'], ['no', 'Не обработаны'], ['yes', 'Обработаны']] as const).map(([v, label]) => (
            <button key={v} onClick={() => setProcessed(v)}
                    className={`px-3 py-2 text-sm ${
                      processed === v ? 'text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                    style={processed === v ? { background: DARK } : undefined}>
              {label}
            </button>
          ))}
        </div>

        {sources.length > 0 && (
          <button onClick={() => setShowFilters(v => !v)}
                  className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
                  style={applied
                    ? { borderColor: DARK, color: DARK, background: `${DARK}0F` }
                    : { borderColor: '#e5e7eb', color: '#374151', background: '#fff' }}>
            <Filter size={15} /> Фильтры{applied ? ' · включены' : ''}
          </button>
        )}

        <button onClick={() => setShowCols(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
          <SlidersHorizontal size={15} /> Настройка отображения
        </button>
      </div>

      {showFilters && sources.length > 0 && (
        <div className="mb-3 rounded-xl border border-gray-200 bg-white p-4">
          <ConditionBuilder value={filters} sources={sources} onChange={setFilters} />
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => setApplied(JSON.stringify(filters))} className="btn-gold">
              Показать
            </button>
            <button onClick={() => { setFilters(emptyTree()); setApplied('') }}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
              Сбросить
            </button>
          </div>
        </div>
      )}

      <p className="mb-2 text-sm text-gray-500">
        Ответов: <b className="text-gray-800">{total}</b>
        {rows.length < total && ` · показаны первые ${rows.length}`}
      </p>

      {!rows.length ? (
        <p className="text-sm text-gray-400">
          {q || processed !== 'all'
            ? 'По этому отбору ничего не нашлось.'
            : 'Анкету пока никто не заполнил. Отправьте ссылку — ответы появятся здесь.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-gray-600">
                {shownCols.map(c => (
                  <Th key={c.key} title={c.title} active={sort === c.key} dir={dir}
                      staff={c.kind === 'question' && c.q.filled_by === 'staff'}
                      onClick={() => clickSort(c.key)} />
                ))}
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}
                    className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                    /* ⚠️ Обработанные подсвечены полупрозрачным фирменным
                       синим. Прозрачность 8% (`14`) читалась как обычный
                       серый — подняли до 22% (`38`), чтобы цвет был виден. */
                    style={r.processed ? { background: `${DARK}38` } : undefined}>
                  {shownCols.map((c: any) => {
                    if (c.kind === 'person') {
                      return (
                        <td key={c.key} className="px-3 py-2">
                          {c.key === 'created_at' ? (
                            <span className="whitespace-nowrap text-gray-500">{fmtDate(r.created_at)}</span>
                          ) : c.key === 'name' ? (
                            <button
                              onClick={() => router.push(`/dashboard/surveys/${surveyId}/responses/${r.id}`)}
                              className="font-medium hover:underline" style={{ color: DARK }}>
                              {r.name || 'Без имени'}
                            </button>
                          ) : (
                            <span className="text-gray-700">{r[c.key] || '—'}</span>
                          )}
                        </td>
                      )
                    }
                    const x = c.q
                    return (
                      <td key={c.key} className="px-3 py-2 align-top">
                        {x.filled_by === 'staff' ? (
                          <StaffCell surveyId={surveyId} responseId={r.id} question={x}
                                     value={answerOf(r, x.id)}
                                     onSaved={(val: string) => {
                                       setRows(list => list.map(row => row.id !== r.id ? row : {
                                         ...row,
                                         processed: x.is_protected ? val === 'Да' : row.processed,
                                         answers: [
                                           ...(row.answers || []).filter((a: any) => a.question_id !== x.id),
                                           ...(val ? [{ question_id: x.id, value: val }] : []),
                                         ],
                                       }))
                                     }} />
                        ) : (
                          <span className="block max-w-[280px] whitespace-pre-wrap break-words text-gray-700">
                            {answerOf(r, x.id) || '—'}
                          </span>
                        )}
                      </td>
                    )
                  })}

                  <td className="px-3 py-2 text-right">
                    <button onClick={e => removeResponse(e, r)} disabled={removing === r.id}
                            title="Удалить заполнение"
                            className="rounded-lg p-1.5 text-gray-300 hover:bg-red-50 hover:text-red-600 disabled:opacity-40">
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCols && (
        <ColumnsModal
          person={PERSON_COLUMNS} visitor={visitorQuestions} staff={staffQuestions}
          visible={visible} onToggle={toggleCol} onMove={moveCol} titleOf={titleOf}
          onClose={() => setShowCols(false)} />
      )}
    </div>
  )
}

/** Заголовок столбца — клик сортирует. */
function Th({ title, active, dir, onClick, staff }: any) {
  return (
    <th className="whitespace-nowrap px-3 py-2 font-medium">
      <button onClick={onClick} className="inline-flex items-center gap-1 hover:text-gray-900">
        {title}
        {staff && <span className="rounded bg-gray-200 px-1 text-[10px] text-gray-600">моё</span>}
        {active && (dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  )
}

/**
 * Ячейка поля сотрудника — правится прямо в таблице.
 *
 * ⚠️ Галочка сохраняется сразу по клику, текст — когда уходишь из поля:
 * сохранять текст на каждую букву значило бы слать запрос на каждое
 * нажатие клавиши.
 */
function StaffCell({ surveyId, responseId, question, value, onSaved }: any) {
  const [val, setVal] = useState(value || '')
  const [saving, setSaving] = useState(false)
  const [ok, setOk] = useState(false)
  const initial = useRef(value || '')

  useEffect(() => { setVal(value || ''); initial.current = value || '' }, [value])

  const save = async (raw: any) => {
    setSaving(true)
    try {
      await api.surveys.saveStaffAnswers(surveyId, responseId, { [question.id]: raw })
      const text = typeof raw === 'boolean' ? (raw ? 'Да' : '') : String(raw || '').trim()
      initial.current = text
      onSaved?.(text)
      setOk(true); setTimeout(() => setOk(false), 1200)
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
      setVal(initial.current)
    } finally { setSaving(false) }
  }

  if (question.kind === 'bool') {
    return (
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={val === 'Да'} disabled={saving}
               onChange={e => { setVal(e.target.checked ? 'Да' : ''); save(e.target.checked) }}
               className="h-4 w-4 rounded border-gray-300" />
        {saving && <Loader2 size={12} className="animate-spin text-gray-400" />}
        {ok && !saving && <Check size={12} className="text-green-600" />}
      </label>
    )
  }

  if (question.kind === 'textarea') {
    return (
      <div className="relative">
        <textarea value={val} rows={2} disabled={saving}
                  onChange={e => setVal(e.target.value)}
                  onBlur={() => { if (val !== initial.current) save(val) }}
                  placeholder="—"
                  className="w-full min-w-[180px] rounded-lg border border-gray-200 px-2 py-1 text-sm focus:border-[#25455D] focus:outline-none" />
        {ok && <Check size={12} className="absolute right-2 top-2 text-green-600" />}
      </div>
    )
  }

  if (question.kind === 'select' && Array.isArray(question.options)) {
    return (
      <select value={val} disabled={saving}
              onChange={e => { setVal(e.target.value); save(e.target.value) }}
              className="w-full min-w-[140px] rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm">
        <option value="">—</option>
        {question.options.map((o: string) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }

  return (
    <div className="relative">
      <input value={val} disabled={saving}
             onChange={e => setVal(e.target.value)}
             onBlur={() => { if (val !== initial.current) save(val) }}
             placeholder="—"
             className="w-full min-w-[140px] rounded-lg border border-gray-200 px-2 py-1 text-sm focus:border-[#25455D] focus:outline-none" />
      {ok && <Check size={12} className="absolute right-2 top-2 text-green-600" />}
    </div>
  )
}

/**
 * Настройка отображения: каждое поле включается по отдельности.
 * Группы — только заголовки для удобства, целиком они не переключаются
 * (требование владельца: «каждое поле можно добавить или убавить»).
 */
function ColumnsModal({ person, visitor, staff, visible, onToggle, onMove, onClose, titleOf }: any) {
  const Row = ({ k, title, hint }: any) => (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-50">
      <input type="checkbox" checked={visible.includes(k)} onChange={() => onToggle(k)}
             className="h-4 w-4 rounded border-gray-300" />
      <span className="text-sm text-gray-700">{title}</span>
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
    </label>
  )

  return (
    /* Модалка-форма: закрывается только крестиком, клик по фону не считается. */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5"
           onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Настройка отображения</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <p className="mb-4 text-sm text-gray-500">
          Отметьте, какие столбцы показывать в таблице, и расставьте их по
          порядку. Настройка сохраняется и видна вашим помощникам.
        </p>

        {/* Порядок столбцов — стрелками, а не перетаскиванием: стрелки
            работают на телефоне и не конфликтуют с прокруткой окна
            (тот же приём, что у тарифов события). */}
        {visible.length > 1 && (
          <div className="mb-4 rounded-xl bg-gray-50 p-3">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Порядок столбцов
            </h4>
            <div className="space-y-1">
              {visible.map((k: string, i: number) => (
                <div key={k} className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5">
                  <span className="w-5 text-xs text-gray-400">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                    {titleOf(k)}
                  </span>
                  <button onClick={() => onMove(i, -1)} disabled={i === 0}
                          title="Выше"
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30">
                    <ArrowUp size={14} />
                  </button>
                  <button onClick={() => onMove(i, 1)} disabled={i === visible.length - 1}
                          title="Ниже"
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30">
                    <ArrowDown size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mb-4">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Поля контакта
          </h4>
          {person.map((c: any) => <Row key={c.key} k={c.key} title={c.title} />)}
        </div>

        {staff.length > 0 && (
          <div className="mb-4">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Поля сотрудника
            </h4>
            {staff.map((x: any) => (
              <Row key={x.id} k={`q:${x.id}`} title={x.title} hint="правится в таблице" />
            ))}
          </div>
        )}

        {visitor.length > 0 && (
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Вопросы анкеты
            </h4>
            {visitor.map((x: any) => <Row key={x.id} k={`q:${x.id}`} title={x.title} />)}
          </div>
        )}

        {/* ⚠️ Кнопки «Готово» нет намеренно: галочки применяются сразу, и
            кнопка обманывала бы — будто без неё ничего не сохранится.
            Окно закрывается крестиком. */}
        <p className="mt-4 text-xs text-gray-400">
          Изменения применяются сразу и сохраняются.
        </p>
      </div>
    </div>
  )
}
