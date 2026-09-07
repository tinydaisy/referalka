'use client'

/**
 * Партнёрский кабинет — внутри кабинета покупателя (решение № 30).
 *
 * ⚠️ Кабинет ОДИН: партнёрка и купленные материалы — разделы одного кабинета
 * человека, с одним входом. Два входа с разными паролями в один кабинет —
 * гарантия второго контакта и потерянных начислений.
 *
 * Три раздела: Рекламные материалы, Мои продажи, Мои люди.
 *
 * ⚠️ «Мои люди» — это НЕ ТОЛЬКО купившие. Показываем и тех, кто пришёл по
 * ссылке и ещё ничего не купил: именно с ними партнёру и работать. У каждого
 * — кнопки «написать» в его мессенджеры, чтобы не искать человека вручную.
 * Раздел появляется, когда есть кого показать (поле show_people с бэкенда).
 *
 * ⚠️ Ноль не объясняем (№ 31): пустой кабинет — просто пусто.
 */

import { useEffect, useState } from 'react'

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''

type Tab = 'materials' | 'sales' | 'people' | 'network'

const money = (v: any) =>
  (Number(v) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽'

const dt = (v: any) =>
  v ? new Date(v).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—'

async function get(path: string, token: string) {
  const res = await fetch(`${apiBase}/api/v1/public/partner${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.detail || 'Ошибка')
  return res.json()
}

export default function PartnerCabinet({ token }: { token: string }) {
  const [me, setMe] = useState<any>(null)
  const [tab, setTab] = useState<Tab>('materials')

  useEffect(() => {
    get('/me', token).then(setMe).catch(() => setMe({ is_partner: false }))
  }, [token])

  if (!me) return <p className="text-sm text-gray-400">Загружаем…</p>
  if (!me.is_partner) return <BecomePartner token={token} />

  const tabs: [Tab, string][] = [
    ['materials', 'Что рекомендовать'],
    ['sales', 'Мои продажи'],
    ...(me.show_people ? [['people', 'Мои люди'] as [Tab, string]] : []),

  ]

  return (
    <div>
      {/* Сводка: деньги и режим. ⚠️ Режим ОБЯЗАН быть виден партнёру — иначе
          он считает по одним правилам, а система по другим, и приходят
          жалобы «почему не начислили». */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="К выплате" value={money(me.due)} accent />
        <Stat label="Выплачено" value={money(me.paid)} />
        <Stat label="Продаж" value={String(me.sales_count)} />
      </div>

      <div className="mb-5 rounded-xl bg-white p-3 text-xs text-gray-600 shadow-sm">
        {me.payout_mode === 'passive' ? (
          <>Вознаграждение идёт со <b>всех покупок</b> людей, которых вы привели.</>
        ) : (
          <>Вознаграждение идёт за <b>каждую покупку по вашей рекомендации</b>.</>
        )}
        {me.levels > 1 && <> Уровней вознаграждения: {me.levels}.</>}
      </div>

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-gray-200">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium ${
              tab === key
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'materials' && <Materials token={token} />}
      {tab === 'sales' && <Sales token={token} />}
      {tab === 'people' && <People token={token} />}
      {tab === 'network' && <Network token={token} />}
    </div>
  )
}

/* ─── Стать партнёром ────────────────────────────────────────────────────── */

function BecomePartner({ token }: { token: string }) {
  const [offer, setOffer] = useState<any>(null)
  const [tax, setTax] = useState('')
  const [accept, setAccept] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    // ⚠️ client_id обязателен: без него ручка отдаёт 400 «Не удалось
    // определить кабинет» — по Host кабинет узнаётся, только когда у клиента
    // есть СВОЙ домен страниц. Без параметра оферта не приходила вовсе, и
    // список налоговых статусов в форме оставался ПУСТЫМ: партнёром нельзя
    // было стать в принципе (прод, 07.09.2026).
    const cid = new URLSearchParams(window.location.search).get('client_id')
    fetch(`${apiBase}/api/v1/public/partner/offer${cid ? `?client_id=${cid}` : ''}`)
      .then(r => r.json()).then(setOffer).catch(() => setOffer(null))
  }, [])

  const submit = async () => {
    setBusy(true); setError('')
    try {
      const res = await fetch(`${apiBase}/api/v1/public/partner/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tax_status: tax, accept: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.detail || 'Не получилось')
      window.location.reload()
    } catch (e: any) {
      setError(e?.message || 'Что-то пошло не так')
    } finally { setBusy(false) }
  }

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm">
      <h2 className="mb-2 text-lg font-bold text-gray-900">
        Рекомендуйте и получайте вознаграждение
      </h2>
      <p className="mb-4 text-sm text-gray-600">
        Вы получаете личные ссылки на события и продукты{offer?.brand ? ` «${offer.brand}»` : ''}.
        Человек покупает по вашей ссылке — вам начисляется вознаграждение.
      </p>

      {offer?.body && (
        <details className="mb-4 rounded-xl bg-gray-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-gray-700">
            {offer.title || 'Условия участия'}
          </summary>
          <div className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-gray-600">
            {offer.body}
          </div>
        </details>
      )}

      {/* ⚠️ Налоговый статус обязателен (№ 14): деньги платим только тем, кто
          может их легально принять. Это осознанный вход, а не галочка. */}
      <label className="mb-1 block text-sm font-medium text-gray-700">
        Ваш налоговый статус
      </label>
      <select
        value={tax} onChange={e => setTax(e.target.value)}
        className="mb-4 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
      >
        <option value="">Выберите…</option>
        {(offer?.tax_statuses || []).map((s: any) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>

      <label className="mb-4 flex gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={accept} className="mt-1"
               onChange={e => setAccept(e.target.checked)} />
        <span>Принимаю условия участия в партнёрской программе</span>
      </label>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <button onClick={submit} disabled={busy || !accept || !tax} className="btn-gold w-full">
        {busy ? 'Отправляем…' : 'Стать партнёром'}
      </button>
    </div>
  )
}

/* ─── Материалы ──────────────────────────────────────────────────────────── */

function Materials({ token }: { token: string }) {
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    get('/me/materials', token).then(setData).catch(() => setData({}))
  }, [token])

  if (!data) return <p className="text-sm text-gray-400">Загружаем…</p>

  const groups: [string, any[]][] = [
    ['События', data.events || []],
    ['Продукты', data.products || []],
    ['Подарки и материалы', data.lead_magnets || []],
  ]
  const empty = groups.every(([, items]) => !items.length)

  if (empty) {
    return <p className="text-sm text-gray-500">Пока нечего рекомендовать.</p>
  }

  return (
    <div className="space-y-6">
      {groups.map(([title, items]) => items.length > 0 && (
        <div key={title}>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
            {title}
          </div>
          <div className="space-y-2">
            {items.map((it: any) => (
              <LinkCard key={`${title}-${it.id}`}
                        title={it.title || it.name} link={it.link}
                        platformLinks={it.platform_links} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

const PLATFORM_LABEL: Record<string, string> = {
  telegram: 'Telegram', vk: 'ВКонтакте', max: 'MAX',
}

function LinkCard({ title, link, platformLinks }: {
  title: string; link: string; platformLinks?: Record<string, string>
}) {
  // Ссылки по площадкам показываем только те, что реально пришли с бэкенда:
  // там они строятся лишь для подключённых ботов, где написан разбор метки.
  const platforms = Object.entries(platformLinks || {}).filter(([, v]) => !!v)

  return (
    <div className="rounded-xl bg-white p-3 shadow-sm">
      <div className="mb-2 font-medium text-gray-900">{title}</div>
      <Row label="Ссылка на сайт" link={link} />
      {platforms.map(([p, url]) => (
        <Row key={p} label={PLATFORM_LABEL[p] || p} link={url} />
      ))}
    </div>
  )
}

function Row({ label, link }: { label: string; link: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* буфер недоступен — ссылка всё равно видна и выделяется */ }
  }
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="mb-0.5 text-[11px] text-gray-400">{label}</div>
      <div className="flex items-center gap-2">
        <input
          readOnly value={link}
          onFocus={e => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-600"
        />
        <button onClick={copy} className="btn-primary shrink-0 px-3 py-1.5 text-xs">
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
    </div>
  )
}

/* ─── Продажи ────────────────────────────────────────────────────────────── */

function Sales({ token }: { token: string }) {
  const [items, setItems] = useState<any[] | null>(null)

  useEffect(() => {
    get('/me/sales', token).then(d => setItems(d.sales || [])).catch(() => setItems([]))
  }, [token])

  if (!items) return <p className="text-sm text-gray-400">Загружаем…</p>
  if (!items.length) return <p className="text-sm text-gray-500">Продаж пока нет.</p>

  return (
    <div className="space-y-2">
      {items.map(s => (
        <div key={s.id} className="rounded-xl bg-white p-3 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium text-gray-900">{s.source_title || '—'}</div>
              <div className="text-xs text-gray-500">
                {dt(s.created_at)}
                {s.buyer_name && ` · ${s.buyer_name}`}
                {s.level > 1 && ` · ${s.level}-й уровень`}
              </div>
            </div>
            <div className="text-right">
              <div className="font-semibold text-gray-900">{money(s.amount)}</div>
              <div className={`text-xs ${s.is_paid ? 'text-emerald-600' : 'text-gray-400'}`}>
                {s.is_paid ? 'выплачено' : 'ожидает выплаты'}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ─── Люди ───────────────────────────────────────────────────────────────── */

/* ─── Сеть по уровням ────────────────────────────────────────────────────── */

function Network({ token }: { token: string }) {
  const [data, setData] = useState<any>(null)
  const [level, setLevel] = useState(1)

  useEffect(() => {
    get('/me/network', token).then(setData).catch(() => setData({ network: [] }))
  }, [token])

  if (!data) return <p className="text-sm text-gray-400">Загружаем…</p>

  const all: any[] = data.network || []
  const levels = Math.max(1, Number(data.levels) || 1)
  const rows = all.filter(p => p.level === level)

  return (
    <div>
      <div className="mb-3 rounded-xl bg-white p-3 text-xs text-gray-600 shadow-sm">
        Здесь партнёры, которые пришли по вашей ссылке и сами продают.
        С их продаж вам идёт вознаграждение следующего уровня.
      </div>

      {levels > 1 && (
        <div className="mb-3 flex gap-1 text-sm">
          {Array.from({ length: levels }, (_, i) => i + 1).map(n => (
            <button key={n} onClick={() => setLevel(n)}
                    className={`rounded-lg px-3 py-1.5 ${level === n
                      ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 shadow-sm'}`}>
              {n}-й уровень · {all.filter(p => p.level === n).length}
            </button>
          ))}
        </div>
      )}

      {!rows.length ? (
        <p className="text-sm text-gray-500">
          {level === 1
            ? 'Пока никто из приведённых не стал партнёром.'
            : `На ${level}-м уровне пока никого.`}
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map(p => (
            <div key={p.partner_id} className="rounded-xl bg-white p-3 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900">
                    {p.name || 'Без имени'}
                    {!p.is_active && (
                      <span className="ml-2 text-xs text-gray-400">отключён</span>
                    )}
                  </div>
                  <div className="break-all text-xs text-gray-500">
                    {[p.email, p.phone].filter(Boolean).join(' · ') || '—'}
                  </div>
                  <div className="text-xs text-gray-400">
                    партнёр с {dt(p.accepted_at)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-400">продал на</div>
                  <div className="font-semibold text-gray-900">{money(p.turnover)}</div>
                  {Number(p.my_income) > 0 && (
                    <div className="text-xs text-emerald-600">
                      вам с него {money(p.my_income)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const PLATFORM_NAME: Record<string, string> = {
  telegram: 'Telegram', vk: 'ВКонтакте', max: 'MAX',
}

function People({ token }: { token: string }) {
  const [items, setItems] = useState<any[] | null>(null)
  const [only, setOnly] = useState<'all' | 'warm'>('all')

  useEffect(() => {
    get('/me/people', token).then(d => setItems(d.people || [])).catch(() => setItems([]))
  }, [token])

  if (!items) return <p className="text-sm text-gray-400">Загружаем…</p>
  if (!items.length) return <p className="text-sm text-gray-500">Пока никого.</p>

  // ⚠️ «Интересовались» — те, кто пришёл по ссылке, но ещё не купил. Это и есть
  // работа партнёра: с ними можно связаться и довести до покупки. Раньше их не
  // было видно вовсе — показывались только состоявшиеся продажи.
  const warm = items.filter(p => !p.bought)
  const list = only === 'warm' ? warm : items

  return (
    <div>
      {warm.length > 0 && (
        <div className="mb-3 flex gap-1 text-sm">
          <button onClick={() => setOnly('all')}
                  className={`rounded-lg px-3 py-1.5 ${only === 'all'
                    ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 shadow-sm'}`}>
            Все · {items.length}
          </button>
          <button onClick={() => setOnly('warm')}
                  className={`rounded-lg px-3 py-1.5 ${only === 'warm'
                    ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 shadow-sm'}`}>
            Интересовались · {warm.length}
          </button>
        </div>
      )}

      <div className="space-y-2">
        {list.map(p => (
          <div key={p.id} className="rounded-xl bg-white p-3 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-gray-900">
                  {p.name || 'Без имени'}
                  {p.is_partner && (
                    <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
                      партнёр
                    </span>
                  )}
                </div>
                {/* ⚠️ Партнёр видит про своих людей ВСЁ (№ 10) — он их привёл. */}
                <div className="break-all text-xs text-gray-500">
                  {[p.email, p.phone].filter(Boolean).join(' · ') || '—'}
                </div>
                <div className="text-xs text-gray-400">с {dt(p.came_at)}</div>
              </div>
              <div className="text-right">
                {p.bought ? (
                  <div className="text-sm text-gray-600">
                    купил на {money(p.spent)}
                  </div>
                ) : (
                  <div className="text-xs text-amber-700">интересовался</div>
                )}
              </div>
            </div>

            {/* Кнопки «написать» — партнёр не должен искать человека вручную. */}
            {Object.keys(p.links || {}).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 border-t border-gray-100 pt-2">
                {Object.entries(p.links).map(([platform, url]) => (
                  <a key={platform} href={url as string} target="_blank" rel="noreferrer"
                     className="rounded-lg bg-gray-100 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-200">
                    Написать в {PLATFORM_NAME[platform] || platform}
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, accent }: any) {
  return (
    <div className="rounded-xl bg-white p-3 shadow-sm">
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className={`text-lg font-bold ${accent ? 'text-gray-900' : 'text-gray-700'}`}>
        {value}
      </div>
    </div>
  )
}
