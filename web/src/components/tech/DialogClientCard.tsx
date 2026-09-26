'use client'

/**
 * Карточка человека рядом с перепиской — ТОЛЬКО ЧТЕНИЕ (24.09.2026).
 *
 * ⚠️ Внедренец отвечает на вопрос, не зная, с кем говорит: платит ли человек,
 * что у него настроено, как с ним ещё можно связаться. Всё это лежало в
 * разных разделах, и ради одного звонка приходилось уходить из диалога.
 *
 * ⚠️ РЕДАКТИРОВАНИЯ НЕТ намеренно: тарифы, модули и данные человека — не зона
 * внедренца. Здесь он только смотрит.
 *
 * ⚠️ Контакты идут ПЕРВЫМИ (решение владельца): телефоны и соцсети — то, ради
 * чего карточку и открывают.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

const rub = (kop?: number | null) =>
  `${Math.round((kop || 0) / 100).toLocaleString('ru-RU')} ₽`

const dt = (v?: string | null) =>
  v ? new Date(v).toLocaleDateString('ru-RU') : '—'

const CRM_LABEL: Record<string, string> = {
  lead: 'Лид', trial: 'Триал', activated: 'Активирован',
  retained: 'Удержан', revived: 'Оживлён', churned: 'Отвалился',
}

/** Ссылка-строка: если значение похоже на адрес — делаем кликабельной. */
function Line({ label, value, href }: {
  label: string; value?: string | null; href?: string | null
}) {
  if (!value) return null
  return (
    <div className="flex gap-2 py-0.5 text-[12px]">
      <span className="shrink-0 text-gray-400">{label}</span>
      {href
        ? <a href={href} target="_blank" rel="noreferrer"
             className="truncate text-[#25455D] underline decoration-gray-300 hover:decoration-[#25455D]">
            {value}
          </a>
        : <span className="truncate text-gray-800">{value}</span>}
    </div>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-gray-100 px-4 py-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        {title}
      </div>
      {children}
    </div>
  )
}

export default function DialogClientCard({ contactId, ourChannels = [] }:
  { contactId: number; ourChannels?: any[] }) {
  const [d, setD] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.tech.dialogCard(contactId)
      .then((r: any) => { if (alive) setD(r) })
      .catch(() => { if (alive) setD(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [contactId])

  if (loading) {
    return <div className="p-4 text-sm text-gray-400">Загружаем карточку…</div>
  }
  if (!d) {
    return <div className="p-4 text-sm text-gray-400">Карточка недоступна.</div>
  }

  const name = [d.name, d.last_name].filter(Boolean).join(' ')
    || d.contact_name || 'Без имени'
  const phone = d.client_phone || d.phone
  const tgNick = (d.telegram_username || '').replace('@', '')
  const workTg = (d.work_tg_username || '').replace(/^.*\//, '').replace('@', '')

  // ⚠️ Соцсети хранятся свободным объектом: часть — строки-адреса, часть —
  // списки каналов. Разбираем оба вида, иначе половина ссылок пропадёт.
  const soc = d.social_links || {}
  const socLinks: [string, string][] = []
  const socChannels: { name: string; url: string }[] = []
  for (const [k, v] of Object.entries(soc)) {
    if (typeof v === 'string' && v) socLinks.push([k, v])
    else if (Array.isArray(v)) {
      for (const ch of v as any[]) {
        if (ch?.url) socChannels.push({ name: ch.name || ch.url, url: ch.url })
      }
    }
  }

  const addons: any[] = Array.isArray(d.addons) ? d.addons : []

  return (
    <div className="h-full overflow-y-auto bg-white">
      <div className="px-4 py-3">
        <div className="text-sm font-bold text-gray-900">{name}</div>
        {d.brand_name && (
          <div className="text-[12px] text-gray-500">{d.brand_name}</div>
        )}
        <div className="mt-1 flex flex-wrap gap-1">
          {d.crm_status && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700">
              {CRM_LABEL[d.crm_status] || d.crm_status}
            </span>
          )}
          {!d.client_id && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">
              не клиент платформы
            </span>
          )}
        </div>
      </div>

      {/* ⚠️ Где человек с НАМИ на связи — через какой канал ПЛЮСОНа
          (владелец, 26.09.2026). У одного человека может быть сразу несколько:
          и почта, и Telegram — показываем все. */}
      {(() => {
        const mine = new Set((d.accounts || []).map((a: any) => a.platform_slug))
        const rows = ourChannels.filter((c: any) => mine.has(c.platform))
        if (!rows.length) return null
        const RU: Record<string, string> = {
          telegram: 'Telegram', max: 'MAX', vk: 'ВК', email: 'Почта' }
        return (
          <Block title="Переписка с ним через ПЛЮСОН">
            {rows.map((c: any) => (
              <Line key={c.platform} label={RU[c.platform] || c.platform}
                    value={c.outgoing_only ? `${c.label} (только отправка)` : c.label}
                    href={c.url} />
            ))}
          </Block>
        )
      })()}

      {/* ⚠️ КОНТАКТЫ ПЕРВЫМИ — ради них карточку и открывают. */}
      <Block title="Связь">
        <Line label="Телефон" value={phone}
              href={phone ? `tel:${phone}` : null} />
        <Line label="Почта" value={d.email}
              href={d.email ? `mailto:${d.email}` : null} />
        <Line label="Telegram" value={tgNick ? `@${tgNick}` : null}
              href={tgNick ? `https://t.me/${tgNick}` : null} />
        <Line label="Рабочий TG" value={workTg ? `@${workTg}` : null}
              href={workTg ? `https://t.me/${workTg}` : null} />
        <Line label="ВКонтакте" value={d.work_vk} href={d.work_vk} />
        <Line label="MAX" value={d.work_max} href={d.work_max} />
        {/* Аккаунты, которыми человек заходил в бот: иногда ника в профиле
            нет, а тут он есть. */}
        {(d.accounts || [])
          .filter((a: any) => a.platform_slug !== 'email')
          .map((a: any) => (
            <Line key={a.platform_slug} label={`В боте (${a.platform_slug})`}
                  value={a.username ? `@${a.username}` : a.platform_user_id} />
          ))}
      </Block>

      {(socLinks.length > 0 || socChannels.length > 0) && (
        <Block title="Соцсети и каналы">
          {socLinks.map(([k, v]) => (
            <Line key={k} label={k} value={v} href={v} />
          ))}
          {socChannels.map((c, i) => (
            <Line key={`ch${i}`} label="канал" value={c.name} href={c.url} />
          ))}
        </Block>
      )}

      <Block title="Тариф и деньги">
        <Line label="Тариф" value={d.tariff_name} />
        <Line label="Действует до" value={d.expires_at ? dt(d.expires_at) : null} />
        <Line label="Оплат" value={String(d.payments_count ?? 0)} />
        <Line label="Всего заплатил" value={rub(d.total_paid_kopecks)} />
        <Line label="Последняя оплата" value={d.last_paid_at ? dt(d.last_paid_at) : null} />
      </Block>

      <Block title="Что настроено">
        <Line label="События" value={String(d.events_count ?? 0)} />
        <Line label="Ботов" value={String(d.own_channels_count ?? 0)} />
        <Line label="Подписчиков"
              value={(d.subscribers_count ?? 0).toLocaleString('ru-RU')} />
        <Line label="Вебинаров" value={String(d.webinars_count ?? 0)} />
        <Line label="Контактов в базе"
              value={(d.contacts_count ?? 0).toLocaleString('ru-RU')} />
      </Block>

      {addons.length > 0 && (
        <Block title="Подключённые модули">
          {addons.map((a: any, i: number) => (
            <div key={i} className="flex gap-2 py-0.5 text-[12px]">
              <span className={a.is_active ? 'text-gray-800' : 'text-gray-400'}>
                {a.name}
              </span>
              <span className="ml-auto shrink-0 text-gray-400">
                {a.is_active ? `до ${dt(a.expires_at)}` : 'истёк'}
              </span>
            </div>
          ))}
        </Block>
      )}

      <Block title="Происхождение">
        <Line label="В ПЛЮСОНе с" value={d.created_at ? dt(d.created_at) : null} />
        <Line label="Закреплён за вами" value={d.tech_assigned_at ? dt(d.tech_assigned_at) : null} />
        {/* ⚠️ «Привёл» — кто привёл В ПЛЮСОН, по чьей реф-ссылке человек
            пришёл. Это не тот, кто позвал его на событие. */}
        <Line label="Привёл в ПЛЮСОН" value={d.referrer_name || d.referrer_email} />
        <Line label="Часовой пояс" value={d.timezone} />
      </Block>
    </div>
  )
}
