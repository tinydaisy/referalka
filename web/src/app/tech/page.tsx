'use client'

/**
 * Мои клиенты — главный экран внедренца.
 *
 * ⚠️ Фильтрует БЭКЕНД по `tech_specialist_id` из токена. Здесь фильтра «только
 * свои» нет и быть не должно: он обходится прямым запросом.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Search, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

const rub = (kop?: number | null) =>
  `${Math.round((kop || 0) / 100).toLocaleString('ru-RU')} ₽`

const dt = (v?: string | null) =>
  v ? new Date(v).toLocaleDateString('ru-RU') : '—'

// Разрезы. ⚠️ «Остывшие» показываем НАРАВНЕ с платящими, а не прячем: именно с
// ними и работают ради оживления, а спрятанные они выпадут из внимания.
const TABS: { id: string; label: string }[] = [
  { id: '', label: 'Все' },
  { id: 'paying', label: 'Платят' },
  { id: 'trial', label: 'На пробном' },
  { id: 'cold', label: 'Остыли' },
  // ⚠️ Разрезы по происхождению: «за кого мне идёт процент» и «кого просто
  // дали вести» — разные деньги, и смотрят их отдельно.
  { id: 'mine', label: 'Привёл лично' },
  { id: 'level2', label: '2-й уровень' },
  { id: 'assigned', label: 'Назначенные' },
]

export default function TechClientsPage() {
  const [items, setItems] = useState<any[]>([])
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const t = setTimeout(() => {
      // Разрезы по уровню считаются здесь же, серверу их слать незачем.
      const serverStatus = ['paying', 'trial', 'cold'].includes(status) ? status : undefined
      api.tech.clients({ search: search || undefined, status: serverStatus })
        .then((r: any) => setItems(r.clients || []))
        .catch(() => {})
        .finally(() => setLoading(false))
    }, search ? 350 : 0)   // поиск не дёргает сервер на каждую букву
    return () => clearTimeout(t)
  }, [status, search])

  const paying = items.filter(i => i.is_paying).length
  // ⚠️ Фильтр по уровню — на фронте, а не запросом: список уже загружен целиком
  // и ограничен бэкендом «только мои», лишний поход на сервер тут ни к чему.
  const shown = status === 'mine' ? items.filter(i => i.referral_level === 1)
    : status === 'level2' ? items.filter(i => i.referral_level === 2)
    : status === 'assigned' ? items.filter(i => !i.referral_level)
    : items

  return (
    <div className="p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">Мои клиенты</h1>
      <p className="mb-5 text-sm text-gray-500">
        Всего {items.length}, из них платят {paying}
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setStatus(t.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    status === t.id ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {t.label}
          </button>
        ))}
        <div className="relative ml-auto">
          <Search size={15} className="absolute left-3 top-2.5 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Имя, почта, ник"
                 className="rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm" />
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-gray-400">Загружаем…</div>
      ) : !shown.length ? (
        <div className="rounded-xl bg-white p-8 text-center text-sm text-gray-500 shadow-sm">
          Здесь пока никого. Клиентов закрепляет владелец платформы.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 text-left text-xs text-gray-500">
              <tr>
                <th className="px-4 py-3">Клиент</th>
                <th className="px-4 py-3">Тариф</th>
                <th className="px-4 py-3">Оплат</th>
                <th className="px-4 py-3">Последняя</th>
                <th className="px-4 py-3">Всего</th>
                <th className="px-4 py-3">Связь</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(c => (
                <tr key={c.id} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-3">
                    <Link href={`/tech/clients/${c.id}`}
                          className="font-medium text-gray-900 hover:underline">
                      {c.name || 'Без имени'}
                    </Link>
                    <div className="text-xs text-gray-400">{c.email}</div>
                    {/* ⚠️ Уровень видно сразу: за приведённого лично идёт
                        процент, за второй уровень — по своей ставке, а за
                        назначенного только фикс. Без пометки в списке эти
                        случаи неразличимы. */}
                    {c.referral_level === 1 && (
                      <span className="mt-0.5 inline-block rounded bg-[#FFCFA4] px-1.5 py-0.5 text-[10px] font-semibold text-[#0a1520]">
                        привёл лично
                      </span>
                    )}
                    {c.referral_level === 2 && (
                      <span className="mt-0.5 inline-block rounded bg-[#25455D] px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        2-й уровень
                      </span>
                    )}
                    {!c.referral_level && (
                      <span className="mt-0.5 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                        назначен
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div>{c.tariff_name || '—'}</div>
                    <div className="text-xs text-gray-400">
                      {c.is_paying ? `платит до ${dt(c.expires_at)}`
                        : c.sub_source && c.sub_source !== 'paid' ? 'пробный'
                        : 'не платит'}
                    </div>
                  </td>
                  <td className="px-4 py-3">{c.payments_count || 0}</td>
                  <td className="px-4 py-3 text-gray-600">{dt(c.last_paid_at)}</td>
                  <td className="px-4 py-3">{rub(c.total_paid_kopecks)}</td>
                  <td className="px-4 py-3">
                    {/* Написать человеку напрямую: ради этого ник и телефон и
                        показываются — иначе связаться с клиентом нечем. */}
                    {c.telegram_username ? (
                      <a href={`https://telegram.me/${String(c.telegram_username).replace('@', '')}`}
                         target="_blank" rel="noreferrer"
                         className="inline-flex items-center gap-1 text-[#25455D] hover:underline">
                        Telegram <ExternalLink size={12} />
                      </a>
                    ) : c.phone ? (
                      <a href={`tel:${c.phone}`} className="text-[#25455D] hover:underline">
                        {c.phone}
                      </a>
                    ) : <span className="text-gray-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
