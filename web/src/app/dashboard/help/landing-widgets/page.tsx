'use client'
import Link from 'next/link'
import { useState } from 'react'
import { ArrowLeft, Copy, Check, Code2 } from 'lucide-react'

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
        <div className="absolute top-2 left-3 text-[10px] font-mono uppercase text-gray-400 tracking-wider z-10">
          {lang}
        </div>
      )}
      <button
        onClick={copy}
        className="absolute top-2 right-2 px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-xs text-white flex items-center gap-1 z-10"
      >
        {copied ? <><Check size={11} /> Скопировано</> : <><Copy size={11} /> Копировать</>}
      </button>
      <pre className="bg-gray-900 text-gray-100 rounded-xl px-4 py-3.5 pt-7 overflow-x-auto text-xs leading-relaxed font-mono">
        <code>{code}</code>
      </pre>
    </div>
  )
}

const SAMPLE_COLLABORATORS = `{
  "event_slug": "ivision-8-n5u2u",
  "organizers": [
    {
      "id": 142,
      "collaborator_id": 17,
      "name": "Марго Форбс",
      "title": "Основатель и креатор чемпионата",
      "position": "Основатель и креатор чемпионата",
      "photo_url": "https://pub.../margo.jpg",
      "poster_url": "https://pub.../margo-poster.jpg",
      "achievements": [
        "Нелинейный стратег в маркетинге и продажах",
        "Создатель ВИДЕНИЕ / iViSiON · 7 конференций · 50+ лидеров рынка"
      ],
      "role": "organizer",
      "is_commercial": false,
      "tg_channel_url": "https://t.me/margo_forbs_pro",
      "vk_url": null, "max_url": null,
      "instagram_url": null, "website_url": null,
      "media_assets": [
        { "platform": "tg",        "subscribers": 12500 },
        { "platform": "youtube",   "subscribers": 3400 },
        { "platform": "instagram", "subscribers": 8900 }
      ],
      "topic": null,
      "knowledge_base_title": null,
      "knowledge_base_url": null,
      "ref_code": "abc123",
      "sort_order": 0,
      "priority": 10
    }
  ],
  "jury": [ /* ... */ ],
  "speakers": [ /* ... */ ],
  "partners": [ /* ... */ ]
}`

const SAMPLE_PROGRAM = `{
  "event_slug": "ivision-8-n5u2u",
  "stages": [
    { "id": 1, "sort_order": 0, "title": "Предстарт",
      "subtitle": null, "description": "2 недели разогрева",
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
        "photo_url": "https://pub.../margo.jpg",
        "achievements": [ "..." ],
        "tg_channel_url": "https://t.me/margo_forbs_pro",
        "vk_url": null, "max_url": null,
        "instagram_url": null, "website_url": null,
        "media_assets": [ { "platform": "tg", "subscribers": 12500 } ]
      }
    }
  ]
}`

const SAMPLE_HTML = `<!-- Куда вставить карточки -->
<div id="speakers"></div>

<script>
fetch('https://pluson.ru/api/v1/public/landing-widget/events/ВАШ-SLUG-СОБЫТИЯ/collaborators')
  .then(r => r.json())
  .then(({ speakers, jury, organizers, partners }) => {
    const root = document.getElementById('speakers');
    root.innerHTML = speakers.map(s => \`
      <div class="card">
        <img src="\${s.photo_url}" alt="\${s.name}">
        <h3>\${s.name}</h3>
        <p>\${s.position || ''}</p>
        <ul>
          \${(s.achievements || []).map(a => \`<li>\${a}</li>\`).join('')}
        </ul>
        \${(s.media_assets || []).map(m =>
          \`<span>\${m.platform}: \${m.subscribers.toLocaleString()}</span>\`
        ).join(' · ')}
      </div>
    \`).join('');
  });
</script>`

export default function LandingWidgetsHelpPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2">
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700 inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Инструкции
        </Link>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <Code2 size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Виджеты для своего лендинга</h1>
          <p className="text-sm text-gray-500 mt-1">
            Подтягивайте спикеров, жюри, организаторов, партнёров и программу события на свой сайт автоматически.
            При изменении данных в ПЛЮСОНе ваш лендинг обновится сам в течение минуты.
          </p>
        </div>
      </div>

      <div className="space-y-6">

        {/* Что это и зачем */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Что это</h2>
          <p className="text-sm text-gray-700 leading-relaxed mb-3">
            Два публичных JSON-эндпоинта, которые отдают данные вашего события — спикеров, программу,
            медийные активы. Можно встроить на свой лендинг на Tilda, GetCourse, Vercel или любой другой
            сайт — всё, что умеет делать <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">fetch()</code>.
          </p>
          <p className="text-sm text-gray-700 leading-relaxed">
            <b>Главный плюс:</b> правите карточку спикера или программу в ПЛЮСОНе — лендинг подтягивает
            свежие данные автоматически. Не нужно копировать фото и регалии руками в конструктор.
          </p>
        </section>

        {/* Что нужно сделать в ПЛЮСОНе */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Шаг 1. Подготовьте данные в ПЛЮСОНе</h2>
          <ol className="list-decimal pl-5 space-y-2 text-sm text-gray-700">
            <li>
              Откройте раздел <Link href="/dashboard/collaborations" className="text-blue-600 hover:underline">«Коллаборации»</Link> и
              у каждого спикера/жюри/организатора/партнёра заполните: фото, должность, регалии, соцсети,
              медийные активы (подписчики по площадкам).
            </li>
            <li>
              Привяжите коллабораторов к событию во вкладке «Спикеры» (конференции/турниры) или «Соорганизаторы»
              (мероприятия). Установите роль: организатор / жюри / спикер / партнёр.
            </li>
            <li>
              Заполните <b>программу события</b> во вкладке «Программа»: этапы → дни → сессии.
              К каждой сессии можно привязать спикера.
            </li>
            <li>
              Скопируйте <b>slug события</b> — это код в URL события на лендинге.
              Например, для <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">pluson.ru/l/ivision-8-n5u2u</code> slug
              это <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">ivision-8-n5u2u</code>. Slug виден во вкладке
              «Основное» события.
            </li>
          </ol>
        </section>

        {/* Эндпоинты */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Шаг 2. Эндпоинты</h2>
          <p className="text-sm text-gray-700 mb-4">
            Два публичных GET-запроса. Авторизация не нужна — данные публичные. CORS открыт для любого домена.
          </p>

          <h3 className="font-semibold text-sm text-gray-900 mb-2 mt-4">Спикеры, жюри, организаторы, партнёры:</h3>
          <CodeBlock
            code={`GET https://pluson.ru/api/v1/public/landing-widget/events/{SLUG}/collaborators`}
            lang="GET"
          />
          <p className="text-xs text-gray-500 mb-2">Ответ — 4 группы:</p>
          <CodeBlock code={SAMPLE_COLLABORATORS} lang="JSON" />

          <h3 className="font-semibold text-sm text-gray-900 mb-2 mt-6">Программа события:</h3>
          <CodeBlock
            code={`GET https://pluson.ru/api/v1/public/landing-widget/events/{SLUG}/program`}
            lang="GET"
          />
          <p className="text-xs text-gray-500 mb-2">Ответ — этапы / дни / сессии с прикреплёнными спикерами:</p>
          <CodeBlock code={SAMPLE_PROGRAM} lang="JSON" />
        </section>

        {/* Минимальный пример HTML */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Шаг 3. Минимальный пример</h2>
          <p className="text-sm text-gray-700 mb-3">
            Вставьте на свой лендинг (Tilda HTML-блок, GetCourse «Произвольный код», свой Vercel-сайт, что угодно):
          </p>
          <CodeBlock code={SAMPLE_HTML} lang="HTML" />
          <p className="text-xs text-gray-500 mt-2">
            Замените <code className="bg-gray-100 px-1.5 py-0.5 rounded">ВАШ-SLUG-СОБЫТИЯ</code> на slug своего события.
            Дизайн карточек правьте под свой бренд — JSON остаётся тем же.
          </p>
        </section>

        {/* Детали */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Детали</h2>
          <div className="space-y-3 text-sm text-gray-700">
            <div>
              <b style={{ color: BRAND }}>Группировка в коллабораторах.</b>{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">organizers</code> — организаторы;{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">jury</code> — жюри;{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">speakers</code> — хедлайнеры и обычные спикеры;{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">partners</code> — генеральные и обычные партнёры.
              В карточке есть поля <code className="bg-gray-100 px-1 rounded text-xs">role</code> и{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">is_commercial</code> — если нужно сгруппировать иначе.
            </div>
            <div>
              <b style={{ color: BRAND }}>Порядок.</b> Внутри группы — наша стандартная сортировка
              без приоритета коммерческих: сначала те, кто привёл больше людей через свою реф-ссылку,
              потом — по полю «Приоритет» в карточке коллаба (меньше = выше).
            </div>
            <div>
              <b style={{ color: BRAND }}>Медийные активы.</b> Массив{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">media_assets</code> в каждой карточке —
              подписчики по площадкам. Платформы:{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">tg</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">youtube</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">vk</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">tiktok</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">instagram</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">max</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">rutube</code>.
              Можете показывать как «Совокупный охват N подписчиков» — просуммировав поле{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">subscribers</code> со всех карточек.
            </div>
            <div>
              <b style={{ color: BRAND }}>Время.</b> Все времена в программе в формате{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">HH:MM</code> по московскому времени —
              приписывайте на лендинге « МСК» сами.
            </div>
            <div>
              <b style={{ color: BRAND }}>Кэш.</b> Ответ кешируется на 60 секунд. Изменили карточку
              в ПЛЮСОНе — лендинг подхватит в течение минуты.
            </div>
          </div>
        </section>

        {/* Когда использовать */}
        <section className="rounded-2xl p-5" style={{ background: `linear-gradient(135deg, #fff4e0, ${PEACH}55)` }}>
          <h2 className="font-bold text-base mb-2" style={{ color: BRAND }}>💡 Идея</h2>
          <p className="text-sm text-gray-700">
            Этот же подход работает для AI-генерации лендингов. Дайте нейросети (Claude, ChatGPT, Cursor)
            ссылку на эту инструкцию + slug своего события — она сама сгенерит HTML, который дёргает наш API.
            Дизайн меняется свободно — данные всегда свежие.
          </p>
        </section>

      </div>
    </div>
  )
}
