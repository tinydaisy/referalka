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
import { ArrowLeft } from 'lucide-react'
import CabinetShell from '@/components/products/CabinetShell'
import MaterialsTree from '@/components/products/MaterialsTree'

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''

/** ⚠️ Сохраняем номер кабинета в ссылках: без него `/my` отдаёт «Не удалось
 *  определить кабинет» (свой домен есть не у каждого клиента). */
function myHref(path: string): string {
  if (typeof window === 'undefined') return path
  const cid = new URLSearchParams(window.location.search).get('client_id')
  return cid ? `${path}${path.includes('?') ? '&' : '?'}client_id=${cid}` : path
}
const TOKEN_KEY = 'product_cabinet_token'


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


  return (
    <CabinetShell brand={data.brand} active="materials">
      <div>
        <Link href={myHref('/my')}
              className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft size={15} /> Мои материалы
        </Link>

        <h1 className="mb-6 text-2xl font-bold text-gray-900">{data.product.title}</h1>

        {!tree.length && (
          <p className="text-sm text-gray-500">
            Материалы скоро появятся здесь.
          </p>
        )}

        {/* ⚠️ Дерево рисует ОБЩИЙ компонент — тот же, что в кабинете ПЛЮСОНа
            у материалов модулей. Своей копии здесь быть не должно: их уже было
            три, и они разошлись поведением. */}
        <MaterialsTree nodes={tree} hrefFor={(n) => `/my/${slug}/m/${n.link_id}`} />
      </div>
    </CabinetShell>
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
