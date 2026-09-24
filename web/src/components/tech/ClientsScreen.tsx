'use client'

/**
 * Клиенты внедренцев — КАРТОЧКА клиента, срезом по внедренцу (23.09.2026).
 *
 * ⚠️⚠️ ЭТО НЕ «CRM» (`/admin/tech/crm`). Два разных экрана, и путать их нельзя:
 *   • этот  — «что у клиента ЕСТЬ»: события, боты, подписчики, вебинары,
 *     коллаборации, тариф, когда зарегался, кто привёл;
 *   • «CRM» — «ГДЕ он в пути»: триал → активирован → удержан → оживлён →
 *     отвалился, и что с ним делать дальше.
 * Вопросы разные, решения разные — поэтому и пункты меню разные.
 *
 * ⚠️ Данные берутся из ТОГО ЖЕ эндпоинта, что и «Клиенты» в админке
 * (`/admin/clients` + `spec_id`), а не из своей копии: два списка одной
 * сущности разъезжаются в правилах, и цифры начинают спорить между собой.
 *
 * ⚠️ ТОЛЬКО СМОТРИМ. Ни тарифов, ни модулей, ни запрета коллабораций здесь
 * нет намеренно: это решения владельца, и место им в «Клиентах» админки.
 */
import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import { api } from '@/lib/api'

const PAGE = 50

const dt = (v?: string | null) =>
  v ? new Date(v).toLocaleDateString('ru-RU') : '—'

// ⚠️ `useSearchParams` на пререндеренной странице требует <Suspense>, иначе
// падает сборка ВСЕЙ ветки.
/**
 * ⚠️⚠️ ОДИН ЭКРАН НА ДВА КАБИНЕТА (решение владельца 23.09.2026).
 * У владельца — все клиенты с выбором внедренца (`mode="admin"`), у внедренца
 * — его клиенты (`mode="tech"`, выпадашки нет: номер подставляет сервер из
 * токена). Фильтры, колонки и страницы одинаковые: это единственное отличие.
 */
export default function ClientsScreen({ mode }: { mode: 'admin' | 'tech' }) {
  const params = useSearchParams()
  const router = useRouter()
  const specFromUrl = params.get('spec')

  const [specs, setSpecs] = useState<any[]>([])
  const [specId, setSpecId] = useState<number | null>(
    specFromUrl ? Number(specFromUrl) : null)
  const [q, setQ] = useState('')
  // ⚠️ Те же фильтры, что в админском разделе «Клиенты»: без них внедренец не
  // мог отобрать ни платящих, ни тех, у кого нет бота.
  const [tariff, setTariff] = useState('')
  const [subscription, setSubscription] = useState('')
  const [hasBot, setHasBot] = useState('')
  const [tariffs, setTariffs] = useState<any[]>([])
  const [items, setItems] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.adminTech.specialists()
      .then((r: any) => setSpecs(r.specialists || []))
      .catch(() => setSpecs([]))
  }, [])

  useEffect(() => { setOffset(0) }, [specId, q, tariff, subscription, hasBot])

  useEffect(() => {
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      // ⚠️ `api.admin.clients` принимает СТРОКУ параметров — такая у неё
      // сигнатура во всей админке. Переделывать её под объект значило бы
      // тронуть все вызовы ради одного экрана.
      const sp = new URLSearchParams()
      if (q) sp.set('search', q)
      if (tariff) sp.set('tariff', tariff)
      if (subscription) sp.set('subscription', subscription)
      if (hasBot) sp.set('has_bot', hasBot)
      // ⚠️ У внедренца `spec_id` НЕ передаём: сервер подставляет его номер из
      // токена. Передать параметром значило бы дать указать чужой.
      if (mode === 'admin' && specId !== null) sp.set('spec_id', String(specId))
      sp.set('limit', String(PAGE))
      sp.set('offset', String(offset))
      // ⚠️ Точка с запятой ОБЯЗАТЕЛЬНА: без неё следующая строка, начинающаяся
      // со скобки, читается как ВЫЗОВ результата `sp.set(...)` — то есть
      // `undefined(...)`. Сборка падала «This expression is not callable»
      // и блокировала выкатку всей ветки (24.09.2026).
      ;(mode === 'admin'
        ? api.admin.clients(sp.toString())
        : api.tech.clientsFull(sp.toString()))
        .then((r: any) => {
          if (!alive) return
          setItems(r.clients || [])
          setTotal(r.total || 0)
          // ⚠️ Тарифы приходят ВМЕСТЕ со списком: отдельная ручка
          // `/admin/tariffs` внедренцу закрыта.
          if (r.tariffs) setTariffs(r.tariffs)
        })
        .catch(() => { if (alive) { setItems([]); setTotal(0) } })
        .finally(() => { if (alive) setLoading(false) })
    }, q ? 350 : 0)
    return () => { alive = false; clearTimeout(t) }
  }, [mode, specId, q, tariff, subscription, hasBot, offset])

  function pickSpec(v: number | null) {
    setSpecId(v)
    // ⚠️ У каждого кабинета свой адрес: увести внедренца в админку нельзя.
    const base = mode === 'admin' ? '/admin/tech/clients' : '/tech'
    router.replace(v && mode === 'admin' ? `${base}?spec=${v}` : base)
  }

  const current = specs.find((s: any) => s.id === specId)

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">
        {mode === 'admin' ? 'Клиенты внедренцев' : 'Мои клиенты'}
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        {mode !== 'admin'
          ? 'Закреплённые за вами клиенты и приведённые вами лично.'
          : current
          ? <>Клиенты внедренца <b>{current.name || current.email}</b> — закреплённые и приведённые им лично.</>
            : 'Все клиенты платформы с отметкой, кто их ведёт.'}
      </p>

      <div className="mt-5 rounded-2xl bg-white shadow-sm">
        <div className="border-b border-gray-100 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {mode === 'admin' && (
            <select value={specId ?? ''}
                    onChange={e => pickSpec(e.target.value ? Number(e.target.value) : null)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
              <option value="">Все внедренцы</option>
              {/* ⚠️ «Ничьи» отдельным пунктом: клиент без ответственного —
                  это не «ошибка фильтра», а рабочий вопрос «кого раздать». */}
              <option value="0">Ничьи (без внедренца)</option>
              {specs.map((s: any) => (
                <option key={s.id} value={s.id}>{s.name || s.email}</option>
              ))}
            </select>
            )}

            {/* Фильтры — те же, что у владельца в «Клиентах». */}
            <select value={tariff} onChange={e => setTariff(e.target.value)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
              <option value="">Любой тариф</option>
              {tariffs.map((t: any) => (
                <option key={t.slug || t.id} value={t.slug}>{t.name}</option>
              ))}
            </select>

            <select value={subscription} onChange={e => setSubscription(e.target.value)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
              <option value="">Подписка любая</option>
              <option value="active">Подписка активна</option>
              <option value="inactive">Подписка неактивна</option>
            </select>

            <select value={hasBot} onChange={e => setHasBot(e.target.value)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
              <option value="">Бот: неважно</option>
              <option value="yes">Свой бот есть</option>
              <option value="no">Бота нет</option>
            </select>

            <div className="relative min-w-[240px] flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={q} onChange={e => setQ(e.target.value)}
                     placeholder="Поиск: имя, почта, телеграм"
                     className="w-full rounded-lg border border-gray-300 py-1.5 pl-9 pr-3 text-sm" />
            </div>
          </div>

          <div className="mt-2 text-sm font-semibold text-gray-800">
            {loading ? 'Загружаем…'
              : total > items.length
                ? `Найдено — ${total}, показаны ${offset + 1}–${Math.min(offset + PAGE, total)}`
                : `Показано — ${items.length}`}
          </div>
        </div>

        {!items.length && !loading ? (
          <div className="p-8 text-center text-sm text-gray-500">
            {q || specId !== null ? 'Никого не нашли — смягчите фильтры.' : 'Клиентов пока нет.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                  <th className="px-4 py-2 font-medium">Клиент</th>
                  <th className="px-4 py-2 font-medium">Тариф</th>
                  <th className="px-4 py-2 font-medium">Событий</th>
                  <th className="px-4 py-2 font-medium">Ботов</th>
                  <th className="px-4 py-2 font-medium">Подписчиков</th>
                  <th className="px-4 py-2 font-medium">Вебинаров</th>
                  <th className="px-4 py-2 font-medium">Спикеров</th>
                  {/* ⚠️ Коллаборации ≠ спикеры: это СОВМЕСТНЫЕ события. */}
                  <th className="px-4 py-2 font-medium">Коллабораций</th>
                  <th className="px-4 py-2 font-medium">Зарегался</th>
                  <th className="px-4 py-2 font-medium">Ведёт</th>
                  <th className="px-4 py-2 font-medium">Привёл</th>
                </tr>
              </thead>
              <tbody>
                {items.map(c => (
                  <tr key={c.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{c.name || 'Без имени'}</div>
                      <div className="text-xs text-gray-400">{c.email}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {c.tariff_name || '—'}
                      {c.subscription_expires_at && (
                        <div className="text-xs text-gray-400">
                          до {dt(c.subscription_expires_at)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{c.events_count}</td>
                    <td className="px-4 py-3 text-gray-600">{c.own_channels_count}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {(c.subscribers_count || 0).toLocaleString('ru-RU')}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{c.webinars_count ?? 0}</td>
                    <td className="px-4 py-3 text-gray-600">{c.collaborators_count}</td>
                    <td className="px-4 py-3 text-gray-600">{c.collabs_count ?? 0}</td>
                    <td className="px-4 py-3 text-gray-600">{dt(c.created_at)}</td>
                    {/* ⚠️ «Ведёт» и «Привёл» — РАЗНЫЕ колонки: ведущему идёт
                        фикс за обслуживание, приведшему 10 % навсегда. */}
                    <td className="px-4 py-3 text-gray-600">
                      {c.tech_owner_name || <span className="text-gray-300">ничей</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {c.referrer_name || <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE && (
          <div className="flex items-center justify-between gap-3 border-t border-gray-100 p-4">
            <button type="button" disabled={offset === 0 || loading}
                    onClick={() => setOffset(Math.max(0, offset - PAGE))}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40">
              ← Назад
            </button>
            <span className="text-sm text-gray-500">
              {offset + 1}–{Math.min(offset + PAGE, total)} из {total}
            </span>
            <button type="button" disabled={offset + PAGE >= total || loading}
                    onClick={() => setOffset(offset + PAGE)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40">
              Вперёд →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
