'use client'

/**
 * Воронка email-рассылки — одна строка под строкой email-канала:
 *   768 / 730 (95.1%) / 3 (0.4%) / 1 (0.1%)
 *   отправлено / доставлено / открыли / кликнули
 *
 * Проценты: доставлено — от отправленных; открыли и кликнули — от доставленных.
 * Данные считает бэк: app/services/email_funnel_stats.py
 */

export type EmailStats = {
  sent: number
  delivered: number
  opened: number
  opened_human: number
  clicked: number
}

const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : '0%'

export default function EmailFunnelStats({ stats }: { stats?: EmailStats | null }) {
  if (!stats || !stats.sent) return null
  const { sent, delivered, opened, opened_human, clicked } = stats
  return (
    <div
      className="mt-1 mb-1 text-[11px] text-gray-500 leading-relaxed"
      title={
        `Отправлено ${sent} · доставлено ${delivered} · открыли ${opened} · кликнули ${clicked}\n\n` +
        `Открытий без почтового прокси: ${opened_human}. Gmail и Apple Mail ` +
        'подгружают картинки сами, поэтому «открыли» завышено. «Кликнули» — ' +
        'самая честная цифра. Проценты открытий и кликов — от доставленных.'
      }
    >
      <span className="font-bold text-gray-700">{sent}</span>
      <span className="text-gray-300"> / </span>
      <span className="font-bold text-green-600">{delivered}</span>
      <span className="text-gray-400"> ({pct(delivered, sent)})</span>
      <span className="text-gray-300"> / </span>
      <span className="font-bold text-blue-600">{opened}</span>
      <span className="text-gray-400"> ({pct(opened, delivered)})</span>
      <span className="text-gray-300"> / </span>
      <span className="font-bold text-purple-600">{clicked}</span>
      <span className="text-gray-400"> ({pct(clicked, delivered)})</span>
    </div>
  )
}
