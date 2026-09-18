'use client'

/**
 * Частые вопросы техспецов — ОДИН экран на два места (миграция 460).
 *
 * ⚠️⚠️ ВТОРОЙ КОПИИ БЫТЬ НЕ ДОЛЖНО. Раздел открыт и в админке, и в кабинете
 * внедренца. Скопировать файл значило бы чинить и дорабатывать его потом
 * дважды — и однажды забыть про вторую копию. Отличие между местами ровно
 * одно: какой набор методов передали в пропе `api` (`api.techFaq` или
 * `api.adminFaq`) — пути у них разные, поведение одинаковое.
 *
 * ⚠️⚠️ БАЗА ОБЩАЯ: что завёл один, видят и правят все. Автор показывается
 * как ПОДПИСЬ «кто завёл и когда», а не как владелец — кнопки «изменить» и
 * «удалить» есть у каждого вопроса независимо от автора. Так решил владелец:
 * смысл раздела в едином ответе на частый вопрос, а не в личных подборках.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Pencil, Plus, Search, Trash2 } from 'lucide-react'

type Faq = {
  id: number
  question: string
  answer: string
  author_name: string | null
  author_current_name: string | null
  updated_by_name: string | null
  created_at: string
  updated_at: string
}

type Api = {
  list: (q?: string) => Promise<any>
  create: (data: { question: string; answer: string }) => Promise<any>
  update: (id: number, data: { question?: string; answer?: string }) => Promise<any>
  remove: (id: number) => Promise<any>
}

/** «18.09.2026, 14:30» — дата создания в подписи автора. */
function fmt(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Кнопка «скопировать ответ» — ради неё раздел и заводился: взять готовый
 * текст и сразу отправить клиенту, не переписывая руками.
 *
 * ⚠️ `navigator.clipboard` может не быть вовсе (старый браузер, страница не
 * по https) — тогда молча ничего не произойдёт и человек решит, что сломано.
 * Поэтому есть запасной путь через скрытое поле и `execCommand`.
 */
function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch { ok = false }
    }
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } else {
      alert('Браузер не дал скопировать. Выделите текст ответа и скопируйте вручную.')
    }
  }

  return (
    <button type="button" onClick={copy} title="Скопировать ответ"
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition ${
              copied ? 'border-green-300 bg-green-50 text-green-700'
                     : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? 'Скопировано' : 'Копировать'}
    </button>
  )
}

/** Форма вопроса — и для нового, и для правки существующего. */
function FaqForm({ init, onSave, onCancel, saving }: {
  init?: { question: string; answer: string }
  onSave: (d: { question: string; answer: string }) => void
  onCancel: () => void
  saving: boolean
}) {
  const [question, setQuestion] = useState(init?.question || '')
  const [answer, setAnswer] = useState(init?.answer || '')

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
      <label className="mb-1 block text-xs font-medium text-gray-600">Вопрос</label>
      <input value={question} onChange={e => setQuestion(e.target.value)}
             placeholder="Например: Почему виден только один чат события?"
             className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      <label className="mb-1 block text-xs font-medium text-gray-600">
        Ответ — его и будут копировать, чтобы отправить клиенту
      </label>
      <textarea value={answer} onChange={e => setAnswer(e.target.value)} rows={7}
                placeholder="Готовый текст ответа. Пишите так, чтобы его можно было отправить клиенту как есть."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={saving || !question.trim() || !answer.trim()}
                onClick={() => onSave({ question: question.trim(), answer: answer.trim() })}
                className="btn-gold rounded-lg px-4 py-2 text-sm disabled:opacity-50">
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button type="button" onClick={onCancel}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">
          Отмена
        </button>
      </div>
    </div>
  )
}

export default function TechFaqScreen({ api }: { api: Api }) {
  const [items, setItems] = useState<Faq[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  // ⚠️ Держим последний запрос: ответы могут прийти не в том порядке, в каком
  // ушли, и более ранний перетёр бы список от более позднего.
  const reqId = useRef(0)

  function load(query = q) {
    const my = ++reqId.current
    setLoading(true)
    api.list(query || undefined)
      .then((r: any) => { if (my === reqId.current) setItems(r.items || []) })
      .catch(() => { if (my === reqId.current) setItems([]) })
      .finally(() => { if (my === reqId.current) setLoading(false) })
  }

  // ⚠️ Поиск с задержкой — иначе запрос уходит на каждую букву.
  useEffect(() => {
    const t = setTimeout(() => load(q), q ? 350 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  async function create(d: { question: string; answer: string }) {
    setSaving(true)
    try {
      await api.create(d)
      setCreating(false)
      load()
    } catch (e: any) { alert(e?.message || 'Не удалось сохранить') }
    finally { setSaving(false) }
  }

  async function update(id: number, d: { question: string; answer: string }) {
    setSaving(true)
    try {
      await api.update(id, d)
      setEditId(null)
      load()
    } catch (e: any) { alert(e?.message || 'Не удалось сохранить') }
    finally { setSaving(false) }
  }

  async function remove(f: Faq) {
    // ⚠️ Спрашиваем подтверждение: база общая, удаление заденет всех.
    if (!confirm(`Удалить вопрос «${f.question}»?\n\nОн пропадёт у всех — база общая.`)) return
    try {
      await api.remove(f.id)
      load()
    } catch (e: any) { alert(e?.message || 'Не удалось удалить') }
  }

  return (
    <div className="rounded-xl bg-white shadow-sm">
      <div className="border-b border-gray-100 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={q} onChange={e => setQ(e.target.value)}
                   placeholder="Поиск по вопросам и ответам"
                   className="w-full rounded-lg border border-gray-300 py-1.5 pl-9 pr-3 text-sm" />
          </div>
          <button type="button" onClick={() => { setCreating(true); setEditId(null) }}
                  className="btn-gold inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm">
            <Plus size={16} /> Добавить вопрос
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          База общая для всех техспецов: что добавил один — видят все. Ответ можно
          скопировать и сразу отправить клиенту.
        </p>
      </div>

      <div className="space-y-4 p-4">
        {creating && (
          <FaqForm onSave={create} onCancel={() => setCreating(false)} saving={saving} />
        )}

        {loading && !items.length ? (
          <div className="py-8 text-center text-sm text-gray-400">Загружаем…</div>
        ) : !items.length ? (
          <div className="py-8 text-center text-sm text-gray-500">
            {q ? 'Ничего не нашли — попробуйте другие слова.'
               : 'Вопросов пока нет. Добавьте первый — им смогут пользоваться все.'}
          </div>
        ) : items.map(f => (
          <div key={f.id} className="rounded-xl border border-gray-200 p-4">
            {editId === f.id ? (
              <FaqForm init={{ question: f.question, answer: f.answer }}
                       onSave={d => update(f.id, d)}
                       onCancel={() => setEditId(null)} saving={saving} />
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="font-medium text-gray-900">{f.question}</div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <CopyAnswer text={f.answer} />
                    <button type="button" onClick={() => { setEditId(f.id); setCreating(false) }}
                            title="Изменить"
                            className="rounded-lg border border-gray-300 p-1.5 text-gray-600 hover:bg-gray-50">
                      <Pencil size={14} />
                    </button>
                    <button type="button" onClick={() => remove(f)} title="Удалить"
                            className="rounded-lg border border-gray-300 p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {/* ⚠️ whitespace-pre-wrap: в ответе есть абзацы, и без него
                    текст слипся бы в одну простыню — а его отправляют клиенту
                    как есть. */}
                <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                  {f.answer}
                </div>
                <div className="mt-3 text-xs text-gray-400">
                  Добавил: {f.author_current_name || f.author_name || 'неизвестно'} · {fmt(f.created_at)}
                  {f.updated_by_name && f.updated_at !== f.created_at && (
                    <> · изменил: {f.updated_by_name}, {fmt(f.updated_at)}</>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
