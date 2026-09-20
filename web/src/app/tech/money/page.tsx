'use client'

/**
 * «Мои деньги» — из чего складывается заработок за месяц.
 *
 * ⚠️⚠️ ЦИФРЫ БЕРУТСЯ ИЗ НАЧИСЛЕНИЙ, А НЕ СЧИТАЮТСЯ ЗАНОВО. Начисление — уже
 * принятое решение о деньгах, записанное со ставкой на момент события. Свой
 * пересчёт «по текущим ставкам» показал бы другие суммы, чем будут выплачены,
 * и экран начал бы спорить с выплатой.
 *
 * ⚠️ Прибыли компании здесь нет и быть не должно — только обороты. Премия
 * внедренца считается от фонда, но из чего сложился фонд, он знать не должен.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

const rub = (kop?: number | null) =>
  `${Math.round((kop || 0) / 100).toLocaleString('ru-RU')} ₽`

/** Названия видов — по листу «2. Ставки и KPI», не выдуманные. */
const KIND: Record<string, string> = {
  activation: 'Активация',
  retention: 'Удержание',
  revival: 'Оживление',
  fix: 'Фикс за обслуживание базы',
  referral: 'Процент 1-го уровня',
  referral2: 'Процент 2-го уровня',
  referral3: 'Процент 3-го уровня',
  setup_own: 'Настройки «под ключ» — свои клиенты',
  setup_pluson: 'Настройки «под ключ» — из базы ПЛЮСОНА',
  ticket_simple: 'Тикеты простые',
  ticket_hard: 'Тикеты сложные',
  quarter_bonus: 'Квартальная премия',
  bonus: 'Премия вручную',
}

/** Порядок — как в таблице: сначала работа с клиентом, потом сеть, потом разовое. */
const ORDER = ['activation', 'retention', 'revival', 'fix',
               'referral', 'referral2', 'referral3',
               'setup_own', 'setup_pluson',
               'ticket_simple', 'ticket_hard',
               'quarter_bonus', 'bonus']

const ROLE_LABEL: Record<string, string> = {
  implementer_network: 'Тип В — с привлечением',
  implementer_base: 'Тип Б — обслуживание базы',
}

export default function TechMoneyPage() {
  const [d, setD] = useState<any>(null)
  const [kpi, setKpi] = useState<any>(null)
  const [period, setPeriod] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.tech.money(period || undefined)
      .then(setD).catch(() => setD(null)).finally(() => setLoading(false))
  }, [period])

  useEffect(() => {
    api.tech.kpi().then(setKpi).catch(() => {})
  }, [])

  if (loading) return <div className="p-4 text-sm text-gray-400 md:p-8">Загружаем…</div>
  if (!d) return <div className="p-4 text-sm text-gray-500 md:p-8">Не удалось загрузить.</div>

  const rows = ORDER.filter(k => d.by_kind[k]).map(k => ({ kind: k, ...d.by_kind[k] }))
  const q = kpi?.qualification

  // Месяцы для выбора — последние 12.
  const months: string[] = []
  const now = new Date()
  for (let i = 0; i < 12; i++) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`)
  }

  return (
    <div className="p-4 md:p-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="mb-1 text-2xl font-bold text-gray-900">Мои деньги</h1>
          <p className="text-sm text-gray-500">
            Из чего складывается заработок за месяц.
          </p>
        </div>
        <select value={period || months[0]} onChange={e => setPeriod(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          {months.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {/* Итог и тип — то, ради чего сюда заходят. */}
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl p-4 text-white"
             style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <div className="text-xs text-white/60">Начислено за месяц</div>
          <div className="text-2xl font-bold">{rub(d.total_kopecks)}</div>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="text-xs text-gray-500">Ждёт выплаты</div>
          <div className="text-2xl font-bold" style={{ color: '#25455D' }}>
            {rub(d.unpaid_kopecks)}
          </div>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="text-xs text-gray-500">Ваш тип</div>
          <div className="text-lg font-bold" style={{ color: '#25455D' }}>
            {ROLE_LABEL[d.role] || 'не определён'}
          </div>
          {/* ⚠️ Тип определяется РАБОТОЙ (числом активаций в месяц), а не
              галочкой — поэтому он может меняться сам. */}
          <div className="mt-0.5 text-[11px] text-gray-400">
            Определяется по числу активаций за месяц
          </div>
        </div>
      </div>

      {/* Квалификация: текущий процент и сколько до следующей ступени. */}
      {q && (
        <div className="mb-5 rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-gray-700">Квалификация</div>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <div>
              <span className="text-2xl font-bold" style={{ color: '#25455D' }}>
                {q.percent ?? '—'} %
              </span>
              <span className="ml-1.5 text-sm text-gray-500">
                процент 1-го уровня сейчас
              </span>
            </div>
            <div className="text-sm text-gray-500">
              Оборот вашей сети: <b>{rub(q.turnover_kopecks)}</b>
            </div>
          </div>
          {q.next_at_kopecks && (
            <div className="mt-2 text-sm text-gray-500">
              До {q.next_percent} % осталось оборота:{' '}
              <b style={{ color: '#25455D' }}>
                {rub(Math.max(0, q.next_at_kopecks - (q.turnover_kopecks || 0)))}
              </b>
            </div>
          )}
        </div>
      )}

      {/* Разбивка по видам: сколько человек и сколько денег. */}
      <div className="mb-5 overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs text-gray-500">
            <tr>
              <th className="px-4 py-3">За что</th>
              <th className="px-4 py-3">Клиентов</th>
              <th className="px-4 py-3">Начислений</th>
              <th className="px-4 py-3">Сумма</th>
              <th className="px-4 py-3">Ждёт выплаты</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.kind} className="border-b border-gray-50 last:border-0">
                <td className="px-4 py-3 font-medium text-gray-900">
                  {KIND[r.kind] || r.kind}
                </td>
                <td className="px-4 py-3">{r.people || '—'}</td>
                <td className="px-4 py-3">{r.count}</td>
                <td className="px-4 py-3 font-semibold">{rub(r.amount_kopecks)}</td>
                <td className="px-4 py-3 text-gray-500">{rub(r.unpaid_kopecks)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                  За этот месяц начислений пока нет.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Обороты. ⚠️ Оборот, а не прибыль: от оборота зависит ступень фонда,
          и человеку надо видеть, близко ли она. Прибыль — не его дело. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="text-xs text-gray-500">Ваш оборот за месяц</div>
          <div className="text-xl font-bold" style={{ color: '#25455D' }}>
            {rub(d.own_turnover_kopecks)}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-400">
            Оплаты закреплённых за вами клиентов
          </div>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="text-xs text-gray-500">Оборот команды за месяц</div>
          <div className="text-xl font-bold" style={{ color: '#25455D' }}>
            {rub(d.team_turnover_kopecks)}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-400">
            От него считается премиальный фонд
          </div>
        </div>
      </div>
    </div>
  )
}
