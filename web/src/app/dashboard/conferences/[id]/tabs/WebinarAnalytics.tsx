'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

const STEPS = [5, 10, 20, 40, 60]

export default function WebinarAnalytics({ eventId, day }: { eventId: number; day: number }) {
  const [step, setStep] = useState(5)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [viewers, setViewers] = useState<any[]>([])
  const [showViewers, setShowViewers] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.webinar.analytics(eventId, day, step)
      setData(res)
    } finally { setLoading(false) }
  }, [eventId, day, step])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (showViewers && !viewers.length) {
      api.webinar.viewers(eventId, day).then(r => setViewers(r.viewers || [])).catch(() => {})
    }
  }, [showViewers, viewers.length, eventId, day])

  // рисуем график присутствия
  useEffect(() => {
    const c = canvasRef.current
    if (!c || !data) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const presence = data.presence || []
    const activity = data.activity || {}
    const W = c.width, H = c.height, padL = 8, padR = 8, padT = 14, padB = 26
    const plotW = W - padL - padR, plotH = H - padT - padB
    const n = presence.length
    const maxV = Math.max(1, ...presence.map((p: any) => p.uniq))
    const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
    const y = (v: number) => padT + plotH - (v / maxV) * plotH

    ctx.clearRect(0, 0, W, H)
    // сетка
    ctx.strokeStyle = '#eceff3'; ctx.lineWidth = 1
    for (let g = 0; g <= 4; g++) {
      const yy = padT + (g / 4) * plotH
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke()
    }
    if (n) {
      // area
      ctx.beginPath()
      presence.forEach((p: any, i: number) => i ? ctx.lineTo(x(i), y(p.uniq)) : ctx.moveTo(x(i), y(p.uniq)))
      ctx.lineTo(x(n - 1), padT + plotH); ctx.lineTo(x(0), padT + plotH); ctx.closePath()
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH)
      grad.addColorStop(0, 'rgba(37,69,93,.22)'); grad.addColorStop(1, 'rgba(37,69,93,0)')
      ctx.fillStyle = grad; ctx.fill()
      // line
      ctx.beginPath()
      presence.forEach((p: any, i: number) => i ? ctx.lineTo(x(i), y(p.uniq)) : ctx.moveTo(x(i), y(p.uniq)))
      ctx.strokeStyle = '#25455D'; ctx.lineWidth = 2.4; ctx.lineJoin = 'round'; ctx.stroke()
      // точки активности (клики=золото, оплаты=красный)
      presence.forEach((p: any, i: number) => {
        const a = activity[p.at] || {}
        if (a.click) { ctx.beginPath(); ctx.arc(x(i), y(p.uniq), 3.5, 0, 7); ctx.fillStyle = '#d98a3d'; ctx.fill() }
        if (a.payment || a.order) { ctx.beginPath(); ctx.arc(x(i), y(p.uniq) - 7, 3.5, 0, 7); ctx.fillStyle = '#c0392b'; ctx.fill() }
      })
    }
  }, [data])

  if (loading && !data) return <div className="py-12 flex justify-center"><Spinner /></div>
  if (!data) return null

  const m = data.metrics || {}

  return (
    <div>
      {/* метрики */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Tile label="Всего уникальных" value={m.total_unique} />
        <Tile label="Пик онлайн" value={m.peak_online} sub={m.peak_at ? new Date(m.peak_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) + ' МСК' : ''} />
        <Tile label="Комментариев" value={m.comments} />
        <Tile label="Кликов" value={m.clicks} sub={`заказы ${m.orders} · оплаты ${m.payments}`} />
      </div>

      {/* переключатель шага */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs text-gray-500">Шаг:</span>
        {STEPS.map(s => (
          <button key={s} onClick={() => setStep(s)}
            className={`text-sm px-2.5 py-1 rounded-lg ${step === s ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600'}`}>
            {s} мин
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-500">Вовлечённость: <b>{m.engagement_pct}%</b></span>
      </div>

      {/* график */}
      <div className="border rounded-xl p-3 bg-white overflow-x-auto">
        <canvas ref={canvasRef} width={860} height={260} style={{ width: '100%', height: 'auto', display: 'block' }} />
        <div className="flex flex-wrap gap-4 mt-2 text-xs text-gray-500">
          <span className="flex items-center gap-1.5"><i className="w-3 h-3 rounded-sm inline-block" style={{ background: '#25455D' }} /> Уникальные онлайн</span>
          <span className="flex items-center gap-1.5"><i className="w-3 h-3 rounded-sm inline-block" style={{ background: '#d98a3d' }} /> Клики</span>
          <span className="flex items-center gap-1.5"><i className="w-3 h-3 rounded-sm inline-block" style={{ background: '#c0392b' }} /> Оплаты/заказы</span>
        </div>
      </div>

      {/* активность зрителей */}
      <button onClick={() => setShowViewers(v => !v)} className="mt-4 text-sm text-brand">
        {showViewers ? '▾' : '▸'} Активность по зрителям (для игровых механик)
      </button>
      {showViewers && (
        <div className="mt-3 border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs">
                <tr>
                  <th className="text-left px-3 py-2">Зритель</th>
                  <th className="px-3 py-2">Сообщения</th>
                  <th className="px-3 py-2">Реакции</th>
                  <th className="px-3 py-2">Клики</th>
                  <th className="px-3 py-2">Опросы</th>
                  <th className="px-3 py-2">Всего</th>
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
        </div>
      )}
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
