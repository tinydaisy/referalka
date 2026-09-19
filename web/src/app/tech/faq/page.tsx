'use client'

/**
 * Частые вопросы в кабинете внедренца.
 *
 * ⚠️ Экран ОБЩИЙ с админкой (`TechFaqScreen`). База одна на всех: что завёл
 * один техспец — видят и правят остальные, включая админа.
 *
 * ⚠️⚠️ УДАЛЕНИЕ — ПО ПРАВУ (`can_delete_faq`, миграция 461). Добавлять и
 * править может каждый, а удаление убирает ответ у ВСЕХ сразу — право выдаёт
 * админ галочкой в карточке специалиста. Нет права — в набор не кладём метод
 * `remove`, и кнопка не рисуется. Сам запрет стоит на бэкенде: прятать кнопку,
 * оставив путь рабочим, значило бы запретить лишь на вид.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import TechFaqScreen from '@/components/TechFaqScreen'

export default function TechFaqPage() {
  const [canDelete, setCanDelete] = useState(false)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    api.tech.me()
      .then((me: any) => setCanDelete(!!me?.can_delete_faq))
      .catch(() => setCanDelete(false))
      .finally(() => setChecked(true))
  }, [])

  // ⚠️ Ждём ответа о правах, прежде чем рисовать: иначе кнопка удаления
  // мигала бы на секунду у тех, кому она не положена.
  if (!checked) return null

  // ⚠️⚠️ ОТСТУПЫ ДАЁТ СТРАНИЦА, А НЕ ОБЩИЙ КОМПОНЕНТ. В кабинете внедренца
  // `layout` отдаёт `<main>` БЕЗ полей — каждая страница оборачивается сама
  // (`p-4 md:p-8`). В админке наоборот: поля задаёт layout. Положи обёртку
  // внутрь общего компонента — и в админке отступ удвоится.
  return (
    <div className="p-4 md:p-8">
      <h1 className="mb-5 text-xl font-semibold text-gray-900">Частые вопросы</h1>
      <TechFaqScreen api={canDelete
        ? api.techFaq
        : { ...api.techFaq, remove: undefined }} />
    </div>
  )
}
