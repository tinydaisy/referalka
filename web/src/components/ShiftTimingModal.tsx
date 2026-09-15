'use client'
import { useState } from 'react'
import { api } from '@/lib/api'

/**
 * Сдвиг тайминга слотов внутри одного дня программы.
 *
 * Выбирается слот, с которого начинается сдвиг, и количество минут (может быть
 * отрицательным — сдвинуть раньше). Сдвигается выбранный слот и все, что идут
 * после него в этот же день. Другие дни не трогаются.
 *
 * Вместе со слотами двигаются ещё не отправленные спикерские рассылки этих
 * слотов («за 5 минут до выступления» и «подарок после эфира») — иначе
 * программа уедет, а рассылки останутся на старом времени.
 *
 * Сессии передаёт вызывающая вкладка (они уже загружены) — сюда приходят
 * только слоты выбранного дня. Если слотов со временем нет, форму сохранить
 * нельзя.
 */
export default function ShiftTimingModal({
  eventId, day, sessions, onClose, onDone,
}: {
  eventId: number
  day: number
  /** Слоты этого дня: { id, start_time, end_time, title, speaker_name } */
  sessions: any[]
  onClose: () => void
  onDone: () => void
}) {
  const [fromId, setFromId] = useState('')
  const [minutes, setMinutes] = useState('')
  const [saving, setSaving] = useState(false)

  // Сдвигать можно только слоты со временем — у слота без времени нечего двигать.
  const timed = sessions
    .filter(s => s.start_time)
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)))

  const min = parseInt(minutes, 10)
  const canSave = timed.length > 0 && !!fromId && Number.isFinite(min) && min !== 0 && !saving

  const idx = timed.findIndex(s => String(s.id) === String(fromId))
  const affected = idx >= 0 ? timed.slice(idx) : []

  function preview(hhmm: string) {
    if (!hhmm || !Number.isFinite(min)) return hhmm
    const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number)
    const total = Math.max(0, Math.min(h * 60 + m + min, 23 * 60 + 59))
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }

  async function save() {
    if (!canSave) return
    setSaving(true)
    try {
      const res = await api.conference.sessions.shiftTiming(eventId, {
        day, from_session_id: Number(fromId), minutes: min,
      })
      onDone()
      onClose()
      const sign = min > 0 ? 'позже' : 'раньше'
      alert(
        `Сдвинуто ${res.sessions_shifted} слотов на ${Math.abs(min)} мин ${sign}.` +
        (res.broadcasts_shifted ? `\nЗаодно сдвинуто ${res.broadcasts_shifted} рассылок этих спикеров.` : '')
      )
    } catch (e: any) {
      alert(e?.message || 'Не удалось сдвинуть тайминг')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6 scroll-visible">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-gray-900">Сдвинуть тайминг дня</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors">✕</button>
        </div>

        <p className="text-xs text-gray-500 mb-4">
          Программа поехала? Выберите слот, с которого всё сдвигается, и на сколько минут.
          Сдвинутся этот слот и все следующие за ним в этот день. Другие дни не изменятся.
          Рассылки «за 5 минут до выступления» и «подарок после эфира» сдвинутся вместе со слотами.
        </p>

        {timed.length === 0 ? (
          <div className="px-3 py-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
            В этом дне нет слотов со временем — сдвигать нечего.
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="label">Начать сдвиг со слота</label>
              <select value={fromId} onChange={e => setFromId(e.target.value)} className="input bg-white">
                <option value="">— выберите слот —</option>
                {timed.map(s => (
                  <option key={s.id} value={s.id}>
                    {String(s.start_time).slice(0, 5)} — {s.speaker_name || s.title || `Слот #${s.id}`}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Сдвиг в минутах</label>
              <input type="number" value={minutes} onChange={e => setMinutes(e.target.value)}
                className="input" placeholder="например 15" />
              <p className="text-[11px] text-gray-400 mt-1">
                Положительное число — позже, отрицательное (например −10) — раньше.
              </p>
            </div>

            {affected.length > 0 && Number.isFinite(min) && min !== 0 && (
              <div className="px-3 py-2 rounded-lg bg-gray-50 border border-gray-100 text-xs text-gray-600 space-y-1">
                <p className="font-medium text-gray-700">Сдвинется {affected.length} слот(ов):</p>
                {affected.slice(0, 6).map(s => (
                  <p key={s.id} className="font-mono">
                    {String(s.start_time).slice(0, 5)} → {preview(s.start_time)}
                    <span className="font-sans text-gray-400"> · {s.speaker_name || s.title}</span>
                  </p>
                ))}
                {affected.length > 6 && <p className="text-gray-400">…и ещё {affected.length - 6}</p>}
              </div>
            )}
          </div>
        )}

        <div className="flex gap-3 mt-5">
          <button onClick={save} disabled={!canSave}
            className="btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm disabled:opacity-60">
            {saving ? 'Сдвигаю…' : 'Сдвинуть'}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
            Отмена
          </button>
        </div>
      </div>
    </div>
  )
}
