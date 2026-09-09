'use client'

/**
 * Мои начисления.
 *
 * ⚠️ Внедренец видит расчёт САМ (решение владельца): иначе владелец превращается
 * в живой отчёт, а спор «почему столько» вести не с чем.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

const rub = (kop?: number | null) =>
  `${Math.round((kop || 0) / 100).toLocaleString('ru-RU')} ₽`

const KIND: Record<string, string> = {
  activation: 'Активации',
  revival: 'Оживления',
  fix: 'Фикс за обслуживание',
  referral: 'Процент за приведённых',
  bonus: 'Премии',
}

export default function TechAccrualsPage() {
  const [data, setData] = useState<any>(null)
  const [period, setPeriod] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.tech.accruals(period || undefined)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [period])

  // Последние 6 месяцев для выбора. ⚠️ Список строим от текущей даты, а не
  // храним: иначе в январе он показывал бы прошлогодние месяцы.
  const months: string[] = []
  const now = new Date()
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  return (
    <div className="p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">Начисления</h1>
      <p className="mb-5 text-sm text-gray-500">
        Считается автоматически по вашим клиентам. Выплату отмечает владелец.
      </p>

      <div className="mb-5 flex flex-wrap gap-2">
        <button onClick={() => setPeriod('')}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  !period ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
          За всё время
        </button>
        {months.map(m => (
          <button key={m} onClick={() => setPeriod(m)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    period === m ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {m}
          </button>
        ))}
      </div>

      {loading ? <div className="text-sm text-gray-400">Загружаем…</div> : (<>
        {/* Главная цифра — сколько ещё не выплачено. За ней сюда и заходят. */}
        <div className="mb-5 rounded-xl bg-white p-5 shadow-sm">
          <div className="text-sm text-gray-500">К выплате</div>
          <div className="text-3xl font-bold text-gray-900">
            {rub(data?.unpaid_kopecks)}
          </div>
        </div>

        {!!data?.totals?.length && (
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {data.totals.map((t: any) => (
              <div key={t.kind} className="rounded-xl bg-white p-4 shadow-sm">
                <div className="text-xs text-gray-500">{KIND[t.kind] || t.kind}</div>
                <div className="text-xl font-semibold text-gray-900">{rub(t.sum_kopecks)}</div>
                <div className="text-xs text-gray-400">{t.n} шт.</div>
              </div>
            ))}
          </div>
        )}

        {!data?.accruals?.length ? (
          <div className="rounded-xl bg-white p-8 text-center text-sm text-gray-500 shadow-sm">
            Начислений пока нет.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-4 py-3">Дата</th>
                  <th className="px-4 py-3">За что</th>
                  <th className="px-4 py-3">Клиент</th>
                  <th className="px-4 py-3">Сумма</th>
                  <th className="px-4 py-3">Выплачено</th>
                </tr>
              </thead>
              <tbody>
                {data.accruals.map((a: any) => (
                  <tr key={a.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-4 py-3 text-gray-600">
                      {new Date(a.created_at).toLocaleDateString('ru-RU')}
                    </td>
                    <td className="px-4 py-3">
                      {KIND[a.kind] || a.kind}
                      {a.note && <div className="text-xs text-gray-400">{a.note}</div>}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{a.client_name || '—'}</td>
                    <td className="px-4 py-3 font-medium">{rub(a.amount_kopecks)}</td>
                    <td className="px-4 py-3">
                      {a.paid_at
                        ? <span className="text-green-600">
                            {new Date(a.paid_at).toLocaleDateString('ru-RU')}
                          </span>
                        : <span className="text-gray-400">ждёт</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>)}
    </div>
  )
}
