'use client'
import { useEffect, useState } from 'react'
import { BookOpen, Copy, Check, ExternalLink } from 'lucide-react'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function SalebotApiDocsPage() {
  const [origin, setOrigin] = useState(process.env.NEXT_PUBLIC_APP_URL || 'https://pluson.ru')
  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
  }, [])

  const apiBase = `${origin}/api/v1`

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Шапка */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/images/logo_no_ivision_blue.png" alt="ПЛЮСОН" className="h-7 w-auto" />
            <span className="text-base font-bold" style={{ color: BRAND }}>ПЛЮСОН</span>
          </div>
          <a
            href="https://pluson.ru"
            className="text-xs text-gray-400 hover:text-gray-700"
          >pluson.ru</a>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 pb-24">
        {/* Заголовок */}
        <div className="flex items-start gap-3 mb-6">
          <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <BookOpen size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold" style={{ color: BRAND }}>
              API ПЛЮСОНа для интеграции с Salebot
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Все эндпоинты для регистрации участника, программы конференции, спикеров,
              каналов и проверки подписок. Эта страница публичная — её можно прислать любому
              разработчику или сценаристу Salebot, без логина.
            </p>
          </div>
        </div>

        {/* Базовый URL */}
        <Section step="●" title="Базовый URL">
          <p className="text-sm text-gray-700 mb-3">
            Все запросы идут на этот адрес (его и подставляйте перед путями ниже):
          </p>
          <CopyBlock value={apiBase} />
          <p className="text-xs text-gray-400 mt-2">
            DEV-окружение для тестов: <code>https://dev.pluson.ru/api/v1</code>
          </p>
        </Section>

        {/* Авторизация */}
        <Section step="🔑" title="Авторизация запросов от Salebot">
          <p className="text-sm text-gray-700 mb-3">
            Большинство Salebot-эндпоинтов требуют секретный токен. Передавать можно одним из двух способов:
          </p>
          <ul className="text-sm text-gray-700 space-y-2 list-disc pl-5 mb-3">
            <li>
              Заголовком: <code>X-Salebot-Secret: ВАШ_ТОКЕН</code>
            </li>
            <li>
              Параметром в URL/теле: <code>?secret=ВАШ_ТОКЕН</code> или <code>"secret": "ВАШ_ТОКЕН"</code>
            </li>
          </ul>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
            🔒 Токен выдаёт владелец кабинета ПЛЮСОН (поле <code>SALEBOT_SECRET</code> в окружении бэкенда).
            Запросить можно у <a href="https://t.me/margo_forbs" target="_blank" rel="noreferrer"
              className="underline">@margo_forbs</a>.
          </div>
          <p className="text-sm text-gray-700 mt-3">
            Публичные эндпоинты (программа, спикеры, проверка подписки, билет розыгрыша) — <strong>без токена</strong>.
            В каждом разделе ниже указано, нужен ли он.
          </p>
        </Section>

        {/* 1 — добавить пользователя */}
        <Section step="1" title="Добавить или обновить пользователя в БД">
          <p className="text-sm text-gray-700 mb-3">
            Создаёт контакт у клиента (или находит существующий по email/телефону — автомердж),
            привязывает Telegram-идентичность и, если передан <code>event_id</code>,
            добавляет участие в событии. Возвращает <code>pluson_id</code>, <code>participant_id</code> и реф-код.
          </p>
          <Endpoint method="POST" path="/integrations/salebot/register" auth />

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-4 mb-2">Тело запроса (JSON)</p>
          <CodeBlock value={`{
  "client_id": 1,                  // ID клиента в ПЛЮСОН (зашит в Salebot)
  "platform": "telegram",          // telegram | vk | max
  "platform_user_id": "5725111966",// tg_id строкой
  "username": "ivanov",            // без @, опционально
  "first_name": "Иван",
  "last_name": "Иванов",
  "email": "ivan@example.com",     // используется для автомерджа
  "phone": "+79991234567",         // используется для автомерджа
  "salebot_id": "12345",           // client_id в Salebot, опционально
  "event_id": "7",                 // строкой или числом, опционально
  "is_registered": true,           // отметить регистрацию на событие
  "is_in_chat": false,             // отметить вступление в чат
  "partner_tg_id": "392695076"     // tg_id рефовода, опционально
}`} />

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-4 mb-2">Ответ</p>
          <CodeBlock value={`{
  "ok": 1,
  "pluson_id": "1234",          // platform_users.id
  "participant_id": "567",      // event_participants.id (0 если event_id не передан)
  "ref_code": "abc123",         // реф-код контакта
  "is_new_user": 1,
  "is_new_participant": 1
}`} />

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-4 mb-2">Пример cURL</p>
          <CodeBlock value={`curl -X POST '${apiBase}/integrations/salebot/register' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Salebot-Secret: ВАШ_ТОКЕН' \\
  -d '{
    "client_id": 1,
    "platform_user_id": "5725111966",
    "username": "ivanov",
    "first_name": "Иван",
    "email": "ivan@example.com",
    "event_id": "7",
    "is_registered": true
  }'`} />

          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900 mt-4">
            💡 Если Salebot не умеет слать заголовки — есть GET-вариант:
            <CodeBlock value={`GET ${apiBase}/integrations/salebot/register
  ?client_id=1
  &platform_user_id=5725111966
  &event_id=7
  &secret=ВАШ_ТОКЕН
  &username=ivanov
  &first_name=Иван
  &is_registered=true`} compact />
          </div>
        </Section>

        {/* 2 — получить пользователя */}
        <Section step="2" title="Получить данные пользователя">
          <p className="text-sm text-gray-700 mb-3">
            По <code>platform_user_id</code> (tg_id) возвращает поля контакта и (если есть)
            запись участника события — для проверки «зарегистрирован / нет».
          </p>
          <Endpoint method="GET" path="/integrations/salebot/user?client_id=1&platform_user_id=5725111966" auth />

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-3 mb-2">Ответ</p>
          <CodeBlock value={`{
  "pluson_id": 1234,
  "username": "ivanov",
  "first_name": "Иван",
  "last_name": "Иванов",
  "salebot_id": "12345",
  "ref_code": "abc123",
  "participant_id": 567,
  "event_id": 7,
  "is_registered": true,
  "is_in_chat": false,
  "created_at": "2026-04-29T12:00:00Z"
}`} />
        </Section>

        {/* 3 — программа конференции */}
        <Section step="3" title="Программа конференции">
          <p className="text-sm text-gray-700 mb-3">
            Программа = список <strong>дней</strong> + список <strong>сессий по каждому дню</strong>.
            Время хранится строкой <code>"HH:MM"</code> и означает МСК (Europe/Moscow).
            Везде, где показываете — приписывайте «&nbsp;МСК».
          </p>

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-3 mb-2">Дни конференции</p>
          <Endpoint method="GET" path="/events/{event_id}/conference/days/public" />
          <CodeBlock value={`{
  "days": [
    { "day_number": 1, "day_date": "2026-05-15", "open_time": "10:00", "close_time": "18:00" },
    { "day_number": 2, "day_date": "2026-05-16", "open_time": "10:00", "close_time": "17:00" }
  ]
}`} />

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-4 mb-2">Сессии конкретного дня</p>
          <Endpoint method="GET" path="/events/{event_id}/conference/sessions/day/{day}" />
          <CodeBlock value={`{
  "day": 1,
  "sessions": [
    {
      "id": 42,
      "day": 1,
      "start_time": "11:00",         // "HH:MM" МСК
      "end_time":   "11:30",
      "title": "Тема выступления",
      "gift_description": "Чек-лист",
      "stream_url": "https://...",
      "track_label": null,
      "track_color": null,
      "speaker_event_id": 99,        // = id из conf_speaker_events
      "speaker_name": "Рамиля Шиманская",
      "speaker_title": "Эксперт по PR",
      "photo_url": "https://...",
      "speaker_role": "speaker",
      "gift_after_speech_title": "...",
      "gift_after_speech_url": "..."
    }
  ]
}`} />
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900 mt-3">
            ⚠️ <strong>Время — строка, не ISO.</strong> Никаких <code>toLocaleTimeString</code> и часовых поясов.
            Берите как есть и выводите <code>"11:00 МСК"</code>.
          </div>
        </Section>

        {/* 4 — список спикеров */}
        <Section step="4" title="Спикер: регалии, фото, темы">
          <p className="text-sm text-gray-700 mb-3">
            Два публичных эндпоинта — список и полный профиль одного спикера.
          </p>

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-3 mb-2">Список спикеров события</p>
          <Endpoint method="GET" path="/events/{event_id}/conference/speakers/public" />
          <CodeBlock value={`{
  "speakers": [
    {
      "id": 99,                      // conf_speaker_events.id (нужен дальше)
      "speaker_id": 12,              // collaborators.id
      "name": "Рамиля Шиманская",
      "title": "Эксперт по PR",
      "achievements": "10 лет в индустрии...",
      "photo_url": "https://referalka.r2.../speakers/12.jpg",
      "tg_channel_url": "https://t.me/ramilya",
      "instagram_url": "https://instagram.com/...",
      "personal_tg_username": "ramilya_shim",
      "role": "speaker",
      "speaker_topic": "Как продвигать личный бренд",
      "topics": [
        { "id": 1, "topic": "Тема 1" },
        { "id": 2, "topic": "Тема 2" }
      ],
      "gift_after_speech_title": "Чек-лист",
      "gift_after_speech_url": "https://...",
      "gift_raffle_title": "...",
      "gift_raffle_url": "...",
      "sort_order": 1
    }
  ]
}`} />

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-4 mb-2">Полный профиль одного спикера</p>
          <Endpoint method="GET" path="/events/{event_id}/conference/speakers/{speaker_event_id}/public" />
          <p className="text-sm text-gray-700 mb-2">
            <code>speaker_event_id</code> = поле <code>id</code> из ответа выше (не <code>speaker_id</code>!).
            Возвращает то же самое плюс <code>tg_channel_id</code>, <code>poster_url</code>,
            <code>video_folder_url</code>, <code>website_url</code>.
          </p>
        </Section>

        {/* 5 — список каналов */}
        <Section step="5" title="Список каналов спикеров события">
          <p className="text-sm text-gray-700 mb-3">
            Отдельного эндпоинта «только каналы» нет — берите его из ответа списка спикеров (шаг&nbsp;4).
            Каналы лежат в полях <code>tg_channel_url</code> (ссылка) и <code>tg_channel_id</code> (числовой ID канала, нужен боту для <code>getChatMember</code>).
          </p>
          <p className="text-xs uppercase tracking-wide text-gray-400 mt-3 mb-2">Псевдокод сборки списка каналов</p>
          <CodeBlock value={`GET /events/7/conference/speakers/public
→ возьмите из speakers[] поля: name, tg_channel_url, tg_channel_id
→ отфильтруйте те, у кого tg_channel_id пустой`} />
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900 mt-3">
            💡 В список каналов для подписки попадают <strong>только спикеры, у которых
            бот добавлен в канал</strong> (<code>cse.bot_in_channel = TRUE</code>) и проверка
            не отключена. Эту логику применяет следующий эндпоинт — лучше пользуйтесь им.
          </div>
        </Section>

        {/* 6 — проверка подписки */}
        <Section step="6" title="Проверить подписку участника на каналы спикеров">
          <p className="text-sm text-gray-700 mb-3">
            Бот ПЛЮСОНа сам сходит в каждый канал спикера через Telegram <code>getChatMember</code>
            и вернёт список тех, на которые человек <strong>не подписан</strong>.
            Удобно использовать в Salebot перед выдачей подарка.
          </p>

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-3 mb-2">Вариант 1 — GET (всё в URL)</p>
          <Endpoint method="GET" path="/public/conference/{event_id}/check-subscription?tg_id=5725111966" />

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-4 mb-2">Вариант 2 — POST</p>
          <Endpoint method="POST" path="/public/conference/{event_id}/check-subscription" />
          <CodeBlock value={`{ "tg_id": "5725111966" }`} />

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-4 mb-2">Ответ</p>
          <CodeBlock value={`{
  "status": 0,                   // 1 = подписан на всё, 0 = есть пробелы
  "status_zaglushka": 1,         // всегда 1 — игнорируйте, костыль для Salebot
  "not_subscribed": [
    {
      "speaker_id": 12,
      "name": "Рамиля Шиманская",
      "tg_channel_id": "-1002161199761",
      "tg_channel_url": "https://t.me/ramilya"
    }
  ],
  "not_subscribed_text": "Рамиля Шиманская: https://t.me/ramilya"
}`} />
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900 mt-3">
            ⚠️ Чтобы проверка работала — бот ПЛЮСОНа (или бот клиента) должен быть <strong>добавлен админом</strong>
            в канал спикера. Иначе Telegram отвечает «chat not found» и человек считается неподписанным.
          </div>
        </Section>

        {/* 7 — билет розыгрыша */}
        <Section step="7" title="Бонус: добавить билет розыгрыша">
          <p className="text-sm text-gray-700 mb-3">
            Когда в Salebot участник вводит кодовое слово — этот эндпоинт регистрирует билет.
            Без авторизации, идемпотентно по <code>(event_id, ticket_number)</code>.
          </p>
          <Endpoint method="POST" path="/events/{event_id}/conference/raffle-tickets/public" />
          <CodeBlock value={`{
  "ticket_number": 1057,
  "tg_id": 5725111966,
  "tg_username": "ivanov",
  "tg_name": "Иван Иванов",
  "salebot_client_id": "12345",
  "code_word": "VESNA"
}`} />
        </Section>

        {/* Что ещё пригодится */}
        <Section step="●" title="Что ещё пригодится">
          <ul className="text-sm text-gray-700 space-y-2 list-disc pl-5">
            <li>
              <strong>Лендинг события</strong> (для отправки в чат участнику):
              <CodeBlock value={`GET ${apiBase}/public/events/{slug}/landing`} compact />
              где <code>slug</code> — короткий код события (напр. <code>x7q9k</code>).
            </li>
            <li>
              <strong>Список событий клиента</strong> (для каталога):
              <CodeBlock value={`GET ${apiBase}/public/clients/{client_id}/events`} compact />
            </li>
            <li>
              <strong>Профиль клиента-организатора</strong> (фото, регалии, соцсети):
              <CodeBlock value={`GET ${apiBase}/public/clients/{client_id}/profile`} compact />
            </li>
            <li>
              <strong>События участника по tg_id</strong> (что показать в боте):
              <CodeBlock value={`GET ${apiBase}/participants/miniapp/me/events?tg_id=5725111966`} compact />
            </li>
          </ul>
        </Section>

        {/* Контакт */}
        <div className="mt-8 p-4 bg-white rounded-xl border border-gray-200">
          <div className="text-sm font-semibold text-gray-800 mb-1">Вопросы по интеграции</div>
          <p className="text-sm text-gray-600">
            Напишите —{' '}
            <a href="https://t.me/margo_forbs?text=Вопрос_по_API_Salebot"
               target="_blank" rel="noopener noreferrer"
               className="text-blue-600 hover:underline inline-flex items-center gap-1">
              открыть чат в Telegram <ExternalLink size={12}/>
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}

function Section({ step, title, children }: { step: string; title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-100 p-5 mb-4 shadow-sm">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
             style={{ background: PEACH, color: BRAND }}>
          {step}
        </div>
        <h2 className="text-base font-bold" style={{ color: BRAND }}>{title}</h2>
      </div>
      <div className="pl-11">{children}</div>
    </section>
  )
}

function Endpoint({ method, path, auth }: { method: string; path: string; auth?: boolean }) {
  const colors: Record<string, string> = {
    GET: 'bg-blue-100 text-blue-800',
    POST: 'bg-green-100 text-green-800',
    PATCH: 'bg-amber-100 text-amber-800',
    DELETE: 'bg-red-100 text-red-800',
  }
  return (
    <div className="flex items-center gap-2 mb-2 flex-wrap">
      <span className={`text-xs font-bold px-2 py-1 rounded ${colors[method] || 'bg-gray-100'}`}>{method}</span>
      <code className="text-sm bg-gray-50 border border-gray-200 rounded px-2 py-1 break-all">{path}</code>
      {auth && (
        <span className="text-[10px] uppercase tracking-wide bg-gray-800 text-white px-2 py-0.5 rounded">
          🔑 secret
        </span>
      )}
    </div>
  )
}

function CodeBlock({ value, compact = false }: { value: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <div className="relative group">
      <pre className={`bg-gray-900 text-gray-100 rounded-lg ${compact ? 'p-2 text-xs' : 'p-3 text-xs'} overflow-x-auto font-mono leading-relaxed`}>
{value}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-gray-700 hover:bg-gray-600 text-white text-xs px-2 py-1 rounded flex items-center gap-1"
      >
        {copied ? <><Check size={12}/> Скопировано</> : <><Copy size={12}/> Копировать</>}
      </button>
    </div>
  )
}

function CopyBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <div className="flex gap-2">
      <code className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-800 font-mono overflow-x-auto whitespace-nowrap">
        {value}
      </code>
      <button onClick={copy} className="px-3 py-2.5 rounded-lg text-white font-medium text-sm flex items-center gap-1.5 flex-shrink-0"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        {copied ? <><Check size={15}/> Скопировано</> : <><Copy size={15}/> Копировать</>}
      </button>
    </div>
  )
}
