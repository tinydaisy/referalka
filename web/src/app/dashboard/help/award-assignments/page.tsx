'use client'
import Link from 'next/link'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'
import { Crumbs, Hero, Step, Note, Warn, Accent, NextArticle } from '../_article'

/**
 * Распределение жюри.
 *
 * ⚠️ Самое ценное здесь — конфликт интересов: система знает, кто кого привёл,
 * и предупреждает при назначении «своего». Про это мало кто догадывается,
 * пока не увидит красную цифру.
 */
export default function AwardAssignmentsPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <Crumbs section="Премии и турниры" sectionHref="/dashboard/help/s/tournaments"
              title="Распределение жюри" />

      <Hero
        title="Распределение жюри"
        subtitle="Кто кого оценивает. Жюри видит в своём кабинете только тех, кого вы ему назначили, — поэтому без распределения оценка не начнётся."
      />

      <Warn title="Без распределения жюри никого не увидит">
        Пустое распределение = жюри заходит в кабинет и видит пустой список.
        Это самая частая причина обращения «жюри жалуется, что нечего оценивать».
      </Warn>

      <Step step="1" title="Открыть матрицу">
        <p className="text-sm text-gray-700">
          Раздел <b>«Турнир»</b> → вкладка <b>«Распределение»</b>. Сверху
          выбирается номинация: <b>распределение своё в каждой</b>.
        </p>
        <p className="text-sm text-gray-700 mt-2">
          Дальше — таблица: по строкам номинанты, по столбцам жюри. Галочка
          на пересечении означает «этот оценивает этого».
        </p>
        <Note title="Пусто в списке?">
          «Нет жюри» — значит, никому не задана роль «Жюри». «Нет участников» —
          в этой номинации никто не отмечен. Оба случая чинятся в разделе «Люди».
        </Note>
      </Step>

      <Step step="2" title="Три цифры у каждого номинанта">
        <p className="text-sm text-gray-700">
          В колонке <b>«Жюри»</b> напротив каждого — три числа:
        </p>
        <div className="mt-2 space-y-2">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-2.5">
            <span className="text-xs font-semibold text-blue-700">Синяя</span>
            <span className="text-xs text-gray-700"> — сколько жюри назначено всего</span>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-2.5">
            <span className="text-xs font-semibold text-green-700">Зелёная</span>
            <span className="text-xs text-gray-700"> — из них без конфликта интересов</span>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-2.5">
            <span className="text-xs font-semibold text-red-700">Красная</span>
            <span className="text-xs text-gray-700"> — те, кто <b>сам привёл этого участника</b> по своей ссылке</span>
          </div>
        </div>
        <Accent title="Красная цифра — это конфликт интересов">
          Жюри оценивает того, кого само привело. Система знает об этом
          и предупреждает при назначении: «Если жюри оценивает того, кого само
          привело — это может повлиять на объективность». Решение за вами,
          назначить всё равно можно.
        </Accent>
      </Step>

      <Step step="3" title="Автораспределение">
        <p className="text-sm text-gray-700">
          Кнопка <b>«✨ Автораспределение»</b> раскидывает номинантов по жюри
          равномерно, стараясь не назначать тех, кого жюри само привело.
        </p>
        <p className="text-sm text-gray-700 mt-2">
          В окне выбираете, кого распределять (участников, спикеров или обоих),
          и сколько человек давать одному жюри. Если оставить пусто, система
          подберёт сама и покажет рекомендацию.
        </p>
        <Accent title="Сколько жюри на одного номинанта">
          Чем больше, тем устойчивее результат: один эксперт может ошибиться
          или быть предвзятым, трое — уже усредняются. Рекомендация в окне
          считается как раз из этого.
        </Accent>
        <Note title="Есть и грубые кнопки">
          <b>«Назначить всех всем»</b> — если жюри мало и все смотрят всех.{' '}
          <b>«Очистить»</b> — начать распределение заново.
        </Note>
      </Step>

      <Step step="4" title="Что нельзя изменить">
        <Warn title="Снять жюри, которое уже поставило оценку, нельзя">
          Галочка просто откатится обратно. Иначе оценка повисла бы без автора,
          а итог пересчитался бы задним числом. Если жюри выбыло — оценки
          придётся убирать явно.
        </Warn>
        <Note title="Распределение можно менять до последнего">
          Пока оценок нет, двигайте как угодно: добавляйте жюри, меняйте
          нагрузку, перекидывайте номинантов.
        </Note>
      </Step>

      <NextArticle
        href="/dashboard/help/award-jury-cabinet"
        title="Кабинет жюри"
        description="Что видит эксперт, как ставит оценки и фиксирует их, и где вам смотреть, кто ещё не доделал работу"
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
