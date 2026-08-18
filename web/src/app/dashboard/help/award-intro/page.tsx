'use client'
import Link from 'next/link'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'
import { Crumbs, Hero, Step, Note, Warn, Accent, NextArticle } from '../_article'

/**
 * Обзорная статья раздела «Премии и турниры».
 *
 * ⚠️ Главное, что надо объяснить в первых строках: номинация, тур и этап —
 * ЭТО ОДНО И ТО ЖЕ. В интерфейсе поле называется «Номинация/тур/этап», и без
 * пояснения человек ищет отдельную сущность «номинация» и не находит.
 */
export default function AwardIntroPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <Crumbs section="Премии и турниры" sectionHref="/dashboard/help/s/tournaments"
              title="Как устроены премии и турниры" />

      <Hero
        title="Как устроены премии и турниры"
        subtitle="Номинанты, жюри и оценки по критериям. Разберём главное: что такое номинация, кто кого оценивает и как считается итог."
      />

      <Accent title="Номинация, тур и этап — это одно и то же">
        В интерфейсе вы увидите подпись <b>«Номинация/тур/этап»</b>. Это не три
        разные вещи, а одна: у премии её удобно называть номинацией, у турнира —
        туром, у многоэтапного отбора — этапом. Отличается только слово.
      </Accent>

      <Step step="1" title="Из чего состоит премия">
        <p className="text-sm text-gray-700">
          Четыре сущности, и этого достаточно, чтобы понять всё остальное:
        </p>
        <div className="mt-3 space-y-2">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-800 mb-1">Номинации</div>
            <p className="text-xs text-gray-700 leading-relaxed">
              «Лучший хирург», «Медсестра года». У каждой свои критерии, своё
              жюри и своя таблица. Один человек может участвовать в нескольких.
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-800 mb-1">Номинанты</div>
            <p className="text-xs text-gray-700 leading-relaxed">
              Те, кого оценивают. Заводятся карточками — как спикеры
              в конференции.
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-800 mb-1">Жюри</div>
            <p className="text-xs text-gray-700 leading-relaxed">
              Те, кто оценивает. Это тоже карточка человека, только с ролью
              «Жюри». Каждый видит в своём кабинете лишь тех, кого ему назначили.
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <div className="text-xs font-semibold text-gray-800 mb-1">Критерии</div>
            <p className="text-xs text-gray-700 leading-relaxed">
              По чему ставят баллы. Собираются в пакеты со своими весами —
              например «Оценка жюри» и «Вовлечение».
            </p>
          </div>
        </div>
      </Step>

      <Step step="2" title="Кто может ставить баллы">
        <p className="text-sm text-gray-700">
          Баллы приходят не только от жюри. Критерий бывает разных типов:
        </p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5 mt-2">
          <li><b>Жюри</b> — человек ставит оценку в своём кабинете</li>
          <li><b>Народное голосование</b> — считаются голоса зрителей</li>
          <li><b>Ручной</b> — вы вписываете число сами</li>
          <li><b>Авто-число</b> — участник пишет в чат кодовую фразу с числом, балл ставится сам</li>
          <li><b>Рефералы</b> — сколько людей привёл</li>
          <li><b>Лиды и зрители</b> — считаются автоматически</li>
        </ul>
        <Accent title="Отсюда вся гибкость">
          Премия может быть чисто экспертной (только жюри), чисто механической
          (только рефералы и задания) или смешанной — где эксперты дают половину
          балла, а активность вторую.
        </Accent>
      </Step>

      <Step step="3" title="Порядок сборки — с нуля">
        <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5">
          <li>
            <b>Создать событие</b> и заполнить базовое: название, даты, афишу (
            <Link href="/dashboard/help/award-setup" className="text-blue-600 hover:underline">как</Link>)
          </li>
          <li>
            <b>Завести номинации</b> и, если их много, разложить по категориям (
            <Link href="/dashboard/help/award-nominations" className="text-blue-600 hover:underline">как</Link>)
          </li>
          <li>
            <b>Добавить номинантов и жюри</b>, привязать их к номинациям (
            <Link href="/dashboard/help/award-people" className="text-blue-600 hover:underline">как</Link>)
          </li>
          <li>
            <b>Настроить критерии</b> — по чему считаем баллы (
            <Link href="/dashboard/help/award-criteria" className="text-blue-600 hover:underline">как</Link>)
          </li>
          <li>
            <b>Распределить жюри</b> — кто кого оценивает (
            <Link href="/dashboard/help/award-assignments" className="text-blue-600 hover:underline">как</Link>)
          </li>
          <li>
            <b>Разослать доступы</b> жюри и номинантам (
            <Link href="/dashboard/help/award-invite" className="text-blue-600 hover:underline">как</Link>)
          </li>
        </ol>
        <Warn title="Критерии — до начала оценки">
          Менять критерии, когда жюри уже поставило часть баллов, — плохая идея:
          оценки перестают быть сравнимыми. Определитесь заранее.
        </Warn>
      </Step>

      <Step step="4" title="Что видят участники">
        <p className="text-sm text-gray-700">
          У премии есть <b>публичная турнирная таблица</b> — открытая страница
          с результатами. Плюс страница регламента, где расписано, как считаются
          баллы.
        </p>
        <Accent title="Открытость снимает половину вопросов">
          Когда правила и промежуточные результаты видны всем, спорить
          о справедливости почти не приходится. Ссылку на таблицу можно давать
          и участникам, и зрителям.
        </Accent>
      </Step>

      <NextArticle
        href="/dashboard/help/award-setup"
        title="Создание и настройка премии"
        description="Первые шаги с нуля: создать событие, заполнить описание и даты, загрузить афишу, настроить регистрацию и чаты"
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
