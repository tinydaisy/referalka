'use client'
import { useState, useEffect } from 'react'
import { Handshake, Search, Star, Send, Inbox, Sparkles, MapPin, Check, X, ExternalLink, Users } from 'lucide-react'
import { api } from '@/lib/api'

const PEACH = '#FFCFA4'
const DARK = '#25455D'

type Tab = 'catalog' | 'card' | 'requests' | 'matchmaker'

const CATEGORIES: Record<string, string> = {
  offline_business: 'Офлайн-бизнес',
  online_business: 'Онлайн-бизнес',
  freelancer: 'Фрилансер',
  expert: 'Эксперт',
}
const TIERS: Record<string, string> = {
  under_1k: 'до 1 000',
  '1k_5k': 'до 5 000',
  '5k_10k': '5–10 тыс',
  over_10k: 'выше 10 тыс',
}

export default function CollabHubPage() {
  const [tab, setTab] = useState<Tab>('catalog')
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 rounded-xl" style={{ background: `linear-gradient(45deg, ${DARK}, #0a1520)` }}>
          <Handshake className="w-6 h-6" style={{ color: PEACH }} />
        </div>
        <h1 className="text-2xl font-bold" style={{ color: DARK }}>Коллабораторная</h1>
      </div>
      <p className="text-gray-500 text-sm mb-6">
        Находите партнёров для совместных событий, обменивайтесь аудиторией честно — каждый ведёт своих.
      </p>

      <div className="flex gap-1 mb-6 border-b overflow-x-auto">
        {([
          ['catalog', 'Каталог', Search],
          ['card', 'Моя карточка', Star],
          ['requests', 'Запросы', Inbox],
          ['matchmaker', 'Умный сват', Sparkles],
        ] as [Tab, string, any][]).map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition ${
              tab === key ? 'border-current' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
            style={tab === key ? { color: DARK, borderColor: PEACH } : {}}>
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'catalog' && <CatalogTab />}
      {tab === 'card' && <MyCardTab />}
      {tab === 'requests' && <RequestsTab />}
      {tab === 'matchmaker' && <MatchmakerTab />}
    </div>
  )
}

function MediaTierBadge({ tier }: { tier?: string }) {
  if (!tier) return null
  return <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
    <Users className="w-3 h-3" /> {TIERS[tier] || tier}</span>
}

function CollabCard({ item, onRequest, onView }: { item: any; onRequest?: () => void; onView?: () => void }) {
  return (
    <div className="border rounded-2xl p-4 bg-white hover:shadow-md transition flex flex-col">
      <div className="flex items-start gap-3">
        {item.photo_url
          ? <img src={item.photo_url} alt="" className="w-14 h-14 rounded-xl object-cover" />
          : <div className="w-14 h-14 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400"><Users className="w-6 h-6" /></div>}
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate" style={{ color: DARK }}>{item.name}</div>
          {item.title && <div className="text-xs text-gray-500 truncate">{item.title}</div>}
          <div className="flex flex-wrap gap-1 mt-1">
            {item.hub_category && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: PEACH, color: DARK }}>{CATEGORIES[item.hub_category] || item.hub_category}</span>}
            <MediaTierBadge tier={item.media_tier} />
          </div>
        </div>
      </div>
      {item.hub_about && <p className="text-sm text-gray-600 mt-3 line-clamp-2">{item.hub_about}</p>}
      <div className="flex items-center gap-3 mt-3 text-xs text-gray-500">
        {item.hub_city && <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{item.hub_city}</span>}
        {typeof item.collabs_count === 'number' && <span>Коллабораций: {item.collabs_count}</span>}
        {item.avg_rating && <span className="inline-flex items-center gap-1"><Star className="w-3 h-3" fill={PEACH} stroke={PEACH} />{item.avg_rating}</span>}
      </div>
      <div className="flex gap-2 mt-3">
        {onView && <button onClick={onView} className="flex-1 text-sm py-2 rounded-xl border hover:bg-gray-50">Профиль</button>}
        {onRequest && <button onClick={onRequest} className="flex-1 text-sm py-2 rounded-xl text-white" style={{ background: DARK }}>Предложить</button>}
      </div>
    </div>
  )
}

function CatalogTab() {
  const [items, setItems] = useState<any[]>([])
  const [niches, setNiches] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [f, setF] = useState<Record<string, string>>({})
  const [reqTarget, setReqTarget] = useState<any | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v))
      const r: any = await api.collabHub.catalog(clean as any)
      setItems(r.items || [])
    } catch { setItems([]) }
    setLoading(false)
  }
  useEffect(() => { api.collabHub.niches().then((r: any) => setNiches(r.niches || [])).catch(() => {}) }, [])
  useEffect(() => { load() }, [f])

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        <select value={f.niche || ''} onChange={e => setF({ ...f, niche: e.target.value })} className="border rounded-xl px-3 py-2 text-sm">
          <option value="">Все ниши</option>
          {niches.map(n => <option key={n.slug} value={n.slug}>{n.title}</option>)}
        </select>
        <select value={f.category || ''} onChange={e => setF({ ...f, category: e.target.value })} className="border rounded-xl px-3 py-2 text-sm">
          <option value="">Все категории</option>
          {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={f.media_tier || ''} onChange={e => setF({ ...f, media_tier: e.target.value })} className="border rounded-xl px-3 py-2 text-sm">
          <option value="">Любая медийность</option>
          {Object.entries(TIERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input value={f.q || ''} onChange={e => setF({ ...f, q: e.target.value })} placeholder="Поиск по имени…" className="border rounded-xl px-3 py-2 text-sm flex-1 min-w-[150px]" />
      </div>
      {loading ? <div className="text-gray-400 py-10 text-center">Загрузка…</div>
        : items.length === 0 ? <div className="text-gray-400 py-10 text-center">Пока никого нет в каталоге по этим фильтрам.</div>
        : <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map(it => <CollabCard key={it.collaborator_id} item={it} onRequest={() => setReqTarget(it)} />)}
          </div>}
      {reqTarget && <RequestModal target={reqTarget} onClose={() => setReqTarget(null)} />}
    </div>
  )
}

function RequestModal({ target, onClose }: { target: any; onClose: () => void }) {
  const [events, setEvents] = useState<any[]>([])
  const [eventId, setEventId] = useState<string>('')
  const [msg, setMsg] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { api.events.list().then((r: any) => setEvents(Array.isArray(r) ? r : (r.events || []))).catch(() => {}) }, [])
  const send = async () => {
    setErr('')
    try {
      await api.collabHub.createRequest({ to_client_id: target.client_id, event_id: eventId ? Number(eventId) : null, message: msg || null })
      setSent(true)
    } catch (e: any) { setErr(e?.message || 'Ошибка') }
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

function MyCardTab() {
  const [data, setData] = useState<any>(null)
  const [niches, setNiches] = useState<any[]>([])
  const [form, setForm] = useState<any>({ collaborator_id: '', is_published_in_hub: true, hub_category: '', hub_niche: '', hub_city: '', hub_about: '' })
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')

  const load = async () => {
    const r: any = await api.collabHub.myCard()
    setData(r)
    if (r.published) {
      setForm({ collaborator_id: r.published.id, is_published_in_hub: true, hub_category: r.published.hub_category || '', hub_niche: r.published.hub_niche || '', hub_city: r.published.hub_city || '', hub_about: r.published.hub_about || '' })
    } else if (r.my_collaborators?.length) {
      setForm((f: any) => ({ ...f, collaborator_id: r.my_collaborators[0].id }))
    }
  }
  useEffect(() => { load().catch(() => {}); api.collabHub.niches().then((r: any) => setNiches(r.niches || [])).catch(() => {}) }, [])

  const save = async () => {
    setErr('')
    if (!form.collaborator_id) { setErr('Выберите свою карточку коллаборатора (нажмите «это я»)'); return }
    try {
      await api.collabHub.publishCard({ ...form, collaborator_id: Number(form.collaborator_id) })
      setSaved(true); setTimeout(() => setSaved(false), 2000); load()
    } catch (e: any) { setErr(e?.message || 'Ошибка') }
  }

  if (!data) return <div className="text-gray-400 py-10 text-center">Загрузка…</div>
  return (
    <div className="max-w-lg">
      <p className="text-sm text-gray-600 mb-4">
        Опубликуйте себя в каталоге, чтобы другие организаторы находили вас для совместных событий.
        Выберите карточку коллаборатора, которая представляет вас.
      </p>
      <label className="block text-sm font-medium text-gray-700 mb-1">Это я (моя карточка)</label>
      <select value={form.collaborator_id} onChange={e => setForm({ ...form, collaborator_id: e.target.value })} className="w-full border rounded-xl px-3 py-2 text-sm mb-3">
        <option value="">— выберите —</option>
        {(data.my_collaborators || []).map((c: any) => <option key={c.id} value={c.id}>{c.name}{c.title ? ` — ${c.title}` : ''}</option>)}
      </select>
      <label className="block text-sm font-medium text-gray-700 mb-1">Категория</label>
      <select value={form.hub_category} onChange={e => setForm({ ...form, hub_category: e.target.value })} className="w-full border rounded-xl px-3 py-2 text-sm mb-3">
        <option value="">— не выбрано —</option>
        {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <label className="block text-sm font-medium text-gray-700 mb-1">Ниша</label>
      <select value={form.hub_niche} onChange={e => setForm({ ...form, hub_niche: e.target.value })} className="w-full border rounded-xl px-3 py-2 text-sm mb-3">
        <option value="">— не выбрано —</option>
        {niches.map(n => <option key={n.slug} value={n.slug}>{n.title}</option>)}
      </select>
      <label className="block text-sm font-medium text-gray-700 mb-1">Город (для офлайн-бизнеса)</label>
      <input value={form.hub_city} onChange={e => setForm({ ...form, hub_city: e.target.value })} className="w-full border rounded-xl px-3 py-2 text-sm mb-3" placeholder="Москва" />
      <label className="block text-sm font-medium text-gray-700 mb-1">О себе</label>
      <textarea value={form.hub_about} onChange={e => setForm({ ...form, hub_about: e.target.value })} className="w-full border rounded-xl px-3 py-2 text-sm mb-3" rows={3} placeholder="Чем занимаетесь, что предлагаете партнёрам" />
      <label className="flex items-center gap-2 mb-4 text-sm">
        <input type="checkbox" checked={form.is_published_in_hub} onChange={e => setForm({ ...form, is_published_in_hub: e.target.checked })} />
        Опубликовать в каталоге
      </label>
      {err && <p className="text-red-500 text-sm mb-2">{err}</p>}
      <button onClick={save} className="px-5 py-2.5 rounded-xl text-white font-medium" style={{ background: DARK }}>
        {saved ? '✓ Сохранено' : 'Сохранить'}
      </button>
    </div>
  )
}

function RequestsTab() {
  const [dir, setDir] = useState<'incoming' | 'outgoing'>('incoming')
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const load = async () => {
    setLoading(true)
    try { const r: any = await api.collabHub.requests(dir); setRows(r.requests || []) } catch { setRows([]) }
    setLoading(false)
  }
  useEffect(() => { load() }, [dir])
  const respond = async (id: number, accept: boolean) => {
    await api.collabHub.respondRequest(id, accept); load()
  }
  const statusChip = (s: string) => {
    const map: any = { pending: ['Ждёт ответа', 'bg-gray-200 text-gray-600'], accepted: ['Принято', 'bg-green-100 text-green-700'], declined: ['Отклонено', 'bg-red-100 text-red-600'] }
    const [t, cls] = map[s] || [s, 'bg-gray-100']
    return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{t}</span>
  }
  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setDir('incoming')} className={`px-4 py-2 rounded-xl text-sm ${dir === 'incoming' ? 'text-white' : 'border'}`} style={dir === 'incoming' ? { background: DARK } : {}}>Входящие</button>
        <button onClick={() => setDir('outgoing')} className={`px-4 py-2 rounded-xl text-sm ${dir === 'outgoing' ? 'text-white' : 'border'}`} style={dir === 'outgoing' ? { background: DARK } : {}}>Отправленные</button>
      </div>
      {loading ? <div className="text-gray-400 py-10 text-center">Загрузка…</div>
        : rows.length === 0 ? <div className="text-gray-400 py-10 text-center">{dir === 'incoming' ? 'Входящих запросов нет.' : 'Вы пока никому не предлагали коллаборацию.'}</div>
        : <div className="space-y-2">
            {rows.map(r => (
              <div key={r.id} className="border rounded-2xl p-4 flex items-center justify-between gap-3 bg-white">
                <div className="min-w-0">
                  <div className="font-medium" style={{ color: DARK }}>{r.other_name}</div>
                  {r.event_title && <div className="text-xs text-gray-500">Событие: {r.event_title}</div>}
                  {r.message && <div className="text-sm text-gray-600 mt-1">{r.message}</div>}
                  <div className="mt-1">{statusChip(r.status)}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {r.other_tg && <a href={`https://t.me/${r.other_tg.replace('@', '')}`} target="_blank" rel="noreferrer" className="text-sm px-3 py-1.5 rounded-xl border inline-flex items-center gap-1"><Send className="w-3.5 h-3.5" />Telegram</a>}
                  {dir === 'incoming' && r.status === 'pending' && <>
                    <button onClick={() => respond(r.id, true)} className="text-sm px-3 py-1.5 rounded-xl text-white" style={{ background: '#16a34a' }}><Check className="w-4 h-4" /></button>
                    <button onClick={() => respond(r.id, false)} className="text-sm px-3 py-1.5 rounded-xl border text-red-500"><X className="w-4 h-4" /></button>
                  </>}
                </div>
              </div>
            ))}
          </div>}
    </div>
  )
}

function MatchmakerTab() {
  const [data, setData] = useState<any>(null)
  const [reqTarget, setReqTarget] = useState<any | null>(null)
  useEffect(() => { api.collabHub.matchmaker().then(setData).catch(() => setData({ suggestions: [] })) }, [])
  if (!data) return <div className="text-gray-400 py-10 text-center">Подбираем партнёров…</div>
  return (
    <div>
      <div className="rounded-2xl p-4 mb-5 text-white" style={{ background: `linear-gradient(45deg, ${DARK}, #0a1520)` }}>
        <div className="flex items-center gap-2 mb-1"><Sparkles className="w-5 h-5" style={{ color: PEACH }} /><b>Умный сват</b></div>
        <p className="text-sm opacity-90">Подбираем по вашей нише и сопоставимой аудитории. {data.my_niche ? '' : 'Заполните нишу в «Моя карточка» для точного подбора.'}</p>
      </div>
      {data.suggestions?.length === 0 ? <div className="text-gray-400 py-10 text-center">Пока некого предложить — каталог наполняется.</div>
        : <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.suggestions.map((it: any) => <CollabCard key={it.collaborator_id} item={it} onRequest={() => setReqTarget(it)} />)}
          </div>}
      {reqTarget && <RequestModal target={reqTarget} onClose={() => setReqTarget(null)} />}
    </div>
  )
}
