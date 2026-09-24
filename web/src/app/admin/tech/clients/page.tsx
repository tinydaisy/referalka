'use client'

/**
 * Клиенты внедренцев — админский вход.
 *
 * ⚠️ Экран ОБЩИЙ с кабинетом внедренца (`components/tech/ClientsScreen`):
 * фильтры, колонки и страницы одинаковые. Единственное отличие — здесь есть
 * выбор внедренца, у внедренца его номер подставляет сервер.
 *
 * ⚠️ `useSearchParams` внутри требует <Suspense> на пререндеренной странице,
 * иначе падает сборка ВСЕЙ ветки.
 */
import { Suspense } from 'react'
import ClientsScreen from '@/components/tech/ClientsScreen'

export default function AdminTechClientsPage() {
  return (
    <Suspense fallback={null}>
      <ClientsScreen mode="admin" />
    </Suspense>
  )
}
