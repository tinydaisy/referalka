'use client'

import { useState } from 'react'
import { Copy, X } from 'lucide-react'

/**
 * Окно «Что перенести в копию».
 *
 * ⚠️ Люди по умолчанию НЕ переносятся: у нового события состав обычно другой,
 * а удалять десятки лишних карточек руками дольше, чем добавить нужных.
 *
 * ⚠️ Программа (дни и слоты) не копируется НИКОГДА, галочки для неё нет —
 * она привязана к конкретным датам и таймингу, а у копии даты свои.
 * Об этом прямо сказано в окне, чтобы не искали пропавшее расписание.
 *
 * ⚠️ Организаторы переносятся всегда — это владельцы события.
 *
 * Модалка-форма: закрывается только кнопкой, клик по фону не закрывает
 * (правило проекта — иначе теряется уже сделанный выбор).
 */
export default function CopyEventModal({
  open, busy, onCancel, onConfirm,
}: {
  open: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: (opts: { with_speakers: boolean; with_partners: boolean }) => void
}) {
  const [withSpeakers, setWithSpeakers] = useState(false)
  const [withPartners, setWithPartners] = useState(false)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
           onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <h3 className="text-lg font-bold text-gray-900">Что перенести в копию?</h3>
          <button onClick={onCancel} className="shrink-0 text-gray-400 hover:text-gray-600"
                  aria-label="Закрыть">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-3">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-3 hover:bg-gray-50">
            <input type="checkbox" className="mt-0.5" checked={withSpeakers}
                   onChange={e => setWithSpeakers(e.target.checked)} />
            <span className="text-sm">
              <span className="font-medium text-gray-900">Спикеры и жюри</span>
              <span className="mt-0.5 block text-xs text-gray-500">
                Карточки людей с темами и подарками. Слоты в программе они займут заново.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-3 hover:bg-gray-50">
            <input type="checkbox" className="mt-0.5" checked={withPartners}
                   onChange={e => setWithPartners(e.target.checked)} />
            <span className="text-sm">
              <span className="font-medium text-gray-900">Партнёры</span>
              <span className="mt-0.5 block text-xs text-gray-500">
                Карточки партнёров и генеральных партнёров события.
              </span>
            </span>
          </label>
        </div>

        <p className="mt-4 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
          Переносятся настройки, афиши, подарки, тарифы, лендинг и шаблоны рассылок.
          <br />
          <b>Программа не копируется</b> — она привязана к датам, а у копии они свои.
          Даты и дни программы задаются заново.
        </p>

        <div className="mt-5 flex gap-3">
          <button onClick={onCancel} disabled={busy}
                  className="flex-1 rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            Отмена
          </button>
          <button
            onClick={() => onConfirm({ with_speakers: withSpeakers, with_partners: withPartners })}
            disabled={busy}
            className="btn-gold flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
          >
            <Copy size={15} />
            {busy ? 'Копирую…' : 'Создать копию'}
          </button>
        </div>
      </div>
    </div>
  )
}
