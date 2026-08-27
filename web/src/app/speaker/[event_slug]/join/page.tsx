'use client'

/**
 * Веб-регистрация в состав — `{домен клиента}/speaker/{event_slug}/join`.
 *
 * Зачем. До этого записаться спикером/номинантом можно было только через бот
 * (ссылка `spkreg_` в TG/VK/MAX). У клиента без подключённых ботов — а модуль
 * «Премии/Турниры» берут ради организации работы, отдельно от рассылок —
 * ссылки не было вовсе, состав заводили руками по одному.
 *
 * ⚠️ Человек НЕ вводит код доступа: он его ещё не знает. После отправки формы
 * сервер отдаёт токен кабинета, мы кладём его в тот же ключ localStorage, что
 * использует сам кабинет, и уводим туда — человек сразу заполняет карточку.
 * Код показываем на экране и дублируем письмом: он нужен, чтобы вернуться
 * позже или с другого устройства.
 *
 * ⚠️ Согласие на обработку ПД обязательно — здесь собираются персональные
 * данные (правило всех форм проекта).
 */
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const PEACH = '#FFCFA4'
const DARK = '#25455D'

const TOKEN_KEY = (slug: string) => `speaker_cabinet_token_${slug}`

const WORDS: Record<string, { nom: string; gen: string; plural_gen: string; ins: string }> = {
  speaker: { nom: 'спикер', gen: 'спикера', plural_gen: 'спикеров', ins: 'спикером' },
  nominee: { nom: 'номинант', gen: 'номинанта', plural_gen: 'номинантов', ins: 'номинантом' },
  member: { nom: 'участник', gen: 'участника', plural_gen: 'участников', ins: 'участником' },
}
const words = (k?: string) => WORDS[k || 'speaker'] || WORDS.speaker

/** ⚠️ Ответ сервера — не всегда JSON: при 500 приходит текст «Internal Server
 * Error», и `r.json()` падает SyntaxError. Человек видел бы вместо ошибки
 * непонятную надпись про токен. */
async function readJson(r: Response): Promise<any> {
  const text = await r.text()
  try { return text ? JSON.parse(text) : {} } catch { return { detail: text.slice(0, 200) } }
}

export default function SpeakerJoinPage() {
  const { event_slug: slug } = useParams<{ event_slug: string }>()
  const router = useRouter()

  const [info, setInfo] = useState<any>(null)
  const [loadError, setLoadError] = useState('')
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', telegram_username: '', phone: '',
  })
  const [pd, setPd] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<any>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!slug) return
    fetch(`${API}/api/v1/public/speaker-signup/${slug}`)
      .then(async r => {
        const d = await readJson(r)
        if (!r.ok) throw new Error(d.detail || 'Событие не найдено')
        return d
      })
      .then(setInfo)
      .catch(e => setLoadError(String(e.message || e)))
  }, [slug])

  const w = words(info?.person_wording)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!pd) { setError('Отметьте согласие на обработку персональных данных'); return }
    setSending(true)
    try {
      const r = await fetch(`${API}/api/v1/public/speaker-signup/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, consent_pd: true }),
      })
      const d = await readJson(r)
      if (!r.ok) { setError(d.detail || 'Не получилось зарегистрироваться'); setSending(false); return }
      // Кладём сессию туда же, откуда её читает кабинет, — человек попадёт
      // внутрь без ввода кода.
      try { localStorage.setItem(TOKEN_KEY(slug), d.token) } catch { /* приватный режим */ }
      setDone(d)
    } catch {
      setError('Ошибка сети. Проверьте соединение и попробуйте ещё раз')
    }
    setSending(false)
  }

  const wrap: React.CSSProperties = {
    minHeight: '100vh', background: `linear-gradient(45deg, ${DARK}, #0a1520)`,
    padding: 20, fontFamily: 'Roboto, sans-serif',
  }
  const card: React.CSSProperties = {
    maxWidth: 480, margin: '40px auto', background: '#fff', borderRadius: 16,
    padding: 28, boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
  }
  const inputCss: React.CSSProperties = {
    width: '100%', padding: '12px 14px', borderRadius: 10, border: '1px solid #d4dee5',
    fontSize: 15, marginBottom: 12, boxSizing: 'border-box',
  }
  const labelCss: React.CSSProperties = {
    display: 'block', fontSize: 13, color: '#5c7589', marginBottom: 6,
  }

  if (loadError) {
    return (
      <div style={wrap}>
        <div style={card}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: DARK, marginBottom: 8 }}>Страница не найдена</h1>
          <p style={{ fontSize: 14, color: '#5c7589' }}>{loadError}</p>
        </div>
      </div>
    )
  }

  if (!info) {
    return <div style={wrap}><div style={{ ...card, textAlign: 'center', color: '#7a8c9c' }}>Загружаем…</div></div>
  }

  // ─── Готово ────────────────────────────────────────────────────────────
  if (done) {
    return (
      <div style={wrap}>
        <div style={card}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, marginBottom: 8 }}>
            {done.already ? 'Вы уже в составе' : 'Готово!'}
          </h1>
          <p style={{ fontSize: 15, color: '#5c7589', lineHeight: 1.5, marginBottom: 18 }}>
            Вы {w.nom} события «{info.event_title}». Осталось заполнить карточку — фото,
            позиционирование и регалии: их увидят зрители и организаторы.
          </p>

          {/* ⚠️ Код — единственный способ вернуться в кабинет позже: сейчас
              человек войдёт по выданной сессии, но она живёт 24 часа. Поэтому
              код виден крупно, копируется в одно нажатие и дублируется письмом. */}
          <div style={{ background: '#f5f8fa', border: '1px solid #e2eaf0', borderRadius: 12, padding: 14, marginBottom: 18 }}>
            <div style={{ fontSize: 13, color: '#5c7589', marginBottom: 6 }}>Ваш код доступа в кабинет</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: 'monospace', fontSize: 22, letterSpacing: 2, color: DARK, fontWeight: 700 }}>
                {done.access_code}
              </div>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(done.access_code)
                    .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
                    .catch(() => { /* браузер без доступа к буферу — код виден рядом */ })
                }}
                style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: 'pointer', border: `1px solid ${copied ? '#63b47b' : '#c9d6e0'}`, background: copied ? '#e8f6ec' : '#fff', color: copied ? '#2f7a45' : DARK }}
              >
                {copied ? '✓ Скопировано' : 'Скопировать'}
              </button>
            </div>
            <div style={{ fontSize: 12, color: '#7a8c9c', marginTop: 10, lineHeight: 1.5 }}>
              <b style={{ color: '#5c7589' }}>Сохраните код.</b>{' '}
              {done.email_sent
                ? 'Мы продублировали его письмом на вашу почту — код понадобится, чтобы вернуться в кабинет позже или зайти с другого устройства.'
                : 'Он понадобится, чтобы вернуться в кабинет позже или зайти с другого устройства.'}
            </div>
          </div>

          <button
            onClick={() => router.push(`/speaker/${slug}`)}
            style={{ width: '100%', padding: 14, background: PEACH, color: DARK, fontWeight: 700, fontSize: 15, border: 'none', borderRadius: 10, cursor: 'pointer' }}
          >
            Перейти в кабинет
          </button>
        </div>
      </div>
    )
  }

  // ─── Форма ─────────────────────────────────────────────────────────────
  return (
    <div style={wrap}>
      <div style={card}>
        {info.brand_logo_url && (
          <img src={info.brand_logo_url} alt="" style={{ maxHeight: 44, marginBottom: 14 }} />
        )}
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, marginBottom: 6 }}>
          Регистрация {w.gen}
        </h1>
        <div style={{ fontSize: 15, color: '#5c7589', marginBottom: 20 }}>«{info.event_title}»</div>

        {info.poster_url && (
          <img src={info.poster_url} alt=""
            style={{ width: '100%', borderRadius: 12, marginBottom: 20, display: 'block' }} />
        )}

        <form onSubmit={submit}>
          <label style={labelCss}>Имя</label>
          <input value={form.first_name} required autoComplete="given-name"
            onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
            style={inputCss} placeholder="Мария" />

          <label style={labelCss}>Фамилия</label>
          <input value={form.last_name} required autoComplete="family-name"
            onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
            style={inputCss} placeholder="Иванова" />

          <label style={labelCss}>Email</label>
          <input value={form.email} required type="email" autoComplete="email"
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            style={inputCss} placeholder="mail@example.ru" />
          <div style={{ fontSize: 12, color: '#7a8c9c', marginTop: -6, marginBottom: 12 }}>
            На него придёт код доступа в кабинет.
          </div>

          <label style={labelCss}>Ник в Telegram</label>
          <input value={form.telegram_username} required
            onChange={e => setForm(f => ({ ...f, telegram_username: e.target.value }))}
            style={inputCss} placeholder="ivanova" />
          <div style={{ fontSize: 12, color: '#7a8c9c', marginTop: -6, marginBottom: 12 }}>
            Без «@». По нему организатор свяжется с вами.
          </div>

          <label style={labelCss}>Телефон <span style={{ color: '#9aaab8' }}>— если хотите</span></label>
          <input value={form.phone} autoComplete="tel" type="tel"
            onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
            style={inputCss} placeholder="+7 900 000-00-00" />

          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '6px 0 16px', cursor: 'pointer' }}>
            <input type="checkbox" checked={pd} onChange={e => setPd(e.target.checked)}
              style={{ width: 18, height: 18, marginTop: 2, flex: '0 0 18px' }} />
            <span style={{ fontSize: 12, color: '#5c7589', lineHeight: 1.5 }}>
              Согласен на обработку персональных данных
              {info.privacy_url && (
                <> — <a href={info.privacy_url} target="_blank" rel="noreferrer" style={{ color: DARK, fontWeight: 600 }}>политика</a></>
              )}
            </span>
          </label>

          {error && (
            <div style={{ background: '#ffe9e0', color: '#a83e1c', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
              {error}
            </div>
          )}

          <button type="submit" disabled={sending}
            style={{ width: '100%', padding: 14, background: PEACH, color: DARK, fontWeight: 700, fontSize: 15, border: 'none', borderRadius: 10, cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.6 : 1 }}>
            {sending ? 'Регистрируем…' : `Стать ${w.ins}`}
          </button>
        </form>

        <p style={{ marginTop: 16, fontSize: 12, color: '#7a8c9c', lineHeight: 1.5 }}>
          Уже регистрировались? <a href={`/speaker/${slug}`} style={{ color: DARK, fontWeight: 600 }}>Войдите в кабинет</a> по фамилии и коду доступа.
        </p>
      </div>
    </div>
  )
}
