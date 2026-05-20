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

      <div className="rounded-xl border p-4 mb-6 flex items-start gap-3 bg-blue-50 border-blue-200">
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
              введёте свой <code>club{'{ID}'}</code> вместо тега. ID видно в URL вашего сообщества:
              откройте свою группу — в адресной строке будет что-то вроде <code>vk.ru/club238697730</code>,
              где <code>club238697730</code> — это и есть ваш ID.
            </span>
          </li>
          <li><strong>Сайт:</strong> ваш сайт (если есть)</li>
          <li><strong>Город:</strong> ваш город</li>
          <li>Нажать <strong>«Сохранить»</strong></li>
        </ul>

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

      <Section step="6" title="Получить ключ доступа (Access Token)">
        <p className="text-sm text-gray-700 mb-3">
          Ключ доступа — это «пароль» от вашего сообщества, через который ПЛЮСОН отправляет сообщения и принимает события.
        </p>

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

        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-900">
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
          сразу виден в правой колонке. Дальше нужно настроить несколько разделов в левом меню.
        </p>

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
          VK автоматически сгенерировал <strong>«Защищённый ключ»</strong> (Secure Key) при создании
          приложения. Он скрыт звёздочками — нажмите <strong>«Показать»</strong>, скопируйте значение.
          Скриншот ключа делать НЕЛЬЗЯ — это секрет.
        </p>
        <p className="text-xs text-gray-500">
          Защищённый ключ нужен ПЛЮСОНу для проверки подписи запросов от вашего Mini App к нашему
          бэкенду — гарантия что данные не подделаны.
        </p>
      </Section>

      <Section step="8" title="Подключить сообщество к ПЛЮСОН">
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
              <li>сохранит реквизиты в зашифрованном виде в нашей базе</li>
              <li>перезапустит свой VK-процесс — обычно за 5–10 секунд ваше сообщество начнёт обслуживаться</li>
            </ul>
          </li>
        </ol>

        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-900">
          ✅ <strong>Готово.</strong> Теперь у ваших участников при открытии события через ВК
          будет работать iViSiON: ПЛЮСОН — программа, реферальные подарки, экосистема — всё как в Telegram.
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
