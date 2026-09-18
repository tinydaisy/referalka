'use client'

/**
 * Генератор афиши события: фон + настройки + автоматическая расстановка людей.
 *
 * ⚠️ ТРИ ОТДЕЛЬНЫХ МАКЕТА (горизонтальный, вертикальный, квадратный), а не один
 * в трёх размерах: на вертикальной афише спикеры идут по 4 в ряд и заголовок в
 * две строки, на горизонтальной — по 7 и в одну. Общие настройки заставили бы
 * выбирать компромисс, плохой везде.
 *
 * ⚠️ Предпросмотр и итоговый файл рисует ОДНО И ТО ЖЕ полотно `PosterCanvas`:
 * картинку снимает браузер с этой же вёрстки.
 */

import { useEffect, useMemo, useState } from 'react'
import { GripVertical } from 'lucide-react'
import { api } from '@/lib/api'
import { ensureBrandFonts } from '@/lib/brandStyle'
import FileUploader from '@/components/FileUploader'
import PosterCanvas, { POSTER_SIZE, type PosterLayout, type PosterOrientation, type PosterTheme } from './PosterCanvas'
import { applyManualOrder, ORGANIZER_ROLES, subscribersOf, type PosterPerson } from '@/lib/posterLayout'

const ORIENTATIONS: { key: PosterOrientation; label: string; ratio: string }[] = [
  { key: 'vertical',   label: 'Вертикальная', ratio: '9:16' },
  { key: 'horizontal', label: 'Горизонтальная', ratio: '16:9' },
  { key: 'square',     label: 'Квадратная',   ratio: '1:1' },
]

export default function PosterGeneratorBlock({ eventId }: { eventId: number }) {
  const [o, setO] = useState<PosterOrientation>('vertical')
  const [layout, setLayout] = useState<PosterLayout | null>(null)
  const [theme, setTheme] = useState<PosterTheme>({})
  const [people, setPeople] = useState<PosterPerson[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState<'' | 'png' | 'render'>('')
  const [err, setErr] = useState<string | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  // Пунктир границы полей — подсказка редактора, в макете не хранится.
  const [showMargins, setShowMargins] = useState(false)

  // ⚠️ Файл фирменных шрифтов подключён только на публичных страницах; в
  // кабинете его надо добавить самим, иначе в предпросмотре запасной шрифт.
  useEffect(() => { ensureBrandFonts() }, [])

  useEffect(() => {
    setLoading(true)
    api.posterLayout.get(eventId, o)
      .then((r: any) => {
        setLayout({ ...r.layout, orientation: o })
        setTheme(r.theme || {})
        setPeople(r.people || [])
        setErr(null)
      })
      .catch((e: any) => setErr(e?.message || 'Не удалось загрузить макет'))
      .finally(() => setLoading(false))
  }, [eventId, o])

  function patch(p: Partial<PosterLayout>) {
    setLayout(l => (l ? { ...l, ...p } : l))
    setSaved(false)
  }

  async function save() {
    if (!layout) return
    setSaving(true)
    try {
      const { orientation, ...body } = layout
      const r = await api.posterLayout.save(eventId, o, body)
      setLayout({ ...r, orientation: o })
      setSaved(true)
    } catch (e: any) { setErr(e?.message || 'Не удалось сохранить') }
    finally { setSaving(false) }
  }

  /** ⚠️ Перед снимком СОХРАНЯЕМ: картинку сервер рисует по базе, а не по экрану. */
  async function download() {
    if (!layout) return
    setBusy('png')
    try {
      const { orientation, ...body } = layout
      await api.posterLayout.save(eventId, o, body)
      await api.posterLayout.png(eventId, o)
    } catch (e: any) { setErr(e?.message || 'Не удалось собрать афишу') }
    finally { setBusy('') }
  }

  async function renderToLibrary() {
    if (!layout) return
    setBusy('render')
    try {
      const { orientation, ...body } = layout
      await api.posterLayout.save(eventId, o, body)
      await api.posterLayout.render(eventId, o)
      setErr(null)
      alert('Афиша собрана и добавлена в афиши события')
    } catch (e: any) { setErr(e?.message || 'Не удалось собрать афишу') }
    finally { setBusy('') }
  }

  // Люди, которых можно перетаскивать: организаторы стоят сверху всегда,
  // партнёры-компании идут логотипами — их порядок не переставляют.
  const draggable = useMemo(() => {
    const persons = people.filter(p => !p.is_company && !ORGANIZER_ROLES.includes(p.role))
    return applyManualOrder(persons, layout?.speaker_order || [])
  }, [people, layout?.speaker_order])

  function onDrop(targetId: number) {
    if (dragId == null || dragId === targetId) { setDragId(null); return }
    const list = draggable.map(p => p.id)
    const from = list.indexOf(dragId)
    const to = list.indexOf(targetId)
    if (from < 0 || to < 0) { setDragId(null); return }
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    patch({ speaker_order: list })
    setDragId(null)
  }

  if (loading || !layout) {
    return <div className="text-sm text-gray-400">Загрузка…</div>
  }

  const size = POSTER_SIZE[o]
  // Полотно настоящего размера в колонку кабинета не влезает — уменьшаем.
  const scale = o === 'horizontal' ? 0.28 : o === 'square' ? 0.3 : 0.22

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500 leading-relaxed">
        Загрузите фон, отметьте линию, с которой начинаются спикеры, — остальное соберётся само
        из карточек спикеров и партнёров события. Три вида афиши настраиваются отдельно.
      </p>

      {err && <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{err}</div>}

      {/* Выбор вида афиши. */}
      <div className="flex flex-wrap gap-2">
        {ORIENTATIONS.map(x => (
          <button key={x.key} onClick={() => setO(x.key)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                    o === x.key ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {x.label} <span className="opacity-60">{x.ratio}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col xl:flex-row gap-6">
        {/* Предпросмотр. ⚠️ Обёртка нужного размера: transform не меняет
            занимаемое место, и без неё под афишей осталась бы пустота. */}
        <div className="shrink-0">
          <div style={{ width: size.w * scale, height: size.h * scale }}
               className="overflow-hidden rounded-xl shadow-sm border card-border bg-gray-50">
            <PosterCanvas layout={layout} theme={theme} people={people} scale={scale}
                          showMargins={showMargins} />
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-500 mt-2">
            <input type="checkbox" checked={showMargins}
                   onChange={e => setShowMargins(e.target.checked)} />
            Показать границу полей (в готовый файл не попадёт)
          </label>

          <div className="flex flex-wrap items-center gap-3 mt-4">
            <button onClick={save} disabled={saving} className="btn-gold px-6 py-2.5 text-sm">
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
            <button onClick={download} disabled={!!busy} className="btn-primary px-5 py-2.5 text-sm">
              {busy === 'png' ? 'Собираем…' : 'Скачать PNG'}
            </button>
            <button onClick={renderToLibrary} disabled={!!busy}
                    className="text-sm text-gray-500 hover:text-gray-700 underline">
              {busy === 'render' ? 'Собираем…' : 'Собрать и добавить в афиши события'}
            </button>
            {saved && <span className="text-sm text-green-600">Сохранено</span>}
          </div>
        </div>

        {/* Настройки. */}
        <div className="flex-1 min-w-0 space-y-4">
          <Card title="Фон">
            <FileUploader
              mode="single"
              kind="poster_bg"
              eventId={eventId}
              value={layout.bg_url || null}
              onChange={(u: any) => patch({ bg_url: u || null })}
              aspectClass={o === 'horizontal' ? 'aspect-video' : o === 'square' ? 'aspect-square' : 'aspect-[9/16]'}
              emptyText="Фон не загружен — возьмётся градиент бренда"
              buttonLabel="Загрузить фон"
            />
            <Range label="Затемнение фона, %" value={layout.bg_dim ?? 0} min={0} max={90}
                   hint="По светлой картинке белые подписи не читаются"
                   onChange={v => patch({ bg_dim: v })} />
          </Card>

          <Card title="Поля от края">
            <p className="text-xs text-gray-500 mb-2 leading-relaxed">
              Рабочая область афиши. За эти поля не выходит ничего — ни спикеры с подписями,
              ни логотипы, ни заголовок.
            </p>
            <div className="grid grid-cols-2 gap-x-4">
              <MmField label="Сверху"  value={layout.margin_top ?? 10}    onChange={v => patch({ margin_top: v })} />
              <MmField label="Снизу"   value={layout.margin_bottom ?? 10} onChange={v => patch({ margin_bottom: v })} />
              <MmField label="Слева"   value={layout.margin_left ?? 10}   onChange={v => patch({ margin_left: v })} />
              <MmField label="Справа"  value={layout.margin_right ?? 10}  onChange={v => patch({ margin_right: v })} />
            </div>
            <div className="flex flex-wrap gap-2 mt-3">
              <span className="text-xs text-gray-400 self-center mr-1">Сразу все:</span>
              {[0, 5, 10, 15, 20].map(mm => (
                <button key={mm} type="button"
                        onClick={() => patch({ margin_top: mm, margin_bottom: mm, margin_left: mm, margin_right: mm })}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition">
                  {mm === 0 ? 'без полей' : `${mm} мм`}
                </button>
              ))}
            </div>
          </Card>

          <Card title="Где стоят спикеры">
            <Range label="Начинать с высоты, %" value={layout.speakers_top ?? 45} min={0} max={95}
                   hint="Линия, ниже которой начинается блок людей — чтобы они не легли на рисунок фона"
                   onChange={v => patch({ speakers_top: v })} />
            <Range label="Не ниже, %" value={layout.speakers_bottom ?? 97} min={5} max={100}
                   onChange={v => patch({ speakers_bottom: v })} />
            {/* ⚠️ Бывшая настройка «Поля по бокам, %» убрана (миграция 440):
                боковой отступ теперь общий для всей афиши и задаётся выше в мм.
                Две настройки одного отступа означали бы вопрос «почему спикеры
                отступают не так, как заголовок». */}
            <Range label="Промежуток между фото, %" value={layout.gap ?? 2} min={0} max={20}
                   onChange={v => patch({ gap: v })} />
            <div className="mt-3">
              <div className="mb-1 text-xs text-gray-600">Сколько в ряду</div>
              <div className="flex items-center gap-2">
                <input type="number" min={1} max={12}
                       value={layout.per_row ?? ''}
                       placeholder="авто"
                       onChange={e => patch({ per_row: e.target.value ? Number(e.target.value) : null })}
                       className="w-24 rounded-lg border border-gray-200 px-3 py-1.5 text-sm" />
                <span className="text-xs text-gray-400">пусто — подберём сами под количество</span>
              </div>
            </div>
          </Card>

          <Card title="Форма фото">
            <Choice value={layout.mask_shape || 'portrait'}
                    onChange={v => patch({ mask_shape: v as any })}
                    options={[
                      ['portrait', 'Прямоугольник'],
                      ['square', 'Квадрат'],
                      ['circle', 'Круг'],
                      ['oval', 'Овал'],
                      ['egg', 'Яйцо'],
                      ['cutout', 'Вырезанные, без рамок'],
                    ]} />
            {layout.mask_shape === 'cutout' ? (
              <>
                <p className="mt-2 text-xs text-gray-400 leading-relaxed">
                  Берутся фото на прозрачном фоне из карточек спикеров. Люди стоят плотной группой,
                  задний ряд выглядывает из-за переднего.
                </p>
                <Range label="Наложение рядов, %" value={layout.row_overlap ?? 0} min={0} max={60}
                       onChange={v => patch({ row_overlap: v })} />
              </>
            ) : (
              <Range label="Скругление углов, %" value={layout.mask_radius ?? 0} min={0} max={50}
                     onChange={v => patch({ mask_radius: v })} />
            )}
          </Card>

          <Card title="Подписи имён">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={layout.show_names !== false}
                     onChange={e => patch({ show_names: e.target.checked })} />
              Показывать имена
            </label>
            {layout.show_names !== false && (
              <>
                <div className="mt-3">
                  <div className="mb-1 text-xs text-gray-600">Порядок слов</div>
                  <Choice value={layout.name_order || 'first_last'}
                          onChange={v => patch({ name_order: v as any })}
                          options={[['first_last', 'Имя Фамилия'], ['last_first', 'Фамилия Имя']]} />
                </div>
                <div className="mt-3">
                  <div className="mb-1 text-xs text-gray-600">Строк</div>
                  <Choice value={String(layout.name_lines ?? 2)}
                          onChange={v => patch({ name_lines: Number(v) as 1 | 2 })}
                          options={[['1', 'В одну строку'], ['2', 'В две строки']]} />
                </div>
                <div className="mt-3">
                  <div className="mb-1 text-xs text-gray-600">Где подпись</div>
                  <Choice value={layout.name_place || 'below'}
                          onChange={v => patch({ name_place: v as any })}
                          options={[['below', 'Под фото'], ['over', 'Поверх фото']]} />
                </div>
                <Range label="Размер, % ширины афиши" value={layout.name_size ?? 1.6} min={0.3} max={8}
                       onChange={v => patch({ name_size: v })} />
                <ColorRow label="Цвет подписи" value={layout.name_color}
                          onChange={v => patch({ name_color: v })} />
                <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                  <input type="checkbox" checked={!!layout.name_shadow}
                         onChange={e => patch({ name_shadow: e.target.checked })} />
                  Тень под подписью
                </label>
                <p className="text-xs text-gray-400 mt-1">
                  У вырезанных спикеров и подписей поверх фото тень включается сама — иначе
                  на светлой одежде буквы пропадают.
                </p>
              </>
            )}
          </Card>

          <Card title="Выделение организатора и хедлайнера">
            <Choice value={layout.hl_style || 'border'}
                    onChange={v => patch({ hl_style: v as any })}
                    options={[['none', 'Никак'], ['border', 'Рамка'], ['glow', 'Свечение'], ['both', 'Рамка и свечение']]} />
            {layout.hl_style !== 'none' && (
              <>
                <ColorRow label="Цвет выделения" value={layout.hl_color}
                          placeholder="золото бренда"
                          onChange={v => patch({ hl_color: v })} />
                {(layout.hl_style === 'border' || layout.hl_style === 'both') && (
                  <Range label="Толщина рамки, %" value={layout.hl_border_w ?? 0.3} min={0} max={3}
                         onChange={v => patch({ hl_border_w: v })} />
                )}
                {(layout.hl_style === 'glow' || layout.hl_style === 'both') && (
                  <Range label="Размах свечения, %" value={layout.hl_glow ?? 1.5} min={0} max={10}
                         onChange={v => patch({ hl_glow: v })} />
                )}
              </>
            )}
            <div className="mt-4">
              <div className="mb-1 text-xs text-gray-600">Как подписать роль</div>
              <Choice value={layout.role_badge || 'pill'}
                      onChange={v => patch({ role_badge: v as any })}
                      options={[
                        ['none', 'Не подписывать'],
                        ['pill', 'Плашкой над именем'],
                        ['ribbon', 'Лентой через угол'],
                        ['suffix', 'Через тире после имени'],
                      ]} />
              <p className="text-xs text-gray-400 mt-2 leading-relaxed">
                Место под плашку резервируется у всех карточек — имена всех людей остаются
                на одном уровне.
              </p>
              <ColorRow label="Цвет плашки" value={layout.role_badge_color}
                        placeholder="золото бренда"
                        onChange={v => patch({ role_badge_color: v })} />
            </div>
          </Card>

          <Card title="Заголовок и подзаголовок">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={layout.show_title !== false}
                     onChange={e => patch({ show_title: e.target.checked })} />
              Показывать заголовок
            </label>
            {layout.show_title !== false && (
              <>
                <input value={layout.title || ''} placeholder="Название события"
                       onChange={e => patch({ title: e.target.value })}
                       className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                <Range label="Размер, %" value={layout.title_size ?? 6} min={1} max={20}
                       onChange={v => patch({ title_size: v })} />
                <ColorRow label="Цвет" value={layout.title_color}
                          placeholder="цвет бренда"
                          onChange={v => patch({ title_color: v })} />
                <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                  <input type="checkbox" checked={layout.title_metallic !== false}
                         onChange={e => patch({ title_metallic: e.target.checked })} />
                  Металлический отлив
                </label>
                <div className="mt-3">
                  <div className="mb-1 text-xs text-gray-600">Подчёркивание</div>
                  <Choice value={layout.title_underline || 'none'}
                          onChange={v => patch({ title_underline: v as any })}
                          options={[['none', 'Нет'], ['line', 'Линия'], ['gradient', 'Линия градиентом']]} />
                </div>
                <FontPicker theme={theme} value={layout.title_font}
                            onChange={v => patch({ title_font: v })} />
              </>
            )}

            <div className="mt-5 pt-4 border-t border-gray-100">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={layout.show_subtitle !== false}
                       onChange={e => patch({ show_subtitle: e.target.checked })} />
                Показывать подзаголовок
              </label>
              {layout.show_subtitle !== false && (
                <>
                  <textarea value={layout.subtitle || ''} rows={2}
                            placeholder="Подзаголовок"
                            onChange={e => patch({ subtitle: e.target.value })}
                            className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                  <Range label="Размер, %" value={layout.subtitle_size ?? 2.4} min={0.5} max={12}
                         onChange={v => patch({ subtitle_size: v })} />
                  <ColorRow label="Цвет" value={layout.subtitle_color}
                            placeholder="цвет бренда"
                            onChange={v => patch({ subtitle_color: v })} />
                  <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                    <input type="checkbox" checked={!!layout.subtitle_metallic}
                           onChange={e => patch({ subtitle_metallic: e.target.checked })} />
                    Металлический отлив
                  </label>
                  <FontPicker theme={theme} value={layout.subtitle_font}
                              onChange={v => patch({ subtitle_font: v })} />
                </>
              )}
            </div>

            <Range label="Высота текстового блока, %" value={layout.text_top ?? 18} min={0} max={100}
                   onChange={v => patch({ text_top: v })} />
          </Card>

          <Card title="Пилюля с датой и форматом">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={layout.show_pill !== false}
                     onChange={e => patch({ show_pill: e.target.checked })} />
              Показывать
            </label>
            {layout.show_pill !== false && (
              <>
                <input value={layout.pill_text || ''} placeholder="23–24 апреля"
                       onChange={e => patch({ pill_text: e.target.value })}
                       className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                <input value={layout.pill_text_2 || ''} placeholder="Онлайн-конференция"
                       onChange={e => patch({ pill_text_2: e.target.value })}
                       className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                <div className="mt-3">
                  <div className="mb-1 text-xs text-gray-600">Оформление</div>
                  <Choice value={layout.pill_style || 'border'}
                          onChange={v => patch({ pill_style: v as any })}
                          options={[
                            ['border', 'Рамка'], ['filled', 'Заливка'],
                            ['underline', 'Подчёркивание'], ['plain', 'Просто текст'],
                          ]} />
                </div>
                {layout.pill_style === 'border' && (
                  <>
                    <Range label="Скругление" value={layout.pill_radius ?? 50} min={0} max={50}
                           onChange={v => patch({ pill_radius: v })} />
                    <ColorRow label="Цвет рамки" value={layout.pill_border_color}
                              placeholder="золото бренда"
                              onChange={v => patch({ pill_border_color: v })} />
                    <ColorRow label="Второй цвет (рамка градиентом)" value={layout.pill_border_color_2}
                              placeholder="без градиента"
                              onChange={v => patch({ pill_border_color_2: v })} />
                  </>
                )}
                <ColorRow label="Цвет текста" value={layout.pill_text_color}
                          onChange={v => patch({ pill_text_color: v })} />
                <Range label="Размер, %" value={layout.pill_size ?? 1.8} min={0.3} max={8}
                       onChange={v => patch({ pill_size: v })} />
              </>
            )}
          </Card>

          <Card title="Логотипы">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={layout.show_brand_logo !== false}
                     onChange={e => patch({ show_brand_logo: e.target.checked })} />
              Логотип бренда
            </label>
            {layout.show_brand_logo !== false && (
              <>
                <Choice value={layout.brand_logo_variant || 'light'}
                        onChange={v => patch({ brand_logo_variant: v as any })}
                        options={[['light', 'Для тёмного фона'], ['dark', 'Для светлого фона']]} />
                <Range label="По горизонтали, %" value={layout.brand_logo_x ?? 50} min={0} max={100}
                       onChange={v => patch({ brand_logo_x: v })} />
                <Range label="По вертикали, %" value={layout.brand_logo_y ?? 5} min={0} max={100}
                       onChange={v => patch({ brand_logo_y: v })} />
                <Range label="Размер, %" value={layout.brand_logo_size ?? 6} min={1} max={30}
                       onChange={v => patch({ brand_logo_size: v })} />
              </>
            )}
            <label className="flex items-center gap-2 text-sm text-gray-700 mt-4 pt-4 border-t border-gray-100">
              <input type="checkbox" checked={layout.show_partners !== false}
                     onChange={e => patch({ show_partners: e.target.checked })} />
              Логотипы партнёров сверху
            </label>
            <p className="text-xs text-gray-400 mt-1 leading-relaxed">
              Сюда попадают партнёры с галочкой «Компания». Партнёры-люди идут в общую
              сетку со спикерами — со своим фото.
            </p>
            {layout.show_partners !== false && (
              <>
                <Range label="Высота, %" value={layout.partners_y ?? 5} min={0} max={100}
                       onChange={v => patch({ partners_y: v })} />
                <Range label="Размер, %" value={layout.partners_size ?? 5} min={1} max={20}
                       onChange={v => patch({ partners_size: v })} />
              </>
            )}
          </Card>
        </div>
      </div>

      {/* Порядок спикеров — перетаскиванием, как блоки лендинга. */}
      <Card title="Порядок спикеров">
        <p className="text-xs text-gray-500 mb-3 leading-relaxed">
          Перетащите за ⠿, чтобы поменять порядок — афиша перестроится сразу.
          Организаторы всегда стоят сверху по центру, их порядок не меняется.
          {!layout.speaker_order?.length && (
            <> Сейчас порядок автоматический: самые крупные по подписчикам — по краям,
            ближе к организаторам, коммерческие — в середине.</>
          )}
        </p>
        {layout.speaker_order?.length ? (
          <button onClick={() => patch({ speaker_order: [] })}
                  className="text-xs text-gray-400 hover:text-gray-600 underline mb-3">
            Вернуть автоматический порядок
          </button>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {draggable.map(p => (
            <PersonChip key={p.id} p={p}
                        isDragging={dragId === p.id}
                        onDragStart={() => setDragId(p.id)}
                        onDragOver={e => e.preventDefault()}
                        onDrop={() => onDrop(p.id)} />
          ))}
          {draggable.length === 0 && (
            <p className="text-sm text-gray-400">
              У события пока нет спикеров с фотографиями.
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}

/** Карточка человека в списке перетаскивания. */
function PersonChip({ p, isDragging, onDragStart, onDragOver, onDrop }: {
  p: PosterPerson
  isDragging: boolean
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
}) {
  // ⚠️ `draggable` включается ТОЛЬКО когда мышь на ручке ⠿ — тот же приём, что
  // у блоков лендинга: иначе браузер тащит карточку при выделении текста.
  const [canDrag, setCanDrag] = useState(false)
  const subs = subscribersOf(p)
  return (
    <div
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragEnd={() => setCanDrag(false)}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`flex items-center gap-2 rounded-lg border bg-white px-2 py-1.5 transition-shadow ${
        isDragging ? 'opacity-40 border-[#FFCFA4]' : 'border-gray-200'}`}
    >
      <span
        onMouseDown={() => setCanDrag(true)}
        onMouseUp={() => setCanDrag(false)}
        onMouseLeave={() => setCanDrag(false)}
        title="Перетащите, чтобы поменять порядок"
        className="shrink-0 cursor-grab active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4 text-[#25455D]/50" />
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.photo_url || p.cutout_photo_url || ''} alt=""
           className="w-7 h-7 rounded-full object-cover shrink-0"
           style={{ objectPosition: p.photo_focal || '50% 33%' }} />
      <div className="min-w-0">
        <div className="text-xs font-medium text-gray-800 truncate max-w-[140px]">
          {[p.name, p.last_name].filter(Boolean).join(' ')}
        </div>
        <div className="text-[10px] text-gray-400">
          {p.role === 'headliner' ? 'Хедлайнер · ' : p.is_commercial ? 'Коммерческий · ' : ''}
          {subs > 0 ? `${subs.toLocaleString('ru-RU')} подписчиков` : 'нет данных'}
        </div>
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
  // Дробный шаг у маленьких диапазонов: толщину рамки в 0,3 % целыми не задать.
  const step = max <= 10 ? 0.1 : 1
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-xs text-gray-600">
        <span>{label}</span><span className="text-gray-400">{value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} className="w-full"
             onChange={e => onChange(Number(e.target.value))} />
      {hint && <div className="mt-0.5 text-xs text-gray-400">{hint}</div>}
    </div>
  )
}

/** Поле в миллиметрах. Дробные значения допустимы (2.5 мм — законное поле). */
function MmField({ label, value, onChange }: {
  label: string; value: number; onChange: (v: number) => void
}) {
  return (
    <div className="mt-2">
      <div className="mb-1 text-xs text-gray-600">{label}</div>
      <div className="flex items-center gap-1.5">
        <input type="number" min={0} max={60} step={0.5} value={value}
               onChange={e => {
                 const n = Number(e.target.value)
                 // ⚠️ Пустое поле даёт NaN — записав его, мы сломали бы всю
                 // раскладку (ширина области стала бы NaN). Пусто = 0 мм.
                 onChange(Number.isFinite(n) ? Math.max(0, Math.min(60, n)) : 0)
               }}
               className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-sm" />
        <span className="text-xs text-gray-400">мм</span>
      </div>
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

/** Цвет: палитра + поле. Пусто — берётся цвет бренда. */
function ColorRow({ label, value, placeholder, onChange }: {
  label: string; value?: string | null; placeholder?: string
  onChange: (v: string | null) => void
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs text-gray-600">{label}</div>
      <div className="flex items-center gap-2">
        <input type="color" value={value || '#FFCFA4'}
               onChange={e => onChange(e.target.value)}
               className="h-8 w-10 rounded border border-gray-200 bg-white p-0.5" />
        <input value={value || ''} placeholder={placeholder || 'по умолчанию'}
               onChange={e => onChange(e.target.value || null)}
               className="w-32 rounded-lg border border-gray-200 px-2 py-1.5 text-xs" />
        {value && (
          <button onClick={() => onChange(null)}
                  className="text-xs text-gray-400 hover:text-gray-600 underline">сброс</button>
        )}
      </div>
    </div>
  )
}

/** Выбор шрифта из фирменного справочника темы. */
function FontPicker({ theme, value, onChange }: {
  theme: PosterTheme; value?: string | null; onChange: (v: string | null) => void
}) {
  const fonts = theme.fonts || []
  if (!fonts.length) return null
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs text-gray-600">Шрифт</div>
      <select value={value || ''}
              onChange={e => onChange(e.target.value || null)}
              className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm">
        <option value="">Как в стилях бренда</option>
        {fonts.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
      </select>
    </div>
  )
}
