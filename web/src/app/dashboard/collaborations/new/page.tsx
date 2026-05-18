import { redirect } from 'next/navigation'

// Создание коллаба «с нуля» больше не доступно: коллаб = расширение контакта.
// Добавление идёт только через модалку «Добавить из контактов» на списке.
export default function NewCollaborationRedirect() {
  redirect('/dashboard/collaborations')
}
