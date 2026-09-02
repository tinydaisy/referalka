'use client'

/**
 * Ответ одного человека на анкету — отдельная СТРАНИЦА (решение владельца).
 *
 * ⚠️ Не модалка: из ответа чаще всего идут дальше — в карточку контакта, — а
 * всплывающее окно такой переход обрывает. Наверху две ссылки: «Назад к
 * ответам» и «Открыть карточку с перепиской».
 *
 * ⚠️ Показываем ВСЕ вопросы анкеты, включая те, на которые не ответили:
 * пропущенный вопрос — тоже информация (например, необязательный, который
 * все игнорируют).
 *
 * ⚠️ Поля сотрудника правятся и ЗДЕСЬ, и в таблице заявок — через один и тот
 * же эндпоинт, иначе поведение в двух местах разъедется.
 */
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import { ArrowLeft, MessagesSquare, Check, Loader2, Lock } from 'lucide-react'

const DARK = '#25455D'

export default function SurveyResponsePage() {
  const { id, responseId } = useParams<{ id: string; responseId: string }>()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.surveys.response(Number(id), Number(responseId))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [id, responseId])

  if (loading) return <p className="p-6 text-sm text-gray-400">Загружаем…</p>
  if (!data) return <p className="p-6 text-sm text-red-600">Ответ не найден</p>

  const contacts: Array<[string, string]> = [
    ['Почта', data.email],
    ['Телефон', data.phone],
    ['Telegram', data.telegram],
    ['ВКонтакте', data.vk],
    ['MAX', data.max_nick],
  ].filter(([, v]) => !!v) as Array<[string, string]>

  const all = data.answers || []
  const staff = all.filter((a: any) => a.filled_by === 'staff')
  const visitor = all.filter((a: any) => a.filled_by !== 'staff')

  return (
    /* ⚠️ Ширину не сужаем: её держит общая обёртка кабинета (max-w-6xl) —
       по неё же идёт плашка тарифа сверху. Было `max-w-3xl` (768px), и
       страница обрывалась заметно левее остальных разделов. */
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-4 text-sm">
        <Link href={`/dashboard/surveys/${id}?tab=answers`}
              className="flex items-center gap-2 text-gray-500 hover:text-gray-700">
          <ArrowLeft size={14} /> Назад к ответам
        </Link>
        {/* В карточке контакта рядом со сведениями открыта переписка —
            отсюда можно сразу ответить человеку. */}
        <Link href={`/dashboard/clients?contact=${data.contact_id}`}
              className="flex items-center gap-2 hover:underline" style={{ color: DARK }}>
          <MessagesSquare size={15} /> Открыть карточку и написать
        </Link>
      </div>

      <h1 className="mb-1 text-2xl font-bold text-gray-900">
        {data.name || 'Без имени'}
      </h1>
      <p className="mb-6 text-sm text-gray-500">
        {data.survey?.title}
        {' · '}
        {new Date(data.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК
      </p>

      {/* Обработка — САМЫМ ВЕРХОМ: за этим сюда и заходят. */}
      {staff.length > 0 && (
        <div className="mb-6 rounded-xl border-2 p-4"
             style={{ borderColor: `${DARK}33`, background: `${DARK}0A` }}>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-800">
            <Lock size={14} className="text-gray-500" /> Обработка ответа
          </h2>
          <p className="mb-3 text-xs text-gray-500">
            Это видите только вы и ваши помощники — посетителю не показывается.
          </p>
          <div className="space-y-3">
            {staff.map((a: any) => (
              <StaffField key={a.id} surveyId={Number(id)} responseId={Number(responseId)}
                          question={a} />
            ))}
          </div>
        </div>
      )}

      {contacts.length > 0 && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-800">Контакты</h2>
          <div className="space-y-1.5">
            {contacts.map(([label, val]) => (
              <div key={label} className="flex justify-between gap-3 text-sm">
                <span className="text-gray-500">{label}</span>
                <span className="text-gray-900">{val}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-800">Ответы на анкету</h2>
        <div className="space-y-4">
          {visitor.map((a: any) => (
            <div key={a.id}>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                {a.title}
                {/* ⚠️ Значение взято из доп. поля контакта, а не из этого
                    заполнения: вопрос добавили в анкету позже, чем человек
                    её заполнил. Помечаем — иначе непонятно, откуда цифра. */}
                {a.from_field && (
                  <span className="rounded bg-[#FFCFA4] px-1.5 py-0.5 text-[10px] font-medium text-[#25455D]">
                    доп. поле
                  </span>
                )}
              </div>
              <div className="text-sm text-gray-900">
                {a.value || <span className="text-gray-400">не ответил</span>}
              </div>
            </div>
          ))}
          {!visitor.length && (
            <p className="text-sm text-gray-400">В анкете нет вопросов.</p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Поле сотрудника в карточке ответа.
 *
 * Галочка сохраняется сразу по клику, текст — когда уходишь из поля: слать
 * запрос на каждую букву не нужно.
 */
function StaffField({ surveyId, responseId, question }: any) {
  const [val, setVal] = useState(question.value || '')
  const [saving, setSaving] = useState(false)
  const [ok, setOk] = useState(false)
  const initial = useRef(question.value || '')

  const save = async (raw: any) => {
    setSaving(true)
    try {
      await api.surveys.saveStaffAnswers(surveyId, responseId, { [question.id]: raw })
      initial.current = typeof raw === 'boolean' ? (raw ? 'Да' : '') : String(raw || '').trim()
      setOk(true); setTimeout(() => setOk(false), 1500)
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
      setVal(initial.current)
    } finally { setSaving(false) }
  }

  const done = ok && !saving

  if (question.kind === 'bool') {
    return (
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={val === 'Да'} disabled={saving}
               onChange={e => { setVal(e.target.checked ? 'Да' : ''); save(e.target.checked) }}
               className="h-4 w-4 rounded border-gray-300" />
        <span className="text-sm font-medium text-gray-800">{question.title}</span>
        {saving && <Loader2 size={13} className="animate-spin text-gray-400" />}
        {done && <Check size={13} className="text-green-600" />}
      </label>
    )
  }

  const common = {
    value: val,
    disabled: saving,
    onChange: (e: any) => setVal(e.target.value),
    onBlur: () => { if (val !== initial.current) save(val) },
    className: 'input',
  }

  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2 text-sm font-medium text-gray-800">
        {question.title}
        {saving && <Loader2 size={13} className="animate-spin text-gray-400" />}
        {done && <Check size={13} className="text-green-600" />}
      </span>
      {question.kind === 'textarea' ? (
        <textarea {...common} rows={4} placeholder="Заметка" />
      ) : question.kind === 'select' && Array.isArray(question.options) ? (
        <select value={val} disabled={saving} className="input bg-white"
                onChange={e => { setVal(e.target.value); save(e.target.value) }}>
          <option value="">—</option>
          {question.options.map((o: string) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input {...common} />
      )}
    </label>
  )
}
