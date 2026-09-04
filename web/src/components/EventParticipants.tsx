'use client'
import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { Users, Search, ChevronDown, ChevronUp, X, Check, Trash2, Plus, Mail, Phone, UserPlus, AlertCircle, MessagesSquare, Pencil, Copy, Link2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useMe } from '@/hooks/useMe'

interface Participant {
  id: number
  contact_id: number
  platform_user_id: string
  ref_code: string
  referrer_ref_code: string | null
  referrer_contact_id: number | null
  referrer_name: string | null
  // Оплаты по тарифам события (миграция 257): сумма и названия тарифов.
  paid_amount?: number | null
  paid_tariffs?: string | null
  // Тестовый аккаунт кого-то из организаторов — только таких можно удалять в коллабе.
  is_test_account?: boolean
  // ⚠️ КОЛЛАБ: организатор, в чьей базе лежит контакт (contacts.client_id).
  organizer_name?: string | null
  organizer_client_id?: number | null
  referrer_username: string | null
  is_registered: boolean
  is_in_chat: boolean
  is_subscribed?: boolean
  is_unsubscribed?: boolean
  registered_at: string | null
  link_clicked_at: string | null
  chat_check_at: string | null
  contact_name: string | null
  first_name: string | null
  last_name: string | null
  username: string | null
  salebot_id: string | null
  phone: string | null
  email: string | null
  referral_count: number
  // Платформенные идентичности (для иконок + клик на профиль)
  tg_id?: string | null
  tg_username?: string | null
  vk_id?: string | null
  vk_username?: string | null
  max_id?: string | null
  max_username?: string | null
}

// Иконки платформ — SVG inline (без зависимости от внешних библиотек)
function PlatformBadge({
  platform, userId, username,
}: {
  platform: 'telegram' | 'vk' | 'max'
  userId?: string | null
  username?: string | null
}) {
  if (!userId && !username) return null
  const label = username ? `@${username.replace(/^@+/, '')}` : `#${userId}`
  const href =
    platform === 'telegram'
      ? (username ? `https://telegram.me/${username.replace(/^@+/, '')}` : `tg://user?id=${userId}`)
      : platform === 'vk'
      ? (username ? `https://vk.com/${username.replace(/^@+/, '')}` : `https://vk.com/id${userId}`)
      : (username ? `https://max.ru/${username}` : '#')
  const color =
    platform === 'telegram' ? '#229ED9'
    : platform === 'vk'     ? '#0077FF'
    : '#FFCFA4'
  const letter = platform === 'telegram' ? 'TG' : platform === 'vk' ? 'VK' : 'MAX'
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs hover:underline min-w-0 max-w-full"
      style={{ color }}
      title={label}
    >
      <span
        className="inline-flex items-center justify-center w-4 h-4 rounded-sm text-[9px] font-bold text-white shrink-0"
        style={{ background: color }}
      >
        {letter}
      </span>
      {/* ⚠️ 120px, а не 160: в строке до трёх бейджей, и на 160 они вылезали
          за колонку. Полный ник — в подсказке при наведении. */}
      <span className="truncate max-w-[120px]">{label}</span>
    </a>
  )
}

type RegisteredFilter = 'all' | 'yes' | 'no'

type PlatformKey = 'all' | 'telegram' | 'vk' | 'max'
type StageKey = 'landed' | 'registered' | 'attended'
interface ParticipantFilter {
  platform: PlatformKey
  stage: StageKey
}

interface Counts {
  total: number
  registered: number
  not_registered: number
}

// У участника есть идентичность на платформе?
function hasPlatform(p: Participant, plat: PlatformKey): boolean {
  if (plat === 'all') return true
  if (plat === 'telegram') return !!(p.tg_id || p.tg_username)
  if (plat === 'vk') return !!(p.vk_id || p.vk_username)
  if (plat === 'max') return !!(p.max_id || p.max_username)
  return true
}

// Участник попадает в этап воронки?
function matchStage(p: Participant, stage: StageKey): boolean {
  if (stage === 'landed') return true
  if (stage === 'registered') return !!p.is_registered
  if (stage === 'attended') return !!p.link_clicked_at
  return true
}

interface PlatformStat {
  landed: number
  registered: number
  attended: number
  in_chat?: number | null   // null/отсутствует для VK/MAX — членство в беседе не проверяется
}

interface Stats {
  total: PlatformStat
  by_platform: Partial<Record<'telegram' | 'vk' | 'max', PlatformStat>>
}

// Блок статистики «зашло / зарегано / на эфире» с конверсиями, разбивка по площадкам.
// Каждая числовая ячейка + название площадки — кнопка-фильтр списка ниже.
function StatsBlock({
  stats, clickLabel, filter, onPick,
}: {
  stats: Stats
  clickLabel: string
  filter: ParticipantFilter
  onPick: (platform: PlatformKey, stage: StageKey) => void
}) {
  const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : 0)
  const rows: { key: PlatformKey; label: string; color: string; s: PlatformStat }[] = [
    { key: 'all', label: 'Всего', color: '#25455D', s: stats.total },
  ]
  const platMeta: { slug: 'telegram' | 'vk' | 'max'; label: string; color: string }[] = [
    { slug: 'telegram', label: 'Telegram', color: '#229ED9' },
    { slug: 'vk', label: 'VK', color: '#0077FF' },
    { slug: 'max', label: 'MAX', color: '#C79A5B' },
  ]
  for (const m of platMeta) {
    const s = stats.by_platform[m.slug]
    if (s && (s.landed > 0 || s.registered > 0 || s.attended > 0)) {
      rows.push({ key: m.slug, label: m.label, color: m.color, s })
    }
  }

  // Кликабельная числовая ячейка
  const NumCell = ({ platform, stage, value }: { platform: PlatformKey; stage: StageKey; value: number }) => {
    const active = filter.platform === platform && filter.stage === stage
    return (
      <td className="py-1.5 px-2 text-center">
        <button
          onClick={() => onPick(platform, stage)}
          className={`w-full min-w-[44px] py-1.5 px-2 rounded-lg text-sm tabular-nums font-semibold transition ${
            active
              ? 'text-white'
              : 'text-gray-900 hover:bg-gray-100'
          }`}
          style={active ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : undefined}
        >
          {value}
        </button>
      </td>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 mb-4">
      <h3 className="text-sm font-bold text-gray-900 mb-1">Регистрации по площадкам</h3>
      <p className="text-xs text-gray-400 mb-3">Нажмите на число, чтобы отфильтровать список ниже</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[520px]">
          <thead>
            <tr className="text-left text-gray-400 text-xs">
              <th className="font-medium pb-2 pr-3">Площадка</th>
              <th className="font-medium pb-2 px-2 text-center">Зашло</th>
              <th className="font-medium pb-2 px-2 text-center">Зарегано</th>
              <th className="font-medium pb-2 px-2 text-center">В чате</th>
              <th className="font-medium pb-2 pl-3 text-center">Конверсия</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              return (
                <tr key={r.key} className="border-t border-gray-50">
                  <td className="py-1.5 pr-3">
                    <span className="inline-flex items-center gap-2 font-semibold" style={{ color: r.color }}>
                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: r.color }} />
                      {r.label}
                    </span>
                  </td>
                  <NumCell platform={r.key} stage="landed" value={r.s.landed} />
                  <NumCell platform={r.key} stage="registered" value={r.s.registered} />
                  <td className="py-1.5 px-2 text-center">
                    {/* «В чате» проверяется только в Telegram (getChatMember).
                        Для VK/MAX членство в беседе через API не получить → «—». */}
                    {(r.key === 'vk' || r.key === 'max') ? (
                      <span
                        className="inline-block min-w-[44px] py-1.5 px-2 text-sm text-gray-300"
                        title="Проверка членства в чате доступна только для Telegram"
                      >
                        —
                      </span>
                    ) : (
                      <span className="inline-block min-w-[44px] py-1.5 px-2 text-sm tabular-nums font-semibold text-gray-900">
                        {r.s.in_chat ?? 0}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pl-3 text-center">
                    <span
                      className="inline-block px-2 py-0.5 rounded-md text-xs font-bold"
                      style={{ background: '#FFCFA4', color: '#25455D' }}
                    >
                      {pct(r.s.registered, r.s.landed)}%
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400 mt-3">
        Зашло — открыли событие. Зарегано — завершили регистрацию.
        В чате — состоят в Telegram-чате события (обновляется по кнопке «Проверить чаты»).
        Конверсия = зарегано ÷ зашло. Один человек попадает в строку каждой своей площадки, поэтому сумма по площадкам может быть больше «Всего».
      </p>
    </div>
  )
}

function referrerLabel(p: Participant): string {
  if (!p.referrer_ref_code) return '—'
  const username = p.referrer_username ? `@${p.referrer_username.replace(/^@+/, '')}` : ''
  if (p.referrer_name) {
    return username ? `${p.referrer_name} (${username})` : p.referrer_name
  }
  if (username) return username
  return `код ${p.referrer_ref_code}`
}

// Персональные реф-ссылки участника (TG/VK/MAX) по его ref_code.
// Грузятся лениво при раскрытии карточки. Кнопка «Скопировать все» кладёт
// в буфер сразу все ссылки (по одной на строку).
const PLATFORM_META: { key: 'telegram' | 'vk' | 'max'; label: string; color: string }[] = [
  { key: 'telegram', label: 'Telegram', color: '#229ED9' },
  { key: 'vk', label: 'VK', color: '#0077FF' },
  { key: 'max', label: 'MAX', color: '#C79A5B' },
]

function ParticipantRefLinks({ eventId, refCode }: { eventId: number; refCode: string }) {
  const [links, setLinks] = useState<Record<string, string> | null>(null)
  const [loading, setLoading] = useState(true)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.events.shareLinksById(eventId, refCode)
      .then((r: any) => { if (alive) setLinks(r?.links || {}) })
      .catch(() => { if (alive) setLinks({}) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [eventId, refCode])

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(k => (k === key ? null : k)), 1500)
    } catch { /* ignore */ }
  }

  if (loading) {
    return <p className="text-[11px] text-gray-400 py-1">Загружаю ссылки…</p>
  }

  const rows = PLATFORM_META.filter(m => links?.[m.key])
  if (rows.length === 0) {
    return <p className="text-[11px] text-gray-400 py-1">Нет подключённых площадок для реф-ссылок.</p>
  }

  const allText = rows.map(m => `${m.label}: ${links![m.key]}`).join('\n')

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-gray-500 text-xs font-semibold flex items-center gap-1.5">
          <Link2 size={12} /> Партнёрские ссылки участника
        </p>
        <button
          type="button"
          onClick={() => copy(allText, '__all__')}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg text-white"
          style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
        >
          {copiedKey === '__all__' ? <Check size={12} /> : <Copy size={12} />}
          {copiedKey === '__all__' ? 'Скопировано' : 'Скопировать все'}
        </button>
      </div>
      <div className="space-y-1.5">
        {rows.map(m => (
          <div key={m.key} className="flex items-center gap-2">
            <span
              className="inline-flex items-center justify-center w-9 shrink-0 rounded-md text-[9px] font-bold text-white py-1"
              style={{ background: m.color }}
            >
              {m.key === 'telegram' ? 'TG' : m.key === 'vk' ? 'VK' : 'MAX'}
            </span>
            <input
              readOnly
              value={links![m.key]}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 px-2 py-1 text-[11px] font-mono rounded-md border border-gray-200 bg-white text-gray-700"
            />
            <button
              type="button"
              onClick={() => copy(links![m.key], m.key)}
              title={`Скопировать ссылку ${m.label}`}
              className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-gray-400 hover:text-[#25455D] hover:bg-gray-200 transition-colors"
            >
              {copiedKey === m.key ? <Check size={13} className="text-green-600" /> : <Copy size={13} />}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function ContactCard({
  p,
  eventId,
  onToggleRegistered,
  onDelete,
  onReferrerChanged,
  clickLabel,
  isCollab,
}: {
  p: Participant
  eventId: number
  onToggleRegistered: (next: boolean) => void
  onDelete: () => void
  onReferrerChanged: (ref: { name: string | null; username: string | null; ref_code: string | null } | null) => void
  clickLabel: string
  isCollab?: boolean
}) {
  const { isAssistant } = useMe()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editingRef, setEditingRef] = useState(false)
  const name = p.contact_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || 'Без имени'
  const initial = name[0]?.toUpperCase() || '?'

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      onToggleRegistered(!p.is_registered)
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (deleting) return
    if (!confirm(`Удалить участника «${name}» из события?\n\nКонтакт и его участие в других событиях останутся.`)) return
    setDeleting(true)
    try {
      onDelete()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="border-t border-gray-50 first:border-t-0">
      <div
        className="flex items-center gap-3 px-5 py-3.5 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        {/* Имя — главная колонка.
            ⚠️ `pr-3` обязателен: ники площадок (`@rendarevskaya_coach`) стоят в
            строке с `flex-wrap` и упираются в самый край колонки — вплотную к
            соседней «В чьей базе», текст читался как склеенный. Отступ даёт
            зазор; `min-w-0` оставляем, иначе усечение не сработает. */}
        <div className="flex items-center gap-3 flex-1 min-w-0 pr-3">
          <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center shrink-0 text-sm font-medium text-gray-500">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            {/* Имя — ссылка на карточку контакта в общей базе: раньше туда
                можно было попасть, только развернув участника. */}
            {p.contact_id ? (
              <a
                href={`/dashboard/clients?contact=${p.contact_id}`}
                target="_blank"
                rel="noopener"
                onClick={e => e.stopPropagation()}
                title="Открыть карточку контакта"
                className="block truncate text-sm font-medium text-gray-900 hover:text-[#25455D] hover:underline"
              >
                {name}
              </a>
            ) : (
              <p className="truncate text-sm font-medium text-gray-900">{name}</p>
            )}
            {/* ⚠️ `w-full min-w-0 overflow-hidden` обязательны: без них строка
                ников распирает колонку изнутри. `flex-wrap` переносит бейджи,
                но сам блок при этом растёт по содержимому — и длинный ник
                (`@rendarevskaya_coach`) наезжал на соседнюю колонку «В чьей
                базе». Одного `truncate` на бейдже мало: он ограничивает ник в
                160px, а бейджей в строке до трёх. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5 w-full min-w-0 overflow-hidden">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(String(p.id)) }}
                title="Скопировать participant_id (для интеграции с GetCourse/Salebot)"
                className="text-[10px] text-gray-400 hover:text-gray-700 font-mono"
              >
                #{p.id}
              </button>
              {p.tg_id || p.tg_username ? (
                <PlatformBadge platform="telegram" userId={p.tg_id} username={p.tg_username} />
              ) : null}
              {p.vk_id || p.vk_username ? (
                <PlatformBadge platform="vk" userId={p.vk_id} username={p.vk_username} />
              ) : null}
              {p.max_id || p.max_username ? (
                <PlatformBadge platform="max" userId={p.max_id} username={p.max_username} />
              ) : null}
            </div>
          </div>
        </div>

        {/* Колонка «Организатор» — только в коллабе. Организатор ≠ «кто привёл»:
            реферала мог позвать обычный участник, но организатор — тот, в чью базу
            попал контакт (contacts.client_id). */}
        {isCollab && (
          // ⚠️ pl-3 — отступ слева: без него длинные ники из колонки «Имя»
          // наезжали на эту колонку и текст сливался.
          <div className="hidden sm:flex w-40 shrink-0 min-w-0 items-center pl-3">
            <span className="text-xs text-gray-700 truncate" title={p.organizer_name || ''}>
              {p.organizer_name || <span className="text-gray-300">—</span>}
            </span>
          </div>
        )}

        {/* Колонка «Кто привёл» (имя реферера) */}
        <div className="hidden sm:flex flex-1 max-w-xs shrink-0 min-w-0 items-center">
          {p.referrer_ref_code ? (
            <span className="text-xs text-gray-700 truncate" title={referrerLabel(p)}>
              {p.referrer_name || (p.referrer_username ? `@${p.referrer_username.replace(/^@+/, '')}` : `код ${p.referrer_ref_code}`)}
              {p.referrer_username && p.referrer_name && (
                <span className="text-gray-400"> @{p.referrer_username.replace(/^@+/, '')}</span>
              )}
            </span>
          ) : (
            <span className="text-xs text-gray-300">— пришёл сам</span>
          )}
        </div>

        {/* Колонка «Дата регистрации» — дата и ВРЕМЯ захода.
            ⚠️ Время считаем в МСК (timeZone), а не в поясе браузера: у клиента
            и у зрителей он разный, а событие живёт по московскому. */}
        <div className="w-24 text-center shrink-0">
          {p.registered_at ? (
            <span className="text-xs text-gray-500 leading-tight block">
              {new Date(p.registered_at).toLocaleDateString('ru', { timeZone: 'Europe/Moscow' })}
              <br />
              <span className="text-[11px] text-gray-400">
                {new Date(p.registered_at).toLocaleTimeString('ru', {
                  timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit',
                })} МСК
              </span>
            </span>
          ) : (
            <span className="text-xs text-gray-300">—</span>
          )}
        </div>

        {/* Колонка «Оплатил» — сумма по всем оплаченным тарифам события. */}
        <div className="w-24 shrink-0 text-center">
          {Number(p.paid_amount) > 0 ? (
            <span title={p.paid_tariffs || ''}
                  className="inline-block rounded-md bg-green-50 px-2 py-0.5 text-xs font-semibold text-green-700">
              {Number(p.paid_amount).toLocaleString('ru-RU')} ₽
            </span>
          ) : (
            <span className="text-xs text-gray-300">—</span>
          )}
        </div>

        {/* Колонка «Зарегистрирован» — чекбокс */}
        <div className="w-24 flex justify-center shrink-0">
          <button
            type="button"
            onClick={toggle}
            disabled={busy}
            title={p.is_registered ? 'Снять статус «Зарегистрирован»' : 'Отметить как зарегистрирован'}
            className={`w-6 h-6 rounded-md border flex items-center justify-center transition-colors ${
              p.is_registered
                ? 'bg-green-500 border-green-500 text-white'
                : 'bg-white border-gray-300 hover:border-gray-400'
            } ${busy ? 'opacity-50' : ''}`}
          >
            {p.is_registered && <Check size={14} strokeWidth={3} />}
          </button>
        </div>


        {/* Колонка «В чате» — read-only, ставится кнопкой «Проверить чаты» (только TG) */}
        <div className="w-24 flex justify-center shrink-0">
          {p.chat_check_at ? (
            <span
              title={`Проверено ${new Date(p.chat_check_at).toLocaleString('ru')} — ${p.is_in_chat ? 'в чате' : 'не в чате'}`}
              className={`w-6 h-6 rounded-md border flex items-center justify-center ${
                p.is_in_chat
                  ? 'bg-blue-500 border-blue-500 text-white'
                  : 'bg-white border-gray-300 text-gray-300'
              }`}
            >
              {p.is_in_chat ? <Check size={14} strokeWidth={3} /> : <X size={14} strokeWidth={3} />}
            </span>
          ) : (
            <span
              title="Ещё не проверяли. Нажмите «Проверить чаты» вверху."
              className="w-6 h-6 rounded-md border border-gray-200 flex items-center justify-center text-gray-300 text-xs"
            >
              ?
            </span>
          )}
        </div>

        {/* Колонка «Подписан / Отписан» — read-only */}
        <div className="w-24 flex justify-center shrink-0">
          {p.is_unsubscribed ? (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold bg-red-50 text-red-600 border border-red-200"
              title="Отписался от всех TG-каналов клиента"
            >
              ✕ Отписан
            </span>
          ) : p.is_subscribed ? (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold bg-green-50 text-green-700 border border-green-200"
              title="Подписан хотя бы на один TG-канал клиента"
            >
              ✓ Подписан
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium bg-gray-50 text-gray-400 border border-gray-200"
              title="Нет записи о подписке (либо контакт не из TG)"
            >
              —
            </span>
          )}
        </div>

        {/* Кнопка удаления.
            ⚠️ В КОЛЛАБЕ состав участников защищён — на нём считается вклад
            организаторов и Win-Win. Удалять можно ТОЛЬКО тестовые аккаунты
            организаторов события (Настройки → «Тестовые рассылки»), поэтому у
            остальных кнопку не рисуем: раньше она была видна у всех, человек
            нажимал и получал 403 с советом «обратитесь в поддержку», у которой
            такой возможности тоже нет. */}
        <div className="w-8 flex justify-center shrink-0">
          {!isAssistant && (!isCollab || p.is_test_account) && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              title="Удалить из события"
              className={`w-7 h-7 rounded-md flex items-center justify-center text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors ${
                deleting ? 'opacity-50' : ''
              }`}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>

        <div className="w-4 shrink-0 text-gray-400">
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </div>

      {open && (
        <div className="px-5 pb-4 bg-gray-50 border-t border-gray-100">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 pt-3 text-xs">
            <Field label="participant_id (для GetCourse-webhook)" value={String(p.id)} mono />
            <Field label="contact_id (для GetCourse-webhook)" value={String(p.contact_id)} mono />
            <Field label="Свой реф-код (его ссылка)" value={p.ref_code || '—'} mono />
            <Field
              label="От кого пришёл"
              value={referrerLabel(p)}
              highlight={!!p.referrer_ref_code}
            />
            <div>
              <p className="text-gray-400 mb-0.5">Реф-код реферера</p>
              <div className="flex items-center gap-1.5">
                <span className={`font-mono break-all ${p.referrer_ref_code ? 'text-brand font-medium' : 'text-gray-700'}`}>
                  {p.referrer_ref_code || '—'}
                </span>
                {!isAssistant && (
                  <button
                    type="button"
                    onClick={() => setEditingRef(v => !v)}
                    title={p.referrer_ref_code ? 'Сменить реферера' : 'Указать реферера'}
                    className="w-5 h-5 rounded flex items-center justify-center text-gray-400 hover:text-[#25455D] hover:bg-gray-200 transition-colors shrink-0"
                  >
                    <Pencil size={12} />
                  </button>
                )}
              </div>
            </div>
            <Field label="Telegram ID" value={p.platform_user_id || '—'} />
            <Field label="Salebot ID" value={p.salebot_id || '—'} />
            <Field label="Телефон" value={p.phone || '—'} />
            <Field label="Email" value={p.email || '—'} />
            <Field label="Зарегистрирован" value={p.is_registered ? 'Да' : 'Нет'} />
            <Field label="В чате" value={p.is_in_chat ? 'Да' : 'Нет'} />
          </div>
          {!isAssistant && editingRef && (
            <div className="pt-3 mt-3 border-t border-gray-200">
              <ReferrerEditor
                eventId={eventId}
                p={p}
                onChanged={(ref) => { setEditingRef(false); onReferrerChanged(ref) }}
                onClose={() => setEditingRef(false)}
              />
            </div>
          )}
          {p.ref_code && (
            <div className="pt-3 mt-3 border-t border-gray-200">
              <ParticipantRefLinks eventId={eventId} refCode={p.ref_code} />
            </div>
          )}
          {p.contact_id ? (
            <div className="pt-3 mt-3 border-t border-gray-200">
              <a
                href={`/dashboard/clients?contact=${p.contact_id}`}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#25455D] hover:underline"
              >
                Открыть карточку контакта в общей базе →
              </a>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function ListHeader({ isCollab }: { isCollab?: boolean }) {
  return (
    <div className="hidden sm:flex items-center gap-3 px-5 py-2.5 border-b border-gray-100 bg-gray-50/50 text-[11px] font-medium uppercase tracking-wider text-gray-400">
      <div className="flex-1 min-w-0">Имя</div>
      {/* ⚠️ «В ЧЬЕЙ БАЗЕ», а не «Организатор»: слово «организатор» читалось как
          «кто провёл событие», хотя речь о том, в чью базу попал контакт. */}
      {isCollab && <div className="w-40 shrink-0 pl-3">В чьей базе</div>}
      <div className="flex-1 max-w-xs">Кто привёл</div>
      <div className="w-24 text-center">Регистрация</div>
      <div className="w-24 text-center">Оплатил</div>
      <div className="w-24 text-center">Зарегистр.</div>
      <div className="w-24 text-center">В чате ТГ</div>
      <div className="w-24 text-center">Подписка</div>
      <div className="w-8" />
      <div className="w-4" />
    </div>
  )
}

// Редактор реферера участника — только для владельца кабинета.
// Поиск по контактам клиента; выбранный контакт становится реферером (по его ref_code).
function ReferrerEditor({
  eventId,
  p,
  onChanged,
  onClose,
}: {
  eventId: number
  p: Participant
  onChanged: (ref: { name: string | null; username: string | null; ref_code: string | null } | null) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const q = query.trim()
    const t = setTimeout(() => {
      setSearching(true)
      api.contacts.list(q, 20, 0, false)
        .then((r: any) => setResults(r.contacts || r.items || []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  async function pick(contact: any | null) {
    if (saving) return
    setSaving(true)
    try {
      await api.events.setReferrer(eventId, p.id, { referrer_contact_id: contact?.id ?? null })
      // Передаём наверх данные нового реферера — строка обновится точечно,
      // без полной перезагрузки списка участников. username берём из identities
      // (приоритет Telegram), т.к. плоского поля username в contacts.list нет.
      const ids = contact?.identities || []
      const tgId = ids.find((i: any) => i.platform_slug === 'telegram')
      const uname = (tgId?.username || ids[0]?.username || contact?.username || '').replace(/^@+/, '')
      onChanged(contact ? {
        name: contact.name || null,
        username: uname || null,
        ref_code: contact.ref_code || null,
      } : null)
    } catch (e: any) {
      alert(e?.message || 'Не удалось сменить реферера')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 max-w-md">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-gray-600">Кто привёл участника</span>
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700"
        >
          <X size={14} />
        </button>
      </div>
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Имя, @ник, email…"
          className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border border-gray-200 focus:border-[#25455D] focus:outline-none"
        />
      </div>
      <div className="mt-2 max-h-48 overflow-y-auto">
        {searching ? (
          <p className="text-[11px] text-gray-400 py-2 text-center">Ищем…</p>
        ) : results.length === 0 ? (
          <p className="text-[11px] text-gray-400 py-2 text-center">Никого не найдено</p>
        ) : (
          results
            .filter((c) => c.id !== p.contact_id)
            .map((c) => {
              const nm = c.name || c.username || c.email || `#${c.id}`
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={saving}
                  onClick={() => pick(c)}
                  className="w-full text-left px-2 py-1.5 rounded-md hover:bg-gray-50 flex items-center gap-2 disabled:opacity-50"
                >
                  <span className="text-xs text-gray-800 truncate">{nm}</span>
                  {c.ref_code && <span className="text-[10px] text-gray-400 font-mono ml-auto">{c.ref_code}</span>}
                </button>
              )
            })
        )}
      </div>
      {p.referrer_ref_code && (
        <button
          type="button"
          disabled={saving}
          onClick={() => pick(null)}
          className="mt-2 w-full text-center text-[11px] text-red-500 hover:text-red-600 py-1.5 disabled:opacity-50"
        >
          Снять реферера (пришёл сам)
        </button>
      )}
    </div>
  )
}

function Field({ label, value, mono, highlight }: { label: string; value: string; mono?: boolean; highlight?: boolean }) {
  return (
    <div>
      <p className="text-gray-400 mb-0.5">{label}</p>
      <p className={`${mono ? 'font-mono' : ''} ${highlight ? 'text-brand font-medium' : 'text-gray-700'} break-all`}>
        {value}
      </p>
    </div>
  )
}

function AddFromContactModal({
  eventId,
  existingContactIds,
  onClose,
  onAdded,
}: {
  eventId: number
  existingContactIds: Set<number>
  onClose: () => void
  onAdded: () => void
}) {
  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true)
      api.contacts.list(query, 50, 0, false)
        .then((r: any) => setContacts(r.contacts || r.items || []))
        .catch(() => setContacts([]))
        .finally(() => setLoading(false))
    }, query ? 250 : 0)
    return () => clearTimeout(t)
  }, [query])

  async function pickContact(c: any) {
    if (existingContactIds.has(c.id)) return
    setAdding(c.id); setError('')
    try {
      await api.events.addParticipantFromContact(eventId, c.id, false)
      onAdded()
      onClose()
    } catch (e: any) {
      setError(e?.message || 'Не удалось добавить участника')
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 shrink-0">
          <div>
            <h3 className="font-bold text-gray-900 text-lg">Добавить участника</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Выберите контакт — он попадёт в список без статуса «зарегистрирован».
              Поставить галочку можно потом кликом по строке.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 border-b border-gray-100 shrink-0">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              type="text"
              placeholder="Имя, email или телефон..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="w-6 h-6 border-2 border-brand rounded-full border-t-transparent animate-spin" />
            </div>
          ) : contacts.length === 0 ? (
            <div className="p-8 text-center">
              <Users size={28} className="mx-auto mb-3 text-gray-300" />
              <p className="text-sm text-gray-500 mb-2">
                {query ? 'Ничего не найдено' : 'Нет контактов'}
              </p>
              <p className="text-xs text-gray-400">
                Сначала добавьте человека в{' '}
                <Link href="/dashboard/clients" className="text-brand hover:underline">«Контакты»</Link>
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-50">
              {contacts.map(c => {
                const taken = existingContactIds.has(c.id)
                const isAdding = adding === c.id
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => pickContact(c)}
                      disabled={taken || isAdding}
                      className={`w-full text-left px-3 py-3 rounded-xl flex items-center gap-3 transition-colors
                        ${taken ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`}
                    >
                      <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                        {(c.name || '?').trim().charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-sm text-gray-900 truncate">{c.name || 'Без имени'}</div>
                        <div className="text-xs text-gray-500 truncate flex items-center gap-3">
                          {c.email && <span className="flex items-center gap-1"><Mail size={10} />{c.email}</span>}
                          {c.phone && <span className="flex items-center gap-1"><Phone size={10} />{c.phone}</span>}
                          {!c.email && !c.phone && <span className="text-gray-400">без email/телефона</span>}
                        </div>
                      </div>
                      {taken ? (
                        <span className="text-[11px] text-gray-400 shrink-0">уже участник</span>
                      ) : isAdding ? (
                        <Spinner />
                      ) : (
                        <UserPlus size={16} className="text-gray-400 shrink-0" />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {error && (
          <div className="p-3 border-t border-red-200 bg-red-50 text-red-700 text-sm flex items-center gap-2">
            <AlertCircle size={15} /> {error}
          </div>
        )}

        <div className="p-4 border-t border-gray-100 text-xs text-gray-500 shrink-0">
          Не нашли человека?{' '}
          <Link href="/dashboard/clients" className="text-brand hover:underline">
            Добавьте контакт
          </Link>{' '}
          — и вернитесь сюда.
        </div>
      </div>
    </div>
  )
}

export default function EventParticipants({ eventId, moduleSlug, isCollab }: { eventId: number; moduleSlug?: string; isCollab?: boolean }) {
  // Лейбл второй галочки — «Был в эфире» / «Проголосовал». У конкурсов
  // главная ссылка — голосование, у остальных типов — стрим/эфир.
  const clickLabel = moduleSlug === 'contest' ? 'Проголосовал' : 'Был в эфире'
  const [participants, setParticipants] = useState<Participant[]>([])
  const [counts, setCounts] = useState<Counts>({ total: 0, registered: 0, not_registered: 0 })
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  // Фильтр по оплате: показать только оплативших или только без оплаты.
  const [paidFilter, setPaidFilter] = useState<'all' | 'yes' | 'no'>('all')
  // Фильтр по площадке × этапу (управляется кликами по таблице статистики)
  const [pFilter, setPFilter] = useState<ParticipantFilter>({ platform: 'all', stage: 'landed' })
  const [showAdd, setShowAdd] = useState(false)
  const [checkingChats, setCheckingChats] = useState(false)

  async function load() {
    setLoading(true)
    try {
      // Грузим всех участников разом — фильтрация по площадке/этапу на фронте
      const r = await api.events.participants(eventId, 'all')
      setParticipants(r.participants || [])
      setCounts(r.counts || { total: 0, registered: 0, not_registered: 0 })
      if (r.stats) setStats(r.stats)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId])

  async function toggleRegistered(participantId: number, next: boolean) {
    // Оптимистичное обновление + откат при ошибке
    const prev = participants
    const prevCounts = counts
    setParticipants(list =>
      list.map(p => (p.id === participantId ? { ...p, is_registered: next } : p))
    )
    setCounts(c => ({
      total: c.total,
      registered: c.registered + (next ? 1 : -1),
      not_registered: c.not_registered + (next ? -1 : 1),
    }))
    try {
      await api.events.setRegistered(eventId, participantId, next)
    } catch (e: any) {
      setParticipants(prev)
      setCounts(prevCounts)
      alert(e?.message || 'Не удалось обновить статус')
    }
  }

  async function deleteParticipant(participantId: number) {
    const prev = participants
    const prevCounts = counts
    const target = participants.find(p => p.id === participantId)
    if (!target) return
    setParticipants(list => list.filter(p => p.id !== participantId))
    setCounts(c => ({
      total: c.total - 1,
      registered: c.registered - (target.is_registered ? 1 : 0),
      not_registered: c.not_registered - (target.is_registered ? 0 : 1),
    }))
    try {
      await api.events.deleteParticipant(eventId, participantId)
    } catch (e: any) {
      setParticipants(prev)
      setCounts(prevCounts)
      alert(e?.message || 'Не удалось удалить участника')
    }
  }

  async function checkChats() {
    if (checkingChats) return
    setCheckingChats(true)
    try {
      const r: any = await api.events.checkChats(eventId)
      if (!r?.ok) {
        alert(r?.message || 'Не удалось проверить чаты.')
        return
      }
      // Перезагружаем список — обновятся is_in_chat + chat_check_at
      await load()
      const parts: string[] = [
        `Проверено: ${r.checked}`,
        `в чате: ${r.in_chat}`,
        `не в чате: ${r.not_in_chat}`,
      ]
      if (r.skipped_no_tg) parts.push(`без Telegram (пропущено): ${r.skipped_no_tg}`)
      if (r.undetermined) parts.push(`не удалось определить (бот не админ?): ${r.undetermined}`)
      alert(`Готово.\n\n${parts.join('\n')}`)
    } catch (e: any) {
      alert(e?.message || 'Не удалось проверить чаты.')
    } finally {
      setCheckingChats(false)
    }
  }

  const existingContactIds = useMemo(
    () => new Set(participants.map(p => p.contact_id).filter((x): x is number => typeof x === 'number')),
    [participants]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return participants.filter(p => {
      // Фильтр по площадке × этапу (клик в таблице статистики)
      if (!hasPlatform(p, pFilter.platform)) return false
      if (!matchStage(p, pFilter.stage)) return false
      // Оплатившие — у кого сумма по оплаченным тарифам больше нуля.
      if (paidFilter === 'yes' && !(Number(p.paid_amount) > 0)) return false
      if (paidFilter === 'no' && Number(p.paid_amount) > 0) return false
      if (!q) return true
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ').toLowerCase()
      const username = (p.username || '').toLowerCase().replace(/^@+/, '')
      const refCode = (p.ref_code || '').toLowerCase()
      const referrerCode = (p.referrer_ref_code || '').toLowerCase()
      return (
        name.includes(q) ||
        username.includes(q) ||
        refCode.includes(q) ||
        referrerCode.includes(q) ||
        (p.platform_user_id || '').includes(q) ||
        (p.salebot_id || '').includes(q)
      )
    })
  }, [participants, search, pFilter, paidFilter])

  if (loading && participants.length === 0) {
    return <div className="flex justify-center py-12"><Spinner className="text-brand text-2xl" /></div>
  }

  if (counts.total === 0) {
    return (
      <div className="max-w-2xl">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
          <div className="w-16 h-16 rounded-full gradient-bg flex items-center justify-center mx-auto mb-5">
            <Users size={28} className="text-white" />
          </div>
          <h2 className="text-lg font-bold text-gray-900 mb-2">Участников пока нет</h2>
          <p className="text-gray-500 text-sm max-w-xs mx-auto mb-6">
            Здесь появятся пользователи Telegram, которые открыли бот по вашей реферальной ссылке на это событие. Или добавьте их вручную из своих контактов.
          </p>
          <button onClick={() => setShowAdd(true)}
            className="btn-gold inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold">
            <Plus size={16} /> Добавить из контактов
          </button>
        </div>
        {showAdd && (
          <AddFromContactModal
            eventId={eventId}
            existingContactIds={existingContactIds}
            onClose={() => setShowAdd(false)}
            onAdded={() => load()}
          />
        )}
      </div>
    )
  }

  return (
    <div>
      {/* Статистика по площадкам — кликабельные ячейки = фильтр списка */}
      {stats && (
        <StatsBlock
          stats={stats}
          clickLabel={clickLabel}
          filter={pFilter}
          onPick={(platform, stage) => setPFilter({ platform, stage })}
        />
      )}

      {/* Активный фильтр + кнопка добавления */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-sm text-gray-500">
          Показаны:{' '}
          <span className="font-semibold text-gray-900">
            {pFilter.platform === 'all' ? 'все площадки'
              : pFilter.platform === 'telegram' ? 'Telegram'
              : pFilter.platform === 'vk' ? 'VK' : 'MAX'}
            {' · '}
            {pFilter.stage === 'landed' ? 'зашло'
              : pFilter.stage === 'registered' ? 'зарегано'
              : clickLabel.toLowerCase()}
          </span>{' '}
          <span className="text-gray-400">({filtered.length})</span>
        </span>
        {(pFilter.platform !== 'all' || pFilter.stage !== 'landed') && (
          <button
            onClick={() => setPFilter({ platform: 'all', stage: 'landed' })}
            className="text-xs text-brand hover:underline"
          >
            сбросить
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex flex-col items-end">
            <button
              onClick={checkChats}
              disabled={checkingChats}
              title="Проверить, кто из участников состоит в Telegram-чате события. Бот должен быть админом чата."
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {checkingChats ? <Spinner className="text-gray-500 text-base" /> : <MessagesSquare size={15} />}
              {checkingChats ? 'Проверяю…' : 'Проверить чаты'}
            </button>
            <span className="text-[10px] text-gray-400 mt-0.5 leading-none">работает только в Telegram</span>
          </div>
          <button onClick={() => setShowAdd(true)}
            className="btn-gold inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold">
            <Plus size={15} /> Добавить из контактов
          </button>
        </div>
      </div>

      {/* Поиск */}
      <div className="relative mb-4">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Поиск по имени, @username, реф-коду, Telegram ID..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-8 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand bg-white"
        />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            <X size={14} />
          </button>
        )}
      </div>

      {/* Фильтр по оплате — рядом с поиском, чтобы быстро вытащить платящих. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {([
          ['all', 'Все'], ['yes', 'Оплатили'], ['no', 'Без оплаты'],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setPaidFilter(k as any)}
            className={`rounded-lg border px-3 py-1.5 text-sm ${
              paidFilter === k
                ? 'border-brand bg-brand/5 font-medium text-brand'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
        {paidFilter === 'yes' && (
          <span className="text-sm text-gray-500">
            на сумму{' '}
            <b className="text-gray-800">
              {filtered.reduce((sum, p) => sum + Number(p.paid_amount || 0), 0)
                .toLocaleString('ru-RU')} ₽
            </b>
          </span>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-10 text-center text-gray-400 text-sm">
            {participants.length === 0 ? 'В этой группе пусто' : 'Никого не найдено'}
          </div>
        ) : (
          <>
            <ListHeader isCollab={isCollab} />
            {filtered.map(p => (
              <ContactCard
                key={p.id}
                p={p}
                eventId={eventId}
                onToggleRegistered={(next) => toggleRegistered(p.id, next)}
                onDelete={() => deleteParticipant(p.id)}
                onReferrerChanged={(ref) => setParticipants(list => list.map(x =>
                  x.id === p.id ? {
                    ...x,
                    referrer_ref_code: ref?.ref_code ?? null,
                    referrer_name: ref?.name ?? null,
                    referrer_username: ref?.username ?? null,
                  } : x
                ))}
                clickLabel={clickLabel}
                isCollab={isCollab}
              />
            ))}
          </>
        )}
      </div>
      <p className="text-xs text-gray-400 mt-2">
        Галочка в колонке «Зарегистр.» — отметка вручную, что человек зарегистрировался на событие. Снять/поставить можно кликом.
      </p>
      {showAdd && (
        <AddFromContactModal
          eventId={eventId}
          existingContactIds={existingContactIds}
          onClose={() => setShowAdd(false)}
          onAdded={() => load()}
        />
      )}
    </div>
  )
}
