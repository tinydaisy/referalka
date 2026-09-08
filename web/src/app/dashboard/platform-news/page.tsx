'use client'

/**
 * Ведение новостей платформы из кабинета сервисного клиента («ПЛЮСОН Сервис»).
 *
 * ⚠️ Зачем отдельно от админки: чтобы посадить на новости человека из
 * техподдержки, не выдавая ему всю админку — там клиенты, тарифы, оплаты и
 * заявки на вывод.
 *
 * ⚠️ Проверка доступа стоит и здесь, и на бэкенде (`require_news_editor`).
 * Скрытого пункта меню мало: страница открывается по прямой ссылке.
 */
import { useMe } from '@/hooks/useMe'
import NewsManager from '@/components/news/NewsManager'

export default function ServiceNewsPage() {
  const { me, isAnyAssistant } = useMe()

  if (!me) return <div className="text-sm text-gray-400">Загружаем…</div>

  if (!me.is_system_service || isAnyAssistant) {
    return (
      <div className="max-w-lg rounded-xl border border-gray-200 bg-white px-5 py-8 text-center">
        <div className="font-semibold" style={{ color: '#25455D' }}>Раздел недоступен</div>
        <div className="mt-1 text-sm text-gray-500">
          Новости платформы ведёт команда ПЛЮСОНа.
        </div>
      </div>
    )
  }

  return <NewsManager />
}
