'use client'
import { UserCircle } from 'lucide-react'
import { useLang } from '@/contexts/LangContext'

export default function ClientsPage() {
  const { lang } = useLang()

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          {lang === 'ru' ? 'Контакты' : 'Contacts'}
        </h1>
        <p className="text-gray-500 mt-1">
          {lang === 'ru'
            ? 'Все пользователи бота, участвовавшие в ваших событиях'
            : 'All bot users who participated in your events'}
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
        <div className="w-20 h-20 rounded-full gradient-bg flex items-center justify-center mx-auto mb-6">
          <UserCircle size={36} className="text-white" />
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-3">
          {lang === 'ru' ? 'Скоро' : 'Coming soon'}
        </h2>
        <p className="text-gray-500 max-w-sm mx-auto">
          {lang === 'ru'
            ? 'База клиентов будет доступна в следующем обновлении. Здесь вы увидите всех участников ваших событий в одном месте.'
            : 'The client base will be available in the next update. Here you will see all participants of your events in one place.'}
        </p>
      </div>
    </div>
  )
}
