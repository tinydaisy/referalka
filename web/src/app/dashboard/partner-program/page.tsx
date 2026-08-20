'use client'
import { useEffect, useState } from 'react'
import { Copy, Check, ArrowRight, Users, Wallet, X, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

interface RefData {
  referral_code: string
  // max приходит, только если у ПЛЮСОНа подключён MAX-бот с handle
  links: { web: string; telegram: string; max?: string }
  balance_kopecks: number
  balance_rub: number
  can_withdraw: boolean
  withdrawal_threshold_kopecks: number
  withdrawal_block_reason: string | null
  transactions: any[]
  withdrawal_requests: any[]
  partner?: {
    accepted_at: string | null
    accepted_version: string | null
    tax_status: string | null
  } | null
  referrals: any[]
  referrals_count: number
}

const TX_LABEL: Record<string, { label: string; icon: string }> = {
  accrual:           { label: 'Начисление',              icon: '🎉' },
  payment:           { label: 'Оплата подписки',         icon: '💳' },
  withdrawal_hold:   { label: 'Заморозка под вывод',     icon: '🔒' },
  withdrawal_done:   { label: 'Вывод выполнен',          icon: '💸' },
  withdrawal_cancel: { label: 'Вывод отклонён, возврат', icon: '↩️' },
  admin_adjust:      { label: 'Корректировка',            icon: '⚙️' },
}

const WD_STATUS: Record<string, { label: string; color: string }> = {
  pending:   { label: 'В обработке', color: 'text-amber-700 bg-amber-50' },
  completed: { label: 'Выплачено',    color: 'text-green-700 bg-green-50' },
  cancelled: { label: 'Отклонено',    color: 'text-red-700 bg-red-50' },
}

type Tab = 'main' | 'referrals' | 'payouts'
type RefFilter = 'all' | 'active' | 'inactive'

export default function PartnerProgramPage() {
  const [data, setData] = useState<RefData | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)
  const [showWithdrawModal, setShowWithdrawModal] = useState(false)
  const [tab, setTab] = useState<Tab>('main')
  const [refFilter, setRefFilter] = useState<RefFilter>('all')

  function load() {
    api.referrals.me()
      .then((r: any) => { setData(r); setLoading(false) })
      .catch(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  function copy(label: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  if (loading) return <div className="text-gray-500 p-8">Загрузка…</div>
  if (!data) return <div className="text-gray-500 p-8">Не удалось загрузить данные</div>

  // Реферал «действующий» = есть активная подписка (sub_active). Иначе — недействующий (подписка остановилась/истекла).
  const activeCount = data.referrals.filter((r: any) => r.sub_active).length
  const inactiveCount = data.referrals.length - activeCount
  const filteredReferrals = data.referrals.filter((r: any) =>
    refFilter === 'all' ? true : refFilter === 'active' ? r.sub_active : !r.sub_active
  )

  const TABS: { key: Tab; label: string }[] = [
    { key: 'main', label: 'Основное' },
    { key: 'referrals', label: 'Приведённые клиенты' },
    { key: 'payouts', label: 'История выплат' },
  ]

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Партнёрская программа</h1>
        <p className="text-sm text-gray-500 mt-1">
          Приводите клиентов и получайте % бонусами с каждой их оплаты подписки — до 31 июля 2027 года
          это <b>10% в течение года</b>. Начисляем бонусными рублями — их можно тратить на свою подписку.
        </p>
      </div>

      {/* Вкладки */}
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-[#25455D] text-[#25455D]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
            {t.key === 'referrals' && <span className="ml-1.5 text-xs text-gray-400">{data.referrals_count}</span>}
          </button>
        ))}
      </div>

      {/* ── ОСНОВНОЕ ── */}
      {tab === 'main' && (
        <>
          {/* Баланс + действия */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="text-sm text-gray-500 mb-1">Бонусный баланс</div>
                <div className="text-4xl font-bold" style={{ color: '#25455D' }}>
                  {data.balance_rub.toLocaleString('ru-RU')} ₽
                </div>
              </div>
              <div className="flex gap-2 flex-wrap">
                <a
                  href="/dashboard/settings?tab=subscription"
                  className="btn-gold px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2"
                >
                  <Wallet size={14} /> Потратить на подписку
                  <ArrowRight size={14} />
                </a>
                {/* Вывод деньгами. Открывается, когда выполнены ВСЕ условия:
                    принята партнёрская оферта со статусом, набран минимум и
                    есть активная платная подписка. Причина недоступности
                    приходит с бэкенда — показываем её, а не прячем кнопку:
                    иначе непонятно, чего не хватает. */}
                {data.partner?.accepted_at && (
                  data.can_withdraw ? (
                    <button
                      onClick={() => setShowWithdrawModal(true)}
                      className="px-4 py-2 rounded-xl text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 flex items-center gap-2"
                    >
                      <Wallet size={14} /> Вывести деньгами
                    </button>
                  ) : (
                    <button
                      disabled
                      title={data.withdrawal_block_reason || ''}
                      className="px-4 py-2 rounded-xl text-sm font-semibold bg-gray-100 text-gray-400 cursor-not-allowed flex items-center gap-2"
                    >
                      <Wallet size={14} /> Вывести деньгами
                    </button>
                  )
                )}
              </div>
            </div>
            <div className="mt-3 text-xs text-gray-500 italic">
              Бонусы можно потратить на свою подписку.
              {data.partner?.accepted_at && !data.can_withdraw && data.withdrawal_block_reason && (
                <span className="not-italic text-gray-500"> · {data.withdrawal_block_reason}</span>
              )}
            </div>

            {/* Акцепт партнёрской оферты (миграция 319).
                ⚠️ Отдельное действие, а не часть регистрации: в партнёрской
                программе платим МЫ клиенту, оплаты с его стороны нет — значит
                акцептовать оплатой нечем. Нажатие кнопки — конклюдентное
                действие по п. 3 ст. 438 ГК.
                ⚠️ Статус обязателен: выплата обычному физлицу сделала бы
                Оферента налоговым агентом (ст. 226 НК), а ИП на НПД им быть
                не может. */}
            <div className="mt-4 pt-4 border-t border-gray-100">
              {data.partner?.accepted_at ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="inline-flex items-center gap-1.5 text-emerald-700">
                    <Check size={15} /> Вы участвуете в партнёрской программе
                  </span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-600">
                    статус: <b>{TAX_STATUS_LABEL[data.partner.tax_status || ''] || '—'}</b>
                  </span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-500 text-xs">
                    принято {new Date(data.partner.accepted_at).toLocaleDateString('ru-RU')}
                    {data.partner.accepted_version ? `, редакция ${data.partner.accepted_version}` : ''}
                  </span>
                  <a href="/partner-offer" target="_blank" rel="noopener"
                     className="text-xs text-[#25455D] underline">оферта</a>
                </div>
              ) : (
                <PartnerAcceptBlock onAccepted={load} />
              )}
            </div>
          </div>

          {/* Реф-ссылки.
              ⚠️ Показываются ТОЛЬКО после принятия партнёрской оферты: ссылка —
              это уже участие в программе, и выдавать её до согласия с условиями
              неправильно. До акцепта на месте блока стоит объяснение и кнопка. */}
          {!data.partner?.accepted_at ? (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
              <h3 className="font-semibold text-gray-800 mb-1">Ваши реф-ссылки</h3>
              <p className="text-sm text-gray-500">
                Ссылки появятся здесь, как только вы примете условия партнёрской
                программы в блоке выше.
              </p>
            </div>
          ) : (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h3 className="font-semibold text-gray-800 mb-1">Ваши реф-ссылки</h3>
            <p className="text-xs text-gray-400 mb-4">
              Реф-код: <code className="bg-gray-50 px-1.5 py-0.5 rounded">{data.referral_code}</code>
            </p>
            <div className="space-y-2">
              {[
                { key: 'web', label: 'Сайт', url: data.links.web },
                { key: 'telegram', label: 'Telegram', url: data.links.telegram },
                // MAX — только если бэкенд прислал (у ПЛЮСОНа подключён MAX-бот)
                ...(data.links.max ? [{ key: 'max', label: 'MAX', url: data.links.max }] : []),
              ].map(({ key, label, url }) => (
                <div key={key} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                  <span className="text-xs text-gray-500 w-16 shrink-0">{label}</span>
                  <code className="flex-1 text-xs text-gray-700 truncate">{url}</code>
                  <button onClick={() => copy(key, url)} className="text-gray-400 hover:text-[#25455D] p-1 shrink-0" title="Скопировать">
                    {copied === key ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                  </button>
                  <a href={url} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-[#25455D] p-1 shrink-0">
                    <ExternalLink size={14} />
                  </a>
                </div>
              ))}
            </div>
          </div>
          )}
        </>
      )}

      {/* ── ПРИВЕДЁННЫЕ КЛИЕНТЫ ── */}
      {tab === 'referrals' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <h3 className="font-semibold text-gray-800 flex items-center gap-2">
              <Users size={16} /> Приведённые клиенты
            </h3>
            {/* Фильтр действующие / недействующие */}
            <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5 text-xs">
              {[
                { key: 'all' as RefFilter, label: `Все · ${data.referrals.length}` },
                { key: 'active' as RefFilter, label: `Действующие · ${activeCount}` },
                { key: 'inactive' as RefFilter, label: `Остановлены · ${inactiveCount}` },
              ].map(f => (
                <button
                  key={f.key}
                  onClick={() => setRefFilter(f.key)}
                  className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                    refFilter === f.key ? 'bg-white text-[#25455D] shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          {filteredReferrals.length === 0 ? (
            <p className="text-sm text-gray-400">
              {data.referrals.length === 0 ? 'Пока никого нет. Поделитесь реф-ссылкой!' : 'Нет клиентов в этой категории.'}
            </p>
          ) : (
            <div className="space-y-2">
              {filteredReferrals.map((r: any) => (
                <div key={r.id} className="flex items-center justify-between border-b border-gray-50 last:border-0 py-2">
                  <div>
                    <div className="font-medium text-gray-800 flex items-center gap-2">
                      {r.name}
                      <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded ${
                        r.sub_active ? 'text-emerald-700 bg-emerald-50' : 'text-gray-500 bg-gray-100'
                      }`}>
                        {r.sub_active ? 'Действует' : 'Остановлена'}
                      </span>
                    </div>
                    <div className="text-xs text-gray-400">
                      {r.email} · с {new Date(r.created_at).toLocaleDateString('ru-RU')}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm">
                      {r.tariff_name ? (
                        <span className={r.sub_active ? 'text-emerald-700' : 'text-gray-400'}>
                          {r.tariff_name}{r.sub_source === 'trial' ? ' (trial)' : ''}
                        </span>
                      ) : <span className="text-gray-400">—</span>}
                    </div>
                    <div className="text-xs text-gray-500">
                      Оплатил всего: {((r.total_paid_kopecks || 0) / 100).toLocaleString('ru-RU')} ₽
                    </div>
                    <div className={`text-xs mt-0.5 ${r.accrual_expired ? 'text-gray-400' : 'text-[#25455D]'}`}>
                      {r.accrual_expired ? (
                        <>Начисления завершены{r.accrual_until ? ` ${new Date(r.accrual_until).toLocaleDateString('ru-RU')}` : ''}</>
                      ) : (
                        <><b>{r.rate_percent}%</b>{r.accrual_until ? ` до ${new Date(r.accrual_until).toLocaleDateString('ru-RU')}` : ''}</>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── ИСТОРИЯ ВЫПЛАТ ── */}
      {tab === 'payouts' && (
        <>
          {/* Заявки на вывод */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h3 className="font-semibold text-gray-800 mb-4">Заявки на вывод</h3>
            {data.withdrawal_requests.length === 0 ? (
              <p className="text-sm text-gray-400">Заявок на вывод пока не было</p>
            ) : (
              <div className="space-y-2">
                {data.withdrawal_requests.map((w: any) => {
                  const st = WD_STATUS[w.status] || { label: w.status, color: 'text-gray-600 bg-gray-100' }
                  return (
                    <div key={w.id} className="flex items-center justify-between border-b border-gray-50 last:border-0 py-2 text-sm">
                      <div>
                        <div className="font-medium text-gray-800">{(w.amount_kopecks / 100).toLocaleString('ru-RU')} ₽</div>
                        <div className="text-xs text-gray-400">
                          {new Date(w.requested_at).toLocaleString('ru-RU')}
                        </div>
                        {w.admin_note && <div className="text-xs text-gray-500 italic mt-1">{w.admin_note}</div>}
                      </div>
                      <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded ${st.color}`}>
                        {st.label}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* История бонусов */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <h3 className="font-semibold text-gray-800 mb-4">История бонусов</h3>
            {data.transactions.length === 0 ? (
              <p className="text-sm text-gray-400">Операций пока нет</p>
            ) : (
              <div className="space-y-2">
                {data.transactions.map((t: any) => {
                  const meta = TX_LABEL[t.type] || { label: t.type, icon: '·' }
                  const amt = t.amount_kopecks / 100
                  const isPositive = t.amount_kopecks > 0
                  return (
                    <div key={t.id} className="flex items-center justify-between border-b border-gray-50 last:border-0 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <span>{meta.icon}</span>
                        <div>
                          <div className="font-medium text-gray-800">{meta.label}</div>
                          <div className="text-xs text-gray-400">
                            {new Date(t.created_at).toLocaleDateString('ru-RU')}
                            {t.source_payer_name && ` · от ${t.source_payer_name}`}
                          </div>
                          {t.description && <div className="text-xs text-gray-500 mt-0.5">{t.description}</div>}
                        </div>
                      </div>
                      <div className={`font-semibold ${isPositive ? 'text-green-600' : t.amount_kopecks < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                        {isPositive ? '+' : ''}{amt.toLocaleString('ru-RU')} ₽
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      {showWithdrawModal && (
        <WithdrawModal
          maxAmount={data.balance_kopecks}
          onClose={() => setShowWithdrawModal(false)}
          onSuccess={() => { setShowWithdrawModal(false); load() }}
        />
      )}
    </div>
  )
}


function WithdrawModal({ maxAmount, onClose, onSuccess }: {
  maxAmount: number
  onClose: () => void
  onSuccess: () => void
}) {
  const [amount, setAmount] = useState(String(maxAmount / 100))
  const [details, setDetails] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const rub = parseFloat(amount)
    if (!rub || rub <= 0) { setError('Введите сумму'); return }
    if (rub * 100 > maxAmount) { setError('Сумма больше баланса'); return }
    if (!details.trim()) { setError('Укажите реквизиты для перевода'); return }
    setLoading(true)
    try {
      await api.referrals.withdraw(Math.round(rub * 100), details.trim())
      onSuccess()
    } catch (e: any) {
      setError(e?.message || 'Ошибка')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Заявка на вывод</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Сумма, ₽</label>
            <input
              type="number" step="0.01" min="4000" max={maxAmount / 100}
              value={amount} onChange={e => setAmount(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
            <div className="text-xs text-gray-400 mt-1">
              Минимум 4000 ₽. На балансе: {(maxAmount / 100).toLocaleString('ru-RU')} ₽.
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Реквизиты для перевода</label>
            <textarea
              value={details} onChange={e => setDetails(e.target.value)}
              placeholder="Карта Сбер 1234... / СБП по телефону +7... / ИП ..."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm h-24 resize-none"
            />
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">Отмена</button>
            <button type="submit" disabled={loading} className="btn-gold px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
              {loading ? 'Создание…' : 'Отправить заявку'}
            </button>
          </div>
          <p className="text-xs text-gray-500 pt-1">
            Заявка обрабатывается вручную. Маргарита получит уведомление, переведёт деньги
            на указанные реквизиты и отметит заявку выполненной.
          </p>
        </form>
      </div>
    </div>
  )
}


// ─── Принятие условий партнёрской программы ──────────────────────────────────

const TAX_STATUS_LABEL: Record<string, string> = {
  ip: 'ИП',
  company: 'Юридическое лицо',
  self_employed: 'Самозанятый',
}

/**
 * Блок вступления в партнёрскую программу.
 *
 * ⚠️ Статус налогоплательщика обязателен: партнёрское вознаграждение
 * выплачивается только ИП, юрлицам и самозанятым. Обычному физлицу платить
 * нельзя — Оферент стал бы налоговым агентом (НДФЛ + взносы), а ИП на НПД
 * налоговым агентом быть не может.
 */
function PartnerAcceptBlock({ onAccepted }: { onAccepted: () => void }) {
  const [status, setStatus] = useState('')
  const [agree, setAgree] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function accept() {
    setSaving(true); setErr('')
    try {
      await api.referrals.acceptPartnerOffer({ tax_status: status })
      onAccepted()
    } catch (e: any) {
      setErr(e?.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="text-sm font-medium text-gray-800 mb-1">Участие в партнёрской программе</div>
      <p className="text-xs text-gray-500 mb-3 leading-snug">
        Примите условия и укажите свой статус — после этого появятся ваши
        реферальные ссылки, а вознаграждение можно будет выводить на счёт.
        Выплаты возможны индивидуальным предпринимателям, юридическим лицам и
        самозанятым: они платят налоги самостоятельно.
      </p>

      <div className="flex flex-wrap gap-2 mb-3">
        {Object.entries(TAX_STATUS_LABEL).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setStatus(key)}
            className={`px-3.5 py-2 rounded-xl text-sm border transition ${
              status === key
                ? 'border-[#25455D] bg-[#25455D] text-white'
                : 'border-gray-200 text-gray-700 hover:border-gray-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="flex items-start gap-2.5 cursor-pointer mb-3">
        <input
          type="checkbox" checked={agree}
          onChange={e => setAgree(e.target.checked)}
          className="mt-0.5 w-4 h-4 shrink-0 accent-[#25455D] cursor-pointer"
        />
        <span className="text-xs text-gray-600 leading-snug">
          Я принимаю условия{' '}
          <a href="/partner-offer" target="_blank" rel="noopener" className="text-[#25455D] underline">
            Оферты об участии в партнёрской программе
          </a>{' '}
          и подтверждаю указанный статус
        </span>
      </label>

      {err && <div className="text-xs text-red-600 mb-2">{err}</div>}

      <button
        onClick={accept}
        disabled={!status || !agree || saving}
        className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40"
      >
        {saving ? 'Сохраняем…' : 'Стать партнёром и получить реф-ссылки'}
      </button>
    </div>
  )
}
