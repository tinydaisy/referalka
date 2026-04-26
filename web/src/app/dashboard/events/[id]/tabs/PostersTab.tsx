'use client'
import { useState, useEffect } from 'react'
import { Plus, Trash2, ImageIcon } from 'lucide-react'
import { api } from '@/lib/api'

interface Poster {
  id: number
  url: string
  orientation: 'horizontal' | 'vertical'
  sort: number
}

export default function PostersTab({ eventId }: { eventId: number }) {
  const [items, setItems] = useState<Poster[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const r = await api.referralProgram.posters.list(eventId)
      setItems(r.items || [])
      setErr(null)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [eventId])

  async function handleDelete(id: number) {
    if (!confirm('Удалить афишу?')) return
    await api.referralProgram.posters.delete(eventId, id).catch((e: any) => alert(e.message))
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Афиши используются на лендинге события и в материалах для шеринга. Поддерживаются горизонтальные и вертикальные.
        </p>
        <button onClick={() => setShowForm(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <Plus size={16} /> Добавить
        </button>
      </div>

      {err && <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{err}</div>}

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <ImageIcon className="mx-auto mb-3 text-gray-300" size={36} />
          <p className="text-gray-500 text-sm">Афиш пока нет</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map(p => (
            <div key={p.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden group">
              <div className={`bg-gray-100 ${p.orientation === 'vertical' ? 'aspect-[3/4]' : 'aspect-video'}`}>
                <img src={p.url} alt="" className="w-full h-full object-cover" />
              </div>
              <div className="p-3 flex items-center justify-between">
                <span className="text-xs text-gray-500">
                  {p.orientation === 'horizontal' ? 'Горизонтальная' : 'Вертикальная'}
                </span>
                <button onClick={() => handleDelete(p.id)}
                        className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <PosterForm eventId={eventId}
                    onClose={() => setShowForm(false)}
                    onSaved={() => { setShowForm(false); load() }} />
      )}
    </div>
  )
}


function PosterForm({ eventId, onClose, onSaved }: {
  eventId: number; onClose: () => void; onSaved: () => void
}) {
  const [url, setUrl] = useState('')
  const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>('horizontal')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim()) return setErr('Укажите URL')
    setSaving(true); setErr(null)
    try {
      await api.referralProgram.posters.create(eventId, { url: url.trim(), orientation, sort: 0 })
      onSaved()
    } catch (e: any) { setErr(e.message); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4" style={{ color: '#25455D' }}>Добавить афишу</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">URL картинки</label>
            <input type="url" value={url} onChange={e => setUrl(e.target.value)}
                   placeholder="https://..."
                   className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                   autoFocus />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Ориентация</label>
            <div className="flex gap-2">
              {(['horizontal','vertical'] as const).map(o => (
                <button type="button" key={o} onClick={() => setOrientation(o)}
                        className={`flex-1 px-3 py-2 rounded-lg text-sm border transition ${
                          orientation === o
                            ? 'border-gray-900 bg-gray-50 font-medium'
                            : 'border-gray-200 text-gray-500 hover:border-gray-400'
                        }`}>
                  {o === 'horizontal' ? 'Горизонтальная' : 'Вертикальная'}
                </button>
              ))}
            </div>
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Отмена</button>
            <button type="submit" disabled={saving}
                    className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                    style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
              {saving ? 'Сохраняю…' : 'Добавить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
