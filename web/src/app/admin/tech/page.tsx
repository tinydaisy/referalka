'use client'

/**
 * Админ: тех-специалисты — люди, ставки, распределение клиентов, выплаты.
 *
 * ⚠️ Распределение здесь, а не в кабинете внедренца: кому кого вести — решение
 * владельца. Иначе специалист набирал бы себе платящих и обходил остывших.
 */
import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { useUrlTab } from '@/hooks/useUrlTab'
import { api } from '@/lib/api'
import TechFaqScreen from '@/components/TechFaqScreen'

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

type Tab = 'specs' | 'assign' | 'dialogs' | 'rates' | 'bonus' | 'money' | 'faq'


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
      <p className="mb-4 text-sm text-gray-500">
        Внедренцы: кто есть, кто кого ведёт и сколько кому причитается.
      </p>

      {/* Адрес входа в кабинет внедренца. Он нужен каждый раз, когда заводят
          нового человека — а искать его было негде: кабинет живёт на своём
          разделе, из админки туда ссылки не было вовсе. */}
      <TechLoginLink />

      <div className="mb-5 flex gap-2">
        {([['specs', 'Люди'], ['assign', 'Клиенты'],
           ['rates', 'Ставки и вилки'], ['bonus', 'Премии'],
           ['dialogs', 'Диалоги бота'],
           ['money', 'Начисления'],
           ['faq', 'Частые вопросы']] as [Tab, string][]).map(([id, label]) => (
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
      {/* ⚠️ Экран ОБЩИЙ с кабинетом внедренца: база вопросов одна на всех,
          отличается только набор методов (`adminFaq` против `techFaq`). */}
      {tab === 'faq' && <TechFaqScreen api={api.adminFaq} />}
    </div>
  )
}

/**
 * Адрес входа в кабинет внедренца — под рукой, с кнопкой «скопировать».
 *
 * ⚠️ Адрес строится от ТЕКУЩЕГО домена (`window.location.origin`), а не зашит
 * строкой «pluson.ru»: тот же экран открывают на dev-сервере, и зашитый прод
 * отправил бы человека не туда. На сервере рендера `window` нет — до первой
 * отрисовки в браузере показываем относительный путь.
 */
function TechLoginLink() {
  const [origin, setOrigin] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => { setOrigin(window.location.origin) }, [])

  const url = `${origin}/tech/login`

  return (
    <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-700">
          Вход в кабинет внедренца
        </div>
        <a href="/tech/login" target="_blank" rel="noreferrer"
           className="text-sm font-mono underline" style={{ color: '#25455D' }}>
          {url || '/tech/login'}
        </a>
        <div className="mt-0.5 text-xs text-gray-400">
          Отправьте эту ссылку человеку — входит он почтой и паролем своего
          кабинета клиента, отдельный пароль выдавать не нужно.
        </div>
      </div>
      <button onClick={() => {
                navigator.clipboard?.writeText(url)
                setCopied(true)
                setTimeout(() => setCopied(false), 1800)
              }}
              className="ml-auto rounded-lg bg-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-300">
        {copied ? 'Скопировано' : 'Скопировать'}
      </button>
    </div>
  )
}

// ── Люди и ставки ────────────────────────────────────────────────────────
function SpecsTab({ specs, rates, onChange }: any) {
  // ⚠️⚠️ ВНЕДРЕНЦА ВЫБИРАЮТ ИЗ КЛИЕНТОВ (миграция 486), а не вводят почтой:
  // внедренец — роль клиента, и почта с паролем у человека уже есть.
  const [q, setQ] = useState('')
  const [found, setFound] = useState<any[]>([])
  const [picked, setPicked] = useState<any>(null)
  const [searching, setSearching] = useState(false)
  const [created, setCreated] = useState<any>(null)

  // ⚠️ Переиспользуем ГОТОВЫЙ поиск клиентов от персональных заказов, а не
  // заводим второй: разные поиски по одной сущности разъезжаются в правилах.
  async function search() {
    const term = q.trim()
    if (term.length < 2) { setFound([]); return }
    setSearching(true)
    try { setFound((await api.customOrders.searchClients(term))?.clients || []) }
    catch { setFound([]) }
    finally { setSearching(false) }
  }

  async function add() {
    if (!picked) return
    try {
      const r: any = await api.adminTech.createSpec({ client_id: picked.id })
      setCreated(r)
      setPicked(null); setQ(''); setFound([])
      onChange()
    } catch (e: any) { alert(e?.message || 'Не удалось') }
  }

  /**
   * Уволить — закрыть кабинет, оставив всё остальное.
   *
   * ⚠️ Это НЕ удаление: история начислений, закреплённые клиенты и проценты
   * остаются на месте, человек просто не может войти. Обратимо кнопкой
   * «вернуть».
   */
  async function fire(s: any) {
    const back = !s.is_active
    if (!confirm(back
      ? `Вернуть ${s.name || s.email} к работе? Он снова сможет войти в кабинет внедренца.`
      : `Уволить ${s.name || s.email}?\n\n`
        + `Кабинет ВНЕДРЕНЦА закроется, а его кабинет КЛИЕНТА останется — туда он `
        + `заходит как обычно.\n\n`
        + `Если подписку на кабинет ему подарили, она закроется сегодня же. `
        + `Оплаченную своими деньгами не тронем.\n\n`
        + `История начислений и клиенты останутся. Решение обратимо.`)) return
    try {
      const r: any = await api.adminTech.updateSpec(s.id, { is_active: back })
      if (r?.closed_subscription) {
        alert('Уволен. Подаренная подписка на его кабинет закрыта сегодняшним днём.')
      }
      onChange()
    } catch (e: any) { alert(e?.message || 'Не удалось') }
  }

  /**
   * Удалить насовсем.
   *
   * ⚠️⚠️ У начислений ON DELETE CASCADE — вместе с человеком уходит ВСЯ его
   * история выплат, и восстановить её нечем. Поэтому сервер при наличии
   * начислений отвечает 409 и их числом; здесь мы показываем это человеческим
   * текстом и требуем второго, осознанного подтверждения.
   */
  async function remove(s: any) {
    const who = s.name || s.email
    if (!confirm(`Снять с ${who} роль внедренца насовсем?\n\n`
                 + `Кабинет клиента, его база и подписка останутся — уйдёт только `
                 + `внедренчество.\n\nЕсли нужно просто закрыть доступ — лучше `
                 + `«уволить»: история начислений сохранится.`)) return
    try {
      const r = await api.adminTech.deleteSpec(s.id)
      alert(r.freed_clients
        ? `Удалён. Клиентов освободилось: ${r.freed_clients} — раздайте их заново.`
        : 'Удалён.')
      onChange()
      return
    } catch (e: any) {
      // 409 с разбором: у человека есть начисления.
      const d = e?.detail || e?.data?.detail
      if (d?.error !== 'has_accruals') {
        alert(e?.message || 'Не удалось удалить')
        return
      }
      const sum = rub(d.total_kopecks)
      if (!confirm(`У ${who} ${d.accruals} начислений на ${sum}.\n\n`
                   + `Удаление СОТРЁТ всю историю выплат — восстановить её будет `
                   + `нечем. Точно удалять?\n\nОтмена — оставить и уволить.`)) return
      try {
        const r = await api.adminTech.deleteSpec(s.id, true)
        alert(`Удалён вместе с историей (${r.deleted_accruals} начислений).`
              + (r.freed_clients ? ` Клиентов освободилось: ${r.freed_clients}.` : ''))
        onChange()
      } catch (e2: any) { alert(e2?.message || 'Не удалось удалить') }
    }
  }

  return (
    <div className="space-y-5">
      {created && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="text-sm font-semibold text-emerald-900">
            {created.name || created.email} теперь внедренец
          </div>
          <div className="mt-1 text-xs text-emerald-800/80">
            Пароль выдавать не нужно — он входит на /tech/login почтой и паролем
            своего кабинета клиента ({created.email}).
          </div>
          <button onClick={() => setCreated(null)}
                  className="mt-2 text-xs text-emerald-900 underline">Скрыть</button>
        </div>
      )}

      <div className="rounded-xl bg-white p-4 shadow-sm">
        <div className="mb-1 text-sm font-semibold text-gray-800">Добавить внедренца</div>
        <div className="mb-3 text-xs text-gray-500">
          Выберите клиента — его кабинет станет рабочим инструментом внедренца.
          Отдельный пароль не нужен: он входит своим клиентским.
        </div>

        {picked ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex-1 rounded-lg border-2 border-[#25455D]/20 px-3 py-2 text-sm">
              <span className="font-medium text-gray-900">{picked.name}</span>
              <span className="ml-2 text-xs text-gray-400">{picked.email}</span>
            </div>
            <button onClick={() => setPicked(null)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600">
              Другой
            </button>
            <button onClick={add} className="btn-gold px-5 py-2 text-sm">
              Сделать внедренцем
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <input
                value={q}
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') search() }}
                placeholder="Имя, почта или бренд клиента"
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <button onClick={search} disabled={q.trim().length < 2}
                      className="btn-primary px-5 py-2 text-sm disabled:opacity-40">
                {searching ? 'Ищем…' : 'Найти'}
              </button>
            </div>

            {found.length > 0 && (
              <div className="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-200">
                {found.map((c: any) => (
                  <button key={c.id} onClick={() => { setPicked(c); setFound([]) }}
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50">
                    <span className="font-medium text-gray-900">{c.name}</span>
                    <span className="ml-2 text-xs text-gray-400">{c.email}</span>
                  </button>
                ))}
              </div>
            )}

            {!searching && q.trim().length >= 2 && found.length === 0 && (
              <div className="mt-2 text-xs text-gray-500">
                Никого не нашли. Внедренцем можно сделать только того, у кого уже
                есть кабинет клиента.
              </div>
            )}
          </>
        )}
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
              {/* Право удалять из общей базы частых вопросов (миграция 461). */}
              <th className="px-4 py-3">Удаление<br />вопросов</th>
              <th className="px-4 py-3">Работает</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {specs.map((s: any) => (
              <tr key={s.id} className="border-b border-gray-50 last:border-0">
                <td className="px-4 py-3">
                  {/* ⚠️ Имя — ССЫЛКА в сводную CRM с фильтром по этому
                      человеку: «зайти во внедренца» значит увидеть его
                      клиентов, а не открыть окно с настройками. Отдельная
                      страница, а не модалка: у окна нет адреса, его не дать
                      ссылкой и из него не вернуться назад. */}
                  <Link href={`/admin/tech/clients?spec=${s.id}`}
                        className="font-medium text-gray-900 underline decoration-gray-300 underline-offset-2 hover:decoration-gray-600">
                    {s.name || s.email}
                  </Link>
                  <div className="text-xs text-gray-400">{s.email}</div>
                  {/* ⚠️ ДВЕ ссылки, потому что это два разных вопроса:
                      «что у его клиентов есть» и «где они в воронке». */}
                  <div className="mt-1 flex gap-2 text-[11px]">
                    <Link href={`/admin/tech/clients?spec=${s.id}`}
                          className="text-gray-500 underline decoration-gray-300 hover:text-gray-800">
                      клиенты
                    </Link>
                    <Link href={`/admin/tech/crm?spec=${s.id}`}
                          className="text-gray-500 underline decoration-gray-300 hover:text-gray-800">
                      CRM
                    </Link>
                  </div>
                </td>
                <td className="px-4 py-3">
                  {/* Число клиентов — тоже вход в его срез: по нему кликают
                      чаще всего, когда хотят «посмотреть, кого он ведёт». */}
                  <Link href={`/admin/tech/clients?spec=${s.id}`}
                        className="underline decoration-gray-300 underline-offset-2 hover:decoration-gray-600">
                    {s.clients_count}
                  </Link>
                </td>
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
                  {/* ⚠️ Удаление вопроса убирает ответ у ВСЕХ сразу: база
                      общая. Добавлять и править может каждый, удалять — только
                      с этой галочкой (решение владельца 19.09.2026). */}
                  <input type="checkbox" checked={!!s.can_delete_faq}
                         title="Может удалять вопросы из общей базы"
                         onChange={async e => {
                           await api.adminTech.updateSpec(s.id, { can_delete_faq: e.target.checked })
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
                  <div className="flex flex-wrap items-center gap-3">
                    {/* ⚠️ Кнопки «новый пароль» здесь БОЛЬШЕ НЕТ (миграция 486):
                        своего пароля у внедренца не существует, он входит
                        клиентским и восстанавливает его сам на /password-reset. */}
                    {/* Уволить — тот же `is_active`, что и галочка «Работает»,
                        но названный словом: галочку не читают как увольнение. */}
                    <button onClick={() => fire(s)}
                            className="text-xs text-gray-500 underline">
                      {s.is_active ? 'уволить' : 'вернуть'}
                    </button>
                    <button onClick={() => remove(s)}
                            className="text-xs text-red-600 underline">удалить</button>
                  </div>
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
  // ⚠️⚠️ ПЕРЕЗАКРЕПЛЕНИЕ (18.09.2026). Раньше экран умел ровно одно — раздать
  // клиентов, у которых ответственного ещё нет. Уже закреплённого передать
  // другому было НЕЛЬЗЯ: список его не показывал, хотя движок это умел.
  // Административные решения бывают разные — внедренец уволился, ушёл в
  // отпуск, клиента забрали, — и передавать надо в любой момент.
  const [scope, setScope] = useState<'free' | 'busy' | 'all'>('free')
  const [q, setQ] = useState('')
  // ⚠️⚠️ СТРАНИЦЫ ПО 50 (23.09.2026). Раньше сервер отдавал до 500 строк без
  // смещения: на тысяче клиентов вторая половина была недостижима — ни
  // прокруткой, ни поиском. `total` нужен, чтобы стрелка «вперёд» знала, где
  // конец, а человек видел, сколько всего нашлось.
  const PAGE = 50
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)

  // ⚠️ Смена поиска или среза возвращает на первую страницу: иначе человек
  // ищет и попадает в пустоту — на 7-ю страницу списка из трёх строк.
  useEffect(() => { setOffset(0) }, [scope, q])

  // ⚠️ Поиск с задержкой: без неё запрос уходит на каждую букву.
  useEffect(() => {
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      api.adminTech.unassigned({ scope, q, limit: PAGE, offset })
        .then((r: any) => {
          if (!alive) return
          setItems(r.clients || [])
          setTotal(r.total ?? (r.clients || []).length)
        })
        .catch(() => { if (alive) { setItems([]); setTotal(0) } })
        .finally(() => { if (alive) setLoading(false) })
    }, q ? 350 : 0)
    return () => { alive = false; clearTimeout(t) }
  }, [scope, q, offset])

  async function assign(clientId: number, specId: number | null) {
    const c = items.find(i => i.id === clientId)
    // ⚠️ У ЗАКРЕПЛЁННОГО спрашиваем подтверждение: это уже не раздача, а
    // отъём клиента у живого человека — вместе с фиксом за обслуживание.
    if (c?.tech_specialist_id) {
      const to = specId ? (specs.find((s: any) => s.id === specId)?.name || 'другого') : null
      const msg = specId
        ? `Передать «${c.name || c.email}» от ${c.owner_name} к ${to}?\n\n`
          + 'Фикс за обслуживание с этого момента пойдёт новому. Уже начисленное '
          + 'прежнему остаётся — оно за сделанную работу.'
        : `Снять «${c.name || c.email}» с ${c.owner_name}?\n\nКлиент останется без ответственного.`
      if (!confirm(msg)) return
    }
    try {
      await api.adminTech.assign({ client_id: clientId, spec_id: specId })
      // ⚠️ Перечитываем СПИСОК, а не вычёркиваем строку на глаз: при
      // перезакреплении клиент из списка не исчезает, у него меняется
      // ответственный. Раньше строку убирали сразу после ответа — и экран
      // показывал успех даже тогда, когда передача падала с 500.
      const r: any = await api.adminTech.unassigned({ scope, q, limit: PAGE, offset })
      setItems(r.clients || [])
      setTotal(r.total ?? (r.clients || []).length)
      onChange()
    } catch (e: any) { alert(e?.message || 'Не удалось') }
  }

  // ⚠️ В выпадающем списке ТОЛЬКО те, кто берёт новых клиентов. Раньше фильтр
  // был лишь по `is_active`, а сервер требует ещё и `takes_clients` (отпуск,
  // перегруз) — человек в отпуске был виден в списке, но передача на него
  // отклонялась с 400. Со стороны это выглядит как «выбрал, а ничего не
  // произошло»: список и проверка обязаны совпадать.
  const active = specs.filter((s: any) => s.is_active && s.takes_clients)

  // ⚠️ Раннего `return` при загрузке НЕТ: он снёс бы поле поиска вместе с
  // фокусом, и набрать фразу целиком стало бы невозможно — каждая буква
  // перерисовывала бы экран. Состояние загрузки показываем строкой в шапке.
  return (
    <div className="rounded-xl bg-white shadow-sm">
      <div className="border-b border-gray-100 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {([['free', 'Без ответственного'], ['busy', 'Закреплённые'], ['all', 'Все']] as const)
            .map(([v, label]) => (
              <button key={v} type="button" onClick={() => setScope(v)}
                      className={`rounded-lg px-3 py-1.5 text-sm ${scope === v
                        ? 'bg-gray-900 text-white'
                        : 'border border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
                {label}
              </button>
            ))}
          {/* ⚠️ В подписи перечислены ВСЕ поля, по которым ищет сервер, —
              имя, фамилия, почта, телеграм. Неполный список читается как
              ограничение: по фамилии не искали, считая, что она не найдётся. */}
          <input value={q} onChange={e => setQ(e.target.value)}
                 placeholder="Поиск: имя, фамилия, почта, телеграм"
                 className="min-w-[220px] flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
        </div>
        {/* ⚠️ Показываем НАЙДЕНО ВСЕГО, а не длину страницы: строк на экране
            всегда 50, и по ним не понять, три человека нашлись или триста. */}
        <div className="mt-2 text-sm font-semibold text-gray-800">
          {loading ? 'Загружаем…'
            : total > items.length
              ? `Найдено — ${total}, показаны ${offset + 1}–${Math.min(offset + PAGE, total)}`
              : `Показано — ${items.length}`}
        </div>
        <p className="mt-0.5 text-xs text-gray-500">
          Остывшие показаны наравне с остальными: именно с ними работают ради оживления.
        </p>
        <p className="mt-1 text-xs text-gray-500">
          Передача отдаёт новому <b>фикс за обслуживание</b>. 10 % за приведённого
          клиента остаются у того, кто его привёл, — они не переезжают.
        </p>
      </div>
      {!items.length ? (
        <div className="p-8 text-center text-sm text-gray-500">
          {q ? 'Никого не нашли — попробуйте другой запрос.'
             : scope === 'free' ? 'Все клиенты распределены.'
             : 'Пока никого нет.'}
        </div>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {items.map(c => (
              <tr key={c.id} className="border-b border-gray-50 last:border-0">
                <td className="px-4 py-3">
                  {/* ⚠️ Имя И ФАМИЛИЯ: у клиента они лежат раздельно, и одного
                      имени мало — в списке из тысячи человек «Ирина» ничего не
                      говорит, а искать по фамилии и не видеть её странно. */}
                  <div className="font-medium text-gray-900">
                    {[c.name, c.last_name].filter(Boolean).join(' ') || 'Без имени'}
                  </div>
                  <div className="text-xs text-gray-400">{c.email}</div>
                  {/* ⚠️ Кому идут 10 % — видно ПРЯМО В СТРОКЕ, рядом с выбором
                      нового ответственного: это разные люди и разные деньги. */}
                  <div className="mt-0.5 text-xs text-gray-500">
                    {c.referred_by_name
                      ? <>Привёл: <b>{c.referred_by_name}</b> — ему 10 %</>
                      : <span className="text-gray-400">Никто не приводил — 10 % никому</span>}
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-600">{c.tariff_slug || '—'}</td>
                <td className="px-4 py-3 text-gray-600">{c.payments_count} оплат</td>
                {/* Кто ведёт сейчас — иначе при перезакреплении не видно,
                    у кого забираем. */}
                <td className="px-4 py-3">
                  {c.owner_name
                    ? <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                        Ведёт: {c.owner_name}
                      </span>
                    : <span className="text-xs text-gray-400">Без ответственного</span>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {/* ⚠️ `value`, а НЕ `defaultValue`: список перечитывается
                        после передачи, и выбор обязан показывать того, кто
                        ведёт клиента сейчас. С defaultValue он оставался бы на
                        «Кому передать…» даже у закреплённого. */}
                    <select value={c.tech_specialist_id || ''}
                            onChange={e => assign(c.id, e.target.value ? Number(e.target.value) : null)}
                            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
                      <option value="">Кому передать…</option>
                      {/* ⚠️ Текущий ответственный показывается ДАЖЕ если он в
                          отпуске или уволен и в списке выбора его нет: иначе
                          `value` не нашёл бы своего пункта, и закреплённый
                          клиент выглядел бы ничьим — ровно у тех, кого надо
                          передать в первую очередь. */}
                      {c.tech_specialist_id && !active.some((s: any) => s.id === c.tech_specialist_id) && (
                        <option value={c.tech_specialist_id}>
                          {c.owner_name} (сейчас не берёт клиентов)
                        </option>
                      )}
                      {active.map((s: any) => (
                        <option key={s.id} value={s.id}>{s.name || s.email}</option>
                      ))}
                    </select>
                    {c.tech_specialist_id && (
                      <button type="button" onClick={() => assign(c.id, null)}
                              className="whitespace-nowrap rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
                        Снять
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ⚠️ Стрелки показываем, только когда страниц больше одной: на коротком
          списке они сбивали бы с толку. Номер и общий счёт словами — чтобы
          было видно, сколько всего нашлось, а не только текущая горстка. */}
      {total > PAGE && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <button type="button"
                  disabled={offset === 0 || loading}
                  onClick={() => setOffset(Math.max(0, offset - PAGE))}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40">
            ← Назад
          </button>
          <span className="text-sm text-gray-500">
            {offset + 1}–{Math.min(offset + PAGE, total)} из {total}
          </span>
          <button type="button"
                  disabled={offset + PAGE >= total || loading}
                  onClick={() => setOffset(offset + PAGE)}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40">
            Вперёд →
          </button>
        </div>
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
  const [title, setTitle] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [base, setBase] = useState('6')
  const [netPl, setNetPl] = useState('3')
  const [netOwn, setNetOwn] = useState('5')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    api.adminTech.quarterReqs()
      .then((r: any) => setReqs(r.requirements || [])).catch(() => {})
  }, [tick])

  // ⚠️ По умолчанию — текущий календарный квартал, но даты можно поправить:
  // рабочие периоды с календарём не совпадают (первый идёт с середины
  // сентября до конца года).
  useEffect(() => {
    if (period) return
    const d = new Date()
    const q = Math.floor(d.getMonth() / 3)
    setPeriod(`${d.getFullYear()}-Q${q + 1}`)
    const s = new Date(d.getFullYear(), q * 3, 1)
    const e = new Date(d.getFullYear(), q * 3 + 3, 0)
    const iso = (x: Date) => x.toISOString().slice(0, 10)
    setFrom(iso(s)); setTo(iso(e))
  }, [period])

  const months = from && to
    ? Math.round(((new Date(to).getTime() - new Date(from).getTime())
        / 86400000 + 1) / 30.44 * 10) / 10
    : 3

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <h3 className="mb-1 text-sm font-semibold text-gray-900">Условия премии на квартал</h3>
      <p className="mb-3 text-xs text-gray-500">
        Активаций <b>в месяц</b>. Тип Б — только клиенты ПЛЮСОНА. Тип В — и от
        ПЛЮСОНА, и свои приведённые. Не выполнил — в дележе фонда не участвует.
        {from && to && (
          <> В этом периоде <b>{months} мес.</b> — значит за весь период нужно{' '}
          <b>{Math.round(Number(base) * months)}</b> (тип Б) и{' '}
          <b>{Math.round(Number(netPl) * months)} + {Math.round(Number(netOwn) * months)}</b> (тип В).</>
        )}
      </p>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-500">Ключ периода<br />
          <input value={period} onChange={e => setPeriod(e.target.value)}
                 className="mt-1 w-28 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-500">Название<br />
          <input value={title} onChange={e => setTitle(e.target.value)}
                 placeholder="До Нового года"
                 className="mt-1 w-40 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-500">С<br />
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                 className="mt-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-gray-500">По<br />
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
                 className="mt-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
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
                period, title: title || undefined,
                starts_on: from || undefined, ends_on: to || undefined,
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
            <th className="py-2">Период</th>
            <th className="py-2">Даты</th>
            <th className="py-2">Тип Б</th>
            <th className="py-2">Тип В</th>
          </tr>
        </thead>
        <tbody>
          {reqs.map((r: any) => (
            <tr key={r.period} className="border-b border-gray-50">
              <td className="py-2 font-medium text-gray-900">
                {r.title || r.period}
                {r.title && <div className="text-xs text-gray-400">{r.period}</div>}
              </td>
              <td className="py-2 text-gray-600">
                {r.starts_on && r.ends_on
                  ? `${new Date(r.starts_on).toLocaleDateString('ru-RU')} — ${new Date(r.ends_on).toLocaleDateString('ru-RU')}`
                  : 'календарный квартал'}
              </td>
              <td className="py-2">{r.base_from_pluson} от ПЛЮСОНА</td>
              <td className="py-2">
                {r.network_from_pluson} от ПЛЮСОНА + {r.network_own} своих
              </td>
            </tr>
          ))}
          {!reqs.length && (
            <tr><td colSpan={4} className="py-3 text-gray-400">Условия не заданы</td></tr>
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
