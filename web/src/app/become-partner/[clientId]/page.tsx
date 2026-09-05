'use client'

/**
 * Публичная страница «Стать партнёром» — `{домен клиента}/partner/{client_id}`.
 *
 * Зачем отдельная страница, а не форма в кабинете: стать партнёром можно было
 * ТОЛЬКО войдя в `/my`, куда пускают по коду на почту. Человеку «с улицы»
 * клиенту было нечего дать — а именно такую ссылку он и раздаёт, чтобы
 * набирать партнёров.
 *
 * ⚠️ Опознание идёт по почте и телефону (`find_or_create_contact`): человек
 * уже может быть в базе клиента, и заводить ему второй контакт нельзя —
 * иначе прошлые приведённые останутся за старой карточкой, а ссылки пойдут
 * с новым кодом.
 *
 * ⚠️ Налоговый статус обязателен: деньги платим только тем, кто может их
 * легально принять. Это осознанный вход, а не галочка.
 */

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''

export default function BecomePartnerPage() {
  // ⚠️ Next 14: параметры через useParams(), не через use(params).
  const params = useParams()
  const clientId = Number(params?.clientId)

  const [offer, setOffer] = useState<any>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [tax, setTax] = useState('')
  const [accept, setAccept] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<any>(null)

  useEffect(() => {
    if (!clientId) return
    fetch(`${apiBase}/api/v1/public/partner/offer?client_id=${clientId}`)
      .then(r => r.ok ? r.json() : null)
      .then(setOffer)
      .catch(() => setOffer(null))
  }, [clientId])

  const submit = async () => {
    setBusy(true); setError('')
    try {
      const res = await fetch(`${apiBase}/api/v1/public/partner/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          name: name.trim() || null,
          email: email.trim().toLowerCase() || null,
          phone: phone.trim() || null,
          tax_status: tax,
          accept: true,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.detail || 'Не получилось')
      setDone(data)
    } catch (e: any) {
      setError(e?.message || 'Что-то пошло не так')
    } finally { setBusy(false) }
  }

  const brand = offer?.brand || ''

  if (done) {
    return (
      <Shell brand={brand}>
        <div className="text-center">
          <div className="mb-3 text-4xl">🎉</div>
          <h1 className="mb-2 text-xl font-bold text-gray-900">
            {done.already ? 'Вы уже партнёр' : 'Готово, вы партнёр'}
          </h1>
          <p className="mb-5 text-sm text-gray-600">
            Ваши ссылки и статистика — в личном кабинете. Вход по коду,
            который придёт на почту.
          </p>
          <a href="/my" className="btn-gold inline-block">Открыть кабинет</a>
        </div>
      </Shell>
    )
  }

  return (
    <Shell brand={brand}>
      <h1 className="mb-2 text-xl font-bold text-gray-900">
        Стать партнёром{brand ? ` «${brand}»` : ''}
      </h1>
      <p className="mb-5 text-sm text-gray-600">
        Вы получите личные ссылки на события и продукты. Человек покупает по
        вашей ссылке — вам начисляется вознаграждение.
      </p>

      <div className="space-y-3">
        <Input label="Имя" value={name} onChange={setName} placeholder="Как к вам обращаться" />
        <Input label="Почта" value={email} onChange={setEmail} type="email"
               placeholder="Для входа в кабинет и связи" />
        <Input label="Телефон" value={phone} onChange={setPhone}
               placeholder="Необязательно" />

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Налоговый статус
          </label>
          <select value={tax} onChange={e => setTax(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="">Выберите…</option>
            {(offer?.tax_statuses || []).map((s: any) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-400">
            Нужен, чтобы вознаграждение можно было выплатить законно.
          </p>
        </div>

        {offer?.body && (
          <details className="rounded-xl bg-gray-50 p-3">
            <summary className="cursor-pointer text-sm font-medium text-gray-700">
              {offer.title || 'Условия участия'}
            </summary>
            <div className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-gray-600">
              {offer.body}
            </div>
          </details>
        )}

        <label className="flex gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={accept} className="mt-1"
                 onChange={e => setAccept(e.target.checked)} />
          <span>Принимаю условия участия в партнёрской программе</span>
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button onClick={submit}
                disabled={busy || !accept || !tax || (!email.trim() && !phone.trim())}
                className="btn-gold w-full">
          {busy ? 'Отправляем…' : 'Стать партнёром'}
        </button>
        <p className="text-center text-xs text-gray-400">
          Уже партнёр? <a href="/my" className="underline">Войти в кабинет</a>
        </p>
      </div>
    </Shell>
  )
}

function Shell({ brand, children }: { brand: string; children: any }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-sm">
        {children}
      </div>
    </div>
  )
}

function Input({ label, value, onChange, type = 'text', placeholder }: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)}
             type={type} placeholder={placeholder}
             className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
    </div>
  )
}
