'use client'

/**
 * Публичная страница анкеты — `pluson.ru/f/{slug}` (миграция 280).
 *
 * ⚠️ Человека, пришедшего из бота, НЕ переспрашиваем: `?c={contact_id}` в
 * ссылке даёт нам имя, почту и телефон, они подставляются заполненными. В
 * анкете клиента из шести вопросов пять были контактными — в GetCourse их
 * приходилось вводить заново, потому что форма человека не знает.
 *
 * ⚠️ Если анкета открыта по дороге за подарком (`?lm=` / `?pkg=`), после
 * отправки материалы показываются прямо здесь И дублируются в бот той
 * площадки, откуда человек пришёл (`?to=`). «Спасибо» без подарка в этом
 * случае не показываем — человек шёл за файлом.
 */
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const PLATFORM_BY_SHORT: Record<string, string> = {
  tg: 'telegram', vk: 'vk', max: 'max',
}

/**
 * Черновик ответов в браузере.
 *
 * ⚠️ Анкета длинная (у клиента — 29 вопросов). Случайная перезагрузка,
 * переход «назад» или заснувший телефон стирали всё введённое, и человек
 * начинал заново — а чаще просто уходил. Держим ответы в localStorage и
 * возвращаем при следующем открытии; после успешной отправки — чистим.
 *
 * Ключ включает contact_id: с одного устройства анкету может заполнять
 * несколько человек (общий компьютер), их черновики не должны смешиваться.
 */
const draftKey = (slug: string, contactId: string | null) =>
  `pluson.survey.${slug}.${contactId || 'anon'}`

function loadDraft(key: string): any | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const d = JSON.parse(raw)
    // Черновик старше 30 дней неактуален — анкету за это время могли поменять.
    if (!d?.at || Date.now() - d.at > 30 * 24 * 3600 * 1000) return null
    return d
  } catch { return null }
}

export default function PublicSurveyPage() {
  const { slug } = useParams<{ slug: string }>()
  const search = useSearchParams()

  const contactId = search.get('c')
  const lm = search.get('lm')
  const pkg = search.get('pkg')
  const to = search.get('to') || ''

  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [answers, setAnswers] = useState<Record<string, any>>({})
  const [contact, setContact] = useState({ name: '', email: '', phone: '' })
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState<any>(null)
  // Экран «Это вы?»: данные совпали с несколькими людьми в базе.
  const [candidates, setCandidates] = useState<any[] | null>(null)
  // Согласия: обработка ПД обязательна, рассылки — по желанию.
  const [pd, setPd] = useState(false)
  // Человек уже заполнял и решил поправить ответы.
  const [editAgain, setEditAgain] = useState(false)
  const [mkt, setMkt] = useState(false)
  // Ответы вернулись из черновика — говорим об этом, иначе выглядит так,
  // будто анкету кто-то заполнил за него.
  const [restored, setRestored] = useState(false)

  // Автосохранение черновика: пишем на каждое изменение ответов и контактов.
  // Данных мало (текст), запись в localStorage синхронная и быстрая —
  // отдельный таймер-дебаунс тут только усложнил бы код.
  useEffect(() => {
    if (loading || done) return
    if (!Object.keys(answers).length && !contact.name && !contact.email && !contact.phone) return
    try {
      localStorage.setItem(draftKey(slug, contactId),
        JSON.stringify({ at: Date.now(), answers, contact }))
    } catch { /* приватный режим / переполнено — не мешаем заполнять анкету */ }
  }, [answers, contact, loading, done, slug, contactId])

  useEffect(() => {
    const qs = new URLSearchParams()
    if (contactId) qs.set('c', contactId)
    if (lm) qs.set('lm', lm)
    if (pkg) qs.set('pkg', pkg)
    fetch(`${API_BASE}/api/v1/public/surveys/${slug}?${qs}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Анкета не найдена')
        return r.json()
      })
      .then(d => {
        setData(d)
        setContact({
          name: d.known?.name || '', email: d.known?.email || '', phone: d.known?.phone || '',
        })
        // Уже известные значения полей подставляем в форму — человеку остаётся
        // только проверить, а не вводить заново.
        const pre: Record<string, any> = {}
        for (const q of d.questions || []) {
          // ⚠️ Прошлый ответ на ЭТОТ вопрос главнее значения поля контакта:
          // при правке человек должен видеть именно то, что писал в анкете.
          const prev = d.known?.answers?.[String(q.id)]
          const v = prev ?? (q.field_id ? d.known?.fields?.[String(q.field_id)] : null)
          if (v) pre[String(q.id)] = q.kind === 'multiselect' ? String(v).split(', ') : v
        }
        // ⚠️ Недописанный черновик ГЛАВНЕЕ подставленных значений: человек
        // начал отвечать и перезагрузил страницу — вернуть надо то, что писал
        // он, а не то, что мы знали о нём до этого.
        const draft = loadDraft(draftKey(slug, contactId))
        setAnswers(draft?.answers ? { ...pre, ...draft.answers } : pre)
        if (draft?.contact) {
          setContact(c => ({
            name: draft.contact.name || c.name,
            email: draft.contact.email || c.email,
            phone: draft.contact.phone || c.phone,
          }))
        }
        if (draft) setRestored(true)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [slug, contactId, lm, pkg])

  const submit = async (choice?: { chosen_contact_id?: number; force_new?: boolean }) => {
    if (!pd) {
      setError('Без согласия на обработку персональных данных отправить анкету нельзя')
      return
    }
    setSending(true); setError('')
    try {
      const r = await fetch(`${API_BASE}/api/v1/public/surveys/${slug}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers,
          contact_id: contactId ? Number(contactId) : null,
          name: contact.name || null,
          email: contact.email || null,
          phone: contact.phone || null,
          lead_magnet_id: lm ? Number(lm) : null,
          package_id: pkg ? Number(pkg) : null,
          platform: PLATFORM_BY_SHORT[to] || null,
          consent_pd: pd,
          consent_marketing: mkt,
          edit_again: editAgain,
          ...(choice || {}),
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.detail || 'Не удалось отправить')
      // ⚠️ Почта совпала с одним человеком, телефон с другим — решать не нам.
      // Спрашиваем, как в вебинарной авторизации и форме заказа тарифа.
      if (body.need_choice) { setCandidates(body.candidates || []); return }
      setCandidates(null)
      // Анкета ушла — черновик больше не нужен.
      try { localStorage.removeItem(draftKey(slug, contactId)) } catch {}
      if (body.after_mode === 'url' && body.redirect_url && !body.materials?.length) {
        window.location.href = body.redirect_url
        return
      }
      setDone(body)
    } catch (e: any) {
      // «Failed to fetch» человеку ничего не объясняет — переводим.
      const isNetwork = e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(e?.message || '')
      setError(isNetwork
        ? 'Связь прервалась — ответы не отправились. Проверьте интернет и попробуйте ещё раз.'
        : e.message)
    } finally { setSending(false) }
  }

  if (loading) {
    return <Shell><p className="text-sm opacity-70">Загружаем…</p></Shell>
  }
  if (error && !data) {
    return <Shell><p className="text-sm text-red-600">{error}</p></Shell>
  }
  if (done) {
    return <Shell theme={data?.theme}><DoneView result={done} survey={data} /></Shell>
  }
  // ⚠️ Уже заполнял → показываем подарок СРАЗУ (он заслужил его в прошлый
  // раз) и предлагаем поправить ответы. Прошлое заполнение при этом не
  // затирается: правка уходит ОТДЕЛЬНОЙ записью, история сохраняется.
  if (data.already_filled && !data.allow_repeat && !editAgain) {
    const mats = data.already_materials || []
    return (
      <Shell theme={data.theme}>
        <BrandHeader brand={data.brand} theme={data.theme} />
        <h1 className="mb-2 text-xl font-bold">{data.title}</h1>
        <p className="mb-4 text-sm opacity-80">
          Вы уже заполняли эту анкету — спасибо!
        </p>

        {mats.length > 0 && (
          <div className="mb-5">
            <p className="mb-2 text-sm font-medium">Ваш подарок:</p>
            <div className="space-y-2">
              {mats.map((m: any, i: number) => (
                <a key={i} href={m.url} target="_blank" rel="noreferrer"
                   className="block rounded-xl border border-current/20 p-3 hover:bg-current/5">
                  <div className="font-medium">{m.name}</div>
                  {m.description && (
                    <div className="mt-0.5 text-sm opacity-70">{m.description}</div>
                  )}
                </a>
              ))}
            </div>
          </div>
        )}

        <button onClick={() => setEditAgain(true)}
                className="w-full rounded-xl border border-current/30 px-6 py-3 text-sm font-medium hover:bg-current/5">
          Изменить ответы
        </button>
      </Shell>
    )
  }

  const missingContacts = !contactId

  return (
    <Shell>
      <BrandHeader brand={data.brand} theme={data.theme} />
      {data.image_url && (
        <img src={data.image_url} alt=""
             className="mb-4 w-full rounded-xl object-cover" />
      )}
      <h1 className="mb-2 text-xl font-bold">{data.title}</h1>
      {data.intro && (
        <p className="mb-5 whitespace-pre-wrap text-sm opacity-80">{data.intro}</p>
      )}
      {data.has_gift && (
        <div className="mb-5 rounded-xl border border-[#FFCFA4] bg-[#FFCFA4]/10 p-3 text-sm">
          {data.gift_name ? (
            <>
              За заполнение анкеты вы получите: <b>{data.gift_name}</b>.
              <div className="mt-1 opacity-80">
                Придёт сразу после отправки — ссылкой здесь и сообщением в боте.
              </div>
            </>
          ) : (
            'Подарок придёт сразу после отправки — ссылкой здесь и сообщением в боте.'
          )}
        </div>
      )}

      {/* Контакты спрашиваем ТОЛЬКО у незнакомого человека: пришедший из бота
          уже опознан, и повторный ввод отпугивает. */}
      {missingContacts && (
        <div className="mb-5 space-y-3">
          <Labeled label="Как вас зовут">
            <input className="fld" value={contact.name}
                   onChange={e => setContact({ ...contact, name: e.target.value })} />
          </Labeled>
          <Labeled label="Почта">
            <input className="fld" type="email" value={contact.email}
                   onChange={e => setContact({ ...contact, email: e.target.value })} />
          </Labeled>
          <Labeled label="Телефон">
            <input className="fld" value={contact.phone}
                   onChange={e => setContact({ ...contact, phone: e.target.value })} />
          </Labeled>
        </div>
      )}

      {restored && (
        <div className="mb-4 rounded-xl border border-current/20 bg-current/5 p-3 text-sm">
          Мы вернули ваши ответы — можно продолжить с того места, где остановились.
        </div>
      )}

      <div className="space-y-5">
        {data.questions.map((q: any) => (
          <Question key={q.id} q={q} value={answers[String(q.id)]}
                    onChange={(v: any) => setAnswers({ ...answers, [String(q.id)]: v })} />
        ))}
      </div>

      {/* ⚠️ Согласия ОБЯЗАТЕЛЬНЫ на любой форме сбора данных. Раньше блок был
          объявлен, но на странице не выводился: отправка упиралась в ошибку
          «без согласия нельзя», а поставить галочку было негде. */}
      <div className="mt-6 space-y-3 border-t border-current/10 pt-4">
        <Consent checked={pd} onChange={setPd}>
          Я согласен на обработку моих персональных данных.{' '}
          {data.privacy_url ? (
            <>С{' '}
              <a href={data.privacy_url} target="_blank" rel="noreferrer" className="underline">
                Политикой обработки персональных данных
              </a>{' '}ознакомлен.
            </>
          ) : 'С Политикой обработки персональных данных ознакомлен.'}
        </Consent>

        <Consent checked={mkt} onChange={setMkt}>
          Я согласен на получение информационных и маркетинговых рассылок
          {brandLabel(data.brand) && <> от {brandLabel(data.brand)}</>}.
          {' '}Вы в любой момент можете отказаться от получения писем.
        </Consent>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {/* ⚠️ Вызов обёрнут: submit принимает выбор контакта ({chosen_contact_id}),
          а onClick передал бы объект события мыши — и в разбор выбора попал бы мусор. */}
      <button onClick={() => submit()} disabled={sending}
              style={{
                background: data.theme?.lp_btn_color || '#25455D',
                color: data.theme?.lp_btn_text_color || '#fff',
                borderRadius: data.theme?.lp_btn_radius ?? 12,
              }}
              className="mt-6 w-full px-6 py-3 font-medium disabled:opacity-50">
        {sending ? 'Отправляем…' : (data.submit_label || 'Отправить')}
      </button>

      <style jsx global>{`
        /* ⚠️ Поля прозрачные и наследуют цвет карточки: у клиента карточка
           тёмная (#0F1E2E), и белое поле с тёмным текстом на ней выглядело
           заплаткой. currentColor даёт читаемость на любом фоне. */
        .fld {
          width: 100%; padding: 10px 12px; border-radius: 10px; font-size: 15px;
          background: rgba(127,127,127,.12); color: inherit;
          border: 1px solid currentColor; border-color: color-mix(in srgb, currentColor 25%, transparent);
        }
        .fld::placeholder { color: currentColor; opacity: .45; }
        .fld:focus { outline: none; border-color: currentColor; }
      `}</style>
    </Shell>
  )
}

/**
 * ⚠️ Оформление берётся из «Стилей лендингов» клиента (решение владельца):
 * анкета должна выглядеть как его лендинг, а не как чужая страница. Тема
 * приходит вместе с анкетой; чего клиент не задал — остаётся наш дефолт.
 */
function Shell({ children, theme }: { children: React.ReactNode; theme?: any }) {
  const t = theme || {}
  // ⚠️ Заливку считает бэкенд (`client_landing_theme`) — тем же правилом, что
  // у лендинга и оферты. Анкета длинная (у клиента 26 вопросов), поэтому
  // берём зеркальный `bg_css_long`: обычный градиент растягивается, и низ
  // страницы уходит в тёмный конец.
  const bg = t.bg_css_long || t.bg_css || 'linear-gradient(45deg, #25455D, #0a1520)'
  return (
    <div className="min-h-screen px-4 py-8" style={{ background: bg }}>
      <div className="mx-auto w-full max-w-xl rounded-2xl p-6 shadow-sm"
           style={{
             // ⚠️ Карточка всегда светлая (см. CARD_BG) — тему клиента к ней
             // не применяем: тёмная заливка делала 26 вопросов нечитаемыми.
             // Цвет текста тоже не берём из темы — он рассчитан на тёмный фон
             // (белый по белому).
             background: CARD_BG,
             fontFamily: t.lp_font_body || undefined,
           }}>
        {children}
      </div>
    </div>
  )
}

function Labeled({ label, hint, required, image, children }: any) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">
        {label}{required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {hint && <span className="mb-1 block text-xs opacity-60">{hint}</span>}
      {/* Картинка вопроса — над полем ответа: сначала смотрят, потом отвечают. */}
      {image && <img src={image} alt="" className="mb-2 w-full rounded-lg object-cover" />}
      {children}
    </label>
  )
}

function Question({ q, value, onChange }: any) {
  const opts: string[] = Array.isArray(q.options) ? q.options : []

  if (q.kind === 'select') {
    return (
      <Labeled label={q.title} hint={q.hint} required={q.is_required} image={q.image_url}>
        <div className="space-y-1.5">
          {opts.map(o => (
            <label key={o} className="flex cursor-pointer items-center gap-2 rounded-lg border border-current/20 p-2.5 text-sm hover:bg-current/5">
              <input type="radio" name={`q${q.id}`} checked={value === o}
                     onChange={() => onChange(o)} className="h-4 w-4" />
              <span className="text-gray-800">{o}</span>
            </label>
          ))}
        </div>
      </Labeled>
    )
  }

  if (q.kind === 'multiselect') {
    const arr: string[] = Array.isArray(value) ? value : []
    return (
      <Labeled label={q.title} hint={q.hint} required={q.is_required} image={q.image_url}>
        <div className="space-y-1.5">
          {opts.map(o => (
            <label key={o} className="flex cursor-pointer items-center gap-2 rounded-lg border border-current/20 p-2.5 text-sm hover:bg-current/5">
              <input type="checkbox" checked={arr.includes(o)}
                     onChange={e => onChange(e.target.checked
                       ? [...arr, o] : arr.filter(x => x !== o))}
                     className="h-4 w-4 rounded" />
              <span className="text-gray-800">{o}</span>
            </label>
          ))}
        </div>
      </Labeled>
    )
  }

  if (q.kind === 'bool') {
    return (
      <Labeled label={q.title} hint={q.hint} required={q.is_required} image={q.image_url}>
        <div className="flex gap-2">
          {['Да', 'Нет'].map(o => (
            <button key={o} type="button" onClick={() => onChange(o)}
                    className={`flex-1 rounded-lg border p-2.5 text-sm ${
                      value === o
                        ? 'border-current bg-current/15 font-medium'
                        : 'border-current/20 opacity-80 hover:bg-current/5'
                    }`}>
              {o}
            </button>
          ))}
        </div>
      </Labeled>
    )
  }

  if (q.kind === 'scale') {
    const min = q.scale_min ?? 1
    const max = q.scale_max ?? 10
    const nums = Array.from({ length: max - min + 1 }, (_, i) => min + i)
    return (
      <Labeled label={q.title} hint={q.hint} required={q.is_required} image={q.image_url}>
        <div className="flex flex-wrap gap-1.5">
          {nums.map(n => (
            <button key={n} type="button" onClick={() => onChange(String(n))}
                    className={`h-10 w-10 rounded-lg border text-sm ${
                      String(value) === String(n)
                        ? 'border-current bg-current/15 font-medium'
                        : 'border-current/20 opacity-80 hover:bg-current/5'
                    }`}>
              {n}
            </button>
          ))}
        </div>
      </Labeled>
    )
  }

  if (q.kind === 'textarea') {
    return (
      <Labeled label={q.title} hint={q.hint} required={q.is_required} image={q.image_url}>
        <textarea className="fld min-h-[90px]" value={value || ''}
                  onChange={e => onChange(e.target.value)} />
      </Labeled>
    )
  }

  return (
    <Labeled label={q.title} hint={q.hint} required={q.is_required} image={q.image_url}>
      <input className="fld"
             type={q.kind === 'number' ? 'number' : q.kind === 'date' ? 'date' : 'text'}
             value={value || ''} onChange={e => onChange(e.target.value)} />
    </Labeled>
  )
}

function DoneView({ result, survey }: any) {
  const materials = result.materials || []

  if (materials.length) {
    return (
      <div>
        <h1 className="mb-2 text-xl font-bold">Спасибо! Ваш подарок</h1>
        <p className="mb-4 text-sm opacity-80">
          {result.sent_to_bot
            ? 'Мы также отправили его вам в бот — не потеряется.'
            : 'Сохраните ссылки, чтобы не потерять.'}
        </p>
        <div className="space-y-2">
          {materials.map((m: any, i: number) => (
            <a key={i} href={m.url} target="_blank" rel="noreferrer"
               className="block rounded-xl border border-current/20 p-3 hover:bg-current/5">
              <div className="font-medium text-[#25455D]">{m.name}</div>
              {m.description && (
                <div className="mt-0.5 text-sm opacity-70">{m.description}</div>
              )}
            </a>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 className="mb-2 text-xl font-bold">Спасибо!</h1>
      <p className="whitespace-pre-wrap text-sm opacity-80">
        {survey?.thanks_text || result.thanks_text || 'Мы получили ваши ответы.'}
      </p>
    </div>
  )
}

/**
 * Фон карточки анкеты. ⚠️ Белый НАМЕРЕННО и не берётся из темы клиента:
 * анкета длинная (у клиента 26 вопросов), и читать её на тёмном тяжело.
 * Единая точка — чтобы заливка карточки и выбор логотипа не разъехались.
 */
const CARD_BG = '#fff'

/**
 * Светлый ли фон карточки — по нему выбираем версию логотипа.
 * Пусто = белая карточка по умолчанию, значит светлый.
 */
function isLightBg(color?: string): boolean {
  if (!color) return true
  const m = color.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return false           // rgba/градиент — считаем тёмным, как у лендинга
  let hex = m[1]
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  // Воспринимаемая яркость (ITU-R BT.601): глаз видит зелёный ярче синего.
  return (r * 299 + g * 587 + b * 114) / 1000 > 150
}

/** Кому принадлежит анкета — для текста согласия на рассылки. */
function brandLabel(brand: any): string {
  if (!brand) return ''
  const parts = [brand.owner_name, brand.brand_name && `«${brand.brand_name}»`]
  return parts.filter(Boolean).join(', ')
}

/**
 * Шапка анкеты: логотип клиента, бренд и имя основателя.
 *
 * ⚠️ Та же шапка, что на остальных публичных страницах: человек должен
 * понимать, чью анкету заполняет, ещё до первого вопроса.
 */
function BrandHeader({ brand, theme }: { brand: any; theme?: any }) {
  if (!brand || (!brand.logo_url && !brand.brand_name && !brand.owner_name)) return null
  // ⚠️ Смотреть надо на фон КАРТОЧКИ, под которым лежит логотип, а не на
  // тему страницы. Карточка анкеты БЕЛАЯ намеренно (так удобнее читать
  // длинный список вопросов) — `lp_card_bg` из темы к ней не применяется.
  // Раньше проверка шла по теме: там тёмный #0F1E2E, код считал фон тёмным
  // и брал белый логотип — он сливался с белой карточкой.
  const logo = isLightBg(CARD_BG)
    ? (brand.logo_light_url || brand.logo_url)
    : brand.logo_url
  return (
    <div className="mb-5 flex items-center gap-3 border-b border-current/10 pb-4">
      {logo && (
        <img src={logo} alt=""
             className="h-12 w-12 shrink-0 rounded-xl object-contain" />
      )}
      <div className="min-w-0">
        {brand.brand_name && (
          <div className="truncate font-semibold">{brand.brand_name}</div>
        )}
        {brand.owner_name && (
          <div className="truncate text-sm opacity-70">{brand.owner_name}</div>
        )}
      </div>
    </div>
  )
}

/** Галочка согласия — та же форма, что в заказе тарифа. */
function Consent({ checked, onChange, children }: any) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-[.85em] leading-snug">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300"
      />
      <span className="opacity-80">{children}</span>
    </label>
  )
}
