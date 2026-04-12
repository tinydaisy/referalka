'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Users, TrendingUp, Gift, MousePointerClick, Copy, Check, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

const STATUS_LABELS: Record<string, { label: string; cls: string; next: string; nextLabel: string }> = {
  draft:  { label: 'Черновик',  cls: 'bg-gray-100 text-gray-600',   next: 'active', nextLabel: 'Активировать' },
  active: { label: 'Активно',   cls: 'bg-green-100 text-green-700', next: 'ended',  nextLabel: 'Завершить' },
  ended:  { label: 'Завершено', cls: 'bg-red-100 text-red-700',     next: 'active', nextLabel: 'Возобновить' },
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://plusson.app'

export default function EventPage() {
  const { id } = useParams()
  const router = useRouter()
  const [event, setEvent] = useState<any>(null)
  const [analytics, setAnalytics] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    Promise.all([api.events.get(Number(id)), api.events.analytics(Number(id))])
      .then(([e, a]) => { setEvent(e.event); setAnalytics(a) })
      .catch(() => router.push('/dashboard'))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-2 border-brand rounded-full border-t-transparent animate-spin" /></div>
  if (!event) return null

  const status = STATUS_LABELS[event.status] || STATUS_LABELS.draft
  const refUrl = `${APP_URL}/r/example-code`

  async function changeStatus() {
    await api.events.update(Number(id), { status: status.next })
    setEvent((e: any) => ({ ...e, status: status.next }))
  }

  function copyLink() {
    navigator.clipboard.writeText(refUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const tabs = [
    { label: 'Обзор', href: `/dashboard/events/${id}`, active: true },
    { label: 'Аналитика', href: `/dashboard/events/${id}/analytics` },
    { label: 'Материалы', href: `/dashboard/events/${id}/materials` },
    ...(event.module_slug === 'conference' ? [{ label: 'Конференция', href: `/dashboard/events/${id}/conference` }] : []),
  ]

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-6">
        <Link href="/dashboard" className="hover:text-gray-700">События</Link>
        <span>/</span>
        <span className="text-gray-700">{event.title}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold text-gray-900">{event.title}</h1>
            <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${status.cls}`}>{status.label}</span>
          </div>
          <p className="text-gray-500 text-sm">Модуль: {event.module_slug}</p>
        </div>
        <button
          onClick={changeStatus}
          className="btn-primary px-4 py-2 rounded-xl text-sm font-medium"
        >
          {status.nextLabel}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-8 border-b border-gray-200">
        {tabs.map(tab => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab.active
                ? 'border-brand text-brand'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            style={tab.active ? { borderBottomColor: '#25455D', color: '#25455D' } : {}}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Участников', value: analytics?.participants_total || 0, icon: Users },
          { label: 'Переходов', value: analytics?.clicks_total || 0, icon: MousePointerClick },
          { label: 'Конверсий', value: analytics?.conversions_free || 0, icon: TrendingUp },
          { label: 'Подарков', value: analytics?.gifts_issued || 0, icon: Gift },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-gray-500">{label}</span>
              <Icon size={18} className="text-gray-300" />
            </div>
            <p className="text-3xl font-bold text-gray-900">{value}</p>
          </div>
        ))}
      </div>

      {/* Ref link */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-6">
        <h3 className="font-semibold text-gray-800 mb-4">Реферальная ссылка-пример</h3>
        <p className="text-sm text-gray-500 mb-4">
          Каждый участник получает свою персональную ссылку в Mini App. Это пример формата.
        </p>
        <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
          <code className="flex-1 text-sm text-gray-700 truncate">{refUrl}</code>
          <button
            onClick={copyLink}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors shrink-0"
            style={{ background: copied ? '#dcfce7' : '#f1f5f9', color: copied ? '#16a34a' : '#374151' }}
          >
            {copied ? <><Check size={14} /> Скопировано</> : <><Copy size={14} /> Скопировать</>}
          </button>
        </div>
      </div>

      {/* Top referrers */}
      {analytics?.top_referrers?.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Топ участников</h3>
          <div className="space-y-3">
            {analytics.top_referrers.map((r: any, i: number) => (
              <div key={i} className="flex items-center gap-3">
                <span className="w-6 text-center text-sm text-gray-400 font-medium">{i + 1}</span>
                <div className="w-8 h-8 rounded-full gradient-bg flex items-center justify-center text-white text-xs font-bold">
                  {(r.first_name || '?')[0]}
                </div>
                <span className="flex-1 text-sm text-gray-700">{r.first_name} {r.username ? `@${r.username}` : ''}</span>
                <span className="text-sm font-semibold text-gray-900">{r.referrals_count} рефералов</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
