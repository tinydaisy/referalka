'use client'
import { useState } from 'react'
import Link from 'next/link'
import { BookOpen, ExternalLink, ImageOff } from 'lucide-react'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function CollabFindInstructionPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help/s/collab-hub" className="text-sm text-gray-400 hover:text-gray-700">Коллабораторная</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Как найти коллаборатора</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>
            Как найти коллаборатора и предложить совместный эфир
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Выберите партнёра в каталоге, отправьте предложение — и после принятия
            у вас автоматически появится совместное событие, готовое к упаковке.
          </p>
        </div>
      </div>

      <div className="rounded-xl border p-4 mb-4 flex items-start gap-3 bg-amber-50 border-amber-200">
        <div className="text-xl flex-shrink-0">⚠️</div>
        <div>
          <div className="text-sm font-semibold text-gray-800">Сначала опубликуйте свою карточку</div>
          <p className="text-xs text-gray-700 mt-1">
            Партнёр увидит вас в предложении и решит, соглашаться ли. Без заполненной
            карточки решать ему не по чему. Как заполнить —{' '}
            <Link href="/dashboard/help/collab-card" className="text-blue-600 hover:underline">
              Как создать карточку коллаборатора
            </Link>
          </p>
        </div>
      </div>

      <Section step="1" title="Зайти в каталог коллабораторов">
        <p className="text-sm text-gray-700">
          В меню слева откройте <b>Коллабораторная (Хаб) → Каталог</b>. Здесь собраны
          все организаторы и эксперты, опубликовавшие свои карточки.
        </p>
        <p className="text-sm text-gray-700 mt-2">
          Наверху — фильтры по нише, категории и городу. Начните с своей ниши либо
          со смежной: коллаборация лучше работает, когда аудитории близкие, но не одинаковые.
        </p>
        <Screenshot
          src="/help/collab-find/01-catalog.jpg"
          alt="Коллабораторная (Хаб), пункт меню Каталог"
          caption="Коллабораторная (Хаб) → Каталог"
        />
      </Section>

      <Section step="2" title="Выбрать коллаборатора">
        <p className="text-sm text-gray-700">
          На карточке видно главное: ниши, охват, число коллабораций, Win-Win коэффициент
          и блок <b>«Что предлагает партнёрам»</b> (он выделен голубым). Кнопка <b>«Профиль»</b> —
          открыть карточку целиком, <b>«Предложить»</b> — сразу написать предложение.
        </p>
        <div className="mt-3 rounded-lg border p-3" style={{ borderColor: PEACH, background: 'rgba(255,207,164,0.22)' }}>
          <div className="text-xs font-semibold mb-1" style={{ color: BRAND }}>Про Win-Win коэффициент</div>
          <p className="text-xs" style={{ color: BRAND }}>
            Это отношение приведённых человеком людей к среднему по его партнёрам.
            Ориентир — <b>1.0</b>: сработал наравне со всеми. Выше — вытянул коллаборацию на себе.
            Прочерк значит, что коллабораций ещё не было — это не минус, просто человек новичок.
          </p>
        </div>
        <Screenshot
          src="/help/collab-find/02-choose.jpg"
          alt="Карточка коллаборатора в каталоге с кнопкой Предложить"
          caption="Карточка в каталоге: «Профиль» — посмотреть подробнее, «Предложить» — написать"
        />
      </Section>

      <Section step="3" title="Написать предложение о коллаборации">
        <p className="text-sm text-gray-700">
          Откроется окно <b>«Предложить коллаборацию»</b>. В поле <b>«Присоединить к коллабе»</b>
          оставьте <b>«Новая коллаба»</b> — событие создастся само при принятии. Если у вас уже
          есть коллаборация и вы зовёте в неё ещё одного партнёра — выберите её из списка.
        </p>
        <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="text-xs font-semibold text-gray-800 mb-1">Что написать в предложении</div>
          <ul className="text-xs text-gray-700 space-y-1 list-disc pl-4">
            <li>Кто вы и какая у вас аудитория — коротко</li>
            <li>Что предлагаете: тема эфира, формат, примерные даты</li>
            <li>Что получит партнёр — почему ему это выгодно</li>
          </ul>
          <p className="text-xs text-gray-500 mt-2">
            Односложное «давай коллабу» чаще всего остаётся без ответа: человеку нечего решать.
          </p>
        </div>
        <Screenshot
          src="/help/collab-find/03-offer.jpg"
          alt="Окно Предложить коллаборацию с полем текста"
          caption="Окно «Предложить коллаборацию» → «Отправить запрос»"
        />
      </Section>

      <Section step="4" title="Перейти в запросы">
        <p className="text-sm text-gray-700">
          Все предложения живут в разделе <b>Коллабораторная (Хаб) → Запросы</b>.
          Здесь и то, что вы отправили, и то, что прислали вам.
        </p>
        <Screenshot
          src="/help/collab-find/04-requests.jpg"
          alt="Коллабораторная (Хаб), пункт меню Запросы"
          caption="Коллабораторная (Хаб) → Запросы"
        />
      </Section>

      <Section step="5" title="Дождаться, когда примут вашу коллаборацию">
        <p className="text-sm text-gray-700">
          В разделе две вкладки: <b>«Входящие»</b> — предложения вам, <b>«Отправленные»</b> —
          ваши. Пока партнёр не ответил, у запроса стоит статус <b>«Ждёт ответа»</b>.
        </p>
        <p className="text-sm text-gray-700 mt-2">
          Кнопка <b>«Профиль»</b> у карточки открывает страницу партнёра — оттуда можно
          связаться с ним напрямую, если ответа долго нет.
        </p>
        <Screenshot
          src="/help/collab-find/05-sent.jpg"
          alt="Вкладки Входящие и Отправленные в разделе Запросы"
          caption="Вкладка «Отправленные»: статус «Ждёт ответа», пока партнёр не принял"
        />
      </Section>

      <Section step="6" title="Забрать созданное событие и упаковать его">
        <p className="text-sm text-gray-700">
          Как только партнёр принял — событие создаётся автоматически и появляется
          в разделе <b>Коллабораторная (Хаб) → Коллабы</b>. Откройте его и упакуйте
          как обычное событие: даты, программа, афиши, лендинг, вебинарная комната.
        </p>
        <div className="mt-3 rounded-lg border p-3" style={{ borderColor: PEACH, background: 'rgba(255,207,164,0.22)' }}>
          <div className="text-xs font-semibold mb-1" style={{ color: BRAND }}>Организаторы равноправны</div>
          <p className="text-xs" style={{ color: BRAND }}>
            Каждый ведёт <b>свою</b> базу через <b>своего</b> бота — базы не смешиваются.
            Отчёт по привлечению видят все организаторы: вклад каждого на виду, в этом и смысл Win-Win.
          </p>
        </div>
        <Screenshot
          src="/help/collab-find/06-collabs.jpg"
          alt="Коллабораторная (Хаб), пункт меню Коллабы"
          caption="Коллабораторная (Хаб) → Коллабы: здесь появится созданное событие"
        />

        <div className="mt-4 rounded-xl border p-4 flex items-start gap-3 bg-green-50 border-green-200">
          <div className="text-xl flex-shrink-0">✅</div>
          <div>
            <div className="text-sm font-semibold text-gray-800">Готово</div>
            <p className="text-xs text-gray-700 mt-1">
              Событие есть — дальше обычная работа: опубликовать, собрать людей, провести эфир.
              После последнего эфира коллаборация завершится сама, и вклад каждого запишется в рейтинг.
            </p>
          </div>
        </div>

        <div className="mt-5 p-4 bg-gray-50 rounded-xl border border-gray-200">
          <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
          <p className="text-sm text-gray-600">
            Напишите в поддержку —{' '}
            <Link href={SUPPORT_URL} className="text-blue-600 hover:underline inline-flex items-center gap-1">
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

function Screenshot({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const [errored, setErrored] = useState(false)
  if (errored) {
    return (
      <div className="mt-3 rounded-xl border border-dashed border-gray-300 bg-gray-50 p-4 flex items-start gap-3">
        <ImageOff size={20} className="text-gray-400 flex-shrink-0 mt-0.5" />
        <div>
          <div className="text-xs font-mono text-gray-500 break-all">{src}</div>
          {caption && <div className="text-xs text-gray-500 mt-1 italic">{caption}</div>}
          <div className="text-xs text-gray-400 mt-1">Скриншот будет добавлен</div>
        </div>
      </div>
    )
  }
  return (
    <figure className="mt-3">
      <img
        src={src}
        alt={alt}
        onError={() => setErrored(true)}
        className="w-full rounded-xl border border-gray-200 shadow-sm"
      />
      {caption && (
        <figcaption className="text-xs text-gray-500 mt-2 italic">{caption}</figcaption>
      )}
    </figure>
  )
}
