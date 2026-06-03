'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CreditCard, CheckCircle2, X, ArrowRight, Wallet } from 'lucide-react'
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

  useEffect(() => {
    api.auth.me().then((d: any) => setMe(d)).catch(() => {})
    api.publicData.tariffs().then((r: any) => {
      const paid = (r.tariffs || []).filter((t: any) => t.slug !== 'trial' && Number(t.price) > 0 && t.prodamus_payment_url)
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
  const selectedTariff = tariffs.find(t => t.slug === selectedSlug)
  const selectedPriceKopecks = selectedTariff ? Math.round(Number(selectedTariff.price) * 100) : 0
  const canPayWithBonus = selectedTariff && bonusBalance >= selectedPriceKopecks && selectedPriceKopecks > 0

  const isExpired = !sub || !sub.is_active || sub.days_left < 0
  const expiresStr = sub?.expires_at
    ? new Date(sub.expires_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—'

  async function pay() {
    if (!selectedSlug) return
    setLoading(true)
    setError('')
    try {
      const res = await api.subscriptions.createOrder(selectedSlug)
      if (res?.payment_url) window.location.href = res.payment_url
      else { setError('Не удалось создать заказ'); setLoading(false) }
    } catch (e: any) {
      setError(e?.message || 'Ошибка оплаты'); setLoading(false)
    }
  }

  async function payWithBonus() {
    if (!selectedSlug || !canPayWithBonus) return
    if (!confirm(`Списать ${(selectedPriceKopecks / 100).toLocaleString('ru-RU')} ₽ с бонусного баланса?`)) return
    setBonusLoading(true); setError('')
    try {
      await api.subscriptions.payWithBonus(selectedSlug)
      setPaidBanner(true)
      setBonusBalance(b => b - selectedPriceKopecks)
      setTimeout(() => window.location.reload(), 1500)
    } catch (e: any) {
      setError(e?.message || 'Ошибка списания бонусов'); setBonusLoading(false)
    }
  }

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

      {/* Выбор тарифа */}
      {tariffs.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-2">Продлить или сменить тариф</h3>
          <p className="text-sm text-gray-500 mb-4">
            Оплата идёт через Prodamus, чек 54-ФЗ приходит на email автоматически.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            {tariffs.map(t => {
              const selected = selectedSlug === t.slug
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedSlug(t.slug)}
                  className={`text-left rounded-xl border p-4 transition-all ${
                    selected ? 'border-[#25455D] ring-2 ring-[#25455D]/20 bg-blue-50/30' : 'border-gray-200 hover:border-gray-300'
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

                  <div className="space-y-1 mt-3 text-xs text-gray-600">
                    <div>До {t.contact_limit?.toLocaleString('ru-RU')} контактов</div>
                    <div>{t.broadcasts_daily_limit ? `${t.broadcasts_daily_limit.toLocaleString('ru-RU')} рассылок/сутки` : 'Безлимит рассылок'}</div>
                    {(t.feature_slugs || []).map((slug: string) => (
                      <div key={slug}>· {featureLabels[slug] || slug}</div>
                    ))}
                  </div>
                </button>
              )
            })}
          </div>

          {bonusBalance > 0 && (
            <div className="mb-3 text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
              💰 Бонусный баланс: <b>{(bonusBalance / 100).toLocaleString('ru-RU')} ₽</b>
              {!canPayWithBonus && selectedTariff && (
                <span className="text-gray-500 ml-2">
                  · нужно ещё {((selectedPriceKopecks - bonusBalance) / 100).toLocaleString('ru-RU')} ₽ чтобы оплатить целиком
                </span>
              )}
            </div>
          )}

          {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

          <div className="flex gap-2 flex-wrap">
            <button
              onClick={pay}
              disabled={!selectedSlug || loading || bonusLoading}
              className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Создаём заказ…' : 'Оплатить картой'}
            </button>
            {canPayWithBonus && (
              <button
                onClick={payWithBonus}
                disabled={bonusLoading || loading}
                className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {bonusLoading ? 'Списываем…' : `Оплатить бонусами (${(selectedPriceKopecks / 100).toLocaleString('ru-RU')} ₽)`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Что входит в текущий тариф */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <h3 className="font-semibold text-gray-800 mb-4">Что входит в ваш тариф</h3>
        <div className="space-y-2 text-sm">
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
      </div>

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
