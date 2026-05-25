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

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <pre className="bg-gray-900 text-gray-100 rounded-lg px-3 py-2 text-xs font-mono overflow-x-auto leading-relaxed whitespace-pre">
        {text}
      </pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        className="absolute top-2 right-2 px-2 py-1 rounded text-white text-[10px] font-semibold flex items-center gap-1 bg-gray-700 hover:bg-gray-600"
      >
        {copied ? <><Check size={10}/> ОК</> : <><Copy size={10}/> Копировать</>}
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

  const urlExternalRef =
    `${baseHost}/api/v1/integrations/getcourse/external-ref` +
    `?client_id=${clientId || 'ВАШ_CLIENT_ID'}` +
    `&secret=${secret}` +
    `&contact_id={object.pluson_contact_id}` +
    `&external_ref_param={object.participant_code}`

  const widgetScript = `<script>
$(document).ready(function(){
    // === Доп. поля пользователя — адресуем по ID input'а ===
    // ID берутся из GetCourse: /pl/logic/context/custom-fields?contextName=UserContext
    var CUSTOM = {
        'pluson_contact_id':     13740684,
        'pluson_participant_id': 13740683,
        'tg_id':                 11132047,
        'tg_nickname':           11224895
    };
    Object.keys(CUSTOM).forEach(function(urlParam){
        var v = getQueryParam(urlParam);
        if (v !== false) {
            $('#field-input-' + CUSTOM[urlParam]).val(v).trigger('change');
        }
    });

    // === Стандартные поля — адресуем по атрибуту name ===
    var STD = {
        'email': 'formParams[email]',
        'name':  'formParams[full_name]',
        'phone': 'formParams[phone]'
    };
    Object.keys(STD).forEach(function(urlParam){
        var v = getQueryParam(urlParam);
        if (v !== false) {
            if (urlParam === 'phone' && v.charAt(0) !== '+') v = '+' + v;
            $('input[name="' + STD[urlParam] + '"]').val(v).trigger('change');
        }
    });
});

function getQueryParam(name) {
    var m = window.location.search.match(new RegExp('[?&]' + name + '=([^&]+)'));
    return m ? decodeURIComponent(m[1]) : false;
}
</script>`

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">GetCourse: партнёрский код</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>GetCourse: партнёрский код</h1>
          <p className="text-sm text-gray-500 mt-1">
            Как замкнуть круг «гость → партнёр»: когда GetCourse выдаёт пользователю партнёрский код,
            мы сохраняем его в ПЛЮСОНе. После этого все его ссылки в ПЛЮСОНе автоматически дописывают
            этот код к лендингу, и GetCourse начисляет ему награду за приведённых.
          </p>
        </div>
      </div>

      <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl border border-amber-200 p-5 mb-6">
        <div className="text-sm font-bold mb-3" style={{ color: BRAND }}>Что мы вам подсовываем в URL лендинга</div>
        <p className="text-sm text-gray-700 mb-2">
          При открытии события в Mini App мы редиректим человека на ваш лендинг GetCourse и дописываем в URL все
          параметры (полный список — в <Link href="/dashboard/help/getcourse-register" className="text-blue-600 hover:underline">инструкции про регистрацию</Link>).
          Для партнёрского кода нам нужен только один:
        </p>
        <ul className="text-sm text-gray-700 list-disc list-inside space-y-1">
          <li><code className="bg-white px-1.5 py-0.5 rounded text-xs">pluson_contact_id</code> — ID контакта в ПЛЮСОНе (без привязки к событию).</li>
        </ul>
        <p className="text-sm text-gray-700 mt-3">
          GetCourse через стандартную фичу <b>«Сохранять GET-параметры в форме»</b> сохраняет его в скрытое поле.
          Процесс при заполнении формы дёргает наш webhook и передаёт нам этот <code className="bg-white px-1 rounded">pluson_contact_id</code> и собственный партнёрский код пользователя.
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

      <Step n={2} title="В GetCourse создайте дополнительное поле «pluson_contact_id»">
        <p>В GetCourse: <b>«Пользователи» → «Дополнительные поля» → «Добавить поле»</b>.</p>
        <ul className="list-disc list-inside space-y-1">
          <li><b>Тип</b> — Строка</li>
          <li><b>Заголовок</b> — <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">pluson_contact_id</code></li>
          <li><b>Видимость поля</b> — <b>«Показывать всегда»</b> (а НЕ «Скрыть поле»)</li>
        </ul>
        <p>Добавьте это поле в форму регистрации/оплаты как <b>скрытое</b>, в свойствах формы включите галку <b>«Сохранять GET-параметры в форме»</b>.</p>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900">
          Подробно про создание дополнительных полей и их видимость — в{' '}
          <Link href="/dashboard/help/getcourse-register" className="text-blue-700 underline font-medium">
            инструкции про регистрацию участника
          </Link>{' '} (там же — про ловушку «Скрыть поле»).
        </div>
      </Step>

      <Step n={3} title="Создайте Процесс «Плюсон-партнёрский код»">
        <p>Шаги создания процесса в GetCourse — точно такие же, как для регистрации участника
          (подробно описано в <Link href="/dashboard/help/getcourse-register" className="text-blue-600 hover:underline">инструкции про регистрацию</Link>, Шаг 4).</p>
        <p>Кратко:</p>
        <ol className="list-decimal list-inside text-sm space-y-1">
          <li><b>Разделы → Процессы → Создать процесс</b>. Название — «Плюсон-партнёрский код». Тип объекта — «Пользователи». Галка «Не добавлять исполнителей и супервайзеров».</li>
          <li>На вкладке «Процесс» → <b>+ Добавить блок → Операция → Тип: Вызвать url</b>.</li>
          <li>Метод: <b>GET</b>. URL — см. ниже (Шаг 4).</li>
          <li>Соедините блоки: <b>Начало работы → Вызвать url → Завершение процесса</b>.</li>
          <li>На вкладке «Общее» поставьте галку <b>«Одобрено»</b>.</li>
          <li>В настройках формы регистрации/оплаты привяжите этот процесс через <b>«Добавить процесс»</b>.</li>
        </ol>
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900">
          <b>К одной форме можно привязать оба процесса одновременно</b> — Процесс «Регистрация» пометит участие в событии,
          Процесс «Партнёрский код» запишет код. Если кода ещё нет — webhook просто пропустит обновление.
        </div>
      </Step>

      <Step n={4} title="URL для блока «Вызвать url»">
        <p>Вставьте этот URL в поле <b>Url</b> блока «Вызвать url» (Метод: <b>GET</b>):</p>
        <CopyBox text={urlExternalRef} />
        <div className="mt-3 space-y-2">
          <p className="text-xs text-gray-600">
            <code className="bg-gray-100 px-1 rounded">{`{object.participant_code}`}</code> — это <b>собственный партнёрский код пользователя</b> в вашей GetCourse-партнёрке. Подставляется как полная строка <code className="bg-gray-100 px-1 rounded">gcpc=48922</code> (с префиксом), поэтому в URL пишем <code className="bg-gray-100 px-1 rounded">external_ref_param={`{object.participant_code}`}</code> <b>без</b> дополнительного <code className="bg-gray-100 px-1 rounded">gcpc=</code>. Код виден в карточке партнёра в разделе «Источники → Основной партнёрский код».
            Подтверждено техподдержкой GetCourse (тикет от 25.05.2026).
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
            ⚠️ <b>Не путать с <code className="bg-white px-1 rounded">{`{create_session.gcpc}`}</code></b> — это код <b>того, кто привёл</b> пользователя (входящий партнёрский трафик), а не его собственный.
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900">
            <b>Если код ещё не присвоен</b> (пользователь ещё не партнёр, переменная пустая) — мы НЕ обнуляем существующий код в ПЛЮСОНе, просто пропускаем. Безопасно вешать на любой триггер.
          </div>
        </div>
      </Step>

      <Step n={5} title="Где брать партнёрский код в GetCourse">
        <p>Партнёрский код — это идентификатор, под которым GetCourse засчитывает реферала во <b>вашей</b> партнёрке.
          В URL партнёрской ссылки GetCourse приписывает его как <code className="bg-gray-100 px-1 rounded">?gcpc=48922</code>.</p>
        <p>В ПЛЮСОН передавайте <b>полную строку «ключ=значение»</b>:</p>
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
          <code className="text-amber-900 font-mono">external_ref_param=gcpc=48922</code>
        </div>
        <p>Префикс <code className="bg-gray-100 px-1 rounded">gcpc</code> должен совпадать с тем, что GetCourse читает на лендинге для атрибуции реферала. Если вы переименовали параметр в GetCourse — поменяйте и здесь.</p>
      </Step>

      <Step n={6} title="Куда параметры попадают в ПЛЮСОНе">
        <ul className="space-y-1 list-disc list-inside">
          <li><code className="bg-gray-100 px-1 rounded text-xs">contacts.external_ref_param</code> — записывается партнёрский код целиком. Свежий код перезатирает старый. Пустое значение не обнуляет существующее.</li>
        </ul>
        <p>Карточка контакта на странице <Link href="/dashboard/clients" className="text-blue-600 hover:underline">Контакты</Link> покажет это значение в поле «Партнёрский код внешней платформы».</p>
      </Step>

      <Step n={7} title="Где это используется автоматически">
        <p>Как только у контакта есть <code className="bg-gray-100 px-1 rounded text-xs">external_ref_param</code> — все его ссылки в ПЛЮСОНе работают как партнёрские в обе стороны:</p>
        <div className="bg-gray-50 rounded-lg p-3 text-xs font-mono space-y-1">
          <div><span className="text-gray-500">его ссылка в ПЛЮСОНе:</span> pluson.ru/l/event-slug?<span className="text-amber-700 font-bold">pid={`{его_ref_code}`}</span></div>
          <div className="flex items-center gap-2"><ArrowRight size={12} className="text-gray-400" /> мы автоматически редиректим на ваш лендинг с приписанным:</div>
          <div className="pl-4"><span className="text-gray-500">your-landing.ru/?...&</span><span className="text-amber-700 font-bold">gcpc=48922</span></div>
          <div className="flex items-center gap-2"><ArrowRight size={12} className="text-gray-400" /> GetCourse видит свой <code className="bg-white px-1 rounded">gcpc=48922</code> и засчитывает реферала.</div>
        </div>
      </Step>

      <div className="bg-white rounded-2xl border-2 border-amber-300 p-5 mb-4">
        <h2 className="text-lg font-bold mb-3" style={{ color: BRAND }}>Особый случай: виджеты оплаты в iframe</h2>

        <p className="text-sm text-gray-700 mb-3">
          Если у вас на лендинге не обычная форма GetCourse, а <b>платёжный виджет</b> (он загружается в iframe и открывается в модалке) —
          галка «Сохранять GET-параметры в форме» подхватывает только стандартные поля (email/телефон),
          а ваши скрытые доп. поля типа <code className="bg-gray-100 px-1 rounded">pluson_contact_id</code> остаются пустыми.
          Это особенность виджетов: GetCourse передаёт URL-параметры внутрь iframe, но в input'ы формы их не записывает.
        </p>

        <p className="text-sm text-gray-700 mb-3">
          Решение — добавить в каждый виджет блок <b>«HTML»</b> с маленьким JS-скриптом. Скрипт читает <code className="bg-gray-100 px-1 rounded">window.location.search</code> и сам записывает значения в нужные поля.
        </p>

        <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 mb-3 text-xs text-rose-900">
          <div className="font-semibold mb-1">⚠️ Грабли — на которые легко наступить</div>
          <ul className="list-disc list-inside space-y-0.5">
            <li><b>Не делайте lazy-load виджета.</b> Скрипт виджета GetCourse подписан на <code className="bg-white px-1 rounded">DOMContentLoaded</code> — если вставить его динамически после загрузки страницы, форма никогда не отрисуется. Виджет должен быть встроен сразу в HTML.</li>
            <li><b>Не добавляйте параметры в URL скрипта виджета</b> (<code className="bg-white px-1 rounded">widget/script?id=...&tg_id=...</code>) — GetCourse игнорирует доп. параметры. Он строит iframe.src из <code className="bg-white px-1 rounded">window.location.search</code> страницы.</li>
            <li><b>Видимость поля</b> в GetCourse должна быть «Показывать всегда». При «Скрыть поле» GetCourse рендерит input в DOM, но не сохраняет значение в карточку.</li>
            <li><b>Виджеты изолированы.</b> Скрипт, добавленный в один виджет, не влияет на другие. Если у вас 4 тарифа = 4 виджета — вставьте HTML-блок в каждый.</li>
          </ul>
        </div>

        <div className="bg-gray-50 rounded-lg p-3 mb-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 1 — Найти числовые ID доп. полей в GetCourse</div>
          <p className="text-sm text-gray-700 mb-2">GetCourse использует числовые внутренние ID для адресации полей формы (например, <code className="bg-white px-1 rounded">pluson_contact_id</code> в DOM это <code className="bg-white px-1 rounded">{`<input id="field-input-13740684">`}</code>). Без этого ID скрипт ничего не найдёт.</p>
          <ol className="list-decimal list-inside text-sm space-y-1">
            <li>Откройте URL <code className="bg-white px-1 rounded">https://ВАШ_АККАУНТ.getcourse.ru/pl/logic/context/custom-fields?contextName=UserContext</code></li>
            <li>В Chrome нажмите Cmd+U (View Source)</li>
            <li>Найдите в JS-конфиге участок <code className="bg-white px-1 rounded">fields: [...]</code> — там массив всех доп. полей с <code className="bg-white px-1 rounded">id</code> и <code className="bg-white px-1 rounded">label</code></li>
            <li>Выпишите пары URL-параметр → ID поля (например, <code className="bg-white px-1 rounded">pluson_contact_id → 13740684</code>)</li>
          </ol>
        </div>

        <div className="bg-gray-50 rounded-lg p-3 mb-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 2 — Добавить поля в форму виджета + класс «hide»</div>
          <ol className="list-decimal list-inside text-sm space-y-1">
            <li>В редакторе виджета (<code className="bg-white px-1 rounded">/pl/lite/widget/editor?id=ВАШ_ID</code>) кликните на любое существующее поле формы.</li>
            <li>В нижнем меню → <b>«+ Поле пользователя»</b> → выберите нужное доп. поле (<code className="bg-white px-1 rounded">pluson_contact_id</code>, и т.д.).</li>
            <li>Кликните на блок поля → откройте <b>Style settings</b> → в поле <b>«CSS-класс блока»</b> впишите <code className="bg-white px-1 rounded">hide</code> (или другой класс, который у вас скрывает блок через <code className="bg-white px-1 rounded">display:none</code>).</li>
          </ol>
        </div>

        <div className="bg-gray-50 rounded-lg p-3 mb-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 3 — Вставить HTML-блок со скриптом</div>
          <ol className="list-decimal list-inside text-sm space-y-1 mb-3">
            <li>В редакторе виджета: <b>«+ Добавить блок» → «HTML»</b>.</li>
            <li>Внутрь блока вставьте код ниже (отредактируйте массив <code className="bg-white px-1 rounded">CUSTOM</code> — поставьте свои числовые ID из Шага 1).</li>
            <li>Поставьте блок в самом низу формы виджета.</li>
            <li>Сохраните виджет.</li>
          </ol>
          <CopyBlock text={widgetScript} />
          <p className="text-xs text-gray-500 mt-2">
            jQuery в виджетах GetCourse доступен по умолчанию.
            <code className="bg-white px-1 rounded">.trigger(&apos;change&apos;)</code> — нужен, чтобы GetCourse «увидел» изменение значения программно.
          </p>
        </div>

        <div className="bg-gray-50 rounded-lg p-3">
          <div className="font-semibold text-xs text-gray-700 mb-2">Шаг 4 — Распространить на все виджеты</div>
          <p className="text-sm text-gray-700">Если у вас несколько виджетов (например, 4 тарифа = 4 виджета) — повторите Шаги 2 и 3 для каждого. HTML-блок со скриптом одинаковый, доп. поля те же.</p>
        </div>

        <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900">
          <b>Проверка:</b> откройте лендинг с тестовым URL → нажмите кнопку, открывающую модалку виджета →
          DevTools → Elements → войдите в iframe → найдите input <code className="bg-white px-1 rounded">#field-input-ВАШ_ID</code> → убедитесь, что <code className="bg-white px-1 rounded">value</code> заполнено.
          Затем сделайте тестовую регистрацию → в GetCourse откройте карточку юзера → доп. поле должно быть заполнено.
        </div>
      </div>

      <div className="mt-8 p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
        <p className="text-sm text-gray-600">
          Проверьте в карточке контакта на странице <Link href="/dashboard/clients" className="text-blue-600 hover:underline">Контакты</Link> — заполнилось ли поле <code className="bg-white px-1 rounded text-xs">external_ref_param</code>.
          Если пусто — посмотрите ответ webhook в логах Процесса GetCourse.{' '}
          <a href="https://t.me/margo_forbs?text=Вопрос_по_GetCourse_партнёрке"
             target="_blank" rel="noopener noreferrer"
             className="text-blue-600 hover:underline">
            Написать разработчику
          </a>
        </p>
      </div>
    </div>
  )
}
