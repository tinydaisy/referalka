'use client'
import { useState, useEffect } from 'react'
import { Gift, Plus, Pencil, Trash2, ExternalLink, X } from 'lucide-react'
import { api } from '@/lib/api'

interface LeadMagnet {
  id: number
  name: string
  description: string | null
  url: string
  created_at: string
  updated_at: string
}

export default function LeadMagnetsPage() {
  const [items, setItems] = useState<LeadMagnet[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<LeadMagnet | null>(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await api.leadMagnets.list()
      setItems(res.items || [])
      setError(null)
    } catch (e: any) {
      setError(e.message || 'Не получилось загрузить')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleDelete(id: number) {
    if (!confirm('Удалить лид-магнит? Связанные пороги в реф-программах останутся, но без подарка.')) return
    try {
      await api.leadMagnets.delete(id)
      await load()
    } catch (e: any) {
      alert(e.message || 'Ошибка удаления')
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: '#25455D' }}>
            <Gift size={24} /> Лид-магниты
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Общая база материалов клиента: чек-листы, гайды, статьи, видео.
            Используются как подарки в реф-программе любого события.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium"
          style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
        >
          <Plus size={18} /> Добавить
        </button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <Gift className="mx-auto mb-3 text-gray-300" size={40} />
          <p className="text-gray-500 text-sm mb-4">У вас пока нет лид-магнитов</p>
          <button
            onClick={() => setCreating(true)}
            className="text-sm underline"
            style={{ color: '#25455D' }}
          >
            Создать первый
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y">
          {items.map(lm => (
            <div key={lm.id} className="p-4 flex items-start gap-3 hover:bg-gray-50">
              <div className="mt-1 w-9 h-9 rounded-lg flex items-center justify-center text-white"
                   style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                <Gift size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900">{lm.name}</div>
                <a href={lm.url} target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-1 text-xs mt-1 text-gray-400 hover:underline truncate">
                  <ExternalLink size={12} />
                  <span className="truncate">{lm.url}</span>
                </a>
              </div>
              <div className="flex gap-1">
                <button onClick={() => setEditing(lm)}
                        className="p-2 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                  <Pencil size={16} />
                </button>
                <button onClick={() => handleDelete(lm.id)}
                        className="p-2 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <LeadMagnetForm
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}
    </div>
  )
}


function LeadMagnetForm({
  initial, onClose, onSaved,
}: {
  initial: LeadMagnet | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [url, setUrl] = useState(initial?.url || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!name.trim() || !url.trim()) {
      setErr('Название и ссылка обязательны')
      return
    }
    setSaving(true)
    try {
      const payload = { name: name.trim(), description: null, url: url.trim() }
      if (initial) {
        await api.leadMagnets.update(initial.id, payload)
      } else {
        await api.leadMagnets.create(payload)
      }
      onSaved()
    } catch (e: any) {
      setErr(e.message || 'Ошибка сохранения')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
         onClick={onClose}>
      <div className="bg-white rounded-xl max-w-md w-full p-6"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold" style={{ color: '#25455D' }}>
            {initial ? 'Редактировать лид-магнит' : 'Новый лид-магнит'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Название *</label>
            <input
              type="text" value={name} onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Чек-лист по продажам"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Ссылка *</label>
            <input
              type="url" value={url} onChange={e => setUrl(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="https://example.com/file.pdf"
            />
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex gap-2 justify-end pt-2">
            <button type="button" onClick={onClose}
                    className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
              Отмена
            </button>
            <button type="submit" disabled={saving}
                    className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                    style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
