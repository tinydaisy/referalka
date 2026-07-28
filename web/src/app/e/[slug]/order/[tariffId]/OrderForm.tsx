'use client'

/**
 * Форма заказа тарифа (миграция 257).
 *
 * Показывает афишу события и название тарифа, собирает контакты и уводит на
 * оплату. Бесплатный тариф оплаты не требует — сразу регистрирует.
 *
 * ⚠️ Ссылки на техподдержку здесь нет намеренно: это шаг оплаты, лишние
 * выходы с него уводят человека от покупки.
 */
import { useState } from 'react'

interface Props {
  page: any
  event: any
  tariff: any
  offerUrl: string | null
  slug: string
  contactId: string | null
}

export default function OrderForm({
  page, event, tariff, offerUrl, slug, contactId,
}: Props) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [tg, setTg] = useState('')
  const [pd, setPd] = useState(false)
  const [mkt, setMkt] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const price = Number(tariff.price || 0)
  const isFree = price <= 0

  const btnStyle: React.CSSProperties = {
    background: page.btn_color || '#FFCFA4',
    color: page.btn_text_color || '#0a1520',
    borderRadius: page.btn_radius ?? page.radius ?? 5,
    fontFamily: page.font_body_css,
  }

  const submit = async () => {
    setError('')
    if (!name.trim()) { setError('Укажите имя'); return }
    if (!email.trim() && !phone.trim()) {
      setError('Укажите email или телефон — иначе мы не сможем прислать доступ')
      return
    }
    if (!pd) {
      setError('Без согласия на обработку персональных данных оформить заказ нельзя')
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/v1/public/event-orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tariff_id: tariff.id,
          name: name.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          telegram_username: tg.trim() || null,
          contact_id: contactId ? Number(contactId) : null,
          consent_pd: true,
          consent_marketing: mkt,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || 'Не удалось оформить заказ')

      // Бесплатный тариф — сразу в кабинет; платный — на оплату.
      if (data.redirect) { location.href = data.redirect; return }
      if (data.payment_url) { location.href = data.payment_url; return }
      location.href = `/thanks?order=${data.order_id}`
    } catch (e: any) {
      setError(e?.message || 'Не удалось оформить заказ')
      setBusy(false)
    }
  }

  return (
    <div
      className="min-h-screen px-4 py-8"
      style={{
        background: page.bg_css_screen || page.bg_css || '#25455D',
        color: page.color_body || '#FFFFFF',
        fontFamily: page.font_body_css,
      }}
    >
      <div className="mx-auto w-full max-w-lg">
        {/* Афиша события */}
        {event.poster_url && (
          <img
            src={event.poster_url}
            alt={event.title}
            className="mb-6 w-full rounded-xl object-cover"
            style={{ borderRadius: page.radius ?? 5 }}
          />
        )}

        {/* Что покупаем */}
        <div className="mb-6 text-center">
          <div className="text-[.9em] uppercase tracking-wide opacity-70">
            {event.title}
          </div>
          <h1
            className="mt-2 text-[1.8em] font-bold uppercase leading-tight"
            style={{ fontFamily: page.font_heading_css, color: page.color_heading || '#FFCFA4' }}
          >
            {tariff.title}
          </h1>
          <div className="mt-3 text-[1.6em] font-bold">
            {isFree ? 'Бесплатно' : `${price.toLocaleString('ru-RU')} ₽`}
          </div>
        </div>

        {/* Форма */}
        <div
          className="space-y-4 rounded-2xl p-6"
          style={{
            background: 'rgba(255,255,255,.07)',
            border: `1px solid ${page.border_color || '#FFCFA4'}55`,
            borderRadius: Math.max(page.radius ?? 5, 12),
          }}
        >
          <Field label="Имя">
            <input value={name} onChange={e => setName(e.target.value)}
                   autoComplete="name" style={inputStyle(page)} />
          </Field>
          <Field label="Email">
            <input value={email} onChange={e => setEmail(e.target.value)}
                   type="email" autoComplete="email" style={inputStyle(page)} />
          </Field>
          <Field label="Телефон">
            <input value={phone} onChange={e => setPhone(e.target.value)}
                   type="tel" autoComplete="tel" style={inputStyle(page)} />
          </Field>
          <Field label="Ник в Telegram">
            <input value={tg} onChange={e => setTg(e.target.value)}
                   placeholder="@nickname" style={inputStyle(page)} />
          </Field>

          <label className="flex cursor-pointer items-start gap-2.5 text-[.85em] leading-snug opacity-90">
            <input type="checkbox" checked={pd} onChange={e => setPd(e.target.checked)}
                   className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Согласен на обработку персональных данных
              {offerUrl && (
                <> и принимаю{' '}
                  <a href={offerUrl} target="_blank" rel="noreferrer"
                     className="underline" style={{ color: page.color_link || '#FFCFA4' }}>
                    условия оферты
                  </a>
                </>
              )}
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5 text-[.85em] leading-snug opacity-90">
            <input type="checkbox" checked={mkt} onChange={e => setMkt(e.target.checked)}
                   className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Согласен получать новости и материалы события</span>
          </label>

          {error && (
            <div className="rounded-lg bg-red-500/20 p-3 text-[.9em] text-red-100">
              {error}
            </div>
          )}

          <button
            onClick={submit}
            disabled={busy}
            className="w-full px-6 py-4 text-[1em] font-bold uppercase transition-transform hover:scale-[1.02] disabled:opacity-60"
            style={btnStyle}
          >
            {busy ? 'Отправляем…' : isFree ? 'Участвовать' : 'Перейти к оплате'}
          </button>
        </div>

        <div className="mt-5 text-center">
          <a href={`/e/${slug}`} className="text-[.9em] underline opacity-70 hover:opacity-100">
            Вернуться к тарифам
          </a>
        </div>
      </div>
    </div>
  )
}

function inputStyle(page: any): React.CSSProperties {
  return {
    width: '100%',
    padding: '12px 14px',
    borderRadius: page.radius ?? 5,
    border: `1px solid ${page.border_color || '#FFCFA4'}55`,
    background: 'rgba(255,255,255,.08)',
    color: page.color_body || '#FFFFFF',
    fontFamily: page.font_body_css,
    fontSize: '1em',
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[.85em] font-medium opacity-80">{label}</label>
      {children}
    </div>
  )
}
