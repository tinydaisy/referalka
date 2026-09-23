'use client'

/**
 * CRM клиентов — админский вход.
 *
 * ⚠️ Сам экран общий с кабинетом внедренца (`components/tech/CrmScreen`):
 * функционал один, отличается только срез — у владельца сводка по всем, у
 * внедренца выборка по нему. Две копии разошлись бы в правилах, и воронка
 * показывала бы разное по одним и тем же людям.
 *
 * ⚠️ `useSearchParams` внутри требует <Suspense> на пререндеренной странице,
 * иначе падает сборка ВСЕЙ ветки.
 */
import { Suspense } from 'react'
import CrmScreen from '@/components/tech/CrmScreen'

export default function AdminCrmPage() {
  return (
    <Suspense fallback={null}>
      <CrmScreen mode="admin" />
    </Suspense>
  )
}
