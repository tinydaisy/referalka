'use client'

/**
 * База материалов Коллабораторной — ВНУТРИ кабинета ПЛЮСОНа.
 *
 * ⚠️ Почему не кабинет покупателя `/my`. Смотрит клиент платформы, он уже
 * авторизован, и право смотреть даёт КУПЛЕННЫЙ МОДУЛЬ. Гнать его во второй
 * кабинет с входом по коду на почту — лишний шаг ради данных, к которым у него
 * уже есть доступ.
 *
 * ⚠️ Материалы лежат в системном кабинете, поэтому читаются отдельным
 * эндпоинтом (`module-materials`), а не обычными `products.*`: те фильтруют по
 * владению продуктом и отдали бы 404.
 *
 * ⚠️ Терминология КОНСУЛЬТАЦИОННАЯ — «материалы», а не «уроки»: у продукта
 * `wording_preset='consulting'`, и слова должны совпадать с ним.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import FeatureLock from '@/components/FeatureLock'
import MaterialsTree from '@/components/products/MaterialsTree'

const MODULE = 'collab_hub'

export default function CollabMaterialsPage() {
  const { me } = useMe()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    api.moduleMaterials.list(MODULE)
      .then(setData)
      .catch((e: any) => setError(e?.message || 'Не удалось загрузить материалы'))
      .finally(() => setLoading(false))
  }, [])

  // ⚠️ Замок и ЗДЕСЬ, а не только в меню: страница открывается по прямой
  // ссылке, и пункта с замком для защиты недостаточно.
  if (me && !(me.features || []).includes(MODULE)) {
    return <FeatureLock anyOf={[MODULE]} />
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">
        {data?.product?.title || 'База материалов'}
      </h1>
      {data?.product?.subtitle && (
        <p className="mb-6 text-sm text-gray-500">{data.product.subtitle}</p>
      )}

      {loading && <div className="text-sm text-gray-400">Загружаем…</div>}
      {error && !loading && <div className="text-sm text-red-600">{error}</div>}

      {!loading && !error && !data?.tree?.length && (
        <p className="text-sm text-gray-500">Материалы скоро появятся здесь.</p>
      )}

      {!loading && !!data?.tree?.length && (
        <MaterialsTree
          nodes={data.tree}
          hrefFor={(n) => `/dashboard/collab-hub/materials/${n.link_id}`}
        />
      )}
    </div>
  )
}
