'use client'
import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Download } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'
import SettingsTab  from './tabs/SettingsTab'
import SpeakersTab  from './tabs/SpeakersTab'
import ProgramTab   from './tabs/ProgramTab'
import ParticipantsTab from './tabs/ParticipantsTab'
import RaffleTab  from './tabs/RaffleTab'
import PostersTab from './tabs/PostersTab'
import ReportTab from './tabs/ReportTab'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

type Tab = 'settings' | 'speakers' | 'program' | 'participants' | 'raffle' | 'posters' | 'report'
const VALID_TABS: Tab[] = ['settings', 'speakers', 'program', 'participants', 'raffle', 'posters', 'report']

export default function ConferencePage() {
  const { id } = useParams()
  const eventId = Number(id)
  const searchParams = useSearchParams()
  const { t } = useLang()
  const initialTab = (searchParams.get('tab') as Tab) || 'settings'
  const [tab, setTab] = useState<Tab>(VALID_TABS.includes(initialTab) ? initialTab : 'settings')
  const [event, setEvent] = useState<any>(null)
  const [conf, setConf] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  async function handleSalebotExport() {
    setExporting(true)
    try {
      const token = localStorage.getItem('plusson_token')
      const res = await fetch(`${API_URL}/api/v1/events/${eventId}/conference/export/salebot`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Ошибка экспорта')
      const blob = await res.blob()
      const disposition = res.headers.get('content-disposition') || ''
      const nameMatch = disposition.match(/filename="?([^"]+)"?/)
      const filename = nameMatch ? nameMatch[1] : `${eventId}_info.txt`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert('Не удалось скачать файл')
    } finally {
      setExporting(false)
    }
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: 'settings',     label: t.conferences.tabs.settings },
    { id: 'speakers',     label: t.conferences.tabs.speakers },
    { id: 'program',      label: t.conferences.tabs.program },
    { id: 'participants', label: t.conferences.tabs.participants },
    { id: 'posters',      label: t.conferences.tabs.posters },
    { id: 'raffle',       label: t.conferences.tabs.raffle },
    { id: 'report',       label: 'Отчёт' },
  ]

  useEffect(() => {
    Promise.all([
      api.events.get(eventId),
      api.conference.get(eventId),
    ]).then(([evRes, confRes]) => {
      setEvent(evRes.event)
      setConf(confRes.conference)
    }).finally(() => setLoading(false))
  }, [eventId])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="text-brand text-3xl" />
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/conferences" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 truncate">{event?.title || t.conferences.header.defaultTitle}</h1>
          <p className="text-gray-400 text-sm">
            {conf?.status === 'active' ? t.conferences.header.active : t.conferences.header.draft}
          </p>
        </div>
        <button
          onClick={handleSalebotExport}
          disabled={exporting}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-[#25455D] text-[#FFCFA4] hover:opacity-90 transition-opacity disabled:opacity-50 whitespace-nowrap"
        >
          {exporting ? (
            <span className="animate-spin inline-block w-4 h-4 border-2 border-[#FFCFA4] border-t-transparent rounded-full" />
          ) : (
            <Download size={16} />
          )}
          Экспорт для Salebot
        </button>
      </div>

      {/* Tabs — горизонтальный скролл на мобильном */}
      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 mb-6">
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-max sm:w-fit">
          {TABS.map(tb => (
            <button key={tb.id} onClick={() => setTab(tb.id)}
              className={`px-3 sm:px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                tab === tb.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}>
              {tb.label}
            </button>
          ))}
          <Link href={`/dashboard/conferences/${eventId}/broadcasts/templates`}
            className="px-3 sm:px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap text-gray-500 hover:text-gray-700 hover:bg-white/60">
            Рассылки
          </Link>
        </div>
      </div>

      {tab === 'settings'     && <SettingsTab     eventId={eventId} conf={conf} event={event} onConfUpdated={setConf} />}
      {tab === 'speakers'     && <SpeakersTab     eventId={eventId} />}
      {tab === 'program'      && <ProgramTab      eventId={eventId} />}
      {tab === 'participants' && <ParticipantsTab eventId={eventId} />}
      {tab === 'raffle'       && <RaffleTab />}
      {tab === 'posters'      && <PostersTab      eventId={eventId} />}
      {tab === 'report'       && <ReportTab       eventId={eventId} />}
    </div>
  )
}
