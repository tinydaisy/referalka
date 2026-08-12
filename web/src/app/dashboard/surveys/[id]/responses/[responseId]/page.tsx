'use client'

/**
 * Ответ одного человека на анкету — отдельная СТРАНИЦА (решение владельца).
 *
 * ⚠️ Не модалка: из ответа чаще всего идут дальше — в карточку контакта, — а
 * всплывающее окно такой переход обрывает. Наверху две ссылки: «Назад к
 * ответам» и «Открыть карточку контакта».
 *
 * ⚠️ Показываем ВСЕ вопросы анкеты, включая те, на которые не ответили:
 * пропущенный вопрос — тоже информация (например, необязательный, который
 * все игнорируют).
 */
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import { ArrowLeft, UserCircle } from 'lucide-react'

export default function SurveyResponsePage() {
  const { id, responseId } = useParams<{ id: string; responseId: string }>()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.surveys.response(Number(id), Number(responseId))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [id, responseId])

  if (loading) return <p className="p-6 text-sm text-gray-400">Загружаем…</p>
  if (!data) return <p className="p-6 text-sm text-red-600">Ответ не найден</p>

  const contacts: Array<[string, string]> = [
    ['Почта', data.email],
    ['Телефон', data.phone],
    ['Telegram', data.telegram],
    ['ВКонтакте', data.vk],
    ['MAX', data.max_nick],
  ].filter(([, v]) => !!v) as Array<[string, string]>

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
        <Link href={`/dashboard/surveys/${id}?tab=answers`}
              className="flex items-center gap-2 text-gray-500 hover:text-gray-700">
          <ArrowLeft size={14} /> Назад к ответам
        </Link>
        <Link href={`/dashboard/clients?contact=${data.contact_id}`}
              className="flex items-center gap-2 text-[#25455D] hover:underline">
          <UserCircle size={15} /> Открыть карточку контакта
        </Link>
      </div>

      <h1 className="mb-1 text-2xl font-bold text-gray-900">
        {data.name || 'Без имени'}
      </h1>
      <p className="mb-6 text-sm text-gray-500">
        {data.survey?.title}
        {' · '}
        {new Date(data.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК
      </p>

      {contacts.length > 0 && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-800">Контакты</h2>
          <div className="space-y-1.5">
            {contacts.map(([label, val]) => (
              <div key={label} className="flex justify-between gap-3 text-sm">
                <span className="text-gray-500">{label}</span>
                <span className="text-gray-900">{val}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-800">Ответы на анкету</h2>
        <div className="space-y-4">
          {(data.answers || []).map((a: any) => (
            <div key={a.id}>
              <div className="text-xs text-gray-500">{a.title}</div>
              <div className="text-sm text-gray-900">
                {a.value || <span className="text-gray-400">не ответил</span>}
              </div>
            </div>
          ))}
          {!(data.answers || []).length && (
            <p className="text-sm text-gray-400">В анкете нет вопросов.</p>
          )}
        </div>
      </div>
    </div>
  )
}
