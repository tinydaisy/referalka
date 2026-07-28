/**
 * Страница после оплаты — pluson.ru/thanks/order/{orderId}.
 *
 * ⚠️ Номер заказа стоит В САМОМ ПУТИ, а не параметром: параметр терялся по
 * дороге, и страница не знала, чьи чаты показывать. По номеру заказа видно
 * не только событие, но и конкретного человека — имя, сумму, статус оплаты.
 *
 * Этот адрес мы передаём платёжной системе при каждой покупке; в её
 * настройках ничего указывать не нужно.
 */
import type { Metadata } from 'next'
import ThanksContent from '../../ThanksContent'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Спасибо за оплату',
  robots: { index: false },
}

export default function ThanksOrderPage({
  params, searchParams,
}: {
  params: { orderId: string }
  searchParams: { fail?: string }
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#25455D] to-[#0a1520] px-4 py-10 text-white">
      <div className="w-full max-w-lg text-center">
        <ThanksContent
          orderId={params.orderId}
          failed={searchParams.fail === '1'}
        />
      </div>
    </div>
  )
}
