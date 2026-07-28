'use client'

/**
 * Настройки → «Стили лендингов» — фирменное оформление по умолчанию (миграция 241).
 *
 * Задаётся один раз и подставляется в каждый НОВЫЙ лендинг события. Это дефолт,
 * а не жёсткая привязка: уже собранные лендинги правка темы не меняет — иначе
 * правка цвета «под одно событие» ломала бы все прошлые страницы.
 *
 * Справа — живое превью: сразу видно, как лягут заголовок, кнопка и карточка.
 */
import { useEffect, useState } from 'react'
import { Loader2, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { ColorField, MetallicToggle, FontSelect } from '@/components/landing/StyleControls'

/** Металлический перелив — расчёт совпадает с лендингом (вертикаль, 5 стопов). */
function metallic(color: string): string {
  return `linear-gradient(180deg, ${shade(color, -45)}, ${color}, ${shade(color, 30)}, ${color}, ${shade(color, -45)})`
}
function metallicButton(color: string): string {
  return `linear-gradient(180deg, ${shade(color, -22)}, ${color}, ${shade(color, 42)}, ${color}, ${shade(color, -22)})`
}
/** Минус — темнее, плюс — светлее (к белому). */
function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex || '#000000'
  const n = parseInt(m[1], 16)
  const f = (v: number) => pct >= 0
    ? Math.round(v + (255 - v) * (pct / 100))
    : Math.round(v * (1 + pct / 100))
  return `#${[f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]
    .map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`
}

const FONT_CSS: Record<string, string> = {
  BebasNeue: "'Bebas Neue', 'Oswald', Impact, sans-serif",
}
const fontCss = (key: string, label?: string) =>
  FONT_CSS[key] || `'${(label || key).replace(/([a-z])([A-Z])/g, '$1 $2')}', system-ui, sans-serif`

export default function LandingThemeTab() {
  const [theme, setTheme] = useState<any>(null)
  const [fonts, setFonts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const res = await api.landingTheme.get()
        setTheme(res?.theme || {})
        setFonts(Array.isArray(res?.fonts) ? res.fonts : [])
      } catch (e: any) {
        alert(e?.message || 'Не удалось загрузить стили')
      } finally { setLoading(false) }
    })()
  }, [])

  const set = (patch: any) => setTheme((t: any) => ({ ...t, ...patch }))

  const save = async () => {
    setSaving(true)
    try {
      await api.landingTheme.update(theme)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Загружаем…
      </div>
    )
  }
  if (!theme) return null

  const headFont = fonts.find(f => f.key === theme.font_heading)
  const bodyFont = fonts.find(f => f.key === theme.font_body)
  // shade() ждёт корректный HEX: мусор из поля не должен ронять превью.
  const safe = (v: any, d: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d)

  const bg = theme.bg_gradient && theme.bg_color_2
    ? `linear-gradient(${theme.bg_angle ?? 45}deg, ${theme.bg_color || '#25455D'}, ${theme.bg_color_2})`
    : (theme.bg_color || '#25455D')

  const radius = theme.radius ?? 5

  // Заливка кнопки в превью — та же логика, что на лендинге.
  const asLayer = (v: string) =>
    v.startsWith('linear-gradient') ? v : `linear-gradient(${v}, ${v})`
  const btnFillPreview = theme.btn_color_2
    ? `linear-gradient(${theme.btn_angle ?? 180}deg, ${safe(theme.btn_color, '#FFCFA4')}, ${safe(theme.btn_color_2, '#FFCFA4')})`
    : theme.btn_metallic
      ? metallicButton(safe(theme.btn_color, '#FFCFA4'))
      : (theme.btn_color || '#FFCFA4')

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        Это оформление по умолчанию для <b>новых</b> лендингов событий. Уже
        собранные страницы останутся как есть — их стиль правится в самом событии.
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
        {/* ── Настройки ──────────────────────────────────────────────── */}
        <div className="space-y-6">
          <Card title="Фон">
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField label="Основной цвет" value={theme.bg_color}
                onChange={v => set({ bg_color: v })} />
              <ColorField label="Цвет градиента" value={theme.bg_color_2}
                onChange={v => set({ bg_color_2: v })} />
            </div>
            <div className="mt-3 space-y-3">
              <MetallicToggle label="Градиент (переход между цветами)"
                checked={!!theme.bg_gradient} onChange={v => set({ bg_gradient: v })} />
              {theme.bg_gradient && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Как располагать градиент
                  </label>
                  <select
                    value={theme.bg_mode || 'screen'}
                    onChange={e => set({ bg_mode: e.target.value })}
                    className="input bg-white"
                  >
                    <option value="screen">Повторять на каждом экране — переход виден везде</option>
                    <option value="block">Свой градиент в каждом блоке</option>
                    <option value="page">Растянуть на всю страницу целиком</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    На длинной странице растянутый градиент почти не виден — сверху
                    один цвет, снизу другой. Обычно лучше «на каждом экране».
                  </p>
                </div>
              )}
              {theme.bg_gradient && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Направление: {theme.bg_angle ?? 45}°
                  </label>
                  <input type="range" min={0} max={360} step={15}
                    value={theme.bg_angle ?? 45}
                    onChange={e => set({ bg_angle: Number(e.target.value) })}
                    className="w-full" />
                  <p className="mt-1 text-xs text-gray-500">
                    0° — снизу вверх, 45° — по диагонали, 90° — слева направо.
                  </p>
                </div>
              )}
            </div>
          </Card>

          <Card title="Заголовки">
            <div className="grid gap-4 sm:grid-cols-2">
              <FontSelect label="Шрифт заголовков" fonts={fonts}
                value={theme.font_heading || 'BebasNeue'}
                onChange={v => set({ font_heading: v })} />
              <ColorField label="Цвет заголовков" value={theme.color_heading}
                onChange={v => set({ color_heading: v })} />
            </div>
            <div className="mt-3">
              <MetallicToggle label="Металлический градиент на заголовках"
                checked={!!theme.heading_metallic}
                onChange={v => set({ heading_metallic: v })} />
            </div>
            {theme.font_heading === 'BebasNeue' && (
              <p className="mt-2 text-xs text-amber-700">
                У Bebas Neue нет русских букв — кириллица берётся из похожего
                Oswald. Внешне разница почти незаметна.
              </p>
            )}
          </Card>

          <Card title="Основной текст">
            <div className="grid gap-4 sm:grid-cols-2">
              <FontSelect label="Шрифт текста" fonts={fonts}
                value={theme.font_body || 'Roboto'}
                onChange={v => set({ font_body: v })} />
              <ColorField label="Цвет текста" value={theme.color_body}
                onChange={v => set({ color_body: v })} />
              <ColorField label="Цвет ссылок" value={theme.color_link}
                onChange={v => set({ color_link: v })} />
              <ColorField label="Цвет цены в тарифах" value={theme.price_color}
                onChange={v => set({ price_color: v })}
                hint="Пусто — как у заголовков." />
            </div>
            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Размер основного текста: {theme.body_size ?? 16} px
              </label>
              <input type="range" min={12} max={28}
                value={theme.body_size ?? 16}
                onChange={e => set({ body_size: Number(e.target.value) })}
                className="w-full" />
              <p className="mt-1 text-xs text-gray-500">
                Размер заголовков задаётся у каждого блока отдельно.
              </p>
            </div>
          </Card>

          <Card title="Кнопки">
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField label="Цвет кнопки" value={theme.btn_color}
                onChange={v => set({ btn_color: v })} />
              <ColorField label="Цвет текста на кнопке" value={theme.btn_text_color}
                onChange={v => set({ btn_text_color: v })} />
            </div>
            <div className="mt-3 space-y-3">
              <MetallicToggle label="Металлический градиент на кнопках"
                checked={!!theme.btn_metallic} onChange={v => set({ btn_metallic: v })} />

              <ColorField label="Второй цвет заливки (градиент)"
                value={theme.btn_color_2}
                onChange={v => set({ btn_color_2: v })}
                hint="Пусто — заливка одним цветом или металликом." />

              {theme.btn_color_2 && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Направление заливки: {theme.btn_angle ?? 180}°
                  </label>
                  <input type="range" min={0} max={360} step={15}
                    value={theme.btn_angle ?? 180}
                    onChange={e => set({ btn_angle: Number(e.target.value) })}
                    className="w-full" />
                </div>
              )}
            </div>

            <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
              <h4 className="font-medium text-gray-900">Рамка кнопки</h4>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Толщина: {theme.btn_border_width ?? 0} px
                </label>
                <input type="range" min={0} max={12}
                  value={theme.btn_border_width ?? 0}
                  onChange={e => set({ btn_border_width: Number(e.target.value) })}
                  className="w-full" />
                <p className="mt-1 text-xs text-gray-500">0 — рамки нет.</p>
              </div>
              {!!theme.btn_border_width && (
                <>
                  <ColorField label="Цвет рамки" value={theme.btn_border_color}
                    onChange={v => set({ btn_border_color: v })} />
                  <MetallicToggle label="Металлический перелив на рамке"
                    checked={!!theme.btn_border_metallic}
                    onChange={v => set({ btn_border_metallic: v })} />
                </>
              )}
            </div>
          </Card>

          <Card title="Границы и иконки">
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField label="Цвет границ карточек" value={theme.border_color}
                onChange={v => set({ border_color: v })} />
              <ColorField label="Цвет иконок" value={theme.icon_color}
                onChange={v => set({ icon_color: v })} />
            </div>
            <div className="mt-3 space-y-2">
              <MetallicToggle label="Металлические границы"
                checked={!!theme.border_metallic}
                onChange={v => set({ border_metallic: v })} />
              <MetallicToggle label="Металлические иконки"
                checked={!!theme.icon_metallic}
                onChange={v => set({ icon_metallic: v })} />
            </div>
            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Скругление углов: {radius} px
              </label>
              <input type="range" min={0} max={40}
                value={radius}
                onChange={e => set({ radius: Number(e.target.value) })}
                className="w-full" />
              <p className="mt-1 text-xs text-gray-500">
                Одно на кнопки, карточки спикеров, тарифы и блоки.
              </p>
            </div>
          </Card>

          <Card title="Отступы и ширина">
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Ширина контента: {theme.content_width ? `${theme.content_width} px` : 'во всю ширину'}
                </label>
                <input type="range" min={0} max={2000} step={40}
                  value={theme.content_width ?? 1120}
                  onChange={e => set({ content_width: Number(e.target.value) })}
                  className="w-full" />
                <p className="mt-1 text-xs text-gray-500">
                  Полоса, в которой живёт текст. 0 — контент растянется на весь экран.
                </p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Отступы по бокам: {theme.pad_x ?? 24} px
                </label>
                <input type="range" min={0} max={160} step={4}
                  value={theme.pad_x ?? 24}
                  onChange={e => set({ pad_x: Number(e.target.value) })}
                  className="w-full" />
                <p className="mt-1 text-xs text-gray-500">
                  На телефоне всегда остаётся минимум 16 px, чтобы текст не липнул к краю.
                </p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Отступ между блоками: {theme.section_gap ?? 64} px
                </label>
                <input type="range" min={0} max={200} step={4}
                  value={theme.section_gap ?? 64}
                  onChange={e => set({ section_gap: Number(e.target.value) })}
                  className="w-full" />
              </div>
            </div>
          </Card>

          <div className="flex items-center gap-3">
            <button onClick={save} disabled={saving}
              className="btn-primary inline-flex items-center gap-2 disabled:opacity-60">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Сохранить стили
            </button>
            {saved && (
              <span className="flex items-center gap-1 text-sm text-green-700">
                <Check className="h-4 w-4" /> Сохранено
              </span>
            )}
          </div>
        </div>

        {/* ── Живое превью ───────────────────────────────────────────── */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className="mb-2 text-sm font-medium text-gray-700">Как это выглядит</div>
          <div className="overflow-hidden rounded-xl border border-gray-200 p-6"
               style={{ background: bg, fontFamily: fontCss(theme.font_body, bodyFont?.label) }}>
            <div
              className="text-3xl font-bold uppercase"
              style={
                theme.heading_metallic
                  ? {
                      fontFamily: fontCss(theme.font_heading, headFont?.label),
                      background: metallic(safe(theme.color_heading, '#FFCFA4')),
                      WebkitBackgroundClip: 'text',
                      backgroundClip: 'text',
                      color: 'transparent',
                      lineHeight: 1.1,
                    }
                  : {
                      fontFamily: fontCss(theme.font_heading, headFont?.label),
                      color: theme.color_heading || '#FFCFA4',
                      lineHeight: 1.1,
                    }
              }
            >
              Заголовок события
            </div>

            <p className="mt-3 text-sm" style={{ color: theme.color_body || '#fff' }}>
              Обычный текст лендинга. А это{' '}
              <span style={{ color: theme.color_link || '#FFCFA4' }}>ссылка</span>.
            </p>

            <div
              className="mt-4 p-4 text-sm"
              style={{
                borderRadius: radius,
                color: theme.color_body || '#fff',
                // Металл только в рамке — фон карточки прозрачный, иначе текст не читается.
                border: `1px solid ${theme.border_color || '#FFCFA4'}`,
                background: 'rgba(255,255,255,.02)',
              }}
            >
              <span className="font-bold" style={{ color: theme.icon_color || '#FFCFA4' }}>01</span>
              {'  '}Карточка спикера или пункт списка
            </div>

            <button
              className="mt-4 w-full px-6 py-3 text-sm font-bold uppercase"
              style={{
                borderRadius: radius,
                background: theme.btn_border_width
                  ? `${asLayer(btnFillPreview)} padding-box, ${
                      theme.btn_border_metallic
                        ? metallic(safe(theme.btn_border_color, '#FFCFA4'))
                        : `linear-gradient(${safe(theme.btn_border_color, '#FFCFA4')}, ${safe(theme.btn_border_color, '#FFCFA4')})`
                    } border-box`
                  : btnFillPreview,
                border: theme.btn_border_width
                  ? `${theme.btn_border_width}px solid transparent`
                  : undefined,
                color: theme.btn_text_color || '#0a1520',
                boxShadow: theme.btn_metallic
                  ? 'inset 0 1px 0 rgba(255,255,255,.45), 0 6px 18px rgba(0,0,0,.35)'
                  : undefined,
              }}
            >
              Участвовать
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Шрифты в превью подгружаются те же, что на лендинге.
          </p>
        </div>
      </div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <h3 className="mb-4 font-semibold text-gray-900">{title}</h3>
      {children}
    </div>
  )
}
