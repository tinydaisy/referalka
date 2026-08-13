'use client'

/**
 * Карточка продукта (миграция 290).
 *
 * Вкладки по образцу карточки события: Основное, Тарифы, Состав, Клиенты.
 * «Лендинг» появится, когда конструктор блоков будет развязан с события.
 *
 * ⚠️ Адрес страницы показываем на домене клиента (publicBase), а не на
 * pluson.ru: клиент платит за свой домен и раздаёт его, а не наш.
 */
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import FeatureLock from '@/components/FeatureLock'
import ProductLandingTab from './LandingTab'
import MaterialEditor from '@/components/products/MaterialEditor'
import {
  ArrowLeft, Plus, Trash2, X, Copy, Check, ChevronDown, ChevronRight,
  MoreHorizontal, Settings2, Wallet, Layers, Users, ExternalLink, Eye, EyeOff,
  LayoutTemplate,
} from 'lucide-react'

const WORDING_PRESETS = [
  {
    value: 'consulting',
    label: 'Консультационный',
    hint: 'Материал, Что входит, Клиент — без слов про обучение',
  },
  {
    value: 'education',
    label: 'Образовательный',
    hint: 'Урок, Программа, Ученик',
  },
]

// ⚠️ params читаем через useParams(), а НЕ через use(params): промис в
// params — это Next 15, а на проде Next 14.2.3 отдаёт обычный объект, и
// use() падал с «unsupported type was passed to use()» — страница не
// открывалась вовсе (Application error). Так же сделано во всех остальных
// страницах проекта.
export default function ProductCardPage() {
  const { id } = useParams<{ id: string }>()
  const productId = Number(id)
  const { me, isAssistant, publicBase } = useMe()

  const [product, setProduct] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'main' | 'tariffs' | 'content' | 'landing' | 'buyers'>('main')

  const load = async () => {
    try { setProduct(await api.products.get(productId)) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [productId])

  const hasFeature = (me?.features || []).includes('products')
  if (me && !hasFeature) {
    return (
      <div className="max-w-3xl">
        <h1 className="mb-6 text-2xl font-bold text-gray-900">Продукты и услуги</h1>
        <FeatureLock anyOf={['products']} />
      </div>
    )
  }

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>
  if (!product) return <p className="text-sm text-gray-400">Продукт не найден</p>

  return (
    <div className="max-w-5xl">
      <Link
        href="/dashboard/products"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft size={15} /> Все продукты
      </Link>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-gray-900">{product.title}</h1>
        <StatusToggle product={product} readOnly={isAssistant} onChanged={load} />
      </div>

      <div className="mb-6 flex gap-2 overflow-x-auto border-b border-gray-200">
        {([
          ['main', 'Основное', Settings2],
          ['tariffs', 'Тарифы', Wallet],
          ['content', 'Состав', Layers],
          ['landing', 'Лендинг', LayoutTemplate],
          ['buyers', 'Клиенты', Users],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-4 py-2 text-sm ${
              tab === key
                ? 'border-[#25455D] font-semibold text-[#25455D]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === 'main' && (
        <MainTab product={product} readOnly={isAssistant} publicBase={publicBase} onChanged={load} />
      )}
      {tab === 'tariffs' && <TariffsTab productId={productId} readOnly={isAssistant} />}
      {tab === 'content' && (
        <ContentTab
          productId={productId}
          readOnly={isAssistant}
          wordingPreset={product.wording_preset || 'consulting'}
        />
      )}
      {tab === 'landing' && (
        <ProductLandingTab productId={productId} product={product} readOnly={isAssistant} />
      )}
      {tab === 'buyers' && <BuyersTab productId={productId} readOnly={isAssistant} />}
    </div>
  )
}

/* ─────────────────────────── Статус публикации ──────────────────────────── */

function StatusToggle({ product, readOnly, onChanged }: {
  product: any; readOnly: boolean; onChanged: () => void
}) {
  const [saving, setSaving] = useState(false)

  const setStatus = async (status: string) => {
    setSaving(true)
    try {
      await api.products.update(product.id, { status })
      onChanged()
    } catch (e: any) {
      // Бэк не даёт опубликовать без оферты — текст ошибки уже понятный.
      alert(e?.message || 'Не удалось изменить статус')
    } finally { setSaving(false) }
  }

  if (readOnly) return null

  const next = product.status === 'published' ? 'draft' : 'published'
  const label = product.status === 'published' ? 'Опубликован' : 'Черновик'
  const cls = product.status === 'published'
    ? 'border-green-200 bg-green-50 text-green-700'
    : 'border-amber-200 bg-amber-50 text-amber-700'

  return (
    <button
      onClick={() => setStatus(next)}
      disabled={saving}
      className={`rounded-full border px-3 py-1 text-xs ${cls}`}
      title={product.status === 'published' ? 'Снять с публикации' : 'Опубликовать'}
    >
      {label}
    </button>
  )
}

/* ────────────────────────────── Основное ────────────────────────────────── */

function MainTab({ product, readOnly, publicBase, onChanged }: {
  product: any; readOnly: boolean; publicBase: string; onChanged: () => void
}) {
  const [title, setTitle] = useState(product.title || '')
  const [subtitle, setSubtitle] = useState(product.subtitle || '')
  const [description, setDescription] = useState(product.description || '')
  const [slug, setSlug] = useState(product.slug || '')
  const [offerUrl, setOfferUrl] = useState(product.offer_url || '')
  const [preset, setPreset] = useState(product.wording_preset || 'consulting')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  const url = `${publicBase}/pr/${product.slug}`

  const save = async () => {
    setSaving(true)
    try {
      await api.products.update(product.id, {
        title: title.trim(),
        subtitle: subtitle.trim() || null,
        description: description.trim() || null,
        slug: slug.trim(),
        offer_url: offerUrl.trim() || null,
        wording_preset: preset,
      })
      onChanged()
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  const copy = () => {
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <label className="mb-1 block text-sm text-gray-600">Название</label>
        <input
          value={title} onChange={e => setTitle(e.target.value)} disabled={readOnly}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm text-gray-600">Короткое пояснение</label>
        <input
          value={subtitle} onChange={e => setSubtitle(e.target.value)} disabled={readOnly}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm text-gray-600">Описание</label>
        <textarea
          value={description} onChange={e => setDescription(e.target.value)}
          disabled={readOnly} rows={5}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm text-gray-600">Адрес страницы</label>
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-sm text-gray-400">{publicBase}/pr/</span>
          <input
            value={slug} onChange={e => setSlug(e.target.value)} disabled={readOnly}
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button onClick={copy} className="text-gray-400 hover:text-gray-600" title="Скопировать ссылку">
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
          {product.status === 'published' && (
            <a href={url} target="_blank" rel="noreferrer"
               className="text-gray-400 hover:text-gray-600" title="Открыть">
              <ExternalLink size={16} />
            </a>
          )}
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Латиница, цифры и дефис. Меняете адрес — старые ссылки перестанут работать.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm text-gray-600">Ссылка на оферту</label>
        <input
          value={offerUrl} onChange={e => setOfferUrl(e.target.value)} disabled={readOnly}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-gray-400">
          Оферта своя у каждого продукта — она описывает именно эту услугу, её состав
          и порядок возврата. Без неё продукт не опубликовать.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-sm text-gray-600">Как называть части продукта</label>
        <div className="space-y-2">
          {WORDING_PRESETS.map(p => (
            <button
              key={p.value}
              onClick={() => !readOnly && setPreset(p.value)}
              disabled={readOnly}
              className={`w-full rounded-lg border p-3 text-left text-sm ${
                preset === p.value
                  ? 'border-[#25455D] bg-[#25455D]/5'
                  : 'border-gray-300 hover:border-gray-400'
              }`}
            >
              <div className="font-medium text-gray-900">{p.label}</div>
              <div className="text-xs text-gray-500">{p.hint}</div>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-400">
          Эти слова подставляются везде — на странице, в кабинете клиента, в письмах
          и сообщениях бота. Если у вас консультационные услуги, выберите первый вариант:
          тогда нигде не появятся «уроки», «программа обучения» и «ученики».
        </p>
      </div>

      {!readOnly && (
        <button onClick={save} disabled={saving} className="btn-gold">
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      )}
    </div>
  )
}

/* ─────────────────────────────── Тарифы ─────────────────────────────────── */

function TariffsTab({ productId, readOnly }: { productId: number; readOnly: boolean }) {
  const [list, setList] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  const load = async () => {
    try {
      const r = await api.products.tariffs(productId)
      setList(r.tariffs || [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [productId])

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  return (
    <div className="max-w-3xl">
      <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
        Оплата идёт через платёжную систему, подключённую в Настройках — отдельно
        для продуктов настраивать ничего не нужно. Тариф без цены (или с нулём)
        считается бесплатным: человек оставляет контакты и сразу получает доступ.
      </div>

      {!readOnly && (
        <button onClick={() => setAdding(true)} className="btn-gold mb-4 inline-flex items-center gap-2">
          <Plus size={16} /> Добавить тариф
        </button>
      )}

      {adding && (
        <TariffForm
          productId={productId}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load() }}
        />
      )}

      {!list.length && !adding && (
        <p className="text-sm text-gray-400">Пока нет ни одного тарифа.</p>
      )}

      <div className="space-y-2">
        {list.map(t => (
          <TariffRow key={t.id} productId={productId} tariff={t} readOnly={readOnly} onChanged={load} />
        ))}
      </div>
    </div>
  )
}

function TariffRow({ productId, tariff, readOnly, onChanged }: {
  productId: number; tariff: any; readOnly: boolean; onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)

  const remove = async () => {
    if (!confirm(`Удалить тариф «${tariff.title}»?`)) return
    try {
      await api.products.deleteTariff(productId, tariff.id)
      onChanged()
    } catch (e: any) {
      alert(e?.message || 'Не удалось удалить')
    }
  }

  if (editing) {
    return (
      <TariffForm
        productId={productId} tariff={tariff}
        onClose={() => setEditing(false)}
        onSaved={() => { setEditing(false); onChanged() }}
      />
    )
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900">{tariff.title}</span>
          {!tariff.is_active && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">
              выключен
            </span>
          )}
          {tariff.is_featured && (
            <span className="rounded-full bg-[#FFCFA4]/40 px-2 py-0.5 text-[11px] text-[#25455D]">
              выделен
            </span>
          )}
        </div>
        <div className="text-xs text-gray-400">
          {tariff.price ? `${tariff.price} ₽` : 'Бесплатно'}
          {tariff.paid_count > 0 && ` · оплат: ${tariff.paid_count}`}
        </div>
      </div>
      {!readOnly && (
        <>
          <button onClick={() => setEditing(true)} className="text-sm text-gray-500 hover:text-gray-700">
            Изменить
          </button>
          <button onClick={remove} className="text-gray-400 hover:text-red-600">
            <Trash2 size={16} />
          </button>
        </>
      )}
    </div>
  )
}

function TariffForm({ productId, tariff, onClose, onSaved }: {
  productId: number; tariff?: any; onClose: () => void; onSaved: () => void
}) {
  const [code, setCode] = useState(tariff?.code || '')
  const [title, setTitle] = useState(tariff?.title || '')
  const [description, setDescription] = useState(tariff?.description || '')
  const [excluded, setExcluded] = useState(tariff?.excluded_description || '')
  const [price, setPrice] = useState<string>(tariff?.price != null ? String(tariff.price) : '')
  const [payProductId, setPayProductId] = useState(tariff?.pay_product_id || '')
  const [payUrl, setPayUrl] = useState(tariff?.pay_url || '')
  const [isActive, setIsActive] = useState(tariff?.is_active ?? true)
  const [isFeatured, setIsFeatured] = useState(tariff?.is_featured ?? false)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!title.trim() || !code.trim()) return
    setSaving(true)
    try {
      const data = {
        code: code.trim().toLowerCase(),
        title: title.trim(),
        description: description.trim() || null,
        excluded_description: excluded.trim() || null,
        price: price.trim() ? Number(price) : null,
        pay_product_id: payProductId.trim() || null,
        pay_url: payUrl.trim() || null,
        is_active: isActive,
        is_featured: isFeatured,
      }
      if (tariff) await api.products.updateTariff(productId, tariff.id, data)
      else await api.products.createTariff(productId, data)
      onSaved()
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-semibold text-gray-900">{tariff ? 'Тариф' : 'Новый тариф'}</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
      </div>

      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm text-gray-600">Название</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
                   className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">Код</label>
            <input value={code} onChange={e => setCode(e.target.value)}
                   className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <p className="mt-1 text-xs text-gray-400">Латиницей: standard, premium</p>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-600">Что входит</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-600">Что не входит</label>
          <textarea value={excluded} onChange={e => setExcluded(e.target.value)} rows={2}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm text-gray-600">Цена, ₽</label>
            <input value={price} onChange={e => setPrice(e.target.value)} inputMode="numeric"
                   className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <p className="mt-1 text-xs text-gray-400">Пусто или 0 — бесплатный доступ</p>
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">Код товара</label>
            <input value={payProductId} onChange={e => setPayProductId(e.target.value)}
                   className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <p className="mt-1 text-xs text-gray-400">Нужен только для LeadPay</p>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-600">Своя ссылка на оплату</label>
          <input value={payUrl} onChange={e => setPayUrl(e.target.value)}
                 className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <p className="mt-1 text-xs text-gray-400">
            Понадобится, только если платёжная система не подключена — тогда оплату
            отмечаете вручную.
          </p>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
            Показывать на странице
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isFeatured} onChange={e => setIsFeatured(e.target.checked)} />
            Выделить как основной
          </label>
        </div>

        <div className="flex gap-2">
          <button onClick={save} disabled={saving || !title.trim() || !code.trim()} className="btn-gold">
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button onClick={onClose} className="btn-primary">Отмена</button>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────── Состав ─────────────────────────────────── */

/**
 * Состав продукта — дерево «разделы + материалы».
 *
 * ⚠️ Раздел здесь — просто папка внутри продукта, а НЕ вложенный курс со своими
 * настройками (как у Бизона, где из-за этого теряешься в матрёшке). Нажали
 * «Добавить раздел», вписали название — всё.
 *
 * ⚠️ Материал без раздела — нормальный случай, а не ошибка: он показывается
 * первым уровнем рядом с разделами (вводное видео до первого раздела, бонус
 * после последнего). Продукт из трёх файлов разделов не заводит вовсе.
 *
 * Как называется раздел — решает словарь продукта: «Модуль» у образовательного
 * пресета, «Блок» у консультационного.
 */
function ContentTab({ productId, readOnly, wordingPreset }: {
  productId: number; readOnly: boolean; wordingPreset: string
}) {
  const [tree, setTree] = useState<any[]>([])
  const [sections, setSections] = useState<any[]>([])
  const [tariffs, setTariffs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [picking, setPicking] = useState<{ sectionId: number | null } | null>(null)
  const [creating, setCreating] = useState<{ sectionId: number | null } | null>(null)
  const [addingSection, setAddingSection] = useState<{ parentId: number | null } | null>(null)

  const W = wording(wordingPreset)

  const load = async () => {
    try {
      const [c, t] = await Promise.all([
        api.products.materials(productId),
        api.products.tariffs(productId),
      ])
      setTree(c.tree || [])
      setSections(c.sections || [])
      setTariffs(t.tariffs || [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [productId])

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  return (
    <div className="max-w-3xl">
      <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
        Это то, что человек получит после оплаты. Материалы можно сложить
        в {W.sectionsAcc.toLowerCase()} — или оставить простым списком, если их немного.
      </div>

      {!readOnly && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            onClick={() => setAddingSection({ parentId: null })}
            className="btn-gold inline-flex items-center gap-2"
          >
            <Plus size={16} /> Добавить {W.section.toLowerCase()}
          </button>
          <button
            onClick={() => setCreating({ sectionId: null })}
            className="btn-primary inline-flex items-center gap-2"
          >
            <Plus size={16} /> Загрузить материал
          </button>
          <button
            onClick={() => setPicking({ sectionId: null })}
            className="btn-primary inline-flex items-center gap-2"
          >
            <Layers size={16} /> Взять из имеющихся
          </button>
        </div>
      )}

      {addingSection && (
        <SectionForm
          productId={productId}
          parentId={addingSection.parentId}
          word={W.section}
          onClose={() => setAddingSection(null)}
          onSaved={() => { setAddingSection(null); load() }}
        />
      )}

      {creating && (
        <NewMaterialInline
          productId={productId}
          sectionId={creating.sectionId}
          onClose={() => setCreating(null)}
          onSaved={() => { setCreating(null); load() }}
        />
      )}

      {picking && (
        <PickMaterialModal
          productId={productId}
          sectionId={picking.sectionId}
          onClose={() => setPicking(null)}
          onAdded={() => { setPicking(null); load() }}
        />
      )}

      {!tree.length && (
        <p className="text-sm text-gray-400">
          Пока пусто. У консультации материалов может не быть вовсе — это нормально.
        </p>
      )}

      <div className="space-y-2">
        {tree.map(node => (
          <TreeNode
            key={`${node.type}-${node.id || node.link_id}`}
            node={node}
            depth={0}
            productId={productId}
            sections={sections}
            tariffs={tariffs}
            readOnly={readOnly}
            W={W}
            onChanged={load}
            onAddSection={(parentId) => setAddingSection({ parentId })}
            onAddMaterial={(sectionId) => setCreating({ sectionId })}
            onPickMaterial={(sectionId) => setPicking({ sectionId })}
          />
        ))}
      </div>
    </div>
  )
}

/** Словарь: как называть части продукта. Зависит от пресета (миграция 290). */
function wording(preset: string) {
  return preset === 'education'
    ? { section: 'Модуль', sectionsAcc: 'Модули', unit: 'Урок' }
    : { section: 'Блок', sectionsAcc: 'Блоки', unit: 'Материал' }
}

/** Общие пропсы узла дерева состава — и раздела, и материала. */
type TreeNodeProps = {
  node: any
  depth: number
  productId: number
  sections: any[]
  tariffs: any[]
  readOnly: boolean
  W: { section: string; sectionsAcc: string; unit: string }
  onChanged: () => void
  onAddSection: (parentId: number | null) => void
  onAddMaterial: (sectionId: number | null) => void
  onPickMaterial: (sectionId: number | null) => void
}

function TreeNode({ node, depth, productId, sections, tariffs, readOnly, W,
                    onChanged, onAddSection, onAddMaterial, onPickMaterial }: TreeNodeProps) {
  const [open, setOpen] = useState(true)

  if (node.type === 'material') {
    return (
      <div style={{ marginLeft: depth * 20 }}>
        <ContentRow
          productId={productId}
          item={node}
          sections={sections}
          tariffs={tariffs}
          readOnly={readOnly}
          onChanged={onChanged}
        />
      </div>
    )
  }

  // Раздел
  return (
    <div style={{ marginLeft: depth * 20 }}>
      <div className="rounded-xl border border-gray-300 bg-gray-50">
        <div className="flex items-center gap-2 p-3">
          <button onClick={() => setOpen(!open)} className="text-gray-400 hover:text-gray-600">
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-gray-900">{node.title}</div>
            {node.description && (
              <div className="truncate text-xs text-gray-500">{node.description}</div>
            )}
          </div>
          {!readOnly && (
            <SectionActions
              productId={productId}
              section={node}
              W={W}
              onChanged={onChanged}
              onAddSection={onAddSection}
              onAddMaterial={onAddMaterial}
              onPickMaterial={onPickMaterial}
            />
          )}
        </div>

        {open && (
          <div className="space-y-2 border-t border-gray-200 p-3">
            {!node.children?.length && (
              <p className="text-xs text-gray-400">
                Пусто. Добавьте материалы или вложенный {W.section.toLowerCase()}.
              </p>
            )}
            {node.children?.map((ch: any) => (
              <TreeNode
                key={`${ch.type}-${ch.id || ch.link_id}`}
                node={ch}
                depth={0}
                productId={productId}
                sections={sections}
                tariffs={tariffs}
                readOnly={readOnly}
                W={W}
                onChanged={onChanged}
                onAddSection={onAddSection}
                onAddMaterial={onAddMaterial}
                onPickMaterial={onPickMaterial}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionActions({ productId, section, W, onChanged,
                          onAddSection, onAddMaterial, onPickMaterial }: {
  productId: number
  section: any
  W: { section: string; sectionsAcc: string; unit: string }
  onChanged: () => void
  onAddSection: (parentId: number | null) => void
  onAddMaterial: (sectionId: number | null) => void
  onPickMaterial: (sectionId: number | null) => void
}) {
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)

  const remove = async () => {
    if (!confirm(
      `Удалить «${section.title}»? Материалы внутри не пропадут — ` +
      `они поднимутся на верхний уровень продукта.`
    )) return
    await api.products.deleteSection(productId, section.id)
    onChanged()
  }

  if (editing) {
    return (
      <SectionRename
        productId={productId}
        section={section}
        onClose={() => setEditing(false)}
        onSaved={() => { setEditing(false); onChanged() }}
      />
    )
  }

  return (
    <div className="relative flex items-center gap-2">
      <button onClick={() => onAddMaterial(section.id)}
              className="text-xs text-gray-500 hover:text-gray-700">
        + материал
      </button>
      <button onClick={() => setMenu(!menu)} className="text-gray-400 hover:text-gray-600">
        <MoreHorizontal size={16} />
      </button>
      {menu && (
        <div className="absolute right-0 top-7 z-10 w-56 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          <button
            onClick={() => { setMenu(false); onPickMaterial(section.id) }}
            className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
          >
            Взять материал из имеющихся
          </button>
          <button
            onClick={() => { setMenu(false); onAddSection(section.id) }}
            className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
          >
            Вложенный {W.section.toLowerCase()}
          </button>
          <button
            onClick={() => { setMenu(false); setEditing(true) }}
            className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
          >
            Переименовать
          </button>
          <button
            onClick={() => { setMenu(false); remove() }}
            className="block w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
          >
            Удалить
          </button>
        </div>
      )}
    </div>
  )
}

function SectionForm({ productId, parentId, word, onClose, onSaved }: {
  productId: number; parentId: number | null; word: string
  onClose: () => void; onSaved: () => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await api.products.createSection(productId, {
        title: title.trim(),
        description: description.trim() || null,
        parent_id: parentId,
      })
      onSaved()
    } catch (e: any) {
      alert(e?.message || 'Не удалось создать')
    } finally { setSaving(false) }
  }

  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-semibold text-gray-900">
          Новый {word.toLowerCase()}{parentId ? ' внутри раздела' : ''}
        </span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
      </div>
      <div className="space-y-3">
        <input
          value={title} onChange={e => setTitle(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <input
          value={description} onChange={e => setDescription(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <div className="flex gap-2">
          <button onClick={save} disabled={saving || !title.trim()} className="btn-gold">
            {saving ? 'Создаём…' : 'Создать'}
          </button>
          <button onClick={onClose} className="btn-primary">Отмена</button>
        </div>
      </div>
    </div>
  )
}

function SectionRename({ productId, section, onClose, onSaved }: {
  productId: number; section: any; onClose: () => void; onSaved: () => void
}) {
  const [title, setTitle] = useState(section.title || '')
  const [description, setDescription] = useState(section.description || '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await api.products.updateSection(productId, section.id, {
        title: title.trim(),
        description: description.trim() || null,
      })
      onSaved()
    } finally { setSaving(false) }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        value={title} onChange={e => setTitle(e.target.value)}
        className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
      />
      <input
        value={description} onChange={e => setDescription(e.target.value)}
        placeholder="описание"
        className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
      />
      <button onClick={save} disabled={saving} className="text-sm font-medium text-[#25455D]">
        ОК
      </button>
      <button onClick={onClose} className="text-sm text-gray-500">Отмена</button>
    </div>
  )
}

function ContentRow({ productId, item, sections, tariffs, readOnly, onChanged }: {
  productId: number; item: any; sections: any[]; tariffs: any[]
  readOnly: boolean; onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const name = item.title_override || item.title

  const detach = async () => {
    if (!confirm(`Убрать «${name}» из продукта? Сам материал останется в библиотеке.`)) return
    await api.products.detachMaterial(productId, item.link_id)
    onChanged()
  }

  const toggleLanding = async () => {
    await api.products.updateMaterial(productId, item.link_id, {
      show_on_landing: !item.show_on_landing,
    })
    onChanged()
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-gray-900">{name}</div>
          <div className="text-xs text-gray-400">
            {item.min_tariff_id
              ? `С тарифа: ${tariffs.find(t => t.id === item.min_tariff_id)?.title || '—'}`
              : 'Открыт на всех тарифах'}
            {item.used_elsewhere > 0 && ` · используется ещё в ${item.used_elsewhere} продукт(ах)`}
          </div>
        </div>

        {!readOnly && (
          <>
            <button
              onClick={toggleLanding}
              className="text-gray-400 hover:text-gray-600"
              title={item.show_on_landing ? 'Показывается на странице' : 'Скрыт со страницы'}
            >
              {item.show_on_landing ? <Eye size={16} /> : <EyeOff size={16} />}
            </button>
            <button onClick={() => setEditing(true)}
                    className="text-sm font-medium text-[#25455D] hover:underline">
              Содержимое
            </button>
            <button onClick={() => setOpen(!open)} className="text-sm text-gray-500 hover:text-gray-700">
              Настроить
            </button>
            <button onClick={detach} className="text-gray-400 hover:text-red-600">
              <Trash2 size={16} />
            </button>
          </>
        )}
      </div>

      {open && (
        <ContentSettings
          productId={productId} item={item} sections={sections} tariffs={tariffs}
          onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); onChanged() }}
        />
      )}

      {editing && (
        <MaterialEditor
          materialId={item.material_id}
          title={item.title}
          onClose={() => { setEditing(false); onChanged() }}
          onRenamed={() => onChanged()}
        />
      )}
    </div>
  )
}

function ContentSettings({ productId, item, sections, tariffs, onClose, onSaved }: {
  productId: number; item: any; sections: any[]; tariffs: any[]
  onClose: () => void; onSaved: () => void
}) {
  const [titleOverride, setTitleOverride] = useState(item.title_override || '')
  const [minTariff, setMinTariff] = useState<string>(item.min_tariff_id ? String(item.min_tariff_id) : '')
  const [sectionId, setSectionId] = useState<string>(item.section_id ? String(item.section_id) : '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await api.products.updateMaterial(productId, item.link_id, {
        title_override: titleOverride.trim() || null,
        min_tariff_id: minTariff ? Number(minTariff) : null,
        section_id: sectionId ? Number(sectionId) : null,
      })
      onSaved()
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  return (
    <div className="border-t border-gray-100 p-4">
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm text-gray-600">Название в этом продукте</label>
          <input
            value={titleOverride} onChange={e => setTitleOverride(e.target.value)}
            placeholder={item.title}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-gray-400">
            Пусто — название из библиотеки. В другом продукте этот же материал
            может называться иначе.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-600">Где лежит</label>
          <select
            value={sectionId} onChange={e => setSectionId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">Первым уровнем (без раздела)</option>
            {sections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-600">С какого тарифа открыт</label>
          <select
            value={minTariff} onChange={e => setMinTariff(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="">На всех тарифах</option>
            {tariffs.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </div>

        <div className="flex gap-2">
          <button onClick={save} disabled={saving} className="btn-gold">
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button onClick={onClose} className="btn-primary">Отмена</button>
        </div>
      </div>
    </div>
  )
}

function NewMaterialInline({ productId, sectionId, onClose, onSaved }: {
  productId: number; sectionId?: number | null
  onClose: () => void; onSaved: () => void
}) {
  const [kind, setKind] = useState('file')
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!title.trim()) return
    if (kind !== 'text' && !url.trim()) { alert('Добавьте ссылку'); return }
    setSaving(true)
    try {
      await api.products.attachMaterial(productId, {
        section_id: sectionId ?? null,
        new_material: {
          kind, title: title.trim(),
          url: kind === 'text' ? null : url.trim(),
          body: kind === 'text' ? body : null,
        },
      })
      onSaved()
    } catch (e: any) {
      alert(e?.message || 'Не удалось добавить')
    } finally { setSaving(false) }
  }

  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-semibold text-gray-900">Новый материал</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {[['video', 'Видео'], ['file', 'Файл'], ['link', 'Ссылка'], ['text', 'Текст']].map(([v, l]) => (
            <button
              key={v} onClick={() => setKind(v)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                kind === v ? 'border-[#25455D] bg-[#25455D] text-white'
                           : 'border-gray-300 text-gray-600 hover:border-gray-400'
              }`}
            >{l}</button>
          ))}
        </div>
        <input
          value={title} onChange={e => setTitle(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        {kind === 'text' ? (
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={5}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        ) : (
          <input value={url} onChange={e => setUrl(e.target.value)}
                 className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        )}
        <div className="flex gap-2">
          <button onClick={save} disabled={saving || !title.trim()} className="btn-gold">
            {saving ? 'Добавляем…' : 'Добавить'}
          </button>
          <button onClick={onClose} className="btn-primary">Отмена</button>
        </div>
      </div>
    </div>
  )
}

function PickMaterialModal({ productId, sectionId, onClose, onAdded }: {
  productId: number; sectionId?: number | null
  onClose: () => void; onAdded: () => void
}) {
  const [list, setList] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number | null>(null)

  const load = async (query?: string) => {
    try {
      const r = await api.materials.list(query)
      setList(r.materials || [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const attach = async (materialId: number, copy: boolean) => {
    setBusy(materialId)
    try {
      await api.products.attachMaterial(productId, {
        material_id: materialId, copy, section_id: sectionId ?? null,
      })
      onAdded()
    } catch (e: any) {
      alert(e?.message || 'Не удалось добавить')
    } finally { setBusy(null) }
  }

  return (
    // ⚠️ Модалка-форма не закрывается по клику на фон (правило проекта):
    // на внешнем div НЕТ onClick, закрытие только крестиком и «Отмена».
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        onClick={e => e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5"
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-lg font-semibold text-gray-900">Взять из имеющихся</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="mb-3 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
          <b>Подключить</b> — материал остаётся общим: поправите его, и обновится
          во всех продуктах.{' '}
          <b>Взять копией</b> — появится отдельная запись, её можно переписать
          под этот продукт, оригинал не изменится.
        </div>

        <input
          value={q} onChange={e => { setQ(e.target.value); load(e.target.value) }}
          placeholder="Поиск по названию"
          className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />

        {loading && <p className="text-sm text-gray-400">Загружаем…</p>}
        {!loading && !list.length && (
          <p className="text-sm text-gray-400">Ничего не нашлось.</p>
        )}

        <div className="space-y-2">
          {list.map(m => (
            <div key={m.id} className="flex items-center gap-3 rounded-xl border border-gray-200 p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-gray-900">{m.title}</div>
                <div className="text-xs text-gray-400">
                  {m.used_count > 0 ? `используется в ${m.used_count} продукт(ах)` : 'пока нигде не используется'}
                </div>
              </div>
              <button
                onClick={() => attach(m.id, false)} disabled={busy === m.id}
                className="text-sm font-medium text-[#25455D] hover:underline"
              >
                Подключить
              </button>
              <button
                onClick={() => attach(m.id, true)} disabled={busy === m.id}
                className="text-sm text-gray-500 hover:underline"
              >
                Взять копией
              </button>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <button onClick={onClose} className="btn-primary">Отмена</button>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────── Клиенты ────────────────────────────────── */

function BuyersTab({ productId, readOnly }: { productId: number; readOnly: boolean }) {
  const [buyers, setBuyers] = useState<any[]>([])
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const [b, o] = await Promise.all([
        api.products.buyers(productId),
        api.products.orders(productId),
      ])
      setBuyers(b.buyers || [])
      setOrders(o.orders || [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [productId])

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  const unpaid = orders.filter(o => o.status === 'unpaid')

  return (
    <div className="max-w-3xl space-y-6">
      {unpaid.length > 0 && (
        <div>
          <h3 className="mb-2 font-semibold text-gray-900">Не оплачено — {unpaid.length}</h3>
          <div className="space-y-2">
            {unpaid.map(o => (
              <div key={o.id} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
                <div className="font-medium text-gray-900">{o.contact_name || 'Без имени'}</div>
                <div className="text-xs text-gray-500">
                  {o.tariff_title}
                  {o.amount ? ` · ${o.amount} ₽` : ''}
                  {o.email ? ` · ${o.email}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 font-semibold text-gray-900">Доступ открыт — {buyers.length}</h3>
        {!buyers.length && (
          <p className="text-sm text-gray-400">Пока никого.</p>
        )}
        <div className="space-y-2">
          {buyers.map(b => (
            <div key={b.id} className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-gray-900">{b.name || 'Без имени'}</div>
                <div className="text-xs text-gray-400">
                  {b.tariff_title || 'Без тарифа'}
                  {b.email ? ` · ${b.email}` : ''}
                  {b.source === 'manual' && ' · выдан вручную'}
                </div>
              </div>
              {!readOnly && (
                <button
                  onClick={async () => {
                    if (!confirm(`Забрать доступ у «${b.name || 'без имени'}»?`)) return
                    await api.products.revokeAccess(productId, b.id)
                    load()
                  }}
                  className="text-gray-400 hover:text-red-600"
                  title="Забрать доступ"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
