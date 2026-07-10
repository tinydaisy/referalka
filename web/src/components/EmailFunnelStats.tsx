'use client'

/**
 * Воронка email-рассылки — 4 цифры по УНИКАЛЬНЫМ адресам получателей.
 * Один компонент на обе страницы рассылок: общие (/dashboard/broadcasts)
 * и событийные (/dashboard/conferences/[id]/broadcasts/queue).
 *
 * Данные считает бэк — app/services/email_funnel_stats.py.
 */

export type EmailStats = {
  sent: number          // скольким адресам попытались отправить
  delivered: number     // почта получателя приняла письмо
  opened: number        // загрузился пиксель (вкл. прокси-предзагрузку)
  opened_human: number  // из них без почтового прокси
  clicked: number       // перешли по ссылке из письма
}

function Tile({ label, value, of, color, hint }: {
  label: string; value: number; of?: number; color: string; hint: string
}) {
  const pct = of && of > 0 ? Math.round((value / of) * 1000) / 10 : null
  return (
    <div
      className="flex-1 min-w-[70px] rounded-xl border border-gray-200 bg-white px-2.5 py-2"
      title={hint}
    >
      <div className={`text-lg font-bold leading-none ${color}`}>{value}</div>
      <div className="text-[11px] text-gray-500 mt-1 leading-tight">{label}</div>
      {pct !== null && <div className="text-[10px] text-gray-400 mt-0.5">{pct}%</div>}
    </div>
  )
}

export default function EmailFunnelStats({ stats }: { stats?: EmailStats | null }) {
  if (!stats || !stats.sent) return null
  return (
    <div className="mt-2">
      <p className="text-[11px] font-semibold text-gray-600 mb-1">Email — по уникальным адресам:</p>
      <div className="flex gap-1.5">
        <Tile
          label="Отправлено" value={stats.sent} color="text-gray-700"
          hint="Скольким адресам мы попытались отправить письмо."
        />
        <Tile
          label="Доставлено" value={stats.delivered} of={stats.sent} color="text-green-600"
          hint="Почтовый сервер получателя принял письмо. Остальные — отказы, причины ниже."
        />
        <Tile
          label="Открыли" value={stats.opened} of={stats.delivered} color="text-blue-600"
          hint={
            'Загрузилась картинка внутри письма.\n\n' +
            `Из них без почтового прокси: ${stats.opened_human}.\n\n` +
            'Gmail и Apple Mail подгружают картинки сами, ещё до того как человек ' +
            'прочитал письмо, поэтому цифра завышена. Считаем так же, как GetCourse ' +
            'и Mailchimp — иначе Gmail (половина базы) давал бы ноль.'
          }
        />
        <Tile
          label="Кликнули" value={stats.clicked} of={stats.delivered} color="text-purple-600"
          hint="Перешли по ссылке из письма. Самая честная цифра — почтовый прокси её подделать не может."
        />
      </div>
    </div>
  )
}
