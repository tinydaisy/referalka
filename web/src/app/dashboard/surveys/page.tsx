'use client'

/**
 * Анкеты и дополнительные поля контакта (миграция 280).
 *
 * Две вкладки:
 *  - «Анкеты» — список анкет, ссылки для отправки, конструктор вопросов, отчёт.
 *  - «Поля контакта» — «Доход», «Ниша», «Статус». ⚠️ Поле создаётся ОДИН раз на
 *    весь кабинет и существует сразу у всех контактов (пустым, пока не
 *    заполнено). Заполняется анкетой, импортом или руками в карточке.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import {
  Plus, Trash2, Copy, Check, BarChart3, Settings2, ClipboardList, X,
} from 'lucide-react'

const KINDS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'text', label: 'Короткий текст', hint: 'Имя, город, ссылка' },
  { value: 'textarea', label: 'Длинный текст', hint: 'Развёрнутый ответ' },
  { value: 'number', label: 'Число', hint: 'Возраст, количество' },
  { value: 'date', label: 'Дата', hint: 'День рождения, дата старта' },
  { value: 'scale', label: 'Шкала 1–10', hint: 'Оценка' },
  { value: 'select', label: 'Выбор одного варианта', hint: 'Один из списка' },
  { value: 'multiselect', label: 'Выбор нескольких', hint: 'Несколько из списка' },
  { value: 'bool', label: 'Да / Нет', hint: 'Простой выбор' },
]

const NEEDS_OPTIONS = new Set(['select', 'multiselect'])

function kindLabel(k: string) {
  return KINDS.find(x => x.value === k)?.label || k
}

export default function SurveysPage() {
  const { isAssistant } = useMe()
  const [tab, setTab] = useState<'surveys' | 'fields'>('surveys')

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Анкеты</h1>
      <p className="text-sm text-gray-500 mb-6">
        Соберите анкету, отправьте ссылку — и смотрите, кто и как ответил.
        Тем, кто уже есть в базе, не придётся вписывать имя и контакты заново.
      </p>

      <div className="mb-6 flex gap-2 border-b border-gray-200">
        {([
          ['surveys', 'Анкеты', ClipboardList],
          ['fields', 'Поля контакта', Settings2],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm ${
              tab === key
                ? 'border-[#25455D] font-semibold text-[#25455D]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === 'surveys' ? <SurveysTab readOnly={isAssistant} />
                         : <FieldsTab readOnly={isAssistant} />}
    </div>
  )
}

/* ────────────────────────────── Поля контакта ───────────────────────────── */

function FieldsTab({ readOnly }: { readOnly: boolean }) {
  const [list, setList] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  const load = async () => {
    try { setList(await api.contactFields.list()) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  return (
    <div>
      <div className="mb-4 rounded-xl bg-gray-50 border border-gray-200 p-4 text-sm text-gray-600">
        Поле создаётся один раз и сразу появляется у <b>всех</b> контактов —
        пустым, пока не заполнено. Заполнить можно анкетой, импортом из файла
        или вручную в карточке человека. По заполненным полям работает фильтр в
        Контактах, а значит и сегмент для рассылки.
      </div>

      {!readOnly && (
        <button onClick={() => setAdding(true)} className="btn-gold mb-4 inline-flex items-center gap-2">
          <Plus size={16} /> Добавить поле
        </button>
      )}

      {adding && (
        <FieldForm
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load() }}
        />
      )}

      {!list.length && !adding && (
        <p className="text-sm text-gray-400">
          Пока ни одного поля. Например: «Уровень дохода», «Ниша», «Статус».
        </p>
      )}

      <div className="space-y-2">
        {list.map(f => (
          <FieldRow key={f.id} field={f} readOnly={readOnly} onChanged={load} />
        ))}
      </div>
    </div>
  )
}

function FieldRow({ field, readOnly, onChanged }: any) {
  const [editing, setEditing] = useState(false)

  const remove = async () => {
    if (!confirm(
      `Удалить поле «${field.title}»?\n\n` +
      `Вместе с ним удалятся ответы у всех контактов (заполнено: ${field.filled_count}).\n` +
      `Если нужно просто убрать поле из карточки — снимите галочку «Показывать в карточке».`
    )) return
    await api.contactFields.delete(field.id)
    onChanged()
  }

  if (editing) {
    return (
      <FieldForm
        field={field}
        onClose={() => setEditing(false)}
        onSaved={() => { setEditing(false); onChanged() }}
      />
    )
  }

  return (
    <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4">
      <div className="min-w-0">
        <div className="font-medium text-gray-900">{field.title}</div>
        <div className="mt-0.5 text-xs text-gray-500">
          {kindLabel(field.kind)}
          {Array.isArray(field.options) && field.options.length > 0 &&
            ` · ${field.options.length} вариантов`}
          {' · заполнено у '}
          <b>{field.filled_count}</b>
          {!field.show_in_card && ' · скрыто в карточке'}
        </div>
      </div>
      {!readOnly && (
        <div className="flex shrink-0 gap-2">
          <button onClick={() => setEditing(true)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
            Изменить
          </button>
          <button onClick={remove} title="Удалить"
                  className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600">
            <Trash2 size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

function FieldForm({ field, onClose, onSaved }: any) {
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

/* ───────────────────────────────── Анкеты ───────────────────────────────── */

function SurveysTab({ readOnly }: { readOnly: boolean }) {
  const [list, setList] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')

  const load = async () => {
    try { setList(await api.surveys.list()) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const create = async () => {
    if (!title.trim()) return
    await api.surveys.create({ title: title.trim() })
    setTitle(''); setCreating(false); load()
  }

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  return (
    <div>
      {!readOnly && (
        <div className="mb-4">
          {creating ? (
            <div className="flex gap-2">
              <input autoFocus className="input flex-1 min-w-0" placeholder="Название анкеты"
                     value={title} onChange={e => setTitle(e.target.value)}
                     onKeyDown={e => e.key === 'Enter' && create()} />
              <button onClick={create} className="btn-gold">Создать</button>
              <button onClick={() => setCreating(false)}
                      className="rounded-lg border border-gray-200 px-4 text-sm text-gray-600">
                Отмена
              </button>
            </div>
          ) : (
            <button onClick={() => setCreating(true)} className="btn-gold inline-flex items-center gap-2">
              <Plus size={16} /> Создать анкету
            </button>
          )}
        </div>
      )}

      {!list.length && (
        <p className="text-sm text-gray-400">
          Пока ни одной анкеты. Создайте — и сразу получите ссылку, которую можно
          отправить в рассылке или выложить в сторис.
        </p>
      )}

      <div className="space-y-3">
        {list.map(s => <SurveyRow key={s.id} survey={s} onChanged={load} readOnly={readOnly} />)}
      </div>
    </div>
  )
}

function SurveyRow({ survey, onChanged, readOnly }: any) {
  const [copied, setCopied] = useState('')

  const copy = (url: string, key: string) => {
    navigator.clipboard.writeText(url)
    setCopied(key); setTimeout(() => setCopied(''), 1500)
  }

  const remove = async () => {
    if (!confirm(
      `Удалить анкету «${survey.title}»?\n\n` +
      `Вместе с ней удалятся все ответы (заполнений: ${survey.responses_count}).\n` +
      `Если нужно просто перестать её показывать — откройте и снимите «Активна».`
    )) return
    await api.surveys.delete(survey.id)
    onChanged()
  }

  const links: Array<[string, string]> = [
    ['Ссылка', survey.links?.web],
    ['Telegram', survey.links?.telegram],
    ['ВКонтакте', survey.links?.vk],
    ['MAX', survey.links?.max],
  ].filter(([, url]) => !!url) as Array<[string, string]>

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/dashboard/surveys/${survey.id}`}
                className="font-medium text-gray-900 hover:text-[#25455D] hover:underline">
            {survey.title}
          </Link>
          <div className="mt-0.5 text-xs text-gray-500">
            {survey.questions_count} вопрос(ов) · заполнили{' '}
            <b>{survey.people_count}</b> человек
            {!survey.is_active && ' · выключена'}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link href={`/dashboard/surveys/${survey.id}?tab=report`}
                title="Отчёт"
                className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-gray-500 hover:bg-gray-50">
            <BarChart3 size={15} />
          </Link>
          {!readOnly && (
            <button onClick={remove} title="Удалить"
                    className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>

      {links.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {links.map(([label, url]) => (
            <button key={label} onClick={() => copy(url, label)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gray-50 border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100">
              {copied === label ? <Check size={13} className="text-green-600" /> : <Copy size={13} />}
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
