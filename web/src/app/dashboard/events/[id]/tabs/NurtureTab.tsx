'use client'
import { useState, useEffect } from 'react'
import { Plus, Trash2, Clock, Save } from 'lucide-react'
import { api } from '@/lib/api'

interface Step {
  id: number
  sort_order: number
  offset_minutes: number
  text: string
  button_label: string
  is_active: boolean
}

interface Props {
  eventId: number
}

// Удобные пресеты интервалов для дропдауна.
const OFFSET_PRESETS: { label: string; minutes: number }[] = [
  { label: 'через 15 минут',  minutes: 15 },
  { label: 'через 30 минут',  minutes: 30 },
  { label: 'через 1 час',     minutes: 60 },
  { label: 'через 3 часа',    minutes: 180 },
  { label: 'через 6 часов',   minutes: 360 },
  { label: 'через 12 часов',  minutes: 720 },
  { label: 'через 1 сутки',   minutes: 1440 },
  { label: 'через 2 суток',   minutes: 2880 },
  { label: 'через 3 суток',   minutes: 4320 },
  { label: 'через 7 суток',   minutes: 10080 },
]

function formatOffset(min: number): string {
  if (min < 60) return `через ${min} мин`
  if (min < 1440) {
    const h = Math.floor(min / 60); const m = min % 60
    return m ? `через ${h} ч ${m} мин` : `через ${h} ч`
  }
  const d = Math.floor(min / 1440); const rest = min % 1440
  if (rest === 0) return `через ${d} ${plural(d, 'сутки', 'суток', 'суток')}`
  const h = Math.floor(rest / 60)
  return `через ${d} ${plural(d, 'д', 'д', 'д')} ${h} ч`
}

function plural(n: number, one: string, few: string, many: string) {
  const m = n % 10, t = n % 100
  if (m === 1 && t !== 11) return one
  if (m >= 2 && m <= 4 && (t < 12 || t > 14)) return few
  return many
}

export default function NurtureTab({ eventId }: Props) {
  const [steps, setSteps] = useState<Step[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Record<number, Partial<Step>>>({})

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
    // Дефолт — 30 мин после последнего шага, простой текст-заготовка
    const lastOffset = steps.length ? steps[steps.length - 1].offset_minutes : 30
    await api.eventNurture.create(eventId, {
      offset_minutes: lastOffset + 1440,
      text: 'Новое сообщение воронки.',
      button_label: 'Зарегистрироваться',
      is_active: true,
    })
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
          Плейсхолдеры в тексте: <code>{'{event_title}'}</code> — название события,{' '}
          <code>{'{event_date_short}'}</code> — дата в формате «28 мая в 11:00 МСК».
        </p>
      </div>

      {steps.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500">
          Шагов пока нет. Добавьте первый ниже.
        </div>
      ) : (
        steps.map((s, i) => {
          const d = drafts[s.id] || {}
          const dirty = Object.keys(d).length > 0
          const currentOffset = d.offset_minutes ?? s.offset_minutes
          const currentText = d.text ?? s.text
          const currentLabel = d.button_label ?? s.button_label
          return (
            <div key={s.id}
                 className={`bg-white rounded-2xl border shadow-sm p-5 ${s.is_active ? 'border-gray-100' : 'border-gray-200 bg-gray-50 opacity-75'}`}>
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
                <div className="sm:col-span-1">
                  <label className="block text-xs text-gray-500 mb-1">Когда отправить</label>
                  <select
                    value={OFFSET_PRESETS.find(p => p.minutes === currentOffset)?.minutes ?? -1}
                    onChange={e => {
                      const v = Number(e.target.value)
                      if (v > 0) patchDraft(s.id, { offset_minutes: v })
                    }}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                  >
                    {OFFSET_PRESETS.map(p => (
                      <option key={p.minutes} value={p.minutes}>{p.label}</option>
                    ))}
                    {!OFFSET_PRESETS.some(p => p.minutes === currentOffset) && (
                      <option value={currentOffset}>{formatOffset(currentOffset)} (текущее)</option>
                    )}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs text-gray-500 mb-1">Надпись на кнопке</label>
                  <input
                    value={currentLabel}
                    onChange={e => patchDraft(s.id, { button_label: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                    placeholder="Зарегистрироваться"
                  />
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

              {dirty && (
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={() => saveStep(s)}
                    disabled={saving === s.id}
                    className="px-4 py-2 rounded-lg text-white font-semibold text-sm inline-flex items-center gap-2 disabled:opacity-50"
                    style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
                  >
                    <Save size={14} /> {saving === s.id ? 'Сохранение…' : 'Сохранить'}
                  </button>
                </div>
              )}
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
