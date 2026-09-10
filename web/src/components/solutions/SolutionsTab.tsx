'use client'

/**
 * Готовые решения — витрина сценариев, которые можно поставить себе одной кнопкой.
 *
 * ⚠️ Данные берутся ТОЛЬКО из `catalog.ts`. Своего списка здесь нет: вторая
 * копия разъехалась бы со страницами описаний и с установкой.
 *
 * ⚠️ Решение с недоступным тарифом НЕ прячем, а показываем с честной пометкой,
 * что нужно. Спрятанное выглядит как «такого нельзя», хотя на самом деле можно
 * — просто на другом тарифе; а рядом стоят соседние решения того же результата
 * на Профи, и человек должен их сравнить.
 */
import Link from 'next/link'
import { useMemo } from 'react'
import { ExternalLink, Lock, Check, ArrowRight } from 'lucide-react'
import { useMe } from '@/hooks/useMe'
import {
  SOLUTIONS, CATEGORIES, FEATURE_TITLE, missingFeatures, byNum,
  type Solution,
} from './catalog'

const DARK = '#25455D'

export default function SolutionsTab() {
  const { me } = useMe()
  const features: string[] = useMemo(() => me?.features || [], [me])

  // ⚠️ Сначала доступные, потом требующие тарифа (решение владельца). Внутри
  // группы — по номеру: он же используется в ссылках «смотрите решение 5».
  const inCategory = (key: string) => {
    const list = SOLUTIONS.filter(s => s.category === key)
    return [...list].sort((a, b) => {
      const am = missingFeatures(a, features).length ? 1 : 0
      const bm = missingFeatures(b, features).length ? 1 : 0
      return am - bm || a.num - b.num
    })
  }

  return (
    <div>
      <div className="mb-5 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="mb-1 text-base font-bold text-gray-900">
          Готовые решения — бесплатно
        </h3>
        <p className="text-sm text-gray-600">
          Собранные сценарии: воронка, анкета, событие или продукт уже настроены и
          связаны между собой. Нажимаете «Установить мне» — всё создаётся в вашем
          кабинете за пару секунд.
        </p>
        {/* ⚠️ Про правку говорим В САМОМ ВЕРХУ и повторяем на каждой странице
            решения: без этого готовое воспринимается как «чужое и трогать
            нельзя», и им не пользуются. */}
        <p className="mt-2 text-sm text-gray-600">
          Всё внутри — ваше: тексты, фотографии, вопросы анкет, цены и оформление
          можно менять как угодно. Решение — это заготовка, а не рамка.
        </p>
      </div>

      {CATEGORIES.map(cat => {
        const list = inCategory(cat.key)
        if (!list.length) return null
        return (
          <div key={cat.key} className="mb-7">
            <h4 className="text-sm font-bold uppercase tracking-wide" style={{ color: DARK }}>
              {cat.title}
            </h4>
            <p className="mb-3 text-xs text-gray-500">{cat.hint}</p>

            <div className="space-y-3">
              {list.map(s => <Row key={s.slug} sol={s} features={features} />)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Row({ sol, features }: { sol: Solution; features: string[] }) {
  const missing = missingFeatures(sol, features)
  const available = missing.length === 0

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-semibold text-gray-500">
              {sol.num}
            </span>
            <Link href={`/dashboard/solutions/${sol.slug}`}
                  className="font-semibold hover:underline" style={{ color: DARK }}>
              {sol.title}
            </Link>
          </div>
          <p className="mt-1 text-sm text-gray-600">{sol.short}</p>

          <ul className="mt-2 space-y-1">
            {sol.advantages.map((a, i) => (
              <li key={i} className="flex gap-1.5 text-sm text-gray-700">
                <Check size={14} className="mt-0.5 shrink-0" style={{ color: DARK }} />
                <span>{a}</span>
              </li>
            ))}
          </ul>

          {/* Ссылки на соседние решения того же результата. */}
          {!!sol.seeAlso?.length && (
            <p className="mt-2 text-xs text-gray-500">
              Тот же результат по-другому:{' '}
              {sol.seeAlso.map((n, i) => {
                const other = byNum(n)
                if (!other) return null
                return (
                  <span key={n}>
                    {i > 0 && ', '}
                    <Link href={`/dashboard/solutions/${other.slug}`}
                          className="underline hover:text-gray-700">
                      решение {n}
                    </Link>
                  </span>
                )
              })}
            </p>
          )}

          {/* ⚠️ «Что настроить» — ОТДЕЛЬНО от тарифа: тариф это вопрос денег,
              а это вопрос настройки. Человек с Экстрой, но без подключённого
              бота, иначе не поймёт, почему решение не работает. */}
          <div className="mt-2 rounded-lg bg-gray-50 p-2">
            <div className="mb-1 text-[11px] font-medium text-gray-500">
              Что нужно настроить у себя
            </div>
            <ul className="space-y-0.5">
              {sol.setup.map((x, i) => (
                <li key={i} className="text-xs text-gray-600">— {x}</li>
              ))}
            </ul>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {sol.tools.map(t => (
              <span key={t} className="rounded-md bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
                {t}
              </span>
            ))}
          </div>
        </div>

        {/* Правая колонка: тариф и действия. */}
        <div className="w-full shrink-0 sm:w-56">
          {available ? (
            <div className="mb-2 inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
              <Check size={13} /> Доступно на вашем тарифе
            </div>
          ) : (
            <div className="mb-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
              <span className="inline-flex items-center gap-1 font-medium">
                <Lock size={13} /> Нужен тариф Экстра
              </span>
              <div className="mt-0.5 text-[11px]">
                не хватает: {missing.map(f => FEATURE_TITLE[f]).join(', ')}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Link href={`/dashboard/solutions/${sol.slug}`}
                  className="inline-flex items-center justify-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
              Подробное описание <ArrowRight size={13} />
            </Link>

            {/* ⚠️ «Посмотреть пример» показываем ТОЛЬКО когда пример реально
                собран: кнопка, ведущая в никуда, хуже её отсутствия. */}
            {sol.demo && (
              <a href={sol.demo} target="_blank" rel="noreferrer"
                 className="inline-flex items-center justify-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                Посмотреть пример <ExternalLink size={13} />
              </a>
            )}

            {available ? (
              <Link href={`/dashboard/solutions/${sol.slug}#install`}
                    className="btn-gold inline-flex items-center justify-center gap-1 text-sm">
                Установить мне
              </Link>
            ) : (
              <Link href="/dashboard/subscription"
                    className="inline-flex items-center justify-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100">
                Подключить Экстру
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
