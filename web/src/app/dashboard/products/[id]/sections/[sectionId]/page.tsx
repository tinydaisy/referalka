'use client'

/**
 * Страница ОДНОГО раздела продукта — «БОНУС Креативный маркетинг» и т.п.
 *
 * Зачем отдельная страница. В общем составе продукта разделов бывает десяток,
 * и работать с одним из них в общей простыне неудобно: чтобы добраться до
 * нужного урока, надо прокручивать всё остальное. Здесь только этот раздел,
 * его вложенные разделы и его материалы — списком, каждый кликабелен.
 *
 * ⚠️ Материалы открываются СТРАНИЦЕЙ, а не всплывающим окном: урок бывает
 * длинным, в окне он прокручивается внутри коробки высотой в экран, а ссылку
 * на него нельзя ни сохранить, ни открыть в соседней вкладке.
 */
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import { ArrowLeft, FileText, FolderTree, ChevronRight } from 'lucide-react'

export default function ProductSectionPage() {
  // ⚠️ useParams(), а не use(params): на проде Next 14.2.3 — use() падает.
  const { id, sectionId } = useParams<{ id: string; sectionId: string }>()
  const productId = Number(id)
  const secId = Number(sectionId)
  const { isAssistant } = useMe()

  const [product, setProduct] = useState<any>(null)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const [p, c] = await Promise.all([
        api.products.get(productId),
        api.products.materials(productId),
      ])
      setProduct(p)
      setData(c)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [productId])

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>
  if (!data || !product) return <p className="text-sm text-gray-400">Раздел не найден</p>

  const sections: any[] = data.sections || []
  const items: any[] = data.items || []
  const section = sections.find(s => s.id === secId)
  if (!section) return <p className="text-sm text-gray-400">Раздел не найден</p>

  const children = sections.filter(s => s.parent_id === secId)
  const mats = items.filter(i => i.section_id === secId)

  // Хлебные крошки: раздел может лежать внутри другого раздела.
  const path: any[] = []
  let cur = section
  while (cur?.parent_id) {
    const parent = sections.find(s => s.id === cur.parent_id)
    if (!parent) break
    path.unshift(parent)
    cur = parent
  }

  return (
    <div className="max-w-4xl">
      <Link
        href={`/dashboard/products/${productId}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft size={15} /> {product.title}
      </Link>

      {path.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-gray-400">
          {path.map(p => (
            <span key={p.id} className="inline-flex items-center gap-1">
              <Link
                href={`/dashboard/products/${productId}/sections/${p.id}`}
                className="hover:text-gray-600 hover:underline"
              >
                {p.title}
              </Link>
              <ChevronRight size={12} />
            </span>
          ))}
        </div>
      )}

      <h1 className="mb-1 text-2xl font-bold text-gray-900">{section.title}</h1>
      {section.description && (
        <p className="mb-6 text-sm text-gray-500">{section.description}</p>
      )}
      {!section.description && <div className="mb-6" />}

      {children.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Вложенные разделы
          </h2>
          <div className="space-y-2">
            {children.map(c => (
              <Link
                key={c.id}
                href={`/dashboard/products/${productId}/sections/${c.id}`}
                className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3 transition hover:border-gray-300"
              >
                <FolderTree size={16} className="shrink-0 text-gray-400" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-gray-900">{c.title}</div>
                  {c.description && (
                    <div className="truncate text-xs text-gray-500">{c.description}</div>
                  )}
                </div>
                <span className="shrink-0 text-xs text-gray-400">
                  {items.filter(i => i.section_id === c.id).length} шт.
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Материалы {mats.length > 0 && <span className="text-gray-300">· {mats.length}</span>}
      </h2>
      {!mats.length ? (
        <p className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
          В этом разделе пока нет материалов. Добавьте их на странице продукта.
        </p>
      ) : (
        <div className="space-y-2">
          {mats.map((m, i) => (
            <Link
              key={m.link_id}
              href={`/dashboard/products/${productId}/materials/${m.material_id}`}
              className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 transition hover:border-gray-300"
            >
              <span className="w-6 shrink-0 text-sm text-gray-300">{i + 1}</span>
              <FileText size={16} className="shrink-0 text-gray-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-gray-900">
                  {m.title_override || m.title}
                </div>
                <div className="text-xs text-gray-400">
                  {m.blocks_count > 0 ? `Блоков: ${m.blocks_count}` : 'Пусто — материал не наполнен'}
                  {m.used_elsewhere > 0 && ` · используется ещё в ${m.used_elsewhere} продукт(ах)`}
                </div>
              </div>
              <ChevronRight size={16} className="shrink-0 text-gray-300" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
