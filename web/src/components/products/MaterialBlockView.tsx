'use client'

/**
 * Показ ОДНОГО блока материала (миграция 294) — текст, картинка, видео, файл,
 * аудио, кнопка.
 *
 * ⚠️ Общий компонент: он нужен и в списке материалов кабинета покупателя, и на
 * отдельной странице урока. Копия в каждом месте разъехалась бы — например,
 * ссылка стала бы кликабельной в одном и осталась текстом в другом.
 *
 * ⚠️ Санитайз текста обязателен: значение приходит из базы, куда могло попасть
 * импортом или через API мимо редактора.
 */
import { FileText, ExternalLink } from 'lucide-react'
import SafeHtml from '@/components/SafeHtml'
import LazyVideo from '@/components/LazyVideo'

export default function MaterialBlockView({ block }: { block: any }) {
  const { kind, title, body, url } = block

  if (kind === 'text') {
    // ⚠️ prose-подобные правила заданы в SafeHtml: там ссылки внутри текста
    // становятся кликабельными и подчёркнутыми. Без этого урок с ссылкой на
    // майндкарту выглядел просто текстом, и человек не понимал, что по нему жать.
    return <SafeHtml html={body} className="text-[15px] leading-relaxed text-gray-800" />
  }

  if (kind === 'video' && url) {
    return (
      <div>
        {title && <div className="mb-1 text-sm font-medium text-gray-700">{title}</div>}
        {/* ⚠️ Плеер грузится по клику: в уроке видео бывает несколько, и все
            они тянули бы плеер сразу при открытии страницы. */}
        <div className="overflow-hidden rounded-xl bg-black">
          {/* ⚠️ Обложка передаётся явно: у VK и Rutube её нельзя достать из
              ссылки, и без неё видео выглядит чёрным прямоугольником. У YouTube
              плеер добудет сам, если поле пустое. */}
          <LazyVideo url={url} poster={block.poster_url || null}
                     title={title || undefined} className="aspect-video w-full" />
        </div>
      </div>
    )
  }

  if (kind === 'image' && url) {
    return (
      <figure>
        <img src={url} alt={title || ''} className="w-full rounded-xl" />
        {title && <figcaption className="mt-1 text-xs text-gray-500">{title}</figcaption>}
      </figure>
    )
  }

  if (kind === 'audio' && url) {
    return (
      <div>
        {title && <div className="mb-1 text-sm text-gray-700">{title}</div>}
        <audio src={url} controls className="w-full" />
      </div>
    )
  }

  if (kind === 'file' && url) {
    return (
      <a href={url} target="_blank" rel="noreferrer"
         className="flex items-center gap-3 rounded-xl border border-gray-200 p-3 transition hover:border-gray-300">
        <FileText size={18} className="shrink-0 text-gray-400" />
        <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
          {title || 'Скачать файл'}
        </span>
        <ExternalLink size={15} className="shrink-0 text-gray-300" />
      </a>
    )
  }

  if (kind === 'button' && url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="btn-gold inline-block">
        {title || 'Открыть'}
      </a>
    )
  }

  return null
}
