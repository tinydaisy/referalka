'use client'

/**
 * Раздел «Отзывы и кейсы» (миграция 249).
 *
 * Общая база на клиента: один отзыв нужен и на лендинге конференции, и в
 * рассылке, и на следующем событии. Раньше файлы грузились прямо в блок
 * галереи — переиспользовать их было нельзя.
 *
 * Отбор в галерею лендинга идёт ПО ТЕГАМ, поэтому массовая загрузка сразу
 * принимает общий набор меток на всю пачку.
 */
import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Loader2, Image as ImageIcon, Video, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'

type Kind = 'photo' | 'video'

/**
 * Обложка внешнего видео по ссылке.
 *
 * YouTube отдаёт превью по id ролика: img.youtube.com/vi/{id}/hqdefault.jpg.
 * ⚠️ Берём hqdefault, а не maxresdefault: последнего у Shorts и старых роликов
 * часто нет, и вместо картинки приходит заглушка-«битое превью».
 *
 * VK и Rutube публичного адреса обложки по ссылке не дают — для них null,
 * показывается иконка (это честнее, чем битая картинка).
 */
function videoThumb(url: string | null): string | null {
  if (!url) return null
  const m =
    url.match(/(?:youtu\.be\/|youtube\.com\/(?:shorts\/|live\/|embed\/|watch\?v=))([\w-]{6,})/i)
  return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : null
}

export default function TestimonialsPage() {
  const { me } = useMe()
  const [items, setItems] = useState<any[]>([])
  const [tags, setTags] = useState<any[]>([])
  const [kind, setKind] = useState<Kind>('photo')
  const [tag, setTag] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [bulkTags, setBulkTags] = useState('')
  const [videoUrls, setVideoUrls] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const hasFeature = (me?.features || []).includes('testimonials')

  const load = async () => {
    try {
      const res = await api.testimonials.list({ kind, tag: tag || undefined })
      setItems(res.items || [])
      setTags(res.tags || [])
    } catch (e: any) {
      if (!String(e?.message || '').includes('недоступен')) {
        alert(e?.message || 'Не удалось загрузить')
      }
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [kind, tag])

  /* Массовая загрузка фото: файлы → R2 → записи в базе с общими тегами. */
  const uploadPhotos = async (files: FileList) => {
    const list = Array.from(files)
    if (!list.length) return
    setUploading(true)
    try {
      const urls: string[] = []
      for (const f of list) {
        const fd = new FormData()
        fd.append('file', f)
        fd.append('kind', 'landing_media')
        const res = await fetch('/api/v1/uploads', {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
          body: fd,
        })
        if (!res.ok) throw new Error('Не удалось загрузить файл')
        const data = await res.json()
        if (data?.url) urls.push(data.url)
      }
      if (urls.length) {
        await api.testimonials.bulk({
          kind: 'photo',
          urls,
          tags: bulkTags.split(',').map(t => t.trim()).filter(Boolean),
        })
      }
      await load()
    } catch (e: any) { alert(e?.message || 'Не удалось загрузить') }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = '' }
  }

  /* Видео добавляются ссылками — файлы видео тяжёлые и хранить их незачем. */
  const addVideos = async () => {
    const urls = videoUrls.split('\n').map(u => u.trim()).filter(Boolean)
    if (!urls.length) { alert('Вставьте ссылки на видео, по одной в строке'); return }
    setUploading(true)
    try {
      await api.testimonials.bulk({
        kind: 'video',
        urls,
        tags: bulkTags.split(',').map(t => t.trim()).filter(Boolean),
      })
      setVideoUrls('')
      await load()
    } catch (e: any) { alert(e?.message || 'Не удалось добавить') }
    finally { setUploading(false) }
  }

  const remove = async (id: number) => {
    if (!confirm('Удалить эту запись?')) return
    try { await api.testimonials.remove(id); await load() }
    catch (e: any) { alert(e?.message || 'Не удалось удалить') }
  }

  const setItemTags = async (id: number, value: string) => {
    try {
      await api.testimonials.update(id, {
        tags: value.split(',').map(t => t.trim()).filter(Boolean),
      })
      await load()
    } catch (e: any) { alert(e?.message || 'Не удалось сохранить') }
  }

  if (!hasFeature && !loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 text-gray-600">
        Раздел «Отзывы и кейсы» недоступен на вашем тарифе.
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Отзывы и кейсы</h1>
        <p className="mt-1 text-sm text-gray-500">
          Общая база: отмечайте метками и подставляйте в галерею любого лендинга.
        </p>
      </div>

      {/* Тип */}
      <div className="mb-4 flex gap-1 border-b border-gray-200">
        {([['photo', 'Фото-отзывы'], ['video', 'Видео-отзывы']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setKind(k as Kind)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium ${
              kind === k ? 'border-brand text-brand'
                         : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Метки */}
      {!!tags.length && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            onClick={() => setTag('')}
            className={`rounded-full border px-3 py-1 text-sm ${
              !tag ? 'border-brand bg-brand/5 font-medium text-brand'
                   : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Все
          </button>
          {tags.map((t: any) => (
            <button
              key={t.tag}
              onClick={() => setTag(t.tag === tag ? '' : t.tag)}
              className={`rounded-full border px-3 py-1 text-sm ${
                tag === t.tag ? 'border-brand bg-brand/5 font-medium text-brand'
                              : 'border-gray-300 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {t.tag} <span className="text-gray-400">{t.cnt}</span>
            </button>
          ))}
        </div>
      )}

      {/* Добавление */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3">
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Метки для загружаемых (через запятую)
          </label>
          <input
            type="text" value={bulkTags}
            onChange={e => setBulkTags(e.target.value)}
            placeholder="конференция, частушки, ivision-8"
            className="input"
          />
          <p className="mt-1 text-xs text-gray-500">
            По меткам отзывы подставляются в галерею лендинга.
          </p>
        </div>

        {kind === 'photo' ? (
          <>
            <input
              ref={fileRef}
              type="file" accept="image/*" multiple
              onChange={e => e.target.files && uploadPhotos(e.target.files)}
              className="hidden"
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="btn-primary inline-flex items-center gap-2 disabled:opacity-60"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Загрузить фото (можно сразу много)
            </button>
          </>
        ) : (
          <>
            <textarea
              rows={4} value={videoUrls}
              onChange={e => setVideoUrls(e.target.value)}
              placeholder={'Ссылки на видео, по одной в строке:\nhttps://youtu.be/…\nhttps://vk.com/video…'}
              className="input"
            />
            <button
              onClick={addVideos} disabled={uploading}
              className="btn-primary mt-3 inline-flex items-center gap-2 disabled:opacity-60"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Добавить видео
            </button>
          </>
        )}
      </div>

      {/* Список */}
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin" /> Загружаем…
        </div>
      ) : !items.length ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-gray-500">
          Пока пусто. Загрузите первые {kind === 'photo' ? 'скриншоты отзывов' : 'видео'}.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map(it => (
            <div key={it.id} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <div className="relative">
                {it.kind === 'photo' ? (
                  <img src={it.url} alt="" className="aspect-[4/3] w-full object-cover" />
                ) : /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(it.url || '') ? (
                  // Свой видеофайл показываем плеером — иконка-заглушка не
                  // давала понять, что именно загружено.
                  <video src={it.url} controls preload="metadata"
                         poster={it.preview_url || undefined}
                         className="aspect-[4/3] w-full bg-black object-contain" />
                ) : videoThumb(it.url) ? (
                  // Внешнее видео (YouTube) — <video src> его проиграть не может,
                  // это страница, а не файл. Показываем обложку ролика, иначе
                  // клиент видит серую плашку и не понимает, что за отзыв.
                  <a href={it.url} target="_blank" rel="noreferrer"
                     className="relative block aspect-[4/3] w-full bg-black">
                    <img src={videoThumb(it.url)!} alt=""
                         className="h-full w-full object-cover"
                         onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/60">
                        <Video className="h-5 w-5 text-white" />
                      </span>
                    </span>
                  </a>
                ) : (
                  <div className="flex aspect-[4/3] w-full items-center justify-center bg-gray-100">
                    <Video className="h-8 w-8 text-gray-400" />
                  </div>
                )}
                <button
                  onClick={() => remove(it.id)}
                  className="absolute right-2 top-2 rounded-full bg-white/90 p-1.5 text-gray-500 hover:text-red-600"
                  title="Удалить"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-3">
                {it.kind === 'video' && (
                  <a href={it.url} target="_blank" rel="noreferrer"
                     className="mb-2 block truncate text-xs text-blue-600 hover:underline">
                    {it.url}
                  </a>
                )}
                <input
                  type="text"
                  defaultValue={(it.tags || []).join(', ')}
                  onBlur={e => setItemTags(it.id, e.target.value)}
                  placeholder="метки через запятую"
                  className="w-full rounded border border-gray-200 px-2 py-1 text-xs"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
