'use client'

/**
 * Блок «Анкета / Заявка» на лендинге (миграция 352).
 *
 * Показывает анкету клиента прямо на странице: либо всеми вопросами сразу
 * («Форма»), либо по одному с прогрессом («Квиз»).
 *
 * ⚠️⚠️ ЭТО НЕ ВТОРАЯ СИСТЕМА АНКЕТ. Вопросы, приём ответов, обработка и
 * уведомления — те же самые: отправка идёт в `/public/surveys/{slug}/submit`,
 * ровно как со страницы `/f/{slug}`. Разница целиком в вёрстке. Своего приёма
 * ответов здесь быть не должно — он разъедется с публичной анкетой.
 *
 * ⚠️ ЗАЯВКА НИЧЕГО НЕ ОТКРЫВАЕТ. Ни кабинета, ни материалов, ни доступа к
 * продукту — только контакт в базе клиента и уведомление ему. Нулевого заказа
 * тоже не создаём: `product_orders` привязан к тарифу, а смысл блока как раз в
 * том, что тарифов на странице нет.
 *
 * ⚠️ Экран «Это вы?» обязателен: почта могла совпасть с одним контактом, а
 * телефон с другим — выбирает человек, а не мы. Тот же приём, что в форме
 * заказа тарифа и в авторизации вебинарной комнаты.
 */
import { useMemo, useRef, useState } from 'react'
import SupportButtons from '@/components/surveys/SupportButtons'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || ''

interface Props {
  survey: any
  view?: string | null
  /** contact_id из ссылки — человек пришёл из бота или из письма. */
  contactId?: string | null
  /** Оформление лендинга: кнопка блока должна выглядеть как соседние. */
  btnStyle?: any
  radius?: number
  /** Акцентный цвет темы («Цвет иконок и кнопок» в стилях лендингов). */
  accentColor?: string
  privacyUrl?: string | null
  /** Печать в PDF: форму не показываем — заполнить её на бумаге нельзя. */
  forPdf?: boolean
  pageUrl?: string
}

export default function SurveyBlock({
  survey, view, contactId, btnStyle, radius = 12,
  accentColor = '#FFCFA4', privacyUrl, forPdf = false, pageUrl = '',
}: Props) {
  const questions: any[] = Array.isArray(survey?.questions) ? survey.questions : []

  const [answers, setAnswers] = useState<Record<string, any>>({})
  const [contact, setContact] = useState({ name: '', email: '', phone: '' })
  const [pd, setPd] = useState(false)
  const [step, setStep] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<any>(null)
  const [candidates, setCandidates] = useState<any[] | null>(null)
  // ⚠️ Замок повторной отправки — обычной переменной, а не состоянием:
  // состояние применяется к СЛЕДУЮЩЕЙ перерисовке, и два быстрых нажатия
  // проходят оба. На форме заказа это уже давало два контакта и два заказа.
  const busy = useRef(false)

  const isQuiz = (view || 'form') === 'quiz'
  // Человек пришёл по ссылке с contact_id — мы его знаем, контакты не спрашиваем.
  const known = !!contactId

  const total = questions.length

  /* Обязательные вопросы текущего шага — чтобы не пускать дальше пустым. */
  const stepOk = useMemo(() => {
    if (!isQuiz) return true
    const q = questions[step]
    if (!q || !q.is_required) return true
    const v = answers[String(q.id)]
    return Array.isArray(v) ? v.length > 0 : String(v ?? '').trim() !== ''
  }, [isQuiz, questions, step, answers])

  if (forPdf) {
    /* ⚠️ В PDF форма бессмысленна — заполнить её нельзя. Вместо неё ссылка
       на живую страницу, иначе в файле остаётся мёртвый блок полей. */
    return (
      <div className="text-center">
        {!!survey.intro && <p className="mb-3 opacity-80">{survey.intro}</p>}
        <a href={pageUrl || '#'} style={btnStyle}
           className="inline-block px-6 py-3 font-semibold">
          {survey.submit_label || 'Оставить заявку'} — на сайте
        </a>
      </div>
    )
  }

  const setAnswer = (qid: number, v: any) =>
    setAnswers(p => ({ ...p, [String(qid)]: v }))

  const submit = async (choice?: { chosen_contact_id?: number; force_new?: boolean }) => {
    if (busy.current) return
    if (!pd) { setError('Поставьте галочку согласия на обработку данных'); return }

    // ⚠️ Те же проверки, что на публичной странице анкеты: без имени и
    // способа связи заявка приходит клиенту от неизвестно кого. Спрашиваем
    // только у того, кого не знаем: пришедшему по ссылке подставит бэкенд.
    if (!known && !choice?.chosen_contact_id) {
      if (!contact.name.trim()) { setError('Напишите, как вас зовут'); return }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email.trim())) {
        setError('Проверьте почту — кажется, в адресе опечатка'); return
      }
      if (contact.phone.replace(/\D/g, '').length < 10) {
        setError('Проверьте телефон — кажется, номер неполный'); return
      }
    }
    // Обязательные вопросы — до отправки, иначе сервер ответит ошибкой уже
    // после того, как человек нажал кнопку и ждёт.
    const miss = questions.filter(q => {
      if (!q.is_required) return false
      const v = answers[String(q.id)]
      return Array.isArray(v) ? !v.length : String(v ?? '').trim() === ''
    })
    if (miss.length) {
      setError('Заполните: ' + miss.map(q => q.title).slice(0, 3).join('; '))
      if (isQuiz) setStep(questions.indexOf(miss[0]))
      return
    }

    busy.current = true
    setSending(true); setError('')
    try {
      const r = await fetch(`${API_BASE}/api/v1/public/surveys/${survey.slug}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers,
          contact_id: contactId ? Number(contactId) : null,
          name: contact.name || null,
          email: contact.email || null,
          phone: contact.phone || null,
          consent_pd: pd,
          // Источник заявки (миграция 519): форма заявки этого события или
          // продукта — по нему заявка попадает во вкладку «Заявки».
          event_id: survey.source_event_id || null,
          product_id: survey.source_product_id || null,
          ...(choice || {}),
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.detail || 'Не удалось отправить')
      if (body.need_choice) { setCandidates(body.candidates || []); return }
      setCandidates(null)
      if (body.after_mode === 'url' && body.redirect_url) {
        window.location.href = body.redirect_url
        return
      }
      setDone(body)
    } catch (e: any) {
      const isNetwork = e instanceof TypeError
        || /failed to fetch|networkerror|load failed/i.test(e?.message || '')
      setError(isNetwork
        ? 'Связь прервалась — заявка не отправилась. Проверьте интернет и попробуйте ещё раз.'
        : e.message)
    } finally {
      busy.current = false
      setSending(false)
    }
  }

  /* ── Отправлено ──────────────────────────────────────────────────────── */
  if (done) {
    return (
      <div className="mx-auto max-w-xl text-center">
        <div className="mb-3 text-4xl">✓</div>
        <p className="whitespace-pre-wrap text-lg font-semibold">
          {done.thanks_text || survey.thanks_text || 'Спасибо! Заявка отправлена. Мы свяжемся с вами.'}
        </p>
        {/* Режим «с подарком»: материалы прямо здесь (и дублем в бот). */}
        {(done.materials || []).length > 0 && (
          <div className="mt-4 space-y-2 text-left">
            {done.materials.map((m: any, i: number) => (
              <a key={i} href={m.url} target="_blank" rel="noreferrer"
                 className="block rounded-xl border border-current/20 p-3 hover:bg-current/5">
                <div className="font-medium">{m.name}</div>
                {m.description && <div className="mt-0.5 text-sm opacity-70">{m.description}</div>}
              </a>
            ))}
          </div>
        )}
        {/* Режим «контакты службы заботы» (миграция 519). */}
        <SupportButtons support={done.support} />
      </div>
    )
  }

  /* ── «Это вы?» ───────────────────────────────────────────────────────── */
  if (candidates) {
    return (
      <div className="mx-auto max-w-xl">
        <p className="mb-3 font-semibold">Мы нашли вас в базе. Это вы?</p>
        <div className="space-y-2">
          {candidates.map((c: any) => (
            <button key={c.id} type="button" onClick={() => submit({ chosen_contact_id: c.id })}
              style={{ borderRadius: radius }}
              className="w-full border border-current/25 p-3 text-left text-sm hover:bg-current/5">
              <b>{c.name || 'Без имени'}</b>
              <span className="ml-2 opacity-70">{[c.email, c.phone].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
          <button type="button" onClick={() => submit({ force_new: true })}
            style={{ borderRadius: radius }}
            className="w-full border border-dashed border-current/25 p-3 text-sm opacity-80 hover:bg-current/5">
            Меня здесь нет — я впервые
          </button>
        </div>
      </div>
    )
  }

  // ⚠️ В КВИЗЕ КОНТАКТЫ — ОТДЕЛЬНЫЙ ПОСЛЕДНИЙ ШАГ, а не довесок к последнему
  // вопросу: иначе на одном экране и вопрос, и три поля с согласием, и шаг
  // перестаёт быть «одним вопросом», ради чего квиз и нужен.
  // Пришедшему по ссылке этот экран не показываем — его данные мы знаем.
  const contactStep = isQuiz && !known ? total : -1
  const onContactStep = isQuiz && step === contactStep
  const shown = isQuiz && onContactStep
    ? []
    : (isQuiz ? questions.slice(step, step + 1) : questions)
  const lastStep = !isQuiz
    || (contactStep >= 0 ? onContactStep : step >= total - 1)
  // Шагов на один больше, если контакты спрашиваем отдельным экраном.
  const steps = contactStep >= 0 ? total + 1 : total

  return (
    <div className="mx-auto max-w-xl">
      {!!survey.intro && !isQuiz && (
        <p className="mb-4 opacity-80">{survey.intro}</p>
      )}

      {/* Прогресс квиза: человеку важно видеть, сколько осталось. */}
      {isQuiz && steps > 1 && (
        <div className="mb-4">
          <div className="mb-1 flex justify-between text-xs opacity-70">
            <span>Шаг {Math.min(step + 1, steps)} из {steps}</span>
            <span>{Math.round((step / steps) * 100)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-current/15">
            <div className="h-full rounded-full transition-all"
              style={{ width: `${(step / steps) * 100}%`, background: accentColor }} />
          </div>
        </div>
      )}

      <div className="space-y-4">
        {shown.map(q => (
          <SurveyQuestion key={q.id} q={q}
            value={answers[String(q.id)]}
            onChange={(v: any) => setAnswer(q.id, v)}
            radius={radius} accent={accentColor} />
        ))}

        {/* Контакты — на последнем шаге квиза либо внизу формы.
            ⚠️ Спрашиваем только у незнакомого: пришедшему по ссылке из бота
            подставит бэкенд, и повторный ввод выглядел бы недоверием. */}
        {lastStep && !known && (
          <div className={onContactStep ? 'space-y-3' : 'space-y-3 border-t border-current/15 pt-4'}>
            {onContactStep && (
              <div className="mb-1">
                <p className="text-base font-semibold">Куда прислать ответ</p>
                <p className="mt-1 text-sm opacity-70">
                  Остался последний шаг — оставьте контакты, и мы свяжемся с вами.
                </p>
              </div>
            )}
            <Fld label="Как вас зовут" value={contact.name} radius={radius}
              onChange={(v: string) => setContact(p => ({ ...p, name: v }))} />
            <Fld label="Почта" type="email" value={contact.email} radius={radius}
              onChange={(v: string) => setContact(p => ({ ...p, email: v }))} />
            <Fld label="Телефон" type="tel" value={contact.phone} radius={radius}
              onChange={(v: string) => setContact(p => ({ ...p, phone: v }))} />
          </div>
        )}

        {/* ⚠️ Согласие на обработку ПД обязательно у любой формы сбора данных
            (правило проекта). Без галочки бэкенд ответит 422. */}
        {lastStep && (
          <label className="flex cursor-pointer items-start gap-2.5 text-xs opacity-80">
            <input type="checkbox" checked={pd} onChange={e => setPd(e.target.checked)}
              style={{ accentColor }}
              className="mt-0.5 h-4 w-4 shrink-0" />
            <span style={{ minWidth: 0 }} className="leading-snug">
              Согласен на обработку персональных данных
              {privacyUrl && (
                <>
                  {' \u2014 '}
                  <a href={privacyUrl} target="_blank" rel="noreferrer"
                    style={{ color: accentColor }} className="underline">
                    политика конфиденциальности
                  </a>
                </>
              )}
            </span>
          </label>
        )}

        {!!error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex gap-2">
          {isQuiz && step > 0 && (
            <button type="button" onClick={() => { setError(''); setStep(s => s - 1) }}
              style={{ borderRadius: radius, borderColor: accentColor, color: accentColor }}
              className="border px-4 py-3 text-sm font-medium">
              Назад
            </button>
          )}
          {!lastStep ? (
            <button type="button" style={btnStyle}
              onClick={() => {
                if (!stepOk) { setError('Ответьте на вопрос — он обязательный'); return }
                setError(''); setStep(s => s + 1)
              }}
              className="flex-1 px-6 py-3 font-semibold">
              Дальше
            </button>
          ) : (
            <button type="button" style={btnStyle} disabled={sending}
              onClick={() => submit()}
              className="flex-1 px-6 py-3 font-semibold disabled:opacity-60">
              {sending ? 'Отправляем…' : (survey.submit_label || 'Оставить заявку')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────
   Поле вопроса. ⚠️ Набор типов и их поведение — как на публичной странице
   анкеты (`/f/{slug}`): человек, заполнявший её там, не должен встретить
   здесь другие правила.
   ───────────────────────────────────────────────────────────────────────── */
function SurveyQuestion({ q, value, onChange, radius, accent }: any) {
  const opts: string[] = Array.isArray(q.options) ? q.options : []

  const wrap = (children: any) => (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">
        {q.title}{q.is_required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {!!q.hint && <span className="mb-1 block text-xs opacity-60">{q.hint}</span>}
      {!!q.image_url && (
        <img src={q.image_url} alt="" className="mb-2 w-full rounded-lg object-cover" />
      )}
      {children}
    </label>
  )

  const box = 'w-full border border-current/25 bg-transparent px-3 py-2.5 text-sm outline-none'

  if (q.kind === 'select' || q.kind === 'multiselect') {
    const multi = q.kind === 'multiselect'
    const arr: string[] = Array.isArray(value) ? value : []
    return wrap(
      <div className="flex flex-col gap-1.5">
        {opts.map(o => {
          const on = multi ? arr.includes(o) : value === o
          return (
            <Choice key={o} label={o} checked={on} multi={multi}
              accent={accent} radius={radius}
              onClick={() => onChange(multi
                ? (on ? arr.filter(x => x !== o) : [...arr, o])
                : o)} />
          )
        })}
      </div>
    )
  }

  if (q.kind === 'bool') {
    return wrap(
      <div className="flex flex-col gap-1.5">
        {['Да', 'Нет'].map(o => (
          <Choice key={o} label={o} checked={value === o} multi={false}
            accent={accent} radius={radius} onClick={() => onChange(o)} />
        ))}
      </div>
    )
  }

  if (q.kind === 'scale') {
    const min = q.scale_min ?? 1
    const max = q.scale_max ?? 10
    return wrap(
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map(n => (
          <button key={n} type="button" onClick={() => onChange(String(n))}
            style={{ borderRadius: radius }}
            className={`h-10 w-10 border text-sm ${
              String(value) === String(n)
                ? 'border-current bg-current/15 font-medium'
                : 'border-current/20 hover:bg-current/5'}`}>
            {n}
          </button>
        ))}
      </div>
    )
  }

  if (q.kind === 'textarea') {
    return wrap(
      <textarea className={`${box} min-h-[90px]`} style={{ borderRadius: radius }}
        value={value || ''} onChange={e => onChange(e.target.value)} />
    )
  }

  return wrap(
    <input className={box} style={{ borderRadius: radius }}
      type={q.kind === 'number' ? 'number' : q.kind === 'date' ? 'date' : 'text'}
      value={value || ''} onChange={e => onChange(e.target.value)} />
  )
}

function Choice({ label, checked, multi, accent, radius, onClick }: any) {
  return (
    <button type="button" onClick={onClick}
      style={{ borderRadius: radius, borderColor: checked ? accent : 'currentColor',
               opacity: checked ? 1 : 0.75 }}
      className="flex w-full items-center gap-2.5 border p-2.5 text-left text-sm hover:bg-current/5">
      <span style={{ borderColor: accent, borderRadius: multi ? 4 : 999 }}
        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center border-2">
        {checked && (
          <span style={{ background: accent, borderRadius: multi ? 2 : 999 }}
            className="h-2.5 w-2.5" />
        )}
      </span>
      <span className={checked ? 'font-medium' : ''}>{label}</span>
    </button>
  )
}

function Fld({ label, value, onChange, type = 'text', radius }: any) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        style={{ borderRadius: radius }}
        className="w-full border border-current/25 bg-transparent px-3 py-2.5 text-sm outline-none" />
    </label>
  )
}
