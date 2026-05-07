'use client'
import { useEffect, useState } from 'react'
import { Plus, Check } from 'lucide-react'
import { api } from '@/lib/api'

interface Feature {
  id: number
  slug: string
  name: string
  description?: string
}

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
}

const FEATURE_LABELS: Record<string, string> = {
  lead_magnets:    'Лид-магниты',
  conference:      'Конференции',
  awards:          'Премии',
  channels:        'Свой бот',
  export_contacts: 'Экспорт контактов',
}

export default function AdminTariffsPage() {
  const [tariffs, setTariffs] = useState<Tariff[]>([])
  const [features, setFeatures] = useState<Feature[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    slug: '', name: '', price: '0', contact_limit: '1000',
    broadcasts_daily_limit: '10000', default_duration_days: '30',
    feature_slugs: [] as string[],
  })

  useEffect(() => {
    api.admin.tariffs().then(r => setTariffs(r.tariffs || [])).catch(() => {})
    fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/api/v1/admin/features`, {
      headers: { Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('plusson_token') || '' : ''}` },
    }).then(r => r.ok ? r.json() : { features: [] }).then(d => setFeatures(d.features || [])).catch(() => {})
  }, [])

  async function addTariff(e: React.FormEvent) {
    e.preventDefault()
    const res = await api.admin.createTariff({
      slug: form.slug,
      name: form.name,
      price: parseFloat(form.price),
      contact_limit: parseInt(form.contact_limit),
      broadcasts_daily_limit: form.broadcasts_daily_limit ? parseInt(form.broadcasts_daily_limit) : null,
      default_duration_days: parseInt(form.default_duration_days),
      feature_slugs: form.feature_slugs,
    })
    setTariffs(t => [...t, res.tariff])
    setShowForm(false)
  }

  function toggleFeature(slug: string) {
    setForm(f => ({
      ...f,
      feature_slugs: f.feature_slugs.includes(slug)
        ? f.feature_slugs.filter(s => s !== slug)
        : [...f.feature_slugs, slug],
    }))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Тарифы</h1>
        <button onClick={() => setShowForm(true)} className="btn-gold px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2">
          <Plus size={14} /> Добавить тариф
        </button>
      </div>

      {showForm && (
        <form onSubmit={addTariff} className="bg-white rounded-2xl border border-gray-200 p-6 mb-6 shadow-sm">
          <h3 className="font-semibold text-gray-800 mb-4">Новый тариф</h3>
          <div className="grid grid-cols-2 gap-4 mb-4">
            {[
              { key: 'slug', label: 'Slug (ID)', placeholder: 'basic' },
              { key: 'name', label: 'Название', placeholder: 'Базовый' },
              { key: 'price', label: 'Цена (₽/мес)', placeholder: '0' },
              { key: 'default_duration_days', label: 'Длительность по умолчанию (дн)', placeholder: '30' },
              { key: 'contact_limit', label: 'Лимит контактов', placeholder: '1000' },
              { key: 'broadcasts_daily_limit', label: 'Лимит рассылок/сутки (пусто = безлимит)', placeholder: '10000' },
            ].map(({ key, label, placeholder }) => (
              <div key={key}>
                <label className="block text-xs text-gray-500 mb-1">{label}</label>
                <input type="text" value={(form as any)[key]}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
            ))}
          </div>
          <div className="mb-4">
            <label className="block text-xs text-gray-500 mb-2">Фичи (опции тарифа)</label>
            <div className="flex flex-wrap gap-2">
              {features.map(f => {
                const selected = form.feature_slugs.includes(f.slug)
                return (
                  <button
                    key={f.slug}
                    type="button"
                    onClick={() => toggleFeature(f.slug)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      selected
                        ? 'bg-[#25455D] text-white border-[#25455D]'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {selected ? '✓ ' : ''}{FEATURE_LABELS[f.slug] || f.name}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">Отмена</button>
            <button type="submit" className="btn-gold px-5 py-2 rounded-lg text-sm font-medium">Создать</button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {tariffs.map(t => (
          <div key={t.id}
            className={`bg-white rounded-2xl border shadow-sm p-6 ${
              t.slug === 'vip' ? 'border-amber-200 ring-2 ring-amber-100' :
              t.slug === 'pro' ? 'border-blue-200' :
              t.slug === 'start' ? 'border-emerald-200' :
              'border-gray-100'
            }`}
          >
            <h3 className="font-bold text-gray-900 text-lg">{t.name}</h3>
            <p className="text-3xl font-bold mt-2 mb-1" style={{ color: '#25455D' }}>
              {Number(t.price) === 0 ? 'Бесплатно' : `${Number(t.price).toLocaleString('ru-RU')} ₽`}
            </p>
            {Number(t.price) > 0 && <p className="text-sm text-gray-400 mb-3">за {t.default_duration_days} дн.</p>}

            <div className="space-y-2 mt-4 text-sm text-gray-600">
              <div className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                До {t.contact_limit?.toLocaleString('ru-RU')} контактов
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
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
