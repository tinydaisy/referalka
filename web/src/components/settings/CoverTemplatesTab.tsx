'use client'

/**
 * Шаблоны обложек — «как выглядит обложка по умолчанию» (миграция 387).
 *
 * ⚠️ Полотно рисует общий `CoverCanvas` — тот же компонент, с которого браузер
 * снимает готовый PNG. Своей вёрстки предпросмотра здесь нет: она разошлась бы
 * с файлом, и клиент правил бы одно, а получал другое.
 *
 * ⚠️ Цвета, шрифты и логотипы НЕ настраиваются здесь — они берутся из «Стилей
 * бренда и лендинга». Иначе фирменный цвет пришлось бы менять в двух местах, и однажды
 * лендинги оказались бы одного цвета, а обложки другого.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import FileUploader from '@/components/FileUploader'
import CoverCanvas, { COVER_W, COVER_H, type CoverTemplate, type CoverTheme } from '@/components/covers/CoverCanvas'
import { ensureBrandFonts } from '@/lib/brandStyle'

type Kind = 'material' | 'speaker'

// Что показываем в предпросмотре вместо настоящих данных.
const SAMPLE: Record<Kind, { title: string; subtitle?: string; overline?: string }> = {
  material: { title: 'ЗДЕСЬ БУДЕТ НАЗВАНИЕ ВАШЕГО МАТЕРИАЛА' },
  speaker: { title: 'ИМЯ ФАМИЛИЯ', subtitle: 'спикер', overline: 'Название конференции' },
}

export default function CoverTemplatesTab() {
  const [kind, setKind] = useState<Kind>('material')
  const [tpl, setTpl] = useState<CoverTemplate | null>(null)
  const [theme, setTheme] = useState<CoverTheme>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [downloading, setDownloading] = useState(false)

  // ⚠️ Файл фирменных шрифтов подключён только на публичных страницах — в
  // кабинете его надо добавить самим, иначе превью рисуется запасным шрифтом
  // и выглядит «не тем», хотя в теме выбран правильный.
  useEffect(() => { ensureBrandFonts() }, [])

  useEffect(() => {
    setLoading(true)
    api.coverTemplates.get(kind)
      // ⚠️ Сливаем, а не заменяем: справочник шрифтов приезжает вторым
      // запросом, и замена целиком стирала бы его при смене вида шаблона —
      // превью моргало бы запасным шрифтом.
      .then((r: any) => { setTpl(r.template); setTheme(t => ({ ...t, ...(r.theme || {}) })) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [kind])

  // Справочник шрифтов: в теме лежит ключ (`BebasNeue`), а семейство в CSS
  // называется иначе («Bebas Neue»). Берём тот же список, что и «Стили».
  useEffect(() => {
    api.landingTheme.get()
      .then((r: any) => setTheme(t => ({ ...t, fonts: r?.fonts || [] })))
      .catch(() => {})
  }, [])

  function patch(p: Partial<CoverTemplate>) {
    setTpl(t => (t ? { ...t, ...p } : t))
    setSaved(false)
  }

  async function save() {
    if (!tpl) return
    setSaving(true)
    try {
      const r = await api.coverTemplates.save(kind, tpl)
      setTpl(r)
      setSaved(true)
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  // ⚠️ Перед снимком СОХРАНЯЕМ: картинку рисует сервер по тому, что лежит в
  // базе, а не по тому, что на экране. Без этого клиент подвинул бы фото,
  // нажал «Скачать» и получил старую раскладку.
  async function download() {
    if (!tpl) return
    setDownloading(true)
    try {
      await api.coverTemplates.save(kind, tpl)
      const s = SAMPLE[kind]
      await api.coverTemplates.png(kind, {
        title: s.title, subtitle: s.subtitle || '', overline: s.overline || '',
        photo: theme.sample_photo_url || '',
      })
    } catch (e: any) {
      alert(e?.message || 'Не удалось собрать картинку')
    } finally {
      setDownloading(false)
    }
  }

  if (loading || !tpl) {
    return <div className="p-4 text-sm text-gray-400">Загружаем…</div>
  }

  const s = SAMPLE[kind]
  // Полотно 1280 px в колонку кабинета не влезает — показываем уменьшенным.
  const scale = 0.5

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Шаблоны обложек</h2>
        <p className="mt-1 text-sm text-gray-500">
          Обложка собирается сама — для записей эфиров и материалов. Цвета, шрифты
          и логотип берутся из «Стилей бренда и лендинга», здесь настраивается раскладка.
        </p>
      </div>

      {/* Вид шаблона. ⚠️ Два разных, а не галочки в одном: у материала главное —
          название, у спикера — имя, роль и конференция. */}
      <div className="flex gap-2">
        {(['material', 'speaker'] as Kind[]).map(k => (
          <button key={k} onClick={() => setKind(k)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                    kind === k ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {k === 'material' ? 'Записи и материалы' : 'Спикеры'}
          </button>
        ))}
      </div>

      {/* Предпросмотр. Обёртка нужна, чтобы уменьшенное полотно не оставляло
          пустое место: transform не меняет занимаемый размер. */}
      <div style={{ width: COVER_W * scale, height: COVER_H * scale }}
           className="overflow-hidden rounded-xl shadow-sm">
        <CoverCanvas
          template={tpl} theme={theme} scale={scale}
          title={s.title} subtitle={s.subtitle} overline={s.overline}
          photoUrl={theme.sample_photo_url}
        />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {/* ── Фон ── */}
        <Card title="Фон">
          <p className="mb-3 text-xs text-gray-500">
            Пусто — берётся фирменный фон из «Стилей бренда и лендинга».
          </p>
          <FileUploader
            mode="single" kind="cover_bg"
            value={tpl.bg_url || null}
            aspectClass="aspect-video"
            onChange={(url: string | null) => patch({ bg_url: url || null })}
          />
          {!!tpl.bg_url && (
            <Range label="Затемнение фона" value={tpl.bg_dim ?? 0} min={0} max={90}
                   hint="По светлой картинке текст не читается"
                   onChange={v => patch({ bg_dim: v })} />
          )}
        </Card>

        {/* ── Логотип ── */}
        <Card title="Логотип">
          <Choice
            value={tpl.logo_variant || 'light'}
            onChange={v => patch({ logo_variant: v as any })}
            options={[
              ['light', 'Светлый'],
              ['dark', 'Тёмный'],
              ['none', 'Без логотипа'],
            ]}
          />
          {tpl.logo_variant !== 'none' && (<>
            <Range label="Размер" value={tpl.logo_size ?? 7} min={2} max={30}
                   onChange={v => patch({ logo_size: v })} />
            <Range label="По горизонтали" value={tpl.logo_x ?? 88} min={0} max={100}
                   onChange={v => patch({ logo_x: v })} />
            <Range label="По вертикали" value={tpl.logo_y ?? 6} min={0} max={100}
                   onChange={v => patch({ logo_y: v })} />
          </>)}
          <p className="mt-2 text-xs text-gray-500">
            Логотипы загружаются в «Mini App» → «Бренд».
          </p>
        </Card>

        {/* ── Фото ── */}
        <Card title="Фото на прозрачном фоне">
          <Choice
            value={tpl.photo_side || 'left'}
            onChange={v => patch({ photo_side: v as any })}
            options={[['left', 'Слева'], ['right', 'Справа'], ['none', 'Не показывать']]}
          />
          {tpl.photo_side !== 'none' && (<>
            <Range label="Размер" value={tpl.photo_scale ?? 100} min={30} max={200}
                   onChange={v => patch({ photo_scale: v })} />
            <Range label="Сдвиг вбок" value={tpl.photo_x ?? 0} min={-100} max={100}
                   onChange={v => patch({ photo_x: v })} />
            <Range label="Сдвиг вверх" value={tpl.photo_y ?? 0} min={-100} max={100}
                   onChange={v => patch({ photo_y: v })} />
          </>)}
          <p className="mt-2 text-xs text-gray-500">
            Фото берётся из карточки человека. Нет фото — текст встаёт по центру.
          </p>
        </Card>

        {/* ── Текст ── */}
        <Card title="Заголовок">
          <Range label="Отступ слева" value={tpl.text_x ?? 50} min={0} max={100}
                 onChange={v => patch({ text_x: v })} />
          <Range label="Положение по высоте" value={tpl.text_y ?? 50} min={0} max={100}
                 onChange={v => patch({ text_y: v })} />
          <Range label="Ширина области" value={tpl.text_w ?? 45} min={10} max={100}
                 onChange={v => patch({ text_w: v })} />
          <Range label="Размер шрифта" value={tpl.title_size ?? 8} min={3} max={20}
                 onChange={v => patch({ title_size: v })} />
          <div className="mt-3">
            <Choice
              value={tpl.text_align || 'left'}
              onChange={v => patch({ text_align: v as any })}
              options={[['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа']]}
            />
          </div>
        </Card>

        {/* ── Подписи ── */}
        <Card title="Имя и бренд">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={!!tpl.show_owner_name}
                   onChange={e => patch({ show_owner_name: e.target.checked })} />
            Имя
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={(tpl.show_brand_name ?? tpl.show_brand) !== false}
                   onChange={e => patch({ show_brand_name: e.target.checked })} />
            Название бренда
          </label>
          <div className="mt-3">
            <div className="mb-1 text-xs text-gray-600">Где разместить</div>
            <Choice
              value={tpl.brand_position || 'below'}
              onChange={v => patch({ brand_position: v as any })}
              options={[['above', 'Над названием'], ['below', 'Под названием'], ['none', 'Не показывать']]}
            />
          </div>
        </Card>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="btn-gold px-6 py-2.5 text-sm">
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button onClick={download} disabled={downloading}
                className="btn-primary px-5 py-2.5 text-sm">
          {downloading ? 'Собираем картинку…' : 'Скачать PNG'}
        </button>
        {saved && <span className="text-sm text-green-600">Сохранено</span>}
      </div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-gray-800">{title}</div>
      {children}
    </div>
  )
}

function Range({ label, value, min, max, hint, onChange }: {
  label: string; value: number; min: number; max: number; hint?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
        <span>{label}</span><span className="text-gray-400">{value}</span>
      </div>
      <input type="range" min={min} max={max} value={value} className="w-full"
             onChange={e => onChange(Number(e.target.value))} />
      {hint && <div className="mt-0.5 text-xs text-gray-400">{hint}</div>}
    </div>
  )
}

function Choice({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: [string, string][]
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  value === v ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
          {label}
        </button>
      ))}
    </div>
  )
}
