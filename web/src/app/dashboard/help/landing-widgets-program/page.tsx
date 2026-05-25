'use client'
import Link from 'next/link'
import { useState } from 'react'
import { ArrowLeft, Copy, Check, Calendar, Sparkles } from 'lucide-react'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="relative my-3 group">
      {lang && (
        <div className="absolute top-2 left-3 text-[10px] font-mono uppercase text-gray-400 tracking-wider z-10">{lang}</div>
      )}
      <button
        onClick={copy}
        className="absolute top-2 right-2 px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-xs text-white flex items-center gap-1 z-10"
      >
        {copied ? <><Check size={11} /> Скопировано</> : <><Copy size={11} /> Копировать</>}
      </button>
      <pre className="bg-gray-900 text-gray-100 rounded-xl px-4 py-3.5 pt-7 overflow-x-auto text-xs leading-relaxed font-mono whitespace-pre-wrap break-words">
        <code>{code}</code>
      </pre>
    </div>
  )
}

const SAMPLE_JSON = `{
  "event_slug": "ivision-8-n5u2u",
  "stages": [
    {
      "id": 1, "sort_order": 0,
      "title": "Предстарт", "subtitle": null,
      "description": "2 недели разогрева",
      "start_date": "2026-07-09", "end_date": "2026-07-22"
    }
  ],
  "days": [
    {
      "id": 33, "day_number": 1, "day_date": "2026-07-23",
      "open_time": "10:00", "close_time": "18:00",
      "stage_id": 2, "title": "День 1. Открытие"
    }
  ],
  "sessions": [
    {
      "id": 201, "day": 1,
      "start_time": "11:00", "end_time": "11:30",
      "title": "Открытие конференции",
      "gift_description": null,
      "track_id": null, "sort_order": 0,
      "speaker_event_id": 142, "speaker_role": "organizer",
      "speaker": {
        "id": 17, "name": "Марго Форбс",
        "title": "Основатель и креатор чемпионата",
        "photo_url": "https://pub.../margo.jpg",
        "achievements": ["..."],
        "tg_channel_url": "https://t.me/margo_forbs_pro",
        "vk_url": null, "max_url": null,
        "instagram_url": null, "website_url": null,
        "media_assets": [
          { "platform": "tg", "subscribers": 12500 }
        ]
      }
    }
  ]
}`

const SAMPLE_HTML = `<div id="program"></div>

<script>
const SLUG = 'ID-ИЛИ-SLUG-СОБЫТИЯ';
fetch(\`https://pluson.ru/api/v1/public/landing-widget/events/\${SLUG}/program\`)
  .then(r => r.json())
  .then(({ days, sessions }) => {
    document.getElementById('program').innerHTML = days.map(d => \`
      <section class="day">
        <h2>\${d.title || 'День ' + d.day_number} — \${d.day_date}</h2>
        \${sessions.filter(s => s.day === d.day_number).map(s => \`
          <div class="session">
            <time>\${s.start_time}–\${s.end_time} МСК</time>
            <h3>\${s.title}</h3>
            \${s.speaker ? \`
              <div class="speaker">
                <img src="\${s.speaker.photo_url}" alt="\${s.speaker.name}" />
                <b>\${s.speaker.name}</b>
                <span>\${s.speaker.title || ''}</span>
              </div>
            \` : ''}
          </div>
        \`).join('')}
      </section>
    \`).join('');
  });
</script>`

const AI_PROMPT = `Я делаю лендинг события на платформе iViSiON: ПЛЮСОН. У ПЛЮСОНа есть публичный JSON-эндпоинт, который отдаёт актуальную программу события — этапы, дни, сессии со спикерами. Тебе нужно встроить его на мой лендинг, чтобы при изменении программы в ПЛЮСОНе лендинг обновлялся автоматически в течение минуты.

ID события: ID-ИЛИ-SLUG-СОБЫТИЯ
(подставь сюда число — ID события из URL дашборда, например 24. Эндпоинт также принимает slug, но используй ID — он не меняется при переименовании.)

Стек лендинга: ВАШ-СТЕК (Tilda HTML-блок / GetCourse «Произвольный код» / Next.js на Vercel / статический HTML / другой)

ЭНДПОИНТ
GET https://pluson.ru/api/v1/public/landing-widget/events/{ID}/program

Авторизация не нужна, CORS открыт для любого домена, кэш 60 секунд.

Ответ:
{
  "event_slug": "...",
  "stages": [   // верхний уровень (опц., обычно используется в турнирах)
    { "id": 1, "sort_order": 0, "title": "Предстарт",
      "subtitle": null, "description": "...",
      "start_date": "2026-07-09", "end_date": "2026-07-22" }
  ],
  "days": [
    { "id": 33, "day_number": 1, "day_date": "2026-07-23",
      "open_time": "10:00", "close_time": "18:00",
      "stage_id": 2, "title": "День 1. Открытие" }
  ],
  "sessions": [
    {
      "id": 201, "day": 1,
      "start_time": "11:00", "end_time": "11:30",
      "title": "Открытие конференции",
      "gift_description": null,
      "track_id": null, "sort_order": 0,
      "speaker_event_id": 142, "speaker_role": "organizer",
      "speaker": {
        "id": 17, "name": "Марго Форбс",
        "title": "Основатель и креатор чемпионата",
        "photo_url": "...",
        "achievements": ["..."],
        "tg_channel_url": "...",
        "vk_url": null, "max_url": null,
        "instagram_url": null, "website_url": null,
        "media_assets": [ { "platform": "tg", "subscribers": 12500 } ]
      }
    }
  ]
}

ВАЖНО ПРО ВРЕМЯ
- start_time, end_time, open_time, close_time — строки HH:MM по московскому времени.
- На лендинге приписывай « МСК» сам. НЕ оборачивай в new Date() — никаких таймзон.

ИЕРАРХИЯ
- Если stages пустой → обычная конференция, рендери просто days → sessions.
- Если stages есть → группируй дни по stage_id (для турниров с этапами «Предстарт» / «Основной»).
- session.day = day_number того дня — связывай сессии с днями через это поле.
- session.speaker может быть null — сессия без спикера (открытие, кофе-брейк), просто title + время.

ЧТО ОТ ТЕБЯ НУЖНО
1. Сверстай блок «Программа» под мой дизайн (этапы → дни → сессии).
2. На странице делай fetch() к эндпоинту, рендери из JSON.
3. К каждой сессии прикрепи мини-карточку спикера (фото, имя, должность) если speaker !== null.
4. Не хардкодь — программа меняется.

EDGE-CASES
- 404 на bad slug → понятная ошибка для юзера.
- sessions[i].speaker === null → не рендери блок спикера.
- gift_description заполнен → покажи как «🎁 Подарок: ...» или иконкой.
- day.title === null → fallback «День N» по day_number.

МИНИМАЛЬНЫЙ ПРИМЕР
<div id="program"></div>
<script>
const SLUG = 'ID-ИЛИ-SLUG-СОБЫТИЯ';
fetch(\`https://pluson.ru/api/v1/public/landing-widget/events/\${SLUG}/program\`)
  .then(r => r.json())
  .then(({ days, sessions }) => {
    document.getElementById('program').innerHTML = days.map(d => \`
      <section class="day">
        <h2>\${d.title || 'День ' + d.day_number} — \${d.day_date}</h2>
        \${sessions.filter(s => s.day === d.day_number).map(s => \`
          <div class="session">
            <time>\${s.start_time}–\${s.end_time} МСК</time>
            <h3>\${s.title}</h3>
            \${s.speaker ? \`
              <div class="speaker">
                <img src="\${s.speaker.photo_url}" alt="\${s.speaker.name}" />
                <b>\${s.speaker.name}</b>
                <span>\${s.speaker.title || ''}</span>
              </div>
            \` : ''}
          </div>
        \`).join('')}
      </section>
    \`).join('');
  });
</script>

Готов помогать — покажи свой текущий HTML/код или дизайн, я подключу эндпоинт.`

export default function ProgramWidgetHelpPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2">
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700 inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Инструкции
        </Link>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <Calendar size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>
            Виджет «Программа события» для своего лендинга
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Этапы → дни → сессии. К каждой сессии прикрепляется спикер с фото и должностью.
            На вашем лендинге обновляется автоматически в течение минуты после изменений в ПЛЮСОНе.
          </p>
        </div>
      </div>

      <div className="space-y-6">

        {/* Готовый промпт для AI */}
        <section className="rounded-2xl p-5 border-2" style={{ borderColor: PEACH, background: `linear-gradient(135deg, #fff9f0, #fff)` }}>
          <div className="flex items-start gap-3 mb-3">
            <Sparkles size={20} style={{ color: '#c98b54' }} className="flex-shrink-0 mt-1" />
            <div>
              <h2 className="font-bold text-lg" style={{ color: BRAND }}>Промпт для нейросети</h2>
              <p className="text-sm text-gray-700 mt-1 leading-snug">
                Скопируйте, замените <code className="bg-white border border-gray-200 rounded px-1.5 py-0.5 text-xs">ID-ИЛИ-SLUG-СОБЫТИЯ</code> и
                {' '}<code className="bg-white border border-gray-200 rounded px-1.5 py-0.5 text-xs">ВАШ-СТЕК</code> на свои значения —
                и вставьте в Claude / ChatGPT / Cursor. Нейросеть подключит эндпоинт к вашему лендингу.
              </p>
            </div>
          </div>
          <CodeBlock code={AI_PROMPT} lang="prompt" />
        </section>

        {/* Что это и зачем */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Что это</h2>
          <p className="text-sm text-gray-700 leading-relaxed mb-3">
            Публичный JSON-эндпоинт, который отдаёт всю программу события: этапы (для турниров),
            дни, сессии со временами и привязанными спикерами. Встраивается на любой лендинг —
            Tilda, GetCourse, Vercel, статический HTML.
          </p>
          <p className="text-sm text-gray-700 leading-relaxed">
            <b>Главный плюс:</b> двигаете сессию в ПЛЮСОНе — лендинг подхватывает изменение через минуту.
            Не нужно вручную править расписание в конструкторе сайта.
          </p>
        </section>

        {/* Подготовка */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Шаг 1. Заполните программу</h2>
          <ol className="list-decimal pl-5 space-y-2 text-sm text-gray-700">
            <li>
              На странице события откройте вкладку «Программа». Создайте этапы (для турниров — опционально),
              дни и сессии. К каждой сессии можно привязать спикера.
            </li>
            <li>
              Спикеров заранее заполните в <Link href="/dashboard/collaborations" className="text-blue-600 hover:underline">«Коллаборациях»</Link>
              {' '}и привяжите к событию во вкладке «Спикеры». Их фото, имя и должность подтянутся автоматически.
            </li>
            <li>
              <b>Возьмите ID или slug события.</b> Эндпоинт принимает оба.
              <ul className="list-disc pl-5 mt-1.5 space-y-1">
                <li>
                  <b>ID</b> (рекомендуется) — число в URL дашборда события:{' '}
                  <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">pluson.ru/dashboard/events/<b>24</b></code>.
                  ID не меняется никогда — даже если переименуете slug, лендинг не сломается.
                </li>
                <li>
                  <b>Slug</b> — код в публичной ссылке:{' '}
                  <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">pluson.ru/l/<b>cygum</b></code>.
                </li>
              </ul>
            </li>
          </ol>
        </section>

        {/* Эндпоинт */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Шаг 2. Эндпоинт</h2>
          <CodeBlock
            code={`GET https://pluson.ru/api/v1/public/landing-widget/events/{ID-или-SLUG}/program

# по ID (рекомендуется — не сломается при смене slug):
GET https://pluson.ru/api/v1/public/landing-widget/events/24/program

# по slug (тоже работает):
GET https://pluson.ru/api/v1/public/landing-widget/events/cygum/program`}
            lang="GET"
          />
          <p className="text-xs text-gray-500 mb-2">Ответ — этапы / дни / сессии с прикреплёнными спикерами:</p>
          <CodeBlock code={SAMPLE_JSON} lang="JSON" />
        </section>

        {/* Минимальный пример */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Шаг 3. Минимальный пример</h2>
          <p className="text-sm text-gray-700 mb-3">Вставьте на свой лендинг:</p>
          <CodeBlock code={SAMPLE_HTML} lang="HTML" />
          <p className="text-xs text-gray-500 mt-2">
            Замените <code className="bg-gray-100 px-1.5 py-0.5 rounded">ID-ИЛИ-SLUG-СОБЫТИЯ</code> на slug.
            Дизайн правьте под свой бренд — JSON остаётся тем же.
          </p>
        </section>

        {/* Детали */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Детали</h2>
          <div className="space-y-3 text-sm text-gray-700">
            <div>
              <b style={{ color: BRAND }}>Этапы (stages).</b> Используются в турнирах с разными фазами
              («Предстарт», «Основной этап»). Если у вашего события этапов нет — массив{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">stages</code> будет пустым,
              просто рендерите дни напрямую.
            </div>
            <div>
              <b style={{ color: BRAND }}>Связь сессий с днями.</b>{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">session.day</code> = number дня
              (<code className="bg-gray-100 px-1 rounded text-xs">days[i].day_number</code>). Через это поле фильтруйте сессии по дням.
            </div>
            <div>
              <b style={{ color: BRAND }}>Связь дней с этапами.</b>{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">days[i].stage_id</code> →{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">stages[j].id</code>. Если{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">null</code> — день «свободный», вне этапов.
            </div>
            <div>
              <b style={{ color: BRAND }}>Время.</b> Все времена —{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">"HH:MM"</code> по МСК.
              На лендинге приписывайте « МСК» сами. <b>Никаких</b>{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">new Date()</code> и таймзон.
            </div>
            <div>
              <b style={{ color: BRAND }}>Спикер сессии.</b> Поле{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">session.speaker</code> — карточка с фото, именем,
              регалиями и медийными активами. Если null — сессия без спикера (открытие, кофе-брейк).
            </div>
            <div>
              <b style={{ color: BRAND }}>Кэш.</b> Ответ кешируется на 60 секунд — изменения подхватятся в течение минуты.
            </div>
          </div>
        </section>

      </div>
    </div>
  )
}
