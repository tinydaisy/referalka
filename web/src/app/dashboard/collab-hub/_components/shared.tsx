'use client'
import { useState, useEffect } from 'react'
import { Search, Star, Send, MapPin, Check, X, Sparkles, Users, Calendar, Pencil, ChevronDown, ChevronUp, ExternalLink, Trash2 } from 'lucide-react'
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

/** Био/регалии основателя = СПИСОК СТРОК. В профиле каждая регалия введена с новой
 *  строки (часто с ведущим «•»). Режем строго по переносам строк, ведущий маркер
 *  срезаем — «•» ВНУТРИ строки («7 конференций • 50+ лидеров») остаётся текстом.
 *  Раньше резали по «•» и игнорировали \n → всё слипалось в кучу. */
export function bioLines(bio: string): string[] {
  return (bio || '')
    .split(/\r?\n/)
    .map(s => s.replace(/^\s*[•·‣\-–—*]\s*/, '').trim())
    .filter(Boolean)
}

/** Био списком: свёрнуто — первые 2 строки, развёрнуто — все. */
export function BioBlock({ bio, open, className = '' }: { bio: string; open: boolean; className?: string }) {
  const lines = bioLines(bio)
  if (lines.length === 0) return null
  const shown = open ? lines : lines.slice(0, 2)
  return (
    <ul className={`text-sm text-gray-500 space-y-1 list-none ${className}`}>
      {shown.map((line, i) => (
        <li key={i} className="flex gap-1.5">
          <span style={{ color: PEACH }} className="shrink-0">•</span>
          <span className={open ? '' : 'line-clamp-2'}>{line}</span>
        </li>
      ))}
    </ul>
  )
}

export function CollabCard({ item, onRequest }: { item: any; onRequest?: () => void }) {
  const isMe = item.is_me
  const hadCollabs = (item.collabs_count || 0) > 0
  const contribution = hadCollabs && item.avg_contribution != null ? `${item.avg_contribution}%` : '—'
  const achievements: any[] = Array.isArray(item.achievements) ? item.achievements : []
  const [bioOpen, setBioOpen] = useState(false)
  const [lightbox, setLightbox] = useState(false)
  const bio = item.bio || ''
  // «Подробнее» — когда регалий больше, чем показываем свёрнутыми (2 строки).
  const bioLong = bioLines(bio).length > 2
  return (
    <div className={`rounded-2xl p-4 transition flex flex-col ${isMe ? 'border-2' : 'border bg-white hover:shadow-md'}`}
         style={isMe ? { borderColor: PEACH, background: '#FFF8F1' } : {}}>
      {isMe && <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="text-[11px] font-semibold inline-flex items-center gap-1" style={{ color: '#C77B3B' }}><Star className="w-3 h-3" fill={PEACH} stroke={PEACH} />ВАША КАРТОЧКА</span>
        {item.is_published_in_hub === false && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-600">не опубликована</span>}
      </div>}
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
      {/* Био/регалии — КАЖДАЯ С НОВОЙ СТРОКИ (режем по \n, не по «•»). */}
      {bio && (
        <div className="mt-2">
          <BioBlock bio={bio} open={bioOpen} />
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
  // В списке — только мои СУЩЕСТВУЮЩИЕ коллабы (is_collab), куда можно добавить ещё партнёра.
  // Обычные/прошедшие события сюда не идут — для новой коллабы выбирают «Без события».
  useEffect(() => {
    api.collabHub.collabs()
      .then((r: any) => setEvents((r.collabs || []).map((c: any) => ({ id: c.event_id, title: c.title }))))
      .catch(() => setEvents([]))
  }, [])
  const send = async () => {
    setErr('')
    try { await api.collabHub.createRequest({ to_client_id: target.client_id, event_id: eventId ? Number(eventId) : null, message: msg || null }); setSent(true) }
    catch (e: any) { setErr(e?.message || 'Ошибка') }
  }
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
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
            <label className="block text-sm text-gray-500 mb-1">Присоединить к коллабе</label>
            <select value={eventId} onChange={e => setEventId(e.target.value)} className="w-full border rounded-xl px-3 py-2 text-sm mb-3">
              <option value="">Новая коллаба (создастся при принятии)</option>
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
  const [dir, setDir] = useState<'incoming' | 'outgoing'>('incoming')
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const load = async () => {
    setLoading(true)
    try { const r: any = await api.collabHub.requests(dir); setRows(r.requests || []) } catch { setRows([]) }
    setLoading(false)
  }
  useEffect(() => { load() }, [dir])
  const [busy, setBusy] = useState<number | null>(null)   // только для accept (долгое создание коллабы)
  const [declineId, setDeclineId] = useState<number | null>(null)  // открыта модалка причины отклонения
  const accept = async (id: number) => {
    setBusy(id)
    try { await api.collabHub.respondRequest(id, true); await load() }
    catch (e: any) { alert(e?.message || 'Не удалось') }
    finally { setBusy(null) }
  }
  const doDecline = async (id: number, reason: string) => {
    setDeclineId(null)
    try { await api.collabHub.respondRequest(id, false, reason); await load() }
    catch (e: any) { alert(e?.message || 'Не удалось') }
  }
  const del = async (id: number) => { if (!confirm('Удалить этот запрос?')) return; try { await api.collabHub.deleteRequest(id); load() } catch (e: any) { alert(e?.message || 'Не удалось') } }
  const reconsider = async (id: number) => { if (!confirm('Передумать? Вы выйдете из коллабы, запрос вернётся в «ждёт ответа».')) return; try { await api.collabHub.reconsiderRequest(id); load() } catch (e: any) { alert(e?.message || 'Не удалось') } }
  const chip = (s: string) => { const m: any = { pending: ['Ждёт ответа', 'bg-gray-200 text-gray-600'], accepted: ['Принято', 'bg-green-100 text-green-700'], declined: ['Отклонено', 'bg-red-100 text-red-600'] }; const [t, c] = m[s] || [s, 'bg-gray-100']; return <span className={`text-xs px-2 py-0.5 rounded-full ${c}`}>{t}</span> }
  const fmtDate = (s?: string) => { if (!s) return ''; try { return new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

  const Avatar = ({ r }: { r: any }) => r.other_photo
    ? <img src={r.other_photo} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0" />
    : <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 shrink-0"><Users className="w-5 h-5" /></div>

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setDir('incoming')} className={`px-4 py-2 rounded-xl text-sm ${dir === 'incoming' ? 'text-white' : 'border'}`} style={dir === 'incoming' ? { background: DARK } : {}}>Входящие</button>
        <button onClick={() => setDir('outgoing')} className={`px-4 py-2 rounded-xl text-sm ${dir === 'outgoing' ? 'text-white' : 'border'}`} style={dir === 'outgoing' ? { background: DARK } : {}}>Отправленные</button>
      </div>
      {loading ? <div className="text-gray-400 py-10 text-center">Загрузка…</div>
        : rows.length === 0 ? <div className="text-gray-400 py-10 text-center">{dir === 'incoming' ? 'Входящих запросов нет.' : 'Вы пока никому не предлагали коллаборацию.'}</div>
        : <div className="space-y-2">{rows.map(r => (
          <div key={r.id} className="border rounded-2xl p-4 flex items-start gap-3 bg-white">
            <Avatar r={r} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium" style={{ color: DARK }}>{r.other_name}</span>
                <span className="text-xs text-gray-400">{fmtDate(r.created_at)}</span>
              </div>
              {r.event_title && <div className="text-xs text-gray-500">Коллаба: {r.event_title}</div>}
              {r.message && <div className="text-sm text-gray-600 mt-1">{r.message}</div>}
              {/* Причина отклонения — видна обеим сторонам */}
              {r.status === 'declined' && (
                <div className="text-xs text-red-500 mt-1">
                  Причина отказа: {r.decline_reason || 'Причина не указана'}
                  {r.responded_at && <span className="text-gray-400"> · {fmtDate(r.responded_at)}</span>}
                </div>
              )}
              <div className="mt-1 flex items-center gap-2 flex-wrap">
                {chip(r.status)}
                {r.status === 'accepted' && r.event_id && <a href={`/dashboard/events/${r.event_id}`} className="text-xs px-2.5 py-1 rounded-lg border inline-flex items-center gap-1" style={{ color: '#C77B3B', borderColor: PEACH }}>Перейти в коллабу →</a>}
                <a href={`/dashboard/collab-hub/org/${r.other_client_id}`} className="text-xs px-2.5 py-1 rounded-lg border inline-flex items-center gap-1 hover:bg-gray-50"><ExternalLink className="w-3 h-3" />Профиль</a>
                {r.other_tg && <a href={`https://t.me/${(r.other_tg||'').replace('@','')}?text=Здравствуйте! По коллаборации в ПЛЮСОН`} target="_blank" rel="noreferrer" className="text-xs px-2.5 py-1 rounded-lg border inline-flex items-center gap-1 text-blue-600"><Send className="w-3 h-3" />Написать в Telegram</a>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {dir === 'incoming' && r.status === 'pending' && (busy === r.id
                ? <span className="text-xs text-gray-500 px-2">Создаём коллабу…</span>
                : <>
                  <button onClick={() => accept(r.id)} className="text-sm px-3 py-1.5 rounded-xl text-white" style={{ background: '#16a34a' }}><Check className="w-4 h-4" /></button>
                  <button onClick={() => setDeclineId(r.id)} className="text-sm px-3 py-1.5 rounded-xl border text-red-500"><X className="w-4 h-4" /></button>
                </>)}
              {dir === 'incoming' && r.status === 'declined' && <button onClick={() => accept(r.id)} className="text-xs px-3 py-1.5 rounded-xl border" style={{ color: '#16a34a', borderColor: '#16a34a' }}>Передумать — принять</button>}
              {dir === 'incoming' && r.status === 'accepted' && <button onClick={() => reconsider(r.id)} className="text-xs px-3 py-1.5 rounded-xl border text-gray-500" title="Выйти и вернуть в «ждёт ответа»">Передумать</button>}
              {dir === 'outgoing' && r.status !== 'accepted' && <button onClick={() => del(r.id)} className="text-sm px-3 py-1.5 rounded-xl border text-red-500" title="Удалить запрос"><Trash2 className="w-4 h-4" /></button>}
            </div>
          </div>
        ))}</div>}
      {declineId !== null && <DeclineModal onClose={() => setDeclineId(null)} onSubmit={(reason) => doDecline(declineId, reason)} />}
    </div>
  )
}

function DeclineModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-bold text-lg" style={{ color: DARK }}>Отклонить запрос</h3>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <label className="block text-sm text-gray-500 mb-1">Причина отказа (необязательно)</label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Например: не совпадает ниша / нет времени" className="w-full border rounded-xl px-3 py-2 text-sm mb-4" rows={3} />
        <div className="flex gap-2">
          <button onClick={() => onSubmit(reason)} className="flex-1 py-2.5 rounded-xl text-white font-medium" style={{ background: '#ef4444' }}>Отклонить</button>
          <button onClick={onClose} className="px-5 py-2.5 rounded-xl border">Отмена</button>
        </div>
      </div>
    </div>
  )
}


// Запросы соорганизаторов на рассылку по МОЕЙ базе (коллаб-события).
export function BroadcastConfirmationsView() {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const load = () => {
    api.collabHub.broadcastConfirmations()
      .then((r: any) => { setRows(r.confirmations || []); setLoading(false) })
      .catch(() => { setRows([]); setLoading(false) })
  }
  useEffect(() => { load() }, [])
  const respond = async (batchId: string, accept: boolean) => {
    try { await api.collabHub.respondBroadcastConfirmation(batchId, accept); load() }
    catch (e: any) { alert(e?.message || 'Не удалось') }
  }
  if (loading || rows.length === 0) return null
  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold mb-1" style={{ color: DARK }}>Рассылки на подтверждение</h2>
      <p className="text-sm text-gray-500 mb-3">Соорганизаторы просят разослать это по вашей базе. Подтвердите — уйдёт через вашего бота.</p>
      <div className="space-y-3">
        {rows.map(c => (
          <div key={c.confirm_batch_id} className="rounded-xl border-2 p-4 bg-white" style={{ borderColor: PEACH }}>
            <p className="text-sm text-gray-800">
              <b>{c.origin_name || 'Организатор'}</b> — {c.msg_count > 1 ? `пакет из ${c.msg_count} сообщений` : 'сообщение'} по событию «{c.event_title}».
            </p>
            {c.sample_text && <p className="text-xs text-gray-500 mt-1 whitespace-pre-wrap line-clamp-3">{c.sample_text}</p>}
            <div className="flex gap-2 mt-3">
              <button onClick={() => respond(c.confirm_batch_id, true)}
                className="px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ background: DARK }}>
                Подтвердить {c.msg_count > 1 ? 'пакет' : ''}
              </button>
              <button onClick={() => respond(c.confirm_batch_id, false)}
                className="px-4 py-2 rounded-lg border text-sm text-gray-500">Отклонить</button>
            </div>
          </div>
        ))}
      </div>
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
          {/* Регалии — каждая с новой строки (как введены в профиле Основателя). */}
          {card.bio && <BioBlock bio={card.bio} open className="mt-4" />}
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
// Коллабы — совместные события, где я владелец. С ФИО организаторов + выход из коллабы.
export function CollabsView() {
  const [collabs, setCollabs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const load = () => { api.collabHub.collabs().then((r: any) => { setCollabs(r.collabs || []); setLoading(false) }).catch(() => { setCollabs([]); setLoading(false) }) }
  useEffect(() => { load() }, [])
  const leave = async (eventId: number) => {
    if (!confirm('Выйти из этой коллабы? Вы перестанете быть её организатором.')) return
    try { await api.collabHub.leaveCollab(eventId); load() } catch (e: any) { alert(e?.message || 'Не удалось выйти') }
  }
  if (loading) return <div className="text-gray-400 py-10 text-center">Загрузка…</div>
  if (collabs.length === 0) return (
    <div className="text-gray-400 py-10 text-center">
      Коллаб пока нет.<br />
      <span className="text-sm">Коллаба появится, когда вы примете запрос на коллаборацию или ваш будет принят.</span>
    </div>
  )
  return (
    <div className="space-y-2">
      {collabs.map(c => {
        const orgs: any[] = c.organizers || []
        return (
          <div key={c.event_id} className="border rounded-2xl p-4 bg-white">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-gray-400" />
              <a href={`/dashboard/events/${c.event_id}`} className="font-medium hover:underline" style={{ color: DARK }}>{c.title}</a>
              <span className="text-xs px-2 py-0.5 rounded-full ml-auto" style={{ background: PEACH, color: DARK }}>Коллаба</span>
            </div>
            {/* ФИО организаторов */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {orgs.map((o: any) => (
                <a key={o.client_id} href={`/dashboard/collab-hub/org/${o.client_id}`} className="text-xs px-2 py-1 rounded-lg bg-gray-50 hover:bg-gray-100" style={{ color: DARK }}>
                  {o.name}{o.role === 'owner' ? ' (создатель)' : ''}
                </a>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <a href={`/dashboard/events/${c.event_id}`} className="text-sm px-3 py-1.5 rounded-xl text-white" style={{ background: DARK }}>Открыть событие</a>
              <button onClick={() => leave(c.event_id)} className="text-sm px-3 py-1.5 rounded-xl border text-red-500">Выйти из коллабы</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
