'use client'

/**
 * Дашборд аналитики — сетка квадратиков-разрезов.
 *
 * ОДИН компонент на два места (движок общий):
 *   • раздел «Аналитика»                → без eventId, считает по всей базе
 *   • карточка события → «Отслеживания» → с eventId, бэк сам добавляет
 *     условие «контакт — участник этого события»
 *
 * Квадратик = разрез (поле контакта ИЛИ вопрос анкеты) + условия-фильтры.
 * Пример: разрез «Рассматривает наставника» + условие «доход из вилок от
 * 200 тысяч» — видно, кто из платёжеспособных готов покупать.
 */
import { useCallback, useEffect, useState } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import Link from 'next/link'
import { api } from '@/lib/api'
import PeopleColumnBase from './PeopleColumnBase'
import ConditionBuilder, { SourceMeta, emptyTree } from './ConditionBuilder'

const DARK = '#25455D'
const PEACH = '#FFCFA4'

interface Card {
  id: number
  key: string
  source: 'field' | 'question'
  ref_id: number
  title: string
  kind?: string
  filters: any
  // Своё значение карточки: null = «как на дашборде».
  hide_absolute: boolean | null
  hide_percent: boolean | null
  primary_metric?: 'count' | 'percent' | null
  // Итоговое, с учётом общих настроек дашборда — по нему и рисуем.
  eff_hide_absolute?: boolean
  eff_hide_percent?: boolean
  eff_primary_metric?: 'count' | 'percent'
  view?: 'list' | 'tile'
  option_value?: string | null
  survey_title?: string | null
  scope?: number
  answered?: number
  count?: number          // вид 'tile' — цифра плитки
  percent?: number
  breakdown?: { option: string; count: number; percent: number }[]
  breakdown_hidden?: number
  avg?: number | null
  min?: number | null
  max?: number | null
  missing?: boolean
  error?: string
}

/** «человек / человека / человек» */
function plural(n: number): string {
  const a = Math.abs(n) % 100, b = a % 10
  if (a > 10 && a < 20) return 'человек'
  if (b > 1 && b < 5) return 'человека'
  if (b === 1) return 'человек'
  return 'человек'
}

/** Сколько условий в дереве — для подписи на карточке. */
function countConditions(node: any): number {
  if (!node || typeof node !== 'object') return 0
  if (Array.isArray(node.items)) {
    return node.items.reduce((s: number, it: any) => s + countConditions(it), 0)
  }
  return node.ref_id ? 1 : 0
}

/** Кто эти люди — список за цифрой, с выгрузкой в CSV. */
function PeopleModal({ dashId, cardId, option, title, onClose }: {
  dashId: number
  cardId: number
  option?: string | null
  title: string
  onClose: () => void
}) {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    api.analytics.cardPeople(dashId, cardId, option || undefined)
      .then(r => { if (alive) setData(r) })
      .catch(e => { if (alive) setErr(e?.message || 'Не удалось загрузить') })
    return () => { alive = false }
  }, [dashId, cardId, option])

  const download = async () => {
    const blob = await api.analytics.cardPeopleCsv(dashId, cardId, option || undefined)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'люди.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    // ⚠️ Оверлей без onClick — модалка закрывается только крестиком/кнопкой
    // (правило проекта: клик мимо окна не закрывает).
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div onClick={e => e.stopPropagation()}
           className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl bg-white p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-[#25455D]">{title}</div>
            {data && <div className="text-sm text-gray-500">{data.total} {plural(data.total)}</div>}
          </div>
          <button onClick={onClose} className="shrink-0 text-gray-400 hover:text-gray-700">✕</button>
        </div>

        {err && <div className="text-sm text-red-600">{err}</div>}
        {!data && !err && <div className="py-6 text-center text-gray-400">Загрузка…</div>}

        {data && (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-gray-100">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-50">
                  {data.people.map((p: any) => (
                    <tr key={p.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2">
                        {/* ⚠️ Открываем карточку по contact_id (`?contact=`),
                            а НЕ поиском по почте: поиск контактов ищет по
                            имени/телефону/нику, но не по email — почта живёт
                            в идентичностях, и такая ссылка вела в пустоту. */}
                        <Link href={`/dashboard/clients?contact=${p.id}`} target="_blank"
                              className="text-[#25455D] hover:underline">
                          {p.name || 'Без имени'}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-gray-500">{p.email || ''}</td>
                      <td className="px-3 py-2 text-gray-500">{p.phone || ''}</td>
                      <td className="px-3 py-2 text-gray-500">{p.telegram ? '@' + p.telegram : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.people.length < data.total && (
                <div className="px-3 py-2 text-xs text-gray-400">
                  Показаны первые {data.people.length}. Полный список — в выгрузке.
                </div>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={download} className="btn-gold px-3 py-1.5 text-sm">
                Скачать CSV
              </button>
              <button onClick={onClose}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600">
                Закрыть
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function CardTile({ card, sources, dashId, onChanged, readOnly, onHandle }: {
  card: Card
  sources: SourceMeta[]
  dashId: number
  onChanged: () => void
  readOnly: boolean
  onHandle: (on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [filters, setFilters] = useState<any>(card.filters || emptyTree())
  const [saving, setSaving] = useState(false)
  // Какой вариант смотрим списком людей: строка = вариант, '' = все ответившие.
  const [people, setPeople] = useState<string | null>(null)

  useEffect(() => { setFilters(card.filters || emptyTree()) }, [card.filters])

  const save = async (patch: any) => {
    setSaving(true)
    try {
      await api.analytics.updateCard(dashId, card.id, patch)
      onChanged()
    } finally { setSaving(false) }
  }

  const remove = async () => {
    if (!confirm(`Убрать квадратик «${card.title}»?`)) return
    await api.analytics.deleteCard(dashId, card.id)
    onChanged()
  }

  const condCount = countConditions(card.filters)
  const maxCount = Math.max(1, ...(card.breakdown || []).map(b => b.count))

  return (
    <div className="flex h-full flex-col rounded-2xl border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-start gap-2">
        {!readOnly && (
          <span
            onMouseEnter={() => onHandle(true)}
            onMouseLeave={() => onHandle(false)}
            className="cursor-grab select-none pt-0.5 text-gray-300"
            title="Перетащить"
          >⠿</span>
        )}
        <div className="min-w-0 flex-1">
          {/* У плитки в заголовке — сам вариант («200-300 т.р.»), а название
              вопроса уходит подписью: так плитка читается как в GetCourse. */}
          <div className="truncate font-semibold text-[#25455D]"
               title={card.option_value || card.title}>
            {card.view === 'tile' ? (card.option_value || card.title) : card.title}
          </div>
          <div className="mt-0.5 space-y-0.5 text-xs text-gray-400">
            {card.view === 'tile' && (
              <div className="truncate" title={card.title}>{card.title}</div>
            )}
            {/* Из какой анкеты вопрос — иначе четыре одинаковых
                «Готовы выступать спикером?» не различить. */}
            {card.survey_title && (
              <div className="truncate" title={card.survey_title}>{card.survey_title}</div>
            )}
            {condCount > 0 && (
              <div style={{ color: DARK }}>с условиями: {condCount}</div>
            )}
          </div>
        </div>
        {!readOnly && (
          <div className="flex shrink-0 gap-1">
            <button onClick={() => setOpen(o => !o)}
                    className="rounded px-1.5 text-gray-400 hover:text-[#25455D]"
                    title="Настроить">⚙</button>
            <button onClick={remove}
                    className="rounded px-1.5 text-gray-400 hover:text-red-500"
                    title="Убрать">✕</button>
          </div>
        )}
      </div>

      {card.missing && (
        <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-700">
          Разрез удалён — поле или анкета больше не существуют.
        </div>
      )}
      {card.error && (
        <div className="rounded-lg bg-red-50 p-2 text-xs text-red-600">{card.error}</div>
      )}

      {/* ── Плитка-цифра. Что крупно — абсолютное или процент — задаётся
             общей настройкой дашборда либо переопределяется у карточки. ── */}
      {!card.missing && !card.error && card.view === 'tile' && (() => {
        const hideAbs = card.eff_hide_absolute
        const hidePct = card.eff_hide_percent
        const bigIsPct = card.eff_primary_metric === 'percent'
        // Если то, что должно быть крупным, скрыто — крупным становится второе.
        const showPctBig = bigIsPct ? !hidePct : hideAbs && !hidePct
        const big = showPctBig ? `${card.percent ?? 0}%` : `${card.count ?? 0}`
        const smallPct = !showPctBig && !hidePct ? `${card.percent ?? 0}%` : ''
        const smallAbs = showPctBig && !hideAbs
          ? `${card.count ?? 0} ${plural(card.count ?? 0)}` : ''
        return (
          <button onClick={() => setPeople(card.option_value || null)}
                  className="group flex flex-1 flex-col items-center justify-center py-2 text-center">
            {/* ⚠️ Подчёркивание ПОСТОЯННОЕ, а не по наведению: по цифре можно
                кликнуть и посмотреть, кто эти люди, но об этом никто не
                догадывался — на телефоне наведения нет вовсе, а на компьютере
                надо сначала случайно навести. Цвет приглушённый, чтобы не
                спорить с крупным числом, но было видно сразу. */}
            <div className="text-4xl font-bold tabular-nums text-[#25455D] underline decoration-[#FFCFA4] decoration-2 underline-offset-4 group-hover:decoration-[#25455D]">
              {big}
            </div>
            <div className="mt-0.5 text-xs text-gray-500">
              {showPctBig
                ? smallAbs
                : `${plural(card.count ?? 0)}${smallPct ? ` · ${smallPct}` : ''}`}
            </div>
          </button>
        )
      })()}

      {!card.missing && !card.error && card.view !== 'tile' && (
        <>
          {/* ⚠️ Знаменатель процентов — ОТВЕТИВШИЕ, а не все прошедшие условия.
              Молчащий человек не «против», он неизвестен. Показываем обе
              цифры, чтобы была видна полнота разреза. */}
          <button onClick={() => setPeople('')}
                  className="mb-2 text-left text-xs text-gray-500 hover:text-[#25455D] hover:underline">
            ответили {card.answered ?? 0} из {card.scope ?? 0}
          </button>

          {typeof card.avg === 'number' && (
            <div className="mb-2 rounded-lg bg-gray-50 p-2 text-sm">
              среднее <b>{card.avg}</b>
              <span className="ml-2 text-xs text-gray-500">
                от {card.min} до {card.max}
              </span>
            </div>
          )}

          <div className="space-y-1.5">
            {(card.breakdown || []).length === 0 && (
              <div className="text-sm text-gray-400">Нет данных</div>
            )}
            {(card.breakdown || []).map(b => (
              // Клик по строке — «кто эти люди».
              <button key={b.option} onClick={() => setPeople(b.option)}
                      className="group block w-full text-left">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate group-hover:underline"
                        title={b.option}>{b.option}</span>
                  <span className="shrink-0 tabular-nums text-gray-600">
                    {/* Цифра подчёркнута всегда — она кликабельна (см. выше) */}
                    {!card.eff_hide_absolute && <b className="text-[#25455D] underline decoration-[#FFCFA4] decoration-2 underline-offset-2 group-hover:decoration-[#25455D]">{b.count}</b>}
                    {!card.eff_hide_absolute && !card.eff_hide_percent && ' · '}
                    {!card.eff_hide_percent && <span>{b.percent}%</span>}
                  </span>
                </div>
                <div className="mt-0.5 h-1.5 w-full rounded bg-gray-100">
                  <div className="h-1.5 rounded"
                       style={{ width: `${Math.round(b.count * 100 / maxCount)}%`, background: PEACH }} />
                </div>
              </button>
            ))}
            {card.breakdown_hidden && (
              <div className="text-xs text-gray-400">
                {card.breakdown_hidden} разных значений — показаны средние.
                Нажмите «ответили N», чтобы увидеть людей.
              </div>
            )}
          </div>
        </>
      )}

      {open && !readOnly && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="mb-2 text-xs font-semibold text-gray-600">
            Считать только тех, кто подходит под условия
          </div>
          <ConditionBuilder value={filters} sources={sources} onChange={setFilters} />

          {/* ⚠️ Настройки ЭТОГО квадратика перебивают общие. «как на
              дашборде» = null, чтобы карточка снова слушала общую настройку. */}
          <div className="mt-3 space-y-2 text-xs">
            <div className="text-gray-500">Только для этого квадратика:</div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-gray-500">числа:</span>
              {[['как на дашборде', null], ['показывать', false], ['скрыть', true]].map(([l, v]) => (
                <button key={String(l)} onClick={() => save({ hide_absolute: v })}
                        className={`rounded px-2 py-0.5 ${card.hide_absolute === v ? 'text-white' : 'bg-gray-100 text-gray-600'}`}
                        style={card.hide_absolute === v ? { background: DARK } : undefined}>
                  {l}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-gray-500">проценты:</span>
              {[['как на дашборде', null], ['показывать', false], ['скрыть', true]].map(([l, v]) => (
                <button key={String(l)} onClick={() => save({ hide_percent: v })}
                        className={`rounded px-2 py-0.5 ${card.hide_percent === v ? 'text-white' : 'bg-gray-100 text-gray-600'}`}
                        style={card.hide_percent === v ? { background: DARK } : undefined}>
                  {l}
                </button>
              ))}
            </div>
            {card.view === 'tile' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-gray-500">крупно:</span>
                {[['как на дашборде', null], ['число', 'count'], ['процент', 'percent']].map(([l, v]) => (
                  <button key={String(l)} onClick={() => save({ primary_metric: v })}
                          className={`rounded px-2 py-0.5 ${card.primary_metric === v ? 'text-white' : 'bg-gray-100 text-gray-600'}`}
                          style={card.primary_metric === v ? { background: DARK } : undefined}>
                    {l}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 flex gap-2">
            <button onClick={() => save({ filters })} disabled={saving}
                    className="btn-gold px-3 py-1.5 text-sm">
              {saving ? 'Сохраняю…' : 'Применить'}
            </button>
            <button onClick={() => { setFilters(emptyTree()); save({ filters: emptyTree() }) }}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600">
              Сбросить условия
            </button>
          </div>
        </div>
      )}

      {people !== null && (
        <PeopleModal
          dashId={dashId} cardId={card.id} option={people}
          title={people ? `${card.title} — ${people}` : card.title}
          onClose={() => setPeople(null)}
        />
      )}
    </div>
  )
}

/**
 * Выбор полей для дашборда.
 *
 * ⚠️ Раньше кнопка «Собрать автоматически» тащила ВСЕ разрезы разом — и
 * плодила по четыре одинаковых «Готовы выступать спикером?» (один вопрос
 * заведён в каждой анкете) плюс числовые с бесполезной россыпью. Владелец:
 * «мне не нужны лишние поля — нужно то, что нужно мне».
 * Поэтому: сначала ОТКУДА (поля контакта / конкретная анкета), потом
 * галочки ровно на нужных вопросах.
 */
/**
 * Колонка дашборда в режиме «колонками»: в шапке цифра, внутри люди.
 * Список подгружается при первом раскрытии — грузить всех сразу при
 * десятке колонок значило бы десяток запросов на открытие страницы.
 */
function PeopleColumn({ card, dashId, surveyId, onChanged, readOnly,
                       onMove, canMoveLeft, canMoveRight }: {
  card: Card; dashId: number; surveyId?: number
  onChanged: () => void; readOnly?: boolean
  onMove?: (delta: -1 | 1) => void
  canMoveLeft?: boolean; canMoveRight?: boolean
}) {
  const [people, setPeople] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  // ⚠️ Переименование и удаление были только у плиток — в режиме колонок
  // клиент не мог убрать лишнюю колонку и переписать заголовок.
  const rename = async () => {
    const next = prompt('Название колонки', card.title || '')
    if (next === null) return
    await api.analytics.updateCard(dashId, card.id, { title: next.trim() })
    onChanged()
  }

  const remove = async () => {
    if (!confirm(`Убрать колонку «${card.title}»?`)) return
    await api.analytics.deleteCard(dashId, card.id)
    onChanged()
  }

  const load = async () => {
    if (loaded) return
    setLoading(true)
    try {
      const r = await api.analytics.cardPeople(dashId, card.id, card.option_value || undefined)
      setPeople(r.people || [])
      setLoaded(true)
    } catch { setPeople([]) }
    finally { setLoading(false) }
  }

  // ⚠️ Заголовок колонки: СНАЧАЛА собственное название («Консультация
  // проведена — Да»), и только если его нет — вариант ответа. Было
  // наоборот, и колонка подписывалась голым «Да»: при нескольких полях
  // такие колонки неразличимы, а переименование не показывалось.
  const title = card.title || card.option_value || 'Разрез'

  return (
    <PeopleColumnBase
      title={title}
      count={card.count ?? card.answered ?? 0}
      percent={card.eff_hide_percent ? null : card.percent}
      hint={card.survey_title || undefined}
      people={people} loading={loading} onExpand={load}
      onRename={readOnly ? undefined : rename}
      onRemove={readOnly ? undefined : remove}
      onMove={readOnly ? undefined : onMove}
      canMoveLeft={canMoveLeft} canMoveRight={canMoveRight}
      // ⚠️ В дашборде АНКЕТЫ клик ведёт на заполненную анкету человека:
      // сюда приходят разбирать ответы, и карточка контакта — лишний крюк.
      // Ответа может не быть (человек прошёл по условию поля контакта) —
      // тогда открываем карточку, как везде.
      hrefFor={surveyId
        ? (p: any) => p.response_id
            ? `/dashboard/surveys/${surveyId}/responses/${p.response_id}`
            : `/dashboard/clients?contact=${p.id}`
        : undefined}
    />
  )
}


function PickFieldsModal({ sources, used, onClose, onAdd }: {
  sources: SourceMeta[]
  used: Set<string>
  onClose: () => void
  onAdd: (keys: string[], view: 'tile' | 'list',
          options?: Record<string, string[]>) => Promise<void>
}) {
  const groups = Array.from(new Set(sources.map(s => s.group)))
  const [group, setGroup] = useState(groups[0] || '')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [view, setView] = useUrlTab<'tile' | 'list'>('view', 'tile', ['tile', 'list'])
  const [busy, setBusy] = useState(false)

  // Показываем только то, что имеет смысл рисовать: списки, да/нет, числа.
  const items = sources.filter(s => s.group === group && s.auto && !used.has(s.key))

  // Какие ИМЕННО ответы превращать в колонки: { 'question:24': ['Да'] }.
  // Отметил один — будет одна колонка, отметил все — по колонке на каждый.
  const [opts, setOpts] = useState<Record<string, string[]>>({})

  /** Варианты ответа поля. У «да/нет» их в options нет — подставляем сами. */
  const optionsOf = (s: SourceMeta): string[] =>
    (s.options?.length ? s.options : (s.kind === 'bool' ? ['Да', 'Нет'] : []))

  const toggle = (k: string) => {
    const next = new Set(picked)
    if (next.has(k)) { next.delete(k) } else {
      next.add(k)
      // При выборе поля отмечаем все его ответы — обычно нужны все, а
      // лишние снять проще, чем отмечать каждый.
      const s = items.find(x => x.key === k)
      if (s && !opts[k]) setOpts(o => ({ ...o, [k]: optionsOf(s) }))
    }
    setPicked(next)
  }

  const toggleOpt = (k: string, opt: string) => {
    setOpts(o => {
      const cur = o[k] || []
      return { ...o, [k]: cur.includes(opt) ? cur.filter(x => x !== opt) : [...cur, opt] }
    })
  }

  const submit = async () => {
    if (!picked.size) return
    setBusy(true)
    try {
      const chosen: Record<string, string[]> = {}
      picked.forEach(k => { if (opts[k]?.length) chosen[k] = opts[k] })
      await onAdd([...picked], view, chosen)
      onClose()
    }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div onClick={e => e.stopPropagation()}
           className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white p-5">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <div className="font-semibold text-[#25455D]">Какие поля показать</div>
            <div className="text-xs text-gray-500">
              Отметьте только то, что хотите видеть на дашборде.
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
        </div>

        {/* Откуда берём: поля контакта или конкретная анкета. */}
        <div className="mb-3">
          <label className="mb-1 block text-xs text-gray-500">Откуда</label>
          <select value={group} onChange={e => { setGroup(e.target.value); setPicked(new Set()) }}
                  className="w-full rounded-lg border border-gray-300 px-2 py-2 text-sm">
            {groups.map(g => {
              const n = sources.filter(s => s.group === g && s.auto && !used.has(s.key)).length
              return <option key={g} value={g}>{g} ({n})</option>
            })}
          </select>
        </div>

        <div className="mb-3 flex items-center gap-2 text-xs">
          <span className="text-gray-500">Вид:</span>
          <button onClick={() => setView('tile')}
                  className={`rounded px-2 py-1 ${view === 'tile' ? 'text-white' : 'bg-gray-100 text-gray-600'}`}
                  style={view === 'tile' ? { background: DARK } : undefined}>
            квадратики с цифрами
          </button>
          <button onClick={() => setView('list')}
                  className={`rounded px-2 py-1 ${view === 'list' ? 'text-white' : 'bg-gray-100 text-gray-600'}`}
                  style={view === 'list' ? { background: DARK } : undefined}>
            одна карточка со списком
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-xl border border-gray-100 p-2">
          {!items.length && (
            <div className="p-4 text-center text-sm text-gray-400">
              Здесь всё уже добавлено.
            </div>
          )}
          {items.map(s => {
            const on = picked.has(s.key)
            const vals = optionsOf(s)
            return (
              <div key={s.key} className="rounded-lg p-2 hover:bg-gray-50">
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5"
                         checked={on} onChange={() => toggle(s.key)} />
                  <span className="min-w-0 flex-1">
                    <span className="block">{s.title}</span>
                    <span className="text-xs text-gray-400">
                      {s.kind === 'bool' ? 'да / нет'
                        : vals.length ? `${vals.length} вариантов`
                        : 'число'}
                    </span>
                  </span>
                </label>

                {/* ⚠️ Под каким ответом создавать колонку — выбирает клиент.
                    Раньше на каждое поле создавалась пара «Да»/«Нет», и ряд
                    забивался колонками, которые тут же удаляли: в CRM нужна
                    одна колонка на стадию («консультация проведена»). */}
                {on && vals.length > 0 && view === 'tile' && (
                  <div className="ml-6 mt-1 rounded-lg bg-gray-50 p-2">
                    <div className="mb-1 text-xs text-gray-500">
                      По каким ответам сделать колонки:
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {vals.map(v => (
                        <label key={v} className="flex cursor-pointer items-center gap-1.5 text-sm">
                          <input type="checkbox"
                                 checked={(opts[s.key] || []).includes(v)}
                                 onChange={() => toggleOpt(s.key, v)} />
                          <span>{v}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button onClick={submit} disabled={!picked.size || busy}
                  className="btn-gold px-4 py-2 text-sm disabled:opacity-50">
            {busy ? 'Добавляю…' : `Добавить (${picked.size})`}
          </button>
          <button onClick={() => setPicked(new Set(items.map(s => s.key)))}
                  className="text-xs text-gray-500 hover:text-[#25455D]">
            отметить все
          </button>
          <button onClick={onClose}
                  className="ml-auto rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600">
            Отмена
          </button>
        </div>
      </div>
    </div>
  )
}

export default function DashboardView({ eventId, surveyId, readOnly = false }: {
  eventId?: number
  /** Дашборды конкретной анкеты. Тот же движок — просто другая привязка. */
  surveyId?: number
  readOnly?: boolean
}) {
  const [dashboards, setDashboards] = useState<any[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [cards, setCards] = useState<Card[]>([])
  const [sources, setSources] = useState<SourceMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [picking, setPicking] = useState(false)
  const [dash, setDash] = useState<any>(null)
  const [totals, setTotals] = useState<any>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  // Карточка, на ручке которой сейчас мышь — только её можно тащить.
  const [handleId, setHandleId] = useState<number | null>(null)

  const loadList = useCallback(async () => {
    const [d, s] = await Promise.all([
      api.analytics.dashboards(eventId, surveyId),
      // В дашборде анкеты предлагаем разрезы ТОЛЬКО этой анкеты: у клиента
      // под сотню вопросов, и одинаковые вопросы разных анкет не различить.
      api.analytics.sources(surveyId),
    ])
    setDashboards(d.dashboards || [])
    setSources(s.sources || [])
    return d.dashboards || []
  }, [eventId, surveyId])

  const loadCards = useCallback(async (id: number) => {
    const r = await api.analytics.dashboard(id)
    setCards(r.cards || [])
    setDash(r.dashboard || null)
    setTotals(r.totals || null)
  }, [])

  // Общие настройки показа — сохраняем и сразу перечитываем цифры.
  const saveDash = async (patch: any) => {
    if (!activeId) return
    setDash((d: any) => ({ ...(d || {}), ...patch }))   // отзывчиво, без ожидания
    await api.analytics.updateDashboard(activeId, patch)
    await loadCards(activeId)
  }

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true); setErr('')
      try {
        const list = await loadList()
        if (!alive) return
        if (list.length) {
          setActiveId(list[0].id)
          await loadCards(list[0].id)
        }
      } catch (e: any) {
        if (alive) setErr(e?.message || 'Не удалось загрузить')
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [loadList, loadCards])

  const switchTo = async (id: number) => {
    setActiveId(id); setCards([])
    try { await loadCards(id) } catch (e: any) { setErr(e?.message || '') }
  }

  const createDashboard = async () => {
    const title = prompt('Название дашборда', 'Новый дашборд')
    if (title === null) return
    setBusy(true)
    try {
      const d = await api.analytics.createDashboard({
        title, event_id: eventId, survey_id: surveyId,
      })
      await loadList()
      setActiveId(d.id)
      await loadCards(d.id)
    } catch (e: any) { alert(e?.message || 'Не получилось') }
    finally { setBusy(false) }
  }

  const renameDashboard = async () => {
    if (!activeId) return
    const cur = dashboards.find(d => d.id === activeId)
    const title = prompt('Название дашборда', cur?.title || '')
    if (!title) return
    await api.analytics.renameDashboard(activeId, title)
    await loadList()
  }

  const removeDashboard = async () => {
    if (!activeId) return
    const cur = dashboards.find(d => d.id === activeId)
    if (!confirm(`Удалить дашборд «${cur?.title}» вместе с квадратиками?`)) return
    await api.analytics.deleteDashboard(activeId)
    const list = await loadList()
    if (list.length) { setActiveId(list[0].id); await loadCards(list[0].id) }
    else { setActiveId(null); setCards([]) }
  }

  const addPicked = async (keys: string[], view: 'tile' | 'list',
                          options?: Record<string, string[]>) => {
    if (!activeId) return
    await api.analytics.autofill(activeId, keys, view, options)
    await loadCards(activeId)
  }

  /** Подвинуть колонку стрелкой. В режиме колонок перетаскивания нет:
   *  ряд прокручивается вбок, и перетаскивание конфликтовало бы с
   *  прокруткой — особенно на телефоне. */
  const moveCard = async (i: number, delta: -1 | 1) => {
    if (!activeId) return
    const j = i + delta
    if (j < 0 || j >= cards.length) return
    const next = [...cards]
    const [moved] = next.splice(i, 1)
    next.splice(j, 0, moved)
    setCards(next)
    try {
      await api.analytics.reorderCards(activeId, next.map(c => c.id))
    } catch {
      await loadCards(activeId)
    }
  }

  const drop = async (targetId: number) => {
    if (dragId == null || dragId === targetId || !activeId) { setDragId(null); return }
    const from = cards.findIndex(c => c.id === dragId)
    const to = cards.findIndex(c => c.id === targetId)
    if (from < 0 || to < 0) { setDragId(null); return }
    const next = [...cards]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setCards(next)
    setDragId(null)
    try {
      await api.analytics.reorderCards(activeId, next.map(c => c.id))
    } catch {
      await loadCards(activeId)   // не сохранилось — вернём порядок с сервера
    }
  }

  if (loading) return <div className="p-6 text-gray-500">Загрузка…</div>
  if (err) return <div className="p-6 text-red-600">{err}</div>

  // Что уже на дашборде — чтобы не предлагать повторно.
  const used = new Set(cards.map(c => c.key))

  return (
    <div className="space-y-4">
      {/* ── Переключатель дашбордов ── */}
      <div className="flex flex-wrap items-center gap-2">
        {dashboards.map(d => (
          <button key={d.id} onClick={() => switchTo(d.id)}
                  className={`rounded-full px-3 py-1.5 text-sm ${
                    d.id === activeId ? 'text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                  style={d.id === activeId ? { background: DARK } : undefined}>
            {d.title}
          </button>
        ))}
        {!readOnly && (
          <button onClick={createDashboard} disabled={busy}
                  className="rounded-full border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-500 hover:border-[#25455D] hover:text-[#25455D]">
            + дашборд
          </button>
        )}
      </div>

      {!dashboards.length && (
        <div className="rounded-2xl border border-dashed border-gray-300 p-8 text-center">
          <div className="mb-2 font-semibold text-[#25455D]">Дашбордов пока нет</div>
          <div className="mb-4 text-sm text-gray-500">
            Создайте дашборд и соберите квадратики — по полям контакта и вопросам анкет.
          </div>
          {!readOnly && (
            <button onClick={createDashboard} className="btn-gold px-4 py-2">
              Создать дашборд
            </button>
          )}
        </div>
      )}

      {activeId && (
        <>
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 pb-3">
              <button onClick={() => setPicking(true)} className="btn-gold px-3 py-1.5 text-sm">
                + Выбрать поля
              </button>

              {/* ⚠️ ОБЩИЕ настройки показа — на все квадратики сразу.
                  Выставлять их по одной в шестерёнке каждой из двух десятков
                  плиток невозможно; у карточки настройка остаётся и
                  перебивает общую. */}
              {!!cards.length && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl bg-gray-50 px-3 py-1.5 text-xs">
                  {/* Вид показа: плитками (как было) или колонками со
                      списком людей внутри. */}
                  <span className="text-gray-500">вид:</span>
                  <button onClick={() => saveDash({ layout: 'cards' })}
                          className={`rounded px-2 py-0.5 ${dash?.layout !== 'columns' ? 'text-white' : 'bg-gray-200 text-gray-600'}`}
                          style={dash?.layout !== 'columns' ? { background: DARK } : undefined}>
                    плитками
                  </button>
                  <button onClick={() => saveDash({ layout: 'columns' })}
                          className={`rounded px-2 py-0.5 ${dash?.layout === 'columns' ? 'text-white' : 'bg-gray-200 text-gray-600'}`}
                          style={dash?.layout === 'columns' ? { background: DARK } : undefined}>
                    колонками
                  </button>
                  <span className="text-gray-400">|</span>
                  {/* ⚠️ В режиме колонок цифра стоит в шапке ВСЕГДА, и
                      «числа» с «крупно» ни на что не влияют — показываем
                      только «проценты», которые действительно убираются. */}
                  {dash?.layout !== 'columns' && (
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={!dash?.hide_absolute}
                             onChange={e => saveDash({ hide_absolute: !e.target.checked })} />
                      числа
                    </label>
                  )}
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={!dash?.hide_percent}
                           onChange={e => saveDash({ hide_percent: !e.target.checked })} />
                    проценты
                  </label>
                  {dash?.layout !== 'columns' && <>
                  <span className="text-gray-400">|</span>
                  <span className="text-gray-500">крупно:</span>
                  <button onClick={() => saveDash({ primary_metric: 'count' })}
                          className={`rounded px-2 py-0.5 ${dash?.primary_metric !== 'percent' ? 'text-white' : 'bg-gray-200 text-gray-600'}`}
                          style={dash?.primary_metric !== 'percent' ? { background: DARK } : undefined}>
                    число
                  </button>
                  <button onClick={() => saveDash({ primary_metric: 'percent' })}
                          className={`rounded px-2 py-0.5 ${dash?.primary_metric === 'percent' ? 'text-white' : 'bg-gray-200 text-gray-600'}`}
                          style={dash?.primary_metric === 'percent' ? { background: DARK } : undefined}>
                    процент
                  </button>
                  </>}
                </div>
              )}

              <div className="ml-auto flex gap-2 text-sm">
                <button onClick={renameDashboard} className="text-gray-500 hover:text-[#25455D]">
                  Переименовать
                </button>
                <button onClick={removeDashboard} className="text-gray-400 hover:text-red-500">
                  Удалить
                </button>
              </div>
            </div>
          )}

          {/* ⚠️ От чего считается процент. Без этой строки «49.4%» на плитке
              висит в воздухе: непонятно, доля от базы это или от ответивших.
              Знаменатель — именно «ответили». */}
          {!!cards.length && totals && (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <span className="text-gray-500">
                {eventId ? 'Участников события:' : 'Всего в базе:'}{' '}
                <b className="text-[#25455D]">{totals.base_total}</b>
              </span>
              {totals.scope !== totals.base_total && (
                <span className="text-gray-500">
                  после условий: <b className="text-[#25455D]">{totals.scope}</b>
                </span>
              )}
              <span className="text-gray-500">
                ответили: <b className="text-[#25455D]">{totals.answered}</b>
                <span className="ml-1 text-xs text-gray-400">— от них и считаются проценты</span>
              </span>
            </div>
          )}

          {/* ⚠️ Подсказка про клик. По цифрам можно кликнуть и увидеть список
              людей, но сами по себе они выглядят как обычный текст — клиент об
              этой возможности не знал. Фон персиковый ПОЛУПРОЗРАЧНЫЙ, а текст
              тёмный: персиковым по белому надпись почти не читается. */}
          {!!cards.length && (
            <div className="rounded-xl px-3 py-2 text-sm text-[#25455D]"
                 style={{ background: `${PEACH}59` }}>
              {/* У колонок люди уже на виду — подсказка про цифры там
                  бессмысленна, нужна своя. */}
              {dash?.layout === 'columns'
                ? (surveyId
                    ? 'Нажмите на имя человека — откроются его ответы на анкету'
                    : 'Нажмите на имя человека — откроется его карточка')
                : 'Нажмите на цифры в карточках для просмотра контактов'}
            </div>
          )}

          {!cards.length ? (
            <div className="rounded-2xl border border-dashed border-gray-300 p-8 text-center">
              <div className="mb-3 text-sm text-gray-500">
                Пусто. Выберите поля, которые хотите видеть.
              </div>
              {!readOnly && (
                <button onClick={() => setPicking(true)} className="btn-gold px-4 py-2">
                  + Выбрать поля
                </button>
              )}
            </div>
          ) : dash?.layout === 'columns' ? (
            /* Вид колонками: в шапке цифра, внутри список людей. */
            <div className="flex gap-3 overflow-x-auto pb-3 scroll-visible">
              {cards.map((c, i) => (
                <PeopleColumn key={c.id} card={c} dashId={activeId} surveyId={surveyId}
                              onChanged={() => loadCards(activeId)} readOnly={readOnly}
                              onMove={(d: -1 | 1) => moveCard(i, d)}
                              canMoveLeft={i > 0} canMoveRight={i < cards.length - 1} />
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {cards.map(c => (
                <div key={c.id}
                     // ⚠️ draggable включается ТОЛЬКО когда мышь на ручке ⠿ —
                     // иначе браузер тащит карточку при выделении текста и
                     // при работе с полями конструктора условий.
                     draggable={!readOnly && handleId === c.id}
                     onDragStart={() => setDragId(c.id)}
                     onDragEnd={() => { setDragId(null); setHandleId(null) }}
                     onDragOver={e => e.preventDefault()}
                     onDrop={() => drop(c.id)}
                     className={dragId === c.id ? 'opacity-40' : ''}>
                  <CardTile card={c} sources={sources} dashId={activeId}
                            onChanged={() => loadCards(activeId)} readOnly={readOnly}
                            onHandle={on => setHandleId(on ? c.id : null)} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {picking && activeId && (
        <PickFieldsModal sources={sources} used={used}
                         onClose={() => setPicking(false)} onAdd={addPicked} />
      )}
    </div>
  )
}
