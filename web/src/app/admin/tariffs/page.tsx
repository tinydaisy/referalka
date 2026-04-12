'use client'
import { useEffect, useState } from 'react'
import { Plus, Check } from 'lucide-react'
import { api } from '@/lib/api'

export default function AdminTariffsPage() {
  const [tariffs, setTariffs] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ slug: '', name: '', price: '0', trial_months: '0', max_events: '-1', max_participants: '-1' })

  useEffect(() => { api.admin.tariffs().then(r => setTariffs(r.tariffs || [])).catch(() => {}) }, [])

  async function addTariff(e: React.FormEvent) {
    e.preventDefault()
    const res = await api.admin.createTariff({
      slug: form.slug, name: form.name, price: parseFloat(form.price),
      trial_months: parseInt(form.trial_months), max_events: parseInt(form.max_events),
      max_participants: parseInt(form.max_participants)
    })
    setTariffs(t => [...t, res.tariff])
    setShowForm(false)
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
              { key: 'trial_months', label: 'Пробный период (мес)', placeholder: '0' },
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
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">Отмена</button>
            <button type="submit" className="btn-gold px-5 py-2 rounded-lg text-sm font-medium">Создать</button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {tariffs.map(t => (
          <div key={t.id}
            className={`bg-white rounded-2xl border shadow-sm p-6 ${t.slug === 'beta' ? 'border-green-200 ring-2 ring-green-100' : 'border-gray-100'}`}
          >
            {t.slug === 'beta' && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-green-100 text-green-700 text-xs rounded-full font-medium mb-3">
                <Check size={11} /> Текущий
              </span>
            )}
            <h3 className="font-bold text-gray-900 text-lg">{t.name}</h3>
            <p className="text-3xl font-bold mt-2 mb-1" style={{ color: '#25455D' }}>
              {t.price === 0 ? 'Бесплатно' : `${t.price} ₽`}
            </p>
            {t.price > 0 && <p className="text-sm text-gray-400 mb-3">в месяц</p>}

            <div className="space-y-2 mt-4 text-sm text-gray-600">
              {t.trial_months > 0 && (
                <div className="flex items-center gap-2"><span className="text-green-500">✓</span> Пробный период: {t.trial_months} мес.</div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                {t.max_events === -1 ? 'Неограниченно событий' : `До ${t.max_events} событий`}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                {t.max_participants === -1 ? 'Неограниченно участников' : `До ${t.max_participants} участников`}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
