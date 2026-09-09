'use client'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ExternalLink, Users, CheckCircle2, Wallet } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

/**
 * Карточка рефовода в контексте события: кого он привёл и с каким результатом.
 *
 * Открывается кликом по строке в «Реф-программа → Отчёт по рефералам».
 * Живёт внутри макета кабинета (сайдбар и шапка на месте) — это обычная
 * вложенная страница события, как страница соорганизатора.
 *
 * ⚠️ Своего `max-w` в корне НЕТ намеренно: DashboardLayout уже задаёт ширину,
 * а таблице людей нужна вся доступная. См. [[feedback_dashboard_page_full_width]].
 */

interface Person {
  participant_id: number
  contact_id: number
  name: string | null
  phone: string | null
  email: string | null
  tg_id: string | null
  tg_username: string | null
  vk_id: string | null
  vk_username: string | null
  max_id: string | null
  max_username: string | null
  is_registered: boolean
  registered_at: string | null
  created_at: string | null
  paid_amount: number
  paid_tariffs: string | null
}

function money(v: number): string {
  return `${Number(v || 0).toLocaleString('ru-RU')} ₽`
}

/** Иконка площадки — только у тех, что реально есть у человека. */
function PlatformBadges({ p }: { p: Person }) {
  const items: { key: string; label: string; color: string; href?: string }[] = []
  if (p.tg_id || p.tg_username) {
    const nick = p.tg_username ? String(p.tg_username).replace(/^@+/, '') : ''
    items.push({
      key: 'tg', label: 'TG', color: '#229ED9',
      href: nick ? `https://t.me/${nick}` : undefined,
    })
  }
  if (p.vk_id || p.vk_username) {
    const nick = p.vk_username ? String(p.vk_username).replace(/^@+/, '') : ''
    items.push({
      key: 'vk', label: 'VK', color: '#0077FF',
      href: nick ? `https://vk.com/${nick}` : (p.vk_id ? `https://vk.com/id${p.vk_id}` : undefined),
    })
  }
  if (p.max_id || p.max_username) {
    const nick = p.max_username ? String(p.max_username).replace(/^@+/, '') : ''
    items.push({
      key: 'max', label: 'MAX', color: '#C79A5B',
      href: nick ? `https://max.ru/${nick}` : (p.max_id ? `https://max.ru/u/${p.max_id}` : undefined),
    })
  }
  if (items.length === 0) return <span className="text-gray-300">—</span>
  return (
    <span className="inline-flex gap-1">
      {items.map(i => i.href ? (
        <a key={i.key} href={i.href} target="_blank" rel="noopener noreferrer"
           title={i.href}
           className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[9px] font-bold text-white hover:opacity-80"
           style={{ background: i.color }}>
          {i.label}
        </a>
      ) : (
        <span key={i.key}
              className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[9px] font-bold text-white opacity-60"
              style={{ background: i.color }}>
          {i.label}
        </span>
      ))}
    </span>
  )
}

function StatCard({ icon: Icon, label, value, accent }: {
  icon: any; label: string; value: string; accent?: boolean
}) {
  return (
    <div
      className="rounded-xl border px-4 py-3 flex items-center gap-3"
      style={accent
        ? { borderColor: '#FFCFA4', background: '#FFF8F1' }
        : { borderColor: '#e5e7eb', background: '#fff' }}
    >
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
           style={{ background: accent ? '#FFCFA4' : '#F1F6FA', color: '#25455D' }}>
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-gray-400">{label}</p>
        <p className="text-lg font-bold text-gray-900 leading-tight">{value}</p>
      </div>
    </div>
  )
}

/** Куда возвращаться: вкладка реф-программы того раздела, откуда пришли. */
const SECTION_LABEL: Record<string, string> = {
  events: 'Мероприятия',
  conferences: 'Конференции',
  tournaments: 'Премии/Турниры',
  contests: 'Участие в конкурсах',
}

export default function EventReferrerPage() {
  const { id, contactId } = useParams()
  const params = useSearchParams()
  const eventId = Number(id)
  const cid = Number(contactId)

  // ⚠️ Отчёт живёт в ОБЩЕЙ вкладке реф-программы: она подключена и к
  // мероприятиям, и к конференциям, и к конкурсам. Страница карточки одна
  // (второй копии быть не должно), поэтому раздел возврата передаётся в
  // адресе — иначе из конференции кнопка «назад» уводила бы в мероприятия.
  const fromRaw = params.get('from') || 'events'
  const section = SECTION_LABEL[fromRaw] ? fromRaw : 'events'
  const backHref = `/dashboard/${section}/${eventId}?tab=referral&sub=report`

  const [event, setEvent] = useState<any>(null)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([
      api.events.get(eventId).catch(() => null),
      api.referralProgram.reportPerson(eventId, cid),
    ])
      .then(([ev, rep]: any[]) => {
        if (!alive) return
        setEvent(ev)
        setData(rep)
      })
      .catch((e: any) => { if (alive) setErr(e?.message || 'Не удалось загрузить') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [eventId, cid])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="text-brand text-3xl" />
      </div>
    )
  }
  if (err) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {err}
      </div>
    )
  }
  if (!data) return null

  const person = data.person || {}
  const people: Person[] = data.people || []
  const t = data.totals || {}
  const nick = person.tg_username ? String(person.tg_username).replace(/^@+/, '') : ''

  return (
    <div>
      {/* Хлебные крошки — как на других вложенных страницах события. */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4 flex-wrap">
        <Link href={`/dashboard/${section}`} className="hover:text-gray-700">
          {SECTION_LABEL[section]}
        </Link>
        <span>/</span>
        <Link href={backHref} className="hover:text-gray-700">
          {event?.title || 'Событие'}
        </Link>
        <span>/</span>
        <span className="text-gray-700">{person.name || 'Реферал'}</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <Link href={backHref}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors shrink-0">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">{person.name || 'Без имени'}</h1>
          <div className="flex items-center gap-3 flex-wrap mt-1 text-sm text-gray-500">
            {nick && (
              <a href={`https://t.me/${nick}`} target="_blank" rel="noopener noreferrer"
                 className="text-[#229ED9] hover:underline">@{nick}</a>
            )}
            {person.email && <span>{person.email}</span>}
            {person.phone && <span>{person.phone}</span>}
            <span className="font-mono text-xs text-gray-400">реф-код {person.ref_code || '—'}</span>
          </div>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {/* Зарегистрирован ли САМ рефовод — отдельный вопрос от того,
                скольких он привёл: человек может звать друзей, сам не дойдя
                до регистрации, и это важно видеть сразу. */}
            {person.self_registered ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-md bg-green-50 text-green-700 border border-green-200">
                <CheckCircle2 size={12} /> Сам зарегистрирован на событие
              </span>
            ) : person.self_participant ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-md bg-amber-50 text-amber-700 border border-amber-200">
                Сам НЕ зарегистрирован — только заходил
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-md bg-gray-100 text-gray-500 border border-gray-200">
                Сам не участник этого события
              </span>
            )}
            <Link href={`/dashboard/clients?contact=${person.id}`} target="_blank"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#25455D] hover:underline">
              Карточка контакта <ExternalLink size={11} />
            </Link>
          </div>
        </div>
      </div>

      {/* Итоги — над таблицей, чтобы ответ на «сколько он принёс» был виден
          сразу, без прокрутки списка. */}
      <div className="grid gap-3 mb-5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Users} label="Пришло от него" value={String(t.brought ?? 0)} />
        <StatCard icon={CheckCircle2} label="Зарегистрировалось" value={String(t.registered ?? 0)} />
        <StatCard icon={Wallet} label="Оплатили" value={String(t.paid_count ?? 0)} />
        <StatCard icon={Wallet} label="Сумма оплат" value={money(t.paid_sum ?? 0)} accent />
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <h2 className="font-bold text-gray-900 text-sm">Кого привёл</h2>
          <span className="text-xs text-gray-400">{people.length} чел.</span>
        </div>
        {people.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            По ссылке этого человека на событие пока никто не пришёл.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[860px]">
              <thead className="text-[11px] text-gray-400 uppercase tracking-wide bg-gray-50">
                <tr>
                  <th className="text-left px-5 py-2.5 font-medium">Имя</th>
                  <th className="text-left px-3 py-2.5 font-medium">Email</th>
                  <th className="text-left px-3 py-2.5 font-medium">Телефон</th>
                  <th className="text-left px-3 py-2.5 font-medium">Площадки</th>
                  <th className="text-left px-3 py-2.5 font-medium">Регистрация</th>
                  <th className="text-right px-5 py-2.5 font-medium">Оплата</th>
                </tr>
              </thead>
              <tbody>
                {people.map(p => (
                  <tr key={p.participant_id} className="border-t border-gray-50 hover:bg-gray-50/60">
                    <td className="px-5 py-2.5">
                      <Link href={`/dashboard/clients?contact=${p.contact_id}`} target="_blank"
                            className="font-medium text-gray-900 hover:text-[#25455D] hover:underline">
                        {p.name || 'Без имени'}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-gray-600">{p.email || <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">{p.phone || <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2.5"><PlatformBadges p={p} /></td>
                    <td className="px-3 py-2.5">
                      {p.is_registered ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700">
                          <CheckCircle2 size={12} /> Да
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">Нет</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right whitespace-nowrap">
                      {p.paid_amount > 0 ? (
                        <span className="font-semibold text-gray-900" title={p.paid_tariffs || ''}>
                          {money(p.paid_amount)}
                        </span>
                      ) : p.paid_tariffs ? (
                        /* Тариф оплачен, но сумма нулевая (бесплатный или
                           отмечен вручную) — «оплатил» и «сумма» независимы. */
                        <span className="text-xs text-gray-500" title={p.paid_tariffs}>0 ₽</span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold text-gray-900">
                  <td className="px-5 py-3">Итого</td>
                  <td className="px-3 py-3" colSpan={3}>
                    <span className="text-xs font-normal text-gray-500">
                      пришло {t.brought ?? 0} · зарегистрировалось {t.registered ?? 0} · оплатили {t.paid_count ?? 0}
                    </span>
                  </td>
                  <td className="px-3 py-3" />
                  <td className="px-5 py-3 text-right whitespace-nowrap">{money(t.paid_sum ?? 0)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
