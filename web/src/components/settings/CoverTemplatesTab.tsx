'use client'

/**
 * Шаблоны обложек — «как выглядит обложка по умолчанию» (миграция 387).
 *
 * ⚠️ Полотно рисует общий `CoverCanvas` — тот же компонент, с которого браузер
 * снимает готовый PNG. Своей вёрстки предпросмотра здесь нет: она разошлась бы
 * с файлом, и клиент правил бы одно, а получал другое.
 *
 * ⚠️ Цвета, шрифты и логотипы НЕ настраиваются здесь — они берутся из «Стилей
 * лендингов». Иначе фирменный цвет пришлось бы менять в двух местах, и однажды
 * лендинги оказались бы одного цвета, а обложки другого.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import FileUploader from '@/components/FileUploader'
import CoverCanvas, { COVER_W, COVER_H, type CoverTemplate, type CoverTheme } from '@/components/covers/CoverCanvas'

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
  const [photo, setPhoto] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    api.coverTemplates.get(kind)
      .then((r: any) => { setTpl(r.template); setTheme(r.theme || {}) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [kind])

  // Фото для предпросмотра — любая вырезка из базы коллабораторов. Пусто →
  // показываем раскладку «без фото», она тоже настоящая.
  useEffect(() => {
    api.collaborators.list('', 'name')
      .then((r: any) => {
        const withCutout = (r?.collaborators || r || []).find((c: any) => c.cutout_photo_url)
        setPhoto(withCutout?.cutout_photo_url || null)
      })
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
          и логотип берутся из «Стилей лендингов», здесь настраивается раскладка.
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
          photoUrl={photo}
        />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {/* ── Фон ── */}
        <Card title="Фон">
          <p className="mb-3 text-xs text-gray-500">
            Пусто — берётся фирменный фон из «Стилей лендингов».
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
          <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={tpl.show_brand !== false}
                   onChange={e => patch({ show_brand: e.target.checked })} />
            Показывать название бренда
          </label>
        </Card>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="btn-gold px-6 py-2.5 text-sm">
          {saving ? 'Сохраняем…' : 'Сохранить'}
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
