'use client'
import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Save } from 'lucide-react'
import { api } from '@/lib/api'
import { FEATURE_LABELS } from '../labels'

interface Feature { id: number; slug: string; name: string }

const EMPTY_FORM = {
  slug: '', name: '', price: '0', contact_limit: '1000',
  broadcasts_daily_limit: '10000', default_duration_days: '30',
  prodamus_payment_url: '', leadpay_product_id: '', promo_banner_text: '', promo_old_price: '',
  feature_slugs: [] as string[],
  is_active: true,
}

export default function TariffEditPage() {
  const router = useRouter()
  const params = useParams()
  const idParam = String(params?.id || '')
  const isNew = idParam === 'new'

  const [form, setForm] = useState(EMPTY_FORM)
  const [features, setFeatures] = useState<Feature[]>([])
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/api/v1/admin/features`, {
      headers: { Authorization: `Bearer ${typeof window !== 'undefined' ? localStorage.getItem('plusson_token') || '' : ''}` },
    }).then(r => r.ok ? r.json() : { features: [] }).then(d => setFeatures(d.features || [])).catch(() => {})

    if (isNew) return
    api.admin.tariffs().then((r: any) => {
      const t = (r.tariffs || []).find((x: any) => String(x.id) === idParam)
      if (!t) { setNotFound(true); setLoading(false); return }
      setForm({
        slug: t.slug,
        name: t.name,
        price: String(t.price),
        contact_limit: String(t.contact_limit ?? ''),
        broadcasts_daily_limit: t.broadcasts_daily_limit == null ? '' : String(t.broadcasts_daily_limit),
        default_duration_days: String(t.default_duration_days ?? 30),
        prodamus_payment_url: t.prodamus_payment_url ?? '',
        leadpay_product_id: t.leadpay_product_id ?? '',
        promo_banner_text: t.promo_banner_text ?? '',
        promo_old_price: t.promo_old_price == null ? '' : String(t.promo_old_price),
        feature_slugs: t.feature_slugs || [],
        is_active: !!t.is_active,
      })
      setLoading(false)
    }).catch(() => { setNotFound(true); setLoading(false) })
  }, [idParam, isNew])

  function toggleFeature(slug: string) {
    setForm(f => ({
      ...f,
      feature_slugs: f.feature_slugs.includes(slug)
        ? f.feature_slugs.filter(s => s !== slug)
        : [...f.feature_slugs, slug],
    }))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    const body: any = {
      name: form.name,
      price: parseFloat(form.price || '0') || 0,
      contact_limit: parseInt(form.contact_limit || '0') || 0,
      broadcasts_daily_limit: form.broadcasts_daily_limit ? parseInt(form.broadcasts_daily_limit) : 0,
      default_duration_days: parseInt(form.default_duration_days || '30') || 30,
      prodamus_payment_url: form.prodamus_payment_url,
      leadpay_product_id: form.leadpay_product_id,
      promo_banner_text: form.promo_banner_text,
      promo_old_price: form.promo_old_price ? parseFloat(form.promo_old_price) : 0,
      feature_slugs: form.feature_slugs,
      is_active: form.is_active,
    }
    try {
      if (isNew) {
        body.slug = form.slug
        await api.admin.createTariff(body)
      } else {
        await api.admin.updateTariff(Number(idParam), body)
      }
      router.push('/admin/tariffs')
    } catch (err: any) {
      setError(err?.message || 'Не удалось сохранить')
      setSaving(false)
    }
  }

  if (loading) return <div className="text-gray-400 text-sm">Загружаем тариф…</div>
  if (notFound) return (
    <div>
      <button onClick={() => router.push('/admin/tariffs')} className="text-sm text-gray-500 flex items-center gap-1 mb-4">
        <ArrowLeft size={14} /> К тарифам
      </button>
      <p className="text-gray-600">Тариф не найден.</p>
    </div>
  )

  const inputCls = "w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"

  return (
    <div className="max-w-3xl">
      <button onClick={() => router.push('/admin/tariffs')} className="text-sm text-gray-500 flex items-center gap-1 mb-4 hover:text-gray-700">
        <ArrowLeft size={14} /> К тарифам
      </button>

      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        {isNew ? 'Новый тариф' : `Редактирование: ${form.name}`}
      </h1>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3 mb-4">{error}</div>
      )}

      <form onSubmit={save} className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          {isNew && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Slug (короткий ID)</label>
              <input type="text" value={form.slug}
                onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
                placeholder="например: gold" className={inputCls} />
            </div>
          )}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Название</label>
            <input type="text" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Цена, ₽/мес</label>
            <input type="text" value={form.price}
              onChange={e => setForm(f => ({ ...f, price: e.target.value }))} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Длительность, дней</label>
            <input type="text" value={form.default_duration_days}
              onChange={e => setForm(f => ({ ...f, default_duration_days: e.target.value }))} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Лимит контактов</label>
            <input type="text" value={form.contact_limit}
              onChange={e => setForm(f => ({ ...f, contact_limit: e.target.value }))} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Рассылок в сутки (пусто = безлимит)</label>
            <input type="text" value={form.broadcasts_daily_limit}
              onChange={e => setForm(f => ({ ...f, broadcasts_daily_limit: e.target.value }))} className={inputCls} />
          </div>
        </div>

        <div className="border-t border-gray-100 pt-4 mb-4">
          <h4 className="text-sm font-semibold text-gray-700 mb-3">Оплата через Prodamus</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs text-gray-500 mb-1">Ссылка на форму оплаты Prodamus</label>
              <input type="url" value={form.prodamus_payment_url}
                onChange={e => setForm(f => ({ ...f, prodamus_payment_url: e.target.value }))}
                placeholder="https://payform.ru/XXXXXXX/" className={inputCls} />
              <p className="text-xs text-gray-400 mt-1">
                Сумма в форме фиксирована — задаётся в кабинете Prodamus. При запуске акции
                создайте в Prodamus новую ссылку со скидочной ценой и подмените здесь.
              </p>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Текст-баннер акции (опц.)</label>
              <input type="text" value={form.promo_banner_text}
                onChange={e => setForm(f => ({ ...f, promo_banner_text: e.target.value }))}
                placeholder="напр. «-30% до 31.12»" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Старая цена (для зачёркивания, опц.)</label>
              <input type="text" value={form.promo_old_price}
                onChange={e => setForm(f => ({ ...f, promo_old_price: e.target.value }))}
                placeholder="2490" className={inputCls} />
            </div>
          </div>
        </div>

        <div className="border-t border-gray-100 pt-4 mb-4">
          <h4 className="text-sm font-semibold text-gray-700 mb-3">Оплата через LeadPay</h4>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Product ID карточки LeadPay</label>
            <input type="text" value={form.leadpay_product_id}
              onChange={e => setForm(f => ({ ...f, leadpay_product_id: e.target.value }))}
              placeholder="напр. 62548" className={inputCls} />
            <p className="text-xs text-gray-400 mt-1">
              ID карточки продукта из личного кабинета LeadPay (число из карточки продукта).
              Ссылку оплаты система создаёт сама через API.
            </p>
          </div>
        </div>

        <div className="border-t border-gray-100 pt-4 mb-4">
          <h4 className="text-sm font-semibold text-gray-700 mb-3">Фичи (опции тарифа)</h4>
          <div className="flex flex-wrap gap-2">
            {features.map(f => {
              const selected = form.feature_slugs.includes(f.slug)
              return (
                <button key={f.slug} type="button" onClick={() => toggleFeature(f.slug)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                    selected ? 'bg-[#25455D] text-white border-[#25455D]'
                             : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                  {selected ? '✓ ' : ''}{FEATURE_LABELS[f.slug] || f.name}
                </button>
              )
            })}
          </div>
        </div>

        <label className="flex items-center gap-2 mb-6 text-sm text-gray-700">
          <input type="checkbox" checked={form.is_active}
            onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
          Тариф активен
        </label>

        <div className="flex gap-2">
          <button type="button" onClick={() => router.push('/admin/tariffs')}
            className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">Отмена</button>
          <button type="submit" disabled={saving}
            className="btn-gold px-5 py-2 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-60">
            <Save size={14} /> {saving ? 'Сохраняем…' : (isNew ? 'Создать' : 'Сохранить')}
          </button>
        </div>
      </form>
    </div>
  )
}
