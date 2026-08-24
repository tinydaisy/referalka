'use client'
/**
 * Форма создания и правки ДОПОЛНИТЕЛЬНОГО ПОЛЯ КОНТАКТА — общая на два места.
 *
 * ⚠️ Поле заводится из ДВУХ мест: раздел «Анкеты» → вкладка «Поля контакта»
 * и раздел «Контакты» → меню действий. Форма при этом ОДНА: две копии
 * разъехались бы при первой же правке (список типов, варианты, лимиты).
 *
 * Само поле создаётся один раз на кабинет и сразу существует у всех контактов
 * пустым; заполняется анкетой, импортом или руками в карточке.
 */
import { useState } from 'react'
import { api } from '@/lib/api'
import { Plus, Trash2, X } from 'lucide-react'

export const KINDS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'text', label: 'Короткий текст', hint: 'Имя, город, ссылка' },
  { value: 'textarea', label: 'Длинный текст', hint: 'Развёрнутый ответ' },
  { value: 'number', label: 'Число', hint: 'Возраст, количество' },
  { value: 'date', label: 'Дата', hint: 'День рождения, дата старта' },
  { value: 'scale', label: 'Шкала 1–10', hint: 'Оценка' },
  { value: 'select', label: 'Выбор одного варианта', hint: 'Один из списка' },
  { value: 'multiselect', label: 'Выбор нескольких', hint: 'Несколько из списка' },
  { value: 'bool', label: 'Да / Нет', hint: 'Простой выбор' },
]

export const NEEDS_OPTIONS = new Set(['select', 'multiselect'])

export function kindLabel(k: string) {
  return KINDS.find(x => x.value === k)?.label || k
}

export default function FieldForm({ field, onClose, onSaved }: any) {
  const [title, setTitle] = useState(field?.title || '')
  const [kind, setKind] = useState(field?.kind || 'text')
  const [options, setOptions] = useState<string[]>(
    Array.isArray(field?.options) ? field.options : [])
  const [showInCard, setShowInCard] = useState(field?.show_in_card !== false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    if (!title.trim()) { setErr('Впишите название поля'); return }
    if (NEEDS_OPTIONS.has(kind) && options.filter(o => o.trim()).length < 2) {
      setErr('Добавьте хотя бы два варианта ответа'); return
    }
    setSaving(true); setErr('')
    try {
      const payload = {
        title: title.trim(), kind, show_in_card: showInCard,
        options: NEEDS_OPTIONS.has(kind) ? options.filter(o => o.trim()) : [],
        ...(kind === 'scale' ? { scale_min: 1, scale_max: 10 } : {}),
      }
      if (field) await api.contactFields.update(field.id, payload)
      else await api.contactFields.create(payload)
      onSaved()
    } catch (e: any) {
      setErr(e.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  return (
    <div className="mb-4 rounded-xl border border-[#25455D]/30 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold text-gray-800">
          {field ? 'Изменить поле' : 'Новое поле'}
        </h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm text-gray-600">Название</span>
          <input className="input" value={title} onChange={e => setTitle(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-gray-600">Что вписывают</span>
          <select className="input bg-white" value={kind} onChange={e => setKind(e.target.value)}>
            {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
          <span className="mt-1 block text-xs text-gray-500">
            {KINDS.find(k => k.value === kind)?.hint}
          </span>
        </label>
      </div>

      {NEEDS_OPTIONS.has(kind) && (
        <div className="mt-3">
          <span className="mb-1 block text-sm text-gray-600">Варианты ответа</span>
          {options.map((o, i) => (
            <div key={i} className="mb-2 flex gap-2">
              <input className="input flex-1 min-w-0" value={o}
                     onChange={e => {
                       const next = [...options]; next[i] = e.target.value; setOptions(next)
                     }} />
              <button onClick={() => setOptions(options.filter((_, j) => j !== i))}
                      className="rounded-lg border border-gray-200 px-2.5 text-gray-400 hover:text-red-600">
                <X size={15} />
              </button>
            </div>
          ))}
          <button onClick={() => setOptions([...options, ''])}
                  className="text-sm text-[#25455D] hover:underline">
            + Добавить вариант
          </button>
        </div>
      )}

      <label className="mt-3 flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={showInCard}
               onChange={e => setShowInCard(e.target.checked)}
               className="h-4 w-4 rounded border-gray-300" />
        <span className="text-sm text-gray-700">Показывать в карточке контакта</span>
      </label>

      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}

      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600">
          Отмена
        </button>
        <button onClick={save} disabled={saving} className="btn-gold disabled:opacity-50">
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </div>
  )
}
