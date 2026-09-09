'use client'

/**
 * Админ: тех-специалисты — люди, ставки, распределение клиентов, выплаты.
 *
 * ⚠️ Распределение здесь, а не в кабинете внедренца: кому кого вести — решение
 * владельца. Иначе специалист набирал бы себе платящих и обходил остывших.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

const rub = (kop?: number | null) =>
  `${Math.round((kop || 0) / 100).toLocaleString('ru-RU')} ₽`

// ⚠️ Подписи и правила — по листу «2. KPI и проценты», не выдуманные.
const KIND: Record<string, string> = {
  activation: 'Активация — % от тарифа',
  revival: 'Оживление — % от тарифа',
  fix: 'Фикс за обслуживание (по вилке ниже)',
  referral: 'Свой приведённый — % пожизненно',
  referral2: '2-й уровень — %',
  quarter_bonus: 'Квартальная премия',
  bonus: 'Премия вручную',
}

type Tab = 'specs' | 'assign' | 'dialogs' | 'money'

export default function AdminTechPage() {
  const [tab, setTab] = useState<Tab>('specs')
  const [specs, setSpecs] = useState<any[]>([])
  const [rates, setRates] = useState<any[]>([])
  const [fixTiers, setFixTiers] = useState<any[]>([])
  const [quarterTiers, setQuarterTiers] = useState<any[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    api.adminTech.specialists().then((r: any) => setSpecs(r.specialists || [])).catch(() => {})
    api.adminTech.rates().then((r: any) => {
      setRates(r.rates || [])
      setFixTiers(r.fix_tiers || [])
      setQuarterTiers(r.quarter_tiers || [])
    }).catch(() => {})
  }, [tick])

  return (
    <div className="p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">Тех-специалисты</h1>
      <p className="mb-5 text-sm text-gray-500">
        Внедренцы: кто есть, кто кого ведёт и сколько кому причитается.
      </p>

      <div className="mb-5 flex gap-2">
        {([['specs', 'Люди и ставки'], ['assign', 'Клиенты'],
           ['dialogs', 'Диалоги бота'],
           ['money', 'Начисления']] as [Tab, string][]).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                    tab === id ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'specs' && <SpecsTab specs={specs} rates={rates} fixTiers={fixTiers}
                                    quarterTiers={quarterTiers}
                                    onChange={() => setTick(t => t + 1)} />}
      {tab === 'assign' && <AssignTab specs={specs} onChange={() => setTick(t => t + 1)} />}
      {tab === 'dialogs' && <DialogsTab specs={specs} />}
      {tab === 'money' && <MoneyTab specs={specs} />}
    </div>
  )
}

// ── Люди и ставки ────────────────────────────────────────────────────────
function SpecsTab({ specs, rates, fixTiers, quarterTiers, onChange }: any) {
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

      <div className="rounded-xl bg-white p-4 shadow-sm">
        <div className="mb-1 text-sm font-semibold text-gray-800">Ставки</div>
        <p className="mb-3 text-xs text-gray-500">
          Новая ставка действует вперёд — уже начисленное не пересчитывается.
        </p>
        <div className="space-y-2">
          {rates.map((r: any) => (
            <div key={r.kind} className="flex flex-wrap items-center gap-2">
              <span className="min-w-[260px] text-sm text-gray-700">{KIND[r.kind] || r.kind}</span>
              {r.kind === 'fix' ? (
                <span className="text-xs text-gray-400">считается по вилке</span>
              ) : r.of_tariff ? (
                <>
                  <input defaultValue={r.percent} type="number" step="0.5"
                         onBlur={e => api.adminTech.setRate(r.kind, { percent: Number(e.target.value) })}
                         className="w-24 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                  <span className="text-sm text-gray-500">% от тарифа клиента</span>
                </>
              ) : (
                <>
                  <input defaultValue={Math.round((r.amount_kopecks || 0) / 100)} type="number"
                         onBlur={e => api.adminTech.setRate(r.kind, { amount_kopecks: Number(e.target.value) * 100 })}
                         className="w-28 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                  <span className="text-sm text-gray-500">₽</span>
                </>
              )}
            </div>
          ))}
        </div>

        {/* ⚠️ ФИКС — ВИЛКА, А НЕ СУММА ЗА КАЖДОГО: 15–49 клиентов → 4 000 ₽ за
            всех сразу. Умножение на число дало бы на сотне 30 000 вместо 12 000. */}
        {!!rates?.length && (
          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <div>
              <div className="mb-1 text-sm font-semibold text-gray-800">
                Фикс за обслуживание
              </div>
              <p className="mb-2 text-xs text-gray-500">
                Считаются только ЧУЖИЕ платящие клиенты: за своих идёт процент.
              </p>
              <table className="w-full text-sm">
                <tbody>
                  {(fixTiers || []).map((t: any) => (
                    <tr key={t.id} className="border-b border-gray-50 last:border-0">
                      <td className="py-1.5 text-gray-600">
                        {t.clients_from}–{t.clients_to} клиентов
                      </td>
                      <td className="py-1.5 text-right font-medium">
                        {rub(t.amount_kopecks)}/мес
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <div className="mb-1 text-sm font-semibold text-gray-800">
                Квартальная премия
              </div>
              <p className="mb-2 text-xs text-gray-500">
                Доля доживших: из впервые оплативших за квартал сколько сделали
                вторую оплату.
              </p>
              <table className="w-full text-sm">
                <tbody>
                  {(quarterTiers || []).map((t: any) => (
                    <tr key={t.id} className="border-b border-gray-50 last:border-0">
                      <td className="py-1.5 text-gray-600">
                        {Number(t.rate_from)}–{Number(t.rate_to)} %
                      </td>
                      <td className="py-1.5 text-right font-medium">
                        {rub(t.amount_kopecks)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
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
