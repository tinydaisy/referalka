'use client'
/**
 * Библиотека фото спикера (миграция 323).
 *
 * Организатор постоянно просит фото для афиши и анонсов. Одного снимка мало —
 * пусть выберет сам на публичной странице /sp/{client_id}. Здесь клиент их
 * загружает, подписывает и отмечает главное (оно показывается в профиле).
 *
 * Устроено как библиотека афиш коллаба ([CollaboratorPostersField.tsx]).
 */
import { useEffect, useState, useRef } from 'react'
import { Loader2, Trash2, Upload, Star, Check, X, Pencil, ArrowUp, ArrowDown } from 'lucide-react'
import { api } from '@/lib/api'
import { focalCss } from '@/lib/photoFocal'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

type Photo = { id: number; url: string; label: string | null; is_primary: boolean; sort_order: number; focal?: string | null }

export default function SpeakerPhotosField() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const r = await api.speakerPhotos.list()
      setPhotos(r.photos || [])
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить фото')
    } finally { setLoading(false) }
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return
    setUploading(true); setError(null)
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('kind', 'speaker_gallery')
        // ⚠️ Ключ токена — 'plusson_token' (две «с»), как во всём проекте.
        // Здесь стояло 'token': в заголовок уходило пустое значение, сервер
        // отвечал 401 «Неверный или просроченный токен», и загрузить фото было
        // нельзя вообще — при этом перелогин не помогал, потому что дело не в
        // сроке токена, а в том, что его не находили.
        const resp = await fetch(`${API_URL}/api/v1/uploads`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('plusson_token') || ''}` },
          body: fd,
        })
        if (!resp.ok) {
          const t = await resp.json().catch(() => ({}))
          throw new Error(t.detail || 'Не удалось загрузить файл')
        }
        const { url } = await resp.json()
        await api.speakerPhotos.create({ url })
      }
      await load()
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить файл')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function makePrimary(id: number) {
    // Меняем на месте, не перезагружая список: иначе картинки моргают.
    setPhotos(prev => prev.map(p => ({ ...p, is_primary: p.id === id })))
    try { await api.speakerPhotos.update(id, { is_primary: true }) } catch { load() }
  }

  async function saveLabel(id: number) {
    const label = draftLabel.trim()
    setPhotos(prev => prev.map(p => p.id === id ? { ...p, label: label || null } : p))
    setEditingId(null)
    try { await api.speakerPhotos.update(id, { label }) } catch { load() }
  }

  async function move(id: number, dir: -1 | 1) {
    const i = photos.findIndex(p => p.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= photos.length) return
    const next = [...photos]
    ;[next[i], next[j]] = [next[j], next[i]]
    setPhotos(next)
    try { await api.speakerPhotos.reorder(next.map(p => p.id)) } catch { load() }
  }

  async function remove(id: number) {
    if (!confirm('Удалить это фото? Файл удалится из хранилища.')) return
    setPhotos(prev => prev.filter(p => p.id !== id))
    try { await api.speakerPhotos.delete(id) } catch { load() }
    load()
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={14} className="animate-spin" /> Загружаем…</div>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-sm font-medium text-gray-800">Фото для организаторов</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Загрузите несколько — организатор скачает подходящее для афиши.
            Отмеченное звёздочкой показывается в профиле.
          </p>
        </div>
        <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
          className="shrink-0 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5">
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          Добавить
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden
               onChange={e => upload(e.target.files)} />
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{error}</p>
      )}

      {photos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center">
          <p className="text-sm text-gray-400">Фото пока нет</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {photos.map((p, i) => (
            <div key={p.id} className={`rounded-xl overflow-hidden border bg-white ${
              p.is_primary ? 'border-[#FFCFA4] ring-2 ring-[#FFCFA4]/40' : 'border-gray-200'}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={p.label || 'Фото'} className="w-full aspect-[3/4] object-cover"
                   style={{ objectPosition: focalCss(p.focal) }} />

              <div className="p-2 space-y-1.5">
                {editingId === p.id ? (
                  <div className="flex items-center gap-1">
                    <input autoFocus value={draftLabel} onChange={e => setDraftLabel(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveLabel(p.id); if (e.key === 'Escape') setEditingId(null) }}
                      placeholder="Подпись"
                      className="flex-1 min-w-0 text-xs border border-gray-200 rounded px-1.5 py-1" />
                    <button type="button" onClick={() => saveLabel(p.id)} className="p-1 text-green-600"><Check size={13} /></button>
                    <button type="button" onClick={() => setEditingId(null)} className="p-1 text-gray-400"><X size={13} /></button>
                  </div>
                ) : (
                  <button type="button"
                    onClick={() => { setEditingId(p.id); setDraftLabel(p.label || '') }}
                    className="w-full text-left text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1 truncate">
                    <Pencil size={11} className="shrink-0" />
                    <span className="truncate">{p.label || 'Без подписи'}</span>
                  </button>
                )}

                <div className="flex items-center gap-0.5">
                  <button type="button" onClick={() => makePrimary(p.id)}
                    title={p.is_primary ? 'Главное фото' : 'Сделать главным'}
                    className={`p-1 rounded ${p.is_primary ? 'text-[#FFCFA4]' : 'text-gray-300 hover:text-gray-500'}`}>
                    <Star size={14} fill={p.is_primary ? 'currentColor' : 'none'} />
                  </button>
                  <button type="button" onClick={() => move(p.id, -1)} disabled={i === 0}
                    title="Выше" className="p-1 rounded text-gray-300 hover:text-gray-500 disabled:opacity-30">
                    <ArrowUp size={13} />
                  </button>
                  <button type="button" onClick={() => move(p.id, 1)} disabled={i === photos.length - 1}
                    title="Ниже" className="p-1 rounded text-gray-300 hover:text-gray-500 disabled:opacity-30">
                    <ArrowDown size={13} />
                  </button>
                  <button type="button" onClick={() => remove(p.id)}
                    title="Удалить" className="ml-auto p-1 rounded text-gray-300 hover:text-red-500">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
