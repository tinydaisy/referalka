'use client'

/**
 * Подробное описание готового решения — отдельная страница.
 *
 * ⚠️ Страница, а не модалка: здесь пошаговый разбор, список того, что можно
 * поправить, и установка. Ссылку на такую страницу дают друг другу и
 * возвращаются к ней позже — из модалки этого не сделать.
 *
 * ⚠️ Данные — из общего `catalog.ts`. Своего текста здесь нет: он разошёлся бы
 * с таблицей на витрине.
 */
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  ArrowLeft, Check, ExternalLink, Lock, Loader2, Wrench, AlertTriangle,
} from 'lucide-react'
import { useMe } from '@/hooks/useMe'
import { api } from '@/lib/api'
import { bySlug, byNum, missingFeatures, FEATURE_TITLE, CATEGORIES } from '@/components/solutions/catalog'

const DARK = '#25455D'

export default function SolutionPage() {
  const params = useParams()
  const slug = String(params?.slug || '')
  const sol = bySlug(slug)
  const { me } = useMe()
  const features: string[] = useMemo(() => me?.features || [], [me])

  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState('')

  if (!sol) {
    return (
      <div className="p-4 md:p-8">
        <p className="text-sm text-gray-500">Решение не найдено.</p>
        <Link href="/dashboard/channels?tab=solutions"
              className="mt-3 inline-block text-sm underline" style={{ color: DARK }}>
          ← Ко всем решениям
        </Link>
      </div>
    )
  }

  // ⚠️ Гейт нужен и на САМОЙ странице: скрытая вкладка не мешает открыть
  // раздел по прямой ссылке (та же ошибка была у конференций — см. правило
  // «Замка в сайдбаре недостаточно»).
  if (me && !features.includes('ready_solutions')) {
    return (
      <div className="p-4 md:p-8">
        <p className="text-sm text-gray-500">
          Раздел готовых решений пока недоступен в вашем кабинете.
        </p>
        <Link href="/dashboard/channels" className="mt-3 inline-block text-sm underline"
              style={{ color: DARK }}>
          ← К каналам
        </Link>
      </div>
    )
  }

  const missing = missingFeatures(sol, features)
  const available = missing.length === 0
  const category = CATEGORIES.find(c => c.key === sol.category)

  const install = async () => {
    setBusy(true); setError(''); setResult(null)
    try {
      const r: any = await api.solutions.install(sol.slug)
      setResult(r)
    } catch (e: any) {
      setError(e?.message || 'Не удалось установить')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-3xl p-4 md:p-8">
      <Link href="/dashboard/channels?tab=solutions"
            className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft size={15} /> Ко всем решениям
      </Link>

      <div className="mb-1 text-xs uppercase tracking-wide text-gray-400">
        {category?.title} · решение {sol.num}
      </div>
      <h1 className="mb-2 text-2xl font-bold text-gray-900">{sol.title}</h1>
      <p className="mb-5 text-gray-600">{sol.short}</p>

      {/* ── Тариф ─────────────────────────────────────────────────────── */}
      {available ? (
        <div className="mb-5 inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm text-emerald-700">
          <Check size={15} /> Доступно на вашем тарифе
        </div>
      ) : (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-center gap-1.5 font-medium text-amber-900">
            <Lock size={15} /> Нужен тариф Экстра
          </div>
          <p className="mt-1 text-sm text-amber-800">
            Не хватает: {missing.map(f => FEATURE_TITLE[f]).join(', ')}.
          </p>
          {!!sol.seeAlso?.length && (
            <p className="mt-2 text-sm text-amber-800">
              Тот же результат на вашем тарифе:{' '}
              {sol.seeAlso.map((n, i) => {
                const other = byNum(n)
                if (!other || missingFeatures(other, features).length) return null
                return (
                  <span key={n}>
                    {i > 0 && ', '}
                    <Link href={`/dashboard/solutions/${other.slug}`} className="underline">
                      {other.title}
                    </Link>
                  </span>
                )
              })}
            </p>
          )}
          <Link href="/dashboard/subscription"
                className="mt-3 inline-block rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100">
            Подключить Экстру
          </Link>
        </div>
      )}

      {/* ── Как это выглядит для человека ─────────────────────────────── */}
      <section className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-base font-bold text-gray-900">Как это работает</h2>
        <ol className="space-y-3">
          {sol.flow.map((st, i) => (
            <li key={i} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
                    style={{ background: DARK }}>
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm text-gray-800">{st.text}</span>
                {st.note && (
                  <span className="mt-0.5 block text-xs text-gray-500">{st.note}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Что можно поправить ───────────────────────────────────────── */}
      <section className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-1 flex items-center gap-1.5 text-base font-bold text-gray-900">
          <Wrench size={16} style={{ color: DARK }} /> Что можно поменять под себя
        </h2>
        {/* ⚠️ Этот раздел обязателен на каждой странице решения: без него
            готовое воспринимается как «чужое и трогать нельзя». */}
        <p className="mb-3 text-sm text-gray-600">
          Решение — это заготовка. Меняется всё: тексты, фотографии, вопросы
          анкет, цены и оформление. Ничего не сломается — это обычные разделы
          вашего кабинета.
        </p>
        <ul className="space-y-1.5">
          {sol.editable.map((e, i) => (
            <li key={i} className="flex gap-2 text-sm text-gray-700">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full" style={{ background: DARK }} />
              <span>{e}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Что настроить ─────────────────────────────────────────────── */}
      <section className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-base font-bold text-gray-900">
          Что нужно настроить у себя
        </h2>
        <p className="mb-3 text-sm text-gray-600">
          Без этого решение не заработает — проверьте до установки.
        </p>
        <ul className="space-y-1.5">
          {sol.setup.map((x, i) => (
            <li key={i} className="flex gap-2 text-sm text-gray-700">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full" style={{ background: DARK }} />
              <span>{x}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Инструменты ───────────────────────────────────────────────── */}
      <section className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-2 text-base font-bold text-gray-900">Что задействовано</h2>
        <div className="flex flex-wrap gap-1.5">
          {sol.tools.map(t => (
            <span key={t} className="rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-700">
              {t}
            </span>
          ))}
        </div>
      </section>

      {/* ── Установка ─────────────────────────────────────────────────── */}
      <section id="install" className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-2 text-base font-bold text-gray-900">Поставить себе</h2>

        {sol.demo && (
          <a href={sol.demo} target="_blank" rel="noreferrer"
             className="mb-3 inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
            Сначала посмотреть пример <ExternalLink size={13} />
          </a>
        )}

        {!available ? (
          <p className="text-sm text-gray-500">
            Установка станет доступна на тарифе Экстра.
          </p>
        ) : result ? (
          <div className="rounded-lg bg-emerald-50 p-4">
            <div className="flex items-center gap-1.5 font-medium text-emerald-800">
              <Check size={16} /> Готово — решение установлено
            </div>
            {!!result.created?.length && (
              <ul className="mt-2 space-y-1 text-sm text-emerald-900">
                {result.created.map((c: any, i: number) => (
                  <li key={i}>
                    {c.title}
                    {c.href && (
                      <>
                        {' — '}
                        <Link href={c.href} className="underline">открыть</Link>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-emerald-800">
              Теперь замените тексты и фото на свои — где именно, написано выше.
            </p>
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-gray-600">
              Создадим всё нужное в вашем кабинете. Ничего существующего это не
              изменит — появятся новые записи, которые можно править и удалять.
            </p>
            {error && (
              <div className="mb-3 flex gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <button onClick={install} disabled={busy}
                    className="btn-gold inline-flex items-center gap-1.5 text-sm disabled:opacity-50">
              {busy && <Loader2 size={14} className="animate-spin" />}
              {busy ? 'Устанавливаем…' : 'Установить мне'}
            </button>
          </>
        )}
      </section>
    </div>
  )
}
