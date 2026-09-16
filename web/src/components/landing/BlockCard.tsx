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
import { GripVertical, ChevronDown, ChevronRight, Trash2, Zap, X, Lock } from 'lucide-react'
import FileUploader, { type UploadKind } from '@/components/FileUploader'
import { metaFor, BLOCK_FEATURE } from './blockMeta'
import FeatureLock from '@/components/FeatureLock'
import { useMe } from '@/hooks/useMe'
import { ColorField, BackgroundFields } from './StyleControls'
import { CARD_ICONS, CardIcon, ICON_GROUPS } from './icons'

interface Props {
  block: any
  eventId?: number
  /** Вид загрузки для картинок: landing_media (событие) | product_media. */
  uploadKind?: UploadKind
  onPatch: (patch: any) => void
  onRemove: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
  isDragging: boolean
  /** Все блоки страницы — для выбора якоря у кнопки. */
  pageBlocks?: any[]
  /** Тарифы события — чтобы выбрать, какой подсветить. */
  tariffs?: any[]
  /** Оферты клиента — для ссылки в подвале. */
  offers?: any[]
  /** Анкеты кабинета — чтобы выбрать, какую показать в блоке «Анкета». */
  surveys?: any[]
  /** Совместное событие: блок «Анкета / Заявка» там не работает. */
  isCollab?: boolean
  /**
   * Настройки счётчика мест — ТОЛЬКО у главной страницы события.
   *
   * ⚠️ Живут в `events`, а не в блоке, поэтому приходят пропом со своим
   * сохранением. Собраны здесь, потому что раньше были размазаны по трём
   * местам: число и подпись — блоком над списком секций, галочка показа и
   * положение — внутри шапки, плюс отдельная секция «Осталось мест».
   */
  seats?: {
    total: string
    setTotal: (v: string) => void
    meta: any
    setMeta: (fn: any) => void
    save: (patch?: any) => void
  }
}

export default function BlockCard({
  block, eventId, onPatch, onRemove,
  onDragStart, onDragOver, onDrop, isDragging, pageBlocks, tariffs, offers,
  surveys, isCollab = false, seats,
  // ⚠️ Куда грузить картинки. По умолчанию — как было у события; у продукта
  // события нет, и `landing_media` там упал бы с «требует event_id».
  uploadKind = 'landing_media',
}: Props) {
  const [open, setOpen] = useState(false)
  // ⚠️ draggable включается ТОЛЬКО когда мышь на ручке ⠿. Если он висит на
  // всей карточке, браузер начинает тащить её при выделении текста в поле и
  // при перетаскивании ползунков — карточка «уезжает» прямо во время правки.
  const [canDrag, setCanDrag] = useState(false)
  const [tab, setTab] = useState<'content' | 'style'>('content')
  // ⚠️ Владельца определяем по kind загрузки: у продукта он `product_media`
  // (события нет — `landing_media` там падает). Отдельный проп заводить не
  // стали, чтобы не пробрасывать одно и то же двумя путями.
  const meta = metaFor(block.kind, uploadKind === 'product_media' ? 'product' : 'event')
  const has = (f: string) => meta.fields.includes(f as any)

  // ⚠️ Гейт секции — по фиче, не по тарифу (состав тарифов меняется данными).
  // Хватает ЛЮБОЙ из перечисленных: спикеры есть и в конференциях, и в
  // турнирах, и в коллаборациях.
  const { me } = useMe()
  const gate = BLOCK_FEATURE[block.kind as keyof typeof BLOCK_FEATURE]
  const myFeatures: string[] = me?.features || []
  const locked = !!gate && !gate.anyOf.some(f => myFeatures.includes(f))

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
  // ⚠️ Раскладываем ВЕСЬ `gal`, а не три поля поимённо: иначе любая правка
  // (например смена режима показа) затирала бы остальные настройки галереи —
  // вид фото, форму карточки, положение подписи.
  const setGal = (patch: any) => onPatch({
    items: {
      ...gal,
      mode: gal.mode || 'carousel',
      media: gal.media || 'image',
      list: galList,
      ...patch,
    },
  })

  return (
    <div
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragEnd={() => setCanDrag(false)}
      onDragOver={onDragOver}
      onDrop={onDrop}
      // ⚠️ РАСКРЫТАЯ карточка обведена фирменным синим и в 2px: серая рамка на
      // белом фоне не читалась вовсе — было не видно, какая секция открыта и
      // где она заканчивается (у длинных настроек это целый экран).
      className={`rounded-xl border bg-white transition-shadow ${
        isDragging
          ? 'opacity-40 border-brand'
          : open
            ? 'border-2 border-[#25455D] shadow-sm'
            : 'border-gray-200 hover:shadow-sm'
      } ${!block.is_active ? 'bg-gray-50' : ''}`}
    >
      {/* Шапка карточки — ПЕРСИКОВАЯ плашка, текст фирменным синим.
          ⚠️ Именно так, а не наоборот: персиковый #FFCFA4 сам по себе светлый,
          на нём тёмный текст читается, а тёмная плашка с персиковыми буквами
          делала список секций мрачным. Плашка у ВСЕХ карточек, свёрнутых тоже —
          иначе список распадался бы на два разных вида. У раскрытой скругление
          только сверху: снизу к ней примыкает содержимое. */}
      <div className={`flex items-center gap-2 p-3 bg-[#FFCFA4] ${
        open ? 'rounded-t-[10px]' : 'rounded-[11px]'
      }`}>
        <span
          onMouseDown={() => setCanDrag(true)}
          onMouseUp={() => setCanDrag(false)}
          onMouseLeave={() => setCanDrag(false)}
          title="Перетащите, чтобы поменять порядок"
          className="shrink-0 cursor-grab active:cursor-grabbing"
        >
          <GripVertical className="h-5 w-5 text-[#25455D]/50" />
        </span>

        <button
          onClick={() => setOpen(o => !o)}
          className="flex flex-1 items-center gap-2 text-left min-w-0"
        >
          {open
            ? <ChevronDown className="h-4 w-4 shrink-0 text-[#25455D]/60" />
            : <ChevronRight className="h-4 w-4 shrink-0 text-[#25455D]/60" />}
          {/* Замок виден и в свёрнутой карточке — иначе про недоступность
              секции узнаёшь только раскрыв её. */}
          {/* ⚠️ Тёмный, а не янтарный: янтарный на персиковой плашке сливается
              с фоном, и замок переставало быть видно. */}
          {locked && <Lock className="h-4 w-4 shrink-0 text-[#25455D]" />}
          {/* ⚠️ Тёмно-синий на персиковом; у выключенной секции приглушён,
              чтобы «не показывается» читалось с одного взгляда. */}
          <span className={`font-medium truncate ${block.is_active ? 'text-[#25455D]' : 'text-[#25455D]/45'}`}>
            {block.admin_name || meta.label}
          </span>
          {(block.admin_name || block.title) && (
            <span className="truncate text-sm text-[#25455D]/60">
              — {block.admin_name ? meta.label : block.title}
            </span>
          )}
          {meta.live && (
            <span
              title="Содержимое подтягивается из события автоматически"
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#25455D]/12 px-2 py-0.5 text-[11px] font-medium text-[#25455D]"
            >
              <Zap className="h-3 w-3" /> авто
            </span>
          )}
        </button>

        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-sm text-[#25455D]">
          <input
            type="checkbox"
            checked={block.is_active}
            onChange={e => onPatch({ is_active: e.target.checked })}
            // ⚠️ Рамка тёмная: серая на персиковом фоне не видна, и пустая
            // галочка сливалась с плашкой.
            className="h-4 w-4 rounded border-[#25455D]/40 text-[#25455D] focus:ring-[#25455D]"
          />
          показывать
        </label>

        {/* Удалить можно ЛЮБУЮ секцию, не только повторяемую: ненужные блоки
            не должны висеть выключенными навсегда. Удалённую из стандартного
            набора всегда можно вернуть кнопкой «+ Добавить секцию» внизу. */}
        <button
          onClick={() => {
            if (confirm(
              `Удалить секцию «${meta.label}»?\n\n` +
              'Её содержимое пропадёт. Пустую секцию потом можно добавить заново.'
            )) onRemove()
          }}
          className="shrink-0 rounded p-1.5 text-[#25455D]/60 hover:bg-red-100 hover:text-red-700"
          title="Удалить секцию"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {open && locked && (
        <div className="border-t border-gray-100 p-4">
          <p className="mb-3 text-sm text-gray-500">{meta.hint}</p>
          <FeatureLock anyOf={gate!.anyOf} />
        </div>
      )}

      {open && !locked && (
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
              {/* Внутреннее имя — только для списка в конструкторе. */}
              {meta.repeatable && (
                <Field label="Название секции (только для вас)">
                  <input
                    type="text"
                    value={block.admin_name || ''}
                    onChange={e => onPatch({ admin_name: e.target.value })}
                    className="input"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Видно только в этом списке — помогает отличать секции.
                    На лендинге не показывается.
                  </p>
                </Field>
              )}

              {has('title') && (
                <>
                  <Field label={block.kind === 'hero' ? 'Заголовок' : 'Заголовок секции'}>
                    <input
                      type="text"
                      value={block.title || ''}
                      onChange={e => onPatch({ title: e.target.value })}
                      className="input"
                    />
                    {/* ⚠️ У шапки поле НЕОБЯЗАТЕЛЬНОЕ: пусто — берётся название
                        продукта. Заполнено — показывается заполненное: на
                        продающей странице нужен призыв, а не служебное
                        название из кабинета. */}
                    {block.kind === 'hero' && (
                      <p className="mt-1 text-xs text-gray-500">
                        Пусто — возьмётся название со вкладки «Основное».
                        Заполните, если на странице нужен другой текст.
                      </p>
                    )}
                    {block.kind === 'description' && (
                      <p className="mt-1 text-xs text-gray-500">
                        Пусто — будет «ПОДРОБНОСТИ».
                      </p>
                    )}
                  </Field>

                </>
              )}

              {/* ⚠️ НАДЗАГОЛОВОК — мелкая строка НАД крупным заголовком
                  («ВИДЕНИЕ / iViSiON-8: БИЗНЕС-СОЗДАТЕЛИ»). Стоит ПЕРЕД
                  подзаголовком — в том же порядке, в каком строки идут на
                  самой странице: надзаголовок, название, подзаголовок. */}
              {block.kind === 'hero' && (
                <Field label="Надзаголовок">
                  <input
                    type="text"
                    value={block.overline || ''}
                    onChange={e => onPatch({ overline: e.target.value })}
                    className="input"
                    placeholder="Мелкая строка над заголовком"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Например, название события или направления. Пусто — строки не будет.
                  </p>
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
                  {/* ⚠️ Это КОРОТКАЯ строка под названием, а НЕ описание
                      события: описание — большой текст, и его показывает
                      отдельная секция «Описание». Раньше оно падало сюда, и
                      шапка превращалась в простыню. */}
                  {block.kind === 'hero' && (
                    <p className="mt-1 text-xs text-gray-500">
                      Короткая строка под названием. Полное описание события
                      показывает секция «Описание» — она берёт его со вкладки
                      «Основное».
                    </p>
                  )}
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

              {/* ⚠️ НАСТРОЙКИ СЧЁТЧИКА МЕСТ ЖИВУТ ЗДЕСЬ — в секции «Осталось
                  мест». Раньше они были размазаны: число и подпись — блоком над
                  списком секций, показ и положение — в шапке, а здесь висела
                  плашка «задаётся сверху страницы», то есть секция не давала
                  ничего. Теперь наоборот: тут всё, а в «Главной странице»
                  только галочка «показывать в шапке».
                  ⚠️ Хранится в `events`, не в блоке, поэтому приходит пропом. */}
              {has('seats') && seats && (
                <>
                  <Field label="Всего мест на событии">
                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        type="number" min={0}
                        value={seats.total}
                        onChange={e => seats.setTotal(e.target.value)}
                        onBlur={() => seats.save()}
                        placeholder="без лимита"
                        className="input w-40"
                      />
                      <span className="text-sm text-gray-500">
                        Занято: <b>{seats.meta?.seats_taken ?? 0}</b>
                        {seats.meta?.seats_total != null && (
                          <> · свободно: <b>{Math.max(0, seats.meta.seats_total - (seats.meta.seats_taken || 0))}</b></>
                        )}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      Пусто — покажем только число записавшихся.
                    </p>
                  </Field>

                  <Field label="Подпись у счётчика">
                    <input
                      type="text"
                      value={seats.meta?.seats_label ?? ''}
                      onChange={e => seats.setMeta((m: any) => ({ ...m, seats_label: e.target.value }))}
                      onBlur={e => seats.save({ seats_label: e.target.value || null })}
                      placeholder="ОСТАЛОСЬ МЕСТ:"
                      className="input"
                    />
                    <p className="mt-1 text-xs text-gray-500">Пусто — только цифра.</p>
                  </Field>

                  <Field label="Что считать занятым">
                    <div className="flex gap-2">
                      {([['registered', 'Записались'], ['visited', 'Зашли']] as const)
                        .map(([val, label]) => (
                          <button
                            key={val}
                            onClick={() => seats.save({ seats_count_mode: val })}
                            className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
                              (seats.meta?.seats_count_mode || 'registered') === val
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
                  </Field>

                  <Field label="Прибавить к счётчику">
                    <input
                      type="number" min={0}
                      value={seats.meta?.seats_base ?? ''}
                      onChange={e => seats.setMeta((m: any) => ({
                        ...m, seats_base: e.target.value === '' ? null : Number(e.target.value),
                      }))}
                      onBlur={e => seats.save({
                        seats_base: e.target.value === '' ? null : Number(e.target.value),
                      })}
                      placeholder="0"
                      className="input"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Если аудитория уже есть — например, 1100 человек в чате.
                      Счётчик пойдёт от этого числа.
                    </p>
                  </Field>

                  <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
                    Эти настройки общие: тот же счётчик можно показать в шапке —
                    галочка в секции «Главная страница».
                  </p>
                </>
              )}

              {has('list') && (
                <ListEditor
                  items={items}
                  onChange={setList}
                  label={block.kind === 'audience' ? 'Кому подойдёт' : 'Пункты списка'}
                />
              )}
              {has('audience_cards') && (
                <AudienceEditor uploadKind={uploadKind}
                  eventId={eventId}
                  items={Array.isArray(items)
                    ? items.map((i: any) => typeof i === 'string' ? { title: i } : i)
                        .filter((i: any) => i && typeof i === 'object')
                    : []}
                  onChange={next => onPatch({ items: next })}
                />
              )}

              {has('cards') && (
                <CardsEditor
                  items={Array.isArray(items)
                    ? items.filter((i: any) => i && typeof i === 'object' && 'title' in i)
                    : []}
                  onChange={next => onPatch({ items: next })}
                />
              )}

              {has('numbers') && (
                <NumbersEditor items={numbers} onChange={setNumbers}
                               eventId={eventId} uploadKind={uploadKind} />
              )}

              {has('steps') && (
                <StepsEditor
                  items={Array.isArray(items)
                    ? items.filter((i: any) => i && typeof i === 'object')
                    : []}
                  onChange={next => onPatch({ items: next })}
                  eventId={eventId}
                  uploadKind={uploadKind}
                />
              )}

              {has('gallery') && (
                <div className="rounded-lg border border-gray-200 p-3">
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Откуда брать содержимое
                  </label>
                  <select
                    value={block.gallery_source || 'manual'}
                    onChange={e => onPatch({ gallery_source: e.target.value })}
                    className="input bg-white"
                  >
                    <option value="manual">Загрузить прямо сюда</option>
                    <option value="testimonials">Из базы «Отзывы и кейсы» по меткам</option>
                  </select>
                  {block.gallery_source === 'testimonials' && (
                    <div className="mt-3">
                      <label className="mb-1 block text-sm font-medium text-gray-700">
                        Метки (через запятую)
                      </label>
                      <input
                        type="text"
                        defaultValue={(block.gallery_tags || []).join(', ')}
                        onBlur={e => onPatch({
                          gallery_tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean),
                        })}
                        placeholder="конференция, частушки"
                        className="input"
                      />
                      <p className="mt-1 text-xs text-gray-500">
                        Пусто — попадут все отзывы. Метки задаются в разделе
                        «Отзывы и кейсы».
                      </p>
                    </div>
                  )}
                </div>
              )}

              {has('gallery') && (block.gallery_source || 'manual') === 'manual' && (
                <GalleryEditor uploadKind={uploadKind}
                  eventId={eventId}
                  mode={gal.mode || 'carousel'}
                  media={gal.media || 'image'}
                  list={galList}
                  onChange={setGal}
                />
              )}


              {/* ── Анкета на странице ────────────────────────────────────
                  Заявка — это анкета из двух-трёх вопросов. Отдельной формы
                  заявок нет намеренно: у анкет уже есть обработка, счётчик
                  необработанных, уведомления и выгрузка. */}
              {/* ⚠️ Событие могло стать совместным ПОСЛЕ того, как блок уже
                  добавили. Прятать его нельзя — клиент не поймёт, куда делась
                  настроенная секция, и не сможет её удалить. Поэтому он виден,
                  но честно объясняет, почему не показывается людям. */}
              {has('survey') && isCollab && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-sm font-medium text-amber-900">
                    В совместном событии эта секция не показывается
                  </p>
                  <p className="mt-1 text-xs text-amber-800">
                    Лендинг у совместного события общий, а базы контактов у
                    организаторов разные: заявка попала бы в базу того, кто
                    поставил форму, — даже если человек пришёл по ссылке
                    партнёра. Секцию можно удалить, на странице её нет.
                  </p>
                </div>
              )}

              {has('survey') && !isCollab && (
                <Field label="Форма заявки">
                  {/* ⚠️⚠️ ВЫБОРА АНКЕТЫ ЗДЕСЬ БОЛЬШЕ НЕТ (07.09.2026).
                      Анкета берётся из «Формы заявки» владельца
                      («Платежи/Заявки» → «Формы заявки»). Два места,
                      задающих одно и то же, неминуемо разъезжаются: клиент
                      поменял анкету в форме заявки, а на лендинге осталась
                      старая. Здесь — только заголовок и оформление. */}
                  <p className="rounded-lg bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-gray-600 leading-relaxed">
                    Анкета, заголовок и способ показа (квиз или все вопросы
                    сразу) берутся <b>из формы заявки</b> — настроить их можно
                    в разделе{' '}
                    <a href="?tab=request_form" className="underline">«Платежи/Заявки» → «Формы заявки»</a>.
                    Здесь — только оформление секции: фон, отступы, положение
                    и вид заголовка.
                  </p>

                  <p className="mt-2 text-xs text-gray-500">
                    Заявки придут в раздел «Анкеты» → «Ответы». Оплата и доступ
                    при этом не выдаются — человек просто оставляет контакты.
                  </p>
                </Field>
              )}

              {/* Какой тариф подсветить — выбирается здесь, а не в разделе «Тарифы». */}
              {block.kind === 'tariffs' && (
                <Field label="Выделить тариф">
                  <select
                    value={block.featured_tariff_id ?? ''}
                    onChange={e => onPatch({
                      featured_tariff_id: e.target.value ? Number(e.target.value) : null,
                    })}
                    className="input bg-white"
                  >
                    <option value="">Никакой не выделять</option>
                    {(tariffs || []).map((t: any) => (
                      <option key={t.id} value={t.id}>{t.title}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    У выделенного тарифа рамка акцентного цвета и свечение.
                  </p>
                  {!!block.featured_tariff_id && (
                    <div className="mt-3">
                      <label className="mb-1 block text-sm font-medium text-gray-700">
                        Сила свечения: {block.featured_glow ?? 24} px
                      </label>
                      <input type="range" min={0} max={90} step={2}
                        value={block.featured_glow ?? 24}
                        onChange={e => onPatch({ featured_glow: Number(e.target.value) })}
                        className="w-full" />
                      <p className="mt-1 text-xs text-gray-500">
                        Ширина ореола вокруг карточки. 0 — только рамка, без свечения.
                      </p>
                    </div>
                  )}
                </Field>
              )}

              {/* Кнопка в карточке тарифа: ширина и положение.
                  ⚠️ Настройка на БЛОКЕ, а не на каждом тарифе: кнопки в ряду
                  карточек должны выглядеть одинаково, иначе ряд разъезжается. */}
              {block.kind === 'tariffs' && (
                <Field label="Кнопка в карточке тарифа">
                  <div className="flex gap-2">
                    {([
                      ['full', 'Во всю ширину'], ['auto', 'По размеру текста'],
                    ] as const).map(([val, label]) => (
                      <button
                        key={val}
                        onClick={() => onPatch({ btn_width: val })}
                        className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
                          (block.btn_width || 'full') === val
                            ? 'border-brand bg-brand/5 font-medium text-brand'
                            : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* Положение имеет смысл только у кнопки по размеру текста:
                      растянутую во всю ширину двигать некуда. */}
                  {block.btn_width === 'auto' && (
                    <div className="mt-2">
                      <div className="mb-1 text-sm text-gray-700">Где стоит кнопка</div>
                      <div className="flex gap-2">
                        {([
                          ['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа'],
                        ] as const).map(([val, label]) => (
                          <button
                            key={val}
                            onClick={() => onPatch({ btn_align: val })}
                            className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
                              (block.btn_align || 'center') === val
                                ? 'border-brand bg-brand/5 font-medium text-brand'
                                : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </Field>
              )}

              {/* Оферта подвала — из общей базы оферт. */}
              {block.kind === 'footer' && (
                <Field label="Оферта в подвале">
                  <select
                    value={block.offer_id ?? ''}
                    onChange={e => onPatch({
                      offer_id: e.target.value ? Number(e.target.value) : null,
                    })}
                    className="input bg-white"
                  >
                    <option value="">Как задано в событии</option>
                    {(offers || []).map((o: any) => (
                      <option key={o.id} value={o.id}>{o.title}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    Список берётся из раздела «Оферты». Ссылка появится внизу
                    страницы рядом с политикой.
                  </p>
                </Field>
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
                  {/* Цель кнопки настраивается у ВСЕХ блоков, включая шапку:
                      «Получить билет» может вести и к тарифам, а не только
                      на форму регистрации. */}
                  {(
                    <Field label="Куда ведёт кнопка">
                      <select
                        value={
                          !block.button_url ? 'register'
                            : block.button_url.startsWith('#lp-') ? block.button_url
                            : 'custom'
                        }
                        /* ⚠️ У повторяемых секций (анкета, текст, галерея) на
                           странице бывает несколько блоков ОДНОГО вида, и
                           якорь `#lp-{kind}` уводит всегда к первому из них.
                           Поэтому для них берётся `#lp-b{id}` — уникальный
                           якорь конкретного блока, он есть у каждой секции. */
                        onChange={e => {
                          const v = e.target.value
                          onPatch({ button_url: v === 'register' ? null : v === 'custom' ? ' ' : v })
                        }}
                        className="input bg-white"
                      >
                        <option value="register">На регистрацию</option>
                        {(pageBlocks || []).map((b: any) => (
                          <option key={b.id}
                            value={metaFor(b.kind).repeatable
                              ? `#lp-b${b.id}` : `#lp-${b.kind}`}>
                            К секции «{b.admin_name || metaFor(b.kind).label}»
                          </option>
                        ))}
                        <option value="custom">Своя ссылка</option>
                      </select>
                      {block.button_url && !block.button_url.startsWith('#lp-') && (
                        <input
                          type="text"
                          value={block.button_url.trim()}
                          onChange={e => onPatch({ button_url: e.target.value })}
                          placeholder="https://…"
                          className="input mt-2"
                        />
                      )}
                    </Field>
                  )}
                </div>
              )}

              {/* Сколько карточек в ряд + рамка — для блоков с сеткой. */}
              {['speakers', 'partners'].includes(block.kind) && (
                <Field label="Как показывать карточки">
                  <div className="flex flex-wrap gap-2">
                    {([
                      ['grid', 'Сеткой — несколько в ряд'],
                      ['scroll', 'Лентой — прокрутка вбок'],
                    ] as const).map(([val, label]) => (
                      <button
                        key={val}
                        onClick={() => onPatch({ display_mode: val })}
                        className={`rounded-lg border px-3 py-1.5 text-sm ${
                          (block.display_mode || 'grid') === val
                            ? 'border-brand bg-brand/5 font-medium text-brand'
                            : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </Field>
              )}

              {/* Выравнивание ВНУТРИ карточек — отдельно от заголовка секции.
                  ⚠️ Раньше всем управляла одна настройка «Выравнивание текста
                  секции», а у партнёров поверх стоял жёсткий центр: регалии
                  вставали по центру, даже когда выбрано «Слева». */}
              {['speakers', 'partners'].includes(block.kind) && (
                <div className="rounded-lg border border-gray-200 p-3">
                  <div className="mb-2 text-sm font-medium text-gray-700">
                    Выравнивание внутри карточек
                  </div>
                  <p className="mb-3 text-xs text-gray-500">
                    Отдельно от заголовка секции. Обычно должность ставят по
                    центру, а регалии — по левому краю, так их удобнее читать.
                  </p>
                  {([
                    ['card_name_align', 'Имя и должность'],
                    ['card_text_align', 'Регалии'],
                  ] as const).map(([field, label]) => (
                    <Field key={field} label={label}>
                      <div className="flex flex-wrap gap-2">
                        {([
                          ['left', 'Слева'],
                          ['center', 'По центру'],
                          ['right', 'Справа'],
                        ] as const).map(([val, lbl]) => (
                          <button
                            key={val}
                            onClick={() => onPatch({ [field]: val })}
                            className={`rounded-lg border px-3 py-1.5 text-sm ${
                              block[field] === val
                                ? 'border-brand bg-brand/5 font-medium text-brand'
                                : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                            }`}
                          >
                            {lbl}
                          </button>
                        ))}
                        {block[field] && (
                          <button
                            onClick={() => onPatch({ [field]: null })}
                            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-50"
                          >
                            Как было
                          </button>
                        )}
                      </div>
                    </Field>
                  ))}
                </div>
              )}

              {/* Подарки в карточках. Выключено по умолчанию: подарок бывает
                  внутренней договорённостью, и выводить его наружу без спроса
                  нельзя. Работает и у спикеров, и у партнёров — партнёр так же
                  дарит что-то участникам. */}
              {['speakers', 'partners'].includes(block.kind) && (
                <div className="rounded-lg border border-gray-200 p-3">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!block.show_speaker_gift}
                      onChange={e => onPatch({ show_speaker_gift: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                    />
                    <span className="text-sm font-medium text-gray-700">
                      {block.kind === 'partners'
                        ? 'Показывать подарки партнёров'
                        : 'Показывать подарки спикеров'}
                    </span>
                  </label>
                  <p className="mt-1 text-xs text-gray-500">
                    Берутся из карточки человека в разделе «Люди». Если подарков
                    несколько — покажем списком, только названия, без ссылок.
                    У кого подарка нет — плашки не будет.
                  </p>

                  {block.show_speaker_gift && (
                    <div className="mt-3 space-y-3">
                      <Field label="Подпись над подарком">
                        <input
                          type="text"
                          value={block.speaker_gift_label || ''}
                          onChange={e => onPatch({ speaker_gift_label: e.target.value })}
                          placeholder="Подарок участникам:"
                          className="input"
                        />
                        <p className="mt-1 text-xs text-gray-500">
                          Оставьте пустым — будет «Подарок участникам:».
                        </p>
                      </Field>

                      <Field label="Где показывать">
                        <div className="flex flex-wrap gap-2">
                          {([
                            ['after', 'После регалий'],
                            ['before', 'До регалий'],
                          ] as const).map(([val, label]) => (
                            <button
                              key={val}
                              onClick={() => onPatch({ speaker_gift_position: val })}
                              className={`rounded-lg border px-3 py-1.5 text-sm ${
                                (block.speaker_gift_position || 'after') === val
                                  ? 'border-brand bg-brand/5 font-medium text-brand'
                                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </Field>

                      {/* Цвет и прозрачность — настройки, но по умолчанию берём
                          те, что клиент задал блокам в стилях: плашка должна
                          попадать в тему сама, без лишних действий. */}
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={!!block.speaker_gift_bg}
                          onChange={e => onPatch({
                            speaker_gift_bg: e.target.checked ? '#0F1E2E' : null,
                          })}
                          className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                        />
                        <span className="text-sm font-medium text-gray-700">
                          Свой цвет плашки (не как у блоков)
                        </span>
                      </label>
                      {block.speaker_gift_bg && (
                        <ColorField
                          label="Цвет плашки подарка"
                          value={block.speaker_gift_bg}
                          onChange={v => onPatch({ speaker_gift_bg: v })}
                        />
                      )}

                      <Field label={`Прозрачность плашки: ${
                        block.speaker_gift_opacity ?? 'как у блоков'
                      }${block.speaker_gift_opacity != null ? '%' : ''}`}>
                        <input
                          type="range" min={0} max={100} step={5}
                          value={block.speaker_gift_opacity ?? 55}
                          onChange={e => onPatch({
                            speaker_gift_opacity: Number(e.target.value),
                          })}
                          className="w-full"
                        />
                        <p className="mt-1 text-xs text-gray-500">
                          100% — плотная заливка, 0% — прозрачная.
                          {block.speaker_gift_opacity != null && (
                            <button
                              onClick={() => onPatch({ speaker_gift_opacity: null })}
                              className="ml-1 text-brand hover:underline"
                            >
                              вернуть «как у блоков»
                            </button>
                          )}
                        </p>
                      </Field>
                    </div>
                  )}
                </div>
              )}

              {/* ⚠️ audience обязателен в списке: внутри лежат настройки фото
                  карточек «Для кого». Без него весь блок не рисовался, и
                  размер фото было негде задать. */}
              {/* ⚠️ tariffs тоже здесь: рендерер число колонок читал и раньше,
                  но задать его в конструкторе было негде — тарифы всегда
                  рисовались по 3 в ряд. */}
              {['speakers', 'partners', 'values', 'difference', 'gallery', 'numbers', 'audience', 'tariffs'].includes(block.kind) && (
                <>
                  <Field label={`Карточек в ряд: ${block.columns || (block.kind === 'numbers' ? 4 : 3)}`}>
                    <input
                      type="range" min={1} max={6}
                      value={block.columns || (block.kind === 'numbers' ? 4 : 3)}
                      onChange={e => onPatch({ columns: Number(e.target.value) })}
                      className="w-full"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      На узком экране колонок будет меньше — вёрстка подстроится сама.
                    </p>
                  </Field>
                  {['values', 'difference', 'audience'].includes(block.kind) && (
                    <Field label={`Размер иконок: ${block.icon_size || 88} px`}>
                      <input type="range" min={24} max={200} step={4}
                        value={block.icon_size || 88}
                        onChange={e => onPatch({ icon_size: Number(e.target.value) })}
                        className="w-full" />
                    </Field>
                  )}

                  {block.kind === 'audience' && (
                    <div className="rounded-lg border border-gray-200 p-3">
                      <div className="mb-2 text-sm font-medium text-gray-700">Фото в карточках</div>
                      {/* ⚠️ «Вписать целиком» — по умолчанию: на скриншотах
                          главное по краям (цифры охватов), а обрезка их режет. */}
                      <Field label="Как показывать фото">
                        <div className="flex flex-wrap gap-2">
                          {([['fit', 'Вписать целиком'], ['crop', 'Обрезать по краям']] as const).map(
                            ([val, label]) => (
                              <button
                                key={val}
                                onClick={() => onPatch({ card_img_fit: val })}
                                className={`rounded-lg border px-3 py-1.5 text-sm ${
                                  (block.card_img_fit || 'fit') === val
                                    ? 'border-brand bg-brand/5 font-medium text-brand'
                                    : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                        </div>
                      </Field>
                      <div className="mt-3" />
                      <Field label={`Размер фото: ${block.card_img_size || 100}% ширины карточки`}>
                        <input type="range" min={20} max={100} step={5}
                          value={block.card_img_size || 100}
                          onChange={e => onPatch({ card_img_size: Number(e.target.value) })}
                          className="w-full" />
                      </Field>
                      <div className="mt-3 grid gap-4 sm:grid-cols-3">
                        <Field label={`Скругление по ширине: ${block.card_img_radius_x || 0}%`}>
                          <input type="range" min={0} max={50}
                            value={block.card_img_radius_x || 0}
                            onChange={e => onPatch({ card_img_radius_x: Number(e.target.value) })}
                            className="w-full" />
                        </Field>
                        <Field label={`Скругление по высоте: ${block.card_img_radius_y || 0}%`}>
                          <input type="range" min={0} max={50}
                            value={block.card_img_radius_y || 0}
                            onChange={e => onPatch({ card_img_radius_y: Number(e.target.value) })}
                            className="w-full" />
                        </Field>
                        <Field label={`Пропорция: ${Number(block.card_img_ratio || 1.6).toFixed(2)}`}>
                          <input type="range" min={0.4} max={3} step={0.1}
                            value={Number(block.card_img_ratio || 1.6)}
                            onChange={e => onPatch({ card_img_ratio: Number(e.target.value) })}
                            className="w-full" />
                        </Field>
                      </div>
                      <p className="mt-2 text-xs text-gray-500">
                        50% и 50% при пропорции 1 — круг. Разные значения дают овал
                        («яйцо»), нули — прямоугольник. Пропорция задаёт форму области,
                        чтобы фото не обрезалось лишним.
                      </p>
                    </div>
                  )}

                  {block.kind === 'numbers' && (
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!block.show_divider}
                        onChange={e => onPatch({ show_divider: e.target.checked })}
                        className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                      />
                      <span className="text-sm text-gray-700">
                        Линия-разделитель между цифрой и подписью
                      </span>
                    </label>
                  )}

                  {['values', 'difference', 'benefits', 'audience', 'tariffs'].includes(block.kind) && (
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!block.cards_glow}
                        onChange={e => onPatch({ cards_glow: e.target.checked })}
                        className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                      />
                      <span className="text-sm text-gray-700">
                        Бегущее свечение карточек (анимация)
                      </span>
                    </label>
                  )}

                  <Field label="Вид карточек">
                    <div className="flex flex-wrap gap-2">
                      {([
                        ['border', 'В рамках'],
                        ['divider', 'С разделителями'],
                        ['plain', 'Без оформления'],
                      ] as const).map(([val, label]) => (
                        <button
                          key={val}
                          onClick={() => onPatch({ card_style: val })}
                          className={`rounded-lg border px-3 py-1.5 text-sm ${
                            (block.card_style || (block.cards_bordered === false ? 'plain' : 'border')) === val
                              ? 'border-brand bg-brand/5 font-medium text-brand'
                              : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </Field>
                </>
              )}

              {block.kind === 'hero' && (
                <>
                  {/* Дата события. Показывается всегда — галочки нет:
                      без даты продающая шапка не работает. Настраиваются
                      только размер и место. */}
                  <div className="rounded-lg border border-gray-200 p-3">
                    <div className="mb-2 text-sm font-medium text-gray-700">
                      Формат и дата
                    </div>
                    <Field label="Формат">
                      <input
                        type="text"
                        value={block.kicker || ''}
                        onChange={e => onPatch({ kicker: e.target.value })}
                        className="input"
                      />
                      <p className="mt-1 text-xs text-gray-500">
                        Показывается овалом слева от даты — например, «Онлайн-конференция»
                        или город. Пусто — будет только дата.
                      </p>
                    </Field>
                    <div className="mt-3 grid gap-4 sm:grid-cols-2">
                      <Field label={`Размер даты: ${block.date_size ? `${block.date_size} px` : 'как основной текст'}`}>
                        <div className="flex items-center gap-3">
                          <input type="range" min={10} max={80} step={1}
                            value={block.date_size ?? 18}
                            onChange={e => onPatch({ date_size: Number(e.target.value) })}
                            className="w-full" />
                          {block.date_size != null && (
                            <button
                              onClick={() => onPatch({ date_size: null })}
                              className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                            >
                              сбросить
                            </button>
                          )}
                        </div>
                      </Field>
                      <Field label="Где показывать">
                        <div className="flex gap-2">
                          {([
                            ['above', 'Над названием'],
                            ['below', 'Под описанием'],
                          ] as const).map(([val, label]) => (
                            <button
                              key={val}
                              onClick={() => onPatch({ date_position: val })}
                              className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
                                (block.date_position || 'above') === val
                                  ? 'border-brand bg-brand/5 font-medium text-brand'
                                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </Field>
                    </div>
                  </div>

                  <p className="text-sm text-gray-500">
                    Название, описание и даты берутся из настроек события.
                  </p>

                  {/* ⚠️ Здесь ТОЛЬКО показ счётчика в шапке и его место рядом
                      с кнопкой. Сами настройки (сколько мест, подпись, что
                      считать занятым) живут в секции «Осталось мест» — они
                      общие для обоих мест показа, и держать их в двух экранах
                      значило бы одно и то же число править дважды. */}
                  {/* ⚠️ Отбит линией сверху: счётчик мест — отдельная тема, и
                      без разделителя его галочка читалась как продолжение
                      настроек даты. */}
                  <div className="mt-2 rounded-lg border border-gray-200 p-3 border-t-4 border-t-gray-100">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!block.show_seats}
                        onChange={e => onPatch({ show_seats: e.target.checked })}
                        className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                      />
                      <span className="text-sm font-medium text-gray-700">
                        Показывать «осталось мест» в шапке
                      </span>
                    </label>
                    <p className="mt-1 text-xs text-gray-500">
                      Сколько мест, подпись и что считать занятым — в секции
                      «Осталось мест».
                    </p>

                    {block.show_seats && (
                      <div className="mt-3 space-y-3">
                        <div className="flex flex-wrap gap-2">
                          {([['above', 'Над кнопкой'], ['side', 'Сбоку от кнопки']] as const).map(
                            ([val, label]) => (
                              <button
                                key={val}
                                onClick={() => onPatch({ seats_position: val })}
                                className={`rounded-lg border px-3 py-1.5 text-sm ${
                                  (block.seats_position || 'above') === val
                                    ? 'border-brand bg-brand/5 font-medium text-brand'
                                    : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                        </div>

                      </div>
                    )}
                  </div>

                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Раскладка: где стоит заголовок относительно содержимого.
                  На телефоне всегда одна колонка — заголовок сверху. */}
              {/* ⚠️ Вид карточек галереи — это оформление, поэтому поля
                  живут здесь, а не в «Содержимом» (там только список фото).
                  Перенесено по просьбе заказчика 2026-08-12. */}
              {/* Размер карточек и подписи — общие для обоих источников. */}
              {has('gallery') && (
                <div className="rounded-lg border border-gray-200 p-3">
                  {/* Когда содержимое берётся из базы, режим показа задаётся
                      здесь: у блока нет своего списка с этими переключателями. */}
                  {block.gallery_source === 'testimonials' && (
                    <div className="mb-3 grid gap-3 sm:grid-cols-2">
                      <Field label="Как показываем">
                        <select
                          value={gal.mode || 'carousel'}
                          onChange={e => setGal({ mode: e.target.value })}
                          className="input bg-white"
                        >
                          <option value="carousel">Каруселью — листается вбок</option>
                          <option value="grid">Сеткой — всё сразу</option>
                        </select>
                      </Field>
                    </div>
                  )}
                  {/* Две независимые настройки вида карточек. Фото у клиента
                      разных пропорций, поэтому «как показать фото» и «где
                      подпись» решаются отдельно друг от друга. */}
                  <div className="mb-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Фото в карточке">
                      <select
                        value={gal.photo_fit || 'crop'}
                        onChange={e => setGal({ photo_fit: e.target.value })}
                        className="input bg-white"
                      >
                        <option value="crop">Обрезается по краям — заполняет карточку</option>
                        <option value="fit">Вписывается целиком — по краям пусто</option>
                      </select>
                    </Field>
                    <Field label="Форма карточки">
                      <select
                        value={gal.ratio || '4 / 3'}
                        onChange={e => setGal({ ratio: e.target.value })}
                        className="input bg-white"
                      >
                        <option value="1 / 1">Квадрат</option>
                        <option value="4 / 3">Горизонтальная 4:3</option>
                        <option value="16 / 9">Широкая 16:9</option>
                        <option value="3 / 4">Вертикальная 3:4</option>
                      </select>
                    </Field>
                  </div>
                  <Field label="Подпись под фото">
                    <select
                      value={gal.caption_align || 'bottom'}
                      onChange={e => setGal({ caption_align: e.target.value })}
                      className="input bg-white"
                    >
                      <option value="top">Сразу под фото — начинаются на одной линии</option>
                      <option value="bottom">У нижнего края — заканчиваются на одной линии</option>
                    </select>
                  </Field>
                  <div className="mb-3" />
                  <Field label={`Ширина карточки: ${block.media_size || 320} px`}>
                    <input type="range" min={160} max={900} step={20}
                      value={block.media_size || 320}
                      onChange={e => onPatch({ media_size: Number(e.target.value) })}
                      className="w-full" />
                    <p className="mt-1 text-xs text-gray-500">
                      Работает в режиме карусели. На узком экране карточка
                      сожмётся по ширине экрана.
                    </p>
                  </Field>
                  <label className="mt-3 flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={block.show_captions !== false}
                      onChange={e => onPatch({ show_captions: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                    />
                    <span className="text-sm text-gray-700">Показывать подписи под карточками</span>
                  </label>
                  <p className="mt-1 text-xs text-gray-500">
                    Подписи берутся из названия отзыва в разделе «Отзывы и кейсы».
                  </p>
                </div>
              )}

              {/* Заголовок: размер, выравнивание, свой цвет — доступно у ВСЕХ
                  блоков, а не только у тех, где правится текст заголовка. */}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={`Размер заголовка: ${block.title_size || (block.kind === 'hero' ? 72 : 48)} px`}>
                  <input
                    type="range" min={16} max={140} step={2}
                    value={block.title_size || (block.kind === 'hero' ? 72 : 48)}
                    onChange={e => onPatch({ title_size: Number(e.target.value) })}
                    className="w-full"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    На телефоне уменьшится сам, чтобы не вылезал за экран.
                  </p>
                </Field>
                {/* ⚠️ У ШАПКИ переключатель пишет в hero_align, а НЕ в
                    title_align: рендер шапки читает только hero_align и
                    двигает им всю колонку (надзаголовок, название, описание,
                    дата, кнопка). Пока кнопки писали сюда title_align, в
                    шапке они молча ничего не меняли. Дефолт у шапки center,
                    у остальных блоков left. */}
                <Field label={block.kind === 'hero' ? 'Где стоит текст' : 'Выравнивание текста секции'}>
                  <div className="flex gap-2">
                    {([
                      ['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа'],
                    ] as const).map(([val, label]) => {
                      const isHero = block.kind === 'hero'
                      const cur = isHero
                        ? (block.hero_align || 'center')
                        : (block.title_align || 'left')
                      return (
                        <button
                          key={val}
                          onClick={() => onPatch(isHero ? { hero_align: val } : { title_align: val })}
                          className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
                            cur === val
                              ? 'border-brand bg-brand/5 font-medium text-brand'
                              : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                  {block.kind === 'hero' && (
                    <p className="mt-1 text-xs text-gray-500">
                      Двигается весь текст шапки — название, описание, дата и кнопка.
                      На телефоне колонка всегда во всю ширину.
                    </p>
                  )}
                </Field>
                {/* ⚠️ Где стоит колонка и как выровнены строки внутри — разные
                    вещи. Обложка «фото слева, текст справа» ставит колонку у
                    правого края, а строки в ней — по левому: иначе у абзаца
                    рвётся левая кромка и заголовок читается лесенкой. */}
                {block.kind === 'hero' && (
                  <Field label="Строки внутри">
                    <div className="flex gap-2">
                      {([
                        ['left', 'По левому'], ['center', 'По центру'], ['right', 'По правому'],
                      ] as const).map(([val, label]) => {
                        const cur = block.title_align || block.hero_align || 'center'
                        return (
                          <button
                            key={val}
                            onClick={() => onPatch({ title_align: val })}
                            className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
                              cur === val
                                ? 'border-brand bg-brand/5 font-medium text-brand'
                                : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                            }`}
                          >
                            {label}
                          </button>
                        )
                      })}
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      Как выровнены сами строки. Не путать с «Где стоит текст» —
                      там колонка целиком, здесь строки внутри неё.
                    </p>
                  </Field>
                )}
                {/* ⚠️ Нужна для обложек, где фигура занимает бОльшую часть
                    кадра: при широкой колонке текст залезает на неё, а длинный
                    заголовок рвётся посреди слова. */}
                {/* ⚠️ Показываем при ЛЮБОМ положении, включая центр: раньше
                    при центре ползунка не было вовсе, и сузить колонку было
                    нечем. Умолчание — 100%, во всю полосу. */}
                {block.kind === 'hero' && (
                  <Field label={`Ширина колонки: ${block.split_ratio || 100}%`}>
                    {/* ⚠️ До 100%: у шапки это ширина колонки с текстом, и её
                        штатно ставят во всю полосу. Потолок 80% не давал
                        сделать текст во всю ширину при сдвиге влево — оставался
                        необъяснимый зазор справа. */}
                    <input
                      type="range" min={20} max={100} step={1}
                      value={block.split_ratio || 100}
                      onChange={e => onPatch({ split_ratio: Number(e.target.value) })}
                      className="w-full"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Сколько места занимает текст. 100% — во всю ширину.
                      Уменьшите, если он наезжает на картинку фона. На телефоне
                      колонка всегда во всю ширину.
                    </p>
                  </Field>
                )}
              </div>

              {/* Размеры остального текста секции — отдельно от заголовка. */}
              <div className="grid gap-4 sm:grid-cols-2">
                {/* ⚠️ Оформление счётчика — здесь, в секции «Осталось мест»,
                    рядом с остальными его настройками. Во вкладке «Содержимое»
                    той же секции — что показываем и что считаем. */}
                {has('seats') && seats && (
                  <Field label={`Размер цифры «осталось мест»: ${seats.meta?.seats_size ? `${seats.meta.seats_size} px` : 'обычный'}`}>
                    <div className="flex items-center gap-3">
                      <input
                        type="range" min={12} max={120} step={2}
                        value={seats.meta?.seats_size ?? 38}
                        onChange={e => seats.setMeta((m: any) => ({ ...m, seats_size: Number(e.target.value) }))}
                        onMouseUp={e => seats.save({ seats_size: Number((e.target as HTMLInputElement).value) })}
                        className="w-full"
                      />
                      {seats.meta?.seats_size != null && (
                        <button
                          onClick={() => seats.save({ seats_size: null })}
                          className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                        >
                          сбросить
                        </button>
                      )}
                    </div>
                  </Field>
                )}
                {has('seats') && seats && (
                  <Field label="Где подпись у счётчика">
                    <div className="flex gap-2">
                      {([['top', 'Сверху'], ['left', 'Слева'], ['right', 'Справа']] as const)
                        .map(([val, label]) => (
                          <button
                            key={val}
                            onClick={() => seats.save({ seats_label_position: val })}
                            className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
                              (seats.meta?.seats_label_position || 'top') === val
                                ? 'border-brand bg-brand/5 font-medium text-brand'
                                : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                    </div>
                  </Field>
                )}
                {/* ⚠️ Надзаголовок — только у шапки: в обычных секциях его нет.
                    Размер читался рендерером и раньше, но регулятора не было —
                    поменять его можно было только через базу. */}
                {block.kind === 'hero' && (
                  <Field label={`Размер надзаголовка: ${block.overline_size || 30} px`}>
                    <div className="flex items-center gap-3">
                      <input
                        type="range" min={10} max={64} step={1}
                        value={block.overline_size ?? 30}
                        onChange={e => onPatch({ overline_size: Number(e.target.value) })}
                        className="w-full"
                      />
                      {block.overline_size != null && (
                        <button
                          onClick={() => onPatch({ overline_size: null })}
                          className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                        >
                          сбросить
                        </button>
                      )}
                    </div>
                  </Field>
                )}
                {/* ⚠️ Регулятор показываем ТОЛЬКО там, где подзаголовок вообще
                    есть (поле `subtitle` в meta.fields). У секции «Описание»
                    его нет — настройка размера несуществующей строки сбивает
                    с толку. */}
                {has('subtitle') && (
                  <Field label={`Размер подзаголовка: ${block.subtitle_size ? `${block.subtitle_size} px` : 'обычный'}`}>
                    <div className="flex items-center gap-3">
                      <input
                        type="range" min={10} max={64} step={1}
                        value={block.subtitle_size ?? 18}
                        onChange={e => onPatch({ subtitle_size: Number(e.target.value) })}
                        className="w-full"
                      />
                      {block.subtitle_size != null && (
                        <button
                          onClick={() => onPatch({ subtitle_size: null })}
                          className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                        >
                          сбросить
                        </button>
                      )}
                    </div>
                  </Field>
                )}
                <Field label={`Размер ${block.kind === 'description' ? 'текста описания' : 'текста секции'}: ${block.text_size ? `${block.text_size} px` : 'как на странице'}`}>
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min={10} max={48} step={1}
                      value={block.text_size ?? 16}
                      onChange={e => onPatch({ text_size: Number(e.target.value) })}
                      className="w-full"
                    />
                    {block.text_size != null && (
                      <button
                        onClick={() => onPatch({ text_size: null })}
                        className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                      >
                        сбросить
                      </button>
                    )}
                  </div>
                  {/* ⚠️ Подпись — по тому, что в секции РЕАЛЬНО есть. Общий
                      текст про карточки и тарифы у секции с одним абзацем
                      выглядел бессмыслицей: там нет ни списков, ни тарифов. */}
                  <p className="mt-1 text-xs text-gray-500">
                    {block.kind === 'description'
                      ? 'Размер самого текста описания.'
                      : 'Пункты списков, карточки, подарки, тарифы — всё содержимое секции.'}
                  </p>
                </Field>
              </div>

              <div className="rounded-lg border border-gray-200 p-3">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!block.title_color}
                    onChange={e => onPatch({
                      title_color: e.target.checked ? '#FFFFFF' : null,
                      title_metallic: e.target.checked ? false : null,
                    })}
                    className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    Свой цвет заголовка (не как в теме)
                  </span>
                </label>
                {block.title_color && (
                  <div className="mt-3 space-y-3">
                    <ColorField
                      label="Цвет заголовка этой секции"
                      value={block.title_color}
                      onChange={v => onPatch({ title_color: v })}
                    />
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!block.title_metallic}
                        onChange={e => onPatch({ title_metallic: e.target.checked })}
                        className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                      />
                      <span className="text-sm text-gray-700">Металлический перелив</span>
                    </label>
                  </div>
                )}
              </div>

              <div>
                {/* ⚠️ Название уточнено: настройка про КОЛОНКИ (где стоит
                    заголовок относительно текста), а не про выравнивание —
                    их путали с «Выравниванием текста секции» выше. */}
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Расположение заголовка относительно текста
                </label>
                <div className="flex flex-wrap gap-2">
                  {([
                    ['top', 'Сверху'],
                    ['left', 'Слева, текст справа'],
                    ['right', 'Справа, текст слева'],
                  ] as const).map(([val, label]) => (
                    <button
                      key={val}
                      onClick={() => onPatch({ layout: val })}
                      className={`rounded-lg border px-3 py-2 text-sm ${
                        (block.layout || 'top') === val
                          ? 'border-brand bg-brand/5 font-medium text-brand'
                          : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  На телефоне колонки всегда складываются в одну.
                </p>
              </div>

              {block.layout && block.layout !== 'top' && (
                <Field label={`Ширина колонки с заголовком: ${block.split_ratio || 50}%`}>
                  <input
                    type="range" min={20} max={80} step={5}
                    value={block.split_ratio || 50}
                    onChange={e => onPatch({ split_ratio: Number(e.target.value) })}
                    className="w-full"
                  />
                </Field>
              )}

              {/* ⚠️ У галереи своя лента картинок — отдельная картинка сбоку там
                  не нужна и только путает: клиент видит два разных загрузчика
                  и не понимает, какой из них наполняет галерею (2026-08-12). */}
              {!has('gallery') && (
              <div className="border-t border-gray-100 pt-4">
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Картинка в секции
                </label>
                <p className="mb-2 text-xs text-gray-500">
                  Не фон, а изображение рядом с текстом — фото, скриншот, коллаж.
                </p>
                <FileUploader
                  mode="single"
                  kind={uploadKind}
                  eventId={eventId}
                  value={block.image_url || null}
                  onChange={url => onPatch({ image_url: url })}
                  emptyText="Загрузите картинку"
                />
                {block.image_url && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {([
                      ['left', 'Слева'], ['right', 'Справа'],
                      ['center', 'По центру'],
                      ['top', 'Сверху'], ['bottom', 'Снизу'],
                    ] as const).map(([val, label]) => (
                      <button
                        key={val}
                        onClick={() => onPatch({ image_position: val })}
                        className={`rounded-lg border px-3 py-1.5 text-sm ${
                          (block.image_position || 'right') === val
                            ? 'border-brand bg-brand/5 font-medium text-brand'
                            : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {block.image_url && (
                  <div className="mt-3">
                    <label className="mb-1 block text-sm font-medium text-gray-700">
                      Ширина картинки: {block.image_width || 100}%
                    </label>
                    <input
                      type="range" min={20} max={100} step={5}
                      value={block.image_width || 100}
                      onChange={e => onPatch({ image_width: Number(e.target.value) })}
                      className="w-full"
                    />
                  </div>
                )}
              </div>
              )}

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

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Отступ сверху и снизу: {block.pad_y != null ? `${block.pad_y} px` : 'как у страницы'}
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={0} max={200} step={4}
                    value={block.pad_y ?? 64}
                    onChange={e => onPatch({ pad_y: Number(e.target.value) })}
                    className="w-full"
                  />
                  {block.pad_y != null && (
                    <button
                      onClick={() => onPatch({ pad_y: null })}
                      className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                    >
                      сбросить
                    </button>
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Насколько «воздушной» будет эта секция. Не задан — берётся общий
                  отступ из стилей лендинга.
                </p>
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

/** Список простых строк — «что вы получите» / «для кого». */
function ListEditor({
  items, onChange, label = 'Пункты списка',
}: {
  items: any[]
  onChange: (v: string[]) => void
  label?: string
}) {
  const list: string[] = items.filter(i => typeof i === 'string')
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <div className="space-y-2">
        {list.map((v, i) => (
          <div key={i} className="flex gap-2">
            <input
              type="text"
              value={v}
              onChange={e => {
                const next = [...list]; next[i] = e.target.value; onChange(next)
              }}
              className="input min-w-0 flex-1"
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

/**
 * Выбор иконки: сначала показываем текущую и кнопку «Выбрать», список
 * раскрывается по клику и сгруппирован по смыслу. Длинная лента из 60 иконок
 * в каждой карточке была бы нечитаемой.
 */
function IconPicker({
  value, onChange,
}: {
  value?: string | null
  onChange: (v: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const current = CARD_ICONS.find(i => i.key === value)

  return (
    <div className="mt-3">
      <div className="mb-1.5 text-xs font-medium text-gray-600">Иконка</div>

      <div className="flex items-center gap-2">
        {current
          ? <CardIcon iconKey={current.key} color="#FFCFA4" size={40} />
          : <span className="flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-gray-300 text-[10px] text-gray-400">
              нет
            </span>}
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          {open ? 'Закрыть' : (current ? `${current.label} — сменить` : 'Выбрать иконку')}
        </button>
        {current && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="rounded px-2 py-1 text-sm text-gray-400 hover:bg-red-50 hover:text-red-600"
          >
            убрать
          </button>
        )}
      </div>

      {/* Модалка выбора. Закрывается только крестиком/«Отмена» — правило
          проекта: клик по фону не закрывает форму. */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-200 p-4">
              <h3 className="font-semibold text-gray-900">Выберите иконку</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                aria-label="Закрыть"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto p-4 scroll-visible">
              {ICON_GROUPS.map(group => (
                <div key={group}>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {group}
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-2">
                    {CARD_ICONS.filter(i => i.group === group).map(ic => (
                      <button
                        key={ic.key}
                        type="button"
                        onClick={() => { onChange(ic.key); setOpen(false) }}
                        title={ic.label}
                        className={`flex flex-col items-center gap-1 rounded-lg border p-2 ${
                          value === ic.key ? 'border-brand bg-brand/5' : 'border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        <CardIcon iconKey={ic.key} color="#FFCFA4" size={38} />
                        <span className="w-full truncate text-center text-[10px] text-gray-500">
                          {ic.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 border-t border-gray-200 p-4">
              <button
                type="button"
                onClick={() => { onChange(null); setOpen(false) }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Без иконки
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Карточки «Для кого»: название, описание и картинка. */
function AudienceEditor({
  eventId, uploadKind = 'landing_media', items, onChange,
}: {
  eventId?: number
  uploadKind?: UploadKind
  items: Array<{ title?: string; text?: string; image?: string | null }>
  onChange: (v: any[]) => void
}) {
  const upd = (i: number, patch: any) => {
    const next = [...items]; next[i] = { ...next[i], ...patch }; onChange(next)
  }
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">Кому подойдёт</label>
      <div className="space-y-3">
        {items.map((c, i) => (
          <div key={i} className="rounded-lg border border-gray-200 p-3">
            <div className="flex gap-2">
              <input
                type="text" value={c.title || ''}
                onChange={e => upd(i, { title: e.target.value })}
                placeholder="Например: Предпринимателям в операционке"
                className="input min-w-0 flex-1 font-semibold"
              />
              <button
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="shrink-0 rounded px-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                ✕
              </button>
            </div>
            <textarea
              rows={3} value={c.text || ''}
              onChange={e => upd(i, { text: e.target.value })}
              placeholder="Описание — в чём его ситуация и что он получит"
              className="input mt-2"
            />
            <div className="mt-2">
              <div className="mb-1 text-xs font-medium text-gray-600">Картинка</div>
              <FileUploader
                mode="single"
                kind={uploadKind}
                eventId={eventId}
                value={c.image || null}
                onChange={url => upd(i, { image: url })}
                aspectClass="aspect-video"
                emptyText="Загрузите картинку"
              />
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange([...items, { title: '', text: '', image: null }])}
        className="mt-2 text-sm font-medium text-brand hover:underline"
      >
        + Добавить карточку
      </button>
    </div>
  )
}

/** Карточки «название + описание» — ценности, особенности. */
function CardsEditor({
  items, onChange,
}: {
  items: Array<{ title: string; text?: string; icon?: string | null }>
  onChange: (v: any[]) => void
}) {
  const upd = (i: number, patch: any) => {
    const next = [...items]; next[i] = { ...next[i], ...patch }; onChange(next)
  }
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">Карточки</label>
      <div className="space-y-3">
        {items.map((c, i) => (
          <div key={i} className="rounded-lg border border-gray-200 p-3">
            <div className="flex gap-2">
              <input
                type="text" value={c.title || ''}
                onChange={e => upd(i, { title: e.target.value })}
                placeholder="Название"
                className="input min-w-0 flex-1 font-semibold"
              />
              <button
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="shrink-0 rounded px-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                ✕
              </button>
            </div>
            <textarea
              rows={2} value={c.text || ''}
              onChange={e => upd(i, { text: e.target.value })}
              placeholder="Короткое описание"
              className="input mt-2"
            />

            {/* Иконка карточки — из набора lucide, цветом иконок вашей темы. */}
            <IconPicker value={c.icon} onChange={v => upd(i, { icon: v })} />
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange([...items, { title: '', text: '' }])}
        className="mt-2 text-sm font-medium text-brand hover:underline"
      >
        + Добавить карточку
      </button>
    </div>
  )
}

/**
 * Шаги процесса — этапы по вертикальной линии.
 *
 * ⚠️ Порядок здесь ЗНАЧИМ (в отличие от карточек ценностей): это
 * последовательность «приём заявок → эфиры → финал», поэтому есть стрелки
 * перемещения, а не только удаление.
 */
function StepsEditor({
  items, onChange, eventId, uploadKind = 'landing_media',
}: {
  items: Array<{ date?: string; title?: string; text?: string; image?: string }>
  onChange: (v: any[]) => void
  eventId?: number
  uploadKind?: UploadKind
}) {
  const upd = (i: number, patch: any) => {
    const next = [...items]; next[i] = { ...next[i], ...patch }; onChange(next)
  }
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">Шаги</label>
      <p className="mb-2 text-xs text-gray-400">
        Идут сверху вниз по линии, карточки встают по её сторонам поочерёдно.
      </p>
      <div className="space-y-2">
        {items.map((s, i) => (
          <div key={i} className="rounded-lg border border-gray-200 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs text-gray-400">Шаг {i + 1}</span>
              <div className="ml-auto flex items-center gap-1">
                <button onClick={() => move(i, -1)} disabled={i === 0}
                        className="rounded px-1.5 py-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
                        title="Выше">↑</button>
                <button onClick={() => move(i, 1)} disabled={i === items.length - 1}
                        className="rounded px-1.5 py-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
                        title="Ниже">↓</button>
                <button onClick={() => onChange(items.filter((_, j) => j !== i))}
                        className="rounded px-2 py-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                        title="Удалить шаг">✕</button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
              <input
                type="text" value={s.date || ''}
                onChange={e => upd(i, { date: e.target.value })}
                placeholder="май — июль"
                className="input"
              />
              <input
                type="text" value={s.title || ''}
                onChange={e => upd(i, { title: e.target.value })}
                placeholder="Приём заявок"
                className="input font-medium"
              />
            </div>
            <textarea
              rows={2} value={s.text || ''}
              onChange={e => upd(i, { text: e.target.value })}
              placeholder="Что происходит на этом шаге"
              className="input mt-2"
            />
            <div className="mt-2">
              <div className="mb-1 text-xs font-medium text-gray-600">Картинка (необязательно)</div>
              <FileUploader
                mode="single"
                kind={uploadKind}
                eventId={eventId}
                value={s.image || null}
                onChange={url => upd(i, { image: url })}
                aspectClass="aspect-video"
                emptyText="Загрузите картинку"
              />
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={() => onChange([...items, { date: '', title: '', text: '' }])}
        className="mt-2 text-sm font-medium text-brand hover:underline"
      >
        + Добавить шаг
      </button>
    </div>
  )
}

/** Цифры с подписями — формат как регалии основателя. */
function NumbersEditor({
  items, onChange, eventId, uploadKind = 'landing_media',
}: {
  items: Array<{ value: string; label: string; image?: string; image_caption?: string }>
  onChange: (v: any[]) => void
  eventId?: number
  uploadKind?: UploadKind
}) {
  const upd = (i: number, patch: any) => {
    const next = [...items]; next[i] = { ...next[i], ...patch }; onChange(next)
  }
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">
        Цифры (от 2 до 4)
      </label>
      {/* ⚠️ Картинка привязана к КОНКРЕТНОЙ цифре, а не собрана в общий блок
          «доказательства»: собранные отдельно скриншоты выглядят оторванно —
          непонятно, какую цифру подтверждает какой из них. */}
      <p className="mb-2 text-xs text-gray-400">
        К каждой цифре можно приложить скриншот-подтверждение — он покажется
        прямо под ней.
      </p>
      <div className="space-y-2">
        {/* ⚠️ Полю подписи нужны `flex-1 min-w-0`: у `.input` есть width:100%,
            но во flex-строке ширина считается от содержимого, и без этих
            классов поле схлопывалось в узкий столбик — текст в нём был, но
            его не было видно. На узком экране пара переносится в две строки:
            рядом два поля просто не помещаются. */}
        {items.map((n, i) => (
          <div key={i} className="flex flex-wrap items-start gap-2 sm:flex-nowrap">
            <input
              type="text" value={n.value || ''}
              onChange={e => upd(i, { value: e.target.value })}
              placeholder="500+"
              className="input w-full font-semibold sm:w-32 sm:shrink-0"
            />
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <input
                type="text" value={n.label || ''}
                onChange={e => upd(i, { label: e.target.value })}
                placeholder="участников"
                className="input min-w-0 flex-1"
              />
              <button
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="shrink-0 rounded px-2 py-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
                title="Удалить цифру"
              >
                ✕
              </button>
            </div>
            <div className="w-full sm:w-56 sm:shrink-0">
              <FileUploader
                mode="single"
                kind={uploadKind}
                eventId={eventId}
                value={n.image || null}
                onChange={url => upd(i, { image: url })}
                aspectClass="aspect-video"
                emptyText="Скриншот-подтверждение"
              />
              {n.image && (
                <input
                  type="text" value={n.image_caption || ''}
                  onChange={e => upd(i, { image_caption: e.target.value })}
                  placeholder="Подпись под скриншотом"
                  className="input mt-1 w-full text-xs"
                />
              )}
            </div>
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
  eventId, uploadKind = 'landing_media', mode, media, list, onChange,
}: {
  eventId?: number
  uploadKind?: UploadKind
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
                kind={uploadKind}
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
