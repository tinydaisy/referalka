'use client'
import { useState, useEffect } from 'react'
import { Search, Star, Send, MapPin, Check, X, Sparkles, Users, Calendar, Pencil, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

export const PEACH = '#FFCFA4'
export const DARK = '#25455D'

// Лайтбокс для фото
export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-6" onClick={onClose}>
      <img src={src} alt="" className="max-w-full max-h-full rounded-2xl object-contain" onClick={e => e.stopPropagation()} />
      <button onClick={onClose} className="absolute top-4 right-4 text-white/80 hover:text-white"><X className="w-7 h-7" /></button>
    </div>
  )
}

export const CATEGORIES: Record<string, string> = {
  offline_business: 'Офлайн-бизнес', online_business: 'Онлайн-бизнес', freelancer: 'Фрилансер', expert: 'Эксперт',
}
export const TIERS: Record<string, string> = {
  under_1k: 'до 1 000', '1k_5k': 'до 5 000', '5k_10k': '5–10 тыс', over_10k: 'выше 10 тыс',
}

export function HubHeader({ subtitle }: { subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold mb-1" style={{ color: DARK }}>Коллабораторная</h1>
      <p className="text-gray-500 text-sm">{subtitle}</p>
    </div>
  )
}

export function MediaTierBadge({ tier }: { tier?: string }) {
  if (!tier) return null
  return <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600"><Users className="w-3 h-3" /> {TIERS[tier] || tier}</span>
}

export function CollabCard({ item, onRequest }: { item: any; onRequest?: () => void }) {
  const isMe = item.is_me
  const hadCollabs = (item.collabs_count || 0) > 0
  const contribution = hadCollabs && item.avg_contribution != null ? `${item.avg_contribution}%` : '—'
  const achievements: any[] = Array.isArray(item.achievements) ? item.achievements : []
  const [bioOpen, setBioOpen] = useState(false)
  const [lightbox, setLightbox] = useState(false)
  const bio = item.bio || ''
  const bioLong = bio.length > 120
  return (
    <div className={`rounded-2xl p-4 transition flex flex-col ${isMe ? 'border-2' : 'border bg-white hover:shadow-md'}`}
         style={isMe ? { borderColor: PEACH, background: '#FFF8F1' } : {}}>
      {isMe && <div className="text-[11px] font-semibold mb-2 inline-flex items-center gap-1" style={{ color: '#C77B3B' }}><Star className="w-3 h-3" fill={PEACH} stroke={PEACH} />ВАША КАРТОЧКА</div>}
      <div className="flex items-start gap-3">
        {item.photo_url
          ? <img src={item.photo_url} alt="" onClick={() => setLightbox(true)} className="w-14 h-14 rounded-xl object-cover cursor-zoom-in hover:opacity-90" />
          : <div className="w-14 h-14 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400"><Users className="w-6 h-6" /></div>}
        <div className="flex-1 min-w-0">
          <div className="font-semibold" style={{ color: DARK }}>{item.name}</div>
          {/* позиционирование — полностью, без обрезки */}
          {item.positioning && <div className="text-xs text-gray-500">{item.positioning}</div>}
          <div className="flex flex-wrap gap-1 mt-1">
            {item.hub_category && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: PEACH, color: DARK }}>{CATEGORIES[item.hub_category] || item.hub_category}</span>}
            <MediaTierBadge tier={item.media_tier} />
          </div>
        </div>
      </div>
      {item.hub_about && <p className="text-sm text-gray-600 mt-3">{item.hub_about}</p>}
      {/* Био — разворачиваемое */}
      {bio && (
        <div className="mt-2">
          <p className={`text-sm text-gray-500 ${bioOpen ? '' : 'line-clamp-2'}`}>{bio}</p>
          {bioLong && <button onClick={() => setBioOpen(!bioOpen)} className="text-xs mt-1 inline-flex items-center gap-0.5" style={{ color: '#C77B3B' }}>
            {bioOpen ? <>Свернуть <ChevronUp className="w-3 h-3" /></> : <>Подробнее <ChevronDown className="w-3 h-3" /></>}
          </button>}
        </div>
      )}
      {achievements.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {achievements.slice(0, 4).map((a: any, i: number) => (
            <span key={i} className="text-[11px] px-2 py-1 rounded-lg bg-gray-50 text-gray-600">
              {a.value ? <b style={{ color: DARK }}>{a.value}</b> : null} {a.label}
            </span>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 mt-3">
        <div className="rounded-xl bg-gray-50 p-2 text-center">
          <div className="font-bold text-sm" style={{ color: DARK }}>{item.collabs_count ?? 0}</div>
          <div className="text-[10px] text-gray-500 leading-tight">коллабораций</div>
        </div>
        <div className="rounded-xl bg-gray-50 p-2 text-center" title="Среднее по всем коллаборациям: какую долю участников события организатор приводил сам. Показывает, насколько он вкладывается — надёжный партнёр или нахлебник.">
          <div className="font-bold text-sm" style={{ color: DARK }}>{contribution}</div>
          <div className="text-[10px] text-gray-500 leading-tight">средний вклад</div>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
        {item.hub_city && <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{item.hub_city}</span>}
        {item.avg_rating && <span className="inline-flex items-center gap-1"><Star className="w-3 h-3" fill={PEACH} stroke={PEACH} />{item.avg_rating}</span>}
      </div>
      {isMe ? (
        <a href="/dashboard/collab-hub/card" className="mt-3 w-full text-sm py-2 rounded-xl border text-center" style={{ borderColor: PEACH, color: '#C77B3B' }}>Редактировать карточку</a>
      ) : (
        <div className="flex gap-2 mt-3">
          <a href={`/dashboard/collab-hub/org/${item.client_id}`} className="flex-1 text-sm py-2 rounded-xl border text-center hover:bg-gray-50">Профиль</a>
          {onRequest && <button onClick={onRequest} className="flex-1 text-sm py-2 rounded-xl text-white" style={{ background: DARK }}>Предложить</button>}
        </div>
      )}
      {lightbox && item.photo_url && <Lightbox src={item.photo_url} onClose={() => setLightbox(false)} />}
    </div>
  )
}

export function RequestModal({ target, onClose }: { target: any; onClose: () => void }) {
  const [events, setEvents] = useState<any[]>([])
  const [eventId, setEventId] = useState('')
  const [msg, setMsg] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { api.events.list().then((r: any) => setEvents(Array.isArray(r) ? r : (r.events || []))).catch(() => {}) }, [])
  const send = async () => {
    setErr('')
    try { await api.collabHub.createRequest({ to_client_id: target.client_id, event_id: eventId ? Number(eventId) : null, message: msg || null }); setSent(true) }
    catch (e: any) { setErr(e?.message || 'Ошибка') }
  }
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-lg" style={{ color: DARK }}>Предложить коллаборацию</h3>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        {sent ? (
          <div className="text-center py-4">
            <Check className="w-10 h-10 mx-auto mb-2 text-green-500" />
            <p className="text-gray-700">Запрос отправлен <b>{target.name}</b>. Будет «серым», пока не ответят.</p>
            <button onClick={onClose} className="mt-4 px-4 py-2 rounded-xl text-white" style={{ background: DARK }}>Готово</button>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-600 mb-3">Кому: <b>{target.name}</b></p>
            <label className="block text-sm text-gray-500 mb-1">К какому вашему событию (необязательно)</label>
            <select value={eventId} onChange={e => setEventId(e.target.value)} className="w-full border rounded-xl px-3 py-2 text-sm mb-3">
              <option value="">Без события (общее знакомство)</option>
              {events.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}
            </select>
            <textarea value={msg} onChange={e => setMsg(e.target.value)} placeholder="Сообщение (необязательно)" className="w-full border rounded-xl px-3 py-2 text-sm mb-3" rows={3} />
            {err && <p className="text-red-500 text-sm mb-2">{err}</p>}
            <button onClick={send} className="w-full py-2.5 rounded-xl text-white font-medium" style={{ background: DARK }}>Отправить запрос</button>
          </>
        )}
      </div>
    </div>
  )
}

export function CatalogView() {
  const [items, setItems] = useState<any[]>([])
  const [me, setMe] = useState<any | null>(null)
  const [niches, setNiches] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [f, setF] = useState<Record<string, string>>({})
  const [reqTarget, setReqTarget] = useState<any | null>(null)
  const load = async () => {
    setLoading(true)
    try { const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v)); const r: any = await api.collabHub.catalog(clean as any); setItems(r.items || []); setMe(r.me || null) } catch { setItems([]) }
    setLoading(false)
  }
  useEffect(() => { api.collabHub.niches().then((r: any) => setNiches(r.niches || [])).catch(() => {}) }, [])
  useEffect(() => { load() }, [f])
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        <select value={f.niche || ''} onChange={e => setF({ ...f, niche: e.target.value })} className="border rounded-xl px-3 py-2 text-sm">
          <option value="">Все ниши</option>{niches.map(n => <option key={n.slug} value={n.slug}>{n.title}</option>)}
        </select>
        <select value={f.category || ''} onChange={e => setF({ ...f, category: e.target.value })} className="border rounded-xl px-3 py-2 text-sm">
          <option value="">Все категории</option>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={f.media_tier || ''} onChange={e => setF({ ...f, media_tier: e.target.value })} className="border rounded-xl px-3 py-2 text-sm">
          <option value="">Любая медийность</option>{Object.entries(TIERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input value={f.q || ''} onChange={e => setF({ ...f, q: e.target.value })} placeholder="Поиск по имени…" className="border rounded-xl px-3 py-2 text-sm flex-1 min-w-[150px]" />
      </div>
      {loading ? <div className="text-gray-400 py-10 text-center">Загрузка…</div>
        : <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {me && <CollabCard item={me} />}
            {items.map(it => <CollabCard key={it.client_id} item={it} onRequest={() => setReqTarget(it)} />)}
            {items.length === 0 && !me && <div className="text-gray-400 py-10 text-center col-span-full">Пока никого нет в каталоге по этим фильтрам.</div>}
          </div>}
      {reqTarget && <RequestModal target={reqTarget} onClose={() => setReqTarget(null)} />}
    </div>
  )
}

export function RequestsView() {
  // tab: pending (ждут моего/их ответа) | accepted (договорённости — принятые, неважно кто инициатор)
  const [tab, setTab] = useState<'pending' | 'accepted'>('pending')
  const [incoming, setIncoming] = useState<any[]>([])
  const [outgoing, setOutgoing] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const load = async () => {
    setLoading(true)
    try {
      const [inc, out]: any = await Promise.all([api.collabHub.requests('incoming'), api.collabHub.requests('outgoing')])
      setIncoming(inc.requests || []); setOutgoing(out.requests || [])
    } catch { setIncoming([]); setOutgoing([]) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])
  const respond = async (id: number, accept: boolean) => { await api.collabHub.respondRequest(id, accept); load() }

  // Договорённости = принятые из обоих направлений, с пометкой кто инициатор
  const deals = [
    ...incoming.filter(r => r.status === 'accepted').map(r => ({ ...r, initiator: 'them' })),
    ...outgoing.filter(r => r.status === 'accepted').map(r => ({ ...r, initiator: 'me' })),
  ]
  // Ждут ответа: входящие pending (мне решать) + отправленные pending (жду их)
  const pendingIn = incoming.filter(r => r.status === 'pending')
  const pendingOut = outgoing.filter(r => r.status === 'pending')

  const Avatar = ({ r }: { r: any }) => r.other_photo
    ? <img src={r.other_photo} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0" />
    : <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 shrink-0"><Users className="w-5 h-5" /></div>

  const Contacts = ({ r }: { r: any }) => (
    <div className="flex items-center gap-2 mt-2">
      <a href={`/dashboard/collab-hub/org/${r.other_client_id}`} className="text-xs px-2.5 py-1 rounded-lg border inline-flex items-center gap-1 hover:bg-gray-50">
        <ExternalLink className="w-3 h-3" />Профиль
      </a>
      {r.other_tg && <a href={`https://t.me/${r.other_tg.replace('@', '')}?text=Здравствуйте! По коллаборации в ПЛЮСОН`} target="_blank" rel="noreferrer" className="text-xs px-2.5 py-1 rounded-lg border inline-flex items-center gap-1 text-blue-600">
        <Send className="w-3 h-3" />Написать в Telegram
      </a>}
    </div>
  )

  if (loading) return <div className="text-gray-400 py-10 text-center">Загрузка…</div>
  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setTab('pending')} className={`px-4 py-2 rounded-xl text-sm ${tab === 'pending' ? 'text-white' : 'border'}`} style={tab === 'pending' ? { background: DARK } : {}}>
          Ждут ответа {(pendingIn.length + pendingOut.length) > 0 && `(${pendingIn.length + pendingOut.length})`}
        </button>
        <button onClick={() => setTab('accepted')} className={`px-4 py-2 rounded-xl text-sm ${tab === 'accepted' ? 'text-white' : 'border'}`} style={tab === 'accepted' ? { background: DARK } : {}}>
          Договорённости {deals.length > 0 && `(${deals.length})`}
        </button>
      </div>

      {tab === 'pending' ? (
        <div className="space-y-4">
          {pendingIn.length > 0 && <div>
            <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Вам предложили</div>
            <div className="space-y-2">{pendingIn.map(r => (
              <div key={r.id} className="border rounded-2xl p-4 flex items-start justify-between gap-3 bg-white">
                <div className="flex items-start gap-3 min-w-0">
                  <Avatar r={r} />
                  <div className="min-w-0">
                    <div className="font-medium" style={{ color: DARK }}>{r.other_name}</div>
                    {r.event_title && <div className="text-xs text-gray-500">Событие: {r.event_title}</div>}
                    {r.message && <div className="text-sm text-gray-600 mt-1">{r.message}</div>}
                    <Contacts r={r} />
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => respond(r.id, true)} className="text-sm px-3 py-1.5 rounded-xl text-white" style={{ background: '#16a34a' }}><Check className="w-4 h-4" /></button>
                  <button onClick={() => respond(r.id, false)} className="text-sm px-3 py-1.5 rounded-xl border text-red-500"><X className="w-4 h-4" /></button>
                </div>
              </div>
            ))}</div>
          </div>}
          {pendingOut.length > 0 && <div>
            <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Вы предложили (ждёте ответа)</div>
            <div className="space-y-2">{pendingOut.map(r => (
              <div key={r.id} className="border rounded-2xl p-4 flex items-start gap-3 bg-white">
                <Avatar r={r} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium" style={{ color: DARK }}>{r.other_name}</div>
                  {r.event_title && <div className="text-xs text-gray-500">Событие: {r.event_title}</div>}
                  {r.message && <div className="text-sm text-gray-600 mt-1">{r.message}</div>}
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 inline-block mt-1">Ждёт ответа</span>
                  <Contacts r={r} />
                </div>
              </div>
            ))}</div>
          </div>}
          {pendingIn.length === 0 && pendingOut.length === 0 && <div className="text-gray-400 py-10 text-center">Нет запросов, ждущих ответа.</div>}
        </div>
      ) : (
        <div className="space-y-2">
          {deals.length === 0 ? <div className="text-gray-400 py-10 text-center">Принятых коллабораций пока нет.</div>
            : deals.map(r => (
              <div key={r.id} className="border rounded-2xl p-4 flex items-start gap-3 bg-white">
                <Avatar r={r} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium" style={{ color: DARK }}>{r.other_name}</span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: PEACH, color: DARK }}>
                      {r.initiator === 'me' ? 'инициатор — вы' : 'инициатор — партнёр'}
                    </span>
                  </div>
                  {r.event_title && <div className="text-xs text-gray-500">Событие: {r.event_title}</div>}
                  {r.message && <div className="text-sm text-gray-600 mt-1">{r.message}</div>}
                  <Contacts r={r} />
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

export function MatchmakerView() {
  const [data, setData] = useState<any>(null)
  const [reqTarget, setReqTarget] = useState<any | null>(null)
  useEffect(() => { api.collabHub.matchmaker().then(setData).catch(() => setData({ suggestions: [] })) }, [])
  if (!data) return <div className="text-gray-400 py-10 text-center">Подбираем партнёров…</div>
  return (
    <div>
      <div className="rounded-2xl p-4 mb-5 text-white" style={{ background: `linear-gradient(45deg, ${DARK}, #0a1520)` }}>
        <div className="flex items-center gap-2 mb-1"><Sparkles className="w-5 h-5" style={{ color: PEACH }} /><b>Умный сват</b></div>
        <p className="text-sm opacity-90">Подбираем по вашей нише и аудитории. {data.my_niche ? '' : 'Заполните нишу в «Моя карточка» для точного подбора.'}</p>
      </div>
      {data.suggestions?.length === 0 ? <div className="text-gray-400 py-10 text-center">Пока некого предложить — каталог наполняется.</div>
        : <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{data.suggestions.map((it: any) => <CollabCard key={it.client_id} item={it} onRequest={() => setReqTarget(it)} />)}</div>}
      {reqTarget && <RequestModal target={reqTarget} onClose={() => setReqTarget(null)} />}
    </div>
  )
}

export function MyCardView() {
  const [card, setCard] = useState<any>(null)
  const [niches, setNiches] = useState<any[]>([])
  const [form, setForm] = useState<any>({ is_published_in_hub: true, hub_category: '', hub_niche: '', hub_city: '', hub_about: '' })
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')
  const load = async () => {
    const r: any = await api.collabHub.myCard()
    setCard(r.card)
    setForm({ is_published_in_hub: r.card.is_published_in_hub ?? true, hub_category: r.card.hub_category || '', hub_niche: r.card.hub_niche || '', hub_city: r.card.hub_city || '', hub_about: r.card.hub_about || '' })
  }
  useEffect(() => { load().catch(() => {}); api.collabHub.niches().then((r: any) => setNiches(r.niches || [])).catch(() => {}) }, [])
  const save = async () => { setErr(''); try { await api.collabHub.publishCard(form); setSaved(true); setTimeout(() => setSaved(false), 2000); load() } catch (e: any) { setErr(e?.message || 'Ошибка') } }
  if (!card) return <div className="text-gray-400 py-10 text-center">Загрузка…</div>
  const achievements: any[] = Array.isArray(card.achievements) ? card.achievements : []
  const social = card.social_links || {}
  const tg = social.telegram_channels?.[0]?.url || social.telegram
  return (
    <div className="grid lg:grid-cols-2 gap-8">
      <div>
        <div className="text-sm font-medium text-gray-500 mb-2">Так вас увидят в каталоге</div>
        <div className="border rounded-2xl p-5 bg-white">
          <div className="flex items-start gap-4">
            {card.photo_url ? <img src={card.photo_url} alt="" className="w-20 h-20 rounded-2xl object-cover" />
              : <div className="w-20 h-20 rounded-2xl bg-gray-100 flex items-center justify-center text-gray-400"><Users className="w-8 h-8" /></div>}
            <div className="min-w-0">
              <div className="font-bold text-lg" style={{ color: DARK }}>{card.name || '—'}</div>
              {card.positioning && <div className="text-sm text-gray-500">{card.positioning}</div>}
              <div className="mt-1"><MediaTierBadge tier={card.media_tier} /></div>
            </div>
          </div>
          {card.bio && <p className="text-sm text-gray-600 mt-4 line-clamp-3">{card.bio}</p>}
          {achievements.length > 0 && (
            <div className="grid grid-cols-3 gap-2 mt-4">
              {achievements.slice(0, 3).map((a: any, i: number) => (
                <div key={i} className="rounded-xl bg-gray-50 p-2 text-center">
                  <div className="font-bold text-sm" style={{ color: DARK }}>{a.value}</div>
                  <div className="text-[11px] text-gray-500 leading-tight">{a.label}</div>
                </div>
              ))}
            </div>
          )}
          {tg && <a href={tg} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm mt-4 text-blue-600"><Send className="w-3.5 h-3.5" />Telegram-канал</a>}
        </div>
        <div className="text-xs text-gray-400 mt-3 flex items-start gap-1">
          <Pencil className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          Фото, имя, регалии, био и каналы берутся из вашего профиля. Изменить — в <a href="/dashboard/mini-app" className="underline">Настройки → Mini App</a> (вкладка «Основатель»).
        </div>
      </div>
      <div>
        <div className="text-sm font-medium text-gray-500 mb-2">Параметры для биржи</div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Категория</label>
        <select value={form.hub_category} onChange={e => setForm({ ...form, hub_category: e.target.value })} className="w-full border rounded-xl px-3 py-2 text-sm mb-3">
          <option value="">— не выбрано —</option>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="block text-sm font-medium text-gray-700 mb-1">Ниша</label>
        <select value={form.hub_niche} onChange={e => setForm({ ...form, hub_niche: e.target.value })} className="w-full border rounded-xl px-3 py-2 text-sm mb-3">
          <option value="">— не выбрано —</option>{niches.map(n => <option key={n.slug} value={n.slug}>{n.title}</option>)}
        </select>
        <label className="block text-sm font-medium text-gray-700 mb-1">Город (для офлайн-бизнеса)</label>
        <input value={form.hub_city} onChange={e => setForm({ ...form, hub_city: e.target.value })} className="w-full border rounded-xl px-3 py-2 text-sm mb-3" placeholder="Москва" />
        <label className="block text-sm font-medium text-gray-700 mb-1">Что предлагаете партнёрам</label>
        <textarea value={form.hub_about} onChange={e => setForm({ ...form, hub_about: e.target.value })} className="w-full border rounded-xl px-3 py-2 text-sm mb-3" rows={3} placeholder="Чем полезна коллаборация с вами" />
        <label className="flex items-center gap-2 mb-4 text-sm">
          <input type="checkbox" checked={form.is_published_in_hub} onChange={e => setForm({ ...form, is_published_in_hub: e.target.checked })} />
          Опубликовать в каталоге
        </label>
        {err && <p className="text-red-500 text-sm mb-2">{err}</p>}
        <button onClick={save} className="px-5 py-2.5 rounded-xl text-white font-medium" style={{ background: DARK }}>{saved ? '✓ Сохранено' : 'Сохранить'}</button>
      </div>
    </div>
  )
}

// Совместные события — где клиент co_owner (>1 владелец)
export function CollabEventsView() {
  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    api.events.list().then((r: any) => {
      const all = Array.isArray(r) ? r : (r.events || [])
      setEvents(all.filter((e: any) => e.is_collab))
      setLoading(false)
    }).catch(() => { setEvents([]); setLoading(false) })
  }, [])
  if (loading) return <div className="text-gray-400 py-10 text-center">Загрузка…</div>
  if (events.length === 0) return (
    <div className="text-gray-400 py-10 text-center">
      Совместных событий пока нет.<br />
      <span className="text-sm">Они появятся, когда вы примете запрос на коллаборацию или ваш будет принят.</span>
    </div>
  )
  return (
    <div className="space-y-2">
      {events.map(e => (
        <a key={e.id} href={`/dashboard/events/${e.id}`} className="block border rounded-2xl p-4 bg-white hover:shadow-md transition">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-gray-400" />
            <span className="font-medium" style={{ color: DARK }}>{e.title}</span>
            <span className="text-xs px-2 py-0.5 rounded-full ml-auto" style={{ background: PEACH, color: DARK }}>Совместное</span>
          </div>
        </a>
      ))}
    </div>
  )
}
