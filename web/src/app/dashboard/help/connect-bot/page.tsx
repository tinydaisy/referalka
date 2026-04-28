'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ExternalLink, Copy, Check } from 'lucide-react'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function ConnectBotInstructionPage() {
  const [origin, setOrigin] = useState('https://pluson.margoforbs.ru')

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
  }, [])

  const miniAppUrl = `${origin}/tg/`
  const isDev = origin.includes('dev.')

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="#" className="text-sm text-gray-400 hover:text-gray-700">Тех.поддержка</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Инструкции</span>
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
      <Section step="●" title="Ваш URL Mini App">
        <p className="text-sm text-gray-600 mb-3">
          Этот адрес нужен на всех шагах ниже. Сохраните или скопируйте его.
        </p>
        <CopyBlock value={miniAppUrl} />
        <p className="text-xs text-gray-400 mt-2">
          ⚠️ Слэш в конце обязателен — без него Telegram не загрузит ассеты.
        </p>
      </Section>

      <Section step="1" title="Открыть @BotFather и выбрать вашего бота">
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5">
          <li>В Telegram найдите и откройте <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">@BotFather <ExternalLink size={12}/></a></li>
          <li>Команда <code>/mybots</code></li>
          <li>Выберите вашего бота (например <code>@pluson_bot</code>)</li>
        </ol>
      </Section>

      <Section step="2" title="Создать или обновить Mini App">
        <p className="text-sm text-gray-700 mb-3">
          Если у вас ещё нет Mini App в этом боте — создаём:
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-4">
          <li>Команда <code>/newapp</code> → выбрать вашего бота</li>
          <li><strong>Title:</strong> <code>ПЛЮСОН</code></li>
          <li><strong>Description:</strong> ваше описание</li>
          <li><strong>Photo:</strong> картинка 640×360 (логотип или превью)</li>
          <li><strong>GIF:</strong> можно пропустить — пришлите <code>/empty</code></li>
          <li><strong>Web App URL:</strong> вставьте ссылку выше</li>
          <li><strong>Short name:</strong> <code>app</code> (или любое короткое имя на латинице)</li>
        </ol>

        <p className="text-sm text-gray-700 mb-3">
          Если Mini App уже есть — обновляем URL:
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5">
          <li>Команда <code>/myapps</code> → выбрать существующий Mini App</li>
          <li>Нажать <strong>«Edit Web App URL»</strong></li>
          <li>Вставить ссылку выше — придёт <em>«Success! URL updated»</em></li>
        </ol>
      </Section>

      <Section step="3" title="Настроить Menu Button">
        <p className="text-sm text-gray-700 mb-3">
          Чтобы внизу чата с ботом появилась большая кнопка-вход вместо обычного <code>/</code>:
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5">
          <li>В @BotFather: <code>/mybots</code> → выбрать бота → <strong>«Bot Settings»</strong></li>
          <li>Нажать <strong>«Menu Button»</strong> → <strong>«Configure menu button»</strong></li>
          <li><strong>Текст кнопки:</strong> <code>Открыть ПЛЮСОН</code></li>
          <li><strong>URL:</strong> вставьте ссылку:</li>
        </ol>
        <div className="mt-3"><CopyBlock value={miniAppUrl} /></div>
      </Section>

      <Section step="4" title="Прописать домен бота">
        <p className="text-sm text-gray-700 mb-3">
          Это нужно для безопасной работы Mini App и Telegram Login:
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Команда <code>/setdomain</code> → выбрать вашего бота</li>
          <li>Прислать домен (без <code>https://</code> и без <code>/</code> в конце):</li>
        </ol>
        <CopyBlock value={origin.replace(/^https?:\/\//, '').replace(/\/$/, '')} />
      </Section>

      <Section step="●" title="Готовые ссылки на ваш Mini App">
        <p className="text-sm text-gray-600 mb-3">
          После настройки вашему боту доступны такие виды ссылок (замените <code>my_bot</code> на имя вашего бота, <code>app</code> — на short name из шага 2):
        </p>

        <div className="space-y-3">
          <LinkRow
            label="Хаб организатора (Календарь + Экосистема)"
            value="https://t.me/my_bot/app"
          />
          <LinkRow
            label="Сразу страница события"
            value="https://t.me/my_bot/app?startapp=ref_pgEVENT_SLUG"
            note="Замените EVENT_SLUG на slug события из вашего кабинета"
          />
          <LinkRow
            label="Событие + засчитать партнёра + UTM"
            value="https://t.me/my_bot/app?startapp=ref_pgEVENT_SLUG_pidPARTNER_srcSOURCE"
            note="PARTNER — ID партнёра, SOURCE — utm_source (insta, vk, …)"
          />
        </div>
      </Section>

      <Section step="●" title="Smart Bridge — редирект с лендинга">
        <p className="text-sm text-gray-700 mb-3">
          В каждом лендинге события (<code>/l/SLUG</code>) уже подключён скрипт автоматического перехода в Telegram. Если открыть лендинг с <code>?app=tg</code> — Telegram запустится сам:
        </p>
        <CopyBlock value={`${origin}/l/EVENT_SLUG?app=tg`} />
        <p className="text-xs text-gray-500 mt-2">
          Используйте этот формат в постах в соцсетях — на компьютере откроется обычный лендинг, на телефоне с Telegram — сразу Mini App.
        </p>
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

function LinkRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div className="text-xs font-semibold text-gray-700 mb-1">{label}</div>
      <CopyBlock value={value} />
      {note && <p className="text-xs text-gray-500 mt-1">{note}</p>}
    </div>
  )
}
