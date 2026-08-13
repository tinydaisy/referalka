'use client'

/**
 * Мелкие поля оформления лендинга: цвет, картинка фона + перекрытие, шрифт.
 * Используются и в настройках страницы целиком, и в оформлении отдельной секции.
 */
import FileUploader from '@/components/FileUploader'

/** Цвет + поле HEX рядом: пипетка удобна, но точный код тоже нужен. */
export function ColorField({
  label, value, onChange, hint,
}: {
  label: string
  value: string | null
  onChange: (v: string) => void
  hint?: string
}) {
  const safe = value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#ffffff'
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={safe}
          onChange={e => onChange(e.target.value)}
          className="h-9 w-12 rounded border border-gray-300 bg-white p-0.5 cursor-pointer shrink-0"
        />
        <input
          type="text"
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder="#25455D"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
        />
      </div>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  )
}

/** Галочка «металлический градиент» — из цвета делается переливающаяся заливка. */
export function MetallicToggle({
  checked, onChange, label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
      />
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  )
}

/**
 * Фон: картинка + цвет перекрытия с прозрачностью.
 * Перекрытие нужно, чтобы текст читался поверх фото — без него светлая
 * картинка «съедает» заголовок.
 */
export function BackgroundFields({
  uploadKind = 'landing_bg',
  imageUrl, overlay, opacity, bgColor,
  onImage, onOverlay, onOpacity, onBgColor,
  eventId,
}: {
  /** Куда грузить фон: landing_bg (событие) | product_media (продукт). */
  uploadKind?: string
  imageUrl: string | null
  overlay: string | null
  opacity: number | null
  bgColor: string | null
  onImage: (url: string | null) => void
  onOverlay: (v: string) => void
  onOpacity: (v: number) => void
  onBgColor: (v: string) => void
  eventId?: number
}) {
  return (
    <div className="space-y-3">
      <ColorField label="Цвет фона" value={bgColor} onChange={onBgColor} />

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Картинка фона
        </label>
        <FileUploader
          mode="single"
          kind={uploadKind}
          eventId={eventId}
          value={imageUrl}
          onChange={onImage}
          aspectClass="aspect-video"
          emptyText="Фоновая картинка секции"
        />
      </div>

      {imageUrl && (
        <div className="grid grid-cols-2 gap-3">
          <ColorField label="Цвет перекрытия" value={overlay} onChange={onOverlay} />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Плотность перекрытия: {opacity ?? 60}%
            </label>
            <input
              type="range" min={0} max={100} step={5}
              value={opacity ?? 60}
              onChange={e => onOpacity(Number(e.target.value))}
              className="w-full"
            />
            <p className="mt-1 text-xs text-gray-500">
              Чем выше, тем лучше читается текст поверх картинки.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Кадр фоновой картинки: сдвиг и масштаб, ОТДЕЛЬНО для компьютера и телефона.
 *
 * ⚠️ Зачем отдельно. Фон заполняет экран по правилу object-cover: лишнее
 * обрезается по краям. На узком экране телефона срезаются именно БОКА —
 * и объект, стоящий сбоку (человек, предмет), уходит из кадра. Одной общей
 * настройки не хватает: на широком экране кадр обычно хорош как есть.
 */
export function BgFramingFields({ page, patchPage }: { page: any; patchPage: (v: any) => void }) {
  // object-position хранится строкой «X% Y%» — разбираем на два числа.
  const parse = (v: string | null | undefined, fallback = 50) => {
    const m = String(v || '').match(/(-?\d+)%\s+(-?\d+)%/)
    return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: fallback, y: fallback }
  }
  const d = parse(page.bg_position)
  const m = parse(page.bg_position_mobile ?? page.bg_position)

  const Row = ({ label, hint, value, min, max, step = 1, suffix = '%', onChange }: any) => (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">
        {label}: {value}{suffix}
      </label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} className="w-full" />
      {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
    </div>
  )

  return (
    <div className="mt-4 space-y-4 border-t border-gray-100 pt-4">
      <div>
        <h4 className="font-medium text-gray-900">Кадр фоновой картинки</h4>
        <p className="mt-0.5 text-xs text-gray-500">
          Картинка заполняет экран, лишнее обрезается по краям. Сдвиньте кадр, если
          нужный объект оказался за краем — особенно на телефоне, там срезаются бока.
        </p>
      </div>

      <div className="rounded-lg bg-gray-50 p-3">
        <p className="mb-2 text-sm font-medium text-gray-800">На компьютере</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Row label="По горизонтали" value={d.x} min={0} max={100}
            hint="0 — левый край, 100 — правый"
            onChange={(v: number) => patchPage({ bg_position: `${v}% ${d.y}%` })} />
          <Row label="По вертикали" value={d.y} min={0} max={100}
            hint="0 — верх, 100 — низ"
            onChange={(v: number) => patchPage({ bg_position: `${d.x}% ${v}%` })} />
          <Row label="Масштаб" value={page.bg_scale ?? 300} min={100} max={500} step={5}
            hint="100 — картинка вписана в экран, больше — приблизить"
            onChange={(v: number) => patchPage({ bg_scale: v })} />
        </div>
      </div>

      <div className="rounded-lg bg-gray-50 p-3">
        <p className="mb-2 text-sm font-medium text-gray-800">На телефоне</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Row label="По горизонтали" value={m.x} min={0} max={100}
            hint="сдвиньте к объекту — бока обрезаются"
            onChange={(v: number) => patchPage({ bg_position_mobile: `${v}% ${m.y}%` })} />
          <Row label="По вертикали" value={m.y} min={0} max={100}
            onChange={(v: number) => patchPage({ bg_position_mobile: `${m.x}% ${v}%` })} />
          <Row label="Масштаб" value={page.bg_scale_mobile ?? page.bg_scale ?? 300}
            min={100} max={500} step={5}
            hint="увеличьте, если объект попадает в кадр не целиком"
            onChange={(v: number) => patchPage({ bg_scale_mobile: v })} />
        </div>
      </div>
    </div>
  )
}

/** Выбор шрифта. Список приходит с бэка (landing_fonts.py) — одна точка истины. */
export function FontSelect({
  label, value, onChange, fonts,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  fonts: Array<{ key: string; label: string; category: string }>
}) {
  // Список шрифтов может не прийти (сбой запроса) — без защиты .filter
  // роняет всю страницу настроек.
  const list0 = Array.isArray(fonts) ? fonts : []
  const groups: Array<[string, string]> = [
    ['sans', 'Без засечек'],
    ['serif', 'С засечками'],
    ['display', 'Акцидентные (для заголовков)'],
  ]
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
      >
        {groups.map(([cat, title]) => {
          const list = list0.filter(f => f.category === cat)
          if (!list.length) return null
          return (
            <optgroup key={cat} label={title}>
              {list.map(f => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </optgroup>
          )
        })}
      </select>
    </div>
  )
}
