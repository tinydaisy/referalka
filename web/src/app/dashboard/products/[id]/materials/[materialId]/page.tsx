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
import MaterialNav from '@/components/products/MaterialNav'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import MaterialEditor from '@/components/products/MaterialEditor'
import MaterialBlockView from '@/components/products/MaterialBlockView'
import { ArrowLeft, Pencil, Eye } from 'lucide-react'

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
  // Соседние материалы — чтобы листать состав, не возвращаясь в оглавление за
  // каждым. ⚠️ Берём из УЖЕ загруженного состава продукта, без второго запроса.
  const [prev, setPrev] = useState<any>(null)
  const [next, setNext] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  // ⚠️ Предпросмотр «как видит ученик»: в редакторе урок разобран на блоки с
  // полями и кнопками, и понять, как он выглядит для купившего, нельзя. Без
  // этого приходилось заходить в кабинет ученика отдельной учёткой.
  const [preview, setPreview] = useState(false)
  const [blocks, setBlocks] = useState<any[]>([])
  const [blocksLoading, setBlocksLoading] = useState(false)

  // Блоки тянем ПО НАЖАТИЮ и каждый раз заново — иначе предпросмотр покажет
  // состояние до правок, которые человек только что внёс.
  const openPreview = async () => {
    setPreview(true)
    setBlocksLoading(true)
    try {
      const r: any = await api.materials.blocks(matId)
      setBlocks(r.blocks || [])
    } finally { setBlocksLoading(false) }
  }

  useEffect(() => {
    (async () => {
      try {
        const [p, c] = await Promise.all([
          api.products.get(productId),
          api.products.materials(productId),
        ])
        setProduct(p)
        const items = c.items || []
        const link = items.find((i: any) => i.material_id === matId)
        setTitle(link?.title || '')
        setSectionId(link?.section_id ?? null)
        // ⚠️ Порядок берём такой же, как в составе (`sort_order`), а не по id:
        // иначе «дальше» повело бы не туда, куда показывает оглавление.
        const idx = items.findIndex((i: any) => i.material_id === matId)
        setPrev(idx > 0 ? items[idx - 1] : null)
        setNext(idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null)
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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft size={15} /> {product?.title || 'Назад'}
        </Link>

        <div className="flex items-center gap-1 rounded-lg border border-gray-200 p-1">
          {([
            [false, 'Правка', Pencil],
            [true, 'Как видит ученик', Eye],
          ] as const).map(([val, label, Icon]) => (
            <button
              key={String(val)}
              onClick={() => (val ? openPreview() : setPreview(false))}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
                preview === val
                  ? 'bg-[#25455D] font-medium text-white'
                  : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </div>

      {preview ? (
        <>
          {/* ⚠️ Показываем ТЕМ ЖЕ компонентом, что и кабинет покупателя
              (MaterialBlockView), и на том же сером фоне: своя вёрстка
              предпросмотра разошлась бы с тем, что человек видит на самом
              деле, и смысл проверки потерялся бы. */}
          <div className="rounded-2xl bg-gray-50 p-4 md:p-8">
            <h1 className="mb-6 text-2xl font-bold text-gray-900">{title}</h1>
            {blocksLoading ? (
              <p className="text-sm text-gray-400">Загружаем…</p>
            ) : !blocks.length ? (
              <p className="rounded-xl bg-white p-6 text-center text-sm text-gray-400 shadow-sm">
                Материал пуст — ученик увидит «Материал скоро появится».
              </p>
            ) : (
              <div className="space-y-4 rounded-xl bg-white p-5 shadow-sm md:p-7">
                {blocks.map(b => <MaterialBlockView key={b.id} block={b} />)}
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-gray-400">
            Так урок выглядит у купившего. Ссылки кликабельны, видео и файлы —
            рабочие.
          </p>
        </>
      ) : (
        <MaterialEditor
          mode="page"
          materialId={matId}
          title={title}
          onClose={() => router.push(backHref)}
          onRenamed={(t: string) => setTitle(t)}
        />
      )}

      <MaterialNav
        prev={prev ? { href: `/dashboard/products/${productId}/materials/${prev.material_id}`, title: prev.title } : null}
        next={next ? { href: `/dashboard/products/${productId}/materials/${next.material_id}`, title: next.title } : null}
      />
    </div>
  )
}
