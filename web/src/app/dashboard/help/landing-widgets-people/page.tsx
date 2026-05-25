'use client'
import Link from 'next/link'
import { useState } from 'react'
import { ArrowLeft, Copy, Check, Users, Sparkles } from 'lucide-react'

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
      "topic": null,
      "tg_channel_url": "https://t.me/margo_forbs_pro",
      "vk_url": null, "max_url": null,
      "instagram_url": null, "website_url": null,
      "knowledge_base_title": null,
      "knowledge_base_url": null,
      "media_assets": [
        { "platform": "tg",        "subscribers": 12500 },
        { "platform": "youtube",   "subscribers": 3400 },
        { "platform": "instagram", "subscribers": 8900 }
      ],
      "ref_code": "abc123",
      "sort_order": 0,
      "priority": 10
    }
  ],
  "jury":     [ /* ... */ ],
  "speakers": [ /* ... */ ],
  "partners": [ /* ... */ ]
}`

const SAMPLE_HTML = `<div id="speakers" class="grid"></div>

<script>
const SLUG = 'ID-ИЛИ-SLUG-СОБЫТИЯ';
fetch(\`https://pluson.ru/api/v1/public/landing-widget/events/\${SLUG}/collaborators\`)
  .then(r => r.json())
  .then(({ speakers, jury, organizers, partners }) => {
    document.getElementById('speakers').innerHTML = speakers.map(s => \`
      <article class="card">
        <img src="\${s.photo_url}" alt="\${s.name}" />
        <h3>\${s.name}</h3>
        <p>\${s.position || ''}</p>
        <ul>
          \${(s.achievements || []).map(a => \`<li>\${a}</li>\`).join('')}
        </ul>
        <div>
          \${(s.media_assets || []).map(m =>
            \`<span>\${m.platform}: \${m.subscribers.toLocaleString('ru-RU')}</span>\`
          ).join(' · ')}
        </div>
      </article>
    \`).join('');
  });
</script>`

const AI_PROMPT = `Я делаю лендинг события на платформе iViSiON: ПЛЮСОН. У ПЛЮСОНа есть публичный JSON-эндпоинт, который отдаёт актуальные данные коллабораторов события — спикеров, жюри, организаторов и партнёров. Тебе нужно встроить его на мой лендинг, чтобы при изменении данных в ПЛЮСОНе лендинг обновлялся автоматически в течение минуты.

ID события: ID-ИЛИ-SLUG-СОБЫТИЯ
(подставь сюда число — ID события из URL дашборда, например 24. Эндпоинт также принимает slug, но используй ID — он не меняется при переименовании.)

Стек лендинга: ВАШ-СТЕК (Tilda HTML-блок / GetCourse «Произвольный код» / Next.js на Vercel / статический HTML / другой)

ЭНДПОИНТ
GET https://pluson.ru/api/v1/public/landing-widget/events/{ID}/collaborators

Авторизация не нужна, CORS открыт для любого домена, кэш 60 секунд.

Ответ — JSON с 4 группами:
{
  "event_slug": "...",
  "organizers": [Card, ...],
  "jury":       [Card, ...],
  "speakers":   [Card, ...],   // role=speaker + role=headliner
  "partners":   [Card, ...]    // role=partner + role=general_partner
}

Структура Card:
{
  "id": 142,
  "collaborator_id": 17,
  "name": "Марго Форбс",
  "title": "Основатель и креатор чемпионата",
  "position": "Основатель и креатор чемпионата",
  "photo_url": "https://.../margo.jpg",
  "poster_url": "https://.../margo-poster.jpg",
  "achievements": ["Регалия 1", "Регалия 2"],
  "role": "organizer",
  "is_commercial": false,
  "topic": null,
  "tg_channel_url": "https://t.me/...",
  "vk_url": null, "max_url": null,
  "instagram_url": null, "website_url": null,
  "knowledge_base_title": null, "knowledge_base_url": null,
  "media_assets": [
    { "platform": "tg",      "subscribers": 12500 },
    { "platform": "youtube", "subscribers": 3400 }
  ],
  "ref_code": "abc123",
  "sort_order": 0, "priority": 10
}

Платформы в media_assets: tg / youtube / vk / tiktok / instagram / max / rutube
Лейблы для UI: Telegram / YouTube / VK / TikTok / Instagram / MAX / RuTube

Сортировка внутри группы уже выполнена на бэке — рендери в полученном порядке.

ЧТО ОТ ТЕБЯ НУЖНО
1. Сверстай блоки «Спикеры», «Жюри», «Организаторы», «Партнёры» под мой дизайн.
2. На странице делай fetch() к эндпоинту, рендери из JSON.
3. Не хардкодь данные — спикеры могут меняться.
4. Опционально: посчитай совокупный охват — сумма subscribers по всем media_assets всех коллабораторов. Покажи в шапке «Совокупный охват: X подписчиков».

EDGE-CASES
- Пустой массив в группе → не рендери заголовок группы.
- photo_url === null → fallback на placeholder или скрой карточку.
- achievements может быть [] → не рендери список.
- 404 на bad slug → понятная ошибка для юзера.

МИНИМАЛЬНЫЙ ПРИМЕР
<div id="speakers" class="grid"></div>
<script>
const SLUG = 'ID-ИЛИ-SLUG-СОБЫТИЯ';
fetch(\`https://pluson.ru/api/v1/public/landing-widget/events/\${SLUG}/collaborators\`)
  .then(r => r.json())
  .then(({ speakers }) => {
    document.getElementById('speakers').innerHTML = speakers.map(s => \`
      <article class="card">
        <img src="\${s.photo_url}" alt="\${s.name}" />
        <h3>\${s.name}</h3>
        <p>\${s.position || ''}</p>
        <ul>\${(s.achievements || []).map(a => \`<li>\${a}</li>\`).join('')}</ul>
        <div>\${(s.media_assets || []).map(m =>
          \`<span>\${m.platform}: \${m.subscribers.toLocaleString('ru-RU')}</span>\`
        ).join(' · ')}</div>
      </article>
    \`).join('');
  });
</script>

Готов помогать — покажи свой текущий HTML/код или дизайн, я подключу эндпоинт.`

export default function PeopleWidgetHelpPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2">
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700 inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Инструкции
        </Link>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <Users size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>
            Виджет «Люди события» для своего лендинга
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Спикеры, жюри, организаторы, партнёры — с фото, регалиями, медийными активами.
            На вашем лендинге обновляются автоматически в течение минуты после изменений в ПЛЮСОНе.
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
            Публичный JSON-эндпоинт, который отдаёт всех коллабораторов вашего события одним запросом.
            Можно встроить на свой лендинг на Tilda, GetCourse, Vercel, любой статический сайт — всё,
            что умеет делать <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">fetch()</code>.
          </p>
          <p className="text-sm text-gray-700 leading-relaxed">
            <b>Главный плюс:</b> правите карточку спикера в ПЛЮСОНе — лендинг подтягивает свежие данные
            автоматически. Не нужно копировать фото и регалии руками в конструктор.
          </p>
        </section>

        {/* Подготовка данных */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Шаг 1. Подготовьте данные в ПЛЮСОНе</h2>
          <ol className="list-decimal pl-5 space-y-2 text-sm text-gray-700">
            <li>
              Откройте <Link href="/dashboard/collaborations" className="text-blue-600 hover:underline">«Коллаборации»</Link> и
              у каждого человека заполните: фото, должность, регалии, соцсети, медийные активы (подписчики по площадкам).
            </li>
            <li>
              Привяжите коллабораторов к событию во вкладке «Спикеры» (конференции/турниры) или «Соорганизаторы»
              (мероприятия). Установите роль: организатор / жюри / хедлайнер / спикер / партнёр / генеральный партнёр.
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
                  Виден во вкладке «Основное». Меняется при правке поля «Код ссылки».
                </li>
              </ul>
            </li>
          </ol>
        </section>

        {/* Эндпоинт */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Шаг 2. Эндпоинт</h2>
          <CodeBlock
            code={`GET https://pluson.ru/api/v1/public/landing-widget/events/{ID-или-SLUG}/collaborators

# по ID (рекомендуется — не сломается при смене slug):
GET https://pluson.ru/api/v1/public/landing-widget/events/24/collaborators

# по slug (тоже работает):
GET https://pluson.ru/api/v1/public/landing-widget/events/cygum/collaborators`}
            lang="GET"
          />
          <p className="text-xs text-gray-500 mb-2">Ответ — 4 группы:</p>
          <CodeBlock code={SAMPLE_JSON} lang="JSON" />
        </section>

        {/* Минимальный пример */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Шаг 3. Минимальный пример</h2>
          <p className="text-sm text-gray-700 mb-3">
            Вставьте на свой лендинг (Tilda HTML-блок, GetCourse «Произвольный код», свой Vercel-сайт):
          </p>
          <CodeBlock code={SAMPLE_HTML} lang="HTML" />
          <p className="text-xs text-gray-500 mt-2">
            Замените <code className="bg-gray-100 px-1.5 py-0.5 rounded">ID-ИЛИ-SLUG-СОБЫТИЯ</code> на slug.
            Дизайн карточек правьте под свой бренд — JSON остаётся тем же.
          </p>
        </section>

        {/* Детали */}
        <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-bold text-lg mb-3" style={{ color: BRAND }}>Детали</h2>
          <div className="space-y-3 text-sm text-gray-700">
            <div>
              <b style={{ color: BRAND }}>Группировка.</b>{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">organizers</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">jury</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">speakers</code> (хедлайнеры + обычные спикеры),{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">partners</code> (генеральные + обычные).
              В карточке есть <code className="bg-gray-100 px-1 rounded text-xs">role</code> и{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">is_commercial</code> — если нужно сгруппировать иначе.
            </div>
            <div>
              <b style={{ color: BRAND }}>Порядок.</b> Внутри группы — без приоритета коммерческих:
              сначала те, кто привёл больше людей по своей реф-ссылке, потом — по полю «Приоритет»
              в карточке коллаба (меньше = выше).
            </div>
            <div>
              <b style={{ color: BRAND }}>Медийные активы.</b> Массив{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">media_assets</code> — подписчики по площадкам.
              Платформы: <code className="bg-gray-100 px-1 rounded text-xs">tg</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">youtube</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">vk</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">tiktok</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">instagram</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">max</code>,{' '}
              <code className="bg-gray-100 px-1 rounded text-xs">rutube</code>.
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
