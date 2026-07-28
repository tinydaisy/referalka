'use client'

/**
 * Вкладка «Лендинг» — конструктор продающей страницы события (миграция 240).
 *
 * Две подстраницы: основная (pluson.ru/e/{slug}) и «после оплаты»
 * (pluson.ru/e/{slug}/thanks — её клиент ставит как return-url в платёжке).
 *
 * Блоки перетаскиваются мышью, выключаются галочкой. Живые блоки (спикеры,
 * программа, тарифы, организатор) содержимого не хранят — тянут данные события,
 * поэтому правка спикера сразу видна на лендинге.
 *
 * Сохранение — по факту правки, с задержкой (не дёргаем сервер на каждую букву).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Eye, Plus, Loader2, ExternalLink, Palette } from 'lucide-react'
import { api } from '@/lib/api'
import BlockCard from '@/components/landing/BlockCard'
import { ADDABLE, metaFor } from '@/components/landing/blockMeta'
import { ColorField, MetallicToggle, FontSelect, BackgroundFields } from '@/components/landing/StyleControls'

interface Props {
  eventId: number
  event: any
}

type PageKind = 'main' | 'post_pay'

export default function LandingTab({ eventId, event }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pages, setPages] = useState<any[]>([])
  const [fonts, setFonts] = useState<any[]>([])
  const [meta, setMeta] = useState<any>(null)
  const [kind, setKind] = useState<PageKind>('main')
  const [dragId, setDragId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [seats, setSeats] = useState<string>('')

  // Отложенное сохранение: пока клиент печатает — копим правки, шлём одним PATCH.
  const timers = useRef<Record<string, any>>({})

  const load = async () => {
    try {
      setLoading(true)
      const res = await api.eventLanding.get(eventId)
      setPages(res.pages || [])
      setFonts(res.fonts || [])
      setMeta(res.event || null)
      setSeats(res.event?.seats_total != null ? String(res.event.seats_total) : '')
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить лендинг')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [eventId])

  const page = useMemo(() => pages.find(p => p.kind === kind), [pages, kind])
  // Защита от неверных данных: если nav_items придёт не массивом, .map ниже
  // уронил бы всю вкладку (Application error).
  const navItems: any[] = Array.isArray(page?.nav_items) ? page!.nav_items : []

  /* ── правка настроек страницы ─────────────────────────────────────────── */
  // ⚠️ Накопительное сохранение. Раньше в setTimeout уходил ТОЛЬКО последний
  // patch: при быстром вводе (буква за буквой) предыдущие правки терялись, и
  // поле выглядело «не принимающим ввод». Теперь копим все правки в pending и
  // отправляем одним запросом.
  const pendingPage = useRef<Record<number, any>>({})

  const patchPage = (patch: any) => {
    if (!page) return
    const pageId = page.id
    setPages(prev => prev.map(p => p.id === pageId ? { ...p, ...patch } : p))
    pendingPage.current[pageId] = { ...(pendingPage.current[pageId] || {}), ...patch }
    const key = `page-${pageId}`
    clearTimeout(timers.current[key])
    timers.current[key] = setTimeout(async () => {
      const body = pendingPage.current[pageId]
      delete pendingPage.current[pageId]
      if (!body) return
      setSaving(true)
      try { await api.eventLanding.patchPage(eventId, pageId, body) }
      catch (e: any) { alert(e?.message || 'Не удалось сохранить') }
      finally { setSaving(false) }
    }, 600)
  }

  /* ── правка блока ─────────────────────────────────────────────────────── */
  const pendingBlock = useRef<Record<number, any>>({})

  const patchBlock = (blockId: number, patch: any) => {
    setPages(prev => prev.map(p => p.id !== page?.id ? p : {
      ...p,
      blocks: p.blocks.map((b: any) => b.id === blockId ? { ...b, ...patch } : b),
    }))
    pendingBlock.current[blockId] = { ...(pendingBlock.current[blockId] || {}), ...patch }
    const key = `block-${blockId}`
    clearTimeout(timers.current[key])
    timers.current[key] = setTimeout(async () => {
      const body = pendingBlock.current[blockId]
      delete pendingBlock.current[blockId]
      if (!body) return
      setSaving(true)
      try { await api.eventLanding.patchBlock(eventId, blockId, body) }
      catch (e: any) { alert(e?.message || 'Не удалось сохранить') }
      finally { setSaving(false) }
    }, 600)
  }

  const removeBlock = async (blockId: number) => {
    try {
      await api.eventLanding.removeBlock(eventId, blockId)
      setPages(prev => prev.map(p => p.id !== page?.id ? p : {
        ...p, blocks: p.blocks.filter((b: any) => b.id !== blockId),
      }))
    } catch (e: any) { alert(e?.message || 'Не удалось удалить') }
  }

  const addBlock = async (blockKind: string) => {
    if (!page) return
    try {
      const created = await api.eventLanding.createBlock(eventId, page.id, {
        kind: blockKind,
        title: metaFor(blockKind).label,
        items: blockKind === 'gallery'
          ? { mode: 'carousel', media: 'image', list: [] }
          : [],
      })
      setPages(prev => prev.map(p => p.id !== page.id ? p : {
        ...p, blocks: [...p.blocks, created],
      }))
    } catch (e: any) { alert(e?.message || 'Не удалось добавить секцию') }
  }

  /* ── перетаскивание ───────────────────────────────────────────────────── */
  const onDrop = async (targetId: number) => {
    if (!page || dragId == null || dragId === targetId) { setDragId(null); return }
    const list = [...page.blocks]
    const from = list.findIndex(b => b.id === dragId)
    const to = list.findIndex(b => b.id === targetId)
    if (from < 0 || to < 0) { setDragId(null); return }
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    setPages(prev => prev.map(p => p.id === page.id ? { ...p, blocks: list } : p))
    setDragId(null)
    try { await api.eventLanding.reorder(eventId, page.id, list.map(b => b.id)) }
    catch (e: any) { alert(e?.message || 'Не удалось сохранить порядок'); load() }
  }

  // Тема копируется в страницу при создании; для уже собранной страницы —
  // явная кнопка, иначе правка «Стилей лендингов» не видна на лендинге.
  const applyTheme = async () => {
    if (!page) return
    if (!confirm('Перетянуть оформление из «Стили лендингов» в эту страницу?\n\nЦвета, шрифты, отступы и ширина заменятся. Содержимое блоков не изменится.')) return
    try {
      const updated = await api.eventLanding.applyTheme(eventId, page.id)
      setPages(prev => prev.map(p => p.id === page.id ? { ...p, ...updated } : p))
    } catch (e: any) { alert(e?.message || 'Не удалось применить тему') }
  }

  const saveSeats = async () => {
    const v = seats.trim() === '' ? null : Math.max(0, parseInt(seats, 10) || 0)
    try {
      await api.eventLanding.setSeats(eventId, v)
      setMeta((m: any) => ({ ...m, seats_total: v }))
    } catch (e: any) { alert(e?.message || 'Не удалось сохранить') }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Загружаем конструктор…
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-800">
        {error}
      </div>
    )
  }

  if (!page) return null

  const publicUrl = `/e/${meta?.slug}${kind === 'post_pay' ? '/thanks' : ''}`

  return (
    <div className="space-y-5">
      {/* Подвкладки страниц */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 border-b border-gray-200">
          {([
            { key: 'main' as const, label: 'Основная страница' },
            { key: 'post_pay' as const, label: 'Страница после оплаты' },
          ]).map(t => (
            <button
              key={t.key}
              onClick={() => setKind(t.key)}
              className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                kind === t.key ? 'border-brand text-brand'
                               : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {saving && (
          <span className="flex items-center gap-1.5 text-xs text-gray-400">
            <Loader2 className="h-3 w-3 animate-spin" /> сохраняем…
          </span>
        )}
      </div>

      {/* Публикация + просмотр */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4">
        <div className="min-w-0">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={!!page.is_published}
              onChange={e => patchPage({ is_published: e.target.checked })}
              className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
            />
            <span className="font-medium text-gray-900">Страница опубликована</span>
          </label>
          <p className="mt-1 text-sm text-gray-500">
            {page.is_published
              ? <>Доступна по ссылке <span className="font-mono text-gray-700">pluson.ru{publicUrl}</span></>
              : 'Пока черновик — посторонние страницу не увидят.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={applyTheme}
            title="Взять цвета, шрифты и отступы из Настройки → Стили лендингов"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Palette className="h-4 w-4" /> Применить стили
          </button>
          <a
            href={publicUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Eye className="h-4 w-4" /> Посмотреть
            <ExternalLink className="h-3.5 w-3.5 text-gray-400" />
          </a>
        </div>
      </div>

      {/* Всего мест — только на основной странице */}
      {kind === 'main' && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Всего мест на событии
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="number" min={0}
              value={seats}
              onChange={e => setSeats(e.target.value)}
              onBlur={saveSeats}
              placeholder="без лимита"
              className="input w-40"
            />
            <span className="text-sm text-gray-500">
              Занято сейчас: <b>{meta?.seats_taken ?? 0}</b>
              {meta?.seats_total != null && (
                <> · свободно: <b>{Math.max(0, meta.seats_total - (meta.seats_taken || 0))}</b></>
              )}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Пусто — блок «Осталось мест» покажет только число записавшихся.
          </p>
        </div>
      )}

      {/* Шапка-меню */}
      {kind === 'main' && (
        <details className="rounded-xl border border-gray-200 bg-white">
          <summary className="cursor-pointer p-4 font-medium text-gray-900">
            Шапка с меню {page.nav_enabled ? '· включена' : '· выключена'}
          </summary>
          <div className="space-y-4 border-t border-gray-100 p-4">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={!!page.nav_enabled}
                onChange={e => patchPage({ nav_enabled: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
              />
              <span className="font-medium text-gray-900">
                Показывать шапку с логотипом и меню
              </span>
            </label>
            <p className="text-sm text-gray-500">
              Логотип берётся из визитки бренда (Настройки → Mini App → Бренд).
              Пункты меню прокручивают страницу к нужной секции.
            </p>

            {page.nav_enabled && (
              <>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Подпись кнопки в шапке
                  </label>
                  <input
                    type="text"
                    value={page.nav_button_label || ''}
                    onChange={e => patchPage({ nav_button_label: e.target.value })}
                    className="input"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Пусто — кнопки в шапке не будет.
                  </p>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Куда ведёт кнопка в шапке
                  </label>
                  <select
                    value={page.nav_button_target || 'register'}
                    onChange={e => patchPage({ nav_button_target: e.target.value })}
                    className="input bg-white"
                  >
                    <option value="register">На регистрацию</option>
                    {(page.blocks || []).map((b: any) => (
                      <option key={b.id} value={b.kind}>
                        К секции «{b.admin_name || metaFor(b.kind).label}»
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Пункты меню
                  </label>
                  <p className="mb-2 text-xs text-gray-500">
                    Слева — как пункт называется в шапке, справа — к какой секции
                    он прокручивает страницу.
                  </p>
                  <div className="space-y-2">
                    {navItems.map((it: any, i: number) => (
                      <div key={i} className="flex flex-wrap items-end gap-2">
                        <div className="min-w-[160px] flex-1">
                          <div className="mb-1 text-xs font-medium text-gray-600">
                            Название пункта
                          </div>
                          <input
                            type="text"
                            value={it.label || ''}
                            onChange={e => {
                              const next = [...navItems]
                              next[i] = { ...next[i], label: e.target.value }
                              patchPage({ nav_items: next })
                            }}
                            placeholder="Спикеры"
                            className="input"
                          />
                        </div>
                        <div className="min-w-[200px] flex-1">
                          <div className="mb-1 text-xs font-medium text-gray-600">
                            Куда ведёт
                          </div>
                          <select
                            value={it.block_kind || ''}
                            onChange={e => {
                              const next = [...navItems]
                              next[i] = { ...next[i], block_kind: e.target.value }
                              patchPage({ nav_items: next })
                            }}
                            className="input bg-white"
                          >
                            <option value="">— выберите секцию —</option>
                            {(page.blocks || []).map((b: any) => (
                              <option key={b.id} value={b.kind}>
                                {b.admin_name || metaFor(b.kind).label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button
                          onClick={() => patchPage({
                            nav_items: navItems.filter((_: any, j: number) => j !== i),
                          })}
                          title="Удалить пункт"
                          className="mb-1 shrink-0 rounded px-2 py-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  {navItems.length < 8 && (
                    <button
                      onClick={() => patchPage({
                        nav_items: [...navItems, { label: '', block_kind: '' }],
                      })}
                      className="mt-2 text-sm font-medium text-brand hover:underline"
                    >
                      + Добавить пункт
                    </button>
                  )}
                  {!!navItems.length && navItems.some((i: any) => !i.label || !i.block_kind) && (
                    <p className="mt-2 text-xs text-amber-700">
                      Пункты без названия или без выбранной секции в шапке не показываются.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </details>
      )}

      {/* Оформление страницы */}
      <details className="rounded-xl border border-gray-200 bg-white">
        <summary className="cursor-pointer p-4 font-medium text-gray-900">
          Оформление страницы
        </summary>
        <div className="space-y-5 border-t border-gray-100 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FontSelect
              label="Шрифт заголовков" fonts={fonts}
              value={page.font_heading}
              onChange={v => patchPage({ font_heading: v })}
            />
            <FontSelect
              label="Шрифт основного текста" fonts={fonts}
              value={page.font_body}
              onChange={v => patchPage({ font_body: v })}
            />
            <ColorField
              label="Цвет заголовков" value={page.color_heading}
              onChange={v => patchPage({ color_heading: v })}
            />
            <ColorField
              label="Цвет основного текста" value={page.color_body}
              onChange={v => patchPage({ color_body: v })}
            />
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h4 className="mb-3 font-medium text-gray-900">Кнопки</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField
                label="Цвет кнопки" value={page.btn_color}
                onChange={v => patchPage({ btn_color: v })}
              />
              <ColorField
                label="Цвет текста на кнопке" value={page.btn_text_color}
                onChange={v => patchPage({ btn_text_color: v })}
              />
            </div>
            <div className="mt-3">
              <MetallicToggle
                label="Металлический градиент на кнопках"
                checked={!!page.btn_metallic}
                onChange={v => patchPage({ btn_metallic: v })}
              />
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h4 className="mb-3 font-medium text-gray-900">Иконки</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField
                label="Цвет иконок" value={page.icon_color}
                onChange={v => patchPage({ icon_color: v })}
              />
              <div className="flex items-end pb-2">
                <MetallicToggle
                  label="Металлический градиент на иконках"
                  checked={!!page.icon_metallic}
                  onChange={v => patchPage({ icon_metallic: v })}
                />
              </div>
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h4 className="mb-3 font-medium text-gray-900">Фон страницы</h4>
            <BackgroundFields
              eventId={eventId}
              bgColor={page.bg_color}
              imageUrl={page.bg_image_url}
              overlay={page.bg_overlay}
              opacity={page.bg_overlay_opacity}
              onBgColor={v => patchPage({ bg_color: v })}
              onImage={v => patchPage({ bg_image_url: v })}
              onOverlay={v => patchPage({ bg_overlay: v })}
              onOpacity={v => patchPage({ bg_overlay_opacity: v })}
            />
          </div>
        </div>
      </details>

      {/* Текст страницы после оплаты */}
      {kind === 'post_pay' && (
        <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
          <h4 className="font-medium text-gray-900">Что увидит человек после оплаты</h4>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Заголовок</label>
            <input
              type="text"
              value={page.post_pay_title || ''}
              onChange={e => patchPage({ post_pay_title: e.target.value })}
              className="input"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Сопроводительный текст
            </label>
            <textarea
              rows={3}
              value={page.post_pay_text || ''}
              onChange={e => patchPage({ post_pay_text: e.target.value })}
              className="input"
            />
          </div>
          <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
            Под текстом сами появятся кнопки на ваших ботов — чтобы человек
            не потерялся после оплаты. Ссылку <span className="font-mono">pluson.ru{publicUrl}</span>
            {' '}укажите как страницу возврата в платёжной системе.
          </p>
        </div>
      )}

      {/* Блоки */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Блоки страницы</h3>
          <span className="text-xs text-gray-500">Перетащите за ⠿, чтобы поменять порядок</span>
        </div>

        <div className="space-y-2">
          {page.blocks.map((b: any) => (
            <BlockCard
              key={b.id}
              block={b}
              eventId={eventId}
              isDragging={dragId === b.id}
              onPatch={patch => patchBlock(b.id, patch)}
              onRemove={() => removeBlock(b.id)}
              onDragStart={() => setDragId(b.id)}
              onDragOver={e => e.preventDefault()}
              onDrop={() => onDrop(b.id)}
            />
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {ADDABLE.map(k => (
            <button
              key={k}
              onClick={() => addBlock(k)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Plus className="h-4 w-4" /> {metaFor(k).label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
