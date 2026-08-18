'use client'
import Link from 'next/link'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'
import { Crumbs, Hero, Step, Note, Warn, Accent, NextArticle } from '../_article'

/**
 * Приветствие — две разные механики под одной вкладкой.
 *
 * ⚠️ Люди путают: «На почту» — письмо в момент регистрации, «В чатах» — ответ
 * бота на кодовое слово в групповом чате. Общего между ними только вкладка.
 */
export default function EventWelcomePage() {
  return (
    <div className="pb-24 max-w-3xl">
      <Crumbs section="Мероприятия" sectionHref="/dashboard/help/s/events"
              title="Приветствие: письмо и ответ в чатах" />

      <Hero
        title="Приветствие: письмо и ответ в чатах"
        subtitle="Две независимые вещи под одной вкладкой: письмо, которое уходит сразу после регистрации, и ответ бота на кодовое слово в чате события."
      />

      <Step step="1" title="Письмо на почту после регистрации">
        <p className="text-sm text-gray-700">
          Раздел <b>«Настройки»</b> → вкладка <b>«Приветствие»</b> → подвкладка{' '}
          <b>«На почту»</b>. Письмо уходит человеку сразу, как он записался.
        </p>
        <p className="text-sm text-gray-700 mt-2">
          Заполняются два поля: <b>тема</b> и <b>текст</b>. В них работают
          подстановки:
        </p>
        <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <ul className="text-xs text-gray-700 space-y-1">
            <li><code className="bg-white border border-gray-200 rounded px-1">&#123;name&#125;</code> — имя человека</li>
            <li><code className="bg-white border border-gray-200 rounded px-1">&#123;event_title&#125;</code> — название события</li>
            <li><code className="bg-white border border-gray-200 rounded px-1">&#123;tg_url&#125;</code> — ссылка на событие</li>
          </ul>
        </div>
        <Warn title="Письмо уйдёт, только если есть почта">
          Если в настройках регистрации стоит галочка «Регистрировать без ввода
          контактных данных», почту человек не вводит — и письмо ему отправить
          некуда. Это нормально: в этом случае связь идёт через бота.
        </Warn>
        <Accent title="Что писать">
          Не «спасибо за регистрацию», а <b>что делать дальше</b>: когда эфир,
          где ссылка, куда вступить. Это письмо человек открывает — им и стоит
          воспользоваться.
        </Accent>
      </Step>

      <Step step="2" title="Ответ бота на кодовое слово в чате">
        <p className="text-sm text-gray-700">
          Подвкладка <b>«В чатах»</b>. Человек пишет в чате события кодовое слово,
          и бот отвечает ему заготовленным сообщением — с задержкой, чтобы это
          не выглядело роботом.
        </p>
        <p className="text-sm text-gray-700 mt-2">Настраиваются:</p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5 mt-2">
          <li>Тумблер <b>«Отвечать на кодовое слово в чатах»</b></li>
          <li>Само <b>кодовое слово</b></li>
          <li>Режим срабатывания — точное совпадение или вхождение</li>
        </ul>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-800 mb-1">Точное совпадение</div>
            <p className="text-xs text-gray-700 leading-relaxed">
              Бот ответит, только если всё сообщение — это кодовое слово
              (можно с восклицательным знаком и эмодзи).
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-800 mb-1">Вхождение</div>
            <p className="text-xs text-gray-700 leading-relaxed">
              Сработает везде, где слово встретилось, — в том числе внутри
              длинной фразы.
            </p>
          </div>
        </div>
        <Accent title="Зачем это нужно">
          Классический приём для прогрева чата: «напишите ХОЧУ, и я пришлю
          разбор». Люди пишут, чат оживает, а бот раздаёт материал сам —
          вам не надо сидеть и отвечать каждому.
        </Accent>
        <Warn title="Бот должен быть в чате и видеть сообщения">
          Добавьте бота в чат администратором. Для Telegram дополнительно
          отключите режим приватности (@BotFather → Bot Settings → Group
          Privacy → Disable) — иначе бот не видит обычные сообщения и не
          среагирует.
        </Warn>
        <Note title="Выбирайте слово, которое не встречается случайно">
          При режиме «вхождение» слово «хочу» сработает в любой фразе вроде
          «я хочу спросить». Берите что-то нетипичное: ХОЧУРАЗБОР, СТАРТ2024.
        </Note>
      </Step>

      <NextArticle
        href="/dashboard/help/event-landing"
        title="Лендинг события"
        description="Продающая страница из блоков: что можно поставить, как оформить и что заполняется само"
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
