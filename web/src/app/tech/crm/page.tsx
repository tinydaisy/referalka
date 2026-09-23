'use client'

/**
 * Моя CRM — кабинет внедренца.
 *
 * ⚠️ Экран ОБЩИЙ с админкой (`components/tech/CrmScreen`): функционал один,
 * отличается только срез. Здесь сервер подставляет номер внедренца из токена —
 * параметром он не передаётся, иначе можно было бы указать чужой.
 *
 * ⚠️ «Мои клиенты» и «CRM» — РАЗНЫЕ разделы: первый отвечает «что у клиента
 * есть» (события, боты, подписчики, вебинары), второй — «где он в воронке».
 */
import { Suspense } from 'react'
import CrmScreen from '@/components/tech/CrmScreen'

export default function TechCrmPage() {
  return (
    <Suspense fallback={null}>
      <CrmScreen mode="tech" />
    </Suspense>
  )
}
