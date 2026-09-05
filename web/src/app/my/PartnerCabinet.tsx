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
 * ⚠️ «Мои продажи» есть ВСЕГДА, «Мои люди» — только когда там реально есть
 * кого показать (№ 40). В активном режиме закреплённые, не ставшие
 * партнёрами, дохода не приносят: показать их — значит пообещать
 * несуществующее. Решает бэкенд полем show_people.
 *
 * ⚠️ Ноль не объясняем (№ 31): пустой кабинет — просто пусто.
 */

import { useEffect, useState } from 'react'

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''

type Tab = 'materials' | 'sales' | 'people'

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
    fetch(`${apiBase}/api/v1/public/partner/offer`)
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
                        title={it.title || it.name} link={it.link} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function LinkCard({ title, link }: { title: string; link: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* буфер недоступен — ссылка всё равно видна и выделяется */ }
  }
  return (
    <div className="rounded-xl bg-white p-3 shadow-sm">
      <div className="mb-1 font-medium text-gray-900">{title}</div>
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

function People({ token }: { token: string }) {
  const [items, setItems] = useState<any[] | null>(null)

  useEffect(() => {
    get('/me/people', token).then(d => setItems(d.people || [])).catch(() => setItems([]))
  }, [token])

  if (!items) return <p className="text-sm text-gray-400">Загружаем…</p>
  if (!items.length) return <p className="text-sm text-gray-500">Пока никого.</p>

  return (
    <div className="space-y-2">
      {items.map(p => (
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
              <div className="text-xs text-gray-400">с {dt(p.partner_bound_at)}</div>
            </div>
            {Number(p.spent) > 0 && (
              <div className="text-right text-sm text-gray-600">
                купил на {money(p.spent)}
              </div>
            )}
          </div>
        </div>
      ))}
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
