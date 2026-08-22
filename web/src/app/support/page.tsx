/**
 * Публичная страница поддержки — /support
 *
 * ⚠️ Ведём сюда, а не прямо в бота: поддержка работает в двух мессенджерах,
 * и человек должен выбрать свой. Список каналов общий с кабинетом
 * (lib/support.ts) — двух копий быть не должно.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { LifeBuoy, ExternalLink } from 'lucide-react'
import PublicShell from '@/components/public/PublicShell'
import { SUPPORT_CHANNELS } from '@/lib/support'

const BRAND = '#25455D'

export const metadata: Metadata = {
  title: 'Поддержка — iViSiON: ПЛЮСОН',
  description: 'Напишите нам в Telegram или MAX — отвечают живые люди. Плюс инструкции по шагам в базе знаний.',
  alternates: { canonical: 'https://pluson.ru/support' },
}

export default function PublicSupportPage() {
  return (
    <PublicShell>
      <div className="max-w-2xl">
        <div className="flex items-start gap-3 mb-6">
          <div className="p-2 rounded-lg text-white shrink-0"
               style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <LifeBuoy size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Поддержка</h1>
            <p className="text-sm text-gray-500 mt-1">
              Отвечают живые люди, а не бот с номером обращения. Выберите, где вам удобнее.
            </p>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          {SUPPORT_CHANNELS.map(ch => (
            <a key={ch.key} href={ch.url} target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-3 p-4 bg-white rounded-2xl border border-gray-100 hover:border-gray-300 hover:shadow-sm transition-all">
              <span className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold shrink-0"
                    style={{ background: ch.color }}>
                {ch.label[0]}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block font-semibold" style={{ color: BRAND }}>{ch.label}</span>
                <span className="block text-xs text-gray-400 truncate">{ch.hint}</span>
              </span>
              <ExternalLink size={16} className="text-gray-300 shrink-0" />
            </a>
          ))}
        </div>

        <div className="mt-6 p-4 bg-gray-50 rounded-xl border border-gray-200">
          <div className="text-sm font-semibold text-gray-800 mb-1">
            Может, ответ уже есть
          </div>
          <p className="text-sm text-gray-600">
            В <Link href="/help" className="text-blue-600 hover:underline">базе знаний</Link>{' '}
            инструкции по шагам — со скриншотами и поиском.
          </p>
        </div>
      </div>
    </PublicShell>
  )
}
