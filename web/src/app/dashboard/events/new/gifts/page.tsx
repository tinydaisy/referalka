'use client'
import { useState, useEffect, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Plus, Trash2, Gift, ArrowLeft } from 'lucide-react'
import { api } from '@/lib/api'

const DEFAULT_GIFTS = [
  { title: 'Первый подарок', description: '', points_cost: 1, link_url: '' },
  { title: 'Второй подарок', description: '', points_cost: 5, link_url: '' },
  { title: 'Большой подарок', description: '', points_cost: 10, link_url: '' },
]

function GiftsForm() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const eventId = Number(searchParams.get('event_id'))

  const [gifts, setGifts] = useState(DEFAULT_GIFTS.map(g => ({ ...g })))
  const [pointsFree, setPointsFree] = useState(1)
  const [pointsPaid, setPointsPaid] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const addGift = () => setGifts(g => [...g, { title: '', description: '', points_cost: 1, link_url: '' }])

  const removeGift = (i: number) => setGifts(g => g.filter((_, idx) => idx !== i))

  const setGift = (i: number, k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setGifts(g => g.map((gift, idx) => idx === i ? { ...gift, [k]: e.target.value } : gift))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!eventId) { setError('Событие не найдено'); return }
    setLoading(true)
    setError('')
    try {
      // Обновляем баллы события
      await api.events.update(eventId, { points_free: pointsFree, points_paid: pointsPaid })
      // Создаём подарки
      for (const [i, gift] of gifts.entries()) {
        if (gift.title.trim()) {
          await api.gifts.create(eventId, { ...gift, sort_order: i })
        }
      }
      router.push(`/dashboard/events/${eventId}`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl">
      {/* Progress */}
      <div className="flex items-center gap-3 mb-8">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-green-500 flex items-center justify-center text-white text-xs">✓</div>
          <span className="text-sm text-gray-500">Основное</span>
        </div>
        <div className="flex-1 h-px bg-brand" style={{ background: '#25455D' }} />
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full gradient-bg flex items-center justify-center text-white text-xs font-bold">2</div>
          <span className="text-sm font-medium text-gray-900">Подарки</span>
        </div>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">Настройте подарки</h1>
      <p className="text-gray-500 mb-8">Участники получают подарки за приглашённых друзей</p>

      <form onSubmit={handleSubmit} className="space-y-8">
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
        )}

        {/* Points config */}
        <div className="p-5 bg-gray-50 rounded-2xl">
          <h3 className="font-semibold text-gray-800 mb-4">Начисление баллов</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-2">
                Баллов за бесплатную регистрацию
              </label>
              <input
                type="number" min={1} value={pointsFree}
                onChange={e => setPointsFree(Number(e.target.value))}
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm text-center font-semibold"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-2">
                Баллов за платную регистрацию
                <span className="block text-xs text-gray-400">0 = нет платного тарифа</span>
              </label>
              <input
                type="number" min={0} value={pointsPaid}
                onChange={e => setPointsPaid(Number(e.target.value))}
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm text-center font-semibold"
              />
            </div>
          </div>
        </div>

        {/* Gifts list */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-800">Список подарков</h3>
            <button
              type="button" onClick={addGift}
              className="text-sm font-medium flex items-center gap-1 hover:underline"
              style={{ color: '#25455D' }}
            >
              <Plus size={14} /> Добавить подарок
            </button>
          </div>

          <div className="space-y-4">
            {gifts.map((gift, i) => (
              <div key={i} className="p-5 bg-white border border-gray-200 rounded-2xl shadow-sm">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-9 h-9 rounded-full gradient-bg flex items-center justify-center shrink-0">
                    <Gift size={16} className="text-white" />
                  </div>
                  <span className="text-sm font-medium text-gray-700">Подарок {i + 1}</span>
                  <button
                    type="button" onClick={() => removeGift(i)}
                    className="ml-auto text-gray-400 hover:text-red-500"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Название</label>
                    <input
                      type="text" value={gift.title} onChange={setGift(i, 'title')}
                      placeholder="Запись вебинара"
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand/30 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Стоимость (баллов)</label>
                    <input
                      type="number" min={1} value={gift.points_cost}
                      onChange={e => setGifts(g => g.map((gt, idx) => idx === i ? { ...gt, points_cost: Number(e.target.value) } : gt))}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand/30 text-sm text-center"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-gray-500 mb-1">Ссылка после разблокировки</label>
                  <input
                    type="url" value={gift.link_url} onChange={setGift(i, 'link_url')}
                    placeholder="https://drive.google.com/..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand/30 text-sm"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <Link href="/dashboard/events/new" className="px-5 py-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 flex items-center gap-2">
            <ArrowLeft size={16} /> Назад
          </Link>
          <button
            type="submit" disabled={loading}
            className="btn-gold flex-1 py-3 rounded-xl font-semibold text-sm"
          >
            {loading ? 'Сохраняем...' : 'Создать событие'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default function GiftsPage() {
  return (
    <Suspense>
      <GiftsForm />
    </Suspense>
  )
}
