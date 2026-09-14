'use client'
import { useState, useEffect, useMemo } from 'react'
import { useMe } from '@/hooks/useMe'
import { Plus, Save, Trash2, Pencil, X, Users, FileText, ChevronUp, ChevronDown, Search, Check, Download } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useUrlTab } from '@/hooks/useUrlTab'
import { usePaymentMinimum } from '@/hooks/usePaymentMinimum'
import { MultiSelectDropdown } from '@/components/MultiSelectDropdown'

// Тарифы мероприятия (миграция 157). Раздел показывается только клиентам
// тарифа vip — гейтинг в page.tsx, на бэке write-операции тоже 403 для остальных.

interface Tariff {
  id: number
  code: string
  title: string
  description: string | null
  excluded_description: string | null
  // price — цена К ОПЛАТЕ (уже со скидкой). old_price / discount_percent
  // приходят с бэкенда посчитанными, руками их не вычисляем.
  price: number | null
  discount_kind?: 'percent' | 'amount' | null
  discount_value?: number | null
  old_price?: number | null
  discount_percent?: number | null
  // Вознаграждение партнёру (миграция 347). NULL = действует умолчание
  // из раздела «Моя партнёрка».
  partner_reward_kind?: 'percent' | 'fixed' | null
  partner_reward_value?: number | null
  pay_url: string | null
  sort_order: number
  is_active: boolean
  is_featured?: boolean
  pay_product_id?: string | null
  order_hint?: string | null
  // Бонус в ПЛЮСОНе (миграция 307): что выдать покупателю при оплате.
  bonus_feature_id?: number | null
  bonus_days?: number | null
  bonus_trial?: boolean | null
  bonus_tariff_slug?: string | null
  bonus_line_auto?: boolean | null
  bonus_feature_name?: string | null
  // Сколько номинаций премии открывает тариф (миграция 328).
  nominations_grant?: number | null
  buyers_count: number
  unpaid_count: number
}

interface Buyer {
  id: number
  participant_id: number
  status: 'paid' | 'unpaid'
  note: string | null
  paid_at: string | null
  ordered_at: string | null
  source: string | null
  amount: number | null
  external_payment_id: string | null
  contact_id: number
  contact_name: string | null
  phone: string | null
  email: string | null
  tg_id: string | null
  tg_username: string | null
  vk_id: string | null
  vk_username: string | null
  max_id: string | null
  max_username: string | null
}

const emptyForm = {
  code: '', title: '', description: '', excluded_description: '', price: '', pay_url: '', pay_product_id: '', order_hint: '', is_active: true, is_featured: false,
  bonus_feature_id: '' as string, bonus_days: '30' as string,
  bonus_trial: false, bonus_tariff_slug: 'trial' as string,
  bonus_line_auto: true,
  // Скидка: пустой размер = скидки нет.
  discount_kind: 'percent' as 'percent' | 'amount', discount_value: '',
  // Сколько номинаций премии открывает тариф (миграция 328). Пусто = нисколько.
  nominations_grant: '',
  // Вознаграждение партнёру (миграция 347). Пусто = действует умолчание
  // из раздела «Моя партнёрка».
  partner_reward_kind: 'percent' as 'percent' | 'fixed',
  partner_reward_value: '',
}

/** Цена до скидки — только для подсказки в форме. Боевое значение считает
 *  бэкенд (services/tariff_discount.py), здесь просто показываем, что выйдет. */
function calcOldPrice(price: string, kind: 'percent' | 'amount', value: string): number | null {
  const p = parseInt(price, 10)
  const v = parseInt(value, 10)
  if (!Number.isFinite(p) || !Number.isFinite(v) || v <= 0 || p < 0) return null
  if (kind === 'percent') {
    if (v >= 100) return null
    const old = Math.round((p * 100) / (100 - v))
    return old > p ? old : null
  }
  return p + v
}

export default function TariffsTab({
  event, eventId, onReload, subTab: subTabProp, hideSubNav,
}: {
  event: any
  eventId: number
  onReload?: () => Promise<void>
  subTab?: 'tariffs' | 'orders'
  hideSubNav?: boolean
}) {
  // Поле «Вознаграждение партнёру» показываем только при подключённой
  // партнёрской программе (миграция 347).
  const { me } = useMe()
  const hasPartnerProgram = (me?.features || []).includes('partner_program')
  // Участие события в партнёрке — читаем из самого события, пишем PATCH'ем.
  const [partnerOn, setPartnerOn] = useState<boolean>(!!event?.partner_enabled)
  const [savingPartner, setSavingPartner] = useState(false)
  useEffect(() => { setPartnerOn(!!event?.partner_enabled) }, [event?.partner_enabled])
  const [items, setItems] = useState<Tariff[]>([])
  const [loading, setLoading] = useState(true)
  // Оферта события: документ из раздела «Оферты» (главный способ) либо ссылка
  // на чужой сайт. Выбранный документ приоритетнее ссылки — так же на бэке.
  const [offerUrl, setOfferUrl] = useState(event.offer_url || '')
  const [offerId, setOfferId] = useState<number | null>(event.offer_id ?? null)
  const [offers, setOffers] = useState<{ id: number; title: string }[]>([])
  const [savingOffer, setSavingOffer] = useState(false)

  // ⚠️ Оферта нужна только там, где берут ДЕНЬГИ: у события с одними
  // бесплатными тарифами требовать её незачем — красная плашка на пустом месте
  // приучает не обращать на неё внимания.
  const offerMissing = !offerId && !offerUrl.trim()
    && items.some(t => t.is_active && (t.price ?? 0) > 0)

  // форма создания/редактирования
  const [editing, setEditing] = useState<Tariff | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<typeof emptyForm>(emptyForm)
  const [saving, setSaving] = useState(false)

  // раскрытый блок «кто оплатил» (inline, не модалка)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  // Подключена ли своя платёжная система: от этого зависит, что спрашивать
  // у тарифа — код товара (мы сами создаём заказ) или внешнюю ссылку.
  const [payReady, setPayReady] = useState(false)
  const [needsProductId, setNeedsProductId] = useState(false)
  // Предупреждение о цене ниже минимума платёжной системы.
  const { warnFor: minPaymentWarn } = usePaymentMinimum()
  // Модули ПЛЮСОНа, которые тариф может выдать бонусом (миграция 307).
  // Пустой список = у клиента нет фичи, блок в форме не показываем.
  const [bonusFeatures, setBonusFeatures] = useState<{ id: number; slug: string; name: string }[]>([])
  // подвкладка: настройка тарифов / сводная таблица заказов (запоминается в URL ?sub=).
  // Если subTab передан сверху (родитель управляет через группировку вкладок) —
  // используем его и прячем свою панель подвкладок (hideSubNav).
  const [subTabLocal, setSubTab] = useUrlTab<'tariffs' | 'orders'>('sub', 'tariffs', ['tariffs', 'orders'])
  const subTab = subTabProp ?? subTabLocal

  async function load() {
    setLoading(true)
    try {
      const r = await api.eventTariffs.list(eventId)
      setItems(r.items || [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [eventId])

  // Молча: раздел может быть недоступен на тарифе — тогда остаётся ссылка.
  useEffect(() => {
    api.paymentSettings.get()
      .then(r => {
        setPayReady(!!r?.is_configured)
        // ⚠️ Код товара сейчас не нужен НИ ОДНОЙ системе: LeadPay переведён
        // на v2, где название и цена идут в запросе. Флаг оставлен как
        // единая точка — вернётся система с карточками, поле появится само.
        setNeedsProductId(!!r?.needs_product_id)
      })
      .catch(() => {})
  }, [])

  // Молча: без фичи бэкенд отдаёт available:false — блока просто не будет.
  useEffect(() => {
    api.eventTariffs.bonusFeatures(eventId)
      .then((r: any) => setBonusFeatures(r?.available ? (r.items || []) : []))
      .catch(() => {})
  }, [eventId])

  // Молча: раздел оферт закрыт на тарифе без фичи offers — тогда остаётся
  // только ссылка, селектор покажет пустой список с подсказкой.
  useEffect(() => {
    api.offers.list()
      .then(r => setOffers((r?.items || []).filter((o: any) => o.is_active)))
      .catch(() => {})
  }, [])

  async function saveOffer() {
    setSavingOffer(true)
    try {
      await api.events.update(eventId, {
        offer_url: offerUrl.trim() || null,
        offer_id: offerId,
      })
      await onReload?.()
    } finally {
      setSavingOffer(false)
    }
  }

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
    setShowForm(true)
  }
  function openEdit(t: Tariff) {
    setEditing(t)
    setForm({
      code: t.code,
      title: t.title,
      description: t.description || '',
      excluded_description: t.excluded_description || '',
      pay_product_id: t.pay_product_id || '',
      order_hint: t.order_hint || '',
      price: t.price != null ? String(t.price) : '',
      pay_url: t.pay_url || '',
      is_active: t.is_active,
      is_featured: !!t.is_featured,
      bonus_feature_id: t.bonus_feature_id ? String(t.bonus_feature_id) : '',
      bonus_days: String(t.bonus_days || 30),
      bonus_trial: !!t.bonus_trial,
      bonus_tariff_slug: t.bonus_tariff_slug || 'trial',
      bonus_line_auto: t.bonus_line_auto !== false,
      partner_reward_kind: (t.partner_reward_kind || 'percent') as 'percent' | 'fixed',
      partner_reward_value: t.partner_reward_value != null ? String(t.partner_reward_value) : '',
      discount_kind: (t.discount_kind || 'percent') as 'percent' | 'amount',
      discount_value: t.discount_value != null ? String(t.discount_value) : '',
      nominations_grant: t.nominations_grant != null ? String(t.nominations_grant) : '',
    })
    setShowForm(true)
  }

  async function submitForm() {
    const code = form.code.trim().toLowerCase()
    const title = form.title.trim()
    if (!code) { alert('Укажите код тарифа (например vip) — он нужен платёжке.'); return }
    if (!title) { alert('Укажите название тарифа.'); return }
    const payload = {
      code,
      title,
      description: form.description.trim() || null,
      excluded_description: form.excluded_description.trim() || null,
      pay_product_id: form.pay_product_id.trim() || null,
      order_hint: form.order_hint.trim() || null,
      price: form.price.trim() ? parseInt(form.price.trim(), 10) : null,
      // Пустой размер = скидки нет; бэкенд занулит и вид, чтобы в базе не
      // осталось половины пары.
      discount_kind: form.discount_value.trim() ? form.discount_kind : null,
      discount_value: form.discount_value.trim() ? parseInt(form.discount_value.trim(), 10) : null,
      // Пара пишется целиком: половина не пройдёт проверку в базе.
      partner_reward_kind: form.partner_reward_value.trim() ? form.partner_reward_kind : null,
      partner_reward_value: form.partner_reward_value.trim()
        ? Number(form.partner_reward_value.trim()) : null,
      pay_url: form.pay_url.trim() || null,
      is_active: form.is_active,
      is_featured: form.is_featured,
      // ⚠️ Шлём всегда: галочка «дарить доступ в ПЛЮСОН» доступна ВСЕМ
      // клиентам. Раньше поля отправлялись только при наличии платных
      // модулей, и подарить триал было нечем.
      bonus_feature_id: form.bonus_feature_id ? parseInt(form.bonus_feature_id, 10) : null,
      bonus_days: parseInt(form.bonus_days || '30', 10) || 30,
      bonus_trial: form.bonus_trial,
      bonus_tariff_slug: form.bonus_tariff_slug || 'trial',
      bonus_line_auto: form.bonus_line_auto,
      // Номинации премии (миграция 328). Пусто = тариф их не даёт; шлём
      // null, а не '', чтобы поле реально очищалось.
      nominations_grant: form.nominations_grant.trim()
        ? parseInt(form.nominations_grant.trim(), 10) : null,
    }
    setSaving(true)
    try {
      if (editing) await api.eventTariffs.update(eventId, editing.id, payload)
      else await api.eventTariffs.create(eventId, payload)
      setShowForm(false)
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить тариф')
    } finally {
      setSaving(false)
    }
  }

  async function removeTariff(t: Tariff) {
    if (!confirm(`Удалить тариф «${t.title}»? Записи об оплатах этого тарифа тоже удалятся.`)) return
    await api.eventTariffs.remove(eventId, t.id)
    await load()
  }

  /** Переставить тариф на позицию выше/ниже. Порядок в кабинете = порядок
   *  на лендинге. Список обновляем сразу, не дожидаясь ответа — иначе
   *  стрелка кажется залипшей. */
  async function move(index: number, dir: -1 | 1) {
    const to = index + dir
    if (to < 0 || to >= items.length) return
    const next = [...items]
    ;[next[index], next[to]] = [next[to], next[index]]
    setItems(next)
    try {
      await api.eventTariffs.reorder(eventId, next.map(t => t.id))
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить порядок')
      await load()
    }
  }

  if (loading) return <div className="py-16 flex justify-center"><Spinner /></div>

  return (
    <div className={subTab === 'orders' ? '' : 'max-w-3xl'}>
      {/* Подвкладки: Тарифы / Заказы — прячем, если родитель управляет ими сам
          (вынес в общий ряд вкладок раздела «Платежи»). */}
      {!hideSubNav && (
        <div className="border-b border-gray-200 mb-6 flex gap-1">
          {([['tariffs', 'Тарифы'], ['orders', 'Заказы']] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setSubTab(k)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                subTab === k ? 'border-[#FFCFA4] text-[#25455D]' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {subTab === 'orders' && <OrdersTable eventId={eventId} onChanged={load} />}

      {subTab === 'tariffs' && (
    <div className="space-y-6">
      {/* Участие события в партнёрской программе (миграция 347).
          ⚠️ Без этой галочки начисления НЕ создаются вовсе — проверка стоит
          в самом начислении. Поэтому она обязана быть в интерфейсе: колонка
          с DEFAULT FALSE и никакого способа её включить = мёртвая партнёрка. */}
      {hasPartnerProgram && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" className="mt-1" disabled={savingPartner}
                   checked={partnerOn}
                   onChange={async e => {
                     const next = e.target.checked
                     setSavingPartner(true)
                     try {
                       await api.events.update(eventId, { partner_enabled: next })
                       setPartnerOn(next)
                     } catch (err: any) {
                       alert(err?.message || 'Не удалось сохранить')
                     } finally { setSavingPartner(false) }
                   }} />
            <div>
              <div className="text-sm font-medium text-gray-800">
                Участвует в партнёрской программе
              </div>
              <div className="text-xs text-gray-500">
                Партнёры смогут рекомендовать это событие и получать
                вознаграждение с оплат. Размер задаётся у тарифа или
                в разделе «Моя партнёрка».
              </div>
            </div>
          </label>
        </div>
      )}

      {/* Оферта события.
          ⚠️⚠️ ПУСТАЯ ОФЕРТА ПРИ ПЛАТНЫХ ТАРИФАХ ПОДСВЕЧИВАЕТСЯ КРАСНЫМ
          (08.09.2026). Раньше блок выглядел как обычное необязательное поле —
          и клиент продавал платный тариф без оферты, не замечая этого:
          галочка «Принимаю условия» на форме заказа просто не появлялась.
          Ошибка юридическая, поэтому она обязана бросаться в глаза. */}
      <div className={`rounded-2xl border p-5 ${
        offerMissing ? 'border-red-300 bg-red-50/60' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-center gap-2 mb-1">
          <FileText size={18} className={offerMissing ? 'text-red-600' : 'text-brand'} />
          <h3 className={`font-semibold ${offerMissing ? 'text-red-700' : 'text-gray-800'}`}>
            Оферта мероприятия
          </h3>
          {offerMissing && (
            <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
              не выбрана
            </span>
          )}
        </div>
        {offerMissing ? (
          // ⚠️ Говорим, ЧТО именно не так и чем это грозит: «заполните поле»
          // человек пролистывает, «продаёте без оферты» — нет.
          <p className="mb-3 text-xs leading-relaxed text-red-700">
            У события есть платные тарифы, а оферта не задана. Значит на форме
            заказа не будет галочки «Принимаю условия оферты» — люди платят,
            не приняв ваших условий. Выберите документ или укажите ссылку.
          </p>
        ) : (
          <p className="text-xs text-gray-400 mb-3">
            Одна на всё событие. Появится галочкой «Принимаю условия оферты» на форме
            заказа платного тарифа и ссылкой внизу лендинга.
          </p>
        )}

        <label className="mb-1 block text-sm font-medium text-gray-700">
          Документ из раздела «Оферты»
        </label>
        <select
          value={offerId ?? ''}
          onChange={e => setOfferId(e.target.value ? Number(e.target.value) : null)}
          className={`w-full px-4 py-2.5 rounded-xl border bg-white text-sm focus:outline-none focus:border-brand ${
            offerMissing ? 'border-red-300' : 'border-gray-200'}`}
        >
          <option value="">Не выбрана</option>
          {offers.map(o => (
            <option key={o.id} value={o.id}>{o.title}</option>
          ))}
        </select>
        {offers.length === 0 && (
          <p className="mt-1 text-xs text-gray-500">
            Список пуст — создайте документ в разделе «Оферты».
          </p>
        )}

        {/* Ссылка — запасной вариант: оферта лежит на чужом сайте. Выбранный
            документ ГЛАВНЕЕ ссылки (так же решает и бэкенд). */}
        <label className="mt-4 mb-1 block text-sm font-medium text-gray-700">
          Или ссылка на свой документ
        </label>
        <input
          value={offerUrl}
          onChange={e => setOfferUrl(e.target.value)}
          placeholder="https://..."
          className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
        />
        <p className="mt-1 text-xs text-gray-500">
          {offerId
            ? 'Сейчас используется выбранный документ — ссылка не действует.'
            : 'Нужна, только если оферта лежит не в ПЛЮСОНе.'}
        </p>

        <button
          onClick={saveOffer}
          disabled={savingOffer}
          className="btn-primary mt-4 flex items-center gap-1.5 disabled:opacity-50"
        >
          <Save size={15} /> Сохранить
        </button>
      </div>

      {/* Список тарифов */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-800">Тарифы события</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Платёжка дёргает вебхук с кодом тарифа — оплата попадёт в нужный тариф.
            </p>
          </div>
          <button
            onClick={openCreate}
            className="px-3.5 py-2 rounded-xl bg-brand text-white text-sm font-medium flex items-center gap-1.5 shrink-0"
          >
            <Plus size={15} /> Добавить тариф
          </button>
        </div>

        {items.length === 0 ? (
          <div className="text-center text-gray-400 text-sm py-10">
            Тарифов пока нет. Добавьте первый — например VIP-доступ.
          </div>
        ) : (
          <div className="space-y-2.5">
            {items.map((t, idx) => (
              <div key={t.id} className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="p-4 flex items-start gap-3">
                {/* Порядок тарифов — в этой же последовательности они идут на
                    лендинге. Стрелки, а не перетаскивание: работает на телефоне
                    и не конфликтует с полями внутри карточки. */}
                <div className="flex flex-col shrink-0 -my-1">
                  <button onClick={() => move(idx, -1)} disabled={idx === 0}
                          className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-25 disabled:hover:text-gray-400"
                          title="Выше">
                    <ChevronUp size={15} />
                  </button>
                  <button onClick={() => move(idx, 1)} disabled={idx === items.length - 1}
                          className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-25 disabled:hover:text-gray-400"
                          title="Ниже">
                    <ChevronDown size={15} />
                  </button>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-gray-800">{t.title}</span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-mono">{t.code}</span>
                    {!t.is_active && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-400">выключен</span>
                    )}
                    {t.price != null && (
                      <span className="text-sm text-gray-500">
                        {t.old_price != null && (
                          <span className="text-gray-400 line-through mr-1.5">
                            {t.old_price.toLocaleString('ru-RU')} ₽
                          </span>
                        )}
                        {t.price.toLocaleString('ru-RU')} ₽
                      </span>
                    )}
                    {t.discount_percent != null && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">
                        −{t.discount_percent}%
                      </span>
                    )}
                  </div>
                  {t.bonus_feature_id && (
                    <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[11px] font-medium">
                      🎁 ПЛЮСОН: {t.bonus_feature_name || 'модуль'}
                      {` · ${t.bonus_days || 30} дн.`}
                    </span>
                  )}
                  {t.description && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{t.description}</p>}
                  {t.pay_url && (
                    <a href={t.pay_url} target="_blank" rel="noreferrer"
                       className="text-xs text-brand hover:underline break-all mt-1 inline-block">
                      {t.pay_url}
                    </a>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 ${
                      expandedId === t.id
                        ? 'bg-[#FFCFA4]/60 text-[#8a5a2b]'
                        : 'bg-[#FFCFA4]/30 text-[#8a5a2b] hover:bg-[#FFCFA4]/50'
                    }`}
                    title="Оплатившие и заказы"
                  >
                    <Users size={13} /> {t.buyers_count}
                    {t.unpaid_count > 0 && (
                      <span className="text-amber-600" title="имеют заказ, не оплатили">/ {t.unpaid_count}</span>
                    )}
                    {expandedId === t.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                  <button onClick={() => openEdit(t)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" title="Изменить">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => removeTariff(t)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-400" title="Удалить">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Раскрывающийся блок «Кто оплатил» (inline, не модалка) */}
              {expandedId === t.id && (
                <BuyersPanel
                  eventId={eventId}
                  tariff={t}
                  allTariffs={items}
                  onChanged={load}
                />
              )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Модалка формы.
          ⚠️ Форма прокручивается: полей стало больше, и на невысоком экране
          низ вместе с кнопкой «Сохранить» уходил за край — окно выглядело
          зависшим. Прокрутка на подложке + ограничение высоты у окна. */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-10">
          <div className="max-h-[85vh] w-full max-w-md space-y-3 overflow-y-auto rounded-2xl bg-white p-5"
               onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-800">{editing ? 'Изменить тариф' : 'Новый тариф'}</h3>
              <button onClick={() => setShowForm(false)} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
            </div>
            <Field label="Название" hint="Что видит покупатель — «VIP-доступ»">
              <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
                     className="input-tar" placeholder="VIP-доступ" />
            </Field>
            <Field label="Код тарифа" hint="Латиницей, без пробелов — его передаёт платёжка (tariff_code). Например vip">
              <input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })}
                     className="input-tar font-mono" placeholder="vip" />
            </Field>
            <Field label="Сумма, ₽" hint="Это цена к оплате. Оставьте пустым, если «по запросу»">
              <input value={form.price} onChange={e => setForm({ ...form, price: e.target.value.replace(/[^0-9]/g, '') })}
                     className="input-tar" placeholder="29000" inputMode="numeric" />
              {/* Предупреждение, а не запрет: цену решает клиент, но платёж
                  ниже порога платёжная система просто не пропустит. */}
              {minPaymentWarn(form.price) && (
                <div className="mt-2 text-xs text-amber-700">{minPaymentWarn(form.price)}</div>
              )}
            </Field>
            <Field label="Скидка"
                   hint="Если есть — на лендинге рядом с ценой появится вторая, зачёркнутая. Пусто = скидки нет">
              {/* ⚠️ Ширины заданы inline, а НЕ классами w-20/flex-1: у .input-tar
                  стоит `width:100%` из <style jsx>, и он перебивал Tailwind —
                  селектор «%/₽» растягивался на строку, а поле ввода
                  схлопывалось в кружок, куда нельзя было попасть. */}
              <div className="flex gap-2">
                <select value={form.discount_kind}
                        onChange={e => setForm({ ...form, discount_kind: e.target.value as 'percent' | 'amount' })}
                        className="input-tar"
                        style={{ width: '5rem', flex: '0 0 5rem' }}>
                  <option value="percent">%</option>
                  <option value="amount">₽</option>
                </select>
                <input value={form.discount_value}
                       onChange={e => setForm({ ...form, discount_value: e.target.value.replace(/[^0-9]/g, '') })}
                       className="input-tar"
                       style={{ flex: '1 1 auto', minWidth: 0 }}
                       placeholder={form.discount_kind === 'percent' ? '20' : '5000'}
                       inputMode="numeric" />
              </div>
              {/* Сразу показываем, что увидит покупатель — иначе «20%» и
                  «5000 ₽» приходится считать в уме. */}
              {(() => {
                const old = calcOldPrice(form.price, form.discount_kind, form.discount_value)
                if (!old) return null
                return (
                  <div className="mt-2 text-xs text-gray-600">
                    На лендинге:{' '}
                    <span className="text-gray-400 line-through">{old.toLocaleString('ru-RU')} ₽</span>{' '}
                    <span className="font-semibold text-gray-900">
                      {parseInt(form.price, 10).toLocaleString('ru-RU')} ₽
                    </span>
                  </div>
                )
              })()}
            </Field>
            {/* Вознаграждение партнёру за продажу этого тарифа (миграция 347).
                ⚠️ Только при подключённой партнёрке: остальным это поле
                ничего не даёт и лишь загромождает форму. */}
            {hasPartnerProgram && (
              <Field label="Вознаграждение партнёру"
                     hint="Пусто — действует значение из раздела «Моя партнёрка»">
                <div className="flex gap-2">
                  <select value={form.partner_reward_kind}
                          onChange={e => setForm({ ...form,
                            partner_reward_kind: e.target.value as 'percent' | 'fixed' })}
                          className="input-tar"
                          style={{ flex: '0 0 5rem' }}>
                    <option value="percent">%</option>
                    <option value="fixed">₽</option>
                  </select>
                  <input value={form.partner_reward_value}
                         onChange={e => setForm({ ...form,
                           partner_reward_value: e.target.value.replace(/[^0-9.]/g, '') })}
                         className="input-tar"
                         style={{ flex: '1 1 auto', minWidth: 0 }}
                         placeholder={form.partner_reward_kind === 'percent' ? '10' : '3000'}
                         inputMode="decimal" />
                </div>
                {/* «10%» само по себе ничего не говорит — показываем сумму. */}
                {(() => {
                  const p = parseInt(form.price, 10)
                  const v = parseFloat(form.partner_reward_value)
                  if (!Number.isFinite(v) || v <= 0) return null
                  const sum = form.partner_reward_kind === 'fixed'
                    ? v
                    : (Number.isFinite(p) && p > 0 ? Math.round((p * v) / 100) : null)
                  if (sum == null) return null
                  return (
                    <div className="mt-2 text-xs text-gray-600">
                      Партнёр получит{' '}
                      <span className="font-semibold text-gray-900">
                        {sum.toLocaleString('ru-RU')} ₽
                      </span>{' '}с каждой продажи
                    </div>
                  )
                })()}
              </Field>
            )}
            <Field label="Что входит" hint="По пункту в строке — на лендинге станут галочками">
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                        rows={4} className="input-tar resize-none" />
            </Field>
            <Field label="Подсказка при оплате"
                   hint="Показывается белым по красному над формой заказа — например, просьба указать рабочие контакты">
              <textarea value={form.order_hint}
                        onChange={e => setForm({ ...form, order_hint: e.target.value })}
                        rows={3} className="input-tar resize-none" />
            </Field>
            <Field label="Что НЕ входит" hint="По пункту в строке — на лендинге будут зачёркнуты крестиком">
              <textarea value={form.excluded_description}
                        onChange={e => setForm({ ...form, excluded_description: e.target.value })}
                        rows={3} className="input-tar resize-none" />
            </Field>
            {/* Развилка: платёжная система подключена → мы сами создаём
                заказ и ловим оплату вебхуком. Не подключена → внешняя
                ссылка, оплаты отмечаются вручную.
                ⚠️ Код товара сейчас не нужен НИ ОДНОЙ системе (LeadPay
                переведён на v2). Ветку не удаляем: `needs_product_id`
                приходит с бэкенда, и поле вернётся само, если появится
                система с карточками товара. */}
            {payReady ? (needsProductId ? (
              <Field label="Код товара в платёжной системе"
                     hint="Номер карточки товара — например 63959. Заказ и оплата отметятся сами">
                <input value={form.pay_product_id}
                       onChange={e => setForm({ ...form, pay_product_id: e.target.value })}
                       className="input-tar" placeholder="63959" inputMode="numeric" />
              </Field>
            ) : (
              <p className="text-xs text-gray-500 -mt-1">
                Оплата подключена — ссылку создадим сами по названию и сумме
                тарифа. Заводить товар в платёжной системе не нужно.
              </p>
            )) : (
              <Field label="Ссылка на оплату"
                     hint="Оплаты придётся отмечать вручную. Подключите платёжную систему в Настройках, чтобы это происходило само">
                <input value={form.pay_url} onChange={e => setForm({ ...form, pay_url: e.target.value })}
                       className="input-tar" placeholder="https://..." />
              </Field>
            )}
            {/* Номинации премии (миграция 328). Только у турнира/премии — у
                конференции и мероприятия номинаций нет вовсе.
                ⚠️ Премия и чемпионат — один module_slug='turnir', различает их
                только слово события; поэтому поле показываем обоим: не
                заполнил — ничего не происходит. */}
            {event?.module_slug === 'turnir' && (
              <Field label="Открывает номинаций"
                     hint="Столько номинаций покупатель сможет отметить себе сам в кабинете. Пусто — тариф номинаций не даёт">
                <input value={form.nominations_grant}
                       onChange={e => setForm({ ...form, nominations_grant: e.target.value.replace(/[^0-9]/g, '') })}
                       className="input-tar" placeholder="например 3" inputMode="numeric" />
              </Field>
            )}
            {/* ⚠️ Блок виден ВСЕМ: дарить доступ в ПЛЮСОН может любой клиент —
                человек регистрируется под его реф-кодом, и клиент получает
                кэшбэк. А выбор платного МОДУЛЯ и тарифа «Профи» показывается
                только тем, у кого есть фича (admin): это уже наши деньги. */}
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 space-y-2.5">
                <div className="text-sm font-medium text-amber-900">Триал доступ к ПЛЮСОН за покупку</div>
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-[#25455D]"
                    checked={form.bonus_trial}
                    onChange={e => setForm({ ...form, bonus_trial: e.target.checked })}
                  />
                  <span className="text-xs text-amber-900">
                    Подарить Триал доступ к ПЛЮСОН
                    <span className="block text-amber-800/70">
                      Новому пользователю — полный бесплатный период, у кого кабинет
                      уже есть — 3 дня продления. Покупатель закрепится за вами,
                      и вы получите кэшбэк с его оплат.
                    </span>
                  </span>
                </label>
                {bonusFeatures.length > 0 && (<>
                <p className="text-xs text-amber-800/80">
                  Можно добавить платный модуль ПЛЮСОНа — покупатель получит его
                  вместе с доступом.
                </p>
                <select
                  value={form.bonus_feature_id}
                  onChange={e => setForm({ ...form, bonus_feature_id: e.target.value })}
                  className="input-tar bg-white"
                >
                  <option value="">Без модуля</option>
                  {bonusFeatures.map(f => (
                    <option key={f.id} value={String(f.id)}>{f.name}</option>
                  ))}
                </select>
                {form.bonus_feature_id && (
                  <div className="space-y-1">
                    <span className="text-xs text-amber-900">Вместе с модулем дарим</span>
                    {/* Модуль без подписки почти бесполезен: разделы гейтятся
                        фичей, но запись в кабинете закрыта без тарифа. */}
                    <select
                      value={form.bonus_tariff_slug}
                      onChange={e => setForm({ ...form, bonus_tariff_slug: e.target.value })}
                      className="input-tar bg-white"
                    >
                      <option value="trial">Бесплатный период</option>
                      <option value="pro">Тариф Профи</option>
                    </select>
                  </div>
                )}
                </>)}
                {(form.bonus_feature_id || form.bonus_trial) && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-amber-900">На срок</span>
                    <input
                      value={form.bonus_days}
                      onChange={e => setForm({ ...form, bonus_days: e.target.value.replace(/[^0-9]/g, '') })}
                      className="input-tar bg-white" style={{ width: 80 }} inputMode="numeric"
                    />
                    {/* ⚠️ Срок ТОЛЬКО в днях: «месяц» — это то ли 30, то ли 31,
                        а покупателю в письме нужна точная цифра. */}
                    <span className="text-xs text-amber-900">дн.</span>
                  </div>
                )}
                {(form.bonus_feature_id || form.bonus_trial) && (
                  <label className="flex items-start gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-[#25455D]"
                      checked={form.bonus_line_auto}
                      onChange={e => setForm({ ...form, bonus_line_auto: e.target.checked })}
                    />
                    <span className="text-xs text-amber-900">
                      Писать бонус на лендинге автоматически
                      <span className="block text-amber-800/70">
                        Строка «Бонус: …» появится в карточке тарифа сама и всегда
                        совпадёт с настройкой. Снимите галочку, если опишете бонус
                        своими словами в описании тарифа.
                      </span>
                    </span>
                  </label>
                )}
                {(form.bonus_feature_id || form.bonus_trial) && !form.price && (
                  <p className="text-xs text-red-600">
                    У тарифа не указана сумма — оплаты не будет, значит и доступ не выдастся.
                  </p>
                )}
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} />
              Тариф активен
            </label>
            {/* ⚠️ Галочки «Выделить на лендинге» здесь НЕТ: выделенный тариф
                выбирается в конструкторе лендинга (блок «Тарифы»), там же
                настраивается сила свечения. Две точки управления одним и тем
                же признаком путали. */}
            <p className="text-xs text-gray-400 -mt-2">Выключенный тариф остаётся в кабинете, оплаты по нему засчитываются. Влияет только на отдачу в API для стороннего лендинга.</p>
            <div className="flex gap-2 pt-1">
              <button onClick={submitForm} disabled={saving}
                      className="flex-1 px-4 py-2.5 rounded-xl bg-brand text-white text-sm font-medium disabled:opacity-50">
                {saving ? 'Сохраняю…' : 'Сохранить'}
              </button>
              <button onClick={() => setShowForm(false)}
                      className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600">Отмена</button>
            </div>
          </div>
        </div>
      )}


      <style jsx>{`
        .input-tar {
          width: 100%;
          padding: 0.6rem 0.9rem;
          border-radius: 0.75rem;
          border: 1px solid #e5e7eb;
          font-size: 0.875rem;
          outline: none;
        }
        .input-tar:focus { border-color: #25455D; }
      `}</style>
    </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}

function PlatformChip({ label, href, color }: { label: string; href: string; color: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer"
       className="inline-flex items-center gap-1 text-xs hover:underline" style={{ color }}>
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-sm text-[8px] font-bold text-white" style={{ background: color }}>
        {label.slice(0, 2)}
      </span>
    </a>
  )
}

function BuyersPanel({ eventId, tariff, allTariffs, onChanged }: { eventId: number; tariff: any; allTariffs: Tariff[]; onChanged: () => void }) {
  const [data, setData] = useState<{ paid: Buyer[]; unpaid: Buyer[] } | null>(null)
  const [adding, setAdding] = useState(false)
  const [addStatus, setAddStatus] = useState<'paid' | 'unpaid'>('paid')

  async function reload() {
    const r = await api.eventTariffs.buyers(eventId, tariff.id)
    setData({ paid: r.paid || [], unpaid: r.unpaid || [] })
  }
  useEffect(() => { reload() }, [eventId, tariff.id])

  async function removeBuyer(participantId: number) {
    if (!confirm('Снять отметку у этого человека?')) return
    await api.eventTariffs.removeBuyer(eventId, tariff.id, participantId)
    await reload()
    onChanged()
  }

  async function patchBuyer(participantId: number, patch: { note?: string; status?: 'paid' | 'unpaid'; move_to_tariff_id?: number }) {
    await api.eventTariffs.patchBuyer(eventId, tariff.id, participantId, patch)
    await reload()
    onChanged()
  }

  const paidIds = new Set((data?.paid || []).map(b => b.participant_id))
  const unpaidIds = new Set((data?.unpaid || []).map(b => b.participant_id))

  function openAdd(status: 'paid' | 'unpaid') {
    setAddStatus(status)
    setAdding(true)
  }

  return (
    <div className="border-t border-gray-100 bg-gray-50/50 p-4 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => openAdd('paid')}
          className="px-2.5 py-1.5 rounded-lg bg-brand text-white text-xs font-medium flex items-center gap-1"
        >
          <Plus size={13} /> Добавить оплатившего
        </button>
        <button
          onClick={() => openAdd('unpaid')}
          className="px-2.5 py-1.5 rounded-lg bg-amber-100 text-amber-700 text-xs font-medium flex items-center gap-1 hover:bg-amber-200"
        >
          <Plus size={13} /> Добавить заказ (не оплачен)
        </button>
      </div>

      {adding && (
        <AddBuyerPicker
          eventId={eventId}
          tariffId={tariff.id}
          tariffPrice={tariff.price}
          status={addStatus}
          paidParticipantIds={paidIds}
          unpaidParticipantIds={unpaidIds}
          onDone={async () => { setAdding(false); await reload(); onChanged() }}
        />
      )}

      {!data ? (
        <div className="py-6 flex justify-center"><Spinner /></div>
      ) : (
        <div className="space-y-4">
          {/* Оплатили */}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Оплатили · {data.paid.length}
            </div>
            {data.paid.length === 0 ? (
              <div className="text-xs text-gray-400 py-2">Пока никто не оплатил.</div>
            ) : (
              <div className="space-y-2">
                {data.paid.map(b => <BuyerCard key={b.id} b={b} currentTariffId={tariff.id} allTariffs={allTariffs}
                  onRemove={() => removeBuyer(b.participant_id)}
                  onPatch={(patch) => patchBuyer(b.participant_id, patch)} />)}
              </div>
            )}
          </div>

          {/* Имеют заказ, не оплатили */}
          {data.unpaid.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-2">
                Имеют заказ, не оплатили · {data.unpaid.length}
              </div>
              <div className="space-y-2">
                {data.unpaid.map(b => <BuyerCard key={b.id} b={b} unpaid currentTariffId={tariff.id} allTariffs={allTariffs}
                  onRemove={() => removeBuyer(b.participant_id)}
                  onPatch={(patch) => patchBuyer(b.participant_id, patch)} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function BuyerCard({ b, unpaid, currentTariffId, allTariffs, onRemove, onPatch }: {
  b: Buyer
  unpaid?: boolean
  currentTariffId: number
  allTariffs: Tariff[]
  onRemove: () => void
  onPatch: (patch: { note?: string; status?: 'paid' | 'unpaid'; move_to_tariff_id?: number }) => void
}) {
  const [noteVal, setNoteVal] = useState(b.note || '')
  const [editingNote, setEditingNote] = useState(false)
  const otherTariffs = allTariffs.filter(t => t.id !== currentTariffId)

  return (
    <div className={`border rounded-xl p-3 ${unpaid ? 'border-amber-200 bg-amber-50/40' : 'border-gray-100 bg-white'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-gray-800 text-sm truncate">{b.contact_name || `Контакт #${b.contact_id}`}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-gray-400">{fmtDate(b.paid_at || b.ordered_at)}</span>
          <button onClick={onRemove} className="p-1 rounded hover:bg-red-50 text-red-400" title="Снять отметку">
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2.5 mt-1.5 flex-wrap">
        {(b.tg_id || b.tg_username) && (
          <PlatformChip label="TG" color="#229ED9"
            href={b.tg_username ? `https://telegram.me/${b.tg_username.replace(/^@+/, '')}` : `tg://user?id=${b.tg_id}`} />
        )}
        {(b.vk_id || b.vk_username) && (
          <PlatformChip label="VK" color="#0077FF"
            href={b.vk_username ? `https://vk.com/${b.vk_username.replace(/^@+/, '')}` : `https://vk.com/id${b.vk_id}`} />
        )}
        {(b.max_id || b.max_username) && (
          <PlatformChip label="MAX" color="#8a5a2b"
            href={b.max_username ? `https://max.ru/${b.max_username}` : '#'} />
        )}
        {b.email && <span className="text-xs text-gray-500 truncate">{b.email}</span>}
        {b.phone && <span className="text-xs text-gray-500">{b.phone}</span>}
      </div>
      {(b.source || b.amount != null) && (
        <div className="text-[11px] text-gray-400 mt-1">
          {b.source && <span>через {b.source}</span>}
          {b.amount != null && <span> · {b.amount.toLocaleString('ru-RU')} ₽</span>}
        </div>
      )}

      {/* Заметка */}
      <div className="mt-2">
        {editingNote ? (
          <div className="flex gap-1.5">
            <input
              value={noteVal}
              onChange={e => setNoteVal(e.target.value)}
              autoFocus
              placeholder="Комментарий…"
              className="flex-1 px-2 py-1 rounded-lg border border-gray-200 text-xs focus:outline-none focus:border-brand"
            />
            <button onClick={() => { onPatch({ note: noteVal }); setEditingNote(false) }}
              className="px-2 py-1 rounded-lg bg-brand text-white text-xs">OK</button>
            <button onClick={() => { setNoteVal(b.note || ''); setEditingNote(false) }}
              className="px-2 py-1 rounded-lg border border-gray-200 text-gray-500 text-xs">×</button>
          </div>
        ) : (
          <button onClick={() => setEditingNote(true)}
            className="text-xs flex items-center gap-1 text-left w-full">
            {b.note
              ? <span className="text-gray-700 bg-yellow-50 border border-yellow-200 rounded px-1.5 py-0.5">📝 {b.note}</span>
              : <span className="text-gray-400 hover:text-brand">📝 добавить заметку</span>}
          </button>
        )}
      </div>

      {/* Действия: сменить статус + перенести на другой тариф */}
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        {unpaid ? (
          <button onClick={() => onPatch({ status: 'paid' })}
            className="text-[11px] px-2 py-0.5 rounded bg-green-100 text-green-700 hover:bg-green-200">→ оплатил</button>
        ) : (
          <button onClick={() => onPatch({ status: 'unpaid' })}
            className="text-[11px] px-2 py-0.5 rounded bg-amber-100 text-amber-700 hover:bg-amber-200">→ в заказ (не оплачен)</button>
        )}
        {otherTariffs.length > 0 && (
          <select
            value=""
            onChange={e => { if (e.target.value) onPatch({ move_to_tariff_id: Number(e.target.value) }) }}
            className="text-[11px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-600 bg-white"
          >
            <option value="">Перенести на тариф…</option>
            {otherTariffs.map(t => (
              <option key={t.id} value={t.id}>{t.title}{t.price != null ? ` (${t.price}₽)` : ''}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  )
}

// Выбор кого отметить оплатившим: участники события ИЛИ контакты базы.
function AddBuyerPicker({
  eventId, tariffId, tariffPrice, status, paidParticipantIds, unpaidParticipantIds, onDone,
}: {
  eventId: number
  tariffId: number
  /** Цена тарифа — только ПОДСКАЗКА для поля суммы, не подстановка в расчёт. */
  tariffPrice?: number | null
  status: 'paid' | 'unpaid'
  paidParticipantIds: Set<number>
  unpaidParticipantIds: Set<number>
  onDone: () => void
}) {
  const [source, setSource] = useState<'participants' | 'contacts'>('participants')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [noteVal, setNoteVal] = useState('')
  // ⚠️⚠️ Поля суммы здесь НЕ БЫЛО ВОВСЕ, и форма всегда слала пустое значение:
  // на проде у события 24 сумма отсутствует у 24 оплат из 31. Отчёт по
  // рефералам из-за этого показывал «оплатили 2, сумма 0 ₽».
  //
  // ⚠️ Подставлять цену тарифа при расчёте НЕЛЬЗЯ (решение владельца
  // 09.09.2026): вручную отмечают и тех, кто прошёл бесплатно, — им
  // приписались бы чужие деньги. Поэтому сумма спрашивается ЗДЕСЬ, в момент
  // отметки, когда человек знает, платил покупатель или нет.
  const [amountVal, setAmountVal] = useState<string>(
    tariffPrice != null ? String(tariffPrice) : '')

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      try {
        if (source === 'participants') {
          const r = await api.events.participants(eventId, 'all')
          const list = (r.participants || []).filter((p: any) => {
            if (!query.trim()) return true
            const q = query.toLowerCase()
            return [p.contact_name, p.first_name, p.last_name, p.username, p.email, p.phone]
              .some((v: any) => (v || '').toString().toLowerCase().includes(q))
          })
          if (!cancelled) setRows(list)
        } else {
          const r = await api.contacts.list(query, 50, 0, false)
          if (!cancelled) setRows(r.contacts || r.items || [])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    const t = setTimeout(run, query ? 250 : 0)
    return () => { cancelled = true; clearTimeout(t) }
  }, [source, query, eventId])

  async function pick(row: any) {
    setBusyId(row.id)
    try {
      const note = noteVal.trim() || undefined
      // Пустое поле — сумма неизвестна (шлём undefined, в базе останется
      // пусто). Явный «0» — это осознанный ноль: человек прошёл бесплатно.
      const raw = amountVal.trim().replace(',', '.')
      const parsed = raw === '' ? undefined : Number(raw)
      if (parsed !== undefined && (!Number.isFinite(parsed) || parsed < 0)) {
        alert('Сумма должна быть числом (0 — если человек прошёл бесплатно)')
        setBusyId(null)
        return
      }
      const amount = parsed === undefined ? undefined : Math.round(parsed)
      if (source === 'participants') {
        await api.eventTariffs.addBuyer(eventId, tariffId, { participant_id: row.id, status, note, amount })
      } else {
        await api.eventTariffs.addBuyer(eventId, tariffId, { contact_id: row.id, status, note, amount })
      }
      onDone()
    } catch (e: any) {
      alert(e?.message || 'Не удалось отметить оплату')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="border border-gray-200 bg-white rounded-xl p-3 space-y-2.5">
      {/* Сумма — первым полем: без неё оплата не попадёт ни в отчёт по
          рефералам, ни в суммы по событию. */}
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-gray-600 shrink-0">Сумма, ₽</label>
        <input
          value={amountVal}
          onChange={e => setAmountVal(e.target.value)}
          inputMode="numeric"
          className="w-28 px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs focus:outline-none focus:border-brand"
        />
        <span className="text-[11px] text-gray-400 leading-tight">
          0 — если прошёл бесплатно. Пусто — сумма не попадёт в отчёты.
        </span>
      </div>
      <input
        value={noteVal}
        onChange={e => setNoteVal(e.target.value)}
        placeholder="Заметка (необязательно) — применится к выбранному"
        className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs focus:outline-none focus:border-brand"
      />
      <div className="text-xs font-medium text-gray-600">
        {status === 'paid' ? 'Отметить оплатившим:' : 'Добавить заказ (не оплачен):'}
      </div>
      <div className="flex gap-1 text-xs">
        {([['participants', 'Из участников'], ['contacts', 'Из контактов']] as const).map(([k, label]) => (
          <button key={k} onClick={() => { setSource(k); setRows([]) }}
            className={`px-3 py-1.5 rounded-lg font-medium ${
              source === k ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600'
            }`}>
            {label}
          </button>
        ))}
      </div>
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Поиск по имени, @нику, email, телефону…"
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-brand"
        />
      </div>
      <div className="max-h-64 overflow-y-auto space-y-1">
        {loading ? (
          <div className="py-6 flex justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <div className="text-center text-gray-400 text-xs py-6">Ничего не найдено</div>
        ) : rows.map(row => {
          const isParticipant = source === 'participants'
          const alreadyPaid = isParticipant && paidParticipantIds.has(row.id)
          const hasUnpaidOrder = isParticipant && unpaidParticipantIds.has(row.id)
          // В форме «оплатившего» строка с неоплаченным заказом — кликабельна (переводит в оплату).
          // В форме «заказа» она блокируется (заказ уже есть).
          const unpaidActionable = status === 'paid' && hasUnpaidOrder
          const blocked = alreadyPaid || (status === 'unpaid' && hasUnpaidOrder)
          const name = row.contact_name || row.name || [row.first_name, row.last_name].filter(Boolean).join(' ') || `#${row.id}`
          const sub = row.email || row.phone || (row.username ? `@${row.username}` : '')
          return (
            <button
              key={row.id}
              onClick={() => !blocked && pick(row)}
              disabled={blocked || busyId === row.id}
              title={
                alreadyPaid ? 'Уже оплатил этот тариф'
                : (status === 'unpaid' && hasUnpaidOrder) ? 'Заказ по этому тарифу уже есть'
                : unpaidActionable ? 'Есть заказ, не оплачен — нажмите, чтобы перевести в оплатившие'
                : undefined
              }
              className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-left text-sm ${
                alreadyPaid ? 'bg-green-50 text-green-700 cursor-default'
                : (status === 'unpaid' && hasUnpaidOrder) ? 'bg-amber-50 text-amber-700 cursor-default'
                : 'hover:bg-gray-50'
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-gray-800">{name}</span>
                {sub && <span className="block truncate text-xs text-gray-400">{sub}</span>}
                {unpaidActionable && (
                  <span className="block truncate text-[11px] text-amber-600">Есть заказ, не оплачен</span>
                )}
                {(status === 'unpaid' && hasUnpaidOrder) && (
                  <span className="block truncate text-[11px] text-amber-600">Заказ уже добавлен</span>
                )}
              </span>
              {alreadyPaid ? (
                <span className="shrink-0 flex items-center gap-1 text-[11px] text-green-700"><Check size={15} /> оплатил</span>
              ) : unpaidActionable ? (
                <span className="shrink-0 text-[11px] px-2 py-0.5 rounded bg-amber-500 text-white font-medium">Оплатить</span>
              ) : (status === 'unpaid' && hasUnpaidOrder) ? (
                <Check size={15} className="shrink-0 text-amber-600" />
              ) : (
                <Plus size={15} className="shrink-0 text-brand" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Сводная таблица всех заказов по всем тарифам с фильтрами.
interface OrderRow {
  id: number
  participant_id: number
  tariff_id: number
  status: 'paid' | 'unpaid'
  amount: number | null
  note: string | null
  paid_at: string | null
  ordered_at: string | null
  source: string | null
  tariff_code: string
  tariff_title: string
  tariff_price: number | null
  contact_id: number
  contact_name: string | null
  phone: string | null
  email: string | null
  tg_id: string | null; tg_username: string | null
  vk_id: string | null; vk_username: string | null
  max_id: string | null; max_username: string | null
  referrer_name: string | null
}

function OrdersTable({ eventId, onChanged }: { eventId: number; onChanged: () => void }) {
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [tariffs, setTariffs] = useState<Tariff[]>([])
  const [loading, setLoading] = useState(true)
  const [fTariffs, setFTariffs] = useState<number[]>([])      // мульти-выбор тарифов (пусто = все)
  const [fPartners, setFPartners] = useState<string[]>([])    // мульти-выбор партнёров (пусто = все)
  const [fStatus, setFStatus] = useState<'all' | 'paid' | 'unpaid'>('all')
  const [q, setQ] = useState('')

  async function load() {
    setLoading(true)
    try {
      const r = await api.eventTariffs.allOrders(eventId)
      setOrders(r.orders || [])
      setTariffs(r.tariffs || [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [eventId])

  async function patch(o: OrderRow, p: { note?: string; status?: 'paid' | 'unpaid'; move_to_tariff_id?: number; amount?: number | null; amount_set?: boolean }) {
    await api.eventTariffs.patchBuyer(eventId, o.tariff_id, o.participant_id, p)
    // Точечно обновляем строку в стейте — без полной перезагрузки таблицы
    // (без мигания и прыжка скролла). Меняем только реально затронутые поля.
    setOrders(prev => prev.map(row => {
      if (row.participant_id !== o.participant_id || row.tariff_id !== o.tariff_id) return row
      const next = { ...row }
      if (p.note !== undefined) next.note = p.note
      if (p.status !== undefined) next.status = p.status
      if (p.amount_set) next.amount = p.amount ?? null
      if (p.move_to_tariff_id != null && p.move_to_tariff_id !== o.tariff_id) {
        next.tariff_id = p.move_to_tariff_id
        const t = tariffs.find(tt => tt.id === p.move_to_tariff_id)
        if (t) { next.tariff_title = t.title; next.tariff_price = t.price }
      }
      return next
    }))
    onChanged()  // обновить счётчики в шапке тарифов (там свой стейт)
  }
  async function remove(o: OrderRow) {
    if (!confirm('Удалить заказ этого человека?')) return
    await api.eventTariffs.removeBuyer(eventId, o.tariff_id, o.participant_id)
    await load(); onChanged()
  }

  // Уникальные партнёры (рефоводы) для фильтра. «__none__» — заказы без партнёра.
  const NO_PARTNER = '__none__'
  const partnerOptions = useMemo(() => {
    const names = new Set<string>()
    let hasNone = false
    for (const o of orders) {
      const n = (o.referrer_name || '').trim()
      if (n) names.add(n)
      else hasNone = true
    }
    const opts = Array.from(names).sort((a, b) => a.localeCompare(b, 'ru'))
      .map(n => ({ value: n, label: n }))
    if (hasNone) opts.push({ value: NO_PARTNER, label: 'Без партнёра' })
    return opts
  }, [orders])

  const filtered = orders.filter(o => {
    if (fTariffs.length > 0 && !fTariffs.includes(o.tariff_id)) return false
    if (fPartners.length > 0) {
      const n = (o.referrer_name || '').trim()
      const key = n || NO_PARTNER
      if (!fPartners.includes(key)) return false
    }
    if (fStatus !== 'all' && o.status !== fStatus) return false
    if (q.trim()) {
      const s = q.toLowerCase()
      if (![o.contact_name, o.email, o.phone, o.tg_username, o.vk_username, o.referrer_name]
        .some(v => (v || '').toString().toLowerCase().includes(s))) return false
    }
    return true
  })

  // ⚠️⚠️ Считаем ТОЛЬКО по вписанной сумме. Раньше здесь стояло
  // `amount ?? tariff_price` — цена тарифа подставлялась вместо незаполненной
  // суммы, и итог завышался: вручную отмечают и тех, кто прошёл БЕСПЛАТНО
  // (на событии 24 так приходили люди от Михайленко), а им приписывалась
  // полная цена. Решение владельца 09.09.2026: сумма берётся как есть.
  const sumOf = (o: OrderRow) => (o.amount ?? 0)
  const paidRows = filtered.filter(o => o.status === 'paid')
  const unpaidRows = filtered.filter(o => o.status === 'unpaid')
  const paidSum = paidRows.reduce((s, o) => s + sumOf(o), 0)
  const unpaidSum = unpaidRows.reduce((s, o) => s + sumOf(o), 0)
  // Сколько строк без вписанной суммы — иначе итог молча занижен и непонятно
  // почему: человек видит 20 оплат и сумму от четырёх из них.
  const paidNoAmount = paidRows.filter(o => o.amount == null).length

  // Экспорт CSV — ровно тех заказов, что видны после фильтра (массив filtered).
  // UTF-8 с BOM + ;-разделитель — открывается в Excel без танцев с кодировкой.
  function exportCsv() {
    const esc = (v: any) => {
      const s = v == null ? '' : String(v)
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const tgLink = (o: OrderRow) =>
      o.tg_username ? `https://telegram.me/${o.tg_username.replace(/^@+/, '')}` : (o.tg_id ? `tg://user?id=${o.tg_id}` : '')
    const vkLink = (o: OrderRow) =>
      o.vk_username ? `https://vk.com/${o.vk_username.replace(/^@+/, '')}` : (o.vk_id ? `https://vk.com/id${o.vk_id}` : '')
    const maxLink = (o: OrderRow) =>
      o.max_username ? `https://max.ru/${o.max_username}` : ''
    const headers = [
      'Имя', 'Email', 'Телефон', 'Telegram', 'VK', 'MAX',
      'Тариф', 'Код тарифа', 'Сумма, ₽', 'Статус', 'Партнёр', 'Источник', 'Заметка', 'Дата',
    ]
    const rows = filtered.map(o => [
      o.contact_name || `#${o.contact_id}`,
      o.email || '',
      o.phone || '',
      tgLink(o),
      vkLink(o),
      maxLink(o),
      o.tariff_title || '',
      o.tariff_code || '',
      sumOf(o),
      o.status === 'paid' ? 'Завершён (оплатил)' : 'Новый (не оплачен)',
      o.referrer_name || '',
      o.source || '',
      o.note || '',
      fmtDate(o.paid_at || o.ordered_at),
    ])
    const csv = [headers, ...rows].map(r => r.map(esc).join(';')).join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stamp = new Date().toISOString().slice(0, 10)
    a.download = `orders-event-${eventId}-${stamp}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  if (loading) return <div className="py-12 flex justify-center"><Spinner /></div>

  return (
    <div className="space-y-3">
      {/* Фильтры */}
      <div className="flex flex-wrap gap-2 items-center">
        <MultiSelectDropdown
          label="Тарифы"
          placeholder="Все тарифы"
          options={tariffs.map(t => ({ value: t.id, label: `${t.title}${t.price != null ? ` (${t.price}₽)` : ''}` }))}
          values={fTariffs}
          onChange={setFTariffs}
        />
        <MultiSelectDropdown
          label="Партнёры"
          placeholder="Все партнёры"
          options={partnerOptions}
          values={fPartners}
          onChange={setFPartners}
        />
        <select value={fStatus} onChange={e => setFStatus(e.target.value as any)}
          className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm bg-white">
          <option value="all">Все статусы</option>
          <option value="paid">Завершён (оплатил)</option>
          <option value="unpaid">Новый (не оплачен)</option>
        </select>
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск…"
            className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-brand" />
        </div>
        <button
          onClick={exportCsv}
          disabled={filtered.length === 0}
          title="Скачать показанные заказы в CSV (для Excel)"
          className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm font-medium flex items-center gap-1.5 shrink-0 disabled:opacity-50"
        >
          <Download size={15} /> Экспорт CSV
        </button>
      </div>
      <div className="text-xs text-gray-500 flex flex-wrap gap-x-4 gap-y-1">
        <span>Показано: {filtered.length}</span>
        {paidRows.length > 0 && (
          <span className="text-green-700">✓ оплачено: {paidRows.length} на {paidSum.toLocaleString('ru-RU')} ₽</span>
        )}
        {unpaidRows.length > 0 && (
          <span className="text-amber-700">⏳ заказов (не оплачено): {unpaidRows.length} на {unpaidSum.toLocaleString('ru-RU')} ₽</span>
        )}
      </div>

      {/* ⚠️ Честная цифра требует объяснения: раньше вместо незаполненной суммы
          подставлялась цена тарифа, и итог выглядел полным. Теперь считаем по
          вписанным суммам — и сразу говорим, у скольких строк суммы нет, иначе
          «упавший» итог читается как пропажа денег. */}
      {paidNoAmount > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          У <b>{paidNoAmount}</b> из {paidRows.length} оплат сумма не заполнена — эти деньги в итог не попали.
          Впишите сумму в столбце «Сумма» (или <b>0</b>, если человек прошёл бесплатно).
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="text-center text-gray-400 text-sm py-10">Заказов нет.</div>
      ) : (
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 border-y sm:border border-gray-100 sm:rounded-xl [-webkit-overflow-scrolling:touch]">
          <table className="w-full text-sm table-fixed min-w-[1040px]">
            <colgroup>
              <col style={{ width: '13%' }} />
              <col style={{ width: '17%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '4%' }} />
            </colgroup>
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-xs">
                <th className="text-left px-2 py-2 font-medium">Имя</th>
                <th className="text-left px-2 py-2 font-medium">Контакт</th>
                <th className="text-left px-2 py-2 font-medium">Тариф</th>
                <th className="text-left px-2 py-2 font-medium">Сумма</th>
                <th className="text-left px-2 py-2 font-medium">Статус</th>
                <th className="text-left px-2 py-2 font-medium">Партнёр</th>
                <th className="text-left px-2 py-2 font-medium">Дата и время</th>
                <th className="text-left px-2 py-2 font-medium">Заметка</th>
                <th className="px-1 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(o => (
                <tr key={o.id} className="border-t border-gray-50 hover:bg-gray-50/50 align-top">
                  <td className="px-2 py-2 text-gray-800 break-words">{o.contact_name || `#${o.contact_id}`}</td>
                  <td className="px-2 py-2">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        {(o.tg_id || o.tg_username) && <PlatformChip label="TG" color="#229ED9" href={o.tg_username ? `https://telegram.me/${o.tg_username.replace(/^@+/, '')}` : `tg://user?id=${o.tg_id}`} />}
                        {(o.vk_id || o.vk_username) && <PlatformChip label="VK" color="#0077FF" href={o.vk_username ? `https://vk.com/${o.vk_username.replace(/^@+/, '')}` : `https://vk.com/id${o.vk_id}`} />}
                      </div>
                      {o.email && <span className="text-xs text-gray-500 truncate" title={o.email}>{o.email}</span>}
                      {o.phone && <span className="text-xs text-gray-500">{o.phone}</span>}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <select value={o.tariff_id}
                      onChange={e => { const v = Number(e.target.value); if (v !== o.tariff_id) patch(o, { move_to_tariff_id: v }) }}
                      className="text-xs px-1 py-1 rounded border border-gray-200 bg-white w-full">
                      {tariffs.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    {/* ⚠️ Править сумму можно ТОЛЬКО у отмеченных ВРУЧНУЮ
                        (решение владельца 09.09.2026). Оплата, пришедшая с
                        сайта или из платёжной системы, — это факт: сумму там
                        прислал продавец, и переписать её нельзя, иначе учёт
                        разойдётся с реальными деньгами. */}
                    <OrderAmount amount={o.amount} tariffPrice={o.tariff_price}
                      readOnly={!!o.source && o.source !== 'manual'}
                      sourceLabel={o.source}
                      onSave={(a) => patch(o, { amount: a, amount_set: true })} />
                  </td>
                  <td className="px-2 py-2">
                    <button onClick={() => patch(o, { status: o.status === 'paid' ? 'unpaid' : 'paid' })}
                      className={`text-[11px] px-2 py-0.5 rounded ${o.status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                      {o.status === 'paid' ? 'Завершён' : 'Новый'}
                    </button>
                  </td>
                  <td className="px-2 py-2 text-xs text-gray-500 break-words">{o.referrer_name || '—'}</td>
                  <td className="px-2 py-2 text-xs text-gray-500 break-words">{fmtDate(o.paid_at || o.ordered_at) || '—'}</td>
                  <td className="px-2 py-2">
                    <OrderNote note={o.note} onSave={(n) => patch(o, { note: n })} />
                  </td>
                  <td className="px-1 py-2">
                    <button onClick={() => remove(o)} className="p-1 rounded hover:bg-red-50 text-red-400"><Trash2 size={13} /></button>
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

// Заметка — всегда видимое поле: вписать / изменить / очистить (✕).
// Сохраняется по потере фокуса или Enter, только если значение изменилось.
function OrderNote({ note, onSave }: { note: string | null; onSave: (n: string) => void }) {
  const [val, setVal] = useState(note || '')
  useEffect(() => { setVal(note || '') }, [note])
  const dirty = val !== (note || '')
  function commit() { if (dirty) onSave(val) }
  return (
    <div className="flex items-center gap-1">
      <input
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur() } }}
        placeholder="заметка…"
        className={`px-2 py-1 rounded border text-xs flex-1 min-w-0 focus:outline-none focus:border-brand ${
          note ? 'bg-yellow-50 border-yellow-200' : 'border-gray-200'
        }`}
      />
      {val && (
        <button onClick={() => { setVal(''); onSave('') }} title="Очистить"
          className="p-0.5 rounded hover:bg-red-50 text-red-400"><X size={12} /></button>
      )}
    </div>
  )
}

// Фактическая сумма — редактируемое поле. Если не задана — серым показывает цену
// тарифа (плейсхолдером), при вводе сохраняет фактически внесённое (для скидок).
function OrderAmount({ amount, tariffPrice, onSave, readOnly = false, sourceLabel }: {
  amount: number | null
  tariffPrice: number | null
  onSave: (a: number | null) => void
  /** Оплата пришла не из ручной отметки — сумму менять нельзя. */
  readOnly?: boolean
  sourceLabel?: string | null
}) {
  const [val, setVal] = useState(amount != null ? String(amount) : '')
  useEffect(() => { setVal(amount != null ? String(amount) : '') }, [amount])
  const cur = val.trim() === '' ? null : parseInt(val.trim(), 10)
  const dirty = cur !== amount
  function commit() { if (!readOnly && dirty) onSave(cur) }
  const discounted = amount != null && tariffPrice != null && amount < tariffPrice

  // ⚠️ Оплату, пришедшую с сайта или из платёжной системы, НЕ РЕДАКТИРУЕМ
  // (решение владельца 09.09.2026): сумму там прислал продавец, это факт
  // сделки. Правится только то, что отметили вручную.
  if (readOnly) {
    return (
      <div className="flex items-center gap-1"
           title={`Оплата через ${sourceLabel} — сумму менять нельзя. Править можно только отмеченные вручную.`}>
        <span className="px-1.5 py-1 text-xs w-16 text-right text-gray-700 font-medium">
          {amount != null ? amount.toLocaleString('ru-RU') : '—'}
        </span>
        <span className="text-xs text-gray-400">₽</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <input
        value={val}
        onChange={e => setVal(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur() } }}
        placeholder={tariffPrice != null ? String(tariffPrice) : '—'}
        className={`px-1.5 py-1 rounded border text-xs w-16 text-right focus:outline-none focus:border-brand ${
          discounted ? 'bg-orange-50 border-orange-200 text-orange-700' : 'border-gray-200 text-gray-600'
        }`}
        title={discounted ? `Скидка с ${tariffPrice}₽` : ''}
      />
      <span className="text-xs text-gray-400">₽</span>
    </div>
  )
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Moscow',
    }) + ' МСК'
  } catch { return iso }
}
