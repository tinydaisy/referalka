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
import { Plus, Trash2, Pencil, Instagram, AlertTriangle, X, Loader2, Check } from 'lucide-react'
import { api } from '@/lib/api'

interface Funnel {
  id: number
  name: string
  channel_id: number
  account_handle?: string | null
  trigger_kind: string
  media_scope: string
  media_ids: string[]
  keyword_mode: string
  keywords: string[]
  lead_magnet_id: number | null
  package_id: number | null
  lead_magnet_name?: string | null
  package_name?: string | null
  delivery_mode: string
  require_subscription: boolean
  public_reply_enabled: boolean
  reminder_enabled: boolean
  reminder_delay_min: number
  is_active: boolean
  runs?: number
  delivered?: number
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
    'Привет! Материал готов. Подпишитесь на аккаунт и нажмите «Готово» — сразу отправим.',
    'Здравствуйте! Остался один шаг: подпишитесь на аккаунт и нажмите «Готово».',
    'Привет! Рады, что заинтересовало. Подпишитесь на аккаунт и нажмите «Готово» — отправим материал.',
    'Здравствуйте! Чтобы забрать материал, подпишитесь на аккаунт и нажмите «Готово».',
  ],
  dm_not_subscribed: [
    'Пока не видим вашу подписку. Подпишитесь на аккаунт и нажмите «Готово» ещё раз.',
    'Подписки пока не видно — проверьте, что подписались, и нажмите «Готово».',
    'Кажется, подписка ещё не оформлена. Подпишитесь и нажмите «Готово» — сразу отправим.',
    'Не нашли вас среди подписчиков. Подпишитесь на аккаунт и нажмите «Готово».',
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
    'Напоминаем: материал ждёт вас. Подпишитесь на аккаунт и нажмите «Готово».',
    'Вы не забрали материал — подпишитесь и нажмите «Готово», сразу отправим.',
    'Материал всё ещё за вами. Подпишитесь на аккаунт и нажмите «Готово».',
    'Не хотим, чтобы вы потеряли материал — подпишитесь и нажмите «Готово».',
  ],
}

const REPLY_KINDS: { key: string; title: string; hint: string }[] = [
  { key: 'public_comment',    title: 'Ответ под комментарием', hint: 'Видят все. Пишите несколько вариантов — одинаковые ответы Instagram считает спамом' },
  { key: 'dm_intro',          title: 'Первое сообщение в директ', hint: 'Просьба подписаться, если проверка подписки включена' },
  { key: 'dm_not_subscribed', title: 'Если подписки не видно', hint: '' },
  { key: 'dm_delivered',      title: 'Выдача материала', hint: 'Перед ссылками на материалы' },
  { key: 'dm_repeat',         title: 'Если написал повторно', hint: '«Уже отправляли — вот ещё раз»' },
  { key: 'dm_reminder',       title: 'Напоминание молчащему', hint: '' },
]

export default function InstagramFunnelsTab() {
  const [items, setItems] = useState<Funnel[]>([])
  const [accounts, setAccounts] = useState<any[]>([])
  const [magnets, setMagnets] = useState<any[]>([])
  const [packages, setPackages] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<any | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [f, ch, lm, pk] = await Promise.all([
        api.instagramFunnels.list(),
        api.channels.list(),
        api.leadMagnets.list(),
        api.leadMagnetPackages.list(),
      ])
      setItems(f.items || [])
      setAccounts((ch.items || []).filter((c: any) => c.platform_slug === 'instagram'))
      setMagnets(lm.items || [])
      setPackages(pk.items || [])
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
                    {!f.is_active && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">выключена</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">
                    {f.trigger_kind === 'story_reply' ? 'Ответ на сторис' : 'Комментарий под публикацией'}
                    {f.keyword_mode === 'specific' && f.keywords?.length
                      ? ` · слова: ${f.keywords.join(', ')}` : ' · любое слово'}
                    {' · выдаём: '}
                    {f.lead_magnet_name || f.package_name || '—'}
                    {f.account_handle ? ` · @${f.account_handle}` : ''}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    Обратились: {f.runs ?? 0} · получили: {f.delivered ?? 0}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => setEditing({ id: f.id })}
                          className="p-2 text-gray-400 hover:text-gray-700" title="Изменить">
                    <Pencil size={16} />
                  </button>
                  <button onClick={() => remove(f)}
                          className="p-2 text-gray-400 hover:text-red-600" title="Удалить">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <FunnelModal
          initial={editing}
          accounts={accounts}
          magnets={magnets}
          packages={packages}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
    </div>
  )
}


function FunnelModal({ initial, accounts, magnets, packages, onClose, onSaved }: {
  initial: any
  accounts: any[]
  magnets: any[]
  packages: any[]
  onClose: () => void
  onSaved: () => void
}) {
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
    delivery_mode: 'direct',
    require_subscription: true,
    public_reply_enabled: true,
    reminder_enabled: true,
    reminder_delay_min: 10,
    is_active: true,
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
      .then((r: any) => setF({ ...r, keywords: r.keywords?.length ? r.keywords : [''] }))
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

          {accounts.length > 1 && (
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
            <select
              value={f.lead_magnet_id ? `m${f.lead_magnet_id}` : f.package_id ? `p${f.package_id}` : ''}
              onChange={e => {
                const v = e.target.value
                set('lead_magnet_id', v.startsWith('m') ? +v.slice(1) : null)
                set('package_id', v.startsWith('p') ? +v.slice(1) : null)
              }}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg">
              <option value="">— выберите —</option>
              {magnets.length > 0 && <optgroup label="Лид-магниты">
                {magnets.map((m: any) => <option key={m.id} value={`m${m.id}`}>{m.name}</option>)}
              </optgroup>}
              {packages.length > 0 && <optgroup label="Пакеты">
                {packages.map((p: any) => <option key={p.id} value={`p${p.id}`}>{p.name}</option>)}
              </optgroup>}
            </select>
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
