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
  const [tab, setTab] = useState<'materials' | 'partner'>('materials')

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

  return (
    <div className="min-h-screen bg-gray-50">
      <CabinetBrand brand={brand} />
      <div className="mx-auto max-w-3xl px-4 py-10">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Мой кабинет</h1>
          <button onClick={onLogout} className="text-sm text-gray-500 hover:text-gray-700">
            Выйти
          </button>
        </div>

        <div className="mb-6 flex gap-1 border-b border-gray-200">
          {([['materials', 'Мои материалы'], ['partner', 'Партнёру']] as const).map(
            ([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium ${
                  tab === key
                    ? 'border-gray-900 text-gray-900'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
        </div>

        {tab === 'partner' && <PartnerCabinet token={token} />}

        {tab === 'materials' && (
        <>
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
      </div>
    </div>
  )
}
