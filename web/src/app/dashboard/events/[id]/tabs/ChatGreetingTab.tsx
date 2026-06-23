'use client'

/**
 * Подвкладка «Приветствие → В чатах».
 *
 * Что внутри:
 * - Переключатель «Отвечать на кодовое слово в чатах»
 * - Поле «Кодовое слово» (хранится в events.chat_greeting_keyword)
 * - Список случайных фраз приветствия (event_chat_greetings) — бот берёт одну
 *   рандомно и отвечает ОТВЕТОМ (reply) человеку.
 *
 * Работает во всех чатах события (TG/VK/MAX). Бот должен быть админом чата,
 * privacy mode OFF, а chat_id чата — заполнен в настройках события (вкладка
 * «Контроль заданий» / поля чатов). Отвечает всем, на каждое сообщение с
 * кодовым словом.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface Props {
  event: any
  eventId: number
  onReload: () => void
}

interface Greeting { id: number; text: string; sort: number }

export default function ChatGreetingTab({ event, eventId, onReload }: Props) {
  const [enabled, setEnabled] = useState<boolean>(event.chat_greeting_enabled || false)
  const [keyword, setKeyword] = useState<string>(event.chat_greeting_keyword || '')
  const [greetings, setGreetings] = useState<Greeting[]>([])
  const [loading, setLoading] = useState(true)
  const [savingMeta, setSavingMeta] = useState(false)
  const [savedMeta, setSavedMeta] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newText, setNewText] = useState('')
  // Локальные правки текста по id (чтобы не дёргать API на каждый символ).
  const [edits, setEdits] = useState<Record<number, string>>({})

  useEffect(() => {
    setEnabled(event.chat_greeting_enabled || false)
    setKeyword(event.chat_greeting_keyword || '')
  }, [event])

  async function load() {
    setLoading(true)
    try {
      const r = await api.chatGreetings.list(eventId)
      setGreetings(r.greetings || [])
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить фразы')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [eventId])

  async function saveMeta() {
    setSavingMeta(true); setError(null); setSavedMeta(false)
    try {
      if (enabled && !keyword.trim()) {
        setError('Заполните «Кодовое слово» — без него бот не поймёт, на что отвечать.')
        setSavingMeta(false)
        return
      }
      await api.events.update(eventId, {
        chat_greeting_enabled: enabled,
        chat_greeting_keyword: keyword.trim() || null,
      })
      setSavedMeta(true)
      setTimeout(() => setSavedMeta(false), 2500)
      onReload()
    } catch (e: any) {
      setError(e?.message || 'Ошибка сохранения')
    } finally {
      setSavingMeta(false)
    }
  }

  async function addPhrase() {
    const text = newText.trim()
    if (!text) return
    try {
      const r = await api.chatGreetings.create(eventId, { text, sort: greetings.length })
      setGreetings([...greetings, r.greeting])
      setNewText('')
    } catch (e: any) {
      setError(e?.message || 'Не удалось добавить фразу')
    }
  }

  async function savePhrase(g: Greeting) {
    const text = (edits[g.id] ?? g.text).trim()
    if (!text || text === g.text) { setEdits(p => { const n = { ...p }; delete n[g.id]; return n }); return }
    try {
      const r = await api.chatGreetings.update(eventId, g.id, { text })
      setGreetings(greetings.map(x => x.id === g.id ? r.greeting : x))
      setEdits(p => { const n = { ...p }; delete n[g.id]; return n })
    } catch (e: any) {
      setError(e?.message || 'Не удалось сохранить фразу')
    }
  }

  async function removePhrase(id: number) {
    if (!confirm('Удалить эту фразу?')) return
    try {
      await api.chatGreetings.remove(eventId, id)
      setGreetings(greetings.filter(x => x.id !== id))
    } catch (e: any) {
      setError(e?.message || 'Не удалось удалить фразу')
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-gray-700 leading-relaxed">
        <b>Что это:</b> человек пишет в чате события <b>кодовое слово</b>
        {' '}(например «Я С ВАМИ») — и бот <b>ответом</b> на его сообщение присылает
        случайную фразу из набора ниже. Отвечает не сразу, а через 30 секунд – 3 минуты
        (рандомно) — чтобы выглядело естественно, как живой человек. Реагирует только
        на кодовое слово. Работает во всех чатах события — Telegram, VK, MAX.
        <div className="mt-2 text-xs text-gray-500">
          ⚠️ Чтобы бот видел сообщения в чате: он должен быть админом чата,
          privacy mode выключен в @BotFather, а ID чата заполнен в настройках события.
        </div>
      </div>

      {/* Включить + кодовое слово */}
      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          className="mt-1 w-5 h-5 rounded border-gray-300" />
        <div>
          <div className="font-medium text-gray-900">Отвечать на кодовое слово в чатах</div>
          <div className="text-sm text-gray-500">
            Если выключено — бот не реагирует на кодовое слово в чатах.
          </div>
        </div>
      </label>

      <div className={enabled ? '' : 'opacity-60'}>
        <label className="block text-sm font-medium text-gray-700 mb-1">Кодовое слово</label>
        <input type="text" value={keyword}
          onChange={e => setKeyword(e.target.value)}
          placeholder="Я С ВАМИ"
          className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
        <div className="text-xs text-gray-500 mt-1">
          Ищется в сообщении где угодно, без учёта регистра. Например, «я с вами!»
          или «Ребята, я с вами» — оба сработают.
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={saveMeta} disabled={savingMeta}
          className="px-6 py-3 bg-brand text-white rounded-xl text-sm font-medium disabled:opacity-50">
          {savingMeta ? 'Сохранение...' : 'Сохранить'}
        </button>
        {savedMeta && <span className="text-sm text-green-600">✓ Сохранено</span>}
      </div>

      {/* Набор фраз */}
      <div className="border-t border-gray-100 pt-6">
        <div className="text-sm font-semibold text-gray-800 mb-1">Фразы приветствия</div>
        <div className="text-xs text-gray-500 mb-3">
          Бот берёт одну случайную фразу из этого списка. Используйте <code className="px-1 bg-gray-100 rounded">{'{name}'}</code> — подставится имя человека.
        </div>

        {loading ? (
          <div className="text-sm text-gray-400">Загрузка…</div>
        ) : (
          <div className="space-y-2">
            {greetings.map(g => (
              <div key={g.id} className="flex items-start gap-2">
                <textarea
                  value={edits[g.id] ?? g.text}
                  onChange={e => setEdits(p => ({ ...p, [g.id]: e.target.value }))}
                  onBlur={() => savePhrase(g)}
                  rows={2}
                  className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand/30"
                  style={{ resize: 'vertical' }}
                />
                <button onClick={() => removePhrase(g.id)}
                  className="mt-1 px-2.5 py-2 text-gray-400 hover:text-red-600 text-sm"
                  title="Удалить фразу">✕</button>
              </div>
            ))}
            {greetings.length === 0 && (
              <div className="text-sm text-gray-400">Пока нет фраз — добавьте первую ниже.</div>
            )}
          </div>
        )}

        {/* Добавить фразу */}
        <div className="flex items-start gap-2 mt-3">
          <textarea
            value={newText}
            onChange={e => setNewText(e.target.value)}
            placeholder="Добро пожаловать, {name}! Рады, что вы с нами 🎉"
            rows={2}
            className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand/30"
            style={{ resize: 'vertical' }}
          />
          <button onClick={addPhrase} disabled={!newText.trim()}
            className="mt-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium disabled:opacity-40">
            + Добавить
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 text-sm">
          {error}
        </div>
      )}
    </div>
  )
}
