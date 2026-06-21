'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, Copy, Check, Users, UserX, MessageSquare, CreditCard, Database, ListChecks } from 'lucide-react'
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
  const [platform, setPlatform] = useState<'all' | 'tg' | 'vk' | 'max'>('all')

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

  const cid = clientId || 'ВАШ_CLIENT_ID'
  const platSuffix = platform === 'all' ? '' : `&platform=${platform}`
  const evBase = `${baseHost}/api/v1/integrations/events/${eid}/participants`
  const urlAll = `${evBase}?client_id=${cid}${platSuffix}`
  const urlRegistered = `${evBase}/registered?client_id=${cid}${platSuffix}`
  const urlNotRegistered = `${evBase}/not-registered?client_id=${cid}${platSuffix}`
  const urlInChat = `${evBase}/in-chat?client_id=${cid}${platSuffix}`
  const urlPaid = `${evBase}/paid?client_id=${cid}${platSuffix}`
  const urlBase = `${baseHost}/api/v1/integrations/contacts?client_id=${cid}&limit=1000&offset=0${platSuffix}`

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
            Готовые запросы по событию: <b>все участники</b>,{' '}
            <b>зарегистрированные</b>, <b>незарегистрированные</b>,{' '}
            <b>кто в чате</b>, <b>кто оплатил</b> — плюс выгрузка{' '}
            <b>всей базы контактов</b>. В каждой записи указано, на каких
            мессенджерах есть человек (TG / ВК / МАХ), а фильтром можно
            выгрузить <b>только одну платформу</b>. Из списков события
            автоматически исключаются организаторы, жюри, спикеры и партнёры.
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

        <div className="pt-2 border-t border-gray-100 mt-3">
          <div className="text-sm font-semibold mb-2" style={{ color: BRAND }}>
            Платформа в выгрузке
          </div>
          <div className="flex flex-wrap gap-2">
            {([
              ['all', 'Все платформы'],
              ['tg', 'Только Telegram'],
              ['vk', 'Только ВКонтакте'],
              ['max', 'Только MAX'],
            ] as const).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setPlatform(val)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition"
                style={
                  platform === val
                    ? { background: 'linear-gradient(45deg, #25455D, #0a1520)', color: '#fff', borderColor: 'transparent' }
                    : { background: '#fff', color: BRAND, borderColor: '#e5e7eb' }
                }
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            «Все платформы» — выдаст контакты на всех мессенджерах (TG/ВК/МАХ).
            Выбор одной платформы добавит к ссылкам{' '}
            <code className="bg-gray-100 px-1 rounded">&platform={platform === 'all' ? 'tg' : platform}</code>{' '}
            — тогда в выгрузке будут только люди с этим мессенджером, а лишние
            поля (другие платформы) станут <code className="bg-gray-100 px-1 rounded">null</code>.
          </p>
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

      <Step n={4} title="Все участники сразу (зарег. + незарег.)">
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: BRAND }}>
          <ListChecks size={16} /> Один список со всеми, у кого есть запись в событии
        </div>
        <p className="text-xs text-gray-500">
          Можно добавить фильтр <code className="bg-gray-100 px-1 rounded">&registered=true</code>{' '}
          (только зарегистрированные) или{' '}
          <code className="bg-gray-100 px-1 rounded">&registered=false</code>{' '}
          (только незарегистрированные).
        </p>
        <CopyBox text={urlAll} />
      </Step>

      <Step n={5} title="Кто в чате события">
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: BRAND }}>
          <MessageSquare size={16} /> Участники, которые реально состоят в Telegram-чате
        </div>
        <p className="text-xs text-gray-500">
          Список строится по последней проверке чата (кнопка «Проверить чаты» в
          участниках события). Только Telegram — ВК-беседы и МАХ через API не
          проверяются.
        </p>
        <CopyBox text={urlInChat} />
      </Step>

      <Step n={6} title="Кто оплатил тариф">
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: BRAND }}>
          <CreditCard size={16} /> Участники, оплатившие хотя бы один тариф события
        </div>
        <p className="text-xs text-gray-500">
          У каждого в ответе — поле{' '}
          <code className="bg-gray-100 px-1 rounded">paid_tariffs</code> со
          списком оплаченных тарифов (код, название, сумма, дата).
        </p>
        <CopyBox text={urlPaid} />
      </Step>

      <Step n={7} title="Вся база контактов (не только событие)">
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: BRAND }}>
          <Database size={16} /> Все ваши контакты ПЛЮСОН целиком
        </div>
        <p className="text-xs text-gray-500">
          Постранично:{' '}
          <code className="bg-gray-100 px-1 rounded">limit</code> (до 5000) и{' '}
          <code className="bg-gray-100 px-1 rounded">offset</code>. В ответе есть{' '}
          <code className="bg-gray-100 px-1 rounded">total</code> — общее число
          контактов, чтобы пройти базу по страницам.
        </p>
        <CopyBox text={urlBase} />
      </Step>

      <Step n={8} title="Что вернётся (формат ответа)">
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
      "is_in_chat": true,
      "chat_check_at": "2026-06-10 12:00",
      "is_paid": true,
      "paid_tariffs": [
        { "code": "vip", "title": "VIP", "price": 3900,
          "amount": 3900, "paid_at": "2026-06-05 18:20", "source": "getcourse" }
      ],
      "messengers": ["telegram", "max"],
      "telegram": { "id": "12345678", "username": "ivan_p" },
      "vk":  null,
      "max": { "id": "98765432", "username": null },
      "participated_at": "2026-06-01 10:30",
      "contact_created_at": "2026-05-20 14:05",
      "last_contact_at": "2026-06-08 09:12"
    }
  ]
}`}</pre>
        <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
          <li><b>name / email / phone</b> — контактные данные участника.</li>
          <li><b>messengers</b> — массив платформ, где у человека есть аккаунт: любая комбинация <code className="bg-gray-100 px-1 rounded">telegram</code>, <code className="bg-gray-100 px-1 rounded">vk</code>, <code className="bg-gray-100 px-1 rounded">max</code>. Подскажет мейлеру, каким каналом до человека можно достучаться.</li>
          <li><b>telegram / vk / max</b> — сами аккаунты: id и username (или null, если на этой платформе человека нет).</li>
          <li><b>is_in_chat</b> — состоит ли в Telegram-чате события (по последней проверке).</li>
          <li><b>is_paid / paid_tariffs</b> — оплачен ли тариф и какие именно (код, название, сумма, дата).</li>
          <li><b>ref_code</b> — личный реферальный код. <b>referrer_ref_code</b> — код того, кто привёл (или null).</li>
          <li><b>participated_at</b> — когда участник появился в событии.</li>
        </ul>
        <p className="text-xs text-gray-500 mt-2">
          В выгрузке «вся база контактов» полей события (is_registered,
          is_in_chat, paid_tariffs) нет — там общие поля контакта + messengers.
        </p>
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
