'use client'
/**
 * Вкладка «Заявки» раздела «Платежи/Заявки» — кто оставил заявку через форму
 * заявки ЭТОГО события (или продукта). Решение владельца 26.09.2026: не бегать
 * в раздел «Анкеты», чтобы увидеть заявки своего события.
 *
 * ⚠️ Заявка — это ответ на анкету, ОТДЕЛЬНОЙ сущности нет. «Обработано» и
 * заметка — те же поля сотрудника анкеты и пишутся ТОЙ ЖЕ ручкой
 * (`api.surveys.saveStaffAnswers`), что таблица и карточка в «Анкетах»: отметил
 * здесь — видно там, и наоборот.
 *
 * ⚠️ Список строится по ИСТОЧНИКУ в ответе (миграция 519), а не по анкете
 * формы: одна анкета стоит на нескольких событиях. Заявки, оставленные до
 * миграции, источника не имеют и здесь не появятся — они в «Анкетах».
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

type Row = {
  id: number
  survey_id: number
  survey_title: string
  created_at: string
  contact_id: number
  name: string | null
  phone: string | null
  email: string | null
  telegram: string | null
  vk: string | null
  max_nick: string | null
  answers: { title: string; value: string }[]
  processed: boolean
  note: string
  processed_qid: number | null
  note_qid: number | null
}

function fmtDate(s: string) {
  try {
    return new Date(s).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Moscow',
    })
  } catch { return s }
}

export default function RequestResponsesTab({ ownerType, ownerId, onCount }: {
  ownerType: 'events' | 'products'
  ownerId: number
  /** Сколько необработанных — для цифры на вкладке. */
  onCount?: (n: number) => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const [filter, setFilter] = useState<'all' | 'new'>('all')

  async function load() {
    setLoading(true); setError('')
    try {
      const r: any = await api.requestForms.responses(ownerType, ownerId)
      setRows(r?.responses || [])
      onCount?.(r?.unprocessed || 0)
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить заявки')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [ownerType, ownerId])

  function patch(id: number, p: Partial<Row>) {
    setRows(prev => {
      const next = prev.map(r => (r.id === id ? { ...r, ...p } : r))
      onCount?.(next.filter(r => r.processed_qid && !r.processed).length)
      return next
    })
  }

  async function toggleProcessed(r: Row) {
    if (!r.processed_qid) return
    const v = !r.processed
    patch(r.id, { processed: v })
    try {
      await api.surveys.saveStaffAnswers(r.survey_id, r.id, { [r.processed_qid]: v })
    } catch (e: any) {
      patch(r.id, { processed: !v })
      alert(e?.message || 'Не удалось сохранить')
    }
  }

  async function saveNote(r: Row, text: string) {
    if (!r.note_qid || text === r.note) return
    const prev = r.note
    patch(r.id, { note: text })
    try {
      await api.surveys.saveStaffAnswers(r.survey_id, r.id, { [r.note_qid]: text })
    } catch (e: any) {
      patch(r.id, { note: prev })
      alert(e?.message || 'Не удалось сохранить заметку')
    }
  }

  if (loading) return <div className="p-6 text-sm text-gray-400">Загружаем…</div>
  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>

  const shown = filter === 'new' ? rows.filter(r => r.processed_qid && !r.processed) : rows
  const newCount = rows.filter(r => r.processed_qid && !r.processed).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {([['all', `Все (${rows.length})`], ['new', `Не обработаны (${newCount})`]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)}
                  className={`rounded-full px-3 py-1.5 text-sm ${
                    filter === k ? 'bg-[#FFCFA4] text-[#25455D] font-medium' : 'bg-gray-100 text-gray-600'}`}>
            {label}
          </button>
        ))}
      </div>

      {!shown.length && (
        <div className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-sm text-gray-500">
          {rows.length ? 'Все заявки обработаны.' : 'Заявок с формы этого события пока нет.'}
        </div>
      )}

      <div className="space-y-2">
        {shown.map(r => {
          const isOpen = open === r.id
          const contacts = [
            r.phone, r.email,
            r.telegram && `Telegram: ${r.telegram}`,
            r.vk && `ВК: ${r.vk}`,
            r.max_nick && `MAX: ${r.max_nick}`,
          ].filter(Boolean) as string[]
          return (
            <div key={r.id}
                 className={`rounded-xl border ${r.processed ? 'border-gray-200 bg-gray-50' : 'border-[#FFCFA4] bg-white'}`}>
              <button onClick={() => setOpen(isOpen ? null : r.id)}
                      className="flex w-full items-start gap-3 p-3 text-left">
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${r.processed ? 'bg-gray-300' : 'bg-[#FFCFA4]'}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium text-gray-800">{r.name || 'Без имени'}</span>
                    <span className="text-xs text-gray-400">{fmtDate(r.created_at)}</span>
                  </span>
                  {contacts.length > 0 && (
                    <span className="block truncate text-xs text-gray-500">{contacts.join(' · ')}</span>
                  )}
                </span>
                <span className="text-xs text-gray-400">{isOpen ? '▲' : '▼'}</span>
              </button>

              {isOpen && (
                <div className="space-y-3 border-t border-gray-100 p-3">
                  {r.answers.length ? (
                    <dl className="space-y-2">
                      {r.answers.map((a, i) => (
                        <div key={i}>
                          <dt className="text-xs text-gray-500">{a.title}</dt>
                          <dd className="whitespace-pre-wrap text-sm text-gray-800">{a.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="text-sm text-gray-400">Ответов нет.</p>
                  )}

                  {r.processed_qid && (
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
                      <input type="checkbox" checked={r.processed}
                             onChange={() => toggleProcessed(r)} />
                      Обработано
                    </label>
                  )}
                  {r.note_qid && (
                    <label className="block">
                      <span className="mb-1 block text-xs text-gray-500">Заметка</span>
                      <textarea defaultValue={r.note} rows={2}
                                onBlur={e => saveNote(r, e.target.value)}
                                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-[#25455D] focus:outline-none" />
                    </label>
                  )}

                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <a href={`/dashboard/surveys/${r.survey_id}/responses/${r.id}`}
                       className="text-[#25455D] underline">
                      Открыть в анкетах
                    </a>
                    <a href={`/dashboard/clients?contact=${r.contact_id}`}
                       className="text-[#25455D] underline">
                      Карточка контакта
                    </a>
                    <span className="text-gray-400">Анкета: {r.survey_title}</span>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
