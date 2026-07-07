'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CheckCircle, ArrowRight, Users, Megaphone, Gift } from 'lucide-react'
import { api } from '@/lib/api'

interface Tariff {
  id: number
  slug: string
  name: string
  price: number
  default_duration_days: number
  contact_limit: number
  broadcasts_daily_limit: number | null
  prodamus_payment_url: string | null
  promo_banner_text: string | null
  promo_old_price: number | null
  feature_slugs: string[]
  bullet_points: Bullet[]
}

// Пункт тарифа: либо строка, либо заголовок с вложенными подпунктами.
type Bullet = string | { title: string; sub: string[] }

interface Promotion {
  id: number
  slug: string
  name: string
  description: string | null
  type: string
  value: number
  target_tariff_slug: string | null
  max_uses: number | null
  used_count: number
  remaining: number | null
}

interface Feature {
  slug: string
  name: string
  description: string | null
  is_addon: boolean
  coming_soon?: boolean
  price_monthly: number | null
  price_6mo: number | null
  promo_old_monthly: number | null
  promo_old_6mo: number | null
  min_tariff_slug: string | null
  tagline: string | null
  bullet_points: string[]
  bundle_price?: number | null
}


export default function LandingClient() {
  const [tariffs, setTariffs] = useState<Tariff[]>([])
  const [promotions, setPromotions] = useState<Promotion[]>([])
  const [featureLabels, setFeatureLabels] = useState<Record<string, string>>({})
  const [addonModules, setAddonModules] = useState<Feature[]>([])
  const [pid, setPid] = useState<string | null>(null)
  // Инфо о пригласившем — заполняется только если pid ВАЛИДНЫЙ (реальный код).
  const [referrer, setReferrer] = useState<{ referrer_name: string; bonus_days: number; total_days: number } | null>(null)

  useEffect(() => {
    // Парсим pid из URL и сохраняем в localStorage — пригодится при регистрации
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const pidParam = params.get('pid')
      const effective = pidParam || localStorage.getItem('pluson_referrer_pid')
      if (effective) {
        // Валидируем код на бэке: мусорный/несуществующий pid не сохраняем и не
        // показываем плашку (напр. если открыли ссылку с сырым {plsn_ref}).
        api.auth.referrerInfo(effective)
          .then((r: any) => {
            if (r?.valid) {
              localStorage.setItem('pluson_referrer_pid', effective)
              setPid(effective)
              setReferrer({ referrer_name: r.referrer_name, bonus_days: r.bonus_days, total_days: r.total_days })
            } else {
              localStorage.removeItem('pluson_referrer_pid')
              setPid(null)
            }
          })
          .catch(() => {})
      }
    }

    api.publicData.tariffs()
      .then(r => {
        // Порядок слева направо: Триал (0₽), затем платные по цене (Профи, Экстра).
        const all: Tariff[] = (r.tariffs || [])
        const trial = all.filter(t => t.slug === 'trial')
        const paid = all.filter(t => t.slug !== 'trial').sort((a, b) => Number(a.price) - Number(b.price))
        setTariffs([...trial, ...paid])
      })
      .catch(() => {})
    api.publicData.features().then((r: any) => {
      const feats: Feature[] = r.features || []
      const map: Record<string, string> = {}
      for (const f of feats) map[f.slug] = f.name
      setFeatureLabels(map)
      setAddonModules(feats.filter(f => f.is_addon))
    }).catch(() => {})
    api.publicData.activePromotions()
      .then(r => setPromotions(r.promotions || []))
      .catch(() => {})
  }, [])

  const trialBonus = promotions.find(p => p.type === 'trial_bonus_days')
  const registerHref = pid ? `/register?pid=${encodeURIComponent(pid)}` : '/register'

  return (
    <div className="min-h-screen bg-white">
      {/* Шапка */}
      <header className="border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl sm:text-2xl font-bold" style={{ color: '#25455D' }}>iViSiON: ПЛЮСОН</span>
          </div>
          <nav className="flex items-center gap-2 sm:gap-4">
            <Link href="/login" className="text-sm text-gray-600 hover:text-gray-900 px-3 py-2">Войти</Link>
            <Link href={registerHref} className="btn-gold px-4 py-2 rounded-xl text-sm font-semibold">Начать</Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-12 sm:py-20 text-center">
          <h1 className="text-3xl sm:text-5xl font-bold leading-tight" style={{ color: '#25455D' }}>
            Платформа для организаторов и&nbsp;экспертов
          </h1>
          <p className="mt-4 sm:mt-6 text-base sm:text-xl text-gray-600 max-w-3xl mx-auto leading-relaxed">
            Управляйте событием от&nbsp;А до&nbsp;Я — спикеры, рассылки, рефералы в&nbsp;одном месте.
          </p>

          {trialBonus && (
            <div className="mt-6 sm:mt-8 inline-flex flex-col sm:flex-row items-center gap-2 sm:gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 sm:px-6 py-3">
              <span className="text-amber-900 font-semibold text-sm sm:text-base">🎁 {trialBonus.name}</span>
              {trialBonus.remaining != null && trialBonus.remaining > 0 && (
                <span className="text-xs sm:text-sm text-amber-700">Осталось мест: <b>{trialBonus.remaining}</b> из {trialBonus.max_uses}</span>
              )}
            </div>
          )}

          <div className="mt-8 sm:mt-10 flex flex-col sm:flex-row gap-3 justify-center">
            <Link href={registerHref} className="btn-gold px-6 sm:px-8 py-3 rounded-xl font-semibold inline-flex items-center justify-center gap-2">
              Зарегистрироваться
              <ArrowRight size={16} />
            </Link>
            <Link href="/login" className="px-6 sm:px-8 py-3 rounded-xl font-medium border border-gray-200 text-gray-700 hover:bg-gray-50 inline-flex items-center justify-center">
              У&nbsp;меня уже есть аккаунт
            </Link>
          </div>

          {referrer && (
            <div className="mt-5 inline-flex flex-col items-center gap-1 bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3">
              <span className="text-amber-900 font-semibold text-sm sm:text-base">
                🎁 Вам доступен продлённый триал — {referrer.total_days} дней
              </span>
              {referrer.referrer_name && (
                <span className="text-xs sm:text-sm text-amber-700">
                  Вас пригласил {referrer.referrer_name}
                </span>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Что внутри */}
      <section className="bg-gray-50 py-14 sm:py-20">
        <div className="max-w-6xl mx-auto px-5 sm:px-8">
          <h2 className="text-2xl sm:text-3xl font-bold text-center mb-10 sm:mb-14" style={{ color: '#25455D' }}>
            Всё для запуска события в одном месте
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 sm:gap-7">
            {[
              { icon: Users, title: 'Контакты и сегментация',
                text: 'Единая база участников из всех каналов. Фильтры по тегам, UTM, событиям, лид-магнитам.' },
              { icon: Megaphone, title: 'Рассылки и воронки',
                text: 'Шаблоны под спикеров и дни конференции. Лид-магниты с подпиской и follow-up.' },
              { icon: Gift, title: 'Рефералы и подарки',
                text: 'Участники приглашают друзей за пороговые подарки. Mini App с прогрессом и шерингом.' },
            ].map(({ icon: Icon, title, text }) => (
              <div key={title} className="bg-white rounded-2xl p-5 sm:p-6 border border-gray-100">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                  <Icon size={18} className="text-[#FFCFA4]" />
                </div>
                <h3 className="font-semibold text-gray-900 mb-1.5">{title}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Тарифы */}
      <section className="py-14 sm:py-20">
        <div className="max-w-6xl mx-auto px-5 sm:px-8">
          <h2 className="text-2xl sm:text-3xl font-bold text-center mb-3" style={{ color: '#25455D' }}>Тарифы</h2>
          <p className="text-sm sm:text-base text-gray-500 text-center max-w-2xl mx-auto mb-10 sm:mb-14">
            Сначала trial бесплатно. Дальше — выбираете тариф, оплачиваете картой через Prodamus,
            используете весь функционал.
          </p>

          <div className="flex flex-wrap justify-center gap-5 sm:gap-7 max-w-5xl mx-auto [&>*]:w-full [&>*]:sm:w-[300px]">
            {tariffs.map(t => (
              <TariffCard key={t.id} t={t} registerHref={registerHref} featureLabels={featureLabels} trialBonus={trialBonus} />
            ))}
          </div>

          {tariffs.length === 0 && (
            <p className="text-center text-gray-400">Тарифы загружаются…</p>
          )}
        </div>
      </section>

      {/* Модули (аддоны поверх тарифа) */}
      {addonModules.length > 0 && (
        <section className="bg-gray-50 py-14 sm:py-20">
          <div className="max-w-6xl mx-auto px-5 sm:px-8">
            <h2 className="text-2xl sm:text-3xl font-bold text-center mb-3" style={{ color: '#25455D' }}>
              Модули
            </h2>
            <p className="text-sm sm:text-base text-gray-500 text-center max-w-2xl mx-auto mb-10 sm:mb-14">
              Подключаются поверх тарифа <b>Профи</b> и выше. Оплата помесячно или за&nbsp;6&nbsp;месяцев со&nbsp;скидкой&nbsp;20%.
            </p>
            <div className="flex flex-wrap justify-center gap-5 sm:gap-7 max-w-5xl mx-auto [&>*]:w-full [&>*]:sm:w-[300px]">
              {addonModules.map(m => (
                <ModuleCard key={m.slug} m={m} registerHref={registerHref} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Финальный CTA */}
      <section className="py-14 sm:py-20" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        <div className="max-w-3xl mx-auto px-5 sm:px-8 text-center">
          <h2 className="text-2xl sm:text-3xl font-bold text-white">Готовы запустить событие?</h2>
          <p className="mt-3 text-white/70 text-base sm:text-lg">
            Зарегистрируйтесь сейчас и получите trial-доступ ко всем модулям.
          </p>
          <Link href={registerHref} className="mt-6 sm:mt-8 inline-flex items-center gap-2 btn-gold px-6 sm:px-8 py-3 rounded-xl font-semibold">
            Создать аккаунт
            <ArrowRight size={16} />
          </Link>
        </div>
      </section>

      <footer className="py-8 text-center text-xs text-gray-400">
        © iViSiON: ПЛЮСОН, {new Date().getFullYear()}
      </footer>
    </div>
  )
}

function TariffCard({ t, registerHref, featureLabels, trialBonus }: { t: Tariff; registerHref: string; featureLabels: Record<string, string>; trialBonus?: Promotion }) {
  const isPro = t.slug === 'pro'
  const isTrial = t.slug === 'trial'
  // Срок триала с учётом активной акции: база + бонусные дни.
  const trialDays = t.default_duration_days + (isTrial && trialBonus ? Number(trialBonus.value || 0) : 0)
  return (
    <div className={`relative rounded-2xl p-5 sm:p-7 border shadow-sm flex flex-col bg-white ${
      isPro ? 'border-amber-200 ring-2 ring-amber-100' : 'border-gray-100'
    }`}>
      {t.promo_banner_text && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold whitespace-nowrap">
          {t.promo_banner_text}
        </span>
      )}
      {isTrial && !t.promo_banner_text && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-semibold whitespace-nowrap">
          Попробуй бесплатно
        </span>
      )}
      <h3 className="font-bold text-xl text-gray-900">{t.name}</h3>
      {isTrial && (
        <p className="mt-1 text-sm text-gray-500">Полный доступ ко всему на {trialDays} дней — попробовать бесплатно</p>
      )}
      {isTrial && trialBonus && (
        <p className="mt-1 text-xs font-semibold text-emerald-600">🎁 Акция: {trialDays} дней вместо {t.default_duration_days}</p>
      )}

      <div className="mt-3 mb-1 min-h-[3.5rem] flex flex-col">
        {t.promo_old_price && Number(t.promo_old_price) > 0 && Number(t.promo_old_price) > Number(t.price) ? (
          <>
            <span className="text-sm line-through text-gray-400">{Number(t.promo_old_price).toLocaleString('ru-RU')} ₽</span>
            <span className="text-3xl font-bold" style={{ color: '#25455D' }}>
              {Number(t.price).toLocaleString('ru-RU')} ₽
            </span>
          </>
        ) : (
          <span className="text-3xl font-bold" style={{ color: '#25455D' }}>
            {Number(t.price).toLocaleString('ru-RU')} ₽
          </span>
        )}
        <span className="text-xs text-gray-400 mt-1">за {trialDays} дней</span>
      </div>

      <div className="space-y-2 mt-4 text-sm text-gray-600 flex-1">
        {(t.bullet_points || []).map((b, i) => (
          typeof b === 'string' ? (
            <div key={i} className="flex items-start gap-2">
              <CheckCircle size={14} className="text-emerald-500 shrink-0 mt-0.5" />
              <span>{b}</span>
            </div>
          ) : (
            <div key={i}>
              <div className="flex items-start gap-2">
                <CheckCircle size={14} className="text-emerald-500 shrink-0 mt-0.5" />
                <span className="font-medium text-gray-700">{b.title}</span>
              </div>
              <ul className="mt-1.5 ml-6 space-y-1">
                {(b.sub || []).map((s, j) => (
                  <li key={j} className="flex items-start gap-2 text-gray-500">
                    <span className="text-[#FFCFA4] mt-0.5 shrink-0">•</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )
        ))}
      </div>

      <Link href={registerHref} className={`mt-6 text-center px-5 py-2.5 rounded-xl text-sm font-semibold ${
        isPro ? 'btn-gold' : 'bg-[#25455D] text-white hover:opacity-90'
      }`}>
        {isTrial ? 'Попробовать бесплатно' : `Выбрать ${t.name}`}
      </Link>
    </div>
  )
}

function ModuleCard({ m, registerHref }: { m: Feature; registerHref: string }) {
  return (
    <div className="relative rounded-2xl p-5 sm:p-7 border border-gray-100 shadow-sm flex flex-col bg-white">
      <h3 className="font-bold text-xl text-gray-900">{m.name}</h3>
      {m.tagline && <p className="mt-1 text-sm text-gray-500">{m.tagline}</p>}

      {m.coming_soon ? (
        <div className="mt-4 mb-1">
          <span className="inline-block px-3 py-1 rounded-lg bg-amber-50 text-amber-700 text-sm font-semibold">🔜 Скоро будет</span>
        </div>
      ) : (
        <>
          <div className="mt-4 mb-1 flex items-baseline gap-2">
            {m.promo_old_monthly && m.promo_old_monthly > (m.price_monthly || 0) && (
              <span className="text-xl line-through text-gray-400">
                {m.promo_old_monthly.toLocaleString('ru-RU')} ₽
              </span>
            )}
            <span className="text-3xl font-bold" style={{ color: '#25455D' }}>
              {m.price_monthly?.toLocaleString('ru-RU')} ₽
            </span>
            <span className="text-sm text-gray-400">/ мес</span>
          </div>
          {m.price_6mo && m.price_6mo < (m.price_monthly || 0) && (
            <p className="text-xs text-emerald-600 font-medium">
              {m.price_6mo.toLocaleString('ru-RU')} ₽/мес при оплате за 6 мес (−20%)
            </p>
          )}
        </>
      )}

      <div className="space-y-2 mt-5 text-sm text-gray-600 flex-1">
        {(m.bullet_points || []).map((b, i) => (
          <div key={i} className="flex items-start gap-2">
            <CheckCircle size={14} className="text-emerald-500 shrink-0 mt-0.5" />
            <span>{b}</span>
          </div>
        ))}
      </div>

      {m.coming_soon ? (
        <div className="mt-5 text-center px-5 py-2.5 rounded-xl text-sm font-semibold bg-gray-100 text-gray-400">
          Скоро будет
        </div>
      ) : (
        <>
          {m.bundle_price ? (
            <div className="mt-5 text-xs text-gray-500">
              С тарифом Профи — <span className="font-semibold text-[#25455D]">{m.bundle_price.toLocaleString('ru-RU')} ₽</span> / мес одной оплатой
            </div>
          ) : (
            <div className="mt-5 flex items-center gap-1.5 text-xs text-gray-400">
              <span>🔒</span>
              <span>Нужен тариф Профи или выше</span>
            </div>
          )}

          <Link href={registerHref} className="mt-4 text-center px-5 py-2.5 rounded-xl text-sm font-semibold btn-gold">
            {m.bundle_price ? `Оформить с Профи — ${m.bundle_price.toLocaleString('ru-RU')} ₽` : 'Подключить'}
          </Link>
        </>
      )}
    </div>
  )
}
