'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

const STEPS = [5, 10, 20, 40, 60]

// линии графика: ключ в series → подпись + цвет + видимость по умолчанию
const LINES = [
  { key: 'uniq',       label: 'Уникальные',    color: '#3a78c9', on: true },
  { key: 'active',     label: 'Активные',      color: '#e07a5f', on: true },
  { key: 'engaged',    label: 'Вовлечённые',   color: '#5aa469', on: true },
  { key: 'new',        label: 'Новые',         color: '#5bc0de', on: false },
  { key: 'authorized', label: 'Авторизованные', color: '#b06ac9', on: false },
]

export default function WebinarAnalytics({ eventId, day }: { eventId: number; day: number }) {
  const [step, setStep] = useState(5)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [viewers, setViewers] = useState<any[]>([])
  const [showViewers, setShowViewers] = useState(false)
  // ⚠️ Реакции по спикерам — ИТОГ эфира (24.09.2026). Раньше их было не
  // видно нигде: цифры копились в базе, а экрана не было. В таблице
  // зрителей есть колонка «реакции», но это «кто сколько ПОСТАВИЛ», а
  // организатору нужно «кто сколько СОБРАЛ».
  const [rx, setRx] = useState<any>(null)
  const [sessions, setSessions] = useState<any[]>([])
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [visible, setVisible] = useState<Record<string, boolean>>(
    Object.fromEntries(LINES.map(l => [l.key, l.on])))
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // список запусков
  useEffect(() => {
    api.webinar.sessions(eventId, day).then(r => setSessions(r.sessions || [])).catch(() => {})
  }, [eventId, day])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.webinar.analytics(eventId, day, step, sessionId)
      setData(res)
    } finally { setLoading(false) }
  }, [eventId, day, step, sessionId])

  useEffect(() => { load() }, [load])
  // Реакции спикеров — одним запросом, тем же, что кормит пульт ведущего.
  // ⚠️ Ошибку глотаем: аналитика не должна падать из-за побочного блока.
  useEffect(() => {
    // ⚠️ С sessionId: у каждой записи свои реакции. Без него показывалась
    // сумма за ВСЕ запуски — одни и те же цифры под каждой записью.
    api.webinar.liveStats(eventId, day, sessionId).then(setRx).catch(() => {})
  }, [eventId, day, sessionId])

  useEffect(() => {
    setViewers([])
    if (showViewers) api.webinar.viewers(eventId, day, sessionId).then(r => setViewers(r.viewers || [])).catch(() => {})
  }, [showViewers, eventId, day, sessionId])

  // геометрия графика (общая для рисования и hover)
  const geom = useCallback(() => {
    const c = canvasRef.current
    const presence = data?.presence || []
    const W = c?.width || 860, H = c?.height || 300
    const padL = 40, padR = 12, padT = 14, padB = 34
    const plotW = W - padL - padR, plotH = H - padT - padB
    const n = presence.length
    let maxV = 1
    for (const p of presence) for (const l of LINES) if (visible[l.key]) maxV = Math.max(maxV, p[l.key] || 0)
    const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
    const y = (v: number) => padT + plotH - (v / maxV) * plotH
    return { W, H, padL, padR, padT, padB, plotW, plotH, n, maxV, x, y, presence }
  }, [data, visible])

  useEffect(() => {
    const c = canvasRef.current
    if (!c || !data) return
    const ctx = c.getContext('2d')!
    const g = geom()
    ctx.clearRect(0, 0, g.W, g.H)

    // горизонтальная сетка + подписи Y
    ctx.strokeStyle = '#eceff3'; ctx.fillStyle = '#9aa5b1'; ctx.font = '10px Roboto, sans-serif'; ctx.lineWidth = 1
    for (let k = 0; k <= 4; k++) {
      const yy = g.padT + (k / 4) * g.plotH
      ctx.beginPath(); ctx.moveTo(g.padL, yy); ctx.lineTo(g.W - g.padR, yy); ctx.stroke()
      ctx.fillText(String(Math.round(g.maxV * (1 - k / 4))), 6, yy + 3)
    }
    // ось X — метки времени
    ctx.fillStyle = '#9aa5b1'; ctx.textAlign = 'center'
    const labelEvery = Math.max(1, Math.ceil(g.n / 8))
    g.presence.forEach((p: any, i: number) => {
      if (i % labelEvery !== 0) return
      const t = new Date(p.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
      ctx.fillText(t, g.x(i), g.H - 8)
    })
    ctx.textAlign = 'left'

    // линии
    for (const l of LINES) {
      if (!visible[l.key]) continue
      ctx.beginPath()
      g.presence.forEach((p: any, i: number) => {
        const yy = g.y(p[l.key] || 0)
        i ? ctx.lineTo(g.x(i), yy) : ctx.moveTo(g.x(i), yy)
      })
      ctx.strokeStyle = l.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke()
    }

    // вертикальная линия под курсором + точки
    if (hover && g.presence[hover.i]) {
      const hx = g.x(hover.i)
      ctx.strokeStyle = 'rgba(120,120,120,.4)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(hx, g.padT); ctx.lineTo(hx, g.padT + g.plotH); ctx.stroke()
      ctx.setLineDash([])
      for (const l of LINES) {
        if (!visible[l.key]) continue
        const v = g.presence[hover.i][l.key] || 0
        ctx.beginPath(); ctx.arc(hx, g.y(v), 3.5, 0, 7); ctx.fillStyle = l.color; ctx.fill()
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
      }
    }
  }, [data, visible, hover, geom])

  function onMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!
    const rect = c.getBoundingClientRect()
    const px = (e.clientX - rect.left) * (c.width / rect.width)
    const g = geom()
    if (g.n === 0) return
    let best = 0, bd = Infinity
    for (let i = 0; i < g.n; i++) { const d = Math.abs(g.x(i) - px); if (d < bd) { bd = d; best = i } }
    setHover({ x: px, i: best })
  }

  if (loading && !data) return <div className="py-12 flex justify-center"><Spinner /></div>
  if (!data) return null
  const m = data.metrics || {}
  const hp = hover && data.presence?.[hover.i]

  return (
    <div>
      {/* селектор запуска эфира (сессии) — показываем всегда */}
      <div className="mb-4 flex items-center gap-2 flex-wrap">
        <span className="text-sm text-gray-600">Запуск эфира:</span>
        {sessions.length > 0 ? (
          <select className="input max-w-md" value={sessionId ?? ''} onChange={e => setSessionId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Все запуски (весь день)</option>
            {sessions.map((s: any) => {
              const t = (d: string) => d ? new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : 'идёт'
              return <option key={s.id} value={s.id}>{t(s.started_at)} – {t(s.ended_at)} · {s.unique_viewers} зрит.</option>
            })}
          </select>
        ) : (
          <span className="text-sm text-gray-400">эфир ещё не запускали — появится после первого «Начать эфир»</span>
        )}
      </div>

      {/* метрики */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Tile label="Всего уникальных" value={m.total_unique} />
        <Tile label="Комментариев" value={m.comments} />
        <Tile label="Кликов" value={m.clicks} sub={`заказы ${m.orders} · оплаты ${m.payments}`} />
        <Tile label="Пик онлайн" value={m.peak_online} sub={m.peak_at ? new Date(m.peak_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) + ' МСК' : ''} />
      </div>

      {/* шаг + вовлечённость */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-xs text-gray-500">Шаг:</span>
        {STEPS.map(s => (
          <button key={s} onClick={() => setStep(s)} className={`text-sm px-2.5 py-1 rounded-lg ${step === s ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600'}`}>{s} мин</button>
        ))}
        <span className="ml-auto text-xs text-gray-500">Вовлечённость: <b>{m.engagement_pct}%</b></span>
      </div>

      {/* чекбоксы линий */}
      <div className="flex flex-wrap gap-3 mb-2">
        {LINES.map(l => (
          <label key={l.key} className="flex items-center gap-1.5 text-sm cursor-pointer">
            <input type="checkbox" checked={visible[l.key]} onChange={e => setVisible({ ...visible, [l.key]: e.target.checked })} />
            <i className="w-3 h-3 rounded-sm inline-block" style={{ background: l.color }} />
            {l.label}
          </label>
        ))}
      </div>

      {/* график */}
      <div className="border rounded-xl p-3 bg-white relative overflow-x-auto">
        <canvas ref={canvasRef} width={860} height={300} style={{ width: '100%', height: 'auto', display: 'block' }}
          onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        {hp && (
          <div className="absolute bg-[#0a1520] text-white text-xs rounded-lg px-3 py-2 pointer-events-none shadow-lg"
            style={{ left: Math.min(Math.max(hover!.x / (canvasRef.current!.width) * 100, 5), 80) + '%', top: 8 }}>
            <div className="font-semibold mb-1">{new Date(hp.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })} МСК</div>
            {LINES.filter(l => visible[l.key]).map(l => (
              <div key={l.key} className="flex items-center gap-1.5">
                <i className="w-2 h-2 rounded-sm inline-block" style={{ background: l.color }} />
                {l.label}: <b>{hp[l.key] || 0}</b>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* активность зрителей */}
      <button onClick={() => setShowViewers(v => !v)} className="mt-4 text-sm text-brand">
        {showViewers ? '▾' : '▸'} Активность по зрителям (для игровых механик)
      </button>
      {showViewers && (
        <div className="mt-3 border rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="text-left px-3 py-2">Зритель</th>
                <th className="px-3 py-2">Сообщения</th><th className="px-3 py-2">Реакции</th>
                <th className="px-3 py-2">Клики</th><th className="px-3 py-2">Опросы</th><th className="px-3 py-2">Всего</th>
              </tr>
            </thead>
            <tbody>
              {viewers.map((v: any) => (
                <tr key={v.contact_id} className="border-t">
                  <td className="px-3 py-2">{v.name || `#${v.contact_id}`}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{v.messages}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{v.reactions}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{v.clicks}</td>
                  <td className="px-3 py-2 text-center tabular-nums">{v.poll_votes}</td>
                  <td className="px-3 py-2 text-center font-semibold tabular-nums">{v.total}</td>
                </tr>
              ))}
              {!viewers.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">Пока нет активности.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* ⚠️ ИТОГ ПО РЕАКЦИЯМ — внизу, после всех графиков: это не метрика
          эфира, а результат СПИКЕРОВ, за ним приходят отдельно.
          ⚠️ Не путать с колонкой «реакции» в таблице зрителей выше: там «кто
          сколько ПОСТАВИЛ», здесь — «кто сколько СОБРАЛ».
          ⚠️ Раньше показывался только счёт баттла, а баттл бывает редко —
          обычные реакции спикеров не было видно нигде. */}
      <div className="border rounded-xl p-4 mt-4">
        <h4 className="font-semibold mb-3">🔥 Реакции у спикеров</h4>
        {!rx ? (
          <p className="text-sm text-gray-400">Загружаем…</p>
        ) : !rx.reactions_enabled ? (
          <p className="text-sm text-gray-500">
            Реакции не считаются — включите их в настройках комнаты.
          </p>
        ) : !(rx.reactions || []).length ? (
          <p className="text-sm text-gray-500">За этот эфир реакций не ставили.</p>
        ) : (
          <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
            {rx.reactions.map((r: any, i: number) => (
              <div key={i} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="text-gray-800 truncate">
                  <span className="text-gray-400 tabular-nums mr-2">{i + 1}.</span>
                  {r.speaker_name}
                </span>
                <span className="shrink-0 flex gap-4 tabular-nums">
                  {r.up > 0 && <span title={rx.reaction_up_label}>🔥 {r.up}</span>}
                  {r.down > 0 && <span title={rx.reaction_down_label}>👎 {r.down}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, sub }: { label: string; value: any; sub?: string }) {
  return (
    <div className="border rounded-xl p-3 bg-gray-50/50">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-extrabold mt-1 tabular-nums">{value ?? 0}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}
