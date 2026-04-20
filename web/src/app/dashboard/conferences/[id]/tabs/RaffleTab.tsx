'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Dice5, RefreshCw, Trophy } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

type Ticket = {
  id: number
  event_id: number
  ticket_number: number
  tg_username: string | null
  tg_id: number | null
  tg_name: string | null
  salebot_client_id: string | null
  pluson_participant_id: number | null
  code_word: string | null
  created_at: string
  pu_username: string | null
  pu_first_name: string | null
  pu_last_name: string | null
  pu_salebot_id: string | null
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function displayName(t: Ticket): string {
  const name = t.tg_name || [t.pu_first_name, t.pu_last_name].filter(Boolean).join(' ').trim()
  return name || '—'
}

function displayUsername(t: Ticket): string {
  const u = t.tg_username || t.pu_username
  return u ? `@${u.replace(/^@/, '')}` : '—'
}

export default function RaffleTab() {
  const { id } = useParams()
  const eventId = Number(id)

  const [tickets, setTickets] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [winner, setWinner] = useState<Ticket | null>(null)
  const [rolling, setRolling] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.conference.raffleTickets.list(eventId)
      setTickets(res.tickets || [])
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить билеты')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [eventId])

  function rollWinner() {
    if (!tickets.length) return
    setRolling(true)
    setWinner(null)
    // Небольшая анимация: меняем победителя несколько раз, потом фиксируем
    let frame = 0
    const total = 20
    const interval = setInterval(() => {
      const rnd = tickets[Math.floor(Math.random() * tickets.length)]
      setWinner(rnd)
      frame++
      if (frame >= total) {
        clearInterval(interval)
        const finalWinner = tickets[Math.floor(Math.random() * tickets.length)]
        setWinner(finalWinner)
        setRolling(false)
      }
    }, 60)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="text-brand text-3xl" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Заголовок + действия */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold text-gray-900">Розыгрыш билетов</h2>
          <p className="text-sm text-gray-500">
            Всего билетов: <span className="font-semibold text-gray-900">{tickets.length}</span>
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <RefreshCw size={14} /> Обновить
        </button>
        <button
          onClick={rollWinner}
          disabled={!tickets.length || rolling}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-[#25455D] text-[#FFCFA4] hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          <Dice5 size={16} />
          {rolling ? 'Крутим…' : 'Выбрать случайный билет'}
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-50 text-red-700 text-sm border border-red-100">
          {error}
        </div>
      )}

      {/* Победитель */}
      {winner && (
        <div
          className="rounded-2xl p-5 text-white shadow-sm"
          style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: '#FFCFA4' }}>
              <Trophy size={20} className="text-[#25455D]" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider opacity-70">
                {rolling ? 'Выбираем…' : 'Победитель'}
              </p>
              <p className="text-2xl font-bold" style={{ color: '#FFCFA4' }}>
                Билет № {winner.ticket_number}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div>
              <p className="text-xs opacity-60">Ник в Telegram</p>
              <p className="font-medium break-all">{displayUsername(winner)}</p>
            </div>
            <div>
              <p className="text-xs opacity-60">Имя</p>
              <p className="font-medium break-words">{displayName(winner)}</p>
            </div>
            <div>
              <p className="text-xs opacity-60">Код участника</p>
              <p className="font-medium">{winner.code_word || '—'}</p>
            </div>
          </div>
        </div>
      )}

      {/* Таблица билетов */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {tickets.length === 0 ? (
          <div className="p-10 text-center text-gray-500 text-sm">
            Билеты пока не добавлены. Отправьте их через API:
            <code className="block mt-2 px-3 py-2 bg-gray-50 rounded-lg text-xs text-left overflow-x-auto">
              POST /api/v1/events/{eventId}/conference/raffle-tickets/public
            </code>
          </div>
        ) : (
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-left text-gray-500 text-xs uppercase tracking-wider">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Номер билета</th>
                  <th className="px-3 py-2 font-medium">Ник TG</th>
                  <th className="px-3 py-2 font-medium">Имя</th>
                  <th className="px-3 py-2 font-medium">Код</th>
                  <th className="px-3 py-2 font-medium">Дата</th>
                  <th className="px-3 py-2 font-medium">ID участника</th>
                  <th className="px-3 py-2 font-medium">Salebot ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {tickets.map((t, i) => {
                  const isWinner = winner && winner.id === t.id
                  return (
                    <tr
                      key={t.id}
                      className={isWinner ? 'bg-[#FFCFA4]/30' : 'hover:bg-gray-50'}
                    >
                      <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                      <td className="px-3 py-2 font-semibold text-gray-900">{t.ticket_number}</td>
                      <td className="px-3 py-2 text-gray-700">{displayUsername(t)}</td>
                      <td className="px-3 py-2 text-gray-700">{displayName(t)}</td>
                      <td className="px-3 py-2 text-gray-700">{t.code_word || '—'}</td>
                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{formatDate(t.created_at)}</td>
                      <td className="px-3 py-2 text-gray-500">{t.pluson_participant_id ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-500">{t.salebot_client_id || t.pu_salebot_id || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
