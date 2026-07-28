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

/** Металлический перелив из цвета — тот же расчёт, что на самом лендинге. */
function metallic(color: string): string {
  return `linear-gradient(135deg, ${color} 0%, #ffffff 22%, ${color} 45%, ${shade(color, -18)} 70%, ${color} 100%)`
}
function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex || '#000000'
  const n = parseInt(m[1], 16)
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + (v * pct) / 100)))
  return `#${[f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]
    .map(v => v.toString(16).padStart(2, '0')).join('')}`
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
        setTheme(res.theme || {})
        setFonts(res.fonts || [])
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

  const bg = theme.bg_gradient && theme.bg_color_2
    ? `linear-gradient(${theme.bg_angle ?? 45}deg, ${theme.bg_color || '#25455D'}, ${theme.bg_color_2})`
    : (theme.bg_color || '#25455D')

  const radius = theme.radius ?? 5

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
            </div>
          </Card>

          <Card title="Кнопки">
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField label="Цвет кнопки" value={theme.btn_color}
                onChange={v => set({ btn_color: v })} />
              <ColorField label="Цвет текста на кнопке" value={theme.btn_text_color}
                onChange={v => set({ btn_text_color: v })} />
            </div>
            <div className="mt-3">
              <MetallicToggle label="Металлический градиент на кнопках"
                checked={!!theme.btn_metallic} onChange={v => set({ btn_metallic: v })} />
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
                      background: metallic(theme.color_heading || '#FFCFA4'),
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
                border: theme.border_metallic ? '1px solid transparent' : `1px solid ${theme.border_color || '#FFCFA4'}`,
                background: theme.border_metallic
                  ? `linear-gradient(rgba(255,255,255,.04), rgba(255,255,255,.04)) padding-box, ${metallic(theme.border_color || '#FFCFA4')} border-box`
                  : 'rgba(255,255,255,.04)',
              }}
            >
              <span className="font-bold" style={{ color: theme.icon_color || '#FFCFA4' }}>01</span>
              {'  '}Карточка спикера или пункт списка
            </div>

            <button
              className="mt-4 w-full px-6 py-3 text-sm font-bold uppercase"
              style={{
                borderRadius: radius,
                background: theme.btn_metallic
                  ? metallic(theme.btn_color || '#FFCFA4')
                  : (theme.btn_color || '#FFCFA4'),
                color: theme.btn_text_color || '#0a1520',
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
