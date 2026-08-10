'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CreditCard, CheckCircle2, X, ArrowRight, Wallet, ChevronDown } from 'lucide-react'
import { api } from '@/lib/api'

export default function SubscriptionPage() {
  const [me, setMe] = useState<any>(null)
  const [tariffs, setTariffs] = useState<any[]>([])
  const [promotions, setPromotions] = useState<any[]>([])
  const [featureLabels, setFeatureLabels] = useState<Record<string, string>>({})
  const [selectedSlug, setSelectedSlug] = useState<string>('')
  const [bonusBalance, setBonusBalance] = useState(0)
  const [paidBanner, setPaidBanner] = useState(false)
  const [loading, setLoading] = useState(false)
  const [bonusLoading, setBonusLoading] = useState(false)
  const [error, setError] = useState('')
  const [featuresOpen, setFeaturesOpen] = useState(false)  // «Что входит в тариф» — свёрнут по умолчанию

  useEffect(() => {
    api.auth.me().then((d: any) => setMe(d)).catch(() => {})
    api.publicData.tariffs().then((r: any) => {
      // Показываем платный тариф, если настроена хотя бы одна платёжка (Prodamus или LeadPay).
      const paid = (r.tariffs || []).filter((t: any) =>
        t.slug !== 'trial' && Number(t.price) > 0 && (t.prodamus_payment_url || t.leadpay_product_id))
      setTariffs(paid)
    }).catch(() => {})
    api.publicData.activePromotions().then((r: any) => setPromotions(r.promotions || [])).catch(() => {})
    api.publicData.features().then((r: any) => {
      const map: Record<string, string> = {}
      for (const f of (r.features || [])) map[f.slug] = f.name
      setFeatureLabels(map)
    }).catch(() => {})
    api.referrals.me().then((r: any) => setBonusBalance(r.balance_kopecks || 0)).catch(() => {})

    if (typeof window !== 'undefined') {
      const u = new URL(window.location.href)
      if (u.searchParams.get('paid') === '1') {
        setPaidBanner(true)
        u.searchParams.delete('paid')
        window.history.replaceState({}, '', u.toString())
      }
    }
  }, [])

  useEffect(() => {
    if (!tariffs.length) return
    const current = me?.subscription?.tariff_slug
    if (current && tariffs.find((t: any) => t.slug === current)) {
      setSelectedSlug(current)
    } else {
      const pro = tariffs.find((t: any) => t.slug === 'pro')
      setSelectedSlug((pro || tariffs[0]).slug)
    }
  }, [tariffs, me])

  const sub = me?.subscription
  const features: string[] = me?.features || []
  const isExpired = !sub || !sub.is_active || sub.days_left < 0
  const expiresStr = sub?.expires_at
    ? new Date(sub.expires_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—'

  async function pay(slug: string, tariff: any) {
    if (!slug) return
    setSelectedSlug(slug)
    setLoading(true)
    setError('')
    try {
      // Провайдер: LeadPay если у тарифа настроена карточка, иначе Prodamus.
      const provider = tariff?.leadpay_product_id ? 'leadpay' : 'prodamus'
      const res = await api.subscriptions.createOrder(slug, provider)
      if (res?.payment_url) window.location.href = res.payment_url
      else { setError('Не удалось создать заказ'); setLoading(false) }
    } catch (e: any) {
      setError(e?.message || 'Ошибка оплаты'); setLoading(false)
    }
  }

  async function payWithBonus(slug: string, priceKopecks: number) {
    if (!slug || bonusBalance < priceKopecks || priceKopecks <= 0) return
    if (!confirm(`Списать ${(priceKopecks / 100).toLocaleString('ru-RU')} ₽ с бонусного баланса?`)) return
    setSelectedSlug(slug)
    setBonusLoading(true); setError('')
    try {
      await api.subscriptions.payWithBonus(slug)
      setPaidBanner(true)
      setBonusBalance(b => b - priceKopecks)
      setTimeout(() => window.location.reload(), 1500)
    } catch (e: any) {
      setError(e?.message || 'Ошибка списания бонусов'); setBonusLoading(false)
    }
  }

  // Пришли по ссылке с якорем (#module-conference / #modules / #tariffs) —
  // подводим к нужному блоку.
  //
  // ⚠️ ЖДЁМ ПОЯВЛЕНИЯ ЯКОРЯ, а не фиксированную задержку. Карточки модулей
  // грузятся отдельным запросом (`api.addons.list`), и по таймеру в 350 мс
  // якоря `#module-…` ещё не существовало: страница оставалась на тарифах, а
  // выделенным выглядел текущий тариф (Экстра) — ровно то, на что жаловались.
  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (!id) return
    let tries = 0
    const iv = setInterval(() => {
      const el = document.getElementById(id)
      if (el) {
        clearInterval(iv)
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } else if (++tries > 40) {   // ~6 c — дальше ждать бессмысленно
        clearInterval(iv)
      }
    }, 150)
    return () => clearInterval(iv)
  }, [])

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <CreditCard size={22} /> Подписка
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Управляйте тарифом и оплачивайте подписку картой или бонусами.
        </p>
      </div>

      {paidBanner && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-lg px-4 py-3">
          ✅ Оплата прошла. Подписка продлена.
        </div>
      )}

      {/* Текущий статус */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="font-semibold text-gray-800 mb-1">{sub?.tariff_name || 'Тариф не определён'}</h3>
            <p className="text-sm text-gray-500">
              Действует до <b>{expiresStr}</b>
              {!isExpired && sub?.days_left >= 0 && (
                <span className={sub.days_left <= 7 ? 'text-amber-700 ml-2' : 'text-gray-500 ml-2'}>
                  · осталось {sub.days_left === 0 ? 'меньше дня' : `${sub.days_left} дн.`}
                </span>
              )}
            </p>
          </div>
          <span className={`px-3 py-1 rounded-full text-xs font-medium ${
            isExpired ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
          }`}>
            {isExpired ? 'Истекла' : 'Активна'}
          </span>
        </div>
      </div>

      {/* Что входит в текущий тариф — свёрнутый список над тарифами */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <button
          onClick={() => setFeaturesOpen(o => !o)}
          className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
        >
          <h3 className="font-semibold text-gray-800">Что входит в ваш тариф</h3>
          <ChevronDown size={18} className={`text-gray-400 transition-transform ${featuresOpen ? 'rotate-180' : ''}`} />
        </button>
        {featuresOpen && (
          <div className="px-6 pb-6 space-y-2 text-sm border-t border-gray-50 pt-4">
            <div className="text-[11px] font-semibold tracking-wider text-gray-400 uppercase mb-1">База — всегда включено</div>
            {['Контакты', 'Мероприятия', 'Рассылки'].map(x => (
              <div key={x} className="flex items-center gap-2 text-gray-700">
                <CheckCircle2 size={16} className="text-green-500 shrink-0" /> {x}
              </div>
            ))}
            <div className="text-[11px] font-semibold tracking-wider text-gray-400 uppercase mb-1 mt-3">Опции тарифа</div>
            {Object.entries(featureLabels).map(([slug, label]) => {
              const enabled = features.includes(slug)
              return (
                <div key={slug} className={`flex items-center gap-2 ${enabled ? 'text-gray-700' : 'text-gray-400'}`}>
                  {enabled
                    ? <CheckCircle2 size={16} className="text-green-500 shrink-0" />
                    : <X size={16} className="text-gray-300 shrink-0" />}
                  {label}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Выбор тарифа */}
      {tariffs.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h3 id="tariffs" className="scroll-mt-24 font-semibold text-gray-800 mb-2">Продлить или сменить тариф</h3>
          <p className="text-sm text-gray-500 mb-4">
            Оплата идёт через Prodamus, чек 54-ФЗ приходит на email автоматически.
          </p>

          {bonusBalance > 0 && (
            <div className="mb-3 text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
              💰 Бонусный баланс: <b>{(bonusBalance / 100).toLocaleString('ru-RU')} ₽</b>
            </div>
          )}

          {error && <div className="mb-3 text-sm text-red-600">{error}</div>}
          {loading && (
            <div className="mb-3 flex items-center gap-3 rounded-xl border border-[#FFCFA4] bg-amber-50/60 px-4 py-3">
              <span className="w-5 h-5 border-2 border-[#25455D] border-t-transparent rounded-full animate-spin shrink-0" />
              <span className="text-sm text-gray-700">Соединяем вас с платёжной системой — подождите ~20 секунд…</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {tariffs.map(t => {
              const isCurrent = me?.subscription?.tariff_slug === t.slug
              const priceKopecks = Math.round(Number(t.price) * 100)
              const busy = selectedSlug === t.slug && (loading || bonusLoading)
              const canBonus = bonusBalance >= priceKopecks && priceKopecks > 0
              return (
                <div
                  key={t.id}
                  className={`flex flex-col rounded-xl border p-4 ${
                    isCurrent ? 'border-[#25455D] ring-2 ring-[#25455D]/20 bg-blue-50/30' : 'border-gray-200'
                  }`}
                >
                  {t.promo_banner_text && (
                    <div className="text-[10px] font-bold tracking-wider uppercase text-amber-700 mb-1">
                      {t.promo_banner_text}
                    </div>
                  )}
                  <div className="font-semibold text-gray-900">{t.name}</div>
                  <div className="mt-1 flex items-baseline gap-2">
                    {t.promo_old_price && Number(t.promo_old_price) > Number(t.price) ? (
                      <>
                        <span className="text-sm line-through text-gray-400">{Number(t.promo_old_price).toLocaleString('ru-RU')} ₽</span>
                        <span className="text-xl font-bold text-[#25455D]">{Number(t.price).toLocaleString('ru-RU')} ₽</span>
                      </>
                    ) : (
                      <span className="text-xl font-bold text-[#25455D]">{Number(t.price).toLocaleString('ru-RU')} ₽</span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5">за {t.default_duration_days} дн.</div>

                  <div className="space-y-1 mt-3 text-xs text-gray-600 flex-1">
                    <div>До {t.contact_limit?.toLocaleString('ru-RU')} контактов на канал</div>
                    <div>{t.broadcasts_daily_limit ? `${t.broadcasts_daily_limit.toLocaleString('ru-RU')} рассылок/сутки` : 'Безлимит рассылок'}</div>
                    {(t.feature_slugs || []).map((slug: string) => (
                      <div key={slug}>· {featureLabels[slug] || slug}</div>
                    ))}
                  </div>

                  {/* ⚠️ На ТЕКУЩЕМ тарифе это ПРОДЛЕНИЕ, а не покупка: слово
                      «Оплатить» на уже оплаченном тарифе читается как «вы не
                      оплатили» и путает. Золотую кнопку-призыв тоже убираем —
                      призывать покупать то, что уже есть, незачем. */}
                  {isCurrent && (
                    <div className="mt-4 text-center text-xs font-semibold text-[#25455D]">
                      ✓ Ваш текущий тариф
                    </div>
                  )}
                  <button
                    onClick={() => pay(t.slug, t)}
                    disabled={busy}
                    className={`w-full ${isCurrent ? 'mt-2 border border-[#25455D]/30 text-[#25455D] hover:bg-blue-50' : 'btn-gold mt-4'} px-4 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5`}
                  >
                    {busy && loading
                      ? <><span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> Соединяем…</>
                      : isCurrent
                        ? `Продлить за ${Number(t.price).toLocaleString('ru-RU')} ₽`
                        : `Оплатить ${Number(t.price).toLocaleString('ru-RU')} ₽`}
                  </button>
                  {canBonus && (
                    <button
                      onClick={() => payWithBonus(t.slug, priceKopecks)}
                      disabled={busy}
                      className="w-full mt-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {busy && bonusLoading ? 'Списываем…' : 'Оплатить бонусами'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Модули-аддоны поверх тарифа */}
      <ModulesBlock />

      {/* Партнёрская */}
      <Link
        href="/dashboard/partner-program"
        className="block bg-white rounded-2xl border border-gray-100 shadow-sm p-5 hover:border-[#FFCFA4] hover:bg-amber-50/30 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
              <Wallet size={18} className="text-amber-700" />
            </div>
            <div>
              <div className="font-semibold text-gray-800">Партнёрская программа</div>
              <div className="text-xs text-gray-500">10% бонусами с оплат приведённых клиентов · вывод от 4000 ₽</div>
            </div>
          </div>
          <ArrowRight size={16} className="text-gray-400" />
        </div>
      </Link>

      <SubscriptionHistoryBlock />
    </div>
  )
}


// ─── Блок модулей-аддонов (Коллабораторная / Конференции / Премии-Турниры) ───
function ModulesBlock() {
  const [addons, setAddons] = useState<any[]>([])
  const [loadingSlug, setLoadingSlug] = useState<string>('')
  const [error, setError] = useState('')

  useEffect(() => {
    api.addons.list().then((r: any) => setAddons(r.addons || [])).catch(() => {})
  }, [])

  async function buy(slug: string, months: number, bundle = false, provider: 'prodamus' | 'leadpay' = 'prodamus') {
    setError(''); setLoadingSlug(slug + ':' + (bundle ? 'bundle' : months))
    try {
      const r = await api.addons.createOrder(slug, months, bundle ? 'leadpay' : provider, bundle)
      if (r.payment_url) window.location.href = r.payment_url
    } catch (e: any) {
      setError(e?.message || 'Не удалось создать заказ')
    } finally {
      setLoadingSlug('')
    }
  }

  // Пришли по ссылке вида `#module-conference` — подсвечиваем именно эту
  // карточку. Иначе человек попадал в блок модулей и искал нужный сам.
  const [highlight, setHighlight] = useState<string>('')
  useEffect(() => {
    const h = window.location.hash.slice(1)
    if (h.startsWith('module-')) setHighlight(h.slice('module-'.length))
  }, [])

  if (addons.length === 0) return null

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
      <h3 id="modules" className="scroll-mt-24 font-semibold text-gray-800 mb-1">Модули</h3>
      <p className="text-sm text-gray-500 mb-5">
        Подключаются поверх тарифа. Оплата помесячно.
      </p>
      {error && <div className="mb-4 text-sm text-red-600">{error}</div>}
      {loadingSlug && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-[#FFCFA4] bg-amber-50/60 px-4 py-3">
          <span className="w-5 h-5 border-2 border-[#25455D] border-t-transparent rounded-full animate-spin shrink-0" />
          <span className="text-sm text-gray-700">Соединяем вас с платёжной системой — подождите ~20 секунд…</span>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {addons.map(a => {
          const owned = a.owned || a.included_in_tariff
          const locked = !a.available
          const isTarget = highlight === a.slug
          return (
            <div key={a.slug}
                 id={`module-${a.slug}`}
                 className={`scroll-mt-24 rounded-xl border p-4 flex flex-col transition-shadow ${
                   isTarget ? 'border-[#FFCFA4] ring-2 ring-[#FFCFA4] shadow-md bg-amber-50/40'
                   : owned ? 'border-emerald-200 bg-emerald-50/40'
                   : locked ? 'border-gray-100 bg-gray-50' : 'border-gray-200'}`}>
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-gray-900">{a.name}</h4>
                {owned && <span className="text-xs font-semibold text-emerald-600">Подключён</span>}
              </div>
              {a.tagline && <p className="text-xs text-gray-500 mt-0.5">{a.tagline}</p>}
              {!a.coming_soon && (
                <div className="mt-3 mb-1 flex items-baseline gap-2">
                  {a.promo_old_monthly && a.promo_old_monthly > (a.price_monthly || 0) && (
                    <span className="text-base line-through text-gray-400">{a.promo_old_monthly.toLocaleString('ru-RU')} ₽</span>
                  )}
                  <span className="text-2xl font-bold text-[#25455D]">{a.price_monthly?.toLocaleString('ru-RU')} ₽</span>
                  <span className="text-xs text-gray-400"> / мес</span>
                </div>
              )}
              <ul className="mt-3 space-y-1.5 text-xs text-gray-600 flex-1">
                {(a.bullet_points || []).slice(0, 5).map((b: string, i: number) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <CheckCircle2 size={12} className="text-emerald-500 shrink-0 mt-0.5" /><span>{b}</span>
                  </li>
                ))}
              </ul>

              {a.coming_soon ? (
                <p className="mt-4 text-xs font-semibold text-amber-600">🔜 Скоро будет</p>
              ) : owned ? (
                <p className="mt-4 text-xs text-gray-500">
                  {a.included_in_tariff ? 'Входит в ваш тариф' : a.expires_at ? `Активен до ${new Date(a.expires_at).toLocaleDateString('ru-RU')}` : 'Активен'}
                </p>
              ) : locked ? (
                a.bundle_available ? (
                  <div className="mt-4">
                    <button onClick={() => buy(a.slug, 1, true)} disabled={!!loadingSlug}
                      className="w-full px-3 py-2.5 rounded-lg text-xs font-semibold btn-gold disabled:opacity-50 flex items-center justify-center gap-1.5">
                      {loadingSlug === a.slug + ':bundle'
                        ? <><span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> Соединяем…</>
                        : `Оформить с Профи — ${a.bundle_price?.toLocaleString('ru-RU')} ₽`}
                    </button>
                    <p className="mt-1.5 text-[11px] text-gray-400 text-center">Тариф Профи + модуль на 30 дней одной оплатой</p>
                  </div>
                ) : (
                  <p className="mt-4 text-xs text-amber-600">🔒 Нужен тариф Профи или выше</p>
                )
              ) : (
                {/* Кнопки с суммами длиннее прежних «На месяц» — в столбик,
                    иначе в узкой карточке текст сжимается и рвётся. */}
                <div className="mt-4 flex flex-col gap-2">
                  {a.monthly_payable && (
                    <button onClick={() => buy(a.slug, 1, false, a.monthly_provider || 'prodamus')} disabled={!!loadingSlug}
                      className="w-full px-3 py-2 rounded-lg text-xs font-semibold btn-gold disabled:opacity-50 flex items-center justify-center gap-1.5">
                      {/* ⚠️ «На месяц» само по себе не говорит ни что это
                          оплата, ни сколько платить — сумма была только в
                          заголовке карточки. Пишем на кнопке. */}
                      {loadingSlug === a.slug + ':1'
                        ? <><span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> Соединяем…</>
                        : `Оплатить ${a.price_monthly?.toLocaleString('ru-RU')} ₽ / мес`}
                    </button>
                  )}
                  {/* ⚠️ Вторая золотая кнопка рядом конкурировала с первой:
                      две одинаковые «главные» кнопки читаются как одна
                      сломанная. Полгода — второстепенное действие. */}
                  {a.price_6mo && a.sixmo_payable && (
                    <button onClick={() => buy(a.slug, 6, false, a.sixmo_provider || 'prodamus')} disabled={!!loadingSlug}
                      className="w-full px-3 py-2 rounded-lg text-xs font-semibold border border-[#25455D]/30 text-[#25455D] hover:bg-blue-50 disabled:opacity-50 flex items-center justify-center gap-1.5">
                      {loadingSlug === a.slug + ':6'
                        ? <><span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> Соединяем…</>
                        : `6 мес — ${a.price_6mo?.toLocaleString('ru-RU')} ₽ (−20%)`}
                    </button>
                  )}
                  {!a.monthly_payable && !a.sixmo_payable && (
                    <p className="text-xs text-amber-600">Оплата этого модуля скоро появится</p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}


function SubscriptionHistoryBlock() {
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.subscriptions.listOrders().then((r: any) => {
      setOrders(r.orders || []); setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  if (loading) return null
  if (orders.length === 0) return null

  const STATUS_LABEL: Record<string, { label: string; color: string }> = {
    created:   { label: 'Создан, ждём оплату', color: 'text-amber-700 bg-amber-50' },
    paid:      { label: 'Оплачен',              color: 'text-green-700 bg-green-50' },
    failed:    { label: 'Ошибка оплаты',         color: 'text-red-700 bg-red-50' },
    cancelled: { label: 'Отменён',               color: 'text-gray-600 bg-gray-100' },
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
      <h3 className="font-semibold text-gray-800 mb-4">История оплат</h3>
      <div className="space-y-2">
        {orders.map(o => {
          const st = STATUS_LABEL[o.status] || { label: o.status, color: 'text-gray-600 bg-gray-100' }
          const amount = (o.amount_paid_card_kopecks || o.amount_paid_bonus_kopecks || o.amount_total_kopecks) / 100
          return (
            <div key={o.id} className="flex items-center justify-between text-sm py-2 border-b border-gray-50 last:border-0">
              <div>
                <div className="font-medium text-gray-800">{o.tariff_name}</div>
                <div className="text-xs text-gray-400">
                  {new Date(o.created_at).toLocaleString('ru-RU', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}
                </div>
              </div>
              <div className="text-right">
                <div className="font-semibold text-gray-900">{amount.toLocaleString('ru-RU')} ₽</div>
                <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded ${st.color}`}>
                  {st.label}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
