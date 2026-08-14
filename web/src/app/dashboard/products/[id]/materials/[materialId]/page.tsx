'use client'

/**
 * Страница ОДНОГО материала (урока) в кабинете — правка на отдельной странице,
 * а не во всплывающем окне.
 *
 * Зачем. Урок бывает длинным: текст, видео, файлы, кнопки. В окне он
 * прокручивался внутри коробки высотой в экран, ссылку на него нельзя было ни
 * сохранить, ни открыть в соседней вкладке, ни отправить помощнику — окно
 * живёт только внутри той страницы, где его открыли.
 *
 * ⚠️ Редактор тот же самый (MaterialEditor в режиме `page`) — второй копии
 * блочного редактора в проекте быть не должно, иначе правки разъедутся.
 */
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import MaterialEditor from '@/components/products/MaterialEditor'
import { ArrowLeft } from 'lucide-react'

export default function ProductMaterialPage() {
  // ⚠️ useParams(), а не use(params): на проде Next 14.2.3.
  const { id, materialId } = useParams<{ id: string; materialId: string }>()
  const productId = Number(id)
  const matId = Number(materialId)
  const router = useRouter()
  const { isAssistant } = useMe()

  const [product, setProduct] = useState<any>(null)
  const [title, setTitle] = useState<string>('')
  const [sectionId, setSectionId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      try {
        const [p, c] = await Promise.all([
          api.products.get(productId),
          api.products.materials(productId),
        ])
        setProduct(p)
        const link = (c.items || []).find((i: any) => i.material_id === matId)
        setTitle(link?.title || '')
        setSectionId(link?.section_id ?? null)
      } finally { setLoading(false) }
    })()
  }, [productId, matId])

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  // Куда возвращаться: в раздел, если материал в нём, иначе в состав продукта.
  const backHref = sectionId
    ? `/dashboard/products/${productId}/sections/${sectionId}`
    : `/dashboard/products/${productId}`

  return (
    <div className="max-w-4xl">
      <Link
        href={backHref}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft size={15} /> {product?.title || 'Назад'}
      </Link>

      <MaterialEditor
        mode="page"
        materialId={matId}
        title={title}
        onClose={() => router.push(backHref)}
        onRenamed={(t: string) => setTitle(t)}
      />
    </div>
  )
}
