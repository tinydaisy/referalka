/**
 * Публичная страничка политики обработки персональных данных клиента.
 * URL: /c/{client_id}/privacy
 *
 * Просто рендерит текст политики (с переносами строк) и блок «Оператор
 * персональных данных» внизу с юр-данными.
 *
 * Используется:
 * - В подвале каждого письма (URL вшит в ссылку «политики»)
 * - В чекбоксе согласия на форме регистрации (ссылка «С политикой ознакомлен»)
 */
import { notFound } from 'next/navigation'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const FORM_LABELS: Record<string, string> = {
  individual: 'Самозанятый',
  ip: 'Индивидуальный предприниматель',
  ooo: 'Юридическое лицо',
  other: 'Другая форма',
}

async function getPolicy(clientId: string) {
  try {
    const r = await fetch(`${API_BASE}/api/v1/public/clients/${clientId}/privacy`, {
      cache: 'no-store',
    })
    if (!r.ok) return null
    return r.json()
  } catch {
    return null
  }
}

export default async function PrivacyPage({
  params,
}: {
  params: Promise<{ clientId: string }>
}) {
  const { clientId } = await params
  const data = await getPolicy(clientId)
  if (!data) notFound()

  // Политика ещё не опубликована. ⚠️ Не 404: ссылка на политику стоит в согласии
  // 152-ФЗ при регистрации, и «страница не найдена» выглядит как поломанная ссылка.
  // Объясняем человеку, что происходит, и что делать.
  if (data.published === false) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-3xl mx-auto px-4 py-12">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Политика обработки персональных данных
          </h1>
          <p className="text-sm text-gray-500 mb-8">{data.display_name}</p>
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <p className="text-gray-800 font-medium mb-2">
              Организатор пока не опубликовал политику обработки персональных данных.
            </p>
            <p className="text-sm text-gray-600">
              Ваши данные обрабатываются в соответствии с 152-ФЗ. За текстом политики и по
              вопросам обработки ваших данных обратитесь напрямую к организатору события.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const publishedDate = data.privacy_policy_published_at
    ? new Date(data.privacy_policy_published_at).toLocaleDateString('ru-RU', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : ''

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-12">
        {/* Шапка */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Политика обработки персональных данных
          </h1>
          <p className="text-sm text-gray-500">
            {data.display_name}
            {publishedDate && <> · Опубликовано {publishedDate}</>}
            {data.privacy_policy_version > 0 && <> · версия {data.privacy_policy_version}</>}
          </p>
        </div>

        {/* Текст политики */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 mb-6">
          <div
            className="prose prose-sm max-w-none text-gray-800 whitespace-pre-wrap leading-relaxed"
            style={{ fontFamily: 'inherit' }}
          >
            {data.privacy_policy_text}
          </div>
        </div>

        {/* Оператор персональных данных */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8">
          <h2 className="font-semibold text-gray-900 mb-4">Оператор персональных данных</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-y-3 text-sm">
            {data.legal_form && (
              <>
                <dt className="text-gray-500">Форма</dt>
                <dd className="sm:col-span-2 text-gray-800">{FORM_LABELS[data.legal_form] || data.legal_form}</dd>
              </>
            )}
            {data.legal_name && (
              <>
                <dt className="text-gray-500">Наименование</dt>
                <dd className="sm:col-span-2 text-gray-800">{data.legal_name}</dd>
              </>
            )}
            {data.legal_inn && (
              <>
                <dt className="text-gray-500">{data.legal_inn_label?.trim() || 'ИНН'}</dt>
                <dd className="sm:col-span-2 text-gray-800">{data.legal_inn}</dd>
              </>
            )}
            {data.legal_ogrn && (
              <>
                <dt className="text-gray-500">ОГРН</dt>
                <dd className="sm:col-span-2 text-gray-800">{data.legal_ogrn}</dd>
              </>
            )}
            {data.legal_address && (
              <>
                <dt className="text-gray-500">Адрес</dt>
                <dd className="sm:col-span-2 text-gray-800">{data.legal_address}</dd>
              </>
            )}
            {data.legal_operator_email && (
              <>
                <dt className="text-gray-500">Email</dt>
                <dd className="sm:col-span-2 text-gray-800">
                  <a href={`mailto:${data.legal_operator_email}`} className="text-blue-600 hover:underline">
                    {data.legal_operator_email}
                  </a>
                </dd>
              </>
            )}
            {data.legal_operator_phone && (
              <>
                <dt className="text-gray-500">Телефон</dt>
                <dd className="sm:col-span-2 text-gray-800">{data.legal_operator_phone}</dd>
              </>
            )}
          </dl>
        </div>

        <p className="text-center text-xs text-gray-400 mt-8">
          Хостинг — платформа{' '}
          <a href="https://pluson.ru" className="hover:underline">iViSiON: ПЛЮСОН</a>
        </p>
      </div>
    </div>
  )
}
