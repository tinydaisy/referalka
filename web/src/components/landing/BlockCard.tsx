'use client'

/**
 * Карточка одного блока лендинга в конструкторе.
 *
 * Свёрнутая — строка с ручкой перетаскивания, названием и галочкой «показывать».
 * Развёрнутая — поля содержимого + оформление секции.
 *
 * Живые блоки (спикеры, программа, тарифы...) содержимое не редактируют — они
 * тянут данные события. У них правится только заголовок и оформление.
 */
import { useState } from 'react'
import { GripVertical, ChevronDown, ChevronRight, Trash2, Zap, X } from 'lucide-react'
import FileUploader from '@/components/FileUploader'
import { metaFor } from './blockMeta'
import { ColorField, BackgroundFields } from './StyleControls'
import { CARD_ICONS, CardIcon, ICON_GROUPS } from './icons'

interface Props {
  block: any
  eventId: number
  onPatch: (patch: any) => void
  onRemove: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
  isDragging: boolean
  /** Все блоки страницы — для выбора якоря у кнопки. */
  pageBlocks?: any[]
  /** Тарифы события — чтобы выбрать, какой подсветить. */
  tariffs?: any[]
  /** Оферты клиента — для ссылки в подвале. */
  offers?: any[]
}

export default function BlockCard({
  block, eventId, onPatch, onRemove,
  onDragStart, onDragOver, onDrop, isDragging, pageBlocks, tariffs, offers,
}: Props) {
  const [open, setOpen] = useState(false)
  // ⚠️ draggable включается ТОЛЬКО когда мышь на ручке ⠿. Если он висит на
  // всей карточке, браузер начинает тащить её при выделении текста в поле и
  // при перетаскивании ползунков — карточка «уезжает» прямо во время правки.
  const [canDrag, setCanDrag] = useState(false)
  const [tab, setTab] = useState<'content' | 'style'>('content')
  const meta = metaFor(block.kind)
  const has = (f: string) => meta.fields.includes(f as any)

  const items = Array.isArray(block.items) ? block.items : []

  /* ── список пунктов (что получите) ───────────────────────────────────── */
  const setList = (next: string[]) => onPatch({ items: next })

  /* ── цифры [{value,label}] ───────────────────────────────────────────── */
  const numbers: Array<{ value: string; label: string }> =
    Array.isArray(items) && items.length && typeof items[0] === 'object' && 'value' in items[0]
      ? items : []
  const setNumbers = (next: any[]) => onPatch({ items: next })

  /* ── галерея {mode, media, list:[{url,caption}]} ─────────────────────── */
  const gal = (block.items && !Array.isArray(block.items)) ? block.items : {}
  const galList: Array<{ url: string; caption?: string }> = Array.isArray(gal.list) ? gal.list : []
  const setGal = (patch: any) => onPatch({
    items: { mode: gal.mode || 'carousel', media: gal.media || 'image', list: galList, ...patch },
  })

  return (
    <div
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragEnd={() => setCanDrag(false)}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`rounded-xl border bg-white transition-shadow ${
        isDragging ? 'opacity-40 border-brand' : 'border-gray-200 hover:shadow-sm'
      } ${!block.is_active ? 'bg-gray-50' : ''}`}
    >
      {/* Шапка карточки */}
      <div className="flex items-center gap-2 p-3">
        <span
          onMouseDown={() => setCanDrag(true)}
          onMouseUp={() => setCanDrag(false)}
          onMouseLeave={() => setCanDrag(false)}
          title="Перетащите, чтобы поменять порядок"
          className="shrink-0 cursor-grab active:cursor-grabbing"
        >
          <GripVertical className="h-5 w-5 text-gray-400" />
        </span>

        <button
          onClick={() => setOpen(o => !o)}
          className="flex flex-1 items-center gap-2 text-left min-w-0"
        >
          {open
            ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
            : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />}
          <span className={`font-medium truncate ${block.is_active ? 'text-gray-900' : 'text-gray-400'}`}>
            {block.admin_name || meta.label}
          </span>
          {(block.admin_name || block.title) && (
            <span className="truncate text-sm text-gray-400">
              — {block.admin_name ? meta.label : block.title}
            </span>
          )}
          {meta.live && (
            <span
              title="Содержимое подтягивается из события автоматически"
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700"
            >
              <Zap className="h-3 w-3" /> авто
            </span>
          )}
        </button>

        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={block.is_active}
            onChange={e => onPatch({ is_active: e.target.checked })}
            className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
          />
          показывать
        </label>

        {meta.repeatable && (
          <button
            onClick={() => { if (confirm(`Удалить секцию «${meta.label}»?`)) onRemove() }}
            className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
            title="Удалить секцию"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {open && (
        <div className="border-t border-gray-100 p-4">
          <p className="mb-4 text-sm text-gray-500">{meta.hint}</p>

          <div className="mb-4 flex gap-1 border-b border-gray-200">
            {(['content', 'style'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                  tab === t ? 'border-brand text-brand'
                            : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {t === 'content' ? 'Содержимое' : 'Оформление'}
              </button>
            ))}
          </div>

          {tab === 'content' ? (
            <div className="space-y-4">
              {/* Внутреннее имя — только для списка в конструкторе. */}
              {meta.repeatable && (
                <Field label="Название секции (только для вас)">
                  <input
                    type="text"
                    value={block.admin_name || ''}
                    onChange={e => onPatch({ admin_name: e.target.value })}
                    className="input"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Видно только в этом списке — помогает отличать секции.
                    На лендинге не показывается.
                  </p>
                </Field>
              )}

              {has('title') && (
                <>
                  <Field label="Заголовок секции">
                    <input
                      type="text"
                      value={block.title || ''}
                      onChange={e => onPatch({ title: e.target.value })}
                      className="input"
                    />
                  </Field>

                </>
              )}

              {has('subtitle') && (
                <Field label="Подзаголовок">
                  <input
                    type="text"
                    value={block.subtitle || ''}
                    onChange={e => onPatch({ subtitle: e.target.value })}
                    className="input"
                  />
                </Field>
              )}

              {has('body') && (
                <Field label={block.kind === 'footer' ? 'Дополнительный текст в подвале' : 'Текст'}>
                  <textarea
                    rows={4}
                    value={block.body || ''}
                    onChange={e => onPatch({ body: e.target.value })}
                    className="input"
                  />
                </Field>
              )}

              {has('seats') && (
                <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
                  Сколько всего мест — задаётся сверху страницы, одно число на событие.
                  Свободные считаются сами.
                </p>
              )}

              {has('list') && (
                <ListEditor
                  items={items}
                  onChange={setList}
                  label={block.kind === 'audience' ? 'Кому подойдёт' : 'Пункты списка'}
                />
              )}
              {has('audience_cards') && (
                <AudienceEditor
                  eventId={eventId}
                  items={Array.isArray(items)
                    ? items.map((i: any) => typeof i === 'string' ? { title: i } : i)
                        .filter((i: any) => i && typeof i === 'object')
                    : []}
                  onChange={next => onPatch({ items: next })}
                />
              )}

              {has('cards') && (
                <CardsEditor
                  items={Array.isArray(items)
                    ? items.filter((i: any) => i && typeof i === 'object' && 'title' in i)
                    : []}
                  onChange={next => onPatch({ items: next })}
                />
              )}

              {has('numbers') && <NumbersEditor items={numbers} onChange={setNumbers} />}

              {has('gallery') && (
                <div className="rounded-lg border border-gray-200 p-3">
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Откуда брать содержимое
                  </label>
                  <select
                    value={block.gallery_source || 'manual'}
                    onChange={e => onPatch({ gallery_source: e.target.value })}
                    className="input bg-white"
                  >
                    <option value="manual">Загрузить прямо сюда</option>
                    <option value="testimonials">Из базы «Отзывы и кейсы» по меткам</option>
                  </select>
                  {block.gallery_source === 'testimonials' && (
                    <div className="mt-3">
                      <label className="mb-1 block text-sm font-medium text-gray-700">
                        Метки (через запятую)
                      </label>
                      <input
                        type="text"
                        defaultValue={(block.gallery_tags || []).join(', ')}
                        onBlur={e => onPatch({
                          gallery_tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean),
                        })}
                        placeholder="конференция, частушки"
                        className="input"
                      />
                      <p className="mt-1 text-xs text-gray-500">
                        Пусто — попадут все отзывы. Метки задаются в разделе
                        «Отзывы и кейсы».
                      </p>
                    </div>
                  )}
                </div>
              )}

              {has('gallery') && (block.gallery_source || 'manual') === 'manual' && (
                <GalleryEditor
                  eventId={eventId}
                  mode={gal.mode || 'carousel'}
                  media={gal.media || 'image'}
                  list={galList}
                  onChange={setGal}
                />
              )}

              {/* Размер карточек и подписи — общие для обоих источников. */}
              {has('gallery') && (
                <div className="rounded-lg border border-gray-200 p-3">
                  {/* Когда содержимое берётся из базы, режим показа задаётся
                      здесь: у блока нет своего списка с этими переключателями. */}
                  {block.gallery_source === 'testimonials' && (
                    <div className="mb-3 grid gap-3 sm:grid-cols-2">
                      <Field label="Как показываем">
                        <select
                          value={gal.mode || 'carousel'}
                          onChange={e => setGal({ mode: e.target.value })}
                          className="input bg-white"
                        >
                          <option value="carousel">Каруселью — листается вбок</option>
                          <option value="grid">Сеткой — всё сразу</option>
                        </select>
                      </Field>
                    </div>
                  )}
                  <Field label={`Ширина карточки: ${block.media_size || 320} px`}>
                    <input type="range" min={160} max={900} step={20}
                      value={block.media_size || 320}
                      onChange={e => onPatch({ media_size: Number(e.target.value) })}
                      className="w-full" />
                    <p className="mt-1 text-xs text-gray-500">
                      Работает в режиме карусели. На узком экране карточка
                      сожмётся по ширине экрана.
                    </p>
                  </Field>
                  <label className="mt-3 flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={block.show_captions !== false}
                      onChange={e => onPatch({ show_captions: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                    />
                    <span className="text-sm text-gray-700">Показывать подписи под карточками</span>
                  </label>
                  <p className="mt-1 text-xs text-gray-500">
                    Подписи берутся из названия отзыва в разделе «Отзывы и кейсы».
                  </p>
                </div>
              )}

              {/* Какой тариф подсветить — выбирается здесь, а не в разделе «Тарифы». */}
              {block.kind === 'tariffs' && (
                <Field label="Выделить тариф">
                  <select
                    value={block.featured_tariff_id ?? ''}
                    onChange={e => onPatch({
                      featured_tariff_id: e.target.value ? Number(e.target.value) : null,
                    })}
                    className="input bg-white"
                  >
                    <option value="">Никакой не выделять</option>
                    {(tariffs || []).map((t: any) => (
                      <option key={t.id} value={t.id}>{t.title}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    У выделенного тарифа рамка акцентного цвета и мягкое свечение.
                  </p>
                </Field>
              )}

              {/* Оферта подвала — из общей базы оферт. */}
              {block.kind === 'footer' && (
                <Field label="Оферта в подвале">
                  <select
                    value={block.offer_id ?? ''}
                    onChange={e => onPatch({
                      offer_id: e.target.value ? Number(e.target.value) : null,
                    })}
                    className="input bg-white"
                  >
                    <option value="">Как задано в событии</option>
                    {(offers || []).map((o: any) => (
                      <option key={o.id} value={o.id}>{o.title}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    Список берётся из раздела «Оферты». Ссылка появится внизу
                    страницы рядом с политикой.
                  </p>
                </Field>
              )}

              {has('button') && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Подпись кнопки">
                    <input
                      type="text"
                      value={block.button_label || ''}
                      onChange={e => onPatch({ button_label: e.target.value })}
                      className="input"
                    />
                  </Field>
                  {/* Цель кнопки настраивается у ВСЕХ блоков, включая шапку:
                      «Получить билет» может вести и к тарифам, а не только
                      на форму регистрации. */}
                  {(
                    <Field label="Куда ведёт кнопка">
                      <select
                        value={
                          !block.button_url ? 'register'
                            : block.button_url.startsWith('#lp-') ? block.button_url
                            : 'custom'
                        }
                        onChange={e => {
                          const v = e.target.value
                          onPatch({ button_url: v === 'register' ? null : v === 'custom' ? ' ' : v })
                        }}
                        className="input bg-white"
                      >
                        <option value="register">На регистрацию</option>
                        {(pageBlocks || []).map((b: any) => (
                          <option key={b.id} value={`#lp-${b.kind}`}>
                            К секции «{b.admin_name || metaFor(b.kind).label}»
                          </option>
                        ))}
                        <option value="custom">Своя ссылка</option>
                      </select>
                      {block.button_url && !block.button_url.startsWith('#lp-') && (
                        <input
                          type="text"
                          value={block.button_url.trim()}
                          onChange={e => onPatch({ button_url: e.target.value })}
                          placeholder="https://…"
                          className="input mt-2"
                        />
                      )}
                    </Field>
                  )}
                </div>
              )}

              {/* Сколько карточек в ряд + рамка — для блоков с сеткой. */}
              {['speakers', 'partners'].includes(block.kind) && (
                <Field label="Как показывать карточки">
                  <div className="flex flex-wrap gap-2">
                    {([
                      ['grid', 'Сеткой — несколько в ряд'],
                      ['scroll', 'Лентой — прокрутка вбок'],
                    ] as const).map(([val, label]) => (
                      <button
                        key={val}
                        onClick={() => onPatch({ display_mode: val })}
                        className={`rounded-lg border px-3 py-1.5 text-sm ${
                          (block.display_mode || 'grid') === val
                            ? 'border-brand bg-brand/5 font-medium text-brand'
                            : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </Field>
              )}

              {['speakers', 'partners', 'values', 'difference', 'gallery', 'numbers'].includes(block.kind) && (
                <>
                  <Field label={`Карточек в ряд: ${block.columns || (block.kind === 'numbers' ? 4 : 3)}`}>
                    <input
                      type="range" min={1} max={6}
                      value={block.columns || (block.kind === 'numbers' ? 4 : 3)}
                      onChange={e => onPatch({ columns: Number(e.target.value) })}
                      className="w-full"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      На узком экране колонок будет меньше — вёрстка подстроится сама.
                    </p>
                  </Field>
                  {['values', 'difference', 'audience'].includes(block.kind) && (
                    <Field label={`Размер иконок: ${block.icon_size || 88} px`}>
                      <input type="range" min={24} max={200} step={4}
                        value={block.icon_size || 88}
                        onChange={e => onPatch({ icon_size: Number(e.target.value) })}
                        className="w-full" />
                    </Field>
                  )}

                  {block.kind === 'audience' && (
                    <div className="rounded-lg border border-gray-200 p-3">
                      <div className="mb-2 text-sm font-medium text-gray-700">Фото в карточках</div>
                      <Field label={`Размер фото: ${block.card_img_size || 100}% ширины карточки`}>
                        <input type="range" min={20} max={100} step={5}
                          value={block.card_img_size || 100}
                          onChange={e => onPatch({ card_img_size: Number(e.target.value) })}
                          className="w-full" />
                      </Field>
                      <div className="mt-3 grid gap-4 sm:grid-cols-3">
                        <Field label={`Скругление по ширине: ${block.card_img_radius_x || 0}%`}>
                          <input type="range" min={0} max={50}
                            value={block.card_img_radius_x || 0}
                            onChange={e => onPatch({ card_img_radius_x: Number(e.target.value) })}
                            className="w-full" />
                        </Field>
                        <Field label={`Скругление по высоте: ${block.card_img_radius_y || 0}%`}>
                          <input type="range" min={0} max={50}
                            value={block.card_img_radius_y || 0}
                            onChange={e => onPatch({ card_img_radius_y: Number(e.target.value) })}
                            className="w-full" />
                        </Field>
                        <Field label={`Пропорция: ${Number(block.card_img_ratio || 1.6).toFixed(2)}`}>
                          <input type="range" min={0.4} max={3} step={0.1}
                            value={Number(block.card_img_ratio || 1.6)}
                            onChange={e => onPatch({ card_img_ratio: Number(e.target.value) })}
                            className="w-full" />
                        </Field>
                      </div>
                      <p className="mt-2 text-xs text-gray-500">
                        50% и 50% при пропорции 1 — круг. Разные значения дают овал
                        («яйцо»), нули — прямоугольник. Пропорция задаёт форму области,
                        чтобы фото не обрезалось лишним.
                      </p>
                    </div>
                  )}

                  {block.kind === 'numbers' && (
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!block.show_divider}
                        onChange={e => onPatch({ show_divider: e.target.checked })}
                        className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                      />
                      <span className="text-sm text-gray-700">
                        Линия-разделитель между цифрой и подписью
                      </span>
                    </label>
                  )}

                  {['values', 'difference', 'benefits', 'audience', 'tariffs'].includes(block.kind) && (
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!block.cards_glow}
                        onChange={e => onPatch({ cards_glow: e.target.checked })}
                        className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                      />
                      <span className="text-sm text-gray-700">
                        Бегущее свечение карточек (анимация)
                      </span>
                    </label>
                  )}

                  <Field label="Вид карточек">
                    <div className="flex flex-wrap gap-2">
                      {([
                        ['border', 'В рамках'],
                        ['divider', 'С разделителями'],
                        ['plain', 'Без оформления'],
                      ] as const).map(([val, label]) => (
                        <button
                          key={val}
                          onClick={() => onPatch({ card_style: val })}
                          className={`rounded-lg border px-3 py-1.5 text-sm ${
                            (block.card_style || (block.cards_bordered === false ? 'plain' : 'border')) === val
                              ? 'border-brand bg-brand/5 font-medium text-brand'
                              : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </Field>
                </>
              )}

              {block.kind === 'hero' && (
                <>
                  <div className="rounded-lg border border-gray-200 p-3">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!block.show_seats}
                        onChange={e => onPatch({ show_seats: e.target.checked })}
                        className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                      />
                      <span className="text-sm font-medium text-gray-700">
                        Показывать «осталось мест» рядом с кнопкой
                      </span>
                    </label>
                    {block.show_seats && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {([['above', 'Над кнопкой'], ['side', 'Сбоку от кнопки']] as const).map(
                          ([val, label]) => (
                            <button
                              key={val}
                              onClick={() => onPatch({ seats_position: val })}
                              className={`rounded-lg border px-3 py-1.5 text-sm ${
                                (block.seats_position || 'above') === val
                                  ? 'border-brand bg-brand/5 font-medium text-brand'
                                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                  {/* Дата события. Показывается всегда — галочки нет:
                      без даты продающая шапка не работает. Настраиваются
                      только размер и место. */}
                  <div className="rounded-lg border border-gray-200 p-3">
                    <div className="mb-2 text-sm font-medium text-gray-700">Дата события</div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label={`Размер даты: ${block.date_size ? `${block.date_size} px` : 'как основной текст'}`}>
                        <div className="flex items-center gap-3">
                          <input type="range" min={10} max={80} step={1}
                            value={block.date_size ?? 18}
                            onChange={e => onPatch({ date_size: Number(e.target.value) })}
                            className="w-full" />
                          {block.date_size != null && (
                            <button
                              onClick={() => onPatch({ date_size: null })}
                              className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                            >
                              сбросить
                            </button>
                          )}
                        </div>
                      </Field>
                      <Field label="Где показывать">
                        <div className="flex gap-2">
                          {([
                            ['above', 'Над названием'],
                            ['below', 'Под описанием'],
                          ] as const).map(([val, label]) => (
                            <button
                              key={val}
                              onClick={() => onPatch({ date_position: val })}
                              className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
                                (block.date_position || 'above') === val
                                  ? 'border-brand bg-brand/5 font-medium text-brand'
                                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </Field>
                    </div>
                  </div>

                  <p className="text-sm text-gray-500">
                    Название, описание и даты берутся из настроек события.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Раскладка: где стоит заголовок относительно содержимого.
                  На телефоне всегда одна колонка — заголовок сверху. */}
              {/* Заголовок: размер, выравнивание, свой цвет — доступно у ВСЕХ
                  блоков, а не только у тех, где правится текст заголовка. */}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={`Размер заголовка: ${block.title_size || (block.kind === 'hero' ? 72 : 48)} px`}>
                  <input
                    type="range" min={16} max={140} step={2}
                    value={block.title_size || (block.kind === 'hero' ? 72 : 48)}
                    onChange={e => onPatch({ title_size: Number(e.target.value) })}
                    className="w-full"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    На телефоне уменьшится сам, чтобы не вылезал за экран.
                  </p>
                </Field>
                <Field label="Выравнивание заголовка">
                  <div className="flex gap-2">
                    {([
                      ['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа'],
                    ] as const).map(([val, label]) => (
                      <button
                        key={val}
                        onClick={() => onPatch({ title_align: val })}
                        className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
                          (block.title_align || 'left') === val
                            ? 'border-brand bg-brand/5 font-medium text-brand'
                            : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>

              {/* Размеры остального текста секции — отдельно от заголовка. */}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={`Размер ${block.kind === 'hero' ? 'описания' : 'подзаголовка'}: ${block.subtitle_size ? `${block.subtitle_size} px` : 'обычный'}`}>
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min={10} max={64} step={1}
                      value={block.subtitle_size ?? 18}
                      onChange={e => onPatch({ subtitle_size: Number(e.target.value) })}
                      className="w-full"
                    />
                    {block.subtitle_size != null && (
                      <button
                        onClick={() => onPatch({ subtitle_size: null })}
                        className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                      >
                        сбросить
                      </button>
                    )}
                  </div>
                </Field>
                <Field label={`Размер текста секции: ${block.text_size ? `${block.text_size} px` : 'как на странице'}`}>
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min={10} max={48} step={1}
                      value={block.text_size ?? 16}
                      onChange={e => onPatch({ text_size: Number(e.target.value) })}
                      className="w-full"
                    />
                    {block.text_size != null && (
                      <button
                        onClick={() => onPatch({ text_size: null })}
                        className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                      >
                        сбросить
                      </button>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    Пункты списков, карточки, подарки, тарифы — всё содержимое секции.
                  </p>
                </Field>
              </div>

              <div className="rounded-lg border border-gray-200 p-3">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!block.title_color}
                    onChange={e => onPatch({
                      title_color: e.target.checked ? '#FFFFFF' : null,
                      title_metallic: e.target.checked ? false : null,
                    })}
                    className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    Свой цвет заголовка (не как в теме)
                  </span>
                </label>
                {block.title_color && (
                  <div className="mt-3 space-y-3">
                    <ColorField
                      label="Цвет заголовка этой секции"
                      value={block.title_color}
                      onChange={v => onPatch({ title_color: v })}
                    />
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!block.title_metallic}
                        onChange={e => onPatch({ title_metallic: e.target.checked })}
                        className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                      />
                      <span className="text-sm text-gray-700">Металлический перелив</span>
                    </label>
                  </div>
                )}
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Расположение заголовка
                </label>
                <div className="flex flex-wrap gap-2">
                  {([
                    ['top', 'Сверху'],
                    ['left', 'Слева, текст справа'],
                    ['right', 'Справа, текст слева'],
                  ] as const).map(([val, label]) => (
                    <button
                      key={val}
                      onClick={() => onPatch({ layout: val })}
                      className={`rounded-lg border px-3 py-2 text-sm ${
                        (block.layout || 'top') === val
                          ? 'border-brand bg-brand/5 font-medium text-brand'
                          : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  На телефоне колонки всегда складываются в одну.
                </p>
              </div>

              {block.layout && block.layout !== 'top' && (
                <Field label={`Ширина колонки с заголовком: ${block.split_ratio || 50}%`}>
                  <input
                    type="range" min={20} max={80} step={5}
                    value={block.split_ratio || 50}
                    onChange={e => onPatch({ split_ratio: Number(e.target.value) })}
                    className="w-full"
                  />
                </Field>
              )}

              <div className="border-t border-gray-100 pt-4">
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Картинка в секции
                </label>
                <p className="mb-2 text-xs text-gray-500">
                  Не фон, а изображение рядом с текстом — фото, скриншот, коллаж.
                </p>
                <FileUploader
                  mode="single"
                  kind="landing_media"
                  eventId={eventId}
                  value={block.image_url || null}
                  onChange={url => onPatch({ image_url: url })}
                  emptyText="Загрузите картинку"
                />
                {block.image_url && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {([
                      ['left', 'Слева'], ['right', 'Справа'],
                      ['center', 'По центру'],
                      ['top', 'Сверху'], ['bottom', 'Снизу'],
                    ] as const).map(([val, label]) => (
                      <button
                        key={val}
                        onClick={() => onPatch({ image_position: val })}
                        className={`rounded-lg border px-3 py-1.5 text-sm ${
                          (block.image_position || 'right') === val
                            ? 'border-brand bg-brand/5 font-medium text-brand'
                            : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {block.image_url && (
                  <div className="mt-3">
                    <label className="mb-1 block text-sm font-medium text-gray-700">
                      Ширина картинки: {block.image_width || 100}%
                    </label>
                    <input
                      type="range" min={20} max={100} step={5}
                      value={block.image_width || 100}
                      onChange={e => onPatch({ image_width: Number(e.target.value) })}
                      className="w-full"
                    />
                  </div>
                )}
              </div>

              <BackgroundFields
                eventId={eventId}
                bgColor={block.bg_color}
                imageUrl={block.bg_image_url}
                overlay={block.bg_overlay}
                opacity={block.bg_overlay_opacity}
                onBgColor={v => onPatch({ bg_color: v })}
                onImage={v => onPatch({ bg_image_url: v })}
                onOverlay={v => onPatch({ bg_overlay: v })}
                onOpacity={v => onPatch({ bg_overlay_opacity: v })}
              />

              <div className="grid gap-3 sm:grid-cols-3">
                <ColorField
                  label="Цвет границы"
                  value={block.border_color}
                  onChange={v => onPatch({ border_color: v })}
                />
                <Field label={`Толщина границы: ${block.border_width || 0}px`}>
                  <input
                    type="range" min={0} max={12}
                    value={block.border_width || 0}
                    onChange={e => onPatch({ border_width: Number(e.target.value) })}
                    className="w-full"
                  />
                </Field>
                <Field label={`Скругление: ${block.border_radius || 0}px`}>
                  <input
                    type="range" min={0} max={64} step={4}
                    value={block.border_radius || 0}
                    onChange={e => onPatch({ border_radius: Number(e.target.value) })}
                    className="w-full"
                  />
                </Field>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Отступ сверху и снизу: {block.pad_y != null ? `${block.pad_y} px` : 'как у страницы'}
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={0} max={200} step={4}
                    value={block.pad_y ?? 64}
                    onChange={e => onPatch({ pad_y: Number(e.target.value) })}
                    className="w-full"
                  />
                  {block.pad_y != null && (
                    <button
                      onClick={() => onPatch({ pad_y: null })}
                      className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                    >
                      сбросить
                    </button>
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Насколько «воздушной» будет эта секция. Не задан — берётся общий
                  отступ из стилей лендинга.
                </p>
              </div>

              <p className="text-xs text-gray-500">
                Пустые поля — секция берёт оформление страницы.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      {children}
    </div>
  )
}

/** Список простых строк — «что вы получите» / «для кого». */
function ListEditor({
  items, onChange, label = 'Пункты списка',
}: {
  items: any[]
  onChange: (v: string[]) => void
  label?: string
}) {
  const list: string[] = items.filter(i => typeof i === 'string')
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <div className="space-y-2">
        {list.map((v, i) => (
          <div key={i} className="flex gap-2">
            <input
              type="text"
              value={v}
              onChange={e => {
                const next = [...list]; next[i] = e.target.value; onChange(next)
              }}
              className="input"
            />
            <button
              onClick={() => onChange(list.filter((_, j) => j !== i))}
              className="shrink-0 rounded px-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange([...list, ''])}
        className="mt-2 text-sm font-medium text-brand hover:underline"
      >
        + Добавить пункт
      </button>
    </div>
  )
}

/**
 * Выбор иконки: сначала показываем текущую и кнопку «Выбрать», список
 * раскрывается по клику и сгруппирован по смыслу. Длинная лента из 60 иконок
 * в каждой карточке была бы нечитаемой.
 */
function IconPicker({
  value, onChange,
}: {
  value?: string | null
  onChange: (v: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const current = CARD_ICONS.find(i => i.key === value)

  return (
    <div className="mt-3">
      <div className="mb-1.5 text-xs font-medium text-gray-600">Иконка</div>

      <div className="flex items-center gap-2">
        {current
          ? <CardIcon iconKey={current.key} color="#FFCFA4" size={40} />
          : <span className="flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-gray-300 text-[10px] text-gray-400">
              нет
            </span>}
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          {open ? 'Закрыть' : (current ? `${current.label} — сменить` : 'Выбрать иконку')}
        </button>
        {current && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="rounded px-2 py-1 text-sm text-gray-400 hover:bg-red-50 hover:text-red-600"
          >
            убрать
          </button>
        )}
      </div>

      {/* Модалка выбора. Закрывается только крестиком/«Отмена» — правило
          проекта: клик по фону не закрывает форму. */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-200 p-4">
              <h3 className="font-semibold text-gray-900">Выберите иконку</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                aria-label="Закрыть"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto p-4">
              {ICON_GROUPS.map(group => (
                <div key={group}>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {group}
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-2">
                    {CARD_ICONS.filter(i => i.group === group).map(ic => (
                      <button
                        key={ic.key}
                        type="button"
                        onClick={() => { onChange(ic.key); setOpen(false) }}
                        title={ic.label}
                        className={`flex flex-col items-center gap-1 rounded-lg border p-2 ${
                          value === ic.key ? 'border-brand bg-brand/5' : 'border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        <CardIcon iconKey={ic.key} color="#FFCFA4" size={38} />
                        <span className="w-full truncate text-center text-[10px] text-gray-500">
                          {ic.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 border-t border-gray-200 p-4">
              <button
                type="button"
                onClick={() => { onChange(null); setOpen(false) }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Без иконки
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Карточки «Для кого»: название, описание и картинка. */
function AudienceEditor({
  eventId, items, onChange,
}: {
  eventId: number
  items: Array<{ title?: string; text?: string; image?: string | null }>
  onChange: (v: any[]) => void
}) {
  const upd = (i: number, patch: any) => {
    const next = [...items]; next[i] = { ...next[i], ...patch }; onChange(next)
  }
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">Кому подойдёт</label>
      <div className="space-y-3">
        {items.map((c, i) => (
          <div key={i} className="rounded-lg border border-gray-200 p-3">
            <div className="flex gap-2">
              <input
                type="text" value={c.title || ''}
                onChange={e => upd(i, { title: e.target.value })}
                placeholder="Например: Предпринимателям в операционке"
                className="input font-semibold"
              />
              <button
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="shrink-0 rounded px-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                ✕
              </button>
            </div>
            <textarea
              rows={3} value={c.text || ''}
              onChange={e => upd(i, { text: e.target.value })}
              placeholder="Описание — в чём его ситуация и что он получит"
              className="input mt-2"
            />
            <div className="mt-2">
              <div className="mb-1 text-xs font-medium text-gray-600">Картинка</div>
              <FileUploader
                mode="single"
                kind="landing_media"
                eventId={eventId}
                value={c.image || null}
                onChange={url => upd(i, { image: url })}
                aspectClass="aspect-video"
                emptyText="Загрузите картинку"
              />
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange([...items, { title: '', text: '', image: null }])}
        className="mt-2 text-sm font-medium text-brand hover:underline"
      >
        + Добавить карточку
      </button>
    </div>
  )
}

/** Карточки «название + описание» — ценности, особенности. */
function CardsEditor({
  items, onChange,
}: {
  items: Array<{ title: string; text?: string; icon?: string | null }>
  onChange: (v: any[]) => void
}) {
  const upd = (i: number, patch: any) => {
    const next = [...items]; next[i] = { ...next[i], ...patch }; onChange(next)
  }
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">Карточки</label>
      <div className="space-y-3">
        {items.map((c, i) => (
          <div key={i} className="rounded-lg border border-gray-200 p-3">
            <div className="flex gap-2">
              <input
                type="text" value={c.title || ''}
                onChange={e => upd(i, { title: e.target.value })}
                placeholder="Название"
                className="input font-semibold"
              />
              <button
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="shrink-0 rounded px-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                ✕
              </button>
            </div>
            <textarea
              rows={2} value={c.text || ''}
              onChange={e => upd(i, { text: e.target.value })}
              placeholder="Короткое описание"
              className="input mt-2"
            />

            {/* Иконка карточки — из набора lucide, цветом иконок вашей темы. */}
            <IconPicker value={c.icon} onChange={v => upd(i, { icon: v })} />
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange([...items, { title: '', text: '' }])}
        className="mt-2 text-sm font-medium text-brand hover:underline"
      >
        + Добавить карточку
      </button>
    </div>
  )
}

/** Цифры с подписями — формат как регалии основателя. */
function NumbersEditor({
  items, onChange,
}: {
  items: Array<{ value: string; label: string }>
  onChange: (v: any[]) => void
}) {
  const upd = (i: number, patch: any) => {
    const next = [...items]; next[i] = { ...next[i], ...patch }; onChange(next)
  }
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">
        Цифры (от 2 до 4)
      </label>
      <div className="space-y-2">
        {items.map((n, i) => (
          <div key={i} className="flex gap-2">
            <input
              type="text" value={n.value || ''}
              onChange={e => upd(i, { value: e.target.value })}
              placeholder="500+"
              className="input w-32 shrink-0 font-semibold"
            />
            <input
              type="text" value={n.label || ''}
              onChange={e => upd(i, { label: e.target.value })}
              placeholder="участников"
              className="input"
            />
            <button
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              className="shrink-0 rounded px-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      {items.length < 4 && (
        <button
          onClick={() => onChange([...items, { value: '', label: '' }])}
          className="mt-2 text-sm font-medium text-brand hover:underline"
        >
          + Добавить цифру
        </button>
      )}
    </div>
  )
}

/** Галерея: картинки или видео, каруселью или сеткой. */
function GalleryEditor({
  eventId, mode, media, list, onChange,
}: {
  eventId: number
  mode: string
  media: string
  list: Array<{ url: string; caption?: string }>
  onChange: (patch: any) => void
}) {
  const upd = (i: number, patch: any) => {
    const next = [...list]; next[i] = { ...next[i], ...patch }; onChange({ list: next })
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Что показываем">
          <select
            value={media}
            onChange={e => onChange({ media: e.target.value, list: [] })}
            className="input bg-white"
          >
            <option value="image">Картинки (скриншоты отзывов, фото)</option>
            <option value="video">Видео по ссылке</option>
          </select>
        </Field>
        <Field label="Как показываем">
          <select
            value={mode}
            onChange={e => onChange({ mode: e.target.value })}
            className="input bg-white"
          >
            <option value="carousel">Карусель — листается вбок</option>
            <option value="grid">Сеткой — всё сразу</option>
          </select>
        </Field>
      </div>

      <div className="space-y-3">
        {list.map((it, i) => (
          <div key={i} className="rounded-lg border border-gray-200 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-600">№ {i + 1}</span>
              <button
                onClick={() => onChange({ list: list.filter((_, j) => j !== i) })}
                className="rounded px-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                ✕
              </button>
            </div>

            {media === 'image' ? (
              <FileUploader
                mode="single"
                kind="landing_media"
                eventId={eventId}
                value={it.url || null}
                onChange={url => upd(i, { url: url || '' })}
                emptyText="Загрузите картинку"
              />
            ) : (
              <input
                type="text"
                value={it.url || ''}
                onChange={e => upd(i, { url: e.target.value })}
                placeholder="Ссылка на YouTube, VK Видео или Rutube"
                className="input"
              />
            )}

            <input
              type="text"
              value={it.caption || ''}
              onChange={e => upd(i, { caption: e.target.value })}
              placeholder="Подпись (необязательно)"
              className="input mt-2"
            />
          </div>
        ))}
      </div>

      <button
        onClick={() => onChange({ list: [...list, { url: '', caption: '' }] })}
        className="text-sm font-medium text-brand hover:underline"
      >
        + Добавить {media === 'video' ? 'видео' : 'картинку'}
      </button>
    </div>
  )
}
