'use client'

/**
 * Админ: тех-специалисты — люди, ставки, распределение клиентов, выплаты.
 *
 * ⚠️ Распределение здесь, а не в кабинете внедренца: кому кого вести — решение
 * владельца. Иначе специалист набирал бы себе платящих и обходил остывших.
 */
import { useEffect, useState, Suspense } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import { api } from '@/lib/api'

const rub = (kop?: number | null) =>
  `${Math.round((kop || 0) / 100).toLocaleString('ru-RU')} ₽`

// ⚠️ Подписи и правила — по листу «2. KPI и проценты», не выдуманные.
/** Названия ставок. ⚠️ Порядок повторяет лист «2. Ставки и KPI»:
 *  активация → удержание → оживление, затем проценты по уровням 1-2-3. */
const KIND: Record<string, string> = {
  activation: 'Активация — % от тарифа',
  retention: 'Удержание — % от тарифа',
  revival: 'Оживление — % от тарифа',
  referral: 'Процент 1-го уровня (свой приведённый)',
  referral2: 'Процент 2-го уровня',
  referral3: 'Процент 3-го уровня',
  setup_pluson: 'Настройки: клиент из базы ПЛЮСОН',
  setup_own: 'Настройки: ваш клиент',
  ticket_simple: 'Тикет простой',
  ticket_hard: 'Тикет сложный (домены, почта, платежи)',
  fix: 'Фикс за обслуживание',
  quarter_bonus: 'Квартальная премия',
  bonus: 'Премия вручную',
}

/** ⚠️ Фикс задаётся ВИЛКОЙ на вкладке «Ставки», отдельной строки ему тут не
 *  нужно — раньше она висела бесполезной подписью «считается по вилке». */
const HIDDEN_RATES = ['fix', 'quarter_bonus', 'bonus']

const ORDER = ['activation', 'retention', 'revival',
               'referral', 'referral2', 'referral3',
               'setup_pluson', 'setup_own',
               'ticket_simple', 'ticket_hard']

const sortRates = (rates: any[]) =>
  [...(rates || [])]
    .filter(r => !HIDDEN_RATES.includes(r.kind))
    .sort((a, b) => {
      const ia = ORDER.indexOf(a.kind), ib = ORDER.indexOf(b.kind)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })

type Tab = 'specs' | 'assign' | 'dialogs' | 'rates' | 'bonus' | 'money'


// ⚠️⚠️ ОБЯЗАТЕЛЬНАЯ ОБЁРТКА. У страницы нет динамического сегмента, поэтому
// Next пререндерит её на сборке, а `useUrlTab` читает адрес (`useSearchParams`)
// — на пререндеренной странице это требует <Suspense>, иначе падает сборка
// ВСЕГО проекта. ⚠️ `tsc` такую ошибку не ловит, только сборка.
export default function AdminTechPage() {
  return (
    <Suspense fallback={null}>
      <AdminTechPageInner />
    </Suspense>
  )
}

function AdminTechPageInner() {
  const [tab, setTab] = useUrlTab<Tab>('tab', 'specs')
  const [specs, setSpecs] = useState<any[]>([])
  const [rates, setRates] = useState<any[]>([])
  const [fixTiers, setFixTiers] = useState<any[]>([])
  const [qualTiers, setQualTiers] = useState<any[]>([])
  const [fundTiers, setFundTiers] = useState<any[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    api.adminTech.specialists().then((r: any) => setSpecs(r.specialists || [])).catch(() => {})
    api.adminTech.rates().then((r: any) => {
      setRates(r.rates || [])
      setFixTiers(r.fix_tiers || [])
      setQualTiers(r.qualification_tiers || [])
      setFundTiers(r.fund_tiers || [])
    }).catch(() => {})
  }, [tick])

  return (
    <div className="p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">Тех-специалисты</h1>
      <p className="mb-5 text-sm text-gray-500">
        Внедренцы: кто есть, кто кого ведёт и сколько кому причитается.
      </p>

      <div className="mb-5 flex gap-2">
        {([['specs', 'Люди'], ['assign', 'Клиенты'],
           ['rates', 'Ставки и вилки'], ['bonus', 'Премии'],
           ['dialogs', 'Диалоги бота'],
           ['money', 'Начисления']] as [Tab, string][]).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                    tab === id ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'specs' && <SpecsTab specs={specs} rates={rates}
                                    onChange={() => setTick(t => t + 1)} />}
      {tab === 'assign' && <AssignTab specs={specs} onChange={() => setTick(t => t + 1)} />}
      {tab === 'rates' && <RatesTab rates={rates} fixTiers={fixTiers}
                                    qualTiers={qualTiers}
                                    onChange={() => setTick(t => t + 1)} />}
      {tab === 'bonus' && <BonusTab fundTiers={fundTiers}
                                    onChange={() => setTick(t => t + 1)} />}
      {tab === 'dialogs' && <DialogsTab specs={specs} />}
      {tab === 'money' && <MoneyTab specs={specs} />}
    </div>
  )
}

// ── Люди и ставки ────────────────────────────────────────────────────────
function SpecsTab({ specs, rates, onChange }: any) {
  const [form, setForm] = useState({ email: '', name: '', telegram_username: '' })
  const [created, setCreated] = useState<any>(null)

  async function add() {
    if (!form.email.trim()) return
    try {
      const r: any = await api.adminTech.createSpec(form)
      // ⚠️ Пароль показываем ОДИН раз: он больше нигде не хранится в открытом
      // виде. Забыли — сбросить, а не «посмотреть».
      setCreated(r)
      setForm({ email: '', name: '', telegram_username: '' })
      onChange()
    } catch (e: any) { alert(e?.message || 'Не удалось') }
  }

  async function reset(id: number) {
    if (!confirm('Выдать новый пароль? Старый перестанет работать.')) return
    try { setCreated(await api.adminTech.resetPassword(id)) }
    catch (e: any) { alert(e?.message || 'Не удалось') }
  }

  return (
    <div className="space-y-5">
      {created && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="text-sm font-semibold text-amber-900">
            Пароль для {created.email}
          </div>
          <div className="mt-1 font-mono text-lg text-amber-900">{created.password}</div>
          <div className="mt-1 text-xs text-amber-800/80">
            Передайте его человеку — второй раз он не покажется. Вход: /tech/login
          </div>
          <button onClick={() => setCreated(null)}
                  className="mt-2 text-xs text-amber-900 underline">Скрыть</button>
        </div>
      )}

      <div className="rounded-xl bg-white p-4 shadow-sm">
        <div className="mb-3 text-sm font-semibold text-gray-800">Добавить внедренца</div>
        <div className="flex flex-wrap gap-2">
          <input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
                 placeholder="Почта" className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                 placeholder="Имя" className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <input value={form.telegram_username}
                 onChange={e => setForm({ ...form, telegram_username: e.target.value })}
                 placeholder="Telegram" className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <button onClick={add} className="btn-gold px-5 py-2 text-sm">Добавить</button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs text-gray-500">
            <tr>
              <th className="px-4 py-3">Человек</th>
              <th className="px-4 py-3">Клиентов</th>
              <th className="px-4 py-3">Платят</th>
              <th className="px-4 py-3">К выплате</th>
              <th className="px-4 py-3">Материалы</th>
              <th className="px-4 py-3">Работает</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {specs.map((s: any) => (
              <tr key={s.id} className="border-b border-gray-50 last:border-0">
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{s.name || s.email}</div>
                  <div className="text-xs text-gray-400">{s.email}</div>
                </td>
                <td className="px-4 py-3">{s.clients_count}</td>
                <td className="px-4 py-3">{s.paying_count}</td>
                <td className="px-4 py-3 font-medium">{rub(s.unpaid_kopecks)}</td>
                <td className="px-4 py-3">
                  {/* Право править материалы Коллабораторной: их видят все
                      купившие модуль, поэтому даётся поимённо. */}
                  <input type="checkbox" checked={!!s.can_edit_materials}
                         onChange={async e => {
                           await api.adminTech.updateSpec(s.id, { can_edit_materials: e.target.checked })
                           onChange()
                         }} />
                </td>
                <td className="px-4 py-3">
                  <input type="checkbox" checked={!!s.is_active}
                         onChange={async e => {
                           await api.adminTech.updateSpec(s.id, { is_active: e.target.checked })
                           onChange()
                         }} />
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => reset(s.id)}
                          className="text-xs text-[#25455D] underline">новый пароль</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  )
}

// ── Премии ───────────────────────────────────────────────────────────────
/** Вкладка «Премии»: условия на квартал, ступени фонда, ввод прибыли, история.
 *
 * ⚠️⚠️ ПОНЯТИЯ «ДОЛЯ ДОЖИВШИХ» В СИСТЕМЕ НЕТ. Премия считается от ПРИБЫЛИ
 * компании по ступеням (лист «2. Ставки и KPI», блок «ПРЕМИАЛЬНЫЙ ФОНД»).
 * Прежний экран показывал долю доживших — это осталось от старой версии
 * таблицы и вводило в заблуждение.
 */
function BonusTab({ fundTiers, onChange }: any) {
  return (
    <div className="space-y-4">
      <QuarterReqBlock />

      {/* ⚠️ Ступени фонда — процент от ПРИБЫЛИ компании за квартал. */}
      <TierEditor kind="fund" tiers={fundTiers} rangeInKopecks
                  title="Премиальный фонд — процент от прибыли компании"
                  fromLabel="Прибыль за квартал, ₽" unit="%"
                  hint="Владелец вводит прибыль за квартал — платформа сама берёт ступень и считает фонд."
                  onChange={onChange} />

      <BonusFundBlock />
    </div>
  )
}


// ── Ставки и вилки ───────────────────────────────────────────────────────
/** Редактор одной вилки: ступени «от — до — значение».
 *
 * ⚠️ Вилки правятся здесь, а не миграцией: лист «2. Ставки и KPI» — единственное
 * место, где меняются цифры, и правка не должна требовать выкатки.
 */
function TierEditor({ kind, tiers, title, hint, fromLabel, unit, money,
                     rangeInKopecks, onChange }: any) {
  const [rows, setRows] = useState<any[]>([])
  useEffect(() => { setRows(tiers || []) }, [tiers])

  // ⚠️⚠️ ГРАНИЦЫ КВАЛИФИКАЦИИ И ФОНДА ЛЕЖАТ В БАЗЕ В КОПЕЙКАХ. Показывать их
  // как есть — значит выводить «10000000» вместо «100 000 ₽»: два лишних нуля,
  // цифры нечитаемы. Делим при показе, умножаем при сохранении.
  const toView = (v: any) => rangeInKopecks ? Math.round(Number(v || 0) / 100) : Number(v || 0)
  const toDb = (v: any) => rangeInKopecks ? Math.round(Number(v || 0) * 100) : Number(v || 0)

  // ⚠️ Разделители разрядов: без них нули сливаются и ошибиться на порядок
  // проще простого.
  const group = (v: any) => Number(v || 0).toLocaleString('ru-RU')

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <div className="mb-1 text-sm font-semibold text-gray-800">{title}</div>
      <p className="mb-3 text-xs text-gray-500">{hint}</p>
      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 text-left text-xs text-gray-500">
          <tr>
            <th className="py-2">{fromLabel} от</th>
            <th className="py-2">до</th>
            <th className="py-2">{money ? '₽/мес' : unit}</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t: any) => (
            <tr key={t.id} className="border-b border-gray-50 last:border-0">
              <td className="py-1.5">
                <input defaultValue={toView(t.clients_from ?? t.turnover_from ?? t.profit_from)}
                       type="number"
                       onBlur={e => { t._from = Number(e.target.value) }}
                       className="w-32 rounded border border-gray-200 px-2 py-1 text-sm" />
                {rangeInKopecks && (
                  <div className="mt-0.5 text-[11px] text-gray-400">
                    {group(toView(t.clients_from ?? t.turnover_from ?? t.profit_from))} ₽
                  </div>
                )}
              </td>
              <td className="py-1.5">
                <input defaultValue={toView(t.clients_to ?? t.turnover_to ?? t.profit_to)}
                       type="number"
                       onBlur={e => { t._to = Number(e.target.value) }}
                       className="w-32 rounded border border-gray-200 px-2 py-1 text-sm" />
                {rangeInKopecks && (
                  <div className="mt-0.5 text-[11px] text-gray-400">
                    {group(toView(t.clients_to ?? t.turnover_to ?? t.profit_to))} ₽
                  </div>
                )}
              </td>
              <td className="py-1.5">
                <input defaultValue={money ? Math.round((t.amount_kopecks || 0) / 100) : Number(t.percent)}
                       type="number" step={money ? 1 : 0.5}
                       onBlur={async e => {
                         const v = Number(e.target.value)
                         try {
                           await api.adminTech.setTier(kind, {
                             id: t.id,
                             range_from: toDb(t._from ?? toView(t.clients_from ?? t.turnover_from ?? t.profit_from)),
                             range_to: toDb(t._to ?? toView(t.clients_to ?? t.turnover_to ?? t.profit_to)),
                             value: v,
                           })
                           onChange?.()
                         } catch (err: any) { alert(err?.message || 'Не удалось сохранить') }
                       }}
                       className="w-28 rounded border border-gray-200 px-2 py-1 text-sm" />
              </td>
              <td className="py-1.5 text-right">
                <button onClick={async () => {
                          if (!confirm('Удалить ступень?')) return
                          await api.adminTech.deleteTier(kind, t.id); onChange?.()
                        }}
                        className="text-xs text-gray-400 hover:text-red-500">удалить</button>
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr><td colSpan={4} className="py-3 text-gray-400">Ступеней нет</td></tr>
          )}
        </tbody>
      </table>
      <button
        onClick={async () => {
          const last = rows[rows.length - 1]
          const from = last
            ? Number(last.clients_to ?? last.turnover_to ?? last.profit_to) + (rangeInKopecks ? 100 : 1)
            : 0
          await api.adminTech.setTier(kind, {
            range_from: from, range_to: from + (rangeInKopecks ? 100 : 1), value: 0 })
          onChange?.()
        }}
        className="mt-2 text-xs text-gray-500 hover:text-gray-800">+ ступень</button>
    </div>
  )
}

/** Одна ставка: поле + кнопка «Сохранить».
 *
 * ⚠️⚠️ БЫЛО СОХРАНЕНИЕ ПО onBlur БЕЗ ОТКЛИКА — и выглядело как «не работает»:
 * человек менял цифру, уходил с поля, никакого подтверждения не появлялось, а
 * ошибка (например, отказ прав) глоталась молча. Теперь явная кнопка, видимый
 * результат и перечитывание списка после записи.
 */
function RateRow({ rate, onChange }: any) {
  const isPercent = rate.of_tariff || String(rate.kind).startsWith('setup')
  const initial = isPercent
    ? String(Number(rate.percent))
    : String(Math.round((rate.amount_kopecks || 0) / 100))
  const [val, setVal] = useState(initial)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => { setVal(initial); setState('idle') }, [initial])

  const dirty = val !== initial

  async function save() {
    setState('saving')
    try {
      await api.adminTech.setRate(rate.kind,
        isPercent ? { percent: Number(val) }
                  : { amount_kopecks: Math.round(Number(val) * 100) })
      setState('saved')
      onChange?.()
    } catch (e: any) {
      setState('error')
      alert(e?.message || 'Не удалось сохранить ставку')
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-[300px] text-sm text-gray-700">
        {KIND[rate.kind] || rate.kind}
      </span>
      <input value={val} onChange={e => { setVal(e.target.value); setState('idle') }}
             type="number" step={isPercent ? '0.5' : '1'}
             onKeyDown={e => { if (e.key === 'Enter' && dirty) save() }}
             className="w-28 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
      <span className="text-sm text-gray-500">
        {isPercent
          ? (String(rate.kind).startsWith('setup') ? '% от чека настройки' : '% от тарифа клиента')
          : '₽'}
      </span>
      {dirty && (
        <button onClick={save} disabled={state === 'saving'}
                className="btn-gold px-3 py-1 text-xs disabled:opacity-50">
          {state === 'saving' ? 'Сохраняю…' : 'Сохранить'}
        </button>
      )}
      {state === 'saved' && !dirty && (
        <span className="text-xs text-green-600">сохранено</span>
      )}
    </div>
  )
}

function RatesTab({ rates, fixTiers, qualTiers, onChange }: any) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-white p-4 shadow-sm">
        <div className="mb-1 text-sm font-semibold text-gray-800">Ставки</div>
        <p className="mb-3 text-xs text-gray-500">
          Поменяйте цифру и нажмите «Сохранить» (или Enter). Новая ставка
          действует вперёд — уже начисленное не пересчитывается.
        </p>
        <div className="space-y-2">
          {sortRates(rates).map((r: any) => (
            <RateRow key={r.kind} rate={r} onChange={onChange} />
          ))}
        </div>
      </div>

      {/* ⚠️ ФИКС — ВИЛКА, А НЕ СУММА ЗА КАЖДОГО: 15–49 клиентов → 4 000 ₽ за
          всех сразу. Умножение на число дало бы на сотне 30 000 вместо 12 000. */}
      <TierEditor kind="fix" tiers={fixTiers} money
                  title="Фикс за обслуживание базы"
                  fromLabel="Клиентов" unit="₽"
                  hint="Считаются только ЧУЖИЕ платящие клиенты: за своих идёт процент. Вилка, а не сумма за каждого."
                  onChange={onChange} />

      {/* ⚠️ КВАЛИФИКАЦИЯ: процент 1-го уровня растёт от оборота сети. Оборот
          сети — ВСЕ действующие клиенты внедренца, и выданные, и приведённые. */}
      <TierEditor kind="qualification" tiers={qualTiers} rangeInKopecks
                  title="Квалификация — процент 1-го уровня от оборота сети"
                  fromLabel="Оборот в месяц, ₽" unit="%"
                  hint="Сеть — все действующие клиенты внедренца: из базы ПЛЮСОН и приведённые им. Чем больше оборот, тем выше его процент."
                  onChange={onChange} />
    </div>
  )
}


// ── Распределение ────────────────────────────────────────────────────────
function AssignTab({ specs, onChange }: any) {
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.adminTech.unassigned()
      .then((r: any) => setItems(r.clients || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function assign(clientId: number, specId: number) {
    try {
      await api.adminTech.assign({ client_id: clientId, spec_id: specId })
      setItems(list => list.filter(i => i.id !== clientId))
      onChange()
    } catch (e: any) { alert(e?.message || 'Не удалось') }
  }

  const active = specs.filter((s: any) => s.is_active)

  if (loading) return <div className="text-sm text-gray-400">Загружаем…</div>

  return (
    <div className="rounded-xl bg-white shadow-sm">
      <div className="border-b border-gray-100 px-4 py-3">
        <div className="text-sm font-semibold text-gray-800">
          Без ответственного — {items.length}
        </div>
        <p className="mt-0.5 text-xs text-gray-500">
          Остывшие показаны наравне с остальными: именно с ними работают ради оживления.
        </p>
      </div>
      {!items.length ? (
        <div className="p-8 text-center text-sm text-gray-500">Все клиенты распределены.</div>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {items.map(c => (
              <tr key={c.id} className="border-b border-gray-50 last:border-0">
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{c.name || 'Без имени'}</div>
                  <div className="text-xs text-gray-400">{c.email}</div>
                </td>
                <td className="px-4 py-3 text-gray-600">{c.tariff_slug || '—'}</td>
                <td className="px-4 py-3 text-gray-600">{c.payments_count} оплат</td>
                <td className="px-4 py-3">
                  <select defaultValue="" onChange={e => e.target.value && assign(c.id, Number(e.target.value))}
                          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
                    <option value="">Кому передать…</option>
                    {active.map((s: any) => (
                      <option key={s.id} value={s.id}>{s.name || s.email}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Начисления ───────────────────────────────────────────────────────────
/** Премиальный фонд за квартал: ввод суммы и раздача по весам.
 *
 * ⚠️ Сумму считает владелец в фин-модели (процент от прибыли компании) и вносит
 * сюда одним числом. Платформа прибыль не знает и знать не должна: в кабинете
 * внедренца её показывать нельзя.
 */
/** Условия допуска к премии на квартал.
 *
 * ⚠️ Задаются на КАЖДЫЙ квартал: условия зависят от плана на период. Требуют
 * свежей работы — оборот внедренца может складываться из старых клиентов,
 * и премия за такое была бы платой за прошлое.
 */
function QuarterReqBlock() {
  const [reqs, setReqs] = useState<any[]>([])
  const [period, setPeriod] = useState('')
  const [base, setBase] = useState('6')
  const [netPl, setNetPl] = useState('3')
  const [netOwn, setNetOwn] = useState('5')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    api.adminTech.quarterReqs()
      .then((r: any) => setReqs(r.requirements || [])).catch(() => {})
  }, [tick])

  useEffect(() => {
    if (period) return
    const d = new Date()
    setPeriod(`${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`)
  }, [period])

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <h3 className="mb-1 text-sm font-semibold text-gray-900">Условия премии на квартал</h3>
      <p className="mb-3 text-xs text-gray-500">
        Активаций в месяц. Тип Б — только клиенты ПЛЮСОНА. Тип В — и от ПЛЮСОНА,
        и свои приведённые. Не выполнил — в дележе фонда не участвует.
      </p>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-500">Квартал<br />
          <input value={period} onChange={e => setPeriod(e.target.value)}
                 className="mt-1 w-24 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-500">Тип Б: от ПЛЮСОНА<br />
          <input value={base} onChange={e => setBase(e.target.value)} inputMode="numeric"
                 className="mt-1 w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-500">Тип В: от ПЛЮСОНА<br />
          <input value={netPl} onChange={e => setNetPl(e.target.value)} inputMode="numeric"
                 className="mt-1 w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-500">Тип В: своих<br />
          <input value={netOwn} onChange={e => setNetOwn(e.target.value)} inputMode="numeric"
                 className="mt-1 w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <button
          onClick={async () => {
            try {
              await api.adminTech.setQuarterReq({
                period,
                base_from_pluson: Number(base) || 0,
                network_from_pluson: Number(netPl) || 0,
                network_own: Number(netOwn) || 0,
              })
              setTick(t => t + 1)
            } catch (e: any) { alert(e?.message || 'Не вышло') }
          }}
          className="btn-primary px-4 py-1.5 text-sm">Сохранить</button>
      </div>

      {/* ⚠️ Коэффициенты — вес в дележе фонда. Шкала 1–10, сумма значения не
          имеет: доля = вес человека / сумма весов допущенных. */}
      <div className="mb-4 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
        <b>Коэффициенты в премии:</b> тип В (со своей сетью) — 9,
        тип Б (клиенты ПЛЮСОН) — 7. Шкала 1–10, важны пропорции, а не сумма.
        Тип присваивается автоматически по числу своих активаций в месяц.
      </div>

      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 text-left text-xs text-gray-500">
          <tr>
            <th className="py-2">Квартал</th>
            <th className="py-2">Тип Б</th>
            <th className="py-2">Тип В</th>
          </tr>
        </thead>
        <tbody>
          {reqs.map((r: any) => (
            <tr key={r.period} className="border-b border-gray-50">
              <td className="py-2 font-medium text-gray-900">{r.period}</td>
              <td className="py-2">{r.base_from_pluson} от ПЛЮСОНА</td>
              <td className="py-2">
                {r.network_from_pluson} от ПЛЮСОНА + {r.network_own} своих
              </td>
            </tr>
          ))}
          {!reqs.length && (
            <tr><td colSpan={3} className="py-3 text-gray-400">Условия не заданы</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function BonusFundBlock() {
  const [funds, setFunds] = useState<any[]>([])
  const [weights, setWeights] = useState<any[]>([])
  const [period, setPeriod] = useState('')
  const [rubles, setRubles] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    api.adminTech.bonusFunds().then((r: any) => {
      setFunds(r.funds || []); setWeights(r.weights || [])
    }).catch(() => {})
  }, [tick])

  // Квартал по умолчанию — предыдущий: премия считается после его закрытия.
  useEffect(() => {
    if (period) return
    const d = new Date()
    const q = Math.floor(d.getMonth() / 3)
    const [y, qq] = q === 0 ? [d.getFullYear() - 1, 4] : [d.getFullYear(), q]
    setPeriod(`${y}-Q${qq}`)
  }, [period])

  const totalWeight = weights.reduce((s, w) => s + Number(w.weight || 0), 0)

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <h3 className="mb-1 text-sm font-semibold text-gray-900">
        Фонд за квартал и история
      </h3>
      <p className="mb-3 text-xs text-gray-500">
        Введите прибыль компании за квартал — платформа возьмёт процент из вилки
        выше, посчитает фонд и разделит его между внедренцами по весам ролей.
        История ниже: видно, за какой период сколько было и роздано ли.
      </p>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-500">Квартал<br />
          <input value={period} onChange={e => setPeriod(e.target.value)}
                 placeholder="2026-Q1"
                 className="mt-1 w-28 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-500">Прибыль за квартал, ₽<br />
          <input value={rubles} onChange={e => setRubles(e.target.value)}
                 placeholder="напр. 800000" inputMode="numeric"
                 className="mt-1 w-40 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
        </label>
        <button
          onClick={async () => {
            const v = Math.round(Number(rubles.replace(/\s/g, '')) * 100)
            if (!v || v <= 0) { alert('Введите прибыль за квартал'); return }
            try {
              // ⚠️ Отдаём ПРИБЫЛЬ — процент платформа возьмёт из вилки сама.
              await api.adminTech.setBonusFund({ period, profit_kopecks: v })
              setRubles(''); setTick(t => t + 1)
            } catch (e: any) { alert(e?.message || 'Не вышло') }
          }}
          className="btn-primary px-4 py-1.5 text-sm">Посчитать фонд</button>
      </div>

      {!!weights.length && (
        <div className="mb-4 text-xs text-gray-600">
          Веса: {weights.map((w: any) =>
            `${w.note || w.role} — ${Number(w.weight)}`).join(' · ')}
          {totalWeight > 0 && <> (сумма {totalWeight})</>}
        </div>
      )}

      <table className="w-full text-sm">
        <thead className="border-b border-gray-100 text-left text-xs text-gray-500">
          <tr>
            <th className="py-2">Квартал</th><th className="py-2">Прибыль</th>
            <th className="py-2">%</th><th className="py-2">Фонд</th>
            <th className="py-2">Статус</th><th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {funds.map((f: any) => (
            <tr key={f.period} className="border-b border-gray-50">
              <td className="py-2 font-medium text-gray-900">{f.period}</td>
              <td className="py-2 text-gray-600">
                {f.profit_kopecks ? rub(f.profit_kopecks) : '—'}
              </td>
              <td className="py-2 text-gray-600">
                {f.percent ? `${Number(f.percent)}%` : '—'}
              </td>
              <td className="py-2 font-medium">{rub(f.amount_kopecks)}</td>
              <td className="py-2 text-gray-500">
                {f.distributed_at ? 'роздан' : 'ждёт раздачи'}
              </td>
              <td className="py-2 text-right">
                {!f.distributed_at && (
                  <button
                    onClick={async () => {
                      if (!confirm(`Раздать ${rub(f.amount_kopecks)} за ${f.period}?`)) return
                      try {
                        const r: any = await api.adminTech.distributeFund(f.period)
                        alert(`Начислено: ${r.accrued}`)
                        setTick(t => t + 1)
                      } catch (e: any) { alert(e?.message || 'Не вышло') }
                    }}
                    className="btn-gold px-3 py-1 text-xs">Раздать</button>
                )}
              </td>
            </tr>
          ))}
          {!funds.length && (
            <tr><td colSpan={6} className="py-3 text-gray-400">Фондов пока нет</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function MoneyTab({ specs }: any) {
  const [items, setItems] = useState<any[]>([])
  const [unpaidOnly, setUnpaidOnly] = useState(true)
  const [specId, setSpecId] = useState<number | ''>('')
  const [sel, setSel] = useState<number[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    api.adminTech.accruals({
      unpaid: unpaidOnly || undefined,
      spec_id: specId ? Number(specId) : undefined,
    }).then((r: any) => { setItems(r.accruals || []); setSel([]) }).catch(() => {})
  }, [unpaidOnly, specId, tick])

  const total = items.filter(i => sel.includes(i.id))
    .reduce((s, i) => s + (i.amount_kopecks || 0), 0)

  return (
    <div className="space-y-4">
      <QuarterReqBlock />
      <BonusFundBlock />

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={unpaidOnly}
                 onChange={e => setUnpaidOnly(e.target.checked)} />
          Только невыплаченные
        </label>
        <select value={specId} onChange={e => setSpecId(e.target.value ? Number(e.target.value) : '')}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
          <option value="">Все специалисты</option>
          {specs.map((s: any) => <option key={s.id} value={s.id}>{s.name || s.email}</option>)}
        </select>
        {!!sel.length && (
          <button
            onClick={async () => {
              // ⚠️ Это ОТМЕТКА, а не перевод денег: платит владелец сам,
              // платформа только ведёт учёт.
              if (!confirm(`Отметить выплаченными ${sel.length} на ${rub(total)}?`)) return
              await api.adminTech.markPaid(sel)
              setTick(t => t + 1)
            }}
            className="btn-gold px-4 py-2 text-sm">
            Отметить выплаченными — {rub(total)}
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs text-gray-500">
            <tr>
              <th className="px-4 py-3 w-8"></th>
              <th className="px-4 py-3">Дата</th>
              <th className="px-4 py-3">Кому</th>
              <th className="px-4 py-3">За что</th>
              <th className="px-4 py-3">Клиент</th>
              <th className="px-4 py-3">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {items.map(a => (
              <tr key={a.id} className="border-b border-gray-50 last:border-0">
                <td className="px-4 py-3">
                  {!a.paid_at && (
                    <input type="checkbox" checked={sel.includes(a.id)}
                           onChange={e => setSel(s => e.target.checked
                             ? [...s, a.id] : s.filter(x => x !== a.id))} />
                  )}
                </td>
                <td className="px-4 py-3 text-gray-600">
                  {new Date(a.created_at).toLocaleDateString('ru-RU')}
                </td>
                <td className="px-4 py-3">{a.spec_name}</td>
                <td className="px-4 py-3">
                  {KIND[a.kind]?.split(' (')[0] || a.kind}
                  {a.note && <div className="text-xs text-gray-400">{a.note}</div>}
                </td>
                <td className="px-4 py-3 text-gray-600">{a.client_name || '—'}</td>
                <td className="px-4 py-3 font-medium">
                  {rub(a.amount_kopecks)}
                  {a.paid_at && <div className="text-xs text-green-600">выплачено</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}


// ── Диалоги бота ─────────────────────────────────────────────────────────
// ⚠️ Распределяются ОТДЕЛЬНО от клиентов: в @pluson_bot пишут и те, кто
// клиентом ещё не стал, — в списке клиентов платформы их попросту нет.
function DialogsTab({ specs }: any) {
  const [items, setItems] = useState<any[]>([])
  const [onlyFree, setOnlyFree] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    api.adminTech.botDialogs(onlyFree || undefined)
      .then((r: any) => setItems(r.dialogs || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(load, [onlyFree])

  async function assign(contactId: number, specId: number | null) {
    try {
      await api.adminTech.assignDialog({ contact_id: contactId, spec_id: specId })
      load()
    } catch (e: any) { alert(e?.message || 'Не удалось') }
  }

  const active = specs.filter((s: any) => s.is_active)

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={onlyFree}
               onChange={e => setOnlyFree(e.target.checked)} />
        Только нераспределённые
      </label>

      {loading ? <div className="text-sm text-gray-400">Загружаем…</div> : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 text-left text-xs text-gray-500">
              <tr>
                <th className="px-4 py-3">Человек</th>
                <th className="px-4 py-3">Последнее</th>
                <th className="px-4 py-3">Не прочитано</th>
                <th className="px-4 py-3">Ответственный</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d: any) => (
                <tr key={d.contact_id} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {d.name || 'Без имени'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {d.last_at ? new Date(d.last_at).toLocaleDateString('ru-RU') : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {d.unread > 0
                      ? <span className="rounded-full bg-[#FFCFA4] px-2 text-xs font-bold text-[#0a1520]">{d.unread}</span>
                      : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <select value={d.spec_id || ''}
                            onChange={e => assign(d.contact_id, e.target.value ? Number(e.target.value) : null)}
                            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
                      <option value="">— никому —</option>
                      {active.map((s: any) => (
                        <option key={s.id} value={s.id}>{s.name || s.email}</option>
                      ))}
                    </select>
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
