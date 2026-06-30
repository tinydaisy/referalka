'use client'
/**
 * <BroadcastMediaPicker /> — выбор медиа для рассылки: ФОТО или ВИДЕО.
 *
 * Зачем отдельный компонент, а не голый FileUploader:
 *  - переключатель Фото / Видео,
 *  - при загрузке видео — ПРЕДУПРЕЖДЕНИЯ (по требованию: гарантировать
 *    проигрывание встроенным плеером в Telegram):
 *      • не .mp4 → может не проигрываться внутри Telegram, лучше пересжать в MP4;
 *      • > 50 МБ → Telegram не покажет встроенным плеером, бот отправит ссылкой.
 *    В обоих случаях клиент сам решает: «всё равно загрузить» / «отменить».
 *
 * Значение наружу — { photo_url, video_url, media_type } через onChange.
 *   media_type: null | 'photo' | 'video'
 */
import { useRef, useState } from 'react'
import { Upload, Trash2, Loader2, Image as ImageIcon, Video as VideoIcon, AlertTriangle } from 'lucide-react'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// Telegram присылает встроенный плеер надёжно только для .mp4 (H.264/AAC).
const MP4_RE = /\.mp4$/i
// Видео крупнее 50 МБ Telegram-бот не отправит файлом → только ссылкой.
const TG_INLINE_VIDEO_MAX = 50 * 1024 * 1024
// Жёсткий лимит загрузки видео в наше хранилище (cap Cloudflare).
const UPLOAD_VIDEO_MAX = 100 * 1024 * 1024

export type BroadcastMedia = {
  photo_url: string | null
  video_url: string | null
  media_type: 'photo' | 'video' | null
}

type Props = {
  value: BroadcastMedia
  onChange: (v: BroadcastMedia) => void
}

export default function BroadcastMediaPicker({ value, onChange }: Props) {
  const [tab, setTab] = useState<'photo' | 'video'>(value.media_type === 'video' ? 'video' : 'photo')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const photoRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLInputElement>(null)

  // Драг-н-дроп: по типу брошенного файла сами решаем — фото или видео,
  // переключаем вкладку и шлём в нужный обработчик. Не зависит от текущей вкладки.
  function handleDrop(files: FileList | null) {
    if (!files || !files[0]) return
    const f = files[0]
    const isVideo = (f.type || '').startsWith('video/') || /\.(mp4|webm|mov|m4v|ogg)$/i.test(f.name)
    if (isVideo) {
      if (value.media_type === 'photo') clearMedia()
      setTab('video')
      handleVideo(files)
    } else {
      if (value.media_type === 'video') clearMedia()
      setTab('photo')
      handlePhoto(files)
    }
  }

  function clearMedia() {
    if (value.photo_url) deleteByUrl(value.photo_url)
    if (value.video_url) deleteByUrl(value.video_url)
    onChange({ photo_url: null, video_url: null, media_type: null })
  }

  function switchTab(next: 'photo' | 'video') {
    setError(null)
    setTab(next)
    // Переключение типа очищает чужое медиа, чтобы не отправить и фото, и видео.
    if (next === 'photo' && value.media_type === 'video') clearMedia()
    if (next === 'video' && value.media_type === 'photo') clearMedia()
  }

  async function deleteByUrl(url: string) {
    const token = (typeof window !== 'undefined' && localStorage.getItem('plusson_token')) || ''
    try {
      await fetch(`${API_URL}/api/v1/uploads/by-url?url=${encodeURIComponent(url)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch { /* ignore */ }
  }

  async function uploadFile(file: File, kind: 'broadcast_photo' | 'broadcast_video'): Promise<string> {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('kind', kind)
    const token = (typeof window !== 'undefined' && localStorage.getItem('plusson_token')) || ''
    const r = await fetch(`${API_URL}/api/v1/uploads`, {
      method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) {
      if (r.status === 413) throw new Error('Файл слишком большой (лимит 100 МБ для видео). Сожмите файл.')
      const err = await r.json().catch(() => ({ detail: `HTTP ${r.status}` }))
      throw new Error(err.detail || `HTTP ${r.status}`)
    }
    const data = await r.json()
    return data.url as string
  }

  async function handlePhoto(files: FileList | null) {
    if (!files || !files[0]) return
    const f = files[0]
    if (f.size > 50 * 1024 * 1024) {
      setError(`Фото ${(f.size / 1024 / 1024).toFixed(1)} МБ — больше 50 МБ. Сожмите изображение.`)
      return
    }
    setError(null); setUploading(true)
    try {
      const url = await uploadFile(f, 'broadcast_photo')
      onChange({ photo_url: url, video_url: null, media_type: 'photo' })
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки')
    } finally {
      setUploading(false)
      if (photoRef.current) photoRef.current.value = ''
    }
  }

  async function handleVideo(files: FileList | null) {
    if (!files || !files[0]) return
    const f = files[0]
    setError(null)

    // Жёсткий стоп: больше 100 МБ наше хранилище не примет.
    if (f.size > UPLOAD_VIDEO_MAX) {
      setError(`Видео ${(f.size / 1024 / 1024).toFixed(1)} МБ — больше 100 МБ, загрузить нельзя. Сожмите видео (QuickTime / Handbrake) или вырежьте фрагмент.`)
      if (videoRef.current) videoRef.current.value = ''
      return
    }

    // Предупреждения с выбором за клиентом (гарантия отправки):
    const isMp4 = MP4_RE.test(f.name)
    const tooBigForInline = f.size > TG_INLINE_VIDEO_MAX
    const warnings: string[] = []
    if (tooBigForInline) {
      warnings.push(
        `Видео ${(f.size / 1024 / 1024).toFixed(1)} МБ — больше 50 МБ. ` +
        `Telegram не покажет его встроенным плеером: бот сможет отправить только ССЫЛКОЙ на видео. ` +
        `Чтобы видео проигрывалось прямо в сообщении — сожмите его до 50 МБ.`
      )
    }
    if (!isMp4) {
      warnings.push(
        `Формат файла — не MP4. Внутри Telegram такое видео может не проигрываться. ` +
        `Надёжнее пересжать в MP4 (H.264).`
      )
    }
    if (warnings.length > 0) {
      const ok = window.confirm(
        '⚠️ ' + warnings.join('\n\n') +
        '\n\n«ОК» — всё равно загрузить (видео уйдёт ссылкой, если Telegram не примет файлом).' +
        '\n«Отмена» — отменить и пересжать видео.'
      )
      if (!ok) {
        if (videoRef.current) videoRef.current.value = ''
        return
      }
    }

    setUploading(true)
    try {
      const url = await uploadFile(f, 'broadcast_video')
      onChange({ photo_url: null, video_url: url, media_type: 'video' })
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки')
    } finally {
      setUploading(false)
      if (videoRef.current) videoRef.current.value = ''
    }
  }

  const hasPhoto = !!value.photo_url && value.media_type === 'photo'
  const hasVideo = !!value.video_url && value.media_type === 'video'

  return (
    <div className="space-y-2">
      {/* Переключатель Фото / Видео */}
      <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm">
        <button type="button" onClick={() => switchTab('photo')}
          className={`flex items-center gap-1.5 px-3 py-1.5 ${tab === 'photo' ? 'bg-brand text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
          <ImageIcon size={14} /> Фото
        </button>
        <button type="button" onClick={() => switchTab('video')}
          className={`flex items-center gap-1.5 px-3 py-1.5 border-l border-gray-200 ${tab === 'video' ? 'bg-brand text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
          <VideoIcon size={14} /> Видео
        </button>
      </div>

      {/* Подсказка про видео */}
      {tab === 'video' && !hasVideo && (
        <div className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            Чтобы видео проигрывалось прямо в сообщении Telegram — нужен <b>MP4 до 50 МБ</b>.
            Если файл больше или другой формат — мы предупредим: видео уйдёт ссылкой.
          </span>
        </div>
      )}

      {/* Зона загрузки */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); handleDrop(e.dataTransfer.files) }}
        className={`rounded-xl border-2 border-dashed p-3 flex items-center justify-between gap-3 transition-colors ${dragOver ? 'border-brand bg-brand/5' : 'border-gray-200 bg-gray-50/50'}`}
      >
        <span className="text-sm text-gray-500">
          {tab === 'photo'
            ? (hasPhoto ? 'Фото загружено' : 'Перетащите файл или загрузите фото (до 50 МБ)')
            : (hasVideo ? 'Видео загружено' : 'Перетащите файл или загрузите видео (MP4 до 50 МБ — встроенный плеер)')}
        </span>
        <button type="button"
          onClick={() => (tab === 'photo' ? photoRef.current : videoRef.current)?.click()}
          disabled={uploading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-sm font-medium text-gray-700 disabled:opacity-50">
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {uploading ? 'Загрузка…' : 'Загрузить'}
        </button>
        <input ref={photoRef} type="file" accept="image/*" className="hidden" onChange={e => handlePhoto(e.target.files)} />
        <input ref={videoRef} type="file" accept="video/mp4,video/webm,video/quicktime,video/*" className="hidden" onChange={e => handleVideo(e.target.files)} />
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}

      {/* Превью */}
      {hasPhoto && (
        <div className="flex items-start gap-2">
          <img src={value.photo_url!} alt="" className="w-40 rounded-lg border border-gray-200 object-cover" />
          <button type="button" onClick={clearMedia}
            className="p-1.5 rounded-lg border border-gray-200 hover:bg-red-50 hover:text-red-600 text-gray-500" title="Убрать">
            <Trash2 size={14} />
          </button>
        </div>
      )}
      {hasVideo && (
        <div className="flex items-start gap-2">
          <video src={value.video_url!} controls className="w-56 rounded-lg border border-gray-200 bg-black" />
          <button type="button" onClick={clearMedia}
            className="p-1.5 rounded-lg border border-gray-200 hover:bg-red-50 hover:text-red-600 text-gray-500" title="Убрать">
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
