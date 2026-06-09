import { useState } from 'react'
import { registerParticipant } from '../api'

interface Props {
  event: any
  tgUser: any
  partnerId?: string
  utmSource?: string
  contactId?: number
  onClose: () => void
  onDone: (participant: any) => void
}

export default function RegistrationFlow({ event, tgUser, partnerId, utmSource, contactId, onClose, onDone }: Props) {
  const [step, setStep] = useState<1 | 2>(1)
  const [name,  setName]  = useState(tgUser?.first_name ? `${tgUser.first_name}${tgUser.last_name ? ' ' + tgUser.last_name : ''}` : '')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [consentPd, setConsentPd] = useState(false)
  const [consentMkt, setConsentMkt] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function isValidEmail(s: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) }
  function isValidPhone(s: string) { return s.replace(/\D/g, '').length >= 10 }

  function next() {
    if (!name.trim())  { setError('Укажите имя'); return }
    if (!isValidEmail(email)) { setError('Email указан неверно'); return }
    if (!isValidPhone(phone)) { setError('Телефон указан неверно'); return }
    if (!consentPd)  { setError('Без согласия на обработку персональных данных регистрация невозможна (152-ФЗ)'); return }
    if (!consentMkt) { setError('Без согласия на маркетинговые рассылки регистрация невозможна'); return }
    setError(null)
    submit()
  }

  async function submit() {
    setSubmitting(true)
    try {
      const [first_name, ...rest] = name.trim().split(/\s+/)
      const last_name = rest.join(' ')
      const r = await registerParticipant({
        event_slug: event.slug,
        tg_id: tgUser?.id,
        username: tgUser?.username,
        first_name,
        last_name,
        email: email.trim(),
        phone: phone.trim(),
        ref_code: partnerId,
        utm_source: utmSource,
        contact_id: contactId,
        consent_pd: consentPd,
        consent_marketing: consentMkt,
        policy_version: event?.privacy_policy_version || 0,
      })
      setStep(2)
      // Через 1.5 сек закрыть и обновить
      setTimeout(() => onDone(r.participant || r), 1400)
    } catch (e: any) {
      // Показываем реальный текст ошибки от бэка (FastAPI detail)
      // вместо общей заглушки — без этого диагностика вслепую.
      const msg = (e?.message || '').trim()
      console.error('[register] failed:', e)
      setError(msg || 'Не удалось зарегистрировать. Попробуйте ещё раз.')
    } finally {
      setSubmitting(false)
    }
  }

  function requestPhoneFromTG() {
    const twa = (window as any).Telegram?.WebApp
    if (!twa?.requestContact) {
      setError('Telegram не отдал телефон. Введите номер вручную в поле ниже.')
      return
    }
    try {
      twa.requestContact((ok: boolean, res: any) => {
        const c = res?.responseUnsafe?.contact
        if (ok && c?.phone_number) {
          setPhone(c.phone_number)
          setError(null)
        } else if (!ok) {
          // Пользователь отказал или версия Telegram не поддерживает.
          setError('Не получилось взять телефон из Telegram. Введите вручную.')
        }
      })
    } catch (err) {
      console.error('[requestContact] failed:', err)
      setError('Telegram не разрешил взять телефон. Введите вручную.')
    }
  }

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose() }}>
      <div className="modal-sheet">
        {step === 1 && (
          <>
            <h2>Чтобы участвовать, оставьте контакты</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16, lineHeight: 1.4 }}>
              Они нужны организатору, чтобы прислать материалы и подтвердить регистрацию.
            </p>

            <div className="field">
              <label>Имя</label>
              <input className="input-dark" value={name} onChange={e => setName(e.target.value)} placeholder="Ваше имя" />
            </div>

            <div className="field">
              <label>Email</label>
              <input className="input-dark" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>

            <div className="field">
              <label>Телефон</label>
              <input className="input-dark" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+7 999 123-45-67" />
              <button onClick={requestPhoneFromTG}
                      style={{ marginTop: 6, background: 'none', border: 'none', color: 'var(--peach)', fontSize: 12, cursor: 'pointer', padding: 0 }}>
                Взять из Telegram
              </button>
            </div>

            {/* Согласия (152-ФЗ). Обе галочки обязательные. */}
            <div style={{ marginTop: 12, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, lineHeight: 1.4, color: 'var(--muted)' }}>
                <input type="checkbox" checked={consentPd} onChange={e => setConsentPd(e.target.checked)}
                       style={{ marginTop: 3, flexShrink: 0, width: 16, height: 16 }} />
                <span>
                  Я согласен на обработку моих персональных данных. С{' '}
                  {event?.client_id ? (
                    <a href={`https://pluson.ru/c/${event.client_id}/privacy`} target="_blank" rel="noreferrer"
                       style={{ color: 'var(--peach)', textDecoration: 'underline' }}>
                      Политикой обработки персональных данных
                    </a>
                  ) : 'Политикой обработки персональных данных'} ознакомлен.
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, lineHeight: 1.4, color: 'var(--muted)' }}>
                <input type="checkbox" checked={consentMkt} onChange={e => setConsentMkt(e.target.checked)}
                       style={{ marginTop: 3, flexShrink: 0, width: 16, height: 16 }} />
                <span>
                  Я согласен на получение информационных и маркетинговых рассылок от{' '}
                  {event?.client_brand_name || event?.client_name || 'организатора'}.
                  Вы в любой момент можете отказаться от получения писем.
                </span>
              </label>
            </div>

            {error && (
              <p style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>{error}</p>
            )}

            <button className="btn btn-primary" disabled={submitting} onClick={next}>
              {submitting ? 'Регистрируем...' : 'Зарегистрироваться'}
            </button>
            <button onClick={onClose} disabled={submitting}
                    style={{ marginTop: 10, background: 'none', border: 'none', color: 'var(--muted)', fontSize: 13, width: '100%', padding: 10, cursor: 'pointer' }}>
              Отмена
            </button>
          </>
        )}

        {step === 2 && (
          <div style={{ textAlign: 'center', padding: '24px 0 12px' }}>
            <div style={{ fontSize: 56, marginBottom: 12 }}>✓</div>
            <h2 style={{ color: 'var(--peach)' }}>Вы зарегистрированы!</h2>
            <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 12, lineHeight: 1.5 }}>
              Открываем программу события...
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
