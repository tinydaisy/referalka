'use client'

/**
 * Мои показатели — из чего складываются деньги внедренца.
 *
 * ⚠️ Экран объясняет НАЧИСЛЕНИЯ, а не заменяет их: «Начисления» показывают, что
 * уже начислено, здесь — почему столько и что сделать, чтобы стало больше.
 *
 * ⚠️ Ставки, ступени и пороги приходят С СЕРВЕРА (из базы), в вёрстке их нет.
 * Захардкоженная вилка пережила бы правку ставки и врала бы молча.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Users, Wallet, TrendingUp, Snowflake } from 'lucide-react'
import { api } from '@/lib/api'

const rub = (kop?: number | null) =>
  `${Math.round((kop || 0) / 100).toLocaleString('ru-RU')} ₽`

const DARK = '#25455D'
const PEACH = '#FFCFA4'

/** Плитка с крупной цифрой. */
function Tile({ icon: Icon, label, value, hint, accent }: {
  icon: any; label: string; value: string; hint?: string; accent?: boolean
}) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-gray-500">
        <Icon size={15} /> {label}
      </div>
      <div className="text-2xl font-bold" style={{ color: accent ? DARK : '#111827' }}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-gray-400">{hint}</div>}
    </div>
  )
}

/** Полоса прогресса до следующей ступени. */
function Progress({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100">
      <div className="h-full rounded-full transition-all"
           style={{ width: `${pct}%`, background: PEACH }} />
    </div>
  )
}

export default function TechKpiPage() {
  const [d, setD] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.tech.kpi().then(setD).catch(() => {}).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-8 text-sm text-gray-400">Загружаем…</div>
  if (!d) return <div className="p-8 text-sm text-gray-500">Не удалось загрузить показатели.</div>

  const { clients, fix, quarter, money, rates } = d

  // Ставки процентов — показываем как есть из базы, без пересчёта в рубли:
  // цена зависит от тарифа конкретного клиента, средняя цифра вводила бы в
  // заблуждение.
  const rateOf = (kind: string) => rates?.find((r: any) => r.kind === kind)
  const pct = (kind: string) => {
    const r = rateOf(kind)
    return r?.of_tariff ? `${Math.round(Number(r.percent))}%` : null
  }

  return (
    <div className="p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">Показатели</h1>
      <p className="mb-6 text-sm text-gray-500">
        Из чего складываются ваши деньги. Цифры считаются так же, как начисления.
      </p>

      {/* ── Деньги ─────────────────────────────────────────────────────── */}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Tile icon={Wallet} label="Начислено за месяц"
              value={rub(money.this_month_kopecks)} accent />
        <Tile icon={Wallet} label="Ждёт выплаты"
              value={rub(money.unpaid_kopecks)}
              hint="выплату отмечает владелец" />
        <Tile icon={Wallet} label="Всего за всё время"
              value={rub(money.total_kopecks)} />
      </div>

      {/* ── Клиенты ────────────────────────────────────────────────────── */}
      {kpi?.bonus_conditions && (() => {
        const b = kpi.bonus_conditions
        const own = b.need_own_quarter > 0
        return (
          <div className="mb-6 rounded-xl bg-white p-4 shadow-sm">
            <div className="mb-1 flex items-center justify-between gap-3">
              <h2 className="text-base font-bold text-gray-900">
                Условия премии · {b.period}
              </h2>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                b.meets ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
                {b.meets ? 'условия выполнены' : 'условия не выполнены'}
              </span>
            </div>
            <p className="mb-3 text-xs text-gray-500">
              Премия за квартал начисляется, если сделаны активации. Считаются
              клиенты, доведённые до второй оплаты.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">Клиенты от ПЛЮСОНА</div>
                <div className="text-lg font-bold" style={{ color: DARK }}>
                  {b.got_from_pluson}
                  <span className="text-sm font-normal text-gray-400">
                    {' '}из {b.need_from_pluson_quarter} за квартал
                  </span>
                </div>
                <div className="text-xs text-gray-400">
                  это {b.need_from_pluson} в месяц
                </div>
              </div>
              {own && (
                <div className="rounded-lg bg-gray-50 p-3">
                  <div className="text-xs text-gray-500">Приведённые вами</div>
                  <div className="text-lg font-bold" style={{ color: DARK }}>
                    {b.got_own}
                    <span className="text-sm font-normal text-gray-400">
                      {' '}из {b.need_own_quarter} за квартал
                    </span>
                  </div>
                  <div className="text-xs text-gray-400">
                    это {b.need_own} в месяц
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Клиенты
      </h2>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile icon={Users} label="Всего в работе" value={String(clients.total)}
              hint={`платят ${clients.paying}`} />
        <Tile icon={Users} label="Привёл лично" value={String(clients.mine)}
              hint={`платят ${clients.mine_paying}${pct('referral') ? ` · ${pct('referral')} с оплат` : ''}`} />
        <Tile icon={Users} label="Идут в фикс" value={String(clients.others_paying)}
              hint="платящие, кого привёл не я" />
        <Tile icon={Snowflake} label="Остыли" value={String(clients.cold)}
              hint={pct('revival') ? `оживление — ${pct('revival')} от тарифа` : 'платили раньше'} />
      </div>

      {/* ── Фикс ───────────────────────────────────────────────────────── */}
      <div className="mb-4 rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-bold text-gray-900">Фикс за обслуживание</h3>
          <div className="text-xl font-bold" style={{ color: DARK }}>
            {rub(fix.amount_kopecks)}<span className="text-sm font-normal text-gray-400">/мес</span>
          </div>
        </div>
        <p className="text-sm text-gray-500">
          Платится одной суммой за диапазон, а не за каждого клиента.
          Считаются только те, кого привели не вы, — за своих идёт процент.
        </p>

        {fix.next_at ? (
          <>
            <Progress value={fix.clients_counted} max={fix.next_at} />
            <div className="mt-2 text-sm text-gray-600">
              Сейчас <b>{fix.clients_counted}</b>
              {fix.tier_from != null && fix.amount_kopecks > 0 &&
                <> (ступень {fix.tier_from}–{fix.tier_to})</>}.
              {' '}Ещё <b>{fix.next_at - fix.clients_counted}</b> — и фикс станет{' '}
              <b>{rub(fix.next_amount_kopecks)}</b>.
            </div>
          </>
        ) : (
          <div className="mt-2 text-sm text-gray-600">
            Сейчас <b>{fix.clients_counted}</b> — это верхняя ступень.
          </div>
        )}
      </div>

      {/* ── Квартальная премия ─────────────────────────────────────────── */}
      <div className="mb-4 rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-bold text-gray-900">
            Премия за удержание · текущий квартал
          </h3>
          <div className="text-xl font-bold" style={{ color: DARK }}>
            {quarter.rate === null ? '—' : `${quarter.rate}%`}
          </div>
        </div>
        <p className="text-sm text-gray-500">
          Сколько из впервые оплативших в этом квартале сделали вторую оплату.
          Считается через месяц после конца квартала — у оплативших в последние
          недели срок второй оплаты ещё не наступил.
        </p>

        {quarter.first_payers > 0 ? (
          <>
            <Progress value={quarter.rate || 0} max={quarter.next_rate || 100} />
            <div className="mt-2 text-sm text-gray-600">
              Дожили <b>{quarter.survived}</b> из <b>{quarter.first_payers}</b>.
              {quarter.amount_kopecks > 0
                ? <> Сейчас это <b>{rub(quarter.amount_kopecks)}</b>.</>
                : <> До премии пока не хватает.</>}
              {quarter.next_rate != null && (
                <> С <b>{Math.round(quarter.next_rate)}%</b> премия{' '}
                  <b>{rub(quarter.next_amount_kopecks)}</b>.</>
              )}
            </div>
          </>
        ) : (
          <div className="mt-2 text-sm text-gray-500">
            В этом квартале ещё никто не оплатил впервые — считать пока нечего.
          </div>
        )}
      </div>

      {/* ── Ставки ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-base font-bold text-gray-900">Ставки</h3>
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          {[
            ['activation', 'Активация', '10+ новых в воронке и вторая оплата'],
            ['retention', 'Удержание', 'клиент оплатил второй месяц'],
            ['revival', 'Оживление', 'оплата после перерыва'],
            ['referral', 'Свой приведённый', 'каждый месяц, пока платит'],
            ['referral2', 'Второй уровень', 'кого привёл ваш приведённый'],
            ['referral3', 'Третий уровень', 'следующий за вторым'],
          ].map(([kind, label, hint]) => {
            const v = pct(kind)
            if (!v) return null
            return (
              <div key={kind} className="flex items-baseline justify-between gap-3
                                         border-b border-gray-50 pb-2 last:border-0">
                <div>
                  <div className="font-medium text-gray-900">{label}</div>
                  <div className="text-xs text-gray-400">{hint}</div>
                </div>
                <div className="whitespace-nowrap font-bold" style={{ color: DARK }}>
                  {v} <span className="text-xs font-normal text-gray-400">от тарифа</span>
                </div>
              </div>
            )
          })}
        </div>
        <p className="mt-3 text-xs text-gray-400">
          Процент считается от цены тарифа клиента, а не от суммы платежа: при
          оплате сразу за полгода ставка та же.
        </p>
      </div>

      <div className="mt-4 text-sm">
        <Link href="/tech/accruals" className="font-medium hover:underline"
              style={{ color: DARK }}>
          Посмотреть начисления по каждому клиенту →
        </Link>
      </div>
    </div>
  )
}
