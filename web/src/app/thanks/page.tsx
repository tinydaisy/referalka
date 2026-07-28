/**
 * Страница после оплаты — pluson.ru/thanks?order={id} (миграция 257).
 *
 * ⚠️ ОДНА на все события и всех клиентов. Событие определяется по номеру
 * заказа, поэтому в карточке платёжной системы адрес возврата прописывается
 * один раз и больше не меняется — под каждую конференцию своя страница не
 * нужна.
 *
 * Показывает, что оплачено, и чаты ИМЕННО того события, за которое заплатили.
 */
import type { Metadata } from 'next'

export const dynamic = 'force-dynamic'

const apiBase =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000'

export const metadata: Metadata = {
  title: 'Спасибо за оплату',
  robots: { index: false },
}

async function getOrder(orderId: string) {
  try {
    const res = await fetch(
      `${apiBase}/api/v1/public/event-orders/${encodeURIComponent(orderId)}`,
      { cache: 'no-store' },
    )
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

const CHAT_LABEL: Record<string, string> = {
  telegram: 'Чат в Telegram',
  vk: 'Чат во ВКонтакте',
  max: 'Чат в MAX',
}

export default async function ThanksPage({
  searchParams,
}: {
  searchParams: { order?: string; fail?: string }
}) {
  const order = searchParams.order ? await getOrder(searchParams.order) : null
  const failed = searchParams.fail === '1'

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#25455D] to-[#0a1520] px-4 py-10 text-white">
      <div className="w-full max-w-lg text-center">
        {order?.poster_url && (
          <img src={order.poster_url} alt=""
               className="mb-6 w-full rounded-xl object-cover" />
        )}

        {failed ? (
          <>
            <h1 className="text-2xl font-bold text-[#FFCFA4] sm:text-3xl">
              Оплата не прошла
            </h1>
            <p className="mt-3 text-white/80">
              Деньги не списаны. Попробуйте ещё раз — или напишите организатору,
              если ошибка повторяется.
            </p>
            {order?.event_slug && (
              <a href={`/e/${order.event_slug}`}
                 className="mt-6 inline-block rounded-lg bg-[#FFCFA4] px-7 py-3.5 font-bold uppercase text-[#0a1520]">
                Вернуться к тарифам
              </a>
            )}
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-[#FFCFA4] sm:text-3xl">
              Спасибо! Вы с нами
            </h1>

            {order ? (
              <p className="mt-3 text-white/85">
                {order.event_title}
                {order.tariff_title && <> — тариф «{order.tariff_title}»</>}
                {order.status === 'paid'
                  ? '. Оплата получена.'
                  : '. Как только оплата дойдёт, мы откроем доступ.'}
              </p>
            ) : (
              <p className="mt-3 text-white/85">
                Оплата принята. Организатор свяжется с вами.
              </p>
            )}

            {/* Чаты события — чтобы человек не потерялся после оплаты. */}
            {!!order?.chats?.length && (
              <>
                <p className="mt-8 text-sm uppercase tracking-wide text-white/60">
                  Заходите в чат, там всё самое важное
                </p>
                <div className="mt-3 flex flex-col gap-2.5">
                  {order.chats.map((c: any) => (
                    <a key={c.platform} href={c.url} target="_blank" rel="noreferrer"
                       className="rounded-lg bg-[#FFCFA4] px-6 py-3.5 font-bold uppercase text-[#0a1520] transition-transform hover:scale-[1.02]">
                      {CHAT_LABEL[c.platform] || 'Чат события'}
                    </a>
                  ))}
                </div>
              </>
            )}

            {order?.event_slug && (
              <a href={`/event/${order.event_slug}${order.contact_id ? `?c=${order.contact_id}` : ''}`}
                 className="mt-6 inline-block text-sm text-white/70 underline hover:text-white">
                Открыть страницу события
              </a>
            )}
          </>
        )}
      </div>
    </div>
  )
}
