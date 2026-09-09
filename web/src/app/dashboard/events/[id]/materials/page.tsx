'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Upload, Plus, Copy, Check, Link as LinkIcon } from 'lucide-react'
import { api } from '@/lib/api'

export default function MaterialsPage() {
  const { id } = useParams()
  const [event, setEvent] = useState<any>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const sampleText = `🚀 Присоединяйтесь к нашему событию!\n\nПереходите по ссылке и участвуйте в реферальной программе — получайте подарки за каждого приглашённого друга.\n\n👉 Ваша ссылка: [ВАША_ССЫЛКА]`

  useEffect(() => {
    api.events.get(Number(id)).then(r => setEvent(r.event))
  }, [id])

  function copyText(text: string, key: string) {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  const tabs = [
    { label: 'Обзор', href: `/dashboard/events/${id}` },
    { label: 'Аналитика', href: `/dashboard/events/${id}/analytics` },
    { label: 'Материалы', href: `/dashboard/events/${id}/materials`, active: true },
    ...(event?.module_slug === 'conference' ? [{ label: 'Конференция', href: `/dashboard/conferences/${id}` }] : []),
  ]

  return (
    <div>
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-6">
        <Link href="/dashboard" className="hover:text-gray-700">События</Link>
        <span>/</span>
        <Link href={`/dashboard/events/${id}`} className="hover:text-gray-700">{event?.title}</Link>
        <span>/</span>
        <span className="text-gray-700">Материалы</span>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-6">{event?.title}</h1>

      <div className="flex gap-1 mb-8 border-b border-gray-200">
        {tabs.map(tab => (
          <Link key={tab.href} href={tab.href}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab.active ? 'border-brand text-brand' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            style={tab.active ? { borderBottomColor: '#25455D', color: '#25455D' } : {}}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Poster */}
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Афиша события</h3>
          {event?.poster_url ? (
            <div className="relative">
              <img src={event.poster_url} alt="Афиша" className="w-full rounded-xl" />
              <button className="mt-3 w-full py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
                Заменить
              </button>
            </div>
          ) : (
            <div className="border-2 border-dashed border-gray-200 rounded-xl p-10 text-center hover:border-brand/40 cursor-pointer transition-colors">
              <Upload size={32} className="mx-auto mb-3 text-gray-300" />
              <p className="text-sm font-medium text-gray-600 mb-1">Загрузите афишу</p>
              <p className="text-xs text-gray-400">PNG, JPG до 5 МБ</p>
              <button className="mt-4 px-4 py-2 rounded-lg text-sm font-medium btn-primary">
                Выбрать файл
              </button>
            </div>
          )}
        </div>

        {/* Promo text */}
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-800">Текст анонса</h3>
            <button
              onClick={() => copyText(sampleText, 'promo')}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 transition-colors"
            >
              {copied === 'promo' ? <><Check size={13} className="text-green-600" /> Скопировано</> : <><Copy size={13} /> Скопировать</>}
            </button>
          </div>
          <textarea
            defaultValue={sampleText}
            rows={8}
            className="w-full text-sm text-gray-700 bg-gray-50 rounded-xl p-4 border border-gray-200 focus:outline-none focus:ring-1 focus:ring-brand/30 resize-none"
          />
          <p className="text-xs text-gray-400 mt-2">
            Замените [ВАША_ССЫЛКА] на реферальную ссылку участника из Mini App
          </p>
        </div>

        {/* Materials list */}
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-800">Рекламные материалы и ссылки</h3>
            <button className="flex items-center gap-2 text-sm font-medium btn-primary px-4 py-2 rounded-lg">
              <Plus size={14} /> Добавить
            </button>
          </div>

          <div className="text-center py-10 text-gray-400">
            <LinkIcon size={32} className="mx-auto mb-3 text-gray-200" />
            <p className="text-sm">Добавьте ссылки на материалы, которые участники получат в Mini App</p>
            <p className="text-xs mt-1">Например: запись вебинара, PDF-файл, закрытый чат</p>
          </div>
        </div>
      </div>
    </div>
  )
}
