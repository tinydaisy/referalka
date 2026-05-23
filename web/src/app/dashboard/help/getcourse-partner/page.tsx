'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, Copy, Check, AlertTriangle, ArrowRight } from 'lucide-react'
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

  // Готовый URL с подставленным client_id и secret. event_id и partner-код
  // клиент дописывает сам — оставляем плейсхолдер.
  const webhookBase = `${origin.replace(/\/$/, '')}/api/v1/integrations/salebot/register`
  const fullUrl =
    `${webhookBase}?client_id=${clientId || 'ВАШ_CLIENT_ID'}` +
    `&secret=${secret}` +
    `&event_id=ID_СОБЫТИЯ` +
    `&platform_user_id={platform_user_id}` +
    `&platform={platform}` +
    `&email={object.email}` +
    `&phone={object.phone}` +
    `&first_name={object.first_name}` +
    `&last_name={object.last_name}` +
    `&telegram_username={ваше_поле_tg_ника}` +
    `&is_registered=1` +
    `&pid={pid}` +
    `&external_ref_param=gcpc={партнёрский_код_GetCourse}`

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Партнёрский код из GetCourse</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Как передавать партнёрский код из GetCourse в ПЛЮСОН</h1>
          <p className="text-sm text-gray-500 mt-1">
            Замыкаем круг «гость → партнёр»: человек регистрируется на лендинге GetCourse, получает там свой партнёрский код,
            мы записываем его в ПЛЮСОН — и теперь когда он шарит свою ссылку, GetCourse начисляет ему вознаграждение автоматически.
          </p>
        </div>
      </div>

      {/* Картинка процесса */}
      <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl border border-amber-200 p-5 mb-6">
        <div className="text-sm font-bold mb-3" style={{ color: BRAND }}>Как это работает</div>
        <ol className="text-sm text-gray-700 space-y-2 leading-relaxed">
          <li><span className="font-bold" style={{ color: BRAND }}>1.</span> Человек открывает Mini App ПЛЮСОН → мы редиректим его на ваш лендинг GetCourse и подсовываем в URL его Telegram-ID (или VK-ID).</li>
          <li><span className="font-bold" style={{ color: BRAND }}>2.</span> GetCourse через стандартную фичу «Сохранять GET-параметры в форме» кладёт эти данные в скрытые поля.</li>
          <li><span className="font-bold" style={{ color: BRAND }}>3.</span> Человек заполняет форму → срабатывает Процесс → блок «Вызвать url» шлёт нам webhook.</li>
          <li><span className="font-bold" style={{ color: BRAND }}>4.</span> ПЛЮСОН находит этого контакта (по Telegram/VK-ID, email, телефону или TG-нику) и записывает его новый партнёрский код в поле <code className="bg-white px-1.5 py-0.5 rounded text-xs">contacts.external_ref_param</code>.</li>
          <li><span className="font-bold" style={{ color: BRAND }}>5.</span> Когда этот человек шарит свою ссылку <code className="bg-white px-1.5 py-0.5 rounded text-xs">pluson.ru/l/{`{slug}`}?pid={`{его_ref_code}`}</code> — мы автоматически дописываем к лендингу его GetCourse-партнёрский код. GetCourse засчитывает ему реферала.</li>
        </ol>
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
        <p className="text-xs text-gray-500">Используются и для Salebot, и для GetCourse, и для любого другого конструктора — один токен на всё.</p>
      </Step>

      <Step n={2} title="В форме GetCourse — создайте скрытые поля">
        <p>В редакторе формы добавьте <b>скрытые поля</b> с такими именами (точно, как написано):</p>
        <ul className="space-y-1 list-disc list-inside text-gray-700">
          <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">platform_user_id</code> — Telegram-ID или VK-ID посетителя</li>
          <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">platform</code> — <code className="bg-gray-100 px-1 rounded">tg</code> или <code className="bg-gray-100 px-1 rounded">vk</code></li>
          <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">pid</code> — кто привёл (наш реф-код), мы кладём в URL</li>
          <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">utm_source</code> — источник трафика (опционально)</li>
        </ul>
        <p>Включите в свойствах формы галку <b>«Сохранять GET-параметры в форме»</b> — GetCourse сам подхватит значения из URL и подставит в эти скрытые поля.</p>
        <p>Также форма должна собирать обычные поля: <b>email</b>, <b>телефон</b>, <b>имя</b>, и желательно <b>TG-ник</b> (на случай если человек пришёл через VK и Telegram-ID мы не знаем).</p>
      </Step>

      <Step n={3} title="Создайте Процесс в GetCourse">
        <ol className="space-y-2 list-decimal list-inside">
          <li>Разделы → <b>Процессы</b> → <b>Создать процесс</b>.</li>
          <li>Тип объекта — <b>Пользователи</b>. Галку «Не добавлять исполнителей» поставьте.</li>
          <li>Сохраните → откройте вкладку <b>Процесс</b> → <b>+ Добавить блок</b> → <b>Операция</b>.</li>
          <li>В типе операции выберите <b>«Вызвать url»</b>.</li>
          <li>Метод — <b>GET</b>. В поле URL вставьте полный URL из шага 4 ниже.</li>
        </ol>
        <p>Триггер запуска процесса повесьте на отправку формы — либо через тег «Заполнил форму», либо в самой форме в «Действиях после отправки».</p>
      </Step>

      <Step n={4} title="URL для блока «Вызвать url»">
        <p>Скопируйте URL ниже. В нём уже подставлены <b>ваш client_id и токен</b>. Замените <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">ID_СОБЫТИЯ</code> на id события из ПЛЮСОНа (видно в URL карточки события в дашборде), а в <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">{`{партнёрский_код_GetCourse}`}</code> подставьте переменную из GetCourse, где лежит код партнёра, выданный этому человеку:</p>
        <CopyBox text={fullUrl} />
        <p className="text-xs text-gray-500 mt-2">Имена переменных в фигурных скобках типа <code>{`{object.email}`}</code> — это синтаксис GetCourse для подстановки полей пользователя/формы. Замените <code>{`{ваше_поле_tg_ника}`}</code> на имя вашего скрытого/обычного поля с TG-юзернеймом.</p>
      </Step>

      <Step n={5} title="Откуда брать партнёрский код в GetCourse">
        <p>Партнёрский код — это идентификатор, под которым GetCourse засчитывает реферала во <b>вашей</b> партнёрке (GetCourse Partner Cabinet, Bizon360, другая). Обычно он выглядит как короткая строка, например <code className="bg-gray-100 px-1 rounded">fdd97</code>, а в URL партнёрской ссылки GetCourse приписывает его как <code className="bg-gray-100 px-1 rounded">?gcpc=fdd97</code>.</p>
        <p>В ПЛЮСОН передавайте <b>полную строку «ключ=значение»</b>:</p>
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
          <code className="text-amber-900 font-mono">external_ref_param=gcpc=fdd97</code>
        </div>
        <p>Когда в URL уже стоит <code>external_ref_param=gcpc=</code>, остаётся только подставить <b>переменную GetCourse с самим кодом</b> сразу после знака равно. Имя этой переменной зависит от вашей настройки партнёрки — посмотрите в админке GetCourse, где хранится код партнёра у пользователя.</p>
        <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg p-3">
          <AlertTriangle size={16} className="text-blue-700 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-blue-900 leading-relaxed">
            <b>Префикс ключа</b> (<code className="bg-white px-1 rounded">gcpc</code>, или <code className="bg-white px-1 rounded">partner</code>, или другое) должен совпадать с тем, что GetCourse читает на лендинге для атрибуции реферала. Уточните префикс в настройках вашей партнёрки GetCourse.
          </div>
        </div>
      </Step>

      <Step n={6} title="Куда параметр попадает в ПЛЮСОНе">
        <p>После успешного вызова webhook:</p>
        <ul className="space-y-1 list-disc list-inside">
          <li>Контакт находится по <code className="bg-gray-100 px-1 rounded text-xs">platform_user_id</code> + <code className="bg-gray-100 px-1 rounded text-xs">platform</code>, либо по email / телефону / TG-нику (в таком порядке приоритета).</li>
          <li>Поле <code className="bg-gray-100 px-1 rounded text-xs">contacts.external_ref_param</code> <b>перезаписывается</b> новым значением (свежее важнее старого).</li>
          <li>Если передан <code className="bg-gray-100 px-1 rounded text-xs">event_id</code> и контакт ещё не зарегистрирован на это событие — создаётся запись в <code className="bg-gray-100 px-1 rounded text-xs">event_participants</code> с <code className="bg-gray-100 px-1 rounded text-xs">is_registered=true</code>.</li>
          <li>Если передан <code className="bg-gray-100 px-1 rounded text-xs">pid</code> — мы находим партнёра-привлекателя по этому коду и пишем его в <code className="bg-gray-100 px-1 rounded text-xs">event_participants.referrer_ref_code</code> (только при первом INSERT; повторно не перезатирается — first-touch атрибуция).</li>
        </ul>
        <p>Карточка контакта на странице <Link href="/dashboard/clients" className="text-blue-600 hover:underline">Контакты</Link> покажет это значение в поле «Партнёрский код внешней платформы».</p>
      </Step>

      <Step n={7} title="Где это используется автоматически">
        <p>Как только у контакта есть <code className="bg-gray-100 px-1 rounded text-xs">external_ref_param</code> — все ссылки этого человека внутри ПЛЮСОНа начинают работать как партнёрские ссылки <b>в обе стороны</b>:</p>
        <div className="bg-gray-50 rounded-lg p-3 text-xs font-mono space-y-1">
          <div><span className="text-gray-500">его ссылка в ПЛЮСОНе:</span> pluson.ru/l/event-slug?<span className="text-amber-700 font-bold">pid={`{его_ref_code}`}</span></div>
          <div className="flex items-center gap-2"><ArrowRight size={12} className="text-gray-400" /> мы автоматически редиректим на ваш лендинг с приписанным:</div>
          <div className="pl-4"><span className="text-gray-500">your-landing.ru/?...&</span><span className="text-amber-700 font-bold">gcpc=fdd97</span></div>
          <div className="flex items-center gap-2"><ArrowRight size={12} className="text-gray-400" /> GetCourse видит свой <code className="bg-white px-1 rounded">gcpc=fdd97</code> и засчитывает реферала.</div>
        </div>
      </Step>

      <Step n={8} title="Что попадает в URL формы — для проверки">
        <p>Когда человек открывает Mini App ПЛЮСОН и нас редиректит на ваш лендинг, мы дописываем такие GET-параметры (значения зависят от платформы захода):</p>
        <div className="bg-gray-50 rounded-lg p-3 text-xs font-mono space-y-0.5 text-gray-700">
          <div>?event_slug=ваш-slug</div>
          <div>&platform_user_id=583923847  <span className="text-gray-400">(TG-ID или VK-ID)</span></div>
          <div>&platform=tg  <span className="text-gray-400">(или vk, max)</span></div>
          <div>&pid=ABC123  <span className="text-gray-400">(кто привёл — наш реф-код)</span></div>
          <div>&utm_source=insta</div>
          <div>&tg_id=583923847  <span className="text-gray-400">(legacy — для обратной совместимости)</span></div>
        </div>
        <p>В скрытые поля формы кладите ровно эти имена — тогда GetCourse подхватит их автоматически.</p>
      </Step>

      <div className="mt-8 p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
        <p className="text-sm text-gray-600">
          Проверьте логи на странице <Link href="/dashboard/clients" className="text-blue-600 hover:underline">Контакты</Link> — если контакт создался, но <code className="bg-white px-1 rounded text-xs">external_ref_param</code> пустой, значит в URL пришёл пустой параметр (проверьте имя переменной GetCourse). Если контакта не создалось вовсе — посмотрите ответ webhook в логах Процесса GetCourse: обычно там понятная ошибка.
          {' '}Если совсем тупик —{' '}
          <a href="https://t.me/margo_forbs?text=Вопрос_по_GetCourse_webhook"
             target="_blank" rel="noopener noreferrer"
             className="text-blue-600 hover:underline">
            напишите разработчику
          </a>
        </p>
      </div>
    </div>
  )
}
