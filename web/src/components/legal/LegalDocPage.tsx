/**
 * Публичная страница правового документа платформы (миграция 317).
 *
 * ⚠️ Серверный компонент: документ читается на сервере и приходит уже в HTML.
 * Это важно для юридических текстов — страница должна открываться и без
 * JavaScript, и корректно печататься, и индексироваться.
 *
 * ⚠️ Текст выводится как ПРОСТОЙ ТЕКСТ (`whiteSpace: pre-wrap`), без разбора
 * разметки: документ хранится сплошным текстом с переносами строк, и любой
 * рендер HTML тут был бы дырой — содержимое приходит из админки.
 */
import Link from 'next/link'

const API = process.env.NEXT_PUBLIC_API_URL || 'https://pluson.ru'

async function loadDoc(slug: string) {
  try {
    // ⚠️ Ходим на 127.0.0.1: запрос идёт с сервера, внешний адрес увёл бы его
    // через nginx обратно в этот же Next.js — лишний круг и таймаут при сбое.
    const base = process.env.NODE_ENV === 'production' ? 'http://127.0.0.1:8000' : API
    const r = await fetch(`${base}/api/v1/public/legal-docs/${slug}`, { cache: 'no-store' })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export default async function LegalDocPage({ slug }: { slug: string }) {
  const doc = await loadDoc(slug)

  return (
    {/* ⚠️ Без min-h-screen: страница внутри общего каркаса, и растяжка
        на весь экран оттолкнула бы футер за пределы вида. */}
    <main className="bg-white rounded-2xl">
      <div className="mx-auto max-w-3xl px-5 py-10">
        <Link href="/" className="text-sm text-[#25455D] underline">
          ← iViSiON: ПЛЮСОН
        </Link>

        {!doc ? (
          <div className="mt-8">
            <h1 className="text-2xl font-semibold text-[#25455D] mb-3">Документ пока не опубликован</h1>
            <p className="text-gray-600 text-sm">
              Если он вам нужен прямо сейчас — напишите нам, и мы пришлём его текст.
            </p>
          </div>
        ) : (
          <>
            <h1 className="mt-6 text-2xl font-semibold text-[#25455D]">{doc.title}</h1>
            {doc.version && (
              <div className="mt-1 text-sm text-gray-500">Редакция от {doc.version}</div>
            )}
            <article
              className="mt-6 text-[15px] leading-relaxed text-gray-800"
              style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {doc.body}
            </article>
          </>
        )}
      </div>
    </main>
  )
}
