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
  /** Видео идёт, но браузер не дал звук — показываем кнопку «Включить звук». */
  const [needUnmute, setNeedUnmute] = useState(false)
  /** Почему сообщение не ушло (например «Ссылки в чате запрещены»). */
  const [chatError, setChatError] = useState('')
  /** За кого уже голосовал этот зритель: { ec_id: 'up' | 'down' }. */
  const [myVotes, setMyVotes] = useState<Record<number, 'up' | 'down'>>({})
  const [online, setOnline] = useState<number | null>(null)
  const [reactions, setReactions] = useState<Record<string, { up: number; down: number }>>({})
  const [poll, setPoll] = useState<any>(null)
  const [battle, setBattle] = useState<any>(null)
  const [needReg, setNeedReg] = useState(false)
  const [regEventRes, setRegEventRes] = useState<any>(null)  // результат кнопки «Регистрация на событие»
  const [playerStuck, setPlayerStuck] = useState(false)      // плеер завис/чёрный экран → показать кнопку «Обновить видео»
  // ⚠️ «Идёт загрузка» после нажатия (24.09.2026). Видео стартует не
  // мгновенно, и в эти секунды кнопка «Смотреть эфир» возвращалась —
  // выглядело, будто нажатие не работает, и человек жал снова и снова.
  // Теперь на это время показываем крутилку вместо кнопки.
  // ⚠️⚠️ СТАРТОВОЕ ЗНАЧЕНИЕ — `true` (25.09.2026, «чёрный экран без кнопки плей»).
  // Оба флага стартовали в `false`, и пока видео только грузится (а это секунды,
  // на мобильном интернете и больше), поверх чёрного кадра не было НИЧЕГО: ни
  // крутилки, ни кнопки. Зритель видел чёрный прямоугольник и решал, что эфир
  // сломан — жал «обновить» и терял ещё больше времени. Снимут крутилку
  // слушатели самого <video> (playing/canplay/timeupdate) или страховочный
  // таймер на 12 с — то есть если видео пойдёт, надпись уйдёт сама.
  const [playerLoading, setPlayerLoading] = useState(true)
  const hlsInstRef = useRef<any>(null)                       // текущий hls.js — для ручного перезапуска кнопкой
  // ⚠️⚠️ Сбор ФАКТА ВОСПРОИЗВЕДЕНИЯ для heartbeat (26.09.2026, после вебинара,
  // где 71 зритель из 158 не увидел видео, а по логам это было не видно).
  const lastTimeRef = useRef(0)            // currentTime на прошлом пинге — растёт ли
  const playedRef = useRef(0)              // сколько секунд видео реально шло
  const playerModeRef = useRef<string | null>(null)  // 'native' | 'hlsjs'
  const playerErrRef = useRef<string | null>(null)   // последняя ошибка плеера
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
      // Токен кабинета: если комнату открыл организатор — получит кнопки
      // модерации и право слать ссылки при включённом запрете. У зрителя
      // токена нет, параметр просто не уйдёт.
      const _tok = typeof localStorage !== 'undefined' ? localStorage.getItem('plusson_token') : null
      if (_tok) _qs.set('token', _tok)
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

  /**
   * Запуск со ЗВУКОМ, с откатом на беззвучный.
   *
   * ⚠️ Раньше плеер всегда стартовал с `muted` — и зритель сидел в тишине,
   * не найдя, где включить звук (правило владельца, 19.09.2026). Просто убрать
   * `muted` нельзя: браузеры блокируют автозапуск со звуком, и тогда не
   * запустится ВООБЩЕ ничего — чёрный экран вместо тихого видео, что хуже.
   *
   * Поэтому: сначала пробуем со звуком; заблокировали — включаем беззвучно
   * (видео идёт) и поднимаем заметную кнопку «Включить звук». Один клик по
   * ней снимает запрет браузера — это и есть то «действие пользователя»,
   * которого он ждёт.
   */
  const playWithSound = useCallback(async (video: HTMLVideoElement) => {
    video.muted = false
    try {
      await video.play()
      setNeedUnmute(false)
      return true
    } catch {
      video.muted = true
      try {
        await video.play()
        setNeedUnmute(true)   // идёт, но без звука — покажем кнопку
        return true
      } catch {
        return false          // не запустился вовсе → кнопка «Обновить видео»
      }
    }
  }, [])

  /** Включить звук по клику зрителя — клик снимает блокировку автозапуска. */
  const unmute = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = false
    video.volume = 1
    video.play().catch(() => {})
    setNeedUnmute(false)
  }, [])

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

    // ⚠️⚠️ ВЫБОР СПОСОБА ПО УСТРОЙСТВУ, А НЕ «ВСЕГДА hls.js» (25.09.2026).
    //
    // Раньше приоритет был всегда у hls.js, и нативный путь получал только тот,
    // где hls.js не поддерживается вовсе. Из-за этого на iOS через hls.js шли
    // ВСЕ браузеры — и упирались в cookie-сессию MediaMTX (hls.js грузит
    // плейлисты через XHR, а MediaMTX отдаёт куку с атрибутом `Partitioned`,
    // которую XHR не подставляет). Итог на живом эфире: Safari играл, а Chrome
    // и Яндекс на том же телефоне — чёрный экран.
    //
    // ⚠️ Ключевой факт: на iOS ВСЕ браузеры обязаны использовать WebKit —
    // Chrome и Яндекс на iPhone это Safari внутри. Значит нативный HLS там
    // работает точно так же, и cookie уходит сама, потому что запрос делает
    // сам <video>, а не XHR. Поэтому на iOS выбираем НАТИВНЫЙ путь для всех
    // браузеров, а не только для Safari.
    //
    // ⚠️ На Android наоборот: MI Browser и встроенный WebView на
    // canPlayType('vnd.apple.mpegurl') возвращают "maybe", но нативно HLS НЕ
    // играют → чёрный экран. Там нужен hls.js.
    //
    // ⚠️ Определяем по платформе (iOS/iPadOS), а НЕ по названию браузера:
    // названий много (Safari, CriOS, YaBrowser, FxiOS, EdgiOS…), список
    // пришлось бы вечно дополнять, и каждый забытый молча уходил бы не туда.
    // Платформа одна, и именно она определяет движок.
    // iPadOS 13+ подделывается под Mac, поэтому дополнительно проверяем
    // touch-точки: Mac без тача останется на hls.js, планшет уйдёт в нативный.
    const ua = navigator.userAgent
    const isIOS = /iPad|iPhone|iPod/.test(ua)
      || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1)
    // ⚠️⚠️ НА iOS НЕ СПРАШИВАЕМ canPlayType (25.09.2026). Здесь стояло
    // `isIOS && canPlayType(...) !== ''`, и на Яндекс-браузере плеер не
    // стартовал ВООБЩЕ: в логах ноль запросов к /live/ за 26 минут — ни
    // плейлиста, ни сегментов. canPlayType отвечает пустой строкой в части
    // WebKit-сборок (в том числе внутри сторонних браузеров на iOS), и условие
    // молча проваливалось. На iOS нативный HLS есть ВСЕГДА — там весь браузер
    // обязан быть WebKit, спрашивать не о чем. Ошибку загрузки всё равно
    // поймает обработчик 'error' → nativeError и перезапустит.

    const nativeError = () => {
      if (destroyed) return
      clearTimeout(retryTimer)
      retryTimer = setTimeout(() => {          // поток ещё не поднялся — пробуем снова
        if (destroyed) return
        video.src = rm.hls_url; video.load(); video.play().catch(() => {})
      }, 3000)
    }

    // ⚠️⚠️ НАБОРЫ НАСТРОЕК ПО БРАУЗЕРАМ (25.09.2026, правило владельца).
    //
    // Один способ на всех НЕ РАБОТАЕТ: каждая попытка унифицировать лечила одни
    // браузеры и ломала другие. Поэтому каждому браузеру — тот набор, при
    // котором он ФАКТИЧЕСКИ игрался на устройстве (не «по логам»: байты
    // приходили и туда, где картинки не было).
    //
    //   НАБОР «Н-НАТИВ»  — нативный <video>, без hls.js и XHR.
    //                      Cookie MediaMTX уходит сама, потому что запрос
    //                      делает сам <video>. Кому: iOS Яндекс.
    //
    //   НАБОР «Н-HLSJS» — hls.js + xhrSetup withCredentials + настройки
    //                      живого эфира (догон края, повторы, буферы).
    //                      Кому: iOS Safari, iOS Chrome, Android MI,
    //                      Android Chrome и всё остальное.
    //
    // Проверено на живом эфире 25.09.2026:
    //   iOS Яндекс     — Н-НАТИВ работает; Н-HLSJS нет
    //   iOS Safari     — Н-HLSJS работал; Н-НАТИВ сломал (0 запросов к /live/)
    //   iOS Chrome     — Н-HLSJS работал; Н-НАТИВ сломал
    //   Android MI     — Н-HLSJS работает
    //   Android Chrome — Н-HLSJS: сегменты шли 200 в 04:56–04:57
    //
    // ⚠️ Нативный путь получает ТОЛЬКО Яндекс на iOS. Выглядит нелогично —
    // движок на iOS у всех один, WebKit — но это факт с устройств, а не теория:
    // у Яндекса своя обёртка над плеером и своё поведение.
    //
    // ⚠️ Имя браузера здесь — ЕДИНСТВЕННЫЙ доступный признак. По возможностям
    // не развести: на iOS все отвечают на canPlayType одинаково, а у Яндекса
    // эта проверка возвращала пустую строку и роняла плеер вовсе. Ловим
    // YaBrowser узко, чтобы не задеть Safari и Chrome, которым нужен hls.js.
    const isYandex = /YaBrowser/i.test(ua)

    // ── НАБОР «Н-НАТИВ»: только iOS Яндекс ──
    if (isIOS && isYandex) {
      playerModeRef.current = 'native'
      video.addEventListener('error', nativeError)
      video.addEventListener('playing', () => { setPlayerStuck(false); setPlayerLoading(false) })
      video.src = rm.hls_url; video.load()
      playWithSound(video).then(ok => setPlayerStuck(!ok))
      return () => {
        destroyed = true
        clearTimeout(retryTimer)
        video.removeEventListener('error', nativeError)
      }
    }

    // ── НАБОР «Н-HLSJS»: iOS Safari, iOS Chrome, Android MI, Android Chrome ──
    // Сюда попадает всё, кроме iOS Яндекса. Настройки ниже — из сборки, где эти
    // браузеры играли: withCredentials (иначе 401 на дочернем плейлисте) +
    // догон живого края + повторы при обрыве мобильной сети + буферы.
    let netErrCount = 0
    import('hls.js').then(({ default: Hls }) => {
      if (destroyed) return
      if (Hls.isSupported()) {
        playerModeRef.current = 'hlsjs'
        const mk = () => {
          // ⚠️⚠️ НАСТРОЙКИ ЖИВОГО ЭФИРА (24.09.2026). Плеер создавался почти
          // без них, и у части зрителей ЗВУК ШЁЛ, А КАРТИНКА ЗАМИРАЛА: при
          // отставании от прямого эфира hls.js сам не догонял поток —
          // аудиодорожка продолжала играть, видео вставало. Сам поток при
          // этом исправен: запись эфира 24.09 — 720p, 30 к/с, ключевой кадр
          // каждые 2 с, дорожки обе на месте (проверено ffprobe).
          const h = new Hls({
            liveDurationInfinity: true,
            lowLatencyMode: false,
            // Догонять эфир, если отстали: без этого зритель «залипает» в
            // прошлом и видео стоит, пока звук идёт.
            liveSyncDurationCount: 3,        // держимся в 3 сегментах от края
            liveMaxLatencyDurationCount: 10, // отстали больше — прыгаем к краю
            // ⚠️ Повторы при обрыве сети: по умолчанию hls.js сдаётся быстро,
            // а на мобильном интернете обрывы — норма. Молчаливая сдача и
            // выглядела как «видео пропало».
            manifestLoadingMaxRetry: 6,
            levelLoadingMaxRetry: 6,
            fragLoadingMaxRetry: 8,
            fragLoadingRetryDelay: 1000,
            // ⚠️⚠️ ТАЙМАУТЫ ЗАГРУЗКИ — ЯВНО (26.09.2026, лог `levelLoadTimeOut`).
            //
            // Число попыток было задано, а сами таймауты — нет, и работал дефолт
            // hls.js в 10 секунд. На Android Chrome это давало ЧЁРНЫЙ ЭКРАН: в
            // логе `WEBINAR-NOVIDEO ... mode=hlsjs err=levelLoadTimeOut`,
            // played=0s — плеер сдавался по таймауту, не успев получить плейлист.
            // Сегменты при этом качались с кодом 200: сервер отдавал, а плеер
            // уже бросил попытку — именно так «видео отдаётся» сочеталось с
            // чёрным экраном у зрителя.
            //
            // ⚠️ 10 секунд мало именно на мобильной сети: плейлист вырос до 15
            // сегментов (запас 30 с против прежних 14), запрос тяжелее, а 4G с
            // задержками — норма для зрителя вебинара, не исключение.
            manifestLoadingTimeOut: 20000,
            levelLoadingTimeOut: 20000,
            fragLoadingTimeOut: 40000,   // сегмент тяжелее плейлиста — время больше
            // ⚠️ Пауза между попытками растёт, но не бесконечно: без предела
            // hls.js уходит в минутные ожидания и зритель считает, что всё умерло.
            levelLoadingRetryDelay: 1000,
            manifestLoadingRetryDelay: 1000,
            // Буфер: больше запас — меньше рывков на нестабильной сети.
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            // ⚠️⚠️ COOKIE ОБЯЗАТЕЛЬНА (25.09.2026, чёрный экран на Android).
            // MediaMTX v1.19 выдаёт зрителю HLS-сессию кукой: на мастер-плейлист
            // отвечает 302 с `Set-Cookie: hlsSession=...`, а дочерний плейлист и
            // сегменты БЕЗ этой куки отдаёт 401. hls.js грузит их через XHR, а
            // XHR по умолчанию куки НЕ посылает — поэтому мастер-плейлист
            // разбирался, плеер стартовал, и на первом же дочернем запросе
            // приходил 401: ни видео, ни звука, чёрный прямоугольник.
            // Проверено на проде: /index.m3u8 → 200, /main_stream.m3u8 → 401.
            // ⚠️ Одного этого флага мало: с куками браузер запрещает
            // `Access-Control-Allow-Origin: *`, а nginx дописывал его ВТОРЫМ
            // заголовком поверх ответа MediaMTX — ответ отбрасывался целиком.
            // Тот add_header убран из `location /live/` и `/hls/`; вернуть его
            // обратно = снова чёрный экран, даже с этим флагом.
            xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = true },
          })
          hlsInstRef.current = h
          h.loadSource(rm.hls_url); h.attachMedia(video)
          h.on(Hls.Events.MANIFEST_PARSED, () =>
            playWithSound(video).then(ok => setPlayerStuck(!ok)))
          // ⚠️ Кадры пошли → снимаем и «зависло», и «идёт загрузка»: это
          // единственный честный признак, что зритель видит картинку.
          h.on(Hls.Events.FRAG_BUFFERED, () => {
            netErrCount = 0; setPlayerStuck(false); setPlayerLoading(false)
          })
          h.on(Hls.Events.ERROR, (_e: any, data: any) => {
            // ⚠️ Запоминаем ошибку для heartbeat — она уедет на сервер и попадёт
            // в лог `WEBINAR-NOVIDEO`. Иначе про поломку у зрителя знать нечем:
            // 25.09 разбирать было не по чему вовсе.
            if (data?.details) {
              playerErrRef.current = String(data.details).slice(0, 80)
                + (data.fatal ? ':fatal' : '')
            }
            // ⚠️⚠️ КАРТИНКА ЗАМЕРЛА, А ЗВУК ИДЁТ → ДОГОНЯЕМ ЭФИР (24.09.2026).
            // Главная жалоба зрителей. hls.js сообщает о вставшем буфере
            // НЕФАТАЛЬНОЙ ошибкой bufferStalledError — а нефатальные мы ниже
            // просто игнорируем, поэтому зритель залипал в прошлом: аудио
            // играет, видео стоит. Прыгаем к живому краю, а не ждём.
            // ⚠️ Проверяем по ИМЕНИ (`data.details`), отдельного события
            // BUFFER_STALLED_ERROR в hls.js нет — на этом упала сборка.
            if (data?.details === 'bufferStalledError') {
              try {
                const edge = h.liveSyncPosition
                if (edge && video.currentTime < edge - 5) video.currentTime = edge
                video.play().catch(() => {})
              } catch {}
              return
            }
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
        // Запасной нативный путь для НЕ-iOS, где hls.js не поддерживается вовсе
        // (iOS ушёл в нативный путь выше, до загрузки hls.js).
        video.addEventListener('error', nativeError)
        video.addEventListener('playing', () => { setPlayerStuck(false); setPlayerLoading(false) })
        video.src = rm.hls_url; video.load()
        playWithSound(video).then(ok => setPlayerStuck(!ok))
      }
    })
    return () => {
      destroyed = true
      clearTimeout(retryTimer)
      video.removeEventListener('error', nativeError)
      hlsInstRef.current = null
      if (hls) { try { hls.destroy() } catch {} }
    }
    // ⚠️ playWithSound намеренно НЕ в зависимостях: он стабилен (useCallback
    // без зависимостей), а лишняя зависимость пересоздавала бы плеер и рвала
    // эфир на ровном месте.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.room?.hls_url, room?.room?.stream_type])

  // ⚠️⚠️ СТОРОЖА «видео молча не играет» ЗДЕСЬ БОЛЬШЕ НЕТ (24.09.2026).
  //
  // Он раз в 2 секунды смотрел `paused`/`readyState` и поднимал кнопку
  // «Смотреть эфир». На проде это дало БЕСКОНЕЧНУЮ ПЕТЛЮ: зритель жмёт
  // кнопку → плеер перезапускается → видео на пару секунд уходит в
  // буферизацию (`readyState < 2`) → сторож снова поднимает кнопку. Нажать
  // и начать смотреть было невозможно.
  //
  // ⚠️ Лечить таймаутом («подождать N секунд после нажатия») — плохо: на
  // медленной сети буферизация дольше любого разумного N, и петля вернётся.
  // Правильный признак «не играет» — СОБЫТИЯ плеера (pause/error/stalled),
  // а не опрос состояния. Они уже обработаны: playWithSound ставит
  // playerStuck при провале play(), а hls.js — при fatal-ошибке. Этого
  // достаточно, лишний опрос только мешал.

  // Ручной перезапуск плеера (кнопка «Обновить видео»): пере-инициализируем hls.js
  // или перезагружаем нативный src. Это то, что раньше делал только F5.
  // ⚠️⚠️ СНИМАЕМ «Видео подгружается…» ПО СОБЫТИЯМ САМОГО ВИДЕО (24.09.2026).
  //
  // Здесь была дыра, из-за которой у части зрителей надпись висела вечно и
  // эфир они не увидели. Раньше индикатор снимали только обработчики ВНУТРИ
  // создания плеера (MANIFEST_PARSED / FRAG_BUFFERED / 'playing'), а плеер
  // создаётся ОДИН РАЗ. Зритель жмёт кнопку → плеер уже существует → эти
  // обработчики не срабатывают заново → снять надпись некому, остаётся только
  // таймер. У кого видео стартовало за 2 секунды, всё равно 12 секунд смотрел
  // на крутилку, а если в этот момент он жал ещё раз — цикл начинался заново.
  //
  // Слушатели висят на самом <video> и живут столько же, сколько страница:
  // играет видео — надписи нет, независимо от того, как оно запустилось.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const done = () => setPlayerLoading(false)
    // playing — пошло воспроизведение; canplay/timeupdate — кадры реально идут
    // (нужны там, где 'playing' не приходит: iOS при возврате из фона).
    v.addEventListener('playing', done)
    v.addEventListener('canplay', done)
    v.addEventListener('timeupdate', done)
    return () => {
      v.removeEventListener('playing', done)
      v.removeEventListener('canplay', done)
      v.removeEventListener('timeupdate', done)
    }
    // ⚠️ Пустые зависимости: хук обязан стоять ВЫШЕ условных return (правило
    // хуков React), а `live` объявляется ниже по файлу. Слушатели вешаются
    // один раз на всю жизнь страницы — этого достаточно, <video> не
    // пересоздаётся.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ⚠️ Страховка на случай, если видео не пошло вовсе: крутилка не должна
  // висеть вечно. 12 с — на медленной сети видео законно грузится долго,
  // ранний возврат кнопки вернул бы карусель нажатий.
  useEffect(() => {
    if (!playerLoading) return
    const t = setTimeout(() => setPlayerLoading(false), 12000)
    return () => clearTimeout(t)
  }, [playerLoading])

  /**
   * Перезагрузка НАТИВНОГО источника — когда буфер обнулился и играть нечего.
   *
   * ⚠️⚠️ Зачем (26.09.2026, iOS Яндекс). Зритель уходит на другую вкладку и
   * возвращается — буфер пуст, видео стоит, чёрный экран. Обновление страницы
   * НЕ помогало: `video.src` уже выставлен, повторного `load()` не происходит,
   * а браузер сам загрузку не возобновляет. В логе — `mode=native played=0s`.
   *
   * ⚠️ Под hls.js НЕ лезем в `src`: у него своя обработка обрыва (startLoad и
   * повторы), а подмена источника рвала бы ему загрузку на ровном месте.
   */
  const reloadNative = useCallback(() => {
    const url = roomRef.current?.room?.hls_url
    const v = videoRef.current
    if (!url || !v || hlsInstRef.current) return
    try { v.src = url; v.load(); v.play().catch(() => {}) } catch {}
  }, [])

  const reloadPlayer = useCallback(() => {
    const rm = roomRef.current?.room
    const video = videoRef.current
    if (!rm?.hls_url || !video) return
    setPlayerStuck(false)
    const inst = hlsInstRef.current
    if (inst) {
      try { inst.stopLoad(); inst.startLoad(); } catch {}
      // ⚠️ Через playWithSound, а не голый play(): кнопку жмёт сам зритель,
      // то есть блокировки автозапуска в этот момент нет — грех не включить
      // звук. Простой play() возвращал бы человека в тишину после каждого
      // перезапуска плеера.
      playWithSound(video)
    } else {
      // нативный (iOS) — просто перезагружаем источник
      video.src = rm.hls_url; video.load()
      playWithSound(video)
    }
  }, [playWithSound])

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
        // ⚠️ Счётчик ТОЛЬКО для организатора (24.09.2026): комната с
        // «Скрывать число зрителей» шлёт его отдельным типом, чтобы
        // зритель цифры не увидел, а ведущий видел зал вживую — раньше
        // ему приходилось обновлять страницу.
        case 'online_private':
          if (roomRef.current?.room?.is_moderator) setOnline(msg.count)
          break
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
      // ⚠️⚠️ ПОЛНЫЙ User-Agent, а не 'mobile'/'desktop' (26.09.2026). После
      // вебинара 25.09, где 71 зритель из 158 не увидел видео, разбирать было
      // нечем: в базе стояло только «mobile», и какая связка ОС+браузер отвалилась
      // — приходилось сопоставлять вручную по логам nginx через IP. Теперь
      // связка видна сразу в одной строке с фактом воспроизведения.
      const device = navigator.userAgent.slice(0, 300)

      // ⚠️⚠️ ФАКТ ВОСПРОИЗВЕДЕНИЯ, а не «страница открыта».
      // Главный урок 25.09: «сегменты отдались с кодом 200» НЕ значит, что
      // человек видит картинку — на Android Chrome сегменты шли по 500 КБ при
      // чёрном экране. Сервер этого знать не может, поэтому признак собираем
      // здесь, у самого <video>, и отправляем вместе с пингом.
      //
      // ⚠️ Смотрим, РАСТЁТ ли currentTime между пингами, а не на отсутствие
      // ошибки: при чёрном экране события 'error' часто нет вовсе — ровно так и
      // выглядела вся история 25.09.
      const v = videoRef.current
      let playing: boolean | null = null
      let played: number | null = null
      if (v) {
        const t = v.currentTime || 0
        // играется = время идёт вперёд И буфер не пуст И плеер не на паузе
        playing = t > (lastTimeRef.current + 0.2) && v.readyState >= 2 && !v.paused
        if (playing) playedRef.current += Math.max(0, t - lastTimeRef.current)
        lastTimeRef.current = t
        played = Math.round(playedRef.current)
      }
      api('/heartbeat', {
        contact_id: contactId, session_key: sessionKey, device,
        playing, played_sec: played,
        player_mode: playerModeRef.current,
        player_error: playerErrRef.current || null,
      })
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

  /**
   * Модерация прямо в чате — доступна только организатору (`is_moderator`
   * считает бэкенд по токену кабинета, подделать нельзя).
   *
   * ⚠️ Эндпоинты существовали давно, но кнопок к ним не было НИГДЕ: удалить
   * сообщение или выгнать человека было физически нечем (19.09.2026).
   *
   * ⚠️⚠️ ХУК СТОИТ ЗДЕСЬ — ДО ВСЕХ `return`, И ПЕРЕНОСИТЬ ЕГО НИЖЕ НЕЛЬЗЯ.
   * Он лежал после ранних `return` («Загрузка…»), и на первой же отрисовке,
   * когда данные ещё не пришли, React видел РАЗНОЕ число хуков и ронял
   * страницу целиком: «Minified React error #310», белый экран у зрителей
   * при полностью исправном сервере (прод, 23.09.2026). Правило React —
   * хуки вызываются всегда и в одном порядке, поэтому любой новый хук в
   * этом компоненте добавлять только ВЫШЕ этой черты.
   */
  const modApi = useCallback(async (path: string) => {
    const tok = typeof localStorage !== 'undefined' ? localStorage.getItem('plusson_token') : null
    if (!tok || !room?.event?.id) return null
    return fetch(`${API_URL}/api/v1/events/${room.event.id}/webinar/${day}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    }).then(r => r.json()).catch(() => null)
  }, [room?.event?.id, day])

  // ─────────── ниже — только рендер, хуки сюда добавлять НЕЛЬЗЯ ───────────
  if (error) return <Centered>{error}</Centered>
  if (!room) return <Centered>Загрузка…</Centered>

  // ⚠️⚠️ ПРОВЕРЯЕМ И `room.room`, а не только `room` (23.09.2026). Ответ
  // приходил успешным, но без самой комнаты — и следующая же строка
  // (`rm.room_state`) роняла страницу с «Application error» на белом экране.
  // Человек при этом видел не «что-то пошло не так», а полностью мёртвую
  // страницу, хотя сервер отвечал 200 и в логах было чисто.
  //
  // Такое возможно, когда комната ещё не создана или её удалили, пока
  // страница была открыта. Показываем понятный экран вместо падения.
  if (!room.room) {
    return (
      <Centered>
        Комната этого дня ещё не настроена.
        <br />
        <span className="text-white/50 text-sm">
          Если эфир вот-вот начнётся — обновите страницу через минуту.
        </span>
      </Centered>
    )
  }

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

  /** Время сообщения в поясе ОРГАНИЗАТОРА, «14:05».
   *
   * ⚠️ Пояс берём с сервера (`room.brand.timezone`), а не у браузера зрителя:
   * эфир идёт по расписанию организатора, и «в 19:00» из анонса должно
   * совпадать со временем в чате. Зритель из другого пояса иначе видит
   * разнобой и решает, что сообщение пришло не тогда (23.09.2026).
   *
   * ⚠️ Битую дату или неизвестный пояс не показываем вовсе — пустая строка
   * лучше, чем «Invalid Date» в ленте.
   */
  function msgTime(at: any): string {
    if (!at) return ''
    try {
      const d = new Date(at)
      if (isNaN(d.getTime())) return ''
      return d.toLocaleTimeString('ru-RU', {
        hour: '2-digit', minute: '2-digit',
        timeZone: room?.brand?.timezone || 'Europe/Moscow',
      })
    } catch { return '' }
  }

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
      // token — только у организатора (он один шлёт ссылки при запрете).
      const r = await api('/chat', {
        contact_id: contactId, session_key: sessionKey, text,
        author_name: authName || undefined,
        token: (typeof localStorage !== 'undefined'
          ? localStorage.getItem('plusson_token') : null) || undefined,
      })
      // ⚠️ Отказ бэкенда (403 «ссылки запрещены») приходит ОБЫЧНЫМ ответом с
      // полем detail: api() не бросает исключение на код ошибки. Без этой
      // ветки запрещённое сообщение висело бы в ленте как отправленное —
      // человек был бы уверен, что его все видят.
      if (r?.detail && !r?.id) {
        setChat(c => c.filter(m => m._tmpId !== tmpId))
        setChatError(String(r.detail))
        setChatText(text)            // текст возвращаем — не заставляем набирать заново
        return
      }
      setChatError('')
      // если бэк вернул id — проставим его локальному сообщению (дедуп по id ниже уберёт дубль из WS)
      if (r?.id) setChat(c => c.map(m => m._tmpId === tmpId ? { ...m, id: r.id, _local: false } : m))
    } catch {
      // не удалось отправить — помечаем ошибкой, не удаляем (человек видит, что не ушло)
      setChat(c => c.map(m => m._tmpId === tmpId ? { ...m, _failed: true } : m))
    }
  }

  async function hideMsg(msgId: number) {
    // Убираем сразу, не дожидаясь ответа: модератор жмёт, когда в чате уже
    // висит то, что видят все, — задержка тут заметна.
    setChat(c => c.filter(m => m.id !== msgId))
    await modApi(`/chat/${msgId}/moderate?status=hidden`)
  }

  async function banAuthor(m: any) {
    const who = m.author_name || 'этого участника'
    if (!confirm(`Удалить ${who} из эфира? Все его сообщения скроются, писать он больше не сможет.`)) return
    const qs = m.contact_id ? `contact_id=${m.contact_id}` : `session_key=${encodeURIComponent(m.session_key || '')}`
    // Скрываем все его сообщения локально — бэкенд делает то же в базе.
    if (m.contact_id) setChat(c => c.filter(x => x.contact_id !== m.contact_id))
    else setChat(c => c.filter(x => x.id !== m.id))
    await modApi(`/participant/remove?${qs}`)
  }

  async function react(speakerId: number, r: 'up' | 'down') {
    const res = await api('/react', { contact_id: contactId, session_key: sessionKey, speaker_id: speakerId, reaction: r })
    // ⚠️ Отмечаем СВОЙ голос, чтобы кнопка перестала звать нажимать дальше.
    // Без отметки при включённом «один голос» кнопка молча не реагировала —
    // человек жал ещё и ещё, считая, что не срабатывает.
    if (res?.ok || res?.already) {
      setMyVotes(v => ({ ...v, [speakerId]: r }))
    }
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

  // ⚠️ Поле ввода вынесено в переменную (23.09.2026): по настройке комнаты
  // оно рисуется НАД лентой или ПОД ней. Копировать разметку в два места
  // нельзя — правка в одном тут же разошлась бы со вторым.
  // ⚠️ Рамка меняет сторону вместе с положением: снизу — верхняя, сверху —
  // нижняя, иначе блок визуально отрывается от ленты.
  const chatInput = (
    rm.chat_enabled ? (
      <div className={`p-3 ${rm.chat_input_on_top ? 'border-b' : 'border-t'} border-white/10 shrink-0`}>
        {/* Причина отказа — над полем, чтобы её увидели сразу: сообщение
            при этом возвращается в поле, набирать заново не нужно. */}
        {chatError && (
          <div className="mb-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-400/30 rounded-lg px-2.5 py-1.5">
            {chatError}
          </div>
        )}
        <div className="flex gap-2">
        <input
          value={chatText}
          onChange={e => { setChatText(e.target.value); if (chatError) setChatError('') }}
          onKeyDown={e => e.key === 'Enter' && sendChat()}
          placeholder={rm.block_links ? 'Написать… (ссылки запрещены)' : 'Написать…'}
          className="flex-1 min-w-0 bg-white/10 rounded-lg px-3 py-2 text-sm outline-none"
        />
        <button onClick={sendChat} aria-label="Отправить"
          className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg text-base font-semibold"
          style={{ background: '#FFCFA4', color: '#0a1520' }}>▶</button>
        </div>
      </div>
    ) : (
      <div className={`p-3 ${rm.chat_input_on_top ? 'border-b' : 'border-t'} border-white/10 text-xs text-white/40 text-center shrink-0`}>Чат отключён</div>
    )
  )

  const cur = room.current_speaker
  const curRx = cur ? (reactions[cur.ec_id] || { up: 0, down: 0 }) : null

  return (
    <div className="min-h-screen text-white overflow-x-hidden" style={{ background: 'linear-gradient(160deg, #0a1520, #142430)' }}>
      {/* Шапка: логотип бренда + название + название вебинара */}
      <header className="border-b border-white/10">
        <div className="max-w-6xl mx-auto px-3 md:px-5 py-3 flex items-center gap-3">
          {room.brand?.logo_url
            ? <img src={room.brand.logo_url} alt="" className="h-8 w-auto object-contain" />
            : null}
          {/* truncate + min-w-0: длинное название бренда иначе распирает
              шапку и страница снова становится шире экрана телефона. */}
          <span className="font-bold tracking-tight truncate min-w-0" style={{ color: '#FFCFA4' }}>
            {room.brand?.name || 'iViSiON: ПЛЮСОН'}
          </span>
          <span className="text-white/40 hidden sm:inline">·</span>
          <span className="text-white/70 text-sm truncate hidden sm:inline">
            {rm.title || room.event?.title}
          </span>
        </div>
      </header>

      {/* ⚠️ `minmax(0,1fr)` вместо `1fr`, и `min-w-0` у колонок (19.09.2026).
          У колонки грида `min-width: auto` по умолчанию — она отказывается
          сжиматься уже своего содержимого. Одна длинная ссылка в чате делала
          страницу шире экрана телефона, и вся вёрстка ерзала влево-вправо при
          прокрутке и наборе. `overflow-x-hidden` — страховка: горизонтальной
          прокрутки у страницы быть не должно ни при каком содержимом. */}
      <div className="max-w-6xl mx-auto p-3 md:p-5 grid md:grid-cols-[minmax(0,1fr),340px] gap-4 overflow-x-hidden">
        {/* видео + блоки. min-w-0 — иначе широкий блок (длинная ссылка в
            продающем блоке, таблица) снова распирает колонку. */}
        <div className="min-w-0">
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
            {/* ⚠️ БЕЗ `controls` — это ПРЯМОЙ ЭФИР (19.09.2026, правило владельца).
                Стандартная панель браузера даёт паузу, перемотку и таймер «6:59»,
                как у записи. Нечаянная пауза в live не останавливает эфир: он
                продолжает идти, а зритель после «play» смотрит с этого же места,
                то есть ПРОШЛОЕ, и не понимает, что отстал от говорящего.
                Своя панель ниже: звук и полный экран, паузы и перемотки нет.
                playsInline + webkit — чтобы на iPhone не открывалось на весь экран. */}
            {live && <video ref={videoRef} autoPlay playsInline
              // ⚠️⚠️ КЛИК ПО ВИДЕО ЗАПУСКАЕТ ЭФИР (23.09.2026). Здесь стояло
              // `e.preventDefault()` — клик гасился вовсе, и «тык по экрану»
              // срабатывал только при случайном попадании МИМО видео. На
              // телефоне это выглядело как «иногда работает, иногда нет».
              // Клик по видео — это и есть то действие пользователя, которого
              // ждёт браузер, чтобы разрешить воспроизведение со звуком.
              onClick={() => { const v = videoRef.current; if (!v) return
                setPlayerLoading(true)
                playWithSound(v).then(ok => { setPlayerStuck(!ok); if (!ok) setPlayerLoading(false) }) }}
              // @ts-ignore — атрибут для старых iOS
              webkit-playsinline="true"
              className="w-full h-full cursor-pointer" />}
            {live && <LiveControls videoRef={videoRef} needUnmute={needUnmute}
                                   onUnmute={unmute} reloadNative={reloadNative} />}
            {live && <span className="absolute top-3 left-3 bg-red-600 text-xs px-2 py-0.5 rounded font-bold">● LIVE</span>}
            {/* ⚠️ Мелкой кнопки «↻ Видео» в углу больше НЕТ (23.09.2026).
                Она работала, но читалась как непонятный значок: надпись
                «Видео» не объясняла, что будет, и промахнуться по ней на
                телефоне было легко. Её работу делают два очевидных пути:
                большая плашка «Смотреть эфир» при любой заминке и клик по
                самому видео. Лишний элемент в углу только путал. */}
            {/* ⚠️⚠️ БОЛЬШАЯ КНОПКА ПОВЕРХ ВИДЕО, а не подпись «нажмите на экран»
                (23.09.2026). На телефоне браузер почти всегда блокирует
                автозапуск, и зритель видел чёрный прямоугольник: догадаться,
                что надо ткнуть, было неоткуда — кнопка «↻ Видео» в углу мелкая
                и читается как «обновить», а не «включить».
                ⚠️ Кликабельна ВСЯ плашка, не только кружок: промахнуться по
                кнопке на телефоне слишком легко. */}
            {/* ⚠️⚠️ ПОКА ГРУЗИТСЯ — «Видео подгружается…», а не кнопка
                (24.09.2026). Видео стартует не мгновенно, и если в эти секунды
                показывать «Смотреть эфир», выглядит, будто нажатие не
                сработало: человек жмёт снова и снова. Крутилка честно говорит,
                что всё идёт, и ждать осталось недолго.
                ⚠️ Плашка загрузки НЕ кликабельна: повторное нажатие рвёт уже
                идущую загрузку и начинает её заново — именно так и получалась
                бесконечная карусель. */}
            {live && playerLoading && (
              <div className="absolute inset-0 w-full h-full flex flex-col items-center justify-center gap-3 bg-black/75 text-center px-6">
                <span className="w-12 h-12 rounded-full border-2 border-white/25 animate-spin"
                  style={{ borderTopColor: '#FFCFA4' }} />
                <span className="text-white font-semibold">Видео подгружается…</span>
                <span className="text-white/50 text-xs">Это занимает пару секунд</span>
              </div>
            )}
            {live && playerStuck && !playerLoading && (
              <button onClick={() => { setPlayerLoading(true); reloadPlayer() }}
                className="absolute inset-0 w-full h-full flex flex-col items-center justify-center gap-3 bg-black/75 text-center px-6 cursor-pointer">
                <span className="w-16 h-16 rounded-full flex items-center justify-center text-2xl shadow-lg"
                  style={{ background: '#FFCFA4', color: '#0a1520' }}>▶</span>
                <span className="text-white font-semibold">Смотреть эфир</span>
                <span className="text-white/50 text-xs">Нажмите, чтобы включить видео и звук</span>
              </button>
            )}
          </div>

          {/* Продающие блоки (не спикерские) — НАД спикером, отделены чертой.
              Подряд идущие кнопки собираются в сетку N в ряд; форма разрывает группу
              и идёт на всю ширину. Порядок = sort_order. */}
          {(() => {
            const per = Math.max(1, Math.min(4, room.room?.buttons_per_row || 1))
            // ⚠️ Новый вид блока надо добавить И СЮДА, и в проверку ниже —
            // иначе он молча не покажется зрителю, хотя в кабинете создан и
            // виден. Блоки «Повысить тариф» и «Лендинг продукта» (миграция 463)
            // ведут себя как обычные кнопки: у них готовый `url` от бэкенда.
            const items = (room.blocks || []).filter((b: any) =>
              b.kind === 'button' || b.kind === 'form' || b.kind === 'event_reg'
              || b.kind === 'tariff_upgrade' || b.kind === 'product_landing')
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
              if (b.kind === 'button' || b.kind === 'event_reg'
                  || b.kind === 'tariff_upgrade' || b.kind === 'product_landing') {
                btnRun.push(b); return
              }
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
                  {/* ⚠️ «В ТГ» / «В МАХ» / «В ВК» без слова «Канал»
                      (23.09.2026): рядом уже стоит «Подписаться:», и
                      «Подписаться: Канал в ТГ» читается коряво. Три
                      кнопки в ряд на телефоне ещё и не помещались. */}
                  <span className="text-xs text-white/50">Подписаться:</span>
                  {cur.channels?.telegram && (
                    <a href={cur.channels.telegram} target="_blank" rel="noreferrer" className="text-xs px-3 py-1.5 rounded-lg font-semibold" style={{ background: '#FFCFA4', color: '#0a1520' }}>В ТГ</a>
                  )}
                  {cur.channels?.max && (
                    <a href={cur.channels.max} target="_blank" rel="noreferrer" className="text-xs px-3 py-1.5 rounded-lg font-semibold" style={{ background: '#FFCFA4', color: '#0a1520' }}>В МАХ</a>
                  )}
                  {cur.channels?.vk && (
                    <a href={cur.channels.vk} target="_blank" rel="noreferrer" className="text-xs px-3 py-1.5 rounded-lg font-semibold" style={{ background: '#FFCFA4', color: '#0a1520' }}>В ВК</a>
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

          {/* Реакции на текущего спикера.
              ⚠️ Свой голос подсвечен золотом, а при «один голос на человека»
              кнопки ещё и блокируются: иначе человек жмёт повторно, ничего не
              меняется, и он считает, что кнопка сломана. Счётчики у КАЖДОГО
              спикера свои — при смене спикера показываются его цифры, чужие
              не переносятся. */}
          {/* ⚠️ Обе реакции выключены → блока НЕТ вовсе (23.09.2026).
              Раньше выключался только «палец вниз», и оставалась одинокая
              кнопка «Огонь», убрать которую было нечем.
              ⚠️ `!== false`, а не `?? true`: у старых комнат поле может не
              прийти вовсе, и реакции должны остаться как были. */}
          {cur && (rm.show_up_reaction !== false || rm.show_down_reaction) && (() => {
            const voted = myVotes[cur.ec_id]
            const lock = !!rm.one_vote_per_person && !!voted
            const cls = (active: boolean) =>
              `flex-1 rounded-xl py-2.5 text-sm font-semibold transition ${
                active ? 'ring-1' : 'bg-white/10'
              } ${lock ? 'opacity-70 cursor-default' : 'hover:bg-white/20'}`
            return (
            <div className="mt-2 flex gap-2">
              {rm.show_up_reaction !== false && (
                <button onClick={() => !lock && react(cur.ec_id, 'up')} disabled={lock}
                  className={cls(voted === 'up')}
                  style={voted === 'up' ? { background: 'rgba(255,207,164,0.22)', color: '#FFCFA4' } : undefined}>
                  🔥 {rm.reaction_up_label} · {curRx?.up || 0}
                </button>
              )}
              {rm.show_down_reaction && (
                <button onClick={() => !lock && react(cur.ec_id, 'down')} disabled={lock}
                  className={cls(voted === 'down')}
                  style={voted === 'down' ? { background: 'rgba(255,207,164,0.22)', color: '#FFCFA4' } : undefined}>
                  👎 {rm.reaction_down_label} · {curRx?.down || 0}
                </button>
              )}
            </div>
            )
          })()}

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
                      {battle.show_up_reaction !== false && <button onClick={() => voteBattle(pl.id, 'up')} className="px-2 py-1 rounded bg-white/10 text-xs">🔥 {pl.up_count}</button>}
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
        {/* ⚠️ ВЫСОТА НА МОБИЛЬНОМ — `100dvh` минус отступ, а НЕ `70vh`
            (правило владельца, 19.09.2026). При 70vh поле ввода оказывалось
            ниже видимой области: человек не понимал, что надо мотать вниз, и
            не мог написать в чат вовсе.
            ⚠️ Именно `dvh`, а не `vh`: на телефоне адресная строка браузера
            то появляется, то исчезает, и `vh` считается по БОЛЬШЕЙ высоте —
            поле снова уезжало бы под панель браузера. `dvh` меняется вместе
            с ней. Для старых браузеров рядом оставлен `vh` как запасной. */}
        {/* ⚠️ НА КОМПЬЮТЕРЕ высота считается от `dvh` с запасом 6rem, а не
            `100vh-2.5rem` (19.09.2026). При 2.5rem колонка упиралась в самый
            низ окна, и поле ввода наполовину срезалось доком macOS / панелью
            браузера — написать в чат было нельзя, не свернув док. Запас 6rem
            держит ввод выше края. `dvh` и здесь: на ноутбуке окно тоже меняет
            высоту, а `vh` считается по большей. */}
        <div className="min-w-0 rounded-xl bg-white/5 flex flex-col overflow-hidden h-[85vh] h-[calc(100dvh-7rem)] md:h-[calc(100dvh-6rem)] md:sticky md:top-4">
          <div className="p-3 border-b border-white/10 font-semibold text-sm shrink-0">Чат</div>
          {/* ⚠️ `scroll-brand`, а не `scroll-visible`: второй серый и на тёмном
              фоне комнаты читается как чёрная полоса — человек не видит, что
              лента вообще прокручивается (19.09.2026). */}
          {/* ⚠️ Поле ввода НАД лентой — по настройке комнаты
              (23.09.2026): на длинном эфире лента уезжает вниз, и
              искать поле глазами каждый раз неудобно. */}
          {rm.chat_input_on_top && chatInput}
          <div ref={chatBoxRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 text-sm scroll-brand">
            {chat.map((m, i) => (
              <div key={m.id ?? m._tmpId ?? i}
                   className={`group ${m._failed ? 'opacity-50' : ''}`}>
                {/* Кнопки модерации — только организатору и только у чужих
                    сообщений, уже сохранённых (у локальных ещё нет id).
                    ⚠️ Появляются по наведению: висеть у каждой строки они не
                    должны, чат и так узкий. */}
                {room.is_moderator && m.id && (
                  <span className="float-right opacity-0 group-hover:opacity-100 transition flex gap-1 ml-2">
                    <button onClick={() => hideMsg(m.id)} title="Удалить сообщение"
                      className="text-white/40 hover:text-red-400 text-xs px-1">✕</button>
                    <button onClick={() => banAuthor(m)} title="Удалить из эфира"
                      className="text-white/40 hover:text-red-400 text-xs px-1">🚫</button>
                  </span>
                )}
                {/* ⚠️ Время — перед именем и приглушённее: в ленте важнее
                    кто и что сказал, а время нужно «на глаз». */}
                {msgTime(m.at) && (
                  <span className="text-white/30 mr-1 text-xs tabular-nums">{msgTime(m.at)}</span>
                )}
                <span className="text-white/50 mr-1">{m.author_name || 'Гость'}:</span>
                {/* ⚠️ `break-all`, а не только `break-words` (19.09.2026):
                    `break-words` переносит ПО ПРОБЕЛАМ и бессилен против
                    длинной ссылки или слова с подчёркиваниями
                    (`#вопрос_от_клиента`, `HTTPS://…`). Такое «слово» распирало
                    колонку чата, страница становилась шире экрана телефона и
                    ерзала влево-вправо при каждой прокрутке и наборе текста. */}
                <span className="break-all"><ChatText text={m.text} /></span>
                {m._failed && <span className="text-red-400 text-xs ml-1">· не отправлено</span>}
              </div>
            ))}
            {!chat.length && <div className="text-white/40 text-center py-8">Сообщений пока нет</div>}
          </div>
          {!rm.chat_input_on_top && chatInput}
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
/**
 * Текст сообщения чата со ССЫЛКАМИ-КНОПКАМИ.
 *
 * ⚠️ Раньше ссылка была просто текстом: её нельзя было открыть, только
 * выделить и скопировать — а организатор кидает в чат ссылку на оплату, и
 * некликабельная ссылка там бесполезна (19.09.2026).
 *
 * ⚠️ Вставляем ТОЛЬКО через <a> с текстом ссылки, без dangerouslySetInnerHTML:
 * текст пишут зрители, и любая вставка их HTML в разметку — дыра, через
 * которую в чужой браузер попадает чужой скрипт.
 *
 * ⚠️ `rel="noopener noreferrer"` обязателен: без `noopener` открытая страница
 * получает доступ к нашей вкладке через `window.opener` и может её подменить.
 */
function ChatText({ text }: { text: string }) {
  const parts: React.ReactNode[] = []
  // Схема, www. и голый домен — ровно то же, что бэкенд считает ссылкой
  // (has_link в webinar_public.py); расходиться им нельзя, иначе получим
  // «отправить нельзя, а подсветить нечего» или наоборот.
  const re = /((?:https?:\/\/|www\.)[^\s]+|[a-zA-Zа-яА-Я0-9][-a-zA-Zа-яА-Я0-9]*\.(?:ru|рф|com|net|org|io|me|tv|cc|biz|info|online|site|store|shop|club|live|link|bio|app|dev|ai|co|us|uk|de|kz|by|ua|su|pro|top)(?:\/[^\s]*)?)/gi
  let last = 0
  for (const m of (text || '').matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) parts.push(text.slice(last, i))
    const raw = m[0]
    // Хвостовая пунктуация — часть предложения, а не адреса: «зайди на
    // site.ru.» иначе открывало бы ссылку с точкой на конце.
    const clean = raw.replace(/[.,!?;:)]+$/, '')
    const tail = raw.slice(clean.length)
    const href = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
    parts.push(
      <a key={`${i}-${clean}`} href={href} target="_blank" rel="noopener noreferrer"
         className="underline hover:no-underline" style={{ color: '#FFCFA4' }}>
        {clean}
      </a>
    )
    if (tail) parts.push(tail)
    last = i + raw.length
  }
  if (last < (text || '').length) parts.push(text.slice(last))
  return <>{parts}</>
}

/**
 * Панель управления ПРЯМЫМ эфиром: звук и полный экран. Паузы и перемотки нет.
 *
 * ⚠️ Почему не штатные `controls` браузера (правило владельца, 19.09.2026):
 * они показывают полосу перемотки и таймер, как у записи. В live пауза эфир
 * не останавливает — он продолжает идти; после «play» зритель смотрит ПРОШЛОЕ
 * и не понимает, почему говорящий отвечает не на то. Поэтому паузы у зрителя
 * нет вовсе, а если отставание всё же возникло (свернул вкладку, подвисла
 * сеть) — плеер сам догоняет живой край.
 */
function LiveControls({ videoRef, needUnmute, onUnmute, reloadNative }: {
  videoRef: React.RefObject<HTMLVideoElement>
  needUnmute: boolean
  onUnmute: () => void
  // ⚠️ Перезагрузка нативного источника — приходит из родителя, потому что
  // hlsInstRef и roomRef живут там, а этот компонент их не видит.
  // Нужна при возврате с другой вкладки на iOS Яндексе: буфер обнуляется, и
  // без повторного load() остаётся чёрный экран (см. catchUp ниже).
  reloadNative: () => void
}) {
  const [muted, setMuted] = useState(true)
  const [full, setFull] = useState(false)

  // Держим иконку в согласии с реальным состоянием видео: звук могли включить
  // кнопкой «Включить звук», клавишей или из системного меню.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const sync = () => setMuted(v.muted || v.volume === 0)
    sync()
    v.addEventListener('volumechange', sync)
    return () => v.removeEventListener('volumechange', sync)
  }, [videoRef])

  /**
   * Возврат к живому краю.
   *
   * ⚠️ Пауза у зрителя убрана, но отстать всё равно можно: вкладку свернули,
   * сеть подвисла, телефон заснул — браузер сам останавливает видео. Поэтому
   * раз в 5 секунд проверяем, далеко ли мы от конца буфера, и подматываем.
   * Порог 6 секунд: длина HLS-сегмента + запас, иначе дёргали бы картинку на
   * ровном месте при обычном джиттере сети.
   */
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const catchUp = () => {
      try {
        // ⚠️⚠️ ПУСТОЙ БУФЕР → ПЕРЕЗАГРУЖАЕМ ИСТОЧНИК (26.09.2026, iOS Яндекс).
        //
        // Здесь стоял `if (!v.buffered.length) return` — и это была дыра: на
        // iOS Яндексе после возврата с другой вкладки буфер ОБНУЛЯЕТСЯ, а
        // подматывать нечего, поэтому функция молча выходила. Зритель видел
        // чёрный экран, и обновление страницы не спасало: `video.src` уже
        // выставлен, повторного `load()` не происходит, а браузер сам загрузку
        // не возобновляет. В логе это выглядело как `mode=native played=0s`.
        //
        // ⚠️ Только для нативного пути: у hls.js своя обработка обрыва
        // (startLoad и повторы), дёргать `src` под ним — рвать ему загрузку.
        if (!v.buffered.length) {
          if (v.readyState < 2) reloadNative()
          return
        }
        const edge = v.buffered.end(v.buffered.length - 1)
        if (edge - v.currentTime > 6) v.currentTime = edge - 0.5
        if (v.paused) v.play().catch(() => {})
      } catch {}
    }
    const t = setInterval(catchUp, 5000)
    // Вернулись во вкладку — догоняем сразу, не дожидаясь тика таймера.
    const onVis = () => { if (!document.hidden) catchUp() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [videoRef])

  const toggleSound = () => {
    const v = videoRef.current
    if (!v) return
    if (v.muted || v.volume === 0) { onUnmute() } else { v.muted = true }
  }

  const toggleFull = () => {
    const box = videoRef.current?.parentElement
    if (!box) return
    if (document.fullscreenElement) { document.exitFullscreen?.(); setFull(false) }
    // iOS Safari не умеет fullscreen на div — там просим сам <video>.
    else if (box.requestFullscreen) { box.requestFullscreen(); setFull(true) }
    else (videoRef.current as any)?.webkitEnterFullscreen?.()
  }

  return (
    <>
      {/* Браузер не дал автозапуск со звуком — крупная кнопка ПО ЦЕНТРУ, видна
          сразу. ⚠️ Она включает звук и запускает видео ОДНИМ нажатием: зритель
          жмёт «плей» и ждёт, что сразу услышит, а не пойдёт потом искать звук
          (правило владельца, 19.09.2026). Маленькую иконку в углу, которая
          появляется по наведению, человек не находит — пока целится, промах
          попадает по видео и ставит его на паузу. Поэтому: затемняем весь
          кадр и даём одну большую цель во всю площадь. */}
      {needUnmute && (
        <button onClick={onUnmute} aria-label="Смотреть со звуком"
          className="absolute inset-0 w-full h-full flex flex-col items-center justify-center gap-3 bg-black/45">
          <span className="w-16 h-16 rounded-full flex items-center justify-center text-2xl shadow-lg"
                style={{ background: '#FFCFA4', color: '#0a1520' }}>▶</span>
          <span className="text-white font-semibold text-sm drop-shadow">
            Смотреть со звуком
          </span>
        </button>
      )}
      <div className="absolute bottom-3 right-3 flex items-center gap-2">
        <button onClick={toggleSound} aria-label={muted ? 'Включить звук' : 'Выключить звук'}
          title={muted ? 'Включить звук' : 'Выключить звук'}
          className="bg-black/50 hover:bg-black/70 text-white w-9 h-9 rounded-lg flex items-center justify-center text-base">
          {muted ? '🔇' : '🔊'}
        </button>
        <button onClick={toggleFull} aria-label="Во весь экран" title="Во весь экран"
          className="bg-black/50 hover:bg-black/70 text-white w-9 h-9 rounded-lg flex items-center justify-center text-base">
          {full ? '✕' : '⛶'}
        </button>
      </div>
    </>
  )
}

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
