'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ExternalLink, Copy, Check, ImageOff } from 'lucide-react'
import { api } from '@/lib/api'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function VkSetupInstructionPage() {
  // Автоподставляем client_id в URL для шага «Размещение» — клиенту не нужно
  // знать или вводить свой ID руками, ссылка готова к копированию.
  const [clientId, setClientId] = useState<number | null>(null)
  useEffect(() => {
    api.auth.me().then((m: any) => {
      if (m?.id) setClientId(Number(m.id))
    }).catch(() => {})
  }, [])
  const placementUrl = clientId ? `https://pluson.ru/c/${clientId}/vk/` : 'https://pluson.ru/c/{ID}/vk/'

  // Адрес сообщества клиента — он вводит свой короткий адрес (ivision_pluson)
  // или ID (club238697730), и мы строим прямую ссылку на «Работа с API»
  // его сообщества. Без этого ссылка vk.ru/community?act=tokens ведёт
  // на левую страницу «сообщество» (так называется generic-страница ВК).
  const [vkSlug, setVkSlug] = useState('')
  const cleanedSlug = vkSlug
    .trim()
    .replace(/^https?:\/\/(www\.)?vk\.(ru|com)\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\?.*$/, '')
    .replace(/^@/, '')
  const tokensUrl = cleanedSlug
    ? `https://vk.ru/${cleanedSlug}?act=tokens`
    : 'https://vk.ru/<адрес_вашего_сообщества>?act=tokens'

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Подключение ВКонтакте</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Подключение ВКонтакте</h1>
          <p className="text-sm text-gray-500 mt-1">
            Пошаговая инструкция как создать сообщество ВКонтакте, зарегистрировать Mini App
            и подключить их к iViSiON: ПЛЮСОН.
          </p>
        </div>
      </div>

      <div className="rounded-xl border p-4 mb-4 flex items-start gap-3 bg-blue-50 border-blue-200">
        <div className="text-xl flex-shrink-0">💡</div>
        <div>
          <div className="text-sm font-semibold text-gray-800">Зачем это нужно</div>
          <p className="text-xs text-gray-700 mt-1">
            После подключения участники ваших событий смогут открывать iViSiON: ПЛЮСОН
            не только в Telegram, но и в ВКонтакте. Сообщество в ВК становится
            каналом для рассылок и приветствий, Mini App — приложением со всеми возможностями
            (программа, реферальные подарки, экосистема).
          </p>
        </div>
      </div>

      {/* Чек-лист 4 параметров: что собрать пока проходишь шаги 2/6/7,
          чтобы в шаге 8 ввести в мастер. Без этого клиент не понимает,
          что из инструкции — «временные действия», а что — «положить в карман». */}
      <div className="rounded-xl border-2 p-4 mb-6"
           style={{ borderColor: '#FFCFA4', background: 'rgba(255,207,164,0.18)' }}>
        <div className="text-sm font-bold mb-2" style={{ color: '#25455D' }}>
          📋 Финальная цель: собрать 4 параметра и вставить их в шаге 8
        </div>
        <p className="text-xs mb-3" style={{ color: '#25455D' }}>
          Заведите блокнот (или Apple Notes) и по ходу инструкции выписывайте туда эти 4 значения —
          в нужный момент шаги будут помечены жёлтой плашкой <strong>«✂️ СОХРАНИТЕ»</strong>.
          В шаге 8 откроется форма с этими же 4 полями — туда и вставите.
        </p>
        <ol className="text-xs space-y-1.5 list-decimal pl-5" style={{ color: '#25455D' }}>
          <li><strong>ID сообщества</strong> — число вида <code>212804884</code>. Берётся в <strong>шаге 2</strong>
            (число после префикса в URL: <code>club…</code>, <code>public…</code> или <code>event…</code>).</li>
          <li><strong>Access Token сообщества</strong> — длинная строка <code>vk1.a.xxxxx…</code>. Берётся в <strong>шаге 6</strong>.</li>
          <li><strong>VK App ID</strong> — число вида <code>54592404</code>. Берётся в <strong>шаге 7</strong> (после создания Mini App).</li>
          <li><strong>Secure Key (Защищённый ключ)</strong> — длинная строка букв и цифр. Берётся в <strong>шаге 7</strong> (раздел «Разработка → Ключи доступа»).</li>
        </ol>
      </div>

      <Section step="1" title="Создать сообщество в ВКонтакте">
        <p className="text-sm text-gray-700 mb-3">
          Сообщество — это «бот» в терминах ВК: сущность, от имени которой будут уходить
          сообщения и от которой будут получать ваши пользователи.
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Зайдите на <a href="https://vk.ru/groups?w=groups_create" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">vk.ru/groups?w=groups_create <ExternalLink size={12}/></a> и нажмите «Создать сообщество»</li>
          <li>Тип сообщества: <strong>«Бизнес»</strong> (либо «Бренд или организация»)</li>
          <li>Название: ваш бренд (например, <code>iVISION</code>). Тематика: «Бизнес и экономика»</li>
          <li>Нажмите «Создать»</li>
        </ol>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
          🔐 <strong>Добавьте второго админа сразу.</strong> В управлении сообщества →
          «Участники» → «Руководители» → «Добавить руководителя». Это страховка на случай
          если что-то случится с вашим личным аккаунтом — у второго админа останется доступ.
        </div>
      </Section>

      <Section step="2" title="Базовые настройки сообщества">
        <p className="text-sm text-gray-700 mb-3">
          Под обложкой сообщества нажмите <strong>«⋯»</strong> → <strong>«Управление»</strong>.
          Откроется панель управления, в правой колонке — пункты меню.
        </p>

        <p className="text-sm font-semibold text-gray-800 mb-2">В разделе «Настройки» → «Основная информация»:</p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5 mb-4">
          <li><strong>Название:</strong> ваш бренд</li>
          <li><strong>Описание:</strong> короткое описание вашего бизнеса/событий</li>
          <li><strong>Тематика:</strong> «Бизнес и экономика»</li>
          <li><strong>Адрес страницы:</strong> ваш кастомный тег латиницей вместо автоматического
            <code>club{'{ID}'}</code>. Например <code>ivision_pluson</code> — получится <code>vk.ru/ivision_pluson</code>{' '}
            (вместо длинного <code>vk.ru/club238697730</code>).
            <span className="block text-xs text-gray-500 mt-0.5">
              ⚠️ Не получается сохранить адрес (поле красное, кнопка «Сохранить» неактивна или ВК пишет «адрес занят»)? —
              <strong> можно пропустить</strong>. ПЛЮСОН будет работать и без короткого адреса, просто в шаге 6 вы
              введёте свой <code>club{'{ID}'}</code> вместо тега.
            </span>
          </li>
          <li><strong>Сайт:</strong> ваш сайт (если есть)</li>
          <li><strong>Город:</strong> ваш город</li>
          <li>Нажать <strong>«Сохранить»</strong></li>
        </ul>

        <SavePill
          number="1 / 4"
          label="ID сообщества"
          desc={<>В мастере подключения <strong>нужно только число</strong> (например <code>212804884</code>) —
            не <code>ivision_community</code>, не <code>public212804884</code>, не URL.
            <br/><br/>
            <strong>Префикс зависит от типа сообщества:</strong>
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li>Группа (Бизнес / Бренд) → URL <code>vk.ru/<strong>club</strong>238697730</code></li>
              <li>Публичная страница → URL <code>vk.ru/<strong>public</strong>212804884</code></li>
              <li>Мероприятие → URL <code>vk.ru/<strong>event</strong>12345678</code></li>
            </ul>
            В любом случае нужно <strong>только число после префикса</strong>, сам префикс не вписывайте.
            <br/><br/>
            <strong>Как найти это число у вашего сообщества:</strong>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li><strong>Способ 1 (надёжный).</strong> Под обложкой сообщества нажмите
                <strong> «⋯» → «Управление»</strong>. Адресная строка станет
                <code> vk.ru/club212804884?act=manage</code> (даже для публичных страниц в «Управлении»
                префикс становится <code>club</code>). Число между <code>club</code> и <code>?</code> —
                ваш ID.</li>
              <li><strong>Способ 2.</strong> На главной сообщества блок «Подробная информация» / в самом низу
                страницы → строка «Номер сообщества — <code>public212804884</code>» (или <code>club…</code>).
                Берёте только число.</li>
              <li><strong>Способ 3.</strong> Откройте любую запись на стене сообщества — URL станет
                <code> vk.ru/wall-212804884_15</code>. Число между <code>wall-</code> и <code>_</code> и
                есть ваш ID (без знака минус).</li>
            </ul></>}
          example="212804884"
        />

        <Screenshot
          src="/help/vk-setup/02-settings-main.png"
          alt="Раздел Настройки — Основная информация"
          caption="Раздел «Настройки» — основная информация о сообществе"
        />
      </Section>

      <Section step="3" title="Включить сообщения сообщества">
        <p className="text-sm text-gray-700 mb-3">
          Чтобы сообщество могло отправлять сообщения участникам и принимать сообщения от них.
        </p>
        <p className="text-sm font-semibold text-gray-800 mb-2">В правом меню управления → пункт «Сообщения»:</p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-4">
          <li>Переключатель <strong>«Сообщения сообщества»</strong> → <strong>ВКЛ</strong></li>
          <li>Поле <strong>«Приветствие»</strong> — <strong>оставить пустым</strong>.
            <span className="block text-xs text-gray-500 mt-0.5">
              ПЛЮСОН сам отправит контекстное приветствие (по событию или лид-магниту).
              Если заполнить это поле, ВК будет слать своё статичное сообщение поверх нашего — сообщения задублируются.
            </span>
          </li>
          <li>Чекбокс <strong>«Виджет сообщений»</strong> — <strong>не ставить</strong> (это для встраивания чата на сторонние сайты, нам не нужно)</li>
          <li>Нажать <strong>«Сохранить»</strong></li>
        </ol>

        <Screenshot
          src="/help/vk-setup/03-messages.png"
          alt="Раздел Сообщения"
          caption="Раздел «Сообщения» в правом меню управления"
        />
      </Section>

      <Section step="4" title="Подключить чат к сообществу">
        <p className="text-sm text-gray-700 mb-3">
          Чат сообщества — это общий чат для участников вашего события (аналог группового чата в Telegram).
          Туда вы сможете давать ссылку из Mini App, чтобы участники общались друг с другом.
        </p>
        <p className="text-sm font-semibold text-gray-800 mb-2">На главной странице сообщества справа:</p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-4">
          <li>Найдите блок <strong>«Чаты»</strong> или ссылку <strong>«Создать чат»</strong></li>
          <li>Нажмите <strong>«Создать чат»</strong></li>
          <li>Название чата — название вашего события или сообщества</li>
          <li>Фото чата — можно загрузить (необязательно)</li>
          <li>Кто может приглашать — <strong>«Все участники сообщества»</strong></li>
          <li>Нажать <strong>«Создать»</strong></li>
        </ol>
        <p className="text-sm text-gray-700 mb-3">
          После создания скопируйте ссылку на чат (кнопка «Пригласить в чат» → «Скопировать ссылку») —
          она пригодится, когда будете настраивать событие в дашборде ПЛЮСОН (поле «Чат события»).
        </p>
        <Screenshot
          src="/help/vk-setup/04-chat.png"
          alt="Создание чата в сообществе"
          caption="Блок «Чаты» на главной странице сообщества"
        />
      </Section>

      <Section step="5" title="Включить возможности бота">
        <p className="text-sm text-gray-700 mb-3">
          Боты в ВК — это автоматизация ответов сообщества. ПЛЮСОН использует их, чтобы слать
          приветствия, лид-магниты, рассылки, отвечать на нажатия кнопок.
        </p>
        <p className="text-sm font-semibold text-gray-800 mb-2">
          Внутри уже открытого раздела <strong>«Сообщения»</strong> (тот же, что в шаге 3) — наверху в шапке
          переключитесь на подвкладку <strong>«Настройки»</strong>, прокрутите до блока{' '}
          <strong>«Возможности ботов»</strong>:
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-4">
          <li>Переключатель <strong>«Возможности ботов»</strong> → <strong>ВКЛ</strong></li>
          <li>Чекбокс <strong>«Добавить кнопку «Начать»»</strong> → <strong>поставить ✅</strong>.
            <span className="block text-xs text-gray-500 mt-0.5">
              Аналог /start в Telegram. Когда человек впервые открывает диалог с сообществом,
              ВК покажет ему большую кнопку «Начать». Он её жмёт → ПЛЮСОН получает событие и шлёт первое сообщение.
            </span>
          </li>
          <li>Чекбокс <strong>«Разрешать добавлять сообщество в чаты»</strong> → <strong>не ставить</strong>.
            <span className="block text-xs text-gray-500 mt-0.5">
              Иначе пользователи смогут добавлять ваше сообщество в свои групповые чаты — это
              источник мусорных приглашений.
            </span>
          </li>
          <li>Нажать <strong>«Сохранить»</strong></li>
        </ol>

        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-sm text-blue-900 mb-3">
          💡 <strong>Если не видите блок «Возможности ботов»:</strong> в правом меню управления нет отдельного
          пункта «Настройки для бота» — все настройки бота находятся внутри{' '}
          <strong>Сообщения → Настройки</strong> (подвкладка в шапке раздела «Сообщения», рядом с «Диалоги»).
        </div>

        <Screenshot
          src="/help/vk-setup/05-bot-settings.png"
          alt="Раздел Сообщения → Настройки → Возможности ботов"
          caption="Блок «Возможности ботов» внутри Сообщения → Настройки"
        />
      </Section>

      <Section step="6" title="Получить ключ доступа сообщества (Access Token)">
        <p className="text-sm text-gray-700 mb-3">
          Ключ доступа сообщества — это «пароль» от вашей группы, через который ПЛЮСОН отправляет сообщения подписчикам и принимает события («новый диалог», «нажал кнопку»).
        </p>

        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 mb-3">
          ℹ️ <strong>Не путайте с ключами Mini App из шага 7.</strong> Это <em>разные</em> ключи для разных вещей:
          <ul className="list-disc pl-5 mt-1 space-y-0.5">
            <li><strong>Шаг 6</strong> (этот) — Access Token сообщества (<code>vk1.a.xxxxx…</code>). От имени сообщества. Для рассылок и приёма сообщений.</li>
            <li><strong>Шаг 7</strong> — VK App ID + Защищённый ключ + Secure Key. От имени самого Mini App. Чтобы ВК подписывал launch params вашего приложения внутри сообщества.</li>
          </ul>
          В дашборде ПЛЮСОНа на шаге 8 вы вставите <strong>все 4 значения</strong> — без любого из них подключение не сработает.
        </div>

        <p className="text-sm text-gray-700 mb-3">
          В правом меню управления сообществом отдельного пункта «Работа с API» в современном ВК <strong>нет</strong> —
          страница открывается только по прямой ссылке вида <code>vk.ru/<strong>адрес_сообщества</strong>?act=tokens</code>.
          Введите ниже короткий адрес или ID своего сообщества — мы соберём рабочую ссылку.
        </p>

        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 mb-3">
          <label className="text-xs font-semibold text-gray-800 mb-1.5 block">
            Короткий адрес вашего сообщества (из шага 2)
          </label>
          <input
            type="text"
            value={vkSlug}
            onChange={(e) => setVkSlug(e.target.value)}
            placeholder="ivision_pluson  или  club238697730"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          <p className="text-[11px] text-gray-500 mt-1.5">
            Можно вставить целиком URL сообщества (<code>https://vk.ru/ivision_pluson</code>) — мы вытащим адрес автоматически.
            Если короткого адреса ещё нет, найдите ID: откройте свое сообщество, в URL будет <code>vk.ru/club12345678</code> —
            введите целиком <code>club12345678</code>.
          </p>
        </div>

        <p className="text-sm text-gray-700 mb-3 pl-4 border-l-2 border-blue-300">
          ▶{' '}
          {cleanedSlug ? (
            <a href={tokensUrl}
               target="_blank" rel="noreferrer"
               className="text-blue-600 hover:underline inline-flex items-center gap-1 font-medium break-all">
              {tokensUrl} <ExternalLink size={12}/>
            </a>
          ) : (
            <span className="text-gray-500 font-mono text-sm">{tokensUrl}</span>
          )}
        </p>

        <p className="text-sm font-semibold text-gray-800 mb-2">На открывшейся странице «Работа с API» → вкладка «Ключи доступа»:</p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Нажмите <strong>«Создать ключ»</strong></li>
          <li>Отметьте чекбоксы прав:
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li>✅ Сообщения сообщества</li>
              <li>✅ Управление сообществом</li>
              <li>✅ Доступ к фотографиям сообщества</li>
              <li>✅ Доступ к документам сообщества</li>
            </ul>
          </li>
          <li>Нажмите <strong>«Создать»</strong> → подтвердите через SMS-код</li>
          <li>Скопируйте появившийся длинный ключ вида <code>vk1.a.xxxxxxxxxx…</code></li>
        </ol>

        <SavePill
          number="2 / 4"
          label="Access Token сообщества"
          desc={<>Это та самая длинная строка, начинающаяся с <code>vk1.a.</code>, которую вы только что
            скопировали. Сохраните её целиком, как есть.</>}
          example="vk1.a.zZJxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        />

        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-900 mt-3">
          🔒 <strong>Ключ это пароль.</strong> Не показывайте его в публичных местах, не отправляйте в чаты,
          не выкладывайте в скриншоты. Если случайно показали — сразу удалите старый ключ в этом же разделе и создайте новый.
        </div>

        <Screenshot
          src="/help/vk-setup/06-tokens.png"
          alt="Раздел Работа с API — Ключи доступа"
          caption="Раздел «Работа с API» открывается прямой ссылкой и содержит «Ключи доступа»"
        />
      </Section>

      <Section step="7" title="Зарегистрировать VK Mini App">
        <p className="text-sm text-gray-700 mb-3">
          Mini App — это само приложение ПЛЮСОН внутри ВК. Регистрируется в кабинете разработчика VK,
          не в сообществе. В 2025 году ВК перенёс регистрацию из старой панели <code>vk.ru/editapp</code> в новую панель
          на <code>dev.vk.com</code>.
        </p>

        <p className="text-sm font-semibold text-gray-800 mb-2">Откройте в браузере:</p>
        <p className="text-sm pl-4 border-l-2 border-blue-300 mb-3">
          ▶{' '}
          <a href="https://dev.vk.com/ru/mini-apps/management/creating-new-apps"
             target="_blank" rel="noreferrer"
             className="text-blue-600 hover:underline inline-flex items-center gap-1 font-medium">
            dev.vk.com/ru/mini-apps/management/creating-new-apps <ExternalLink size={12}/>
          </a>
        </p>

        <p className="text-sm text-gray-700 mb-2">
          На открывшейся странице — таблица с двумя колонками. В <strong>левой колонке «Новая панель управления»</strong>
          кликните по первому пункту:
        </p>
        <p className="text-sm text-gray-700 mb-3 pl-4 border-l-2 border-blue-300">
          ▶ <strong>«Мини-приложение или игра»</strong> — Запускаются в UI ВКонтакте
        </p>

        <Screenshot
          src="/help/vk-setup/07a-creating-apps-choice.png"
          alt="Страница 'Создание новых приложений' — выбор типа"
          caption="Кликаете «Мини-приложение или игра» в левой колонке (новая панель управления)"
        />

        <p className="text-sm text-gray-700 mt-4 mb-2">
          Откроется форма создания в новой панели. Заполните:
        </p>
        <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5 mb-3">
          <li><strong>Название приложения:</strong> ваш бренд (например, <code>iVISION</code>)</li>
          <li><strong>Тип приложения:</strong> оставить значение по умолчанию — <strong>«Мини приложение»</strong>
            <span className="block text-xs text-gray-500 mt-0.5">
              Поля «Платформа: Веб-приложение / Мобильное приложение» в современной форме нет —
              платформы настраиваются позже в разделе «Размещение».
            </span>
          </li>
          <li><strong>Категория:</strong> выбрать из списка — подойдёт <strong>«Бизнес»</strong>{' '}
            (можно «Утилиты», «Образование» — зависит от вашей тематики)</li>
          <li>Нажать кнопку <strong>«Создать»</strong></li>
        </ol>

        <p className="text-sm text-gray-700 mb-3">
          После создания вы попадёте в панель управления приложением. <strong>App ID</strong> приложения
          сразу виден в правой колонке (короткое число, например <code>54592404</code>).
          Дальше нужно настроить несколько разделов в левом меню.
        </p>

        <SavePill
          number="3 / 4"
          label="VK App ID"
          desc={<>В правой колонке панели Mini App, сразу после создания. Число (обычно 7–9 цифр).
            Также его видно в URL: <code>dev.vk.com/mini-apps/<strong>54592404</strong>/settings</code> —
            число в адресе и есть App ID.</>}
          example="54592404"
        />

        <p className="text-sm font-semibold text-gray-800 mt-4 mb-2">«Настройки → Информация»:</p>
        <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5 mb-4">
          <li><strong>Описание</strong> — расскажите про ваш бизнес и события</li>
          <li><strong>Краткое описание</strong> — одной строкой, до 128 символов</li>
          <li><strong>Короткий адрес</strong> — пропустите этот пункт. ВК показывает ошибку «приложение должно
            появиться в каталоге» — короткий адрес выдаётся <strong>после модерации</strong> приложения,
            заполнять сейчас не получится. Вернётесь к нему позже, если будете публиковать в каталог
            ВК. Для работы с ПЛЮСОН это не нужно.</li>
          <li><strong>Официальное сообщество</strong> — выбрать ваше сообщество из шага 1</li>
          <li><strong>«Запуск приложения из сообщества»</strong> — переключатель <strong>ВКЛ</strong> (в сообществе появится кнопка «Открыть приложение»)</li>
          <li><strong>«Название кнопки»</strong> — выбрать «Открыть приложение» (или похожее) из дропдауна</li>
          <li><strong>«Запуск на iOS / Company Name»</strong> — оставить пустым</li>
          <li>Нажать <strong>«Сохранить»</strong></li>
        </ol>

        <p className="text-sm font-semibold text-gray-800 mt-4 mb-2">«Настройки → Размещение»:</p>
        <p className="text-sm text-gray-700 mb-2">
          Здесь <strong>три отдельные секции</strong> с URL — для разных сценариев открытия. Во все три
          вставляем <strong>один и тот же URL</strong>:
        </p>
        <div className="mb-2"><CopyBlock value={placementUrl} /></div>
        <p className="text-xs text-gray-500 mb-3">
          {clientId
            ? <>В URL уже автоматически подставлен <strong>ваш</strong> ID клиента в ПЛЮСОН (<code>{clientId}</code>) — ничего не редактируйте, скопируйте как есть.</>
            : <>Ваш ID клиента подгружается… после загрузки страницы URL станет персональным.</>}
        </p>

        <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5 mb-4">
          <li><strong>Состояние для пользователей:</strong> <strong>«Включено»</strong></li>
          <li><strong>«Мобильное приложение» (WebView)</strong> → URL: ссылка выше. Запускается из нативного приложения VK на iOS/Android</li>
          <li><strong>«Десктопная версия сайта» (iframe)</strong> → URL: та же ссылка. Запускается с компьютера через vk.com</li>
          <li><strong>«Мобильная версия сайта» (iframe)</strong> → URL: та же ссылка. Запускается с мобильного браузера через m.vk.com</li>
          <li><strong>«Режим разработки»</strong> во всех трёх секциях — <strong>не трогать</strong></li>
          <li>Нажать <strong>«Сохранить»</strong></li>
        </ol>

        <Screenshot
          src="/help/vk-setup/07-miniapp-settings.png"
          alt="Раздел Размещение — три секции URL"
          caption="Раздел «Размещение» — три секции URL (мобильное приложение, десктоп iframe, мобильный сайт iframe). Везде один URL."
        />

        <p className="text-sm font-semibold text-gray-800 mt-4 mb-2">«Разработка → Ключи доступа»:</p>
        <p className="text-sm text-gray-700 mb-3">
          В этом разделе ВК показывает <strong>два</strong> ключа с похожими названиями. Нам нужен
          только <strong>«Защищённый ключ»</strong> (Secure Key). Скопируйте именно его — нажмите
          «Показать», возьмите значение.
        </p>

        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-900 mb-3">
          ⚠️ <strong>Не перепутайте два ключа:</strong>
          <ul className="list-disc pl-5 mt-1 space-y-0.5">
            <li><strong>Защищённый ключ</strong> (Secure Key) — <strong>нужен нам</strong>. Через него
              ВК подписывает запросы Mini App к нашему бэкенду.</li>
            <li><strong>Сервисный ключ доступа</strong> — <em>не нужен</em>. Это серверный токен
              для прямых вызовов VK API, ПЛЮСОН его не использует. Если вставите его вместо
              защищённого — подключение работать не будет.</li>
          </ul>
        </div>

        <SavePill
          number="4 / 4"
          label="Защищённый ключ (Secure Key)"
          desc={<>В разделе <strong>«Разработка → Ключи доступа»</strong> вашего Mini App, строка
            <strong> «Защищённый ключ»</strong> (НЕ «Сервисный ключ доступа»!).
            По умолчанию скрыта звёздочками — нажмите <strong>«Показать»</strong> и скопируйте целиком.</>}
          example="GqXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        />

        <p className="text-xs text-gray-500 mt-3">
          Защищённый ключ нужен ПЛЮСОНу для проверки подписи запросов от вашего Mini App к нашему
          бэкенду — гарантия что данные не подделаны.
        </p>
      </Section>

      <Section step="8" title="Разместить приложение в сообществе (меню + кнопка в шапке)">
        <p className="text-sm text-gray-700 mb-3">
          В шаге 7 вы зарегистрировали Mini App. Само по себе это его <strong>не показывает</strong> подписчикам сообщества —
          нужно ещё добавить его «лицом» в само сообщество: плиткой в меню под обложкой и большой кнопкой
          в шапке рядом с «Сообщения». Сделаем 3 размещения.
        </p>

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900 mb-4">
          ⚠️ <strong>Админ видит шапку сообщества по-другому.</strong> На месте «Открыть приложение»
          у вас как у админа отображается серая кнопка <strong>«Продвижение»</strong> — это нормально, она ваша
          и подписчикам не видна. Чтобы проверить, как смотрятся настройки у обычного пользователя —
          откройте сообщество в режиме инкогнито без входа в ВК.
        </div>

        <p className="text-sm font-semibold text-gray-800 mb-2">8.1 — Установить виджет приложения</p>
        <p className="text-sm text-gray-700 mb-2">
          Сначала «прицепляем» Mini App к сообществу — это даст плитку-сниппет над постами и сделает
          приложение доступным для добавления в меню и кнопку действия.
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Управление сообществом → правая колонка, <strong>прокрутите вниз</strong> до пункта{' '}
            <strong>«Приложения»</strong> (он не в первой группе пунктов, а ниже — после «Сообщения» / «Чаты»)</li>
          <li>На открывшейся странице прокрутите <strong>в самый низ</strong> до блока{' '}
            <strong>«Мои приложения»</strong> (он после «Ранее установленные»)</li>
          <li>У вашего приложения нажмите <strong>«Добавить»</strong></li>
          <li>На экране настроек:
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li><strong>«Кому доступно»</strong>: «Все пользователи»</li>
              <li><strong>«Видимость виджета приложения»</strong>: «Все пользователи»</li>
              <li><strong>«Сниппет»</strong>: выбрать подпись кнопки в плашке-сниппете —
                «Открыть», «Записаться», «Перейти» (на ваш вкус)</li>
              <li><strong>«Название приложения»</strong>: например, «iViSiON: ПЛЮСОН»</li>
            </ul>
          </li>
          <li>Нажать <strong>«Сохранить»</strong></li>
        </ol>
        <Screenshot
          src="/help/vk-setup/08a-install-app.png"
          alt="Установить приложение в сообщество — блок Мои приложения"
          caption="Блок «Мои приложения» в самом низу страницы «Приложения сообщества»"
        />

        <p className="text-sm font-semibold text-gray-800 mt-5 mb-2">8.2 — Добавить плитку в «Меню» сообщества</p>
        <p className="text-sm text-gray-700 mb-2">
          Плитка появляется <strong>под аватаром</strong> сообщества (мобильная и десктоп версии) — это
          самый заметный способ запуска. Можно сделать одну общую плитку «Открыть приложение» или
          несколько («События», «Подарки», «Регистрация»).
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Правая колонка управления → <strong>«Меню»</strong> → <strong>«Новая ссылка»</strong></li>
          <li><strong>Ссылка:</strong> вставьте <code>https://vk.com/app{'{VK_APP_ID}'}_-{'{ID_сообщества}'}</code>{' '}
            — <strong>обязательно с минусом</strong> перед ID сообщества. Минус сообщает ВК, что
            приложение запускается <em>в контексте этого сообщества</em> (а не как личное у пользователя).
            <span className="block text-xs text-gray-500 mt-0.5">
              Пример: если ваш App ID = <code>54592404</code> (из шага 7), а ID сообщества = <code>238697730</code> (из шага 2) —
              ссылка будет <code>https://vk.com/app54592404_-238697730</code>.
              <br/>
              Если ВК пишет <strong>«Некорректная ссылка»</strong> — проверьте: 1) минус перед ID сообщества;
              2) приложение уже установлено в сообщество (шаг 8.1).
            </span>
          </li>
          <li><strong>Название:</strong> до 20 символов — например, «ОТКРЫТЬ ПРИЛОЖЕНИЕ», «СОБЫТИЯ», «РЕГИСТРАЦИЯ»</li>
          <li><strong>Обложка:</strong> загрузить квадратную картинку (рекомендация 376×256 px) —
            это иконка плитки в меню. Без неё ВК подставит дефолтную серую</li>
          <li>Нажать <strong>«Сохранить»</strong></li>
        </ol>
        <p className="text-xs text-gray-500 mb-3">
          Можно добавить <strong>несколько ссылок</strong> в меню — каждая будет отдельной плиткой. Все они
          могут вести на одно и то же приложение, но с разными параметрами в URL
          (<code>#ref_pg{'{slug_события}'}</code> — открыть конкретное событие в приложении).
        </p>
        <Screenshot
          src="/help/vk-setup/08b-menu-tile.png"
          alt="Меню сообщества — добавление плитки"
          caption="Плитка «ОТКРЫТЬ ПРИЛОЖЕНИЕ» в меню сообщества — отображается под аватаром"
        />

        <p className="text-sm font-semibold text-gray-800 mt-5 mb-2">8.3 — Кнопка действия в шапке</p>
        <p className="text-sm text-gray-700 mb-2">
          Большая кнопка <strong>в шапке сообщества</strong> рядом с «Сообщения». Она ОДНА — либо «Открыть приложение»,
          либо «Позвонить»/«Написать в Telegram»/«Записаться по ссылке». Рекомендуем «Открыть приложение».
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Правая колонка управления → <strong>«Кнопка действия»</strong> (если пункта нет — он спрятан под
            «Показать ещё» или «Дополнительно»)</li>
          <li><strong>Тип действия:</strong> «Открыть приложение»</li>
          <li><strong>Приложение:</strong> выбрать ваше из выпадающего списка (там появятся только установленные
            в сообщество — поэтому шаг 8.1 нужно сделать до этого)</li>
          <li><strong>Название кнопки:</strong> «Открыть приложение» (или из предложенных)</li>
          <li>Нажать <strong>«Сохранить»</strong></li>
        </ol>
        <Screenshot
          src="/help/vk-setup/08c-action-button.png"
          alt="Кнопка действия в шапке сообщества"
          caption="После настройки подписчики увидят [Сообщения] [Открыть приложение] рядом в шапке"
        />

        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-900 mt-4">
          ✅ <strong>Готово.</strong> После трёх шагов у подписчиков сообщества будет:
          сниппет приложения над постами (8.1), плитки в меню под аватаром (8.2) и большая кнопка
          «Открыть приложение» в шапке рядом с «Сообщения» (8.3). Не забудьте проверить через инкогнито.
        </div>
      </Section>

      <Section step="9" title="Подключить сообщество к ПЛЮСОН">
        <p className="text-sm text-gray-700 mb-3">
          Финальный шаг — вписать токен сообщества и реквизиты Mini App в дашборд ПЛЮСОН.
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Откройте раздел <Link href="/dashboard/channels" className="text-blue-600 hover:underline font-medium">«Каналы»</Link> в дашборде</li>
          <li>В карточке-приглашении <strong>«Подключите своё VK-сообщество»</strong> нажмите кнопку
            <strong> «Запустить мастер VK»</strong></li>
          <li>В мастере (шаг 2 из 3) заполните <strong>4 поля</strong>:
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li><strong>Access Token сообщества</strong> — длинный ключ <code>vk1.a.xxxxx…</code> из <strong>шага 6</strong></li>
              <li><strong>VK App ID</strong> — число (из шага 7, в правой колонке панели Mini App)</li>
              <li><strong>ID сообщества</strong> — число (например, <code>238697730</code>; виден в URL вашего сообщества <code>vk.ru/club<strong>238697730</strong></code> или в Настройки → «Номер сообщества»)</li>
              <li><strong>Secure Key Mini App</strong> — длинная строка из <strong>«Разработка → Ключи доступа»</strong> вашего Mini App (шаг 7)</li>
            </ul>
          </li>
          <li>Нажмите <strong>«Подключить»</strong>. ПЛЮСОН автоматически:
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li>проверит, что токен живой (запрос <code>groups.getById</code> к VK API)</li>
              <li>включит Long Poll API у вашего сообщества (нужно чтобы наш бэкенд получал входящие сообщения и нажатия кнопок)</li>
              <li><strong>включит отслеживание подписчиков</strong> (события «вступил/вышел из сообщества») —
                чтобы те, кто подписывается на ваше сообщество, автоматически попадали в базу контактов ПЛЮСОН</li>
              <li>сохранит реквизиты в зашифрованном виде в нашей базе</li>
              <li>перезапустит свой VK-процесс — обычно за 5–10 секунд ваше сообщество начнёт обслуживаться</li>
            </ul>
          </li>
        </ol>

        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-900">
          ✅ <strong>Готово.</strong> Теперь у ваших участников при открытии события через ВК
          будет работать iViSiON: ПЛЮСОН — программа, реферальные подарки, экосистема — всё как в Telegram.
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-sm text-blue-900 mt-3">
          💡 <strong>Важно про подписчиков и рассылки в ВК.</strong> Во ВКонтакте это два РАЗНЫХ согласия:
          <ul className="list-disc pl-5 mt-1 space-y-0.5">
            <li><strong>Подписка на сообщество</strong> (человек нажал «Подписаться» на стене) — он попадёт
              к вам в контакты, но <strong>слать ему рассылку в личку ещё нельзя</strong>.</li>
            <li><strong>Разрешение на сообщения</strong> (человек нажал «Разрешить сообщения» или написал
              сообществу / открыл ваше приложение) — вот теперь <strong>можно слать рассылку</strong>.</li>
          </ul>
          Это ограничение самого ВК против спама, не ПЛЮСОНа. Поэтому число «подписчиков» в сообществе
          и число тех, кому реально уходит рассылка, во ВК почти всегда разные. ПЛЮСОН при открытии вашего
          Mini App сам просит у человека и подписку, и разрешение на сообщения — так вы получаете максимум.
        </div>
      </Section>

      <Section step="10" title="Уведомления в ВК (в общий чат, видят вы и команда)">
        <p className="text-sm text-gray-700 mb-3">
          Чтобы уведомления о новых интересах и личных сообщениях приходили в ВК — в <strong>общий
          чат</strong>, который видите вы и ваша команда (как канал) — настройте так. Всё делается
          <strong> руками с компьютера</strong> (vk.com), это надёжнее телефона.
        </p>

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900 mb-3">
          ⚠️ Уведомления идут в <strong>чат (беседу)</strong>, а НЕ в «канал» ВК. Канал не подходит —
          бот туда писать не умеет. И не создавайте чат через блок «Чаты» на странице сообщества —
          он будет публичным (видят подписчики). Нужен обычный приватный чат.
        </div>

        <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5 mb-3">
          <li>
            <strong>Разрешите добавлять сообщество в чаты.</strong> В сообществе:
            <strong> Управление → Сообщения → Настройки для бота</strong> → включите галочку
            <strong> «Разрешать добавлять сообщество в чаты»</strong> → «Сохранить».
            Без этого сообщество нельзя будет добавить в чат.
          </li>
          <li>
            <strong>Создайте чат (беседу) с компьютера.</strong> Откройте <strong>Мессенджер</strong> на
            vk.com → «+» рядом с поиском → <strong>«Создать чат»</strong>. Участников добавлять не
            обязательно — можно создать пустой и дать ему название (например «Уведомления ПЛЮСОН»).
          </li>
          <li>
            <strong>Добавьте сообщество в этот чат.</strong> Откройте страницу своего сообщества →
            в блоке кнопок под шапкой нажмите <strong>«Добавить в чат»</strong> → выберите только что
            созданный чат. Сообщество вступит в него (через поиск участников внутри чата сообщество
            обычно НЕ находится — поэтому добавляем именно так, со страницы сообщества).
          </li>
          <li>
            <strong>Узнайте ID чата.</strong> Напишите в этом чате команду <CopyBlock value="/getmyid" /> —
            сообщество-бот ответит числом вида <code>2000000003</code>. Это <strong>peer_id</strong> чата.
            <div className="text-xs text-gray-500 mt-1">
              Если бот молчит — зайдите в настройки чата → участники → у сообщества назначьте права
              <strong> администратора</strong> и повторите <code>/getmyid</code>.
            </div>
          </li>
          <li>
            <strong>Впишите ID в ПЛЮСОН.</strong> <Link href="/dashboard/settings?tab=tech" className="text-blue-600 hover:underline font-medium">Настройки → Техническое</Link> →
            блок <strong>«Каналы уведомлений»</strong> → вкладка <strong>VK</strong> → вставьте это число →
            нажмите <strong>«Сохранить визитку»</strong>.
          </li>
        </ol>

        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-900">
          ✅ <strong>Готово.</strong> Теперь уведомления приходят в этот ВК-чат (и одновременно во все
          другие подключённые каналы — Telegram и MAX). Добавьте в чат коллег — они тоже будут видеть
          уведомления.
        </div>
      </Section>

      <Section step="?" title="Если что-то не работает">
        <ul className="text-sm text-gray-700 space-y-2 list-disc pl-5">
          <li>
            <strong>«Адрес недоступен»</strong> при сохранении настроек Mini App → URL <code>pluson.ru/c/.../vk/</code> ещё не открыт.
            Проверьте URL в браузере — должна загрузиться страница ПЛЮСОН в ВК. Если нет — пишите разработчику.
          </li>
          <li>
            <strong>«Не могу создать ключ»</strong> → проверьте, что у вас включена двухфакторная аутентификация ВК
            и привязан мобильный номер (SMS-код приходит на него)
          </li>
          <li>
            <strong>«Не приходит SMS»</strong> → ВК отправляет коды только через российские номера и иногда задерживает.
            Попробуйте перезапросить через минуту
          </li>
          <li>
            <strong>Сообщество не появляется в списке «Группа администрирования» при создании Mini App</strong> →
            вы не админ этого сообщества или сообщество ещё не создано. Проверьте в управлении сообщества → «Участники» → «Руководители»
          </li>
        </ul>

        <div className="mt-5 p-4 bg-gray-50 rounded-xl border border-gray-200">
          <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
          <p className="text-sm text-gray-600">
            Напишите разработчику —{' '}
            <a href="https://t.me/margo_forbs?text=Вопрос_по_подключению_ВК"
               target="_blank" rel="noopener noreferrer"
               className="text-blue-600 hover:underline inline-flex items-center gap-1">
              открыть чат в Telegram <ExternalLink size={12}/>
            </a>
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

function SavePill({ number, label, desc, example }: {
  number: string
  label: string
  desc: React.ReactNode
  example: string
}) {
  return (
    <div className="rounded-xl border-2 p-4 mt-3"
         style={{ borderColor: '#FFCFA4', background: 'rgba(255,207,164,0.22)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-bold px-2 py-0.5 rounded-full"
              style={{ background: '#25455D', color: '#FFCFA4' }}>
          ✂️ СОХРАНИТЕ · {number}
        </span>
        <span className="text-sm font-bold" style={{ color: '#25455D' }}>{label}</span>
      </div>
      <div className="text-xs mb-2" style={{ color: '#25455D' }}>{desc}</div>
      <div className="text-[11px] mt-1.5" style={{ color: '#25455D' }}>
        <span className="opacity-70">Пример:</span>{' '}
        <code className="bg-white/60 px-1.5 py-0.5 rounded">{example}</code>
      </div>
    </div>
  )
}

function CopyBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <div className="flex gap-2">
      <code className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono overflow-x-auto whitespace-nowrap text-gray-800">
        {value}
      </code>
      <button
        onClick={copy}
        className="px-3 py-2.5 rounded-lg text-white font-medium text-sm flex items-center gap-1.5 flex-shrink-0"
        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        {copied ? <><Check size={15}/> Скопировано</> : <><Copy size={15}/> Копировать</>}
      </button>
    </div>
  )
}
