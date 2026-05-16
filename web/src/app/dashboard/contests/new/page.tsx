'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Vote } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

export default function NewContestPage() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) { setError('Введите название'); return }
    setLoading(true); setError('')
    try {
      const res = await api.events.create({ title: title.trim(), module_slug: 'contest' })
      router.push(`/dashboard/contests/${res.event.id}`)
    } catch (err: any) {
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      <div className="flex items-center gap-3 mb-10">
        <Link href="/dashboard/contests" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">Новое участие в конкурсе</h1>
      </div>

      <div className="flex justify-center mb-8">
        <div className="w-20 h-20 rounded-2xl gradient-bg flex items-center justify-center">
          <Vote size={36} className="text-white" />
        </div>
      </div>

      <form onSubmit={handleCreate} className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Название конкурса
          </label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Например: Премия Forbes Woman"
            autoFocus
            className="w-full px-4 py-3 rounded-xl border border-gray-200 text-base focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/10"
          />
          <p className="text-xs text-gray-400 mt-1.5">Можно изменить позже в настройках</p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !title.trim()}
          className={`btn-gold w-full py-3.5 rounded-xl font-semibold text-base flex items-center justify-center gap-2 ${loading ? 'btn-loading' : ''}`}
        >
          {loading ? <><Spinner /> Создаём...</> : 'Создать'}
        </button>

        <Link
          href="/dashboard/contests"
          className="block text-center text-sm text-gray-400 hover:text-gray-600 transition-colors py-2"
        >
          Отмена
        </Link>
      </form>
    </div>
  )
}
