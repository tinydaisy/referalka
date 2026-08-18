'use client'
import Link from 'next/link'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'
import { Crumbs, Hero, Step, Note, Warn, Accent, NextArticle } from '../_article'

/**
 * Воронка догрева — две независимые воронки.
 *
 * ⚠️ Главное отличие от рассылок: отсчёт идёт от ДЕЙСТВИЯ ЧЕЛОВЕКА (открыл /
 * зарегистрировался), а не от даты события. Поэтому каждый получает свои
 * сообщения в своё время, и настраивается это один раз.
 */
export default function EventNurturePage() {
  return (
    <div className="pb-24 max-w-3xl">
      <Crumbs section="Мероприятия" sectionHref="/dashboard/help/s/events"
              title="Воронка догрева" />

      <Hero
        title="Воронка догрева"
        subtitle="Человек открыл событие и не записался — его надо вернуть. Записался — надо довести до эфира. Для этого есть две отдельные воронки."
      />

      <Accent title="Чем отличается от обычных рассылок">
        Рассылки привязаны к <b>дате события</b> — уходят всем разом за сутки,
        за 2 часа. Догрев привязан к <b>действию человека</b>: отсчёт идёт
        от момента, когда он открыл событие или записался. Каждый получает
        сообщения в своё время, даже если пришёл за месяц до эфира.
      </Accent>

      <Step step="1" title="Две воронки — для разных людей">
        <p className="text-sm text-gray-700">
          Раздел <b>«Настройки»</b> → вкладка <b>«Воронка догрева»</b>. Внутри две
          подвкладки:
        </p>
        <div className="mt-3 space-y-2">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-800 mb-1">«Незарегистрированным»</div>
            <p className="text-xs text-gray-700 leading-relaxed">
              Человек открыл событие, но не записался. Отсчёт — от первого
              открытия. Останавливается сама, когда он регистрируется или когда
              событие завершилось.
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-800 mb-1">«Зарегистрированным»</div>
            <p className="text-xs text-gray-700 leading-relaxed">
              Помогает не потеряться: вступить в чат, закрепить бота, подготовиться.
              Отсчёт — от момента регистрации. Останавливается, когда событие
              завершилось.
            </p>
          </div>
        </div>
        <Accent title="Первая воронка возвращает деньги, вторая — доводит до эфира">
          Люди, открывшие событие и не записавшиеся, — это те, кого вы уже
          привели и почти потеряли. Одно-два сообщения возвращают заметную часть.
        </Accent>
      </Step>

      <Step step="2" title="Собрать шаги">
        <p className="text-sm text-gray-700">
          Воронка состоит из шагов. У каждого шага задаются:
        </p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5 mt-2">
          <li><b>Интервал</b> — через сколько после старта отсчёта: сразу, через N минут, часов или суток</li>
          <li><b>Текст</b> сообщения</li>
          <li><b>Текст кнопки</b> — например «Зарегистрироваться»</li>
          <li><b>Куда ведёт кнопка</b> — на событие или в поддержку</li>
          <li><b>Тумблер активности</b> — шаг можно выключить, не удаляя</li>
        </ul>
        <p className="text-sm text-gray-700 mt-3">
          Рядом с редактором — предпросмотр «как в Telegram», сразу видно,
          что получит человек.
        </p>
        <Note title="Разметка в тексте">
          Работают <code className="text-xs bg-gray-100 px-1 rounded">&lt;b&gt;</code>,{' '}
          <code className="text-xs bg-gray-100 px-1 rounded">&lt;i&gt;</code> и ссылки{' '}
          <code className="text-xs bg-gray-100 px-1 rounded">&lt;a href="…"&gt;</code> —
          но только в Telegram и MAX. Во ВКонтакте теги срезаются автоматически,
          текст придёт без оформления.
        </Note>
      </Step>

      <Step step="3" title="Подстановки — что можно вставить в текст">
        <p className="text-sm text-gray-700">
          Подстановки заменяются автоматически при отправке. Набор отличается
          у двух воронок.
        </p>
        <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="text-xs font-semibold text-gray-800 mb-1.5">Общие</div>
          <ul className="text-xs text-gray-700 space-y-1">
            <li><code className="bg-white border border-gray-200 rounded px-1">&#123;event_title&#125;</code> — название события</li>
            <li><code className="bg-white border border-gray-200 rounded px-1">&#123;support_link&#125;</code> — ссылка на вашу службу заботы</li>
          </ul>
          <div className="text-xs font-semibold text-gray-800 mt-3 mb-1.5">Для незарегистрированных</div>
          <ul className="text-xs text-gray-700 space-y-1">
            <li><code className="bg-white border border-gray-200 rounded px-1">&#123;event_date_short&#125;</code> — дата события</li>
            <li><code className="bg-white border border-gray-200 rounded px-1">&#123;brand_name&#125;</code> — ваш бренд</li>
          </ul>
          <div className="text-xs font-semibold text-gray-800 mt-3 mb-1.5">Для зарегистрированных</div>
          <ul className="text-xs text-gray-700 space-y-1">
            <li><code className="bg-white border border-gray-200 rounded px-1">&#123;chats&#125;</code> — чаты события списком</li>
            <li><code className="bg-white border border-gray-200 rounded px-1">&#123;program_link&#125;</code> — ссылка на программу</li>
            <li><code className="bg-white border border-gray-200 rounded px-1">&#123;gifts_link&#125;</code> — ссылка на подарки</li>
            <li><code className="bg-white border border-gray-200 rounded px-1">&#123;bot_handle&#125;</code> — имя вашего бота</li>
          </ul>
        </div>
        <Note title="Пустая подстановка убирается">
          Если у события нет чатов, строка с <code className="text-xs bg-gray-100 px-1 rounded">&#123;chats&#125;</code> просто
          исчезнет — пустой строки в сообщении не будет.
        </Note>
      </Step>

      <Step step="4" title="Сколько шагов делать">
        <p className="text-sm text-gray-700">
          Готовые шаги уже созданы — их можно оставить как есть. Если делаете свои,
          рабочий минимум такой:
        </p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5 mt-2">
          <li><b>Незарегистрированным:</b> через 15 минут «не получилось записаться?» и через сутки — напоминание с выгодой</li>
          <li><b>Зарегистрированным:</b> сразу «что делать дальше» и через 15 минут «всё получилось?»</li>
        </ul>
        <Warn title="Не превращайте догрев в спам">
          Пять сообщений подряд человеку, который просто заглянул, дают отписку,
          а не регистрацию. Два-три шага работают лучше, чем шесть.
        </Warn>
      </Step>

      <NextArticle
        href="/dashboard/help/event-welcome"
        title="Приветствие: письмо и ответ в чатах"
        description="Письмо на почту сразу после регистрации и ответ бота на кодовое слово в чате события"
      />

      <div className="mt-6 p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Не нашли ответ?</div>
        <p className="text-sm text-gray-600">
          Напишите в поддержку —{' '}
          <Link href={SUPPORT_URL} className="text-blue-600 hover:underline">{SUPPORT_LABEL}</Link>
        </p>
      </div>
    </div>
  )
}
