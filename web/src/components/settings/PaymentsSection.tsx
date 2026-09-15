'use client'
/**
 * Раздел «Платёжные системы» — два подраздела (решение владельца 09.09.2026):
 *   • Основные настройки — ключи платёжной системы (как было);
 *   • Промокоды — скидки по слову (миграция 397).
 *
 * ⚠️ Промокоды именно ЗДЕСЬ, а не своим пунктом меню: они бессмысленны без
 * подключённой платёжной системы, и от неё же зависит, работают ли они вообще
 * (у LeadPay — нет). Рядом клиент видит и то, и другое.
 */
import { useEffect, useState } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import { api } from '@/lib/api'
import PaymentSettingsTab from './PaymentSettingsTab'
import PromoCodesTab from './PromoCodesTab'

type Sub = 'main' | 'promo'

export default function PaymentsSection() {
  // ⚠️ Подраздел в АДРЕСЕ: при обновлении страницы человек остаётся там же,
  // а не улетает на «Основные настройки» (правило владельца 15.09.2026).
  const [sub, setSub] = useUrlTab<Sub>('sub', 'main', ['main', 'promo'])
  const [payProvider, setPayProvider] = useState<string | null>(null)

  // Платёжная система нужна вкладке промокодов: от неё зависит, работают ли
  // они вообще. Читаем один раз здесь, чтобы не дублировать запрос внутри.
  useEffect(() => {
    api.paymentSettings.get()
      .then((r: any) => setPayProvider(r?.pay_provider || null))
      .catch(() => {})
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex gap-2 border-b border-gray-200 pb-3">
        <SubTab active={sub === 'main'} onClick={() => setSub('main')}>
          Основные настройки
        </SubTab>
        <SubTab active={sub === 'promo'} onClick={() => setSub('promo')}>
          Промокоды
        </SubTab>
      </div>

      {sub === 'main' && <PaymentSettingsTab />}
      {sub === 'promo' && <PromoCodesTab payProvider={payProvider} />}
    </div>
  )
}

function SubTab({ active, onClick, children }: any) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-4 py-2 text-sm font-bold transition-colors ${
        active ? 'bg-[#25455D] text-white' : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {children}
    </button>
  )
}
