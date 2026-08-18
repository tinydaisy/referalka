'use client'
import Link from 'next/link'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'
import { Crumbs, Hero, Step, Note, Warn, Accent, ArticleToc, NextArticle } from '../_article'

/**
 * Рассылки конференции — 13 типов против 6 у мероприятия.
 *
 * ⚠️ Спикерские рассылки (знакомство, за 5 минут, подарок) собираются
 * ПО ПРОГРАММЕ — то есть сначала слоты, потом «Сформировать». Люди жмут
 * кнопку до того, как собрали расписание, и получают пустую очередь.
 */
export default function ConfBroadcastsPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <Crumbs section="Конференции" sectionHref="/dashboard/help/s/conferences"
              title="Рассылки конференции" />

      <Hero
        title="Рассылки конференции"
        subtitle="Кроме обычных напоминаний у конференции есть рассылки вокруг спикеров: знакомство, за 5 минут до выступления, подарок после эфира и итоги дня."
      />

      <ArticleToc items={[
        { id: 'types', title: 'Какие бывают рассылки' },
        { id: 'generate', title: 'Собрать очередь из программы' },
        { id: 'speaker-intro', title: 'Знакомство со спикерами' },
        { id: 'expert-day', title: 'Экспертный день' },
        { id: 'check', title: 'Проверить перед отправкой' },
      ]} />

      <Step id="types" step="1" title="Какие бывают рассылки">
        <p className="text-sm text-gray-700">
          Раздел <b>«Рассылки»</b> → вкладка <b>«Шаблоны»</b>. Шаблоны уже созданы
          при создании события, с готовыми текстами.
        </p>

        <div className="text-sm font-semibold text-gray-800 mt-4 mb-1">Вокруг спикеров</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <tbody className="text-gray-700">
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">Знакомство со спикером</td>
                <td className="py-2">по одному письму на каждого спикера, за несколько дней до старта</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">За 5 минут до выступления</td>
                <td className="py-2">перед слотом каждого спикера</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">Подарок спикера</td>
                <td className="py-2">за 5 минут до конца его слота</td>
              </tr>
              <tr>
                <td className="py-2 pr-3 font-medium">Экспертный день</td>
                <td className="py-2">анонс, что эксперт отвечает на вопросы в чате</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="text-sm font-semibold text-gray-800 mt-4 mb-1">Вокруг дней и события</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <tbody className="text-gray-700">
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">Анонс знакомства со спикерами</td>
                <td className="py-2">накануне первого дня</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">За сутки в 09:12</td>
                <td className="py-2">накануне каждого дня, отдельно записавшимся и остальным</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">За 2 часа</td>
                <td className="py-2">тоже парой: записавшимся и остальным</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">За 30 минут до старта</td>
                <td className="py-2">участникам события</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">Начинаем День события</td>
                <td className="py-2">за 5 минут до первой сессии дня</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">Итоги дня + подарки</td>
                <td className="py-2">после программы дня, со всеми подарками спикеров</td>
              </tr>
              <tr>
                <td className="py-2 pr-3 font-medium">Продажа VIP-тарифа</td>
                <td className="py-2">вручную, когда решите</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Note title="Плюс произвольные">
          Кроме готовых можно создать любое своё сообщение на любое время —
          с привязкой к дню, к слоту спикера или вообще без привязки.
        </Note>
      </Step>

      <Step id="generate" step="2" title="Собрать очередь из программы">
        <p className="text-sm text-gray-700">
          Вкладка <b>«Очередь рассылок»</b> → кнопка <b>«Сформировать из
          программы»</b>. Откроется список шаблонов с галочками — отмеченные
          встанут в очередь с рассчитанным временем.
        </p>
        <Warn title="Сначала программа, потом рассылки">
          Спикерские рассылки строятся <b>по слотам</b>. Если программа пустая,
          «за 5 минут до выступления» и «подарок спикера» просто не создадутся —
          очередь получится наполовину пустой.
        </Warn>
        <Accent title="Нажимать можно сколько угодно раз">
          Добавили спикеров или слоты после формирования — нажмите ещё раз.
          Новые рассылки добавятся, дублей уже созданных не будет.
        </Accent>
        <Note title="Прошедшее время пропускается">
          Рассылки, чьё время уже прошло, в очередь не встают — это нормально,
          если формируете очередь в последний момент.
        </Note>
      </Step>

      <Step id="speaker-intro" step="3" title="Знакомство со спикерами">
        <p className="text-sm text-gray-700">
          Самая полезная рассылка конференции: по <b>отдельному сообщению
          на каждого спикера</b>, с его фото, регалиями и темой. Аудитория
          знакомится с людьми до эфира.
        </p>
        <p className="text-sm text-gray-700 mt-2">В настройках шаблона задаются:</p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5 mt-2">
          <li><b>Время старта</b> — во сколько уходит первое письмо</li>
          <li><b>Интервал</b> — сколько минут между спикерами (по умолчанию 15)</li>
          <li><b>«Отправить за»</b> — за сколько дней до конференции</li>
          <li><b>Роли</b> — галочками, кого анонсировать</li>
          <li><b>Какое фото брать</b> — афишу спикера или обычное фото</li>
        </ul>
        <Accent title="Интервал — чтобы не выглядеть спамом">
          Двадцать сообщений подряд с интервалом в минуту читаются как рассылка.
          С интервалом в 15 минут — как знакомство. Не ставьте меньше 10.
        </Accent>
      </Step>

      <Step id="expert-day" step="4" title="Экспертный день">
        <p className="text-sm text-gray-700">
          Отдельный формат: анонс, что конкретный эксперт сегодня отвечает
          на вопросы в чате события. Кнопка ведёт прямо в чат.
        </p>
        <p className="text-sm text-gray-700 mt-2">
          Настраивается так же, как знакомство: время старта, интервал, роли.
          В сообщение подставляются темы, с которыми к спикеру можно обращаться, —
          те, что он указал у себя в кабинете.
        </p>
        <Note title="Работает, только если чат подключён">
          Кнопка ведёт в чат события — он должен быть выбран во вкладке
          «Описание».
        </Note>
      </Step>

      <Step id="check" step="5" title="Проверить перед отправкой">
        <p className="text-sm text-gray-700">
          В очереди есть тестовая отправка — сообщение уйдёт на ваши тестовые
          аккаунты, а не по базе. У каждой рассылки есть превью: видно, что
          подставилось вместо имени спикера, темы и времени.
        </p>
        <Accent title="Обязательно проверьте спикерские">
          В них больше всего подстановок: имя, тема, время слота, афиша, подарок.
          Если у спикера что-то не заполнено, это сразу видно в превью — и можно
          успеть попросить его дозаполнить.
        </Accent>
        <Warn title="Ссылку в кнопку — только одну">
          Несколько адресов в поле ссылки кнопки — и Telegram отклонит всё
          сообщение целиком, а не только кнопку.
        </Warn>
      </Step>

      <NextArticle
        href="/dashboard/help/conf-announcements"
        title="Отслеживание анонсов спикеров"
        description="Таблица «кто где разместил»: площадки, галочки и заметки о договорённостях — чтобы видеть, кто из спикеров выполнил обещанное"
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
