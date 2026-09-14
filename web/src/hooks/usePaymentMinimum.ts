'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

/**
 * Минимальная сумма платежа у подключённой платёжной системы.
 *
 * ⚠️ Порог — свойство самой системы, а не наше правило: LeadPay и Продамус
 * не принимают платежи меньше 100 ₽, Т-Банк — меньше 1 ₽. Тариф дешевле
 * завести МОЖНО (мы не запрещаем), но оплата по нему не пройдёт — поэтому
 * формы тарифа предупреждают об этом заранее, а не после первой жалобы
 * покупателя.
 *
 * Цифра приходит с бэкенда (`min_payment_rub`), в браузере её не хардкодим:
 * иначе при смене порога пришлось бы править в двух местах и они разъедутся.
 */
export function usePaymentMinimum() {
  const [minPayment, setMinPayment] = useState(0)
  const [providerName, setProviderName] = useState('Платёжная система')

  // Молча: раздел платежей может быть закрыт на тарифе — тогда порога просто
  // нет и предупреждать не о чем.
  useEffect(() => {
    api.paymentSettings.get()
      .then((r: any) => {
        setMinPayment(r?.min_payment_rub || 0)
        const p = r?.pay_provider
        if (p && r?.providers?.[p]) setProviderName(r.providers[p])
      })
      .catch(() => {})
  }, [])

  /** Текст предупреждения либо null, если цена в порядке. */
  const warnFor = (price: string | number | null | undefined): string | null => {
    const p = typeof price === 'number' ? price : parseInt(String(price ?? ''), 10)
    // ⚠️ Ноль и пусто не трогаем: это «бесплатно» и «по запросу» —
    // платёжная система там не участвует вовсе.
    if (!minPayment || !Number.isFinite(p) || p <= 0 || p >= minPayment) return null
    return `${providerName} не принимает платежи меньше ${minPayment.toLocaleString('ru-RU')} ₽`
      + ' — оплата такого тарифа не пройдёт.'
  }

  return { minPayment, providerName, warnFor }
}
