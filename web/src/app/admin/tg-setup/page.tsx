'use client'

/**
 * Админка автонастройки Telegram (миграция 364).
 *
 * Здесь владелец платформы держит сервисные аккаунты, от лица которых
 * создаются боты клиентов: телефон, пароль двухфакторки, прокси, файл сессии,
 * свободные слоты и состояние спам-блока.
 *
 * ⚠️ ПАРОЛЬ ВИДЕН НАМЕРЕННО. Аккаунты — расходники: сгорел один, завели другой.
 * Владельцу нужно уметь зайти в такой аккаунт руками, а для этого нужны телефон
 * и облачный пароль. Страница доступна только админу платформы.
 *
 * ⚠️ АККАУНТ ПОД СПАМ-БЛОКОМ НЕ СОЗДАЁТ БОТОВ ВОВСЕ — BotFather отвечает
 * «cannot create new bots». Поэтому состояние здесь главный показатель: очередь
 * берёт только аккаунты со статусом «Работает».
 */
import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, Check, Loader2, Plus, RefreshCw, Trash2, Upload, X,
} from 'lucide-react'

interface Account {
  id: number
  phone: string
  title: string | null
  username: string | null
  tg_user_id: number | null
  twofa_password: string | null
  proxy: string | null
  session_path: string | null
  session_exists: boolean
  max_slots: number
  busy_slots: number
  free_slots: number
  is_active: boolean
  health: string
  health_note: string | null
  health_checked_at: string | null
}

interface Order {
  id: number
  client_id: number
  client_name: string
  client_email: string
  telegram_username: string | null
  account_phone: string | null
  status: string
  setup_state: string
  setup_error: string | null
  bot_username: string | null
  amount: number
  paid_at: string | null
  claim_deadline: string | null
  created_at: string
}

const API = process.env.NEXT_PUBLIC_API_URL || ''

async function adminFetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = localStorage.getItem('plusson_admin_token') || localStorage.getItem('plusson_token')
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(init.headers || {}),
    },
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error(err.detail || `HTTP ${r.status}`)
  }
  return r.json()
}

const HEALTH: Record<string, { label: string; cls: string }> = {
  ok:      { label: 'Работает',       cls: 'bg-green-100 text-green-800' },
  limited: { label: 'Спам-блок',      cls: 'bg-red-100 text-red-800' },
  dead:    { label: 'Сессия мертва',  cls: 'bg-gray-200 text-gray-700' },
  unknown: { label: 'Не проверялся',  cls: 'bg-amber-100 text-amber-800' },
}

const STATE: Record<string, string> = {
  new: 'Ждёт имени бота',
  queued: 'В очереди',
  running: 'Настраивается',
  awaiting_user: 'Ждём клиента',
  done: 'Готово',
  expired: 'Сгорело',
  failed: 'Сорвалось',
}

export default function AdminTgSetupPage() {
  const [tab, setTab] = useState<'accounts' | 'orders' | 'service'>('accounts')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [service, setService] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [checkingId, setCheckingId] = useState<number | null>(null)

  async function load() {
    setLoading(true); setError('')
    try {
      const [a, o, s] = await Promise.all([
        adminFetch('/api/v1/admin/tg-setup/accounts'),
        adminFetch('/api/v1/admin/tg-setup/orders'),
        adminFetch('/api/v1/admin/tg-setup/services'),
      ])
      setAccounts(a.accounts || [])
      setOrders(o.orders || [])
      setService((s.services || []).find((x: any) => x.slug === 'tg_autosetup') || null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function checkAccount(id: number) {
    setCheckingId(id)
    try {
      const r = await adminFetch(`/api/v1/admin/tg-setup/accounts/${id}/check`, { method: 'POST' })
      alert(`Состояние: ${HEALTH[r.health]?.label || r.health}\nБотов на аккаунте: ${r.bots_count}\n\n${r.note || ''}`)
      await load()
    } catch (e: any) {
      alert(`Не удалось проверить: ${e.message}`)
    } finally {
      setCheckingId(null)
    }
  }

  async function removeAccount(a: Account) {
    if (!confirm(`Удалить аккаунт ${a.phone}?`)) return
    try {
      await adminFetch(`/api/v1/admin/tg-setup/accounts/${a.id}`, { method: 'DELETE' })
      await load()
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function toggleComingSoon() {
    if (!service) return
    const next = !service.coming_soon
    const msg = next
      ? 'Скрыть кнопку оплаты? Услуга останется видна с пометкой «СКОРО».'
      : 'Открыть продажу услуги? Клиенты смогут её купить.'
    if (!confirm(msg)) return
    try {
      await adminFetch('/api/v1/admin/tg-setup/services/tg_autosetup', {
        method: 'PATCH', body: JSON.stringify({ coming_soon: next }),
      })
      await load()
    } catch (e: any) {
      alert(e.message)
    }
  }

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-gray-900">Автонастройка Telegram</h1>
        <button onClick={load} className="text-sm text-gray-500 hover:text-gray-900 flex items-center gap-1.5">
          <RefreshCw size={15} /> Обновить
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-6">
        Сервисные аккаунты, от лица которых создаются боты клиентов
      </p>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="flex gap-2 mb-6 border-b border-gray-200">
        {([['accounts', 'Аккаунты'], ['orders', 'Заказы'], ['service', 'Услуга']] as const).map(
          ([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                tab === k ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500'
              }`}>
              {label}
            </button>
          )
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-gray-500 py-8">
          <Loader2 size={16} className="animate-spin" /> Загружаем…
        </div>
      )}

      {/* ─── Аккаунты ─── */}
      {!loading && tab === 'accounts' && (
        <>
          <button onClick={() => setAdding(true)}
                  className="btn-gold px-4 py-2 mb-4 flex items-center gap-1.5">
            <Plus size={16} /> Добавить аккаунт
          </button>

          {!accounts.length && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 px-5 py-8 text-center text-sm text-gray-500">
              Аккаунтов нет. Пока их нет, услуга работать не будет.
            </div>
          )}

          <div className="space-y-3">
            {accounts.map(a => (
              <AccountCard
                key={a.id} account={a}
                checking={checkingId === a.id}
                onCheck={() => checkAccount(a.id)}
                onDelete={() => removeAccount(a)}
                onChanged={load}
              />
            ))}
          </div>
        </>
      )}

      {/* ─── Заказы ─── */}
      {!loading && tab === 'orders' && (
        <>
        {/* ⚠️ Сводка по очереди — сразу над списком. Без неё владелец видел
            только простыню заказов и не понимал, сколько людей ЖДЁТ прямо
            сейчас: очередь упирается в слоты сервисных аккаунтов, и её длина —
            главный признак, что пора добавлять аккаунт.
            Считаем из уже загруженного списка, отдельная ручка не нужна. */}
        <div className="flex flex-wrap gap-3 mb-4">
          {([
            ['В очереди', orders.filter(o => o.setup_state === 'queued').length, '#25455D'],
            ['Настраивается', orders.filter(o => o.setup_state === 'running').length, '#0ea5e9'],
            ['Ждём клиента', orders.filter(o => o.setup_state === 'awaiting_user').length, '#f59e0b'],
            ['Готово', orders.filter(o => o.setup_state === 'done').length, '#16a34a'],
          ] as const).map(([label, value, color]) => (
            <div key={label} className="rounded-xl border border-gray-200 px-4 py-3 min-w-[130px]">
              <div className="text-2xl font-bold" style={{ color }}>{value}</div>
              <div className="text-xs text-gray-500 mt-0.5">{label}</div>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Клиент</th>
                <th className="text-left px-4 py-2.5 font-medium">Бот</th>
                <th className="text-left px-4 py-2.5 font-medium">Состояние</th>
                <th className="text-left px-4 py-2.5 font-medium">Аккаунт</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {orders.map(o => (
                <tr key={o.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{o.client_name}</div>
                    <div className="text-xs text-gray-500">
                      {o.telegram_username || '— нет ника Telegram'}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {o.bot_username ? `@${o.bot_username}` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div>{STATE[o.setup_state] || o.setup_state}</div>
                    <div className="text-xs text-gray-400">
                      {o.status === 'paid' ? 'оплачено' : o.status}
                    </div>
                    {o.setup_error && (
                      <div className="text-xs text-red-600 mt-0.5">{o.setup_error}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{o.account_phone || '—'}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {o.status !== 'paid' && (
                      <button
                        onClick={async () => {
                          if (!confirm('Отметить оплаченным?')) return
                          await adminFetch(`/api/v1/admin/tg-setup/orders/${o.id}/mark-paid`, { method: 'POST' })
                          await load()
                        }}
                        className="text-xs text-gray-600 hover:text-gray-900 mr-3">
                        Оплачен
                      </button>
                    )}
                    {['failed', 'queued'].includes(o.setup_state) && o.status === 'paid' && (
                      <button
                        onClick={async () => {
                          await adminFetch(`/api/v1/admin/tg-setup/orders/${o.id}/retry`, { method: 'POST' })
                          await load()
                        }}
                        className="text-xs text-gray-600 hover:text-gray-900">
                        Повторить
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!orders.length && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  Заказов пока нет
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        </>
      )}

      {/* ─── Услуга ─── */}
      {!loading && tab === 'service' && service && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 max-w-xl">
          <div className="font-semibold text-gray-900">{service.name}</div>
          <div className="text-sm text-gray-500 mt-1">{service.tagline}</div>

          <div className="mt-4 flex items-center gap-3">
            <div className="text-2xl font-bold text-gray-900">{service.price} ₽</div>
            <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
              service.coming_soon ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'
            }`}>
              {service.coming_soon ? 'СКОРО — продажа закрыта' : 'Продаётся'}
            </span>
          </div>

          <p className="text-sm text-gray-500 mt-4">
            {service.coming_soon
              ? 'Карточка услуги видна клиентам с фичей, но кнопки оплаты нет.'
              : 'Клиенты с фичей видят кнопку и могут оплатить.'}
          </p>

          <button onClick={toggleComingSoon} className="btn-primary px-4 py-2 mt-4">
            {service.coming_soon ? 'Открыть продажу' : 'Закрыть продажу («СКОРО»)'}
          </button>

          {!service.leadpay_product_id && !service.prodamus_payment_url && (
            <div className="mt-4 flex gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span>
                Карточка оплаты не настроена — без неё продажу открыть нельзя.
                Заведите товар в LeadPay и впишите его код.
              </span>
            </div>
          )}
        </div>
      )}

      {adding && <AddAccountModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load() }} />}
    </div>
  )
}

/** Карточка аккаунта: телефон, пароль, прокси, слоты, состояние. */
function AccountCard({ account: a, checking, onCheck, onDelete, onChanged }: {
  account: Account; checking: boolean
  onCheck: () => void; onDelete: () => void; onChanged: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const h = HEALTH[a.health] || HEALTH.unknown

  async function uploadSession(file: File) {
    setUploading(true)
    try {
      const token = localStorage.getItem('plusson_admin_token') || localStorage.getItem('plusson_token')
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch(`${API}/api/v1/admin/tg-setup/accounts/${a.id}/session`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd,
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${r.status}`)
      }
      onChanged()
    } catch (e: any) {
      alert(`Не удалось загрузить сессию: ${e.message}`)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-900">+{a.phone}</span>
            {a.username && <span className="text-gray-500 text-sm">@{a.username}</span>}
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${h.cls}`}>{h.label}</span>
            {!a.is_active && (
              <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">выключен</span>
            )}
          </div>
          {a.title && <div className="text-sm text-gray-500 mt-1">{a.title}</div>}

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <Field label="Пароль двухфакторки" value={a.twofa_password || '— не задан'} mono />
            <Field label="Слоты"
                   value={`${a.busy_slots} занято из ${a.max_slots} · свободно ${a.free_slots}`} />
            <Field label="Прокси" value={a.proxy ? shortProxy(a.proxy) : '— без прокси'} mono />
            <Field
              label="Файл сессии"
              value={a.session_exists ? 'на месте' : '— не загружен'}
              warn={!a.session_exists}
            />
          </div>

          {a.health_note && (
            <div className="mt-2 text-xs text-gray-400 line-clamp-2">{a.health_note}</div>
          )}
        </div>

        <div className="flex flex-col gap-1.5 shrink-0">
          <button onClick={onCheck} disabled={checking}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 hover:border-gray-400 flex items-center gap-1.5">
            {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Проверить
          </button>
          <button onClick={() => fileRef.current?.click()} disabled={uploading}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 hover:border-gray-400 flex items-center gap-1.5">
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            Сессия
          </button>
          <button onClick={onDelete}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-red-600 hover:border-red-300 flex items-center gap-1.5">
            <Trash2 size={13} /> Удалить
          </button>
          <input ref={fileRef} type="file" accept=".session" className="hidden"
                 onChange={e => { const f = e.target.files?.[0]; if (f) uploadSession(f) }} />
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, mono, warn }: {
  label: string; value: string; mono?: boolean; warn?: boolean
}) {
  return (
    <div>
      <div className="text-xs text-gray-400">{label}</div>
      <div className={`${mono ? 'font-mono text-xs' : ''} ${warn ? 'text-amber-700' : 'text-gray-700'} truncate`}>
        {value}
      </div>
    </div>
  )
}

/** Прокси показываем без пароля — строка длинная и в ней логин с паролем. */
function shortProxy(p: string): string {
  const m = p.match(/@([^:/\[]+):(\d+)/)
  return m ? `${m[1]}:${m[2]}` : p.slice(0, 40)
}

function AddAccountModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [phone, setPhone] = useState('')
  const [title, setTitle] = useState('')
  const [twofa, setTwofa] = useState('')
  const [proxy, setProxy] = useState('')
  const [slots, setSlots] = useState(5)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await adminFetch('/api/v1/admin/tg-setup/accounts', {
        method: 'POST',
        body: JSON.stringify({
          phone, title: title || null, twofa_password: twofa || null,
          proxy: proxy || null, max_slots: slots,
        }),
      })
      onSaved()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    // ⚠️ Клик по затемнению НЕ закрывает окно — иначе теряются введённые данные.
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg text-gray-900">Новый сервисный аккаунт</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={20} /></button>
        </div>

        <div className="space-y-3">
          <Input label="Телефон" value={phone} onChange={setPhone} placeholder="998700388279" />
          <Input label="Пометка" value={title} onChange={setTitle} placeholder="Узбекистан, партия 02.09" />
          <Input label="Пароль двухфакторки" value={twofa} onChange={setTwofa}
                 hint="Нужен, чтобы передавать ботов клиентам" />
          <Input label="Прокси" value={proxy} onChange={setProxy}
                 placeholder="socks5://логин:пароль@хост:порт"
                 hint="Иностранному номеру прокси обязателен" />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Слотов</label>
            <input type="number" min={1} max={20} value={slots}
                   onChange={e => setSlots(+e.target.value)}
                   className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <p className="text-xs text-gray-400 mt-1">
              Сколько непереданных ботов держим одновременно
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-900">
          После создания загрузите файл сессии Telethon. ⚠️ Аккаунт не должен
          использоваться где-то ещё (например в мейлере) — Telegram сломает ключ,
          если одна сессия работает с двух серверов.
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="btn-primary flex-1 py-2.5">Отмена</button>
          <button onClick={save} disabled={saving || !phone} className="btn-gold flex-1 py-2.5">
            {saving ? 'Сохраняем…' : 'Добавить'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Input({ label, value, onChange, placeholder, hint }: {
  label: string; value: string; onChange: (v: string) => void
  placeholder?: string; hint?: string
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
             className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-400" />
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}
