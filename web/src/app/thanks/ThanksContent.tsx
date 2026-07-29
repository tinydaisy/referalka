'use client'

/**
 * Содержимое страницы «после оплаты».
 *
 * ⚠️ Заказ подтягиваем В БРАУЗЕРЕ, а не на сервере до отрисовки. При
 * серверной загрузке страница висела пустой, пока шёл запрос к API, — на
 * мобильной связи браузер успевал оборвать её (в логах 499) и уходил на
 * адрес уже без номера заказа. Человек видел общий текст вместо чатов.
 */
import { useEffect, useState } from 'react'

const SUPPORT_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  vk: 'ВКонтакте',
  max: 'MAX',
}

const BOT_LABEL: Record<string, string> = {
  telegram: 'Бот в Telegram',
  vk: 'Сообщество ВКонтакте',
  max: 'Бот в MAX',
}

const CHAT_LABEL: Record<string, string> = {
  telegram: 'Чат в Telegram',
  vk: 'Чат во ВКонтакте',
  max: 'Чат в MAX',
}

export default function ThanksContent({
  orderId, failed,
}: {
  orderId: string | null
  failed: boolean
}) {
  const [order, setOrder] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // ⚠️ Номер заказа берём из адреса, а если его там нет — из памяти
    // браузера: платёжная система возвращает на адрес из своих настроек и
    // наш ?order= теряется. Без этого страница показывала общий текст
    // вместо события и чатов.
    let id = orderId
    if (!id) {
      try { id = localStorage.getItem('lastOrderId') } catch {}
    }
    if (!id) { setLoading(false); return }
    fetch(`/api/v1/public/event-orders/${encodeURIComponent(id)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setOrder(d))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [orderId])

  if (failed) {
    return (
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
    )
  }

  return (
    <>
      {order?.poster_url && (
        <img src={order.poster_url} alt=""
             className="mb-6 w-full rounded-xl object-cover" />
      )}

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
      ) : loading ? (
        <p className="mt-3 text-white/60">Загружаем данные заказа…</p>
      ) : (
        <p className="mt-3 text-white/85">
          Оплата принята. Организатор свяжется с вами.
        </p>
      )}

      {/* Куда вести — настройка события (миграция 261).
          «В бота» (по умолчанию) — там меню события: чат, программа, подарки,
          эфир. «В чаты» — сразу в чат, когда бот клиенту не нужен. */}
      {order?.thanks_destination === 'chats' ? (
        !!order?.chats?.length && (
          <>
            <p className="mt-8 text-sm uppercase tracking-wide text-white/60">
              Заходите в чат события — там всё самое важное
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
        )
      ) : (
        !!order?.bots?.length && (
          <>
            <p className="mt-8 text-sm uppercase tracking-wide text-white/60">
              Откройте бота — там меню события: чат, программа, подарки и эфир
            </p>
            {/* ⚠️ Важное предупреждение: если человек зайдёт в бота на другой
                площадке, его аккаунт не свяжется с регистрацией и рассылки
                до него не дойдут. */}
            <p className="mt-2 text-sm text-white/70">
              Вернитесь на ту площадку, с которой начинали регистрацию, —
              иначе мы не сможем связать вас с заказом.
            </p>
            <div className="mt-3 flex flex-col gap-2.5">
              {order.bots.map((b: any) => (
                <a key={b.platform} href={b.url} target="_blank" rel="noreferrer"
                   className="rounded-lg border border-[#FFCFA4] px-6 py-3 font-bold uppercase text-[#FFCFA4] transition-colors hover:bg-[#FFCFA4]/10">
                  {BOT_LABEL[b.platform] || 'Бот'}
                </a>
              ))}
            </div>
          </>
        )
      )}


    </>
  )
}
