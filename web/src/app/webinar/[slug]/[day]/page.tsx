'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useSearchParams } from 'next/navigation'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const WS_URL = API_URL.replace(/^http/, 'ws')

// стабильный ключ анонимной сессии зрителя (для presence/реакций без contact_id)
function getSessionKey(): string {
  if (typeof window === 'undefined') return ''
  let k = localStorage.getItem('webinar_session_key')
  if (!k) { k = 'sk_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('webinar_session_key', k) }
  return k
}

export default function WebinarRoomPage() {
  const params = useParams()
  const search = useSearchParams()
  const slug = String(params.slug)
  const day = Number(params.day)
  const contactId = search.get('c') ? Number(search.get('c')) : null
  const sessionKey = getSessionKey()

  const [room, setRoom] = useState<any>(null)
  const [error, setError] = useState('')
  const [chat, setChat] = useState<any[]>([])
  const [chatText, setChatText] = useState('')
  const [online, setOnline] = useState<number | null>(null)
  const [reactions, setReactions] = useState<Record<string, { up: number; down: number }>>({})
  const [poll, setPoll] = useState<any>(null)
  const [battle, setBattle] = useState<any>(null)
  const [needReg, setNeedReg] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const chatBoxRef = useRef<HTMLDivElement | null>(null)

  const api = useCallback((path: string, body?: any) =>
    fetch(`${API_URL}/api/v1/public/webinar/${slug}/${day}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(r => r.json()), [slug, day])

  // загрузка комнаты
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/public/webinar/${slug}/${day}`)
      if (!res.ok) { setError('Комната не найдена'); return }
      const d = await res.json()
      setRoom(d)
      if (typeof d.online === 'number') setOnline(d.online)
      // реакции спикерам
      const rx: Record<string, { up: number; down: number }> = {}
      for (const r of d.speaker_reactions || []) {
        rx[r.speaker_id] = rx[r.speaker_id] || { up: 0, down: 0 }
        rx[r.speaker_id][r.reaction_key === 'up' ? 'up' : 'down'] = r.count
      }
      setReactions(rx)
      setPoll(d.poll || null)
      setBattle(d.battle || null)
    } catch { setError('Ошибка загрузки') }
  }, [slug, day])

  useEffect(() => { load() }, [load])

  // история чата
  useEffect(() => {
    api('/chat').then(r => setChat(r.messages || [])).catch(() => {})
  }, [api])

  // HLS-плеер
  useEffect(() => {
    if (!room?.room) return
    const rm = room.room
    if (rm.stream_type !== 'encoder' || !rm.hls_url) return
    const video = videoRef.current
    if (!video) return
    let hls: any
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = rm.hls_url  // Safari/iOS нативно
    } else {
      import('hls.js').then(({ default: Hls }) => {
        if (Hls.isSupported()) {
          hls = new Hls({ lowLatencyMode: true })
          hls.loadSource(rm.hls_url)
          hls.attachMedia(video)
        }
      })
    }
    return () => { if (hls) hls.destroy() }
  }, [room?.room?.hls_url, room?.room?.stream_type])

  // WebSocket realtime
  useEffect(() => {
    if (!room?.room) return
    const ws = new WebSocket(`${WS_URL}/ws/webinar/${slug}/${day}`)
    wsRef.current = ws
    ws.onmessage = (ev) => {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { return }
      switch (msg.type) {
        case 'chat':
          setChat(c => [...c, msg]); break
        case 'chat_moderate':
          if (msg.status === 'hidden') setChat(c => c.filter(m => m.id !== msg.msg_id)); break
        case 'reaction':
          setReactions(r => ({ ...r, [msg.speaker_id]: { up: msg.reaction === 'up' ? msg.count : (r[msg.speaker_id]?.up || 0), down: msg.reaction === 'down' ? msg.count : (r[msg.speaker_id]?.down || 0) } })); break
        case 'poll_open': setPoll(msg.poll); break
        case 'poll_update': setPoll((p: any) => p ? { ...p, options: msg.options } : p); break
        case 'poll_close': setPoll(null); break
        case 'battle_start': setBattle(msg.battle); break
        case 'battle_vote': setBattle((b: any) => b ? { ...b, players: b.players.map((pl: any) => pl.id === msg.player_id ? { ...pl, up_count: msg.up, down_count: msg.down } : pl) } : b); break
        case 'battle_end': setBattle(null); break
        // живой счётчик онлайн (обновляется на каждый heartbeat зрителей)
        case 'online': setOnline(msg.count); break
        // менеджер показал/убрал продающий блок вживую — перечитываем список
        case 'block_pin': load(); break
        // 'ready'/'offline' — спикер настраивается в Zoom, зрителю показывать нечего.
        // Плеер появляется только когда ведущий нажал «Начать эфир» → stream_live.
        case 'stream_live': load(); break
        case 'stream_ended':
          if (msg.redirect_url) window.location.href = msg.redirect_url
          else load()
          break
        case 'participant_removed':
          if ((contactId && msg.contact_id === contactId) || (msg.session_key && msg.session_key === sessionKey)) {
            setError('Вы удалены из эфира')
          }
          break
      }
    }
    // keepalive пинг
    const ping = setInterval(() => { try { ws.send('ping') } catch {} }, 25000)
    return () => { clearInterval(ping); ws.close() }
  }, [room?.room?.id, slug, day]) // eslint-disable-line react-hooks/exhaustive-deps

  // heartbeat присутствия раз в минуту (только когда вкладка активна)
  useEffect(() => {
    if (!room?.room) return
    const beat = () => {
      if (document.hidden) return
      const device = /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop'
      api('/heartbeat', { contact_id: contactId, session_key: sessionKey, device })
    }
    beat()
    const t = setInterval(beat, 60000)
    return () => clearInterval(t)
  }, [room?.room?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // автоскролл чата
  useEffect(() => { chatBoxRef.current?.scrollTo(0, chatBoxRef.current.scrollHeight) }, [chat])

  if (error) return <Centered>{error}</Centered>
  if (!room) return <Centered>Загрузка…</Centered>

  const rm = room.room
  const ended = rm.status === 'ended'
  const live = rm.status === 'live'

  // Профи: внешняя ссылка
  if (rm.stream_type === 'external_link') {
    return (
      <Centered>
        <div className="text-center">
          <p className="mb-4 text-lg">{room.event?.title}</p>
          {rm.external_url
            ? <a href={rm.external_url} target="_blank" rel="noreferrer" className="inline-block px-6 py-3 rounded-xl font-semibold" style={{ background: '#FFCFA4', color: '#0a1520' }}>Смотреть трансляцию</a>
            : <p className="text-white/60">Ссылка на трансляцию скоро появится</p>}
        </div>
      </Centered>
    )
  }

  async function sendChat() {
    const text = chatText.trim()
    if (!text) return
    setChatText('')
    await api('/chat', { contact_id: contactId, session_key: sessionKey, text })
  }
  async function react(speakerId: number, r: 'up' | 'down') {
    await api('/react', { contact_id: contactId, session_key: sessionKey, speaker_id: speakerId, reaction: r })
  }
  async function votePoll(optId: number) {
    await api(`/poll/${poll.id}/vote`, { contact_id: contactId, session_key: sessionKey, option_id: optId })
  }
  async function voteBattle(playerId: number, r: 'up' | 'down') {
    await api(`/battle/${battle.id}/vote`, { contact_id: contactId, session_key: sessionKey, player_id: playerId, reaction: r })
  }
  async function clickBlock(b: any) {
    await api('/track', { contact_id: contactId, session_key: sessionKey, block_id: b.id, kind: 'click' })
    if (b.url) window.open(b.url, '_blank')
  }

  const cur = room.current_speaker
  const curRx = cur ? (reactions[cur.ec_id] || { up: 0, down: 0 }) : null

  return (
    <div className="min-h-screen text-white" style={{ background: 'linear-gradient(160deg, #0a1520, #142430)' }}>
      {/* Шапка: логотип бренда + название + название вебинара */}
      <header className="border-b border-white/10">
        <div className="max-w-6xl mx-auto px-3 md:px-5 py-3 flex items-center gap-3">
          {room.brand?.logo_url
            ? <img src={room.brand.logo_url} alt="" className="h-8 w-auto object-contain" />
            : null}
          <span className="font-bold tracking-tight" style={{ color: '#FFCFA4' }}>
            {room.brand?.name || 'iViSiON: ПЛЮСОН'}
          </span>
          <span className="text-white/40 hidden sm:inline">·</span>
          <span className="text-white/70 text-sm truncate hidden sm:inline">
            {rm.title || room.event?.title}
          </span>
        </div>
      </header>

      <div className="max-w-6xl mx-auto p-3 md:p-5 grid md:grid-cols-[1fr,340px] gap-4">
        {/* видео + блоки */}
        <div>
          <div className="rounded-xl overflow-hidden bg-black aspect-video relative">
            {/* До эфира — афиша дня (или горизонтальная афиша события) как заставка */}
            {!live && room.poster_url && (
              <img src={room.poster_url} alt="" className="absolute inset-0 w-full h-full object-cover" />
            )}
            {ended ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white/80">Трансляция завершена</div>
            ) : !live ? (
              <div className="absolute inset-0 flex items-end justify-center pb-6 px-6 bg-gradient-to-t from-black/80 via-black/20 to-transparent">
                <span className="text-white/90 text-center font-medium drop-shadow">
                  {rm.intro_text || 'Трансляция скоро начнётся'}
                </span>
              </div>
            ) : null}
            {/* плеер только в эфире: до «Начать эфир» hls_url с бэка не приходит */}
            {live && <video ref={videoRef} controls autoPlay playsInline className="w-full h-full" />}
            {live && <span className="absolute top-3 left-3 bg-red-600 text-xs px-2 py-0.5 rounded font-bold">● LIVE</span>}
          </div>

          {/* Сейчас выступает + подписка */}
          {cur && (
            <div className="mt-3 rounded-xl bg-white/5 p-3 flex items-center gap-3">
              {cur.photo_url && <img src={cur.photo_url} alt="" className="w-10 h-10 rounded-full object-cover" />}
              <div className="flex-1 min-w-0">
                <div className="text-xs text-white/50">Сейчас выступает</div>
                <div className="font-semibold truncate">{cur.name}</div>
              </div>
              {cur.channels?.telegram && (
                <a href={cur.channels.telegram} target="_blank" rel="noreferrer" className="text-xs px-3 py-1.5 rounded-lg font-semibold" style={{ background: '#FFCFA4', color: '#0a1520' }}>Подписаться</a>
              )}
            </div>
          )}

          {/* Подарок спикера */}
          {room.current_gift && (
            <div className="mt-2 rounded-xl bg-amber-500/15 border border-amber-400/30 p-3 text-sm">
              🎁 <b>Подарок от спикера</b>
              {room.current_gift.url && <a href={room.current_gift.url} target="_blank" rel="noreferrer" className="ml-2 underline">получить</a>}
            </div>
          )}

          {/* Реакции на текущего спикера */}
          {cur && (
            <div className="mt-2 flex gap-2">
              <button onClick={() => react(cur.ec_id, 'up')} className="flex-1 rounded-xl bg-white/10 hover:bg-white/20 py-2.5 text-sm font-semibold">
                🔥 {rm.reaction_up_label} · {curRx?.up || 0}
              </button>
              {rm.show_down_reaction && (
                <button onClick={() => react(cur.ec_id, 'down')} className="flex-1 rounded-xl bg-white/10 hover:bg-white/20 py-2.5 text-sm font-semibold">
                  👎 {rm.reaction_down_label} · {curRx?.down || 0}
                </button>
              )}
            </div>
          )}

          {/* Опрос */}
          {poll && (
            <div className="mt-3 rounded-xl bg-white/5 p-4">
              <div className="font-semibold mb-2">📊 {poll.question}</div>
              <div className="space-y-2">
                {poll.options.map((o: any) => {
                  const total = poll.options.reduce((s: number, x: any) => s + x.votes, 0) || 1
                  const pct = Math.round((o.votes / total) * 100)
                  return (
                    <button key={o.id} onClick={() => votePoll(o.id)} className="w-full text-left rounded-lg bg-white/10 hover:bg-white/20 p-2 relative overflow-hidden">
                      <div className="absolute inset-y-0 left-0 bg-white/10" style={{ width: `${pct}%` }} />
                      <span className="relative flex justify-between text-sm"><span>{o.text}</span><span>{pct}%</span></span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Батл */}
          {battle && (
            <div className="mt-3 rounded-xl bg-white/5 p-4">
              <div className="font-semibold mb-3">⚔️ {battle.title || 'Батл'}</div>
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(battle.players.length, 2)}, 1fr)` }}>
                {battle.players.map((pl: any) => (
                  <div key={pl.id} className="rounded-lg bg-white/10 p-3 text-center">
                    <div className="font-semibold text-sm mb-2 truncate">{pl.name || `#${pl.speaker_id}`}</div>
                    <div className="flex gap-1 justify-center">
                      <button onClick={() => voteBattle(pl.id, 'up')} className="px-2 py-1 rounded bg-white/10 text-xs">🔥 {pl.up_count}</button>
                      {battle.show_down_reaction && <button onClick={() => voteBattle(pl.id, 'down')} className="px-2 py-1 rounded bg-white/10 text-xs">👎 {pl.down_count}</button>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Кнопки-офферы: сетка N в ряд, без заголовка над блоком — текст на самой кнопке */}
          {(() => {
            const btns = (room.blocks || []).filter((b: any) => b.kind === 'button')
            if (!btns.length) return null
            const per = Math.max(1, Math.min(4, room.room?.buttons_per_row || 1))
            return (
              <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${per}, minmax(0, 1fr))` }}>
                {btns.map((b: any) => (
                  <button key={b.id} onClick={() => clickBlock(b)}
                    className="py-3 px-3 rounded-xl text-sm font-semibold text-center"
                    style={{ background: '#FFCFA4', color: '#0a1520' }}>
                    {b.title || 'Подробнее'}
                  </button>
                ))}
              </div>
            )
          })()}

          {/* Формы заявок: столбиком, с заголовком */}
          <div className="mt-3 space-y-2">
            {(room.blocks || []).filter((b: any) => b.kind === 'form').map((b: any) => (
              <div key={b.id} className="rounded-xl bg-white/10 p-3">
                {b.title && <div className="font-semibold text-sm mb-1">{b.title}</div>}
                {b.body && <div className="text-xs text-white/60 mb-2">{b.body}</div>}
                <FormBlock block={b} slug={slug} day={day} contactId={contactId} sessionKey={sessionKey} onNeedReg={() => setNeedReg(true)} />
              </div>
            ))}
          </div>
        </div>

        {/* чат */}
        <div className="rounded-xl bg-white/5 flex flex-col h-[70vh] md:h-auto">
          <div className="p-3 border-b border-white/10 font-semibold text-sm">Чат</div>
          <div ref={chatBoxRef} className="flex-1 overflow-y-auto p-3 space-y-2 text-sm">
            {chat.map((m, i) => (
              <div key={m.id || i}>
                <span className="text-white/50 mr-1">{m.author_name || 'Гость'}:</span>
                <span>{m.text}</span>
              </div>
            ))}
            {!chat.length && <div className="text-white/40 text-center py-8">Сообщений пока нет</div>}
          </div>
          {rm.chat_enabled ? (
            <div className="p-3 border-t border-white/10 flex gap-2">
              <input
                value={chatText} onChange={e => setChatText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendChat()}
                placeholder="Написать…"
                className="flex-1 bg-white/10 rounded-lg px-3 py-2 text-sm outline-none"
              />
              <button onClick={sendChat} className="px-3 rounded-lg text-sm font-semibold" style={{ background: '#FFCFA4', color: '#0a1520' }}>▶</button>
            </div>
          ) : (
            <div className="p-3 border-t border-white/10 text-xs text-white/40 text-center">Чат отключён</div>
          )}
          {/* счётчик зрителей — внизу чата, а не на видео */}
          {online != null && (
            <div className="px-3 py-2 border-t border-white/10 text-xs text-white/50 flex items-center gap-1.5">
              <span>👁</span> Сейчас смотрят: <b className="text-white/80">{online}</b>
            </div>
          )}
        </div>
      </div>

      {needReg && <RegModal slug={slug} day={day} onClose={() => setNeedReg(false)} />}
    </div>
  )
}

function FormBlock({ block, slug, day, contactId, sessionKey, onNeedReg }: any) {
  const [sent, setSent] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', phone: '', telegram_username: '' })
  const [open, setOpen] = useState(false)

  async function submit(withContact: boolean) {
    const body: any = { contact_id: contactId, session_key: sessionKey }
    if (!withContact) Object.assign(body, form)
    const r = await fetch(`${API_URL}/api/v1/public/webinar/${slug}/${day}/form/${block.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (r.ok) setSent(true)
  }

  if (sent) return <div className="text-sm text-green-300">✓ Заявка принята</div>

  // известный контакт → одна кнопка
  if (contactId && !open) {
    return <button onClick={() => submit(true)} className="w-full py-2 rounded-lg text-sm font-semibold" style={{ background: '#FFCFA4', color: '#0a1520' }}>
      {block.title || 'Оставить заявку'}
    </button>
  }

  // неизвестный → поля
  return (
    <div className="space-y-2">
      <input placeholder="Имя" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full bg-white/10 rounded-lg px-3 py-2 text-sm outline-none" />
      <input placeholder="Телефон" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="w-full bg-white/10 rounded-lg px-3 py-2 text-sm outline-none" />
      <input placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="w-full bg-white/10 rounded-lg px-3 py-2 text-sm outline-none" />
      <button onClick={() => submit(false)} className="w-full py-2 rounded-lg text-sm font-semibold" style={{ background: '#FFCFA4', color: '#0a1520' }}>Отправить</button>
    </div>
  )
}

function RegModal({ slug, day, onClose }: any) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', telegram_username: '' })
  const [done, setDone] = useState(false)
  async function submit() {
    const r = await fetch(`${API_URL}/api/v1/public/webinar/${slug}/${day}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
    })
    if (r.ok) setDone(true)
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" />
      <div className="relative bg-[#142430] text-white rounded-2xl p-6 w-full max-w-sm">
        <div className="flex justify-between mb-4"><h3 className="font-bold">Регистрация</h3><button onClick={onClose}>✕</button></div>
        {done ? <p className="text-green-300">✓ Готово!</p> : (
          <div className="space-y-2">
            <input placeholder="Имя" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full bg-white/10 rounded-lg px-3 py-2 text-sm outline-none" />
            <input placeholder="Телефон" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className="w-full bg-white/10 rounded-lg px-3 py-2 text-sm outline-none" />
            <input placeholder="Email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="w-full bg-white/10 rounded-lg px-3 py-2 text-sm outline-none" />
            <button onClick={submit} className="w-full py-2 rounded-lg font-semibold" style={{ background: '#FFCFA4', color: '#0a1520' }}>Зарегистрироваться</button>
          </div>
        )}
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center text-white/80 p-6" style={{ background: 'linear-gradient(160deg, #0a1520, #142430)' }}>
      {children}
    </div>
  )
}
