import { Suspense } from 'react'
import CoverRenderClient from './CoverRenderClient'

/**
 * Страница отрисовки обложки — её открывает Chromium на сервере и снимает
 * картинку. Человеку она не показывается.
 *
 * ⚠️ Страница БЕЗ динамического сегмента и с `useSearchParams` внутри — значит
 * обязательна обёртка `<Suspense>`, иначе СБОРКА ПАДАЕТ ЦЕЛИКОМ («useSearchParams()
 * should be wrapped in a suspense boundary»). Такие роуты Next пререндерит на
 * сборке; `tsc --noEmit` эту ошибку не видит, ловится только сборкой.
 *
 * ⚠️ Шрифты подключены прямо здесь `<link>`: браузер ждёт `document.fonts` и
 * грузит только то, что объявлено на странице. Без этого в PNG попал бы
 * запасной шрифт.
 */
export default function CoverRenderPage() {
  return (
    <>
      <link rel="stylesheet" href="/fonts/landing-fonts.css" />
      <Suspense fallback={null}>
        <CoverRenderClient />
      </Suspense>
    </>
  )
}
