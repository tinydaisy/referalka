/**
 * Поддержка — публичная страница с контактами и сроками ответа.
 *
 * ⚠️ Обязательна для публикации приложения в Zoom Marketplace: Support URL
 * должен вести на страницу, где указаны каналы связи, часы работы и
 * **максимальный срок первого ответа** (First Response SLA). Отсутствие
 * часов работы и SLA — отдельная причина отказа в официальном списке Zoom.
 *
 * ⚠️ Страница на СВОЁМ домене: Google Docs, Notion и прочие чужие площадки
 * Zoom не принимает — это тоже причина отказа.
 *
 * ⚠️ Почта сервиса, а НЕ личная почта владельца: страницу видят клиенты,
 * их подписчики и проверяющие Zoom.
 */
const SUPPORT_EMAIL = 'ivision.command@gmail.com'
const SUPPORT_TG = 'https://t.me/pluson_bot'

export const metadata = {
  title: 'Поддержка — iViSiON: ПЛЮСОН',
  description: 'Как связаться с поддержкой iViSiON: ПЛЮСОН и за какое время мы отвечаем.',
}

export default function SupportPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold text-[#25455D] mb-2">Поддержка</h1>
      <p className="text-sm text-gray-500 mb-6">
        Поможем с подключением, настройкой и любыми вопросами по платформе.
      </p>

      <div className="space-y-6 text-sm text-gray-700 leading-relaxed">
        <section>
          <h2 className="font-semibold text-[#25455D] mb-2">Как с нами связаться</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Почта:{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-600 hover:underline">
                {SUPPORT_EMAIL}
              </a>
            </li>
            <li>
              Telegram:{' '}
              <a href={SUPPORT_TG} className="text-blue-600 hover:underline"
                 target="_blank" rel="noreferrer">
                @pluson_bot
              </a>
            </li>
            <li>Из кабинета — раздел «Помощь», кнопка «Написать в поддержку».</li>
          </ul>
        </section>

        <section>
          <h2 className="font-semibold text-[#25455D] mb-2">Часы работы</h2>
          <p>
            Понедельник — пятница, с 10:00 до 19:00 по московскому времени (UTC+3).
            В выходные и праздничные дни отвечаем на срочные обращения — например,
            если сорвался идущий эфир.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-[#25455D] mb-2">Сроки ответа</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <b>Первый ответ — в течение 24 часов</b> в рабочие дни. Обычно отвечаем
              значительно быстрее.
            </li>
            <li>
              Проблемы, из-за которых не идёт эфир или недоступен кабинет, берём в работу
              вне очереди — в течение рабочего дня.
            </li>
            <li>
              Вопросы по настройке и обучению — до 2 рабочих дней.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-semibold text-[#25455D] mb-2">Что написать, чтобы помогли быстрее</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>адрес электронной почты, на который зарегистрирован кабинет;</li>
            <li>название события, с которым возникла сложность;</li>
            <li>что вы делали и что увидели вместо ожидаемого;</li>
            <li>снимок экрана, если на нём видна ошибка.</li>
          </ul>
        </section>

        <section>
          <h2 className="font-semibold text-[#25455D] mb-2">Интеграция с Zoom</h2>
          <p>
            Вопросы по подключению Zoom, созданию конференций и трансляции в вебинарную
            комнату — тоже к нам, по контактам выше. Пошаговое руководство:{' '}
            <a href="/zoom-guide" className="text-blue-600 hover:underline">
              как подключить Zoom
            </a>
            .
          </p>
        </section>

        <p className="text-xs text-gray-400 pt-2">
          Удаление данных — на странице{' '}
          <a href="/data-deletion" className="text-blue-600 hover:underline">
            «Удаление данных»
          </a>
          . Обработка персональных данных описана в{' '}
          <a href="/privacy" className="text-blue-600 hover:underline">
            Политике
          </a>
          .
        </p>
      </div>
    </div>
  )
}
