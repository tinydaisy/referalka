'use client'

/**
 * ОДИН материал (урок) в кабинете купившего — отдельной страницей.
 *
 * Зачем. Раньше кабинет разворачивал содержимое ВСЕХ материалов сразу на одной
 * странице: программа из двадцати уроков превращалась в бесконечную простыню,
 * где нельзя было ни найти нужный урок, ни вернуться к прочитанному, ни
 * скинуть ссылку на конкретный урок.
 *
 * ⚠️ Что человеку доступно, решает БЭКЕНД (фильтр по тарифу). Здесь только
 * ищем материал среди уже отданных: если фильтровать в браузере, ссылки на
 * материалы старших тарифов уедут тому, кто их не покупал.
 */
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react'
import MaterialBlockView from '@/components/products/MaterialBlockView'
import CabinetBrand from '@/components/products/CabinetBrand'

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''
const TOKEN_KEY = 'product_cabinet_token'

export default function CabinetMaterialPage() {
  // ⚠️ useParams(), а не use(params): на нашем Next 14.2.3 use() падает.
  const { slug, linkId } = useParams<{ slug: string; linkId: string }>()
  const lid = Number(linkId)

  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      const token = localStorage.getItem(TOKEN_KEY)
      if (!token) { setError('auth'); setLoading(false); return }
      try {
        const res = await fetch(
          `${apiBase}/api/v1/public/product-cabinet/me/${encodeURIComponent(slug)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        if (res.status === 401) { setError('auth'); return }
        if (!res.ok) { setError('no-access'); return }
        setData(await res.json())
      } finally { setLoading(false) }
    })()
  }, [slug])

  const items: any[] = useMemo(() => data?.items || [], [data])
  const idx = items.findIndex((i: any) => i.link_id === lid)
  const item = idx >= 0 ? items[idx] : null

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">Загружаем…</p>
      </div>
    )
  }

  if (error === 'auth') {
    // ⚠️ Ссылку на урок пересылают и открывают из письма — человек попадает
    // сюда, ещё не войдя. Раньше он видел голое «Нужно войти» посреди пустой
    // страницы, а кнопка вела на /my БЕЗ client_id, то есть на ошибку «Не
    // удалось определить кабинет»: выйти из тупика было нечем.
    const cid = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('client_id') : null
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-sm">
          <h1 className="mb-2 text-xl font-bold text-gray-900">
            Доступ к материалу закрыт
          </h1>
          <p className="mb-5 text-sm text-gray-600">
            Чтобы открыть материал, войдите в личный кабинет — код придёт на
            вашу почту.
          </p>
          <Link href={cid ? `/my?client_id=${cid}` : '/my'} className="btn-gold w-full">
            Войти
          </Link>
        </div>
      </div>
    )
  }

  if (!item) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="text-center">
          <p className="mb-4 text-gray-600">Материал недоступен</p>
          <Link href={`/my/${slug}`} className="btn-primary">К списку материалов</Link>
        </div>
      </div>
    )
  }

  const blocks: any[] = item.blocks || []
  // Соседние материалы — чтобы идти по программе, не возвращаясь в список.
  const prev = idx > 0 ? items[idx - 1] : null
  const next = idx < items.length - 1 ? items[idx + 1] : null

  return (
    <div className="min-h-screen bg-gray-50">
      <CabinetBrand brand={data?.brand} href={`/my/${slug}`} />
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Link href={`/my/${slug}`}
              className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={15} /> {data?.product?.title || 'К материалам'}
        </Link>

        <h1 className="mb-1 text-2xl font-bold text-gray-900">{item.title}</h1>
        {item.description && (
          <p className="mb-6 text-sm text-gray-500">{item.description}</p>
        )}
        {!item.description && <div className="mb-6" />}

        {!blocks.length ? (
          <p className="rounded-xl bg-white p-6 text-center text-sm text-gray-400 shadow-sm">
            Материал скоро появится.
          </p>
        ) : (
          <div className="space-y-4 rounded-xl bg-white p-5 shadow-sm md:p-7">
            {blocks.map(b => <MaterialBlockView key={b.id} block={b} />)}
          </div>
        )}

        {(prev || next) && (
          <div className="mt-6 flex items-center justify-between gap-3">
            {prev ? (
              <Link href={`/my/${slug}/m/${prev.link_id}`}
                    className="inline-flex min-w-0 items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:border-gray-300">
                <ChevronLeft size={15} className="shrink-0" />
                <span className="truncate">{prev.title}</span>
              </Link>
            ) : <span />}
            {next && (
              <Link href={`/my/${slug}/m/${next.link_id}`}
                    className="inline-flex min-w-0 items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:border-gray-300">
                <span className="truncate">{next.title}</span>
                <ChevronRight size={15} className="shrink-0" />
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
