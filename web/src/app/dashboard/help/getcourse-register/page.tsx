'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, Copy, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

type Me = {
  id: number
  integration_token?: string
}

function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex gap-2 items-stretch">
      <code className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono overflow-x-auto whitespace-nowrap text-gray-700">
        {text}
      </code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="px-3 py-2 rounded-lg text-white text-xs font-semibold flex items-center gap-1 flex-shrink-0"
        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
      >
        {copied ? <><Check size={14}/> Скопировано</> : <><Copy size={14}/> Копировать</>}
      </button>
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5 mb-4">
      <div className="flex items-start gap-3 mb-3">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ background: PEACH, color: BRAND }}
        >
          {n}
        </div>
        <h2 className="text-base font-bold pt-1" style={{ color: BRAND }}>{title}</h2>
      </div>
      <div className="text-sm text-gray-700 leading-relaxed space-y-3 pl-11">
        {children}
      </div>
    </div>
  )
}

export default function GetCourseRegisterHelpPage() {
  const [origin, setOrigin] = useState('https://pluson.ru')
  const [me, setMe] = useState<Me | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
    api.auth.me().then((r: any) => setMe(r as Me)).catch(() => {})
  }, [])

  const clientId = me?.id ?? 0
  const secret = me?.integration_token ?? 'ВАШ_ТОКЕН'
  const baseHost = origin.replace(/\/$/, '')

  const urlRegister =
    `${baseHost}/api/v1/integrations/getcourse/register` +
    `?client_id=${clientId || 'ВАШ_CLIENT_ID'}` +
    `&secret=${secret}` +
    `&participant_id={object.pluson_participant_id}` +
    `&email={object.email}` +
    `&phone={object.phone}`

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">GetCourse: регистрация участника</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Регистрация участника со стороннего лендинга (GetCourse)</h1>
          <p className="text-sm text-gray-500 mt-1">
            Как настроить вашу форму на GetCourse так, чтобы при её отправке участник пометился зарегистрированным
            в ПЛЮСОНе автоматически, а email и телефон попали в его карточку.
          </p>
        </div>
      </div>

      <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl border border-amber-200 p-5 mb-6">
        <div className="text-sm font-bold mb-3" style={{ color: BRAND }}>Что мы вам подсовываем в URL лендинга</div>
        <p className="text-sm text-gray-700 mb-2">
          Когда участник из Mini App открывает ваше событие, мы редиректим его на ваш лендинг GetCourse и автоматически
          дописываем в URL всё, что у нас есть о человеке:
        </p>
        <ul className="text-sm text-gray-700 list-disc list-inside space-y-1">
          <li><code className="bg-white px-1.5 py-0.5 rounded text-xs">pluson_participant_id</code> — ID участия в этом событии (содержит и человека, и событие)</li>
          <li><code className="bg-white px-1.5 py-0.5 rounded text-xs">pluson_contact_id</code> — ID контакта в ПЛЮСОНе (без привязки к событию)</li>
          <li><code className="bg-white px-1.5 py-0.5 rounded text-xs">tg_id</code>, <code className="bg-white px-1.5 py-0.5 rounded text-xs">vk_id</code>, <code className="bg-white px-1.5 py-0.5 rounded text-xs">tg_nickname</code></li>
          <li><code className="bg-white px-1.5 py-0.5 rounded text-xs">email</code>, <code className="bg-white px-1.5 py-0.5 rounded text-xs">phone</code>, <code className="bg-white px-1.5 py-0.5 rounded text-xs">name</code> — если уже известны</li>
          <li><code className="bg-white px-1.5 py-0.5 rounded text-xs">event_slug</code> — slug события</li>
        </ul>
        <p className="text-sm text-gray-700 mt-3">
          Для регистрации участника нам обязательно нужен только один параметр — <code className="bg-white px-1 rounded">pluson_participant_id</code>.
          Остальное (email, phone) — дозаполнит карточку контакта.
        </p>
      </div>

      <Step n={1} title="Возьмите свои client_id и токен">
        <p>В разделе <Link href="/dashboard/settings" className="text-blue-600 hover:underline">Настройки → Интеграция</Link> уже выданы:</p>
        <div className="space-y-2">
          <div>
            <div className="text-xs font-semibold text-gray-500 mb-1">Ваш client_id</div>
            <CopyBox text={String(clientId || 'войдите в Настройки')} />
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 mb-1">Ваш токен (secret)</div>
            <CopyBox text={secret} />
          </div>
        </div>
      </Step>

      <Step n={2} title="В GetCourse создайте дополнительное поле «pluson_participant_id»">
        <p>В GetCourse: <b>«Пользователи» → «Дополнительные поля» → «Добавить поле»</b>.</p>
        <ul className="list-disc list-inside space-y-1">
          <li><b>Тип</b> — Строка</li>
          <li><b>Заголовок</b> — <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">pluson_participant_id</code> (точно, буква-в-букву, с префиксом <code className="bg-gray-100 px-1 rounded">pluson_</code> чтобы не конфликтовать с другими полями)</li>
          <li><b>Видимость поля</b> — <b>«Показывать всегда»</b> (а НЕ «Скрыть поле» — иначе GetCourse не сохранит значение в карточку, даже если оно попало в форму)</li>
        </ul>
        <p>Сохраните поле.</p>
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-xs text-rose-900">
          ⚠️ Видимость «Скрыть поле» в GetCourse — ловушка. GetCourse будет рендерить input в DOM формы,
          но <b>не сохранит</b> значение в карточку пользователя, даже если оно туда попало. Ставьте «Показывать всегда»,
          а визуально поле скроем через CSS/настройки формы.
        </div>
      </Step>

      <Step n={3} title="Добавьте поле в форму регистрации">
        <p>Откройте свою форму регистрации в GetCourse → отредактируйте — добавьте только что созданное доп. поле <code className="bg-gray-100 px-1 rounded">pluson_participant_id</code> как <b>скрытое</b>.</p>
        <p>В свойствах формы включите галку <b>«Сохранять GET-параметры в форме»</b> — тогда GetCourse автоматически подхватит значение из URL лендинга и положит его в скрытое поле.</p>
        <p>Форма также должна собирать <b>email</b> и <b>телефон</b> (мы обновим эти поля в карточке контакта в ПЛЮСОНе).</p>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900">
          <b>Сложный случай — виджеты оплаты в iframe.</b> Если у вас не обычная форма, а платёжный виджет GetCourse,
          галка «Сохранять GET-параметры» работает по-другому. См. инструкцию про{' '}
          <Link href="/dashboard/help/getcourse-partner" className="text-blue-700 underline">партнёрский код</Link>{' '} —
          там есть раздел про настройку виджетов с JS-скриптом.
        </div>
      </Step>

      <Step n={4} title="Создайте Процесс в GetCourse">
        <p>Процесс — это автоматизация в GetCourse, которая будет дёргать наш webhook при отправке формы.</p>

        <div className="bg-gray-50 rounded-lg p-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 4.1 — Создать процесс</div>
          <ol className="list-decimal list-inside text-sm space-y-1">
            <li>В GetCourse: <b>Разделы → Процессы → «Создать процесс»</b>.</li>
            <li><b>Название</b> — например, «Плюсон-регистрация».</li>
            <li><b>Тип объекта</b> — выберите <b>«Пользователи»</b>.</li>
            <li>Поставьте галку <b>«Не добавлять исполнителей и супервайзеров»</b> — процесс автоматический.</li>
            <li><b>Шаблон процесса</b> — оставьте «без шаблона». Нажмите <b>«Создать»</b>.</li>
          </ol>
        </div>

        <div className="bg-gray-50 rounded-lg p-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 4.2 — Настройки на вкладке «Общее»</div>
          <ul className="list-disc list-inside text-sm space-y-1">
            <li><b>Суть задачи</b> — впишите что-то (например, «Отправить регистрацию в ПЛЮСОН»). Это для логов.</li>
            <li><b>Массовое создание задач</b> — оставьте <b>«Отключено»</b> (задачи будут создаваться триггером из формы).</li>
            <li>Остальное по дефолту. Нажмите <b>«Сохранить»</b>.</li>
          </ul>
        </div>

        <div className="bg-gray-50 rounded-lg p-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 4.3 — Добавить блок «Вызвать url» на вкладке «Процесс»</div>
          <ol className="list-decimal list-inside text-sm space-y-1">
            <li>Перейдите на вкладку <b>«Процесс»</b> — увидите блок «Начало работы».</li>
            <li>Кнопка <b>«+ Добавить блок»</b> (правый верхний угол) → выберите <b>«Операция»</b>.</li>
            <li>В появившемся окне настройки в списке <b>«Тип операции»</b> выберите <b>«Вызвать url»</b>.</li>
            <li>Заполните поля:
              <ul className="list-disc list-inside ml-4 mt-1 space-y-0.5">
                <li><b>Метод</b> — <b>GET</b>.</li>
                <li><b>Url</b> — вставьте URL ниже (с уже подставленными вашим client_id и токеном).</li>
                <li><b>Время на ожидание/соединение</b> — оставьте по 10 секунд (дефолт).</li>
                <li><b>SSL верификация</b> — Да.</li>
                <li><b>Записать результат в доп. поле</b> (опционально) — создайте доп. поле типа «Текст» (например, <code className="bg-white px-1 rounded">pluson_response</code>) и выберите его. В карточке пользователя будет виден ответ нашего сервера — полезно для отладки.</li>
                <li><b>Менеджер должен подтвердить запуск</b> — НЕ ставьте галку.</li>
              </ul>
            </li>
            <li>Нажмите <b>«Сохранить»</b>.</li>
          </ol>
        </div>

        <div className="bg-gray-50 rounded-lg p-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 4.4 — Соединить блоки</div>
          <ol className="list-decimal list-inside text-sm space-y-1">
            <li>Стрелка от <b>«Начало работы»</b> → к <b>«Вызвать url»</b> (потяните от правого края блока).</li>
            <li>Добавьте через <b>«+ Добавить блок» → «Завершение процесса»</b>.</li>
            <li>Стрелка от <b>«Вызвать url» → «Завершение процесса»</b>.</li>
          </ol>
          <p className="text-xs text-gray-500 mt-1">Должна получиться цепочка: <b>Начало работы → Вызвать url → Завершение процесса</b>.</p>
        </div>

        <div className="bg-gray-50 rounded-lg p-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 4.5 — Одобрить (активировать) процесс</div>
          <p className="text-sm">Свежесозданный процесс в GetCourse <b>«неодобрен»</b> и потому неактивен — задачи по триггерам не создаются, пока процесс не одобрен.</p>
          <ol className="list-decimal list-inside text-sm space-y-1 mt-1">
            <li>Откройте процесс → вкладка <b>«Общее»</b>.</li>
            <li>Внизу слева поставьте галку <b>«Одобрено»</b> (рядом с ней знак вопроса с пояснением от GetCourse).</li>
            <li>Нажмите <b>«Сохранить»</b>.</li>
          </ol>
          <div className="bg-rose-50 border border-rose-200 rounded p-2 mt-2 text-xs text-rose-900">
            ⚠️ Без галки «Одобрено» процесс висит в статусе «Неактивен» — отправка формы триггерит процесс, но задачи не создаются и наш webhook не вызывается.
          </div>
        </div>
      </Step>

      <Step n={5} title="URL для блока «Вызвать url»">
        <p>Вставьте этот URL в поле <b>Url</b> на Шаге 4.3 (Метод: <b>GET</b>):</p>
        <CopyBox text={urlRegister} />
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900">
          <b>Один Процесс на все события.</b> ID события зашит внутрь <code className="bg-white px-1 rounded">pluson_participant_id</code> —
          один и тот же URL работает для любого вашего события.
        </div>
        <p className="text-xs text-gray-600">
          Доступ к доп. полю в GetCourse — через <code className="bg-gray-100 px-1 rounded">{`{object.pluson_participant_id}`}</code> (с пробелами и регистром буква-в-букву).
          Источник синтаксиса — <a href="https://getcourse.ru/blog/276215#variables" target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">официальная документация GetCourse</a>.
        </p>
      </Step>

      <Step n={6} title="Привязать процесс к форме (это делается ВНЕ процесса!)">
        <p>Триггер настраивается в источнике события — в самой форме регистрации:</p>
        <ol className="list-decimal list-inside text-sm space-y-1">
          <li>Откройте свою форму регистрации в GetCourse.</li>
          <li><b>Настройки формы → раздел «Процессы»</b> (или «Действия после отправки»).</li>
          <li>Кнопка <b>«Добавить процесс»</b> → выберите ваш только что созданный процесс «Плюсон-регистрация».</li>
          <li>Условия запуска — оставьте пустыми (для всех отправок).</li>
          <li>Сохраните форму.</li>
        </ol>
      </Step>

      <Step n={7} title="Куда параметры попадают в ПЛЮСОНе">
        <p>После успешного вызова webhook:</p>
        <ul className="space-y-1 list-disc list-inside">
          <li><code className="bg-gray-100 px-1 rounded text-xs">event_participants.is_registered = true</code> для события из <code className="bg-gray-100 px-1 rounded text-xs">pluson_participant_id</code>.</li>
          <li><code className="bg-gray-100 px-1 rounded text-xs">contacts.email</code> и <code className="bg-gray-100 px-1 rounded text-xs">contacts.phone</code> — обновляются из формы.</li>
        </ul>
        <p>Посмотреть результат можно в карточке контакта на странице <Link href="/dashboard/clients" className="text-blue-600 hover:underline">Контакты</Link> — там будет помечен как «Зарегистрирован» на нужное событие.</p>
      </Step>

      <Step n={8} title="Проверка">
        <ol className="list-decimal list-inside text-sm space-y-1">
          <li>Откройте ваше событие в Mini App → нажмите кнопку, которая ведёт на ваш лендинг GetCourse.</li>
          <li>На лендинге заполните и отправьте форму.</li>
          <li>В GetCourse: откройте карточку только что созданного пользователя → должны быть заполнены поля <code className="bg-gray-100 px-1 rounded text-xs">pluson_participant_id</code> и (если включили в Шаг 4.3) <code className="bg-gray-100 px-1 rounded text-xs">pluson_response</code> со статусом OK.</li>
          <li>В ПЛЮСОНе: <Link href="/dashboard/clients" className="text-blue-600 hover:underline">Контакты</Link> → найдите контакт → у нужного события стоит галка «Зарегистрирован».</li>
        </ol>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
          <b>Если в карточке GetCourse поле пустое, хотя в URL лендинга параметр был</b> — проверьте:
          <ul className="list-disc list-inside mt-1">
            <li>Видимость доп. поля стоит «Показывать всегда» (Шаг 2).</li>
            <li>Поле добавлено в форму регистрации (Шаг 3).</li>
            <li>В свойствах формы включена галка «Сохранять GET-параметры в форме» (Шаг 3).</li>
          </ul>
        </div>
      </Step>

      <div className="mt-8 p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
        <p className="text-sm text-gray-600">
          Проверьте в карточке контакта на странице <Link href="/dashboard/clients" className="text-blue-600 hover:underline">Контакты</Link> — помечена ли регистрация.
          Если нет — посмотрите ответ webhook в логах Процесса GetCourse (поле <code className="bg-white px-1 rounded text-xs">pluson_response</code>, если включили).{' '}
          <Link href={SUPPORT_URL}
             className="text-blue-600 hover:underline">
            {SUPPORT_LABEL}
          </Link>
        </p>
      </div>
    </div>
  )
}
