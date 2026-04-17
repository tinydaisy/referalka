'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save } from 'lucide-react'
import { api } from '@/lib/api'

export default function NewSpeakerPage() {
  const router = useRouter()
  const [form, setForm] = useState({
    name: '', title: '', company: '', bio: '', achievements: '',
    photo_url: '', photo_folder_url: '', video_folder_url: '',
    telegram_url: '', instagram_url: '', website_url: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) { setError('Введите имя спикера'); return }
    setLoading(true); setError('')
    try {
      const res = await api.speakers.create(
        Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim()))
      )
      router.push(`/dashboard/speakers/${res.speaker.id}`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-8">
        <Link href="/dashboard/speakers" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Новый спикер</h1>
          <p className="text-gray-500 text-sm mt-0.5">Данные сохранятся в вашу базу спикеров</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Основное */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">Основная информация</h2>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Имя и фамилия <span className="text-red-500">*</span>
            </label>
            <input
              type="text" value={form.name} onChange={set('name')}
              placeholder="Маргарита Форбс"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Должность / регалии</label>
              <input
                type="text" value={form.title} onChange={set('title')}
                placeholder="Коуч по продажам"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Компания</label>
              <input
                type="text" value={form.company} onChange={set('company')}
                placeholder="Forbes Academy"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Биография</label>
            <textarea
              value={form.bio} onChange={set('bio')} rows={3}
              placeholder="Краткое описание эксперта..."
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Достижения</label>
            <textarea
              value={form.achievements} onChange={set('achievements')} rows={2}
              placeholder="Автор 3 книг, 15 лет в продажах..."
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand resize-none"
            />
          </div>
        </div>

        {/* Медиа */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">Фото и материалы</h2>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Ссылка на фото</label>
            <input
              type="url" value={form.photo_url} onChange={set('photo_url')}
              placeholder="https://..."
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Папка с фото</label>
              <input
                type="url" value={form.photo_folder_url} onChange={set('photo_folder_url')}
                placeholder="https://drive.google.com/..."
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Папка с видео</label>
              <input
                type="url" value={form.video_folder_url} onChange={set('video_folder_url')}
                placeholder="https://drive.google.com/..."
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
              />
            </div>
          </div>
        </div>

        {/* Контакты */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">Контакты</h2>

          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Telegram</label>
              <input
                type="url" value={form.telegram_url} onChange={set('telegram_url')}
                placeholder="https://t.me/username"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Instagram</label>
              <input
                type="url" value={form.instagram_url} onChange={set('instagram_url')}
                placeholder="https://instagram.com/..."
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Сайт</label>
              <input
                type="url" value={form.website_url} onChange={set('website_url')}
                placeholder="https://..."
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="btn-gold flex-1 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <Save size={16} />
            {loading ? 'Сохраняем...' : 'Сохранить спикера'}
          </button>
          <Link
            href="/dashboard/speakers"
            className="px-6 py-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Отмена
          </Link>
        </div>
      </form>
    </div>
  )
}
