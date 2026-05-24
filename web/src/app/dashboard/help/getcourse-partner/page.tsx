'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, Copy, Check, ArrowRight } from 'lucide-react'
import { api } from '@/lib/api'

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

export default function GetCoursePartnerHelpPage() {
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

  const urlExternalRef =
    `${baseHost}/api/v1/integrations/getcourse/external-ref` +
    `?client_id=${clientId || 'ВАШ_CLIENT_ID'}` +
    `&secret=${secret}` +
    `&contact_id={object.pluson_contact_id}` +
    `&external_ref_param=gcpc={participant_code}`

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">GetCourse: регистрация и партнёрский код</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>GetCourse: регистрация и партнёрский код</h1>
          <p className="text-sm text-gray-500 mt-1">
            Два независимых Процесса в GetCourse, которые отправляют данные в ПЛЮСОН по webhook'у:
            один — отметить регистрацию на событии и обновить email/телефон,
            второй — записать партнёрский код, который GetCourse выдал человеку в своей партнёрке.
          </p>
        </div>
      </div>

      <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl border border-amber-200 p-5 mb-6">
        <div className="text-sm font-bold mb-3" style={{ color: BRAND }}>Что мы вам подсовываем в URL лендинга</div>
        <p className="text-sm text-gray-700 mb-2">При открытии события в Mini App мы редиректим человека на ваш лендинг GetCourse и дописываем в URL два скрытых параметра:</p>
        <ul className="text-sm text-gray-700 list-disc list-inside space-y-1">
          <li><code className="bg-white px-1.5 py-0.5 rounded text-xs">participant_id</code> — ID участия в этом событии (содержит и человека, и событие).</li>
          <li><code className="bg-white px-1.5 py-0.5 rounded text-xs">contact_id</code> — ID контакта в ПЛЮСОНе (без привязки к событию).</li>
        </ul>
        <p className="text-sm text-gray-700 mt-3">GetCourse через стандартную фичу <b>«Сохранять GET-параметры в форме»</b> сохраняет их в скрытые поля. Один Процесс использует <code className="bg-white px-1 rounded">participant_id</code>, другой — <code className="bg-white px-1 rounded">contact_id</code>.</p>
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

      <Step n={2} title="В форме GetCourse — создайте два скрытых (дополнительных) поля">
        <p>В GetCourse: <b>«Пользователи» → «Дополнительные поля» → «Добавить поле»</b>, тип <b>Строка</b>. Создайте два поля с такими заголовками (точно, буква-в-букву, с префиксом <code className="bg-gray-100 px-1 rounded">pluson_</code> чтобы не конфликтовать с другими полями):</p>
        <ul className="list-disc list-inside space-y-1">
          <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">pluson_participant_id</code></li>
          <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">pluson_contact_id</code></li>
        </ul>
        <p>Эти поля добавьте в форму как <b>скрытые</b>, и в свойствах формы включите галку <b>«Сохранять GET-параметры в форме»</b> — GetCourse подхватит значения из URL автоматически. Также форма должна собирать <b>email</b> и <b>телефон</b> (обновим в карточке контакта).</p>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900">
          <b>Если у вас другие имена полей</b> — поменяйте соответствующим образом в URL ниже. Доступ к доп. полю в GetCourse — через <code className="bg-white px-1 rounded">{`{object.заголовок_поля}`}</code> (с пробелами и регистром буква-в-букву). Синтаксис из <a href="https://getcourse.ru/blog/276215#variables" target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">официальной документации GetCourse</a>.
        </div>
      </Step>

      <Step n={3} title="Как создать Процесс в GetCourse (общий шаблон для обоих процессов)">
        <p>Этот шаблон работает и для Процесса №1 (Регистрация), и для Процесса №2 (Партнёрский код) — отличаются только название и URL.</p>

        <div className="bg-gray-50 rounded-lg p-3 mt-2">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 3.1 — Создать процесс</div>
          <ol className="list-decimal list-inside text-sm space-y-1">
            <li>В GetCourse: <b>Разделы → Процессы → «Создать процесс»</b>.</li>
            <li><b>Название</b> — например, «Плюсон-регистрация» или «Плюсон-передача партнёрского кода».</li>
            <li><b>Тип объекта</b> — выберите <b>«Пользователи»</b>.</li>
            <li>Поставьте галку <b>«Не добавлять исполнителей и супервайзеров»</b> — процесс автоматический.</li>
            <li><b>Шаблон процесса</b> — оставьте «без шаблона». Нажмите <b>«Создать»</b>.</li>
          </ol>
        </div>

        <div className="bg-gray-50 rounded-lg p-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 3.2 — Настройки на вкладке «Общее»</div>
          <ul className="list-disc list-inside text-sm space-y-1">
            <li><b>Суть задачи</b> — впишите что-то (например, «Отправить в ПЛЮСОН»). Это для логов.</li>
            <li><b>Массовое создание задач</b> — оставьте <b>«Отключено»</b> (задачи будут создаваться триггером из формы).</li>
            <li>Остальное по дефолту. Нажмите <b>«Сохранить»</b>.</li>
          </ul>
        </div>

        <div className="bg-gray-50 rounded-lg p-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 3.3 — Добавить блок «Вызвать url» на вкладке «Процесс»</div>
          <ol className="list-decimal list-inside text-sm space-y-1">
            <li>Перейдите на вкладку <b>«Процесс»</b> — увидите блок «Начало работы».</li>
            <li>Кнопка <b>«+ Добавить блок»</b> (правый верхний угол) → выберите <b>«Операция»</b>.</li>
            <li>В появившемся окне настройки в списке <b>«Тип операции»</b> выберите <b>«Вызвать url»</b>.</li>
            <li>Заполните поля:
              <ul className="list-disc list-inside ml-4 mt-1 space-y-0.5">
                <li><b>Метод</b> — <b>GET</b>.</li>
                <li><b>Url</b> — вставьте URL для нужного Процесса (см. карточки ниже).</li>
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
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 3.4 — Соединить блоки</div>
          <ol className="list-decimal list-inside text-sm space-y-1">
            <li>Стрелка от <b>«Начало работы»</b> → к <b>«Вызвать url»</b> (потяните от правого края блока).</li>
            <li>Добавьте через <b>«+ Добавить блок» → «Завершение процесса»</b>.</li>
            <li>Стрелка от <b>«Вызвать url» → «Завершение процесса»</b>.</li>
          </ol>
          <p className="text-xs text-gray-500 mt-1">Должна получиться цепочка: <b>Начало работы → Вызвать url → Завершение процесса</b>.</p>
        </div>

        <div className="bg-gray-50 rounded-lg p-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 3.5 — Одобрить (активировать) процесс</div>
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

        <div className="bg-gray-50 rounded-lg p-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 3.6 — Привязать триггер запуска (это делается ВНЕ процесса!)</div>
          <p className="text-sm">Триггер настраивается в источнике события — в самой форме регистрации:</p>
          <ol className="list-decimal list-inside text-sm space-y-1 mt-1">
            <li>Откройте свою форму регистрации в GetCourse.</li>
            <li><b>Настройки формы → раздел «Процессы»</b> (или «Действия после отправки»).</li>
            <li>Кнопка <b>«Добавить процесс»</b> → выберите ваш только что созданный процесс (например, «Плюсон-регистрация»).</li>
            <li>Условия запуска — оставьте пустыми (для всех отправок).</li>
            <li>Сохраните форму.</li>
          </ol>
          <p className="text-xs text-gray-500 mt-1">К одной форме можно привязать <b>оба процесса одновременно</b> — Процесс №1 пометит регистрацию, Процесс №2 запишет партнёрский код. Если кода ещё нет — webhook просто пропустит обновление (см. ниже).</p>
        </div>
      </Step>

      <div className="bg-white border-2 border-emerald-200 rounded-2xl p-5 mb-4">
        <h2 className="text-lg font-bold mb-3" style={{ color: BRAND }}>Процесс №1 — Регистрация на событии</h2>
        <p className="text-sm text-gray-600 mb-3">Срабатывает на отправку формы регистрации. Помечает <code className="bg-gray-100 px-1 rounded text-xs">event_participants.is_registered=true</code>, обновляет email и телефон контакта.</p>

        <div className="text-xs font-semibold text-gray-500 mb-1">URL для блока «Вызвать url» (Метод: GET)</div>
        <CopyBox text={urlRegister} />

        <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900">
          <b>Один Процесс на все события.</b> ID события зашит внутрь <code className="bg-white px-1 rounded">participant_id</code> — один и тот же URL работает для любого вашего события.
        </div>
      </div>

      <div className="bg-white border-2 border-amber-200 rounded-2xl p-5 mb-4">
        <h2 className="text-lg font-bold mb-3" style={{ color: BRAND }}>Процесс №2 — Партнёрский код GetCourse</h2>
        <p className="text-sm text-gray-600 mb-3">Срабатывает когда GetCourse присваивает человеку партнёрский код в своей партнёрке (например, <code className="bg-gray-100 px-1 rounded text-xs">gcpc=08cea</code>). Записывает этот код в карточку контакта в ПЛЮСОНе.</p>

        <div className="text-xs font-semibold text-gray-500 mb-1">URL для блока «Вызвать url» (Метод: GET)</div>
        <CopyBox text={urlExternalRef} />

        <div className="mt-3 space-y-2">
          <p className="text-xs text-gray-600">
            <code className="bg-gray-100 px-1 rounded">{`{participant_code}`}</code> — это <b>собственный партнёрский код пользователя</b> в вашей GetCourse-партнёрке (то, что GetCourse выдаёт человеку после регистрации партнёром, например <code className="bg-gray-100 px-1 rounded">48922</code>). Виден в карточке партнёра в разделе «Источники → Основной партнёрский код». Подробнее — <a href="https://getcourse.ru/blog/733095" target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">официальный гайд GetCourse</a>.
          </p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900">
            <b>Если код ещё не присвоен</b> (пользователь ещё не партнёр, переменная пустая) — мы НЕ обнуляем существующий код в ПЛЮСОНе, просто пропускаем. Безопасно вешать на любой триггер.
          </div>
        </div>
      </div>

      <Step n={4} title="Где брать партнёрский код в GetCourse">
        <p>Партнёрский код — это идентификатор, под которым GetCourse засчитывает реферала во <b>вашей</b> партнёрке. В URL партнёрской ссылки GetCourse приписывает его как <code className="bg-gray-100 px-1 rounded">?gcpc=08cea</code>.</p>
        <p>В ПЛЮСОН передавайте <b>полную строку «ключ=значение»</b>:</p>
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
          <code className="text-amber-900 font-mono">external_ref_param=gcpc=08cea</code>
        </div>
        <p>Префикс <code className="bg-gray-100 px-1 rounded">gcpc</code> (или другой) должен совпадать с тем, что GetCourse читает на лендинге для атрибуции реферала.</p>
      </Step>

      <Step n={5} title="Куда параметры попадают в ПЛЮСОНе">
        <p>После Процесса №1 (регистрация):</p>
        <ul className="space-y-1 list-disc list-inside">
          <li><code className="bg-gray-100 px-1 rounded text-xs">event_participants.is_registered = true</code> для события из <code className="bg-gray-100 px-1 rounded text-xs">participant_id</code>.</li>
          <li><code className="bg-gray-100 px-1 rounded text-xs">contacts.email</code> и <code className="bg-gray-100 px-1 rounded text-xs">contacts.phone</code> — обновляются из формы.</li>
        </ul>
        <p>После Процесса №2 (партнёрский код):</p>
        <ul className="space-y-1 list-disc list-inside">
          <li><code className="bg-gray-100 px-1 rounded text-xs">contacts.external_ref_param</code> — записывается партнёрский код целиком. Свежий код перезатирает старый. Пустое значение не обнуляет существующее.</li>
        </ul>
        <p>Карточка контакта на странице <Link href="/dashboard/clients" className="text-blue-600 hover:underline">Контакты</Link> покажет это значение в поле «Партнёрский код внешней платформы».</p>
      </Step>

      <Step n={6} title="Где это используется автоматически">
        <p>Как только у контакта есть <code className="bg-gray-100 px-1 rounded text-xs">external_ref_param</code> — все его ссылки в ПЛЮСОНе работают как партнёрские в обе стороны:</p>
        <div className="bg-gray-50 rounded-lg p-3 text-xs font-mono space-y-1">
          <div><span className="text-gray-500">его ссылка в ПЛЮСОНе:</span> pluson.ru/l/event-slug?<span className="text-amber-700 font-bold">pid={`{его_ref_code}`}</span></div>
          <div className="flex items-center gap-2"><ArrowRight size={12} className="text-gray-400" /> мы автоматически редиректим на ваш лендинг с приписанным:</div>
          <div className="pl-4"><span className="text-gray-500">your-landing.ru/?...&</span><span className="text-amber-700 font-bold">gcpc=08cea</span></div>
          <div className="flex items-center gap-2"><ArrowRight size={12} className="text-gray-400" /> GetCourse видит свой <code className="bg-white px-1 rounded">gcpc=08cea</code> и засчитывает реферала.</div>
        </div>
      </Step>

      <div className="mt-8 p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
        <p className="text-sm text-gray-600">
          Проверьте в карточке контакта на странице <Link href="/dashboard/clients" className="text-blue-600 hover:underline">Контакты</Link> — заполнилось ли поле <code className="bg-white px-1 rounded text-xs">external_ref_param</code> и помечена ли регистрация. Если пусто — посмотрите ответ webhook в логах Процесса GetCourse.{' '}
          <a href="https://t.me/margo_forbs?text=Вопрос_по_GetCourse_webhook"
             target="_blank" rel="noopener noreferrer"
             className="text-blue-600 hover:underline">
            Написать разработчику
          </a>
        </p>
      </div>
    </div>
  )
}
