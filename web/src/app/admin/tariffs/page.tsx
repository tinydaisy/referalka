'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil } from 'lucide-react'
import { api } from '@/lib/api'
import { FEATURE_LABELS } from './labels'

interface Tariff {
  id: number
  slug: string
  name: string
  price: number
  contact_limit: number
  broadcasts_daily_limit: number | null
  default_duration_days: number
  feature_slugs: string[]
  is_active: boolean
  prodamus_payment_url: string | null
  leadpay_product_id: string | null
  promo_banner_text: string | null
  promo_old_price: number | null
}

export default function AdminTariffsPage() {
  const router = useRouter()
  const [tariffs, setTariffs] = useState<Tariff[]>([])

  useEffect(() => {
    api.admin.tariffs().then((r: any) => setTariffs(r.tariffs || [])).catch(() => {})
  }, [])

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Тарифы</h1>
        <button
          onClick={() => router.push('/admin/tariffs/new')}
          className="btn-gold px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2"
        >
          <Plus size={14} /> Добавить тариф
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {tariffs.map(t => (
          <div key={t.id}
            className={`bg-white rounded-2xl border shadow-sm p-6 cursor-pointer hover:shadow-md transition-shadow ${
              t.slug === 'vip' ? 'border-amber-200 ring-2 ring-amber-100' :
              t.slug === 'pro' ? 'border-blue-200' :
              t.slug === 'start' ? 'border-emerald-200' :
              'border-gray-100'
            }`}
            onClick={() => router.push(`/admin/tariffs/${t.id}`)}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-gray-900 text-lg">{t.name}</h3>
              <span className="text-gray-400 hover:text-[#25455D] p-1" title="Редактировать">
                <Pencil size={14} />
              </span>
            </div>

            {t.promo_banner_text && (
              <span className="inline-block mt-2 px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-medium">
                {t.promo_banner_text}
              </span>
            )}

            <div className="mt-2 mb-1">
              {t.promo_old_price && Number(t.promo_old_price) > 0 ? (
                <div className="flex items-baseline gap-2">
                  <span className="text-base line-through text-gray-400">{Number(t.promo_old_price).toLocaleString('ru-RU')} ₽</span>
                  <span className="text-3xl font-bold" style={{ color: '#25455D' }}>
                    {Number(t.price).toLocaleString('ru-RU')} ₽
                  </span>
                </div>
              ) : (
                <p className="text-3xl font-bold" style={{ color: '#25455D' }}>
                  {Number(t.price) === 0 ? 'Бесплатно' : `${Number(t.price).toLocaleString('ru-RU')} ₽`}
                </p>
              )}
            </div>
            {Number(t.price) > 0 && <p className="text-sm text-gray-400 mb-3">за {t.default_duration_days} дн.</p>}

            <div className="space-y-2 mt-4 text-sm text-gray-600">
              <div className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                До {t.contact_limit?.toLocaleString('ru-RU')} контактов на канал
              </div>
              <div className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                {t.broadcasts_daily_limit
                  ? `До ${t.broadcasts_daily_limit.toLocaleString('ru-RU')} рассылок/сутки`
                  : 'Безлимит рассылок'}
              </div>
              {(t.feature_slugs || []).map(slug => (
                <div key={slug} className="flex items-center gap-2">
                  <span className="text-green-500">✓</span>
                  {FEATURE_LABELS[slug] || slug}
                </div>
              ))}
              {t.prodamus_payment_url && (
                <div className="text-xs text-gray-400 mt-3 truncate" title={t.prodamus_payment_url}>
                  💳 Prodamus подключён
                </div>
              )}
              {t.leadpay_product_id && (
                <div className="text-xs text-gray-400 truncate">
                  💳 LeadPay: карточка #{t.leadpay_product_id}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
