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
  imageUrl, overlay, opacity, bgColor,
  onImage, onOverlay, onOpacity, onBgColor,
  eventId,
}: {
  imageUrl: string | null
  overlay: string | null
  opacity: number | null
  bgColor: string | null
  onImage: (url: string | null) => void
  onOverlay: (v: string) => void
  onOpacity: (v: number) => void
  onBgColor: (v: string) => void
  eventId: number
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
          kind="landing_bg"
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
