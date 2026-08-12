'use client'

/**
 * Карточка анкеты: настройки, вопросы, отчёт (миграция 280).
 *
 * ⚠️ Вопрос можно привязать к полю контакта — тогда ответ ложится в карточку
 * человека и по нему фильтруется база. Тип и варианты в этом случае берутся у
 * поля, чтобы накопленные значения не разъехались.
 */
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import { ArrowLeft, Plus, Trash2, X, Copy, Check } from 'lucide-react'

const KINDS = [
  { value: 'text', label: 'Короткий текст' },
  { value: 'textarea', label: 'Длинный текст' },
  { value: 'number', label: 'Число' },
  { value: 'date', label: 'Дата' },
  { value: 'scale', label: 'Шкала 1–10' },
  { value: 'select', label: 'Выбор одного варианта' },
  { value: 'multiselect', label: 'Выбор нескольких' },
  { value: 'bool', label: 'Да / Нет' },
]
const NEEDS_OPTIONS = new Set(['select', 'multiselect'])
const kindLabel = (k: string) => KINDS.find(x => x.value === k)?.label || k

export default function SurveyPage() {
  const { id } = useParams<{ id: string }>()
  const search = useSearchParams()
  const { isAssistant } = useMe()
  const [tab, setTab] = useState<'edit' | 'report'>(
    search.get('tab') === 'report' ? 'report' : 'edit')
  const [survey, setSurvey] = useState<any>(null)
  const [fields, setFields] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const [s, f] = await Promise.all([
      api.surveys.get(Number(id)),
      api.contactFields.list().catch(() => []),
    ])
    setSurvey(s); setFields(f); setLoading(false)
  }
  useEffect(() => { load() }, [id])

  if (loading) return <p className="p-6 text-sm text-gray-400">Загружаем…</p>
  if (!survey) return <p className="p-6 text-sm text-red-600">Анкета не найдена</p>

  return (
    <div className="max-w-4xl">
      <Link href="/dashboard/surveys"
            className="mb-4 flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft size={14} /> Все анкеты
      </Link>

      <h1 className="mb-1 text-2xl font-bold text-gray-900">{survey.title}</h1>
      <p className="mb-6 text-sm text-gray-500">
        Заполнили {survey.questions?.length ? '' : ''}
        <b>{survey.people_count ?? ''}</b>
      </p>

      <div className="mb-6 flex gap-2 border-b border-gray-200">
        {([['edit', 'Вопросы и настройки'], ['report', 'Отчёт']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
                  className={`-mb-px border-b-2 px-4 py-2 text-sm ${
                    tab === key
                      ? 'border-[#25455D] font-semibold text-[#25455D]'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'edit'
        ? <EditTab survey={survey} fields={fields} onChanged={load} readOnly={isAssistant} />
        : <ReportTab surveyId={Number(id)} />}
    </div>
  )
}

/* ─────────────────────────── Вопросы и настройки ────────────────────────── */

function EditTab({ survey, fields, onChanged, readOnly }: any) {
  const [adding, setAdding] = useState(false)
  const [copied, setCopied] = useState('')

  const copy = (url: string, key: string) => {
    navigator.clipboard.writeText(url)
    setCopied(key); setTimeout(() => setCopied(''), 1500)
  }

  const links: Array<[string, string]> = [
    ['Ссылка', survey.links?.web],
    ['Telegram', survey.links?.telegram],
    ['ВКонтакте', survey.links?.vk],
    ['MAX', survey.links?.max],
  ].filter(([, u]) => !!u) as Array<[string, string]>

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="mb-2 font-semibold text-gray-800">Ссылки на анкету</h3>
        <p className="mb-3 text-sm text-gray-500">
          Отправьте любую — кнопкой в рассылке, сообщением в боте или ссылкой в сторис.
          Тем, кто перешёл из бота, имя и контакты подставятся сами.
        </p>
        <div className="flex flex-wrap gap-2">
          {links.map(([label, url]) => (
            <button key={label} onClick={() => copy(url, label)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100">
              {copied === label ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
              {label}
            </button>
          ))}
        </div>
      </div>

      <SettingsBlock survey={survey} onChanged={onChanged} readOnly={readOnly} />

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-gray-800">Вопросы</h3>
          {!readOnly && !adding && (
            <button onClick={() => setAdding(true)} className="btn-gold inline-flex items-center gap-2">
              <Plus size={16} /> Добавить вопрос
            </button>
          )}
        </div>

        {adding && (
          <QuestionForm surveyId={survey.id} fields={fields}
                        onClose={() => setAdding(false)}
                        onSaved={() => { setAdding(false); onChanged() }} />
        )}

        {!survey.questions?.length && !adding && (
          <p className="text-sm text-gray-400">
            Вопросов пока нет. Имя, почту и телефон добавлять не нужно — они
            подставятся сами у тех, кто уже есть в базе.
          </p>
        )}

        <div className="space-y-2">
          {(survey.questions || []).map((q: any) => (
            <QuestionRow key={q.id} surveyId={survey.id} question={q} fields={fields}
                         onChanged={onChanged} readOnly={readOnly} />
          ))}
        </div>
      </div>
    </div>
  )
}

function SettingsBlock({ survey, onChanged, readOnly }: any) {
  const [intro, setIntro] = useState(survey.intro || '')
  const [afterMode, setAfterMode] = useState(survey.after_mode || 'thanks')
  const [thanks, setThanks] = useState(survey.thanks_text || '')
  const [redirect, setRedirect] = useState(survey.redirect_url || '')
  const [allowRepeat, setAllowRepeat] = useState(!!survey.allow_repeat)
  const [isActive, setIsActive] = useState(survey.is_active !== false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await api.surveys.update(survey.id, {
        intro, after_mode: afterMode, thanks_text: thanks,
        redirect_url: redirect, allow_repeat: allowRepeat, is_active: isActive,
      })
      setSaved(true); setTimeout(() => setSaved(false), 1500)
      onChanged()
    } finally { setSaving(false) }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="mb-3 font-semibold text-gray-800">Настройки</h3>

      <label className="mb-3 block">
        <span className="mb-1 block text-sm text-gray-600">Текст перед вопросами</span>
        <textarea className="input min-h-[70px]" value={intro} disabled={readOnly}
                  onChange={e => setIntro(e.target.value)} />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-sm text-gray-600">Что показать после отправки</span>
        <select className="input bg-white" value={afterMode} disabled={readOnly}
                onChange={e => setAfterMode(e.target.value)}>
          <option value="thanks">Текст «спасибо»</option>
          <option value="url">Перевести на свою ссылку</option>
        </select>
      </label>

      {afterMode === 'thanks' ? (
        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-gray-600">Текст «спасибо»</span>
          <textarea className="input min-h-[60px]" value={thanks} disabled={readOnly}
                    onChange={e => setThanks(e.target.value)}
                    placeholder="Спасибо! Мы получили ваши ответы." />
        </label>
      ) : (
        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-gray-600">Куда перевести</span>
          <input className="input" value={redirect} disabled={readOnly}
                 onChange={e => setRedirect(e.target.value)}
                 placeholder="https://…" />
        </label>
      )}

      <p className="mb-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-500">
        Если анкета стоит перед подарком (включается в самом лид-магните),
        подарок выдаётся сразу после отправки — и ссылкой на странице, и
        сообщением в бот. Настраивать это здесь не нужно.
      </p>

      <label className="mb-2 flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={allowRepeat} disabled={readOnly}
               onChange={e => setAllowRepeat(e.target.checked)}
               className="h-4 w-4 rounded border-gray-300" />
        <span className="text-sm text-gray-700">Можно заполнять несколько раз</span>
      </label>
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={isActive} disabled={readOnly}
               onChange={e => setIsActive(e.target.checked)}
               className="h-4 w-4 rounded border-gray-300" />
        <span className="text-sm text-gray-700">Анкета активна</span>
      </label>

      {!readOnly && (
        <div className="mt-4 flex items-center gap-3">
          <button onClick={save} disabled={saving} className="btn-gold disabled:opacity-50">
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          {saved && <span className="text-sm text-green-600">Сохранено</span>}
        </div>
      )}
    </div>
  )
}

function QuestionRow({ surveyId, question, fields, onChanged, readOnly }: any) {
  const [editing, setEditing] = useState(false)

  const remove = async () => {
    if (!confirm(`Удалить вопрос «${question.title}»? Ответы на него тоже удалятся.`)) return
    await api.surveys.deleteQuestion(surveyId, question.id)
    onChanged()
  }

  if (editing) {
    return (
      <QuestionForm surveyId={surveyId} question={question} fields={fields}
                    onClose={() => setEditing(false)}
                    onSaved={() => { setEditing(false); onChanged() }} />
    )
  }

  return (
    <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4">
      <div className="min-w-0">
        <div className="font-medium text-gray-900">
          {question.title}
          {question.is_required && <span className="ml-1 text-red-500">*</span>}
        </div>
        <div className="mt-0.5 text-xs text-gray-500">
          {kindLabel(question.kind)}
          {question.field_title && ` · пишется в поле «${question.field_title}»`}
        </div>
      </div>
      {!readOnly && (
        <div className="flex shrink-0 gap-2">
          <button onClick={() => setEditing(true)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
            Изменить
          </button>
          <button onClick={remove}
                  className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600">
            <Trash2 size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

function QuestionForm({ surveyId, question, fields, onClose, onSaved }: any) {
  const [title, setTitle] = useState(question?.title || '')
  const [kind, setKind] = useState(question?.kind || 'text')
  const [fieldId, setFieldId] = useState<number | ''>(question?.field_id || '')
  const [options, setOptions] = useState<string[]>(
    Array.isArray(question?.options) ? question.options : [])
  const [required, setRequired] = useState(!!question?.is_required)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  // Привязали к полю контакта → тип и варианты берём у поля: иначе ответы
  // разъедутся с уже накопленными значениями этого поля.
  const linked = fields.find((f: any) => f.id === Number(fieldId))
  const effKind = linked ? linked.kind : kind
  const effOptions = linked
    ? (Array.isArray(linked.options) ? linked.options : [])
    : options

  const save = async () => {
    if (!title.trim()) { setErr('Впишите текст вопроса'); return }
    if (!linked && NEEDS_OPTIONS.has(kind) && options.filter(o => o.trim()).length < 2) {
      setErr('Добавьте хотя бы два варианта ответа'); return
    }
    setSaving(true); setErr('')
    try {
      const payload: any = {
        title: title.trim(), is_required: required,
        field_id: fieldId ? Number(fieldId) : null,
      }
      if (!linked) {
        payload.kind = kind
        payload.options = NEEDS_OPTIONS.has(kind) ? options.filter(o => o.trim()) : []
        if (kind === 'scale') { payload.scale_min = 1; payload.scale_max = 10 }
      }
      if (question) await api.surveys.updateQuestion(surveyId, question.id, payload)
      else await api.surveys.addQuestion(surveyId, payload)
      onSaved()
    } catch (e: any) {
      setErr(e.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  return (
    <div className="mb-3 rounded-xl border border-[#25455D]/30 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="font-semibold text-gray-800">
          {question ? 'Изменить вопрос' : 'Новый вопрос'}
        </h4>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
      </div>

      <label className="mb-3 block">
        <span className="mb-1 block text-sm text-gray-600">Текст вопроса</span>
        <input className="input" value={title} onChange={e => setTitle(e.target.value)} />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-sm text-gray-600">Записать ответ в поле контакта</span>
        <select className="input bg-white" value={fieldId}
                onChange={e => setFieldId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Не записывать — ответ только в этой анкете</option>
          {fields.map((f: any) => (
            <option key={f.id} value={f.id}>{f.title}</option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-gray-500">
          {linked
            ? `Ответ попадёт в карточку человека. Тип берётся у поля: ${kindLabel(linked.kind)}.`
            : 'Выберите поле, чтобы ответ сохранялся в карточке и фильтровал базу.'}
        </span>
      </label>

      {!linked && (
        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-gray-600">Что вписывают</span>
          <select className="input bg-white" value={kind} onChange={e => setKind(e.target.value)}>
            {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </label>
      )}

      {NEEDS_OPTIONS.has(effKind) && (
        <div className="mb-3">
          <span className="mb-1 block text-sm text-gray-600">Варианты ответа</span>
          {linked ? (
            <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
              {effOptions.join(' · ') || 'У поля пока нет вариантов'}
              <div className="mt-1 text-xs text-gray-500">
                Варианты берутся у поля «{linked.title}» — меняются в разделе «Поля контакта».
              </div>
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>
      )}

      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)}
               className="h-4 w-4 rounded border-gray-300" />
        <span className="text-sm text-gray-700">Обязательный вопрос</span>
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

/* ───────────────────────────────── Отчёт ────────────────────────────────── */

function ReportTab({ surveyId }: { surveyId: number }) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.surveys.analytics(surveyId)
      .then(setData)
      .finally(() => setLoading(false))
  }, [surveyId])

  if (loading) return <p className="text-sm text-gray-400">Считаем…</p>
  if (!data) return null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-2xl font-bold text-gray-900">{data.people_total}</div>
          <div className="text-sm text-gray-500">человек заполнили</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-2xl font-bold text-gray-900">{data.responses_total}</div>
          <div className="text-sm text-gray-500">всего заполнений</div>
        </div>
      </div>

      {!data.questions?.length && (
        <p className="text-sm text-gray-400">В анкете пока нет вопросов.</p>
      )}

      {data.questions.map((q: any) => (
        <div key={q.id} className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-1 font-medium text-gray-900">{q.title}</div>
          <div className="mb-3 text-xs text-gray-500">
            Ответили: {q.answers_count}
            {q.avg != null && ` · средняя оценка ${q.avg}`}
          </div>

          {q.breakdown?.length > 0 && (
            <div className="space-y-2">
              {q.breakdown.map((b: any, i: number) => (
                <div key={i}>
                  <div className="mb-0.5 flex justify-between text-sm">
                    <span className="text-gray-700">{b.option}</span>
                    <span className="text-gray-500">
                      <b className="text-gray-900">{b.count}</b> · {b.percent}%
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                    <div className="h-full rounded-full bg-[#FFCFA4]"
                         style={{ width: `${b.percent}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {q.texts?.length > 0 && (
            <div className="space-y-2">
              {q.texts.slice(0, 30).map((t: any, i: number) => (
                <div key={i} className="rounded-lg bg-gray-50 p-2 text-sm">
                  <span className="text-gray-800">{t.value}</span>
                  <span className="ml-2 text-xs text-gray-400">— {t.name || 'Без имени'}</span>
                </div>
              ))}
              {q.texts.length > 30 && (
                <p className="text-xs text-gray-400">…и ещё {q.texts.length - 30}</p>
              )}
            </div>
          )}

          {!q.breakdown?.length && !q.texts?.length && (
            <p className="text-sm text-gray-400">Пока никто не ответил.</p>
          )}
        </div>
      ))}
    </div>
  )
}
