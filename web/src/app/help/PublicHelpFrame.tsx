'use client'
/**
 * Обёртка публичной статьи базы знаний.
 *
 * Зачем. Статьи написаны для кабинета, и внутри них ~119 ссылок вида
 * `/dashboard/help/...` плюс ссылки в разделы кабинета. Снаружи такая ссылка
 * увела бы человека на страницу входа — навигация по базе знаний сломалась бы
 * на первом же клике.
 *
 * ⚠️ Ссылки переписываются ПЕРЕХВАТОМ КЛИКА, а не правкой 60 статей. Причина:
 * статьи должны остаться одним файлом на кабинет и на публичную версию. Две
 * копии разъехались бы в первый же месяц.
 *
 *   /dashboard/help/что-то  → /help/что-то   (остаёмся в публичной базе)
 *   /dashboard/остальное    → /login          (нужен кабинет — показываем вход)
 */
import { useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function PublicHelpFrame({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()

  useEffect(() => {
    const el = ref.current
    if (!el) return

    function onClick(e: MouseEvent) {
      // Модификаторы и средняя кнопка — «открыть в новой вкладке». Не мешаем.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return

      const a = (e.target as HTMLElement)?.closest('a')
      if (!a) return

      const href = a.getAttribute('href') || ''
      if (!href.startsWith('/dashboard')) return

      e.preventDefault()
      router.push(
        href.startsWith('/dashboard/help')
          ? href.replace('/dashboard/help', '/help')
          : '/login'
      )
    }

    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [router])

  return (
    <div ref={ref} className="public-help">
      {/* Статьи рисуют свои хлебные крошки «Дашборд / Инструкции / …».
          Снаружи они ведут в закрытый раздел и сбивают с толку — прячем.
          Через CSS, а не правкой 16 файлов: статья должна оставаться одна
          на кабинет и на публичную версию.
          Свои крошки («База знаний / Статья») рисует страница выше. */}
      <style jsx global>{`
        .public-help div:has(> a[href="/dashboard"]) {
          display: none;
        }
      `}</style>
      {children}
    </div>
  )
}
