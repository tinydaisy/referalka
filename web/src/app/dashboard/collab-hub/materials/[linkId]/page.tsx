'use client'

/**
 * Материал Коллабораторной — страницей в кабинете ПЛЮСОНа.
 *
 * ⚠️ Блоки рисует ОБЩИЙ `MaterialBlockView` — тот же, что в кабинете
 * покупателя и в предпросмотре владельца. Своей вёрстки блоков быть не должно:
 * текст, видео и кнопки обязаны выглядеть одинаково во всех трёх местах.
 *
 * ⚠️ Терминология консультационная — «материал», не «урок».
 */
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import FeatureLock from '@/components/FeatureLock'
import MaterialBlockView from '@/components/products/MaterialBlockView'
import MaterialNav from '@/components/products/MaterialNav'

const MODULE = 'collab_hub'
const BASE = '/dashboard/collab-hub/materials'

export default function CollabMaterialPage() {
  // ⚠️ Next 14.2.3: параметры читаем через useParams(), НЕ через use(params) —
  // это Next 15, здесь страница падает с Application error.
  const { linkId } = useParams<{ linkId: string }>()
  const { me } = useMe()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    api.moduleMaterials.one(MODULE, Number(linkId))
      .then(setData)
      .catch((e: any) => setError(e?.message || 'Материал не найден'))
      .finally(() => setLoading(false))
  }, [linkId])

  if (me && !(me.features || []).includes(MODULE)) {
    return <FeatureLock anyOf={[MODULE]} />
  }

  const m = data?.material

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <Link href={BASE}
            className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft size={15} /> {data?.product?.title || 'База материалов'}
      </Link>

      {loading && <div className="text-sm text-gray-400">Загружаем…</div>}
      {error && !loading && <div className="text-sm text-red-600">{error}</div>}

      {m && (
        <>
          <h1 className="mb-1 text-2xl font-bold text-gray-900">{m.title}</h1>
          {m.description && (
            <p className="mb-6 text-sm text-gray-500">{m.description}</p>
          )}

          {!m.blocks?.length ? (
            <p className="text-sm text-gray-500">Содержимое скоро появится.</p>
          ) : (
            <div className="space-y-4 rounded-xl bg-white p-5 shadow-sm md:p-7">
              {m.blocks.map((b: any) => (
                <MaterialBlockView key={b.id} block={b} />
              ))}
            </div>
          )}

          <MaterialNav
            prev={data.prev ? { href: `${BASE}/${data.prev.link_id}`, title: data.prev.title } : null}
            next={data.next ? { href: `${BASE}/${data.next.link_id}`, title: data.next.title } : null}
          />
        </>
      )}
    </div>
  )
}
