/**
 * Выбор тарифа и оформление заказа — ВНУТРИ Mini App.
 *
 * Открывается по кнопке участия, когда способ регистрации «простая форма» и
 * у события заданы тарифы. Два шага в одном окне:
 *   1) список тарифов (что входит, что не входит, цена со скидкой);
 *   2) форма контактов + три галочки согласий → заказ.
 *
 * ⚠️⚠️ ИЗ MINI APP НИКУДА НЕ УХОДИМ. Веб-страница заказа `/e/{slug}/order/{id}`
 * остаётся для веб-витрины и лендинга; Mini App показывает свою форму окном.
 * Уводить человека из мессенджера в браузер за формой нельзя — он теряет
 * контекст события и часто просто не возвращается.
 *
 * ⚠️ Заказ создаёт ТОТ ЖЕ `POST /public/event-orders/create`, что и веб-форма:
 * второго приёмника заказов не заводим, иначе разъедутся «Это вы?», согласия
 * и ссылка на оплату от платёжной системы клиента.
 */
import { useRef, useState } from 'react'

export interface Tariff {
  id: number
  title: string
  description?: string | null
  excluded_description?: string | null
  order_hint?: string | null
  price: number
  old_price?: number | null
  discount_percent?: number | null
}

interface Props {
  event: any
  tariffs: Tariff[]
  tgUser: any
  /** Реф-код приведшего и метка источника — их нельзя терять при заказе. */
  partnerId?: string
  utmSource?: string
  contactId?: number
  prefill?: { name?: string; email?: string; phone?: string } | null
  onClose: () => void
  /** Бесплатный тариф оформлен — человек зарегистрирован. */
  onDone: (participant: any) => void
}

function money(v: number) {
  return `${Math.round(v).toLocaleString('ru-RU')} ₽`
}

export default function TariffPicker({
  event, tariffs, tgUser, partnerId, utmSource, contactId, prefill, onClose, onDone,
}: Props) {
  const [picked, setPicked] = useState<Tariff | null>(null)
  const [name, setName] = useState(
    prefill?.name
    || (tgUser?.first_name
        ? `${tgUser.first_name}${tgUser.last_name ? ' ' + tgUser.last_name : ''}`
        : ''))
  const [email, setEmail] = useState(prefill?.email || '')
  const [phone, setPhone] = useState(prefill?.phone || '')
  const [tg, setTg] = useState(tgUser?.username ? `@${tgUser.username}` : '')
  const [pd, setPd] = useState(false)
  const [offer, setOffer] = useState(false)
  const [mkt, setMkt] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // ⚠️ Замок повторной отправки — обычной переменной, а не состоянием:
  // состояние применяется к следующей перерисовке, и два быстрых нажатия
  // проходят оба (на форме заказа это уже давало два контакта и два заказа).
  const sending = useRef(false)

  const offerUrl: string | null = event?.offer_url || null
  const privacyUrl: string | null = event?.privacy_url || null
  const isFree = !!picked && (picked.price || 0) <= 0

  async function submit() {
    if (sending.current) return
    sending.current = true
    const unlock = () => { sending.current = false }

    if (!picked) { unlock(); return }
    if (!name.trim())  { unlock(); setError('Укажите имя и фамилию'); return }
    if (!email.trim()) { unlock(); setError('Укажите email — на него придёт доступ'); return }
    if (!phone.trim()) { unlock(); setError('Укажите телефон'); return }
    if (!pd) {
      unlock()
      setError('Без согласия на обработку персональных данных оформить заказ нельзя')
      return
    }
    // ⚠️ Оферта — только у платного: у бесплатного покупки нет, соглашаться не с чем.
    if (!isFree && offerUrl && !offer) {
      unlock(); setError('Примите условия оферты, чтобы продолжить'); return
    }
    if (!mkt) {
      unlock(); setError('Без согласия на рассылки мы не сможем прислать вам доступ'); return
    }

    setError(null)
    setBusy(true)
    try {
      // ⚠️ Адрес API — через `VITE_API_URL`, как весь mini-app (api.ts):
      // относительный путь в дев-сборке уходит не на бэкенд.
      const apiUrl = (import.meta as any).env?.VITE_API_URL || ''
      const res = await fetch(`${apiUrl}/api/v1/public/event-orders/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tariff_id: picked.id,
          name: name.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          telegram_username: tg.trim() || null,
          contact_id: contactId ?? null,
          ref_code: partnerId || null,
          utm_source: utmSource || null,
          consent_pd: true,
          consent_marketing: mkt,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || 'Не удалось оформить заказ')

      // ⚠️ Оплата — единственное, что физически нельзя показать внутри
      // Mini App: платёжные страницы в webview часто не работают (3-D Secure,
      // редиректы банка). Её открываем во внешнем браузере, всё остальное —
      // здесь. Само окно при этом закрываем: заказ уже создан.
      if (data.payment_url) {
        const { getPlatform } = await import('../platform')
        getPlatform().openExternal(data.payment_url)
        onClose()
        return
      }

      // Бесплатный тариф — заказа нет, человек просто зарегистрирован.
      onDone(data?.participant || { is_registered: true })
    } catch (e: any) {
      setError(e?.message || 'Не удалось оформить заказ')
      setBusy(false)
      unlock()
    }
  }

  // ── ШАГ 2: форма контактов ──
  if (picked) {
    return (
      <div className="modal-bg">
        <div className="modal-sheet">
          <h2>{picked.title}</h2>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 4, lineHeight: 1.4 }}>
            {isFree ? 'Участие бесплатное' : money(picked.price)}
          </p>

          <div className="field">
            <label>Имя и фамилия</label>
            <input className="input-dark" value={name}
                   onChange={e => setName(e.target.value)} placeholder="Ваше имя" />
          </div>
          <div className="field">
            <label>Email</label>
            <input className="input-dark" type="email" value={email}
                   onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <div className="field">
            <label>Телефон</label>
            <input className="input-dark" type="tel" value={phone}
                   onChange={e => setPhone(e.target.value)} placeholder="+7 999 123-45-67" />
          </div>
          <div className="field">
            <label>Ник в Telegram</label>
            <input className="input-dark" value={tg}
                   onChange={e => setTg(e.target.value)} placeholder="@nickname" />
          </div>

          {/* Три ОТДЕЛЬНЫЕ галочки — как на веб-форме заказа. Смешивать их
              нельзя: это разные согласия по смыслу и по закону. */}
          <div style={{ marginTop: 12, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, lineHeight: 1.4, color: 'var(--muted)' }}>
              <input type="checkbox" checked={pd} onChange={e => setPd(e.target.checked)}
                     style={{ marginTop: 3, flexShrink: 0, width: 16, height: 16 }} />
              <span>
                Я согласен на обработку моих персональных данных.{' '}
                {privacyUrl ? (
                  <>С <a href={privacyUrl} target="_blank" rel="noreferrer"
                         style={{ color: 'var(--peach)' }}>Политикой обработки
                    персональных данных</a> ознакомлен.</>
                ) : 'С Политикой обработки персональных данных ознакомлен.'}
              </span>
            </label>

            {!isFree && offerUrl && (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, lineHeight: 1.4, color: 'var(--muted)' }}>
                <input type="checkbox" checked={offer} onChange={e => setOffer(e.target.checked)}
                       style={{ marginTop: 3, flexShrink: 0, width: 16, height: 16 }} />
                <span>Я принимаю условия{' '}
                  <a href={offerUrl} target="_blank" rel="noreferrer"
                     style={{ color: 'var(--peach)' }}>оферты</a>.</span>
              </label>
            )}

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, lineHeight: 1.4, color: 'var(--muted)' }}>
              <input type="checkbox" checked={mkt} onChange={e => setMkt(e.target.checked)}
                     style={{ marginTop: 3, flexShrink: 0, width: 16, height: 16 }} />
              <span>Я согласен на получение информационных и маркетинговых
                рассылок. Отказаться можно в любой момент.</span>
            </label>
          </div>

          {/* Подсказка при оплате (`event_tariffs.order_hint`) — прямо НАД
              кнопкой: она про то, что произойдёт ПОСЛЕ нажатия («вернитесь
              после оплаты в бот»). Сверху формы её пролистывали мимо.
              ⚠️ Красная (#dc2626 — красный проекта, как LIVE-бейдж), но НЕ
              как ошибка: у ошибки ниже голый красный текст без плашки, здесь
              заливка и полоса слева — читается как «обрати внимание». */}
          {picked.order_hint && (
            <div style={{
              background: 'rgba(220, 38, 38, .10)',
              borderLeft: '3px solid #dc2626',
              borderRadius: 10, padding: '11px 13px', fontSize: 13,
              lineHeight: 1.5, color: '#a01b1b', fontWeight: 600,
              margin: '0 0 12px', whiteSpace: 'pre-wrap',
            }}>{picked.order_hint}</div>
          )}

          {error && (
            <p style={{ color: '#d9483b', fontSize: 13, margin: '0 0 12px', lineHeight: 1.4 }}>{error}</p>
          )}

          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? 'Оформляем…' : (isFree ? 'Записаться' : 'Перейти к оплате')}
          </button>
          <button
            onClick={() => { setPicked(null); setError(null) }}
            disabled={busy}
            style={{
              width: '100%', marginTop: 8, padding: 12, background: 'none',
              border: 'none', color: 'var(--muted)', fontSize: 14,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >Выбрать другой вариант</button>
        </div>
      </div>
    )
  }

  // ── ШАГ 1: список тарифов ──
  return (
    // ⚠️ Окно закрывается только кнопкой «Отмена» — правило проекта для форм.
    <div className="modal-bg">
      <div className="modal-sheet">
        <h2>Выберите вариант участия</h2>

        {tariffs.map(t => {
          const free = (t.price || 0) <= 0
          return (
            <div key={t.id} style={{
              // ⚠️ Каёмка — из темы (`--border`), а не своим цветом: окно
              // светлое, и захардкоженная белая линия на нём не видна.
              border: '1.5px solid var(--border)',
              borderRadius: 14, padding: 14, marginBottom: 12,
            }}>
              <div style={{
                display: 'flex', alignItems: 'baseline',
                justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
              }}>
                <div style={{ fontSize: 15, fontWeight: 800 }}>{t.title}</div>
                <div style={{ fontSize: 15, fontWeight: 800, whiteSpace: 'nowrap' }}>
                  {free ? 'Бесплатно' : money(t.price)}
                  {!free && t.old_price ? (
                    <span style={{
                      marginLeft: 7, fontSize: 12.5, fontWeight: 600,
                      opacity: .6, textDecoration: 'line-through',
                    }}>{money(t.old_price)}</span>
                  ) : null}
                  {!free && t.discount_percent ? (
                    <span style={{
                      marginLeft: 7, fontSize: 11.5, fontWeight: 800,
                      background: 'var(--peach)', color: '#25455D',
                      borderRadius: 6, padding: '2px 6px',
                    }}>{`−${t.discount_percent}%`}</span>
                  ) : null}
                </div>
              </div>

              {t.description ? (
                <div style={{
                  marginTop: 8, fontSize: 13, lineHeight: 1.5,
                  color: 'var(--muted)', whiteSpace: 'pre-wrap',
                }}>{t.description}</div>
              ) : null}

              {/* Что НЕ входит — приглушённо и зачёркнуто, как на лендинге. */}
              {t.excluded_description ? (
                <div style={{
                  marginTop: 8, fontSize: 13, lineHeight: 1.5, opacity: .5,
                  color: 'var(--muted)', textDecoration: 'line-through',
                  whiteSpace: 'pre-wrap',
                }}>{t.excluded_description}</div>
              ) : null}

              <button
                className="btn btn-primary"
                style={{ marginTop: 12 }}
                onClick={() => { setPicked(t); setError(null) }}
              >{free ? 'Записаться' : 'Оформить'}</button>
            </div>
          )
        })}

        <button
          onClick={onClose}
          style={{
            width: '100%', marginTop: 4, padding: 12, background: 'none',
            border: 'none', color: 'var(--muted)', fontSize: 14,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >Отмена</button>
      </div>
    </div>
  )
}
