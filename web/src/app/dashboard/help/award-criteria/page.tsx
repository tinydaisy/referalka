'use client'
import Link from 'next/link'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'
import { Crumbs, Hero, Step, Note, Warn, Accent, ArticleToc, NextArticle } from '../_article'

/**
 * Критерии и схемы подсчёта — самая сложная тема раздела.
 *
 * ⚠️ Четыре схемы объясняем НЕ формулами, а задачей: «что вы хотите посчитать».
 * Формула даётся справочно. Иначе человек выбирает наугад и получает
 * несравнимые баллы.
 */
export default function AwardCriteriaPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <Crumbs section="Премии и турниры" sectionHref="/dashboard/help/s/tournaments"
              title="Критерии и схемы подсчёта" />

      <Hero
        title="Критерии и схемы подсчёта"
        subtitle="По чему считаются баллы: пакеты критериев, их веса, кто ставит оценку и как из всего этого получается итог."
      />

      <ArticleToc items={[
        { id: 'packages', title: 'Пакеты: зачем группировать критерии' },
        { id: 'types', title: 'Восемь типов критериев — кто ставит балл' },
        { id: 'schemes', title: 'Четыре схемы расчёта — какую выбрать' },
        { id: 'weights', title: 'Веса: как задать важность' },
        { id: 'audience', title: 'Кого включать в номинацию' },
      ]} />

      <Accent title="Где это лежит">
        Раздел <b>«Турнир»</b> → вкладка <b>«Критерии»</b>. Сверху выбирается
        номинация — критерии настраиваются <b>для каждой отдельно</b>. Пакет
        можно сделать общим на весь турнир.
      </Accent>

      <Step id="packages" step="1" title="Пакеты: зачем группировать критерии">
        <p className="text-sm text-gray-700">
          <b>Пакет</b> — смысловая группа критериев со своим весом. Классический
          пример: пакет «Оценка жюри» (экспертные баллы) и пакет «Вовлечение»
          (сколько привёл людей, сколько заданий сдал).
        </p>
        <p className="text-sm text-gray-700 mt-2">
          Итоговый балл участника — это сумма баллов по всем пакетам.
        </p>
        <Accent title="Зачем не свалить всё в один список">
          Оценки жюри идут по шкале 0–10, а приведённые люди — это сотни. Сложить
          их напрямую нельзя: рефералы «съедят» экспертную оценку. Пакеты
          позволяют посчитать каждую группу по своим правилам и только потом
          сложить.
        </Accent>
        <Note title="Копирование в другие номинации">
          Кнопка <b>«Скопировать во все номинации»</b> переносит пакет с его
          критериями во все остальные. Оценки не копируются. Там, где пакет
          с таким названием уже есть, копия не создастся.
        </Note>
      </Step>

      <Step id="types" step="2" title="Восемь типов критериев — кто ставит балл">
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <tbody className="text-gray-700">
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">Жюри (оценивают)</td>
                <td className="py-2">эксперт ставит оценку в кабинете; задаётся шкала и минимум</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">Народное (голосование)</td>
                <td className="py-2">голоса зрителей</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">Ручной (вписать)</td>
                <td className="py-2">вы вписываете число сами, прямо в таблице</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">Авто-число — суммировать</td>
                <td className="py-2">участник пишет в чат «фраза 6» — баллы накапливаются</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">Авто-число — перезаписывать</td>
                <td className="py-2">то же, но новое значение заменяет старое</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">Рефералы (авто)</td>
                <td className="py-2">сколько людей привёл на событие</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-2 pr-3 font-medium">Лиды в ПЛЮСОН (авто)</td>
                <td className="py-2">сколько человек забрало его лид-магнит</td>
              </tr>
              <tr>
                <td className="py-2 pr-3 font-medium">Зрителей в вебинаре (авто)</td>
                <td className="py-2">сколько зрителей привёл на эфир</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Note title="Кодовая фраза для ручных и авто-числовых">
          Участник пишет в чат «фраза: 1000» — двоеточие и пробелы не важны,
          «фраза 1000» тоже сработает. Бот сам поставит балл. Как это включить —{' '}
          <Link href="/dashboard/help/tournament-task-control" className="text-blue-600 hover:underline">
            «Контроль заданий»
          </Link>.
        </Note>
        <Accent title="Описание критерия видит жюри">
          У критерия есть поле описания — оно показывается эксперту в его
          кабинете. Одна строка «что считать хорошим ответом» заметно повышает
          согласованность оценок.
        </Accent>
      </Step>

      <Step id="schemes" step="3" title="Четыре схемы расчёта — какую выбрать">
        <p className="text-sm text-gray-700">
          Схема задаётся <b>у пакета</b> и определяет, как его критерии
          превращаются в один балл. Выбирайте по задаче:
        </p>
        <div className="mt-3 space-y-2">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-800 mb-1">Схема 3 — среднее оценок (жюри)</div>
            <p className="text-xs text-gray-700 leading-relaxed">
              <b>Для экспертных оценок.</b> Честное среднее по критериям.
              Оценки уже в шкале 0–10, лидера нет, накрутить нельзя.
              При выборе все критерии пакета становятся «жюри».
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-800 mb-1">Схема 1 — сырая сумма ÷ лидера</div>
            <p className="text-xs text-gray-700 leading-relaxed">
              <b>Для вовлечения.</b> Лидер получает 10, остальные — долю от него.
              Берёт сырые числа (зрители, рефералы) как есть.
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-800 mb-1">Схема 2 — доля от лучшего</div>
            <p className="text-xs text-gray-700 leading-relaxed">
              <b>Для разномасштабных показателей.</b> Каждый критерий сначала
              приводится к доле от рекорда, потом усредняется. Сглаживает
              разницу, когда в одном пакете и десятки, и тысячи.
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-800 mb-1">Схема 4 — чистая сумма</div>
            <p className="text-xs text-gray-700 leading-relaxed">
              <b>Копилка за задания.</b> Просто сумма баллов, без деления.
              Сделал задание — капнули баллы.
            </p>
          </div>
        </div>
        <Accent title="Если сомневаетесь">
          Оценки жюри — <b>схема 3</b>. Активность и рефералы — <b>схема 1</b>.
          Задания с накоплением — <b>схема 4</b>. Схема 2 нужна редко: когда
          в одном пакете показатели совсем разного масштаба.
        </Accent>
        <Warn title="Схему лучше не менять после начала оценки">
          Пересчёт изменит расстановку мест, и участники увидят, что они
          «упали» без причины. Определитесь до старта.
        </Warn>
      </Step>

      <Step id="weights" step="4" title="Веса: как задать важность">
        <p className="text-sm text-gray-700">
          Вес есть и у пакета, и у критерия внутри него. Чем больше число,
          тем сильнее влияние на итог.
        </p>
        <p className="text-sm text-gray-700 mt-2">
          Например: пакет «Оценка жюри» с весом 3 и пакет «Вовлечение» с весом 1 —
          значит экспертная оценка втрое важнее активности.
        </p>
        <Accent title="Начните с простого">
          Все веса по 1 — и премия уже работает. Веса нужны, когда вы точно
          понимаете, что один критерий должен решать больше другого. Сложная
          система весов, которую никто не может объяснить участникам, вредит
          доверию.
        </Accent>
      </Step>

      <Step id="audience" step="5" title="Кого включать в номинацию">
        <p className="text-sm text-gray-700">
          Блок <b>«Кого включать в этап»</b> — одна настройка, которая действует
          сразу на турнирную таблицу, распределение жюри и кабинет спикера.
          Варианты: все участники, только зарегистрированные, спикеры, жюри,
          либо «Без турнира».
        </p>
        <Note title="Зачем это нужно">
          В премии обычно оценивают <b>номинантов-карточки</b>, а не всех
          зарегистрировавшихся зрителей. Тогда выбирают «Спикеры» — и в таблице
          останутся только заведённые вами люди.
        </Note>
        <Accent title="Регламент — публичная страница">
          Рядом со списком есть ссылка на <b>«Регламент подсчёта»</b> — открытую
          страницу, где расписаны критерии и схемы. Её можно давать участникам:
          она снимает большинство споров о справедливости.
        </Accent>
      </Step>

      <NextArticle
        href="/dashboard/help/award-assignments"
        title="Распределение жюри"
        description="Кто кого оценивает: ручное распределение, автораспределение и защита от конфликта интересов"
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
