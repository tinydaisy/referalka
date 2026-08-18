'use client'

/**
 * Кнопка «Скачать PDF» — лендинг одним файлом, в мобильной вёрстке.
 *
 * ⚠️ Зачем: у части аудитории ссылка не открывается вовсе — корпоративная сеть
 * режет незнакомый домен, встроенный браузер мессенджера падает, интернета
 * может не быть. Таким людям организатор отправляет файл: показать страницу
 * больше нечем.
 *
 * ⚠️ Сборка занимает секунды (браузер на сервере открывает страницу, ждёт
 * шрифты и картинки, печатает). Поэтому кнопка обязана показывать процесс —
 * без этого человек жмёт её повторно, считая, что «не работает», и запускает
 * вторую печать поверх первой.
 *
 * ⚠️ Работает и у ЧЕРНОВИКА: бэкенд сам подставляет токен предпросмотра. PDF
 * нужен как раз на согласовании, до публикации.
 */
import { useState } from 'react'
import { FileDown, Loader2 } from 'lucide-react'

export default function LandingPdfButton({
  onDownload,
  className = '',
  title = 'Страница одним файлом — как она выглядит на телефоне. Удобно отправить тем, у кого не открывается ссылка.',
}: {
  /** Что скачать: вызывается по клику, ошибку бросает наверх. */
  onDownload: () => Promise<void>
  className?: string
  title?: string
}) {
  const [busy, setBusy] = useState(false)

  const click = async () => {
    if (busy) return                       // защита от второго запуска печати
    setBusy(true)
    try {
      await onDownload()
    } catch (e: any) {
      alert(e?.message || 'Не получилось собрать PDF. Попробуйте ещё раз.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={click}
      disabled={busy}
      title={title}
      className={`inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 ${className}`}
    >
      {busy
        ? <><Loader2 className="h-4 w-4 animate-spin" /> Собираем PDF…</>
        : <><FileDown className="h-4 w-4" /> Скачать PDF</>}
    </button>
  )
}
