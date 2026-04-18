'use client'
import { Trophy } from 'lucide-react'
import { useLang } from '@/contexts/LangContext'

export default function RaffleTab() {
  const { lang } = useLang()
  return (
    <div className="max-w-2xl">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
        <div className="w-16 h-16 rounded-full gradient-bg flex items-center justify-center mx-auto mb-5">
          <Trophy size={28} className="text-white" />
        </div>
        <h2 className="text-lg font-bold text-gray-900 mb-2">
          {lang === 'ru' ? 'Раздел в разработке' : 'In development'}
        </h2>
        <p className="text-gray-500 text-sm max-w-xs mx-auto">
          {lang === 'ru'
            ? 'Механика розыгрышей среди участников появится в одном из следующих обновлений.'
            : 'Raffle mechanics for participants will be available in an upcoming update.'}
        </p>
      </div>
    </div>
  )
}
