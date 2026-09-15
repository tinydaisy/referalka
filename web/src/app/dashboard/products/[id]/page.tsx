'use client'

/**
 * Карточка продукта (миграция 290).
 *
 * Вкладки по образцу карточки события: Основное, Тарифы, Материалы, Клиенты.
 * «Лендинг» появится, когда конструктор блоков будет развязан с события.
 *
 * ⚠️ Адрес страницы показываем на домене клиента (publicBase), а не на
 * pluson.ru: клиент платит за свой домен и раздаёт его, а не наш.
 */
import { useEffect, useState } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import { usePaymentMinimum } from '@/hooks/usePaymentMinimum'
import FeatureLock from '@/components/FeatureLock'
import ProductLandingTab from './LandingTab'
import {
  ArrowLeft, Plus, Trash2, X, Copy, Check, ChevronDown, ChevronUp, ChevronRight,
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
  // ⚠️ Вкладка в АДРЕСЕ: обновление страницы оставляет человека на месте.
  const [tab, setTab] = useUrlTab<
    'main' | 'tariffs' | 'content' | 'landing' | 'buyers' | 'orders'>(
    'tab', 'main', ['main', 'tariffs', 'content', 'landing', 'buyers', 'orders'])

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
          ['content', 'Материалы', Layers],
          ['landing', 'Лендинг', LayoutTemplate],
          ['buyers', 'Клиенты', Users],
          ['orders', 'Заказы', Wallet],
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
      {tab === 'orders' && <OrdersTab productId={productId} />}
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
      alert(e?.message || 'Не удалось изменить статус')
    } finally { setSaving(false) }
  }

  if (readOnly) {
    return (
      <span className={`rounded-full border px-3 py-1 text-xs ${
        product.status === 'published'
          ? 'border-green-200 bg-green-50 text-green-700'
          : 'border-amber-200 bg-amber-50 text-amber-700'
      }`}>
        {product.status === 'published' ? 'Опубликован' : 'Черновик'}
      </span>
    )
  }

  const published = product.status === 'published'

  const publish = () => {
    // ⚠️ Оферта — предупреждение, а не запрет: решение за клиентом. Раньше
    // бэкенд просто отказывал, и человек оставался с черновиком, чья
    // страница отвечает «Страница не найдена».
    if (!(product.offer_url || '').trim()) {
      const ok = confirm(
        'Ссылка на оферту не заполнена — на странице продукта её не будет.\n\n' +
        'Опубликовать всё равно?'
      )
      if (!ok) return
    }
    setStatus('published')
  }

  return (
    <div className="flex items-center gap-2">
      <span className={`rounded-full border px-3 py-1 text-xs ${
        published
          ? 'border-green-200 bg-green-50 text-green-700'
          : 'border-amber-200 bg-amber-50 text-amber-700'
      }`}>
        {published ? 'Опубликован' : 'Черновик'}
      </span>
      {published ? (
        <button
          onClick={() => setStatus('draft')}
          disabled={saving}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
        >
          Снять с публикации
        </button>
      ) : (
        <button onClick={publish} disabled={saving} className="btn-gold px-4 py-1.5 text-xs">
          Опубликовать
        </button>
      )}
    </div>
  )
}

/* ────────────────────────────── Основное ────────────────────────────────── */

function MainTab({ product, readOnly, publicBase, onChanged }: {
  product: any; readOnly: boolean; publicBase: string; onChanged: () => void
}) {
  const [title, setTitle] = useState(product.title || '')
  const [description, setDescription] = useState(product.description || '')
  const [slug, setSlug] = useState(product.slug || '')
  const [offerUrl, setOfferUrl] = useState(product.offer_url || '')
  const [preset, setPreset] = useState(product.wording_preset || 'consulting')
  const [categoryId, setCategoryId] = useState<string>(
    product.category_id ? String(product.category_id) : '')
  const [cats, setCats] = useState<any[]>([])
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  // Список категорий приходит вместе со списком продуктов — отдельного
  // эндпоинта под него нет, чтобы не плодить запрос ради одного селектора.
  useEffect(() => {
    api.products.list()
      .then((r: any) => setCats(r.categories || []))
      .catch(() => {})
  }, [])

  const url = `${publicBase}/pr/${product.slug}`

  const save = async () => {
    setSaving(true)
    try {
      await api.products.update(product.id, {
        title: title.trim(),
        description: description.trim() || null,
        slug: slug.trim(),
        offer_url: offerUrl.trim() || null,
        wording_preset: preset,
        category_id: categoryId ? Number(categoryId) : null,
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

      {/* ⚠️ Поля «Короткое пояснение» больше НЕТ: двух описаний у продукта не
          нужно — человек не понимает, чем они отличаются и что где показывается.
          Осталось одно «Описание», оно же подзаголовок шапки лендинга. */}
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
          <a href={url} target="_blank" rel="noreferrer"
             className="text-gray-400 hover:text-gray-600" title="Открыть">
            <ExternalLink size={16} />
          </a>
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Латиница, цифры и дефис. Меняете адрес — старые ссылки перестанут работать.
        </p>
        {/* ⚠️ Ссылка на продукт работает СРАЗУ, до всякой публикации: внешнего
            каталога продуктов нет, и «опубликовать» тут ничего не открывает —
            страницу рассылают ссылкой. Статус оставлен на будущее (появится
            каталог — он и будет решать, показывать ли карточку). */}
        <p className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          Ссылка работает сразу — её можно отправлять, не дожидаясь публикации.
          Статус нужен на будущее: когда появится общий каталог продуктов, в нём
          покажутся только опубликованные.
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
          и порядок возврата. Опубликовать можно и без неё, но лучше заполнить.
        </p>
      </div>

      {/* ⚠️ Категория — ВНУТРЕННЯЯ раскладка кабинета по направлениям, наружу
          она не уходит: публичного каталога продуктов нет. */}
      <div>
        <label className="mb-1 block text-sm text-gray-600">Категория</label>
        <select
          value={categoryId}
          onChange={e => setCategoryId(e.target.value)}
          disabled={readOnly}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">Без категории</option>
          {cats.map(c => (
            <option key={c.id} value={String(c.id)}>{c.title}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-400">
          Раскладка по направлениям в списке продуктов. Новые категории заводятся
          там же, кнопкой «Категории».
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
  // Участие продукта в партнёрке (миграция 347).
  // ⚠️ Без галочки начисления НЕ создаются — проверка стоит в самом
  // начислении. Колонка с DEFAULT FALSE и без способа включить = мёртвая
  // партнёрка, поэтому галочка обязана быть в интерфейсе.
  const { me } = useMe()
  const hasPartnerProgram = (me?.features || []).includes('partner_program')
  const [partnerOn, setPartnerOn] = useState(false)
  const [savingPartner, setSavingPartner] = useState(false)
  useEffect(() => {
    api.products.get(productId)
      .then((p: any) => setPartnerOn(!!p?.partner_enabled))
      .catch(() => {})
  }, [productId])
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

  /** Порядок тарифов в кабинете = порядок на лендинге. Список меняем сразу,
   *  не дожидаясь ответа, иначе стрелка кажется залипшей. */
  const move = async (index: number, dir: -1 | 1) => {
    const to = index + dir
    if (to < 0 || to >= list.length) return
    const next = [...list]
    ;[next[index], next[to]] = [next[to], next[index]]
    setList(next)
    try {
      await api.products.reorderTariffs(productId, next.map(t => t.id))
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить порядок')
      await load()
    }
  }

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  return (
    <div className="max-w-3xl">
      {hasPartnerProgram && (
        <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" className="mt-1" disabled={savingPartner || readOnly}
                   checked={partnerOn}
                   onChange={async e => {
                     const next = e.target.checked
                     setSavingPartner(true)
                     try {
                       await api.products.update(productId, { partner_enabled: next })
                       setPartnerOn(next)
                     } catch (err: any) {
                       alert(err?.message || 'Не удалось сохранить')
                     } finally { setSavingPartner(false) }
                   }} />
            <div>
              <div className="text-sm font-medium text-gray-800">
                Участвует в партнёрской программе
              </div>
              <div className="text-xs text-gray-500">
                Партнёры смогут рекомендовать этот продукт и получать
                вознаграждение с оплат. Размер задаётся у тарифа или
                в разделе «Моя партнёрка».
              </div>
            </div>
          </label>
        </div>
      )}

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
        {list.map((t, i) => (
          <TariffRow key={t.id} productId={productId} tariff={t} readOnly={readOnly} onChanged={load}
                     onMove={readOnly ? undefined : d => move(i, d)}
                     canUp={i > 0} canDown={i < list.length - 1} />
        ))}
      </div>
    </div>
  )
}

function TariffRow({ productId, tariff, readOnly, onChanged, onMove, canUp, canDown }: {
  productId: number; tariff: any; readOnly: boolean; onChanged: () => void
  onMove?: (dir: -1 | 1) => void; canUp?: boolean; canDown?: boolean
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
      {/* Стрелки порядка: в этой последовательности тарифы идут на лендинге. */}
      {onMove && (
        <div className="-my-1 flex shrink-0 flex-col">
          <button onClick={() => onMove(-1)} disabled={!canUp}
                  className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-25 disabled:hover:text-gray-400"
                  title="Выше">
            <ChevronUp size={15} />
          </button>
          <button onClick={() => onMove(1)} disabled={!canDown}
                  className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-25 disabled:hover:text-gray-400"
                  title="Ниже">
            <ChevronDown size={15} />
          </button>
        </div>
      )}
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
          {tariff.old_price != null && (
            <span className="line-through mr-1">
              {Number(tariff.old_price).toLocaleString('ru-RU')} ₽
            </span>
          )}
          {tariff.price ? `${Number(tariff.price).toLocaleString('ru-RU')} ₽` : 'Бесплатно'}
          {tariff.discount_percent != null && (
            <span className="ml-1.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
              −{tariff.discount_percent}%
            </span>
          )}
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
  // Поле «Вознаграждение партнёру» показываем только при подключённой
  // партнёрской программе — иначе это непонятное поле, которое ничего не делает.
  const { me } = useMe()
  const hasPartnerProgram = (me?.features || []).includes('partner_program')
  const [code, setCode] = useState(tariff?.code || '')
  const [title, setTitle] = useState(tariff?.title || '')
  const [description, setDescription] = useState(tariff?.description || '')
  const [excluded, setExcluded] = useState(tariff?.excluded_description || '')
  // price — цена К ОПЛАТЕ (со скидкой). Старая цена не хранится, её считает
  // бэкенд по discount_kind/discount_value.
  const [price, setPrice] = useState<string>(tariff?.price != null ? String(tariff.price) : '')
  const [discountKind, setDiscountKind] = useState<'percent' | 'amount'>(tariff?.discount_kind || 'percent')
  const [discountValue, setDiscountValue] = useState<string>(
    tariff?.discount_value != null ? String(tariff.discount_value) : '')
  // Вознаграждение партнёру (миграция 347). Пусто = действует умолчание
  // из «Моя партнёрка» → «Настройки».
  const [rewardKind, setRewardKind] = useState<'percent' | 'fixed'>(
    tariff?.partner_reward_kind || 'percent')
  const [rewardValue, setRewardValue] = useState<string>(
    tariff?.partner_reward_value != null ? String(tariff.partner_reward_value) : '')
  // Срок доступа после оплаты (миграция 369). Пусто = навсегда.
  const [accessDays, setAccessDays] = useState<string>(
    tariff?.access_days != null ? String(tariff.access_days) : '')
  const [payProductId, setPayProductId] = useState(tariff?.pay_product_id || '')
  const [payUrl, setPayUrl] = useState(tariff?.pay_url || '')
  const [isActive, setIsActive] = useState(tariff?.is_active ?? true)
  const [isFeatured, setIsFeatured] = useState(tariff?.is_featured ?? false)
  const [saving, setSaving] = useState(false)
  // Предупреждение о цене ниже минимума платёжной системы.
  const { warnFor: minPaymentWarn } = usePaymentMinimum()

  // Цена до скидки — только для подсказки в форме (боевой расчёт на бэке).
  const oldPricePreview = (() => {
    const p = parseInt(price, 10)
    const v = parseInt(discountValue, 10)
    if (!Number.isFinite(p) || !Number.isFinite(v) || v <= 0 || p < 0) return null
    if (discountKind === 'percent') {
      if (v >= 100) return null
      const o = Math.round((p * 100) / (100 - v))
      return o > p ? o : null
    }
    return p + v
  })()

  // Сколько получит партнёр — подсказка под полем: «10%» само по себе
  // ничего не говорит, а «1 900 ₽» говорит.
  const rewardPreview = (() => {
    const p = parseInt(price, 10)
    const v = parseFloat(rewardValue)
    if (!Number.isFinite(v) || v <= 0) return null
    if (rewardKind === 'fixed') return `${v.toLocaleString('ru-RU')} ₽`
    if (!Number.isFinite(p) || p <= 0) return null
    return `${Math.round((p * v) / 100).toLocaleString('ru-RU')} ₽`
  })()

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
        // Пустой размер = скидки нет.
        discount_kind: discountValue.trim() ? discountKind : null,
        discount_value: discountValue.trim() ? Number(discountValue) : null,
        pay_product_id: payProductId.trim() || null,
        pay_url: payUrl.trim() || null,
        is_active: isActive,
        is_featured: isFeatured,
        // Пустой размер = своего вознаграждения нет, действует умолчание
        // кабинета. Пара пишется целиком — половина не пройдёт проверку.
        partner_reward_kind: rewardValue.trim() ? rewardKind : null,
        partner_reward_value: rewardValue.trim() ? Number(rewardValue) : null,
        // Пусто или 0 = доступ бессрочный (так работали все тарифы до 369).
        access_days: accessDays.trim() ? Number(accessDays) : null,
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
            <p className="mt-1 text-xs text-gray-400">Цена к оплате. Пусто или 0 — бесплатный доступ</p>
            {/* Предупреждение, а не запрет: цену решает клиент, но платёж ниже
                порога платёжная система просто не пропустит. */}
            {minPaymentWarn(price) && (
              <p className="mt-1 text-xs text-amber-700">{minPaymentWarn(price)}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">Скидка</label>
            <div className="flex gap-2">
              {/* Ширины inline — чтобы селектор не растянулся, а поле ввода
                  не схлопнулось (см. ту же правку в тарифах события). */}
              <select value={discountKind}
                      onChange={e => setDiscountKind(e.target.value as 'percent' | 'amount')}
                      style={{ flex: '0 0 5rem' }}
                      className="rounded-lg border border-gray-300 px-2 py-2 text-sm">
                <option value="percent">%</option>
                <option value="amount">₽</option>
              </select>
              <input value={discountValue}
                     onChange={e => setDiscountValue(e.target.value.replace(/[^0-9]/g, ''))}
                     inputMode="numeric" placeholder={discountKind === 'percent' ? '20' : '5000'}
                     style={{ flex: '1 1 auto', minWidth: 0 }}
                     className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            {oldPricePreview ? (
              <p className="mt-1 text-xs text-gray-600">
                На лендинге:{' '}
                <span className="text-gray-400 line-through">{oldPricePreview.toLocaleString('ru-RU')} ₽</span>{' '}
                <span className="font-semibold text-gray-900">
                  {parseInt(price, 10).toLocaleString('ru-RU')} ₽
                </span>
              </p>
            ) : (
              <p className="mt-1 text-xs text-gray-400">Пусто — скидки нет</p>
            )}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-600">
            Доступ на, дней
          </label>
          <input value={accessDays}
                 onChange={e => setAccessDays(e.target.value.replace(/[^0-9]/g, ''))}
                 inputMode="numeric" placeholder="Пусто — навсегда"
                 className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <p className="mt-1 text-xs text-gray-400">
            {accessDays.trim() && Number(accessDays) > 0
              ? `После оплаты доступ откроется на ${accessDays} дн. — до ${
                  new Date(Date.now() + Number(accessDays) * 86400000)
                    .toLocaleDateString('ru-RU')}, если купить сегодня.`
              : 'Пусто — доступ бессрочный. Заполните, если продаёте доступ на время.'}
          </p>
        </div>

        {/* ⚠️⚠️ Поле кода товара ВИДНО ВСЕГДА. У тарифов, заведённых раньше,
            код остался в базе: спрятав поле, мы лишили клиента возможности его
            увидеть и убрать — а пока код лежит, LeadPay берёт цену из своей
            карточки, и скидка с промокодом молча не работают. Решает клиент,
            и у каждого варианта подписано последствие. */}
        <div>
          <label className="mb-1 block text-sm text-gray-600">Код товара</label>
          <input value={payProductId} onChange={e => setPayProductId(e.target.value)}
                 placeholder="не нужен — оставьте пустым"
                 className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          {payProductId.trim() ? (
            <p className="mt-1 text-xs text-amber-700">
              Код заполнен: LeadPay возьмёт цену и название <b>из своей карточки</b>,
              а не отсюда. <b>Цена выше должна совпадать с ценой в карточке</b> —
              иначе человек увидит одну сумму, а заплатит другую.
              Промокоды и скидка на таком тарифе <b>не работают</b>.
              Очистите поле, чтобы платили сумму из ПЛЮСОНа.
            </p>
          ) : (
            <p className="mt-1 text-xs text-gray-400">
              Пусто — название и сумма уходят в оплату из этого тарифа.
            </p>
          )}
        </div>

        {/* Вознаграждение партнёру за продажу этого тарифа (миграция 347).
            ⚠️ Показываем только при подключённой партнёрке: у остальных это
            непонятное поле в форме, которое ничего не делает. */}
        {hasPartnerProgram && (
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              Вознаграждение партнёру
            </label>
            <div className="flex gap-2">
              <select value={rewardKind}
                      onChange={e => setRewardKind(e.target.value as 'percent' | 'fixed')}
                      style={{ flex: '0 0 5rem' }}
                      className="rounded-lg border border-gray-300 px-2 py-2 text-sm">
                <option value="percent">%</option>
                <option value="fixed">₽</option>
              </select>
              <input value={rewardValue}
                     onChange={e => setRewardValue(e.target.value.replace(/[^0-9.]/g, ''))}
                     inputMode="decimal"
                     placeholder={rewardKind === 'percent' ? '10' : '3000'}
                     style={{ flex: '1 1 auto', minWidth: 0 }}
                     className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <p className="mt-1 text-xs text-gray-400">
              Пусто — действует значение из раздела «Моя партнёрка».
              {rewardPreview && ` Партнёр получит ${rewardPreview}`}
            </p>
          </div>
        )}

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

/* ────────────────────────────── Материалы ───────────────────────────────── */

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
  // ⚠️ Разделы СВЁРНУТЫ по умолчанию: у продукта их бывает десяток, и с
  // раскрытыми состав превращается в бесконечную простыню, по которой не
  // видно структуры. Свёрнутый список читается как оглавление, а развернуть
  // нужный можно стрелкой.
  const [open, setOpen] = useState(false)

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
          {/* ⚠️ Название раздела — ССЫЛКА на его страницу: со списком из
              десятка разделов работать в общей простыне неудобно, нужен экран
              одного раздела с его материалами. Стрелка рядом остаётся —
              заглянуть внутрь, не уходя со страницы. */}
          <div className="min-w-0 flex-1">
            <Link
              href={`/dashboard/products/${productId}/sections/${node.id}`}
              className="block truncate font-semibold text-gray-900 hover:text-[#25455D] hover:underline"
            >
              {node.title}
            </Link>
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
          <Link
            href={`/dashboard/products/${productId}/materials/${item.material_id}`}
            className="block truncate font-medium text-gray-900 hover:text-[#25455D] hover:underline"
          >
            {name}
          </Link>
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
            {/* ⚠️ Содержимое открывается СТРАНИЦЕЙ, а не окном: урок бывает
                длинным, а ссылку на окно нельзя ни сохранить, ни переслать. */}
            <Link href={`/dashboard/products/${productId}/materials/${item.material_id}`}
                  className="text-sm font-medium text-[#25455D] hover:underline">
              Содержимое
            </Link>
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
        className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 scroll-visible"
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

/* ────────────────────── Выдача доступа вручную ──────────────────────────── */

/**
 * Строка контактов человека в результатах поиска.
 *
 * ⚠️⚠️ НИК МЕССЕНДЖЕРА ОБЯЗАТЕЛЕН. Поиск ищет и по нику (`pu.username` в
 * `/contacts`), но раньше в строке показывались только почта и телефон — и
 * человек, нашедший контакт по нику «margo_forbs», видел строку без единого
 * совпадения с тем, что набрал, и не понимал, тот ли это человек и нашёлся ли
 * он вообще (жалоба владельца 07.09.2026).
 */
function contactLine(c: any): string {
  // Бэкенд кладёт ник и плоским полем `username`, и в списке `identities` —
  // берём первое непустое, чтобы строка не зависела от порядка площадок.
  const nick = c?.username
    || (c?.identities || []).find((i: any) => i.username)?.username
  return [nick ? `@${nick}` : null, c?.email, c?.phone]
    .filter(Boolean).join(' · ') || 'без контактов'
}

/**
 * Открыть доступ без заказа и без денег: подарок, бартер, перенос учеников
 * из GetCourse.
 *
 * ⚠️ Доступ выдаётся КОНТАКТУ из базы кабинета, а не «по email в никуда»:
 * кабинет ученика опознаёт человека по его контакту, и запись в воздухе
 * открыть было бы нечему. Поэтому здесь поиск по существующим контактам —
 * нового человека сначала заводят в разделе «Контакты».
 *
 * ⚠️ Тариф не обязателен: он решает, какие материалы видны (min_tariff_id у
 * связки). Без тарифа человек видит всё, что открыто на любом.
 */
function GrantAccessForm({
  productId, tariffs, onClose, onDone,
}: {
  productId: number
  tariffs: any[]
  onClose: () => void
  onDone: () => void
}) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState<any[]>([])
  const [picked, setPicked] = useState<any>(null)
  const [tariffId, setTariffId] = useState<string>('')
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  // Срок: по умолчанию бессрочно — так доступ выдавали всегда.
  const [unlimited, setUnlimited] = useState(true)
  const [until, setUntil] = useState('')

  // Ищем по мере ввода, но не на каждую букву — иначе на каждый символ
  // уходит запрос по всей базе контактов.
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        // ⚠️ Список контактов приходит в `items`, не в `contacts`.
        const r = await api.contacts.list(q.trim(), 10, 0)
        setFound(r.items || [])
      } finally { setSearching(false) }
    }, 350)
    return () => clearTimeout(t)
  }, [q])

  const grant = async () => {
    if (!picked) return
    if (!unlimited && !until) { alert('Укажите дату или отметьте «бессрочно»'); return }
    setSaving(true)
    try {
      await api.products.grantAccess(productId, {
        contact_id: picked.id,
        tariff_id: tariffId ? Number(tariffId) : null,
        // Конец дня: «до 12.11» человек понимает как «весь день 12-го».
        expires_at: unlimited ? null : `${until}T23:59:59`,
      })
      onDone()
    } catch (e: any) {
      alert(e?.message || 'Не получилось открыть доступ')
    } finally { setSaving(false) }
  }

  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3">
      {!picked ? (
        <>
          <label className="block text-sm font-medium text-gray-700">
            Кому открыть доступ
          </label>
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Имя, почта или телефон"
            className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-brand focus:outline-none"
          />
          {searching && <p className="text-xs text-gray-400">Ищем…</p>}
          {!searching && q.trim().length >= 2 && !found.length && (
            <p className="text-xs text-gray-500">
              Никого не нашли. Человека сначала нужно завести в разделе «Контакты».
            </p>
          )}
          <div className="space-y-1">
            {found.map(c => (
              <button
                key={c.id}
                onClick={() => setPicked(c)}
                className="flex w-full items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left hover:border-brand"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-gray-900">
                    {c.name || 'Без имени'}
                  </div>
                  <div className="truncate text-xs text-gray-400">
                    {contactLine(c)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-gray-900">
                {picked.name || 'Без имени'}
              </div>
              <div className="truncate text-xs text-gray-400">
                {contactLine(picked)}
              </div>
            </div>
            <button onClick={() => setPicked(null)}
              className="text-xs text-gray-400 hover:text-gray-700">
              Выбрать другого
            </button>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Тариф</label>
            <select
              value={tariffId}
              onChange={e => setTariffId(e.target.value)}
              className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-brand focus:outline-none"
            >
              <option value="">Без тарифа — открыто всё</option>
              {tariffs.map(t => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-400">
              Тариф решает, какие материалы человек увидит.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Срок доступа
            </label>
            <label className="mb-2 flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={unlimited}
                     onChange={e => setUnlimited(e.target.checked)} />
              Бессрочно
            </label>
            {!unlimited && (
              <input type="date" value={until} onChange={e => setUntil(e.target.value)}
                className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-brand focus:outline-none" />
            )}
            <p className="mt-1 text-xs text-gray-400">
              За 3 дня до окончания человеку уйдёт письмо. После даты материалы
              закроются, а запись останется в списке.
            </p>
          </div>
        </>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={grant}
          disabled={!picked || saving}
          className="btn-gold px-4 py-2 text-sm disabled:opacity-40"
        >
          {saving ? 'Открываем…' : 'Открыть доступ'}
        </button>
        <button onClick={onClose}
          className="rounded-xl px-4 py-2 text-sm text-gray-500 hover:bg-gray-100">
          Отмена
        </button>
      </div>
    </div>
  )
}

/* ─────────────────────────────── Клиенты ────────────────────────────────── */

/** Дата без времени: в таблице секунды только шумят. */
function fmtDate(v?: string | null): string {
  if (!v) return '—'
  return new Date(v).toLocaleDateString('ru-RU',
    { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' })
}

function fmtDateTime(v?: string | null): string {
  if (!v) return '—'
  return new Date(v).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
}

// ⚠️ Подписи статуса — в ОДНОМ месте: те же слова в таблице, в фильтре и в
// истории. Разные формулировки в трёх местах читались бы как разные состояния.
//
// ⚠️ ЗАКРЫТЫЙ — КРАСНЫМ, а не серым (решение владельца 07.09.2026). Серый
// читается как «неважно, архив», а это как раз то, что нужно заметить: человек
// материалы больше не видит.
const ACCESS_STATUS: Record<string, { label: string; cls: string }> = {
  active:  { label: 'Открыт',   cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  expired: { label: 'Истёк',    cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  revoked: { label: 'Закрыт',   cls: 'bg-red-50 text-red-700 border-red-200' },
}

/** Мессенджеры человека строкой: `@ник` либо площадка с числовым id. */
function messengerLine(identities: any[]): string {
  const NAMES: Record<string, string> = { telegram: 'TG', vk: 'VK', max: 'MAX' }
  return (identities || [])
    .map(i => {
      const who = i.username ? `@${i.username}` : String(i.user_id || '').replace(/^@/, '')
      return who ? `${NAMES[i.platform] || i.platform}: ${who}` : ''
    })
    .filter(Boolean)
    .join(' · ')
}

function StatusChip({ status }: { status: string }) {
  const s = ACCESS_STATUS[status] || ACCESS_STATUS.active
  return (
    <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${s.cls}`}>
      {s.label}
    </span>
  )
}

/**
 * Вкладка «Клиенты» — таблица выданных доступов.
 *
 * ⚠️⚠️ Доступ здесь НЕ УДАЛЯЕТСЯ (07.09.2026): «Закрыть» ставит статус, строка
 * остаётся навсегда. Раньше кнопка удаляла запись — и вопрос «у кого доступ был
 * и когда кончился» оставался без ответа: человек исчезал вместе с фактом
 * покупки.
 *
 * ⚠️ Таблица, а не карточки: клиент сравнивает людей между собой по сроку и
 * тарифу, а в карточках такое сравнение делается только глазами по всей ленте.
 */
function BuyersTab({ productId, readOnly }: { productId: number; readOnly: boolean }) {
  const [buyers, setBuyers] = useState<any[]>([])
  const [tariffs, setTariffs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [historyOf, setHistoryOf] = useState<any>(null)
  const [busy, setBusy] = useState<number | null>(null)

  const [fStatus, setFStatus] = useState<string>('all')
  const [fTariff, setFTariff] = useState<string>('all')
  const [q, setQ] = useState('')

  const load = async () => {
    try {
      const [b, t] = await Promise.all([
        api.products.buyers(productId),
        api.products.tariffs(productId),
      ])
      setBuyers(b.buyers || [])
      setTariffs(t.tariffs || [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [productId])

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  const rows = buyers.filter(b => {
    if (fStatus !== 'all' && b.status !== fStatus) return false
    if (fTariff !== 'all') {
      if (fTariff === 'none' ? b.tariff_id : String(b.tariff_id) !== fTariff) return false
    }
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      const hay = [b.name, b.email, b.phone].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(s)) return false
    }
    return true
  })

  const counts = {
    all: buyers.length,
    active: buyers.filter(b => b.status === 'active').length,
    expired: buyers.filter(b => b.status === 'expired').length,
    revoked: buyers.filter(b => b.status === 'revoked').length,
  }

  const resend = async (b: any) => {
    setBusy(b.id)
    try {
      const r: any = await api.products.resendAccess(productId, b.id)
      const where = [r?.email && 'на почту', r?.bot && 'в бот'].filter(Boolean).join(' и ')
      alert(where ? `Отправили ${where}.`
                  : 'Отправить не получилось: нет почты и бота у этого человека.')
      load()
    } catch (e: any) {
      alert(e?.message || 'Не получилось отправить')
    } finally { setBusy(null) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold text-gray-900">Клиенты — {buyers.length}</h3>
        {!readOnly && !adding && (
          <button onClick={() => setAdding(true)} className="btn-gold px-4 py-2 text-sm">
            + Открыть доступ
          </button>
        )}
      </div>

      {adding && (
        <GrantAccessForm
          productId={productId}
          tariffs={tariffs}
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); load() }}
        />
      )}

      {/* Фильтры: по статусу доступа и по тарифу. */}
      <div className="flex flex-wrap items-center gap-2">
        {([
          ['all', `Все · ${counts.all}`],
          ['active', `Открыт · ${counts.active}`],
          ['expired', `Истёк · ${counts.expired}`],
          ['revoked', `Закрыт · ${counts.revoked}`],
        ] as const).map(([k, label]) => (
          <button key={k} onClick={() => setFStatus(k)}
            className={`rounded-full border px-3 py-1.5 text-xs transition ${
              fStatus === k
                ? 'border-[#25455D] bg-[#25455D] text-white'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}>
            {label}
          </button>
        ))}

        <span className="mx-1 h-5 w-px bg-gray-200" />

        <select value={fTariff} onChange={e => setFTariff(e.target.value)}
          className="rounded-full border border-gray-200 px-3 py-1.5 text-xs text-gray-700 focus:border-brand focus:outline-none">
          <option value="all">Все тарифы</option>
          {tariffs.map(t => <option key={t.id} value={String(t.id)}>{t.title}</option>)}
          <option value="none">Без тарифа</option>
        </select>

        <input value={q} onChange={e => setQ(e.target.value)}
          placeholder="Имя, почта, телефон"
          className="min-w-[180px] flex-1 rounded-full border border-gray-200 px-3 py-1.5 text-xs focus:border-brand focus:outline-none" />
      </div>

      {!rows.length ? (
        <p className="text-sm text-gray-400">
          {buyers.length ? 'Под фильтры никто не подошёл.' : 'Пока никого.'}
        </p>
      ) : (
        // ⚠️ Таблица прокручивается внутри своего контейнера: страница кабинета
        // не должна ехать вбок на узком экране.
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-3 py-2.5 font-medium">Человек</th>
                <th className="px-3 py-2.5 font-medium">Открыт</th>
                <th className="px-3 py-2.5 font-medium">До</th>
                <th className="px-3 py-2.5 font-medium">Статус</th>
                <th className="px-3 py-2.5 font-medium">Контакты</th>
                <th className="px-3 py-2.5 font-medium">Тариф</th>
                <th className="px-3 py-2.5 font-medium">Откуда</th>
                <th className="px-3 py-2.5 font-medium">Заходил</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map(b => (
                <tr key={b.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-gray-900">{b.name || 'Без имени'}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">
                    {fmtDate(b.granted_at)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-gray-600">
                    {/* ⚠️ Бессрочный — знаком ∞, а не пустой клеткой: пустота
                        читается как «забыли заполнить». */}
                    {b.expires_at ? fmtDate(b.expires_at)
                      : <span title="Бессрочно" className="text-gray-400">∞</span>}
                  </td>
                  <td className="px-3 py-2.5"><StatusChip status={b.status} /></td>
                  <td className="px-3 py-2.5 text-xs text-gray-500">
                    <div className="truncate max-w-[210px]">{b.email || '—'}</div>
                    {b.phone && <div className="text-gray-400">{b.phone}</div>}
                    {/* Мессенджеры здесь же: писать человеку удобнее оттуда,
                        где он есть, а лезть за этим в карточку контакта долго. */}
                    {!!(b.identities || []).length && (
                      <div className="truncate max-w-[210px] text-gray-400">
                        {messengerLine(b.identities)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-gray-700">{b.tariff_title || '—'}</td>
                  <td className="px-3 py-2.5 text-xs text-gray-500">
                    {b.source === 'manual'
                      ? 'выдан вручную'
                      : (b.amount ? `оплатил ${Number(b.amount).toLocaleString('ru-RU')} ₽`
                                  : 'по заказу')}
                  </td>
                  {/* ⚠️ Заходил — зелёным, не заходил — красным: по этой
                      колонке решают, кого дожимать, и бледно-серое «не
                      заходил» глазом не цеплялось вовсе. */}
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                    {b.last_login_at
                      ? <span className="text-emerald-600">{fmtDateTime(b.last_login_at)}</span>
                      : <span className="font-medium text-red-600">не заходил</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                    <button onClick={() => setHistoryOf(b)}
                      className="mr-2 text-xs text-gray-500 underline-offset-2 hover:text-[#25455D] hover:underline">
                      История
                    </button>
                    {!readOnly && (
                      <>
                        <button onClick={() => resend(b)} disabled={busy === b.id}
                          className="mr-2 text-xs text-gray-500 underline-offset-2 hover:text-[#25455D] hover:underline disabled:opacity-40"
                          title="Отправить письмо о доступе повторно">
                          {busy === b.id ? '…' : 'Письмо'}
                        </button>
                        <button onClick={() => setEditing(b)}
                          className="mr-2 text-xs text-gray-500 underline-offset-2 hover:text-[#25455D] hover:underline">
                          Изменить
                        </button>
                        {b.status !== 'revoked' && (
                          <button
                            onClick={async () => {
                              if (!confirm(
                                `Закрыть доступ «${b.name || 'без имени'}»?\n\n` +
                                'Человек перестанет видеть материалы. Запись останется ' +
                                'в списке — вы увидите, что доступ был.')) return
                              await api.products.revokeAccess(productId, b.id)
                              load()
                            }}
                            className="text-xs text-gray-400 hover:text-red-600">
                            Закрыть
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EditAccessModal
          productId={productId} access={editing} tariffs={tariffs}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); load() }}
        />
      )}
      {historyOf && (
        <AccessHistoryModal
          productId={productId} access={historyOf}
          onClose={() => setHistoryOf(null)}
        />
      )}
    </div>
  )
}

/**
 * Правка выданного доступа: тариф, срок, заметка.
 *
 * ⚠️ Нужна ровно потому, что доступ живёт долго: человек доплатил за старший
 * тариф или попросил продлить. Без правки единственный путь — закрыть и выдать
 * заново, то есть испортить историю ради смены даты.
 */
function EditAccessModal({
  productId, access, tariffs, onClose, onDone,
}: {
  productId: number; access: any; tariffs: any[]
  onClose: () => void; onDone: () => void
}) {
  const [tariffId, setTariffId] = useState<string>(
    access.tariff_id ? String(access.tariff_id) : '')
  const [unlimited, setUnlimited] = useState(!access.expires_at)
  const [until, setUntil] = useState<string>(
    access.expires_at ? String(access.expires_at).slice(0, 10) : '')
  const [note, setNote] = useState(access.note || '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!unlimited && !until) { alert('Укажите дату или отметьте «бессрочно»'); return }
    setSaving(true)
    try {
      await api.products.updateAccess(productId, access.id, {
        tariff_id: tariffId ? Number(tariffId) : null,
        note: note.trim() || null,
        ...(unlimited
          ? { unlimited: true }
          // ⚠️ Конец дня, а не полночь: «до 12.11» человек понимает как «весь
          // день 12-го», и доступ, пропавший утром, читается как обман.
          : { expires_at: `${until}T23:59:59` }),
      })
      onDone()
    } catch (e: any) {
      alert(e?.message || 'Не получилось сохранить')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      {/* ⚠️ Клик по фону НЕ закрывает — правило проекта для форм. */}
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
           onClick={e => e.stopPropagation()}>
        <h3 className="mb-1 font-semibold text-gray-900">
          {access.name || 'Без имени'}
        </h3>
        <p className="mb-4 text-xs text-gray-400">
          Доступ открыт {fmtDate(access.granted_at)}
        </p>

        <label className="mb-1 block text-sm font-medium text-gray-700">Тариф</label>
        <select value={tariffId} onChange={e => setTariffId(e.target.value)}
          className="mb-4 w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-brand focus:outline-none">
          <option value="">Без тарифа — открыто всё</option>
          {tariffs.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>

        <label className="mb-1 block text-sm font-medium text-gray-700">Срок доступа</label>
        <label className="mb-2 flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={unlimited}
                 onChange={e => setUnlimited(e.target.checked)} />
          Бессрочно
        </label>
        {!unlimited && (
          <input type="date" value={until} onChange={e => setUntil(e.target.value)}
            className="mb-1 w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-brand focus:outline-none" />
        )}
        <p className="mb-4 text-xs text-gray-400">
          За 3 дня до окончания человеку уйдёт письмо. После даты материалы
          закроются, а запись останется в списке.
        </p>

        <label className="mb-1 block text-sm font-medium text-gray-700">Заметка</label>
        <input value={note} onChange={e => setNote(e.target.value)}
          placeholder="Для себя: бартер, промо, продление"
          className="mb-4 w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-brand focus:outline-none" />

        <div className="flex gap-2">
          <button onClick={save} disabled={saving}
            className="btn-gold px-4 py-2 text-sm disabled:opacity-40">
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button onClick={onClose}
            className="rounded-xl px-4 py-2 text-sm text-gray-500 hover:bg-gray-100">
            Отмена
          </button>
        </div>
      </div>
    </div>
  )
}

/** Подписи событий доступа — понятными словами, а не служебными ключами. */
const EVENT_LABEL: Record<string, string> = {
  granted: 'Доступ открыт',
  restored: 'Доступ открыт заново',
  extended: 'Доступ изменён',
  revoked: 'Доступ закрыт',
  expired: 'Срок истёк',
  email_sent: 'Отправлено письмо',
}

const VISIT_LABEL: Record<string, string> = {
  login: 'Зашёл в кабинет',
  code_requested: 'Запросил код входа',
  product: 'Открыл продукт',
  material: 'Открыл материал',
}

/**
 * История по одному человеку: события доступа + заходы в кабинет + материалы.
 *
 * ⚠️ Две ленты сведены в ОДНУ по времени: клиент задаёт вопрос «что вообще было
 * с этим человеком», а не «покажи отдельно заходы». Две колонки рядом пришлось
 * бы сопоставлять глазами по датам.
 */
function AccessHistoryModal({
  productId, access, onClose,
}: { productId: number; access: any; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      try { setData(await api.products.accessHistory(productId, access.id)) }
      finally { setLoading(false) }
    })()
  }, [productId, access.id])

  const items = [
    ...(data?.events || []).map((e: any) => ({
      at: e.created_at,
      title: EVENT_LABEL[e.kind] || e.kind,
      detail: e.detail,
      kind: 'event' as const,
    })),
    ...(data?.visits || []).map((v: any) => ({
      at: v.created_at,
      title: VISIT_LABEL[v.kind] || v.kind,
      detail: v.title,
      kind: 'visit' as const,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1))

  const logins = (data?.visits || []).filter((v: any) => v.kind === 'login').length
  const opened = (data?.visits || []).filter((v: any) => v.kind === 'material').length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl"
           onClick={e => e.stopPropagation()}>
        <div className="border-b border-gray-100 p-5">
          <h3 className="font-semibold text-gray-900">{access.name || 'Без имени'}</h3>
          <p className="mt-0.5 text-xs text-gray-400">
            {[access.email, access.phone].filter(Boolean).join(' · ') || 'без контактов'}
          </p>
          {!loading && (
            <p className="mt-2 text-xs text-gray-500">
              Заходов в кабинет: <b>{logins}</b> · открыто материалов: <b>{opened}</b>
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 scroll-visible">
          {loading ? (
            <p className="text-sm text-gray-400">Загружаем…</p>
          ) : !items.length ? (
            <p className="text-sm text-gray-400">
              Пока пусто. Заходы записываются с момента появления этой страницы —
              за прошлое данных нет.
            </p>
          ) : (
            <div className="space-y-2.5">
              {items.map((it, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <div className="w-28 shrink-0 text-xs text-gray-400">
                    {fmtDateTime(it.at)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={it.kind === 'event' ? 'text-gray-900' : 'text-gray-700'}>
                      {it.title}
                    </div>
                    {it.detail && (
                      <div className="truncate text-xs text-gray-400">{it.detail}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-gray-100 p-4">
          <button onClick={onClose}
            className="rounded-xl px-4 py-2 text-sm text-gray-500 hover:bg-gray-100">
            Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────── Заказы ─────────────────────────────────── */

const ORDER_STATUS: Record<string, { label: string; cls: string }> = {
  paid:      { label: 'Оплачен',    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  unpaid:    { label: 'Не оплачен', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  cancelled: { label: 'Отменён',    cls: 'bg-gray-100 text-gray-500 border-gray-200' },
}

/**
 * Вкладка «Заказы» — кто сколько заплатил и от какого партнёра пришёл.
 *
 * ⚠️ Отдельной вкладкой, а не блоком внутри «Клиентов»: заказ и доступ — разные
 * сущности (заказ может навсегда остаться неоплаченным, а доступ выдаётся и
 * без заказа). Смешивать их в одном списке — значит запутать оба.
 *
 * ⚠️ Эндпоинт `/orders` был написан давно и фронтом НЕ использовался: у событий
 * заказы видно, у продуктов — нет, хотя данные лежали.
 */
function OrdersTab({ productId }: { productId: number }) {
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [fStatus, setFStatus] = useState('all')
  const [q, setQ] = useState('')

  useEffect(() => {
    (async () => {
      try {
        const r = await api.products.orders(productId)
        setOrders(r.orders || [])
      } finally { setLoading(false) }
    })()
  }, [productId])

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  const rows = orders.filter(o => {
    if (fStatus !== 'all' && o.status !== fStatus) return false
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      const hay = [o.contact_name, o.email, o.tariff_title, o.referrer_ref_code]
        .filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(s)) return false
    }
    return true
  })

  const paidSum = orders
    .filter(o => o.status === 'paid')
    .reduce((s, o) => s + Number(o.amount || 0), 0)

  // ⚠️ CSV с `;` и BOM — иначе Excel открывает файл одной колонкой и с
  // кракозябрами вместо русских букв (так же сделана выгрузка контактов).
  const exportCsv = () => {
    const head = ['Имя', 'Почта', 'Тариф', 'Сумма', 'Статус', 'Партнёр',
                  'Заказан', 'Оплачен', 'Заметка']
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [head.map(esc).join(';')]
    for (const o of rows) {
      lines.push([
        o.contact_name || '', o.email || '', o.tariff_title || '',
        o.amount ?? '', ORDER_STATUS[o.status]?.label || o.status,
        o.referrer_ref_code || '', fmtDate(o.ordered_at), fmtDate(o.paid_at),
        o.note || '',
      ].map(esc).join(';'))
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')],
                          { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `zakazy-produkta-${productId}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const counts = {
    all: orders.length,
    paid: orders.filter(o => o.status === 'paid').length,
    unpaid: orders.filter(o => o.status === 'unpaid').length,
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-900">Заказы — {orders.length}</h3>
          <p className="text-xs text-gray-500">
            Оплачено на {paidSum.toLocaleString('ru-RU')} ₽
          </p>
        </div>
        {orders.length > 0 && (
          <button onClick={exportCsv}
            className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:border-gray-300">
            Экспорт CSV
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {([
          ['all', `Все · ${counts.all}`],
          ['paid', `Оплачены · ${counts.paid}`],
          ['unpaid', `Не оплачены · ${counts.unpaid}`],
        ] as const).map(([k, label]) => (
          <button key={k} onClick={() => setFStatus(k)}
            className={`rounded-full border px-3 py-1.5 text-xs transition ${
              fStatus === k
                ? 'border-[#25455D] bg-[#25455D] text-white'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}>
            {label}
          </button>
        ))}
        <input value={q} onChange={e => setQ(e.target.value)}
          placeholder="Имя, почта, тариф, партнёр"
          className="min-w-[180px] flex-1 rounded-full border border-gray-200 px-3 py-1.5 text-xs focus:border-brand focus:outline-none" />
      </div>

      {!rows.length ? (
        <p className="text-sm text-gray-400">
          {orders.length ? 'Под фильтры ничего не подошло.' : 'Заказов пока нет.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-3 py-2.5 font-medium">Человек</th>
                <th className="px-3 py-2.5 font-medium">Контакт</th>
                <th className="px-3 py-2.5 font-medium">Тариф</th>
                <th className="px-3 py-2.5 font-medium">Сумма</th>
                <th className="px-3 py-2.5 font-medium">Статус</th>
                <th className="px-3 py-2.5 font-medium">Партнёр</th>
                <th className="px-3 py-2.5 font-medium">Дата</th>
                <th className="px-3 py-2.5 font-medium">Заметка</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(o => {
                const s = ORDER_STATUS[o.status] || ORDER_STATUS.unpaid
                return (
                  <tr key={o.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60">
                    <td className="px-3 py-2.5 font-medium text-gray-900">
                      {o.contact_name || 'Без имени'}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-500">
                      <div className="max-w-[190px] truncate">{o.email || '—'}</div>
                    </td>
                    <td className="px-3 py-2.5 text-gray-700">{o.tariff_title}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-gray-900">
                      {o.amount ? `${Number(o.amount).toLocaleString('ru-RU')} ₽` : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${s.cls}`}>
                        {s.label}
                      </span>
                    </td>
                    {/* ⚠️ Реф-код, а не имя: партнёрское имя резолвится не всегда,
                        а код всегда однозначен и по нему клиент узнаёт партнёра. */}
                    <td className="px-3 py-2.5 text-xs text-gray-500">
                      {o.referrer_ref_code || <span className="text-gray-300">сам</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-gray-500">
                      {fmtDate(o.paid_at || o.ordered_at)}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-500">
                      <div className="max-w-[160px] truncate">{o.note || '—'}</div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
