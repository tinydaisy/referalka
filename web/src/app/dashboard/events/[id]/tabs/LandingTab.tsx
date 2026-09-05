'use client'

/**
 * Вкладка «Лендинг» — конструктор продающей страницы события (миграция 240).
 *
 * Две подстраницы: основная (pluson.ru/e/{slug}) и «после оплаты»
 * (pluson.ru/e/{slug}/thanks — её клиент ставит как return-url в платёжке).
 *
 * Блоки перетаскиваются мышью, выключаются галочкой. Живые блоки (спикеры,
 * программа, тарифы, организатор) содержимого не хранят — тянут данные события,
 * поэтому правка спикера сразу видна на лендинге.
 *
 * Сохранение — по факту правки, с задержкой (не дёргаем сервер на каждую букву).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Eye, Plus, Loader2, ExternalLink, Palette, Copy } from 'lucide-react'
import PreviewLinkButton from '@/components/PreviewLinkButton'
import LandingPdfButton from '@/components/LandingPdfButton'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import BlockCard from '@/components/landing/BlockCard'
import { REPEATABLE, STANDARD, metaFor } from '@/components/landing/blockMeta'
import { ColorField, MetallicToggle, FontSelect, BackgroundFields, BgFramingFields } from '@/components/landing/StyleControls'

interface Props {
  eventId: number
  event: any
}

type PageKind = 'main' | 'post_pay'

/** «12.06.2026 · » перед названием события в списке доноров. Даты нет — пусто. */
function eventDateLabel(s: any): string {
  if (!s?.start_at) return ''
  const d = new Date(s.start_at)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' · '
}

export default function LandingTab({ eventId, event }: Props) {
  // ⚠️ Хук — до любых early-return. Домен клиента, а не наш: эту ссылку он
  // копирует и отдаёт своей аудитории.
  const { publicHost } = useMe()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pages, setPages] = useState<any[]>([])
  const [fonts, setFonts] = useState<any[]>([])
  const [meta, setMeta] = useState<any>(null)
  const [kind, setKind] = useState<PageKind>('main')
  const [dragId, setDragId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [seats, setSeats] = useState<string>('')
  // Копирование лендинга из другого события: список доноров грузим по клику,
  // а не при открытии вкладки — незачем дёргать сервер ради редкого действия.
  const [copyOpen, setCopyOpen] = useState(false)
  const [copySources, setCopySources] = useState<any[]>([])
  const [copySourceId, setCopySourceId] = useState<number | null>(null)
  const [copyTariffs, setCopyTariffs] = useState(true)
  const [copyBusy, setCopyBusy] = useState(false)
  // Выбор источника оформления: свой кабинет / другой организатор коллабы /
  // стандартный стиль платформы. Список грузим по клику, как доноров лендинга.
  const [themeOpen, setThemeOpen] = useState(false)
  const [themeSources, setThemeSources] = useState<any[]>([])
  const [themeChoice, setThemeChoice] = useState<string>('')
  const [themeBusy, setThemeBusy] = useState(false)
  // Списки для выпадающих настроек блоков: какой тариф подсветить и какую
  // оферту показать в подвале. Оба необязательны — раздел может быть закрыт
  // тарифом, тогда список просто пустой.
  const [tariffs, setTariffs] = useState<any[]>([])
  const [offers, setOffers] = useState<any[]>([])
  const [surveys, setSurveys] = useState<any[]>([])

  // Отложенное сохранение: пока клиент печатает — копим правки, шлём одним PATCH.
  const timers = useRef<Record<string, any>>({})

  const load = async () => {
    try {
      setLoading(true)
      const res = await api.eventLanding.get(eventId)
      setPages(res.pages || [])
      setFonts(res.fonts || [])
      setMeta(res.event || null)
      setSeats(res.event?.seats_total != null ? String(res.event.seats_total) : '')
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить лендинг')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [eventId])

  // Тарифы и оферты грузим отдельно и молча: если раздел недоступен на
  // тарифе клиента, выпадающий список просто останется пустым.
  useEffect(() => {
    api.eventTariffs.list(eventId)
      .then(r => setTariffs(r.items || r || []))
      .catch(() => {})
    api.offers.list()
      .then(r => setOffers(r.items || []))
      .catch(() => {})
    // Анкеты — для блока «Анкета / Заявка».
    // ⚠️ `GET /surveys` отдаёт ГОЛЫЙ МАССИВ, не объект со списком.
    api.surveys.list()
      .then((r: any) => setSurveys(Array.isArray(r) ? r : []))
      .catch(() => {})
  }, [eventId])

  const page = useMemo(() => pages.find(p => p.kind === kind), [pages, kind])
  // Защита от неверных данных: если nav_items придёт не массивом, .map ниже
  // уронил бы всю вкладку (Application error).
  const navItems: any[] = Array.isArray(page?.nav_items) ? page!.nav_items : []

  // Что предлагать в «Добавить секцию»: повторяемые блоки — всегда, стандартные
  // — только те, которых на странице сейчас нет (их можно по одной штуке).
  const addableKinds = useMemo(() => {
    const present = new Set<string>((page?.blocks || []).map((b: any) => b.kind))
    const all = [...REPEATABLE, ...STANDARD.filter(k => !present.has(k))]
    // ⚠️ У СОВМЕСТНОГО события блока «Анкета / Заявка» нет: лендинг общий, а
    // базы контактов у организаторов разные — заявка ушла бы в базу того, кто
    // поставил форму, и человек, пришедший по ссылке партнёра, стал бы чужим
    // контактом. Бэкенд отвечает на такое создание 400; здесь просто не
    // предлагаем, чтобы клиент не упирался в отказ.
    return event?.is_collab ? all.filter(k => k !== 'survey') : all
  }, [page, event?.is_collab])

  /* ── правка настроек страницы ─────────────────────────────────────────── */
  // ⚠️ Накопительное сохранение. Раньше в setTimeout уходил ТОЛЬКО последний
  // patch: при быстром вводе (буква за буквой) предыдущие правки терялись, и
  // поле выглядело «не принимающим ввод». Теперь копим все правки в pending и
  // отправляем одним запросом.
  const pendingPage = useRef<Record<number, any>>({})

  const patchPage = (patch: any) => {
    if (!page) return
    const pageId = page.id
    setPages(prev => prev.map(p => p.id === pageId ? { ...p, ...patch } : p))
    pendingPage.current[pageId] = { ...(pendingPage.current[pageId] || {}), ...patch }
    const key = `page-${pageId}`
    clearTimeout(timers.current[key])
    timers.current[key] = setTimeout(async () => {
      const body = pendingPage.current[pageId]
      delete pendingPage.current[pageId]
      if (!body) return
      setSaving(true)
      try { await api.eventLanding.patchPage(eventId, pageId, body) }
      catch (e: any) { alert(e?.message || 'Не удалось сохранить') }
      finally { setSaving(false) }
    }, 600)
  }

  /* ── правка блока ─────────────────────────────────────────────────────── */
  const pendingBlock = useRef<Record<number, any>>({})

  const patchBlock = (blockId: number, patch: any) => {
    setPages(prev => prev.map(p => p.id !== page?.id ? p : {
      ...p,
      blocks: p.blocks.map((b: any) => b.id === blockId ? { ...b, ...patch } : b),
    }))
    pendingBlock.current[blockId] = { ...(pendingBlock.current[blockId] || {}), ...patch }
    const key = `block-${blockId}`
    clearTimeout(timers.current[key])
    timers.current[key] = setTimeout(async () => {
      const body = pendingBlock.current[blockId]
      delete pendingBlock.current[blockId]
      if (!body) return
      setSaving(true)
      try { await api.eventLanding.patchBlock(eventId, blockId, body) }
      catch (e: any) { alert(e?.message || 'Не удалось сохранить') }
      finally { setSaving(false) }
    }, 600)
  }

  const removeBlock = async (blockId: number) => {
    try {
      await api.eventLanding.removeBlock(eventId, blockId)
      setPages(prev => prev.map(p => p.id !== page?.id ? p : {
        ...p, blocks: p.blocks.filter((b: any) => b.id !== blockId),
      }))
    } catch (e: any) { alert(e?.message || 'Не удалось удалить') }
  }

  const addBlock = async (blockKind: string) => {
    if (!page) return
    try {
      const created = await api.eventLanding.createBlock(eventId, page.id, {
        kind: blockKind,
        // ⚠️ Заголовок НЕ подставляем: иначе на лендинге появится текст
        // «Элемент: кнопка», которого клиент нигде не задавал.
        admin_name: metaFor(blockKind).label,
        items: blockKind === 'gallery'
          ? { mode: 'carousel', media: 'image', list: [] }
          : [],
      })
      setPages(prev => prev.map(p => p.id !== page.id ? p : {
        ...p, blocks: [...p.blocks, created],
      }))
    } catch (e: any) { alert(e?.message || 'Не удалось добавить секцию') }
  }

  /* ── перетаскивание ───────────────────────────────────────────────────── */
  const onDrop = async (targetId: number) => {
    if (!page || dragId == null || dragId === targetId) { setDragId(null); return }
    const list = [...page.blocks]
    const from = list.findIndex(b => b.id === dragId)
    const to = list.findIndex(b => b.id === targetId)
    if (from < 0 || to < 0) { setDragId(null); return }
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    setPages(prev => prev.map(p => p.id === page.id ? { ...p, blocks: list } : p))
    setDragId(null)
    try { await api.eventLanding.reorder(eventId, page.id, list.map(b => b.id)) }
    catch (e: any) { alert(e?.message || 'Не удалось сохранить порядок'); load() }
  }

  // Тема копируется в страницу при создании; для уже собранной страницы —
  // явная кнопка, иначе правка «Стилей лендингов» не видна на лендинге.
  //
  // ⚠️ У КОЛЛАБЫ выбор обязателен: страница создаётся в стандартном стиле
  // платформы (своей темы у общего события нет), и чьё оформление взять —
  // решают организаторы, а не порядок строк в базе.
  const openTheme = async () => {
    setThemeOpen(true)
    if (themeSources.length) return
    setThemeBusy(true)
    try {
      const res = await api.eventLanding.themeSources(eventId)
      setThemeSources(res.sources || [])
    } catch (e: any) {
      alert(e?.message || 'Не удалось загрузить список организаторов')
    } finally { setThemeBusy(false) }
  }

  const doApplyTheme = async () => {
    if (!page) return
    const toDefault = themeChoice === 'default'
    const src = themeSources.find(s => String(s.id) === themeChoice)
    if (!toDefault && !src) return
    if (!confirm(
      (toDefault
        ? 'Вернуть странице стандартный стиль ПЛЮСОНа?'
        : `Применить оформление «${src?.title || 'организатора'}»?`) +
      '\n\nЦвета, шрифты, отступы и ширина заменятся. Содержимое блоков не изменится.'
    )) return
    setThemeBusy(true)
    try {
      const updated = await api.eventLanding.applyTheme(eventId, page.id, toDefault
        ? { reset_to_default: true }
        : { source_client_id: src.id })
      setPages(prev => prev.map(p => p.id === page.id ? { ...p, ...updated } : p))
      setThemeOpen(false)
    } catch (e: any) {
      alert(e?.message || 'Не удалось применить стиль')
    } finally { setThemeBusy(false) }
  }

  const openCopy = async () => {
    setCopyOpen(true)
    if (copySources.length) return
    try {
      const res = await api.eventLanding.copySources(eventId)
      setCopySources(res.events || [])
    } catch (e: any) { alert(e?.message || 'Не удалось загрузить список событий') }
  }

  const doCopy = async () => {
    if (!copySourceId) return
    const src = copySources.find(s => s.id === copySourceId)
    // ⚠️ Спрашиваем явно: копирование ЗАМЕЩАЕТ текущий лендинг, а не дополняет.
    if (!confirm(
      `Взять лендинг из «${src?.title || 'события'}»?\n\n` +
      'Текущие блоки этого лендинга будут заменены' +
      (copyTariffs ? ', тарифы — тоже' : '') + '. Отменить будет нельзя.'
    )) return
    setCopyBusy(true)
    try {
      const res = await api.eventLanding.copyFrom(eventId, copySourceId, copyTariffs)
      setCopyOpen(false)
      setCopySourceId(null)
      await load()
      alert(`Готово: перенесено блоков — ${res.blocks}` +
            (copyTariffs ? `, тарифов — ${res.tariffs}` : ''))
    } catch (e: any) {
      alert(e?.message || 'Не удалось скопировать лендинг')
    } finally { setCopyBusy(false) }
  }

  const saveSeats = async (patch: any = {}) => {
    const v = seats.trim() === '' ? null : Math.max(0, parseInt(seats, 10) || 0)
    const body = {
      seats_total: v,
      seats_label: meta?.seats_label ?? null,
      seats_label_position: meta?.seats_label_position || 'top',
      seats_size: meta?.seats_size ?? null,
      seats_count_mode: meta?.seats_count_mode || 'registered',
      seats_base: meta?.seats_base ?? null,
      ...patch,
    }
    try {
      await api.eventLanding.setSeats(eventId, body)
      setMeta((m: any) => ({ ...m, ...body }))
    } catch (e: any) { alert(e?.message || 'Не удалось сохранить') }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Загружаем конструктор…
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-800">
        {error}
      </div>
    )
  }

  if (!page) return null

  const publicUrl = `/e/${meta?.slug}${kind === 'post_pay' ? '/thanks' : ''}`

  return (
    <div className="space-y-5">
      {/* Подвкладки страниц */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 border-b border-gray-200">
          {([
            { key: 'main' as const, label: 'Основная страница' },
            { key: 'post_pay' as const, label: 'Страница после оплаты' },
          ]).map(t => (
            <button
              key={t.key}
              onClick={() => setKind(t.key)}
              className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                kind === t.key ? 'border-brand text-brand'
                               : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {saving && (
          <span className="flex items-center gap-1.5 text-xs text-gray-400">
            <Loader2 className="h-3 w-3 animate-spin" /> сохраняем…
          </span>
        )}
      </div>

      {/* Публикация + просмотр */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4">
        <div className="min-w-0">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={!!page.is_published}
              onChange={e => patchPage({ is_published: e.target.checked })}
              className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
            />
            <span className="font-medium text-gray-900">Страница опубликована</span>
          </label>
          <p className="mt-1 text-sm text-gray-500">
            {page.is_published
              ? <>Доступна по ссылке <span className="font-mono text-gray-700">https://{publicHost}{publicUrl}</span></>
              : 'Пока черновик — посторонние страницу не увидят. Вы можете открыть её кнопкой «Посмотреть черновик».'}
          </p>
        </div>
        {/* ⚠️ items-start, а не items-center: у кнопки PDF во время сборки
            появляется подпись, и при центрировании она приподнимала бы весь
            ряд кнопок. */}
        <div className="flex shrink-0 items-start gap-2">
          <button
            onClick={openCopy}
            title="Перенести блоки и оформление лендинга из другого вашего события"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Copy className="h-4 w-4" /> Скопировать из другого события
          </button>
          <button
            onClick={openTheme}
            title="Взять цвета, шрифты и отступы из «Стилей лендингов» — своих или другого организатора"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Palette className="h-4 w-4" /> Применить стили
          </button>
          {/* ⚠️ У ЧЕРНОВИКА обычная ссылка ведёт в «Лендинг не опубликован» —
              посмотреть, что собрал, было нечем, и страницу настраивали
              вслепую. Для черновика открываем по временной ссылке-предпросмотру
              (2 часа), для опубликованного — обычной ссылкой. */}
          {page.is_published ? (
            <a
              /* ⚠️ Полный адрес на домене клиента, а не путь: относительная
                 ссылка открылась бы на pluson.ru — кабинет-то там. */
              href={`https://${publicHost}${publicUrl}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Eye className="h-4 w-4" /> Посмотреть
              <ExternalLink className="h-3.5 w-3.5 text-gray-400" />
            </a>
          ) : (
            <PreviewLinkButton
              url={`https://${publicHost}${publicUrl}`}
              label="Посмотреть черновик"
              className="px-4 py-2 text-sm font-medium border-gray-300"
            />
          )}
          {/* ⚠️ Файл для тех, у кого ссылка не открывается: корпоративная сеть
              режет домен, встроенный браузер мессенджера падает, нет интернета.
              Собирается в мобильной вёрстке — её и увидит человек в PDF. */}
          <LandingPdfButton
            onDownload={() => api.eventLanding.pdf(
              eventId, page.id, `${meta?.title || 'Лендинг'}.pdf`,
            )}
          />
        </div>
      </div>

      {/* Всего мест — только на основной странице */}
      {kind === 'main' && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Всего мест на событии
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="number" min={0}
              value={seats}
              onChange={e => setSeats(e.target.value)}
              onBlur={() => saveSeats()}
              placeholder="без лимита"
              className="input w-40"
            />
            <span className="text-sm text-gray-500">
              Занято сейчас: <b>{meta?.seats_taken ?? 0}</b>
              {meta?.seats_total != null && (
                <> · свободно: <b>{Math.max(0, meta.seats_total - (meta.seats_taken || 0))}</b></>
              )}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Пусто — блок «Осталось мест» покажет только число записавшихся.
          </p>

          <div className="mt-4 grid gap-4 border-t border-gray-100 pt-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Подпись у счётчика
              </label>
              <input
                type="text"
                value={meta?.seats_label ?? ''}
                onChange={e => setMeta((m: any) => ({ ...m, seats_label: e.target.value }))}
                onBlur={e => saveSeats({ seats_label: e.target.value || null })}
                placeholder="ОСТАЛОСЬ МЕСТ:"
                className="input"
              />
              <p className="mt-1 text-xs text-gray-500">Пусто — только цифра.</p>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Где подпись
              </label>
              <div className="flex gap-2">
                {([['top', 'Сверху'], ['left', 'Слева'], ['right', 'Справа']] as const)
                  .map(([val, label]) => (
                    <button
                      key={val}
                      onClick={() => saveSeats({ seats_label_position: val })}
                      className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
                        (meta?.seats_label_position || 'top') === val
                          ? 'border-brand bg-brand/5 font-medium text-brand'
                          : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Что считать занятым
              </label>
              <div className="flex gap-2">
                {([
                  ['registered', 'Записались'],
                  ['visited', 'Зашли'],
                ] as const).map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => saveSeats({ seats_count_mode: val })}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
                      (meta?.seats_count_mode || 'registered') === val
                        ? 'border-brand bg-brand/5 font-medium text-brand'
                        : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-gray-500">
                «Зашли» — все, кто открыл событие, даже если не дошли до записи.
              </p>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Прибавить к счётчику
              </label>
              <input
                type="number" min={0}
                value={meta?.seats_base ?? ''}
                onChange={e => setMeta((m: any) => ({
                  ...m, seats_base: e.target.value === '' ? null : Number(e.target.value),
                }))}
                onBlur={e => saveSeats({
                  seats_base: e.target.value === '' ? null : Number(e.target.value),
                })}
                placeholder="0"
                className="input"
              />
              <p className="mt-1 text-xs text-gray-500">
                Если у вас уже есть аудитория — например, 1100 человек в чате.
                Счётчик пойдёт от этого числа.
              </p>
            </div>

            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Размер цифры: {meta?.seats_size ? `${meta.seats_size} px` : 'обычный'}
              </label>
              <div className="flex items-center gap-3">
                <input type="range" min={12} max={120} step={2}
                  value={meta?.seats_size ?? 38}
                  onChange={e => setMeta((m: any) => ({ ...m, seats_size: Number(e.target.value) }))}
                  onMouseUp={e => saveSeats({ seats_size: Number((e.target as HTMLInputElement).value) })}
                  className="w-full" />
                {meta?.seats_size != null && (
                  <button
                    onClick={() => saveSeats({ seats_size: null })}
                    className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                  >
                    сбросить
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Шапка-меню */}
      {kind === 'main' && (
        <details className="rounded-xl border border-gray-200 bg-white">
          <summary className="cursor-pointer p-4 font-medium text-gray-900">
            Шапка с меню {page.nav_enabled ? '· включена' : '· выключена'}
          </summary>
          <div className="space-y-4 border-t border-gray-100 p-4">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={!!page.nav_enabled}
                onChange={e => patchPage({ nav_enabled: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
              />
              <span className="font-medium text-gray-900">
                Показывать шапку с логотипом и меню
              </span>
            </label>
            <p className="text-sm text-gray-500">
              Логотип берётся из визитки бренда (Настройки → Mini App → Бренд).
              Пункты меню прокручивают страницу к нужной секции.
            </p>

            {page.nav_enabled && (
              <>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Подпись кнопки в шапке
                  </label>
                  <input
                    type="text"
                    value={page.nav_button_label || ''}
                    onChange={e => patchPage({ nav_button_label: e.target.value })}
                    className="input"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Пусто — кнопки в шапке не будет.
                  </p>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Куда ведёт кнопка в шапке
                  </label>
                  <select
                    value={page.nav_button_target || 'register'}
                    onChange={e => patchPage({ nav_button_target: e.target.value })}
                    className="input bg-white"
                  >
                    <option value="register">На регистрацию</option>
                    {(page.blocks || []).map((b: any) => (
                      <option key={b.id} value={b.kind}>
                        К секции «{b.admin_name || metaFor(b.kind).label}»
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Пункты меню
                  </label>
                  <p className="mb-2 text-xs text-gray-500">
                    Слева — как пункт называется в шапке, справа — к какой секции
                    он прокручивает страницу.
                  </p>
                  <div className="space-y-2">
                    {navItems.map((it: any, i: number) => (
                      <div key={i} className="flex flex-wrap items-end gap-2">
                        <div className="min-w-[160px] flex-1">
                          <div className="mb-1 text-xs font-medium text-gray-600">
                            Название пункта
                          </div>
                          <input
                            type="text"
                            value={it.label || ''}
                            onChange={e => {
                              const next = [...navItems]
                              next[i] = { ...next[i], label: e.target.value }
                              patchPage({ nav_items: next })
                            }}
                            placeholder="Спикеры"
                            className="input"
                          />
                        </div>
                        <div className="min-w-[200px] flex-1">
                          <div className="mb-1 text-xs font-medium text-gray-600">
                            Куда ведёт
                          </div>
                          <select
                            value={it.block_kind || ''}
                            onChange={e => {
                              const next = [...navItems]
                              next[i] = { ...next[i], block_kind: e.target.value }
                              patchPage({ nav_items: next })
                            }}
                            className="input bg-white"
                          >
                            <option value="">— выберите секцию —</option>
                            {(page.blocks || []).map((b: any) => (
                              <option key={b.id} value={b.kind}>
                                {b.admin_name || metaFor(b.kind).label}
                              </option>
                            ))}
                          </select>
                        </div>
                        {/* На узком экране пунктов помещается мало — клиент
                            сам решает, какие из них показать в раскрывашке. */}
                        <label className="mb-2 flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-gray-600">
                          <input
                            type="checkbox"
                            checked={it.mobile !== false}
                            onChange={e => {
                              const next = [...navItems]
                              next[i] = { ...next[i], mobile: e.target.checked }
                              patchPage({ nav_items: next })
                            }}
                            className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                          />
                          на телефоне
                        </label>
                        <button
                          onClick={() => patchPage({
                            nav_items: navItems.filter((_: any, j: number) => j !== i),
                          })}
                          title="Удалить пункт"
                          className="mb-1 shrink-0 rounded px-2 py-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  {navItems.length < 8 && (
                    <button
                      onClick={() => patchPage({
                        nav_items: [...navItems, { label: '', block_kind: '' }],
                      })}
                      className="mt-2 text-sm font-medium text-brand hover:underline"
                    >
                      + Добавить пункт
                    </button>
                  )}
                  {!!navItems.length && navItems.some((i: any) => !i.label || !i.block_kind) && (
                    <p className="mt-2 text-xs text-amber-700">
                      Пункты без названия или без выбранной секции в шапке не показываются.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </details>
      )}

      {/* Оформление страницы */}
      <details className="rounded-xl border border-gray-200 bg-white">
        <summary className="cursor-pointer p-4 font-medium text-gray-900">
          Оформление страницы
        </summary>
        <div className="space-y-5 border-t border-gray-100 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FontSelect
              label="Шрифт заголовков" fonts={fonts}
              value={page.font_heading}
              onChange={v => patchPage({ font_heading: v })}
            />
            <FontSelect
              label="Шрифт основного текста" fonts={fonts}
              value={page.font_body}
              onChange={v => patchPage({ font_body: v })}
            />
            <ColorField
              label="Цвет заголовков" value={page.color_heading}
              onChange={v => patchPage({ color_heading: v })}
            />
            <ColorField
              label="Цвет основного текста" value={page.color_body}
              onChange={v => patchPage({ color_body: v })}
            />
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h4 className="mb-3 font-medium text-gray-900">Кнопки призыва к действию (CTA)</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField
                label="Цвет кнопки" value={page.btn_color}
                onChange={v => patchPage({ btn_color: v })}
              />
              <ColorField
                label="Цвет текста на кнопке" value={page.btn_text_color}
                onChange={v => patchPage({ btn_text_color: v })}
              />
            </div>
            <div className="mt-3">
              <MetallicToggle
                label="Металлический градиент на кнопках"
                checked={!!page.btn_metallic}
                onChange={v => patchPage({ btn_metallic: v })}
              />
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h4 className="mb-3 font-medium text-gray-900">Иконки</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              {/* ⚠️ Этим же цветом красятся кнопки блока «Вопросы» (способы
                  связи). Название поля обязано это называть — иначе клиент
                  правит «Цвет кнопки» и не понимает, почему не меняется. */}
              <ColorField
                label="Цвет иконок и кнопок обратной связи" value={page.icon_color}
                onChange={v => patchPage({ icon_color: v })}
                hint="Кнопки обратной связи (Telegram, ВКонтакте, MAX в блоке «Есть вопросы?») — способы связи, а не призыв к действию. Они красятся этим цветом."
              />
              <div className="flex items-end pb-2">
                <MetallicToggle
                  label="Металлический градиент на иконках"
                  checked={!!page.icon_metallic}
                  onChange={v => patchPage({ icon_metallic: v })}
                />
              </div>
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h4 className="mb-3 font-medium text-gray-900">Фон страницы</h4>
            <BackgroundFields
              eventId={eventId}
              bgColor={page.bg_color}
              imageUrl={page.bg_image_url}
              overlay={page.bg_overlay}
              opacity={page.bg_overlay_opacity}
              onBgColor={v => patchPage({ bg_color: v })}
              onImage={v => patchPage({ bg_image_url: v })}
              onOverlay={v => patchPage({ bg_overlay: v })}
              onOpacity={v => patchPage({ bg_overlay_opacity: v })}
            />
            {/* Кадр фоновой картинки. Показываем только когда картинка есть —
                у цветного фона двигать нечего. */}
            {page.bg_image_url && (
              <BgFramingFields page={page} patchPage={patchPage} />
            )}
          </div>
        </div>
      </details>

      {/* Текст страницы после оплаты */}
      {kind === 'post_pay' && (
        <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
          <h4 className="font-medium text-gray-900">Что увидит человек после оплаты</h4>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Заголовок</label>
            <input
              type="text"
              value={page.post_pay_title || ''}
              onChange={e => patchPage({ post_pay_title: e.target.value })}
              className="input"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Сопроводительный текст
            </label>
            <textarea
              rows={3}
              value={page.post_pay_text || ''}
              onChange={e => patchPage({ post_pay_text: e.target.value })}
              className="input"
            />
          </div>
          <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
            Под текстом сами появятся кнопки на ваших ботов — чтобы человек
            не потерялся после оплаты. Ссылку <span className="font-mono">https://{publicHost}{publicUrl}</span>
            {' '}укажите как страницу возврата в платёжной системе.
          </p>
        </div>
      )}

      {/* Блоки */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Блоки страницы</h3>
          <span className="text-xs text-gray-500">Перетащите за ⠿, чтобы поменять порядок</span>
        </div>

        <div className="space-y-2">
          {page.blocks.map((b: any) => (
            <BlockCard
              key={b.id}
              block={b}
              eventId={eventId}
              isDragging={dragId === b.id}
              pageBlocks={page.blocks}
              tariffs={tariffs}
              offers={offers}
              surveys={surveys}
              isCollab={!!event?.is_collab}
              onPatch={patch => patchBlock(b.id, patch)}
              onRemove={() => removeBlock(b.id)}
              onDragStart={() => setDragId(b.id)}
              onDragOver={e => e.preventDefault()}
              onDrop={() => onDrop(b.id)}
            />
          ))}
        </div>

        <div className="mt-5 border-t border-gray-200 pt-4">
          <p className="mb-2 text-sm font-medium text-gray-700">Добавить секцию</p>
          <div className="flex flex-wrap gap-2">
            {addableKinds.map(k => (
              <button
                key={k}
                onClick={() => addBlock(k)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                <Plus className="h-4 w-4" /> {metaFor(k).label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Блоки «Текст», «Галерея» и элементы можно добавлять сколько угодно раз.
            Остальные секции — по одной: те, что уже стоят на странице, в списке не показаны.
          </p>
        </div>
      </div>

      {/* Копирование лендинга из другого события.
          ⚠️ По правилу проекта модалка-форма НЕ закрывается по клику на фон —
          только по «Отмена»/крестику, иначе теряется выбор. */}
      {copyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            onClick={e => e.stopPropagation()}
            className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl"
          >
            <h3 className="text-lg font-semibold text-gray-900">
              Скопировать лендинг из другого события
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              Перенесём блоки с оформлением — обе страницы, основную и «Спасибо».
              Спикеры, программа и организатор подтянутся уже из этого события.
            </p>

            {copySources.length === 0 ? (
              <p className="my-6 text-sm text-gray-500">
                Готовых лендингов в других ваших событиях пока нет.
              </p>
            ) : (
              <>
                {/* ⚠️ Выпадающий список, а не радио-кнопки: событий у клиента
                    могут быть сотни, полотном они не читаются. Порядок — от
                    свежих к старым (сервер сортирует по дате убыванием). */}
                <div className="my-4">
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Взять лендинг из события
                  </label>
                  <select
                    value={copySourceId ?? ''}
                    onChange={e => setCopySourceId(e.target.value ? Number(e.target.value) : null)}
                    className="input w-full"
                  >
                    <option value="">— выберите событие —</option>
                    {copySources.map(s => (
                      <option key={s.id} value={s.id}>
                        {eventDateLabel(s)}{s.title} · секций {s.blocks_count}
                        {s.tariffs_count > 0 ? ` · тарифов ${s.tariffs_count}` : ''}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    Показаны только события с готовым лендингом — от новых к старым.
                  </p>
                </div>

                <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={copyTariffs}
                    onChange={e => setCopyTariffs(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                  />
                  Перенести и тарифы (названия, описания, цены)
                </label>

                <p className="mt-3 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
                  Блоки текущего лендинга будут заменены. Адрес страницы и то,
                  опубликована ли она, останутся своими.
                </p>
              </>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => { setCopyOpen(false); setCopySourceId(null) }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Отмена
              </button>
              <button
                onClick={doCopy}
                disabled={!copySourceId || copyBusy}
                className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {copyBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {copyBusy ? 'Копируем…' : 'Скопировать'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Выбор оформления. У обычного события в списке один пункт (свои
          стили) — окно тогда просто подтверждает действие; у коллабы
          выбирается стиль любого из организаторов. */}
      {themeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            onClick={e => e.stopPropagation()}
            className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl"
          >
            <h3 className="text-lg font-semibold text-gray-900">Применить стили</h3>
            <p className="mt-1 text-sm text-gray-500">
              Заменим цвета, шрифты, отступы и ширину. Блоки и тексты останутся
              как есть. Потом что угодно можно поправить вручную ниже.
            </p>

            <div className="my-4 space-y-2">
              {themeSources.map(s => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-200 p-3 hover:bg-gray-50"
                >
                  <input
                    type="radio"
                    name="theme-src"
                    checked={themeChoice === String(s.id)}
                    onChange={() => setThemeChoice(String(s.id))}
                    className="h-4 w-4 border-gray-300 text-brand focus:ring-brand"
                  />
                  {/* Полоска цветов — чтобы выбирать глазами, а не по имени:
                      названия кабинетов о стиле ничего не говорят. */}
                  <span
                    className="h-8 w-12 shrink-0 rounded border border-gray-200"
                    style={{
                      background: `linear-gradient(45deg, ${s.lp_bg_color || '#25455D'}, ${s.lp_bg_color_2 || '#0a1520'})`,
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900">
                      {s.title}
                    </span>
                    <span className="block truncate text-xs text-gray-500">
                      {s.owner_name}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <span className="h-4 w-4 rounded-full border border-gray-200"
                          style={{ background: s.lp_color_heading || '#FFCFA4' }} />
                    <span className="h-4 w-4 rounded-full border border-gray-200"
                          style={{ background: s.lp_btn_color || '#FFCFA4' }} />
                  </span>
                </label>
              ))}

              <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-200 p-3 hover:bg-gray-50">
                <input
                  type="radio"
                  name="theme-src"
                  checked={themeChoice === 'default'}
                  onChange={() => setThemeChoice('default')}
                  className="h-4 w-4 border-gray-300 text-brand focus:ring-brand"
                />
                <span
                  className="h-8 w-12 shrink-0 rounded border border-gray-200"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-gray-900">
                    Стандартный стиль ПЛЮСОНа
                  </span>
                  <span className="block text-xs text-gray-500">
                    Тёмно-синий фон, золотые акценты — как у новой страницы
                  </span>
                </span>
              </label>
            </div>

            {themeSources.length > 1 && (
              <p className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
                Это общее событие: у каждого организатора своё оформление.
                По умолчанию страница собрана в стандартном стиле — выберите,
                чьи фирменные цвета взять.
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setThemeOpen(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Отмена
              </button>
              <button
                onClick={doApplyTheme}
                disabled={!themeChoice || themeBusy}
                className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {themeBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {themeBusy ? 'Применяем…' : 'Применить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
