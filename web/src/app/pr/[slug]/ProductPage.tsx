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
import { useMemo } from 'react'

function wording(preset: string) {
  return preset === 'education'
    ? { unit: 'Урок', units: 'Уроки', content: 'Программа', section: 'Модуль' }
    : { unit: 'Материал', units: 'Материалы', content: 'Что входит', section: 'Блок' }
}

export default function ProductPage({ data, slug }: { data: any; slug: string }) {
  const { product, client, tariffs, sections, content } = data
  const W = wording(product.wording_preset)
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
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-2xl font-bold text-gray-900">
                      {t.price ? `${t.price.toLocaleString('ru-RU')} ₽` : 'Бесплатно'}
                    </span>
                    {t.old_price != null && (
                      <>
                        <span className="text-base text-gray-400 line-through">
                          {Number(t.old_price).toLocaleString('ru-RU')} ₽
                        </span>
                        {t.discount_percent != null && (
                          <span className="rounded-full bg-[#25455D] px-2 py-0.5 text-xs font-bold text-white">
                            −{t.discount_percent}%
                          </span>
                        )}
                      </>
                    )}
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

                  {/* ⚠️ Ведём на ОБЩУЮ страницу заказа — ту же, что у события
                      и у лендинга продукта. Своя модалка на витрине уже
                      разошлась с ней: не спрашивала Telegram-ник и согласие
                      на рассылку. Одна форма — одно поведение. */}
                  <a href={`/pr/${slug}/order/${t.id}`} className="btn-gold mt-4 block w-full text-center">
                    {t.price ? 'Оплатить' : 'Получить'}
                  </a>
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
