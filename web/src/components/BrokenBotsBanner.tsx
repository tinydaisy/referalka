'use client'

/**
 * Плашка «бот уведён в сторонний сервис».
 *
 * ⚠️ Telegram отдаёт сообщения ТОЛЬКО ОДНОМУ получателю. Если клиент
 * подключил своего бота ещё и к стороннему сервису (BotHelp, merexo…), тот
 * ставит вебхук — и наш polling не получает ничего. У клиента МОЛЧА
 * отваливаются воронки, подарки, проверка подписки и регистрация на
 * события, а в кабинете всё выглядит исправным. Поэтому предупреждение
 * висит поверх всех разделов, как «email не подтверждён».
 *
 * ⚠️ Кнопки «отключить сторонний сервис» здесь нет намеренно: снять вебхук
 * значит сломать клиенту работу в ЕГО сервисе — это его решение, не наше.
 */
import Link from 'next/link'
import { useMe } from '@/hooks/useMe'

export default function BrokenBotsBanner() {
  const { me, isAnyAssistant } = useMe()
  // ⚠️ Только владельцу кабинета. `isOwner` тут не годится: он true и для
  // помощника с полными правами, а раздел «Каналы» помощникам закрыт —
  // сделать по этой плашке он всё равно ничего не сможет.
  if (isAnyAssistant) return null

  const bots: any[] = me?.broken_bots || []
  if (!bots.length) return null

  return (
    <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
      <div className="font-semibold">
        ⚠️ Внимание! Мы обнаружили, что{' '}
        {bots.length === 1 ? 'бот' : 'боты'}{' '}
        {bots.map((b, i) => (
          <span key={b.channel_id}>
            {i > 0 && ', '}
            <b>{b.handle}</b>
            {b.service ? ` (${b.service})` : ''}
          </span>
        ))}{' '}
        не {bots.length === 1 ? 'работает' : 'работают'} с ПЛЮСОНом —
        {bots.length === 1 ? ' он подключён' : ' они подключены'} к стороннему сервису.
      </div>

      <p className="mt-1.5">
        Telegram отдаёт сообщения только одному сервису. Поэтому через{' '}
        {bots.length === 1 ? 'этого бота' : 'этих ботов'} <b>не работают</b>{' '}
        воронки лид-магнитов, выдача подарков, проверка подписки, приветствия
        и регистрация на события.
      </p>

      <p className="mt-1.5">
        <b>Что делать:</b> отвяжите бота от стороннего сервиса — либо создайте
        отдельного бота для ПЛЮСОНа и подключите его в разделе{' '}
        <Link href="/dashboard/channels" className="underline">«Каналы»</Link>.
      </p>

      <Link href="/dashboard/help" className="mt-2 inline-block font-medium underline">
        Как создать бота →
      </Link>
    </div>
  )
}
