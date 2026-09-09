'use client'

/**
 * Карточка клиента глазами внедренца: контакты для связи и история денег.
 *
 * ⚠️ Это НЕ кабинет клиента — внутрь его событий и контактов отсюда не попасть.
 * Доступ в кабинет даётся отдельно, механизмом помощников, и с согласия клиента.
 */
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

const rub = (kop?: number | null) =>
  `${Math.round((kop || 0) / 100).toLocaleString('ru-RU')} ₽`
const dt = (v?: string | null) =>
  v ? new Date(v).toLocaleDateString('ru-RU') : '—'

export default function TechClientPage() {
  // ⚠️ Next 14.2.3: useParams(), НЕ use(params) — то Next 15, здесь падает.
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.tech.client(Number(id))
      .then(setData)
      .catch((e: any) => setError(e?.message || 'Клиент не найден'))
  }, [id])

  if (error) return <div className="p-8 text-sm text-red-600">{error}</div>
  if (!data) return <div className="p-8 text-sm text-gray-400">Загружаем…</div>

  const c = data.client
  const tg = c.telegram_username ? String(c.telegram_username).replace('@', '') : ''

  return (
    <div className="max-w-3xl p-4 md:p-8">
      <Link href="/tech"
            className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft size={15} /> Мои клиенты
      </Link>

      <h1 className="mb-1 text-2xl font-bold text-gray-900">{c.name || 'Без имени'}</h1>
      <p className="mb-5 text-sm text-gray-500">
        В работе с {dt(c.tech_assigned_at)} · в ПЛЮСОНе с {dt(c.created_at)}
      </p>

      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-gray-800">Связь</div>
          <div className="space-y-1 text-sm">
            <div className="text-gray-600">{c.email}</div>
            {c.phone && <a href={`tel:${c.phone}`} className="block text-[#25455D] hover:underline">{c.phone}</a>}
            {tg && (
              <a href={`https://telegram.me/${tg}`} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1 text-[#25455D] hover:underline">
                @{tg} <ExternalLink size={12} />
              </a>
            )}
          </div>
        </div>

        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-gray-800">Подписка</div>
          <div className="text-sm">
            <div className="font-medium text-gray-900">{c.tariff_name || 'нет тарифа'}</div>
            <div className="text-gray-500">
              {c.sub_source === 'paid' ? 'оплачен' : c.sub_source ? 'выдан бесплатно' : '—'}
              {c.expires_at && ` · до ${dt(c.expires_at)}`}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        <div className="border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-800">
          История оплат
        </div>
        {!data.orders?.length ? (
          <div className="p-6 text-center text-sm text-gray-500">Оплат пока не было.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {data.orders.map((o: any) => (
                <tr key={`${o.kind}-${o.id}`} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-3 text-gray-600">{dt(o.paid_at)}</td>
                  <td className="px-4 py-3">
                    {o.title || (o.kind === 'addon' ? 'Модуль' : 'Тариф')}
                    <div className="text-xs text-gray-400">
                      {o.kind === 'addon' ? 'модуль' : 'подписка'}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-medium">{rub(o.amount)}</td>
                  <td className="px-4 py-3">
                    {o.status === 'paid'
                      ? <span className="text-green-600">оплачено</span>
                      : <span className="text-gray-400">{o.status}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
