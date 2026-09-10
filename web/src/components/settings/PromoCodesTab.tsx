'use client'
/**
 * Промокоды клиента (миграция 397).
 *
 * ⚠️ ОДИН список на кабинет, а не свой раздел в каждом событии: код часто
 * общий на несколько вещей, лимит применений считается на код целиком, и
 * «какие у меня сейчас живые коды» иначе не узнать вовсе.
 *
 * ⚠️ От «помойки из промокодов» (прямая жалоба владельца) спасает вид списка:
 * по умолчанию видны только ДЕЙСТВУЮЩИЕ, истёкшие уходят в «Архив», а пачка
 * именных кодов показывается ОДНОЙ свёрнутой строкой — иначе 200 строк
 * ZHIVU-A7K2 погребут под собой три обычных промокода.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

type Props = {
  /** Платёжная система клиента — от неё зависит, работают ли промокоды. */
  payProvider?: string | null
}

// ⚠️ Держать в синхроне с SUPPORTED_PROVIDERS в services/promo_codes.py.
const PROVIDER_NAMES: Record<string, string> = {
  leadpay: 'LeadPay',
  prodamus: 'Продамус',
  tbank: 'Т-Банк',
}

export default function PromoCodesTab({ payProvider }: Props) {
  const [loading, setLoading] = useState(true)
  const [singles, setSingles] = useState<any[]>([])
  const [batches, setBatches] = useState<any[]>([])
  const [archived, setArchived] = useState(false)
  const [error, setError] = useState('')
  const [openBatch, setOpenBatch] = useState<string | null>(null)
  const [uses, setUses] = useState<Record<number, any[]>>({})
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.promoCodes.list({ archived })
      setSingles(r.promo_codes || [])
      setBatches(r.batches || [])
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить промокоды')
    } finally {
      setLoading(false)
    }
  }, [archived])

  useEffect(() => { load() }, [load])

  const remove = async (id: number, code: string) => {
    if (!confirm(`Удалить промокод «${code}»?\n\nЛюди, которым вы его дали, больше не смогут им воспользоваться.`)) return
    await api.promoCodes.remove(id)
    load()
  }

  const removeBatch = async (batchId: string, total: number) => {
    if (!confirm(`Удалить все ${total} кодов этой пачки?`)) return
    await api.promoCodes.removeBatch(batchId)
    load()
  }

  const loadUses = async (id: number) => {
    if (uses[id]) { setUses({ ...uses, [id]: [] }); return }
    const r = await api.promoCodes.uses(id)
    setUses({ ...uses, [id]: r.uses || [] })
  }

  const providerName = payProvider ? PROVIDER_NAMES[payProvider] : null
  // ⚠️ LeadPay цену из запроса не принимает — она в его карточке товара.
  // Промокоды ПЛЮСОНа с ним не сработают, и об этом надо сказать ПРЯМО:
  // иначе клиент заведёт коды, раздаст людям и получит жалобы.
  const unsupported = payProvider === 'leadpay'

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-bold text-[#25455D]">Промокоды</h3>
        <p className="mt-1 text-sm text-gray-600">
          Скидка по слову: покупатель вводит код при оформлении заказа, и цена
          пересчитывается. Работают на событиях, продуктах и отдельных тарифах.
        </p>
      </div>

      {!payProvider && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Сначала подключите платёжную систему во вкладке «Основные настройки» —
          без неё промокоду не к чему применяться.
        </div>
      )}

      {unsupported && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <b>У вас подключён LeadPay — промокоды ПЛЮСОНа с ним не работают.</b>
          {' '}Цена берётся из карточки товара на стороне LeadPay, и передать
          сумму со скидкой мы не можем. Промокоды у LeadPay свои — заводите их
          в его личном кабинете, раздел «Промокоды».
          <br />
          <span className="mt-1 inline-block opacity-80">
            Наши промокоды работают с Продамусом и Т-Банком.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-gold" onClick={() => setShowForm(true)}>
          Создать промокод
        </button>
        <button
          className={`text-sm underline ${archived ? 'font-bold text-[#25455D]' : 'text-gray-500'}`}
          onClick={() => setArchived(!archived)}
        >
          {archived ? '← К действующим' : 'Архив (истёкшие и использованные)'}
        </button>
      </div>

      {error && <div className="text-sm text-red-600">{error}</div>}
      {loading && <div className="text-sm text-gray-500">Загружаем…</div>}

      {!loading && !singles.length && !batches.length && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
          {archived ? 'В архиве пусто.' : 'Промокодов пока нет.'}
        </div>
      )}

      {/* Пачки — свёрнутыми строками */}
      {batches.map(b => (
        <div key={b.batch_id} className="rounded-xl border border-gray-200 bg-white">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-bold text-[#25455D]">
                {b.batch_title || 'Персональные коды'} ({b.total})
              </div>
              <div className="text-sm text-gray-600">
                {discountLabel(b)} · использовано {b.used} из {b.total}
                {b.event_title && ` · ${b.event_title}`}
                {b.product_title && ` · ${b.product_title}`}
              </div>
            </div>
            <button className="text-sm underline text-[#25455D]"
                    onClick={() => setOpenBatch(openBatch === b.batch_id ? null : b.batch_id)}>
              {openBatch === b.batch_id ? 'Свернуть' : 'Показать коды'}
            </button>
            <button className="text-sm underline text-gray-500"
                    onClick={() => downloadCsv(b)}>
              Скачать CSV
            </button>
            <button className="text-sm underline text-red-600"
                    onClick={() => removeBatch(b.batch_id, b.total)}>
              Удалить
            </button>
          </div>
          {openBatch === b.batch_id && (
            <div className="max-h-72 overflow-auto border-t border-gray-100 px-4 py-3">
              <table className="w-full text-sm">
                <tbody>
                  {b.codes.map((c: any) => (
                    <tr key={c.id} className="border-b border-gray-50 last:border-0">
                      <td className="py-1.5 font-mono">{c.code}</td>
                      <td className="py-1.5 text-gray-500">
                        {c.recipient_name || '—'}
                      </td>
                      <td className="py-1.5 text-right text-gray-500">
                        {c.used_count > 0 ? 'использован' : 'не использован'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      {/* Обычные коды */}
      {singles.map(p => (
        <div key={p.id} className="rounded-xl border border-gray-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-lg font-bold text-[#25455D]">{p.code}</div>
              <div className="text-sm text-gray-600">
                {discountLabel(p)}
                {' · '}
                {p.scope_event_id ? `Событие: ${p.event_title}`
                  : p.scope_product_id ? `Продукт: ${p.product_title}`
                  : p.plusson_subscription ? 'Подписка ПЛЮСОНа'
                  : 'На всё'}
                {p.recipient_name && ` · только для: ${p.recipient_name}`}
              </div>
              <div className="mt-0.5 text-xs text-gray-500">
                {p.max_uses
                  ? `Применений: ${p.used_count} из ${p.max_uses}`
                  : `Применений: ${p.used_count}`}
                {p.ends_at && ` · до ${new Date(p.ends_at).toLocaleDateString('ru-RU')}`}
              </div>
            </div>
            <button className="text-sm underline text-[#25455D]"
                    onClick={() => loadUses(p.id)}>
              Кто применил
            </button>
            <button className="text-sm underline text-red-600"
                    onClick={() => remove(p.id, p.code)}>
              Удалить
            </button>
          </div>
          {uses[p.id]?.length > 0 && (
            <div className="mt-3 border-t border-gray-100 pt-3 text-sm">
              {uses[p.id].map((u: any) => (
                <div key={u.id} className="flex justify-between py-1 text-gray-600">
                  <span>{u.contact_name || 'Без имени'}</span>
                  <span>
                    {u.price_before} → {u.price_after} ₽
                    {u.applied_at && ` · ${new Date(u.applied_at).toLocaleDateString('ru-RU')}`}
                  </span>
                </div>
              ))}
            </div>
          )}
          {uses[p.id]?.length === 0 && (
            <div className="mt-3 border-t border-gray-100 pt-3 text-sm text-gray-500">
              Пока никто не применял.
            </div>
          )}
        </div>
      ))}

      {showForm && (
        <PromoForm onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); load() }} />
      )}
    </div>
  )
}

function discountLabel(p: any) {
  return p.discount_kind === 'percent'
    ? `−${p.discount_value}%`
    : `−${Number(p.discount_value).toLocaleString('ru-RU')} ₽`
}

/** ⚠️ CSV с `;` и BOM — иначе Excel открывает кириллицу кракозябрами
 *  (тот же формат, что у выгрузки контактов). */
function downloadCsv(b: any) {
  const rows = [['Промокод', 'Кому', 'Использован']]
  b.codes.forEach((c: any) => {
    rows.push([c.code, c.recipient_name || '', c.used_count > 0 ? 'да' : 'нет'])
  })
  const csv = '﻿' + rows.map(r => r.join(';')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `promo-${b.batch_title || b.batch_id}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/* ───────────────────────── Форма создания ───────────────────────── */

function PromoForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<'single' | 'batch'>('single')
  const [code, setCode] = useState('')
  const [discountKind, setDiscountKind] = useState<'percent' | 'amount'>('percent')
  const [discountValue, setDiscountValue] = useState('20')
  const [scope, setScope] = useState<'all' | 'event' | 'product'>('event')
  const [eventId, setEventId] = useState<number | ''>('')
  const [productId, setProductId] = useState<number | ''>('')
  const [maxUses, setMaxUses] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [batchCount, setBatchCount] = useState('50')
  const [batchPrefix, setBatchPrefix] = useState('')
  const [batchTitle, setBatchTitle] = useState('')
  const [events, setEvents] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.events.list().then((r: any) => setEvents(r.events || r || [])).catch(() => {})
    api.products?.list?.().then((r: any) => setProducts(r.products || [])).catch(() => {})
  }, [])

  const save = async () => {
    setError('')
    if (kind === 'single' && !code.trim()) { setError('Укажите промокод'); return }
    if (!discountValue || Number(discountValue) <= 0) { setError('Укажите размер скидки'); return }
    if (scope === 'event' && !eventId) { setError('Выберите событие'); return }
    if (scope === 'product' && !productId) { setError('Выберите продукт'); return }
    // ⚠️ Срок ИЛИ лимит обязателен: код без ограничений никто никогда не
    // выключит, и через год их накопится сотня — это и есть «помойка».
    if (!maxUses && !endsAt) {
      setError('Укажите срок действия или количество применений — иначе промокод будет жить вечно')
      return
    }

    setSaving(true)
    try {
      await api.promoCodes.create({
        code: kind === 'single' ? code.trim() : null,
        discount_kind: discountKind,
        discount_value: Number(discountValue),
        scope_event_id: scope === 'event' ? Number(eventId) : null,
        scope_product_id: scope === 'product' ? Number(productId) : null,
        max_uses: maxUses ? Number(maxUses) : null,
        ends_at: endsAt || null,
        batch_count: kind === 'batch' ? Number(batchCount) : null,
        batch_prefix: kind === 'batch' ? batchPrefix.trim() || null : null,
        batch_title: kind === 'batch' ? batchTitle.trim() || null : null,
      })
      onSaved()
    } catch (e: any) {
      setError(e?.message || 'Не удалось создать промокод')
    } finally {
      setSaving(false)
    }
  }

  return (
    // ⚠️ Модалка-форма НЕ закрывается по клику на фон (правило проекта):
    // иначе теряется набранное. Только «Отмена» и крестик.
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6" onClick={e => e.stopPropagation()}>
        <h3 className="mb-4 text-lg font-bold text-[#25455D]">Новый промокод</h3>

        <div className="space-y-4">
          <div className="flex gap-2">
            <TabBtn active={kind === 'single'} onClick={() => setKind('single')}>Один код</TabBtn>
            <TabBtn active={kind === 'batch'} onClick={() => setKind('batch')}>Пачка кодов</TabBtn>
          </div>

          {kind === 'single' ? (
            <Row label="Промокод">
              <input value={code} onChange={e => setCode(e.target.value)}
                     placeholder="PLUSON20"
                     className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono uppercase" />
            </Row>
          ) : (
            <>
              <Row label="Сколько кодов">
                <input value={batchCount} onChange={e => setBatchCount(e.target.value)}
                       type="number" min={1} max={500}
                       className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </Row>
              <Row label="Начало кода" hint="Например, ZHIVU — получится ZHIVU-A7K2">
                <input value={batchPrefix} onChange={e => setBatchPrefix(e.target.value)}
                       className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono uppercase" />
              </Row>
              <Row label="Название пачки" hint="Чтобы отличать её в списке">
                <input value={batchTitle} onChange={e => setBatchTitle(e.target.value)}
                       placeholder="Персональные для гостей"
                       className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </Row>
            </>
          )}

          <Row label="Скидка">
            <div className="flex gap-2">
              <select value={discountKind}
                      onChange={e => setDiscountKind(e.target.value as any)}
                      className="rounded-lg border border-gray-300 px-3 py-2"
                      style={{ flex: '0 0 5rem' }}>
                <option value="percent">%</option>
                <option value="amount">₽</option>
              </select>
              <input value={discountValue} onChange={e => setDiscountValue(e.target.value)}
                     type="number" min={1}
                     className="rounded-lg border border-gray-300 px-3 py-2"
                     style={{ flex: '1 1 auto', minWidth: 0 }} />
            </div>
          </Row>

          {/* ⚠️ По умолчанию «событие», а не «на всё»: код «на всё» молча
              действует на событие за 50 000 ₽, о котором вы не думали, и
              обнаруживается это по деньгам задним числом. */}
          <Row label="Действует на">
            <select value={scope} onChange={e => setScope(e.target.value as any)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2">
              <option value="event">Событие</option>
              <option value="product">Продукт</option>
              <option value="all">На всё</option>
            </select>
          </Row>

          {scope === 'event' && (
            <Row label="Событие">
              <select value={eventId} onChange={e => setEventId(Number(e.target.value))}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2">
                <option value="">— выберите —</option>
                {events.map((e: any) => (
                  <option key={e.id} value={e.id}>{e.title}</option>
                ))}
              </select>
            </Row>
          )}

          {scope === 'product' && (
            <Row label="Продукт">
              <select value={productId} onChange={e => setProductId(Number(e.target.value))}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2">
                <option value="">— выберите —</option>
                {products.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
            </Row>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Row label="Применений" hint="Пусто — без ограничения">
              <input value={maxUses} onChange={e => setMaxUses(e.target.value)}
                     type="number" min={1} placeholder="∞"
                     className="w-full rounded-lg border border-gray-300 px-3 py-2" />
            </Row>
            <Row label="Действует до">
              <input value={endsAt} onChange={e => setEndsAt(e.target.value)}
                     type="date"
                     className="w-full rounded-lg border border-gray-300 px-3 py-2" />
            </Row>
          </div>

          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button className="text-sm text-gray-500 underline" onClick={onClose}>Отмена</button>
          <button className="btn-gold" onClick={save} disabled={saving}>
            {saving ? 'Создаём…' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  )
}

function TabBtn({ active, onClick, children }: any) {
  return (
    <button onClick={onClick}
            className={`rounded-lg px-4 py-2 text-sm font-bold ${
              active ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600'}`}>
      {children}
    </button>
  )
}

function Row({ label, hint, children }: any) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      {children}
      {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
    </div>
  )
}
