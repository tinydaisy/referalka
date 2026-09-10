/**
 * Выбор тарифа и оформление заказа — ВНУТРИ Mini App.
 *
 * Открывается по кнопке участия, когда способ регистрации «простая форма» и
 * у события заданы тарифы и/или форма заявки:
 *   1) список тарифов (что входит, что не входит, цена со скидкой) и ниже
 *      карточка «Оставить заявку», если форма заявки настроена;
 *   2а) выбран тариф → форма контактов + три галочки согласий → заказ;
 *   2б) выбрана заявка → анкета КВИЗОМ, по одному вопросу за шаг, контакты
 *       и согласие последним шагом — ровно как на лендинге.
 *
 * ⚠️ Заявка идёт КВИЗОМ, а не всеми вопросами сразу: в узком окне мессенджера
 * десяток полей превращается в простыню, и человек закрывает окно, не начав.
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

export interface RequestForm {
  title?: string | null
  subtitle?: string | null
  success_text?: string | null
  survey_slug?: string | null
  /** 'quiz' (по умолчанию) | 'form' — задаётся в форме заявки (мигр. 364). */
  survey_view?: string | null
  survey?: { questions?: any[] } | null
}

interface Props {
  event: any
  tariffs: Tariff[]
  /** Форма заявки (мигр. 363) — «оставить заявку» вместо регистрации. */
  requestForm?: RequestForm | null
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
  event, tariffs, requestForm, tgUser, partnerId, utmSource, contactId,
  prefill, onClose, onDone,
}: Props) {
  const [picked, setPicked] = useState<Tariff | null>(null)
  // Экран заявки: человек заполняет анкету, а не покупает.
  // ⚠️ ТАРИФОВ НЕТ — заявку открываем СРАЗУ, без промежуточной кнопки:
  // выбирать не из чего, и лишний экран «нажмите, чтобы оставить заявку»
  // только добавляет шаг. Кнопка нужна лишь когда рядом есть тарифы и
  // человеку правда надо выбрать между «купить» и «оставить заявку».
  const [onRequest, setOnRequest] = useState(
    !!requestForm && tariffs.length === 0)
  const [answers, setAnswers] = useState<Record<string, any>>({})
  const [sentText, setSentText] = useState<string | null>(null)
  // ⚠️ В простой форме заявка идёт КВИЗОМ — по одному вопросу за шаг.
  // Все вопросы сразу в узком окне мессенджера превращаются в простыню:
  // человек видит десятки полей и закрывает окно, не начав.
  const [step, setStep] = useState(0)
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
  // Промокод (миграция 397). Скидку считает СЕРВЕР — здесь только ввод.
  const [promo, setPromo] = useState('')
  const [promoOpen, setPromoOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // ⚠️ Замок повторной отправки — обычной переменной, а не состоянием:
  // состояние применяется к следующей перерисовке, и два быстрых нажатия
  // проходят оба (на форме заказа это уже давало два контакта и два заказа).
  const sending = useRef(false)

  const offerUrl: string | null = event?.offer_url || null
  const privacyUrl: string | null = event?.privacy_url || null
  const isFree = !!picked && (picked.price || 0) <= 0
  // ⚠️ Поле промокода НЕ показываем там, где платёжная система его не
  // поддерживает (у LeadPay цена лежит в его карточке товара): пустое поле,
  // которое ничего не делает, хуже отсутствующего.
  const promoAllowed = !isFree && (picked as any)?.promo_allowed !== false

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
          promo_code: promoAllowed && promo.trim() ? promo.trim() : null,
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

  const questions: any[] = requestForm?.survey?.questions || []

  async function submitRequest() {
    if (sending.current) return
    sending.current = true
    const unlock = () => { sending.current = false }

    if (!name.trim())  { unlock(); setError('Напишите, как вас зовут'); return }
    if (!email.trim()) { unlock(); setError('Укажите email'); return }
    if (!pd) {
      unlock(); setError('Без согласия на обработку персональных данных заявку отправить нельзя'); return
    }
    // Обязательные вопросы — до отправки, иначе сервер ответит ошибкой уже
    // после того, как человек нажал кнопку и ждёт.
    const miss = questions.filter((q: any) => {
      if (!q.is_required) return false
      const v = answers[String(q.id)]
      return Array.isArray(v) ? !v.length : String(v ?? '').trim() === ''
    })
    if (miss.length) {
      unlock()
      // ⚠️ В квизе мало сказать «заполните» — надо ВЕРНУТЬ на тот вопрос,
      // иначе человек видит ошибку про поле, которого на экране нет.
      setStep(questions.indexOf(miss[0]))
      setError('Заполните: ' + miss.map((q: any) => q.title).slice(0, 3).join('; '))
      return
    }

    setError(null); setBusy(true)
    try {
      // ⚠️ Отправка идёт в ТУ ЖЕ ручку, что и публичная страница анкеты
      // `/f/{slug}`. Своего приёма ответов не заводим: разъедутся проверка
      // обязательных, «Это вы?», согласие ПД и уведомления клиенту.
      const apiUrl = (import.meta as any).env?.VITE_API_URL || ''
      const r = await fetch(
        `${apiUrl}/api/v1/public/surveys/${requestForm?.survey_slug}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers,
          contact_id: contactId ?? null,
          name: name.trim() || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          consent_pd: true,
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data?.detail || 'Не удалось отправить заявку')
      setSentText(requestForm?.success_text || 'Спасибо! Мы свяжемся с вами.')
    } catch (e: any) {
      setError(e?.message || 'Не удалось отправить заявку')
      setBusy(false)
    } finally {
      unlock()
    }
  }

  // ── Заявка отправлена ──
  if (sentText) {
    return (
      <div className="modal-bg">
        <div className="modal-sheet" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 44, marginBottom: 8 }}>🎉</div>
          <h2 style={{ marginBottom: 10 }}>Заявка отправлена</h2>
          <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.5, marginBottom: 18 }}>
            {sentText}
          </p>
          <button className="btn btn-primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    )
  }

  // ── ЭКРАН ЗАЯВКИ: анкета КВИЗОМ, по одному вопросу ──
  if (onRequest && requestForm) {
    // ⚠️ КОНТАКТЫ — ОТДЕЛЬНЫЙ ПОСЛЕДНИЙ ШАГ, а не довесок к последнему
    // вопросу: иначе на одном экране и вопрос, и три поля с согласием —
    // шаг перестаёт быть «одним вопросом», ради чего квиз и нужен.
    // ⚠️ Режим показа задаёт КЛИЕНТ в форме заявки; по умолчанию квиз.
    const isQuiz = (requestForm.survey_view || 'quiz') !== 'form'
    const total = questions.length
    // Все вопросы сразу — контакты на том же экране, шагов нет.
    const onContacts = !isQuiz || step >= total
    const shown = isQuiz
      ? (onContacts ? [] : questions.slice(step, step + 1))
      : questions
    const steps = total + 1               // вопросы + экран контактов
    const current = shown[0]

    // Шагнуть вперёд можно, только ответив на обязательный вопрос.
    const canNext = !current?.is_required || (() => {
      const v = answers[String(current.id)]
      return Array.isArray(v) ? !!v.length : String(v ?? '').trim() !== ''
    })()

    return (
      <div className="modal-bg">
        {/* ⚠️ Анкета длиннее окна — стандартных 85vh не хватает, и содержимое
            ОБРЫВАЛОСЬ: кнопка «Отправить» уезжала за край. Класс `tall`
            поднимает потолок до почти всей высоты (в CSS сначала `vh`, затем
            `dvh` для webview с плавающими панелями — второе правило
            перекрывает первое там, где поддерживается). */}
        <div className="modal-sheet modal-sheet-tall">
          {/* ⚠️ Заголовок и подпись — ТОЛЬКО НА ПЕРВОМ ШАГЕ. Дальше человек
              уже внутри квиза, и повторять их на каждом шаге незачем: они
              съедают экран, а нужен вопрос. В режиме «все вопросы сразу»
              шаг один, поэтому шапка видна всегда. */}
          {(!isQuiz || step === 0) && (<>
            <h2>{requestForm.title || 'Оставить заявку'}</h2>
            {requestForm.subtitle && (
              <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 14, lineHeight: 1.45 }}>
                {requestForm.subtitle}
              </p>
            )}
          </>)}

          {/* Полоса прогресса — только в квизе: человек должен видеть,
              сколько осталось. При показе всех вопросов сразу она бессмысленна. */}
          {isQuiz && <div style={{ margin: '4px 0 16px' }}>
            <div style={{ height: 4, borderRadius: 4, background: 'rgba(0,0,0,.08)' }}>
              <div style={{
                height: 4, borderRadius: 4, background: 'var(--peach)',
                width: `${Math.round(((step + 1) / steps) * 100)}%`,
                transition: 'width .2s',
              }} />
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
              Шаг {Math.min(step + 1, steps)} из {steps}
            </p>
          </div>}

          {onContacts && (<>
            <div className="field">
              <label>Имя</label>
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
          </>)}

          {shown.map((q: any) => (
            <div className="field" key={q.id}>
              <label>{q.title}{q.is_required ? ' *' : ''}</label>
              {q.kind === 'textarea' ? (
                <textarea className="input-dark" rows={3}
                          value={answers[String(q.id)] || ''}
                          onChange={e => setAnswers(a => ({ ...a, [String(q.id)]: e.target.value }))} />
              ) : (q.kind === 'select' || q.kind === 'multiselect') ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(q.options || []).map((o: any, i: number) => {
                    const val = typeof o === 'string' ? o : (o?.value ?? o?.title ?? '')
                    const multi = q.kind === 'multiselect'
                    const cur = answers[String(q.id)]
                    const on = multi ? (Array.isArray(cur) && cur.includes(val)) : cur === val
                    return (
                      <label key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: 'var(--text)' }}>
                        <input type={multi ? 'checkbox' : 'radio'} checked={!!on}
                               onChange={() => setAnswers(a => {
                                 if (!multi) return { ...a, [String(q.id)]: val }
                                 const arr = Array.isArray(a[String(q.id)]) ? [...a[String(q.id)]] : []
                                 const ix = arr.indexOf(val)
                                 if (ix >= 0) arr.splice(ix, 1); else arr.push(val)
                                 return { ...a, [String(q.id)]: arr }
                               })}
                               style={{ marginTop: 2, flexShrink: 0, width: 16, height: 16 }} />
                        <span>{val}</span>
                      </label>
                    )
                  })}
                </div>
              ) : q.kind === 'bool' ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={answers[String(q.id)] === 'Да'}
                         onChange={e => setAnswers(a => ({ ...a, [String(q.id)]: e.target.checked ? 'Да' : '' }))}
                         style={{ width: 16, height: 16 }} />
                  <span>Да</span>
                </label>
              ) : (
                <input className="input-dark"
                       type={q.kind === 'number' ? 'number' : q.kind === 'date' ? 'date' : 'text'}
                       value={answers[String(q.id)] || ''}
                       onChange={e => setAnswers(a => ({ ...a, [String(q.id)]: e.target.value }))} />
              )}
              {q.hint && (
                <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>{q.hint}</p>
              )}
            </div>
          ))}

          {/* Согласие — только на последнем шаге, вместе с контактами. */}
          {onContacts && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, lineHeight: 1.4, color: 'var(--muted)', margin: '12px 0 16px' }}>
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
          )}

          {error && (
            <p style={{ color: '#d9483b', fontSize: 13, margin: '0 0 12px', lineHeight: 1.4 }}>{error}</p>
          )}

          {onContacts ? (
            <button className="btn btn-primary" disabled={busy} onClick={submitRequest}>
              {busy ? 'Отправляем…' : 'Отправить заявку'}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={!canNext}
              onClick={() => {
                if (!canNext) return
                setError(null)
                setStep(s => s + 1)
              }}
            >Далее</button>
          )}

          {/* Назад: к предыдущему вопросу, а с первого — к вариантам участия. */}
          <button
            onClick={() => {
              setError(null)
              if (isQuiz && step > 0) setStep(s => s - 1)
              else setOnRequest(false)
            }}
            disabled={busy}
            style={{
              width: '100%', marginTop: 8, padding: 12, background: 'none',
              border: 'none', color: 'var(--muted)', fontSize: 14,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >{isQuiz && step > 0
              ? 'Назад'
              : (tariffs.length > 0 ? 'Назад к вариантам участия' : 'Отмена')}</button>
        </div>
      </div>
    )
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

          {/* ⚠️ Промокод СВЁРНУТ по умолчанию: у большинства покупателей его
              нет, а открытое пустое поле читается как «мне чего-то не дали» —
              и человек уходит искать код вместо покупки. */}
          {promoAllowed && (promoOpen ? (
            <div className="field">
              <label>Промокод</label>
              <input className="input-dark" value={promo}
                     onChange={e => setPromo(e.target.value)}
                     autoCapitalize="characters" spellCheck={false}
                     placeholder="Например, PLUSON20" />
            </div>
          ) : (
            <button type="button" onClick={() => setPromoOpen(true)}
                    style={{
                      background: 'none', border: 'none', padding: 0,
                      color: 'var(--accent)', fontSize: 13,
                      textDecoration: 'underline', cursor: 'pointer',
                    }}>
              У меня есть промокод
            </button>
          ))}

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

        {/* ⚠️ Форма заявки — НИЖЕ тарифов, отдельной карточкой. Тарифы
            регистрируют (за деньги или бесплатно), заявка — нет: человек
            оставляет контакты, с ним свяжутся. Показываем оба варианта
            вместе, чтобы он выбрал сам. */}
        {requestForm && (
          <div style={{
            border: '1.5px dashed var(--border)', borderRadius: 14,
            padding: 14, marginBottom: 12,
          }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>
              {requestForm.title || 'Оставить заявку'}
            </div>
            <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: 'var(--muted)' }}>
              {requestForm.subtitle
                || 'Не готовы решить сейчас — оставьте контакты, и мы свяжемся с вами.'}
            </div>
            <button
              className="btn btn-primary"
              style={{ marginTop: 12 }}
              onClick={() => { setOnRequest(true); setStep(0); setError(null) }}
            >Оставить заявку</button>
          </div>
        )}

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
