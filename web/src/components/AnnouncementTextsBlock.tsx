'use client'
/**
 * Тексты-анонсы события — для подвкладки «Материалы» в карточке события/конференции.
 *
 * Эта сущность отделена от event_referral_share_texts:
 *   share_texts  — «зови друзей за подарки» (аудитория = участник события)
 *   announcement_texts — «анонсируй событие подписчикам» (аудитория = аудитория
 *     спикера или партнёра). См. миграцию 112.
 *
 * Плейсхолдеры:
 *   {link}  — реф-ссылка пользователя
 *   {event} — название события
 *   {date}  — отформатированная дата старта
 *   {brand} — название бренда клиента
 */
import { useEffect, useState } from 'react'
import { Plus, Trash2, Save, Type } from 'lucide-react'
import { api } from '@/lib/api'

const PLACEHOLDERS: { code: string; label: string }[] = [
  { code: '{link}',  label: 'реф-ссылка пользователя на событие' },
  { code: '{event}', label: 'название события' },
  { code: '{date}',  label: 'дата старта (DD.MM.YYYY HH:MM МСК)' },
  { code: '{brand}', label: 'бренд клиента' },
]

type Item = { id: number; content: string; sort: number }

export default function AnnouncementTextsBlock({ eventId }: { eventId: number }) {
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Item | null>(null)

  async function load() {
    setLoading(true)
    try {
      const r = await api.referralProgram.announcementTexts.list(eventId)
      setItems(r.items || [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [eventId])

  async function handleDelete(id: number) {
    if (!confirm('Удалить текст?')) return
    try {
      await api.referralProgram.announcementTexts.delete(eventId, id)
    } catch (e: any) { alert(e.message) }
    load()
  }

  return (
    <section className="max-w-2xl">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <div>
          <h4 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
            <Type size={16} /> Тексты-анонсы события
          </h4>
          <p className="text-xs text-gray-500 mt-0.5 max-w-xl">
            Готовые тексты для спикеров и партнёров — они скопируют их и отправят своей аудитории, чтобы пригласить на событие. Реф-ссылка и название события подставляются автоматически.
          </p>
        </div>
        <button onClick={() => setCreating(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <Plus size={16} /> Добавить текст
        </button>
      </div>

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <Type className="mx-auto mb-2 text-gray-300" size={28} />
          <p className="text-gray-500 text-sm">Текстов пока нет</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y">
          {items.map(t => (
            <div key={t.id} className="p-4 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-800 whitespace-pre-wrap line-clamp-4">{t.content}</div>
                <div className="text-xs text-gray-400 mt-1">Порядок: {t.sort}</div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={() => setEditing(t)}
                        className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded">
                  Изменить
                </button>
                <button onClick={() => handleDelete(t.id)}
                        className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <AnnouncementTextForm
          eventId={eventId}
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}
    </section>
  )
}


function PlaceholdersHint({ onInsert }: { onInsert: (code: string) => void }) {
  return (
    <div className="mt-2 bg-blue-50 border border-blue-200 rounded-lg p-3">
      <div className="text-xs font-semibold text-blue-900 mb-2">
        Коды-вставки — подставятся автоматически у спикера/партнёра при копировании:
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PLACEHOLDERS.map(p => (
          <button key={p.code} type="button" onClick={() => onInsert(p.code)}
                  title={`Вставить ${p.code} — ${p.label}`}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-white border border-blue-200 rounded text-xs font-mono text-blue-800 hover:bg-blue-100">
            {p.code}
          </button>
        ))}
      </div>
      <div className="text-[11px] text-blue-700 mt-2 leading-snug">
        {PLACEHOLDERS.map(p => (
          <div key={p.code}><code className="font-mono">{p.code}</code> — {p.label}</div>
        ))}
      </div>
    </div>
  )
}


function AnnouncementTextForm({ eventId, initial, onClose, onSaved }: any) {
  const [content, setContent] = useState<string>(initial?.content ?? '')
  const [sort, setSort]       = useState<number>(initial?.sort ?? 0)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = content.trim()
    if (!trimmed) return setErr('Введите текст')
    setSaving(true); setErr(null)
    try {
      const payload = { content: trimmed, sort }
      if (initial) {
        await api.referralProgram.announcementTexts.update(eventId, initial.id, payload)
      } else {
        await api.referralProgram.announcementTexts.create(eventId, payload)
      }
      onSaved()
    } catch (e: any) { setErr(e.message); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4" style={{ color: '#25455D' }}>
          {initial ? 'Изменить текст-анонс' : 'Новый текст-анонс'}
        </h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Текст *</label>
            <textarea value={content}
                      rows={6}
                      onChange={e => setContent(e.target.value)}
                      placeholder={'Друзья, выступаю на «{event}» — {date}. Будет про…\n\nПриходите по моей ссылке: {link}'}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      autoFocus />
            <PlaceholdersHint onInsert={(code) => setContent(c => c + (c && !c.endsWith(' ') && !c.endsWith('\n') ? ' ' : '') + code)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Порядок</label>
            <input type="number" value={sort}
                   onChange={e => setSort(parseInt(e.target.value) || 0)}
                   className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
            <p className="text-xs text-gray-400 mt-1">Меньше — выше в списке.</p>
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Отмена</button>
            <button type="submit" disabled={saving}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                    style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
              <Save size={14} />
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
