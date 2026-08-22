'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ExternalLink, Copy, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function ConnectBotInstructionPage() {
  const [origin, setOrigin] = useState(process.env.NEXT_PUBLIC_APP_URL || 'https://pluson.ru')
  const [clientId, setClientId] = useState<number | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
    api.auth.me().then((me: any) => setClientId(me?.id ?? null)).catch(() => {})
  }, [])

  // ⚠️ Статья открыта и в публичной базе знаний (/help), где человек не
  // авторизован и номера клиента нет. Пустая строка оставляла поле пустым
  // и надпись «Загружаем…» навсегда — вместо неё показываем понятный образец.
  const miniAppUrl = clientId ? `${origin}/c/${clientId}/tg/` : `${origin}/c/{ВАШ_НОМЕР}/tg/`
  const isDev = origin.includes('dev.')

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Как подключить Mini App к боту</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Подключение Mini App к боту</h1>
          <p className="text-sm text-gray-500 mt-1">
            Пошаговая инструкция как настроить общий @pluson_bot или вашего собственного бота для открытия Mini App.
          </p>
        </div>
      </div>

      {/* Текущая среда */}
      <div className={`rounded-xl border p-4 mb-6 flex items-start gap-3 ${
        isDev ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'
      }`}>
        <div className="text-xl flex-shrink-0">{isDev ? '🧪' : '🚀'}</div>
        <div>
          <div className="text-sm font-semibold text-gray-800">
            {isDev ? 'Вы в DEV-окружении' : 'Вы в PRODUCTION-окружении'}
          </div>
          <p className="text-xs text-gray-600 mt-0.5">
            Все ссылки ниже автоматически подставлены под текущий домен:{' '}
            <code className="bg-white px-1.5 py-0.5 rounded">{origin}</code>
          </p>
        </div>
      </div>

      {/* Главная ссылка для копирования */}
      <Section step="●" title="Ваш персональный URL Mini App">
        <p className="text-sm text-gray-600 mb-3">
          Это <strong>ваш</strong> адрес — у каждого клиента iViSiON: ПЛЮСОН он свой (отличается номером после <code>/c/</code>).
          Используется на шагах 3 и 4 ниже.
        </p>
        <CopyBlock value={miniAppUrl} />
        <p className="text-xs text-gray-400 mt-2">
          ⚠️ Слэш в конце обязателен — без него Telegram не загрузит ассеты.
          {!clientId && ' Ваш номер подставится сюда автоматически, когда вы войдёте в кабинет.'}
        </p>
      </Section>

      <Section step="1" title="Сначала: добавьте токен бота в Каналы">
        <p className="text-sm text-gray-700 mb-3">
          Без этого приветствия и рассылки будут идти от общего <code>@pluson_bot</code>, а не от вашего.
          Если хотите чтобы участники получали сообщения от <strong>вашего бота</strong> — добавьте его токен в раздел Каналы:
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Получите токен у <a href="https://telegram.me/BotFather" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">@BotFather <ExternalLink size={12}/></a> (команда <code>/newbot</code> для нового бота или <code>/mybots</code> → API Token для существующего)</li>
          <li>Откройте раздел <Link href="/dashboard/channels" className="text-blue-600 hover:underline font-medium">«Каналы»</Link> в кабинете</li>
          <li>Добавьте новый канал → платформа <strong>Telegram</strong> → вставьте токен → сохраните</li>
        </ol>
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900">
          💡 На каждой платформе (Telegram / VK / MAX) можно подключить только <strong>один активный канал</strong> на клиента.
          Если у вас уже есть бот и хотите его сменить — деактивируйте старый и добавьте новый.
        </div>
      </Section>

      <Section step="2" title="Открыть @BotFather и выбрать вашего бота">
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5">
          <li>В Telegram найдите и откройте <a href="https://telegram.me/BotFather" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">@BotFather <ExternalLink size={12}/></a></li>
          <li>Команда <code>/mybots</code></li>
          <li>Выберите вашего бота (например <code>@pluson_bot</code>)</li>
        </ol>
      </Section>

      <Section step="3" title="Configure Mini App в Bot Settings">
        <p className="text-sm text-gray-700 mb-3">
          Привязываем iViSiON: ПЛЮСОН как <strong>главный Mini App</strong> бота. Ссылки получаются короткие
          (<code>t.me/ваш_бот?startapp=…</code>), без коротких имён, работают везде одинаково.
        </p>

        <p className="text-sm font-semibold text-gray-800 mb-2">Открыть настройки Mini App:</p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-4">
          <li>В @BotFather: <code>/mybots</code> → выбрать вашего бота</li>
          <li>Нажать <strong>«Bot Settings»</strong></li>
          <li>Нажать <strong>«Configure Mini App»</strong></li>
          <li>Если Mini App ещё не включён — нажать <strong>«Enable Mini App»</strong></li>
        </ol>

        <p className="text-sm font-semibold text-gray-800 mb-2">Вставьте URL приложения:</p>
        <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5 mb-3">
          <li>
            <strong>«Edit Mini App URL»</strong> → вставить ссылку:
            <div className="mt-2"><CopyBlock value={miniAppUrl} /></div>
            <span className="text-xs text-gray-500">Придёт <em>«Success! URL updated»</em>. Это всё что нужно — title/description/photo
              у Main Mini App не настраиваются (их нет в этом меню).</span>
          </li>
        </ol>

        <p className="text-sm text-gray-700">
          Шаг 3 настроил Main Mini App — это нужно для коротких ссылок
          <code className="mx-1">t.me/ваш_бот?startapp=…</code>
          (например реф-ссылки участников). Также понадобится <strong>short-name <code>pluson</code></strong>
          через <code>/newapp</code> — это для другого формата ссылок, см. шаг 4 ниже.
        </p>
      </Section>

      <Section step="4" title={(<><code>/newapp</code> — short-name <code>pluson</code></>) as any}>
        <p className="text-sm text-gray-700 mb-3">
          Регистрируем short-name <code>pluson</code> у бота — это нужно для ссылок вида
          <code className="mx-1">t.me/ваш_бот/pluson?startapp=…</code>
          (используются в «Подключение стороннего лендинга» в карточке события: возврат
          юзера с лендинга GetCourse/Tilda обратно в Mini App). <strong>Без этого шага</strong>
          такие ссылки откроют пустой чат бота, а не Mini App.
        </p>

        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>В @BotFather отправьте команду <code>/newapp</code></li>
          <li>Выберите вашего бота из списка</li>
          <li>
            <strong>Title</strong> — название Mini App (пример: <code>iViSiON: ПЛЮСОН</code>)
          </li>
          <li>
            <strong>Description</strong> — короткое описание (1–2 строки)
          </li>
          <li>
            <strong>Photo (640×360)</strong> — иконка или <code>/empty</code> чтобы пропустить
          </li>
          <li>
            <strong>GIF demo</strong> — <code>/empty</code> (пропустить)
          </li>
          <li>
            <strong>Web App URL</strong> — вставьте ту же ссылку Mini App:
            <div className="mt-2"><CopyBlock value={miniAppUrl} /></div>
          </li>
          <li>
            <strong>Short name</strong> — введите ровно <code>pluson</code> (одна «с», всё строчными)
          </li>
        </ol>

        <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900 mb-3">
          💡 BotFather подтвердит <em>«Done! Web app …»</em> и выдаст готовую ссылку
          <code className="mx-1">https://telegram.me/ваш_бот/pluson</code>. После этого ссылки возврата
          в дашборде (карточка события → «Подключение стороннего лендинга») заработают —
          юзер с success-страницы лендинга вернётся напрямую в Mini App, а не в чат бота.
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
          🧹 Если в <code>/myapps</code> у вас уже есть <strong>другой</strong> Mini App с short-name —
          удалите его, чтобы не было конфликта (<strong>«Delete App»</strong> → подтвердить именем приложения).
        </div>
      </Section>

      <Section step="5" title="Кнопка меню бота: приложение ИЛИ команды — выберите одно">
        <p className="text-sm text-gray-700 mb-4">
          У бота есть <strong>одна</strong> кнопка меню слева от поля ввода. Она может работать в
          двух режимах — выберите тот, что вам нужен. <strong>Два режима одновременно не работают:</strong>{' '}
          если включена кнопка-приложение, списка команд не будет, и наоборот.
        </p>

        {/* Вариант A — кнопка открывает Mini App */}
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 mb-4">
          <div className="text-sm font-bold text-blue-900 mb-2">
            Вариант A · Кнопка «Открыть приложение» (Mini App)
          </div>
          <p className="text-sm text-blue-900 mb-3">
            Внизу чата — большая кнопка, по нажатию сразу открывается Mini App. Подходит, если
            участник заходит только в приложение.
          </p>
          <ol className="text-sm text-blue-900 space-y-1.5 list-decimal pl-5 mb-1">
            <li>В @BotFather: <code>/mybots</code> → выбрать бота → <strong>«Bot Settings»</strong></li>
            <li>Нажать <strong>«Menu Button»</strong> → <strong>«Configure menu button»</strong></li>
            <li><strong>Текст кнопки:</strong> <code>Открыть приложение</code> (или своё)</li>
            <li>
              <strong>URL:</strong> вставьте ссылку Mini App →
              <div className="mt-2"><CopyBlock value={miniAppUrl} /></div>
            </li>
          </ol>
        </div>

        {/* Вариант B — меню команд */}
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="text-sm font-bold text-emerald-900 mb-2">
            Вариант B · Меню команд (<code>/app</code>, <code>/menu…</code>, <code>/support</code>)
          </div>
          <p className="text-sm text-emerald-900 mb-3">
            Кнопка меню раскрывает список команд. Подходит, если хотите дать участнику несколько
            быстрых действий: открыть приложение, перейти к конкретному событию, написать в поддержку.
          </p>

          <p className="text-sm font-semibold text-emerald-900 mb-1">Шаг 1 — выключить кнопку-приложение</p>
          <ol className="text-sm text-emerald-900 space-y-1.5 list-decimal pl-5 mb-3">
            <li>В @BotFather: <code>/mybots</code> → ваш бот → <strong>«Bot Settings»</strong> → <strong>«Menu Button»</strong></li>
            <li>
              Выбрать <strong>«Use default menu button (Commands)»</strong> — это вернёт обычную кнопку,
              которая показывает список команд (а не открывает Mini App).
            </li>
          </ol>

          <p className="text-sm font-semibold text-emerald-900 mb-1">Шаг 2 — задать сами команды</p>
          <ol className="text-sm text-emerald-900 space-y-1.5 list-decimal pl-5 mb-3">
            <li>В @BotFather отправьте команду <code>/setcommands</code></li>
            <li>Выберите вашего бота</li>
            <li>
              Пришлите список команд — каждая строкой в формате <code>команда - описание</code>.
              Пример (как настроено в боте <code>@ivision_conf_bot</code>):
            </li>
          </ol>

          <CopyBlock value={`app - Открыть приложение\nmenu24 - Меню: Чемпионат спикеров Ж.И.В.У.\nsupport - Служба поддержки`} />

          <div className="bg-white border border-emerald-200 rounded-xl p-3 text-sm text-emerald-900 mt-3 space-y-2">
            <div><strong>Что это за команды:</strong></div>
            <ul className="list-disc pl-5 space-y-1">
              <li><code>/app</code> — открывает Mini App (главный экран приложения).</li>
              <li>
                <code>/menu{'{ID события}'}</code> — открывает меню конкретного события
                (кнопки: формат участия, кабинет·подарки, чат, эфир, поддержка).{' '}
                <strong>{'{ID события}'}</strong> — это номер события из адреса его карточки
                в дашборде: <code>…/tournaments/<u>24</u></code> → команда <code>/menu24</code>.
              </li>
              <li><code>/support</code> — единое сообщение со способами связи (служба поддержки).</li>
            </ul>
            <div className="pt-1">
              <strong>Свои примеры под ваши события</strong> (поменяйте номер после <code>menu</code> на ID вашего события):
            </div>
            <CopyBlock value={`app - Открыть приложение\nmenu24 - Меню: Чемпионат спикеров\nmenu41 - Меню: Весенняя конференция\nsupport - Служба поддержки`} />
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900 mt-3">
            💡 ID события смотрите в адресной строке его карточки в дашборде — число после
            <code className="mx-1">/events/</code>, <code className="mx-1">/conferences/</code>
            или <code className="mx-1">/tournaments/</code>. Например <code>…/tournaments/24</code> → <code>/menu24</code>.
          </div>
        </div>
      </Section>

      <Section step="6" title="Прописать домен бота">
        <p className="text-sm text-gray-700 mb-3">
          Это нужно для безопасной работы Mini App и Telegram Login:
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Команда <code>/setdomain</code> → выбрать вашего бота</li>
          <li>Прислать домен (без <code>https://</code> и без <code>/</code> в конце):</li>
        </ol>
        <CopyBlock value={origin.replace(/^https?:\/\//, '').replace(/\/$/, '')} />
      </Section>

      <Section step="●" title="Где взять готовую ссылку для шеринга">
        <p className="text-sm text-gray-700 mb-3">
          Никаких ссылок руками собирать не нужно — iViSiON: ПЛЮСОН делает их сам. Откройте карточку события и скопируйте готовую:
        </p>
        <ul className="text-sm text-gray-700 space-y-2 list-disc pl-5 mb-3">
          <li>
            Для конференции: <Link href="/dashboard/conferences" className="text-blue-600 hover:underline font-medium">Дашборд → Конференции</Link>
            {' '}→ выбрать конференцию → ссылка для участников
          </li>
          <li>
            Для других событий: <Link href="/dashboard/events" className="text-blue-600 hover:underline font-medium">Дашборд → Мероприятия</Link>
            {' '}→ выбрать событие → ссылка в шапке
          </li>
        </ul>
        <p className="text-sm text-gray-700 mb-3">
          Каждый участник в Mini App получает свою <strong>партнёрскую ссылку</strong> — она генерируется автоматически и доступна во вкладке
          «🎯 Игра». Делиться ей участники могут одной кнопкой «Поделиться».
        </p>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
          🔗 <strong>Smart Bridge.</strong> В каждом лендинге события (<code>/l/SLUG</code>) уже подключён скрипт автоматического перехода в Telegram.
          Если открыть лендинг с <code>?app=tg</code> — Telegram запустится сам и Mini App откроется на нужном событии.
          На компьютере откроется обычный лендинг, на телефоне с Telegram — сразу Mini App. Эту фишку можно использовать в постах в соцсетях.
        </div>
      </Section>

      <Section step="?" title="Если что-то не работает">
        <ul className="text-sm text-gray-700 space-y-2 list-disc pl-5">
          <li>
            <strong>«No supported page found»</strong> в Telegram → URL Mini App не указан или забыт <code>/</code> в конце
          </li>
          <li>
            <strong>Белый экран</strong> при открытии → не загружается JS/CSS. Проверьте что{' '}
            <code>{miniAppUrl}assets/</code> отвечает 200 в браузере
          </li>
          <li>
            <strong>«Bot needs to be added»</strong> → в @BotFather бот не зарегистрирован как Mini App-бот, шаг 2 пропущен
          </li>
          <li>
            <strong>Старая версия отображается</strong> → внутри Mini App нажмите <strong>«⋯»</strong> в правом верхнем углу → <strong>«Обновить страницу»</strong>.
            Это перезапрашивает свежие файлы и обходит кеш. Простой свайп вниз и переоткрытие чаще не помогает —
            Telegram держит Mini App-кеш отдельно от обычного «Очистить кеш».
            Если у проблемного аккаунта не помогло — попробуйте этот же бот в другом аккаунте Telegram (там кеша нет, и сразу видно — проблема в кеше или в коде).
          </li>
        </ul>

        <div className="mt-5 p-4 bg-gray-50 rounded-xl border border-gray-200">
          <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
          <p className="text-sm text-gray-600">
            Напишите в поддержку —{' '}
            <Link href={SUPPORT_URL}
               className="text-blue-600 hover:underline inline-flex items-center gap-1">
              {SUPPORT_LABEL} <ExternalLink size={12}/>
            </Link>
          </p>
        </div>
      </Section>
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

function CopyBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const isLoading = !value
  function copy() {
    if (isLoading) return
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <div className="flex gap-2">
      <code className={`flex-1 border rounded-lg px-3 py-2.5 text-sm font-mono overflow-x-auto whitespace-nowrap ${
        isLoading ? 'bg-gray-100 border-gray-200 text-gray-400 italic' : 'bg-gray-50 border-gray-200 text-gray-800'
      }`}>
        {isLoading ? 'Загружаем ваш персональный URL…' : value}
      </code>
      <button
        onClick={copy}
        disabled={isLoading}
        className="px-3 py-2.5 rounded-lg text-white font-medium text-sm flex items-center gap-1.5 flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        {isLoading ? <><Copy size={15}/> Копировать</> : copied ? <><Check size={15}/> Скопировано</> : <><Copy size={15}/> Копировать</>}
      </button>
    </div>
  )
}

