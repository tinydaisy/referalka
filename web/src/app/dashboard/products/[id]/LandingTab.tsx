'use client'

/**
 * Вкладка «Лендинг» продукта (миграция 293).
 *
 * Тот же конструктор, что у события: карточки блоков (`BlockCard`), справочник
 * (`blockMeta`) и настройки оформления (`StyleControls`) переиспользованы —
 * второй вёрстки нет, чинить в одном месте.
 *
 * Отличия от события — только они и оправдывают отдельный файл:
 *  • свой набор блоков (без программы, спикеров, мест и подарков — это данные
 *    события; вместо них «Что входит», читающий состав продукта);
 *  • картинки грузятся как `product_media`: у продукта нет event_id, и
 *    `landing_media` упал бы с «требует event_id»;
 *  • нет копирования лендинга из другого события и настройки мест.
 *
 * Сохранение — с задержкой, накопительно: не дёргаем сервер на каждую букву.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, Plus, Loader2, ExternalLink } from 'lucide-react'
import PreviewLinkButton from '@/components/PreviewLinkButton'
import LandingPdfButton from '@/components/LandingPdfButton'
import CopyLinkButton from '@/components/CopyLinkButton'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import BlockCard from '@/components/landing/BlockCard'
import { REPEATABLE, PRODUCT_STANDARD, metaFor } from '@/components/landing/blockMeta'
import {
  ColorField, MetallicToggle, FontSelect, BackgroundFields,
} from '@/components/landing/StyleControls'

type PageKind = 'main' | 'post_pay'

interface Props {
  productId: number
  product: any
  readOnly?: boolean
}

export default function ProductLandingTab({ productId, product, readOnly = false }: Props) {
  // ⚠️ Хук до early-return. Домен клиента, а не наш: эту ссылку он отдаёт
  // своей аудитории.
  const { publicHost } = useMe()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pages, setPages] = useState<Record<string, any>>({})
  const [kind, setKind] = useState<PageKind>('main')
  const [dragId, setDragId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [tariffs, setTariffs] = useState<any[]>([])
  const [surveys, setSurveys] = useState<any[]>([])
  const [fonts, setFonts] = useState<any[]>([])
  const [showStyle, setShowStyle] = useState(false)

  const timers = useRef<Record<string, any>>({})
  const pendingPage = useRef<Record<number, any>>({})
  const pendingBlock = useRef<Record<number, any>>({})

  const load = async () => {
    try {
      setLoading(true)
      const res = await api.productLanding.get(productId)
      setPages(res.pages || {})
      setFonts(res.fonts || [])
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить лендинг')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [productId])

  // Тарифы нужны блоку «Тарифы» (какой выделить). Молча: раздел может быть пуст.
  useEffect(() => {
    api.products.tariffs(productId)
      .then((r: any) => setTariffs(r.tariffs || []))
      .catch(() => {})
  }, [productId])

  // Анкеты — для блока «Анкета / Заявка». Молча: на тарифе без фичи `surveys`
  // запрос отдаст 403, и блок всё равно закрыт замком.
  // ⚠️ `GET /surveys` отдаёт ГОЛЫЙ МАССИВ, не объект со списком.
  useEffect(() => {
    api.surveys.list()
      .then((r: any) => setSurveys(Array.isArray(r) ? r : []))
      .catch(() => {})
  }, [])

  const current = pages[kind]
  const page = current?.page
  const blocks: any[] = current?.blocks || []

  // Что предлагать в «Добавить секцию» — ДВУМЯ группами, как у события.
  //
  // ⚠️ Автозаполняемые (состав продукта, тарифы, организатор…) тянут данные
  // сами и бывают по одной. Показываем их отдельной группой и ЦЕЛИКОМ:
  // добавленная — неактивной, удалённая — снова доступной. Раньше добавленная
  // просто исчезала из списка, и было не понять, секции нет или она уже стоит.
  const { extraKinds, autoKinds } = useMemo(() => {
    const present = new Set(blocks.map(b => b.kind))
    const auto = PRODUCT_STANDARD.filter(k => metaFor(k, 'product').live)
    const extra = [
      ...REPEATABLE,
      ...PRODUCT_STANDARD.filter(k => !metaFor(k, 'product').live && !present.has(k)),
    ]
    return {
      extraKinds: extra,
      autoKinds: auto.map(k => ({ kind: k, used: present.has(k) })),
    }
  }, [blocks])

  /* ── правки страницы ──────────────────────────────────────────────────── */

  const patchPage = (patch: any) => {
    if (!page || readOnly) return
    const pageId = page.id
    setPages(prev => ({
      ...prev,
      [kind]: { ...prev[kind], page: { ...prev[kind].page, ...patch } },
    }))
    // ⚠️ Копим правки: при быстром вводе в setTimeout уходил бы только
    // последний patch, и предыдущие буквы терялись.
    pendingPage.current[pageId] = { ...(pendingPage.current[pageId] || {}), ...patch }
    clearTimeout(timers.current[`p${pageId}`])
    timers.current[`p${pageId}`] = setTimeout(async () => {
      const body = pendingPage.current[pageId]
      pendingPage.current[pageId] = {}
      if (!body || !Object.keys(body).length) return
      setSaving(true)
      try { await api.productLanding.patchPage(productId, pageId, body) }
      catch { /* следующая правка отправит заново */ }
      finally { setSaving(false) }
    }, 600)
  }

  /* ── правки блока ─────────────────────────────────────────────────────── */

  /* ⚠️ Досохранение накопленного. Правки уходят на сервер с задержкой 600 мс
     (чтобы не слать запрос на каждую букву). Если за это время уйти со
     страницы, переключить вкладку или закрыть браузер — правка ПРОПАДАЛА
     молча: человек видел её на экране, а в базу она не доезжала. Клиент
     дважды вносил одни и те же карточки заново. */
  const flushPending = useCallback(() => {
    const entries = Object.entries(pendingBlock.current)
    for (const [id, body] of entries) {
      if (!body || !Object.keys(body).length) continue
      pendingBlock.current[Number(id)] = {}
      clearTimeout(timers.current[`b${id}`])
      // keepalive — чтобы запрос дожил до конца, даже если вкладку закрывают.
      api.productLanding.patchBlock(productId, Number(id), body).catch(() => {})
    }
  }, [productId])

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushPending() }
    window.addEventListener('beforeunload', flushPending)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('beforeunload', flushPending)
      document.removeEventListener('visibilitychange', onHide)
      flushPending()   // уход со вкладки «Лендинг» — тоже досохраняем
    }
  }, [flushPending])

  const patchBlock = (blockId: number, patch: any) => {
    if (readOnly) return
    setPages(prev => ({
      ...prev,
      [kind]: {
        ...prev[kind],
        blocks: prev[kind].blocks.map((b: any) =>
          b.id === blockId ? { ...b, ...patch } : b),
      },
    }))
    pendingBlock.current[blockId] = { ...(pendingBlock.current[blockId] || {}), ...patch }
    clearTimeout(timers.current[`b${blockId}`])
    timers.current[`b${blockId}`] = setTimeout(async () => {
      const body = pendingBlock.current[blockId]
      pendingBlock.current[blockId] = {}
      if (!body || !Object.keys(body).length) return
      setSaving(true)
      try { await api.productLanding.patchBlock(productId, blockId, body) }
      catch { /* следующая правка отправит заново */ }
      finally { setSaving(false) }
    }, 600)
  }

  const removeBlock = async (blockId: number) => {
    if (readOnly) return
    if (!confirm('Убрать секцию со страницы?')) return
    setPages(prev => ({
      ...prev,
      [kind]: { ...prev[kind], blocks: prev[kind].blocks.filter((b: any) => b.id !== blockId) },
    }))
    try { await api.productLanding.removeBlock(productId, blockId) } catch { load() }
  }

  const addBlock = async (blockKind: string) => {
    if (!page || readOnly) return
    try {
      const created = await api.productLanding.createBlock(productId, page.id, { kind: blockKind })
      setPages(prev => ({
        ...prev,
        [kind]: { ...prev[kind], blocks: [...prev[kind].blocks, created] },
      }))
    } catch (e: any) {
      alert(e?.message || 'Не удалось добавить секцию')
    }
  }

  /* ── перетаскивание ───────────────────────────────────────────────────── */

  const onDrop = async (targetId: number) => {
    if (dragId == null || dragId === targetId || !page || readOnly) return
    const list = [...blocks]
    const from = list.findIndex(b => b.id === dragId)
    const to = list.findIndex(b => b.id === targetId)
    if (from < 0 || to < 0) return
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    setPages(prev => ({ ...prev, [kind]: { ...prev[kind], blocks: list } }))
    setDragId(null)
    try { await api.productLanding.reorder(productId, page.id, list.map(b => b.id)) }
    catch { load() }
  }

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>
  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!page) return <p className="text-sm text-gray-400">Страница не найдена</p>

  const url = `https://${publicHost}/pr/${product.slug}`

  return (
    <div className="max-w-3xl">
      {/* Адрес и публикация */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-gray-600">Страница:</span>
          <a href={url} target="_blank" rel="noreferrer"
             className="inline-flex min-w-0 items-center gap-1 break-all text-sm text-[#25455D] underline">
            {url} <ExternalLink size={13} className="shrink-0" />
          </a>
          <CopyLinkButton url={url} />
          {saving && <Loader2 size={14} className="animate-spin text-gray-400" />}
        </div>
        {/* ⚠️ Пока лендинг не опубликован, по обычной ссылке открывается витрина,
            а собранную страницу посмотреть было НЕЧЕМ — настраивать её
            приходилось вслепую. Кнопка открывает её по временной ссылке. */}
        {/* ⚠️ Кнопка PDF — и у черновика, и у опубликованной: файл нужен тем,
            у кого ссылка не открывается (сеть режет домен, встроенный браузер
            мессенджера падает, нет интернета). Собирается в мобильной вёрстке. */}
        {/* ⚠️ items-start: у кнопки PDF во время сборки появляется подпись —
            при центрировании она сдвигала бы соседнюю кнопку. */}
        <div className="mt-3 flex flex-wrap items-start gap-2">
          {!page.is_published && (
            <PreviewLinkButton url={url} label="Посмотреть, как получилось" />
          )}
          <LandingPdfButton
            onDownload={() => api.productLanding.pdf(
              productId, page.id, `${product?.title || 'Лендинг'}.pdf`,
            )}
            className="px-3 py-1.5 text-xs"
          />
        </div>
        {!readOnly && (
          <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={!!page.is_published}
              onChange={e => patchPage({ is_published: e.target.checked })}
            />
            Опубликовать страницу
            <span className="text-xs text-gray-400">
              — пока выключено, по адресу открывается простая витрина
            </span>
          </label>
        )}
      </div>

      {/* Основная / после оплаты */}
      <div className="mb-4 flex gap-2">
        {([['main', 'Основная'], ['post_pay', 'После оплаты']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded-lg border px-3 py-1.5 text-sm ${
              kind === k
                ? 'border-[#25455D] bg-[#25455D] text-white'
                : 'border-gray-300 text-gray-600 hover:border-gray-400'
            }`}
          >
            {label}
          </button>
        ))}
        {!readOnly && (
          <button
            onClick={() => setShowStyle(s => !s)}
            className="ml-auto rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:border-gray-400"
          >
            {showStyle ? 'Скрыть оформление' : 'Оформление'}
          </button>
        )}
      </div>

      {/* Оформление страницы */}
      {showStyle && !readOnly && (
        <div className="mb-4 space-y-4 rounded-xl border border-gray-200 bg-white p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FontSelect
              label="Шрифт заголовков" value={page.font_heading} fonts={fonts}
              onChange={(v: string) => patchPage({ font_heading: v })}
            />
            <FontSelect
              label="Шрифт текста" value={page.font_body} fonts={fonts}
              onChange={(v: string) => patchPage({ font_body: v })}
            />
            <ColorField
              label="Цвет заголовков" value={page.color_heading}
              onChange={(v: string) => patchPage({ color_heading: v })}
            />
            <ColorField
              label="Цвет текста" value={page.color_body}
              onChange={(v: string) => patchPage({ color_body: v })}
            />
            <ColorField
              label="Цвет кнопок" value={page.btn_color}
              onChange={(v: string) => patchPage({ btn_color: v })}
            />
            <ColorField
              label="Текст на кнопке" value={page.btn_text_color}
              onChange={(v: string) => patchPage({ btn_text_color: v })}
            />
          </div>

          <MetallicToggle
            label="Металлический перелив у заголовков"
            checked={!!page.heading_metallic}
            onChange={(v: boolean) => patchPage({ heading_metallic: v })}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <ColorField
              label="Фон страницы" value={page.bg_color}
              onChange={(v: string) => patchPage({ bg_color: v })}
            />
            <ColorField
              label="Второй цвет фона" value={page.bg_color_2}
              onChange={(v: string) => patchPage({ bg_color_2: v })}
            />
          </div>

          {/* ⚠️ uploadKind=product_media: у продукта нет event_id, обычный
              landing_bg упал бы с «требует event_id». */}
          <BackgroundFields
            uploadKind="product_media"
            imageUrl={page.bg_image_url}
            overlay={page.bg_overlay}
            opacity={page.bg_overlay_opacity}
            bgColor={page.bg_color}
            onImage={(v: string | null) => patchPage({ bg_image_url: v })}
            onOverlay={(v: string | null) => patchPage({ bg_overlay: v })}
            onOpacity={(v: number) => patchPage({ bg_overlay_opacity: v })}
            onBgColor={(v: string) => patchPage({ bg_color: v })}
          />
        </div>
      )}

      {/* Блоки */}
      <div className="space-y-2">
        {blocks.map(b => (
          <BlockCard
            key={b.id}
            block={b}
            uploadKind="product_media"
            onPatch={(patch: any) => patchBlock(b.id, patch)}
            onRemove={() => removeBlock(b.id)}
            onDragStart={() => setDragId(b.id)}
            onDragOver={(e: any) => e.preventDefault()}
            onDrop={() => onDrop(b.id)}
            isDragging={dragId === b.id}
            pageBlocks={blocks}
            tariffs={tariffs}
            offers={[]}
            surveys={surveys}
          />
        ))}
      </div>

      {/* Добавить секцию — двумя группами, как у события */}
      {!readOnly && (
        <div className="mt-4 rounded-xl border border-dashed border-gray-300 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700">
            <Plus size={15} /> Дополнительные секции
          </div>
          <div className="flex flex-wrap gap-2">
            {extraKinds.map(k => (
              <button
                key={k}
                onClick={() => addBlock(k)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:border-gray-400"
                title={metaFor(k, 'product').hint}
              >
                {metaFor(k, 'product').label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Свои тексты, картинки и кнопки. «Текст», «Галерея» и элементы можно
            добавлять сколько угодно раз.
          </p>

          <div className="mb-2 mt-5 text-sm font-medium text-gray-700">
            Автозаполняемые секции
          </div>
          <div className="flex flex-wrap gap-2">
            {autoKinds.map(({ kind: k, used }) => (
              <button
                key={k}
                onClick={() => !used && addBlock(k)}
                disabled={used}
                title={used
                  ? 'Уже на странице — такая секция может быть только одна. Удалите её выше, чтобы добавить заново.'
                  : metaFor(k, 'product').hint}
                className={`rounded-lg border px-3 py-1.5 text-sm ${
                  used
                    ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
                    : 'border-gray-300 text-gray-600 hover:border-gray-400'
                }`}
              >
                {metaFor(k, 'product').label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Содержимое берётся из продукта само. Каждая — по одной на страницу:
            добавленные показаны серым, удалите секцию выше — снова станет доступной.
          </p>
        </div>
      )}
    </div>
  )
}
