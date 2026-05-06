'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ExternalLink, Copy, Check } from 'lucide-react'
import { api } from '@/lib/api'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function ConnectBotInstructionPage() {
  const [origin, setOrigin] = useState(process.env.NEXT_PUBLIC_APP_URL || 'https://pluson.ru')
  const [clientId, setClientId] = useState<number | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
    api.auth.me().then((me: any) => setClientId(me?.id ?? null)).catch(() => {})
  }, [])

  const miniAppUrl = clientId ? `${origin}/c/${clientId}/tg/` : ''
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
          Это <strong>ваш</strong> адрес — у каждого клиента ПЛЮСОН он свой (отличается номером после <code>/c/</code>).
          Используется на шагах 3 и 4 ниже.
        </p>
        <CopyBlock value={miniAppUrl} />
        <p className="text-xs text-gray-400 mt-2">
          ⚠️ Слэш в конце обязателен — без него Telegram не загрузит ассеты.
          {!clientId && ' Загружаем ваш номер клиента…'}
        </p>
      </Section>

      <Section step="1" title="Сначала: добавьте токен бота в Каналы">
        <p className="text-sm text-gray-700 mb-3">
          Без этого приветствия и рассылки будут идти от общего <code>@pluson_bot</code>, а не от вашего.
          Если хотите чтобы участники получали сообщения от <strong>вашего бота</strong> — добавьте его токен в раздел Каналы:
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Получите токен у <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">@BotFather <ExternalLink size={12}/></a> (команда <code>/newbot</code> для нового бота или <code>/mybots</code> → API Token для существующего)</li>
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
          <li>В Telegram найдите и откройте <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">@BotFather <ExternalLink size={12}/></a></li>
          <li>Команда <code>/mybots</code></li>
          <li>Выберите вашего бота (например <code>@pluson_bot</code>)</li>
        </ol>
      </Section>

      <Section step="3" title="Configure Mini App в Bot Settings">
        <p className="text-sm text-gray-700 mb-3">
          Привязываем ПЛЮСОН как <strong>главный Mini App</strong> бота. Ссылки получаются короткие
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

        <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900 mb-3">
          💡 Не путать с <code>/newapp</code> — это старый путь, он создаёт <strong>short-named</strong> Mini App
          (URL типа <code>t.me/bot/myapp</code>) и там как раз есть title/description/photo.
          Для ПЛЮСОНа short-name не нужен — используем <strong>Main Mini App</strong> через Bot Settings.
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
          🧹 <strong>Если</strong> в @BotFather <code>/myapps</code> у вас есть старые Mini App —
          удалите их (они были созданы через <code>/newapp</code> и могут конфликтовать с Main Mini App):
          выбрать старый Mini App → <strong>«Delete App»</strong> → подтвердить именем приложения.
          Если в <code>/myapps</code> пусто — ничего делать не нужно.
        </div>
      </Section>

      <Section step="4" title="Настроить Menu Button">
        <p className="text-sm text-gray-700 mb-3">
          Чтобы внизу чата с ботом появилась большая кнопка-вход вместо обычного <code>/</code>:
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5">
          <li>В @BotFather: <code>/mybots</code> → выбрать бота → <strong>«Bot Settings»</strong></li>
          <li>Нажать <strong>«Menu Button»</strong> → <strong>«Configure menu button»</strong></li>
          <li><strong>Текст кнопки:</strong> <code>Открыть ПЛЮСОН</code></li>
          <li>
            <strong>URL:</strong> вставьте эту ссылку →
            <div className="mt-2"><CopyBlock value={miniAppUrl} /></div>
          </li>
        </ol>
      </Section>

      <Section step="5" title="Прописать домен бота">
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
          Никаких ссылок руками собирать не нужно — ПЛЮСОН делает их сам. Откройте карточку события и скопируйте готовую:
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
            <strong>Старая версия отображается</strong> → закройте Mini App в Telegram (свайп вниз) и откройте заново. Telegram кэширует
          </li>
        </ul>

        <div className="mt-5 p-4 bg-gray-50 rounded-xl border border-gray-200">
          <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
          <p className="text-sm text-gray-600">
            Напишите разработчику —{' '}
            <a href="https://t.me/margo_forbs?text=Вопрос_по_подключению_Mini_App"
               target="_blank" rel="noopener noreferrer"
               className="text-blue-600 hover:underline inline-flex items-center gap-1">
              открыть чат в Telegram <ExternalLink size={12}/>
            </a>
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

