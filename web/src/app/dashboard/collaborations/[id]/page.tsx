'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, ExternalLink, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'

export default function CollaborationPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const { t } = useLang()
  const collaboratorId = parseInt(params.id)
  const [form, setForm] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.collaborators.get(collaboratorId)
      .then(r => setForm(r.collaborator))
      .catch(() => router.push('/dashboard/collaborations'))
      .finally(() => setLoading(false))
  }, [collaboratorId])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f: any) => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(''); setSaved(false)
    try {
      const updates = Object.fromEntries(
        Object.entries(form).filter(([k]) =>
          ['name','title','achievements','photo_url',
           'photo_folder_url','video_folder_url','telegram_url','instagram_url','website_url',
           'channel_id','personal_account_id','personal_account_username','assistant_account'].includes(k)
        )
      )
      await api.collaborators.update(collaboratorId, updates)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-brand rounded-full border-t-transparent animate-spin" />
      </div>
    )
  }
  if (!form) return null

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-8">
        <Link href="/dashboard/collaborations" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex items-center gap-3 flex-1">
          {form.photo_url && (
            <img src={form.photo_url} alt={form.name} className="w-10 h-10 rounded-full object-cover" />
          )}
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{form.name}</h1>
            {form.title && <p className="text-gray-500 text-sm">{form.title}</p>}
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.basicInfo}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {t.fields.nameRequired}
            </label>
            <input type="text" value={form.name || ''} onChange={set('name')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.position}</label>
            <input type="text" value={form.title || ''} onChange={set('title')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.achievements}</label>
            <textarea value={form.achievements || ''} onChange={set('achievements')} rows={2}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand resize-none" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.media}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.photo}</label>
            <div className="flex gap-2">
              <input type="url" value={form.photo_url || ''} onChange={set('photo_url')} placeholder="https://..."
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
              {form.photo_url && (
                <a href={form.photo_url} target="_blank" rel="noopener" className="px-3 py-2.5 rounded-xl border border-gray-200 text-gray-500 hover:text-brand transition-colors">
                  <ExternalLink size={15} />
                </a>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.photoFolder}</label>
              <input type="url" value={form.photo_folder_url || ''} onChange={set('photo_folder_url')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.videoFolder}</label>
              <input type="url" value={form.video_folder_url || ''} onChange={set('video_folder_url')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.contacts}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.telegram}</label>
            <input type="url" value={form.telegram_url || ''} onChange={set('telegram_url')}
              placeholder="https://t.me/username"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.instagram}</label>
            <input type="url" value={form.instagram_url || ''} onChange={set('instagram_url')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.website}</label>
            <input type="url" value={form.website_url || ''} onChange={set('website_url')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.accounts}</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.channelId}</label>
              <input type="text" value={form.channel_id || ''} onChange={set('channel_id')}
                placeholder="-100123456789"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.personalAccountId}</label>
              <input type="text" value={form.personal_account_id || ''} onChange={set('personal_account_id')}
                placeholder="123456789"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.personalAccountUsername}</label>
              <input type="text" value={form.personal_account_username || ''} onChange={set('personal_account_username')}
                placeholder="@username"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.assistantAccount}</label>
              <input type="text" value={form.assistant_account || ''} onChange={set('assistant_account')}
                placeholder="@assistant"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">{error}</div>
        )}

        <div className="flex gap-3 items-center">
          <button type="submit" disabled={saving}
            className={`btn-gold flex-1 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 ${saving ? 'btn-loading' : ''}`}>
            {saving ? <><Spinner /> {t.common.saving}</> : <><Save size={16} /> {t.common.save}</>}
          </button>
          <Link href="/dashboard/collaborations"
            className="px-6 py-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
            {t.common.back}
          </Link>
          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-green-600">
              <Check size={15} /> {t.common.saved}
            </span>
          )}
        </div>
      </form>
    </div>
  )
}
