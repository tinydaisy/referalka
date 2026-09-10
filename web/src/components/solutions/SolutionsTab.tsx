'use client'

/**
 * Готовые решения — витрина сценариев с установкой в один клик.
 *
 * ⚠️ Данные берутся ТОЛЬКО из `catalog.ts`. Своего списка здесь нет: вторая
 * копия разъехалась бы со страницами описаний и с установкой.
 *
 * ⚠️⚠️ ПО УМОЛЧАНИЮ — ТАБЛИЦА СО СВЁРНУТЫМИ СТРОКАМИ. Развёрнутые карточки
 * занимали по экрану каждая: шестнадцать решений превращались в бесконечную
 * простыню, где не видно ни одного целиком и не сравнить соседние. Задача
 * витрины — показать, что решений МНОГО и они разные; для этого нужен обзор, а
 * не подробности. Подробности — по стрелке и на странице решения.
 *
 * ⚠️ Раскрытая строка обводится ФИРМЕННЫМ СИНИМ, а не оттенком серого: на белом
 * фоне серая рамка не читается, и непонятно, где кончается раскрытый блок.
 */
import Link from 'next/link'
import { useMemo, useState } from 'react'
import {
  ExternalLink, Lock, Check, ArrowRight,
  LayoutGrid, List as ListIcon,
} from 'lucide-react'
import { useMe } from '@/hooks/useMe'
import {
  SOLUTIONS, CATEGORIES, FEATURE_TITLE, missingFeatures, byNum, requiredTariff,
  type Solution, type SolutionFeature,
} from './catalog'

const DARK = '#25455D'

export default function SolutionsTab() {
  const { me } = useMe()
  const features: string[] = useMemo(() => me?.features || [], [me])
  // ⚠️ Вид запоминается в браузере: человек выбрал таблицу — не хочет каждый
  // раз переключать заново.
  const [view, setView] = useState<'table' | 'cards'>(() => {
    if (typeof window === 'undefined') return 'table'
    try {
      return (localStorage.getItem('solutions_view') as any) || 'table'
    } catch { return 'table' }
  })
  const switchView = (v: 'table' | 'cards') => {
    setView(v)
    try { localStorage.setItem('solutions_view', v) } catch {}
  }

  const inCategory = (key: string) => {
    const list = SOLUTIONS.filter(s => s.category === key)
    return [...list].sort((a, b) => {
      const am = missingFeatures(a, features).length ? 1 : 0
      const bm = missingFeatures(b, features).length ? 1 : 0
      return am - bm || a.num - b.num
    })
  }

  const total = SOLUTIONS.length
  const availableCount = SOLUTIONS.filter(s => !missingFeatures(s, features).length).length

  return (
    <div>
      {/* Шапка: сразу видно масштаб — сколько всего решений. */}
      <div className="mb-4 rounded-xl border p-4" style={{ borderColor: '#B9CEDD', background: '#F1F6FA' }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold" style={{ color: DARK }}>
              {total} готовых решений — бесплатно
            </h3>
            <p className="mt-1 text-sm text-gray-700">
              Собранные сценарии: воронка, анкета, событие или продукт уже настроены
              и связаны между собой. Нажимаете «Установить мне» — всё создаётся в
              вашем кабинете за пару секунд.
            </p>
            <p className="mt-1.5 text-sm text-gray-600">
              Всё внутри — ваше: тексты, фотографии, вопросы анкет, цены и
              оформление меняются как угодно. Решение — заготовка, а не рамка.
            </p>
            <p className="mt-1.5 text-xs text-gray-500">
              На вашем тарифе доступно {availableCount} из {total}.
            </p>
          </div>

          {/* Переключатель вида. */}
          <div className="flex shrink-0 gap-1 rounded-lg bg-white p-1">
            <button onClick={() => switchView('table')}
                    className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium ${
                      view === 'table' ? 'text-white' : 'text-gray-600 hover:bg-gray-100'}`}
                    style={view === 'table' ? { background: DARK } : undefined}>
              <ListIcon size={13} /> Таблицей
            </button>
            <button onClick={() => switchView('cards')}
                    className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium ${
                      view === 'cards' ? 'text-white' : 'text-gray-600 hover:bg-gray-100'}`}
                    style={view === 'cards' ? { background: DARK } : undefined}>
              <LayoutGrid size={13} /> Карточками
            </button>
          </div>
        </div>
      </div>

      {CATEGORIES.map(cat => {
        const list = inCategory(cat.key)
        if (!list.length) return null
        return (
          <div key={cat.key} className="mb-6">
            <div className="mb-2 flex items-baseline gap-2">
              <h4 className="text-sm font-bold uppercase tracking-wide" style={{ color: DARK }}>
                {cat.title}
              </h4>
              <span className="text-xs text-gray-400">{list.length}</span>
            </div>
            <p className="mb-2 text-xs text-gray-500">{cat.hint}</p>

            {view === 'table' ? (
              /* ⚠️⚠️ ЭТО НАСТОЯЩАЯ ТАБЛИЦА, а не список со свёрнутыми строками.
                 Колонки заданы владельцем поимённо, и все они обязаны быть
                 ВИДНЫ СРАЗУ: смысл таблицы — сравнивать решения между собой по
                 одним и тем же признакам. Спрятать половину под стрелку значит
                 вернуть тот же список, ради ухода от которого таблица и
                 делалась.
                 ⚠️ Таблица широкая — прокрутка внутри своего контейнера, страница
                 вбок не едет. */
              <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                <table className="w-full min-w-[1180px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50 text-left align-bottom">
                      {[
                        ['#', 'w-10'],
                        ['Решение', 'w-[190px]'],
                        ['Что это', 'w-[230px]'],
                        ['Преимущества', 'w-[250px]'],
                        ['Инструменты', 'w-[150px]'],
                        ['Что настроить у себя', 'w-[220px]'],
                        ['Тариф', 'w-[120px]'],
                        ['', 'w-[200px]'],
                      ].map(([t, w], i) => (
                        <th key={i}
                            className={`${w} px-3 py-2 text-xs font-semibold ${
                              i === 0 ? 'text-center' : ''}`}
                            style={{ color: DARK }}>
                          {t}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {list.map(s => (
                      <SolutionRow key={s.slug} sol={s} features={features} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="space-y-3">
                {list.map(s => <Card key={s.slug} sol={s} features={features} />)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Метка тарифа — общая для обоих видов.
 *
 * ⚠️ Тариф НАЗЫВАЕТСЯ по факту нехватки, а не «Экстра» всем подряд: решению
 * с продуктами Экстра не поможет, там нужен Бизнес. */
function TariffBadge({ missing, compact }: { missing: SolutionFeature[]; compact?: boolean }) {
  if (!missing.length) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
        <Check size={12} /> {compact ? 'Доступно' : 'Доступно на вашем тарифе'}
      </span>
    )
  }
  const t = requiredTariff(missing)
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
      <Lock size={12} /> {t ? `Нужен ${t.title}` : 'Недоступно'}
    </span>
  )
}

/** Кнопки действий — общие для обоих видов. */
function Actions({ sol, available, missing }: {
  sol: Solution; available: boolean; missing: SolutionFeature[]
}) {
  const need = requiredTariff(missing)
  return (
    <div className="flex flex-wrap gap-1.5">
      <Link href={`/dashboard/solutions/${sol.slug}`}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50">
        Описание <ArrowRight size={12} />
      </Link>
      {/* ⚠️ «Посмотреть пример» — только когда пример реально собран: кнопка,
          ведущая в никуда, хуже её отсутствия. */}
      {sol.demo && (
        <a href={sol.demo} target="_blank" rel="noreferrer"
           className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium hover:bg-gray-50"
           style={{ borderColor: DARK, color: DARK }}>
          Пощупать живой пример <ExternalLink size={12} />
        </a>
      )}
      {available ? (
        <Link href={`/dashboard/solutions/${sol.slug}#install`}
              className="btn-gold inline-flex items-center gap-1 px-2.5 py-1 text-xs">
          Установить мне
        </Link>
      ) : (
        <Link href="/dashboard/subscription"
              className="inline-flex items-center rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100">
          {need ? `Повысить до ${need.title}` : 'Посмотреть тарифы'}
        </Link>
      )}
    </div>
  )
}

/**
 * Строка таблицы — все колонки, заданные владельцем, видны сразу.
 *
 * ⚠️ Ничего не сворачивается. Таблицу читают глазами по столбцам, сравнивая
 * решения между собой; спрятанная под стрелку колонка из сравнения выпадает.
 * Подробности, которые в ячейку не помещаются, живут на странице решения.
 */
function SolutionRow({ sol, features }: { sol: Solution; features: string[] }) {
  const missing = missingFeatures(sol, features)
  const available = !missing.length
  const need = requiredTariff(missing)

  return (
    <tr className="border-b border-gray-100 align-top last:border-b-0 hover:bg-gray-50/60">
      {/* № */}
      <td className="px-3 py-3 text-center text-xs font-semibold text-gray-400">
        {sol.num}
      </td>

      {/* Название — ссылка на подробное описание (открывается страницей) */}
      <td className="px-3 py-3">
        <Link href={`/dashboard/solutions/${sol.slug}`}
              className="text-sm font-semibold hover:underline" style={{ color: DARK }}>
          {sol.title}
        </Link>
        {/* ⚠️ «Тот же результат по-другому» — прямо в таблице: владелец просил
            ссылаться на соседние решения там, где человек выбирает. */}
        {!!sol.seeAlso?.length && (
          <div className="mt-1 text-[11px] text-gray-500">
            Иначе:{' '}
            {sol.seeAlso.map((n, i) => {
              const other = byNum(n)
              if (!other) return null
              return (
                <span key={n}>
                  {i > 0 && ', '}
                  <Link href={`/dashboard/solutions/${other.slug}`}
                        className="underline hover:text-gray-700">
                    №{other.num}
                  </Link>
                </span>
              )
            })}
          </div>
        )}
      </td>

      {/* Краткое описание */}
      <td className="px-3 py-3 text-[13px] leading-snug text-gray-700">
        {sol.short}
      </td>

      {/* Преимущества */}
      <td className="px-3 py-3">
        <ul className="space-y-1">
          {sol.advantages.map((a, i) => (
            <li key={i} className="flex gap-1.5 text-[12px] leading-snug text-gray-700">
              <Check size={12} className="mt-0.5 shrink-0" style={{ color: DARK }} />
              <span>{a}</span>
            </li>
          ))}
        </ul>
      </td>

      {/* Инструменты ПЛЮСОНа */}
      <td className="px-3 py-3">
        <div className="flex flex-wrap gap-1">
          {sol.tools.map(t => (
            <span key={t} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
              {t}
            </span>
          ))}
        </div>
      </td>

      {/* Что настроить у себя — отдельная колонка (не то же, что тариф) */}
      <td className="px-3 py-3">
        <ul className="space-y-1">
          {sol.setup.map((x, i) => (
            <li key={i} className="text-[12px] leading-snug text-gray-700">— {x}</li>
          ))}
        </ul>
      </td>

      {/* Тариф */}
      <td className="px-3 py-3">
        <TariffBadge missing={missing} compact />
        {!available && !!missing.length && (
          <div className="mt-1 text-[11px] text-gray-500">
            не хватает: {missing.map(f => FEATURE_TITLE[f]).join(', ')}
          </div>
        )}
      </td>

      {/* Действия */}
      <td className="px-3 py-3">
        <div className="flex flex-col gap-1.5">
          <Link href={`/dashboard/solutions/${sol.slug}`}
                className="inline-flex items-center justify-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50">
            Описание <ArrowRight size={12} />
          </Link>
          {/* ⚠️ Только когда пример реально собран: кнопка в никуда хуже, чем
              её отсутствие. */}
          {sol.demo && (
            <a href={sol.demo} target="_blank" rel="noreferrer"
               className="inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium hover:bg-gray-50"
               style={{ borderColor: DARK, color: DARK }}>
              Пощупать пример <ExternalLink size={12} />
            </a>
          )}
          {available ? (
            <Link href={`/dashboard/solutions/${sol.slug}#install`}
                  className="btn-gold inline-flex items-center justify-center px-2 py-1 text-xs">
              Установить мне
            </Link>
          ) : (
            <Link href="/dashboard/subscription"
                  className="inline-flex items-center justify-center rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100">
              {need ? `Повысить до ${need.title}` : 'Тарифы'}
            </Link>
          )}
        </div>
      </td>
    </tr>
  )
}

/** Карточка — прежний развёрнутый вид, для тех, кому так удобнее. */
function Card({ sol, features }: { sol: Solution; features: string[] }) {
  const missing = missingFeatures(sol, features)
  const available = !missing.length

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-semibold text-gray-500">
          {sol.num}
        </span>
        <Link href={`/dashboard/solutions/${sol.slug}`}
              className="font-semibold hover:underline" style={{ color: DARK }}>
          {sol.title}
        </Link>
        <span className="ml-auto"><TariffBadge missing={missing} /></span>
      </div>
      <p className="mb-2 text-sm text-gray-600">{sol.short}</p>

      <ul className="mb-2 space-y-1">
        {sol.advantages.map((a, i) => (
          <li key={i} className="flex gap-1.5 text-sm text-gray-700">
            <Check size={14} className="mt-0.5 shrink-0" style={{ color: DARK }} />
            <span>{a}</span>
          </li>
        ))}
      </ul>

      <div className="mb-2 rounded-lg bg-gray-50 p-2">
        <div className="mb-1 text-[11px] font-medium text-gray-500">Что настроить у себя</div>
        <ul className="space-y-0.5">
          {sol.setup.map((x, i) => (
            <li key={i} className="text-xs text-gray-600">— {x}</li>
          ))}
        </ul>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {sol.tools.map(t => (
          <span key={t} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">{t}</span>
        ))}
      </div>

      <Actions sol={sol} available={available} missing={missing} />
    </div>
  )
}
