'use client'

/**
 * Замок «возможность недоступна на вашем тарифе».
 *
 * ⚠️ Гейт ВСЕГДА по фиче (slug), никогда по названию тарифа: состав тарифов
 * меняется данными в админке, а фича — стабильный признак. Название возможности
 * и то, модуль это или часть тарифа, берём из справочника фич с бэка
 * (`/public/features`) — в коде названий и цен не держим.
 *
 * Показывает, ЧТО именно нужно подключить, и ведёт в раздел покупки.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Lock } from 'lucide-react'

type Feature = {
  slug: string
  name: string
  is_addon?: boolean
  min_tariff_slug?: string | null
  /** В какие тарифы входит фича. Считает бэкенд из tariff_features. */
  tariff_names?: string[]
}

/**
 * «Профи и Экстра» / «Экстра» — перечисление тарифов по-русски.
 *
 * ⚠️ Названия НЕ хардкодим: они приходят из базы. Перенесли фичу в админке в
 * другой тариф — надпись поменялась сама (требование владельца).
 */
export function tariffListText(names: string[]): string {
  const u = Array.from(new Set(names))
  if (u.length === 0) return ''
  if (u.length === 1) return u[0]
  return `${u.slice(0, -1).join(', ')} и ${u[u.length - 1]}`
}

/** Справочник фич грузится один раз на вкладку и живёт в памяти модуля. */
let cache: Feature[] | null = null
let inflight: Promise<Feature[]> | null = null

async function loadFeatures(): Promise<Feature[]> {
  if (cache) return cache
  if (!inflight) {
    inflight = fetch('/api/v1/public/features')
      .then(r => r.ok ? r.json() : [])
      .then((d: any) => {
        cache = Array.isArray(d) ? d : (d?.features || [])
        return cache!
      })
      .catch(() => [])
  }
  return inflight
}

export function useFeatureCatalog() {
  const [list, setList] = useState<Feature[]>(cache || [])
  useEffect(() => { loadFeatures().then(setList) }, [])
  return list
}

/**
 * @param anyOf   достаточно ЛЮБОЙ из этих фич (например, спикеры есть и в
 *                конференциях, и в турнирах, и в коллаборациях)
 * @param where   куда вести за подключением
 * @param compact короткая строка вместо крупной плашки
 */
export default function FeatureLock({
  anyOf, where, compact = false, className = '',
}: {
  anyOf: string[]
  /** Куда вести. Не задано — подбираем сами: модуль → к модулям, иначе к тарифам. */
  where?: string
  compact?: boolean
  className?: string
}) {
  const catalog = useFeatureCatalog()
  const names = anyOf
    .map(s => catalog.find(f => f.slug === s)?.name)
    .filter(Boolean) as string[]

  // Пока справочник не пришёл — не пишем «недоступно в », без названий это
  // выглядит как ошибка. Показываем нейтральную формулировку.
  const what = names.length
    ? names.map(n => `«${n}»`).join(', ')
    : 'платном тарифе'

  // Все запрошенные фичи — модули (аддоны)? Тогда это «модуль», иначе «тариф».
  const allAddons = anyOf.length > 0 && anyOf.every(
    s => catalog.find(f => f.slug === s)?.is_addon
  )

  // ⚠️ НЕ писать «Доступно в тарифе „Анкеты“» — таких тарифов нет. «Анкеты» и
  // «Оферты» это НАЗВАНИЯ ВОЗМОЖНОСТЕЙ, а тарифы называются Профи и Экстра.
  // Подстановка названия фичи в слово «тариф» придумывала несуществующие
  // тарифы, и человек искал их в прайсе. Модуль — другое дело: «Конференции»
  // и «Премии/Турниры» реально продаются под своими именами.
  // В какие тарифы входит возможность — считает бэкенд из tariff_features.
  // ⚠️ Названия тарифов НЕ хардкодим: перенесли фичу в админке в другой тариф —
  // надпись поменялась сама (требование владельца).
  const tariffs = tariffListText(
    anyOf.flatMap(s => catalog.find(f => f.slug === s)?.tariff_names || [])
  )

  const title = allAddons
    ? `Доступно в ${names.length > 1 ? 'модулях' : 'модуле'} ${what}`
    : names.length
      ? (tariffs ? `${what} — в тарифе ${tariffs}` : `${what} — на платном тарифе`)
      : 'Доступно на платном тарифе'

  // ⚠️ Ведём на СТРАНИЦУ подписки (отдельный пункт меню), а не во вкладку
  // настроек — там подписки нет. И сразу к нужному блоку: модули покупаются
  // в одном месте, смена тарифа — в другом, иначе человек попадает в начало
  // длинной страницы и ищет сам.
  // ⚠️ У модуля якорь ИМЕННОЙ (`#module-conference`), а не общий `#modules`:
  // иначе человек попадал в начало блока модулей и сам искал нужный среди
  // трёх, а выделенным выглядел тариф. Именной якорь подводит к его карточке
  // и подсвечивает её.
  const href = where || (allAddons
    ? `/dashboard/subscription#module-${anyOf[0]}`
    : '/dashboard/subscription#tariffs')

  if (compact) {
    return (
      <Link
        href={href}
        className={`inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-brand ${className}`}
      >
        <Lock className="h-3.5 w-3.5 shrink-0" />
        <span>{title} — подключить</span>
      </Link>
    )
  }

  return (
    <Link
      href={href}
      className={`flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 transition-colors hover:bg-amber-100 ${className}`}
    >
      <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-900">
          {title}
        </div>
        <div className="mt-0.5 text-xs text-gray-600">
          Нажмите, чтобы подключить и открыть этот раздел.
        </div>
      </div>
    </Link>
  )
}
