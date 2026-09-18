'use client'
/**
 * Библиотека логотипов бренда (миграция 449).
 *
 * У бренда логотип не один: горизонтальный и квадратный, полный знак и только
 * иконка, цветной и монохромный для печати. Организатору под афишу нужна своя
 * версия — пусть выберет сам на публичной странице /sp/{код}. Здесь клиент их
 * загружает, подписывает и отмечает главный.
 *
 * ⚠️ Устроено один в один как библиотека фото ([SpeakerPhotosField.tsx]):
 * та же раскладка, те же кнопки, те же слова. Две библиотеки рядом на одной
 * странице обязаны вести себя одинаково — иначе человек каждый раз заново
 * соображает, где тут звёздочка и где стрелки.
 *
 * Отличия ровно два, и оба вынужденные:
 *  1. object-contain вместо object-cover — логотип нельзя обрезать по краям;
 *  2. переключатель подложки (on_dark): светлый знак на белой карточке
 *     сливается с фоном, и организатор решит, что файл битый. По самой
 *     картинке этого не понять — прозрачный фон выглядит одинаково и у
 *     светлой, и у тёмной версии, поэтому отмечает клиент.
 */
import { useEffect, useState, useRef } from 'react'
import { Loader2, Trash2, Upload, Star, Check, X, Pencil, ArrowUp, ArrowDown, Moon, Sun } from 'lucide-react'
import { api } from '@/lib/api'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

type Logo = {
  id: number
  url: string
  label: string | null
  on_dark: boolean
  is_primary: boolean
  sort_order: number
}

/** Тёмная подложка — тот же фирменный градиент, что в шапке страниц. */
const DARK = 'linear-gradient(45deg, #25455D, #0a1520)'

export default function BrandLogosField() {
  const [logos, setLogos] = useState<Logo[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const r = await api.brandLogos.list()
      setLogos(r.logos || [])
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить логотипы')
    } finally { setLoading(false) }
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return
    setUploading(true); setError(null)
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('kind', 'brand_logo')
        // ⚠️ Ключ токена — 'plusson_token' (две «с»), как во всём проекте.
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
        await api.brandLogos.create({ url })
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
    setLogos(prev => prev.map(l => ({ ...l, is_primary: l.id === id })))
    try { await api.brandLogos.update(id, { is_primary: true }) } catch { load() }
  }

  async function toggleDark(id: number) {
    const cur = logos.find(l => l.id === id)
    if (!cur) return
    const next = !cur.on_dark
    setLogos(prev => prev.map(l => l.id === id ? { ...l, on_dark: next } : l))
    try { await api.brandLogos.update(id, { on_dark: next }) } catch { load() }
  }

  async function saveLabel(id: number) {
    const label = draftLabel.trim()
    setLogos(prev => prev.map(l => l.id === id ? { ...l, label: label || null } : l))
    setEditingId(null)
    try { await api.brandLogos.update(id, { label }) } catch { load() }
  }

  async function move(id: number, dir: -1 | 1) {
    const i = logos.findIndex(l => l.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= logos.length) return
    const next = [...logos]
    ;[next[i], next[j]] = [next[j], next[i]]
    setLogos(next)
    try { await api.brandLogos.reorder(next.map(l => l.id)) } catch { load() }
  }

  async function remove(id: number) {
    if (!confirm('Удалить этот логотип? Файл удалится из хранилища.')) return
    setLogos(prev => prev.filter(l => l.id !== id))
    try { await api.brandLogos.delete(id) } catch { load() }
    load()
  }

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={14} className="animate-spin" /> Загружаем…</div>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-sm font-medium text-gray-800">Логотипы для организаторов</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Загрузите все версии знака — организатор скачает подходящую.
            Подпишите каждую: «Горизонтальный», «Квадратный», «Только знак»,
            «Монохром для печати».
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

      {logos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center">
          <p className="text-sm text-gray-400">Логотипов пока нет</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {logos.map((l, i) => (
            <div key={l.id} className={`rounded-xl overflow-hidden border bg-white ${
              l.is_primary ? 'border-[#FFCFA4] ring-2 ring-[#FFCFA4]/40' : 'border-gray-200'}`}>
              {/* ⚠️ object-contain и padding: логотип показываем целиком.
                  С object-cover, как у фото, у горизонтального знака срезало
                  бы половину названия. Подложка — по отметке on_dark. */}
              <div className="w-full aspect-[4/3] flex items-center justify-center p-3"
                   style={{ background: l.on_dark ? DARK : '#ffffff' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={l.url} alt={l.label || 'Логотип'}
                     className="max-w-full max-h-full object-contain" />
              </div>

              <div className="p-2 space-y-1.5">
                {editingId === l.id ? (
                  <div className="flex items-center gap-1">
                    <input autoFocus value={draftLabel} onChange={e => setDraftLabel(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveLabel(l.id); if (e.key === 'Escape') setEditingId(null) }}
                      placeholder="Например: Горизонтальный"
                      className="flex-1 min-w-0 text-xs border border-gray-200 rounded px-1.5 py-1" />
                    <button type="button" onClick={() => saveLabel(l.id)} className="p-1 text-green-600"><Check size={13} /></button>
                    <button type="button" onClick={() => setEditingId(null)} className="p-1 text-gray-400"><X size={13} /></button>
                  </div>
                ) : (
                  <button type="button"
                    onClick={() => { setEditingId(l.id); setDraftLabel(l.label || '') }}
                    className="w-full text-left text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1 truncate">
                    <Pencil size={11} className="shrink-0" />
                    <span className="truncate">{l.label || 'Без подписи'}</span>
                  </button>
                )}

                <div className="flex items-center gap-0.5">
                  <button type="button" onClick={() => makePrimary(l.id)}
                    title={l.is_primary ? 'Главный логотип' : 'Сделать главным'}
                    className={`p-1 rounded ${l.is_primary ? 'text-[#FFCFA4]' : 'text-gray-300 hover:text-gray-500'}`}>
                    <Star size={14} fill={l.is_primary ? 'currentColor' : 'none'} />
                  </button>
                  <button type="button" onClick={() => toggleDark(l.id)}
                    title={l.on_dark ? 'Показывать на тёмном фоне' : 'Показывать на светлом фоне'}
                    className={`p-1 rounded ${l.on_dark ? 'text-[#25455D]' : 'text-gray-300 hover:text-gray-500'}`}>
                    {l.on_dark ? <Moon size={13} /> : <Sun size={13} />}
                  </button>
                  <button type="button" onClick={() => move(l.id, -1)} disabled={i === 0}
                    title="Выше" className="p-1 rounded text-gray-300 hover:text-gray-500 disabled:opacity-30">
                    <ArrowUp size={13} />
                  </button>
                  <button type="button" onClick={() => move(l.id, 1)} disabled={i === logos.length - 1}
                    title="Ниже" className="p-1 rounded text-gray-300 hover:text-gray-500 disabled:opacity-30">
                    <ArrowDown size={13} />
                  </button>
                  <button type="button" onClick={() => remove(l.id)}
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
