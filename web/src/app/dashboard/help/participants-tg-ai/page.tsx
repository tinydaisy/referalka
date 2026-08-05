'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, Copy, Check, Users, MessageSquare, Bot } from 'lucide-react'
import { api } from '@/lib/api'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

interface EventRow { id: number; slug: string; title: string; status: string }

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

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 pr-24 text-xs overflow-x-auto leading-relaxed whitespace-pre-wrap">{text}</pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="absolute top-2 right-2 px-3 py-1.5 rounded-lg text-white text-xs font-semibold flex items-center gap-1"
        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
      >
        {copied ? <><Check size={13}/> Готово</> : <><Copy size={13}/> Копировать</>}
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

export default function ParticipantsTgAiHelpPage() {
  const [origin, setOrigin] = useState('https://pluson.ru')
  const [events, setEvents] = useState<EventRow[]>([])
  const [eventId, setEventId] = useState<number | ''>('')

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
    api.events.list()
      .then((r: any) => Array.isArray(r) ? r : (r?.events || []))
      .then((evs: EventRow[]) => {
        setEvents(evs)
        if (evs.length) setEventId(evs[0].id)
      })
      .catch(() => {})
  }, [])

  const baseHost = origin.replace(/\/$/, '')
  const eid = eventId || 'ВАШ_EVENT_ID'
  const base = `${baseHost}/api/v1/public/landing-widget/events/${eid}/participants-tg`

  const urlRegistered = `${base}?registered=yes`
  const urlNotRegistered = `${base}?registered=no`
  const urlInChat = `${base}?registered=yes&in_chat=yes`
  const urlNotInChat = `${base}?registered=yes&in_chat=no`
  const urlInChatAlias = `${baseHost}/api/v1/public/landing-widget/events/${eid}/participants-tg-in-chat`

  const aiPrompt =
`Мне нужно автоматически забирать список Telegram-никнеймов участников моего события из платформы iViSiON: ПЛЮСОН и работать с ним (рассылка, аналитика, импорт в таблицу).

Данные отдаёт открытый GET-эндпоинт (без авторизации, CORS открыт, возвращает JSON):
${base}?registered={yes|no|all}&in_chat={all|yes|no}

Параметры:
- registered: yes — только зарегистрированные (по умолчанию), no — только незарегистрированные, all — все
- in_chat: all — без фильтра (по умолчанию), yes — только те, кто состоит в Telegram-чате события, no — кого нет в чате

Формат ответа:
{
  "event_slug": "...",
  "event_id": ${eid},
  "registered": "yes",
  "in_chat": "yes",
  "count": 252,
  "usernames": ["nick1", "nick2"],
  "tg_urls": ["https://telegram.me/nick1"],
  "mentions": ["@nick1"],
  "participants": [{"username": "nick1", "in_chat": true}]
}

Из выдачи уже исключены организаторы, жюри, спикеры, партнёры и служебные аккаунты — это чистый список участников-зрителей с реальным Telegram-аккаунтом.

Напиши мне готовый скрипт/сценарий, который дёргает этот эндпоинт, забирает поле usernames (или participants с флагом in_chat) и [ОПИШИ ЧТО ДАЛЬШЕ: сохраняет в CSV / шлёт в рассылку / кладёт в Google Sheets / импортирует в CRM].`

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Ссылки на участников для нейросети</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>
            Ссылки на участников для нейросети
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Открытые ссылки, которые отдают список Telegram-никнеймов участников
            события «на сторону». Можно отдать готовую ссылку нейросети
            (Claude / ChatGPT) или разработчику — и они сами подключат
            рассылку, выгрузку в таблицу или CRM к вашей базе.
          </p>
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-5 text-sm text-amber-900 leading-relaxed">
        <b>Чем это отличается от «Выгрузки участников».</b> Та выгрузка отдаёт
        полные данные (email, телефон, имя) и требует токен. Эти ссылки —{' '}
        <b>открытые</b> (без токена, никаких персональных данных, только
        публичные Telegram-никнеймы). Их безопасно вставить в чужой скрипт,
        в Make/n8n или отдать нейросети в промпте — авторизация не нужна.
      </div>

      <Step n={1} title="Выберите событие">
        <p>
          Выберите событие — мы подставим его номер в готовые ссылки ниже.
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
        <p className="text-xs text-gray-500">
          Вместо номера в ссылке можно использовать и slug события (код из
          адреса лендинга) — оба варианта работают.
        </p>
      </Step>

      <Step n={2} title="Готовые ссылки">
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: BRAND }}>
          <Users size={16} /> Зарегистрированные участники
        </div>
        <CopyBox text={urlRegistered} />

        <div className="flex items-center gap-2 text-sm font-semibold pt-2" style={{ color: BRAND }}>
          <Users size={16} /> Незарегистрированные (тёплая аудитория для догрева)
        </div>
        <CopyBox text={urlNotRegistered} />

        <div className="flex items-center gap-2 text-sm font-semibold pt-2" style={{ color: BRAND }}>
          <MessageSquare size={16} /> Зарегистрированные, кто <b>в чате</b> события
        </div>
        <CopyBox text={urlInChat} />
        <p className="text-xs text-gray-500">Короткая ссылка-алиас для этого же случая:</p>
        <CopyBox text={urlInChatAlias} />

        <div className="flex items-center gap-2 text-sm font-semibold pt-2" style={{ color: BRAND }}>
          <MessageSquare size={16} /> Зарегистрированные, кого <b>нет в чате</b>
        </div>
        <CopyBox text={urlNotInChat} />
      </Step>

      <Step n={3} title="Какие параметры можно менять">
        <p>В конце ссылки два параметра:</p>
        <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
          <li>
            <code className="bg-gray-100 px-1 rounded">registered</code> ={' '}
            <code className="bg-gray-100 px-1 rounded">yes</code> (только
            зарегистрированные, по умолчанию) /{' '}
            <code className="bg-gray-100 px-1 rounded">no</code> (только
            незарегистрированные) /{' '}
            <code className="bg-gray-100 px-1 rounded">all</code> (все)
          </li>
          <li>
            <code className="bg-gray-100 px-1 rounded">in_chat</code> ={' '}
            <code className="bg-gray-100 px-1 rounded">all</code> (без фильтра,
            по умолчанию) /{' '}
            <code className="bg-gray-100 px-1 rounded">yes</code> (только кто в
            Telegram-чате события) /{' '}
            <code className="bg-gray-100 px-1 rounded">no</code> (кого нет в чате)
          </li>
        </ul>
        <p className="text-xs text-gray-500">
          Параметры комбинируются: например{' '}
          <code className="bg-gray-100 px-1 rounded">?registered=all&amp;in_chat=yes</code>{' '}
          — все, кто в чате (и зарегистрированные, и нет).
        </p>
      </Step>

      <Step n={4} title="Что вернётся (формат ответа)">
        <p>Ссылка отдаёт JSON. Главное — поля <code className="bg-gray-100 px-1 rounded">usernames</code> и <code className="bg-gray-100 px-1 rounded">participants</code>:</p>
        <pre className="bg-gray-900 text-gray-100 rounded-lg p-3 text-xs overflow-x-auto leading-relaxed">{`{
  "event_slug": "...",
  "event_id": ${eid},
  "registered": "yes",
  "in_chat": "yes",
  "count": 252,
  "usernames": ["nick1", "nick2"],
  "tg_urls": ["https://telegram.me/nick1", "https://telegram.me/nick2"],
  "mentions": ["@nick1", "@nick2"],
  "participants": [
    { "username": "nick1", "in_chat": true },
    { "username": "nick2", "in_chat": false }
  ]
}`}</pre>
        <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
          <li><b>count</b> — сколько ников в списке.</li>
          <li><b>usernames</b> — массив ников без «@».</li>
          <li><b>tg_urls</b> — готовые ссылки <code className="bg-gray-100 px-1 rounded">https://telegram.me/ник</code>.</li>
          <li><b>mentions</b> — те же ники с «@».</li>
          <li><b>participants[].in_chat</b> — флаг по каждому: в чате он или нет (удобно при <code className="bg-gray-100 px-1 rounded">in_chat=all</code>).</li>
        </ul>
        <p className="text-xs text-gray-500">
          Персональных данных (email, телефон, имя) здесь нет — только публичные
          Telegram-ники. Если нужны полные данные — смотрите статью{' '}
          <Link href="/dashboard/help/participants-export" className="text-blue-600 hover:underline">
            «Выгрузка участников события»
          </Link>{' '}
          (там запрос с токеном).
        </p>
      </Step>

      <Step n={5} title="Готовый промпт для нейросети">
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: BRAND }}>
          <Bot size={16} /> Скопируйте и отдайте Claude / ChatGPT
        </div>
        <p>
          Нейросеть по этому промпту сама напишет скрипт или сценарий, который
          забирает вашу базу и делает с ней что нужно. Замените в конце
          текст в квадратных скобках на свою задачу.
        </p>
        <CopyBlock text={aiPrompt} />
      </Step>

      <div className="bg-white rounded-2xl border border-gray-100 p-5 text-sm text-gray-700 leading-relaxed">
        <div className="font-bold mb-2" style={{ color: BRAND }}>Кого мы исключаем из списков</div>
        <p>
          Из выдачи убираются все члены команды события — организаторы, жюри,
          спикеры, хедлайнеры, партнёры — и ваш рабочий/личный аккаунт. В списке
          остаются только участники-зрители с реальным Telegram-аккаунтом
          (служебные «пустышки» без числового ID тоже отсеиваются).
        </p>
      </div>

      <div className="mt-8 p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Нужна помощь с подключением?</div>
        <p className="text-sm text-gray-600">
          Напишите в поддержку —{' '}
          <Link href={SUPPORT_URL}
             className="text-blue-600 hover:underline">
            {SUPPORT_LABEL}
          </Link>
        </p>
      </div>
    </div>
  )
}
