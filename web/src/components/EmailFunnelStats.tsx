'use client'

/**
 * Воронка email-рассылки — 4 цифры по УНИКАЛЬНЫМ адресам получателей.
 * Рисуется ПОД строкой email-канала в блоке «По каналам отправки»,
 * на обеих страницах рассылок: общих и событийных.
 *
 * Проценты считаются от ДОСТАВЛЕННЫХ (открыли/кликнули), доставленные —
 * от отправленных. Данные считает бэк: app/services/email_funnel_stats.py
 */

export type EmailStats = {
  sent: number          // скольким адресам попытались отправить
  delivered: number     // почта получателя приняла письмо
  opened: number        // загрузился пиксель (вкл. прокси-предзагрузку)
  opened_human: number  // из них без почтового прокси
  clicked: number       // перешли по ссылке из письма
}

const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : null

function Cell({ value, percent, label, color, hint }: {
  value: number; percent: string | null; label: string; color: string; hint: string
}) {
  return (
    <div className="flex-1 min-w-[64px] text-center" title={hint}>
      <div className={`text-base font-bold leading-none ${color}`}>
        {value}
        {percent && <span className="text-[10px] font-semibold opacity-70 ml-1">{percent}</span>}
      </div>
      <div className="text-[10px] text-gray-500 mt-1 leading-tight">{label}</div>
    </div>
  )
}

export default function EmailFunnelStats({ stats }: { stats?: EmailStats | null }) {
  if (!stats || !stats.sent) return null
  const { sent, delivered, opened, opened_human, clicked } = stats
  return (
    <div className="mt-1.5 mb-1 rounded-lg border border-gray-200 bg-white px-2 py-2">
      <div className="flex items-stretch divide-x divide-gray-100">
        <Cell
          value={sent} percent={null} label="Отправлено" color="text-gray-700"
          hint="Скольким уникальным адресам попытались отправить письмо."
        />
        <Cell
          value={delivered} percent={pct(delivered, sent)} label="Доставлено" color="text-green-600"
          hint="Почтовый сервер получателя принял письмо. Процент — от отправленных."
        />
        <Cell
          value={opened} percent={pct(opened, delivered)} label="Открыли" color="text-blue-600"
          hint={
            'Загрузилась картинка внутри письма. Процент — от доставленных.\n\n' +
            `Из них без почтового прокси: ${opened_human}.\n\n` +
            'Gmail и Apple Mail подгружают картинки сами, ещё до того как человек ' +
            'прочитал письмо. Считаем так же, как GetCourse и Mailchimp — иначе Gmail ' +
            '(половина базы) давал бы ноль.'
          }
        />
        <Cell
          value={clicked} percent={pct(clicked, delivered)} label="Кликнули" color="text-purple-600"
          hint="Перешли по ссылке из письма. Процент — от доставленных. Самая честная цифра: почтовый прокси её подделать не может."
        />
      </div>
    </div>
  )
}
