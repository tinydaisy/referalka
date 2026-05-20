'use client'
import { useState, useEffect, useRef } from 'react'
import { Plus, Trash2, Clock, Save, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

interface Step {
  id: number
  sort_order: number
  offset_seconds: number
  text: string
  button_label: string
  is_active: boolean
}

interface Props {
  eventId: number
}

// Единицы для интервалов. Множитель в секундах.
type Unit = 'seconds' | 'minutes' | 'hours' | 'days'
const UNIT_FACTORS: Record<Unit, number> = {
  seconds: 1,
  minutes: 60,
  hours:   3600,
  days:    86400,
}
const UNIT_LABELS: Record<Unit, [string, string, string]> = {
  // (1, 2..4, 5+) — стандартный slavic plural
  seconds: ['секунда',  'секунды',  'секунд'],
  minutes: ['минута',   'минуты',   'минут'],
  hours:   ['час',      'часа',     'часов'],
  days:    ['сутки',    'суток',    'суток'],
}

function plural(n: number, one: string, few: string, many: string) {
  const m = n % 10, t = n % 100
  if (m === 1 && t !== 11) return one
  if (m >= 2 && m <= 4 && (t < 12 || t > 14)) return few
  return many
}

// Из секунд вернёт удобное (число, единица) — наибольшая единица где значение целое.
function secondsToValueUnit(sec: number): { value: number; unit: Unit } {
  if (sec === 0) return { value: 0, unit: 'minutes' }
  if (sec % 86400 === 0) return { value: sec / 86400, unit: 'days' }
  if (sec % 3600 === 0)  return { value: sec / 3600,  unit: 'hours' }
  if (sec % 60 === 0)    return { value: sec / 60,    unit: 'minutes' }
  return { value: sec, unit: 'seconds' }
}

function formatOffset(sec: number): string {
  const { value, unit } = secondsToValueUnit(sec)
  const [one, few, many] = UNIT_LABELS[unit]
  return `через ${value} ${plural(value, one, few, many)}`
}

export default function NurtureTab({ eventId }: Props) {
  const [steps, setSteps] = useState<Step[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Record<number, Partial<Step>>>({})
  const [eventSlug, setEventSlug] = useState<string>('')
  const lastAddedRef = useRef<number | null>(null)
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({})

  // Подтягиваем slug события — чтобы показать в подсказке куда ведёт кнопка
  useEffect(() => {
    api.events.get(eventId).then((r: any) => {
      setEventSlug(r?.event?.slug || '')
    }).catch(() => {})
  }, [eventId])

  // После reload — если был добавлен шаг, scroll к нему и подсветить
  useEffect(() => {
    if (lastAddedRef.current && steps.find(s => s.id === lastAddedRef.current)) {
      const el = cardRefs.current[lastAddedRef.current]
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.style.outline = '2px solid #FFCFA4'
        setTimeout(() => { if (el) el.style.outline = '' }, 2000)
      }
      lastAddedRef.current = null
    }
  }, [steps])

  async function load() {
    setLoading(true)
    try {
      const r = await api.eventNurture.list(eventId)
      setSteps(r.steps || [])
      setDrafts({})
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [eventId])

  function patchDraft(stepId: number, p: Partial<Step>) {
    setDrafts(d => ({ ...d, [stepId]: { ...d[stepId], ...p } }))
  }

  async function saveStep(s: Step) {
    const d = drafts[s.id]
    if (!d) return
    setSaving(s.id)
    try {
      await api.eventNurture.update(s.id, d)
      await load()
    } finally {
      setSaving(null)
    }
  }

  async function toggleActive(s: Step) {
    await api.eventNurture.update(s.id, { is_active: !s.is_active })
    load()
  }

  async function deleteStep(s: Step) {
    if (!confirm(`Удалить этот шаг воронки догрева?`)) return
    await api.eventNurture.remove(s.id)
    load()
  }

  async function addStep() {
    // Дефолт — сутки после последнего шага. Новый шаг ВЫКЛЮЧЕН — клиент
    // допишет текст и включит вручную.
    const lastOffset = steps.length ? steps[steps.length - 1].offset_seconds : 30 * 60
    const r = await api.eventNurture.create(eventId, {
      offset_seconds: lastOffset + 86400,
      text: 'Новое сообщение воронки. Допишите текст и включите шаг ↑',
      button_label: 'Зарегистрироваться',
      is_active: false,
    })
    lastAddedRef.current = r?.id || null
    load()
  }

  if (loading) {
    return <div className="text-sm text-gray-400 py-8">Загрузка…</div>
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Clock size={18} /> Воронка догрева
        </h3>
        <p className="text-sm text-gray-500 mt-1">
          Серия сообщений человеку, который открыл событие, но не зарегистрировался.
          Отсчёт интервалов идёт от момента первого открытия — каждый получает в своё время.
          Воронка останавливается автоматически когда человек регистрируется или событие
          начинается.
        </p>
        <p className="text-xs text-gray-500 mt-2">
          Поддерживается HTML-форматирование: <code>&lt;b&gt;жирный&lt;/b&gt;</code>,{' '}
          <code>&lt;i&gt;курсив&lt;/i&gt;</code>, <code>&lt;a href="..."&gt;ссылка&lt;/a&gt;</code>.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Плейсхолдеры в тексте подставляются автоматически при отправке:
        </p>
        <ul className="text-xs text-gray-500 mt-1 ml-4 list-disc space-y-0.5">
          <li><code>{'{event_title}'}</code> — название события</li>
          <li><code>{'{event_date_short}'}</code> — дата в формате «28 мая в 11:00 МСК»</li>
          <li><code>{'{owner_telegram}'}</code> — ваш Telegram-контакт из настроек (поле «Telegram для связи» в профиле). Если поле пустое — fallback на текст про Экосистему.</li>
        </ul>
      </div>

      {steps.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500">
          Шагов пока нет. Добавьте первый ниже.
        </div>
      ) : (
        steps.map((s, i) => {
          const d = drafts[s.id] || {}
          const dirty = Object.keys(d).length > 0
          const currentOffset = d.offset_seconds ?? s.offset_seconds
          const currentText = d.text ?? s.text
          const currentLabel = d.button_label ?? s.button_label
          const { value: vuValue, unit: vuUnit } = secondsToValueUnit(currentOffset)
          // Mini App URL для подсказки «куда ведёт кнопка»
          const tgUrl = eventSlug
            ? `https://t.me/pluson_bot/pluson?startapp=ref_pg${eventSlug}`
            : ''
          return (
            <div
              key={s.id}
              ref={el => { cardRefs.current[s.id] = el }}
              className={`bg-white rounded-2xl border shadow-sm p-5 transition-all ${s.is_active ? 'border-gray-100' : 'border-gray-200 bg-gray-50 opacity-75'}`}>
              <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                       style={{ background: '#FFCFA4', color: '#25455D' }}>
                    {i + 1}
                  </div>
                  <span className="text-sm font-semibold text-gray-900">
                    Шаг {i + 1} — {formatOffset(currentOffset)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input type="checkbox" checked={s.is_active} onChange={() => toggleActive(s)} />
                    <span className="text-gray-600">{s.is_active ? 'Включён' : 'Выключен'}</span>
                  </label>
                  <button onClick={() => deleteStep(s)}
                          className="p-1.5 text-gray-400 hover:text-red-500 rounded">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Через</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min={1}
                      value={vuValue || 1}
                      onChange={e => {
                        const v = Math.max(1, Number(e.target.value) || 1)
                        patchDraft(s.id, { offset_seconds: v * UNIT_FACTORS[vuUnit] })
                      }}
                      className="w-20 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                    />
                    <select
                      value={vuUnit}
                      onChange={e => {
                        const newUnit = e.target.value as Unit
                        patchDraft(s.id, { offset_seconds: (vuValue || 1) * UNIT_FACTORS[newUnit] })
                      }}
                      className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                    >
                      <option value="seconds">секунд</option>
                      <option value="minutes">минут</option>
                      <option value="hours">часов</option>
                      <option value="days">суток</option>
                    </select>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1">от первого открытия события</p>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">Надпись на кнопке</label>
                  <input
                    value={currentLabel}
                    onChange={e => patchDraft(s.id, { button_label: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                    placeholder="Зарегистрироваться"
                  />
                  {tgUrl && (
                    <p className="text-[11px] text-gray-400 mt-1 flex items-center gap-1 flex-wrap">
                      <ExternalLink size={11} /> Ведёт на страницу события в Mini App (для TG: <code className="text-[10px]">{tgUrl}</code>; для VK — аналогичная ссылка через сообщество).
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-3">
                <label className="block text-xs text-gray-500 mb-1">Текст сообщения (HTML)</label>
                <textarea
                  value={currentText}
                  onChange={e => patchDraft(s.id, { text: e.target.value })}
                  rows={6}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
                  placeholder="Текст с HTML-разметкой..."
                />
              </div>

              <div className="mt-3 flex justify-end">
                <button
                  onClick={() => saveStep(s)}
                  disabled={!dirty || saving === s.id}
                  className="px-4 py-2 rounded-lg text-white font-semibold text-sm inline-flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
                >
                  <Save size={14} /> {saving === s.id ? 'Сохранение…' : dirty ? 'Сохранить' : 'Сохранено'}
                </button>
              </div>
            </div>
          )
        })
      )}

      <button
        onClick={addStep}
        className="w-full py-3 rounded-xl border-2 border-dashed border-gray-200 text-sm font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 inline-flex items-center justify-center gap-2"
      >
        <Plus size={16} /> Добавить ещё шаг
      </button>
    </div>
  )
}
