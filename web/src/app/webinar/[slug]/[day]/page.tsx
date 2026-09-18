'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { focalCss } from '@/lib/photoFocal'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const WS_URL = API_URL.replace(/^http/, 'ws')

// стабильный ключ анонимной сессии зрителя (для presence/реакций без contact_id)
// Стойкий ключ анонимного зрителя: и localStorage, и cookie (год).
// Cookie переживает случаи, когда localStorage недоступен/не успел записаться,
// и общий для всех вкладок домена → новая вкладка = тот же зритель, не новый.
function getSessionKey(): string {
  if (typeof window === 'undefined') return ''
  const readCookie = () => (document.cookie.match(/(?:^|; )wsk=([^;]+)/)?.[1]) || ''
  let k = localStorage.getItem('webinar_session_key') || readCookie()
  if (!k) {
    k = 'sk_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
  try { localStorage.setItem('webinar_session_key', k) } catch {}
  document.cookie = `wsk=${k}; path=/; max-age=31536000; samesite=lax`
  return k
}

// cookie на год: авторизованный contact_id + запомненные данные формы,
// чтобы не вводить на каждом эфире (требование: «запоминай куки формы»).
function saveAuth(contactId: number, form: any) {
  try {
    localStorage.setItem('webinar_auth_contact', String(contactId))
    localStorage.setItem('webinar_auth_form', JSON.stringify(form || {}))
  } catch {}
  document.cookie = `wac=${contactId}; path=/; max-age=31536000; samesite=lax`
}
function readAuthContact(): number | null {
  if (typeof window === 'undefined') return null
  const c = document.cookie.match(/(?:^|; )wac=(\d+)/)?.[1] || localStorage.getItem('webinar_auth_contact')
  return c ? Number(c) : null
}
function readAuthForm(): any {
  if (typeof window === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem('webinar_auth_form') || '{}') } catch { return {} }
}

export default function WebinarRoomPage() {
  const params = useParams()
  const search = useSearchParams()
  const slug = String(params.slug)
  const day = Number(params.day)
  // contact_id: из URL (?c=), либо из Mini App (tg_id резолвится бэком), либо из cookie авторизации
  const urlContact = search.get('c') ? Number(search.get('c')) : null
  const pid = search.get('pid') || search.get('ref') || undefined
  const utm = search.get('utm_source') || undefined
  // SSR-безопасно: из useState-инициализатора cookie/localStorage НЕ читаем
  // (иначе hydration mismatch → страница застревает на «Загрузка»).
  const [authContact, setAuthContact] = useState<number | null>(urlContact)
  const [authName, setAuthName] = useState<string>('')  // имя из формы авторизации — подпись в чате
  const [justAuthed, setJustAuthed] = useState(false)   // только что прошёл форму → регистрация точно есть
  const [sessionKey, setSessionKey] = useState<string | null>(null)
  const contactId = authContact
  // ?new=1 — зайти «как новый»: чистим запомненный вход (cookie+localStorage),
  // показывается форма. Нужно для теста в том же браузере (вкладки/localStorage
  // шарятся) и как «Это не вы?» на чужом компе.
  const forceNew = search.get('new') === '1'
  useEffect(() => {
    if (forceNew) {
      try {
        localStorage.removeItem('webinar_auth_contact')
        localStorage.removeItem('webinar_auth_form')
      } catch {}
      document.cookie = 'wac=; path=/; max-age=0'
      setAuthContact(null); setAuthName(''); setSessionKey(getSessionKey())
      return
    }
    setAuthName((readAuthForm().name || '').trim())
    if (urlContact) { setSessionKey(getSessionKey()); return }
    setAuthContact(readAuthContact())
    setSessionKey(getSessionKey())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [room, setRoom] = useState<any>(null)
  const [error, setError] = useState('')
  const [chat, setChat] = useState<any[]>([])
  const [chatText, setChatText] = useState('')
  const [online, setOnline] = useState<number | null>(null)
  const [reactions, setReactions] = useState<Record<string, { up: number; down: number }>>({})
  const [poll, setPoll] = useState<any>(null)
  const [battle, setBattle] = useState<any>(null)
  const [needReg, setNeedReg] = useState(false)
  const [regEventRes, setRegEventRes] = useState<any>(null)  // результат кнопки «Регистрация на событие»
  const [playerStuck, setPlayerStuck] = useState(false)      // плеер завис/чёрный экран → показать кнопку «Обновить видео»
  const hlsInstRef = useRef<any>(null)                       // текущий hls.js — для ручного перезапуска кнопкой
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const chatBoxRef = useRef<HTMLDivElement | null>(null)
  const roomRef = useRef<any>(null)  // всегда актуальный room — для сравнения в polling (без stale-замыкания)

  const api = useCallback((path: string, body?: any) =>
    fetch(`${API_URL}/api/v1/public/webinar/${slug}/${day}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(r => r.json()), [slug, day])

  // Добавить сообщение в ленту с дедупом: если такое id уже есть (пришло и локально,
  // и по WS/поллингом) — не дублируем; локальное с тем же id обновляем.
  // ⚠️ Объявлено ДО эффектов чата — они держат его в зависимостях.
  const pushChatMsg = useCallback((msg: any) => {
    setChat(c => {
      if (msg.id != null && c.some(m => m.id === msg.id)) return c
      // схлопываем локальную копию (совпадение по тексту+автору), если её id ещё не проставлен
      const idx = c.findIndex(m => m._local && !m.id && m.text === msg.text && (m.contact_id ?? null) === (msg.contact_id ?? null))
      if (idx >= 0) { const n = [...c]; n[idx] = { ...msg }; return n }
      return [...c, msg]
    })
  }, [])

  // загрузка комнаты
  const load = useCallback(async () => {
    try {
      const _qs = new URLSearchParams()
      if (contactId) _qs.set('c', String(contactId))
      if (pid) _qs.set('pid', String(pid))   // рефовод зрителя — зафиксировать при входе по ссылке
      const res = await fetch(`${API_URL}/api/v1/public/webinar/${slug}/${day}${_qs.toString() ? `?${_qs}` : ''}`, { cache: 'no-store' })
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
  }, [slug, day, contactId, pid]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])
  useEffect(() => { roomRef.current = room }, [room])  // держим ref в актуальном состоянии

  // история чата
  useEffect(() => {
    api('/chat').then(r => setChat(r.messages || [])).catch(() => {})
  }, [api])

  // Фоллбэк-поллинг чата раз в 4 сек. Даже если WebSocket совсем не работает
  // (Cloudflare/сеть зрителя) — новые сообщения всё равно появятся. Дедуп по id
  // не даёт дублей с WS. Не льём, пока вкладка скрыта.
  useEffect(() => {
    if (!room?.room) return
    const t = setInterval(async () => {
      if (document.hidden) return
      try {
        const r = await api('/chat')
        for (const m of (r.messages || [])) pushChatMsg(m)
      } catch {}
    }, 4000)
    return () => clearInterval(t)
  }, [room?.room?.id, api, pushChatMsg])

  // HLS-плеер
  useEffect(() => {
    if (!room?.room) return
    const rm = room.room
    if (rm.stream_type !== 'encoder' || !rm.hls_url) return
    const video = videoRef.current
    if (!video) return
    let hls: any
    let retryTimer: any
    let destroyed = false

    // ⚠️ ПРИОРИТЕТ hls.js. Android-браузеры (MI Browser, встроенный WebView) на
    // canPlayType('vnd.apple.mpegurl') возвращают "maybe", но нативно HLS НЕ играют
    // → чёрный экран. Поэтому: если hls.js поддерживается — используем ЕГО (он умеет
    // везде, кроме iOS Safari). Нативный video.src — только там, где hls.js не работает
    // (iOS Safari/WebKit), там HLS реально играет нативно.
    const nativeError = () => {
      if (destroyed) return
      clearTimeout(retryTimer)
      retryTimer = setTimeout(() => {          // поток ещё не поднялся — пробуем снова
        if (destroyed) return
        video.src = rm.hls_url; video.load(); video.play().catch(() => {})
      }, 3000)
    }

    let netErrCount = 0
    import('hls.js').then(({ default: Hls }) => {
      if (destroyed) return
      if (Hls.isSupported()) {
        const mk = () => {
          const h = new Hls({ liveDurationInfinity: true, lowLatencyMode: false })
          hlsInstRef.current = h
          h.loadSource(rm.hls_url); h.attachMedia(video)
          h.on(Hls.Events.MANIFEST_PARSED, () => video.play().then(() => setPlayerStuck(false)).catch(() => setPlayerStuck(true)))
          h.on(Hls.Events.FRAG_BUFFERED, () => { netErrCount = 0; setPlayerStuck(false) })
          h.on(Hls.Events.ERROR, (_e: any, data: any) => {
            if (!data?.fatal) return
            if (data.type === 'networkError') {
              netErrCount++
              try { h.startLoad() } catch {}
              // поток не поднимается несколько раз подряд → показать кнопку «Обновить видео»
              if (netErrCount >= 3) setPlayerStuck(true)
            } else if (data.type === 'mediaError') {
              try { h.recoverMediaError() } catch { setPlayerStuck(true) }
            } else {
              try { h.destroy() } catch {}
              setPlayerStuck(true)
              retryTimer = setTimeout(() => { if (!destroyed) mk() }, 3000)
            }
          })
        }
        hls = { destroy: () => { try { hlsInstRef.current?.destroy() } catch {} } } as any
        mk()
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // iOS Safari — нативный HLS
        video.addEventListener('error', nativeError)
        video.addEventListener('playing', () => setPlayerStuck(false))
        video.src = rm.hls_url; video.load(); video.play().catch(() => setPlayerStuck(true))
      }
    })
    return () => {
      destroyed = true
      clearTimeout(retryTimer)
      video.removeEventListener('error', nativeError)
      hlsInstRef.current = null
      if (hls) { try { hls.destroy() } catch {} }
    }
  }, [room?.room?.hls_url, room?.room?.stream_type])

  // Ручной перезапуск плеера (кнопка «Обновить видео»): пере-инициализируем hls.js
  // или перезагружаем нативный src. Это то, что раньше делал только F5.
  const reloadPlayer = useCallback(() => {
    const rm = roomRef.current?.room
    const video = videoRef.current
    if (!rm?.hls_url || !video) return
    setPlayerStuck(false)
    const inst = hlsInstRef.current
    if (inst) {
      try { inst.stopLoad(); inst.startLoad(); } catch {}
      video.play().catch(() => {})
    } else {
      // нативный (iOS) — просто перезагружаем источник
      video.src = rm.hls_url; video.load(); video.play().catch(() => {})
    }
  }, [])

  // WebSocket realtime — с АВТО-ПЕРЕПОДКЛЮЧЕНИЕМ. Cloudflare рвёт неактивные WS,
  // на слабой сети зрителя соединение отваливается молча → чат «замирал». Теперь
  // при обрыве переподключаемся (с backoff) и дотягиваем пропущенный чат.
  useEffect(() => {
    if (!room?.room) return
    let closed = false
    let ws: WebSocket | null = null
    let ping: any = null
    let reconnectTimer: any = null
    let attempt = 0

    const connect = () => {
      if (closed) return
      ws = new WebSocket(`${WS_URL}/ws/webinar/${slug}/${day}`)
      wsRef.current = ws
      ws.onopen = () => {
        attempt = 0
        // после (пере)подключения дотягиваем историю чата — на случай пропущенных
        api('/chat').then(r => { for (const m of (r.messages || [])) pushChatMsg(m) }).catch(() => {})
      }
      ws.onclose = () => {
        if (closed) return
        // экспоненциальный backoff: 1с, 2с, 4с … максимум 10с
        const delay = Math.min(10000, 1000 * Math.pow(2, attempt++))
        reconnectTimer = setTimeout(connect, delay)
      }
      ws.onerror = () => { try { ws?.close() } catch {} }
      ws.onmessage = (ev) => {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { return }
      switch (msg.type) {
        case 'chat':
          pushChatMsg(msg); break
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
        // ведущий сменил текущего спикера (авто/вручную) — перечитать
        case 'speaker_changed': load(); break
        // 'ready'/'offline' — спикер настраивается в Zoom, зрителю показывать нечего.
        // Плеер появляется только когда ведущий нажал «Начать эфир» → stream_live.
        case 'stream_live': load(); break
        case 'room_opened': load(); break      // комната открыта — появится форма/плеер
        case 'room_reset': load(); break        // «начать заново» — вернуться к отсчёту
        case 'stream_paused': load(); break     // эфир завершён, но комната открыта — «пауза»
        case 'stream_ended':                    // комната закрыта
          // ⚠️ НЕ уводим по ссылке сразу. Раньше здесь был мгновенный
          // window.location.href — и зритель, досидевший до конца эфира,
          // улетал, не увидев ни «встречаемся завтра», ни предложения.
          // Перезагружаем страницу: покажется экран завершения, а уже он
          // переведёт по своему счётчику (outro_redirect_sec).
          load()
          break
        case 'participant_removed':
          if ((contactId && msg.contact_id === contactId) || (msg.session_key && msg.session_key === sessionKey)) {
            setError('Вы удалены из эфира')
          }
          break
      }
      }
    }

    connect()
    // keepalive пинг (шлём только по открытому сокету)
    ping = setInterval(() => { try { if (ws && ws.readyState === WebSocket.OPEN) ws.send('ping') } catch {} }, 25000)
    return () => {
      closed = true
      clearInterval(ping)
      clearTimeout(reconnectTimer)
      try { ws?.close() } catch {}
    }
  }, [room?.room?.id, slug, day]) // eslint-disable-line react-hooks/exhaustive-deps

  // heartbeat присутствия раз в минуту (только когда вкладка активна).
  // ⚠️ Пишем ТОЛЬКО опознанного зрителя (contactId есть): анонимов быть не должно,
  // а до прохождения формы heartbeat раньше писал анонимный session_key → раздувал
  // «неавторизованных» в аналитике.
  useEffect(() => {
    if (!room?.room || !contactId) return
    const beat = () => {
      if (document.hidden) return
      const device = /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop'
      api('/heartbeat', { contact_id: contactId, session_key: sessionKey, device })
    }
    beat()
    const t = setInterval(beat, 60000)
    return () => clearInterval(t)
  }, [room?.room?.id, contactId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fallback к WebSocket: раз в 12 сек перечитываем статус комнаты.
  // Если WS не долетел (отвалился, спящая вкладка) — всё равно поймаем
  // старт эфира и завершение с редиректом.
  useEffect(() => {
    if (!room?.room) return
    const t = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/public/webinar/${slug}/${day}`, { cache: 'no-store' })
        if (!res.ok) return
        const d = await res.json()
        const prev = roomRef.current  // актуальный room (не stale из замыкания)
        if (!prev?.room) return
        // ⚠️ Комната закрыта — ПОКАЗЫВАЕМ экран завершения, а не уводим сразу.
        // Уведёт он сам, по своему счётчику: иначе зритель не увидит ни
        // «встречаемся завтра», ни предложения. (Резервный путь на случай
        // отвалившегося веб-сокета — логика та же, что у stream_ended.)
        if (d.room?.room_state === 'closed' && prev.room.room_state !== 'closed') {
          setRoom(d); return
        }
        // Что могло измениться на пульте ведущего — сравниваем и обновляем без F5:
        //  • статус/состояние комнаты
        //  • текущий спикер (его блоки подписки/подарков переключаются)
        //  • набор видимых продающих блоков (кнопки/формы включают/выключают в эфире)
        const curEc = (x: any) => x?.current_speaker?.ec_id ?? null
        const giftKey = (x: any) => (x?.current_gift?.gifts || []).map((g: any) => g.url).join('|')
        const blockKey = (x: any) => (x?.blocks || []).map((b: any) => b.id).join('|')
        if (
          d.room?.status !== prev.room.status ||
          d.room?.room_state !== prev.room.room_state ||
          curEc(d) !== curEc(prev) ||
          giftKey(d) !== giftKey(prev) ||
          blockKey(d) !== blockKey(prev)
        ) load()
      } catch {}
    }, 12000)
    return () => clearInterval(t)
  }, [room?.room?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // автоскролл чата
  useEffect(() => { chatBoxRef.current?.scrollTo(0, chatBoxRef.current.scrollHeight) }, [chat])

  if (error) return <Centered>{error}</Centered>
  if (!room) return <Centered>Загрузка…</Centered>

  const rm = room.room
  const roomState = rm.room_state || 'created'
  const live = rm.status === 'live' && roomState === 'open'
  const ended = rm.status === 'ended'
  const webinarTitle = rm.title || room.event?.title

  // (d) КОМНАТА ЗАКРЫТА — «вебинар завершён», редирект (если задан).
  if (roomState === 'closed') {
    return (
      <PreStartScreen brand={room.brand} poster={room.poster_url} title={webinarTitle}
        heading="Вебинар завершён"
        sub={rm.redirect_url ? '' : 'Спасибо, что были с нами!'}
        redirectUrl={rm.redirect_url} slug={slug} day={day} isClosed
        offerText={rm.outro_offer_text} buttonLabel={rm.outro_button_label}
        redirectSec={rm.outro_redirect_sec} nextDay={room.room?.next_day} />
    )
  }

  // (a) КОМНАТА НЕ ОТКРЫТА — афиша + название + обратный отсчёт, БЕЗ формы входа.
  if (roomState === 'created') {
    return (
      <PreStartScreen brand={room.brand} poster={room.poster_url} title={webinarTitle}
        heading={rm.intro_text || 'Трансляция скоро начнётся'} opensAt={rm.opens_at} />
    )
  }

  // Дальше room_state === 'open'.
  // Анонимов быть не должно: форма показывается если зритель не опознан ЛИБО опознан
  // по куке, но регистрации на этот вебинар нет (её удалили/обнулили статистику) —
  // иначе кука пускала бы «фантома», которого нет в списке зрителей. justAuthed —
  // только что прошёл форму в этой сессии, регистрация точно есть → не гоняем повторно.
  const needAuth = !contactId || (room.has_registration === false && !justAuthed)
  if (needAuth) {
    return <AuthGate slug={slug} day={day} rm={rm} pid={pid} utm={utm} clientId={room.event?.client_id}
      brand={room.brand} title={webinarTitle}
      onAuthed={(cid: number, form: any) => { saveAuth(cid, form); setAuthContact(cid); setAuthName((form?.name || '').trim()); setJustAuthed(true) }} />
  }

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

  // (b) КОМНАТА ОТКРЫТА, эфир ещё НЕ идёт — НЕ показываем отдельную заглушку.
  // Зритель попадает В САМУ КОМНАТУ (шапка, афиша-заставка на месте плеера, чат,
  // блоки). Внутри на месте видео — афиша + «трансляция скоро начнётся» + отсчёт.
  // Как только ведущий нажмёт «Начать эфир» — заставка сменится плеером (WS load()).

  async function sendChat() {
    const text = chatText.trim()
    if (!text) return
    setChatText('')
    // Оптимистично показываем СВОЁ сообщение сразу — не ждём, пока оно вернётся по
    // WebSocket (WS может подвиснуть / оборваться через Cloudflare). Помечаем _local
    // + _tmpId; когда придёт настоящее (по WS или поллингом) — дедуп его схлопнет.
    const tmpId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const mine = { _tmpId: tmpId, _local: true, text, author_name: authName || 'Вы', contact_id: contactId, at: new Date().toISOString() }
    setChat(c => [...c, mine])
    try {
      // author_name — имя из формы авторизации; бэк также подставит по contact_id, если пусто
      const r = await api('/chat', { contact_id: contactId, session_key: sessionKey, text, author_name: authName || undefined })
      // если бэк вернул id — проставим его локальному сообщению (дедуп по id ниже уберёт дубль из WS)
      if (r?.id) setChat(c => c.map(m => m._tmpId === tmpId ? { ...m, id: r.id, _local: false } : m))
    } catch {
      // не удалось отправить — помечаем ошибкой, не удаляем (человек видит, что не ушло)
      setChat(c => c.map(m => m._tmpId === tmpId ? { ...m, _failed: true } : m))
    }
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
    // Кнопка «Регистрация на событие»: регистрируем сразу (контакт уже есть), затем
    // либо сообщение в бот, либо экран выбора мессенджера.
    if (b.kind === 'event_reg') {
      if (!contactId) { setNeedReg(true); return }
      try {
        const r = await fetch(`${API_URL}/api/v1/public/webinar/${slug}/${day}/register-event`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact_id: contactId, block_id: b.id }),
        })
        const data = await r.json()
        if (data?.ok) setRegEventRes(data)
      } catch {}
      return
    }
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
              /* До эфира — поверх афиши: «трансляция скоро начнётся» + отсчёт */
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 bg-gradient-to-t from-black/85 via-black/40 to-black/30 text-center">
                <span className="text-white font-semibold text-lg drop-shadow">
                  {rm.intro_text || 'Трансляция скоро начнётся'}
                </span>
                {rm.opens_at && <Countdown opensAt={rm.opens_at} />}
              </div>
            ) : null}
            {/* плеер только в эфире: до «Начать эфир» hls_url с бэка не приходит */}
            {/* muted — иначе iOS/Android блокируют autoPlay; звук зритель включит сам.
                playsInline + webkit — чтобы на iPhone не открывалось на весь экран. */}
            {live && <video ref={videoRef} controls autoPlay muted playsInline
              // @ts-ignore — атрибут для старых iOS
              webkit-playsinline="true"
              className="w-full h-full" />}
            {live && <span className="absolute top-3 left-3 bg-red-600 text-xs px-2 py-0.5 rounded font-bold">● LIVE</span>}
            {/* Кнопка перезапуска — всегда доступна в эфире (правый верх), на случай
                «тихого» чёрного экрана без fatal-ошибки (заблокированный autoplay). */}
            {live && !playerStuck && (
              <button onClick={reloadPlayer} title="Обновить видео"
                className="absolute top-3 right-3 bg-black/50 hover:bg-black/70 text-white/90 text-xs px-2.5 py-1 rounded-lg">
                ↻ Видео
              </button>
            )}
            {/* Плеер завис/чёрный экран → кнопка «Обновить видео» (без F5). */}
            {live && playerStuck && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 text-center px-6">
                <span className="text-white/80 text-sm">Видео не загрузилось или зависло?</span>
                <button onClick={reloadPlayer}
                  className="px-5 py-2.5 rounded-xl font-semibold text-sm"
                  style={{ background: '#FFCFA4', color: '#0a1520' }}>
                  ↻ Обновить видео
                </button>
                <span className="text-white/40 text-xs">Если не помогло — обновите страницу</span>
              </div>
            )}
          </div>

          {/* Продающие блоки (не спикерские) — НАД спикером, отделены чертой.
              Подряд идущие кнопки собираются в сетку N в ряд; форма разрывает группу
              и идёт на всю ширину. Порядок = sort_order. */}
          {(() => {
            const per = Math.max(1, Math.min(4, room.room?.buttons_per_row || 1))
            const items = (room.blocks || []).filter((b: any) => b.kind === 'button' || b.kind === 'form' || b.kind === 'event_reg')
            if (!items.length) return null
            const out: any[] = []
            let btnRun: any[] = []
            const flush = () => {
              if (!btnRun.length) return
              const run = btnRun; btnRun = []
              out.push(
                <div key={`btns-${run[0].id}`} className="mt-3 grid gap-2"
                  style={{ gridTemplateColumns: `repeat(${per}, minmax(0, 1fr))` }}>
                  {run.map((b: any) => (
                    <button key={b.id} onClick={() => clickBlock(b)} className="btn-gold text-sm">
                      {b.title || 'Подробнее'}
                    </button>
                  ))}
                </div>
              )
            }
            items.forEach((b: any) => {
              if (b.kind === 'button' || b.kind === 'event_reg') { btnRun.push(b); return }
              flush()
              out.push(
                <div key={b.id} className="mt-3 rounded-xl bg-white/10 p-3">
                  {b.title && <div className="font-semibold text-sm mb-1">{b.title}</div>}
                  {b.body && <div className="text-xs text-white/60 mb-2">{b.body}</div>}
                  <FormBlock block={b} slug={slug} day={day} contactId={contactId} sessionKey={sessionKey} onNeedReg={() => setNeedReg(true)} />
                </div>
              )
            })
            flush()
            return (
              <div>
                {out}
                {/* черта — отделяет продающие блоки от спикера */}
                <div className="mt-4 border-t border-white/15" />
              </div>
            )
          })()}

          {/* Сейчас выступает + подписка на все каналы спикера */}
          {cur && (
            <div className="mt-3 rounded-xl bg-white/5 p-3 flex items-center gap-3 flex-wrap">
              {cur.photo_url && <img src={cur.photo_url} alt="" className="w-10 h-10 rounded-full object-cover" style={{ objectPosition: focalCss(cur.photo_focal) }} />}
              <div className="min-w-0">
                <span className="text-white/50 text-sm">Спикер: </span>
                <span className="font-semibold">{cur.name}</span>
              </div>
              {(cur.channels?.telegram || cur.channels?.max || cur.channels?.vk) && (
                <div className="flex flex-wrap gap-2 items-center ml-auto">
                  <span className="text-xs text-white/50">Подписаться:</span>
                  {cur.channels?.telegram && (
                    <a href={cur.channels.telegram} target="_blank" rel="noreferrer" className="text-xs px-3 py-1.5 rounded-lg font-semibold" style={{ background: '#FFCFA4', color: '#0a1520' }}>Канал в ТГ</a>
                  )}
                  {cur.channels?.max && (
                    <a href={cur.channels.max} target="_blank" rel="noreferrer" className="text-xs px-3 py-1.5 rounded-lg font-semibold" style={{ background: '#FFCFA4', color: '#0a1520' }}>Канал в МАХ</a>
                  )}
                  {cur.channels?.vk && (
                    <a href={cur.channels.vk} target="_blank" rel="noreferrer" className="text-xs px-3 py-1.5 rounded-lg font-semibold" style={{ background: '#FFCFA4', color: '#0a1520' }}>Канал в ВК</a>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Подарки спикера — каждый отдельной кнопкой */}
          {room.current_gift?.gifts?.length > 0 && (
            <div className="mt-2 rounded-xl bg-amber-500/15 border border-amber-400/30 p-3">
              <div className="text-sm font-semibold mb-2">🎁 Подарки {room.current_gift.speaker_name || 'спикера'}:</div>
              <div className="flex flex-wrap gap-2">
                {room.current_gift.gifts.map((g: any, i: number) => (
                  <a key={i} href={g.url} target="_blank" rel="noreferrer"
                    onClick={() => api('/track', { contact_id: contactId, session_key: sessionKey, kind: 'click' })}
                    className="px-3 py-2 rounded-lg text-sm font-semibold"
                    style={{ background: '#FFCFA4', color: '#0a1520' }}>
                    {g.title || 'Получить'}
                  </a>
                ))}
              </div>
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
              {battle.title && <div className="font-semibold mb-3">⚔️ {battle.title}</div>}
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

        </div>

        {/* чат — ФИКСИРОВАННАЯ высота: лента скроллится ВНУТРИ, поле ввода залипает
            внизу и всегда в экране (и на мобиле, и на десктопе). На десктопе колонка
            sticky, чтобы при длинной странице ввод не уезжал. min-h-0 обязателен —
            иначе flex-ребёнок не даёт ленте скроллиться и распирает контейнер. */}
        <div className="rounded-xl bg-white/5 flex flex-col overflow-hidden h-[70vh] md:h-[calc(100vh-2.5rem)] md:sticky md:top-4">
          <div className="p-3 border-b border-white/10 font-semibold text-sm shrink-0">Чат</div>
          <div ref={chatBoxRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 text-sm scroll-visible">
            {chat.map((m, i) => (
              <div key={m.id ?? m._tmpId ?? i} className={m._failed ? 'opacity-50' : ''}>
                <span className="text-white/50 mr-1">{m.author_name || 'Гость'}:</span>
                <span className="break-words">{m.text}</span>
                {m._failed && <span className="text-red-400 text-xs ml-1">· не отправлено</span>}
              </div>
            ))}
            {!chat.length && <div className="text-white/40 text-center py-8">Сообщений пока нет</div>}
          </div>
          {rm.chat_enabled ? (
            <div className="p-3 border-t border-white/10 flex gap-2 shrink-0">
              <input
                value={chatText} onChange={e => setChatText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendChat()}
                placeholder="Написать…"
                className="flex-1 min-w-0 bg-white/10 rounded-lg px-3 py-2 text-sm outline-none"
              />
              <button onClick={sendChat} aria-label="Отправить"
                className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg text-base font-semibold"
                style={{ background: '#FFCFA4', color: '#0a1520' }}>▶</button>
            </div>
          ) : (
            <div className="p-3 border-t border-white/10 text-xs text-white/40 text-center shrink-0">Чат отключён</div>
          )}
          {/* счётчик зрителей — внизу чата, а не на видео */}
          {online != null && (
            <div className="px-3 py-2 border-t border-white/10 text-xs text-white/50 flex items-center gap-1.5 shrink-0">
              <span>👁</span> Сейчас смотрят: <b className="text-white/80">{online}</b>
            </div>
          )}
        </div>
      </div>

      {needReg && <RegModal slug={slug} day={day} onClose={() => setNeedReg(false)} />}
      {regEventRes && <RegEventModal res={regEventRes} onClose={() => setRegEventRes(null)} />}
    </div>
  )
}

// Результат кнопки «Регистрация на событие»: либо «вы зарегистрированы» (ушло в бот),
// либо «Выберите удобный мессенджер» с кнопками площадок клиента (deeplink evreg_).
function RegEventModal({ res, onClose }: any) {
  const bot = res.delivered === 'bot'
  const platforms: any[] = res.platforms || []
  const PLAT_COLOR: Record<string, string> = {
    telegram: '#229ED9', max: '#7C4DFF', vk: '#0077FF',
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-white rounded-2xl max-w-sm w-full p-6 text-center" style={{ color: '#0a1520' }}
           onClick={e => e.stopPropagation()}>
        {bot ? (
          <>
            <div className="text-4xl mb-3">✅</div>
            <div className="font-bold text-lg mb-1">Вы зарегистрированы!</div>
            <div className="text-sm text-gray-600 mb-5">
              На «{res.event_title}». Мы отправили подтверждение и меню события вам в бот.
            </div>
            <button onClick={onClose} className="btn-gold w-full">Понятно</button>
          </>
        ) : (
          <>
            <div className="text-4xl mb-3">📩</div>
            <div className="font-bold text-lg mb-1">Вы зарегистрированы на «{res.event_title}»!</div>
            <div className="text-sm text-gray-600 mb-5">
              Выберите удобный мессенджер, чтобы не потерять информацию о конференции —
              там мы пришлём программу, подарки и ссылку на эфир.
            </div>
            <div className="space-y-2">
              {platforms.length === 0 && (
                <div className="text-sm text-gray-500">Мессенджеры организатора пока не подключены.</div>
              )}
              {platforms.map((p: any) => (
                <a key={p.platform} href={p.url} target="_blank" rel="noopener noreferrer"
                   className="block w-full py-3 rounded-xl font-semibold text-white text-sm"
                   style={{ background: PLAT_COLOR[p.platform] || '#25455D' }}>
                  {p.label}
                </a>
              ))}
            </div>
            <button onClick={onClose} className="mt-4 text-sm text-gray-400 underline">Закрыть</button>
          </>
        )}
      </div>
    </div>
  )
}

function FormBlock({ block, slug, day, contactId, sessionKey, onNeedReg }: any) {
  const submitKey = `webinar_form_${slug}_${day}_${block.id}`
  // запоминаем отправку локально — после обновления страницы форму снова не покажем
  const [sent, setSent] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem(submitKey) === '1'
  })
  const [form, setForm] = useState({ name: '', email: '', phone: '', telegram_username: '' })
  const [open, setOpen] = useState(false)

  async function submit(withContact: boolean) {
    const body: any = { contact_id: contactId, session_key: sessionKey }
    if (!withContact) Object.assign(body, form)
    const r = await fetch(`${API_URL}/api/v1/public/webinar/${slug}/${day}/form/${block.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (r.ok) {
      try { localStorage.setItem(submitKey, '1') } catch {}
      setSent(true)
    }
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

// Форма авторизации перед эфиром — настраиваемые поля, предзаполнение из cookie.
function AuthGate({ slug, day, rm, pid, utm, clientId, brand, title, poster, onAuthed }: any) {
  const [f, setF] = useState<any>(() => ({ name: '', email: '', phone: '', telegram_username: '', ...readAuthForm() }))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [candidates, setCandidates] = useState<any[] | null>(null) // экран «Это вы?»
  // «Это новый участник» показываем, только когда email и ник свободны:
  // они уникальны, второй контакт с ними не создастся.
  const [canCreateNew, setCanCreateNew] = useState(false)
  const [consentPd, setConsentPd] = useState(false)
  const [consentMk, setConsentMk] = useState(false)
  const privacyUrl = clientId ? `${(typeof window !== 'undefined' ? window.location.origin : 'https://pluson.ru')}/c/${clientId}/privacy` : null
  // Организатор включил хоть одно поле связи? Если нет — почту показываем сами:
  // одного имени сервер не принимает, и человеку иначе нечего было бы ввести.
  const needExtra = !!(rm.auth_require_email || rm.auth_require_phone || rm.auth_require_tg)

  async function send(extra: any = {}) {
    setBusy(true); setErr('')
    try {
      const r = await fetch(`${API_URL}/api/v1/public/webinar/${slug}/${day}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...f, pid, utm_source: utm, consent_pd: consentPd, consent_marketing: consentMk, ...extra }),
      })
      const d = await r.json()
      if (d.need_choice) {
        setCandidates(d.candidates || [])
        setCanCreateNew(!!d.can_create_new)
        return
      }
      if (r.ok && d.contact_id) onAuthed(d.contact_id, f)
      else setErr(d.detail || 'Не удалось войти')
    } catch { setErr('Ошибка сети') }
    finally { setBusy(false) }
  }

  async function submit() {
    // Имя обязательно ВСЕГДА — анонимов в эфире быть не должно.
    if (!f.name.trim()) return setErr('Укажите имя')
    // ⚠️ Одного имени НЕ ХВАТАЕТ (2026-09-03): человека без единого способа
    // связи в базу не пишем, и сервер такой запрос отклонит. Когда организатор
    // не включил ни одного поля, почта всё равно показана — ей и заполняем.
    if (!needExtra && !f.email.trim())
      return setErr('Укажите email — иначе мы не сможем прислать вам запись')
    if (rm.auth_require_email && !f.email.trim()) return setErr('Укажите email')
    if (rm.auth_require_phone && !f.phone.trim()) return setErr('Укажите телефон')
    if (rm.auth_require_tg && !f.telegram_username.trim()) return setErr('Укажите ник в Telegram')
    if (!consentPd) return setErr('Нужно согласие на обработку персональных данных')
    await send()
  }

  // экран «Это вы?» — нашлось несколько контактов
  if (candidates) {
    return (
      <Centered>
        <div className="w-full max-w-sm">
          <h2 className="text-lg font-bold text-center mb-1">Это вы?</h2>
          <p className="text-sm text-white/60 text-center mb-4">
            Мы нашли несколько записей. Выберите ту, куда хотите получить
            доступ и напоминания.
          </p>
          <div className="space-y-2">
            {candidates.map((c: any) => (
              <button key={c.id} disabled={busy} onClick={() => send({ chosen_contact_id: c.id })}
                className="w-full text-left rounded-lg bg-white/10 hover:bg-white/20 p-3">
                <div className="font-semibold text-sm">{c.name || 'Без имени'}</div>
                {/* ⚠️ Контакты ПОСТРОЧНО и со значком площадки: по нику в
                    MAX или ВК человек узнаёт себя быстрее, чем по
                    замаскированной почте. */}
                <div className="mt-1 space-y-0.5 text-xs text-white/60">
                  {c.email && (
                    <div className="flex items-center gap-1.5">
                      <PlatformMark platform="email" /> {c.email}
                    </div>
                  )}
                  {c.phone && (
                    <div className="flex items-center gap-1.5">
                      <PlatformMark platform="phone" /> {c.phone}
                    </div>
                  )}
                  {(c.accounts || []).map((a: any) => (
                    <div key={a.platform} className="flex items-center gap-1.5">
                      <PlatformMark platform={a.platform} /> @{a.username}
                    </div>
                  ))}
                </div>
              </button>
            ))}
            {canCreateNew && (
              <button disabled={busy} onClick={() => send({ force_new: true })}
                className="w-full py-2.5 rounded-lg font-semibold mt-1" style={{ background: '#FFCFA4', color: '#0a1520' }}>
                Это новый участник
              </button>
            )}
            {err && <div className="text-sm text-red-300">{err}</div>}
          </div>
        </div>
      </Centered>
    )
  }

  const field = (key: string, ph: string, req: boolean) => (
    <input value={f[key]} onChange={e => setF({ ...f, [key]: e.target.value })}
      placeholder={ph + (req ? ' *' : '')}
      className="w-full bg-white/10 rounded-lg px-3 py-2.5 text-sm outline-none" />
  )

  return (
    <Centered>
      <div className="w-full max-w-sm">
        {brand?.logo_url && <img src={brand.logo_url} alt="" className="h-9 mx-auto mb-3 object-contain" />}
        {/* Только логотип + НАЗВАНИЕ вебинара (афишу в форму не пихаем). */}
        {title && <h2 className="text-lg font-bold text-center mb-2 leading-snug">{title}</h2>}
        <p className="text-sm text-white/70 text-center mb-1">Оставьте контакты для входа в эфир</p>
        {rm.auth_intro_text && <p className="text-sm text-white/60 text-center mb-4">{rm.auth_intro_text}</p>}
        <div className="space-y-2 mt-4">
          {/* Показываем только включённые в настройках поля; все показанные обязательны.
              Имя показывается и обязательно ВСЕГДА. */}
          {field('name', 'Имя', true)}
          {!!rm.auth_require_phone && field('phone', 'Телефон', true)}
          {(!!rm.auth_require_email || !needExtra) && field('email', 'Email', true)}
          {!!rm.auth_require_tg && field('telegram_username', 'Ник в Telegram', true)}

          <label className="flex items-start gap-2 text-xs text-white/70 mt-1 cursor-pointer">
            <input type="checkbox" checked={consentPd} onChange={e => setConsentPd(e.target.checked)} className="mt-0.5" />
            <span>Согласен на обработку персональных данных и ознакомлен с{' '}
              {privacyUrl
                ? <a href={privacyUrl} target="_blank" rel="noreferrer" className="underline" style={{ color: '#FFCFA4' }}>политикой конфиденциальности</a>
                : <span>политикой конфиденциальности</span>}</span>
          </label>
          <label className="flex items-start gap-2 text-xs text-white/70 cursor-pointer">
            <input type="checkbox" checked={consentMk} onChange={e => setConsentMk(e.target.checked)} className="mt-0.5" />
            <span>Согласен на получение рекламных материалов</span>
          </label>

          {err && <div className="text-sm text-red-300">{err}</div>}
          <button onClick={submit} disabled={busy}
            className="w-full py-2.5 rounded-lg font-semibold mt-1" style={{ background: '#FFCFA4', color: '#0a1520' }}>
            {busy ? '…' : 'Войти в эфир'}
          </button>
        </div>
      </div>
    </Centered>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center text-white/80 p-6" style={{ background: 'linear-gradient(160deg, #0a1520, #142430)' }}>
      {children}
    </div>
  )
}

// Экран до старта / после закрытия: логотип + название вебинара + афиша + отсчёт.
// slug/day/isClosed нужны, чтобы closed-экран сам пинговал состояние: если комнату
// переоткрыли (open/created) — перезагрузиться и показать форму/отсчёт, а не «завершён».
function PreStartScreen({ brand, poster, title, heading, sub, opensAt, redirectUrl, slug, day, isClosed,
                          offerText, buttonLabel, redirectSec, nextDay }: any) {
  // Секунды до автоперехода. 0 (или отсутствие ссылки) — не переводим вовсе:
  // уйдёт только по кнопке. Раньше здесь было 4 секунды хардкодом — человек не
  // успевал прочитать ни про следующий день, ни про предложение.
  const delay = (typeof redirectSec === 'number' ? redirectSec : 15)
  const [left, setLeft] = useState<number>(delay)
  useEffect(() => {
    if (!redirectUrl || delay <= 0) return
    setLeft(delay)
    const tick = setInterval(() => setLeft(v => (v > 0 ? v - 1 : 0)), 1000)
    const t = setTimeout(() => { window.location.href = redirectUrl }, delay * 1000)
    return () => { clearTimeout(t); clearInterval(tick) }
  }, [redirectUrl, delay])
  // closed-экран: раз в 8 сек проверяем — вдруг комнату переоткрыли.
  useEffect(() => {
    if (!isClosed || !slug || day == null) return
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${API_URL}/api/v1/public/webinar/${slug}/${day}`, { cache: 'no-store' })
        if (!r.ok) return
        const d = await r.json()
        if (d.room?.room_state && d.room.room_state !== 'closed') window.location.reload()
      } catch {}
    }, 8000)
    return () => clearInterval(t)
  }, [isClosed, slug, day])
  return (
    <div className="min-h-screen flex flex-col items-center justify-center text-white p-6 text-center"
      style={{ background: 'linear-gradient(160deg, #0a1520, #142430)' }}>
      {brand?.logo_url && <img src={brand.logo_url} alt="" className="h-10 mb-4 object-contain" />}
      {title && <h1 className="text-xl sm:text-2xl font-bold mb-2 max-w-xl">{title}</h1>}
      {opensAt && !redirectUrl && (
        <p className="text-sm mb-3" style={{ color: '#FFCFA4' }}>📅 {fmtStartMsk(opensAt)}</p>
      )}
      {poster && (
        <img src={poster} alt="" className="w-full max-w-md rounded-2xl shadow-lg mb-5 object-cover" />
      )}
      {heading && <p className="text-lg text-white/90 mb-1 max-w-xl whitespace-pre-wrap">{heading}</p>}
      {sub && <p className="text-sm text-white/60 mb-3">{sub}</p>}
      {opensAt && <Countdown opensAt={opensAt} />}

      {/* Следующий день программы — человеку, пришедшему после эфира, важнее
          всего узнать, когда встречаемся снова. Фразу собирает бэк той же
          логикой, что {next_day_mention} в рассылках: формулировки совпадают.
          Последний день → nextDay = null, блока нет. */}
      {nextDay?.mention && (
        <div className="mt-4 rounded-2xl px-4 py-3 max-w-md w-full"
             style={{ background: 'rgba(255,207,164,0.12)', border: '1px solid rgba(255,207,164,0.35)' }}>
          <p className="text-sm font-semibold" style={{ color: '#FFCFA4' }}>{nextDay.mention}</p>
          {nextDay.title && <p className="text-xs text-white/60 mt-1">{nextDay.title}</p>}
        </div>
      )}

      {/* Предложение + кнопка. Показываем ТОЛЬКО при заданной ссылке: кнопка
          в никуда бессмысленна. Кнопка и автопереход ведут в одно место. */}
      {redirectUrl && (
        <div className="mt-5 flex flex-col items-center gap-2.5 w-full max-w-md">
          {offerText && <p className="text-sm text-white/80">{offerText}</p>}
          <a href={redirectUrl}
             className="w-full rounded-xl px-5 py-3 text-sm font-semibold text-center"
             style={{ background: '#FFCFA4', color: '#0a1520' }}>
            {buttonLabel || 'Смотреть предложение'}
          </a>
          {delay > 0 && (
            <p className="text-xs text-white/40">
              {left > 0 ? `Перейдём автоматически через ${left} сек` : 'Переходим…'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// Дата+время старта в МСК: «27 июля, 11:00 МСК».
function fmtStartMsk(iso: string): string {
  try {
    const d = new Date(iso)
    const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
    return `${date}, ${time} МСК`
  } catch { return '' }
}

// Обратный отсчёт до opensAt (ISO). После наступления — «Трансляция вот-вот начнётся».
function Countdown({ opensAt }: { opensAt: string }) {
  const [left, setLeft] = useState<number>(() => Math.max(0, new Date(opensAt).getTime() - Date.now()))
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, new Date(opensAt).getTime() - Date.now())), 1000)
    return () => clearInterval(t)
  }, [opensAt])
  if (left <= 0) return <p className="text-base text-white/70">Трансляция вот-вот начнётся…</p>
  const s = Math.floor(left / 1000)
  const d = Math.floor(s / 86400)
  const hh = Math.floor((s % 86400) / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    <div className="mt-1">
      <p className="text-xs text-white/50 mb-1.5 uppercase tracking-wide">До начала эфира</p>
      <div className="text-2xl sm:text-3xl font-bold tabular-nums" style={{ color: '#FFCFA4' }}>
        {d > 0 && <span>{d} дн </span>}{pad(hh)}:{pad(mm)}:{pad(ss)}
      </div>
    </div>
  )
}

/** Значок площадки в карточке «Это вы?» — фирменный цвет и короткая метка. */
const PLATFORM_MARK: Record<string, { label: string; color: string; short: string }> = {
  telegram: { label: 'Telegram', color: '#229ED9', short: 'TG' },
  vk:       { label: 'ВКонтакте', color: '#0077FF', short: 'VK' },
  max:      { label: 'MAX', color: '#8B5CF6', short: 'MAX' },
  email:    { label: 'Почта', color: '#6B7280', short: '@' },
  phone:    { label: 'Телефон', color: '#10B981', short: '☎' },
}

function PlatformMark({ platform }: { platform: string }) {
  const m = PLATFORM_MARK[platform] || { label: platform, color: '#6B7280', short: '•' }
  return (
    <span
      title={m.label}
      className="inline-flex h-4 min-w-[32px] shrink-0 items-center justify-center rounded px-1 text-[9px] font-bold uppercase text-white"
      style={{ background: m.color }}
    >
      {m.short}
    </span>
  )
}
