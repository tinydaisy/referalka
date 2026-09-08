/**
 * Обёртка восстановления пароля (`/password-reset` и `/password-reset/confirm`).
 *
 * ⚠️ Существует ради `force-dynamic` — по той же причине, что у `(auth)` и
 * `/my`: без него Next кеширует HTML на год, и после выкатки страница просит
 * JS-файлы, которых уже нет. Форма при этом выглядит рабочей, но кнопка не
 * делает ничего. На странице восстановления это особенно скверно: человек уже
 * не может войти, и второй сломанный путь не оставляет ему ни одного.
 */
export const dynamic = 'force-dynamic'

export default function PasswordResetLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
