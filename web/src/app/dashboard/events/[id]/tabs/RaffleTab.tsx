'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface Props { eventId: number }

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

interface Settings {
  is_enabled: boolean
  draw_at: string | null
  subscription_grants_starter_ticket: boolean
  intro_text: string | null
}
interface Prize {
  id: number
  title: string
  description: string | null
  icon_emoji: string | null
  icon_url: string | null
  places_count: number
  value_label: string | null
  sort_order: number
  is_active: boolean
}
interface Keyword {
  id: number
  keyword: string
  sort_order: number
  is_active: boolean
}

export default function RaffleTab({ eventId }: Props) {
  const [settings, setSettings] = useState<Settings>({
    is_enabled: false, draw_at: null, subscription_grants_starter_ticket: true, intro_text: null,
  })
  const [prizes, setPrizes] = useState<Prize[]>([])
  const [keywords, setKeywords] = useState<Keyword[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Local input для нового приза/слова
  const [newPrize, setNewPrize] = useState({ title: '', description: '', places_count: 1, value_label: '', icon_emoji: '🎁' })
  const [newKw,    setNewKw]    = useState({ keyword: '' })

  useEffect(() => { reload() }, [eventId])

  async function reload() {
    setLoading(true)
    try {
      const [s, p, k] = await Promise.all([
        api.raffle.settings.get(eventId),
        api.raffle.prizes.list(eventId),
        api.raffle.keywords.list(eventId),
      ])
      setSettings(s)
      setPrizes(p.items || [])
      setKeywords(k.items || [])
    } finally {
      setLoading(false)
    }
  }

  async function saveSettings() {
    setSaving(true)
    try {
      await api.raffle.settings.save(eventId, settings)
      setSavedAt(Date.now()); setTimeout(() => setSavedAt(null), 2000)
    } catch (e: any) {
      alert(e.message || 'Не удалось сохранить настройки')
    } finally {
      setSaving(false)
    }
  }

  async function addPrize() {
    const p = newPrize
    if (!p.title.trim()) { alert('Название обязательно'); return }
    try {
      await api.raffle.prizes.create(eventId, {
        title: p.title.trim(),
        description: p.description.trim() || null,
        places_count: Number(p.places_count) || 1,
        value_label: p.value_label.trim() || null,
        icon_emoji:  p.icon_emoji || null,
        sort_order: prizes.length,
        is_active: true,
      })
      setNewPrize({ title: '', description: '', places_count: 1, value_label: '', icon_emoji: '🎁' })
      await reload()
    } catch (e: any) { alert(e.message || 'Ошибка') }
  }

  async function updatePrize(id: number, patch: Partial<Prize>) {
    try { await api.raffle.prizes.update(eventId, id, patch); await reload() }
    catch (e: any) { alert(e.message || 'Ошибка') }
  }

  async function removePrize(id: number) {
    if (!confirm('Удалить приз?')) return
    try { await api.raffle.prizes.delete(eventId, id); await reload() }
    catch (e: any) { alert(e.message || 'Ошибка') }
  }

  async function addKeyword() {
    if (!newKw.keyword.trim()) { alert('Слово обязательно'); return }
    try {
      await api.raffle.keywords.create(eventId, {
        keyword: newKw.keyword.trim(),
        sort_order: keywords.length,
        is_active: true,
      })
      setNewKw({ keyword: '' })
      await reload()
    } catch (e: any) {
      if (e.message?.includes('409') || /already/i.test(e.message || ''))
        alert('Это слово уже добавлено')
      else alert(e.message || 'Ошибка')
    }
  }

  async function updateKeyword(id: number, patch: Partial<Keyword>) {
    try { await api.raffle.keywords.update(eventId, id, patch); await reload() }
    catch (e: any) { alert(e.message || 'Ошибка') }
  }

  async function removeKeyword(id: number) {
    if (!confirm('Удалить кодовое слово?')) return
    try { await api.raffle.keywords.delete(eventId, id); await reload() }
    catch (e: any) { alert(e.message || 'Ошибка') }
  }

  if (loading) return <div className="text-gray-500">Загружаем…</div>

  return (
    <div className="max-w-3xl space-y-10 pb-24">
      {/* === Общие настройки === */}
      <section>
        <h2 className="text-lg font-bold mb-1" style={{ color: BRAND }}>Розыгрыш</h2>
        <p className="text-sm text-gray-500 mb-4">
          Если включить — у участника в Mini App появится вкладка «Розыгрыш» с билетами,
          списком призов и кодовыми словами.
        </p>

        <label className="flex items-center gap-2 mb-4 cursor-pointer">
          <input type="checkbox" checked={settings.is_enabled}
                 onChange={e => setSettings(s => ({ ...s, is_enabled: e.target.checked }))} />
          <span className="text-sm font-medium">Включить розыгрыш для этого события</span>
        </label>

        {settings.is_enabled && (
          <div className="space-y-3 pl-6 border-l-2" style={{ borderColor: PEACH }}>
            <Field label="Когда разыгрываете" hint="Дата и время финала розыгрыша. Покажется в Mini App над билетами.">
              <input type="datetime-local" className="input w-60"
                     value={settings.draw_at ? settings.draw_at.slice(0, 16) : ''}
                     onChange={e => setSettings(s => ({ ...s, draw_at: e.target.value || null }))} />
            </Field>

            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" className="mt-1"
                     checked={settings.subscription_grants_starter_ticket}
                     onChange={e => setSettings(s => ({ ...s, subscription_grants_starter_ticket: e.target.checked }))} />
              <div>
                <div className="text-sm font-medium">Подписка → стартовый билет</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Если включено — за подписку на ваши каналы участник автоматически получает 1 билет
                </div>
              </div>
            </label>

            <Field label="Текст-объяснение" hint="Опционально. Можно описать механику словами под цифрами билетов.">
              <textarea className="input min-h-[60px]"
                        value={settings.intro_text || ''}
                        onChange={e => setSettings(s => ({ ...s, intro_text: e.target.value || null }))}
                        placeholder="Подпишитесь на каналы и получите свой первый билет!" />
            </Field>
          </div>
        )}

        <button onClick={saveSettings} disabled={saving}
                className="mt-5 px-5 py-2 rounded-lg text-white font-medium disabled:opacity-50"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          {saving ? 'Сохраняем…' : 'Сохранить настройки'}
        </button>
        {savedAt && <span className="text-sm text-green-600 ml-3">✓ Сохранено</span>}
      </section>

      {/* === ПРИЗЫ === */}
      <section>
        <h2 className="text-lg font-bold mb-1" style={{ color: BRAND }}>Призы</h2>
        <p className="text-sm text-gray-500 mb-4">
          Список призов в раскрывающемся блоке Mini App. Можно сколько угодно (5, 12, 20…).
        </p>

        {prizes.length > 0 && (
          <div className="space-y-2 mb-5">
            {prizes.map(p => (
              <div key={p.id} className="border border-gray-200 rounded-xl p-3 flex items-start gap-3">
                <div className="text-2xl flex-shrink-0 w-10 text-center">{p.icon_emoji || '🎁'}</div>
                <div className="flex-1 min-w-0">
                  <input className="input mb-1" value={p.title}
                         onBlur={e => e.target.value !== p.title && updatePrize(p.id, { title: e.target.value })}
                         onChange={e => setPrizes(prev => prev.map(x => x.id === p.id ? { ...x, title: e.target.value } : x))} />
                  <div className="flex gap-2 items-center">
                    <input className="input w-24 text-sm" type="number" min="1" value={p.places_count}
                           onBlur={e => Number(e.target.value) !== p.places_count && updatePrize(p.id, { places_count: Number(e.target.value) })}
                           onChange={e => setPrizes(prev => prev.map(x => x.id === p.id ? { ...x, places_count: Number(e.target.value) } : x))} />
                    <span className="text-xs text-gray-500">мест</span>
                    <input className="input flex-1 text-sm" placeholder="Стоимость (опц.) — например 49 000 ₽" value={p.value_label || ''}
                           onBlur={e => (e.target.value || null) !== p.value_label && updatePrize(p.id, { value_label: e.target.value || null })}
                           onChange={e => setPrizes(prev => prev.map(x => x.id === p.id ? { ...x, value_label: e.target.value } : x))} />
                  </div>
                </div>
                <button onClick={() => removePrize(p.id)} className="text-red-500 hover:text-red-700 text-sm px-2">✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Добавление нового приза */}
        <div className="border-2 border-dashed border-gray-300 rounded-xl p-4 space-y-2">
          <div className="text-sm font-medium text-gray-700">Добавить приз</div>
          <div className="flex gap-2">
            <input className="input w-16 text-center text-2xl" maxLength={2} value={newPrize.icon_emoji}
                   onChange={e => setNewPrize({ ...newPrize, icon_emoji: e.target.value })} />
            <input className="input flex-1" placeholder="Название (например «Курс Email-маркетинг»)"
                   value={newPrize.title}
                   onChange={e => setNewPrize({ ...newPrize, title: e.target.value })} />
          </div>
          <div className="flex gap-2 items-center">
            <input className="input w-24" type="number" min="1" placeholder="мест"
                   value={newPrize.places_count}
                   onChange={e => setNewPrize({ ...newPrize, places_count: Number(e.target.value) || 1 })} />
            <span className="text-xs text-gray-500">мест</span>
            <input className="input flex-1" placeholder="Стоимость (опц.)"
                   value={newPrize.value_label}
                   onChange={e => setNewPrize({ ...newPrize, value_label: e.target.value })} />
          </div>
          <button onClick={addPrize} className="px-4 py-2 rounded-lg text-sm font-medium"
                  style={{ background: PEACH, color: BRAND }}>+ Добавить приз</button>
        </div>
      </section>

      {/* === КОДОВЫЕ СЛОВА === */}
      <section>
        <h2 className="text-lg font-bold mb-1" style={{ color: BRAND }}>Кодовые слова</h2>
        <p className="text-sm text-gray-500 mb-4">
          Спикеры будут называть слова в эфире — за каждое участник получит дополнительные билеты.
        </p>

        {keywords.length > 0 && (
          <div className="space-y-2 mb-5">
            {keywords.map(k => (
              <div key={k.id} className="border border-gray-200 rounded-xl p-3 flex items-center gap-3">
                <input className="input flex-1 font-mono uppercase" value={k.keyword}
                       onBlur={e => e.target.value !== k.keyword && updateKeyword(k.id, { keyword: e.target.value })}
                       onChange={e => setKeywords(prev => prev.map(x => x.id === k.id ? { ...x, keyword: e.target.value } : x))} />
                <span className="text-xs text-gray-500 whitespace-nowrap">+1 билет</span>
                <button onClick={() => removeKeyword(k.id)} className="text-red-500 hover:text-red-700 text-sm px-2">✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="border-2 border-dashed border-gray-300 rounded-xl p-4 space-y-2">
          <div className="text-sm font-medium text-gray-700">Добавить кодовое слово</div>
          <div className="flex gap-2">
            <input className="input flex-1 font-mono uppercase" placeholder="ROCKETS"
                   value={newKw.keyword}
                   onChange={e => setNewKw({ ...newKw, keyword: e.target.value })} />
          </div>
          <button onClick={addKeyword} className="px-4 py-2 rounded-lg text-sm font-medium"
                  style={{ background: PEACH, color: BRAND }}>+ Добавить слово</button>
          <p className="text-xs text-gray-500">Каждое слово даёт ровно один билет участнику. Слово может ввести любое число участников — один участник одно слово вводит только раз.</p>
        </div>
      </section>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {hint && <p className="text-xs text-gray-500 mb-1.5">{hint}</p>}
      {children}
    </div>
  )
}
