'use client'
import { useEffect, useState } from 'react'
import { Plus, Pencil, Save, X } from 'lucide-react'
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
  prodamus_payment_url: string | null
  promo_banner_text: string | null
  promo_old_price: number | null
}

const FEATURE_LABELS: Record<string, string> = {
  lead_magnets:    'Лид-магниты',
  conference:      'Конференции',
  awards:          'Премии',
  channels:        'Свой бот',
  export_contacts: 'Экспорт контактов',
  collab_hub:      'Коллабораторная (Хаб)',
  contests:        'Участие в конкурсах',
}

const EMPTY_FORM = {
  slug: '', name: '', price: '0', contact_limit: '1000',
  broadcasts_daily_limit: '10000', default_duration_days: '30',
  prodamus_payment_url: '', promo_banner_text: '', promo_old_price: '',
  feature_slugs: [] as string[],
  is_active: true,
}

export default function AdminTariffsPage() {
  const [tariffs, setTariffs] = useState<Tariff[]>([])
  const [features, setFeatures] = useState<Feature[]>([])
  const [editingId, setEditingId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)

  async function load() {
    const r = await api.admin.tariffs().catch(() => ({ tariffs: [] }))
    setTariffs(r.tariffs || [])
  }

  useEffect(() => {
    load()
    fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/api/v1/admin/features`, {
      headers: { Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('plusson_token') || '' : ''}` },
    }).then(r => r.ok ? r.json() : { features: [] }).then(d => setFeatures(d.features || [])).catch(() => {})
  }, [])

  function startCreate() {
    setForm(EMPTY_FORM)
    setEditingId('new')
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function startEdit(t: Tariff) {
    setForm({
      slug: t.slug,
      name: t.name,
      price: String(t.price),
      contact_limit: String(t.contact_limit ?? ''),
      broadcasts_daily_limit: t.broadcasts_daily_limit == null ? '' : String(t.broadcasts_daily_limit),
      default_duration_days: String(t.default_duration_days ?? 30),
      prodamus_payment_url: t.prodamus_payment_url ?? '',
      promo_banner_text: t.promo_banner_text ?? '',
      promo_old_price: t.promo_old_price == null ? '' : String(t.promo_old_price),
      feature_slugs: t.feature_slugs || [],
      is_active: !!t.is_active,
    })
    setEditingId(t.id)
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function cancel() {
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const body: any = {
      name: form.name,
      price: parseFloat(form.price || '0') || 0,
      contact_limit: parseInt(form.contact_limit || '0') || 0,
      broadcasts_daily_limit: form.broadcasts_daily_limit ? parseInt(form.broadcasts_daily_limit) : 0,
      default_duration_days: parseInt(form.default_duration_days || '30') || 30,
      prodamus_payment_url: form.prodamus_payment_url,
      promo_banner_text: form.promo_banner_text,
      promo_old_price: form.promo_old_price ? parseFloat(form.promo_old_price) : 0,
      feature_slugs: form.feature_slugs,
      is_active: form.is_active,
    }
    if (editingId === 'new') {
      body.slug = form.slug
      await api.admin.createTariff(body)
    } else if (typeof editingId === 'number') {
      await api.admin.updateTariff(editingId, body)
    }
    cancel()
    load()
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
        {editingId === null && (
          <button onClick={startCreate} className="btn-gold px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2">
            <Plus size={14} /> Добавить тариф
          </button>
        )}
      </div>

      {editingId !== null && (
        <form onSubmit={save} className="bg-white rounded-2xl border border-gray-200 p-6 mb-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-800">
              {editingId === 'new' ? 'Новый тариф' : `Редактирование: ${form.name}`}
            </h3>
            <button type="button" onClick={cancel} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {editingId === 'new' && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">Slug (короткий ID)</label>
                <input type="text" value={form.slug}
                  onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
                  placeholder="например: gold"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
            )}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Название</label>
              <input type="text" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Цена, ₽/мес</label>
              <input type="text" value={form.price}
                onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Длительность, дней</label>
              <input type="text" value={form.default_duration_days}
                onChange={e => setForm(f => ({ ...f, default_duration_days: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Лимит контактов</label>
              <input type="text" value={form.contact_limit}
                onChange={e => setForm(f => ({ ...f, contact_limit: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Рассылок в сутки (пусто = безлимит)</label>
              <input type="text" value={form.broadcasts_daily_limit}
                onChange={e => setForm(f => ({ ...f, broadcasts_daily_limit: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4 mb-4">
            <h4 className="text-sm font-semibold text-gray-700 mb-3">Оплата через Prodamus</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-xs text-gray-500 mb-1">Ссылка на форму оплаты Prodamus</label>
                <input type="url" value={form.prodamus_payment_url}
                  onChange={e => setForm(f => ({ ...f, prodamus_payment_url: e.target.value }))}
                  placeholder="https://payform.ru/XXXXXXX/"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                <p className="text-xs text-gray-400 mt-1">
                  Сумма в форме фиксирована — задаётся в кабинете Prodamus. При запуске акции
                  создайте в Prodamus новую ссылку со скидочной ценой и подмените здесь.
                </p>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Текст-баннер акции (опц.)</label>
                <input type="text" value={form.promo_banner_text}
                  onChange={e => setForm(f => ({ ...f, promo_banner_text: e.target.value }))}
                  placeholder="напр. «-30% до 31.12»"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Старая цена (для зачёркивания, опц.)</label>
                <input type="text" value={form.promo_old_price}
                  onChange={e => setForm(f => ({ ...f, promo_old_price: e.target.value }))}
                  placeholder="2490"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4 mb-4">
            <h4 className="text-sm font-semibold text-gray-700 mb-3">Фичи (опции тарифа)</h4>
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

          <label className="flex items-center gap-2 mb-4 text-sm text-gray-700">
            <input type="checkbox" checked={form.is_active}
              onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
            Тариф активен
          </label>

          <div className="flex gap-2">
            <button type="button" onClick={cancel} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">Отмена</button>
            <button type="submit" className="btn-gold px-5 py-2 rounded-lg text-sm font-medium flex items-center gap-2">
              <Save size={14} /> {editingId === 'new' ? 'Создать' : 'Сохранить'}
            </button>
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
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-gray-900 text-lg">{t.name}</h3>
              <button onClick={() => startEdit(t)} className="text-gray-400 hover:text-[#25455D] p-1" title="Редактировать">
                <Pencil size={14} />
              </button>
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
                  💳 {t.prodamus_payment_url}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
