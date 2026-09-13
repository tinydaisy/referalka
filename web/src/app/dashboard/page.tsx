'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'

// Раздел «Дашборд» убран из меню. Корень /dashboard решает, куда высадить
// человека при входе.
//
// ⚠️⚠️ НЕТ СВОЕГО TELEGRAM-БОТА → ВЕДЁМ В АВТОНАСТРОЙКУ, а не в «Каналы».
// Раньше вели в «Каналы» с плашкой-подсказкой, и человек оставался один на
// один с полем токена: чтобы получить бота, надо уйти в @BotFather, создать
// его там руками и вернуться. Услуга «под ключ» делает ровно это за него и
// открыта всем тарифам — значит и вести надо туда, где работа делается, а не
// туда, где её просят сделать самому.
//
// ⚠️ Смотрим ИМЕННО НА TELEGRAM, а не на «есть хоть какой-то бот» (решение
// владельца): у клиента может быть сообщество ВКонтакте или бот MAX и не быть
// Telegram — тащить его в автонастройку каждый раз незачем, он работает на
// своей площадке. И наоборот: TG-бот есть, остальных нет — всё в порядке,
// это самая частая рабочая связка.
//
// ⚠️ Ведём КАЖДЫЙ РАЗ, пока Telegram-бота нет (решение владельца): без него
// половина платформы недоступна, и один показ при регистрации забывается.
export default function DashboardPage() {
  const router = useRouter()
  useEffect(() => {
    let done = false
    api.channels.list()
      .then((chs: any) => {
        const items = chs.items || []
        const hasOwnTelegram = items.some(
          (c: any) => !c.is_system && c.platform_slug === 'telegram',
        )
        if (done) return
        // Автонастройка живёт отдельной страницей (переехала из «Каналов»),
        // и открывается на своей вкладке по умолчанию.
        router.replace(hasOwnTelegram ? '/dashboard/events' : '/dashboard/autosetup')
      })
      .catch(() => { if (!done) router.replace('/dashboard/events') })
    return () => { done = true }
  }, [router])

  return (
    <div className="flex items-center justify-center h-64">
      <div
        className="w-8 h-8 border-2 rounded-full border-t-transparent animate-spin"
        style={{ borderColor: '#25455D', borderTopColor: 'transparent' }}
      />
    </div>
  )
}
