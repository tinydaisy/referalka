'use client'
import { useState } from 'react'
import { Copy, Check, ChevronDown, Download, Image as ImageIcon } from 'lucide-react'

// Афиши лежат в служебном хранилище (R2). Позже переедут в общее облако —
// тогда меняется только этот адрес, разметка остаётся как есть.
const POSTER_BASE = 'https://pub-519fc43b54e1489384397c9cea0c0ded.r2.dev/partner-materials'

const POSTERS = [
  { id: 'collab-1', title: 'Круг экспертов', file: 'collab-poster-1.jpg' },
  { id: 'collab-2', title: 'Круг экспертов — вариант 2', file: 'collab-poster-2.jpg' },
]

interface Material {
  id: string
  situation: string   // «когда это отправлять» — по нему человек и ищет глазами
  audience: string
  note?: string       // как работает / что поправить под себя
  body: string        // {LINK} заменяется реальной реф-ссылкой
  steps?: { title: string; lines: string[] }[]  // для схемы разговора
}

const COLLAB_TEXTS: Material[] = [
  {
    id: 'collab-invite',
    situation: 'Зову эксперта в Коллабораторную',
    audience: 'Личные сообщения, сторис, посты',
    body: `Ищу экспертов для совместных эфиров. Обмен аудиторией без затрат на рекламу.

Меняемся аудиториями на эфирах и регистрациях — система считает, кто сколько привёл.

Делюсь контактами экспертов от 150 до 10 000 подписчиков, открытых к коллаборациям.

Дарю 30 дней платформы для привлечения клиентов.

Переходите по ссылке и напишите мне.

{LINK}`,
  },
  {
    id: 'collab-networking',
    situation: 'Знакомлюсь на нетворкинге',
    audience: 'Живые и зум-нетворкинги, конференции',
    note: 'Главное — пятый шаг. Вы не просите контакт, вы просите написать вам, чтобы отдать обещанное. Человек сам начинает переписку, и она стартует с вашей пользы. Без этого шага контакт теряется в тот же вечер.',
    steps: [
      { title: 'Шаг 1. Спросите про него', lines: ['— Привет! Чем занимаешься?', '— О, класс!'] },
      { title: 'Шаг 2. Коротко про себя', lines: ['— А я в теме психологии развиваюсь. Сейчас делаем то-то и то-то для таких-то людей.'] },
      { title: 'Шаг 3. Переход к ценности', lines: ['— Тебе клиенты нужны?'] },
      { title: 'Шаг 4. Предложение', lines: ['— Могу дать контакты экспертов от 150 до 10 000 подписчиков, кто открыт к коллаборациям по обмену аудиториями. Можешь привлекать клиентов без вложений.'] },
      { title: 'Шаг 5. Фиксация контакта', lines: ['— Напиши мне слово КОЛЛАБ прямо сейчас, чтобы я тебя не потеряла. Я тебе после нетворкинга скину. Ок? Договорились?'] },
    ],
    body: `Привет! Чем занимаешься? О, класс!

А я в теме психологии развиваюсь. Сейчас делаем то-то и то-то для таких-то людей.

Тебе клиенты нужны? Могу дать контакты экспертов от 150 до 10 000 подписчиков, кто открыт к коллаборациям по обмену аудиториями. Можешь привлекать клиентов без вложений.

Напиши мне слово КОЛЛАБ прямо сейчас, чтобы я тебя не потеряла. Я тебе после нетворкинга скину. Ок? Договорились?`,
  },
  {
    id: 'collab-request',
    situation: 'Предлагаю коллаборацию конкретному эксперту',
    audience: 'Личные сообщения',
    note: 'Заполните свои каналы и охваты честно, без округления вверх. Если эфиров ещё не проводили — напишите охват канала, а не выдуманный прогноз. Обычно приходят с «давайте что-нибудь замутим» — вы приходите с цифрами и с доступом, который отдаёте партнёру.',
    body: `Привет! Предлагаю сделать совместный эфир — обмен аудиториями.

Что я приношу:
— мои медийные активы: [перечислите каналы и число подписчиков]
— в среднем на совместный эфир привожу [число] человек
— я состою в Коллабораторной — могу дать контакты других экспертов, открытых к коллаборациям, и доступ к среде

Всё привлечение автоматизировано: видно, кто сколько привёл, ничего не надо считать руками.

Как вам идея?`,
  },
]

const PLUSON_TEXTS: Material[] = [
  {
    id: 'pluson-organizer',
    situation: 'Пишу организатору премии или фестиваля',
    audience: 'Тем, кто проводит премии, конференции, чемпионаты',
    note: 'Начинается с вопроса про него, а не с рассказа про себя. «Премию» замените на то, что человек реально проводит. Если не участвовали в чемпионате спикеров — уберите этот абзац или напишите «Знаю, Международный чемпионат спикеров был». Не приписывайте себе чужой опыт.',
    body: `Привет! А вы премию как проводите? Оценки жюри, этапы, подсчёт баллов уже автоматизированы или всё руками в табличках?

Спрашиваю, потому что сейчас осваиваю платформу iViSiON: ПЛЮСОН как эксперт. И там сильная часть именно под премии, фестивали и конференции — у жюри свой кабинет с критериями и оценками, турнирная таблица и этапы считаются сами, у спикеров свои кабинеты.

Я участвовала в большом Международном чемпионате спикеров — и там всё было сделано на этой платформе: и оценки жюри, и программа выступлений.

Может вам пригодится? Если интересно — могу познакомить с основателем, Марго Форбс. Знаю, что она любит коллаборироваться и открыта к партнёрствам.`,
  },
  {
    id: 'pluson-chat',
    situation: 'Отдаю пользу в чат или в личку',
    audience: 'Чаты экспертов, нетворкинг-группы',
    note: 'Абзац про чемпионат спикеров замените на свой опыт пользования платформой или удалите. «Начала осваивать» → «начал осваивать», если вы мужчина.',
    body: `Привет! Может кому пригодится для поиска клиентов?

Я тут начала осваивать платформу для привлечения клиентов — iViSiON: ПЛЮСОН. Очень прикольная, и много чего именно под нас, экспертов.

Я когда в чемпионате спикеров участвовала — мы на этой платформе себе чат-боты создавали и подписчиков собирали.

Готовые воронки, боты, рассылки, лендинги — всё в одном месте. Есть даже интересная Коллабораторная для автоматизации совместных эфиров и поиска клиентов без вложений в маркетинг.

Могу поделиться ссылкой. Сейчас у них акция — месяц доступа без оплаты.

{LINK}`,
  },
  {
    id: 'pluson-bonus',
    situation: 'Добавляю ценность к своему продукту',
    audience: 'Своим клиентам — в описание услуги, курса, наставничества',
    note: 'Вы ничего не тратите — просто добавляете то, что у вас уже есть. Работает как бонус к покупке, подарок за регистрацию на вебинар, ценность в переговорах вместо скидки и повод написать холодному контакту.',
    body: `В подарок к [вашему продукту]:

30 дней платформы iViSiON: ПЛЮСОН для привлечения клиентов.

Готовые воронки, боты, рассылки, лендинги — всё в одном месте. Плюс Коллабораторная: контакты экспертов, открытых к обмену аудиториями, и автоматизация совместных эфиров.

Ссылку пришлю после оплаты.`,
  },
]

const RULES = [
  'Не приписывайте себе чужой опыт. Не участвовали в чемпионате — уберите этот абзац.',
  'Сначала вопрос про собеседника, потом про себя. Ни один текст не начинается с «я предлагаю».',
  'Заканчивайте действием. Не «если интересно, дай знать», а «напиши мне слово КОЛЛАБ».',
  'Отправляйте в тот же вечер. Через три дня контекст знакомства уже остыл.',
]

function MaterialCard({ m, link }: { m: Material; link: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  // ⚠️ Ссылка подставляется САМА. Иначе партнёр копирует текст, отправляет
  // и только потом замечает, что вместо ссылки уехал плейсхолдер.
  const text = m.body.replace(/\{LINK\}/g, link)

  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-gray-50 transition-colors"
      >
        <ChevronDown
          size={18}
          className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : '-rotate-90'}`}
        />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-gray-900 text-sm">{m.situation}</div>
          <div className="text-xs text-gray-400 mt-0.5">{m.audience}</div>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {m.note && (
            <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 leading-relaxed">
              {m.note}
            </p>
          )}

          {m.steps ? (
            <div className="space-y-3">
              {m.steps.map((s, i) => (
                <div key={i}>
                  <div className="text-xs font-semibold text-[#25455D] mb-1">{s.title}</div>
                  {s.lines.map((l, j) => (
                    <div key={j} className="text-sm text-gray-700 leading-relaxed">{l}</div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg p-3">
              {text}
            </div>
          )}

          <button onClick={copy} className="btn-primary text-sm inline-flex items-center gap-2">
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? 'Скопировано' : 'Скопировать текст'}
          </button>
        </div>
      )}
    </div>
  )
}

export default function MaterialsTab({ link }: { link: string }) {
  return (
    <div className="space-y-8">
      {/* Принцип — короткий блок сверху. Без него тексты читаются как скрипты
          продаж, хотя построены на обратном. */}
      <div className="rounded-2xl p-5" style={{ background: 'linear-gradient(45deg, #25455D, #1a3348)' }}>
        <h3 className="font-bold mb-2" style={{ color: '#FFCFA4' }}>Вы не продаёте. Вы отдаёте.</h3>
        <p className="text-sm text-white/85 leading-relaxed">
          В каждом тексте вы делаете одно из двух: даёте значимость собеседнику или даёте
          нейтральную помощь — что-то полезное, что вы как коллега нашли и готовы отдать
          по-дружески. Ни одной попытки продать своё.
        </p>
        <p className="text-xs text-white/60 mt-3">
          Ваша реферальная ссылка подставляется в тексты автоматически — копируйте и отправляйте.
        </p>
      </div>

      {/* ── КОЛЛАБОРАТОРНАЯ ── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-bold text-gray-900">🤝 Коллабораторная</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Обмен аудиторией на совместных эфирах. Зовите экспертов — партнёрство и ваш реферал.
          </p>
        </div>

        {/* Афиши */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center gap-2 mb-1">
            <ImageIcon size={16} className="text-gray-400" />
            <h3 className="font-semibold text-gray-800 text-sm">Афиши для сторис</h3>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            Белое поле справа оставлено под стикер-ссылку — вставьте туда свою реферальную ссылку.
          </p>
          <div className="grid grid-cols-2 gap-4 max-w-md">
            {POSTERS.map(p => {
              const url = `${POSTER_BASE}/${p.file}`
              return (
                <div key={p.id} className="space-y-2">
                  <a href={url} target="_blank" rel="noopener noreferrer" className="block">
                    <img
                      src={url}
                      alt={p.title}
                      className="w-full rounded-xl border border-gray-200 hover:border-[#25455D] transition-colors"
                    />
                  </a>
                  <a
                    href={url}
                    download
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-[#25455D] py-1"
                  >
                    <Download size={13} />
                    Скачать
                  </a>
                </div>
              )
            })}
          </div>
        </div>

        {COLLAB_TEXTS.map(m => <MaterialCard key={m.id} m={m} link={link} />)}
      </section>

      {/* ── ПЛАТФОРМА ── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-bold text-gray-900">⚡ Платформа ПЛЮСОН</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Воронки, боты, рассылки, лендинги, премии и конференции — тексты под разных людей.
          </p>
        </div>

        {PLUSON_TEXTS.map(m => <MaterialCard key={m.id} m={m} link={link} />)}
      </section>

      {/* ── ПРАВИЛА ── */}
      <section>
        <h2 className="text-lg font-bold text-gray-900 mb-3">Общие правила</h2>
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <ul className="space-y-2.5">
            {RULES.map((r, i) => (
              <li key={i} className="flex gap-3 text-sm text-gray-700 leading-relaxed">
                <span className="shrink-0 font-bold" style={{ color: '#FFCFA4' }}>→</span>
                {r}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  )
}
