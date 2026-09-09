'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ExternalLink } from 'lucide-react'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function ConnectMaxChannelInstructionPage() {
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
        <span className="text-sm text-gray-700">Как создать открытый канал в MAX</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Как создать открытый канал в MAX</h1>
          <p className="text-sm text-gray-500 mt-1">
            Пошаговый гайд: создаём именно <strong>открытый</strong> канал, видимый для всех — через платформу
            «Партнёры МАХ». Весь процесс — около 15–20 минут без учёта верификации.
          </p>
        </div>
      </div>

      {isDev && (
        <div className="rounded-xl border p-4 mb-6 flex items-start gap-3 bg-amber-50 border-amber-200">
          <div className="text-xl flex-shrink-0">🧪</div>
          <div>
            <div className="text-sm font-semibold text-gray-800">Вы в DEV-окружении</div>
            <p className="text-xs text-gray-600 mt-0.5">Инструкция одинакова для dev и прода — она про сам MAX.</p>
          </div>
        </div>
      )}

      <Section step="!" title="Кто может создать открытый канал в MAX">
        <p className="text-sm text-gray-700 mb-3">
          В MAX бывает два типа каналов — открытые и приватные. Раньше создавать их могли только аккаунты
          с 10 000+ подписчиков в соцсетях, теперь это ограничение снято. Но открытый канал доступен только
          для бизнеса:
        </p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5 mb-3">
          <li>ИП (включая ИП на НПД)</li>
          <li>ООО и другие формы организаций</li>
        </ul>
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900 mb-3">
          💡 Если у вас самозанятость — без паники. Просто перейдите на ИП с НПД: ставка та же, лимит тот же,
          зато возможностей больше.
        </div>
        <div className="bg-rose-50 border border-rose-100 rounded-xl p-3 text-sm text-rose-900">
          ⚠️ Физлица и нерезиденты — пока вне игры. Открытый канал для них недоступен.
        </div>
      </Section>

      <Section step="1" title="Регистрация на платформе «Партнёры МАХ»">
        <p className="text-sm text-gray-700 mb-3">
          Всё начинается с платформы «Партнёры МАХ». Откройте{' '}
          <a href="https://business.max.ru" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline font-medium inline-flex items-center gap-1">
            business.max.ru <ExternalLink size={12}/>
          </a>
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Введите номер телефона</li>
          <li>Получите SMS-код</li>
          <li>Введите код — вы в системе</li>
        </ol>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
          ⚠️ <strong>Один номер = один профиль компании.</strong> К нему привязываются каналы, боты и
          мини-приложения. Сразу вводите рабочий номер.
        </div>
      </Section>

      <Section step="2" title="Добавляем организацию и проходим верификацию">
        <p className="text-sm text-gray-700 mb-3">
          Введите ИНН организации (10 или 12 цифр) → нажмите «Далее». Система найдёт компанию — подтверждаете.
        </p>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900 mb-3">
          ⭐ Дальше нужна верификация. Пройти её может <strong>только владелец организации</strong>.
        </div>
        <p className="text-sm font-semibold text-gray-800 mb-2">Способы подтверждения:</p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5 mb-3">
          <li>Госуслуги</li>
          <li>Банковские сервисы: Alfa ID, T-Business ID, СберБизнес ID — как правило, быстрее</li>
        </ul>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Выберите сервис → нажмите «Подключить»</li>
          <li>Авторизуйтесь</li>
          <li>Подтвердите передачу данных через SMS</li>
        </ol>
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900">
          💡 Совет: если не хотите мучиться с Госуслугами — попробуйте через банк, где у вас уже есть
          бизнес-аккаунт. Там обычно всё проходит в пару кликов. Для подтверждения через провайдера банка
          потребуется открытый расчётный счёт в нём.
        </div>
      </Section>

      <Section step="3" title="Создаём канал">
        <p className="text-sm text-gray-700 mb-3">
          После успешной верификации возвращайтесь на платформу и выбирайте <strong>«Канал»</strong> в списке
          сервисов → нажмите «Создать».
        </p>
        <p className="text-sm font-semibold text-gray-800 mb-2">Вам предложат два варианта ника:</p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5">
          <li>Сохранить ник из Telegram (если есть отметка A+)</li>
          <li>Создать канал с автоматическим ником (формат: <code>idИНН_biz</code>)</li>
        </ul>
      </Section>

      <Section step="4" title="Выбираете вариант канала — переходите к созданию">
        <p className="text-sm text-gray-700 mb-3">
          MAX спросит, как вы хотите создать канал:
        </p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5 mb-3">
          <li><strong>Создать канал с ником из другого мессенджера или соцсети</strong> — если у вас есть регистрация в РКН</li>
          <li><strong>Создать новый канал для бизнеса</strong></li>
        </ul>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Сканируете QR-код — перейдёте в приложение MAX (войдите тем же номером, что используете на платформе)</li>
          <li>Задаёте название канала</li>
        </ol>
        <div className="bg-green-50 border border-green-100 rounded-xl p-3 text-sm text-green-900">
          ✅ <strong>Открытый канал в MAX активирован!</strong> Теперь вас можно найти через поиск.
        </div>
      </Section>

      <Section step="●" title="Что дальше — подключить канал к ПЛЮСОНу">
        <p className="text-sm text-gray-700 mb-3">
          Когда открытый канал в MAX создан, добавьте его в раздел{' '}
          <Link href="/dashboard/channels" className="text-blue-600 hover:underline font-medium">«Каналы»</Link> кабинета —
          платформа MAX. После этого реф-ссылки и материалы событий смогут вести на ваш канал в MAX.
        </p>
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900">
          💡 Весь процесс создания канала — около 15–20 минут без учёта верификации. Самый непростой этап —
          подтверждение. С этой инструкцией вы пройдёте его значительно быстрее.
        </div>
      </Section>

      <Section step="?" title="Если что-то не получается">
        <ul className="text-sm text-gray-700 space-y-2 list-disc pl-5">
          <li>
            <strong>Нет кнопки «Создать канал»</strong> → не пройдена верификация организации (этап 2).
            Её проходит только владелец.
          </li>
          <li>
            <strong>Самозанятость / физлицо</strong> → открытый канал недоступен. Нужен ИП (можно на НПД)
            или ООО.
          </li>
          <li>
            <strong>Верификация через Госуслуги зависает</strong> → попробуйте банковский сервис
            (Alfa ID / T-Business ID / СберБизнес ID), где у вас уже есть бизнес-аккаунт.
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
    <section className="bg-white rounded-2xl border card-border p-5 mb-4 shadow-sm">
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
