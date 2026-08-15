'use client'

/**
 * Витрина продукта: описание, состав, тарифы, форма заказа.
 *
 * ⚠️ Состав показывается названиями и описаниями, БЕЗ ссылок — иначе страница
 * раздаёт содержимое бесплатно. Ссылки живут в кабинете купившего.
 *
 * ⚠️ Формулировки — из словаря продукта: у консультационного пресета нигде не
 * должно быть «уроков», «программы обучения» и «учеников».
 */
import { useEffect, useMemo, useState } from 'react'

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''

function wording(preset: string) {
  return preset === 'education'
    ? { unit: 'Урок', units: 'Уроки', content: 'Программа', section: 'Модуль' }
    : { unit: 'Материал', units: 'Материалы', content: 'Что входит', section: 'Блок' }
}

export default function ProductPage({ data, slug }: { data: any; slug: string }) {
  const { product, client, tariffs, sections, content } = data
  const W = wording(product.wording_preset)
  const [orderTariff, setOrderTariff] = useState<any>(null)

  // ⚠️ Кнопка тарифа с ЛЕНДИНГА ведёт сюда с ?tariff={id} — открываем форму
  // заказа сразу. Раньше параметр никто не читал: человек приходил на витрину
  // и ничего не происходило, будто кнопка не работает.
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get('tariff')
    if (!id) return
    const t = (tariffs || []).find((x: any) => String(x.id) === String(id))
    if (t) setOrderTariff(t)
  }, [tariffs])

  // Дерево состава: разделы верхнего уровня + материалы без раздела.
  const tree = useMemo(() => buildTree(sections, content), [sections, content])

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:py-16">

        {client?.brand_logo_url && (
          <img src={client.brand_logo_url} alt=""
               className="mb-8 h-10 w-auto object-contain" />
        )}

        <h1 className="text-3xl font-bold text-gray-900 sm:text-4xl">{product.title}</h1>
        {product.subtitle && (
          <p className="mt-3 text-lg text-gray-600">{product.subtitle}</p>
        )}

        {product.cover_url && (
          <img src={product.cover_url} alt=""
               className="mt-6 w-full rounded-2xl object-cover" />
        )}

        {product.description && (
          <div className="mt-6 whitespace-pre-wrap text-gray-700">
            {product.description}
          </div>
        )}

        {tree.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-4 text-xl font-bold text-gray-900">{W.content}</h2>
            <div className="space-y-3">
              {tree.map((n: any) => (
                <TreeItem key={`${n.type}-${n.id ?? n.link_id}`} node={n} W={W} />
              ))}
            </div>
          </section>
        )}

        {tariffs.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-4 text-xl font-bold text-gray-900">Участие</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {tariffs.map((t: any) => (
                <div
                  key={t.id}
                  className={`rounded-2xl border p-5 ${
                    t.is_featured ? 'border-[#25455D] shadow-lg' : 'border-gray-200'
                  }`}
                >
                  <div className="text-lg font-semibold text-gray-900">{t.title}</div>
                  <div className="mt-1 text-2xl font-bold text-gray-900">
                    {t.price ? `${t.price.toLocaleString('ru-RU')} ₽` : 'Бесплатно'}
                  </div>

                  {t.description && (
                    <div className="mt-3 whitespace-pre-wrap text-sm text-gray-600">
                      {t.description}
                    </div>
                  )}
                  {t.excluded_description && (
                    <div className="mt-2 whitespace-pre-wrap text-sm text-gray-400 line-through">
                      {t.excluded_description}
                    </div>
                  )}

                  {t.order_hint && (
                    <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                      {t.order_hint}
                    </div>
                  )}

                  <button onClick={() => setOrderTariff(t)} className="btn-gold mt-4 w-full">
                    {t.price ? 'Оплатить' : 'Получить'}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {product.offer_url && (
          <p className="mt-10 text-xs text-gray-400">
            Оформляя заказ, вы соглашаетесь с{' '}
            <a href={product.offer_url} target="_blank" rel="noreferrer"
               className="underline hover:text-gray-600">
              условиями оферты
            </a>.
          </p>
        )}
      </div>

      {orderTariff && (
        <OrderModal
          tariff={orderTariff}
          product={product}
          onClose={() => setOrderTariff(null)}
        />
      )}
    </div>
  )
}

/* ─────────────────────────────── Состав ─────────────────────────────────── */

function buildTree(sections: any[], content: any[]) {
  const byParent: Record<string, any[]> = {}
  for (const s of sections) {
    const key = String(s.parent_id ?? 'root')
    ;(byParent[key] ||= []).push({ ...s, type: 'section', children: [] })
  }
  const bySection: Record<string, any[]> = {}
  for (const c of content) {
    const key = String(c.section_id ?? 'root')
    ;(bySection[key] ||= []).push({ ...c, type: 'material' })
  }
  const attach = (node: any) => {
    const kids = byParent[String(node.id)] || []
    kids.forEach(attach)
    node.children = [...kids, ...(bySection[String(node.id)] || [])]
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    return node
  }
  const roots = (byParent['root'] || []).map(attach)
  return [...roots, ...(bySection['root'] || [])]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
}

function TreeItem({ node, W, depth = 0 }: { node: any; W: any; depth?: number }) {
  if (node.type === 'material') {
    return (
      <div style={{ marginLeft: depth * 16 }}
           className="rounded-xl border border-gray-200 px-4 py-3">
        <div className="font-medium text-gray-900">{node.title}</div>
        {node.description && (
          <div className="mt-0.5 text-sm text-gray-500">{node.description}</div>
        )}
      </div>
    )
  }
  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div className="rounded-xl border border-gray-300 bg-gray-50 px-4 py-3">
        <div className="font-semibold text-gray-900">{node.title}</div>
        {node.description && (
          <div className="mt-0.5 text-sm text-gray-500">{node.description}</div>
        )}
      </div>
      {node.children?.length > 0 && (
        <div className="mt-2 space-y-2">
          {node.children.map((ch: any) => (
            <TreeItem key={`${ch.type}-${ch.id ?? ch.link_id}`}
                      node={ch} W={W} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────── Заказ ──────────────────────────────────── */

function OrderModal({ tariff, product, onClose }: {
  tariff: any; product: any; onClose: () => void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [consentPd, setConsentPd] = useState(false)
  const [consentMk, setConsentMk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Экран «Это вы?» — когда данные указывают на разных людей в базе.
  const [choice, setChoice] = useState<any>(null)

  const submit = async (extra: any = {}) => {
    setBusy(true)
    setError('')
    try {
      const url = new URL(window.location.href)
      const res = await fetch(`${apiBase}/api/v1/public/product-orders/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tariff_id: tariff.id,
          name: name.trim() || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          consent_pd: consentPd,
          consent_marketing: consentMk,
          ref_code: url.searchParams.get('pid') || null,
          utm_source: url.searchParams.get('utm_source') || null,
          contact_id: url.searchParams.get('c') || null,
          ...extra,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.detail || 'Не удалось оформить')

      if (data.need_choice) { setChoice(data); return }
      if (data.payment_url) { window.location.href = data.payment_url; return }
      if (data.redirect) { window.location.href = data.redirect; return }
      onClose()
    } catch (e: any) {
      setError(e?.message || 'Что-то пошло не так')
    } finally { setBusy(false) }
  }

  // ⚠️ Модалка-форма НЕ закрывается по клику на фон (правило проекта):
  // на внешнем div нет onClick, закрытие только крестиком и «Отмена».
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div onClick={e => e.stopPropagation()}
           className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6">

        {choice ? (
          <>
            <h3 className="mb-2 text-lg font-semibold text-gray-900">Это вы?</h3>
            <p className="mb-4 text-sm text-gray-500">
              По вашим данным нашлось несколько записей. Выберите свою, чтобы
              доступ пришёл туда, куда нужно.
            </p>
            <div className="space-y-2">
              {choice.candidates.map((c: any) => (
                <button
                  key={c.contact_id ?? c.id}
                  onClick={() => submit({ chosen_contact_id: c.contact_id ?? c.id })}
                  disabled={busy}
                  className="w-full rounded-xl border border-gray-300 p-3 text-left hover:border-gray-400"
                >
                  <div className="font-medium text-gray-900">{c.name || 'Без имени'}</div>
                  <div className="text-xs text-gray-500">
                    {[c.email, c.phone].filter(Boolean).join(' · ')}
                  </div>
                </button>
              ))}
              {choice.can_create_new && (
                <button
                  onClick={() => submit({ force_new: true })}
                  disabled={busy}
                  className="w-full rounded-xl border border-dashed border-gray-300 p-3 text-sm text-gray-500 hover:border-gray-400"
                >
                  Меня здесь нет — я впервые
                </button>
              )}
            </div>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <button onClick={onClose} className="btn-primary mt-4 w-full">Отмена</button>
          </>
        ) : (
          <>
            <h3 className="mb-1 text-lg font-semibold text-gray-900">{product.title}</h3>
            <p className="mb-4 text-sm text-gray-500">
              {tariff.title} ·{' '}
              {tariff.price ? `${tariff.price.toLocaleString('ru-RU')} ₽` : 'бесплатно'}
            </p>

            <div className="space-y-3">
              <input
                value={name} onChange={e => setName(e.target.value)}
                placeholder="Имя"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                value={email} onChange={e => setEmail(e.target.value)}
                placeholder="Почта" type="email"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                value={phone} onChange={e => setPhone(e.target.value)}
                placeholder="Телефон" type="tel"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />

              {/* ⚠️ Согласия обязательны — правило проекта для любой формы сбора данных. */}
              <label className="flex items-start gap-2 text-xs text-gray-600">
                <input type="checkbox" checked={consentPd} className="mt-0.5"
                       onChange={e => setConsentPd(e.target.checked)} />
                <span>
                  Согласен на обработку персональных данных
                  {product.offer_url && (
                    <> и принимаю{' '}
                      <a href={product.offer_url} target="_blank" rel="noreferrer"
                         className="underline">условия оферты</a>
                    </>
                  )}
                </span>
              </label>
              <label className="flex items-start gap-2 text-xs text-gray-600">
                <input type="checkbox" checked={consentMk} className="mt-0.5"
                       onChange={e => setConsentMk(e.target.checked)} />
                <span>Согласен получать новости и полезные материалы</span>
              </label>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <button
                onClick={() => submit()}
                disabled={busy || !consentPd || (!email.trim() && !phone.trim())}
                className="btn-gold w-full"
              >
                {busy ? 'Отправляем…' : tariff.price ? 'Перейти к оплате' : 'Получить доступ'}
              </button>
              <button onClick={onClose} className="btn-primary w-full">Отмена</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
