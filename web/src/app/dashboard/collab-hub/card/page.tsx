'use client'
import { ArrowLeft } from 'lucide-react'
import { HubHeader, MyCardView } from '../_components/shared'

export default function CollabCardPage() {
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      {/* ⚠️ Ссылка назад: со страницы своей карточки некуда было вернуться —
          ни стрелки, ни ссылки, только через меню сайдбара, которое на
          телефоне ещё и уезжает вниз. В профилях коллабов такая ссылка есть,
          здесь её просто забыли. */}
      <a href="/dashboard/collab-hub"
         className="text-sm text-gray-500 inline-flex items-center gap-1 mb-4 hover:text-gray-700">
        <ArrowLeft className="w-4 h-4" />К каталогу
      </a>
      <HubHeader subtitle="Так вас видят другие организаторы в каталоге." />
      <MyCardView />
    </div>
  )
}
