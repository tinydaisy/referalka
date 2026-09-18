'use client'

/**
 * Секция «Услуги» на лендинге: прайс-ориентир + кнопка «Оставить заявку».
 *
 * ⚠️ ЦЕНЫ ЗДЕСЬ — ОРИЕНТИР, а не витрина с оплатой. Объём работы заранее
 * неизвестен: «подключить домен» и «вести вебинары месяц» — разные истории.
 * Поэтому цифры идут с «от», а точную сумму мы называем после разговора и
 * выставляем персональным заказом. Писать здесь твёрдые цены нельзя — человек
 * сочтёт их обещанием.
 *
 * Прайс приходит из базы (service_price_items), а не из этого файла: менять
 * цены владелец должен в админке, а не просьбой поправить код.
 */
import { useEffect, useState } from 'react'
import BotRequestForm from './BotRequestForm'

type Item = { title: string; description: string | null; price: number }

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''

export default function ServicesSection() {
  const [items, setItems] = useState<Item[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    fetch(`${apiBase}/api/v1/public/custom-orders/prices/list`)
      .then(r => (r.ok ? r.json() : { items: [] }))
      .then(d => setItems(d.items || []))
      .catch(() => setItems([]))
  }, [])

  const from = items.length
    ? Math.min(...items.map(i => i.price).filter(p => p > 0))
    : 5000

  return (
    <section id="services" className="bg-gray-50 py-14 sm:py-20 scroll-mt-20">
      <div className="max-w-6xl mx-auto px-5 sm:px-8">
        <h2 className="text-2xl sm:text-3xl font-bold text-center mb-3"
            style={{ color: '#25455D' }}>
          Услуги
        </h2>
        <p className="text-sm sm:text-base text-gray-500 text-center max-w-2xl mx-auto mb-10 sm:mb-14">
          Настроим за вас — от&nbsp;{from.toLocaleString('ru-RU')}&nbsp;₽.
          Не знаете, что именно нужно? Опишите задачу своими словами, а мы
          посмотрим и назовём цену.
        </p>

        {items.length > 0 && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5 mb-10">
            {items.map((it, i) => (
              <div key={i} className="bg-white rounded-xl p-5 border border-gray-100">
                <div className="font-semibold mb-1" style={{ color: '#25455D' }}>
                  {it.title}
                </div>
                {it.description && (
                  <p className="text-sm text-gray-500 mb-3">{it.description}</p>
                )}
                <div className="text-lg font-bold" style={{ color: '#25455D' }}>
                  от {it.price.toLocaleString('ru-RU')} ₽
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="max-w-xl mx-auto">
          {open ? (
            <div className="bg-white rounded-2xl p-6 sm:p-8 border border-gray-100">
              <h3 className="text-lg font-bold mb-1" style={{ color: '#25455D' }}>
                Нужна личная настройка
              </h3>
              <p className="text-sm text-gray-500 mb-5">
                Расскажите, что хотите сделать. Мы посмотрим и напишем вам —
                уточним детали и назовём стоимость.
              </p>
              <BotRequestForm kind="service" />
            </div>
          ) : (
            <div className="text-center">
              <button onClick={() => setOpen(true)}
                      className="btn-gold px-8 py-3 rounded-xl font-semibold">
                Оставить заявку
              </button>
              <p className="text-xs text-gray-400 mt-3">
                Итоговая цена — как договоримся: может выйти и меньше, и больше
                прайса. Зависит от объёма работы.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
