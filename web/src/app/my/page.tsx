'use client'

/**
 * Кабинет купившего (миграция 290) — `/my`.
 *
 * ⚠️ В границах КЛИЕНТА: человек видит продукты, купленные у ЭТОГО клиента.
 * Так же устроен аккаунт GetCourse. Купил у другого организатора ПЛЮСОНа —
 * это другой адрес и другой список.
 *
 * Вход по коду на почту, как в кабинете спикера: пароля у покупателя нет и
 * заводить его незачем — он заходит редко и всё равно забудет.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, Handshake, LifeBuoy, LogOut, User } from 'lucide-react'
import CabinetBrand, { type Brand } from '@/components/products/CabinetBrand'
import PartnerCabinet from './PartnerCabinet'

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''
const TOKEN_KEY = 'product_cabinet_token'

export default function CabinetPage() {
  const [token, setToken] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY))
    setReady(true)
  }, [])

  if (!ready) return null

  return token
    ? <CabinetList token={token} onLogout={() => {
        localStorage.removeItem(TOKEN_KEY)
        setToken(null)
      }} />
    : <LoginForm onLogged={(t) => {
        localStorage.setItem(TOKEN_KEY, t)
        setToken(t)
      }} />
}

/* ─────────────────────────────── Вход ───────────────────────────────────── */

function LoginForm({ onLogged }: { onLogged: (token: string) => void }) {
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const clientId = () =>
    new URLSearchParams(window.location.search).get('client_id')

  const requestCode = async () => {
    setBusy(true); setError('')
    try {
      // ⚠️ Партнёрский эндпоинт, а не product-cabinet: тот шлёт код только
      // тому, кто ЧТО-ТО КУПИЛ, а партнёр может не купить ничего — он продаёт.
      // Кабинет один на обоих (№ 30), значит и вход должен пускать обоих.
      const res = await fetch(`${apiBase}/api/v1/public/partner/request-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), client_id: clientId() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.detail || 'Не получилось')
      // ⚠️ Письма может не быть — на этой почте нет доступа. Тогда НЕ уводим
      // на экран ввода кода: человек сидел бы и ждал письмо, которого нет
      // (так владелец не мог войти в свой кабинет, прод 07.09.2026). Причина
      // почти всегда — описка в адресе: точка, лишняя буква, раскладка.
      if (data?.sent === false) {
        setError(data?.message || 'На этой почте нет доступа в кабинет.')
        return
      }
      setStep('code')
    } catch (e: any) {
      setError(e?.message || 'Что-то пошло не так')
    } finally { setBusy(false) }
  }

  const auth = async () => {
    setBusy(true); setError('')
    try {
      const res = await fetch(`${apiBase}/api/v1/public/product-cabinet/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(), code: code.trim(), client_id: clientId(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.detail || 'Код не подошёл')
      onLogged(data.token)
    } catch (e: any) {
      setError(e?.message || 'Что-то пошло не так')
    } finally { setBusy(false) }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-xl font-bold text-gray-900">Вход</h1>
        <p className="mb-5 text-sm text-gray-500">
          {step === 'email'
            // ⚠️ Не «почту от заказа»: в этот кабинет входят и партнёры,
            // которые ничего не покупали. Формулировка про заказ ставила их
            // в тупик — «какой заказ?».
            ? 'Введите вашу почту — пришлём код для входа.'
            : 'Код отправлен. Он действует 15 минут.'}
        </p>

        {step === 'email' ? (
          <div className="space-y-3">
            <input
              value={email} onChange={e => setEmail(e.target.value)}
              type="email" placeholder="Почта"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              onClick={requestCode}
              disabled={busy || !email.includes('@')}
              className="btn-gold w-full"
            >
              {busy ? 'Отправляем…' : 'Получить код'}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <input
              value={code} onChange={e => setCode(e.target.value)}
              inputMode="numeric" placeholder="Код из письма"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-center text-lg tracking-widest"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button onClick={auth} disabled={busy || code.trim().length < 4}
                    className="btn-gold w-full">
              {busy ? 'Проверяем…' : 'Войти'}
            </button>
            <button onClick={() => { setStep('email'); setCode(''); setError('') }}
                    className="w-full text-sm text-gray-500 hover:text-gray-700">
              Ввести другую почту
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ───────────────────────────── Список ───────────────────────────────────── */

function CabinetList({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [list, setList] = useState<any[]>([])
  const [brand, setBrand] = useState<Brand | null>(null)
  const [loading, setLoading] = useState(true)
  const [expired, setExpired] = useState(false)
  // Партнёрка — раздел ТОГО ЖЕ кабинета (решение № 30), а не отдельный вход.
  const [tab, setTab] =
    useState<'materials' | 'partner' | 'support' | 'profile'>('materials')

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/v1/public/product-cabinet/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.status === 401) { setExpired(true); return }
        const data = await res.json()
        setList(data.products || [])
        setBrand(data.brand || null)
      } finally { setLoading(false) }
    })()
  }, [token])

  if (expired) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="text-center">
          <p className="mb-4 text-gray-600">Сессия истекла</p>
          <button onClick={onLogout} className="btn-gold">Войти заново</button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">Загружаем…</p>
      </div>
    )
  }

  // ⚠️ Цвета кабинета — ТЕМА КЛИЕНТА (`clients.lp_*`), как на его лендингах:
  // человек купил у конкретного эксперта, и кабинет должен быть его, а не
  // безымянным серым. Где у нас тёмно-синее меню — там фон клиента, где
  // персиковый акцент — его акцент, белое остаётся белым.
  const c1 = brand?.lp_bg_color || '#25455D'
  const c2 = brand?.lp_bg_color_2 || '#0a1520'
  const accent = brand?.lp_color_heading || '#FFCFA4'
  const navBg = `linear-gradient(160deg, ${c1}, ${c2})`

  const NAV = [
    { key: 'materials', label: 'Мои материалы', icon: BookOpen },
    { key: 'partner', label: 'Партнёрский кабинет', icon: Handshake },
    { key: 'support', label: 'Поддержка', icon: LifeBuoy },
    { key: 'profile', label: 'Мой профиль', icon: User },
  ] as const

  const NavList = ({ onPick }: { onPick?: () => void }) => (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ key, label, icon: Icon }) => {
        const on = tab === key
        return (
          <button
            key={key}
            onClick={() => { setTab(key as any); onPick?.() }}
            className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition"
            style={on
              ? { background: 'rgba(255,255,255,.14)', color: accent, fontWeight: 600 }
              : { color: 'rgba(255,255,255,.78)' }}
          >
            <Icon size={17} className="shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        )
      })}
      {/* ⚠️ «Выйти» — пункт меню, а не мелкая ссылка в углу: человек ищет
          выход там же, где остальные разделы. */}
      <button
        onClick={onLogout}
        className="mt-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition"
        style={{ color: 'rgba(255,255,255,.55)' }}
      >
        <LogOut size={17} className="shrink-0" />
        <span>Выйти</span>
      </button>
    </nav>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      <CabinetBrand brand={brand} />

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:flex-row md:py-10">
        {/* Меню слева — на телефоне уезжает наверх и прокручивается вбок. */}
        <aside className="w-full shrink-0 md:w-64">
          <div className="rounded-2xl p-3 shadow-sm" style={{ background: navBg }}>
            <NavList />
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          {tab === 'materials' && (
            <>
              <h1 className="mb-5 text-2xl font-bold text-gray-900">Мои материалы</h1>
              {!list.length && (
                <p className="text-sm text-gray-500">
                  Здесь появится всё, к чему у вас открыт доступ.
                </p>
              )}
              <div className="space-y-3">
                {list.map(p => (
                  <Link
                    key={p.id}
                    href={`/my/${p.slug}`}
                    className="flex items-center gap-4 rounded-2xl bg-white p-4 shadow-sm transition hover:shadow-md"
                  >
                    {p.cover_url && (
                      <img src={p.cover_url} alt=""
                           className="h-16 w-16 shrink-0 rounded-xl object-cover" />
                    )}
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-900">{p.title}</div>
                      {p.subtitle && (
                        <div className="truncate text-sm text-gray-500">{p.subtitle}</div>
                      )}
                      <div className="mt-0.5 text-xs text-gray-400">
                        {p.tariff_title || 'Доступ открыт'}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </>
          )}

          {tab === 'partner' && (
            <>
              <h1 className="mb-5 text-2xl font-bold text-gray-900">
                Партнёрский кабинет
              </h1>
              <PartnerCabinet token={token} />
            </>
          )}

          {tab === 'support' && <SupportTab token={token} accent={accent} />}
          {tab === 'profile' && <ProfileTab token={token} />}
        </section>
      </div>
    </div>
  )
}

/* ───────────────────────────── Поддержка ────────────────────────────────── */

function SupportTab({ token, accent }: { token: string; accent: string }) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/v1/public/product-cabinet/me/support`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) setData(await res.json())
      } finally { setLoading(false) }
    })()
  }, [token])

  const items: any[] = data?.items || []

  return (
    <>
      <h1 className="mb-2 text-2xl font-bold text-gray-900">Поддержка</h1>
      <p className="mb-5 text-sm text-gray-600">
        Напишите нам удобным способом — ответим{data?.brand ? ` от «${data.brand}»` : ''}.
      </p>

      {loading ? (
        <p className="text-sm text-gray-400">Загружаем…</p>
      ) : !items.length ? (
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-gray-500 shadow-sm">
          Контакты поддержки пока не указаны.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map(it => (
            <a
              key={it.kind} href={it.url} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm transition hover:shadow-md"
            >
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold"
                style={{ background: accent, color: '#0a1520' }}
              >
                {it.kind === 'telegram' ? 'TG' : it.kind === 'vk' ? 'VK' : 'MAX'}
              </span>
              <span className="min-w-0">
                <span className="block font-semibold text-gray-900">{it.label}</span>
                <span className="block text-xs text-gray-500">Написать в поддержку</span>
              </span>
            </a>
          ))}
        </div>
      )}
    </>
  )
}

/* ───────────────────────────── Мой профиль ──────────────────────────────── */

function ProfileTab({ token }: { token: string }) {
  const [me, setMe] = useState<any>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  // Смена почты — отдельным шагом, с подтверждением кодом на НОВЫЙ адрес.
  const [newEmail, setNewEmail] = useState('')
  const [emailStep, setEmailStep] = useState<'idle' | 'code'>('idle')
  const [emailCode, setEmailCode] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailErr, setEmailErr] = useState('')

  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const load = async () => {
    const res = await fetch(`${apiBase}/api/v1/public/product-cabinet/me/profile/data`,
                            { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return
    const d = await res.json()
    setMe(d); setName(d.name || ''); setPhone(d.phone || '')
  }
  useEffect(() => { load() }, [token])

  const save = async () => {
    setBusy(true); setErr(''); setMsg('')
    try {
      const res = await fetch(`${apiBase}/api/v1/public/product-cabinet/me/profile`, {
        method: 'PATCH', headers: auth,
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() }),
      })
      if (!res.ok) throw new Error((await res.json())?.detail || 'Не сохранилось')
      setMsg('Сохранено'); load()
    } catch (e: any) { setErr(e?.message || 'Что-то пошло не так') }
    finally { setBusy(false) }
  }

  const requestEmail = async () => {
    setEmailBusy(true); setEmailErr('')
    try {
      const res = await fetch(`${apiBase}/api/v1/public/product-cabinet/me/email/request`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ email: newEmail.trim() }),
      })
      if (!res.ok) throw new Error((await res.json())?.detail || 'Не получилось')
      setEmailStep('code')
    } catch (e: any) { setEmailErr(e?.message || 'Что-то пошло не так') }
    finally { setEmailBusy(false) }
  }

  const confirmEmail = async () => {
    setEmailBusy(true); setEmailErr('')
    try {
      const res = await fetch(`${apiBase}/api/v1/public/product-cabinet/me/email/confirm`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ email: newEmail.trim(), code: emailCode.trim() }),
      })
      if (!res.ok) throw new Error((await res.json())?.detail || 'Код не подошёл')
      setEmailStep('idle'); setNewEmail(''); setEmailCode('')
      setMsg('Почта изменена'); load()
    } catch (e: any) { setEmailErr(e?.message || 'Что-то пошло не так') }
    finally { setEmailBusy(false) }
  }

  const field = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm'

  return (
    <>
      <h1 className="mb-5 text-2xl font-bold text-gray-900">Мой профиль</h1>

      <div className="mb-4 rounded-2xl bg-white p-5 shadow-sm">
        <label className="mb-1 block text-sm font-medium text-gray-700">Имя</label>
        <input value={name} onChange={e => setName(e.target.value)} className={`${field} mb-4`} />

        <label className="mb-1 block text-sm font-medium text-gray-700">Телефон</label>
        <input value={phone} onChange={e => setPhone(e.target.value)}
               placeholder="+7…" className={`${field} mb-4`} />

        {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
        {msg && <p className="mb-3 text-sm text-green-700">{msg}</p>}

        <button onClick={save} disabled={busy} className="btn-gold">
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>

      <div className="rounded-2xl bg-white p-5 shadow-sm">
        <label className="mb-1 block text-sm font-medium text-gray-700">Почта</label>
        <p className="mb-3 text-sm text-gray-900">{me?.email || '—'}</p>
        {/* ⚠️ Почта — логин входа, поэтому меняется не «как поле», а с
            подтверждением кодом на НОВЫЙ адрес: опечатка иначе отрезала бы
            человека от купленного навсегда. */}
        <p className="mb-3 text-xs text-gray-500">
          На неё приходит код для входа. Чтобы сменить — подтвердите новый адрес.
        </p>

        {emailStep === 'idle' ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input value={newEmail} onChange={e => setNewEmail(e.target.value)}
                   type="email" placeholder="Новая почта" className={field} />
            <button onClick={requestEmail}
                    disabled={emailBusy || !newEmail.includes('@')}
                    className="btn-primary shrink-0">
              {emailBusy ? 'Отправляем…' : 'Сменить'}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-gray-600">
              Код отправлен на <b>{newEmail}</b>. Введите его — и адрес станет вашим логином.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input value={emailCode} onChange={e => setEmailCode(e.target.value)}
                     inputMode="numeric" placeholder="Код из письма" className={field} />
              <button onClick={confirmEmail} disabled={emailBusy || emailCode.trim().length < 4}
                      className="btn-gold shrink-0">
                {emailBusy ? 'Проверяем…' : 'Подтвердить'}
              </button>
            </div>
            <button onClick={() => { setEmailStep('idle'); setEmailCode(''); setEmailErr('') }}
                    className="text-sm text-gray-500 hover:text-gray-700">
              Отмена
            </button>
          </div>
        )}
        {emailErr && <p className="mt-2 text-sm text-red-600">{emailErr}</p>}
      </div>
    </>
  )
}
