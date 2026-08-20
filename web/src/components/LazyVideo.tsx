'use client'

/**
 * Видео с «фасадом»: пока не нажали ▶, плеер не грузится вовсе.
 *
 * ⚠️ Зачем. `<iframe loading="lazy">` для YouTube экономит мало — браузер тянет
 * плеер, как только блок подходит к экрану: ~0,5 МБ и несколько запросов НА
 * КАЖДОЕ видео. На лендинге с галереей отзывов это мегабайты трафика ещё до
 * того, как посетитель что-то нажал, и страница ощутимо тормозит на телефоне.
 * Тот же приём применён на лендинге чемпионата спикеров iViSiON.
 *
 * Работает и для наших файлов (mp4 в хранилище): у <video> без клика стоит
 * preload="none" — браузер не качает даже начало файла.
 */
import { useState } from 'react'
import { embedUrl, isFileVideo, videoThumbUrl } from '@/lib/videoEmbed'

export default function LazyVideo({
  url, poster, title, className, style, objectFit = 'cover',
}: {
  url: string
  poster?: string | null
  title?: string
  className?: string
  style?: React.CSSProperties
  objectFit?: 'cover' | 'contain'
}) {
  const [playing, setPlaying] = useState(false)
  const thumb = poster || videoThumbUrl(url)

  // Наш файл: тег <video>. До клика preload="none" — трафика ноль.
  if (isFileVideo(url)) {
    return (
      <video
        src={url}
        poster={thumb || undefined}
        controls
        playsInline
        preload={playing ? 'metadata' : 'none'}
        onPlay={() => setPlaying(true)}
        className={className}
        style={{ background: '#000', objectFit, ...style }}
      />
    )
  }

  // Внешняя площадка. Плеер вставляем только по клику — с autoplay,
  // чтобы клик по обложке сразу запускал ролик, а не требовал второго.
  if (playing) {
    const src = embedUrl(url)
    return (
      <iframe
        src={src + (src.includes('?') ? '&' : '?') + 'autoplay=1'}
        className={className}
        style={style}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
        title={title || 'Видео'}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-label={title ? `Смотреть: ${title}` : 'Смотреть видео'}
      className={className}
      style={{ position: 'relative', background: '#000', border: 0, padding: 0,
               cursor: 'pointer', display: 'block', ...style }}
    >
      {thumb && (
        <img
          src={thumb}
          alt={title || ''}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit, display: 'block' }}
          // Обложки у VK/Rutube нет, у YouTube может не быть hqdefault —
          // прячем картинку, остаётся тёмная плашка с кнопкой.
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
        />
      )}
      <span style={{
        position: 'absolute', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{
          width: 62, height: 44, borderRadius: 12,
          background: 'rgba(0,0,0,.62)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 12px rgba(0,0,0,.35)',
        }}>
          <svg width="20" height="22" viewBox="0 0 20 22" fill="#fff" aria-hidden>
            <path d="M0 1.6c0-1.3 1.4-2 2.5-1.4l16 9.4c1.1.6 1.1 2.2 0 2.8l-16 9.4C1.4 22.4 0 21.7 0 20.4V1.6z" />
          </svg>
        </span>
      </span>
    </button>
  )
}
