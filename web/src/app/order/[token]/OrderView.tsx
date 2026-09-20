'use client'

/**
 * Персональный заказ: что входит, сколько стоит, контакты и оплата.
 *
 * ⚠️ Три ОТДЕЛЬНЫЕ галочки — персональные данные, оферта, рассылки. Смешивать
 * их в одну нельзя: это разные согласия по смыслу и по закону. Формулировки
 * дословно те же, что в OrderForm событий и продуктов, — иначе на разных
 * страницах человек соглашается на разное.
 */
import { useState } from 'react'

type Order = {
  number: string
  title: string
  items: string[]
  amount: number
  paid: boolean
  token: string
  created_at?: string | null
  paid_at?: string | null
  name?: string | null
  email?: string | null
  phone?: string | null
}

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''

export default function OrderView({ order }: { order: Order }) {
  const [name, setName] = useState(order.name || '')
  const [email, setEmail] = useState(order.email || '')
  const [phone, setPhone] = useState(order.phone || '')
  const [pd, setPd] = useState(false)
  const [offer, setOffer] = useState(false)
  const [mkt, setMkt] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const money = order.amount.toLocaleString('ru-RU')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!name.trim()) return setError('Напишите, как вас зовут')
    if (!email.trim()) return setError('Нужна почта — на неё придёт чек')
    if (!pd) return setError('Без согласия на обработку персональных данных оформить заказ нельзя')
    if (!offer) return setError('Нужно принять условия оферты')

    setBusy(true)
    try {
      const res = await fetch(
        `${apiBase}/api/v1/public/custom-orders/${encodeURIComponent(order.token)}/pay`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            email: email.trim(),
            phone: phone.trim() || null,
            consent_pd: pd,
            consent_offer: offer,
            consent_marketing: mkt,
          }),
        },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || 'Не удалось перейти к оплате')
      if (data.paid) return window.location.reload()
      if (!data.payment_url) throw new Error('Оплата временно недоступна')
      // ⚠️ Уводим в платёжную систему в ТОМ ЖЕ окне: новая вкладка часто
      // блокируется, и человек остаётся на странице, думая, что кнопка не
      // работает.
      window.location.href = data.payment_url
    } catch (e: any) {
      setError(e?.message || 'Что-то пошло не так')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen py-10 px-5"
         style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
      <div className="max-w-2xl mx-auto">

        {/* Шапка: наш логотип и название */}
        <div className="flex flex-col items-center gap-3 mb-8">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/logo_no_ivision_wwhite.png" alt="iViSiON: ПЛЮСОН"
               className="h-14 w-auto"
               onError={e => { (e.target as any).style.display = 'none' }} />
          <span className="text-white text-lg font-bold tracking-wide">
            iViSiON: ПЛЮСОН
          </span>
        </div>

        <div className="bg-white rounded-2xl overflow-hidden shadow-xl">

          {/* Заголовок заказа и номер */}
          <div className="px-6 sm:px-8 pt-7 pb-6 border-b border-gray-100">
            <div className="text-xs font-semibold tracking-widest uppercase mb-1"
                 style={{ color: '#FFCFA4' }}>
              {order.number}
              {order.created_at && (
                <span className="ml-2 font-normal tracking-normal normal-case text-gray-400">
                  от {new Date(order.created_at).toLocaleDateString('ru-RU',
                      { day: 'numeric', month: 'long', year: 'numeric' })}
                </span>
              )}
            </div>
            <h1 className="text-2xl font-bold" style={{ color: '#25455D' }}>
              {order.title}
            </h1>
          </div>

          {order.paid ? (
            <div className="px-6 sm:px-8 py-10 text-center">
              <div className="text-4xl mb-3">✅</div>
              <h2 className="text-xl font-bold text-gray-900 mb-2">Заказ оплачен</h2>
              {order.paid_at && (
                <div className="text-sm text-gray-400 mb-2">
                  {new Date(order.paid_at).toLocaleDateString('ru-RU',
                    { day: 'numeric', month: 'long', year: 'numeric' })}
                </div>
              )}
              <p className="text-gray-500">
                Спасибо! Мы уже видим оплату и берёмся за работу.
                Если понадобятся детали — напишем вам.
              </p>
            </div>
          ) : (
            <>
              {/* Что входит */}
              {order.items.length > 0 && (
                <div className="px-6 sm:px-8 py-6 border-b border-gray-100">
                  <div className="text-sm font-semibold text-gray-500 mb-3">
                    Что входит
                  </div>
                  <ul className="space-y-2">
                    {order.items.map((it, i) => (
                      <li key={i} className="flex gap-3 text-gray-800">
                        <span className="mt-[7px] shrink-0 w-1.5 h-1.5 rounded-full"
                              style={{ background: '#FFCFA4' }} />
                        <span>{it}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Стоимость */}
              <div className="px-6 sm:px-8 py-6 border-b border-gray-100 flex items-baseline justify-between gap-4">
                <span className="text-gray-500 font-semibold">Стоимость</span>
                <span className="text-3xl font-bold" style={{ color: '#25455D' }}>
                  {money} ₽
                </span>
              </div>

              {/* Контакты и согласия */}
              <form onSubmit={submit} className="px-6 sm:px-8 py-6 space-y-4">
                <div className="text-sm font-semibold text-gray-500">
                  Контактные данные
                </div>

                <Field label="Как вас зовут" value={name} onChange={setName}
                       placeholder="Имя и фамилия" required />
                <Field label="Почта" value={email} onChange={setEmail}
                       placeholder="you@example.com" type="email" required
                       hint="На неё придёт чек об оплате" />
                <Field label="Телефон" value={phone} onChange={setPhone}
                       placeholder="+7 900 000-00-00" type="tel" />

                <div className="pt-2 space-y-3">
                  <Consent checked={pd} onChange={setPd}>
                    Я согласен на обработку моих персональных данных. С{' '}
                    <a href="/privacy" target="_blank" rel="noreferrer"
                       className="underline" style={{ color: '#25455D' }}>
                      Политикой обработки персональных данных
                    </a>{' '}ознакомлен.
                  </Consent>

                  <Consent checked={offer} onChange={setOffer}>
                    Я принимаю условия{' '}
                    <a href="/offer" target="_blank" rel="noreferrer"
                       className="underline" style={{ color: '#25455D' }}>
                      оферты
                    </a>.
                  </Consent>

                  <Consent checked={mkt} onChange={setMkt}>
                    Я согласен на получение информационных и маркетинговых
                    рассылок от «iViSiON: ПЛЮСОН». Вы в любой момент можете
                    отказаться от получения писем.
                  </Consent>
                </div>

                {error && (
                  <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                    {error}
                  </div>
                )}

                <button type="submit" disabled={busy} className="btn-gold w-full">
                  {busy ? 'Переходим к оплате…' : `Оплатить ${money} ₽`}
                </button>

                <p className="text-xs text-gray-400 text-center">
                  Оплата проходит на защищённой странице платёжной системы.
                  Данные карты мы не видим и не храним.
                </p>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text', required, hint }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  required?: boolean
  hint?: string
}) {
  return (
    <label className="block">
      <span className="block text-sm text-gray-700 mb-1">
        {label}{required && <span className="text-red-500"> *</span>}
      </span>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
             placeholder={placeholder}
             className="w-full rounded-lg border border-gray-300 px-3 py-2.5
                        focus:outline-none focus:ring-2 focus:ring-offset-0"
             style={{ ['--tw-ring-color' as any]: '#FFCFA4' }} />
      {hint && <span className="block text-xs text-gray-400 mt-1">{hint}</span>}
    </label>
  )
}

function Consent({ checked, onChange, children }: {
  checked: boolean
  onChange: (v: boolean) => void
  children: React.ReactNode
}) {
  // ⚠️ Отступы заданы и утилитами, и инлайном: если CSS не догрузился,
  // согласия слипаются в сплошной абзац и человек не понимает, за что ставит
  // галочку. Тот же приём, что в OrderForm.
  return (
    <label className="flex gap-2.5 items-start cursor-pointer"
           style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
      <input type="checkbox" checked={checked}
             onChange={e => onChange(e.target.checked)}
             className="mt-1 shrink-0" style={{ marginTop: '4px' }} />
      <span className="text-sm text-gray-600 leading-snug">{children}</span>
    </label>
  )
}
