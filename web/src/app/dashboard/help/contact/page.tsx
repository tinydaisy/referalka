'use client'

import Link from 'next/link'
import { LifeBuoy, ExternalLink } from 'lucide-react'
import { SUPPORT_CHANNELS } from '@/lib/support'
import { PlatformLogo } from '@/components/PlatformLogo'

const BRAND = '#25455D'

/** Боты техподдержки ПЛЮСОНа (сервисный клиент id 3).
 *  Сообщение из любого падает в Диалоги + уведомление #user_message. */
// Список общий с публичной страницей /support — см. lib/support.ts
const CHANNELS = SUPPORT_CHANNELS

export default function SupportContactPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Тех.поддержка</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <LifeBuoy size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Написать в тех.поддержку</h1>
          <p className="text-sm text-gray-500 mt-1">
            Выберите удобный мессенджер, куда задать свой вопрос по ПЛЮСОНу.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {CHANNELS.map(ch => (
          <a
            key={ch.key}
            href={ch.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center gap-3 p-4 bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-md hover:border-gray-300 transition-all"
          >
            {/* ⚠️ Логотип площадки, а не первая буква названия: «T» и «M» в
                кружке читались как заглушка. Компонент общий — PlatformLogo. */}
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: ch.color }}
            >
              <PlatformLogo slug={ch.key} size={24} color="#fff" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-gray-900 flex items-center gap-1.5">
                {ch.label}
                <ExternalLink size={13} className="text-gray-400 group-hover:text-gray-600" />
              </div>
              <div className="text-xs text-gray-500 truncate">{ch.hint}</div>
            </div>
          </a>
        ))}
      </div>

      <div className="mt-6 p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Сначала посмотрите инструкции</div>
        <p className="text-sm text-gray-600">
          Возможно, ответ уже есть —{' '}
          <Link href="/dashboard/help" className="text-blue-600 hover:underline">
            открыть инструкции
          </Link>
        </p>
      </div>
    </div>
  )
}
