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
import FeatureLock from '@/components/FeatureLock'
import {
  Plus, Trash2, Copy, Check, BarChart3, Settings2, ClipboardList, X, ExternalLink,
} from 'lucide-react'
// ⚠️ Форма поля — ОБЩАЯ с разделом «Контакты»: поле заводится из двух мест,
// а форма должна быть одна (иначе разъедется список типов и вариантов).
import FieldForm, { KINDS, NEEDS_OPTIONS, kindLabel } from '@/components/ContactFieldForm'

export default function SurveysPage() {
  const { me, isAssistant } = useMe()
  const [tab, setTab] = useState<'surveys' | 'fields'>('surveys')

  // ⚠️ Гейт по фиче, не по тарифу (состав тарифов меняется данными).
  // Замок нужен на САМОЙ странице: пункт меню не мешает открыть раздел
  // по прямой ссылке (правило проекта, найдено на кабинете Виктории).
  const hasFeature = (me?.features || []).includes('surveys')
  if (me && !hasFeature) {
    return (
      <div className="max-w-3xl">
        <h1 className="mb-1 text-2xl font-bold text-gray-900">Анкеты</h1>
        <p className="mb-6 text-sm text-gray-500">
          Соберите анкету, отправьте ссылку — и смотрите, кто и как ответил.
          Ответы попадают в карточку человека и фильтруют базу.
        </p>
        <FeatureLock anyOf={['surveys']} />
      </div>
    )
  }

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

      {/* ⚠️ Имя, почта и телефон в анкете УЖЕ ЕСТЬ — их не надо заводить полями.
          Клиенты создавали поле «Имя» руками и получали в анкете два вопроса
          про одно и то же. */}
      <div className="mb-5 rounded-xl border p-4 text-sm"
           style={{ borderColor: '#F0D9C0', background: '#FFF8F1', color: '#8A5A2B' }}>
        <b>Имя, почта и телефон добавляются в анкету сами.</b> Отдельными полями
        их создавать не нужно. Больше того — если человек уже есть в базе, они
        подставятся заполненными, и переписывать их ему не придётся.
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
          {/* Копирование И открытие: клиенту нужно и дать ссылку людям, и
              самому глянуть, как анкета выглядит. Раньше была только копия —
              чтобы просто посмотреть, приходилось вставлять её в адресную
              строку вручную. */}
          {links.map(([label, url]) => (
            <span key={label}
                  className="inline-flex items-stretch rounded-lg bg-gray-50 border border-gray-200 overflow-hidden">
              <button onClick={() => copy(url, label)}
                      title="Скопировать ссылку"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100">
                {copied === label ? <Check size={13} className="text-green-600" /> : <Copy size={13} />}
                {label}
              </button>
              <a href={url} target="_blank" rel="noopener noreferrer"
                 title="Открыть анкету"
                 className="inline-flex items-center border-l border-gray-200 px-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800">
                <ExternalLink size={13} />
              </a>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
