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
import { useEffect, useRef, useState, Suspense } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import {
  AlertTriangle, Check, HelpCircle, Loader2, PauseCircle, PlayCircle, Plus,
  RefreshCw, KeyRound, Settings2, Trash2, Upload, X,
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
  /** Сколько ботов создаём за сутки. 0 или null — без ограничения. */
  daily_bot_limit: number | null
  /** Пауза в минутах после предыдущего создания. 0 или null — без паузы. */
  min_create_gap_min: number | null
  last_bot_created_at: string | null
  bots_created_total: number
  made_today: number
  transferred_total: number
  cooldown_until: string | null
  /** Почему аккаунт сейчас не берёт заказы — считает БЭКЕНД (см. list_accounts). */
  blocked_reasons: string[]
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
  // ⚠️ «Сорвалось» читалось как «всё пропало, заказ мёртвый» — и его
  // откладывали. На деле остановка почти всегда упирается в одно действие
  // клиента (открыть приватность, зайти в бота), а у него на экране есть
  // кнопка «Доделать настройку». Называем состояние тем, чем оно является.
  failed: 'Можно доделать',
}


// ⚠️⚠️ ОБЯЗАТЕЛЬНАЯ ОБЁРТКА. У страницы нет динамического сегмента, поэтому
// Next пререндерит её на сборке, а `useUrlTab` читает адрес (`useSearchParams`)
// — на пререндеренной странице это требует <Suspense>, иначе падает сборка
// ВСЕГО проекта. ⚠️ `tsc` такую ошибку не ловит, только сборка.
export default function AdminTgSetupPage() {
  return (
    <Suspense fallback={null}>
      <AdminTgSetupPageInner />
    </Suspense>
  )
}

function AdminTgSetupPageInner() {
  const [tab, setTab] = useUrlTab<'accounts' | 'orders' | 'service'>('tab', 'accounts', ['accounts', 'orders', 'service'])
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
  const bundleRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [togglingActive, setTogglingActive] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const h = HEALTH[a.health] || HEALTH.unknown

  /** Включить/выключить аккаунт для выдачи ботов.
   *
   * ⚠️ Спрашиваем подтверждение только при ВЫКЛЮЧЕНИИ и называем последствие:
   * если это последний живой аккаунт, заказы встанут в очередь и будут ждать,
   * а не отвалятся с ошибкой. Человек должен понимать, что именно он делает.
   */
  async function onToggleActive() {
    const next = !a.is_active
    if (!next && !confirm(
      `Выключить +${a.phone}? Новые боты на нём создаваться не будут — `
      + 'заказы уйдут на другие аккаунты, а если свободных нет, встанут в '
      + 'очередь до включения. Уже созданные боты клиенты заберут как обычно.'
    )) return
    setTogglingActive(true)
    try {
      await adminFetch(`/api/v1/admin/tg-setup/accounts/${a.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: next }),
      })
      onChanged()
    } catch (e: any) {
      alert(`Не удалось переключить: ${e.message}`)
    } finally {
      setTogglingActive(false)
    }
  }

  /** Загружает КОМПЛЕКТ продавца: zip / .session / .json / twoFA.txt.
   *
   * ⚠️ Файлов может быть несколько и сразу на несколько номеров — бэкенд
   * разберёт и ответит по каждому отдельно. Показываем построчно: молчаливое
   * «готово» скрыло бы, что половина комплектов мёртвая.
   */
  async function uploadBundle(files: File[]) {
    setUploading(true)
    try {
      const token = localStorage.getItem('plusson_admin_token') || localStorage.getItem('plusson_token')
      const fd = new FormData()
      files.forEach(f => fd.append('files', f))
      const r = await fetch(`${API}/api/v1/admin/tg-setup/accounts/upload-bundle`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd,
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`)
      const lines = (data.results || []).map((x: any) =>
        `${x.ok ? '✅' : '❌'} +${x.phone} — ${x.note}${x.twofa_found ? ' · пароль из комплекта' : ''}`)
      const errs = (data.errors || []).map((e: string) => `⚠️ ${e}`)
      alert([...lines, ...errs].join('\n') || 'Ничего не нашлось')
      onChanged()
    } catch (e: any) {
      alert(`Не удалось загрузить комплект: ${e.message}`)
    } finally {
      setUploading(false)
    }
  }

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
            <Field label="Ботов ждут получателя"
                   value={`${a.busy_slots} из ${a.max_slots} · свободно ${a.free_slots}`}
                   help={"Боты, которых уже создали, но клиенты ещё не забрали. Забрал — место освободилось.\n\n" +
                         "Все места заняты → аккаунт не берёт новые заказы."} />
            <Field label="Прокси"
                   value={a.proxy ? shortProxy(a.proxy) : '— без прокси'}
                   mono
                   /* ⚠️ Иностранному номеру прокси обязателен: без него вход
                      идёт с российского IP, и Telegram блокирует аккаунт.
                      Российский номер (+7) в прокси не нуждается. */
                   warn={!a.proxy && !a.phone.startsWith('7')} />
            <Field
              label="Файл сессии"
              value={a.session_exists ? 'на месте' : '— не загружен'}
              warn={!a.session_exists}
            />
            <Field label="Ботов за сутки"
                   value={a.daily_bot_limit
                     ? `${a.made_today} из ${a.daily_bot_limit}`
                     : `${a.made_today} · без лимита`}
                   warn={!!a.daily_bot_limit && a.made_today >= a.daily_bot_limit} />
            <Field label="Пауза между ботами"
                   value={a.min_create_gap_min
                     ? `${a.min_create_gap_min} мин`
                     : '— без паузы'} />
            <Field label="Создано всего"
                   value={`${a.bots_created_total} · передано ${a.transferred_total}`} />
          </div>

          {/* ⚠️ Причины считает БЭКЕНД (list_accounts), а не браузер: правила
              живут в `_pick_account`, и вторая копия условий здесь разъехалась
              бы с очередью. Человек видит ровно ту причину, по которой очередь
              пропускает аккаунт. */}
          {a.blocked_reasons?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {a.blocked_reasons.map((r, i) => (
                <span key={i}
                      className="px-2 py-0.5 rounded text-xs bg-amber-50 text-amber-800 border border-amber-200">
                  {r}
                </span>
              ))}
            </div>
          )}

          {a.health_note && (
            <div className="mt-2 text-xs text-gray-400 line-clamp-2">{a.health_note}</div>
          )}
        </div>

        <div className="flex flex-col gap-1.5 shrink-0">
          {/* ⚠️ Рычаг «выдавать ботов / не выдавать» — на случай, когда аккаунт
              нельзя трогать прямо сейчас (выступление, демонстрация, разбор
              проблемы). Выключённый аккаунт очередь не берёт вовсе
              (`_pick_account`: WHERE is_active = TRUE), а остальные продолжают
              работать — заказы просто уходят к ним.
              ⚠️ Уже созданные и ещё не переданные боты выключение НЕ трогает:
              их слоты остаются занятыми, клиенты забирают их как обычно. */}
          <button onClick={onToggleActive} disabled={togglingActive}
                  className={`text-xs px-3 py-1.5 rounded-lg border flex items-center gap-1.5 ${
                    a.is_active
                      ? 'border-gray-200 hover:border-amber-300 text-amber-700'
                      : 'border-green-300 text-green-700 hover:border-green-400'}`}>
            {togglingActive
              ? <Loader2 size={13} className="animate-spin" />
              : (a.is_active ? <PauseCircle size={13} /> : <PlayCircle size={13} />)}
            {a.is_active ? 'Выключить' : 'Включить'}
          </button>
          {/* Подпись под кнопкой: человек должен понимать, что выключение
              значит «не участвует в создании ботов», а не «удалён». */}
          <div className="text-[10px] text-gray-400 leading-tight max-w-[110px]">
            {a.is_active
              ? 'участвует в создании ботов'
              : 'в создании ботов не участвует'}
          </div>
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
          {/* ⚠️ Отдельно от «Сессии»: там один голый .session, здесь — весь
              комплект продавца (zip с .session, .json и twoFA.txt). Пароль
              двухфакторки из комплекта подставляется сам. */}
          <button onClick={() => bundleRef.current?.click()} disabled={uploading}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 hover:border-gray-400 flex items-center gap-1.5">
            <Upload size={13} /> Комплект
          </button>
          {/* ⚠️ Единственный способ вернуть аккаунт с аннулированным ключом:
              файлом такой не чинится, только вход с кодом из SMS. */}
          <button onClick={() => setLoginOpen(true)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 hover:border-gray-400 flex items-center gap-1.5">
            <KeyRound size={13} /> Войти по коду
          </button>
          <button onClick={() => setEditOpen(true)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 hover:border-gray-400 flex items-center gap-1.5">
            <Settings2 size={13} /> Лимиты
          </button>
          <button onClick={onDelete}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-red-600 hover:border-red-300 flex items-center gap-1.5">
            <Trash2 size={13} /> Удалить
          </button>
          <input ref={fileRef} type="file" accept=".session" className="hidden"
                 onChange={e => { const f = e.target.files?.[0]; if (f) uploadSession(f) }} />
          <input ref={bundleRef} type="file" multiple
                 accept=".zip,.session,.json,.txt" className="hidden"
                 onChange={e => {
                   const fs = Array.from(e.target.files || [])
                   if (fs.length) uploadBundle(fs)
                   e.target.value = ''
                 }} />
        </div>
      </div>

      {loginOpen && (
        <LoginByCodeModal phone={a.phone} proxy={a.proxy}
                          onClose={() => setLoginOpen(false)}
                          onDone={() => { setLoginOpen(false); onChanged() }} />
      )}
      {editOpen && (
        <EditLimitsModal account={a}
                         onClose={() => setEditOpen(false)}
                         onSaved={() => { setEditOpen(false); onChanged() }} />
      )}
    </div>
  )
}

function Field({ label, value, mono, warn, help }: {
  label: string; value: string; mono?: boolean; warn?: boolean; help?: string
}) {
  return (
    <div>
      <div className="text-xs text-gray-400">{label}{help && <Hint text={help} />}</div>
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
  // ⚠️ 0 = «без ограничения». Дефолты осторожные: BotFather даёт 17 часов
  // отдыха после десятка ботов подряд, и на трёх аккаунтах это происходит
  // за минуты. Лучше медленнее, чем всё встало.
  const [dailyLimit, setDailyLimit] = useState(7)
  const [gapMin, setGapMin] = useState(60)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await adminFetch('/api/v1/admin/tg-setup/accounts', {
        method: 'POST',
        body: JSON.stringify({
          phone, title: title || null, twofa_password: twofa || null,
          proxy: proxy || null, max_slots: slots,
          daily_bot_limit: dailyLimit || 0, min_create_gap_min: gapMin || 0,
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

          {/* ⚠️ Три ограничителя про РАЗНОЕ, поэтому поля отдельные:
              слоты — сколько висит непереданными;
              суточный лимит — сколько создаём за сутки;
              пауза — как часто. У BotFather нарастающий лимит, и без двух
              последних три аккаунта ложатся разом на 17 часов. */}
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Новых ботов в сутки
              </label>
              <input type="number" min={0} max={50} value={dailyLimit}
                     onChange={e => setDailyLimit(+e.target.value)}
                     className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              <p className="text-xs text-gray-400 mt-1">
                Сколько ботов аккаунт создаёт за 24 часа. 0 — без ограничения.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Пауза между ботами, минут
              </label>
              <input type="number" min={0} max={720} value={gapMin}
                     onChange={e => setGapMin(+e.target.value)}
                     className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              <p className="text-xs text-gray-400 mt-1">
                Сколько ждать после создания бота перед следующим. 0 — без паузы.
              </p>
            </div>
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

/** Мастер входа по коду из SMS: телефон → код → облачный пароль.
 *
 * ⚠️⚠️ ЕДИНСТВЕННЫЙ способ вернуть аккаунт с аннулированным ключом
 * (`AuthKeyDuplicatedError`). Файлом такой не чинится: Telegram отзывает ключ
 * у САМОГО АККАУНТА, и даже исходная сессия от продавца перестаёт работать.
 *
 * ⚠️ Шаги — отдельные запросы, но клиент Telethon между ними живёт на сервере
 * (см. `tg_account_connect`). Поэтому окно нельзя просто закрыть: уходя,
 * сообщаем серверу отменить вход, иначе клиент повиснет в памяти.
 */
function LoginByCodeModal({ phone, proxy, onClose, onDone }: {
  phone: string; proxy: string | null
  onClose: () => void; onDone: () => void
}) {
  const [step, setStep] = useState<'start' | 'code' | 'password'>('start')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function call(path: string, body: any) {
    setBusy(true); setMsg('')
    try {
      const r = await adminFetch(`/api/v1/admin/tg-setup/accounts/login/${path}`, {
        method: 'POST', body: JSON.stringify(body),
      })
      return r
    } catch (e: any) {
      setMsg(e.message || 'Не получилось')
      return null
    } finally {
      setBusy(false)
    }
  }

  async function sendCode() {
    const r = await call('start', { phone, proxy })
    if (!r) return
    if (r.status === 'already') {
      setMsg('Аккаунт и так подключён — вход не нужен')
      setTimeout(onDone, 1200)
    } else if (r.status === 'code_sent') {
      setStep('code')
      setMsg('Код отправлен в Telegram на этот номер')
    } else {
      setMsg(r.msg || 'Не удалось запросить код')
    }
  }

  async function sendStep(path: 'code' | 'password', value: string) {
    const r = await call(path, { phone, value })
    if (!r) return
    if (r.status === 'ok') {
      setMsg('Готово — аккаунт подключён')
      setTimeout(onDone, 900)
    } else if (r.status === 'need_password') {
      setStep('password')
      setMsg('Нужен облачный пароль (двухфакторка)')
    } else {
      setMsg(r.msg || 'Не подошло')
    }
  }

  /** ⚠️ Уходя — отменяем вход на сервере: иначе клиент Telethon повиснет. */
  function close() {
    adminFetch('/api/v1/admin/tg-setup/accounts/login/cancel', {
      method: 'POST', body: JSON.stringify({ phone }),
    }).catch(() => {})
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg text-gray-900">Вход по коду</h3>
          <button onClick={close} className="text-gray-400 hover:text-gray-700">
            <X size={20} />
          </button>
        </div>

        <div className="text-sm text-gray-600 mb-4">
          Номер <span className="font-mono">+{phone}</span>
          {!proxy && !phone.startsWith('7') && (
            <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
              У иностранного номера не задан прокси — вход пойдёт с российского
              адреса, и Telegram может заблокировать аккаунт. Сначала укажите прокси.
            </div>
          )}
        </div>

        {step === 'start' && (
          <button onClick={sendCode} disabled={busy}
                  className="btn-gold w-full py-2.5">
            {busy ? 'Запрашиваем…' : 'Запросить код'}
          </button>
        )}

        {step === 'code' && (
          <div className="space-y-3">
            <Input label="Код из Telegram" value={code} onChange={setCode}
                   placeholder="12345"
                   hint="Код приходит в приложение Telegram, не в SMS" />
            <button onClick={() => sendStep('code', code)} disabled={busy || !code}
                    className="btn-gold w-full py-2.5">
              {busy ? 'Проверяем…' : 'Подтвердить'}
            </button>
          </div>
        )}

        {step === 'password' && (
          <div className="space-y-3">
            <Input label="Облачный пароль" value={password} onChange={setPassword}
                   hint="Он же нужен для передачи ботов — сохраним его в карточке" />
            <button onClick={() => sendStep('password', password)}
                    disabled={busy || !password} className="btn-gold w-full py-2.5">
              {busy ? 'Входим…' : 'Войти'}
            </button>
          </div>
        )}

        {msg && <p className="mt-3 text-sm text-gray-700">{msg}</p>}
      </div>
    </div>
  )
}

/** Правка ограничителей у существующего аккаунта.
 *
 * ⚠️ Три поля про РАЗНОЕ, поэтому и правятся раздельно:
 * слоты — сколько ботов висит непереданными; суточный лимит — сколько создаём
 * за сутки; пауза — как часто. Первое про Telegram-лимит на аккаунт, два
 * других — наша страховка от нарастающего лимита BotFather.
 */
function EditLimitsModal({ account: a, onClose, onSaved }: {
  account: Account; onClose: () => void; onSaved: () => void
}) {
  const [slots, setSlots] = useState(a.max_slots)
  const [daily, setDaily] = useState(a.daily_bot_limit ?? 0)
  const [gap, setGap] = useState(a.min_create_gap_min ?? 0)
  const [proxy, setProxy] = useState(a.proxy || '')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await adminFetch(`/api/v1/admin/tg-setup/accounts/${a.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          max_slots: slots, daily_bot_limit: daily,
          min_create_gap_min: gap, proxy: proxy || null,
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg text-gray-900">Ограничители +{a.phone}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-3">
          {/* ⚠️ Три числа про РАЗНОЕ, и подписи обязаны это объяснять: без них
              «слоты» и «в сутки» читаются как одно и то же (вопрос владельца
              15.09.2026). Слоты — сколько ботов лежит НЕВОСТРЕБОВАННЫМИ прямо
              сейчас (освобождается, когда клиент забрал); в сутки — сколько
              СОЗДАЛИ за день (не обнуляется передачей). */}
          <div className="space-y-3">
            <NumField label="Ботов ждут получателя"
                      value={slots} onChange={setSlots} min={1} max={20}
                      help={"Это как полки для готовых заказов.\n\n" +
                            "Бот создан, но клиент ещё не забрал его — бот лежит и ждёт, место занято. " +
                            "Клиент забрал (написал боту и принял права) — место освободилось.\n\n" +
                            "Все места заняты → аккаунт не берёт новые заказы, пока кто-нибудь не заберёт своего бота.\n\n" +
                            "Например 1 — очередь строго по одному: следующий заказ не начнётся, пока предыдущий клиент не забрал бота. " +
                            "5 — пятеро могут ждать одновременно.\n\n" +
                            "Ноль поставить нельзя: боту негде было бы лежать. Чтобы аккаунт не работал вовсе, выключите его галочкой «участвует в создании ботов».\n\n" +
                            "Зачем ограничение: Telegram не разрешает держать на одном аккаунте много ботов."} />
            <NumField label="Новых ботов в сутки"
                      value={daily} onChange={setDaily} min={0} max={50}
                      help={"Сколько ботов аккаунт создаёт за 24 часа. 0 — без ограничения.\n\n" +
                            "Чем отличается от «ботов ждут получателя»: там — сколько лежит невостребованными прямо сейчас (освобождается, когда клиент забрал). " +
                            "Здесь — сколько СОЗДАЛИ за день, и передача бота это число не уменьшает.\n\n" +
                            "Зачем: у BotFather нарастающий запрет. Несколько ботов подряд — «подожди 2 минуты», десяток — «подожди 17 часов». " +
                            "Ограничение не даёт подойти к этой грани."} />
            <NumField label="Пауза между ботами, минут"
                      value={gap} onChange={setGap} min={0} max={720}
                      help={"Сколько минут ждать после создания бота, прежде чем делать следующего. 0 — без паузы.\n\n" +
                            "Та же цель, что у суточного лимита: не частить, чтобы BotFather не выдал долгий запрет."} />
          </div>
          <Input label="Прокси" value={proxy} onChange={setProxy}
                 placeholder="socks5://логин:пароль@хост:порт"
                 hint="Иностранному номеру обязателен" />
        </div>

        <div className="mt-4 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-xs text-gray-600">
          Сейчас создано за сутки: <b>{a.made_today}</b>
          {a.daily_bot_limit ? ` из ${a.daily_bot_limit}` : ' (без лимита)'}.
          Всего за жизнь аккаунта: <b>{a.bots_created_total}</b>, из них передано
          клиентам <b>{a.transferred_total}</b>.
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="btn-primary flex-1 py-2.5">Отмена</button>
          <button onClick={save} disabled={saving} className="btn-gold flex-1 py-2.5">
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Вопросик с подсказкой по наведению.
 *
 * ⚠️ Длинные объяснения под полем делают форму нечитаемой, а без них человек
 * не понимает, чем «слоты» отличаются от «в сутки» (вопрос владельца
 * 15.09.2026). Поэтому объяснение прячется под знак вопроса.
 *
 * Вид тот же, что у критериев турнира — второго стиля подсказок в проекте
 * быть не должно.
 */
function Hint({ text }: { text: string }) {
  return (
    <span className="ml-1 relative inline-flex align-middle text-gray-300 hover:text-gray-500 cursor-help group/qm">
      <HelpCircle size={13} />
      <span className="invisible opacity-0 group-hover/qm:visible group-hover/qm:opacity-100 transition-opacity absolute z-50 top-full left-0 mt-1 w-72 bg-[#1f2d3a] text-white text-[11px] font-normal normal-case leading-snug text-left whitespace-pre-line rounded-lg px-3 py-2 shadow-xl pointer-events-none">
        {text}
      </span>
    </span>
  )
}

function NumField({ label, value, onChange, hint, help, min, max }: {
  label: string; value: number; onChange: (v: number) => void
  hint?: string; help?: string; min?: number; max?: number
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}{help && <Hint text={help} />}
      </label>
      <input type="number" min={min} max={max} value={value}
             onChange={e => onChange(+e.target.value)}
             className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
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
