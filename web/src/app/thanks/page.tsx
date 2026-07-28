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
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#25455D] to-[#0a1520] px-4 py-10 text-white">
      <div className="w-full max-w-lg text-center">
        <ThanksContent
          orderId={searchParams.order || null}
          failed={searchParams.fail === '1'}
        />
      </div>
    </div>
  )
}
