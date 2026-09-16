'use client'
/**
 * Воронки Instagram: комментарий под рилсом → директ → лид-магнит.
 *
 * ⚠️ Воронка — надстройка над лид-магнитами: своих материалов у неё нет,
 * клиент выбирает уже существующий подарок, а здесь настраивает «как раздать».
 *
 * План и решения — documentation/INSTAGRAM-FUNNEL-PLAN.md
 */
import { useEffect, useState } from 'react'
import { Plus, Trash2, Pencil, Instagram, AlertTriangle, X, Loader2, Check, Users, BarChart3 } from 'lucide-react'
import { api } from '@/lib/api'
import LeadMagnetPicker from '@/components/LeadMagnetPicker'

interface Funnel {
  id: number
  name: string
  channel_id: number | null
  account_handle?: string | null
  trigger_kind: string
  media_scope: string
  media_ids: string[]
  keyword_mode: string
  keywords: string[]
  lead_magnet_id: number | null
  package_id: number | null
  product_id: number | null
  event_id: number | null
  lead_magnet_name?: string | null
  package_name?: string | null
  product_name?: string | null
  event_name?: string | null
  delivery_mode: string
  require_subscription: boolean
  public_reply_enabled: boolean
  reminder_enabled: boolean
  reminder_delay_min: number
  is_active: boolean
  // Ограничение частоты повторной выдачи снято (галочка «не чаще раза в час»).
  test_mode: boolean
  runs?: number
  delivered?: number
}

/** На что срабатывает воронка — одной строкой, без открытия карточки.
 *
 * ⚠️ Пишем ИМЕННО «под любым» / «под выбранными»: раньше стояло просто
 * «Комментарий под публикацией», и по списку из нескольких воронок нельзя
 * было понять, какая ловит всё подряд, а какая — конкретный рилс. Разница
 * между ними решающая: воронка «на любой» перехватывает почти всё.
 */
function triggerLabel(f: Funnel): string {
  if (f.trigger_kind === 'story_reply') return 'Ответ на любую сторис'
  if (f.media_scope === 'specific') {
    const n = f.media_ids?.length || 0
    // Число говорим всегда: «выбранные» без количества не отличает одну
    // публикацию от десяти, а это ровно то, что человек и проверяет.
    return `Комментарий под ${n} ${plural(n, 'выбранной публикацией', 'выбранными публикациями', 'выбранными публикациями')}`
  }
  return 'Комментарий под любой публикацией'
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

// Готовые тексты — те же, что в движке ([instagram_funnel.py](backend)).
//
// ⚠️ Подставляются в новую воронку сразу, чтобы клиенту было что править, а не
// придумывать с нуля. Все — от лица «МЫ»: род клиента заранее неизвестен, а
// сообщение уходит от имени его аккаунта.
//
// ⚠️ По несколько вариантов на каждый шаг обязательно: Instagram считает спамом
// повторяющиеся одинаковые публичные ответы и режет охваты.
const DEFAULT_REPLIES: Record<string, string[]> = {
  public_comment: [
    'Отправили в личные сообщения ✉️',
    'Всё в директе 💌',
    'Отправили — загляните в личные сообщения 📩',
    'Готово, ждём вас в директе ✨',
    'Уже отправили, проверьте личные 👀',
  ],
  dm_intro: [
    'Привет! Материал готов. Подпишитесь на @{handle} и нажмите «Готово» (или напишите это слово в ответ) — сразу отправим.',
    'Здравствуйте! Остался один шаг: подпишитесь на @{handle} и нажмите «Готово» (или напишите в ответ).',
    'Привет! Рады, что заинтересовало. Подпишитесь на @{handle} и нажмите «Готово» (или напишите это слово) — отправим материал.',
    'Здравствуйте! Чтобы забрать материал, подпишитесь на @{handle} и нажмите «Готово» (или напишите в ответ).',
  ],
  dm_not_subscribed: [
    'Пока не видим вашу подписку на @{handle}. Подпишитесь и нажмите «Готово» ещё раз.',
    'Подписки пока не видно — проверьте, что подписались на @{handle}, и нажмите «Готово».',
    'Кажется, подписка ещё не оформлена. Подпишитесь на @{handle} и нажмите «Готово».',
    'Не нашли вас среди подписчиков @{handle}. Подпишитесь и нажмите «Готово».',
  ],
  dm_delivered: [
    'Держите, всё внутри 👇',
    'Готово! Забирайте 👇',
    'Отправляем — приятного изучения 👇',
    'Вот обещанное 👇',
    'Всё готово, забирайте 👇',
  ],
  dm_repeat: [
    'Уже отправляли — вот ещё раз 👇',
    'Отправляли раньше, дублируем 👇',
    'Повторяем на всякий случай 👇',
    'Держите ещё раз, чтобы не потерялось 👇',
  ],
  dm_reminder: [
    'Напоминаем: материал ждёт вас. Подпишитесь на @{handle} и нажмите «Готово».',
    'Вы не забрали материал — подпишитесь на @{handle} и нажмите «Готово», сразу отправим.',
    'Материал всё ещё за вами. Подпишитесь на @{handle} и нажмите «Готово».',
    'Не хотим, чтобы вы потеряли материал — подпишитесь на @{handle} и нажмите «Готово».',
  ],
}

const REPLY_KINDS: { key: string; title: string; hint: string }[] = [
  { key: 'public_comment',    title: 'Ответ под комментарием', hint: 'Видят все. Пишите несколько вариантов — одинаковые ответы Instagram считает спамом' },
  { key: 'dm_intro',          title: 'Первое сообщение в директ', hint: 'Под сообщением появится кнопка «Готово»' },
  { key: 'dm_not_subscribed', title: 'Если подписки не видно', hint: '' },
  { key: 'dm_delivered',      title: 'Выдача материала', hint: 'Перед ссылками на материалы' },
  { key: 'dm_repeat',         title: 'Если написал повторно', hint: '«Уже отправляли — вот ещё раз»' },
  { key: 'dm_reminder',       title: 'Напоминание молчащему', hint: '' },
]

// Что можно вставить в тексты.
//
// ⚠️ Пояснение общее, а не в подсказке к каждому полю: плейсхолдеры работают
// во ВСЕХ текстах одинаково, и повторять их у каждого — шум. Без пояснения
// «{handle}» в готовом тексте выглядит как случайный набор символов, и его
// стирают.
const PLACEHOLDERS: { code: string; what: string }[] = [
  { code: '{handle}',   what: 'ваш ник в Instagram — станет ссылкой на профиль, подписаться можно в один тап' },
  { code: '{material}', what: 'название подарка, который выдаёт воронка' },
  { code: '{name}',     what: 'ник написавшего человека' },
]

/**
 * Плитка «зашли / забрали / не забрали» — ТОТ ЖЕ вид, что у лид-магнитов.
 *
 * ⚠️ Разделы соседние (соседние вкладки одной страницы), и свой стиль здесь
 * читался бы как две разные системы. Поэтому цвета, размеры и порядок цифр
 * повторяют LeadMagnetCounter один в один.
 *
 * ⚠️ Пусто → серая плитка «0/0/0», а не скрытая строка: отсутствие цифр само
 * по себе информация («никто ещё не написал»), и её место должно быть занято.
 */
function FunnelCounter({ reached, received, onOpen }: {
  reached: number; received: number; onOpen: () => void
}) {
  if (reached === 0) {
    return (
      <span className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-400"
            title="Никто ещё не написал кодовое слово">
        <Users size={12} /> 0/0/0
      </span>
    )
  }
  const notReceived = Math.max(0, reached - received)
  const cell = 'px-1 rounded hover:bg-white/50 transition-colors cursor-pointer'
  return (
    <span className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-[#FFCFA4] text-[#25455D]">
      <Users size={12} />
      <button onClick={onOpen} className={cell} title={`${reached} — написали кодовое слово`}>{reached}</button>
      <span className="text-[#25455D]/40">/</span>
      <button onClick={onOpen} className={cell} title={`${received} — забрали материал`}>{received}</button>
      <span className="text-[#25455D]/40">/</span>
      <button onClick={onOpen} className={cell} title={`${notReceived} — не забрали материал`}>{notReceived}</button>
    </span>
  )
}

export default function InstagramFunnelsTab() {
  const [items, setItems] = useState<Funnel[]>([])
  const [accounts, setAccounts] = useState<any[]>([])
  const [magnets, setMagnets] = useState<any[]>([])
  const [packages, setPackages] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<any | null>(null)
  // Воронка, по которой открыт список людей (null — окно закрыто).
  const [peopleOf, setPeopleOf] = useState<Funnel | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [f, ch, lm, pk, pr, ev] = await Promise.all([
        api.instagramFunnels.list(),
        api.channels.list(),
        api.leadMagnets.list(),
        api.leadMagnetPackages.list(),
        // ⚠️ Продукты может не быть в тарифе — тогда список просто пустой,
        // и кнопка «Продукт» покажется без счётчика. Ошибку глушим, чтобы
        // недоступный раздел не ломал форму воронки целиком.
        api.products.list().catch(() => ({ items: [] })),
        api.events.list().catch(() => ({ items: [] })),
      ])
      setItems(f.items || [])
      setAccounts((ch.items || []).filter((c: any) => c.platform_slug === 'instagram'))
      setMagnets(lm.items || [])
      setPackages(pk.items || [])
      // ⚠️ Эндпоинт продуктов отдаёт поле `products`, а НЕ `items`, как
      // остальные списки — из-за этого выбор продуктов был пустым при
      // опубликованных продуктах у клиента.
      setProducts(pr.products || pr.items || [])
      // ⚠️ Только опубликованные: вести человека на черновик значит
      // привести его на «страница не найдена».
      setEvents((ev.events || ev.items || []).filter((e: any) => e.status === 'published'))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const remove = async (f: Funnel) => {
    if (!confirm(`Удалить воронку «${f.name}»?`)) return
    await api.instagramFunnels.delete(f.id)
    load()
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-gray-500 py-8">
      <Loader2 className="w-4 h-4 animate-spin" /> Загружаем…
    </div>
  }

  // ⚠️ Без подключённого аккаунта воронку настраивать не на чем — ведём в
  // «Каналы», а не показываем пустую форму, где всё равно нечего выбрать.
  if (accounts.length === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-900 mb-1">Сначала подключите Instagram</p>
            <p className="text-sm text-amber-900 mb-3">
              Воронка отвечает на комментарии под вашими рилсами и присылает материал
              в личные сообщения. Для этого нужен подключённый аккаунт.
            </p>
            <a href="/dashboard/channels" className="btn-gold inline-block px-4 py-2 text-sm">
              Перейти в Каналы
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-600">
          Человек пишет кодовое слово под рилсом — бот отвечает ему под комментарием
          и присылает материал в личные сообщения.
        </p>
        <button onClick={() => setEditing({ channel_id: accounts[0].id })}
                className="btn-gold px-4 py-2 text-sm whitespace-nowrap flex items-center gap-1.5">
          <Plus size={16} /> Новая воронка
        </button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center">
          <Instagram className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">Воронок пока нет</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(f => (
            <div key={f.id} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-gray-900">{f.name}</span>
                    {/* ⚠️ Воронка без аккаунта — не поломка: аккаунт удалили,
                        а настройка (слова, тексты, подарок) сохранилась.
                        Говорим прямо, что делать, иначе выглядит как сбой. */}
                    {!f.channel_id ? (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                        аккаунт отключён — выберите заново
                      </span>
                    ) : !f.is_active && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">выключена</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">
                    {triggerLabel(f)}
                    {f.keyword_mode === 'specific' && f.keywords?.length
                      ? ` · слова: ${f.keywords.join(', ')}` : ' · любое слово'}
                    {' · выдаём: '}
                    {f.lead_magnet_name || f.package_name || f.product_name || f.event_name || '—'}
                    {f.account_handle ? ` · @${f.account_handle}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* ⚠️ Плитка и иконка аналитики — ТОЧНО как у лид-магнитов
                      (страница lead-magnets): персиковый фон, «зашли/забрали/
                      не забрали», клик по любой цифре открывает список людей.
                      Свой стиль тут заводить нельзя — разделы соседние, и
                      разнобой читается как две разные системы. */}
                  <FunnelCounter
                    reached={f.runs ?? 0}
                    received={f.delivered ?? 0}
                    onOpen={() => setPeopleOf(f)}
                  />
                  <button onClick={() => setPeopleOf(f)} title="Аналитика"
                          className="p-2 rounded text-gray-400 hover:text-[#25455D] hover:bg-gray-100">
                    <BarChart3 size={16} />
                  </button>
                  <button onClick={() => setEditing({ id: f.id })}
                          className="p-2 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Редактировать">
                    <Pencil size={16} />
                  </button>
                  <button onClick={() => remove(f)}
                          className="p-2 rounded text-gray-400 hover:text-red-600 hover:bg-gray-100" title="Удалить">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {peopleOf && (
        <PeopleModal funnel={peopleOf} onClose={() => setPeopleOf(null)} />
      )}

      {editing && (
        <FunnelModal
          initial={editing}
          accounts={accounts}
          magnets={magnets}
          packages={packages}
          products={products}
          events={events}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </div>
  )
}


function FunnelModal({ initial, accounts, magnets, packages, products, events, onClose, onSaved }: {
  initial: any
  accounts: any[]
  magnets: any[]
  packages: any[]
  products: any[]
  events: any[]
  onClose: () => void
  onSaved: () => void
}) {
  // Какой ТИП подарка выбран сейчас: лид-магнит / пакет / продукт.
  //
  // ⚠️ При открытии существующей воронки восстанавливаем по тому, что в ней
  // реально стоит: иначе форма открылась бы на «лид-магните», а в списке был
  // бы выбран продукт — и клиент решил бы, что настройка слетела.
  const [giftKind, setGiftKind] = useState<string>(
    initial?.event_id ? 'ev' : initial?.product_id ? 'pr' : initial?.package_id ? 'p' : 'm'
  )
  const [f, setF] = useState<any>({
    channel_id: initial.channel_id || accounts[0]?.id,
    name: '',
    trigger_kind: 'comment',
    media_scope: 'any',
    media_ids: [],
    keyword_mode: 'specific',
    keywords: [''],
    match_mode: 'contains',
    lead_magnet_id: null,
    package_id: null,
    product_id: null,
    event_id: null,
    delivery_mode: 'direct',
    require_subscription: true,
    public_reply_enabled: true,
    reminder_enabled: true,
    reminder_delay_min: 10,
    is_active: true,
    // ⚠️ Ограничение «раз в час» по умолчанию ВКЛЮЧЕНО (test_mode=false):
    // новая воронка сразу ведёт себя как в бою, а снимают ограничение
    // осознанно, на время настройки.
    test_mode: false,
    // ⚠️ Готовые тексты подставляем сразу, а не оставляем пусто: пустые поля
    // человек чаще всего так и оставляет, а нам важно, чтобы вариантов было
    // несколько — Instagram режет охваты за одинаковые повторяющиеся ответы.
    replies: initial.id ? {} : { ...DEFAULT_REPLIES },
  })
  const [media, setMedia] = useState<any[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(!!initial.id)

  useEffect(() => {
    if (!initial.id) return
    api.instagramFunnels.get(initial.id)
      .then((r: any) => {
        setF({
          ...r,
          keywords: r.keywords?.length ? r.keywords : [''],
          // ⚠️ Аккаунт мог быть удалён — тогда в воронке пусто (миграция 368).
          // Подставляем первый подключённый, чтобы клиенту осталось только
          // сохранить, а не разбираться, почему поле пустое.
          channel_id: r.channel_id || accounts[0]?.id,
        })
        // ⚠️ Тип подарка выставляем ПОСЛЕ загрузки: при открытии в `initial`
        // лежит только {id}, и без этого форма всегда показывала бы
        // «Лид-магнит» — даже у воронки с продуктом.
        setGiftKind(r.event_id ? 'ev' : r.product_id ? 'pr' : r.package_id ? 'p' : 'm')
      })
      .catch((e: any) => setErr(e?.message || 'Не удалось загрузить'))
      .finally(() => setLoading(false))
  }, [initial.id])

  // Публикации подгружаем только когда клиент выбрал «конкретные»: список
  // тянется из Instagram по сети, дёргать его заранее незачем.
  useEffect(() => {
    if (f.media_scope !== 'specific' || media || !f.channel_id) return
    api.channels.instagramMedia(f.channel_id)
      .then((r: any) => setMedia(r.items || []))
      .catch(() => setMedia([]))
  }, [f.media_scope, f.channel_id])

  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }))

  const save = async () => {
    setBusy(true); setErr(null)
    try {
      const payload = {
        ...f,
        keywords: (f.keywords || []).filter((k: string) => k.trim()),
        replies: f.replies || {},
      }
      if (initial.id) await api.instagramFunnels.update(initial.id, payload)
      else await api.instagramFunnels.create(payload)
      onSaved()
    } catch (e: any) {
      setErr(e?.message || 'Не удалось сохранить')
      setBusy(false)
    }
  }

  const isStory = f.trigger_kind === 'story_reply'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="w-full max-w-2xl my-8 rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">
            {initial.id ? 'Изменить воронку' : 'Новая воронка Instagram'}
          </h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700"><X size={18} /></button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-8">
            <Loader2 className="w-4 h-4 animate-spin" /> Загружаем…
          </div>
        ) : (
        <div className="space-y-4">
          {err && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{err}</div>}

          <div>
            <label className="block text-xs text-gray-500 mb-1">Название</label>
            <input value={f.name} onChange={e => set('name', e.target.value)}
                   placeholder="Гайд за комментарий"
                   className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
          </div>

          {(accounts.length > 1 || !f.channel_id) && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Аккаунт</label>
              <select value={f.channel_id} onChange={e => { set('channel_id', +e.target.value); setMedia(null) }}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg">
                {accounts.map(a => <option key={a.id} value={a.id}>@{a.handle || a.display_name}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs text-gray-500 mb-1">Когда срабатывает</label>
            <div className="flex gap-2">
              {[['comment', 'Комментарий'], ['story_reply', 'Ответ на сторис']].map(([v, l]) => (
                <button key={v} type="button"
                  onClick={() => {
                    set('trigger_kind', v)
                    // ⚠️ У сторис конкретную публикацию выбрать нельзя (живёт
                    // 24 часа), а кодовое слово обязательно — иначе воронка
                    // сработает на любой стикер в ответ.
                    if (v === 'story_reply') { set('media_scope', 'any'); set('keyword_mode', 'specific') }
                  }}
                  className={`px-3 py-2 text-sm rounded-lg border ${f.trigger_kind === v
                    ? 'border-[#25455D] bg-[#25455D] text-white' : 'border-gray-200 text-gray-700'}`}>
                  {l}
                </button>
              ))}
            </div>
            {isStory && (
              <p className="text-xs text-gray-500 mt-1.5">
                Сторис живёт сутки, поэтому воронка срабатывает на ответ к любой вашей
                сторис — по кодовому слову.
              </p>
            )}
          </div>

          {!isStory && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Под какими публикациями</label>
              <div className="flex gap-2 mb-2">
                {[['any', 'Любая'], ['specific', 'Выбрать']].map(([v, l]) => (
                  <button key={v} type="button" onClick={() => set('media_scope', v)}
                    className={`px-3 py-2 text-sm rounded-lg border ${f.media_scope === v
                      ? 'border-[#25455D] bg-[#25455D] text-white' : 'border-gray-200 text-gray-700'}`}>{l}</button>
                ))}
              </div>
              {f.media_scope === 'specific' && (
                media === null ? (
                  <div className="flex items-center gap-2 text-xs text-gray-500 py-3">
                    <Loader2 className="w-3 h-3 animate-spin" /> Загружаем публикации…
                  </div>
                ) : media.length === 0 ? (
                  <p className="text-xs text-gray-500">Публикаций не нашлось.</p>
                ) : (
                  <div className="grid grid-cols-4 gap-2 max-h-52 overflow-y-auto">
                    {media.map((m: any) => {
                      const on = (f.media_ids || []).includes(m.id)
                      return (
                        <button key={m.id} type="button"
                          onClick={() => set('media_ids', on
                            ? f.media_ids.filter((x: string) => x !== m.id)
                            : [...(f.media_ids || []), m.id])}
                          className={`relative rounded-lg overflow-hidden border-2 ${on ? 'border-[#25455D]' : 'border-transparent'}`}>
                          <img src={m.thumbnail_url || m.media_url} alt=""
                               className="w-full aspect-square object-cover" />
                          {/* ⚠️ Галочка обязательна: по одной рамке не видно,
                              что выбрано — особенно на тёмных обложках. */}
                          {on && <>
                            <div className="absolute inset-0 bg-[#25455D]/30" />
                            <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-[#25455D]
                                             flex items-center justify-center shadow">
                              <Check size={12} className="text-white" strokeWidth={3} />
                            </span>
                          </>}
                        </button>
                      )
                    })}
                  </div>
                )
              )}
            </div>
          )}

          <div>
            <label className="block text-xs text-gray-500 mb-1">Кодовые слова</label>
            {!isStory && (
              <div className="flex gap-2 mb-2">
                {[['any', 'Любой текст'], ['specific', 'По словам']].map(([v, l]) => (
                  <button key={v} type="button" onClick={() => set('keyword_mode', v)}
                    className={`px-3 py-2 text-sm rounded-lg border ${f.keyword_mode === v
                      ? 'border-[#25455D] bg-[#25455D] text-white' : 'border-gray-200 text-gray-700'}`}>{l}</button>
                ))}
              </div>
            )}
            {f.keyword_mode === 'specific' && (
              <>
              <div className="flex gap-2 mb-2">
                {[['contains', 'Содержит слово'], ['exact', 'Точная фраза']].map(([v, l]) => (
                  <button key={v} type="button" onClick={() => set('match_mode', v)}
                    className={`px-3 py-1.5 text-xs rounded-lg border ${(f.match_mode || 'contains') === v
                      ? 'border-[#25455D] bg-[#25455D] text-white' : 'border-gray-200 text-gray-600'}`}>{l}</button>
                ))}
              </div>
              <p className="text-xs text-gray-500 mb-2">
                {(f.match_mode || 'contains') === 'contains'
                  ? 'Сработает, если слово есть где-то в комментарии: «хочу», «Хочу гайд», «хочу 🙏». Регистр не важен.'
                  : 'Сработает, только если комментарий равен слову целиком. Нужно, когда слово короткое и встречается в другом смысле — «не хочу», «хочу спросить про другое».'}
              </p>
              <div className="space-y-1.5">
                {(f.keywords || ['']).map((k: string, i: number) => (
                  <div key={i} className="flex gap-2">
                    <input value={k} placeholder="хочу"
                      onChange={e => { const a = [...f.keywords]; a[i] = e.target.value; set('keywords', a) }}
                      className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg" />
                    <button type="button" onClick={() => set('keywords', f.keywords.filter((_: any, j: number) => j !== i))}
                      className="px-2 text-gray-400 hover:text-red-600"><Trash2 size={14} /></button>
                  </div>
                ))}
                <button type="button" onClick={() => set('keywords', [...(f.keywords || []), ''])}
                  className="text-xs text-[#25455D] hover:underline">+ добавить слово</button>
              </div>
              </>
            )}
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Что выдаём</label>
            {/* ⚠️ Сначала ТИП, потом список внутри него. Схлопнуть группы в
                обычном <select> нельзя — браузер этого не умеет, а список из
                лид-магнитов, пакетов и продуктов подряд становится длинным, и
                до нижней группы приходится листать вслепую. Переключатель
                решает то же самое одним кликом. */}
            <div className="flex gap-2 mb-2">
              {([
                ['m', 'Лид-магнит', magnets.length],
                ['p', 'Пакет', packages.length],
                ['pr', 'Продукт', products.length],
                ['ev', 'Событие', events.length],
              ] as [string, string, number][]).map(([k, label, n]) => (
                <button
                  key={k} type="button"
                  onClick={() => {
                    // ⚠️ Прежний выбор сбрасываем: в базе разрешено ровно одно
                    // из трёх (CHECK), и оставленный «хвост» не сохранится.
                    set('lead_magnet_id', null)
                    set('package_id', null)
                    set('product_id', null)
                    set('event_id', null)
                    setGiftKind(k)
                  }}
                  className={`px-3 py-1.5 text-xs rounded-lg border ${giftKind === k
                    ? 'border-[#25455D] bg-[#25455D] text-white'
                    : 'border-gray-200 text-gray-700'}`}>
                  {label} {n > 0 && <span className="opacity-60">· {n}</span>}
                </button>
              ))}
            </div>
            {/* ⚠️ У магнитов и пакетов — общий пикер с ПОИСКОМ: их у клиента
                десятки. Продукты и события остаются обычным списком: их
                единицы, и пикер магнитов про них ничего не знает. */}
            {giftKind === 'm' || giftKind === 'p' ? (
              <LeadMagnetPicker
                placeholder="— выберите —"
                value={f.lead_magnet_id ? { kind: 'magnet', id: f.lead_magnet_id }
                     : f.package_id ? { kind: 'package', id: f.package_id } : null}
                onPick={v => {
                  // Выбранный вид может отличаться от кнопки выше — ведём
                  // кнопку за выбором, иначе в базе окажется не то поле.
                  set('lead_magnet_id', v?.kind === 'magnet' ? v.id : null)
                  set('package_id', v?.kind === 'package' ? v.id : null)
                  set('product_id', null)
                  set('event_id', null)
                  if (v) setGiftKind(v.kind === 'package' ? 'p' : 'm')
                }}
              />
            ) : (
              <select
                value={f.product_id || f.event_id || ''}
                onChange={e => {
                  const v = e.target.value ? +e.target.value : null
                  set('lead_magnet_id', null)
                  set('package_id', null)
                  set('product_id', giftKind === 'pr' ? v : null)
                  set('event_id', giftKind === 'ev' ? v : null)
                }}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg">
                <option value="">— выберите —</option>
                {(giftKind === 'ev' ? events : products).map((it: any) => (
                  <option key={it.id} value={it.id}>{it.name || it.title}</option>
                ))}
              </select>
            )}
            {/* ⚠️⚠️ Предупреждение обязательно: у продукта и события в директ
                уходит ВЕБ-ссылка, а не Mini App — сообщение открывают внутри
                Instagram, где ни телеграмного, ни вэкашного приложения нет.
                Без пояснения клиент ждёт, что человек попадёт в бота. */}
            {(giftKind === 'pr' || giftKind === 'ev') && (
              <p className="text-[11px] text-gray-500 mt-1">
                В личные сообщения уйдёт <b>обычная ссылка на страницу</b> — она открывается
                в браузере прямо из Instagram.
                {giftKind === 'pr'
                  ? ' Материалы продукта открываются после оплаты.'
                  : ' Человек перейдёт и зарегистрируется на событие.'}
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Как выдаём</label>
            <div className="flex gap-2">
              {[['direct', 'Сразу в Instagram'], ['telegram', 'Через телеграм-бота']].map(([v, l]) => (
                <button key={v} type="button" onClick={() => set('delivery_mode', v)}
                  className={`px-3 py-2 text-sm rounded-lg border ${f.delivery_mode === v
                    ? 'border-[#25455D] bg-[#25455D] text-white' : 'border-gray-200 text-gray-700'}`}>{l}</button>
              ))}
            </div>
            {/* ⚠️ Поясняем ОБА способа, а не только второй: без этого клиент
                не понимает разницы и выбирает наугад. */}
            <p className="text-xs text-gray-500 mt-1.5">
              {f.delivery_mode === 'direct'
                ? 'Ссылка на материал придёт человеку прямо в личные сообщения Instagram. Быстрее всего — но дальше писать ему можно только сутки: так устроен Instagram.'
                : 'В личные сообщения Instagram придёт ссылка на вашего телеграм-бота. Материал выдаст уже бот — там же проверит подписку на канал. Человек останется в базе Telegram, где рассылки не ограничены сутками.'}
            </p>
          </div>

          <div className="space-y-2 pt-1">
            {[
              ['require_subscription', 'Требовать подписку на аккаунт'],
              ['public_reply_enabled', 'Отвечать публично под комментарием'],
              ['reminder_enabled', 'Напомнить, если человек не забрал материал'],
              ['is_active', 'Воронка включена'],
            ].map(([k, l]) => (
              <label key={k as string} className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={!!f[k as string]}
                       onChange={e => set(k as string, e.target.checked)} />
                {l}
              </label>
            ))}
          </div>

          {/* Ограничение повторной выдачи — отдельным блоком с объяснением.
              ⚠️ Формулировка НЕ «тест-режим»: это постоянная настройка, а не
              временный режим, и называть её тестовой значит подталкивать
              выключить её «после проверки», хотя нужна она как раз в работе.
              ⚠️ В общем списке галочек потерялась бы: последствие (человек
              получает письмо на каждый свой комментарий) слишком заметное. */}
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
            <label className="flex items-start gap-2 text-sm text-gray-800">
              <input type="checkbox" className="mt-0.5" checked={!f.test_mode}
                     onChange={e => set('test_mode', !e.target.checked)} />
              <span>
                <span className="font-semibold">Одному человеку — не чаще раза в час</span>
                <span className="block text-xs mt-1 font-normal text-gray-600">
                  Включено: если человек уже получил материал и пишет снова <b>в течение часа</b>,
                  в личные сообщения ему ничего не уйдёт — только публичный ответ под комментарием.
                  Так один человек не получит десяток писем подряд.
                  <br />
                  Выключено: материал уходит на <b>каждый</b> комментарий. Удобно, пока настраиваете
                  и проверяете воронку на себе.
                </span>
              </span>
            </label>
          </div>

          {f.reminder_enabled && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Напомнить через (минут)</label>
              <input type="number" min={5} max={1380} value={f.reminder_delay_min}
                onChange={e => set('reminder_delay_min', +e.target.value)}
                className="w-32 px-3 py-2 text-sm border border-gray-200 rounded-lg" />
              <p className="text-xs text-gray-500 mt-1">
                Человек написал кодовое слово, получил в директ просьбу подписаться —
                и пропал. Через это время ему уйдёт одно напоминание. Если он к тому
                моменту подпишется, но не нажмёт кнопку — сразу отправим материал.
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Instagram разрешает писать только сутки с последнего сообщения человека —
                если срок вышел, напоминание не уйдёт.
              </p>
            </div>
          )}

          <details className="rounded-lg border border-gray-200 p-3">
            <summary className="text-sm font-medium text-gray-800 cursor-pointer">
              Тексты сообщений
            </summary>
            <p className="text-xs text-gray-500 mt-2 mb-3">
              Пишите по несколько вариантов на каждый пункт — Instagram считает спамом
              повторяющиеся одинаковые ответы и режет охваты. Оставите пусто — используем свои.
            </p>

            {/* ⚠️ Пояснение к плейсхолдерам — ОДНО на весь блок: они работают
                во всех текстах одинаково, и повторять у каждого поля значит
                зашумлять форму. Без пояснения «{handle}» читается как мусор
                и его стирают. */}
            <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 mb-3">
              <p className="text-xs font-semibold text-gray-700 mb-1.5">
                Что можно вставить в текст — подставится автоматически:
              </p>
              <ul className="space-y-1">
                {PLACEHOLDERS.map(({ code, what }) => (
                  <li key={code} className="text-xs text-gray-600">
                    <code className="px-1 py-0.5 rounded bg-white border border-gray-200 text-gray-800">
                      {code}
                    </code>
                    {' — '}{what}
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-gray-400 mt-1.5">
                Если значения нет (например, Instagram не отдал ник), строка соберётся без него —
                лишних скобок и пустых кавычек человек не увидит.
              </p>
            </div>

            <div className="space-y-3">
              {REPLY_KINDS.map(({ key, title, hint }) => (
                <div key={key}>
                  <label className="block text-xs font-medium text-gray-700">{title}</label>
                  {hint && <p className="text-[11px] text-gray-400 mb-1">{hint}</p>}
                  <textarea
                    value={(f.replies?.[key] || []).join('\n')}
                    onChange={e => set('replies', { ...(f.replies || {}), [key]: e.target.value.split('\n') })}
                    rows={2} placeholder="По одному варианту на строку"
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
                </div>
              ))}
            </div>
          </details>
        </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Отмена</button>
          <button onClick={save} disabled={busy || loading} className="btn-gold px-5 disabled:opacity-50">
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Кто обращался в воронку и что получил.
 *
 * ⚠️ Цифры в карточке отвечают «сколько», но не «кто». Без имён клиенту не с
 * кем работать: он видит «получили 12» и не может ни написать этим людям, ни
 * проверить, дошёл ли материал до конкретного человека.
 *
 * ⚠️ Модалка-форма закрывается только крестиком/кнопкой — по фону НЕ
 * закрываем (правило проекта: иначе теряются данные при случайном клике).
 */
function PeopleModal({ funnel, onClose }: { funnel: Funnel; onClose: () => void }) {
  const [data, setData] = useState<any | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.instagramFunnels.people(funnel.id)
      .then(setData)
      .catch((e: any) => setErr(e?.message || 'Не удалось загрузить'))
  }, [funnel.id])

  const people: any[] = data?.people || []

  const when = (v: string | null) => {
    if (!v) return '—'
    // ⚠️ Время события показываем по Москве — как везде в кабинете.
    return new Date(v).toLocaleString('ru', {
      timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-2xl my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="min-w-0">
            <p className="font-semibold text-gray-900 truncate">{funnel.name}</p>
            <p className="text-xs text-gray-500">Кто обращался и что получил</p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-700" title="Закрыть">
            <X size={18} />
          </button>
        </div>

        <div className="p-5">
          {err && <p className="text-sm text-red-600">{err}</p>}
          {!data && !err && (
            <div className="flex items-center gap-2 text-sm text-gray-500 py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Загружаем…
            </div>
          )}

          {data && (
            <>
              <div className="flex gap-3 mb-4">
                <div className="flex-1 rounded-xl border border-gray-200 p-3">
                  <p className="text-xl font-semibold text-gray-900">{data.counts.started}</p>
                  <p className="text-xs text-gray-500">написали комментарий</p>
                </div>
                <div className="flex-1 rounded-xl border border-gray-200 p-3">
                  <p className="text-xl font-semibold text-gray-900">{data.counts.delivered}</p>
                  {/* ⚠️ Формулировка зависит от настройки: когда подписка
                      требуется, выдача идёт ТОЛЬКО после успешной проверки —
                      значит «получили» и есть «подписались и забрали». Писать
                      это без учёта галочки нельзя: у воронки без проверки
                      подписки никто не подписывался. */}
                  <p className="text-xs text-gray-500">
                    {data.require_subscription ? 'подписались и забрали' : 'забрали материал'}
                  </p>
                </div>
              </div>

              {people.length === 0 ? (
                <p className="text-sm text-gray-500 py-4">
                  Пока никто не обращался. Как только человек напишет кодовое слово
                  под вашей публикацией, он появится здесь.
                </p>
              ) : (
                <div className="overflow-x-auto -mx-5 px-5">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                        <th className="py-2 pr-3 font-medium">Человек</th>
                        <th className="py-2 pr-3 font-medium">Написал</th>
                        <th className="py-2 pr-3 font-medium">Получил</th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.map(p => (
                        <tr key={p.id} className="border-b border-gray-50">
                          <td className="py-2 pr-3">
                            {/* ⚠️ Ник — ссылкой на профиль: клиенту нужно уметь
                                написать человеку, а не просто увидеть строку. */}
                            {p.profile_url ? (
                              <a href={p.profile_url} target="_blank" rel="noreferrer"
                                 className="text-blue-600 hover:underline">
                                @{p.username}
                              </a>
                            ) : (
                              <span className="text-gray-500">
                                {p.contact_name || `id ${p.platform_user_id}`}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-gray-600 whitespace-nowrap">
                            {when(p.started_at || p.ig_last_user_message_at)}
                          </td>
                          <td className="py-2 pr-3 whitespace-nowrap">
                            {p.stage === 'delivered' ? (
                              <span className="text-green-600">{when(p.delivered_at || p.ig_last_delivered_at)}</span>
                            ) : (
                              <span className="text-gray-400">не забрал</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex justify-end">
          <button onClick={onClose} className="btn-primary px-4 py-2 text-sm">Закрыть</button>
        </div>
      </div>
    </div>
  )
}
