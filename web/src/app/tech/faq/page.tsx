'use client'

/**
 * Частые вопросы в кабинете внедренца.
 *
 * ⚠️ Экран ОБЩИЙ с админкой (`TechFaqScreen`). База одна на всех: что завёл
 * один техспец — видят и правят остальные, включая админа.
 */
import { api } from '@/lib/api'
import TechFaqScreen from '@/components/TechFaqScreen'

export default function TechFaqPage() {
  // ⚠️⚠️ ОТСТУПЫ ДАЁТ СТРАНИЦА, А НЕ ОБЩИЙ КОМПОНЕНТ. В кабинете внедренца
  // `layout` отдаёт `<main>` БЕЗ полей — каждая страница оборачивается сама
  // (`p-4 md:p-8`). В админке наоборот: поля задаёт layout. Положи обёртку
  // внутрь общего компонента — и в админке отступ удвоится.
  return (
    <div className="p-4 md:p-8">
      <h1 className="mb-5 text-xl font-semibold text-gray-900">Частые вопросы</h1>
      <TechFaqScreen api={api.techFaq} />
    </div>
  )
}
