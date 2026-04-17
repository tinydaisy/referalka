'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Plus, Search, Users, Mic, ChevronRight, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'

export default function SpeakersPage() {
  const [speakers, setSpeakers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  function load(q?: string) {
    setLoading(true)
    api.speakers.list(q)
      .then(r => setSpeakers(r.speakers || []))
      .catch(() => setSpeakers([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    load(query || undefined)
  }

  async function handleDelete(id: number, name: string) {
    if (!confirm(`Удалить спикера «${name}» из базы?`)) return
    try {
      await api.speakers.delete(id)
      setSpeakers(s => s.filter(sp => sp.id !== id))
    } catch (err: any) {
      alert(err.message)
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Мои спикеры</h1>
          <p className="text-gray-500 mt-1">Глобальная база — добавляйте спикеров в любую конференцию</p>
        </div>
        <Link
          href="/dashboard/speakers/new"
          className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2"
        >
          <Plus size={16} /> Добавить спикера
        </Link>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="mb-6 flex gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Поиск по имени..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
          />
        </div>
        <button type="submit" className="px-4 py-2.5 rounded-xl bg-white border border-gray-200 text-sm text-gray-700 hover:border-brand transition-colors">
          Найти
        </button>
        {query && (
          <button type="button" onClick={() => { setQuery(''); load() }} className="px-4 py-2.5 rounded-xl bg-white border border-gray-200 text-sm text-gray-500 hover:text-gray-700 transition-colors">
            Сбросить
          </button>
        )}
      </form>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-8 h-8 border-2 border-brand rounded-full border-t-transparent animate-spin" />
        </div>
      ) : speakers.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
          <div className="w-20 h-20 rounded-full gradient-bg flex items-center justify-center mx-auto mb-6">
            <Users size={36} className="text-white" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">
            {query ? 'Ничего не найдено' : 'База спикеров пуста'}
          </h2>
          <p className="text-gray-500 mb-8 max-w-sm mx-auto">
            {query
              ? 'Попробуйте другой запрос или добавьте нового спикера.'
              : 'Добавьте спикеров здесь — они появятся в базе и будут доступны для любой конференции.'}
          </p>
          {!query && (
            <Link
              href="/dashboard/speakers/new"
              className="btn-gold inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold"
            >
              <Plus size={16} /> Добавить первого спикера
            </Link>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="divide-y divide-gray-50">
            {speakers.map(sp => (
              <div key={sp.id} className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 group transition-colors">
                {/* Photo or avatar */}
                <div className="w-10 h-10 rounded-full overflow-hidden shrink-0 bg-gray-100 flex items-center justify-center">
                  {sp.photo_url ? (
                    <img src={sp.photo_url} alt={sp.name} className="w-full h-full object-cover" />
                  ) : (
                    <Mic size={18} className="text-gray-400" />
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900 truncate">{sp.name}</p>
                  {(sp.title || sp.company) && (
                    <p className="text-sm text-gray-500 truncate">
                      {[sp.title, sp.company].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleDelete(sp.id, sp.name)}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="Удалить из базы"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>

                <Link href={`/dashboard/speakers/${sp.id}`} className="flex items-center text-gray-400 hover:text-brand transition-colors">
                  <ChevronRight size={18} />
                </Link>
              </div>
            ))}
          </div>

          {/* Add row */}
          <div className="border-t border-gray-100">
            <Link
              href="/dashboard/speakers/new"
              className="flex items-center gap-3 px-5 py-4 text-sm text-gray-400 hover:text-brand hover:bg-gray-50 transition-colors"
            >
              <div className="w-10 h-10 rounded-full border-2 border-dashed border-gray-200 flex items-center justify-center">
                <Plus size={16} />
              </div>
              <span>Добавить спикера</span>
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
