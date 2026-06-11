'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ExternalLink, Copy, Check } from 'lucide-react'
import { api } from '@/lib/api'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function ConnectMaxBotInstructionPage() {
  const [origin, setOrigin] = useState(process.env.NEXT_PUBLIC_APP_URL || 'https://pluson.ru')

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
  }, [])

  const isDev = origin.includes('dev.')

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Подключение своего бота в MAX</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Подключение своего бота в MAX</h1>
          <p className="text-sm text-gray-500 mt-1">
            Пошаговая инструкция: создать своего бота в MAX и подключить его к iViSiON: ПЛЮСОН,
            чтобы воронки событий и рассылки шли от вашего имени, а не от общего бота сервиса.
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
            Текущий домен:{' '}
            <code className="bg-white px-1.5 py-0.5 rounded">{origin}</code>
          </p>
        </div>
      </div>

      {/* Что вы получите */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 mb-6">
        <div className="text-sm font-semibold text-gray-800 mb-1">Зачем подключать свой MAX-бот</div>
        <p className="text-sm text-gray-600">
          Без своего бота воронки событий и рассылки в MAX идут от общего бота сервиса
          (<code>id890306512862_1_bot</code>). Когда вы подключаете <strong>свой</strong> бот —
          участники видят ваше имя, а реф-ссылки в MAX получаются вида
          <code className="mx-1 break-all">max.ru/ваш_бот?start=ref_pgСОБЫТИЕ</code>.
        </p>
      </div>

      <Section step="1" title="Создайте бота в MAX через @MasterBot">
        <p className="text-sm text-gray-700 mb-3">
          Боты в MAX создаются их официальным служебным ботом — так же, как в Telegram через @BotFather.
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Откройте в MAX служебного бота <a href="https://max.ru/masterbot" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">@MasterBot <ExternalLink size={12}/></a></li>
          <li>Отправьте команду <code>/create</code> (или нажмите «Создать бота»)</li>
          <li>Придумайте имя бота и его адрес (username)</li>
          <li><strong>MasterBot пришлёт токен</strong> — длинную строку. Скопируйте её целиком</li>
        </ol>
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900">
          💡 Если бот уже создан — пропустите этот шаг. Токен можно получить заново в @MasterBot:
          выберите бота → <strong>«Токен»</strong> / <strong>«Получить токен»</strong>.
        </div>
      </Section>

      <Section step="2" title="Включите доступ к личным сообщениям">
        <p className="text-sm text-gray-700 mb-3">
          Чтобы бот мог писать воронки и рассылки в личку участникам, у него должна быть включена
          возможность получать и отправлять сообщения.
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5">
          <li>В @MasterBot выберите вашего бота</li>
          <li>Откройте его настройки</li>
          <li>Убедитесь, что бот может <strong>принимать сообщения от пользователей</strong> (не «только по приглашению»)</li>
        </ol>
      </Section>

      <Section step="3" title="Добавьте токен в раздел «Каналы»">
        <p className="text-sm text-gray-700 mb-3">
          Теперь подключаем бота к iViSiON: ПЛЮСОН. Webhook и приём сообщений сервис настроит сам —
          вам нужно только вставить токен.
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Откройте раздел <Link href="/dashboard/channels" className="text-blue-600 hover:underline font-medium">«Каналы»</Link> в кабинете</li>
          <li>Нажмите <strong>«Добавить канал»</strong></li>
          <li>В поле <strong>«Платформа»</strong> выберите <strong>MAX</strong></li>
          <li><strong>Название</strong> — любое понятное вам (например «MAX-бот мероприятия»)</li>
          <li><strong>Адрес (username)</strong> — username вашего бота из MAX (без <code>@</code>)</li>
          <li><strong>Bot Token</strong> — вставьте токен из @MasterBot</li>
          <li>Включите тумблер <strong>«Активный»</strong> и сохраните</li>
        </ol>
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900">
          💡 На каждой платформе (Telegram / VK / MAX) активным может быть только <strong>один канал</strong> на клиента.
          Если хотите сменить MAX-бот — деактивируйте старый и добавьте новый.
        </div>
      </Section>

      <Section step="4" title="Проверьте, что бот отвечает">
        <p className="text-sm text-gray-700 mb-3">
          После сохранения канала откройте вашего бота в MAX и отправьте ему <code>/start</code>.
          Бот должен ответить. Если ответа нет — значит токен введён неверно или доступ к сообщениям
          выключен (вернитесь к шагам 1–2).
        </p>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
          ⏱ После добавления токена webhook поднимается в течение минуты. Если бот не ответил сразу —
          подождите немного и попробуйте <code>/start</code> ещё раз.
        </div>
      </Section>

      <Section step="●" title="Где взять готовую MAX-ссылку для шеринга">
        <p className="text-sm text-gray-700 mb-3">
          Ссылки руками собирать не нужно — iViSiON: ПЛЮСОН делает их сам и уже подставляет
          вашего бота вместо общего. Откройте карточку события и скопируйте готовую MAX-ссылку:
        </p>
        <ul className="text-sm text-gray-700 space-y-2 list-disc pl-5 mb-3">
          <li>
            Для конференции/турнира: <Link href="/dashboard/conferences" className="text-blue-600 hover:underline font-medium">Дашборд → Конференции</Link>
            {' '}→ выбрать событие → блок «Публичные ссылки» → MAX
          </li>
          <li>
            Для других событий: <Link href="/dashboard/events" className="text-blue-600 hover:underline font-medium">Дашборд → Мероприятия</Link>
            {' '}→ выбрать событие → «Публичные ссылки» → MAX
          </li>
        </ul>
        <p className="text-sm text-gray-700">
          Пока свой MAX-бот не подключён, эти ссылки ведут на общий бот сервиса. Как только бот
          подключён и активен — ссылки автоматически начинают вести на него.
        </p>
      </Section>

      <Section step="?" title="Если что-то не работает">
        <ul className="text-sm text-gray-700 space-y-2 list-disc pl-5">
          <li>
            <strong>Бот молчит на <code>/start</code></strong> → неверный токен или выключен приём
            сообщений. Перепроверьте шаги 1–3.
          </li>
          <li>
            <strong>Ссылка в MAX ведёт на чужой/общий бот</strong> → ваш MAX-канал не активен.
            Откройте <Link href="/dashboard/channels" className="text-blue-600 hover:underline font-medium">«Каналы»</Link> и
            включите тумблер «Активный» у вашего MAX-бота.
          </li>
          <li>
            <strong>«Платформа MAX недоступна»</strong> → подключение своего бота на MAX доступно
            не на всех тарифах. Проверьте свой тариф в Настройках.
          </li>
        </ul>

        <div className="mt-5 p-4 bg-gray-50 rounded-xl border border-gray-200">
          <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
          <p className="text-sm text-gray-600">
            Напишите разработчику —{' '}
            <a href="https://t.me/margo_forbs?text=Вопрос_по_подключению_MAX-бота"
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
