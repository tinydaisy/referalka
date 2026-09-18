'use client'

/**
 * Персональные заказы — ОДИН экран на админку и кабинет внедренца.
 *
 * ⚠️⚠️ ВТОРОЙ КОПИИ БЫТЬ НЕ ДОЛЖНО. Различие между владельцем и внедренцем
 * ровно одно — набор методов API (у внедренца свои пути и фильтр по себе в SQL)
 * и доступ к прайсу. Всё остальное — та же таблица, та же форма, та же отметка
 * «Исполнено». Разойдутся копии — и в одном месте появится поле, которого нет в
 * другом, как уже вышло с формой заказа продукта.
 */
import { useEffect, useState } from 'react'
import { Plus, Copy, Check, Trash2, ExternalLink } from 'lucide-react'
import { useUrlTab } from '@/hooks/useUrlTab'

type Order = {
  id: number
  number: string
  title: string
  items: string
  amount: number
  status: string
  client_name: string | null
  client_email: string | null
  client_phone: string | null
  payment_url: string | null
  paid_at: string | null
  is_done: boolean
  lead_source: string
  client_id: number | null
  source_kind: string | null
  source_title: string | null
  owner_tech_title: string | null
  note: string | null
  request_text: string | null
  created_at: string
}

type PriceItem = { id: number; title: string; description?: string | null; price: number }

type Api = {
  list: (status?: string) => Promise<any>
  prices: () => Promise<any>
  searchClients: (q: string) => Promise<any>
  create: (data: any) => Promise<any>
  update: (id: number, data: any) => Promise<any>
  remove?: (id: number) => Promise<any>
}

type FoundClient = {
  id: number
  name: string
  brand: string | null
  email: string
  phone: string | null
  source: { kind: string; title: string; email: string | null }
  // За кем клиент числится. ⚠️ Не то же, что «привёл»: привести мог один, а
  // вести закреплён другой.
  owner: { id: number; title: string | null; email: string | null } | null
}

const STATUSES = ['all', 'draft', 'sent', 'paid', 'cancelled'] as const
const STATUS_LABEL: Record<string, string> = {
  all: 'Все',
  draft: 'Черновики',
  sent: 'Ждут оплаты',
  paid: 'Оплачены',
  cancelled: 'Отменены',
}

export default function CustomOrdersScreen({ api }: { api: Api }) {
  const [tab, setTab] = useUrlTab<string>('status', 'all', STATUSES)
  const [orders, setOrders] = useState<Order[]>([])
  const [prices, setPrices] = useState<PriceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true)
    setError('')
    try {
      const d = await api.list(tab === 'all' ? undefined : tab)
      setOrders(d.orders || [])
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить заказы')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [tab])

  useEffect(() => {
    api.prices().then(d => setPrices(d.items || [])).catch(() => setPrices([]))
  }, [])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#25455D' }}>
            Персональные заказы
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Произвольная услуга: перечень работ и цена — как договорились.
          </p>
        </div>
        <button onClick={() => setCreating(true)}
                className="btn-gold inline-flex items-center gap-2">
          <Plus size={16} /> Новый заказ
        </button>
      </div>

      {/* Вкладки-фильтры. ⚠️ Через useUrlTab: обновление страницы не должно
          сбрасывать выбранный фильтр. */}
      <div className="flex flex-wrap gap-2">
        {STATUSES.map(s => (
          <button key={s} onClick={() => setTab(s)}
                  className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    tab === s ? 'text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                  style={tab === s ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : undefined}>
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {creating && (
        <OrderEditor api={api} prices={prices}
                     onCancel={() => setCreating(false)}
                     onSave={async data => {
                       await api.create(data)
                       setCreating(false)
                       load()
                     }} />
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-gray-400">Загружаем…</p>
      ) : orders.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center">
          <p className="text-gray-500">
            Пока пусто. Нажмите «Новый заказ» — соберите перечень работ,
            поставьте цену и отправьте человеку ссылку на оплату.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map(o => (
            <OrderCard key={o.id} order={o} prices={prices} api={api} onChange={load} />
          ))}
        </div>
      )}
    </div>
  )
}

function OrderCard({ order, prices, api, onChange }: {
  order: Order
  prices: PriceItem[]
  api: Api
  onChange: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const payLink = typeof window !== 'undefined'
    ? `${window.location.origin}/order/${order.number}`
    : `/order/${order.number}`

  async function toggleDone() {
    setBusy(true)
    try {
      await api.update(order.id, { is_done: !order.is_done })
      onChange()
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!api.remove) return
    if (!confirm(`Удалить заказ ${order.number}? Это действие не отменить.`)) return
    setBusy(true)
    try {
      await api.remove(order.id)
      onChange()
    } catch (e: any) {
      alert(e?.message || 'Не удалось удалить')
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <OrderEditor api={api} order={order} prices={prices}
                   onCancel={() => setEditing(false)}
                   onSave={async data => {
                     await api.update(order.id, data)
                     setEditing(false)
                     onChange()
                   }} />
    )
  }

  const items = (order.items || '').split('\n').map(s => s.trim()).filter(Boolean)

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-xs font-semibold tracking-wider text-gray-400">
              {order.number}
            </span>
            <StatusBadge status={order.status} />
            {order.is_done && (
              <span className="text-xs px-2 py-0.5 rounded-md bg-green-50 text-green-700 font-medium">
                Исполнено
              </span>
            )}
          </div>
          <div className="font-semibold" style={{ color: '#25455D' }}>
            {order.title}
          </div>
          {(order.client_name || order.client_email) && (
            <div className="text-sm text-gray-500 mt-0.5">
              {[order.client_name, order.client_email, order.client_phone]
                .filter(Boolean).join(' · ')}
            </div>
          )}
          {/* От кого пришёл клиент. ⚠️ Реферальный процент с персональных
              заказов не платим — показываем, чтобы видеть источник. */}
          {(order.source_title || order.owner_tech_title) && (
            <div className="text-xs text-gray-400 mt-0.5">
              {order.source_title && <>Привёл: {order.source_title}</>}
              {order.owner_tech_title && (
                <>{order.source_title && ' · '}В базе у: {order.owner_tech_title}</>
              )}
              {order.lead_source === 'own' && (
                <span className="ml-1.5 text-green-700">· свой клиент, 80 %</span>
              )}
            </div>
          )}
        </div>
        <div className="text-xl font-bold shrink-0" style={{ color: '#25455D' }}>
          {order.amount.toLocaleString('ru-RU')} ₽
        </div>
      </div>

      {items.length > 0 && (
        <ul className="text-sm text-gray-600 space-y-1 mb-3">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-[7px] shrink-0 w-1 h-1 rounded-full bg-gray-300" />
              {it}
            </li>
          ))}
        </ul>
      )}

      {order.request_text && (
        <div className="text-sm bg-gray-50 rounded-lg p-3 mb-3">
          <div className="text-xs text-gray-400 mb-1">Человек написал:</div>
          <div className="text-gray-600 whitespace-pre-wrap">{order.request_text}</div>
        </div>
      )}

      {order.note && (
        <div className="text-xs text-gray-400 mb-3">
          Заметка: {order.note}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {/* ⚠️ Ссылка на НАШУ страницу заказа, а не на платёжку: платёжная
            ссылка создаётся в момент, когда человек нажал «Оплатить», и до
            этого её нет. Отправлять надо ссылку на страницу. */}
        <button onClick={() => {
                  navigator.clipboard?.writeText(payLink)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1800)
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                           bg-gray-100 text-gray-700 text-sm hover:bg-gray-200">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Скопировано' : 'Скопировать ссылку'}
        </button>

        <a href={payLink} target="_blank" rel="noreferrer"
           className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                      bg-gray-100 text-gray-700 text-sm hover:bg-gray-200">
          <ExternalLink size={14} /> Открыть
        </a>

        <button onClick={toggleDone} disabled={busy}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm ${
                  order.is_done
                    ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    : 'bg-green-50 text-green-700 hover:bg-green-100'
                }`}>
          <Check size={14} />
          {order.is_done ? 'Снять отметку' : 'Исполнено'}
        </button>

        {order.status !== 'paid' && (
          <button onClick={() => setEditing(true)}
                  className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 text-sm hover:bg-gray-200">
            Изменить
          </button>
        )}

        {api.remove && order.status !== 'paid' && (
          <button onClick={remove} disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                             text-red-600 text-sm hover:bg-red-50 ml-auto">
            <Trash2 size={14} /> Удалить
          </button>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    draft: { label: 'Черновик', cls: 'bg-gray-100 text-gray-600' },
    sent: { label: 'Ждёт оплаты', cls: 'bg-amber-50 text-amber-700' },
    paid: { label: 'Оплачен', cls: 'bg-green-50 text-green-700' },
    cancelled: { label: 'Отменён', cls: 'bg-gray-100 text-gray-400' },
  }
  const s = map[status] || map.draft
  return (
    <span className={`text-xs px-2 py-0.5 rounded-md font-medium ${s.cls}`}>
      {s.label}
    </span>
  )
}

/**
 * Выбор клиента платформы с показом того, кто его привёл.
 *
 * ⚠️⚠️ ИСТОЧНИК МЫ ПОКАЗЫВАЕМ, А НЕ СПРАШИВАЕМ. Кто привёл клиента, уже
 * записано в платформе; кнопка «свой / из базы» позволяла поставить ставку
 * 80 % вместо 60 % одним кликом и ничем не проверялась. Ставку считает сервер.
 *
 * ⚠️ Партнёра показываем, хотя реферальный процент с персональных заказов не
 * платим: видеть, от кого пришёл человек, полезно и без начисления.
 */
function ClientPicker({ api, value, onPick }: {
  api: Api
  value: FoundClient | null
  onPick: (c: FoundClient | null) => void
}) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState<FoundClient[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return }
    // ⚠️ Пауза перед запросом: без неё поиск уходит на каждую букву.
    const t = setTimeout(async () => {
      setBusy(true)
      try {
        const d = await api.searchClients(q.trim())
        setFound(d.clients || [])
        setOpen(true)
      } catch { setFound([]) }
      finally { setBusy(false) }
    }, 350)
    return () => clearTimeout(t)
  }, [q])

  if (value) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium" style={{ color: '#25455D' }}>
              {value.name}
              {value.brand && value.brand !== value.name && (
                <span className="text-gray-400 font-normal"> · {value.brand}</span>
              )}
            </div>
            <div className="text-sm text-gray-500">{value.email}</div>
            <div className="mt-1 text-xs">
              <span className="text-gray-400">Привёл: </span>
              <span style={{ color: value.source.kind === 'tech' ? '#25455D' : '#6B7280' }}>
                {value.source.title}
                {value.source.email && ` · ${value.source.email}`}
              </span>
            </div>
            {/* Кто ВЕДЁТ — отдельная строка: привести мог партнёр, а
                закреплён клиент за конкретным внедренцем. */}
            <div className="text-xs">
              <span className="text-gray-400">В базе у: </span>
              <span style={{ color: value.owner ? '#25455D' : '#9CA3AF' }}>
                {value.owner
                  ? `${value.owner.title}${value.owner.email ? ` · ${value.owner.email}` : ''}`
                  : 'ни за кем не закреплён'}
              </span>
            </div>
          </div>
          <button type="button"
                  onClick={() => { onPick(null); setQ(''); setFound([]) }}
                  className="text-xs text-gray-500 underline">
            выбрать другого
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative">
      <span className="block text-sm text-gray-700 mb-1">
        Клиент — найдите в базе
      </span>
      <input value={q} onChange={e => setQ(e.target.value)}
             onFocus={() => found.length && setOpen(true)}
             placeholder="Имя, почта или название"
             className="w-full rounded-lg border border-gray-300 px-3 py-2" />
      <span className="block text-xs text-gray-400 mt-1">
        {busy ? 'Ищем…'
          : 'Кто привёл клиента и какая из этого ставка — определится само.'}
      </span>

      {open && found.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg
                        border border-gray-200 bg-white shadow-lg">
          {found.map(c => (
            <button key={c.id} type="button"
                    onClick={() => { onPick(c); setOpen(false) }}
                    className="block w-full border-b border-gray-50 px-3 py-2 text-left
                               last:border-0 hover:bg-gray-50">
              <div className="text-sm font-medium text-gray-900">
                {c.name}
                {c.brand && c.brand !== c.name && (
                  <span className="text-gray-400 font-normal"> · {c.brand}</span>
                )}
              </div>
              <div className="text-xs text-gray-500">{c.email}</div>
              <div className="text-xs text-gray-400">
                Привёл: {c.source.title}
                {' · '}В базе у: {c.owner?.title || 'никого'}
              </div>
            </button>
          ))}
        </div>
      )}

      {open && !busy && q.trim().length >= 2 && found.length === 0 && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-200
                        bg-white p-3 text-sm text-gray-500 shadow-lg">
          Никого не нашли. Можно оформить заказ и без выбора клиента — тогда
          заполните контакты руками.
        </div>
      )}
    </div>
  )
}

function OrderEditor({ api, order, prices, onSave, onCancel }: {
  api: Api
  order?: Order
  prices: PriceItem[]
  onSave: (data: any) => Promise<void>
  onCancel: () => void
}) {
  const [title, setTitle] = useState(order?.title || 'Персональный заказ')
  const [items, setItems] = useState(order?.items || '')
  const [amount, setAmount] = useState(String(order?.amount ?? 0))
  const [name, setName] = useState(order?.client_name || '')
  const [email, setEmail] = useState(order?.client_email || '')
  const [phone, setPhone] = useState(order?.client_phone || '')
  const [note, setNote] = useState(order?.note || '')
  // Выбранный клиент платформы. ⚠️ Источник (кто привёл) и ставка из него
  // ВЫЧИСЛЯЮТСЯ на сервере — здесь их не спрашиваем и не отправляем.
  const [client, setClient] = useState<FoundClient | null>(null)
  const [clientId, setClientId] = useState<number | null>(order?.client_id ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  /**
   * Галочка в прайсе добавляет пункт в перечень и прибавляет цену.
   *
   * ⚠️ Сумма ПОСЛЕ этого правится руками и мы её не пересчитываем: «как
   * договоримся» — штатный случай. Если бы сумма всегда равнялась сумме
   * галочек, скидку или надбавку поставить было бы негде.
   */
  function addFromPrice(p: PriceItem) {
    setItems(prev => (prev ? `${prev}\n${p.title}` : p.title))
    setAmount(prev => String((parseInt(prev || '0', 10) || 0) + p.price))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!items.trim()) return setError('Напишите, что входит в заказ')
    const sum = parseInt(amount || '0', 10) || 0
    if (sum <= 0) return setError('Поставьте цену')

    setBusy(true)
    try {
      await onSave({
        title: title.trim(),
        items: items.trim(),
        amount: sum,
        client_name: name.trim() || null,
        client_email: email.trim() || null,
        client_phone: phone.trim() || null,
        note: note.trim() || null,
        client_id: clientId,
      })
    } catch (e: any) {
      setError(e?.message || 'Не удалось сохранить')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}
          className="bg-white rounded-xl border-2 p-5 space-y-4"
          style={{ borderColor: '#FFCFA4' }}>
      <div className="font-semibold" style={{ color: '#25455D' }}>
        {order ? `Заказ ${order.number}` : 'Новый персональный заказ'}
      </div>

      {prices.length > 0 && (
        <div>
          <div className="text-sm text-gray-700 mb-2">
            Собрать из прайса — нажмите, что входит:
          </div>
          <div className="flex flex-wrap gap-2">
            {prices.map(p => (
              <button key={p.id} type="button" onClick={() => addFromPrice(p)}
                      className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700
                                 text-sm hover:bg-gray-200 text-left">
                {p.title}
                <span className="text-gray-400"> · {p.price.toLocaleString('ru-RU')} ₽</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="block">
        <span className="block text-sm text-gray-700 mb-1">Название заказа</span>
        <input value={title} onChange={e => setTitle(e.target.value)}
               className="w-full rounded-lg border border-gray-300 px-3 py-2" />
      </label>

      <label className="block">
        <span className="block text-sm text-gray-700 mb-1">
          Что входит — по строке на пункт
        </span>
        <textarea value={items} onChange={e => setItems(e.target.value)} rows={6}
                  placeholder={'Подключение своего домена\nНастройка платёжной системы\nДва вебинара с сопровождением'}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" />
        <span className="block text-xs text-gray-400 mt-1">
          Человек увидит этот список как есть — пишите понятным ему языком.
        </span>
      </label>

      <label className="block max-w-xs">
        <span className="block text-sm text-gray-700 mb-1">Цена, ₽</span>
        <input value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ''))}
               inputMode="numeric"
               className="w-full rounded-lg border border-gray-300 px-3 py-2 text-lg font-semibold" />
        <span className="block text-xs text-gray-400 mt-1">
          Можно поставить любую — как договорились.
        </span>
      </label>

      {/* Клиент выбирается ИЗ БАЗЫ, а не вводится руками: по нему сервер сам
          определит, кто его привёл, и посчитает ставку внедренца. Поля ниже
          подставятся, но их можно поправить — контактное лицо у заказа бывает
          другое. */}
      <ClientPicker api={api} value={client}
                    onPick={c => {
                      setClient(c)
                      setClientId(c?.id ?? null)
                      if (c) {
                        if (!name.trim()) setName(c.name || '')
                        if (!email.trim()) setEmail(c.email || '')
                        if (!phone.trim()) setPhone(c.phone || '')
                      }
                    }} />

      <div className="grid sm:grid-cols-3 gap-3">
        <label className="block">
          <span className="block text-sm text-gray-700 mb-1">Имя клиента</span>
          <input value={name} onChange={e => setName(e.target.value)}
                 className="w-full rounded-lg border border-gray-300 px-3 py-2" />
        </label>
        <label className="block">
          <span className="block text-sm text-gray-700 mb-1">Почта</span>
          <input value={email} onChange={e => setEmail(e.target.value)} type="email"
                 className="w-full rounded-lg border border-gray-300 px-3 py-2" />
        </label>
        <label className="block">
          <span className="block text-sm text-gray-700 mb-1">Телефон</span>
          <input value={phone} onChange={e => setPhone(e.target.value)}
                 className="w-full rounded-lg border border-gray-300 px-3 py-2" />
        </label>
      </div>

      <label className="block">
        <span className="block text-sm text-gray-700 mb-1">
          Заметка для себя — клиент её не увидит
        </span>
        <input value={note} onChange={e => setNote(e.target.value)}
               className="w-full rounded-lg border border-gray-300 px-3 py-2" />
      </label>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn-gold">
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
        {/* ⚠️ Закрывается ТОЛЬКО этой кнопкой — клик мимо не закрывает, иначе
            теряется набранный перечень работ. */}
        <button type="button" onClick={onCancel}
                className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200">
          Отмена
        </button>
      </div>
    </form>
  )
}
