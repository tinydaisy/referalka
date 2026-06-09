'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, Copy, Check, Users, UserX } from 'lucide-react'
import { api } from '@/lib/api'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

interface EventRow { id: number; slug: string; title: string; status: string }
type Me = { id: number; integration_token?: string }

function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex gap-2 items-stretch">
      <code className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono overflow-x-auto whitespace-nowrap text-gray-700">
        {text}
      </code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="px-3 py-2 rounded-lg text-white text-xs font-semibold flex items-center gap-1 flex-shrink-0"
        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
      >
        {copied ? <><Check size={14}/> Скопировано</> : <><Copy size={14}/> Копировать</>}
      </button>
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5 mb-4">
      <div className="flex items-start gap-3 mb-3">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ background: PEACH, color: BRAND }}
        >
          {n}
        </div>
        <h2 className="text-base font-bold pt-1" style={{ color: BRAND }}>{title}</h2>
      </div>
      <div className="text-sm text-gray-700 leading-relaxed space-y-3 pl-11">
        {children}
      </div>
    </div>
  )
}

export default function ParticipantsExportHelpPage() {
  const [origin, setOrigin] = useState('https://pluson.ru')
  const [me, setMe] = useState<Me | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [eventId, setEventId] = useState<number | ''>('')

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
    api.auth.me().then((r: any) => setMe(r as Me)).catch(() => {})
    api.events.list()
      .then((r: any) => Array.isArray(r) ? r : (r?.events || []))
      .then((evs: EventRow[]) => {
        setEvents(evs)
        if (evs.length) setEventId(evs[0].id)
      })
      .catch(() => {})
  }, [])

  const clientId = me?.id ?? 0
  const token = me?.integration_token ?? 'ВАШ_ТОКЕН'
  const baseHost = origin.replace(/\/$/, '')
  const eid = eventId || 'ВАШ_EVENT_ID'

  const urlRegistered =
    `${baseHost}/api/v1/integrations/events/${eid}/participants/registered` +
    `?client_id=${clientId || 'ВАШ_CLIENT_ID'}`
  const urlNotRegistered =
    `${baseHost}/api/v1/integrations/events/${eid}/participants/not-registered` +
    `?client_id=${clientId || 'ВАШ_CLIENT_ID'}`

  const curlRegistered =
    `curl "${urlRegistered}" -H "X-Integration-Token: ${token}"`

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Выгрузка участников</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>
            Выгрузка участников события
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Два готовых запроса: список <b>зарегистрированных</b> и список{' '}
            <b>незарегистрированных</b> участников события. Из обоих списков
            автоматически исключаются организаторы, жюри, спикеры и партнёры —
            вы получаете чистую аудиторию участников-зрителей.
          </p>
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-5 text-sm text-amber-900 leading-relaxed">
        <b>Зачем это нужно.</b> Заберите участников события в свою систему —
        для рассылок через другой сервис, выгрузки в CRM, аналитики, импорта в
        таблицу. Запрос возвращает JSON, который понимает любой конструктор
        (Make, n8n, Zapier, Albato) и любой разработчик.
      </div>

      <Step n={1} title="Выберите событие">
        <p>
          Из списка ниже выберите событие — мы подставим его номер
          (<code className="bg-gray-100 px-1 rounded">event_id</code>) и ваш
          токен в готовые ссылки.
        </p>
        <select
          value={eventId}
          onChange={e => setEventId(e.target.value ? Number(e.target.value) : '')}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        >
          {events.length === 0 && <option value="">У вас пока нет событий</option>}
          {events.map(ev => (
            <option key={ev.id} value={ev.id}>
              #{ev.id} · {ev.title}{ev.status === 'draft' ? ' (черновик)' : ''}
            </option>
          ))}
        </select>
        <div className="text-xs text-gray-500">
          Ваш <code className="bg-gray-100 px-1 rounded">client_id</code> ={' '}
          <b>{clientId || '—'}</b>. Токен берётся из{' '}
          <Link href="/dashboard/settings" className="text-blue-600 hover:underline">
            Настройки → Интеграция
          </Link>{' '}
          (тот же, что для чат-ботов).
        </div>
      </Step>

      <Step n={2} title="Зарегистрированные участники">
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: BRAND }}>
          <Users size={16} /> Список тех, кто зарегистрировался на событие
        </div>
        <p className="text-xs text-gray-500">
          Метод <code className="bg-gray-100 px-1 rounded">GET</code>. Токен
          передаётся заголовком{' '}
          <code className="bg-gray-100 px-1 rounded">X-Integration-Token</code>.
        </p>
        <CopyBox text={urlRegistered} />
        <p className="text-xs text-gray-500 mt-2">Пример полного запроса (curl):</p>
        <CopyBox text={curlRegistered} />
      </Step>

      <Step n={3} title="Незарегистрированные участники">
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: BRAND }}>
          <UserX size={16} /> Список тех, кто открыл событие, но не зарегистрировался
        </div>
        <p className="text-xs text-gray-500">
          Это «тёплая» аудитория — люди интересовались, но до регистрации не
          дошли. Хорошая база для догоняющей рассылки.
        </p>
        <CopyBox text={urlNotRegistered} />
        <p className="text-xs text-gray-500">
          Токен так же передаётся заголовком{' '}
          <code className="bg-gray-100 px-1 rounded">X-Integration-Token: {token}</code>.
        </p>
      </Step>

      <Step n={4} title="Что вернётся (формат ответа)">
        <p>
          Оба запроса возвращают JSON одного формата. Поле{' '}
          <code className="bg-gray-100 px-1 rounded">participants</code> —
          массив участников:
        </p>
        <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 text-xs overflow-x-auto leading-relaxed">{`{
  "event_id": ${eid},
  "is_registered": true,
  "count": 128,
  "participants": [
    {
      "contact_id": 4521,
      "participant_id": 9032,
      "name": "Иван Петров",
      "email": "ivan@mail.ru",
      "phone": "+79001234567",
      "ref_code": "a1b2c",
      "utm_source": "insta",
      "tags": ["клиент"],
      "referrer_ref_code": "x9y8z",
      "is_registered": true,
      "telegram": { "id": "12345678", "username": "ivan_p" },
      "vk":  null,
      "max": null,
      "participated_at": "2026-06-01 10:30",
      "contact_created_at": "2026-05-20 14:05",
      "last_contact_at": "2026-06-08 09:12"
    }
  ]
}`}</pre>
        <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
          <li><b>name / email / phone</b> — контактные данные участника.</li>
          <li><b>ref_code</b> — его личный реферальный код.</li>
          <li><b>referrer_ref_code</b> — реф-код того, кто его привёл (или null).</li>
          <li><b>telegram / vk / max</b> — аккаунты на платформах: id и username (или null, если на этой платформе участника нет).</li>
          <li><b>participated_at</b> — когда участник появился в событии.</li>
        </ul>
      </Step>

      <div className="bg-white rounded-2xl border border-gray-100 p-5 text-sm text-gray-700 leading-relaxed">
        <div className="font-bold mb-2" style={{ color: BRAND }}>Кого мы исключаем из списков</div>
        <p>
          Из обоих списков убираются все, кто добавлен в команду события —
          организаторы, жюри, спикеры, хедлайнеры, генеральные партнёры и
          партнёры. Так в выгрузке остаются только участники-зрители, без членов
          команды. Один и тот же человек может быть участником одного события и
          спикером другого — фильтр работает строго в рамках выбранного события.
        </p>
      </div>

      <div className="mt-8 p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Нужна помощь с подключением?</div>
        <p className="text-sm text-gray-600">
          Напишите разработчику —{' '}
          <a href="https://t.me/margo_forbs?text=Вопрос_по_выгрузке_участников"
             target="_blank" rel="noopener noreferrer"
             className="text-blue-600 hover:underline">
            открыть чат в Telegram
          </a>
        </p>
      </div>
    </div>
  )
}
