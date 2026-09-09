'use client'
import Link from 'next/link'
import { BookOpen } from 'lucide-react'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function TournamentTaskControlHelpPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Контроль заданий в турнире</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Контроль заданий в турнире</h1>
          <p className="text-sm text-gray-500 mt-1">
            Бот слушает чат вашего события и автоматически ставит баллы участникам, когда они присылают
            выполненное задание с кодовой фразой (например <code className="bg-gray-100 px-1 rounded">#дз_1</code>).
            Работает в Telegram, ВКонтакте и MAX. Ниже — как настроить и как убедиться, что слушалка работает.
          </p>
        </div>
      </div>

      {/* Как это работает в двух словах */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 mb-6">
        <div className="text-sm font-semibold text-gray-800 mb-1">Как это работает в двух словах</div>
        <p className="text-sm text-gray-700 leading-relaxed">
          У каждого задания вы задаёте свою <strong>кодовую фразу</strong>. Когда участник пишет эту фразу
          в чате события, бот находит его среди зарегистрированных и ставит <strong>1 балл</strong> за это
          задание. Если фразу написал кто-то, кого нет в участниках — он подсветится <span className="text-red-600 font-medium">красным «не опознан»</span>, и бот ответит ему, что он не зарегистрирован.
          Важность задания регулируется <strong>весом</strong> критерия, а не баллом.
        </p>
      </div>

      <Section step="1" title="Заведите критерии заданий с кодовыми фразами">
        <p className="text-sm text-gray-700 mb-2">
          Откройте свой турнир → вкладка <strong>«Оценки»</strong> → подвкладка <strong>«Критерии»</strong>.
          Создайте критерий задания и поставьте у него тип <strong>«Ставит: Ручной»</strong> — тогда появится
          поле <strong>«Кодовая фраза»</strong>.
        </p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5 mb-3">
          <li>Одна фраза на один критерий. Например: <code className="bg-gray-100 px-1 rounded">#дз_1</code>, <code className="bg-gray-100 px-1 rounded">#дз_1_видео</code>, <code className="bg-gray-100 px-1 rounded">лицензию</code>.</li>
          <li>Фраза ловится в любом месте сообщения и без учёта регистра (<code className="bg-gray-100 px-1 rounded">#ДЗ_1</code> = <code className="bg-gray-100 px-1 rounded">#дз_1</code>).</li>
          <li>Одно сообщение может содержать несколько фраз сразу — засчитается каждая.</li>
          <li><strong>Вес</strong> критерия задаёт его важность в итоге. Балл за выполнение всегда <strong>1</strong>.</li>
        </ul>
      </Section>

      <Section step="2" title="Добавьте бота в чат события">
        <p className="text-sm text-gray-700 mb-2">
          Бот должен видеть сообщения чата. На каждой площадке — по-своему:
        </p>
        <div className="space-y-2.5 mb-3">
          <Platform emoji="🤖" name="Telegram">
            Добавьте вашего бота в группу/чат события и сделайте его <strong>администратором</strong>.
            Админ видит все сообщения — настройка приватности (Group Privacy) роли не играет.
          </Platform>
          <Platform emoji="🟦" name="ВКонтакте">
            В настройках сообщества: <strong>Управление → Сообщения → Настройки для бота</strong> → включите
            <strong> «Разрешать добавлять сообщество в беседы»</strong>. Затем добавьте сообщество в беседу
            события администратором. Если добавляли до включения настройки — удалите и добавьте заново.
            Long Poll должен быть включён с событием <strong>«Входящее сообщение»</strong>.
          </Platform>
          <Platform emoji="🟣" name="MAX">
            Добавьте бота в чат события как участника.
          </Platform>
        </div>
      </Section>

      <Section step="3" title="Узнайте ID чата командой /chatid">
        <p className="text-sm text-gray-700 mb-2">
          Напишите прямо в чате события команду <code className="bg-gray-100 px-1 rounded">/chatid</code> —
          бот ответит числовым ID этого чата. Это единственное, что бот пишет в чат; в остальном он молчит.
        </p>
        <p className="text-sm text-gray-500">
          Для Telegram ID выглядит как <code className="bg-gray-100 px-1 rounded">-1002163265255</code>,
          для ВКонтакте — как <code className="bg-gray-100 px-1 rounded">2000000001</code>,
          для MAX — длинное отрицательное число.
        </p>
      </Section>

      <Section step="4" title="Впишите ID чата в настройки события">
        <p className="text-sm text-gray-700 mb-2">
          Откройте турнир → вкладка <strong>«Настройки»</strong> → блок чатов события. Под нужной площадкой
          есть поле <strong>«ID чата для подсчёта заданий»</strong> — вставьте туда ID из шага 3 и нажмите
          <strong> «Сохранить»</strong>.
        </p>
        <p className="text-sm text-gray-500">
          Можно заполнить сразу несколько площадок — бот будет слушать чат на каждой из них.
        </p>
      </Section>

      <Section step="5" title="Включите слушание и проверьте бота">
        <p className="text-sm text-gray-700 mb-2">
          Вернитесь во вкладку <strong>«Оценки» → «Контроль заданий»</strong>:
        </p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5 mb-3">
          <li>Включите большой тумблер <strong>«Слушание заданий в чатах»</strong>.</li>
          <li>Под каждой площадкой нажмите <strong>«Проверить, что бот слушает»</strong>. Для Telegram бот проверит, что он реально в чате и админ — тогда статус станет <span className="text-green-600 font-medium">зелёным «слушает ✓»</span>.</li>
          <li>Для каждого этапа выберите, кого слушаем: <strong>зрителей</strong> (обычных участников) или <strong>спикеров/жюри</strong>.</li>
        </ul>
        <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-sm text-gray-600">
          Жёлтый статус «не проверено» означает только, что вы ещё не нажали «Проверить» — это не значит,
          что бот не слушает. Бот слушает, как только ID вписан и тумблер включён.
        </div>
      </Section>

      <Section step="✓" title="Финальная проверка — напишите тестовую фразу">
        <p className="text-sm text-gray-700 mb-2">
          Попросите зарегистрированного участника (или себя) написать в чате события любую кодовую фразу,
          например <code className="bg-gray-100 px-1 rounded">#дз_1</code>. Через пару секунд:
        </p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5">
          <li>В таблице внизу вкладки «Контроль заданий» появится <strong>новая строка</strong> с автором, фразой, временем и текстом сообщения.</li>
          <li>Участнику начислится <strong>1 балл</strong> — это видно в подвкладке «Турнирная таблица», в колонке этого задания.</li>
          <li>Если автор не в списке участников — строка будет <span className="text-red-600 font-medium">красной «не опознан»</span> (отфильтровать можно селектором «не опознан»).</li>
        </ul>
      </Section>

      <div className="mt-6 p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Не нашли ответ?</div>
        <p className="text-sm text-gray-600">
          Напишите в поддержку —{' '}
          <Link href={SUPPORT_URL}
             className="text-blue-600 hover:underline">
            {SUPPORT_LABEL}
          </Link>
        </p>
      </div>
    </div>
  )
}

function Section({ step, title, children }: { step: string; title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border card-border p-5 mb-4 shadow-sm">
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

function Platform({ emoji, name, children }: { emoji: string; name: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{emoji}</span>
        <span className="text-sm font-semibold" style={{ color: BRAND }}>{name}</span>
      </div>
      <p className="text-sm text-gray-700 leading-relaxed">{children}</p>
    </div>
  )
}
