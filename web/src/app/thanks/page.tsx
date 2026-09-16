/**
 * Страница после оплаты — pluson.ru/thanks?order={id} (миграция 257).
 *
 * ⚠️ ОДНА на все события и всех клиентов. Событие определяется по номеру
 * заказа, поэтому в карточке платёжной системы адрес возврата прописывается
 * один раз и больше не меняется — под каждую конференцию своя страница не
 * нужна.
 *
 * ⚠️ Сама страница НИЧЕГО не грузит на сервере: пока шёл запрос к API, она
 * висела пустой, и на мобильной связи браузер успевал оборвать загрузку
 * (499 в логах) — человек оказывался на адресе без номера заказа и видел
 * общий текст вместо чатов. Теперь разметка отдаётся сразу, а данные
 * заказа подтягивает ThanksContent уже в браузере.
 */
import type { Metadata } from 'next'
import ThanksContent from './ThanksContent'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Спасибо за оплату',
  robots: { index: false },
}

export default function ThanksPage({
  searchParams,
}: {
  searchParams: { order?: string; fail?: string }
}) {
  // ⚠️ Фон и цвета задаёт САМ ThanksContent из темы клиента. Своей обёртки с
  // градиентом ПЛЮСОНа тут быть не должно: она перебила бы бренд клиента и
  // фон оказался бы двойным — наш снаружи, его внутри.
  return (
    <>
      <link rel="stylesheet" href="/fonts/landing-fonts.css" />
      <ThanksContent
        orderId={searchParams.order || null}
        failed={searchParams.fail === '1'}
      />
    </>
  )
}
