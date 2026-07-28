/**
 * Страница после оплаты с номером тарифа — pluson.ru/thanks/{tariffId}.
 *
 * ⚠️ Событие и клиент определяются САМИМ АДРЕСОМ, а не параметром, который
 * может потеряться по дороге. Чаты и боты у всех покупателей одного тарифа
 * одинаковые, поэтому различать людей между собой не нужно — и одновременные
 * покупки друг другу не мешают.
 *
 * Этот адрес прописывается в карточке товара платёжной системы один раз.
 */
import type { Metadata } from 'next'
import ThanksByTariff from './ThanksByTariff'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Спасибо за оплату',
  robots: { index: false },
}

export default function ThanksTariffPage({
  params, searchParams,
}: {
  params: { tariffId: string }
  searchParams: { fail?: string }
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#25455D] to-[#0a1520] px-4 py-10 text-white">
      <div className="w-full max-w-lg text-center">
        <ThanksByTariff
          tariffId={params.tariffId}
          failed={searchParams.fail === '1'}
        />
      </div>
    </div>
  )
}
