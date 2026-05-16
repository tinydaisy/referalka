'use client'
import { useEffect, useState, useMemo } from 'react'
import { BarChart2, Users, Vote, Gift, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

interface Participant {
  id: number
  is_registered: boolean
  link_clicked_at: string | null
  referrer_ref_code: string | null
  referrer_name: string | null
  referrer_username: string | null
}

interface TopRow {
  refCode: string
  name: string
  username: string | null
  count: number
  registered: number
  clicked: number
}

const PEACH = '#FFCFA4'
const DARK  = '#25455D'

export default function ContestReportTab({ eventId }: { eventId: number }) {
  const [participants, setParticipants] = useState<Participant[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true); setErr(null)
    api.events.participants(eventId, 'all')
      .then((r: any) => setParticipants(r.participants || []))
      .catch((e: any) => setErr(e.message || 'Не получилось загрузить'))
      .finally(() => setLoading(false))
  }, [eventId])

  const stats = useMemo(() => {
    const total = participants.length
    const registered = participants.filter(p => p.is_registered).length
    const clicked = participants.filter(p => !!p.link_clicked_at).length
    return { total, registered, clicked }
  }, [participants])

  const top: TopRow[] = useMemo(() => {
    const map = new Map<string, TopRow>()
    for (const p of participants) {
      const code = p.referrer_ref_code
      if (!code) continue
      const cur = map.get(code) || {
        refCode: code,
        name: p.referrer_name || (p.referrer_username ? `@${p.referrer_username.replace(/^@+/, '')}` : `код ${code}`),
        username: p.referrer_username,
        count: 0,
        registered: 0,
        clicked: 0,
      }
      cur.count++
      if (p.is_registered) cur.registered++
      if (p.link_clicked_at)  cur.clicked++
      map.set(code, cur)
    }
    return Array.from(map.values())
      .sort((a, b) => b.clicked - a.clicked || b.registered - a.registered || b.count - a.count)
      .slice(0, 20)
  }, [participants])

  if (loading) {
    return <div className="flex justify-center py-12"><Spinner className="text-brand text-2xl" /></div>
  }
  if (err) {
    return <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{err}</div>
  }
  if (stats.total === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-12 text-center">
        <BarChart2 className="mx-auto mb-3 text-gray-300" size={32} />
        <p className="text-gray-500 text-sm">Пока нет данных — ждём первых голосующих.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 4 счётчика */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard icon={<Users size={18} />} label="Перешли по ссылке" value={stats.total} accent="dark" />
        <StatCard icon={<CheckCircle2 size={18} />} label="Зарегистрировались" value={stats.registered} sub={pct(stats.registered, stats.total)} accent="dark" />
        <StatCard icon={<Vote size={18} />} label="Проголосовали" value={stats.clicked} sub={pct(stats.clicked, stats.registered)} accent="peach" />
      </div>

      {/* ТОП партнёров */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/60">
          <div className="text-sm font-semibold" style={{ color: DARK }}>
            🏆 ТОП партнёров — кто привёл голосующих
          </div>
          <div className="text-xs text-gray-400 mt-0.5">
            Сортировка: проголосовавшие → зарегистрированные → переходы.
          </div>
        </div>
        {top.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-400">
            Партнёры ещё не привели ни одного голосующего.
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            <div className="hidden sm:flex items-center gap-3 px-5 py-2 text-[11px] uppercase tracking-wider text-gray-400 font-medium bg-gray-50/40">
              <div className="w-8 text-center">№</div>
              <div className="flex-1 min-w-0">Партнёр</div>
              <div className="w-24 text-right">Перешли</div>
              <div className="w-24 text-right">Зарегистр.</div>
              <div className="w-24 text-right">Проголосовали</div>
            </div>
            {top.map((t, i) => (
              <div key={t.refCode} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50">
                <div className="w-8 text-center font-bold" style={{ color: i === 0 ? PEACH : i < 3 ? DARK : '#9aa3ad' }}>
                  {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">{t.name}</div>
                  {t.username && <div className="text-xs text-gray-400 truncate">@{t.username.replace(/^@+/, '')}</div>}
                </div>
                <div className="w-24 text-right text-sm text-gray-700">{t.count}</div>
                <div className="w-24 text-right text-sm font-medium text-gray-900">{t.registered}</div>
                <div className="w-24 text-right text-sm font-bold" style={{ color: t.clicked > 0 ? '#2e7d32' : '#c5cdd6' }}>
                  {t.clicked}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({
  icon, label, value, sub, accent,
}: {
  icon: React.ReactNode; label: string; value: number; sub?: string; accent: 'dark' | 'peach'
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <div className="flex items-center gap-2 mb-2"
           style={{ color: accent === 'peach' ? PEACH : DARK }}>
        {icon}
        <div className="text-xs font-medium uppercase tracking-wider opacity-80">{label}</div>
      </div>
      <div className="text-3xl font-black" style={{ color: DARK, lineHeight: 1 }}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  )
}

function pct(num: number, den: number): string {
  if (!den) return '—'
  return `${Math.round((num / den) * 100)}% от общего`
}
