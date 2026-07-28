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
import { GripVertical, ChevronDown, ChevronRight, Trash2, Zap } from 'lucide-react'
import FileUploader from '@/components/FileUploader'
import { metaFor } from './blockMeta'
import { ColorField, BackgroundFields } from './StyleControls'

interface Props {
  block: any
  eventId: number
  onPatch: (patch: any) => void
  onRemove: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
  isDragging: boolean
}

export default function BlockCard({
  block, eventId, onPatch, onRemove,
  onDragStart, onDragOver, onDrop, isDragging,
}: Props) {
  const [open, setOpen] = useState(false)
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
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`rounded-xl border bg-white transition-shadow ${
        isDragging ? 'opacity-40 border-brand' : 'border-gray-200 hover:shadow-sm'
      } ${!block.is_active ? 'bg-gray-50' : ''}`}
    >
      {/* Шапка карточки */}
      <div className="flex items-center gap-2 p-3">
        <GripVertical className="h-5 w-5 shrink-0 cursor-grab text-gray-400 active:cursor-grabbing" />

        <button
          onClick={() => setOpen(o => !o)}
          className="flex flex-1 items-center gap-2 text-left min-w-0"
        >
          {open
            ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
            : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />}
          <span className={`font-medium truncate ${block.is_active ? 'text-gray-900' : 'text-gray-400'}`}>
            {meta.label}
          </span>
          {block.title && (
            <span className="truncate text-sm text-gray-400">— {block.title}</span>
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
              {has('title') && (
                <Field label="Заголовок секции">
                  <input
                    type="text"
                    value={block.title || ''}
                    onChange={e => onPatch({ title: e.target.value })}
                    className="input"
                  />
                </Field>
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

              {has('list') && <ListEditor items={items} onChange={setList} />}
              {has('numbers') && <NumbersEditor items={numbers} onChange={setNumbers} />}

              {has('gallery') && (
                <GalleryEditor
                  eventId={eventId}
                  mode={gal.mode || 'carousel'}
                  media={gal.media || 'image'}
                  list={galList}
                  onChange={setGal}
                />
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
                  {block.kind !== 'hero' && (
                    <Field label="Ссылка кнопки">
                      <input
                        type="text"
                        value={block.button_url || ''}
                        onChange={e => onPatch({ button_url: e.target.value })}
                        className="input"
                      />
                    </Field>
                  )}
                </div>
              )}

              {block.kind === 'hero' && (
                <p className="text-sm text-gray-500">
                  Кнопка ведёт на регистрацию. Название, подзаголовок и даты берутся из события.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
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

/** Список простых строк — «что вы получите». */
function ListEditor({ items, onChange }: { items: any[]; onChange: (v: string[]) => void }) {
  const list: string[] = items.filter(i => typeof i === 'string')
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">Пункты списка</label>
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
