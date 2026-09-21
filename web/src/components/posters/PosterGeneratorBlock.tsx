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

import { useEffect, useMemo, useRef, useState } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import { GripVertical } from 'lucide-react'
import { api } from '@/lib/api'
import { ensureBrandFonts } from '@/lib/brandStyle'
import FileUploader from '@/components/FileUploader'
import PosterCanvas, { POSTER_SIZE, type PosterLayout, type PosterOrientation, type PosterTheme } from './PosterCanvas'
import { applyManualOrder, applyManualRows, splitIntoRows, ORGANIZER_ROLES, subscribersOf, type PosterPerson } from '@/lib/posterLayout'

/** Разделы генератора: общие афиши, афиши по дням, индивидуальные.
 *  ⚠️ У каждого вида СВОИ настройки (миграция 459): на общей четырнадцать лиц
 *  сеткой, на индивидуальной одно крупное фото — общий макет пришлось бы
 *  перекраивать при каждом переключении. */
type PosterKind = 'common' | 'day' | 'individual'
const KIND_TABS: { key: PosterKind; label: string; hint: string }[] = [
  { key: 'common',     label: 'Общие афиши',        hint: 'Все спикеры события на одной афише' },
  { key: 'day',        label: 'Афиши по дням',      hint: 'На каждый день — свои спикеры, без повторов' },
  { key: 'individual', label: 'Индивидуальные',     hint: 'Отдельная афиша каждому спикеру: тема и время' },
]

/** День события со спикерами — приходит с бэкенда уже без дублей. */
type DayInfo = {
  day: number
  label: string
  speaker_ids: number[]
}

/** Вкладки настроек. ⚠️ Через useUrlTab, а не useState: правило проекта —
 *  обновление страницы не должно сбрасывать на первую вкладку. */
type SetTab = 'bg' | 'speakers' | 'text' | 'logos' | 'place' | 'order'

/** ⚠️⚠️ У АФИШИ СПИКЕРА — СВОИ ПОДВКЛАДКИ, ПО ОДНОЙ НА ЭЛЕМЕНТ (требование
 *  владельца 20.09.2026). Раньше настройки одного и того же элемента лежали в
 *  разных местах: размер и цвет темы — во вкладке «Спикеры», а её положение —
 *  во вкладке «Где что стоит». Чтобы подвинуть тему и перекрасить её, надо
 *  было ходить туда-сюда и помнить, где что; «устройство непонятное».
 *  Теперь всё про элемент собрано в одном месте. */
type IndTab = 'bg' | 'photo' | 'title' | 'role' | 'name' | 'topic' | 'elements' | 'logos'
const IND_TABS: { key: IndTab; label: string }[] = [
  { key: 'bg',    label: 'Фон и поля' },
  { key: 'photo', label: 'Фото спикера' },
  { key: 'title', label: 'Название конфы' },
  { key: 'role',  label: 'Роль' },
  { key: 'name',  label: 'Имя и фамилия' },
  { key: 'topic', label: 'Тема и время' },
  { key: 'elements', label: 'Свои элементы' },
  { key: 'logos', label: 'Логотипы' },
]
const SET_TABS: { key: SetTab; label: string }[] = [
  { key: 'bg',       label: 'Фон и поля' },
  { key: 'speakers', label: 'Спикеры' },
  { key: 'text',     label: 'Заголовок и дата' },
  { key: 'logos',    label: 'Логотип и партнёры' },
  { key: 'place',    label: 'Где что стоит' },
  { key: 'order',    label: 'Порядок по рядам' },
]

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
  // Крупный просмотр афиши: на маленьком превью не видно ни лиц, ни подписей.
  const [zoom, setZoom] = useState(false)
  const [suggested, setSuggested] = useState<any>(null)
  const [dragLogo, setDragLogo] = useState<string | null>(null)
  const [tab, setTab] = useUrlTab<SetTab>('pset', 'bg', ['bg','speakers','text','logos','place','order'])
  // ⚠️ Раздел — тоже через useUrlTab: обновил страницу и остался там же, где был.
  const [kind, setKind] = useUrlTab<PosterKind>('pkind', 'common', ['common','day','individual'])
  // Подвкладка редактора афиши спикера — тоже через useUrlTab.
  const [indTab, setIndTab] = useUrlTab<IndTab>(
    'pind', 'bg', ['bg','photo','title','role','name','topic','elements','logos'])
  // Дни события и выступления — нужны дневным и индивидуальным афишам.
  const [days, setDays] = useState<DayInfo[]>([])
  // ⚠️ Тип совпадает с `PosterCanvas`: `slots` и `topics` — все выступления
  // человека. Разойдутся типы — сборка упадёт на первом же обращении.
  const [sessions, setSessions] = useState<Record<string, {
    topic?: string; when?: string; day?: number; slots?: string[]; topics?: string[]
    all_items?: { id: number; when: string; topic: string; chosen: boolean }[]
  }>>({})
  // Кого показываем в индивидуальной афише. Пусто — первого из списка.
  const [curSpeaker, setCurSpeaker] = useState<number | null>(null)
  // ⚠️ Какой ДЕНЬ сейчас правим на вкладке порядка. У каждого дня свои спикеры
  // и свой порядок рядов (миграция 466) — общий список для них бессмыслен.
  const [curDayNo, setCurDayNo] = useState<number | null>(null)
  // Сколько афиш этого вида уже собрано — чтобы спрашивать «заменить или
  // добавить» только когда есть что заменять.
  const [existing, setExisting] = useState(0)
  const [dragPartner, setDragPartner] = useState<number | null>(null)
  // Ряд, в который сейчас тащат — подсвечиваем, иначе непонятно, куда упадёт.
  const [overRow, setOverRow] = useState<number | null>(null)

  // ⚠️ Файл фирменных шрифтов подключён только на публичных страницах; в
  // кабинете его надо добавить самим, иначе в предпросмотре запасной шрифт.
  useEffect(() => { ensureBrandFonts() }, [])

  useEffect(() => {
    setLoading(true)
    api.posterLayout.get(eventId, o, kind)
      .then((r: any) => {
        // ⚠️⚠️ ПОДСТАВЛЯЕМ ПОДСКАЗКИ В САМИ ПОЛЯ, а не только в placeholder.
        // Серая подсказка не является значением: клиент видел название события
        // бледным текстом, думал что оно подставится, и получал пустую афишу.
        // Заполняем ТОЛЬКО пустые поля — уже вписанное клиентом не трогаем.
        const sg = r.suggested || {}
        const L = { ...r.layout, orientation: o }
        const filled: any = {}
        for (const k of ['title', 'subtitle', 'pill_text', 'pill_text_2'] as const) {
          if (!String(L[k] ?? '').trim() && String(sg[k] ?? '').trim()) {
            filled[k] = sg[k]
          }
        }
        setLayout({ ...L, ...filled })
        // ⚠️ Если что-то подставили — сразу сохраняем, иначе при следующем
        // открытии поля снова окажутся пустыми, а клиент будет уверен, что
        // название уже задано.
        if (Object.keys(filled).length) {
          const { orientation, ...body } = { ...L, ...filled }
          api.posterLayout.save(eventId, o, body, kind).catch(() => {})
        }
        setTheme(r.theme || {})
        setPeople(r.people || [])
        setDays(Array.isArray(r.days) ? r.days : [])
        // ⚠️ jsonb из базы умеет приезжать строкой — тогда `.map` пошёл бы по
        // символам. Берём объект только если это действительно объект.
        setSessions(r.sessions && typeof r.sessions === 'object' ? r.sessions : {})
        setSuggested(sg)
        setExisting(Number(r.existing) || 0)
        setErr(null)
      })
      .catch((e: any) => setErr(e?.message || 'Не удалось загрузить макет'))
      .finally(() => setLoading(false))
  }, [eventId, o, kind])

  // Есть ли несохранённые правки — для автосохранения ниже.
  const dirtyRef = useRef(false)
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  function patch(p: Partial<PosterLayout>) {
    setLayout(l => (l ? { ...l, ...p } : l))
    setSaved(false)
    dirtyRef.current = true
  }

  // ⚠️⚠️ АВТОСОХРАНЕНИЕ. Клиент расставил спикеров по рядам, ушёл со страницы —
  // и всё пропало: сохранение висело на отдельной кнопке, а перетаскивание
  // выглядит как действие, которое уже применилось (афиша-то перестроилась).
  // Сохраняем сами через полторы секунды после последней правки: ползунок
  // двигают часто, и слать запрос на каждое движение незачем.
  useEffect(() => {
    if (!dirtyRef.current) return
    const t = setTimeout(async () => {
      const cur = layoutRef.current
      if (!cur) return
      dirtyRef.current = false
      setSaving(true)
      try {
        const { orientation, ...body } = cur
        await api.posterLayout.save(eventId, o, body, kind)
        setSaved(true)
      } catch (e: any) { setErr(e?.message || 'Не удалось сохранить') }
      finally { setSaving(false) }
    }, 1500)
    return () => clearTimeout(t)
  }, [layout, eventId, o, kind])

  async function save() {
    if (!layout) return
    setSaving(true)
    try {
      const { orientation, ...body } = layout
      const r = await api.posterLayout.save(eventId, o, body, kind)
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
      await api.posterLayout.save(eventId, o, body, kind)
      await api.posterLayout.png(eventId, o)
    } catch (e: any) { setErr(e?.message || 'Не удалось собрать афишу') }
    finally { setBusy('') }
  }

  /**
   * ⚠️⚠️ ОДНА КНОПКА СОБИРАЕТ ВСЕ АФИШИ РАЗДЕЛА (требование владельца).
   * У события бывает четыре дня и полтора десятка спикеров: собирать каждую
   * афишу отдельно — это двадцать нажатий и двадцать ожиданий подряд.
   *
   * Куда попадает результат, решает бэкенд:
   *   общие      — в афиши события;
   *   по дням    — в афиши СВОЕГО дня;
   *   спикерские — в карточку своего спикера (с проставленной галочкой).
   */
  /**
   * ⚠️⚠️ ПУБЛИКАЦИЯ — ОДНА КНОПКА НА ВСЁ. Она же собирает афиши, она же
   * кладёт их на место, она же открывает их спикерам. Отдельная кнопка
   * «сохранить в афиши» не нужна: опубликовал — значит сохранил (решение
   * владельца 19.09.2026).
   *
   * ⚠️ СПРАШИВАЕМ, ЗАМЕНИТЬ ИЛИ ДОБАВИТЬ. Раньше афиши всегда ложились рядом,
   * и после трёх пересборок у события копилась куча одинаковых картинок —
   * понять, какая уйдёт в рассылку, было нельзя (рассылка берёт первую по
   * sort и id, а все вставлялись с sort = 0). Несколько афиш оставить можно,
   * поэтому это вопрос, а не жёсткая замена.
   */
  async function renderToLibrary() {
    if (!layout) return

    const had = existing
    let replace = false
    if (had > 0) {
      // ⚠️ Заменяем только ЭТУ ориентацию: опубликовал вертикальную —
      // горизонтальная осталась на месте.
      replace = window.confirm(
        `У события уже есть ${had} ${had === 1 ? 'афиша' : 'афиш'} этого вида `
        + `(${ORIENTATIONS.find(x => x.key === o)?.label.toLowerCase()}).\n\n`
        + 'ОК — заменить их новыми.\n'
        + 'Отмена — добавить новые рядом со старыми.',
      )
    }

    setBusy('render')
    try {
      const { orientation, ...body } = layout
      await api.posterLayout.save(eventId, o, body, kind)
      const r: any = await api.posterLayout.renderAll(eventId, o, kind, { replace, publish: true })
      setErr(null)
      patch({ published_to_cabinet: true })
      const n = Array.isArray(r?.made) ? r.made.length : 0
      alert(
        (kind === 'common' ? 'Афиша собрана и добавлена в афиши события'
         : kind === 'day' ? `Готово: афиш по дням — ${n}. Каждая легла в афиши своего дня`
         : `Готово: индивидуальных афиш — ${n}. Каждая легла в карточку своего спикера`)
        + '\nСпикеры уже видят их в кабинете.',
      )
    } catch (e: any) { setErr(e?.message || 'Не удалось собрать афишу') }
    finally { setBusy('') }
  }

  /**
   * ⚠️⚠️ ОДНА КНОПКА НА ВЕСЬ ТИП — все три ориентации сразу.
   * Клиент публиковал вертикальную, горизонтальную и квадратную по очереди:
   * «задолбалась по одной кнопке» (21.09.2026). Ориентации у макета разные,
   * но решение «выпускаем» одно.
   */
  async function publishAllOrientations() {
    if (!layout) return
    const had = existing
    let replace = false
    if (had > 0) {
      replace = window.confirm(
        `У события уже есть собранные афиши этого вида.\n\n`
        + 'ОК — заменить их новыми.\nОтмена — добавить рядом со старыми.',
      )
    }
    setBusy('render')
    try {
      // Текущую сохраняем — в ней несохранённые правки.
      const { orientation, ...body } = layout
      await api.posterLayout.save(eventId, o, body, kind)
      let total = 0
      for (const ori of ORIENTATIONS) {
        const r: any = await api.posterLayout.renderAll(eventId, ori.key, kind,
                                                        { replace, publish: true })
        total += Array.isArray(r?.made) ? r.made.length : 0
      }
      setErr(null)
      patch({ published_to_cabinet: true })
      alert(`Готово: собрано афиш — ${total} (все три формата).\nСпикеры уже видят их в кабинете.`)
    } catch (e: any) { setErr(e?.message || 'Не удалось собрать афиши') }
    finally { setBusy('') }
  }

  /** Копирование фона и оформления в другие виды этой же ориентации. */
  async function copyDesign() {
    if (!layout) return
    if (!window.confirm(
      `Скопировать фон и оформление во все ${ORIENTATIONS.find(x => x.key === o)?.label.toLowerCase()} афиши `
      + '(общие, по дням, спикерские)?\n\nРасстановка спикеров и тексты останутся своими.',
    )) return
    setBusy('render')
    try {
      const { orientation, ...body } = layout
      await api.posterLayout.save(eventId, o, body, kind)
      await api.posterLayout.copyBg(eventId, o, kind)
      setErr(null)
      alert('Готово: фон и оформление скопированы')
    } catch (e: any) { setErr(e?.message || 'Не удалось скопировать') }
    finally { setBusy('') }
  }

  // Люди, которых можно перетаскивать: организаторы стоят сверху всегда,
  // партнёры-компании идут логотипами — их порядок не переставляют.
  // ⚠️ Организаторы ПЕРЕТАСКИВАЮТСЯ наравне со всеми: они стоят в общей сетке
  // (решение владельца), и «Марго Форбс не перетаскивается» было именно из-за
  // того, что их отсюда исключали.
  const draggable = useMemo(() => {
    const persons = people.filter(p => !p.is_company)
    return applyManualOrder(persons, layout?.speaker_order || [])
  }, [people, layout?.speaker_order])

  // Партнёры-компании в порядке, заданном клиентом.
  const companies = useMemo(() => {
    const list = people.filter(p => p.is_company && (p.photo_url || p.cutout_photo_url))
    const order = Array.isArray(layout?.partner_order) ? layout!.partner_order : []
    if (!order.length) return list
    const pos = new Map(order.map((id, i) => [id, i]))
    return [...list.filter(p => pos.has(p.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!),
            ...list.filter(p => !pos.has(p.id))]
  }, [people, layout?.partner_order])

  const indSpeakerId = curSpeaker ?? draggable[0]?.id ?? null

  // День, который правим сейчас. Пусто — первый.
  const editDay = kind === 'day' ? (curDayNo ?? days[0]?.day ?? null) : null
  const editDayInfo = days.find(d => d.day === editDay) || null

  // ⚠️ Кого показываем в расстановке: в дневном разделе — ТОЛЬКО спикеров
  // этого дня. Иначе клиент таскает по рядам людей, которых на афише дня нет.
  const dayPeople = useMemo(() => {
    if (kind !== 'day' || !editDayInfo) return draggable
    const ids = new Set(editDayInfo.speaker_ids.map(Number))
    return draggable.filter(p => ids.has(Number(p.id)))
  }, [draggable, kind, editDayInfo])

  // Ряды выбранного дня — свои, из словаря по дням.
  const dayRowsMap: Record<string, number[][]> =
    (layout?.day_speaker_rows && typeof layout.day_speaker_rows === 'object')
      ? layout.day_speaker_rows as any : {}
  const curDayRows = editDay != null ? dayRowsMap[String(editDay)] : undefined

  // ⚠️ Ряды для редактора считаем ТЕМ ЖЕ способом, что и полотно
  // (applyManualRows), иначе в списке одно, а на афише другое.
  const rowsView = useMemo(() => {
    if (!layout) return []
    // ⚠️ В дневном разделе берём ряды СВОЕГО дня и только его спикеров.
    const src = kind === 'day' ? dayPeople : draggable
    const raw = kind === 'day' ? curDayRows : layout.speaker_rows
    // ⚠️ Только массив: строка из jsonb иначе сойдёт за «ряды заданы».
    const rows = Array.isArray(raw) ? raw : []
    if (rows.length) return applyManualRows(src, rows)
    // Ряды ещё не задавали — показываем как один ряд: клиент растащит его сам.
    return src.length ? [src] : []
  }, [draggable, dayPeople, kind, curDayRows, layout?.speaker_rows])

  // ⚠️ Список логотипов — бренд и партнёры ВМЕСТЕ, как их рисует полотно.
  // Иначе в настройках один порядок, а на афише другой.
  const logoList = useMemo(() => {
    const items: { key: string; url: string; name: string; isBrand: boolean }[] = []
    const brandUrl = layout?.logos_variant === 'dark'
      ? (theme.brand_logo_light_url || theme.brand_logo_url)
      : (theme.brand_logo_url || theme.brand_logo_light_url)
    if (brandUrl) items.push({ key: 'brand', url: brandUrl, name: 'Логотип бренда', isBrand: true })
    const forLight = layout?.logos_variant === 'dark'
    for (const c of companies) {
      // Тот же выбор, что на афише: иначе в списке один логотип, на афише другой.
      const u = forLight
        ? ((c as any).logo_on_light_url || c.photo_url || c.cutout_photo_url)
        : (c.photo_url || c.cutout_photo_url)
      if (u) items.push({
        key: String(c.id), url: u, isBrand: false,
        name: [c.name, c.last_name].filter(Boolean).join(' ') || 'Партнёр',
      })
    }
    const order = (Array.isArray(layout?.logos_order) ? layout!.logos_order : []).map(String)
    if (!order.length) return items
    return [...items.filter(i => order.includes(i.key))
              .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)),
            ...items.filter(i => !order.includes(i.key))]
  }, [companies, theme, layout?.logos_order, layout?.logos_variant])

  // ⚠️ Индивидуальная афиша рисуется по ОДНОМУ человеку. Клиент его
  // переключает, но пока не трогал — берём первого, иначе полотно пустое и
  // непонятно, работает ли раздел вообще.
  // ⚠️ Добавленные пилюли (миграция 471). Проверяем, что МАССИВ: jsonb умеет
  // приехать строкой, и тогда `.map()` пошёл бы по символам.
  const extraPills: { text: string; x?: number | null; y?: number | null }[] =
    Array.isArray(layout?.extra_pills) ? (layout!.extra_pills as any) : []

  // ⚠️ Произвольные элементы (миграция 478). Это и есть «пилюли»: текст с
  // рамкой и скруглением. Привязки к данным события нет — стёрли текст,
  // значит стёрли (раньше подставлялась «кривая дата»).
  const customEls: any[] = Array.isArray(layout?.custom_elements)
    ? (layout!.custom_elements as any) : []

  function addEl(preset?: any) {
    patch({ custom_elements: [...customEls, {
      id: `el${Date.now()}`, kind: 'text', text: '',
      x: 50, y: 50, w: 80, size: 28, align: 'center',
      border_w: 0, radius: 0, bg_opacity: 100, ...preset,
    }] } as any)
  }
  function patchEl(id: string, p: any) {
    patch({ custom_elements: customEls.map(e => (e.id === id ? { ...e, ...p } : e)) } as any)
  }
  function removeEl(id: string) {
    patch({ custom_elements: customEls.filter(e => e.id !== id) } as any)
  }

  function addPill() {
    patch({ extra_pills: [...extraPills, { text: '', x: null, y: null }] } as any)
  }
  function patchPill(i: number, p: Partial<{ text: string; x: number | null; y: number | null }>) {
    patch({ extra_pills: extraPills.map((it, k) => (k === i ? { ...it, ...p } : it)) } as any)
  }
  function removePill(i: number) {
    patch({ extra_pills: extraPills.filter((_, k) => k !== i) } as any)
  }

  /** Записать ряды: в дневном разделе — в свой день, иначе в общий порядок. */
  function patchRows(rows: number[][]) {
    if (kind === 'day' && editDay != null) {
      patch({ day_speaker_rows: { ...dayRowsMap, [String(editDay)]: rows } } as any)
    } else {
      patch({ speaker_rows: rows })
    }
  }

  const hiddenSet = useMemo(
    () => new Set((Array.isArray(layout?.logos_hidden) ? layout!.logos_hidden : []).map(String)),
    [layout?.logos_hidden],
  )

  function toggleLogo(key: string) {
    const next = new Set(hiddenSet)
    if (next.has(key)) next.delete(key); else next.add(key)
    patch({ logos_hidden: [...next] })
  }

  function onDropLogo(targetKey: string) {
    if (dragLogo == null || dragLogo === targetKey) { setDragLogo(null); return }
    const list = logoList.map(i => i.key)
    const from = list.indexOf(dragLogo)
    const to = list.indexOf(targetKey)
    if (from < 0 || to < 0) { setDragLogo(null); return }
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    patch({ logos_order: list })
    setDragLogo(null)
  }

  /** Разложить всех спикеров на заданное число рядов. */
  function setRowCount(n: number) {
    // ⚠️ Берём людей В ТЕКУЩЕМ ПОРЯДКЕ (как они идут по рядам сейчас), а не
    // заново из авторасстановки: клиент мог уже переставить кого-то местами,
    // и смена числа рядов не должна это стирать.
    const flat = rowsView.flat()
    patchRows(splitIntoRows(flat, n).map(r => r.map(p => p.id)))
  }

  function onDropPartner(targetId: number) {
    if (dragPartner == null || dragPartner === targetId) { setDragPartner(null); return }
    const list = companies.map(p => p.id)
    const from = list.indexOf(dragPartner)
    const to = list.indexOf(targetId)
    if (from < 0 || to < 0) { setDragPartner(null); return }
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    patch({ partner_order: list })
    setDragPartner(null)
  }

  /** Переносит спикера в другой ряд (или внутри ряда). */
  function moveToRow(personId: number, rowIndex: number) {
    const rows = rowsView.map(r => r.map(p => p.id))
    // Сначала убираем человека отовсюду, потом кладём в целевой ряд.
    const cleaned = rows.map(r => r.filter(id => id !== personId))
    while (cleaned.length <= rowIndex) cleaned.push([])
    cleaned[rowIndex].push(personId)
    patchRows(cleaned.filter(r => r.length))
  }

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
  // ⚠️⚠️ МАСШТАБ СЧИТАЕТСЯ ОТ ПОСТОЯННОЙ ШИРИНЫ КОЛОНКИ, а не задаётся числом
  // на каждый формат. Раньше было три числа (0.28 / 0.3 / 0.22) — и лист у
  // каждого формата получался своей ширины, из-за чего вся раскладка страницы
  // прыгала при переключении. Теперь лист всегда вписан в одну и ту же
  // колонку: меняется только его высота, а ширина постоянна.
  const PREVIEW_W = 340
  const scale = PREVIEW_W / size.w
  // Крупный просмотр — во всю доступную высоту окна (с запасом на поля).
  const zoomScale = typeof window !== 'undefined'
    ? Math.min((window.innerHeight - 80) / size.h, (window.innerWidth - 80) / size.w, 1)
    : 0.5

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500 leading-relaxed">
        Загрузите фон, отметьте линию, с которой начинаются спикеры, — остальное соберётся само
        из карточек спикеров и партнёров события. Три вида афиши настраиваются отдельно.
      </p>

      {err && <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{err}</div>}

      {/* ⚠️⚠️ ТРИ РАЗДЕЛА: общие афиши, афиши по дням, индивидуальные. У каждого
          свои настройки и свои три ориентации внутри. */}
      <div className="flex flex-wrap gap-1 border-b border-gray-200">
        {KIND_TABS.map(k => (
          <button key={k.key} type="button" onClick={() => setKind(k.key)} title={k.hint}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    kind === k.key
                      ? 'border-[#25455D] text-[#25455D]'
                      : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
            {k.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-400 -mt-2">
        {KIND_TABS.find(k => k.key === kind)?.hint}
      </p>

      {/* Выбор ориентации. */}
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
            занимаемое место, и без неё под афишей осталась бы пустота.
            ⚠️ ЛИПНЕТ К ВЕРХУ при прокрутке (`sticky`): настройки длинные, и без
            этого клиент, правя нижние разделы, переставал видеть, что меняется.
            На узком экране обычный поток — там колонки идут друг под другом. */}
        {/* ⚠️⚠️ ШИРИНА КОЛОНКИ ПРЕВЬЮ ПОСТОЯННА — не зависит от формата афиши.
            Раньше колонка была по размеру листа: у горизонтальной одна ширина,
            у вертикальной другая. Правая колонка (flex-1) подстраивалась под
            остаток — и на каждое переключение формата ВСЕ НАСТРОЙКИ МЕНЯЛИ
            ШИРИНУ, а ползунок уезжал из-под курсора. Теперь место под превью
            одно и то же, лист центрируется внутри. */}
        <div className="shrink-0 xl:sticky xl:top-4 xl:self-start xl:w-[360px]">
          <div style={{ width: size.w * scale, height: size.h * scale }}
               className="overflow-hidden rounded-xl shadow-sm border card-border bg-gray-50 mx-auto">
            <PosterCanvas layout={layout} theme={theme} people={people} scale={scale}
                          suggested={suggested} showMargins={showMargins}
                          days={days} sessions={sessions}
                          day={kind === 'day' ? (days[0]?.day ?? null) : null}
                          speakerId={kind === 'individual' ? indSpeakerId : null} />
          </div>
          {/* Клик по превью — крупный просмотр: на уменьшенном в 4 раза макете
              не разобрать ни лиц, ни подписей. */}
          <button type="button" onClick={() => setZoom(true)}
                  className="mt-2 text-xs text-[#25455D] hover:underline">
            Посмотреть крупно
          </button>
          <label className="flex items-center gap-2 text-xs text-gray-500 mt-2">
            <input type="checkbox" checked={showMargins}
                   onChange={e => setShowMargins(e.target.checked)} />
            Показать границу полей (в готовый файл не попадёт)
          </label>

          {/* ⚠️ Переключатель спикеров — НАД превью (требование владельца):
              настройки общие на всех, а проверить их надо на разных людях —
              у кого-то длинная фамилия, у кого-то нет темы выступления. */}
          {kind === 'individual' && draggable.length > 0 && (
            <div className="mt-3">
              <div className="text-xs text-gray-500 mb-1">Показать афишу спикера:</div>
              <select value={indSpeakerId ?? ''} onChange={e => setCurSpeaker(Number(e.target.value))}
                      className="w-full rounded-lg border card-border px-3 py-2 text-sm">
                {draggable.map(p => (
                  <option key={p.id} value={p.id}>
                    {[p.name, p.last_name].filter(Boolean).join(' ')}
                    {sessions[String(p.id)]?.topic ? ` — ${sessions[String(p.id)]!.topic}` : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">
                Настройки общие на всех: кнопка ниже соберёт афишу каждому спикеру сразу.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 mt-4">
            <button onClick={save} disabled={saving} className="btn-gold px-6 py-2.5 text-sm">
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
            <button onClick={download} disabled={!!busy} className="btn-primary px-5 py-2.5 text-sm">
              {busy === 'png' ? 'Собираем…' : 'Скачать PNG'}
            </button>
            {/* ⚠️ Публикация — главное действие экрана, поэтому золотая кнопка.
                Она же собирает афиши и открывает их спикерам: отдельная
                «сохранить в афиши» не нужна. */}
            <button onClick={renderToLibrary} disabled={!!busy} className="btn-gold px-5 py-2.5 text-sm">
              {busy === 'render' ? 'Собираем…'
                : kind === 'common' ? 'Опубликовать афишу'
                : kind === 'day' ? `Опубликовать афиши дней (${days.length})`
                : `Опубликовать афиши спикеров (${draggable.length})`}
            </button>
            <button onClick={publishAllOrientations} disabled={!!busy}
                    className="btn-primary px-5 py-2.5 text-sm">
              {busy === 'render' ? 'Собираем…' : 'Опубликовать все три формата'}
            </button>
            <button onClick={copyDesign} disabled={!!busy}
                    className="text-sm text-gray-500 hover:text-gray-700 underline">
              Скопировать оформление во все {ORIENTATIONS.find(x => x.key === o)?.label.toLowerCase()}
            </button>
            {layout.published_to_cabinet && (
              <span className="text-xs text-green-600">Видно спикерам</span>
            )}
            {saved && <span className="text-sm text-green-600">Сохранено</span>}
          </div>

          {/* ⚠️⚠️ ПРЕВЬЮ ВСЕХ ДНЕЙ ДРУГ ПОД ДРУГОМ (требование владельца):
              настройки общие на все дни, и проверять их надо сразу на всех —
              в один день спикеров трое, в другой четырнадцать, и то, что
              красиво легло на первом, на втором может не поместиться. */}
          {kind === 'day' && days.length > 1 && (
            <div className="mt-5 space-y-3">
              <div className="text-xs text-gray-500">Остальные дни — с теми же настройками:</div>
              {days.slice(1).map(d => (
                <div key={d.day}>
                  <div className="text-xs text-gray-400 mb-1">{d.label}</div>
                  <div style={{ width: size.w * scale, height: size.h * scale }}
                       className="overflow-hidden rounded-xl shadow-sm border card-border bg-gray-50">
                    <PosterCanvas layout={layout} theme={theme} people={people} scale={scale}
                                  suggested={suggested} days={days} sessions={sessions} day={d.day} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {kind === 'day' && days.length === 0 && (
            <p className="mt-3 text-xs text-gray-400">
              У события пока нет программы по дням — добавьте выступления, и афиши дней появятся сами.
            </p>
          )}
        </div>

        {/* Настройки. */}
        {/* ⚠️ Колонка настроек тоже не «остаток», а своя ширина: иначе она
            всё равно дышала бы вслед за содержимым превью. */}
        <div className="flex-1 min-w-0 xl:max-w-[640px]">
          {/* ⚠️ Настройки ВКЛАДКАМИ, а не одной длинной колонкой: раньше нижние
              разделы уезжали далеко вниз, и правя их клиент уже не видел
              превью — приходилось скроллить туда-сюда на каждое движение
              ползунка. Оформление то же, что у вкладок чатов TG/VK/MAX. */}
          {/* ⚠️ У АФИШИ СПИКЕРА СВОЙ РЯД ВКЛАДОК — по одной на элемент, и
              верхние здесь не нужны: половина из них («Порядок по рядам»,
              «Спикеры») к афише одного человека отношения не имеет. Два уровня
              вкладок и были тем, из-за чего ничего не находилось. */}
          <div className={`flex flex-wrap gap-1 border-b border-gray-200 mb-4${
            kind === 'individual' ? ' hidden' : ''}`}>
            {SET_TABS.map(t => (
              <button key={t.key} type="button" onClick={() => setTab(t.key)}
                      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                        tab === t.key
                          ? 'border-[#25455D] text-[#25455D]'
                          : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                {t.label}
              </button>
            ))}
          </div>

          <div className="space-y-4">

          {/* ⚠️⚠️ АФИША СПИКЕРА — СВОЙ РЕДАКТОР ЦЕЛИКОМ, а не подвкладка внутри
              «Спикеров». Ряд пунктов заменяет верхние вкладки: у афиши одного
              человека нет ни сетки, ни порядка по рядам, зато есть тема, время
              и роль, которых нет на общей. */}
          {kind === 'individual' ? (<>

          {/* ⚠️⚠️ РЕДАКТОР АФИШИ СПИКЕРА. Каждый пункт — своя подвкладка, и
              внутри ВСЁ про него: текст, положение, размер, цвет, шрифт, форма.
              Никаких отсылок «смотрите в другой вкладке»: именно из-за них
              получилось лоскутное одеяло, где ничего нельзя было найти. */}
          <div className="flex flex-wrap gap-1 mb-4">
            {IND_TABS.map(t => (
              <button key={t.key} type="button" onClick={() => setIndTab(t.key)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                        indTab === t.key
                          ? 'bg-[#25455D] text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {indTab === 'bg' && (<>
            {/* ⚠️ Вкладка была в списке, но БЕЗ СОДЕРЖИМОГО — загрузка фона
                просто пропала с экрана. */}
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
                Рабочая область афиши. За эти поля не выходит ничего.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <MmField label="Сверху"  value={layout.margin_top ?? 10}    onChange={v => patch({ margin_top: v })} />
                <MmField label="Снизу"   value={layout.margin_bottom ?? 10} onChange={v => patch({ margin_bottom: v })} />
                <MmField label="Слева"   value={layout.margin_left ?? 10}   onChange={v => patch({ margin_left: v })} />
                <MmField label="Справа"  value={layout.margin_right ?? 10}  onChange={v => patch({ margin_right: v })} />
              </div>
            </Card>
          </>)}

          {indTab === 'photo' && (
            <Card title="Фото спикера">
              <div className="mb-1 text-xs text-gray-600">Форма</div>
              <Choice value={layout.mask_shape || 'rect'}
                      onChange={v => patch({ mask_shape: v as any })}
                      options={[
                        ['rect', 'Прямоугольник'], ['square', 'Квадрат'],
                        ['circle', 'Круг'], ['oval', 'Овал'],
                        ['egg', 'Яйцо'], ['cutout', 'Вырезка'],
                      ]} />
              <Range label="Размер, % ширины" value={layout.ind_photo_size ?? 45} min={10} max={100}
                     onChange={v => patch({ ind_photo_size: v })} />
              <Range label="Слева направо, %" value={layout.ind_photo_x ?? 50} min={0} max={100}
                     hint="0 — левое поле, 100 — правое"
                     onChange={v => patch({ ind_photo_x: v })} />
              <Range label="Сверху вниз, %" value={layout.ind_photo_y ?? 55} min={0} max={100}
                     hint="0 — верхнее поле, 100 — нижнее"
                     onChange={v => patch({ ind_photo_y: v })} />
              <Range label="Скругление углов, %" value={layout.mask_radius ?? 0} min={0} max={50}
                     onChange={v => patch({ mask_radius: v })} />
              <Range label="Толщина рамки, px" value={layout.ind_photo_border_w ?? 0} min={0} max={40}
                     onChange={v => patch({ ind_photo_border_w: v })} />
              <ColorRow label="Цвет рамки" value={layout.ind_photo_border_color}
                        onChange={v => patch({ ind_photo_border_color: v })} />
              <Range label="Свечение, px" value={layout.ind_photo_glow ?? 0} min={0} max={100}
                     onChange={v => patch({ ind_photo_glow: v })} />
              <ColorRow label="Цвет свечения" value={layout.ind_photo_glow_color}
                        onChange={v => patch({ ind_photo_glow_color: v })} />
              <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                <input type="checkbox" checked={layout.ind_photo_first === true}
                       onChange={e => patch({ ind_photo_first: e.target.checked })} />
                Фото сверху, текст под ним
              </label>
            </Card>
          )}

          {indTab === 'title' && (
            <IndElement title="Название конференции" theme={theme}
                        text={layout.ind_title_text} textPlaceholder={suggested?.title || 'Название конференции'}
                        onText={v => patch({ ind_title_text: v })}
                        shown={layout.ind_show_event_title !== false}
                        onShown={v => patch({ ind_show_event_title: v })}
                        x={layout.ind_title_x} y={layout.ind_title_y}
                        onX={v => patch({ ind_title_x: v })} onY={v => patch({ ind_title_y: v })}
                        size={layout.ind_title_size ?? 22} sizeMin={8} sizeMax={120}
                        onSize={v => patch({ ind_title_size: v })}
                        color={layout.ind_title_color} onColor={v => patch({ ind_title_color: v })}
                        align={layout.ind_title_align} onAlign={v => patch({ ind_title_align: v })}
                        font={layout.ind_title_font} onFont={v => patch({ ind_title_font: v })}>
              <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                <input type="checkbox" checked={layout.ind_title_metallic === true}
                       onChange={e => patch({ ind_title_metallic: e.target.checked })} />
                Металлический отлив
              </label>
            </IndElement>
          )}

          {indTab === 'role' && (
            <IndElement title="Роль спикера" theme={theme}
                        hint="Текст роли берётся из карточки спикера: спикер, хедлайнер, организатор."
                        shown={layout.ind_show_role !== false}
                        onShown={v => patch({ ind_show_role: v })}
                        x={layout.ind_role_x} y={layout.ind_role_y}
                        onX={v => patch({ ind_role_x: v })} onY={v => patch({ ind_role_y: v })}
                        size={layout.ind_role_size ?? 24} sizeMin={8} sizeMax={120}
                        onSize={v => patch({ ind_role_size: v })}
                        color={layout.ind_role_color} onColor={v => patch({ ind_role_color: v })}
                        align={layout.ind_role_align} onAlign={v => patch({ ind_role_align: v })}
                        font={layout.ind_role_font} onFont={v => patch({ ind_role_font: v })}>
              <ColorRow label="Фон" value={layout.ind_role_bg}
                        onChange={v => patch({ ind_role_bg: v })} />
              <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                <input type="checkbox" checked={layout.ind_role_upper !== false}
                       onChange={e => patch({ ind_role_upper: e.target.checked })} />
                БОЛЬШИМИ БУКВАМИ
              </label>
            </IndElement>
          )}

          {indTab === 'name' && (
            <IndElement title="Имя и фамилия" theme={theme}
                        hint="Имя берётся из карточки спикера."
                        x={layout.ind_name_x} y={layout.ind_name_y}
                        onX={v => patch({ ind_name_x: v })} onY={v => patch({ ind_name_y: v })}
                        size={layout.ind_name_size ?? 54} sizeMin={10} sizeMax={200}
                        onSize={v => patch({ ind_name_size: v })}
                        width={layout.ind_name_w} onWidth={v => patch({ ind_name_w: v })}
                        color={layout.name_color} onColor={v => patch({ name_color: v })}
                        align={layout.name_align} onAlign={v => patch({ name_align: v })}
                        font={layout.ind_name_font} onFont={v => patch({ ind_name_font: v })}>
              <ColorRow label="Фон" value={layout.ind_name_bg}
                        onChange={v => patch({ ind_name_bg: v })} />
              <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                <input type="checkbox" checked={layout.ind_name_upper === true}
                       onChange={e => patch({ ind_name_upper: e.target.checked })} />
                БОЛЬШИМИ БУКВАМИ
              </label>
            </IndElement>
          )}

          {indTab === 'topic' && (<>
            {/* ⚠️⚠️ ВЫБОР ТЕМ — ЗДЕСЬ, на самой афише (требование владельца).
                У Марго Форбс четыре выступления, и «Открытие Дня» — строка
                программы, а не тема для анонса. Отмечаете, какие показать. */}
            {(() => {
              const items = sessions[String(indSpeakerId)]?.all_items || []
              if (items.length < 2) return null
              const chosen = items.filter(it => it.chosen).map(it => it.id)
              const toggle = (id: number) => {
                const next = chosen.includes(id)
                  ? chosen.filter(x => x !== id)
                  : [...chosen, id]
                // ⚠️ Сняли все — значит показываем все: пустая афиша хуже,
                // чем лишняя тема, и так же трактует бэкенд.
                // ⚠️⚠️ ОБНОВЛЯЕМ И `items` — их рисует полотно. Раньше
                // менялся только `all_items` (список галочек), и снятая
                // галочка не убирала тему с афиши: «жму галочки — они не
                // убираются» (владелец 21.09.2026).
                const nextAll = items.map(it => ({
                  ...it, chosen: next.length === 0 || next.includes(it.id),
                }))
                setSessions(prev => ({
                  ...prev,
                  [String(indSpeakerId)]: {
                    ...prev[String(indSpeakerId)],
                    all_items: nextAll,
                    items: nextAll
                      .filter(it => it.chosen && (it.topic || '').trim())
                      .map(it => ({ id: it.id, when: it.when, topic: it.topic })),
                  },
                }))
                if (indSpeakerId != null) {
                  api.posterLayout.setPosterTopics(eventId, indSpeakerId, next).catch(() => {})
                }
              }
              return (
                <Card title="Какие темы показать">
                  <p className="text-xs text-gray-400 mb-2">
                    У этого спикера {items.length} выступления. Отметьте те, что нужны на афише.
                  </p>
                  {items.map(it => (
                    <label key={it.id} className="flex items-start gap-2 text-sm text-gray-700 mb-1.5">
                      <input type="checkbox" checked={it.chosen} className="mt-0.5"
                             onChange={() => toggle(it.id)} />
                      <span className="min-w-0">
                        {it.when && <span className="text-gray-400">{it.when}: </span>}
                        {it.topic || <span className="text-gray-400">без темы</span>}
                      </span>
                    </label>
                  ))}
                </Card>
              )
            })()}
            <IndElement title="Тема выступления" theme={theme}
                        hint="Тема берётся из программы конференции."
                        shown={layout.ind_show_topic !== false}
                        onShown={v => patch({ ind_show_topic: v })}
                        x={layout.ind_topic_x} y={layout.ind_topic_y}
                        onX={v => patch({ ind_topic_x: v })} onY={v => patch({ ind_topic_y: v })}
                        size={layout.ind_topic_size ?? 30} sizeMin={8} sizeMax={150}
                        onSize={v => patch({ ind_topic_size: v })}
                        width={layout.ind_topic_w} onWidth={v => patch({ ind_topic_w: v })}
                        color={layout.ind_topic_color} onColor={v => patch({ ind_topic_color: v })}
                        align={layout.topic_align} onAlign={v => patch({ topic_align: v })}
                        font={layout.ind_topic_font} onFont={v => patch({ ind_topic_font: v })}>
              <ColorRow label="Цвет даты перед темой" value={layout.ind_topic_when_color}
                        onChange={v => patch({ ind_topic_when_color: v })} />
              <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                <input type="checkbox" checked={layout.ind_topic_show_when !== false}
                       onChange={e => patch({ ind_topic_show_when: e.target.checked })} />
                Показывать дату и время
              </label>
              {layout.ind_topic_show_when !== false && (
                <div className="mt-3">
                  <div className="mb-1 text-xs text-gray-600">Где дата</div>
                  <Choice value={layout.ind_topic_when_place || 'left'}
                          onChange={v => patch({ ind_topic_when_place: v as any })}
                          options={[['left', 'Слева'], ['top', 'Над темой'], ['right', 'Справа']]} />
                </div>
              )}
              <ColorRow label="Фон темы" value={layout.ind_topic_bg}
                        onChange={v => patch({ ind_topic_bg: v })} />
              <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                <input type="checkbox" checked={layout.ind_topic_upper === true}
                       onChange={e => patch({ ind_topic_upper: e.target.checked })} />
                БОЛЬШИМИ БУКВАМИ
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 mt-2">
                <input type="checkbox" checked={layout.ind_topic_divider === true}
                       onChange={e => patch({ ind_topic_divider: e.target.checked })} />
                Разделитель между темами
              </label>
            </IndElement>
          </>)}

          {indTab === 'elements' && (<>
            <Card title="Свои элементы">
              <p className="text-xs text-gray-400 mb-2">
                Любой текст на афише: с рамкой и скруглением получается пилюля.
                Сколько угодно, с любым содержимым — ничего не подставляется само.
              </p>
              <div className="flex flex-wrap gap-2 mb-3">
                <button type="button" onClick={() => addEl()}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200">
                  + Текст
                </button>
                <button type="button"
                        onClick={() => addEl({ text: 'Онлайн', border_w: 2, radius: 40, size: 22, w: 40 })}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200">
                  + Пилюля
                </button>
              </div>
              {customEls.length === 0 && (
                <p className="text-xs text-gray-400">Пока ничего не добавлено.</p>
              )}
              {customEls.map(el => (
                <div key={el.id} className="mb-3 rounded-lg border card-border p-3">
                  <div className="flex items-center gap-2">
                    <input value={el.text || ''} placeholder="Текст"
                           onChange={e => patchEl(el.id, { text: e.target.value })}
                           className="flex-1 min-w-0 rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                    <button type="button" onClick={() => removeEl(el.id)}
                            className="shrink-0 text-xs text-red-600 hover:underline">Убрать</button>
                  </div>
                  <Range label="Слева направо, %" value={el.x ?? 50} min={0} max={100}
                         onChange={v => patchEl(el.id, { x: v })} />
                  <Range label="Сверху вниз, %" value={el.y ?? 50} min={0} max={100}
                         onChange={v => patchEl(el.id, { y: v })} />
                  <Range label="Ширина, %" value={el.w ?? 80} min={5} max={100}
                         onChange={v => patchEl(el.id, { w: v })} />
                  <Range label="Размер, px" value={el.size ?? 28} min={6} max={300}
                         onChange={v => patchEl(el.id, { size: v })} />
                  <ColorRow label="Цвет текста" value={el.color}
                            onChange={v => patchEl(el.id, { color: v })} />
                  <ColorRow label="Фон" value={el.bg}
                            onChange={v => patchEl(el.id, { bg: v })} />
                  <Range label="Прозрачность фона, %" value={el.bg_opacity ?? 100} min={0} max={100}
                         onChange={v => patchEl(el.id, { bg_opacity: v })} />
                  <Range label="Толщина рамки, px" value={el.border_w ?? 0} min={0} max={40}
                         onChange={v => patchEl(el.id, { border_w: v })} />
                  <ColorRow label="Цвет рамки" value={el.border_color}
                            onChange={v => patchEl(el.id, { border_color: v })} />
                  <Range label="Скругление, px" value={el.radius ?? 0} min={0} max={100}
                         onChange={v => patchEl(el.id, { radius: v })} />
                  <Range label="Свечение, px" value={el.glow ?? 0} min={0} max={100}
                         onChange={v => patchEl(el.id, { glow: v })} />
                  <ColorRow label="Цвет свечения" value={el.glow_color}
                            onChange={v => patchEl(el.id, { glow_color: v })} />
                  <div className="mt-3">
                    <div className="mb-1 text-xs text-gray-600">Прижать текст</div>
                    <Choice value={el.align || 'center'}
                            onChange={v => patchEl(el.id, { align: v })}
                            options={[['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа']]} />
                  </div>
                  <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                    <input type="checkbox" checked={!!el.upper}
                           onChange={e => patchEl(el.id, { upper: e.target.checked })} />
                    БОЛЬШИМИ БУКВАМИ
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700 mt-2">
                    <input type="checkbox" checked={!!el.metallic}
                           onChange={e => patchEl(el.id, { metallic: e.target.checked })} />
                    Металлический отлив
                  </label>
                  <FontPicker theme={theme} value={el.font}
                              onChange={v => patchEl(el.id, { font: v })} />
                </div>
              ))}
            </Card>
          </>)}

          {indTab === 'logos' && (
            <Card title="Логотипы">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={layout.show_brand_logo !== false}
                       onChange={e => patch({ show_brand_logo: e.target.checked })} />
                Логотип бренда
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 mt-2">
                <input type="checkbox" checked={layout.show_partners !== false}
                       onChange={e => patch({ show_partners: e.target.checked })} />
                Логотипы партнёров
              </label>
              <Range label="Размер бренда, %" value={layout.brand_logo_size ?? 6} min={1} max={30}
                     onChange={v => patch({ brand_logo_size: v })} />
              <Range label="Размер партнёров, %" value={layout.partners_size ?? 5} min={1} max={30}
                     onChange={v => patch({ partners_size: v })} />
              <Range label="Промежуток, %" value={layout.logos_gap ?? 2.5} min={0} max={20}
                     onChange={v => patch({ logos_gap: v })} />
              <Range label="Высота ряда, %" value={layout.partners_y ?? 5} min={0} max={100}
                     onChange={v => patch({ partners_y: v })} />
              <Range label="Слева направо, px" value={layout.pos_logos_x ?? 0} min={-400} max={400}
                     onChange={v => patch({ pos_logos_x: v })} />
              <Range label="Вверх-вниз, px" value={layout.pos_logos_y ?? 0} min={-400} max={400}
                     onChange={v => patch({ pos_logos_y: v })} />
              <div className="mt-3">
                <div className="mb-1 text-xs text-gray-600">Выравнивание</div>
                <Choice value={layout.logos_align || 'center'}
                        onChange={v => patch({ logos_align: v as any })}
                        options={[['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа']]} />
              </div>
              <div className="mt-3">
                <div className="mb-1 text-xs text-gray-600">Вариант логотипов</div>
                <Choice value={layout.logos_variant || 'light'}
                        onChange={v => patch({ logos_variant: v as any })}
                        options={[['light', 'Для тёмного фона'], ['dark', 'Для светлого фона']]} />
              </div>

              {/* ⚠️ Порядок и скрытие — как в общих афишах: раньше на афише
                  спикера этого не было вовсе, и убрать лишний логотип было
                  нечем. Компонент тот же, настройки те же поля. */}
              <div className="mt-4 pt-4 border-t border-gray-100">
                <div className="text-xs text-gray-600 mb-2">
                  Порядок и видимость — перетащите за ⠿
                </div>
                <div className="flex flex-wrap gap-2">
                  {logoList.map(l => (
                    <LogoChip key={l.key} item={l}
                              hidden={hiddenSet.has(l.key)}
                              isDragging={dragLogo === l.key}
                              onToggle={() => toggleLogo(l.key)}
                              onDragStart={() => setDragLogo(l.key)}
                              onDragEnd={() => setDragLogo(null)}
                              onDragOver={e => e.preventDefault()}
                              onDrop={() => onDropLogo(l.key)} />
                  ))}
                  {logoList.length === 0 && (
                    <p className="text-sm text-gray-400">
                      Нет ни логотипа бренда, ни партнёров-компаний.
                    </p>
                  )}
                </div>
              </div>
            </Card>
          )}
          </>) : (<>

          {tab === 'bg' && (<>
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

          </>)}

          {tab === 'speakers' && (<>
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
            {/* ⚠️ Потолок размера карточки: при одном человеке в ряду ширина
                считается «вся строка на одного» и карточку раздувает на
                пол-листа. Особенно заметно на афише дня, где выступает только
                организатор. */}
            <Range label="Карточка не шире, % ряда" value={layout.card_max_w ?? 30} min={5} max={100}
                   hint="Не даёт карточке раздуться, когда человек в ряду один"
                   onChange={v => patch({ card_max_w: v })} />
            <Range label="Между столбцами, %" value={layout.gap ?? 2} min={0} max={20}
                   hint="Расстояние по горизонтали"
                   onChange={v => patch({ gap: v })} />
            {/* ⚠️ Вертикальный промежуток отдельный: под фото идёт подпись, и
                зазор между рядами визуально складывается с ней. */}
            <Range label="Между рядами, %" value={layout.gap_y ?? layout.gap ?? 2} min={0} max={20}
                   hint="Расстояние по вертикали"
                   onChange={v => patch({ gap_y: v })} />
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
                <Range label="Размер имени" value={layout.name_size ?? 15} min={5} max={40}
                       hint="Доля от карточки спикера. Длинные фамилии ужимаются сами, чтобы влезть"
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

          </>)}

          {tab === 'text' && (<>
          <Card title="Заголовок и подзаголовок">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={layout.show_title !== false}
                     onChange={e => patch({ show_title: e.target.checked })} />
              Показывать заголовок
            </label>
            {layout.show_title !== false && (
              <>
                <input value={layout.title || ''}
                       placeholder={suggested?.title || 'Название события'}
                       onChange={e => patch({ title: e.target.value })}
                       className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                <p className="text-xs text-gray-400 mt-1">
                  Пусто — возьмётся название события. Впишите своё, чтобы заменить.
                </p>

                {/* ⚠️ Вторая часть заголовка СВОИМ ЦВЕТОМ (миграция 447): на
                    макетах заказчика заголовок почти всегда двухцветный —
                    «ВИДЕНИЕ/iViSiON-7:» белым, «БИЗНЕСЫ ВЛИЯНИЯ» золотом. */}
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <div className="text-xs text-gray-600 mb-1">
                    Вторая часть заголовка — другим цветом
                  </div>
                  <input value={layout.title_2 || ''}
                         placeholder="необязательно"
                         onChange={e => patch({ title_2: e.target.value })}
                         className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                  {!!layout.title_2 && (
                    <>
                      <ColorRow label="Цвет второй части" value={layout.title_2_color}
                                placeholder="как основной текст"
                                onChange={v => patch({ title_2_color: v })} />
                      <div className="mt-2">
                        <Choice value={layout.title_2_newline === false ? 'same' : 'new'}
                                onChange={v => patch({ title_2_newline: v === 'new' })}
                                options={[['new', 'С новой строки'], ['same', 'В подбор']]} />
                      </div>
                    </>
                  )}
                </div>
                <Range label="Размер, px" value={layout.title_size ?? 76} min={20} max={200}
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
                            placeholder={suggested?.subtitle || 'Подзаголовок'}
                            onChange={e => patch({ subtitle: e.target.value })}
                            className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                  {/* ⚠️ Вторая часть ПОДЗАГОЛОВКА своим цветом (мигр. 458) —
                      как у заголовка: часть текста выделяют цветом. */}
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <div className="text-xs text-gray-600 mb-1">
                      Вторая часть — другим цветом
                    </div>
                    <textarea value={layout.subtitle_2 || ''} rows={2}
                              placeholder="необязательно"
                              onChange={e => patch({ subtitle_2: e.target.value })}
                              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                    {!!layout.subtitle_2 && (
                      <>
                        <ColorRow label="Цвет второй части" value={layout.subtitle_2_color}
                                  placeholder="как первая часть"
                                  onChange={v => patch({ subtitle_2_color: v })} />
                        <div className="mt-2">
                          <Choice value={layout.subtitle_2_newline === true ? 'new' : 'same'}
                                  onChange={v => patch({ subtitle_2_newline: v === 'new' })}
                                  options={[['same', 'В подбор'], ['new', 'С новой строки']]} />
                        </div>
                      </>
                    )}
                  </div>
                  <Range label="Размер, px" value={layout.subtitle_size ?? 28} min={10} max={90}
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

            {/* ⚠️ Расстояния между строками текста: были зашиты в код, и
                подвинуть их было нельзя — на плотном макете слипались. */}
            <Range label="Отступ от пилюли до заголовка, px"
                   value={layout.gap_pill_title ?? 18} min={0} max={200}
                   onChange={v => patch({ gap_pill_title: v })} />
            <Range label="Отступ от заголовка до подзаголовка, px"
                   value={layout.gap_title_subtitle ?? 14} min={0} max={200}
                   onChange={v => patch({ gap_title_subtitle: v })} />
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
                {/* ⚠️ На афишах по дням текст пилюли дня НЕ вводится руками: он
                    свой у каждого дня и собирается сам («День 1 — 24.09 в 11:00»).
                    Одно поле на все дни давало бы одинаковую пилюлю везде. */}
                {kind === 'day' ? (
                  <div className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
                    Пилюля дня собирается сама для каждого дня: «{days[0]?.label || 'День 1 — 24.09 в 11:00'}»
                  </div>
                ) : (
                <input value={layout.pill_text || ''} placeholder={suggested?.pill_text || '23–24 апреля'}
                       onChange={e => patch({ pill_text: e.target.value })}
                       className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                )}

                <input value={layout.pill_text_2 || ''} placeholder={suggested?.pill_text_2 || 'Онлайн-конференция'}
                       onChange={e => patch({ pill_text_2: e.target.value })}
                       className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                {/* ⚠️⚠️ СКОЛЬКО УГОДНО ПИЛЮЛЬ (миграция 471). Было ровно две и
                    обе зашиты в код — третью («Бесплатно», «Запись будет»,
                    город) добавить было нельзя вовсе. Оформление у всех общее:
                    это те же пилюли, а не новый элемент. */}
                <div className="mt-3 border-t border-gray-100 pt-3">
                  <div className="mb-1 text-xs text-gray-600">Ещё пилюли</div>
                  {extraPills.map((ep, i) => (
                    <div key={i} className="mb-2 rounded-lg border card-border p-2">
                      <div className="flex items-center gap-2">
                        <input value={ep.text || ''} placeholder="Например: Бесплатно"
                               onChange={e => patchPill(i, { text: e.target.value })}
                               className="flex-1 min-w-0 rounded-lg border border-gray-200 px-3 py-2 text-sm" />
                        <button type="button" onClick={() => removePill(i)}
                                className="shrink-0 text-xs text-red-600 hover:underline">
                          Убрать
                        </button>
                      </div>
                      <label className="mt-2 flex items-center gap-2 text-xs text-gray-600">
                        <input type="checkbox"
                               checked={ep.x != null || ep.y != null}
                               onChange={e => patchPill(i, e.target.checked
                                 ? { x: 50, y: 50 } : { x: null, y: null })} />
                        Своё место на афише
                      </label>
                      {(ep.x != null || ep.y != null) && (
                        <>
                          <Range label="Слева направо, %" value={ep.x ?? 50} min={0} max={100}
                                 onChange={v => patchPill(i, { x: v })} />
                          <Range label="Сверху вниз, %" value={ep.y ?? 50} min={0} max={100}
                                 onChange={v => patchPill(i, { y: v })} />
                        </>
                      )}
                    </div>
                  ))}
                  <button type="button" onClick={addPill}
                          className="text-sm text-[#25455D] hover:underline">
                    + Добавить пилюлю
                  </button>
                </div>

                <div className="mt-3">
                  <div className="mb-1 text-xs text-gray-600">Оформление</div>
                  <Choice value={layout.pill_style || 'border'}
                          onChange={v => patch({ pill_style: v as any })}
                          options={[
                            ['border', 'Рамка'], ['filled', 'Заливка'],
                            ['underline', 'Подчёркивание'], ['plain', 'Просто текст'],
                          ]} />
                </div>
                {/* ⚠️ Настройки показываем ПО СТИЛЮ: раньше скругление и цвета
                    висели только под «Рамкой», и при заливке клиент не мог
                    задать ни цвет фона, ни скругление — выглядело как поломка. */}
                {(layout.pill_style === 'border' || layout.pill_style === 'filled' || !layout.pill_style) && (
                  <Range label="Скругление (50 — полукруглые торцы)"
                         value={layout.pill_radius ?? 50} min={0} max={50}
                         onChange={v => patch({ pill_radius: v })} />
                )}
                {(layout.pill_style === 'border' || !layout.pill_style) && (
                  <>
                    <ColorRow label="Цвет рамки" value={layout.pill_border_color}
                              placeholder="золото бренда"
                              onChange={v => patch({ pill_border_color: v })} />
                    <ColorRow label="Второй цвет (рамка градиентом)" value={layout.pill_border_color_2}
                              placeholder="без градиента"
                              onChange={v => patch({ pill_border_color_2: v })} />
                  </>
                )}
                {layout.pill_style === 'underline' && (
                  <ColorRow label="Цвет линии" value={layout.pill_border_color}
                            placeholder="золото бренда"
                            onChange={v => patch({ pill_border_color: v })} />
                )}
                {(layout.pill_style === 'filled' || layout.pill_style === 'border' || !layout.pill_style) && (
                  <ColorRow label={layout.pill_style === 'filled' ? 'Цвет заливки' : 'Цвет фона внутри'}
                            value={layout.pill_bg_color}
                            placeholder={layout.pill_style === 'filled' ? 'золото бренда' : 'прозрачный'}
                            onChange={v => patch({ pill_bg_color: v })} />
                )}
                <ColorRow label="Цвет текста" value={layout.pill_text_color}
                          placeholder="белый"
                          onChange={v => patch({ pill_text_color: v })} />
                <Range label="Размер, px" value={layout.pill_size ?? 22} min={8} max={70}
                       onChange={v => patch({ pill_size: v })} />
              </>
            )}
          </Card>

          </>)}

          {tab === 'logos' && (<>
          <Card title="Логотипы">
            <p className="text-xs text-gray-500 mb-3 leading-relaxed">
              Логотип бренда и логотипы партнёров стоят ОДНОЙ строкой по общим правилам —
              поэтому они не наезжают друг на друга. Порядок меняется перетаскиванием,
              галочка у каждого — показывать его или нет.
            </p>

            <div className="mb-1 text-xs text-gray-600">Какой логотип брать</div>
            {/* ⚠️ Вариант ОБЩИЙ на всю строку: фон афиши один, и «этот логотип
                под тёмный, соседний под светлый» — бессмыслица. */}
            <Choice value={layout.logos_variant || 'light'}
                    onChange={v => patch({ logos_variant: v as any })}
                    options={[['light', 'Для тёмного фона'], ['dark', 'Для светлого фона']]} />
            <p className="text-xs text-gray-400 mt-1 leading-relaxed">
              Действует на все логотипы сразу. Второй вариант загружается в карточке
              партнёра — у карточек с галочкой «Компания» два поля: логотип для тёмного
              и для светлого фона. Нет нужного — возьмётся второй.
            </p>

            <div className="mt-4">
              <div className="mb-1 text-xs text-gray-600">Выравнивание строки</div>
              <Choice value={layout.logos_align || 'center'}
                      onChange={v => patch({ logos_align: v as any })}
                      options={[['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа']]} />
            </div>

            <Range label="Расстояние между логотипами, %" value={layout.logos_gap ?? 2.5}
                   min={0} max={20} onChange={v => patch({ logos_gap: v })} />
            <Range label="Высота строки, %" value={layout.partners_y ?? 5} min={0} max={100}
                   hint="Насколько ниже верхнего поля стоят логотипы"
                   onChange={v => patch({ partners_y: v })} />
            <Range label="Размер логотипа бренда, % ширины" value={layout.brand_logo_size ?? 6}
                   min={1} max={30} onChange={v => patch({ brand_logo_size: v })} />
            <Range label="Размер логотипов партнёров, % ширины" value={layout.partners_size ?? 5}
                   min={1} max={20} onChange={v => patch({ partners_size: v })} />

            <div className="mt-4 pt-4 border-t border-gray-100">
              <div className="text-xs text-gray-600 mb-2">
                Порядок и видимость — перетащите за ⠿
              </div>
              <div className="flex flex-wrap gap-2">
                {logoList.map(l => (
                  <LogoChip key={l.key} item={l}
                            hidden={hiddenSet.has(l.key)}
                            isDragging={dragLogo === l.key}
                            onToggle={() => toggleLogo(l.key)}
                            onDragStart={() => setDragLogo(l.key)}
                            onDragEnd={() => setDragLogo(null)}
                            onDragOver={e => e.preventDefault()}
                            onDrop={() => onDropLogo(l.key)} />
                ))}
                {logoList.length === 0 && (
                  <p className="text-sm text-gray-400">
                    Нет ни логотипа бренда, ни партнёров-компаний.
                  </p>
                )}
              </div>
              {(layout.logos_order?.length || layout.logos_hidden?.length) ? (
                <button onClick={() => patch({ logos_order: [], logos_hidden: [] })}
                        className="text-xs text-gray-400 hover:text-gray-600 underline mt-3">
                  Сбросить порядок и показать все
                </button>
              ) : null}
            </div>
          </Card>
          </>)}

          {tab === 'place' && (<>
          {/* ⚠️⚠️ ОДИН И ТОТ ЖЕ РЫЧАГ ДЛЯ КАЖДОГО БЛОКА (миграция 468).
              Раньше у каждого блока была своя отдельная настройка — или не было
              вовсе: пилюли двигались только вместе с заголовком, тема и время
              на афише спикера не двигались никак. Теперь механизм общий:
              сдвиг вбок и вверх-вниз в ПИКСЕЛЯХ, у текстовых блоков ещё и
              выключка. Пусто = блок стоит там, где стоял раньше. */}
          <Card title="Где что стоит">
            <p className="text-xs text-gray-400 mb-2">
              Сдвиг в пикселях от обычного места. 0 — как было. Значение можно вписать числом.
            </p>
            <PlaceRow label="Логотипы" x={layout.pos_logos_x} y={layout.pos_logos_y}
                      onX={v => patch({ pos_logos_x: v })} onY={v => patch({ pos_logos_y: v })} />
            <PlaceRow label="Заголовок с подзаголовком" x={layout.pos_text_x} y={layout.pos_text_y}
                      onX={v => patch({ pos_text_x: v })} onY={v => patch({ pos_text_y: v })} />
            {/* ⚠️ Пилюли стоят В ОДНУ ЛИНИЮ (так было изначально). Выключка
                задаётся один раз для всей пары — иначе они разъезжаются;
                сдвиг у каждой остаётся свой. */}
            <PlaceRow label="Пилюля с датой" x={layout.pos_pill1_x} y={layout.pos_pill1_y}
                      align={layout.pill1_align} onAlign={v => patch({ pill1_align: v })}
                      alignHint="Где стоит вся пара пилюль"
                      onX={v => patch({ pos_pill1_x: v })} onY={v => patch({ pos_pill1_y: v })} />
            <PlaceRow label="Пилюля с форматом" x={layout.pos_pill2_x} y={layout.pos_pill2_y}
                      onX={v => patch({ pos_pill2_x: v })} onY={v => patch({ pos_pill2_y: v })} />
            {/* ⚠️ Проверка вида здесь не нужна: эта ветка и так только для
                общих и дневных афиш — у спикерской свой редактор. */}
            <PlaceRow label="Спикеры" x={layout.pos_speakers_x} y={layout.pos_speakers_y}
                      onX={v => patch({ pos_speakers_x: v })} onY={v => patch({ pos_speakers_y: v })} />
          </Card>
          </>)}

          {tab === 'order' && (<>
          {/* ⚠️⚠️ ПОРЯДОК — ОТДЕЛЬНО ПО КАЖДОМУ ДНЮ (требование владельца).
              В разные дни выступают разные люди: общая расстановка оставляла
              бы половину дня в авторасскладе. Переключаем день прямо здесь. */}
          {kind === 'day' && days.length > 0 && (
            <div className="mb-4">
              <div className="text-xs text-gray-500 mb-1">Расставляем спикеров для дня:</div>
              <div className="flex flex-wrap gap-2">
                {days.map(d => (
                  <button key={d.day} type="button" onClick={() => setCurDayNo(d.day)}
                          className={`rounded-lg px-3 py-1.5 text-sm transition ${
                            editDay === d.day
                              ? 'bg-[#25455D] text-white'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                    {d.label}
                    <span className="ml-1.5 opacity-60">{d.speaker_ids.length}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">
                У каждого дня свой порядок: переставили здесь — другие дни не тронуты.
              </p>
            </div>
          )}
          <SpeakerRowsEditor
            rows={rowsView}
            manual={kind === 'day'
              ? Array.isArray(curDayRows) && curDayRows.length > 0
              : Array.isArray(layout.speaker_rows) && layout.speaker_rows.length > 0}
            dragId={dragId}
            overRow={overRow}
            onDragStart={setDragId}
            onDragEnd={() => { setDragId(null); setOverRow(null) }}
            onOverRow={setOverRow}
            onDropToRow={(ri) => { if (dragId != null) moveToRow(dragId, ri); setDragId(null); setOverRow(null) }}
            onReset={() => {
              // Сбрасываем ТОЛЬКО текущий день, а не всю расстановку.
              if (kind === 'day' && editDay != null) {
                const next = { ...dayRowsMap }
                delete next[String(editDay)]
                patch({ day_speaker_rows: next } as any)
              } else {
                patch({ speaker_rows: [] })
              }
            }}
            onSetRowCount={setRowCount}
            total={rowsView.reduce((n, r) => n + r.length, 0)}
          />
          </>)}
          </>)}
          </div>
        </div>
      </div>

      {/* Крупный просмотр. ⚠️ Это НЕ форма, а просмотр картинки — закрытие по
          клику на фон здесь разрешено правилами проекта (как у лайтбоксов). */}
      {zoom && (
        <div onClick={() => setZoom(false)}
             className="fixed inset-0 z-[200] bg-black/80 overflow-auto p-4 flex items-start justify-center">
          <div onClick={e => e.stopPropagation()} className="relative my-auto">
            <div style={{ width: size.w * zoomScale, height: size.h * zoomScale }}
                 className="overflow-hidden rounded-xl shadow-2xl">
              <PosterCanvas layout={layout} theme={theme} people={people}
                            scale={zoomScale} suggested={suggested}
                            days={days} sessions={sessions}
                            day={kind === 'day' ? (days[0]?.day ?? null) : null}
                            speakerId={kind === 'individual' ? indSpeakerId : null} />
            </div>
            <button onClick={() => setZoom(false)}
                    className="absolute -top-3 -right-3 bg-white text-gray-700 rounded-full w-8 h-8 shadow-lg hover:bg-gray-100">
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Карточка человека в списке перетаскивания. */
function PersonChip({ p, isDragging, onDragStart, onDragOver, onDrop, onDragEnd }: {
  p: PosterPerson
  isDragging: boolean
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
  /** Нужен рядам: по окончании перетаскивания снимаем подсветку. */
  onDragEnd?: () => void
}) {
  // ⚠️ `draggable` включается ТОЛЬКО когда мышь на ручке ⠿ — тот же приём, что
  // у блоков лендинга: иначе браузер тащит карточку при выделении текста.
  const [canDrag, setCanDrag] = useState(false)
  const subs = subscribersOf(p)
  return (
    <div
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragEnd={() => { setCanDrag(false); onDragEnd?.() }}
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
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-gray-600">
        <span className="min-w-0 truncate">{label}</span>
        {/* ⚠️⚠️ ЗНАЧЕНИЕ МОЖНО ВПИСАТЬ ЧИСЛОМ (требование владельца). Ползунком
            точное значение не поймать: экран узкий, шаг крупный, и «попасть
            в 47» мышью невозможно. Раньше здесь был просто текст. */}
        <NumBox value={value} min={min} max={max} step={step} onChange={onChange} />
      </div>
      <input type="range" min={min} max={max} step={step} value={value} className="w-full"
             onChange={e => onChange(Number(e.target.value))} />
      {hint && <div className="mt-0.5 text-xs text-gray-400">{hint}</div>}
    </div>
  )
}

/**
 * Числовое поле рядом с ползунком.
 *
 * ⚠️ Держит СВОЙ текст, пока его правят: иначе при вводе «-12» строка «-»
 * превратилась бы в NaN и поле очищалось бы под пальцами. Наружу отдаём
 * только законченное число, зажатое в границы.
 */
function NumBox({ value, min, max, step, onChange }: {
  value: number; min: number; max: number; step: number
  onChange: (v: number) => void
}) {
  const [raw, setRaw] = useState<string | null>(null)
  const shown = raw ?? String(value ?? '')
  return (
    <input
      type="text" inputMode="numeric" value={shown}
      onChange={e => {
        const t = e.target.value
        setRaw(t)
        if (t === '' || t === '-') return
        const n = Number(t.replace(',', '.'))
        if (!Number.isFinite(n)) return
        onChange(Math.max(min, Math.min(max, n)))
      }}
      onBlur={() => setRaw(null)}
      className="w-14 shrink-0 rounded border border-gray-200 px-1.5 py-0.5 text-right text-xs text-gray-700"
    />
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


/**
 * Спикеры ПО РЯДАМ — перетаскиванием между рядами.
 *
 * ⚠️⚠️ СКОЛЬКО ПОЛОЖИЛИ В РЯД — СТОЛЬКО И БУДЕТ (миграция 445). Ряды разной
 * длины это норма: так и верстают афиши — сверху двое крупно, ниже пятеро
 * плотнее. Выравнивать ряды автоматикой нельзя, иначе перетаскивание теряет
 * смысл: человек уедет обратно при следующем пересчёте.
 *
 * ⚠️ Показываем ИМЕННО РЯДЫ, а не общий список: клиент должен видеть ту же
 * структуру, что получится на афише.
 */
function SpeakerRowsEditor({
  rows, manual, dragId, overRow,
  onDragStart, onDragEnd, onOverRow, onDropToRow, onReset,
  onSetRowCount, total,
}: {
  rows: PosterPerson[][]
  manual: boolean
  dragId: number | null
  overRow: number | null
  onDragStart: (id: number) => void
  onDragEnd: () => void
  onOverRow: (ri: number | null) => void
  onDropToRow: (ri: number) => void
  onReset: () => void
  /** Разложить всех на заданное число рядов. */
  onSetRowCount: (n: number) => void
  total: number
}) {

  return (
    <Card title="Спикеры по рядам">
      <p className="text-xs text-gray-500 mb-3 leading-relaxed">
        Перетащите человека за ⠿ в нужный ряд — афиша перестроится сразу.
        Сколько людей положите в ряд, столько в нём и будет: ряды могут быть разной длины.
        {!manual && <> Сейчас расстановка автоматическая — перетащите кого-нибудь, чтобы задать свою.</>}
      </p>

      {/* ⚠️ КОЛИЧЕСТВО РЯДОВ задаётся кнопкой, а не только перетаскиванием:
          разложить 13 человек на 3 ряда вручную — это тринадцать перетаскиваний.
          Кнопка раскладывает сразу, а дальше клиент правит руками кого надо.
          Порядок людей при этом СОХРАНЯЕТСЯ — перестановки не сбрасываются. */}
      {total > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-600">Разложить на</span>
          {Array.from({ length: Math.min(8, total) }, (_, i) => i + 1).map(n => (
            <button key={n} type="button" onClick={() => onSetRowCount(n)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      rows.length === n
                        ? 'bg-[#25455D] text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {n} {n === 1 ? 'ряд' : n < 5 ? 'ряда' : 'рядов'}
            </button>
          ))}
        </div>
      )}

      {total === 0 ? (
        <p className="text-sm text-gray-400">У события пока нет спикеров с фотографиями.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, ri) => (
            <div key={ri}
                 onDragOver={e => { e.preventDefault(); onOverRow(ri) }}
                 onDragLeave={() => onOverRow(null)}
                 onDrop={() => onDropToRow(ri)}
                 className={`rounded-xl border-2 border-dashed px-3 py-2.5 transition-colors ${
                   overRow === ri ? 'border-[#FFCFA4] bg-[#FFCFA4]/10' : 'border-gray-200'}`}>
              <div className="text-[11px] text-gray-400 mb-1.5">
                Ряд {ri + 1} — {row.length} чел.
              </div>
              <div className="flex flex-wrap gap-2">
                {row.map(p => (
                  <PersonChip key={p.id} p={p}
                              isDragging={dragId === p.id}
                              onDragStart={() => onDragStart(p.id)}
                              onDragEnd={onDragEnd}
                              onDragOver={e => e.preventDefault()}
                              onDrop={() => onDropToRow(ri)} />
                ))}
              </div>
            </div>
          ))}

          {/* ⚠️ Пустой ряд снизу — единственный способ СОЗДАТЬ новый ряд
              перетаскиванием. Без него клиент мог бы только перекладывать
              людей между уже существующими. */}
          <div onDragOver={e => { e.preventDefault(); onOverRow(rows.length) }}
               onDragLeave={() => onOverRow(null)}
               onDrop={() => onDropToRow(rows.length)}
               className={`rounded-xl border-2 border-dashed px-3 py-3 text-center text-xs transition-colors ${
                 overRow === rows.length
                   ? 'border-[#FFCFA4] bg-[#FFCFA4]/10 text-[#25455D]'
                   : 'border-gray-200 text-gray-400'}`}>
            Перетащите сюда, чтобы создать новый ряд
          </div>
        </div>
      )}

      {manual && (
        <button onClick={onReset}
                className="text-xs text-gray-400 hover:text-gray-600 underline mt-3">
          Вернуть автоматическую расстановку
        </button>
      )}
    </Card>
  )
}


/** Логотип в списке: перетаскивание за ⠿ + галочка «показывать». */
function LogoChip({ item, hidden, isDragging, onToggle, onDragStart, onDragEnd, onDragOver, onDrop }: {
  item: { key: string; url: string; name: string; isBrand: boolean }
  hidden: boolean
  isDragging: boolean
  onToggle: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
}) {
  const [canDrag, setCanDrag] = useState(false)
  return (
    <div
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragEnd={() => { setCanDrag(false); onDragEnd() }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`flex items-center gap-2 rounded-lg border bg-white px-2 py-1.5 transition ${
        isDragging ? 'opacity-40 border-[#FFCFA4]' : 'border-gray-200'} ${hidden ? 'opacity-50' : ''}`}
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
      {/* ⚠️ Логотип на СВЕТЛОЙ подложке: светлый вариант логотипа на белом фоне
          списка не виден вовсе, и клиент решил бы, что файла нет. */}
      <span className="w-12 h-7 rounded bg-gray-100 flex items-center justify-center shrink-0 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.url} alt="" className="max-w-full max-h-full object-contain" />
      </span>
      <span className="text-xs text-gray-800 truncate max-w-[120px]">{item.name}</span>
      <label className="flex items-center gap-1 text-[11px] text-gray-500 cursor-pointer shrink-0">
        <input type="checkbox" checked={!hidden} onChange={onToggle} />
        показывать
      </label>
    </div>
  )
}

/**
 * Рычаги положения одного блока: вбок, вверх-вниз и (у текста) выключка.
 *
 * ⚠️ Один компонент на все блоки — в этом и смысл: у логотипов, пилюль, темы
 * и времени рычаг обязан вести себя одинаково. Раньше у каждого блока была
 * своя настройка со своими единицами, и клиент каждый раз заново угадывал,
 * что означает число.
 *
 * ⚠️ ПИКСЕЛИ, а не проценты: проценты пересчитывались при смене полей, и блок
 * уезжал сам собой. Диапазон ±400 px — этого хватает, чтобы увести блок в
 * любой угол листа, а за поля его всё равно не выпустит рабочая область.
 */
function PlaceRow({ label, x, y, align, onX, onY, onAlign, alignHint }: {
  label: string
  x?: number | null
  y?: number | null
  align?: 'left' | 'center' | 'right'
  onX: (v: number) => void
  onY: (v: number) => void
  onAlign?: (v: 'left' | 'center' | 'right') => void
  alignHint?: string
}) {
  return (
    <div className="mt-4 border-t border-gray-100 pt-3 first:border-0 first:pt-0">
      <div className="text-xs font-medium text-gray-700">{label}</div>
      <Range label="Вбок, px" value={x ?? 0} min={-400} max={400} onChange={onX} />
      <Range label="Вверх-вниз, px" value={y ?? 0} min={-400} max={400} onChange={onY} />
      {onAlign && (
        <div className="mt-2">
          <div className="mb-1 text-xs text-gray-600">{alignHint || 'Прижать текст'}</div>
          <Choice value={align || 'center'}
                  onChange={v => onAlign(v as 'left' | 'center' | 'right')}
                  options={[['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа']]} />
        </div>
      )}
    </div>
  )
}


/**
 * Всё про ОДИН элемент афиши спикера: текст, положение, размер, цвет, шрифт.
 *
 * ⚠️⚠️ ВСЁ В ОДНОМ МЕСТЕ И БЕЗ ОТСЫЛОК. Раньше настройки одного элемента были
 * раскиданы по разным вкладкам, а часть заменена подписями «смотрите в другой
 * вкладке» — найти что-либо было невозможно.
 *
 * ⚠️⚠️ ПОЛЗУНКИ ПОЛОЖЕНИЯ ВИДНЫ ВСЕГДА, без галочек-переключателей. Спрятанные
 * за галочку, они выглядели как отсутствующие: «положения нет, ничего нет».
 * Ноль на шкале — элемент у верхнего (левого) поля, сто — у нижнего (правого),
 * уже с учётом отступов. Значит он доезжает до самого низа и не вылезает.
 */
function IndElement({
  title, hint, text, textPlaceholder, onText,
  x, y, onX, onY,
  size, sizeMin, sizeMax, onSize,
  color, onColor, font, onFont, theme,
  align, onAlign, width, onWidth,
  shown, onShown, children,
}: {
  title: string
  hint?: string
  text?: string | null
  textPlaceholder?: string
  onText?: (v: string) => void
  x?: number | null; y?: number | null
  onX?: (v: number) => void; onY?: (v: number) => void
  size?: number; sizeMin?: number; sizeMax?: number; onSize?: (v: number) => void
  color?: string | null; onColor?: (v: string | null) => void
  font?: string | null; onFont?: (v: string | null) => void
  theme: PosterTheme
  align?: 'left' | 'center' | 'right'; onAlign?: (v: 'left' | 'center' | 'right') => void
  width?: number | null; onWidth?: (v: number) => void
  shown?: boolean; onShown?: (v: boolean) => void
  children?: React.ReactNode
}) {
  return (
    <Card title={title}>
      {onShown && (
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={shown !== false}
                 onChange={e => onShown(e.target.checked)} />
          Показывать
        </label>
      )}

      {onText && (
        <input value={text || ''} placeholder={textPlaceholder}
               onChange={e => onText(e.target.value)}
               className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
      )}
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}

      {onX && (
        <Range label="Слева направо, %" value={x ?? 50} min={0} max={100}
               hint="0 — левое поле, 100 — правое"
               onChange={onX} />
      )}
      {onY && (
        <Range label="Сверху вниз, %" value={y ?? 80} min={0} max={100}
               hint="0 — верхнее поле, 100 — нижнее: элемент доезжает до самого низа"
               onChange={onY} />
      )}

      {onSize && (
        <Range label="Размер, px" value={size ?? 24} min={sizeMin ?? 8} max={sizeMax ?? 120}
               onChange={onSize} />
      )}
      {onWidth && (
        <Range label="Ширина, %" value={width ?? 80} min={5} max={100}
               hint="Чтобы длинный текст переносился, а не уезжал за поля"
               onChange={onWidth} />
      )}
      {onColor && <ColorRow label="Цвет" value={color} onChange={onColor} />}
      {onAlign && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-gray-600">Прижать текст</div>
          <Choice value={align || 'center'}
                  onChange={v => onAlign(v as 'left' | 'center' | 'right')}
                  options={[['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа']]} />
        </div>
      )}
      {onFont && <FontPicker theme={theme} value={font} onChange={onFont} />}
      {children}
    </Card>
  )
}
