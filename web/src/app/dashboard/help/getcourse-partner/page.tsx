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
    `&participant_id={participant_id}` +
    `&email={object.email}` +
    `&phone={object.phone}`

  const urlExternalRef =
    `${baseHost}/api/v1/integrations/getcourse/external-ref` +
    `?client_id=${clientId || 'ВАШ_CLIENT_ID'}` +
    `&secret=${secret}` +
    `&contact_id={contact_id}` +
    `&external_ref_param=gcpc={партнёрский_код_GetCourse}`

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

      <Step n={2} title="В форме GetCourse — создайте два скрытых поля">
        <ul className="list-disc list-inside space-y-1">
          <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">participant_id</code></li>
          <li><code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">contact_id</code></li>
        </ul>
        <p>В свойствах формы включите галку <b>«Сохранять GET-параметры в форме»</b> — GetCourse подхватит значения из URL автоматически. Также форма должна собирать <b>email</b> и <b>телефон</b> (обновим в карточке контакта).</p>
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
          <p className="text-xs text-gray-600">Замените <code className="bg-gray-100 px-1 rounded">{`{партнёрский_код_GetCourse}`}</code> на переменную GetCourse, в которой лежит партнёрский код этого человека. Имя переменной зависит от вашей настройки партнёрки.</p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900">
            <b>Если код ещё не присвоен</b> (пустое значение типа <code className="bg-white px-1 rounded">gcpc=</code>) — мы НЕ обнуляем существующий код в ПЛЮСОНе, просто пропускаем. Безопасно вешать на любой триггер.
          </div>
        </div>
      </div>

      <Step n={3} title="Где брать партнёрский код в GetCourse">
        <p>Партнёрский код — это идентификатор, под которым GetCourse засчитывает реферала во <b>вашей</b> партнёрке. В URL партнёрской ссылки GetCourse приписывает его как <code className="bg-gray-100 px-1 rounded">?gcpc=08cea</code>.</p>
        <p>В ПЛЮСОН передавайте <b>полную строку «ключ=значение»</b>:</p>
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
          <code className="text-amber-900 font-mono">external_ref_param=gcpc=08cea</code>
        </div>
        <p>Префикс <code className="bg-gray-100 px-1 rounded">gcpc</code> (или другой) должен совпадать с тем, что GetCourse читает на лендинге для атрибуции реферала.</p>
      </Step>

      <Step n={4} title="Куда параметры попадают в ПЛЮСОНе">
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

      <Step n={5} title="Где это используется автоматически">
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
