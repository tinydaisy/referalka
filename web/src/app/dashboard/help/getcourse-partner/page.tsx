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

  const webhookBase = `${origin.replace(/\/$/, '')}/api/v1/integrations/salebot/register`
  const fullUrl =
    `${webhookBase}?client_id=${clientId || 'ВАШ_CLIENT_ID'}` +
    `&secret=${secret}` +
    `&event_id=ID_СОБЫТИЯ` +
    `&contact_id={contact_id}` +
    `&email={object.email}` +
    `&phone={object.phone}` +
    `&external_ref_param=gcpc={партнёрский_код_GetCourse}` +
    `&is_registered=1`

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
            После заполнения формы на лендинге GetCourse мы получаем email, телефон и партнёрский код этого человека (например, <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">gcpc=08cea</code>), сохраняем у него в карточке контакта и отмечаем регистрацию на событие.
          </p>
        </div>
      </div>

      <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-2xl border border-amber-200 p-5 mb-6">
        <div className="text-sm font-bold mb-3" style={{ color: BRAND }}>Как это работает</div>
        <ol className="text-sm text-gray-700 space-y-2 leading-relaxed">
          <li><span className="font-bold" style={{ color: BRAND }}>1.</span> Человек открывает Mini App ПЛЮСОН → мы редиректим его на ваш лендинг GetCourse и подсовываем в URL <code className="bg-white px-1.5 py-0.5 rounded text-xs">contact_id</code> — его ID в нашей базе.</li>
          <li><span className="font-bold" style={{ color: BRAND }}>2.</span> GetCourse через стандартную фичу «Сохранять GET-параметры в форме» кладёт <code className="bg-white px-1.5 py-0.5 rounded text-xs">contact_id</code> в скрытое поле.</li>
          <li><span className="font-bold" style={{ color: BRAND }}>3.</span> Человек заполняет форму → срабатывает Процесс → блок «Вызвать url» шлёт нам webhook с <code className="bg-white px-1.5 py-0.5 rounded text-xs">contact_id</code> + email + телефон + партнёрский код GetCourse.</li>
          <li><span className="font-bold" style={{ color: BRAND }}>4.</span> ПЛЮСОН находит контакта по <code className="bg-white px-1.5 py-0.5 rounded text-xs">contact_id</code>, обновляет ему email и телефон, записывает партнёрский код в поле <code className="bg-white px-1.5 py-0.5 rounded text-xs">external_ref_param</code>, отмечает <code className="bg-white px-1.5 py-0.5 rounded text-xs">is_registered=true</code> на событие.</li>
          <li><span className="font-bold" style={{ color: BRAND }}>5.</span> Когда этот человек шарит свою ссылку <code className="bg-white px-1.5 py-0.5 rounded text-xs">pluson.ru/l/{`{slug}`}?pid={`{его_ref_code}`}</code> — мы автоматически дописываем к URL лендинга его GetCourse-партнёрский код. GetCourse засчитывает ему реферала.</li>
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
      </Step>

      <Step n={2} title="В форме GetCourse — создайте скрытое поле contact_id">
        <p>В редакторе формы добавьте одно <b>скрытое поле</b> с именем <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">contact_id</code>.</p>
        <p>В свойствах формы включите галку <b>«Сохранять GET-параметры в форме»</b> — GetCourse сам подхватит значение из URL.</p>
        <p>Также форма должна собирать обычные поля <b>email</b> и <b>телефон</b> (если у клиента в кабинете этих данных ещё нет — мы их допишем; если есть — обновим).</p>
      </Step>

      <Step n={3} title="Создайте Процесс в GetCourse">
        <ol className="space-y-2 list-decimal list-inside">
          <li>Разделы → <b>Процессы</b> → <b>Создать процесс</b>.</li>
          <li>Тип объекта — <b>Пользователи</b>. Галку «Не добавлять исполнителей» поставьте.</li>
          <li>Сохраните → откройте вкладку <b>Процесс</b> → <b>+ Добавить блок</b> → <b>Операция</b>.</li>
          <li>В типе операции выберите <b>«Вызвать url»</b>.</li>
          <li>Метод — <b>GET</b>. В поле URL вставьте URL из шага 4 ниже.</li>
        </ol>
        <p>Триггер запуска процесса повесьте на отправку формы — либо через тег, либо в «Действиях после отправки» в самой форме.</p>
      </Step>

      <Step n={4} title="URL для блока «Вызвать url»">
        <p>Скопируйте URL ниже. В нём уже подставлены <b>ваш client_id и токен</b>. Замените:</p>
        <ul className="list-disc list-inside space-y-1">
          <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">ID_СОБЫТИЯ</code> — id события из ПЛЮСОНа (видно в URL карточки события в дашборде)</li>
          <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">{`{партнёрский_код_GetCourse}`}</code> — переменная GetCourse, в которой лежит партнёрский код этого человека (например, <code className="bg-gray-100 px-1 rounded">08cea</code>). Какая именно переменная — зависит от вашей партнёрки в GetCourse.</li>
        </ul>
        <CopyBox text={fullUrl} />
        <p className="text-xs text-gray-500 mt-2">Параметры в фигурных скобках типа <code>{`{object.email}`}</code> и <code>{`{contact_id}`}</code> — это синтаксис GetCourse для подстановки значений из полей пользователя/формы.</p>
      </Step>

      <Step n={5} title="Откуда брать партнёрский код в GetCourse">
        <p>Партнёрский код — это идентификатор, под которым GetCourse засчитывает реферала во <b>вашей</b> партнёрке (GetCourse Partner Cabinet, Bizon360 или другая). В URL партнёрской ссылки GetCourse приписывает его как <code className="bg-gray-100 px-1 rounded">?gcpc=08cea</code>.</p>
        <p>В ПЛЮСОН передавайте <b>полную строку «ключ=значение»</b>:</p>
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
          <code className="text-amber-900 font-mono">external_ref_param=gcpc=08cea</code>
        </div>
        <p>Префикс <code className="bg-gray-100 px-1 rounded">gcpc</code> (или другой) должен совпадать с тем, что GetCourse читает на лендинге для атрибуции реферала. Уточните в настройках вашей партнёрки GetCourse.</p>
      </Step>

      <Step n={6} title="Куда параметр попадает в ПЛЮСОНе">
        <p>После успешного вызова webhook у контакта обновляется:</p>
        <ul className="space-y-1 list-disc list-inside">
          <li><code className="bg-gray-100 px-1 rounded text-xs">contacts.email</code> и <code className="bg-gray-100 px-1 rounded text-xs">contacts.phone</code> — если переданы непустые значения, перезаписываются.</li>
          <li><code className="bg-gray-100 px-1 rounded text-xs">contacts.external_ref_param</code> — записывается партнёрский код целиком (например, <code className="bg-gray-100 px-1 rounded">gcpc=08cea</code>). Свежий код перезатирает старый.</li>
          <li><code className="bg-gray-100 px-1 rounded text-xs">event_participants.is_registered = true</code> для указанного <code className="bg-gray-100 px-1 rounded text-xs">event_id</code>. Если контакт ещё не был на событии — создаётся запись.</li>
        </ul>
        <p>Карточка контакта на странице <Link href="/dashboard/clients" className="text-blue-600 hover:underline">Контакты</Link> покажет это значение в поле «Партнёрский код внешней платформы».</p>
      </Step>

      <Step n={7} title="Где это используется автоматически">
        <p>Как только у контакта есть <code className="bg-gray-100 px-1 rounded text-xs">external_ref_param</code> — все его ссылки в ПЛЮСОНе начинают работать как партнёрские <b>в обе стороны</b>:</p>
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
          Проверьте в карточке контакта на странице <Link href="/dashboard/clients" className="text-blue-600 hover:underline">Контакты</Link>, заполнилось ли поле <code className="bg-white px-1 rounded text-xs">external_ref_param</code>. Если пусто — посмотрите ответ webhook в логах Процесса GetCourse, обычно там понятная ошибка.{' '}
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
