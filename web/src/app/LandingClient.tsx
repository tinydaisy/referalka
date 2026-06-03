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
}

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

const FEATURE_LABELS: Record<string, string> = {
  lead_magnets: 'Лид-магниты с воронкой',
  conference:   'Модуль «Конференция»',
  awards:       'Модуль «Премии»',
  channels:     'Свой бот в Telegram',
  export_contacts: 'Экспорт контактов',
}

const TARIFF_BASE_FEATURES = [
  'Контакты и сегментация',
  'Создание мероприятий',
  'Рассылки по своей базе',
]

export default function LandingClient() {
  const [tariffs, setTariffs] = useState<Tariff[]>([])
  const [promotions, setPromotions] = useState<Promotion[]>([])
  const [pid, setPid] = useState<string | null>(null)

  useEffect(() => {
    // Парсим pid из URL и сохраняем в localStorage — пригодится при регистрации
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const pidParam = params.get('pid')
      if (pidParam) {
        localStorage.setItem('pluson_referrer_pid', pidParam)
        setPid(pidParam)
      } else {
        setPid(localStorage.getItem('pluson_referrer_pid'))
      }
    }

    api.publicData.tariffs()
      .then(r => setTariffs((r.tariffs || []).filter((t: Tariff) => t.slug !== 'trial')))
      .catch(() => {})
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

          {pid && (
            <p className="mt-4 text-xs text-gray-400">
              Вас пригласили — реф-код <code className="bg-gray-100 px-2 py-0.5 rounded">{pid}</code> сохранён
            </p>
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

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 sm:gap-7 max-w-5xl mx-auto">
            {tariffs.map(t => (
              <TariffCard key={t.id} t={t} registerHref={registerHref} />
            ))}
          </div>

          {tariffs.length === 0 && (
            <p className="text-center text-gray-400">Тарифы загружаются…</p>
          )}
        </div>
      </section>

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

function TariffCard({ t, registerHref }: { t: Tariff; registerHref: string }) {
  const isPro = t.slug === 'pro'
  return (
    <div className={`relative rounded-2xl p-5 sm:p-7 border shadow-sm flex flex-col bg-white ${
      isPro ? 'border-amber-200 ring-2 ring-amber-100' : 'border-gray-100'
    }`}>
      {t.promo_banner_text && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold whitespace-nowrap">
          {t.promo_banner_text}
        </span>
      )}
      <h3 className="font-bold text-xl text-gray-900">{t.name}</h3>

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
        <span className="text-xs text-gray-400 mt-1">за {t.default_duration_days} дней</span>
      </div>

      <div className="space-y-2 mt-4 text-sm text-gray-600 flex-1">
        {TARIFF_BASE_FEATURES.map(text => (
          <div key={text} className="flex items-start gap-2">
            <CheckCircle size={14} className="text-emerald-500 shrink-0 mt-0.5" />
            <span>{text}</span>
          </div>
        ))}
        <div className="flex items-start gap-2">
          <CheckCircle size={14} className="text-emerald-500 shrink-0 mt-0.5" />
          <span>До {t.contact_limit?.toLocaleString('ru-RU')} контактов</span>
        </div>
        <div className="flex items-start gap-2">
          <CheckCircle size={14} className="text-emerald-500 shrink-0 mt-0.5" />
          <span>{t.broadcasts_daily_limit ? `До ${t.broadcasts_daily_limit.toLocaleString('ru-RU')} рассылок/сутки` : 'Безлимит рассылок'}</span>
        </div>
        {(t.feature_slugs || []).map(slug => (
          <div key={slug} className="flex items-start gap-2">
            <CheckCircle size={14} className="text-emerald-500 shrink-0 mt-0.5" />
            <span>{FEATURE_LABELS[slug] || slug}</span>
          </div>
        ))}
      </div>

      <Link href={registerHref} className={`mt-6 text-center px-5 py-2.5 rounded-xl text-sm font-semibold ${
        isPro ? 'btn-gold' : 'bg-[#25455D] text-white hover:opacity-90'
      }`}>
        Выбрать {t.name}
      </Link>
    </div>
  )
}
