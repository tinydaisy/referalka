'use client'
/**
 * <FileUploader /> — универсальный загрузчик файлов в R2 через POST /api/v1/uploads.
 *
 * Один компонент для всех мест: афиши конференций/мероприятий, лид-магниты,
 * сертификаты порогов, материалы реф-программы, фото коллабораторов.
 *
 * Режимы:
 *   - mode="single" — одно значение (фото спикера, лид-магнит, сертификат). value: string|null
 *   - mode="multiple" — массив (афиши, материалы шеринга). value: string[]
 *
 * Загруженный URL сохраняется родительским компонентом через onChange.
 * Удаление: DELETE /api/v1/uploads/by-url?url=... — стирает из R2 + client_files.
 */
import { useRef, useState } from 'react'
import { Upload, Trash2, Loader2, Copy, Check, ImageIcon, FileText, AlertCircle, Maximize2, Download, X } from 'lucide-react'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export type UploadKind = 'event_poster' | 'pre_reg_poster' | 'certificate' | 'referral_material' | 'lead_magnet' | 'speaker_photo' | 'speaker_cutout' | 'speaker_poster' | 'brand_photo' | 'brand_logo' | 'owner_photo' | 'funnel_media' | 'broadcast_photo' | 'event_video' | 'speaker_video' | 'referral_video' | 'landing_bg' | 'landing_media' | 'survey_media' | 'product_media' | 'material_media' | 'news_media' | 'cover_bg' | 'poster_bg' | 'testimonial'

const VIDEO_KIND_SET: ReadonlySet<UploadKind> = new Set<UploadKind>(['event_video', 'speaker_video', 'referral_video'])

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogg)(\?|$)/i
function isVideoUrl(url: string): boolean {
  return VIDEO_EXT_RE.test(url)
}
type PosterType = 'horizontal' | 'vertical' | 'square'

type SingleProps = {
  mode: 'single'
  value: string | null
  onChange: (url: string | null) => void
}
type MultipleProps = {
  mode: 'multiple'
  value: string[]
  onChange: (urls: string[]) => void
}

type CommonProps = {
  kind: UploadKind
  eventId?: number
  collaboratorId?: number
  posterType?: PosterType
  accept?: string                 // 'image/*' (по умолчанию) или 'image/*,application/pdf'
  aspectClass?: string            // 'aspect-square', 'aspect-video', 'aspect-[9/16]' — для превью
  emptyText?: string              // текст в пустой зоне дропа
  buttonLabel?: string            // подпись кнопки загрузки
}

type Props = CommonProps & (SingleProps | MultipleProps)

export default function FileUploader(props: Props) {
  const {
    kind, eventId, collaboratorId, posterType,
    accept = 'image/*',
    aspectClass = 'aspect-square',
    emptyText = 'Перетащите файл или нажмите «Загрузить»',
    buttonLabel = 'Загрузить',
  } = props

  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const urls: string[] = props.mode === 'multiple' ? props.value : (props.value ? [props.value] : [])

  /**
   * ⚠️⚠️ СКАЧИВАНИЕ ЧЕРЕЗ BLOB, А НЕ `<a download>`. Атрибут `download`
   * работает только для файлов С ТОГО ЖЕ домена: картинки лежат на S3, и
   * браузер его молча игнорировал — файл открывался во вкладке вместо
   * сохранения («при нажатии скачать не скачиваются», владелец 21.09.2026).
   *
   * Качаем содержимое сами и отдаём как локальный файл. Не вышло (сеть,
   * CORS) — открываем по-старому: лучше открыть, чем ничего.
   */
  async function downloadFile(u: string) {
    try {
      const r = await fetch(u)
      if (!r.ok) throw new Error(String(r.status))
      const blob = await r.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = (u.split('/').pop() || 'file').split('?')[0] || 'file'
      document.body.appendChild(a)
      a.click()
      a.remove()
      // ⚠️ Отзываем ссылку не сразу: Safari обрывает скачивание, если
      // сделать это в том же тике.
      setTimeout(() => URL.revokeObjectURL(href), 10000)
    } catch {
      window.open(u, '_blank', 'noreferrer')
    }
  }

  function copyUrl(url: string) {
    navigator.clipboard.writeText(url)
    setCopiedUrl(url)
    setTimeout(() => setCopiedUrl(null), 2000)
  }

  async function uploadOne(file: File): Promise<string> {
    // Клиентская проверка размера — до отправки на сервер.
    // Для видео (event_video / speaker_video) лимит 100 МБ (cap Cloudflare).
    // Для остального — 50 МБ (совпадает с nginx client_max_body_size и
    // Telegram bot API video lim).
    const isVideoKind = VIDEO_KIND_SET.has(kind)
    const MAX_BYTES = isVideoKind ? 100 * 1024 * 1024 : 50 * 1024 * 1024
    const MAX_MB = isVideoKind ? 100 : 50
    if (file.size > MAX_BYTES) {
      const sizeMb = (file.size / 1024 / 1024).toFixed(1)
      const hint = isVideoKind
        ? 'Сожмите видео (например, через QuickTime / Handbrake) или вырежьте короткий фрагмент.'
        : 'Telegram-бот не принимает файлы крупнее 50 МБ. Сожмите видео (например, через QuickTime / Handbrake) и попробуйте снова.'
      throw new Error(`Файл ${sizeMb} МБ — больше лимита ${MAX_MB} МБ. ${hint}`)
    }

    const fd = new FormData()
    fd.append('file', file)
    fd.append('kind', kind)
    if (eventId) fd.append('event_id', String(eventId))
    if (collaboratorId) fd.append('collaborator_id', String(collaboratorId))
    if (posterType) fd.append('poster_type', posterType)

    const token = (typeof window !== 'undefined' && localStorage.getItem('plusson_token')) || ''
    const r = await fetch(`${API_URL}/api/v1/uploads`, {
      method: 'POST',
      body: fd,
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) {
      if (r.status === 413) {
        const limit = VIDEO_KIND_SET.has(kind) ? '100 МБ' : '50 МБ'
        throw new Error(`Файл больше ${limit} — лимит превышен. Сожмите файл или загрузите поменьше.`)
      }
      const err = await r.json().catch(() => ({ detail: `HTTP ${r.status}` }))
      throw new Error(err.detail || `HTTP ${r.status}`)
    }
    const data = await r.json()
    return data.url as string
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setError(null)
    setUploading(true)
    try {
      const newUrls: string[] = []
      for (const f of Array.from(files)) {
        const url = await uploadOne(f)
        newUrls.push(url)
      }
      if (props.mode === 'multiple') {
        props.onChange([...props.value, ...newUrls])
      } else {
        // single — берём только первый, остальные игнор
        // если был старый — удалим из R2
        if (props.value) {
          deleteByUrl(props.value).catch(() => {})
        }
        props.onChange(newUrls[0])
      }
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function deleteByUrl(url: string) {
    const token = (typeof window !== 'undefined' && localStorage.getItem('plusson_token')) || ''
    await fetch(`${API_URL}/api/v1/uploads/by-url?url=${encodeURIComponent(url)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
  }

  async function removeUrl(url: string) {
    if (!confirm('Удалить файл?')) return
    deleteByUrl(url).catch(() => {})
    if (props.mode === 'multiple') {
      props.onChange(props.value.filter(u => u !== url))
    } else {
      props.onChange(null)
    }
  }

  const isImage = accept.includes('image')

  const hasFiles = urls.length > 0

  return (
    <div className="space-y-3">
      {/* Зона загрузки / drop. Когда файлы уже загружены — показываем компактную кнопку «Добавить ещё»
         (без эмпти-стейта и иконки картинки), иначе — полную дроп-зону с подсказкой. */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
        className={`rounded-xl p-3 flex items-center justify-between gap-3 transition-colors ${
          hasFiles
            ? 'border border-gray-200 bg-white'
            : `border-2 border-dashed ${dragOver ? 'border-brand bg-brand/5' : 'border-gray-200 bg-gray-50/50'} p-4`
        }`}
      >
        {!hasFiles && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            {isImage ? <ImageIcon size={16} /> : <FileText size={16} />}
            <span>{emptyText}</span>
          </div>
        )}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-sm font-medium text-gray-700 disabled:opacity-50 transition-colors ${hasFiles ? 'ml-auto' : ''}`}
        >
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {uploading ? 'Загрузка…' : (hasFiles && props.mode === 'multiple' ? 'Добавить ещё' : buttonLabel)}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={accept}
          multiple={props.mode === 'multiple'}
          className="hidden"
          onChange={e => handleFiles(e.target.files)}
        />
      </div>

      {/* Ошибка */}
      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Превью загруженных */}
      {urls.length > 0 && (
        <div className={`grid gap-3 ${props.mode === 'multiple' ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1 max-w-[240px]'}`}>
          {urls.map((url, i) => (
            <div key={i} className="flex flex-col gap-2">
              <div className={`relative ${aspectClass} rounded-xl overflow-hidden bg-gray-100 border border-gray-100`}>
                {isVideoUrl(url) ? (
                  <video src={url} controls className="w-full h-full object-cover bg-black" />
                ) : isImage ? (
                  <img
                    src={url}
                    alt={`file ${i+1}`}
                    onClick={() => setLightbox(url)}
                    className="w-full h-full object-cover cursor-zoom-in"
                  />
                ) : (
                  <a href={url} target="_blank" rel="noreferrer"
                    className="w-full h-full flex flex-col items-center justify-center text-gray-500 hover:text-brand">
                    <FileText size={32} />
                    <span className="text-xs mt-2">Открыть файл</span>
                  </a>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {isImage && !isVideoUrl(url) && (
                  <button
                    type="button"
                    onClick={() => setLightbox(url)}
                    className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-xs font-medium text-gray-700 transition-colors"
                    title="Раскрыть на весь экран"
                  >
                    <Maximize2 size={13} /> Раскрыть
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => downloadFile(url)}
                  className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-xs font-medium text-gray-700 transition-colors"
                  title="Скачать файл на компьютер"
                >
                  <Download size={13} /> Скачать
                </button>
                <button
                  type="button"
                  onClick={() => copyUrl(url)}
                  className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-xs font-medium text-gray-700 transition-colors"
                  title={url}
                >
                  {copiedUrl === url
                    ? <><Check size={13} className="text-green-600" /> Скопировано</>
                    : <><Copy size={13} /> Ссылка</>}
                </button>
                <button
                  type="button"
                  onClick={() => removeUrl(url)}
                  className="flex items-center justify-center px-2 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-red-50 hover:border-red-200 hover:text-red-600 text-xs font-medium text-gray-700 transition-colors"
                  title="Удалить"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Lightbox — раскрытие картинки на весь экран */}
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
