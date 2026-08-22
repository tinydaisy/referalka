'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Copy, Check, ExternalLink, Search, X } from 'lucide-react'
import { SECTIONS, type Article, type Section } from './sections'

const BRAND = '#25455D'

/**
 * Оглавление разделов — колонка СПРАВА от содержимого.
 *
 * ⚠️ Сознательно БЕЗ иконок и плашек: это содержание документа, как в Google
 * Docs, а не второе навигационное меню. Иконки и цветные квадраты спорили с
 * сайдбаром кабинета слева и превращали страницу в два меню по краям.
 * Активный пункт выделяется вертикальной линией и жирностью, а не заливкой.
 *
 * На узком экране колонки нет — оглавление уезжает вниз обычным списком
 * (`order-2 lg:order-none` на стороне вызова), иначе на телефоне пришлось бы
 * пролистывать его целиком, чтобы добраться до статей.
 */
export function SectionsNav({ activeId, sections, base = '/dashboard/help' }: {
  activeId?: string
  sections?: Section[]
  /** Публичная база знаний передаёт '/help'. */
  base?: string
}) {
  const list = sections || SECTIONS
  return (
    <nav className="lg:sticky lg:top-4">
      <div className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-3">
        Содержание
      </div>
      <ul className="space-y-0.5">
        {list.map(s => {
          const active = s.id === activeId
          return (
            <li key={s.id}>
              <Link
                href={`${base}/s/${s.id}`}
                className="flex items-baseline gap-2 py-1.5 pl-3 border-l-2 transition-colors hover:border-gray-300"
                style={{
                  borderColor: active ? BRAND : '#e5e7eb',
                  color: active ? BRAND : '#4b5563',
                }}
              >
                <span className={`text-sm leading-snug flex-1 min-w-0 ${active ? 'font-bold' : ''}`}>
                  {s.title}
                </span>
                <span className="text-xs text-gray-400 flex-shrink-0 tabular-nums">
                  {s.articles.length}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * Поиск по всем инструкциям сразу.
 *
 * ⚠️ Ищем и по заголовку, и по ОПИСАНИЮ статьи. Описания у нас длинные и
 * содержат живые слова, которыми человек и будет искать («афиша», «зум»,
 * «подарок», «вебхук»), — по одним заголовкам половина запросов не находилась бы.
 *
 * ⚠️ Совпадение ищется по КАЖДОМУ слову запроса отдельно (И), а не по фразе
 * целиком: «настроить лендинг коллаборации» иначе не нашло бы статью
 * «Как настроить лендинг коллаборации» из-за порядка слов.
 *
 * ⚠️ Буква «ё» приводится к «е»: заголовки написаны через «ё» («Подарки»,
 * «где загрузить»), а с клавиатуры её печатают редко.
 */
function normalize(s: string) {
  return s.toLowerCase().replace(/ё/g, 'е')
}

/**
 * Синонимы: слово из запроса → что реально написано в статьях.
 *
 * ⚠️ Нужны там, где человек пишет по-русски, а в тексте латиница (или
 * наоборот). Проверено вживую: «зум» не находил статью про вебинарную комнату,
 * хотя вся статья про него, — в описании стоит «Zoom».
 */
const SYNONYMS: Record<string, string> = {
  зум: 'zoom', обс: 'obs', телеграм: 'telegram', телеграмм: 'telegram',
  тг: 'telegram', вк: 'вконтакте', макс: 'max', кюар: 'qr', куар: 'qr',
  геткурс: 'getcourse', тильда: 'tilda',
  // Числа люди пишут словами, а в описаниях они цифрами («3 и более спикеров»).
  два: '2', две: '2', три: '3', трех: '3', троих: '3', четыре: '4', пять: '5',
}

/**
 * Совпадение слова с текстом — по ОСНОВЕ, а не по точному вхождению.
 *
 * ⚠️ Русские окончания иначе всё ломают. Проверено вживую: «подарок» не
 * находил «подарки», «рассылка» — «рассылок». Поэтому у слов длиннее пяти
 * букв отбрасываются последние две (подар|ок → подар|ки), у слов покороче —
 * одна. Дальше хватает совпадения по началу в любую сторону, чтобы работали
 * и «регистрации» → «регистрация», и наоборот.
 *
 * ⚠️ Две буквы — предел: отбрасывать больше начнёт склеивать разные слова
 * («программа» и «прогресс» дали бы одну основу).
 */
function matches(word: string, words: string[]): boolean {
  const w = SYNONYMS[word] || word
  const cut = w.length > 5 ? 2 : w.length > 3 ? 1 : 0
  const stem = cut ? w.slice(0, w.length - cut) : w
  return words.some(t => t.startsWith(stem) || (t.length > 3 && w.startsWith(t)))
}

/**
 * Поиск по инструкциям.
 *
 * ⚠️ Список разделов и способ построения адреса приходят параметрами — тот же
 * компонент работает и в кабинете, и в публичной базе знаний на `/help`, где
 * разделы другие (без технических) и адреса без `/dashboard`.
 */
export function HelpSearch({ sections, hrefOf }: {
  sections?: Section[]
  hrefOf?: (href: string) => string
} = {}) {
  const [q, setQ] = useState('')
  const list = sections || SECTIONS

  const all = useMemo(
    () => list.flatMap(s => s.articles.map(a => ({ article: a, section: s }))),
    [list],
  )

  const results = useMemo(() => {
    // Запрос режем ТЕМИ ЖЕ правилами, что и текст статей, иначе «win-win»
    // ищется целиком и не находит слова «win» в описании.
    const words = normalize(q).split(/[^a-zа-я0-9]+/).filter(w => w.length >= 2)
    if (!words.length) return []
    return all.filter(({ article, section }) => {
      const hay = normalize(`${article.title} ${article.description} ${section.title}`)
        .split(/[^a-zа-я0-9]+/).filter(Boolean)
      return words.every(w => matches(w, hay))
    })
  }, [q, all])

  const active = q.trim().length >= 2

  return (
    <div className="mb-5">
      <div className="relative">
        <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Поиск по инструкциям"
          className="w-full pl-11 pr-10 py-3 bg-white rounded-xl border border-gray-200 text-sm outline-none focus:border-gray-400 transition-colors"
        />
        {q && (
          <button
            onClick={() => setQ('')}
            aria-label="Очистить поиск"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {active && (
        <div className="mt-3">
          {results.length === 0 ? (
            <div className="p-4 bg-white rounded-xl border border-gray-200">
              <div className="text-sm font-semibold text-gray-800 mb-1">Ничего не нашлось</div>
              <p className="text-sm text-gray-600">
                Попробуйте другое слово — например «афиша», «бот», «рассылка», «лендинг».
                Или посмотрите разделы ниже.
              </p>
            </div>
          ) : (
            <>
              <div className="text-xs text-gray-400 mb-2 px-1">
                Нашлось: {results.length}
              </div>
              <div className="space-y-2">
                {results.map(({ article, section }) => (
                  <div key={article.href}>
                    <div className="text-xs text-gray-400 mb-1 px-1">
                      {section.emoji} {section.title}
                    </div>
                    <ArticleCard article={article} hrefOf={hrefOf} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Карточка статьи. Одна на обе страницы — вёрстка не должна разъезжаться. */
export function ArticleCard({ article, hrefOf }: {
  article: Article
  /** Публичная база знаний передаёт сюда преобразование адреса без /dashboard. */
  hrefOf?: (href: string) => string
}) {
  const href = hrefOf ? hrefOf(article.href) : article.href
  const [origin, setOrigin] = useState('https://pluson.ru')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
  }, [])
  const publicUrl = `${origin}${href}`
  function copyPublic(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(publicUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <Link
      href={href}
      className="block bg-white rounded-xl border border-gray-100 hover:border-gray-300 hover:shadow-sm transition-all p-3.5"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl flex-shrink-0"
             style={{ background: '#f8fafc' }}>
          {article.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h2 className="text-sm font-bold" style={{ color: BRAND }}>{article.title}</h2>
            <ChevronRight size={18} className="text-gray-300 flex-shrink-0" />
          </div>
          <p className="text-xs text-gray-500 leading-snug">{article.description}</p>
          {article.isPublic && (
            <div className="mt-3 p-2.5 rounded-lg border border-amber-200 bg-amber-50">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900 mb-1.5">
                <ExternalLink size={12} /> Публичная ссылка для шеринга
              </div>
              {article.publicNote && (
                <p className="text-xs text-amber-800 mb-2 leading-snug">{article.publicNote}</p>
              )}
              <div className="flex gap-2">
                <code className="flex-1 bg-white border border-amber-200 rounded px-2 py-1.5 text-xs font-mono overflow-x-auto whitespace-nowrap text-gray-700">
                  {publicUrl}
                </code>
                <button
                  onClick={copyPublic}
                  className="px-2.5 py-1.5 rounded text-white text-xs font-medium flex items-center gap-1 flex-shrink-0"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
                >
                  {copied ? <><Check size={12}/> Скопировано</> : <><Copy size={12}/> Копировать</>}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Link>
  )
}

/** Список статей раздела с подзаголовками групп. */
export function ArticleList({ articles, hrefOf }: {
  articles: Article[]
  hrefOf?: (href: string) => string
}) {
  return (
    <div className="space-y-2">
      {articles.map((a, idx) => {
        const showGroup = a.group && a.group !== articles[idx - 1]?.group
        return (
          <div key={a.href}>
            {showGroup && (
              <div className="text-xs font-bold uppercase tracking-wide text-gray-400 mt-3 mb-1.5 px-1">
                {a.group}
              </div>
            )}
            <ArticleCard article={a} hrefOf={hrefOf} />
          </div>
        )
      })}
    </div>
  )
}
