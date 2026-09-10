'use client'
/**
 * Поле адреса с подсказками при вводе (DaData через наш бэкенд).
 *
 * ⚠️ Один компонент на мероприятие и конференцию: два поля адреса, набранные
 * порознь, разъедутся — у одного появятся подсказки, у другого нет.
 *
 * ⚠️ ПОДСКАЗКА — ПОМОЩЬ, А НЕ ОГРАНИЧЕНИЕ. Выбирать из списка необязательно:
 * бывают площадки, которых в справочнике нет (коворкинг в новом здании, база
 * отдыха за городом). Что человек написал, то и сохраняется.
 */
import { useEffect, useRef, useState } from 'react'
import { MapPin } from 'lucide-react'
import { api } from '@/lib/api'

type Item = { value: string; lat?: number | null; lon?: number | null }

export default function AddressField({
  value, onChange, onGeo, placeholder = 'Москва, ул. Тверская, 1',
}: {
  value: string
  onChange: (v: string) => void
  /** Координаты выбранной подсказки — по ним карта ставит МЕТКУ. Поиск по
   *  тексту метку не рисует: человек видит район, но не точку. Адрес вписали
   *  руками (без выбора из списка) → приходит null, и карта работает
   *  по-старому, по тексту. */
  onGeo?: (lat: number | null, lon: number | null) => void
  placeholder?: string
}) {
  const [items, setItems] = useState<Item[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  // Что мы сами только что подставили из списка: по нему гасим повторный
  // запрос — иначе выбор варианта тут же снова открывал бы подсказки.
  const justPicked = useRef('')
  const boxRef = useRef<HTMLDivElement>(null)

  // ⚠️ Запрос НЕ на каждую букву: ждём паузу в наборе. Иначе на «Москва, ул…»
  // уходит два десятка запросов, и суточный лимит тратится впустую.
  useEffect(() => {
    const q = (value || '').trim()
    if (q === justPicked.current) return
    if (q.length < 3) { setItems([]); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const r: any = await api.address.suggest(q)
        if (!cancelled) {
          setItems(r?.items || [])
          setOpen(true)
        }
      } catch {
        // Подсказки — удобство поверх обычного поля: молча обходимся без них.
        if (!cancelled) setItems([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [value])

  // Клик мимо списка — закрыть. ⚠️ Это не модалка-форма (правило «не закрывать
  // по фону» сюда не относится): выпадающий список обязан гаснуть, иначе он
  // перекрывает поля под собой.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  function pick(it: Item) {
    justPicked.current = it.value
    onChange(it.value)
    onGeo?.(it.lat ?? null, it.lon ?? null)
    setOpen(false)
    setItems([])
  }

  return (
    <div className="relative" ref={boxRef}>
      <input
        value={value}
        // ⚠️ Правка руками СБРАСЫВАЕТ координаты: иначе метка осталась бы от
        // прежнего адреса и показывала бы не то место.
        onChange={e => { onChange(e.target.value); onGeo?.(null, null) }}
        onFocus={() => { if (items.length) setOpen(true) }}
        className="input"
        placeholder={placeholder}
        autoComplete="off"
      />
      {loading && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
          ищем…
        </span>
      )}
      {open && items.length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-white rounded-xl border card-border shadow-lg overflow-hidden">
          {items.map((it, i) => (
            <button
              key={`${it.value}-${i}`}
              type="button"
              onClick={() => pick(it)}
              className="w-full text-left px-3 py-2.5 text-sm text-gray-700 hover:bg-gray-50 flex items-start gap-2"
            >
              <MapPin size={14} className="mt-0.5 shrink-0 text-[#25455D]" />
              <span>{it.value}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
