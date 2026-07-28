'use client'

/**
 * Содержимое страницы «после оплаты», найденное ПО НОМЕРУ ТАРИФА.
 *
 * Номер тарифа стоит прямо в адресе, поэтому потеряться не может — в отличие
 * от номера заказа в параметре. Чаты события и боты клиента одинаковы для
 * всех покупателей тарифа, так что одновременные покупки друг другу не мешают.
 */
import { useEffect, useState } from 'react'

const CHAT_LABEL: Record<string, string> = {
  telegram: 'Чат в Telegram',
  vk: 'Чат во ВКонтакте',
  max: 'Чат в MAX',
}

const BOT_LABEL: Record<string, string> = {
  telegram: 'Бот в Telegram',
  vk: 'Сообщество ВКонтакте',
  max: 'Бот в MAX',
}

export default function ThanksByTariff({
  tariffId, failed,
}: {
  tariffId: string
  failed: boolean
}) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/v1/public/event-orders/tariff/${encodeURIComponent(tariffId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [tariffId])

  if (failed) {
    return (
      <>
        <h1 className="text-2xl font-bold text-[#FFCFA4] sm:text-3xl">
          Оплата не прошла
        </h1>
        <p className="mt-3 text-white/80">
          Деньги не списаны. Попробуйте ещё раз — или напишите нам, если
          ошибка повторяется.
        </p>
        {data?.event_slug && (
          <a href={`/e/${data.event_slug}`}
             className="mt-6 inline-block rounded-lg bg-[#FFCFA4] px-7 py-3.5 font-bold uppercase text-[#0a1520]">
            Вернуться к тарифам
          </a>
        )}
      </>
    )
  }

  return (
    <>
      {data?.poster_url && (
        <img src={data.poster_url} alt=""
             className="mb-6 w-full rounded-xl object-cover" />
      )}

      <h1 className="text-2xl font-bold text-[#FFCFA4] sm:text-3xl">
        Спасибо! Вы с нами
      </h1>

      {data ? (
        <p className="mt-3 text-white/85">
          {data.event_title}
          {data.tariff_title && <> — тариф «{data.tariff_title}»</>}. Оплата получена.
        </p>
      ) : loading ? (
        <p className="mt-3 text-white/60">Загружаем…</p>
      ) : (
        <p className="mt-3 text-white/85">Оплата принята.</p>
      )}

      {/* Чаты события */}
      {!!data?.chats?.length && (
        <>
          <p className="mt-8 text-sm uppercase tracking-wide text-white/60">
            Заходите в чат, там всё самое важное
          </p>
          <div className="mt-3 flex flex-col gap-2.5">
            {data.chats.map((c: any) => (
              <a key={c.platform} href={c.url} target="_blank" rel="noreferrer"
                 className="rounded-lg bg-[#FFCFA4] px-6 py-3.5 font-bold uppercase text-[#0a1520] transition-transform hover:scale-[1.02]">
                {CHAT_LABEL[c.platform] || 'Чат события'}
              </a>
            ))}
          </div>
        </>
      )}

      {/* Боты: через них придут напоминания, подарки и ссылка на эфир. */}
      {!!data?.bots?.length && (
        <>
          <p className="mt-8 text-sm uppercase tracking-wide text-white/60">
            Откройте бота — там напоминания, подарки и ссылка на эфир
          </p>
          <div className="mt-3 flex flex-col gap-2.5">
            {data.bots.map((b: any) => (
              <a key={b.platform} href={b.url} target="_blank" rel="noreferrer"
                 className="rounded-lg border border-[#FFCFA4] px-6 py-3 font-bold uppercase text-[#FFCFA4] transition-colors hover:bg-[#FFCFA4]/10">
                {BOT_LABEL[b.platform] || 'Бот'}
              </a>
            ))}
          </div>
        </>
      )}

      {/* Поддержка */}
      {!!data?.support?.length && (
        <p className="mt-8 text-sm text-white/60">
          Что-то не открылось?{' '}
          {data.support.map((s: any, i: number) => (
            <span key={s.platform}>
              {i > 0 && ' · '}
              <a href={s.url} target="_blank" rel="noreferrer"
                 className="underline hover:text-white">
                {BOT_LABEL[s.platform]?.replace('Бот в ', '') || 'Написать нам'}
              </a>
            </span>
          ))}
        </p>
      )}

      {data?.event_slug && (
        <a href={`/event/${data.event_slug}`}
           className="mt-6 inline-block text-sm text-white/70 underline hover:text-white">
          Открыть страницу события
        </a>
      )}
    </>
  )
}
