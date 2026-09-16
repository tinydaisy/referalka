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
  // ⚠️ Фон и цвета задаёт САМ ThanksContent: они приходят из темы клиента
  // вместе с заказом. Здесь их зашивать нельзя — страница «спасибо» это лицо
  // клиента, а фиксированный градиент ПЛЮСОНа перебивал бы его бренд.
  // Шрифты лендинга подключаем тем же файлом, что и страница события.
  return (
    <>
      <link rel="stylesheet" href="/fonts/landing-fonts.css" />
      <ThanksContent
        orderId={params.orderId}
        failed={searchParams.fail === '1'}
      />
    </>
  )
}
