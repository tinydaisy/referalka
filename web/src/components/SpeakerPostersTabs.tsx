'use client'
/**
 * Афиши спикера НА СОБЫТИЕ — три вкладки, по одной афише в каждой.
 *
 * ⚠️ Почему вкладки, а не список (решение владельца 22.09.2026). Раньше афиши
 * копились кучей в библиотеке коллаба: у одного человека их десятки с разных
 * конференций, ориентация закодирована строкой в подписи, у большинства
 * подписи нет вовсе — выбрать нужную можно было только глазами. Здесь у
 * спикера ровно три слота: горизонтальный, квадратный, вертикальный. Загрузка
 * в занятый слот ЗАМЕНЯЕТ афишу, а не кладёт рядом ещё одну.
 *
 * Вкладки — тот же приём, что у чатов события TG/ВК/MAX: три вкладки, в
 * каждой одно поле.
 */
import { useEffect, useRef, useState } from 'react'
import { Trash2, Upload } from 'lucide-react'

type Orientation = 'horizontal' | 'square' | 'vertical'

type Slot = {
  orientation: Orientation
  label: string
  url: string | null
  source?: string | null
}

const ORDER: Orientation[] = ['horizontal', 'square', 'vertical']
const TITLES: Record<Orientation, string> = {
  horizontal: 'Горизонтальная',
  square: 'Квадратная',
  vertical: 'Вертикальная',
}
// Пропорции превью — чтобы пустой слот уже выглядел как та афиша, которую
// в него ждут, и человек не гадал, какой формат грузить.
const RATIO: Record<Orientation, string> = {
  horizontal: '16 / 9',
  square: '1 / 1',
  vertical: '9 / 16',
}

export default function SpeakerPostersTabs({
  eventId, ecId,
}: { eventId: number; ecId: number }) {
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [tab, setTab] = useState<Orientation>('square')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
  const token = () =>
    (typeof window !== 'undefined' && localStorage.getItem('plusson_token')) || ''

  async function load() {
    try {
      const r = await fetch(`${API}/api/v1/events/${eventId}/speakers/${ecId}/posters`,
        { headers: { Authorization: `Bearer ${token()}` } })
      if (!r.ok) throw new Error('Не удалось загрузить афиши')
      const d = await r.json()
      setSlots(d.items || [])
    } catch (e: any) {
      setErr(e?.message || 'Ошибка загрузки')
      setSlots([])
    }
  }

  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [eventId, ecId])

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    const f = files[0]
    setErr(null)
    if (f.size > 50 * 1024 * 1024) { setErr('Файл больше 50 МБ'); return }
    setBusy(true)
    try {
      // Сначала кладём файл в хранилище общей ручкой загрузки, потом
      // привязываем ссылку к слоту: так же, как это делают остальные поля
      // с картинками в проекте.
      const fd = new FormData()
      fd.append('file', f)
      fd.append('kind', 'speaker_poster')
      const up = await fetch(`${API}/api/v1/uploads`, {
        method: 'POST', body: fd,
        headers: { Authorization: `Bearer ${token()}` },
      })
      if (!up.ok) throw new Error('Не удалось загрузить файл')
      const { url } = await up.json()
      const r = await fetch(`${API}/api/v1/events/${eventId}/speakers/${ecId}/posters`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token()}`,
        },
        body: JSON.stringify({ url, orientation: tab }),
      })
      if (!r.ok) throw new Error('Не удалось сохранить афишу')
      await load()
    } catch (e: any) {
      setErr(e?.message || 'Ошибка загрузки')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function clearSlot() {
    if (!confirm(`Удалить ${TITLES[tab].toLowerCase()} афишу?`)) return
    setBusy(true)
    try {
      await fetch(`${API}/api/v1/events/${eventId}/speakers/${ecId}/posters/${tab}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token()}` },
      })
      await load()
    } finally {
      setBusy(false)
    }
  }

  const current = (slots || []).find(s => s.orientation === tab)

  return (
    <div className="rounded-xl border-2 border-[#25455D]/20 overflow-hidden">
      <div className="px-3 py-2 text-sm font-semibold"
           style={{ background: '#FFCFA4', color: '#25455D' }}>
        Афиши спикера для этого события
      </div>

      <div className="p-3">
        {/* Вкладки ориентаций */}
        <div className="flex gap-1 mb-3 border-b border-gray-200">
          {ORDER.map(o => {
            const filled = (slots || []).some(s => s.orientation === o && s.url)
            const active = tab === o
            return (
              <button
                key={o}
                type="button"
                onClick={() => setTab(o)}
                className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                  active
                    ? 'border-[#25455D] text-[#25455D] font-semibold'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {TITLES[o]}
                {/* Точка — слот заполнен: видно, чего ещё не хватает, не
                    переключая вкладки. */}
                {filled && <span className="ml-1.5 text-green-600">•</span>}
              </button>
            )
          })}
        </div>

        {err && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2">
            {err}
          </p>
        )}

        {slots === null ? (
          <p className="text-xs text-gray-400 py-6 text-center">Загружаю…</p>
        ) : (
          <div className="flex items-start gap-3">
            <div
              className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden shrink-0"
              style={{ width: 150, aspectRatio: RATIO[tab] }}
            >
              {current?.url ? (
                <img src={current.url} alt={TITLES[tab]}
                     className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[11px] text-gray-400 text-center px-2">
                  Пока нет
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-500 mb-2">
                {current?.url
                  ? 'Новый файл заменит эту афишу — в каждом формате хранится одна.'
                  : `Загрузите ${TITLES[tab].toLowerCase()} афишу этого спикера.`}
                {current?.source === 'generator' && (
                  <span className="block text-[11px] text-gray-400 mt-0.5">
                    Собрана генератором афиш.
                  </span>
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <input ref={fileRef} type="file" accept="image/*" hidden
                       onChange={e => upload(e.target.files)} />
                <button type="button" disabled={busy}
                        onClick={() => fileRef.current?.click()}
                        className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-60">
                  <Upload size={13} />
                  {busy ? 'Загружаю…' : (current?.url ? 'Заменить' : 'Загрузить')}
                </button>
                {current?.url && (
                  <button type="button" disabled={busy} onClick={clearSlot}
                          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:text-red-600 hover:border-red-200 inline-flex items-center gap-1.5">
                    <Trash2 size={13} /> Удалить
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ⚠️ Приоритет для рассылок — не случайный порядок, а правило
            владельца: квадрат одинаково хорош и в ленте, и в превью
            сообщения; вертикальная занимает весь экран и выглядит
            навязчиво. Пишем прямо здесь, чтобы клиент понимал, какую
            афишу увидят люди. */}
        <p className="text-[11px] text-gray-400 mt-3">
          В рассылки идёт квадратная афиша; если её нет — горизонтальная, затем вертикальная.
        </p>
      </div>
    </div>
  )
}
