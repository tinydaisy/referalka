'use client'
import { useState, useEffect } from 'react'
import { Plus, Save, Trash2, Pencil, X, Users, FileText } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

// Тарифы мероприятия (миграция 157). Раздел показывается только клиентам
// тарифа vip — гейтинг в page.tsx, на бэке write-операции тоже 403 для остальных.

interface Tariff {
  id: number
  code: string
  title: string
  description: string | null
  price: number | null
  pay_url: string | null
  sort_order: number
  is_active: boolean
  buyers_count: number
}

interface Buyer {
  id: number
  participant_id: number
  paid_at: string
  source: string | null
  amount: number | null
  external_payment_id: string | null
  contact_id: number
  contact_name: string | null
  phone: string | null
  email: string | null
  tg_id: string | null
  tg_username: string | null
  vk_id: string | null
  vk_username: string | null
  max_id: string | null
  max_username: string | null
}

const emptyForm = {
  code: '', title: '', description: '', price: '', pay_url: '', is_active: true,
}

export default function TariffsTab({
  event, eventId, onReload,
}: {
  event: any
  eventId: number
  onReload?: () => Promise<void>
}) {
  const [items, setItems] = useState<Tariff[]>([])
  const [loading, setLoading] = useState(true)
  const [offerUrl, setOfferUrl] = useState(event.offer_url || '')
  const [savingOffer, setSavingOffer] = useState(false)

  // форма создания/редактирования
  const [editing, setEditing] = useState<Tariff | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<typeof emptyForm>(emptyForm)
  const [saving, setSaving] = useState(false)

  // модалка «кто оплатил»
  const [buyersOf, setBuyersOf] = useState<Tariff | null>(null)

  async function load() {
    setLoading(true)
    try {
      const r = await api.eventTariffs.list(eventId)
      setItems(r.items || [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [eventId])

  async function saveOffer() {
    setSavingOffer(true)
    try {
      await api.events.update(eventId, { offer_url: offerUrl.trim() || null })
      await onReload?.()
    } finally {
      setSavingOffer(false)
    }
  }

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
    setShowForm(true)
  }
  function openEdit(t: Tariff) {
    setEditing(t)
    setForm({
      code: t.code,
      title: t.title,
      description: t.description || '',
      price: t.price != null ? String(t.price) : '',
      pay_url: t.pay_url || '',
      is_active: t.is_active,
    })
    setShowForm(true)
  }

  async function submitForm() {
    const code = form.code.trim().toLowerCase()
    const title = form.title.trim()
    if (!code) { alert('Укажите код тарифа (например vip) — он нужен платёжке.'); return }
    if (!title) { alert('Укажите название тарифа.'); return }
    const payload = {
      code,
      title,
      description: form.description.trim() || null,
      price: form.price.trim() ? parseInt(form.price.trim(), 10) : null,
      pay_url: form.pay_url.trim() || null,
      is_active: form.is_active,
    }
    setSaving(true)
    try {
      if (editing) await api.eventTariffs.update(eventId, editing.id, payload)
      else await api.eventTariffs.create(eventId, payload)
      setShowForm(false)
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить тариф')
    } finally {
      setSaving(false)
    }
  }

  async function removeTariff(t: Tariff) {
    if (!confirm(`Удалить тариф «${t.title}»? Записи об оплатах этого тарифа тоже удалятся.`)) return
    await api.eventTariffs.remove(eventId, t.id)
    await load()
  }

  if (loading) return <div className="py-16 flex justify-center"><Spinner /></div>

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Оферта события */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <div className="flex items-center gap-2 mb-1">
          <FileText size={18} className="text-brand" />
          <h3 className="font-semibold text-gray-800">Оферта мероприятия</h3>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          Одна на всё событие — ссылка на документ (PDF/страница). Её можно показать рядом с кнопкой оплаты.
        </p>
        <div className="flex gap-2">
          <input
            value={offerUrl}
            onChange={e => setOfferUrl(e.target.value)}
            placeholder="https://..."
            className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
          />
          <button
            onClick={saveOffer}
            disabled={savingOffer}
            className="px-4 py-2.5 rounded-xl bg-brand text-white text-sm font-medium flex items-center gap-1.5 disabled:opacity-50"
          >
            <Save size={15} /> Сохранить
          </button>
        </div>
      </div>

      {/* Список тарифов */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-800">Тарифы события</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Платёжка дёргает вебхук с кодом тарифа — оплата попадёт в нужный тариф.
            </p>
          </div>
          <button
            onClick={openCreate}
            className="px-3.5 py-2 rounded-xl bg-brand text-white text-sm font-medium flex items-center gap-1.5 shrink-0"
          >
            <Plus size={15} /> Добавить тариф
          </button>
        </div>

        {items.length === 0 ? (
          <div className="text-center text-gray-400 text-sm py-10">
            Тарифов пока нет. Добавьте первый — например VIP-доступ.
          </div>
        ) : (
          <div className="space-y-2.5">
            {items.map(t => (
              <div key={t.id} className="border border-gray-200 rounded-xl p-4 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-gray-800">{t.title}</span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-mono">{t.code}</span>
                    {!t.is_active && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-400">выключен</span>
                    )}
                    {t.price != null && (
                      <span className="text-sm text-gray-500">{t.price.toLocaleString('ru-RU')} ₽</span>
                    )}
                  </div>
                  {t.description && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{t.description}</p>}
                  {t.pay_url && (
                    <a href={t.pay_url} target="_blank" rel="noreferrer"
                       className="text-xs text-brand hover:underline break-all mt-1 inline-block">
                      {t.pay_url}
                    </a>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => setBuyersOf(t)}
                    className="px-2.5 py-1.5 rounded-lg bg-[#FFCFA4]/30 text-[#8a5a2b] text-xs font-medium flex items-center gap-1 hover:bg-[#FFCFA4]/50"
                    title="Кто оплатил"
                  >
                    <Users size={13} /> {t.buyers_count}
                  </button>
                  <button onClick={() => openEdit(t)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" title="Изменить">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => removeTariff(t)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-400" title="Удалить">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Модалка формы */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-800">{editing ? 'Изменить тариф' : 'Новый тариф'}</h3>
              <button onClick={() => setShowForm(false)} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
            </div>
            <Field label="Название" hint="Что видит покупатель — «VIP-доступ»">
              <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
                     className="input-tar" placeholder="VIP-доступ" />
            </Field>
            <Field label="Код тарифа" hint="Латиницей, без пробелов — его передаёт платёжка (tariff_code). Например vip">
              <input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })}
                     className="input-tar font-mono" placeholder="vip" />
            </Field>
            <Field label="Сумма, ₽" hint="Оставьте пустым, если «по запросу»">
              <input value={form.price} onChange={e => setForm({ ...form, price: e.target.value.replace(/[^0-9]/g, '') })}
                     className="input-tar" placeholder="29000" inputMode="numeric" />
            </Field>
            <Field label="Описание">
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                        rows={3} className="input-tar resize-none" placeholder="Что входит в тариф" />
            </Field>
            <Field label="Ссылка на оплату" hint="Продамус / ЮKassa / GetCourse — любая">
              <input value={form.pay_url} onChange={e => setForm({ ...form, pay_url: e.target.value })}
                     className="input-tar" placeholder="https://..." />
            </Field>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} />
              Тариф активен (показывать в виджете)
            </label>
            <div className="flex gap-2 pt-1">
              <button onClick={submitForm} disabled={saving}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-brand text-white text-sm font-medium disabled:opacity-50">
                {saving ? 'Сохраняю…' : 'Сохранить'}
              </button>
              <button onClick={() => setShowForm(false)}
                      className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600">Отмена</button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка «кто оплатил» */}
      {buyersOf && <BuyersModal eventId={eventId} tariff={buyersOf} onClose={() => setBuyersOf(null)} />}

      <style jsx>{`
        .input-tar {
          width: 100%;
          padding: 0.6rem 0.9rem;
          border-radius: 0.75rem;
          border: 1px solid #e5e7eb;
          font-size: 0.875rem;
          outline: none;
        }
        .input-tar:focus { border-color: #25455D; }
      `}</style>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}

function PlatformChip({ label, href, color }: { label: string; href: string; color: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer"
       className="inline-flex items-center gap-1 text-xs hover:underline" style={{ color }}>
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-sm text-[8px] font-bold text-white" style={{ background: color }}>
        {label.slice(0, 2)}
      </span>
    </a>
  )
}

function BuyersModal({ eventId, tariff, onClose }: { eventId: number; tariff: any; onClose: () => void }) {
  const [data, setData] = useState<{ count: number; buyers: Buyer[] } | null>(null)
  useEffect(() => {
    api.eventTariffs.buyers(eventId, tariff.id).then(setData)
  }, [eventId, tariff.id])
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h3 className="font-semibold text-gray-800">Оплатили «{tariff.title}»</h3>
            {data && <p className="text-xs text-gray-400 mt-0.5">{data.count} чел.</p>}
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto p-5">
          {!data ? (
            <div className="py-10 flex justify-center"><Spinner /></div>
          ) : data.buyers.length === 0 ? (
            <div className="text-center text-gray-400 text-sm py-10">Пока никто не оплатил.</div>
          ) : (
            <div className="space-y-2">
              {data.buyers.map(b => (
                <div key={b.id} className="border border-gray-100 rounded-xl p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-800 text-sm truncate">{b.contact_name || `Контакт #${b.contact_id}`}</span>
                    <span className="text-[11px] text-gray-400 shrink-0">{fmtDate(b.paid_at)}</span>
                  </div>
                  <div className="flex items-center gap-2.5 mt-1.5 flex-wrap">
                    {(b.tg_id || b.tg_username) && (
                      <PlatformChip label="TG" color="#229ED9"
                        href={b.tg_username ? `https://t.me/${b.tg_username.replace(/^@+/, '')}` : `tg://user?id=${b.tg_id}`} />
                    )}
                    {(b.vk_id || b.vk_username) && (
                      <PlatformChip label="VK" color="#0077FF"
                        href={b.vk_username ? `https://vk.com/${b.vk_username.replace(/^@+/, '')}` : `https://vk.com/id${b.vk_id}`} />
                    )}
                    {(b.max_id || b.max_username) && (
                      <PlatformChip label="MAX" color="#8a5a2b"
                        href={b.max_username ? `https://max.ru/${b.max_username}` : '#'} />
                    )}
                    {b.email && <span className="text-xs text-gray-500 truncate">{b.email}</span>}
                    {b.phone && <span className="text-xs text-gray-500">{b.phone}</span>}
                  </div>
                  {(b.source || b.amount != null) && (
                    <div className="text-[11px] text-gray-400 mt-1">
                      {b.source && <span>через {b.source}</span>}
                      {b.amount != null && <span> · {b.amount.toLocaleString('ru-RU')} ₽</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Moscow',
    }) + ' МСК'
  } catch { return iso }
}
