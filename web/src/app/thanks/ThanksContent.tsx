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

  // ⚠️⚠️ Страница «спасибо» — ЛИЦО КЛИЕНТА, а не ПЛЮСОНа. Раньше она была
  // нарисована нашими цветами (#25455D + персиковые кнопки), и человек после
  // оплаты попадал будто на чужой сайт. Тема приходит вместе с заказом.
  // ⚠️ Запасные значения — прежние цвета ПЛЮСОНа: у клиента без настроенной
  // темы страница должна выглядеть как раньше, а не побелеть.
  const brand = order?.brand || {}
  const bgCss: string = brand.bg_css || 'linear-gradient(135deg, #25455D, #0a1520)'
  const cHead: string = brand.color_heading || '#FFCFA4'
  const cBody: string = brand.color_body || '#FFFFFF'
  const btnBg: string = brand.btn_color || '#FFCFA4'
  const btnFg: string = brand.btn_text_color || '#0a1520'
  const btnRadius: number = brand.btn_radius ?? 10
  const fHead: string | undefined = brand.font_heading_css || undefined
  const fBody: string | undefined = brand.font_body_css || undefined

  // Обёртка страницы: фон, шрифт и центрирование — здесь, потому что цвета
  // известны только после загрузки заказа.
  const Frame = ({ children }: { children: React.ReactNode }) => (
    <div className="flex min-h-screen items-center justify-center px-4 py-10"
         style={{ background: bgCss, color: cBody, fontFamily: fBody }}>
      <div className="w-full max-w-lg text-center">
        {/* Шапка бренда: логотип и название клиента. Показывается, как только
            заказ загружен, — до этого мы не знаем, чьё это событие. */}
        {(brand.logo_url || brand.name) && (
          <div className="mb-7 flex flex-col items-center gap-3">
            {brand.logo_url && (
              <img src={brand.logo_url} alt={brand.name || ''}
                   className="h-16 w-auto max-w-[220px] object-contain" />
            )}
            {brand.name && (
              <div className="text-sm uppercase tracking-[0.18em]"
                   style={{ color: cHead, fontFamily: fHead }}>
                {brand.name}
              </div>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  )

  if (failed) {
    return (
      <Frame>
        <h1 className="text-2xl font-bold sm:text-3xl"
            style={{ color: cHead, fontFamily: fHead }}>
          Оплата не прошла
        </h1>
        <p className="mt-3 opacity-80">
          Деньги не списаны. Попробуйте ещё раз — или напишите организатору,
          если ошибка повторяется.
        </p>
        {order?.event_slug && (
          <a href={`/e/${order.event_slug}`}
             className="mt-6 inline-block px-7 py-3.5 font-bold uppercase"
             style={{ background: btnBg, color: btnFg, borderRadius: btnRadius }}>
            Вернуться к тарифам
          </a>
        )}
      </Frame>
    )
  }

  return (
    <Frame>
      {order?.poster_url && (
        <img src={order.poster_url} alt=""
             className="mb-6 w-full rounded-xl object-cover" />
      )}

      <h1 className="text-2xl font-bold sm:text-3xl"
          style={{ color: cHead, fontFamily: fHead }}>
        Спасибо! Вы с нами
      </h1>

      {order ? (
        <p className="mt-3 opacity-85">
          {order.event_title}
          {order.tariff_title && <> — тариф «{order.tariff_title}»</>}
          {order.status === 'paid'
            ? '. Оплата получена.'
            : '. Как только оплата дойдёт, мы откроем доступ.'}
        </p>
      ) : loading ? (
        <p className="mt-3 opacity-60">Загружаем данные заказа…</p>
      ) : (
        <p className="mt-3 opacity-85">
          Оплата принята. Организатор свяжется с вами.
        </p>
      )}

      {/* Куда вести — настройка события (миграция 261).
          «В бота» (по умолчанию) — там меню события: чат, программа, подарки,
          эфир. «В чаты» — сразу в чат, когда бот клиенту не нужен. */}
      {order?.thanks_destination === 'chats' ? (
        !!order?.chats?.length && (
          <>
            <p className="mt-8 text-sm uppercase tracking-wide opacity-60">
              Заходите в чат события — там всё самое важное
            </p>
            <div className="mt-3 flex flex-col gap-2.5">
              {order.chats.map((c: any) => (
                <a key={c.platform} href={c.url} target="_blank" rel="noreferrer"
                   className="px-6 py-3.5 font-bold uppercase transition-transform hover:scale-[1.02]"
                   style={{ background: btnBg, color: btnFg, borderRadius: btnRadius }}>
                  {CHAT_LABEL[c.platform] || 'Чат события'}
                </a>
              ))}
            </div>
          </>
        )
      ) : (
        !!order?.bots?.length && (
          <>
            <p className="mt-8 text-sm uppercase tracking-wide opacity-60">
              Откройте бота — там меню события: чат, программа, подарки и эфир
            </p>
            {/* ⚠️ Важное предупреждение: если человек зайдёт в бота на другой
                площадке, его аккаунт не свяжется с регистрацией и рассылки
                до него не дойдут. */}
            <p className="mt-2 text-sm opacity-70">
              Вернитесь на ту площадку, с которой начинали регистрацию, —
              иначе мы не сможем связать вас с заказом.
            </p>
            {/* ⚠️ Кнопки ботов — в цвете бренда: заливка фирменная, как у
                главной кнопки лендинга. Раньше они были персиковой рамкой
                ПЛЮСОНа и выпадали из оформления клиента. */}
            <div className="mt-3 flex flex-col gap-2.5">
              {order.bots.map((b: any) => (
                <a key={b.platform} href={b.url} target="_blank" rel="noreferrer"
                   className="px-6 py-3.5 font-bold uppercase transition-transform hover:scale-[1.02]"
                   style={{ background: btnBg, color: btnFg, borderRadius: btnRadius }}>
                  {BOT_LABEL[b.platform] || 'Бот'}
                </a>
              ))}
            </div>
          </>
        )
      )}
    </Frame>
  )
}
