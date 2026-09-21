'use client'
/**
 * Библиотека афиш коллаба (миграция 121).
 *
 * Несколько афиш на одного спикера: загружаются в общий список, при
 * добавлении спикера в конференцию клиент выбирает какую афишу
 * использовать в этой конференции (через event_collaborators.poster_id).
 * Старая афиша остаётся в библиотеке и доступна для будущих событий.
 *
 * Спикер видит всю библиотеку в кабинете на странице «Материалы» и
 * скачивает любую афишу под свой анонс.
 */
import { useEffect, useState, useRef } from 'react'
import { Loader2, Trash2, Upload, AlertCircle, GripVertical, Pencil, Check, X, Maximize2, Download, Copy } from 'lucide-react'
import { api } from '@/lib/api'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

type Poster = { id: number; url: string; label: string | null; sort_order: number }

interface Props {
  collaboratorId: number
}

export default function CollaboratorPostersField({ collaboratorId }: Props) {
  const [posters, setPosters] = useState<Poster[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  /**
   * ⚠️ Скачивание через blob: атрибут `download` не работает для файлов с
   * другого домена (афиши лежат на S3) — браузер открывал их во вкладке
   * вместо сохранения. Не вышло — открываем, как раньше.
   */
  async function downloadFile(u: string) {
    try {
      const r = await fetch(u)
      if (!r.ok) throw new Error(String(r.status))
      const blob = await r.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = (u.split('/').pop() || 'afisha').split('?')[0] || 'afisha'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(href), 10000)
    } catch {
      window.open(u, '_blank', 'noreferrer')
    }
  }

  function copyUrl(id: number, url: string) {
    navigator.clipboard.writeText(url)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  async function reload() {
    setLoading(true)
    try {
      const r = await api.collaborators.posters.list(collaboratorId)
      setPosters(r.posters || [])
    } catch (e: any) {
      setError(e.message || 'Не удалось загрузить афиши')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [collaboratorId])

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setError(null)
    setUploading(true)
    try {
      const token = (typeof window !== 'undefined' && localStorage.getItem('plusson_token')) || ''
      for (const f of Array.from(files)) {
        if (f.size > 50 * 1024 * 1024) {
          throw new Error(`«${f.name}» больше 50 МБ`)
        }
        const fd = new FormData()
        fd.append('file', f)
        fd.append('kind', 'speaker_poster')
        fd.append('collaborator_id', String(collaboratorId))
        const r = await fetch(`${API_URL}/api/v1/uploads`, {
          method: 'POST',
          body: fd,
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!r.ok) {
          const err = await r.json().catch(() => ({ detail: `HTTP ${r.status}` }))
          throw new Error(err.detail || `HTTP ${r.status}`)
        }
      }
      await reload()
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function remove(id: number) {
    if (!confirm('Удалить эту афишу из библиотеки? Файл будет стёрт.')) return
    try {
      await api.collaborators.posters.delete(collaboratorId, id)
      await reload()
    } catch (e: any) {
      setError(e.message || 'Не удалось удалить')
    }
  }

  async function saveLabel(id: number) {
    try {
      await api.collaborators.posters.update(collaboratorId, id, { label: labelDraft.trim() || undefined })
      setEditingId(null)
      await reload()
    } catch (e: any) {
      setError(e.message || 'Не удалось сохранить подпись')
    }
  }

  async function reorderTo(from: number, to: number) {
    if (from === to) return
    const next = posters.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setPosters(next)
    try {
      await api.collaborators.posters.reorder(collaboratorId, next.map(p => p.id))
    } catch (e: any) {
      setError(e.message || 'Не удалось переставить')
      await reload()
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-gray-500">
        Можно загрузить несколько афиш — например, разный дизайн под разные конференции.
        Старые не удаляйте, они пригодятся в следующих событиях. В каждой конференции
        вы выбираете на странице спикера, какая афиша используется в её рассылках.
        Спикеру в его кабинете видна вся библиотека.
      </div>

      <div
        className="border-2 border-dashed border-gray-200 bg-gray-50/50 rounded-xl p-4 flex items-center justify-between gap-3"
      >
        <span className="text-sm text-gray-500">Можно загрузить сразу несколько файлов</span>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-sm font-medium text-gray-700 disabled:opacity-50"
        >
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {uploading ? 'Загрузка…' : 'Добавить афишу'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={e => handleFiles(e.target.files)}
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-400">
          <Loader2 size={20} className="animate-spin inline" />
        </div>
      ) : posters.length === 0 ? (
        <div className="text-center py-8 text-sm text-gray-400">
          Афиши не загружены.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {posters.map((p, idx) => (
            <div
              key={p.id}
              draggable
              onDragStart={() => setDragIndex(idx)}
              onDragOver={e => { e.preventDefault() }}
              onDrop={e => {
                e.preventDefault()
                if (dragIndex !== null) reorderTo(dragIndex, idx)
                setDragIndex(null)
              }}
              className={`flex flex-col gap-2 ${dragIndex === idx ? 'opacity-50' : ''}`}
            >
              <div className="relative aspect-square rounded-xl overflow-hidden bg-gray-100 border border-gray-100 group">
                <img
                  src={p.url}
                  alt={p.label || `Афиша ${idx + 1}`}
                  onClick={() => setLightbox(p.url)}
                  className="w-full h-full object-cover cursor-zoom-in"
                />
                <div className="absolute top-1.5 left-1.5 p-1 rounded bg-white/80 text-gray-400 cursor-grab">
                  <GripVertical size={14} />
                </div>
              </div>
              {/* Действия с афишей: раскрыть, скачать, скопировать ссылку */}
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setLightbox(p.url)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-[11px] font-medium text-gray-700"
                  title="Раскрыть"
                >
                  <Maximize2 size={11} /> Раскрыть
                </button>
                <button
                  type="button"
                  onClick={() => downloadFile(p.url)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-[11px] font-medium text-gray-700"
                  title="Скачать файл на компьютер"
                >
                  <Download size={11} /> Скачать
                </button>
                <button
                  type="button"
                  onClick={() => copyUrl(p.id, p.url)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-[11px] font-medium text-gray-700"
                  title={p.url}
                >
                  {copiedId === p.id
                    ? <><Check size={11} className="text-green-600" /> Скопировано</>
                    : <><Copy size={11} /> Ссылка</>}
                </button>
              </div>
              {editingId === p.id ? (
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={labelDraft}
                    onChange={e => setLabelDraft(e.target.value)}
                    placeholder="Подпись (необязательно)"
                    autoFocus
                    className="flex-1 px-2 py-1 rounded-lg border border-gray-200 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => saveLabel(p.id)}
                    className="px-2 rounded-lg bg-brand text-white text-xs"
                    title="Сохранить"
                  >
                    <Check size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="px-2 rounded-lg border border-gray-200 text-xs text-gray-500"
                    title="Отмена"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <span className="flex-1 text-xs text-gray-600 truncate" title={p.label || ''}>
                    {p.label || <span className="text-gray-400 italic">без подписи</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setEditingId(p.id); setLabelDraft(p.label || '') }}
                    className="p-1 rounded text-gray-400 hover:text-brand"
                    title="Переименовать"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(p.id)}
                    className="p-1 rounded text-gray-400 hover:text-red-500"
                    title="Удалить"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Lightbox — раскрытие афиши на весь экран */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/85"
          onClick={() => setLightbox(null)}
        >
          <div className="relative max-w-5xl max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <img src={lightbox} alt="" className="max-w-full max-h-[90vh] rounded-xl shadow-2xl object-contain" />
            <div className="absolute top-2 right-2 flex gap-2">
              <button
                type="button"
                onClick={() => downloadFile(lightbox)}
                className="flex items-center gap-1 bg-white/90 text-gray-800 rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-white transition-colors"
              >
                <Download size={14} /> Скачать
              </button>
              <button
                onClick={() => setLightbox(null)}
                className="bg-black/50 text-white rounded-full p-1.5 hover:bg-black/80 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
