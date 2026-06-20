'use client'
import { useState, useEffect } from 'react'
import { Plus, Save, Trash2, Pencil, X, Users, FileText, ChevronUp, ChevronDown, Search, Check } from 'lucide-react'
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

  // раскрытый блок «кто оплатил» (inline, не модалка)
  const [expandedId, setExpandedId] = useState<number | null>(null)

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
              <div key={t.id} className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="p-4 flex items-start gap-3">
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
                    onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 ${
                      expandedId === t.id
                        ? 'bg-[#FFCFA4]/60 text-[#8a5a2b]'
                        : 'bg-[#FFCFA4]/30 text-[#8a5a2b] hover:bg-[#FFCFA4]/50'
                    }`}
                    title="Кто оплатил"
                  >
                    <Users size={13} /> {t.buyers_count}
                    {expandedId === t.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                  <button onClick={() => openEdit(t)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" title="Изменить">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => removeTariff(t)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-400" title="Удалить">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Раскрывающийся блок «Кто оплатил» (inline, не модалка) */}
              {expandedId === t.id && (
                <BuyersPanel
                  eventId={eventId}
                  tariff={t}
                  onChanged={load}
                />
              )}
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
              Тариф активен
            </label>
            <p className="text-xs text-gray-400 -mt-2">Выключенный тариф остаётся в кабинете, оплаты по нему засчитываются. Влияет только на отдачу в API для стороннего лендинга.</p>
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

function BuyersPanel({ eventId, tariff, onChanged }: { eventId: number; tariff: any; onChanged: () => void }) {
  const [data, setData] = useState<{ count: number; buyers: Buyer[] } | null>(null)
  const [adding, setAdding] = useState(false)

  async function reload() {
    const r = await api.eventTariffs.buyers(eventId, tariff.id)
    setData(r)
  }
  useEffect(() => { reload() }, [eventId, tariff.id])

  async function removeBuyer(participantId: number) {
    if (!confirm('Снять отметку оплаты у этого человека?')) return
    await api.eventTariffs.removeBuyer(eventId, tariff.id, participantId)
    await reload()
    onChanged()
  }

  return (
    <div className="border-t border-gray-100 bg-gray-50/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Оплатили {data ? `· ${data.count}` : ''}
        </span>
        <button
          onClick={() => setAdding(v => !v)}
          className="px-2.5 py-1.5 rounded-lg bg-brand text-white text-xs font-medium flex items-center gap-1"
        >
          <Plus size={13} /> Добавить оплатившего
        </button>
      </div>

      {adding && (
        <AddBuyerPicker
          eventId={eventId}
          tariffId={tariff.id}
          existingParticipantIds={new Set((data?.buyers || []).map(b => b.participant_id))}
          onDone={async () => { setAdding(false); await reload(); onChanged() }}
        />
      )}

      {!data ? (
        <div className="py-6 flex justify-center"><Spinner /></div>
      ) : data.buyers.length === 0 ? (
        <div className="text-center text-gray-400 text-sm py-6">Пока никто не оплатил. Можно добавить вручную.</div>
      ) : (
        <div className="space-y-2">
          {data.buyers.map(b => (
            <div key={b.id} className="border border-gray-100 bg-white rounded-xl p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-gray-800 text-sm truncate">{b.contact_name || `Контакт #${b.contact_id}`}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] text-gray-400">{fmtDate(b.paid_at)}</span>
                  <button onClick={() => removeBuyer(b.participant_id)} className="p-1 rounded hover:bg-red-50 text-red-400" title="Снять отметку">
                    <Trash2 size={13} />
                  </button>
                </div>
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
  )
}

// Выбор кого отметить оплатившим: участники события ИЛИ контакты базы.
function AddBuyerPicker({
  eventId, tariffId, existingParticipantIds, onDone,
}: {
  eventId: number
  tariffId: number
  existingParticipantIds: Set<number>
  onDone: () => void
}) {
  const [source, setSource] = useState<'participants' | 'contacts'>('participants')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      try {
        if (source === 'participants') {
          const r = await api.events.participants(eventId, 'all')
          const list = (r.participants || []).filter((p: any) => {
            if (!query.trim()) return true
            const q = query.toLowerCase()
            return [p.contact_name, p.first_name, p.last_name, p.username, p.email, p.phone]
              .some((v: any) => (v || '').toString().toLowerCase().includes(q))
          })
          if (!cancelled) setRows(list)
        } else {
          const r = await api.contacts.list(query, 50, 0, false)
          if (!cancelled) setRows(r.contacts || r.items || [])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    const t = setTimeout(run, query ? 250 : 0)
    return () => { cancelled = true; clearTimeout(t) }
  }, [source, query, eventId])

  async function pick(row: any) {
    setBusyId(row.id)
    try {
      if (source === 'participants') {
        await api.eventTariffs.addBuyer(eventId, tariffId, { participant_id: row.id })
      } else {
        await api.eventTariffs.addBuyer(eventId, tariffId, { contact_id: row.id })
      }
      onDone()
    } catch (e: any) {
      alert(e?.message || 'Не удалось отметить оплату')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="border border-gray-200 bg-white rounded-xl p-3 space-y-2.5">
      <div className="flex gap-1 text-xs">
        {([['participants', 'Из участников'], ['contacts', 'Из контактов']] as const).map(([k, label]) => (
          <button key={k} onClick={() => { setSource(k); setRows([]) }}
            className={`px-3 py-1.5 rounded-lg font-medium ${
              source === k ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600'
            }`}>
            {label}
          </button>
        ))}
      </div>
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Поиск по имени, @нику, email, телефону…"
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-brand"
        />
      </div>
      <div className="max-h-64 overflow-y-auto space-y-1">
        {loading ? (
          <div className="py-6 flex justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <div className="text-center text-gray-400 text-xs py-6">Ничего не найдено</div>
        ) : rows.map(row => {
          const already = source === 'participants' && existingParticipantIds.has(row.id)
          const name = row.contact_name || row.name || [row.first_name, row.last_name].filter(Boolean).join(' ') || `#${row.id}`
          const sub = row.email || row.phone || (row.username ? `@${row.username}` : '')
          return (
            <button
              key={row.id}
              onClick={() => !already && pick(row)}
              disabled={already || busyId === row.id}
              className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left text-sm ${
                already ? 'bg-green-50 text-green-700 cursor-default' : 'hover:bg-gray-50'
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-gray-800">{name}</span>
                {sub && <span className="block truncate text-xs text-gray-400">{sub}</span>}
              </span>
              {already
                ? <Check size={15} className="shrink-0" />
                : <Plus size={15} className="shrink-0 text-brand" />}
            </button>
          )
        })}
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
