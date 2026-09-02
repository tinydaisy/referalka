'use client'

/**
 * CRM лид-магнита: люди по этапам воронки, колонками.
 *
 * Открывается кликом по цифрам в списке лид-магнитов. Раньше клик уводил в
 * «Контакты» с фильтром — человек терял страницу лид-магнитов, и увидеть
 * все этапы разом было нельзя.
 *
 * Колонок две или три — зависит от того, стоит ли перед подарком анкета;
 * решает это бэкенд, фронт просто рисует, что пришло.
 */

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { api } from '@/lib/api'
import PeopleColumnBase from '@/components/analytics/PeopleColumnBase'

export default function LeadMagnetCrmPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-gray-400">Загружаем…</p>}>
      <CrmView />
    </Suspense>
  )
}

function CrmView() {
  const search = useSearchParams()
  const lmId = Number(search.get('lead_magnet_id') || 0)
  const pkgId = Number(search.get('package_id') || 0)

  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    const p = lmId
      ? api.leadMagnets.crm(lmId)
      : pkgId ? api.leadMagnetPackages.crm(pkgId) : Promise.reject(new Error('Не указан лид-магнит'))
    p.then(setData).catch((e: any) => setErr(e?.message || 'Не удалось загрузить'))
  }, [lmId, pkgId])

  return (
    <div>
      <Link href="/dashboard/lead-magnets"
            className="mb-4 inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft size={14} /> К лид-магнитам
      </Link>

      {err && <p className="text-sm text-red-600">{err}</p>}
      {!data && !err && <p className="text-sm text-gray-400">Загружаем…</p>}

      {data && (
        <>
          <h1 className="mb-1 text-2xl font-bold text-gray-900">{data.title}</h1>
          <p className="mb-4 text-sm text-gray-500">
            Всего людей: <b className="text-gray-800">{data.total}</b>
            {' · '}проценты считаются от перешедших
            {data.has_survey && ' · перед подарком стоит анкета'}
          </p>

          {!data.total ? (
            <p className="text-sm text-gray-400">
              По этой ссылке пока никто не переходил.
            </p>
          ) : (
            <div className="flex flex-wrap gap-3 pb-2">
              {data.columns.map((c: any, i: number) => (
                <PeopleColumnBase key={c.key}
                  title={c.title} count={c.count} percent={c.percent}
                  people={c.people} tone={i === 0 ? 'peach' : 'dark'} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
