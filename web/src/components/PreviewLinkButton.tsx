'use client'

/**
 * Кнопка «Посмотреть страницу» — открывает лендинг, даже если он ещё черновик.
 *
 * ⚠️ Зачем отдельная кнопка, а не обычная ссылка: черновик посторонним отдаёт
 * 404, и владелец на своей же странице видел «Страница не найдена» — со стороны
 * это выглядит как поломка. Просто «открыть по адресу» тут не работает, нужен
 * подписанный токен, а получить его можно только запросом из кабинета.
 *
 * ⚠️ Токен берём ПО КЛИКУ, а не при отрисовке страницы: он живёт 2 часа, и
 * запрашивать его на каждое открытие карточки — лишние вызовы ради кнопки,
 * которую могут не нажать.
 */
import { useState } from 'react'
import { Eye } from 'lucide-react'
import { api } from '@/lib/api'

export default function PreviewLinkButton({
  url,
  label = 'Посмотреть страницу',
  className = '',
}: {
  /** Публичный адрес страницы, без параметра предпросмотра. */
  url: string
  label?: string
  className?: string
}) {
  const [loading, setLoading] = useState(false)

  const open = async () => {
    setLoading(true)
    try {
      const res: any = await api.previewToken()
      const sep = url.includes('?') ? '&' : '?'
      window.open(`${url}${sep}preview=${encodeURIComponent(res.token)}`, '_blank')
    } catch {
      // Токен не выдали — открываем как есть: если страница опубликована,
      // она откроется и без него.
      window.open(url, '_blank')
    } finally { setLoading(false) }
  }

  return (
    <button
      onClick={open}
      disabled={loading}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 ${className}`}
      title="Откроется и до публикации — ссылка действует 2 часа"
    >
      <Eye size={14} /> {loading ? 'Открываем…' : label}
    </button>
  )
}
