'use client'
import { useState } from 'react'

/**
 * Предпросмотр кабинета участника — два состояния одной страницы.
 *
 * ⚠️ Зачем. Обычная публичная ссылка `/event/{slug}` всегда открывается «как
 * незарегистрированный»: показывается лендинг с кнопкой «Хочу участвовать», а
 * кабинет с программой и подарками увидеть нечем. Организатор собирает событие
 * вслепую и не понимает, что получит человек ПОСЛЕ регистрации.
 *
 * ⚠️ Разница между ссылками — ровно параметр `?c={contact_id}`: по нему бэкенд
 * опознаёт человека (`platform=contact`, см. participants.py) и отдаёт его
 * кабинет. Без параметра зритель неизвестен, поэтому и показывается форма.
 *
 * ⚠️ Это НЕ отдельный «режим предпросмотра», а настоящие страницы: вторая
 * ссылка открывает кабинет от лица КОНКРЕТНОГО человека. Своей регистрации у
 * него может не быть — тогда он тоже увидит лендинг: это правда, а не поломка,
 * и об этом сказано в подписи.
 *
 * ⚠️ Компонент ОБЩИЙ для карточки спикера конференции/турнира и карточки
 * соорганизатора мероприятия/коллабы. Второй копии заводить нельзя — они
 * разъедутся при первой же правке текста, как уже было с блоками статей.
 */
export default function CabinetPreviewBlock(
  { publicHost, slug, contactId, personLabel = 'этого человека' }:
  {
    // slug приходит из состояния страницы и до загрузки события равен null —
    // блок в этот момент просто не рисуется (проверка ниже).
    publicHost: string
    slug: string | null
    contactId?: number | null
    // «спикера» / «соорганизатора» — чтобы подпись не звучала обезличенно.
    personLabel?: string
  },
) {
  const [copied, setCopied] = useState<string | null>(null)
  if (!slug) return null

  const base = `https://${publicHost}/event/${slug}`
  const guestUrl = base
  const memberUrl = contactId ? `${base}?c=${contactId}` : ''

  const copy = async (url: string, key: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(key); setTimeout(() => setCopied(null), 2000) } catch {}
  }

  const Row = ({ label, hint, url, k }: { label: string; hint: string; url: string; k: string }) => (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
      <div className="sm:w-52 sm:shrink-0">
        <div className="text-xs font-semibold text-gray-900">{label}</div>
        <div className="text-[11px] text-gray-500 leading-snug">{hint}</div>
      </div>
      <input readOnly value={url}
        className="flex-1 min-w-0 text-xs bg-white px-2 py-1.5 rounded-lg border border-gray-200 font-mono truncate" />
      <div className="flex gap-1.5 shrink-0">
        <a href={url} target="_blank" rel="noopener noreferrer"
          className="px-2.5 py-1.5 bg-brand text-white rounded-lg text-xs font-semibold hover:opacity-90">
          Открыть
        </a>
        <button type="button" onClick={() => copy(url, k)}
          className="px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50">
          {copied === k ? '✓' : 'Копировать'}
        </button>
      </div>
    </div>
  )

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 space-y-3">
      <div>
        <div className="font-semibold text-gray-900 text-sm">Предпросмотр кабинета участника</div>
        <div className="text-xs text-gray-600 mt-0.5">
          Как страница события выглядит для зрителя — до регистрации и после неё.
        </div>
      </div>
      <Row
        label="Как видит новый зритель"
        hint="Лендинг и кнопка «Хочу участвовать»"
        url={guestUrl}
        k="guest"
      />
      {memberUrl ? (
        <Row
          label="Как видит зарегистрированный"
          hint="Кабинет: программа, подарки, чаты"
          url={memberUrl}
          k="member"
        />
      ) : (
        <div className="text-xs text-gray-500">
          Второй ссылки нет: у {personLabel} не заведён контакт в базе, а кабинет открывается именно по нему.
        </div>
      )}
      <div className="text-[11px] text-gray-500 leading-snug">
        Вторая ссылка открывает кабинет от лица {personLabel}. Если он ещё не зарегистрирован
        на событие, то увидит лендинг — это не ошибка.
      </div>
    </div>
  )
}
