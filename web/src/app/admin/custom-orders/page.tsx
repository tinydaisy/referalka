'use client'

/**
 * Персональные заказы в админке.
 *
 * ⚠️ Экран ОБЩИЙ с кабинетом внедренца (`CustomOrdersScreen`) — различается
 * только набор методов API: у владельца свои пути и право удалять заказ.
 */
import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import CustomOrdersScreen from '@/components/CustomOrdersScreen'
import { useUrlTab } from '@/hooks/useUrlTab'

const TABS = ['orders', 'prices'] as const

export default function AdminCustomOrdersPage() {
  const [tab, setTab] = useUrlTab<string>('tab', 'orders', TABS)

  return (
    <div className="space-y-5">
      {/* ⚠️ Вкладки через useUrlTab: обновление страницы не должно сбрасывать
          на первую. */}
      <div className="flex gap-2 border-b border-gray-200">
        {[['orders', 'Заказы'], ['prices', 'Прайс услуг']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    tab === k
                      ? 'border-current'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                  style={tab === k ? { color: '#25455D' } : undefined}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'orders'
        ? <CustomOrdersScreen api={api.customOrders} />
        : <PriceList />}
    </div>
  )
}

/**
 * Прайс услуг — ориентир для сборки заказа и цифры «от» на лендинге.
 *
 * ⚠️ Правится здесь, а не в коде: цены меняются чаще, чем выкатывается сборка.
 */
function PriceList() {
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const d = await api.customOrders.prices()
      setItems(d.items || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#25455D' }}>
            Прайс услуг
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Ориентир для сборки заказа. На лендинге показывается как «от … ₽» —
            итоговую цену вы ставите в самом заказе.
          </p>
        </div>
        <button onClick={() => setAdding(true)}
                className="btn-gold inline-flex items-center gap-2">
          <Plus size={16} /> Добавить услугу
        </button>
      </div>

      {adding && (
        <PriceEditor onCancel={() => setAdding(false)}
                     onSave={async d => {
                       await api.customOrders.createPrice(d)
                       setAdding(false)
                       load()
                     }} />
      )}

      {loading ? (
        <p className="text-gray-400">Загружаем…</p>
      ) : (
        <div className="space-y-2">
          {items.map(it => (
            <PriceRow key={it.id} item={it} onChange={load} />
          ))}
          {items.length === 0 && (
            <p className="text-gray-500">Прайс пуст — добавьте первую услугу.</p>
          )}
        </div>
      )}
    </div>
  )
}

function PriceRow({ item, onChange }: { item: any; onChange: () => void }) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <PriceEditor item={item}
                   onCancel={() => setEditing(false)}
                   onSave={async d => {
                     await api.customOrders.updatePrice(item.id, d)
                     setEditing(false)
                     onChange()
                   }} />
    )
  }

  return (
    <div className={`bg-white rounded-xl border border-gray-100 p-4 flex flex-wrap
                     items-center gap-3 ${item.is_active ? '' : 'opacity-50'}`}>
      <div className="min-w-0 flex-1">
        <div className="font-medium" style={{ color: '#25455D' }}>
          {item.title}
          {!item.is_active && (
            <span className="text-xs text-gray-400 font-normal"> · скрыта</span>
          )}
        </div>
        {item.description && (
          <div className="text-sm text-gray-500">{item.description}</div>
        )}
      </div>
      <div className="font-bold shrink-0" style={{ color: '#25455D' }}>
        {item.price.toLocaleString('ru-RU')} ₽
      </div>
      <button onClick={() => setEditing(true)}
              className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200">
        Изменить
      </button>
      <button onClick={async () => {
                if (!confirm(`Удалить «${item.title}» из прайса?`)) return
                await api.customOrders.removePrice(item.id)
                onChange()
              }}
              className="p-1.5 rounded-lg text-red-600 hover:bg-red-50">
        <Trash2 size={16} />
      </button>
    </div>
  )
}

function PriceEditor({ item, onSave, onCancel }: {
  item?: any
  onSave: (d: any) => Promise<void>
  onCancel: () => void
}) {
  const [title, setTitle] = useState(item?.title || '')
  const [description, setDescription] = useState(item?.description || '')
  const [price, setPrice] = useState(String(item?.price ?? 0))
  const [sortOrder, setSortOrder] = useState(String(item?.sort_order ?? 0))
  const [isActive, setIsActive] = useState(item?.is_active !== false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return setError('Напишите название услуги')
    setBusy(true)
    setError('')
    try {
      await onSave({
        title: title.trim(),
        description: description.trim() || null,
        price: parseInt(price || '0', 10) || 0,
        sort_order: parseInt(sortOrder || '0', 10) || 0,
        is_active: isActive,
      })
    } catch (e: any) {
      setError(e?.message || 'Не удалось сохранить')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-xl border-2 p-5 space-y-3"
          style={{ borderColor: '#FFCFA4' }}>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-sm text-gray-700 mb-1">Название</span>
          <input value={title} onChange={e => setTitle(e.target.value)}
                 className="w-full rounded-lg border border-gray-300 px-3 py-2" />
        </label>
        <label className="block">
          <span className="block text-sm text-gray-700 mb-1">Цена, ₽</span>
          <input value={price} onChange={e => setPrice(e.target.value.replace(/\D/g, ''))}
                 inputMode="numeric"
                 className="w-full rounded-lg border border-gray-300 px-3 py-2" />
        </label>
      </div>

      <label className="block">
        <span className="block text-sm text-gray-700 mb-1">
          Что входит — короткое пояснение
        </span>
        <input value={description} onChange={e => setDescription(e.target.value)}
               className="w-full rounded-lg border border-gray-300 px-3 py-2" />
      </label>

      <div className="flex flex-wrap items-end gap-4">
        <label className="block w-28">
          <span className="block text-sm text-gray-700 mb-1">Порядок</span>
          <input value={sortOrder}
                 onChange={e => setSortOrder(e.target.value.replace(/\D/g, ''))}
                 inputMode="numeric"
                 className="w-full rounded-lg border border-gray-300 px-3 py-2" />
        </label>
        <label className="flex items-center gap-2 cursor-pointer pb-2.5">
          <input type="checkbox" checked={isActive}
                 onChange={e => setIsActive(e.target.checked)} />
          <span className="text-sm text-gray-700">Показывать на сайте</span>
        </label>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn-gold">
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button type="button" onClick={onCancel}
                className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200">
          Отмена
        </button>
      </div>
    </form>
  )
}
