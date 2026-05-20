'use client'
import { useState } from 'react'
import Link from 'next/link'
import { BookOpen, ExternalLink, Copy, Check, ImageOff } from 'lucide-react'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function VkSetupInstructionPage() {
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
          <li><strong>Адрес страницы:</strong> короткое латинское имя, чтобы получилось <code>vk.ru/ваш_адрес</code></li>
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
          Боты в ВК — это автоматизация ответов сообщества. ПЛЮСОН использует их, чтобы шлать
          приветствия, лид-магниты, рассылки, отвечать на нажатия кнопок.
        </p>
        <p className="text-sm font-semibold text-gray-800 mb-2">В правом меню управления → пункт «Настройки для бота» (отдельный пункт, ниже «Сообщения»):</p>
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

        <Screenshot
          src="/help/vk-setup/04-bot-settings.png"
          alt="Раздел Настройки для бота"
          caption="Раздел «Настройки для бота» — отдельный пункт в правом меню, ниже «Сообщения»"
        />
      </Section>

      <Section step="6" title="Получить ключ доступа (Access Token)">
        <p className="text-sm text-gray-700 mb-3">
          Ключ доступа — это «пароль» от вашего сообщества, через который ПЛЮСОН отправляет сообщения и принимает события.
        </p>

        <p className="text-sm font-semibold text-gray-800 mb-2">В правом меню управления сообществом → пункт «Работа с API»:</p>
        <p className="text-xs text-gray-500 mb-3">
          Если пункта нет в правом меню — откройте напрямую по ссылке{' '}
          <code>https://vk.ru/club{'{ID}'}?act=tokens</code>, заменив <code>{'{ID}'}</code> на номер вашего
          сообщества (виден на странице «Настройки» внизу — «Номер сообщества — <code>club…</code>»).
        </p>

        <p className="text-sm font-semibold text-gray-800 mb-2">На странице «Работа с API» → вкладка «Ключи доступа»:</p>
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
          src="/help/vk-setup/05-tokens.png"
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
        <CopyBlock value="https://dev.vk.com/ru/mini-apps/management/creating-new-apps" />

        <p className="text-sm text-gray-700 mt-3 mb-2">
          На открывшейся странице — таблица с двумя колонками. В <strong>левой колонке «Новая панель управления»</strong>
          кликните по первому пункту:
        </p>
        <p className="text-sm text-gray-700 mb-3 pl-4 border-l-2 border-blue-300">
          ▶ <strong>«Мини-приложение или игра»</strong> — Запускаются в UI ВКонтакте
        </p>

        <Screenshot
          src="/help/vk-setup/06a-creating-apps-choice.png"
          alt="Страница 'Создание новых приложений' — выбор типа"
          caption="Кликаете «Мини-приложение или игра» в левой колонке (новая панель управления)"
        />

        <p className="text-sm text-gray-700 mt-4 mb-2">
          Откроется форма создания в новой панели. Заполните:
        </p>
        <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5 mb-3">
          <li><strong>Название приложения:</strong> ваш бренд (например, <code>iVISION</code>)</li>
          <li><strong>Тип:</strong> <strong>«Mini App»</strong></li>
          <li><strong>Платформа:</strong> «Веб-приложение» + «Мобильное приложение»</li>
          <li>Нажать кнопку создания</li>
        </ol>

        <p className="text-sm text-gray-700 mb-3">
          После создания вы попадёте в панель управления приложением. <strong>App ID</strong> приложения
          сразу виден в правой колонке. Дальше нужно настроить несколько разделов в левом меню.
        </p>

        <p className="text-sm font-semibold text-gray-800 mt-4 mb-2">«Настройки → Информация»:</p>
        <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5 mb-4">
          <li><strong>Описание</strong> — расскажите про ваш бизнес и события</li>
          <li><strong>Краткое описание</strong> — одной строкой, до 128 символов</li>
          <li><strong>Короткий адрес</strong> — латиницей (например <code>ivision_pluson</code>) — будет <code>vk.ru/app/ваш_адрес</code></li>
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
        <div className="mb-3"><CopyBlock value={`https://pluson.ru/c/{ID_КЛИЕНТА}/vk/`} /></div>
        <p className="text-xs text-gray-500 mb-3">
          Где <code>{'{ID_КЛИЕНТА}'}</code> — ваш номер клиента в ПЛЮСОН (виден в правом верхнем углу дашборда).
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
          src="/help/vk-setup/06-miniapp-settings.png"
          alt="Раздел Размещение — три секции URL"
          caption="Раздел «Размещение» — три секции URL (мобильное приложение, десктоп iframe, мобильный сайт iframe). Везде один URL."
        />

        <p className="text-sm font-semibold text-gray-800 mt-4 mb-2">«Разработка → Ключи доступа»:</p>
        <p className="text-sm text-gray-700 mb-3">
          VK автоматически сгенерировал два ключа при создании приложения. Они скрыты звёздочками — нажмите
          <strong>«Показать»</strong>, скопируйте значения. Скриншот ключей делать НЕЛЬЗЯ — это секреты.
        </p>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5">
          <li><strong>Защищённый ключ</strong> (Secure Key) — длинная строка, нужна для подписи запросов от Mini App к нашему бэкенду</li>
          <li><strong>Сервисный ключ доступа</strong> (Service Token) — длинная строка, нужна для серверных запросов от ПЛЮСОН к VK API</li>
        </ul>
      </Section>

      <Section step="8" title="Подключить сообщество к ПЛЮСОН">
        <p className="text-sm text-gray-700 mb-3">
          Финальный шаг — вписать токен сообщества и реквизиты Mini App в дашборд ПЛЮСОН.
        </p>
        <ol className="text-sm text-gray-700 space-y-1.5 list-decimal pl-5 mb-3">
          <li>Откройте раздел <Link href="/dashboard/channels" className="text-blue-600 hover:underline font-medium">«Каналы»</Link> в дашборде</li>
          <li>Нажмите <strong>«Добавить канал»</strong> → выберите платформу <strong>«ВКонтакте»</strong></li>
          <li>Заполните поля:
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li><strong>ID сообщества</strong> — число (например, <code>238697730</code>)</li>
              <li><strong>Access Token сообщества</strong> — <code>vk1.a.xxxxx…</code></li>
              <li><strong>App ID Mini App</strong> — число</li>
              <li><strong>Защищённый ключ Mini App</strong> — строка</li>
              <li><strong>Сервисный ключ Mini App</strong> — строка</li>
            </ul>
          </li>
          <li>Нажмите <strong>«Подключить»</strong>. ПЛЮСОН автоматически:
            <ul className="list-disc pl-5 mt-1 space-y-0.5">
              <li>проверит, что токен живой</li>
              <li>зарегистрирует Callback API у вашего сообщества (для приёма событий)</li>
              <li>привяжет Mini App к сообществу через API</li>
              <li>пропишет главную кнопку сообщества → «Открыть приложение»</li>
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
