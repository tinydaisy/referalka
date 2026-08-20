'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ChevronRight, ImageOff } from 'lucide-react'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

/**
 * Общие кирпичики страницы-инструкции.
 *
 * ⚠️ Заведены отдельным файлом, потому что раньше каждая статья объявляла свои
 * `Section` / `Screenshot` у себя внизу — копий набралось два десятка, и они
 * успели разъехаться по отступам и цветам. Новые статьи собираются только из
 * этих компонентов; свою локальную копию заводить нельзя.
 */

export function Crumbs({ section, sectionHref, title }:
  { section: string; sectionHref: string; title: string }) {
  return (
    <div className="flex items-center gap-3 mb-2 flex-wrap">
      <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
      <span className="text-gray-300">/</span>
      <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
      <span className="text-gray-300">/</span>
      <Link href={sectionHref} className="text-sm text-gray-400 hover:text-gray-700">{section}</Link>
      <span className="text-gray-300">/</span>
      <span className="text-sm text-gray-700">{title}</span>
    </div>
  )
}

export function Hero({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-3 mb-6">
      <div className="p-2 rounded-lg text-white h-fit" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        <BookOpen size={22} />
      </div>
      <div>
        <h1 className="text-2xl font-bold" style={{ color: BRAND }}>{title}</h1>
        <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
      </div>
    </div>
  )
}

/** Шаг инструкции. `step` необязателен — у обзорных статей нумерации нет. */
export function Step({ step, title, id, children }:
  { step?: string; title: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mb-5 bg-white rounded-2xl border border-gray-100 p-5 scroll-mt-4">
      <div className="flex items-center gap-3 mb-3">
        {step && (
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0"
               style={{ background: `linear-gradient(135deg, #fff4e0, ${PEACH})`, color: BRAND }}>
            {step}
          </div>
        )}
        <h2 className="text-base font-bold" style={{ color: BRAND }}>{title}</h2>
      </div>
      {children}
    </section>
  )
}

/** Спокойное пояснение — серая плашка. */
export function Note({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
      {title && <div className="text-xs font-semibold text-gray-800 mb-1">{title}</div>}
      <div className="text-xs text-gray-700 leading-relaxed">{children}</div>
    </div>
  )
}

/** То, что легко сделать неправильно — янтарная плашка. */
export function Warn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-4 mb-4 flex items-start gap-3 bg-amber-50 border-amber-200">
      <div className="text-xl flex-shrink-0">⚠️</div>
      <div>
        <div className="text-sm font-semibold text-gray-800">{title}</div>
        <div className="text-xs text-gray-700 mt-1 leading-relaxed">{children}</div>
      </div>
    </div>
  )
}

/** Акцент на главном — персиковая плашка. */
export function Accent({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border p-3" style={{ borderColor: PEACH, background: 'rgba(255,207,164,0.22)' }}>
      <div className="text-xs font-semibold mb-1" style={{ color: BRAND }}>{title}</div>
      <div className="text-xs leading-relaxed" style={{ color: BRAND }}>{children}</div>
    </div>
  )
}

/**
 * Меню статьи — ссылки на её разделы.
 *
 * ⚠️ Скролл делаем сами (`scrollIntoView`), а не голым `href="#id"`: кабинет
 * рисуется внутри прокручиваемого контейнера, и штатный якорь в нём
 * отрабатывает через раз. `scroll-mt-4` на самих секциях не даёт заголовку
 * упереться в верхнюю кромку.
 */
export function ArticleToc({ items }: { items: { id: string; title: string }[] }) {
  function go(e: React.MouseEvent, id: string) {
    e.preventDefault()
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <nav className="mb-5 bg-white rounded-2xl border border-gray-100 p-4">
      <div className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2.5">
        Содержание статьи
      </div>
      <ol className="space-y-1">
        {items.map((it, i) => (
          <li key={it.id}>
            <a
              href={`#${it.id}`}
              onClick={e => go(e, it.id)}
              className="flex items-baseline gap-2 py-1 text-sm text-gray-600 hover:text-gray-900"
            >
              <span className="text-xs tabular-nums flex-shrink-0" style={{ color: BRAND }}>{i + 1}.</span>
              <span className="hover:underline">{it.title}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}

/** Ссылка «читать дальше» в конце статьи. */
export function NextArticle({ href, title, description }:
  { href: string; title: string; description: string }) {
  return (
    <Link href={href}
          className="flex items-start gap-3 p-4 bg-white rounded-2xl border border-gray-100 hover:border-gray-300 hover:shadow-sm transition-all">
      <div className="flex-1 min-w-0">
        <div className="text-xs text-gray-400 mb-0.5">Читать дальше</div>
        <div className="text-sm font-bold" style={{ color: BRAND }}>{title}</div>
        <p className="text-xs text-gray-500 mt-1 leading-snug">{description}</p>
      </div>
      <ChevronRight size={20} className="text-gray-300 flex-shrink-0 mt-4" />
    </Link>
  )
}

/**
 * Скриншот. Пока картинки нет — рисуется аккуратная заглушка с подписью,
 * а не битая иконка: инструкцией можно пользоваться и без иллюстраций.
 */
export function Screenshot({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => { setFailed(false); setReady(false) }, [src])
  // ⚠️ Ограничиваем ВЫСОТУ, а не ширину: скриншоты с телефона вертикальные, и при
  // `w-full` растягивались на всю ширину статьи — выходили полотна во весь экран.
  // Высота решает обе задачи разом: вертикальные ужимаются, горизонтальные
  // остаются читаемыми. Клик открывает оригинал — мелкий текст можно рассмотреть.
  return (
    <figure className="mt-3">
      {!failed ? (
        <a href={src} target="_blank" rel="noreferrer" className={ready ? 'inline-block' : 'hidden'}>
          <img src={src} alt={alt} onError={() => setFailed(true)} onLoad={() => setReady(true)}
               className="max-h-[420px] w-auto max-w-full rounded-lg border border-gray-200
                          cursor-zoom-in hover:border-gray-300" />
        </a>
      ) : null}
      {(failed || !ready) && (
        <div className="w-full rounded-lg border border-dashed border-gray-300 bg-gray-50 py-8 flex flex-col items-center justify-center gap-1.5">
          <ImageOff size={20} className="text-gray-300" />
          <span className="text-xs text-gray-400 px-4 text-center">{alt}</span>
        </div>
      )}
      {caption && <figcaption className="text-xs text-gray-400 mt-1.5">{caption}</figcaption>}
      {ready && <p className="text-[10px] text-gray-300 mt-0.5">Нажмите на картинку, чтобы открыть крупнее</p>}
    </figure>
  )
}
