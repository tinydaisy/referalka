'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CreditCard, CheckCircle2, ArrowRight, Wallet } from 'lucide-react'
import { api } from '@/lib/api'

export default function SubscriptionPage() {
  const [me, setMe] = useState<any>(null)
  const [tariffs, setTariffs] = useState<any[]>([])
  const [promotions, setPromotions] = useState<any[]>([])
  const [featureLabels, setFeatureLabels] = useState<Record<string, string>>({})
  // Слаги, которые не показываем в карточке тарифа (доступ при этом есть).
  const [hiddenFeatures, setHiddenFeatures] = useState<Set<string>>(new Set())
  const [selectedSlug, setSelectedSlug] = useState<string>('')
  // Выбранный срок оплаты — ОДИН на все карточки: сравнивать тарифы можно
  // только в одинаковом сроке, иначе рядом стоят «1990 ₽» и «19 104 ₽».
  //
  // ⚠️ По умолчанию 12 месяцев — самый выгодный срок. Человек сразу видит
  // лучшую цену и экономию, а не месячную цену, от которой длинные сроки
  // выглядят дороже.
  const [months, setMonths] = useState(12)
  const [bonusBalance, setBonusBalance] = useState(0)
  const [paidBanner, setPaidBanner] = useState(false)
  const [loading, setLoading] = useState(false)
  const [bonusLoading, setBonusLoading] = useState(false)
  const [error, setError] = useState('')

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
      // ⚠️ Скрытые (features.hidden_in_card) в карточку не попадают, но доступ у
      // клиента остаётся — см. миграцию 353. Поэтому прячем ЗДЕСЬ, при показе, а
      // не вырезаем из feature_slugs: по ним фронт ещё и проверяет возможности.
      const map: Record<string, string> = {}
      const hidden: string[] = []
      for (const f of (r.features || [])) {
        map[f.slug] = f.name
        if (f.hidden_in_card) hidden.push(f.slug)
      }
      setFeatureLabels(map)
      setHiddenFeatures(new Set(hidden))
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
  const isExpired = !sub || !sub.is_active || sub.days_left < 0
  const isTrial = sub?.tariff_slug === 'trial'
  const expiresStr = sub?.expires_at
    ? new Date(sub.expires_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—'

  // Период тарифа по выбранному сроку. Всё считает бэкенд (services/tariff_periods.py)
  // и отдаёт готовым в `periods` — здесь ничего не вычисляем, иначе подпись
  // «−20%» однажды разойдётся с суммой, которую человек реально платит.
  function periodOf(t: any, m: number) {
    const list = t?.periods || []
    return list.find((p: any) => p.months === m) || list.find((p: any) => p.months === 1) || null
  }

  // Сроки, которые есть хотя бы у одного тарифа — из них строим переключатель.
  const availableMonths: number[] = Array.from(
    new Set<number>(tariffs.flatMap((t: any) => (t.periods || []).map((p: any) => Number(p.months))))
  ).sort((a, b) => a - b)

  // ⚠️ Страховка на дефолт: если 12 месяцев вообще не настроены (длинные сроки
  // выключили в базе), переключатель остался бы на несуществующем сроке и
  // подсветилась бы пустота. Тогда берём самый длинный из доступных.
  useEffect(() => {
    if (availableMonths.length && !availableMonths.includes(months)) {
      setMonths(availableMonths[availableMonths.length - 1])
    }
  }, [availableMonths.join(','), months])

  // Скидка и рублёвая экономия выбранного срока — для подписи над карточками.
  // Считаем из тех же периодов, что и цены: своей арифметики скидки нет.
  const maxDiscount = Math.max(0, ...tariffs.map(t => periodOf(t, months)?.discount_percent || 0))
  const maxSavingRub = Math.max(0, ...tariffs.map(t => {
    const p = periodOf(t, months)
    if (!p || p.months < 2) return 0
    return Number(t.price) * p.months - (p.total_kopecks || 0) / 100
  }))

  async function pay(slug: string, tariff: any) {
    if (!slug) return
    const period = periodOf(tariff, months)
    setSelectedSlug(slug)
    setLoading(true)
    setError('')
    try {
      // Провайдер: LeadPay если у тарифа настроена карточка, иначе Prodamus.
      // ⚠️ Длинные сроки бывают только у LeadPay — у Продамуса нет готовых
      // ссылок на такие суммы, поэтому при нём срок всегда 1 месяц.
      const provider = tariff?.leadpay_product_id ? 'leadpay' : 'prodamus'
      const payMonths = provider === 'leadpay' ? (period?.months || 1) : 1
      const res = await api.subscriptions.createOrder(slug, provider, payMonths)
      if (res?.payment_url) window.location.href = res.payment_url
      else { setError('Не удалось создать заказ'); setLoading(false) }
    } catch (e: any) {
      setError(e?.message || 'Ошибка оплаты'); setLoading(false)
    }
  }

  async function payWithBonus(slug: string, priceKopecks: number, payMonths: number) {
    if (!slug || bonusBalance < priceKopecks || priceKopecks <= 0) return
    const forWhat = payMonths > 1 ? ` за ${payMonths} мес.` : ''
    if (!confirm(`Списать ${(priceKopecks / 100).toLocaleString('ru-RU')} ₽ с бонусного баланса${forWhat}?`)) return
    setSelectedSlug(slug)
    setBonusLoading(true); setError('')
    try {
      await api.subscriptions.payWithBonus(slug, payMonths)
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

  // ⚠️ Ширина страницы — по экрану, а не max-w-4xl (896px): на широком мониторе
  // карточки жались влево, а справа оставалась пустая треть. Потолок 7xl —
  // чтобы строка списка возможностей не растягивалась в нечитаемую линейку.
  return (
    <div className="space-y-6 max-w-7xl">
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
            {/* ⚠️ Триалу отдельной карточки среди тарифов НЕ заводим — просто
                говорим словами, что это триал и какой тариф по нему открыт.
                Карточка читалась бы как ещё один покупаемый вариант, а купить
                триал нельзя. */}
            <h3 className="font-semibold text-gray-800 mb-1">
              {isTrial ? 'У вас триал — доступ к тарифу Профи' : (sub?.tariff_name || 'Тариф не определён')}
            </h3>
            <p className="text-sm text-gray-500">
              {isExpired ? 'Истёк' : 'Действует до'} <b>{expiresStr}</b>
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

      {/* ⚠️ Блока «Что входит в ваш тариф» здесь больше нет (26.08.2026). Он
          перечислял галочками то, что и так видно по разделам кабинета, и стоял
          НАД карточками тарифов — из-за него оплату приходилось искать
          прокруткой. Состав тарифа остался там, где он нужен для выбора: в
          самой карточке тарифа. */}

      {/* Выбор тарифа */}
      {tariffs.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h3 id="tariffs" className="scroll-mt-24 font-semibold text-gray-800 mb-2">Продлить или сменить тариф</h3>
          {/* ⚠️ Названия платёжной системы здесь нет намеренно: клиенту важно,
              что придёт чек, а через кого проведён платёж — наша кухня. */}
          <p className="text-sm text-gray-500 mb-4">
            Чек 54-ФЗ придёт на email автоматически.
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

          {/* Переключатель срока оплаты. Показываем, только если длинные сроки
              вообще настроены — иначе одинокая кнопка «1 месяц» бессмысленна. */}
          {availableMonths.length > 1 && (
            <div className="mb-4">
              <div className="inline-flex flex-wrap gap-1 rounded-xl bg-gray-100 p-1">
                {availableMonths.map(m => {
                  const active = months === m
                  // Скидку берём у любого тарифа, где этот срок есть: она
                  // одинакова у всех (−12% / −20%), но НЕ хардкодим её здесь —
                  // цифра приходит с бэка вместе с ценой.
                  const pct = tariffs.map(t => periodOf(t, m)?.discount_percent || 0)
                    .find(p => p > 0) || 0
                  return (
                    <button
                      key={m}
                      onClick={() => setMonths(m)}
                      // ⚠️ Активный срок — фирменный персик на тёмном тексте.
                      // Белым на светло-сером он читался как «ничего не выбрано».
                      className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
                        active
                          ? 'bg-[#FFCFA4] text-[#25455D] shadow-sm'
                          : 'text-gray-600 hover:text-[#25455D] hover:bg-white/70'
                      }`}
                    >
                      {m === 1 ? '1 месяц' : `${m} мес.`}
                      {pct > 0 && (
                        // ⚠️ На персике зелёный не читается — берём тёмный
                        // фирменный. Вне выделения зелёный уместен: он тянет
                        // взгляд к выгодным срокам.
                        <span className={`ml-1.5 text-xs font-bold ${active ? 'text-[#25455D]' : 'text-emerald-600'}`}>
                          −{pct}%
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              {months > 1 && (
                <div className="mt-2 text-sm font-semibold text-emerald-700">
                  Выгода {maxDiscount}% — платите сразу за {months} мес. и экономите
                  {maxSavingRub > 0 ? ` до ${maxSavingRub.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽` : ''}
                </div>
              )}
            </div>
          )}

          {/* ⚠️ Колонок СТОЛЬКО, СКОЛЬКО ТАРИФОВ (не жёстко три): продаваемых
              тарифа сейчас два, и третья колонка оставалась пустой дырой, а
              карточки при этом были вдвое уже, чем могли быть.
              Классы перечислены целиком — Tailwind вырезает те, что собраны
              склейкой строк, и сетка молча схлопнулась бы в одну колонку. */}
          <div className={`grid grid-cols-1 gap-4 ${
            tariffs.length >= 3 ? 'sm:grid-cols-3' : tariffs.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-1'
          }`}>
            {tariffs.map(t => {
              const isCurrent = me?.subscription?.tariff_slug === t.slug
              // ⚠️ Всё о цене — из периода, посчитанного бэкендом. Своей
              // арифметики тут нет: сумма в кнопке обязана совпадать с суммой
              // в платёжке до копейки.
              const period = periodOf(t, months)
              const payMonths = period?.months || 1
              // Период у тарифа не настроен (напр. только Продамус) — показываем
              // месячную цену и честно предупреждаем под кнопкой.
              const noLongPeriod = months > 1 && payMonths !== months
              const monthPrice = Number(period?.month_price ?? t.price)
              const priceKopecks = period?.total_kopecks ?? Math.round(Number(t.price) * 100)
              const totalRub = priceKopecks / 100
              const discount = period?.discount_percent || 0
              const busy = selectedSlug === t.slug && (loading || bonusLoading)
              const canBonus = bonusBalance >= priceKopecks && priceKopecks > 0
              return (
                <div
                  key={t.id}
                  // ⚠️ Рамка ВИДИМАЯ у обеих карточек. Была border-gray-200 —
                  // почти белая: на широких карточках «Профи» сливался с фоном
                  // страницы и выглядел как кусок пустоты рядом с обведённой
                  // «Экстра». Текущий тариф по-прежнему выделен темнее.
                  className={`flex flex-col rounded-xl border-2 p-5 bg-white shadow-sm ${
                    isCurrent
                      ? 'border-[#25455D] ring-2 ring-[#25455D]/15'
                      : 'border-gray-300'
                  }`}
                >
                  {t.promo_banner_text && (
                    <div className="text-[10px] font-bold tracking-wider uppercase text-amber-700 mb-1">
                      {t.promo_banner_text}
                    </div>
                  )}
                  <div className="font-semibold text-gray-900">{t.name}</div>
                  {/* ⚠️ Крупно — цена ЗА МЕСЯЦ, под ней итог за весь срок.
                      Наоборот нельзя: рядом с «1990 ₽» соседняя карточка с
                      «19 104 ₽» читается как в десять раз дороже, хотя это
                      тот же тариф на год и месяц там ДЕШЕВЛЕ. */}
                  <div className="mt-1 flex items-baseline gap-2 flex-wrap">
                    {payMonths > 1 ? (
                      <>
                        {/* Зачёркнутая старая цена — КРАСНАЯ и жирная: серая
                            терялась и выгода не читалась вовсе. */}
                        <span className="text-base font-bold line-through text-red-500">
                          {Number(t.price).toLocaleString('ru-RU')} ₽
                        </span>
                        <span className="text-2xl font-extrabold text-[#25455D]">
                          {monthPrice.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽
                        </span>
                        <span className="text-xs font-semibold text-gray-600">/мес</span>
                        {discount > 0 && (
                          <span className="text-xs font-extrabold text-white bg-emerald-600 rounded px-1.5 py-0.5">
                            −{discount}%
                          </span>
                        )}
                      </>
                    ) : t.promo_old_price && Number(t.promo_old_price) > Number(t.price) ? (
                      <>
                        <span className="text-base font-bold line-through text-red-500">{Number(t.promo_old_price).toLocaleString('ru-RU')} ₽</span>
                        <span className="text-2xl font-extrabold text-[#25455D]">{Number(t.price).toLocaleString('ru-RU')} ₽</span>
                      </>
                    ) : (
                      <span className="text-2xl font-extrabold text-[#25455D]">{Number(t.price).toLocaleString('ru-RU')} ₽</span>
                    )}
                  </div>
                  {/* ⚠️ Полная стоимость за срок — ЖИРНО и тёмным. Это ключевая
                      цифра: именно её человек заплатит, и по ней он понимает,
                      что берёт год, а не месяц. Бледно-серым она читалась как
                      сноска и терялась. */}
                  <div className={`mt-1 ${payMonths > 1 ? 'text-sm font-bold text-[#25455D]' : 'text-[11px] text-gray-400'}`}>
                    {payMonths > 1
                      ? `${totalRub.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽ за ${payMonths} мес. одним платежом`
                      : `за ${t.default_duration_days} дн.`}
                  </div>

                  {/* Список возможностей — темнее серого: на белой карточке
                      светло-серый мелкий текст почти не читается. */}
                  <div className="space-y-1 mt-3 text-xs text-gray-700 flex-1">
                    {/* ⚠️ Пустой лимит = БЕЗЛИМИТ (см. contact_limits.py) — без этой
                        ветки у Экстра печаталось «До  контактов на канал» с дырой
                        вместо числа. Так же устроена соседняя строка про рассылки. */}
                    <div>{t.contact_limit
                      ? `До ${t.contact_limit.toLocaleString('ru-RU')} контактов на канал`
                      : 'Неограниченное количество контактов'}</div>
                    <div>{t.broadcasts_daily_limit ? `${t.broadcasts_daily_limit.toLocaleString('ru-RU')} рассылок/сутки` : 'Безлимит рассылок'}</div>
                    {(t.feature_slugs || []).filter((slug: string) => !hiddenFeatures.has(slug)).map((slug: string) => (
                      <div key={slug}>· {featureLabels[slug] || slug}</div>
                    ))}
                  </div>

                  {/* ⚠️ На ТЕКУЩЕМ тарифе это ПРОДЛЕНИЕ, а не покупка: слово
                      «Оплатить» на уже оплаченном тарифе читается как «вы не
                      оплатили» и путает. Меняем только надпись — кнопка
                      остаётся персиковой (решение владельца): бледная кнопка
                      продления терялась ровно там, где подписка уже истекла и
                      продлить нужнее всего. */}
                  {/* ⚠️ На своём тарифе пишем не только «ваш», но и СРОК: из ряда
                      одинаковых карточек иначе не понять, оплачено ли ещё. */}
                  {isCurrent && (
                    <div className={`mt-4 text-center text-xs font-semibold ${
                      isExpired ? 'text-red-600' : 'text-[#25455D]'
                    }`}>
                      {isExpired
                        ? `Истекла ${expiresStr}`
                        : `✓ Подключено · истекает ${expiresStr}`}
                    </div>
                  )}
                  <button
                    onClick={() => pay(t.slug, t)}
                    disabled={busy}
                    className={`w-full btn-gold ${isCurrent ? 'mt-2' : 'mt-4'} px-4 py-2.5 rounded-xl text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5`}
                  >
                    {busy && loading
                      ? <><span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> Соединяем…</>
                      : `${isCurrent ? 'Продлить' : 'Оплатить'} ${totalRub.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽${payMonths > 1 ? ` за ${payMonths} мес.` : ''}`}
                  </button>
                  {/* ⚠️ Молча подставить месяц вместо выбранного года нельзя —
                      человек нажал бы «Оплатить» в полной уверенности, что
                      берёт год со скидкой. */}
                  {noLongPeriod && (
                    <div className="mt-1.5 text-[11px] text-amber-700">
                      Для этого тарифа оплата за {months} мес. не настроена — спишется за 1 месяц.
                    </div>
                  )}
                  {canBonus && (
                    <button
                      onClick={() => payWithBonus(t.slug, priceKopecks, payMonths)}
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
                // Кнопки с суммами длиннее прежних «На месяц» — в столбик,
                // иначе в узкой карточке текст сжимается и рвётся.
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
                {/* Срок в истории обязателен: без него две оплаты одного
                    тарифа на разные суммы выглядят как ошибка списания. */}
                <div className="font-medium text-gray-800">
                  {o.tariff_name}
                  {o.months > 1 && <span className="text-gray-500 font-normal"> · {o.months} мес.</span>}
                </div>
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
