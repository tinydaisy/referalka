'use client'

/**
 * Продукт в кабинете купившего — материалы со ссылками.
 *
 * ⚠️ Фильтр «что открыто моим тарифом» делает БЭКЕНД. Здесь только рисуем:
 * если фильтровать в браузере, ссылки на материалы старших тарифов уедут
 * тому, кто их не покупал.
 *
 * ⚠️ Подписи — из словаря продукта: у консультационного пресета не должно быть
 * ни «уроков», ни «программы обучения».
 */
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, FileText, ChevronDown, ChevronRight } from 'lucide-react'

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''
const TOKEN_KEY = 'product_cabinet_token'

function wording(preset: string) {
  return preset === 'education'
    ? { unit: 'Урок', content: 'Программа' }
    : { unit: 'Материал', content: 'Что входит' }
}

// ⚠️ См. комментарий в dashboard/products/[id]: use(params) — это Next 15,
// на нашем Next 14.2.3 страница падала с Application error.
export default function CabinetProductPage() {
  const { slug } = useParams<{ slug: string }>()
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

  const tree = useMemo(
    () => data ? buildTree(data.sections, data.items) : [],
    [data],
  )

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">Загружаем…</p>
      </div>
    )
  }

  if (error === 'auth') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="text-center">
          <p className="mb-4 text-gray-600">Нужно войти</p>
          <Link href="/my" className="btn-gold">Войти</Link>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="text-center">
          <p className="mb-4 text-gray-600">У вас нет доступа к этому продукту</p>
          <Link href="/my" className="btn-primary">К моим материалам</Link>
        </div>
      </div>
    )
  }

  const W = wording(data.product.wording_preset)

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Link href="/my"
              className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={15} /> Мои материалы
        </Link>

        <h1 className="mb-6 text-2xl font-bold text-gray-900">{data.product.title}</h1>

        {!tree.length && (
          <p className="text-sm text-gray-500">
            Материалы скоро появятся здесь.
          </p>
        )}

        <div className="space-y-3">
          {tree.map((n: any) => (
            <Node key={`${n.type}-${n.id ?? n.link_id}`} node={n} W={W} slug={slug} />
          ))}
        </div>
      </div>
    </div>
  )
}

function buildTree(sections: any[], items: any[]) {
  const byParent: Record<string, any[]> = {}
  for (const s of sections) {
    const key = String(s.parent_id ?? 'root')
    ;(byParent[key] ||= []).push({ ...s, type: 'section', children: [] })
  }
  const bySection: Record<string, any[]> = {}
  for (const it of items) {
    const key = String(it.section_id ?? 'root')
    ;(bySection[key] ||= []).push({ ...it, type: 'material' })
  }
  const attach = (node: any) => {
    const kids = byParent[String(node.id)] || []
    kids.forEach(attach)
    node.children = [...kids, ...(bySection[String(node.id)] || [])]
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    return node
  }
  const roots = (byParent['root'] || []).map(attach)
  return [...roots, ...(bySection['root'] || [])]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
}

/**
 * Узел оглавления. ⚠️ Раньше здесь разворачивалось СОДЕРЖИМОЕ всех материалов
 * сразу: программа из двадцати уроков превращалась в бесконечную страницу, где
 * нельзя ни найти нужный урок, ни вернуться к прочитанному. Теперь это
 * оглавление: материал — ссылка на свою страницу, разделы свёрнуты.
 */
function Node({ node, W, slug, depth = 0 }: {
  node: any; W: any; slug: string; depth?: number
}) {
  // ⚠️ Разделы СВЁРНУТЫ по умолчанию — так виден весь состав целиком,
  // а не первый раздел на весь экран.
  const [open, setOpen] = useState(false)

  if (node.type === 'material') {
    const n = node.blocks?.length || 0
    return (
      <Link
        href={`/my/${slug}/m/${node.link_id}`}
        style={{ marginLeft: depth * 16 }}
        className="flex items-center gap-3 rounded-xl bg-white p-4 shadow-sm transition hover:shadow"
      >
        <FileText size={16} className="shrink-0 text-gray-400" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-900">{node.title}</div>
          {node.description && (
            <div className="mt-0.5 text-sm text-gray-500">{node.description}</div>
          )}
        </div>
        <span className="shrink-0 text-xs text-gray-400">
          {n ? 'Открыть' : 'Скоро'}
        </span>
      </Link>
    )
  }

  const count = (node.children || []).filter((c: any) => c.type === 'material').length

  return (
    <div style={{ marginLeft: depth * 16 }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300"
      >
        {open
          ? <ChevronDown size={16} className="shrink-0 text-gray-400" />
          : <ChevronRight size={16} className="shrink-0 text-gray-400" />}
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-gray-900">{node.title}</div>
          {node.description && (
            <div className="text-sm text-gray-500">{node.description}</div>
          )}
        </div>
        {count > 0 && <span className="shrink-0 text-xs text-gray-400">{count}</span>}
      </button>
      {open && node.children?.length > 0 && (
        <div className="mt-2 space-y-2">
          {node.children.map((ch: any) => (
            <Node key={`${ch.type}-${ch.id ?? ch.link_id}`}
                  node={ch} W={W} slug={slug} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}
