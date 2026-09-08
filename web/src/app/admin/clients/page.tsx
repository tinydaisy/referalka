'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Search, Users, BellOff, Calendar, Crown, UserCheck, Trash2, AlertTriangle, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'

// Метки налогового статуса партнёра (миграция 319). Выплата партнёрского
// вознаграждения возможна только ИП, юрлицу и самозанятому.
const TAX_STATUS_LABEL: Record<string, string> = {
  ip: 'ИП',
  company: 'юрлицо',
  self_employed: 'самозанятый',
}

interface Client {
  id: number
  name: string
  email: string
  phone: string | null
  telegram_username: string | null
  tariff_slug: string | null
  tariff_name: string | null
  features: string[] | null
  offer_accepted_at?: string | null
  offer_accepted_version?: string | null
  privacy_consent_at?: string | null
  partner_offer_accepted_at?: string | null
  partner_tax_status?: string | null
  subscription_expires_at: string | null
  subscription_status: string | null
  is_active: boolean
  created_at: string
  events_count: number
  contacts_count: number
  own_channels_count: number
  subscribers_count: number
  unsubscribed_count: number
  collaborators_count: number
  collab_hub_blocked?: boolean
  channels_breakdown?: { platform: string; name: string | null; subscribed: number; unsubscribed: number }[]
}

interface EmailQuality {
  client_id: number
  sent: number
  bounces_hard: number
  unsubs: number
  bounce_rate: number
  unsub_rate: number
  status: 'green' | 'yellow' | 'red'
  recommendation: string
}

export default function AdminClientsPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [total, setTotal] = useState(0)
  // Поиск можно задать адресом — `?search=почта`. Так работают ссылки «Карточка»
  // из уведомлений ПЛЮСОНа: без этого они открывали общий список, и нужного
  // клиента приходилось искать руками.
  const [search, setSearch] = useState(() => {
    if (typeof window === 'undefined') return ''
    return new URLSearchParams(window.location.search).get('search') || ''
  })
  // Пагинация: клиентов уже больше сотни, а бэк отдаёт по 50 — без докачки
  // половина списка была не видна вовсе.
  const [limit, setLimit] = useState(50)
  // Фильтр «база не меньше N контактов»: отделяет рабочие кабинеты от пустых
  // регистраций, которых большинство.
  const [minContacts, setMinContacts] = useState(0)
  // Сегменты для рассылок: подписка / свой бот / Коллабораторная.
  const [subscription, setSubscription] = useState('')
  const [hasBot, setHasBot] = useState('')
  const [inCollab, setInCollab] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [emailQuality, setEmailQuality] = useState<Record<number, EmailQuality>>({})
  const [manageClient, setManageClient] = useState<Client | null>(null)
  const [deleteClient, setDeleteClient] = useState<Client | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const [qualityModal, setQualityModal] = useState<EmailQuality | null>(null)

  useEffect(() => {
    const qs = new URLSearchParams()
    if (search) qs.set('search', search)
    if (minContacts > 0) qs.set('min_contacts', String(minContacts))
    if (subscription) qs.set('subscription', subscription)
    if (hasBot) qs.set('has_bot', hasBot)
    if (inCollab) qs.set('in_collab', inCollab)
    qs.set('limit', String(limit))
    api.admin.clients(qs.toString())
      .then((r: any) => { setClients(r.clients || []); setTotal(r.total || 0) })
      .catch(() => {})
  }, [search, limit, minContacts, subscription, hasBot, inCollab, reloadTick])

  // Смена фильтра/поиска — снова с первой страницы, иначе останется раздутый
  // limit от прошлого просмотра.
  useEffect(() => { setLimit(50) }, [search, minContacts, subscription, hasBot, inCollab])

  // Разметить контакты тегами plusson:* — после этого сегменты доступны
  // в рассылках кабинета как обычный фильтр по тегам.
  async function syncTags() {
    if (!confirm('Проставить теги сегментов (plusson:*) контактам в вашей базе?\n\nСтарые plusson:*-теги будут пересчитаны заново. Остальные теги не тронутся.')) return
    setSyncing(true)
    try {
      const r: any = await api.admin.syncSegmentTags({ target_client_id: 1 })
      const by = r.by_segment || {}
      alert(`Готово. Размечено контактов: ${r.tagged}\n\n` +
        Object.entries(by).map(([k, v]) => `${k} — ${v}`).join('\n') +
        `\n\nТеперь в Рассылках выберите фильтр «Теги» → нужный сегмент.`)
    } catch (e: any) {
      alert(e?.message || 'Не удалось проставить теги')
    } finally { setSyncing(false) }
  }

  // Метрики качества email-рассылок — отдельным запросом, чтобы не блокировать
  // основной список (миграция 098-099)
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('plusson_token') : null
    if (!token) return
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
    fetch(`${apiUrl}/api/v1/admin/clients-email-quality`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then((data: any) => {
        if (!data?.clients) return
        const map: Record<number, EmailQuality> = {}
        for (const q of data.clients) map[q.client_id] = q
        setEmailQuality(map)
      })
      .catch(() => {})
  }, [])

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Клиенты</h1>
          <p className="text-gray-500 mt-1">Всего: {total}</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 p-5 border-b border-gray-100">
          <div className="relative flex-1 max-w-sm">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text" placeholder="Поиск по имени или email"
              value={search} onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand/30"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">Контактов от</span>
            <select
              value={minContacts}
              onChange={e => setMinContacts(Number(e.target.value))}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none"
            >
              <option value={0}>любое число</option>
              <option value={1}>1 и больше</option>
              <option value={10}>10 и больше</option>
              <option value={50}>50 и больше</option>
              <option value={100}>100 и больше</option>
              <option value={500}>500 и больше</option>
            </select>
          </div>
          <select
            value={subscription} onChange={e => setSubscription(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none"
          >
            <option value="">Подписка: любая</option>
            <option value="active">Есть активная</option>
            <option value="inactive">Без подписки</option>
          </select>
          <select
            value={hasBot} onChange={e => setHasBot(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none"
          >
            <option value="">Бот: любой</option>
            <option value="yes">Есть свой бот</option>
            <option value="no">Нет бота</option>
          </select>
          <select
            value={inCollab} onChange={e => setInCollab(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none"
          >
            <option value="">Коллаб: все</option>
            <option value="yes">В Коллабораторной</option>
            <option value="no">Не в Коллабораторной</option>
          </select>
          <button
            onClick={syncTags} disabled={syncing}
            title="Проставить контактам теги plusson:no_sub / sub_no_bot / sub_and_bot / in_collab — чтобы рассылать по сегментам из кабинета"
            className="px-3 py-2 rounded-lg text-sm bg-brand text-white hover:opacity-90 disabled:opacity-50 whitespace-nowrap"
          >
            {syncing ? 'Размечаю…' : 'Проставить теги сегментам'}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                {['Клиент', 'Тариф', 'Событий', 'Контактов', 'Подписчиков', 'Своих ботов', 'Коллаб.', 'Коллаб. запрещена', 'Зарег.', ''].map(h => (
                  <th key={h} className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {clients.length > 0 ? clients.map(c => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-3 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full gradient-bg flex items-center justify-center text-white text-sm font-bold shrink-0">
                        {c.name[0]}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 text-sm truncate">{c.name}</span>
                          {emailQuality[c.id] && emailQuality[c.id].status !== 'green' && (
                            <button
                              onClick={() => setQualityModal(emailQuality[c.id])}
                              title="Метрики email-рассылок"
                              className="shrink-0">
                              <span className={`text-sm ${
                                emailQuality[c.id].status === 'red' ? 'text-red-500' : 'text-yellow-500'
                              }`}>
                                {emailQuality[c.id].status === 'red' ? '🔴' : '🟡'}
                              </span>
                            </button>
                          )}
                          {!c.is_active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">не активен</span>}
                        </div>
                        <div className="text-xs text-gray-400 truncate">{c.email}</div>
                        {(c.phone || c.telegram_username) && (
                          <div className="text-xs text-gray-400 truncate">
                            {c.phone && <span>{c.phone}</span>}
                            {c.phone && c.telegram_username && <span> · </span>}
                            {c.telegram_username && <span>@{c.telegram_username}</span>}
                          </div>
                        )}
                        {/* Акцепты правовых документов (миграции 315, 319).
                            ⚠️ У клиентов, зарегистрированных ДО внедрения
                            отметки, полей нет — это не нарушение: они
                            акцептовали конклюдентно (п. 3.1.5 Оферты). */}
                        <div className="flex flex-wrap items-center gap-1 mt-1">
                          {c.offer_accepted_at && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200"
                              title={`Оферта принята ${new Date(c.offer_accepted_at).toLocaleDateString('ru-RU')}`
                                + (c.offer_accepted_version ? `, редакция ${c.offer_accepted_version}` : '')}
                            >
                              оферта ✓
                            </span>
                          )}
                          {c.partner_tax_status && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200"
                              title={c.partner_offer_accepted_at
                                ? `Партнёрская оферта принята ${new Date(c.partner_offer_accepted_at).toLocaleDateString('ru-RU')}`
                                : 'Партнёр'}
                            >
                              партнёр · {TAX_STATUS_LABEL[c.partner_tax_status] || c.partner_tax_status}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-4">
                    <div className="flex items-center gap-1.5">
                      {(c.features || []).includes('channels') && <Crown size={12} className="text-amber-500" />}
                      <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                        c.tariff_slug === 'business_beta' ? 'bg-violet-50 text-violet-700'
                        : c.tariff_slug === 'vip' ? 'bg-amber-50 text-amber-700'
                        : c.tariff_slug === 'pro' ? 'bg-blue-50 text-blue-700'
                        : c.tariff_slug === 'start' ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-gray-100 text-gray-600'
                      }`}>
                        {c.tariff_name || c.tariff_slug}
                      </span>
                    </div>
                    {c.subscription_expires_at && (
                      <div className={`text-[10px] mt-1 ${c.subscription_status === 'expired' ? 'text-red-500' : 'text-gray-400'}`}>
                        {c.subscription_status === 'expired' ? 'истекла ' : 'до '}
                        {new Date(c.subscription_expires_at).toLocaleDateString('ru')}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-4 text-sm text-gray-700 text-center">{c.events_count}</td>
                  <td className="px-3 py-4 text-sm text-gray-700 text-center">{c.contacts_count}</td>
                  <td className="px-3 py-4 text-sm">
                    <div className="flex items-center gap-1 justify-center">
                      <div className="flex items-center gap-1 text-green-600" title="Подписаны">
                        <Users size={12} /><span>{c.subscribers_count}</span>
                      </div>
                      {c.channels_breakdown && c.channels_breakdown.length > 0 && (
                        <div className="relative group">
                          <span className="w-4 h-4 inline-flex items-center justify-center rounded-full bg-gray-200 text-gray-500 text-[9px] font-bold cursor-help select-none">?</span>
                          <div className="hidden group-hover:block absolute z-20 left-1/2 -translate-x-1/2 top-5 w-56 bg-white border border-gray-200 rounded-lg shadow-lg p-2 text-left">
                            <div className="text-[10px] font-semibold text-gray-500 mb-1.5 uppercase">Подписчики по ботам</div>
                            {c.channels_breakdown.map((ch, i) => (
                              <div key={i} className="flex items-center justify-between gap-2 py-0.5 text-xs">
                                <span className="text-gray-700 truncate">
                                  <span className="text-gray-400">{ch.platform}</span>{' '}
                                  {ch.name || '—'}
                                </span>
                                <span className="whitespace-nowrap">
                                  <span className="text-green-600 font-medium">{ch.subscribed}</span>
                                  {ch.unsubscribed > 0 && (
                                    <span className="text-red-400"> / -{ch.unsubscribed}</span>
                                  )}
                                </span>
                              </div>
                            ))}
                            <div className="text-[10px] text-gray-400 mt-1.5 pt-1.5 border-t border-gray-100">
                              Один человек может быть в нескольких ботах — поэтому сумма по ботам может отличаться от числа контактов.
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    {c.unsubscribed_count > 0 && (
                      <div className="flex items-center gap-1 text-red-400 text-xs justify-center mt-0.5" title="Отписались">
                        <BellOff size={10} /><span>{c.unsubscribed_count}</span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-4 text-sm text-gray-700 text-center" title="Свои не-системные каналы">
                    {c.own_channels_count}
                  </td>
                  <td className="px-3 py-4 text-sm text-gray-700 text-center">{c.collaborators_count}</td>
                  <td className="px-3 py-4 text-center">
                    <input
                      type="checkbox"
                      checked={!!c.collab_hub_blocked}
                      title="Запретить покупку Коллабораторной"
                      onChange={async e => {
                        const v = e.target.checked
                        setClients(cs => cs.map(x => x.id === c.id ? { ...x, collab_hub_blocked: v } : x))
                        try {
                          await api.admin.updateClient(c.id, { collab_hub_blocked: v })
                        } catch {
                          setClients(cs => cs.map(x => x.id === c.id ? { ...x, collab_hub_blocked: !v } : x))
                        }
                      }}
                      className="w-4 h-4 accent-red-600 cursor-pointer"
                    />
                  </td>
                  <td className="px-3 py-4 text-xs text-gray-400 whitespace-nowrap">
                    <Calendar size={11} className="inline mr-1" />
                    {new Date(c.created_at).toLocaleDateString('ru')}
                  </td>
                  <td className="px-3 py-4 text-center whitespace-nowrap">
                    <button
                      onClick={() => setManageClient(c)}
                      title="Тариф и бонусы"
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-gray-300 whitespace-nowrap"
                    >
                      Тариф · бонусы
                    </button>
                    {/* ⚠️ Владельца платформы (id=1) и системный сервисный
                        аккаунт удалять нельзя — на них держатся общие боты и
                        рассылки. Бэкенд это тоже проверяет. */}
                    {c.id !== 1 && (
                      <button
                        onClick={() => setDeleteClient(c)}
                        title="Удалить клиента"
                        className="ml-1.5 p-1.5 rounded-lg border border-gray-200 text-gray-400 hover:text-red-600 hover:border-red-300 align-middle"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={9} className="px-5 py-12 text-center text-sm text-gray-400">
                    {search ? 'Ничего не найдено' : 'Клиентов пока нет'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-gray-400 mt-4">
        💡 Колонки «дата продления», «выручка» и история тарифов появятся когда подключим тарифную архитектуру (отдельная задача).
      </p>

      {/* Модалка с метриками качества email-рассылок */}
      {clients.length < total && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => setLimit(l => l + 50)}
            className="px-5 py-2.5 rounded-xl border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Показать ещё · {clients.length} из {total}
          </button>
        </div>
      )}

      {qualityModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl"
               onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-4">
              {qualityModal.status === 'red' ? '🔴' : '🟡'} Метрики email за 30 дней
            </h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-gray-500">Отправлено</dt>
                   <dd className="font-semibold">{qualityModal.sent}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Битых адресов</dt>
                   <dd className="font-semibold">{qualityModal.bounces_hard} ({qualityModal.bounce_rate}%)</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Отписок</dt>
                   <dd className="font-semibold">{qualityModal.unsubs} ({qualityModal.unsub_rate}%)</dd></div>
            </dl>
            <div className={`mt-4 rounded-xl p-3 text-sm ${
              qualityModal.status === 'red'
                ? 'bg-red-50 text-red-700'
                : 'bg-yellow-50 text-yellow-800'
            }`}>
              {qualityModal.recommendation}
            </div>
            <p className="text-xs text-gray-500 mt-4 leading-relaxed">
              <b>Нормы:</b><br/>
              🟡 жёлтый — bounce &gt; 5% или unsub &gt; 1%<br/>
              🔴 красный — bounce &gt; 10% или unsub &gt; 3%
            </p>
            <button onClick={() => setQualityModal(null)}
              className="mt-4 w-full px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-xl text-sm font-medium">
              Закрыть
            </button>
          </div>
        </div>
      )}
      {manageClient && (
        <ManageClientModal
          client={manageClient}
          onClose={() => setManageClient(null)}
          onDone={() => { setManageClient(null); setReloadTick(v => v + 1) }}
        />
      )}

      {deleteClient && (
        <DeleteClientModal
          client={deleteClient}
          onClose={() => setDeleteClient(null)}
          onDone={() => { setDeleteClient(null); setReloadTick(v => v + 1) }}
        />
      )}

    </div>
  )
}


// ─── Удаление клиента ────────────────────────────────────────────────────────
//
// ⚠️⚠️ Самое разрушительное действие в системе: вместе с клиентом уходят его
// события, контакты, рассылки, продукты, боты и файлы. Восстановить можно
// только из ночного дампа.
//
// ⚠️ Подтверждение — ВВОД СЛОВА, а не «ок» в окне: случайно набрать нельзя.
// То же слово проверяет бэкенд — запрос легко повторить мимо интерфейса.
//
// ⚠️ Сначала показываем ЦИФРЫ. По имени в списке не отличить пустой тестовый
// кабинет от клиента с базой в семь тысяч контактов.

const DELETE_WORD = 'ПОДТВЕРДИТЬ'

function DeleteClientModal({ client, onClose, onDone }: {
  client: Client; onClose: () => void; onDone: () => void
}) {
  const [preview, setPreview] = useState<any>(null)
  const [word, setWord] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.admin.clientDeletePreview(client.id)
      .then((r: any) => setPreview(r))
      .catch((e: any) => setError(e?.message || 'Не удалось посчитать данные клиента'))
  }, [client.id])

  const ready = word.trim().toUpperCase() === DELETE_WORD && !busy && preview && !preview.protected

  async function run() {
    setBusy(true); setError('')
    try {
      const r: any = await api.admin.deleteClient(client.id, word.trim().toUpperCase())
      alert(r?.message || 'Клиент удалён')
      onDone()
    } catch (e: any) {
      setError(e?.message || 'Не удалось удалить')
      setBusy(false)
    }
  }

  const rows: Array<[string, number]> = preview ? [
    ['События (удалятся)', preview.events_to_delete],
    ['Контакты', preview.contacts],
    ['Подключённые боты', preview.channels],
    ['Продукты', preview.products],
    ['Лид-магниты', preview.lead_magnets],
    ['Рассылки', preview.broadcasts],
    ['Сообщения в переписках', preview.messages],
    ['Файлы', preview.files],
  ] : []

  return (
    // ⚠️ Клик по затемнению НЕ закрывает окно — правило проекта для форм.
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
            <AlertTriangle size={20} className="text-red-600" />
          </div>
          <div>
            <h3 className="font-bold text-lg text-gray-900">Удалить клиента</h3>
            <p className="text-sm text-gray-500 mt-0.5">
              {client.name} · {client.email}
            </p>
          </div>
        </div>

        {!preview && !error && (
          <div className="flex items-center gap-2 text-gray-500 py-6">
            <Loader2 size={16} className="animate-spin" /> Считаем, что удалится…
          </div>
        )}

        {preview?.protected && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">
            Этого клиента удалить нельзя: это владелец платформы или системный
            сервисный аккаунт — на нём держатся общие боты и рассылки.
          </div>
        )}

        {preview && !preview.protected && (
          <>
            <div className="rounded-xl border border-gray-200 overflow-hidden mb-4">
              {rows.map(([label, value]) => (
                <div key={label}
                     className="flex items-center justify-between px-4 py-2 text-sm border-b border-gray-100 last:border-0">
                  <span className="text-gray-600">{label}</span>
                  <span className={`font-semibold ${value > 0 ? 'text-gray-900' : 'text-gray-300'}`}>
                    {value}
                  </span>
                </div>
              ))}
            </div>

            {preview.events_shared > 0 && (
              <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-900 mb-3">
                {preview.events_shared} коллаб-{preview.events_shared === 1 ? 'событие останется' : 'событий останутся'} у
                партнёров — удалится только участие этого клиента.
              </div>
            )}

            {preview.referred > 0 && (
              <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-600 mb-3">
                {preview.referred} приведённых клиентов останутся, но потеряют
                привязку к рефоводу.
              </div>
            )}

            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800 mb-4">
              Данные удаляются <b>безвозвратно</b>. Вернуть можно только из
              ночной резервной копии.
            </div>

            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Введите слово <b>{DELETE_WORD}</b>, чтобы удалить
            </label>
            <input
              value={word}
              onChange={e => setWord(e.target.value)}
              placeholder={DELETE_WORD}
              autoFocus
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-red-400"
            />
          </>
        )}

        {error && (
          <div className="mt-3 text-sm text-red-600">{error}</div>
        )}

        <div className="flex gap-2 mt-5">
          <button onClick={onClose}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-gray-200 text-gray-700 text-sm font-medium hover:border-gray-300">
            Отмена
          </button>
          <button
            onClick={run}
            disabled={!ready}
            className="flex-1 px-4 py-2.5 rounded-lg bg-red-600 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-red-700"
          >
            {busy ? 'Удаляем…' : 'Удалить навсегда'}
          </button>
        </div>
      </div>
    </div>
  )
}


// ─── Управление клиентом: тариф и бонусы ─────────────────────────────────────

/**
 * Окно ручного управления подпиской и бонусным балансом клиента.
 *
 * ⚠️ Смена тарифа БЕЗ указания срока пересчитывает остаток по формуле п. 3.9.1
 * Оферты (осталось дней × цена прежнего ÷ цена нового) — именно это нужно при
 * возврате клиента на прежний Тариф: прожитые на дорогом тарифе дни ему не
 * возвращаются. Указанный срок отменяет пересчёт.
 *
 * ⚠️ Корректировка бонусов пишется отдельным типом операции (admin_adjust) и
 * ВИДНА КЛИЕНТУ в истории — поэтому причина обязательна.
 */
function ManageClientModal({ client, onClose, onDone }: {
  client: Client
  onClose: () => void
  onDone: () => void
}) {
  const [tariff, setTariff] = useState('')
  const [days, setDays] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')

  async function changeTariff() {
    if (!tariff) return
    setBusy(true); setErr(''); setOk('')
    try {
      await api.admin.updateClient(client.id, {
        tariff_slug: tariff,
        ...(days.trim() ? { tariff_days: Number(days) } : {}),
      })
      setOk(days.trim()
        ? `Тариф изменён, срок ${days} дн.`
        : 'Тариф изменён, срок пересчитан из остатка')
      setTariff(''); setDays('')
    } catch (e: any) {
      setErr(e?.message || 'Не удалось сменить тариф')
    } finally { setBusy(false) }
  }

  async function adjustBonus() {
    const sum = Number(amount.replace(',', '.'))
    if (!sum || !reason.trim()) return
    setBusy(true); setErr(''); setOk('')
    try {
      const r: any = await api.adminBonus.adjust(client.id, { amount_rub: sum, description: reason.trim() })
      setOk(`Готово. Баланс: ${r.balance_rub.toLocaleString('ru-RU')} ₽`)
      setAmount(''); setReason('')
    } catch (e: any) {
      setErr(e?.message || 'Не удалось изменить баланс')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      {/* Клик по фону НЕ закрывает — в окне есть поля ввода */}
      <div className="bg-white rounded-2xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-900">{client.name}</h3>
            <div className="text-xs text-gray-500">
              {client.email} · сейчас {client.tariff_name || client.tariff_slug || '—'}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        {err && <div className="mb-3 text-sm text-red-600">{err}</div>}
        {ok && <div className="mb-3 text-sm text-emerald-700">{ok}</div>}

        <div className="mb-5">
          <div className="text-sm font-medium text-gray-800 mb-2">Сменить тариф</div>
          <div className="flex flex-wrap gap-2 mb-2">
            {['trial', 'pro', 'vip', 'business_beta', 'admin'].map(s => (
              <button
                key={s}
                onClick={() => setTariff(s)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  tariff === s ? 'border-[#25455D] bg-[#25455D] text-white' : 'border-gray-200 text-gray-700'
                }`}
              >
                {s === 'trial' ? 'Триал' : s === 'pro' ? 'Профи' : s === 'vip' ? 'Экстра'
                  : s === 'business_beta' ? 'Бизнес Beta' : 'Админ'}
              </button>
            ))}
          </div>
          <input
            type="number" value={days} onChange={e => setDays(e.target.value)}
            placeholder="Срок в днях (пусто — пересчитать остаток)"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-2"
          />
          <div className="text-[11px] text-gray-400 mb-2 leading-snug">
            Пусто — остаток пересчитается по цене нового тарифа: с дорогого на дешёвый
            дней станет больше, наоборот — меньше. Прожитые дни не возвращаются.
          </div>
          <button
            onClick={changeTariff} disabled={!tariff || busy}
            className="btn-gold px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40"
          >
            Применить тариф
          </button>
        </div>

        <div className="pt-5 border-t border-gray-100">
          <div className="text-sm font-medium text-gray-800 mb-2">Бонусный баланс</div>
          <input
            type="text" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="Сумма в рублях: 1500 или -1500 для списания"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-2"
          />
          <input
            type="text" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Причина — её увидит клиент в истории"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-2"
          />
          <button
            onClick={adjustBonus} disabled={!amount || !reason.trim() || busy}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white disabled:opacity-40"
          >
            Изменить баланс
          </button>
        </div>

        <button onClick={onDone} className="mt-5 text-sm text-gray-500 underline">
          Закрыть и обновить список
        </button>
      </div>
    </div>
  )
}
