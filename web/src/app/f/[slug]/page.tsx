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
          const v = q.field_id ? d.known?.fields?.[String(q.field_id)] : null
          if (v) pre[String(q.id)] = q.kind === 'multiselect' ? String(v).split(', ') : v
        }
        setAnswers(pre)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [slug, contactId, lm, pkg])

  const submit = async (choice?: { chosen_contact_id?: number; force_new?: boolean }) => {
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
          ...(choice || {}),
        }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.detail || 'Не удалось отправить')
      // ⚠️ Почта совпала с одним человеком, телефон с другим — решать не нам.
      // Спрашиваем, как в вебинарной авторизации и форме заказа тарифа.
      if (body.need_choice) { setCandidates(body.candidates || []); return }
      setCandidates(null)
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
    return <Shell><p className="text-sm text-gray-500">Загружаем…</p></Shell>
  }
  if (error && !data) {
    return <Shell><p className="text-sm text-red-600">{error}</p></Shell>
  }
  if (done) {
    return <Shell theme={data?.theme}><DoneView result={done} survey={data} /></Shell>
  }
  if (data.already_filled && !data.allow_repeat) {
    return (
      <Shell theme={data.theme}>
        <h1 className="mb-2 text-xl font-bold text-gray-900">{data.title}</h1>
        <p className="text-sm text-gray-600">
          Вы уже заполняли эту анкету — спасибо! Отвечать второй раз не нужно.
        </p>
      </Shell>
    )
  }

  const missingContacts = !contactId

  return (
    <Shell>
      <h1 className="mb-2 text-xl font-bold text-gray-900">{data.title}</h1>
      {data.intro && (
        <p className="mb-5 whitespace-pre-wrap text-sm text-gray-600">{data.intro}</p>
      )}
      {data.has_gift && (
        <div className="mb-5 rounded-xl border border-[#FFCFA4] bg-[#FFF8F0] p-3 text-sm text-gray-700">
          Подарок придёт сразу после отправки — ссылкой здесь и сообщением в боте.
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

      <div className="space-y-5">
        {data.questions.map((q: any) => (
          <Question key={q.id} q={q} value={answers[String(q.id)]}
                    onChange={(v: any) => setAnswers({ ...answers, [String(q.id)]: v })} />
        ))}
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <button onClick={submit} disabled={sending}
              className="mt-6 w-full rounded-xl bg-[#25455D] px-6 py-3 font-medium text-white disabled:opacity-50">
        {sending ? 'Отправляем…' : (data.submit_label || 'Отправить')}
      </button>

      <style jsx global>{`
        .fld {
          width: 100%; padding: 10px 12px; border: 1px solid #e5e7eb;
          border-radius: 10px; font-size: 15px; background: #fff; color: #111827;
        }
        .fld:focus { outline: none; border-color: #25455D; }
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
  const bg = t.lp_bg_color
    ? `linear-gradient(${t.lp_bg_angle ?? 45}deg, ${t.lp_bg_color}, ${t.lp_bg_color_2 || t.lp_bg_color})`
    : 'linear-gradient(45deg, #25455D, #0a1520)'
  return (
    <div className="min-h-screen px-4 py-8" style={{ background: bg }}>
      <div className="mx-auto w-full max-w-xl rounded-2xl p-6 shadow-sm"
           style={{
             background: t.lp_card_bg || '#fff',
             color: t.lp_card_text_color || t.lp_color_body || undefined,
             fontFamily: t.lp_font_body || undefined,
           }}>
        {children}
      </div>
    </div>
  )
}

function Labeled({ label, hint, required, children }: any) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-gray-700">
        {label}{required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {hint && <span className="mb-1 block text-xs text-gray-500">{hint}</span>}
      {children}
    </label>
  )
}

function Question({ q, value, onChange }: any) {
  const opts: string[] = Array.isArray(q.options) ? q.options : []

  if (q.kind === 'select') {
    return (
      <Labeled label={q.title} hint={q.hint} required={q.is_required}>
        <div className="space-y-1.5">
          {opts.map(o => (
            <label key={o} className="flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 p-2.5 text-sm hover:bg-gray-50">
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
      <Labeled label={q.title} hint={q.hint} required={q.is_required}>
        <div className="space-y-1.5">
          {opts.map(o => (
            <label key={o} className="flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 p-2.5 text-sm hover:bg-gray-50">
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
      <Labeled label={q.title} hint={q.hint} required={q.is_required}>
        <div className="flex gap-2">
          {['Да', 'Нет'].map(o => (
            <button key={o} type="button" onClick={() => onChange(o)}
                    className={`flex-1 rounded-lg border p-2.5 text-sm ${
                      value === o
                        ? 'border-[#25455D] bg-[#25455D] text-white'
                        : 'border-gray-200 text-gray-700 hover:bg-gray-50'
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
      <Labeled label={q.title} hint={q.hint} required={q.is_required}>
        <div className="flex flex-wrap gap-1.5">
          {nums.map(n => (
            <button key={n} type="button" onClick={() => onChange(String(n))}
                    className={`h-10 w-10 rounded-lg border text-sm ${
                      String(value) === String(n)
                        ? 'border-[#25455D] bg-[#25455D] text-white'
                        : 'border-gray-200 text-gray-700 hover:bg-gray-50'
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
      <Labeled label={q.title} hint={q.hint} required={q.is_required}>
        <textarea className="fld min-h-[90px]" value={value || ''}
                  onChange={e => onChange(e.target.value)} />
      </Labeled>
    )
  }

  return (
    <Labeled label={q.title} hint={q.hint} required={q.is_required}>
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
        <h1 className="mb-2 text-xl font-bold text-gray-900">Спасибо! Ваш подарок</h1>
        <p className="mb-4 text-sm text-gray-600">
          {result.sent_to_bot
            ? 'Мы также отправили его вам в бот — не потеряется.'
            : 'Сохраните ссылки, чтобы не потерять.'}
        </p>
        <div className="space-y-2">
          {materials.map((m: any, i: number) => (
            <a key={i} href={m.url} target="_blank" rel="noreferrer"
               className="block rounded-xl border border-gray-200 p-3 hover:bg-gray-50">
              <div className="font-medium text-[#25455D]">{m.name}</div>
              {m.description && (
                <div className="mt-0.5 text-sm text-gray-500">{m.description}</div>
              )}
            </a>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 className="mb-2 text-xl font-bold text-gray-900">Спасибо!</h1>
      <p className="whitespace-pre-wrap text-sm text-gray-600">
        {survey?.thanks_text || result.thanks_text || 'Мы получили ваши ответы.'}
      </p>
    </div>
  )
}
