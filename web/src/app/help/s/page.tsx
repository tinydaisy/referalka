import { redirect } from 'next/navigation'

/**
 * `/help/s` без раздела — это обрезанная ссылка. Ведём на список разделов,
 * а не на «страница не найдена»: человек явно шёл в базу знаний.
 */
export default function PublicHelpSectionsRedirect() {
  redirect('/help')
}
