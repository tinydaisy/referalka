'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'

export default function NewCollaborationPage() {
  const router = useRouter()
  const { t } = useLang()
  const tc = t.collaborations
  const [form, setForm] = useState({
    name: '', title: '',
    photo_url: '', photo_folder_url: '', video_folder_url: '',
    tg_channel_url: '', instagram_url: '', website_url: '',
    tg_channel_id: '', personal_tg_id: '', personal_tg_username: '', assistant_tg_username: '',
  })
  const [achievementsText, setAchievementsText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) { setError(tc.new.errorRequired); return }
    setLoading(true); setError('')
    try {
      const achievements = achievementsText.split('\n').map(s => s.trim()).filter(Boolean)
      const payload = Object.fromEntries(Object.entries({ ...form, achievements }).filter(([, v]) =>
        Array.isArray(v) ? (v as any[]).length > 0 : (v as string).trim()
      ))
      const res = await api.collaborators.create(payload)
      router.push(`/dashboard/collaborations/${res.collaborator.id}`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-8">
        <Link href="/dashboard/collaborations" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{tc.new.title}</h1>
          <p className="text-gray-500 text-sm mt-0.5">{tc.new.subtitle}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.basicInfo}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.nameRequired}</label>
            <input type="text" value={form.name} onChange={set('name')}
              placeholder={t.fields.namePlaceholder} autoFocus
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.position}</label>
            <input type="text" value={form.title} onChange={set('title')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.achievements}</label>
            <textarea value={achievementsText} onChange={e => setAchievementsText(e.target.value)} rows={5}
              placeholder={'Регалия 1\nРегалия 2\nРегалия 3'}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand resize-y" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.media}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.photo}</label>
            <input type="url" value={form.photo_url} onChange={set('photo_url')} placeholder="https://..."
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.photoFolder}</label>
              <input type="url" value={form.photo_folder_url} onChange={set('photo_folder_url')}
                placeholder="https://drive.google.com/..."
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.videoFolder}</label>
              <input type="url" value={form.video_folder_url} onChange={set('video_folder_url')}
                placeholder="https://drive.google.com/..."
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.contacts}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.instagram}</label>
            <input type="url" value={form.instagram_url} onChange={set('instagram_url')}
              placeholder="https://instagram.com/..."
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.website}</label>
            <input type="url" value={form.website_url} onChange={set('website_url')} placeholder="https://..."
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.accounts}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.telegram}</label>
            <input type="url" value={form.tg_channel_url} onChange={set('tg_channel_url')}
              placeholder="https://t.me/username"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.channelId}</label>
              <input type="text" value={form.tg_channel_id} onChange={set('tg_channel_id')}
                placeholder="-100123456789"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.personalAccountId}</label>
              <input type="text" value={form.personal_tg_id} onChange={set('personal_tg_id')}
                placeholder="123456789"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.personalAccountUsername}</label>
              <input type="text" value={form.personal_tg_username} onChange={set('personal_tg_username')}
                placeholder="@username"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.assistantAccount}</label>
              <input type="text" value={form.assistant_tg_username} onChange={set('assistant_tg_username')}
                placeholder="@assistant"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">{error}</div>
        )}

        <div className="flex gap-3">
          <button type="submit" disabled={loading}
            className={`btn-gold flex-1 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 ${loading ? 'btn-loading' : ''}`}>
            {loading ? <><Spinner /> {t.common.saving}</> : <><Save size={16} /> {t.common.save}</>}
          </button>
          <Link href="/dashboard/collaborations"
            className="px-6 py-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
            {t.common.cancel}
          </Link>
        </div>
      </form>
    </div>
  )
}
