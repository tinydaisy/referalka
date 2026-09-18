/**
 * Страница персонального заказа — pluson.ru/order/PZ-000123.
 *
 * ⚠️ ПОЧЕМУ НЕ `OrderForm` от событий и продуктов. Та форма собирает заказ
 * ТАРИФА: спрашивает Telegram-ник, берёт оформление лендинга владельца,
 * показывает промокод и цену из карточки. Здесь ничего этого нет — заказ уже
 * собран нами, человеку остаётся его подтвердить и оплатить. Общего кода вышло
 * бы меньше, чем условий «а если персональный заказ».
 *
 * ⚠️ Оформление — НАШЕ, ПЛЮСОНА, а не клиента: услугу оказывает компания.
 * Отсюда фирменный градиент и белый логотип, как на служебных входах.
 */
import type { Metadata } from 'next'
import OrderView from './OrderView'

export const dynamic = 'force-dynamic'

const apiBase =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000'

async function getOrder(number: string) {
  try {
    const res = await fetch(
      `${apiBase}/api/v1/public/custom-orders/${encodeURIComponent(number)}`,
      { cache: 'no-store' },
    )
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function generateMetadata(
  { params }: { params: { number: string } },
): Promise<Metadata> {
  const order = await getOrder(params.number)
  const title = order
    ? `${order.title} ${order.number} — iViSiON: ПЛЮСОН`
    : 'Заказ — iViSiON: ПЛЮСОН'
  return {
    title,
    // ⚠️ Страница заказа не должна попадать в поиск: в ней сумма и перечень
    // работ конкретного человека.
    robots: { index: false, follow: false },
  }
}

export default async function OrderPage({ params }: { params: { number: string } }) {
  const order = await getOrder(params.number)

  if (!order) {
    return (
      <div className="min-h-screen flex items-center justify-center px-5"
           style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-2">Заказ не найден</h1>
          <p className="text-gray-500">
            Проверьте ссылку — возможно, она скопирована не полностью.
            Или напишите нам, мы пришлём новую.
          </p>
        </div>
      </div>
    )
  }

  return <OrderView order={order} />
}
