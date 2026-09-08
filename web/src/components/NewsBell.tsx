'use client'

/**
 * Колокольчик новостей в шапке кабинета, рядом с бейджем подписки.
 *
 * ⚠️ Показываем ДО 5 последних — не весь список: длинная лента в выпадашке
 * нечитаема, а весь список открывается отдельной страницей.
 *
 * ⚠️ Цифра и список берутся из общего useNews вместе с плашкой. Свой запрос
 * здесь развёл бы цифру со списком: закрыл плашку — счётчик остался прежним.
 */
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Bell } from 'lucide-react'
import { useNews } from '@/hooks/useNews'

function formatDate(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'short', timeZone: 'Europe/Moscow',
    })
  } catch { return '' }
}

export default function NewsBell() {
  const { news, unread, markRead } = useNews()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // Клик мимо — закрыть. ⚠️ Это выпадашка-просмотр, а не форма: терять здесь
  // нечего, поэтому запрет на закрытие по фону (правило для модалок-форм)
  // сюда не относится.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const items = news.slice(0, 5)

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className="relative p-2 rounded-lg hover:bg-gray-100 transition text-gray-600"
        title="Новости ПЛЮСОНа"
        aria-label="Новости ПЛЮСОНа"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center
                       justify-center text-[10px] font-bold rounded-full"
            style={{ background: '#FFCFA4', color: '#25455D' }}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white rounded-xl
                        border border-gray-200 shadow-lg z-50 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 text-xs font-semibold text-gray-500">
            Новости ПЛЮСОНа
          </div>

          {items.length === 0 && (
            <div className="px-4 py-6 text-sm text-gray-500 text-center">
              Пока новостей нет
            </div>
          )}

          {items.map(n => (
            <Link
              key={n.id}
              href={`/dashboard/news#news-${n.id}`}
              onClick={() => { markRead(n.id); setOpen(false) }}
              className="block px-4 py-3 hover:bg-gray-50 transition border-b border-gray-50 last:border-0"
            >
              <div className={`text-sm leading-snug ${n.is_read ? 'text-gray-500' : 'font-semibold text-gray-900'}`}>
                {!n.is_read && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 align-middle" />
                )}
                {n.title}
              </div>
              <div className="text-[11px] text-gray-400 mt-0.5">{formatDate(n.published_at)}</div>
            </Link>
          ))}

          <Link
            href="/dashboard/news"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm font-semibold text-center border-t border-gray-100
                       hover:bg-gray-50 transition"
            style={{ color: '#25455D' }}
          >
            Показать все
          </Link>
        </div>
      )}
    </div>
  )
}
