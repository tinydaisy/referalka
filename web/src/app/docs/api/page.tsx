'use client'
import { useEffect, useState } from 'react'
import { BookOpen, Copy, Check, ExternalLink, AlertTriangle } from 'lucide-react'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function ApiDocsPage() {
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
              API ПЛЮСОНа для интеграции с конструкторами чат-ботов
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Salebot, BotHelp, SendPulse, Make, n8n, любой webhook — здесь все эндпоинты:
              регистрация участника в БД, программа конференции, спикеры с регалиями, каналы,
              проверка подписки, билет розыгрыша. Страница публичная — можно прислать любому
              разработчику или сценаристу бота, авторизация в кабинете не нужна.
            </p>
          </div>
        </div>

        {/* Красное предупреждение про подстановки */}
        <div className="mb-6 rounded-xl border-2 border-red-300 bg-red-50 p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={20} className="text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-bold text-red-700 mb-1.5">
                Везде ниже подставьте СВОИ значения
              </div>
              <ul className="text-sm text-red-800 space-y-1 list-disc pl-4">
                <li>
                  <code className="bg-red-100 px-1 rounded">{'<ВАШ_CLIENT_ID>'}</code>
                  {' '}— ваш ID клиента в кабинете ПЛЮСОН (НЕ&nbsp;1, НЕ&nbsp;7).
                  Где взять — указано в следующей секции.
                </li>
                <li>
                  <code className="bg-red-100 px-1 rounded">{'<ВАШ_EVENT_ID>'}</code>
                  {' '}— ID конкретного события или конференции из ссылки в кабинете.
                </li>
                <li>
                  <code className="bg-red-100 px-1 rounded">{'<ВАШ_ТОКЕН>'}</code>
                  {' '}— секретный <code>SALEBOT_SECRET</code>, выдаёт владелец кабинета.
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Базовый URL */}
        <Section step="●" title="Базовый URL и где взять свои ID">
          <p className="text-sm text-gray-700 mb-3">
            Все запросы идут на этот адрес (его подставляйте перед путями ниже):
          </p>
          <CopyBlock value={apiBase} />
          <p className="text-xs text-gray-400 mt-2">
            DEV-окружение для тестов: <code>https://dev.pluson.ru/api/v1</code>
          </p>

          <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
            <strong className="text-gray-900">Где взять свой <code>client_id</code> и <code>event_id</code>:</strong>
            <ul className="mt-2 space-y-1 list-disc pl-5">
              <li>
                <strong>client_id</strong> — откройте в кабинете <em>Настройки → Профиль</em>,
                ID клиента указан рядом с email. Его же видно в URL Mini App вашего бота:
                <code className="ml-1">/c/<strong className="text-red-600">{'<client_id>'}</strong>/tg/</code>
              </li>
              <li>
                <strong>event_id</strong> — откройте событие/конференцию в кабинете,
                число в URL после <code>/events/</code> или <code>/conferences/</code> —
                это и есть <code>event_id</code>.
              </li>
            </ul>
          </div>
        </Section>

        {/* Авторизация */}
        <Section step="🔑" title="Авторизация запросов">
          <p className="text-sm text-gray-700 mb-3">
            Большинство эндпоинтов «для бота» требуют секретный токен. Передавать можно одним из двух способов:
          </p>
          <ul className="text-sm text-gray-700 space-y-2 list-disc pl-5 mb-3">
            <li>
              Заголовком: <code>X-Salebot-Secret: {'<ВАШ_ТОКЕН>'}</code> (название поля историческое — работает для любого конструктора)
            </li>
            <li>
              Параметром в URL/теле: <code>?secret={'<ВАШ_ТОКЕН>'}</code> или <code>"secret": "{'<ВАШ_ТОКЕН>'}"</code>
            </li>
          </ul>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
            🔒 Токен запросите у владельца кабинета ПЛЮСОН —{' '}
            <a href="https://t.me/margo_forbs" target="_blank" rel="noreferrer" className="underline">@margo_forbs</a>.
          </div>
          <p className="text-sm text-gray-700 mt-3">
            Публичные эндпоинты (программа, спикеры, проверка подписки, билет розыгрыша) — <strong>без токена</strong>.
            В каждом разделе ниже отмечено иконкой 🔑, нужен ли он.
          </p>
        </Section>

        {/* НОВАЯ секция: как настроить в Salebot */}
        <Section step="🤖" title="Как настроить HTTP-запрос в Salebot">
          <p className="text-sm text-gray-700 mb-3">
            Если бот собирается в Salebot — внутри блока «HTTP-запрос» все поля заполняются вот так:
          </p>

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-3 mb-2">Поля блока «HTTP-запрос»</p>
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-200">
                <tr><td className="bg-gray-50 px-3 py-2 font-semibold text-gray-700 w-44">Метод</td>
                    <td className="px-3 py-2"><code>POST</code> или <code>GET</code> — смотрите в каждом разделе ниже</td></tr>
                <tr><td className="bg-gray-50 px-3 py-2 font-semibold text-gray-700">URL</td>
                    <td className="px-3 py-2 break-all"><code>{apiBase}/...</code> (полный путь)</td></tr>
                <tr><td className="bg-gray-50 px-3 py-2 font-semibold text-gray-700">Заголовки</td>
                    <td className="px-3 py-2">
                      JSON-объект, ОДНОЙ строкой:
                      <CodeBlock compact value={`{"X-Salebot-Secret": "<ВАШ_ТОКЕН>", "Content-Type": "application/json"}`} />
                    </td></tr>
                <tr><td className="bg-gray-50 px-3 py-2 font-semibold text-gray-700">Тело запроса</td>
                    <td className="px-3 py-2">JSON, можно использовать переменные Salebot — <code>#client_id#</code>, <code>#client.tg_id#</code>, <code>#email#</code> и&nbsp;т.&nbsp;д.</td></tr>
                <tr><td className="bg-gray-50 px-3 py-2 font-semibold text-gray-700">Сохранить ответ в переменную</td>
                    <td className="px-3 py-2">Включить галку, имя переменной — например <code>pluson</code>. Ответ целиком ляжет в неё.</td></tr>
              </tbody>
            </table>
          </div>

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-5 mb-2">Чтение ответа в Salebot</p>
          <p className="text-sm text-gray-700 mb-3">
            После запроса ПЛЮСОН возвращает JSON. Чтобы достать поле — используйте <strong>точечную нотацию</strong>
            прямо в тексте сообщения или в условии:
          </p>
          <CodeBlock value={`Ответ ПЛЮСОНа:
{
  "ok": 1,
  "pluson_id": "1234",
  "ref_code": "abc123",
  "is_new_user": 1
}

В Salebot, если переменная ответа называется "pluson":
  #pluson.ok#          → 1
  #pluson.pluson_id#   → 1234
  #pluson.ref_code#    → abc123
  #pluson.is_new_user# → 1

Для вложенных объектов — путь через точку:
  #pluson.not_subscribed.0.name#  → "Рамиля Шиманская"`} />

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-5 mb-2">Условие «всё ок» в Salebot</p>
          <p className="text-sm text-gray-700 mb-3">
            ПЛЮСОН в JSON возвращает <strong>числа</strong> <code>0</code> и <code>1</code> (а не <code>true/false</code>) —
            именно потому, что Salebot не умеет нормально сравнивать булевые. В условии пишите так:
          </p>
          <CodeBlock value={`Условие «человек подписан на все каналы»:
   #pluson.status# == 1

Условие «человек новый, впервые регистрируется»:
   #pluson.is_new_user# == 1

Условие «есть незакрытые подписки» (показать список):
   #pluson.status# == 0
   → отправить в чат: #pluson.not_subscribed_text#`} />

          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900 mt-4">
            💡 <strong>Готовое текстовое поле для подписок.</strong> В ответе проверки подписки есть
            <code className="mx-1">not_subscribed_text</code> — уже отформатированный список «Имя: ссылка»
            каждый с новой строки. Не надо собирать его руками — просто вставьте <code>#pluson.not_subscribed_text#</code> в сообщение.
          </div>
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
          <CodeBlock highlight={['<ВАШ_CLIENT_ID>', '<ВАШ_EVENT_ID>']} value={`{
  "client_id": <ВАШ_CLIENT_ID>,    // ← ваш ID из кабинета (НЕ 1!)
  "platform": "telegram",          // telegram | vk | max
  "platform_user_id": "5725111966",// tg_id строкой
  "username": "ivanov",            // без @, опционально
  "first_name": "Иван",
  "last_name": "Иванов",
  "email": "ivan@example.com",     // используется для автомерджа
  "phone": "+79991234567",         // используется для автомерджа
  "salebot_id": "12345",           // client_id в Salebot, опционально
  "event_id": "<ВАШ_EVENT_ID>",    // строкой или числом, опционально
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

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-4 mb-2">Пример cURL (для теста из терминала)</p>
          <CodeBlock highlight={['<ВАШ_CLIENT_ID>', '<ВАШ_EVENT_ID>', '<ВАШ_ТОКЕН>']} value={`curl -X POST '${apiBase}/integrations/salebot/register' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Salebot-Secret: <ВАШ_ТОКЕН>' \\
  -d '{
    "client_id": <ВАШ_CLIENT_ID>,
    "platform_user_id": "5725111966",
    "username": "ivanov",
    "first_name": "Иван",
    "email": "ivan@example.com",
    "event_id": "<ВАШ_EVENT_ID>",
    "is_registered": true
  }'`} />

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-4 mb-2">Пример настройки в Salebot</p>
          <div className="rounded-xl border border-gray-200 overflow-hidden text-sm">
            <table className="w-full">
              <tbody className="divide-y divide-gray-200">
                <tr><td className="bg-gray-50 px-3 py-2 font-semibold w-32">Метод</td><td className="px-3 py-2"><code>POST</code></td></tr>
                <tr><td className="bg-gray-50 px-3 py-2 font-semibold">URL</td><td className="px-3 py-2 break-all"><code>{apiBase}/integrations/salebot/register</code></td></tr>
                <tr><td className="bg-gray-50 px-3 py-2 font-semibold">Заголовки</td><td className="px-3 py-2"><code>{`{"X-Salebot-Secret":"<ВАШ_ТОКЕН>","Content-Type":"application/json"}`}</code></td></tr>
                <tr><td className="bg-gray-50 px-3 py-2 font-semibold">Сохранить в</td><td className="px-3 py-2"><code>pluson</code></td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs uppercase tracking-wide text-gray-400 mt-3 mb-2">Тело (вставить как есть, переменные подставит Salebot)</p>
          <CodeBlock highlight={['<ВАШ_CLIENT_ID>', '<ВАШ_EVENT_ID>']} value={`{
  "client_id": <ВАШ_CLIENT_ID>,
  "platform_user_id": "#client.tg_id#",
  "username": "#client.username#",
  "first_name": "#client.name#",
  "email": "#email#",
  "phone": "#phone#",
  "salebot_id": "#client.id#",
  "event_id": "<ВАШ_EVENT_ID>",
  "is_registered": true
}`} />
          <p className="text-xs text-gray-600 mt-2">
            Дальше в любом сообщении доступны: <code>#pluson.pluson_id#</code>, <code>#pluson.ref_code#</code>,
            <code>#pluson.is_new_user#</code>.
          </p>

          <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900 mt-4">
            💡 Если конструктор не умеет слать заголовки — есть GET-вариант:
            <CodeBlock compact highlight={['<ВАШ_CLIENT_ID>', '<ВАШ_EVENT_ID>', '<ВАШ_ТОКЕН>']} value={`GET ${apiBase}/integrations/salebot/register
  ?client_id=<ВАШ_CLIENT_ID>
  &platform_user_id=5725111966
  &event_id=<ВАШ_EVENT_ID>
  &secret=<ВАШ_ТОКЕН>
  &username=ivanov
  &first_name=Иван
  &is_registered=true`} />
          </div>
        </Section>

        {/* 2 — получить пользователя */}
        <Section step="2" title="Получить данные пользователя">
          <p className="text-sm text-gray-700 mb-3">
            По <code>platform_user_id</code> (tg_id) возвращает поля контакта и (если есть)
            запись участника события — для проверки «зарегистрирован / нет».
          </p>
          <Endpoint method="GET" path="/integrations/salebot/user?client_id=<ВАШ_CLIENT_ID>&platform_user_id=5725111966" auth />

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

          <p className="text-sm text-gray-700 mt-3">
            В Salebot после сохранения в переменную <code>user</code>:
            <br/><code>#user.is_registered#</code>, <code>#user.ref_code#</code>, <code>#user.first_name#</code>.
          </p>
        </Section>

        {/* 3 — программа конференции */}
        <Section step="3" title="Программа конференции">
          <p className="text-sm text-gray-700 mb-3">
            Программа = список <strong>дней</strong> + список <strong>сессий по каждому дню</strong>.
            Время хранится строкой <code>"HH:MM"</code> и означает МСК (Europe/Moscow).
            Везде, где показываете — приписывайте «&nbsp;МСК».
          </p>

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-3 mb-2">Дни конференции</p>
          <Endpoint method="GET" path="/events/<ВАШ_EVENT_ID>/conference/days/public" />
          <CodeBlock value={`{
  "days": [
    { "day_number": 1, "day_date": "2026-05-15", "open_time": "10:00", "close_time": "18:00" },
    { "day_number": 2, "day_date": "2026-05-16", "open_time": "10:00", "close_time": "17:00" }
  ]
}`} />

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-4 mb-2">Сессии конкретного дня</p>
          <Endpoint method="GET" path="/events/<ВАШ_EVENT_ID>/conference/sessions/day/<НОМЕР_ДНЯ>" />
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
          <Endpoint method="GET" path="/events/<ВАШ_EVENT_ID>/conference/speakers/public" />
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
          <Endpoint method="GET" path="/events/<ВАШ_EVENT_ID>/conference/speakers/<SPEAKER_EVENT_ID>/public" />
          <p className="text-sm text-gray-700 mb-2">
            <code>SPEAKER_EVENT_ID</code> = поле <code>id</code> из ответа списка выше (не <code>speaker_id</code>!).
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
          <CodeBlock highlight={['<ВАШ_EVENT_ID>']} value={`GET /events/<ВАШ_EVENT_ID>/conference/speakers/public
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
            Удобно использовать перед выдачей подарка.
          </p>

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-3 mb-2">Вариант 1 — GET (всё в URL)</p>
          <Endpoint method="GET" path="/public/conference/<ВАШ_EVENT_ID>/check-subscription?tg_id=5725111966" />

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-4 mb-2">Вариант 2 — POST</p>
          <Endpoint method="POST" path="/public/conference/<ВАШ_EVENT_ID>/check-subscription" />
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

          <p className="text-xs uppercase tracking-wide text-gray-400 mt-4 mb-2">Использование в Salebot</p>
          <CodeBlock value={`Сохранить ответ в переменную "subs"

Условие «всё ок»:        #subs.status# == 1
Условие «есть пробелы»:  #subs.status# == 0
   → отправить в чат:    Подпишитесь:\\n#subs.not_subscribed_text#`} />

          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900 mt-3">
            ⚠️ Чтобы проверка работала — бот ПЛЮСОНа (или бот клиента) должен быть <strong>добавлен админом</strong>
            в канал спикера. Иначе Telegram отвечает «chat not found» и человек считается неподписанным.
          </div>
        </Section>

        {/* 7 — билет розыгрыша */}
        <Section step="7" title="Бонус: добавить билет розыгрыша">
          <p className="text-sm text-gray-700 mb-3">
            Когда в боте участник вводит кодовое слово — этот эндпоинт регистрирует билет.
            Без авторизации, идемпотентно по <code>(event_id, ticket_number)</code>.
          </p>
          <Endpoint method="POST" path="/events/<ВАШ_EVENT_ID>/conference/raffle-tickets/public" />
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
              <CodeBlock compact value={`GET ${apiBase}/public/events/{slug}/landing`} />
              где <code>slug</code> — короткий код события (напр. <code>x7q9k</code>).
            </li>
            <li>
              <strong>Список событий клиента</strong> (для каталога):
              <CodeBlock compact highlight={['<ВАШ_CLIENT_ID>']} value={`GET ${apiBase}/public/clients/<ВАШ_CLIENT_ID>/events`} />
            </li>
            <li>
              <strong>Профиль клиента-организатора</strong> (фото, регалии, соцсети):
              <CodeBlock compact highlight={['<ВАШ_CLIENT_ID>']} value={`GET ${apiBase}/public/clients/<ВАШ_CLIENT_ID>/profile`} />
            </li>
            <li>
              <strong>События участника по tg_id</strong> (что показать в боте):
              <CodeBlock compact value={`GET ${apiBase}/participants/miniapp/me/events?tg_id=5725111966`} />
            </li>
          </ul>
        </Section>

        {/* Контакт */}
        <div className="mt-8 p-4 bg-white rounded-xl border border-gray-200">
          <div className="text-sm font-semibold text-gray-800 mb-1">Вопросы по интеграции</div>
          <p className="text-sm text-gray-600">
            Напишите —{' '}
            <a href="https://t.me/margo_forbs?text=Вопрос_по_API_ПЛЮСОН"
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
  // Подсветим плейсхолдеры в URL красным
  const parts = path.split(/(<[A-ZА-Я_]+>)/g)
  return (
    <div className="flex items-center gap-2 mb-2 flex-wrap">
      <span className={`text-xs font-bold px-2 py-1 rounded ${colors[method] || 'bg-gray-100'}`}>{method}</span>
      <code className="text-sm bg-gray-50 border border-gray-200 rounded px-2 py-1 break-all">
        {parts.map((p, i) =>
          /^<[A-ZА-Я_]+>$/.test(p)
            ? <span key={i} className="text-red-600 font-bold">{p}</span>
            : <span key={i}>{p}</span>
        )}
      </code>
      {auth && (
        <span className="text-[10px] uppercase tracking-wide bg-gray-800 text-white px-2 py-0.5 rounded">
          🔑 secret
        </span>
      )}
    </div>
  )
}

function CodeBlock({ value, compact = false, highlight = [] }: { value: string; compact?: boolean; highlight?: string[] }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  // Подсветить плейсхолдеры (<ВАШ_CLIENT_ID> и т.п.) красным
  function renderHighlighted() {
    if (highlight.length === 0) return value
    const escaped = highlight.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const re = new RegExp(`(${escaped.join('|')})`, 'g')
    const parts = value.split(re)
    return parts.map((p, i) =>
      highlight.includes(p)
        ? <span key={i} className="text-red-400 font-bold bg-red-900/30 px-1 rounded">{p}</span>
        : <span key={i}>{p}</span>
    )
  }
  return (
    <div className="relative group">
      <pre className={`bg-gray-900 text-gray-100 rounded-lg ${compact ? 'p-2 text-xs' : 'p-3 text-xs'} overflow-x-auto font-mono leading-relaxed whitespace-pre`}>
{renderHighlighted()}
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
