'use client'
import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Save, X, Tag } from 'lucide-react'
import { api } from '@/lib/api'

interface Promotion {
  id: number
  slug: string
  name: string
  description: string | null
  type: 'trial_bonus_days'
  value: number
  target_tariff_slug: string | null
  max_uses: number | null
  used_count: number
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
  created_at: string
}

const TYPE_LABELS: Record<string, string> = {
  trial_bonus_days: 'Доп. дни trial при регистрации',
}

const EMPTY_FORM = {
  slug: '', name: '', description: '',
  type: 'trial_bonus_days' as Promotion['type'],
  value: '46',
  target_tariff_slug: 'trial',
  max_uses: '30',
  starts_at: '',
  ends_at: '',
  is_active: true,
}

export default function AdminPromotionsPage() {
  const [list, setList] = useState<Promotion[]>([])
  const [editingId, setEditingId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)

  async function load() {
    const r = await api.admin.promotions().catch(() => ({ promotions: [] }))
    setList(r.promotions || [])
  }

  useEffect(() => { load() }, [])

  function startCreate() {
    setForm(EMPTY_FORM)
    setEditingId('new')
  }

  function startEdit(p: Promotion) {
    setForm({
      slug: p.slug,
      name: p.name,
      description: p.description ?? '',
      type: p.type,
      value: String(p.value),
      target_tariff_slug: p.target_tariff_slug ?? '',
      max_uses: p.max_uses == null ? '' : String(p.max_uses),
      starts_at: p.starts_at ? p.starts_at.slice(0, 16) : '',
      ends_at:   p.ends_at   ? p.ends_at.slice(0, 16)   : '',
      is_active: p.is_active,
    })
    setEditingId(p.id)
  }

  function cancel() {
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const body: any = {
      name: form.name,
      description: form.description,
      value: parseInt(form.value || '0') || 0,
      target_tariff_slug: form.target_tariff_slug || null,
      max_uses: form.max_uses ? parseInt(form.max_uses) : 0,
      starts_at: form.starts_at || null,
      ends_at: form.ends_at || null,
      is_active: form.is_active,
    }
    if (editingId === 'new') {
      body.slug = form.slug
      body.type = form.type
      await api.admin.createPromotion(body)
    } else if (typeof editingId === 'number') {
      await api.admin.updatePromotion(editingId, body)
    }
    cancel()
    load()
  }

  async function remove(p: Promotion) {
    if (!confirm(`Удалить акцию «${p.name}»? Это действие нельзя отменить.`)) return
    await api.admin.deletePromotion(p.id)
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Акции</h1>
        {editingId === null && (
          <button onClick={startCreate} className="btn-gold px-4 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2">
            <Plus size={14} /> Создать акцию
          </button>
        )}
      </div>

      <p className="text-sm text-gray-500 mb-6 max-w-2xl">
        Акции типа «Доп. дни trial при регистрации» применяются автоматически при создании
        нового клиента (если есть свободные места и срок не истёк). Скидки на оплату
        тарифов делаются не здесь, а через подмену ссылки Prodamus в карточке тарифа.
      </p>

      {editingId !== null && (
        <form onSubmit={save} className="bg-white rounded-2xl border border-gray-200 p-6 mb-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-800">
              {editingId === 'new' ? 'Новая акция' : `Редактирование: ${form.name}`}
            </h3>
            <button type="button" onClick={cancel} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {editingId === 'new' && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">Slug (короткий ID)</label>
                <input type="text" value={form.slug}
                  onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
                  placeholder="например: first_30_trial_bonus"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
              </div>
            )}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Название (видно в админке)</label>
              <input type="text" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs text-gray-500 mb-1">Описание (показывается на лендинге, опц.)</label>
              <input type="text" value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="напр. «Только до 31.05 — успейте зарегистрироваться»"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            {editingId === 'new' && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">Тип</label>
                <select value={form.type}
                  onChange={e => setForm(f => ({ ...f, type: e.target.value as any }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
                  <option value="trial_bonus_days">Доп. дни trial при регистрации</option>
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                {form.type === 'trial_bonus_days' ? 'Сколько доп. дней trial' : 'Значение'}
              </label>
              <input type="number" value={form.value} min={0}
                onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Целевой тариф (slug или пусто = любой)</label>
              <input type="text" value={form.target_tariff_slug}
                onChange={e => setForm(f => ({ ...f, target_tariff_slug: e.target.value }))}
                placeholder="trial"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Лимит применений (пусто = без лимита)</label>
              <input type="number" value={form.max_uses} min={0}
                onChange={e => setForm(f => ({ ...f, max_uses: e.target.value }))}
                placeholder="30"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Начало (опц.)</label>
              <input type="datetime-local" value={form.starts_at}
                onChange={e => setForm(f => ({ ...f, starts_at: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Конец (опц.)</label>
              <input type="datetime-local" value={form.ends_at}
                onChange={e => setForm(f => ({ ...f, ends_at: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
          </div>

          <label className="flex items-center gap-2 mb-4 text-sm text-gray-700">
            <input type="checkbox" checked={form.is_active}
              onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
            Акция активна
          </label>

          <div className="flex gap-2">
            <button type="button" onClick={cancel} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">Отмена</button>
            <button type="submit" className="btn-gold px-5 py-2 rounded-lg text-sm font-medium flex items-center gap-2">
              <Save size={14} /> {editingId === 'new' ? 'Создать' : 'Сохранить'}
            </button>
          </div>
        </form>
      )}

      {list.length === 0 && editingId === null && (
        <div className="bg-white rounded-2xl border card-border p-12 text-center">
          <Tag size={32} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">Пока нет ни одной акции</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {list.map(p => {
          const remaining = p.max_uses == null ? null : Math.max(0, p.max_uses - p.used_count)
          const exhausted = remaining !== null && remaining === 0
          return (
            <div key={p.id} className={`bg-white rounded-2xl border p-5 shadow-sm ${p.is_active && !exhausted ? 'border-emerald-200' : 'border-gray-200 opacity-70'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900">{p.name}</h3>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {TYPE_LABELS[p.type] || p.type} · <code>{p.slug}</code>
                  </p>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => startEdit(p)} className="text-gray-400 hover:text-[#25455D] p-1" title="Изменить">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => remove(p)} className="text-gray-400 hover:text-red-500 p-1" title="Удалить">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {p.description && <p className="mt-2 text-sm text-gray-600">{p.description}</p>}

              <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div className="bg-gray-50 rounded-lg p-2">
                  <p className="text-xs text-gray-500">Значение</p>
                  <p className="font-semibold text-gray-900">+{p.value} дн.</p>
                </div>
                {p.max_uses != null && (
                  <div className="bg-gray-50 rounded-lg p-2">
                    <p className="text-xs text-gray-500">Использовано</p>
                    <p className="font-semibold text-gray-900">
                      {p.used_count} из {p.max_uses}
                      {remaining !== null && remaining > 0 && (
                        <span className="text-emerald-600 font-normal ml-2">осталось {remaining}</span>
                      )}
                    </p>
                  </div>
                )}
                {p.target_tariff_slug && (
                  <div className="bg-gray-50 rounded-lg p-2">
                    <p className="text-xs text-gray-500">Тариф</p>
                    <p className="font-semibold text-gray-900">{p.target_tariff_slug}</p>
                  </div>
                )}
                <div className="bg-gray-50 rounded-lg p-2">
                  <p className="text-xs text-gray-500">Статус</p>
                  <p className={`font-semibold ${exhausted ? 'text-gray-400' : p.is_active ? 'text-emerald-600' : 'text-gray-500'}`}>
                    {exhausted ? 'Исчерпана' : p.is_active ? 'Активна' : 'Выключена'}
                  </p>
                </div>
              </div>

              {(p.starts_at || p.ends_at) && (
                <p className="mt-3 text-xs text-gray-400">
                  {p.starts_at && <>с {new Date(p.starts_at).toLocaleString('ru-RU')}</>}
                  {p.starts_at && p.ends_at && ' '}
                  {p.ends_at && <>до {new Date(p.ends_at).toLocaleString('ru-RU')}</>}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
