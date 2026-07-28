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
import { useEffect, useState } from 'react'

interface Props {
  page: any
  event: any
  tariff: any
  offerUrl: string | null
  privacyUrl: string | null
  brandName: string | null
  ownerName: string | null
  slug: string
  contactId: string | null
}

export default function OrderForm({
  page, event, tariff, offerUrl, privacyUrl, brandName, ownerName, slug, contactId,
}: Props) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [tg, setTg] = useState('')
  const [pd, setPd] = useState(false)
  const [offer, setOffer] = useState(false)
  const [mkt, setMkt] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const price = Number(tariff.price || 0)
  const isFree = price <= 0

  // Пришёл из бота по ссылке с ?c= — подставляем его контакты, чтобы не
  // вводил заново. Поля остаются редактируемыми: телефон мог измениться.
  useEffect(() => {
    if (!contactId) return
    fetch(`/api/v1/public/event-orders/prefill/${tariff.id}/${contactId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return
        if (d.name) setName(v => v || d.name)
        if (d.email) setEmail(v => v || d.email)
        if (d.phone) setPhone(v => v || d.phone)
        if (d.tg_username) setTg(v => v || `@${String(d.tg_username).replace(/^@/, '')}`)
      })
      .catch(() => {})
  }, [contactId, tariff.id])

  // ⚠️ Кнопка ровно та же, что на лендинге: свой градиент → металл →
  // сплошной цвет, плюс рамка и блик. Иначе на странице оплаты она
  // выглядела чужой (плоская заливка вместо фирменной).
  const asLayer = (v: string) =>
    v.startsWith('linear-gradient') ? v : `linear-gradient(${v}, ${v})`
  const btnFill = page.btn_color_2
    ? `linear-gradient(${page.btn_angle ?? 180}deg, ${page.btn_color || '#FFCFA4'}, ${page.btn_color_2})`
    : page.btn_metallic
      ? metallicButton(page.btn_color || '#FFCFA4')
      : (page.btn_color || '#FFCFA4')

  const btnStyle: React.CSSProperties = {
    color: page.btn_text_color || '#0a1520',
    borderRadius: page.btn_radius ?? page.radius ?? 5,
    fontFamily: page.font_body_css,
    letterSpacing: '.04em',
    boxShadow: page.btn_metallic || page.btn_color_2
      ? 'inset 0 1px 0 rgba(255,255,255,.45), 0 6px 18px rgba(0,0,0,.35)'
      : undefined,
    ...(page.btn_border_width
      ? {
          border: `${page.btn_border_width}px solid transparent`,
          background: page.btn_border_metallic
            ? `${asLayer(btnFill)} padding-box, ${metallicButton(page.btn_border_color || '#FFCFA4')} border-box`
            : `${asLayer(btnFill)} padding-box, linear-gradient(${page.btn_border_color || '#FFCFA4'}, ${page.btn_border_color || '#FFCFA4'}) border-box`,
        }
      : { background: btnFill }),
  }

  const submit = async () => {
    setError('')
    if (!name.trim()) { setError('Укажите имя и фамилию'); return }
    if (!email.trim()) { setError('Укажите email — на него придёт доступ'); return }
    if (!phone.trim()) { setError('Укажите телефон'); return }
    if (!tg.trim()) { setError('Укажите ник в Telegram — по нему добавим вас в чат'); return }
    if (!pd) {
      setError('Без согласия на обработку персональных данных оформить заказ нельзя')
      return
    }
    if (offerUrl && !offer) {
      setError('Примите условия оферты, чтобы продолжить')
      return
    }
    if (!mkt) {
      setError('Без согласия на рассылки мы не сможем прислать вам доступ')
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

        {/* Предупреждение от организатора: белым по красному, потому что это
            именно предупреждение — цвет намеренно не из темы. */}
        {tariff.order_hint && (
          <div className="mb-5 rounded-xl bg-[#C62828] px-5 py-4 text-center text-[.85em] font-bold uppercase leading-snug text-white">
            {tariff.order_hint}
          </div>
        )}

        {/* Форма */}
        <div
          className="space-y-4 rounded-2xl p-6"
          style={{
            background: 'rgba(255,255,255,.07)',
            border: `1px solid ${page.border_color || '#FFCFA4'}55`,
            borderRadius: Math.max(page.radius ?? 5, 12),
          }}
        >
          {/* Все поля обязательны: без контактов доступ не отправить,
              а ник в Telegram нужен для чата события. */}
          <Field label="Имя Фамилия" required>
            <input value={name} onChange={e => setName(e.target.value)}
                   autoComplete="name" style={inputStyle(page)} />
          </Field>
          <Field label="Email" required>
            <input value={email} onChange={e => setEmail(e.target.value)}
                   type="email" autoComplete="email" style={inputStyle(page)} />
          </Field>
          <Field label="Телефон" required>
            <input value={phone} onChange={e => setPhone(e.target.value)}
                   type="tel" autoComplete="tel" style={inputStyle(page)} />
          </Field>
          <Field label="Ник в Telegram" required>
            <input value={tg} onChange={e => setTg(e.target.value)}
                   placeholder="@nickname" style={inputStyle(page)} />
          </Field>

          {/* Три ОТДЕЛЬНЫЕ галочки: персональные данные, оферта и рассылки.
              Смешивать их в одну нельзя — это разные согласия по смыслу и
              по закону. Формулировки те же, что на странице регистрации. */}
          <Consent checked={pd} onChange={setPd}>
            Я согласен на обработку моих персональных данных.{' '}
            {privacyUrl ? (
              <>С{' '}
                <a href={privacyUrl} target="_blank" rel="noreferrer"
                   className="underline" style={{ color: page.color_link || '#FFCFA4' }}>
                  Политикой обработки персональных данных
                </a>{' '}ознакомлен.
              </>
            ) : 'С Политикой обработки персональных данных ознакомлен.'}
          </Consent>

          {offerUrl && (
            <Consent checked={offer} onChange={setOffer}>
              Я принимаю условия{' '}
              <a href={offerUrl} target="_blank" rel="noreferrer"
                 className="underline" style={{ color: page.color_link || '#FFCFA4' }}>
                оферты
              </a>.
            </Consent>
          )}

          <Consent checked={mkt} onChange={setMkt}>
            Я согласен на получение информационных и маркетинговых рассылок
            {(ownerName || brandName) && <> от {[ownerName, brandName && `«${brandName}»`].filter(Boolean).join(', ')}</>}.
            {' '}Вы в любой момент можете отказаться от получения писем.
          </Consent>

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

function Field({
  label, required, children,
}: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[.85em] font-medium opacity-80">
        {label}{required && <span className="ml-0.5 opacity-70">*</span>}
      </label>
      {children}
    </div>
  )
}

function Consent({
  checked, onChange, children,
}: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-[.8em] leading-snug opacity-90">
      <input type="checkbox" checked={checked}
             onChange={e => onChange(e.target.checked)}
             className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </label>
  )
}

/** Металл кнопки — та же формула, что на лендинге (светлый, с широким бликом). */
function metallicButton(color: string): string {
  const edge = shade(color, -4)
  const light = shade(color, 75)
  return `linear-gradient(180deg, ${edge}, ${color} 18%, ${light} 48%, ${light} 56%, ${color} 82%, ${edge})`
}

function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return '#000000'
  const n = parseInt(m[1], 16)
  const f = (v: number) => pct >= 0
    ? Math.round(v + (255 - v) * (pct / 100))
    : Math.round(v * (1 + pct / 100))
  return `#${[f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]
    .map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`
}
