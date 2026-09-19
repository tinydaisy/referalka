'use client'

/**
 * Шаг 2: получить три значения и связать хранилище с ПЛЮСОНом.
 *
 * ⚠️ Структура статьи: СНАЧАЛА цель («нужны три значения») и куда их вставить,
 * и только ПОТОМ — как получить каждое. Обратный порядок (сначала двадцать
 * экранов настройки, в конце «а теперь вставьте») человек не дочитывает: он не
 * понимает, ради чего всё это делает.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Crumbs, Hero, Step, Note, Warn, Accent, Screenshot } from '../_article'
import { ArrowRight, ExternalLink, Check, Loader2 } from 'lucide-react'

const S = '/help/cloud-storage'
const CLOUD = 'https://console.cloud.ru'

const API = process.env.NEXT_PUBLIC_API_URL || ''

/**
 * Три поля прямо в инструкции + кнопка подключения.
 *
 * ⚠️ Значения сохраняются в браузере (localStorage) на время настройки: человек
 * уходит в Cloud.ru за каждым из них и возвращается — без этого введённое
 * пропадало бы при каждом переключении вкладки.
 */
function ConnectForm() {
  const KEY = 'pluson_cloud_draft'
  const [v, setV] = useState({ tenant_id: '', access_key: '', secret_key: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [done, setDone] = useState<{ global_name: string } | null>(null)
  const [verified, setVerified] = useState<string | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) setV({ ...v, ...JSON.parse(raw) })
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const upd = (k: string, val: string) => {
    const next = { ...v, [k]: val }
    setV(next)
    // ⚠️ Секретный ключ в браузере не храним — он даёт полный доступ к хранилищу.
    try { localStorage.setItem(KEY, JSON.stringify({ ...next, secret_key: '' })) } catch {}
  }

  const connect = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(`${API}/api/v1/clients/me/storage/quick-connect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('plusson_token')}`,
                   'Content-Type': 'application/json' },
        body: JSON.stringify(v),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.detail || 'Не удалось подключить')
      setDone({ global_name: d.global_name })
      setMsg({ ok: true, text: d.message })
      try { localStorage.removeItem(KEY) } catch {}
    } catch (e: any) {
      setMsg({ ok: false, text: e.message })
    } finally { setBusy(false) }
  }

  // ⚠️ Проверяем ПУБЛИЧНОЙ ссылкой и показываем картинку глазами: проверка
  // по ключам прошла бы и при незаполненном глобальном имени, а у посетителей
  // вместо афиш были бы пустые места.
  const verify = async () => {
    setBusy(true); setMsg(null)
    try {
      const h = { Authorization: `Bearer ${localStorage.getItem('plusson_token')}` }
      await fetch(`${API}/api/v1/clients/me/storage/test-image`, { method: 'POST', headers: h })
      const r = await fetch(`${API}/api/v1/clients/me/storage/verify-public`, { method: 'POST', headers: h })
      const d = await r.json()
      if (d.ok) { setVerified(d.url); setMsg({ ok: true, text: d.message }) }
      else { setVerified(null); setMsg({ ok: false, text: d.message }) }
    } catch (e: any) {
      setMsg({ ok: false, text: 'Не удалось проверить — попробуйте ещё раз.' })
    } finally { setBusy(false) }
  }

  const filled = v.tenant_id.trim() && v.access_key.trim() && v.secret_key.trim()

  return (
    <div className="my-5 rounded-2xl border-2 p-5" style={{ borderColor: '#FFCFA4' }}>
      <div className="mb-3 font-semibold text-gray-800">Вставьте значения сюда</div>
      <div className="space-y-3">
        <Row n="1" label="ID тенанта" value={v.tenant_id} onChange={x => upd('tenant_id', x)}
             where="Как получить — ниже, шаг 1" anchor="v1" />
        <Row n="2" label="Key ID (ключ доступа)" value={v.access_key} onChange={x => upd('access_key', x)}
             where="Как получить — ниже, шаг 2" anchor="v23" />
        <Row n="3" label="Key Secret (секретный ключ)" value={v.secret_key}
             onChange={x => upd('secret_key', x)} type="password"
             where="Показывается там же, сразу после создания ключа" anchor="v23" />
      </div>

      {msg && (
        <div className={`mt-3 rounded-xl border px-3.5 py-2.5 text-[13px] ${
          msg.ok ? 'border-green-200 bg-green-50 text-green-800'
                 : 'border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {done ? (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-[13px] text-amber-900">
          <p className="mb-2 font-medium">Хранилище создано. Остался один шаг в Cloud.ru</p>
          <p className="mb-2">Скопируйте это имя — его нужно вписать в Cloud.ru:</p>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <code className="rounded-lg border border-amber-200 bg-white px-3 py-1.5 font-mono text-sm">
              {done.global_name}
            </code>
            <button onClick={() => navigator.clipboard.writeText(done.global_name)}
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs text-amber-900 hover:bg-amber-100">
              Скопировать
            </button>
          </div>
          <ol className="space-y-1">
            <li>1. Откройте вкладку с Cloud.ru и <b>обновите страницу</b> — появится новое хранилище.</li>
            <li>2. Справа от него нажмите <b>три точки</b> → <b>«Редактировать»</b>.</li>
            <li>3. Вставьте имя в поле <b>«Глобальное название»</b> и сохраните.</li>
          </ol>
          <p className="mt-2 text-[12px] text-amber-700">
            Подробнее с картинками — в шаге 3 ниже на этой странице.
          </p>
          {/* ⚠️ Проверяем ПРЯМО ЗДЕСЬ, а не отправляем на другую страницу:
              человек только что вписал имя и хочет увидеть результат, а не
              искать кнопку в настройках. */}
          <button onClick={verify} disabled={busy}
            className="btn-gold mt-3 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-60">
            {busy ? <><Loader2 size={14} className="animate-spin" /> Проверяем…</>
                  : <>Я вписал — проверить <ArrowRight size={14} /></>}
          </button>

          {verified && (
            <div className="mt-3 rounded-xl border border-green-300 bg-white p-3">
              <p className="mb-2 text-[13px] font-medium text-green-800">
                Видите картинку? Значит всё работает — файлы открываются у посетителей.
              </p>
              <img src={verified} alt="Проверочная картинка"
                   className="w-full max-w-sm rounded-lg border border-green-200" />
              <p className="mt-2 text-[12px] text-gray-500">
                Загляните в{' '}
                <Link href="/dashboard/settings?tab=storage" className="text-brand underline">
                  Настройки → Файловое хранилище
                </Link>{' '}
                — там теперь показано ваше хранилище Cloud.ru и его объём.
              </p>
            </div>
          )}
        </div>
      ) : (
        <button onClick={connect} disabled={busy || !filled}
          className="btn-gold mt-4 inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold disabled:opacity-50">
          {busy ? <><Loader2 size={15} className="animate-spin" /> Подключаем…</>
                : <>Подключить хранилище <Check size={15} /></>}
        </button>
      )}
      {!filled && !done && (
        <p className="mt-2 text-[11px] text-gray-400">
          Кнопка станет активной, когда заполните все три поля.
        </p>
      )}
    </div>
  )
}

function Row({ n, label, value, onChange, type = 'text', where, anchor }: {
  n: string; label: string; value: string; onChange: (v: string) => void
  type?: string; where?: string; anchor?: string
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gray-100 text-xs font-bold text-gray-500">
        {n}
      </div>
      <div className="min-w-0 flex-1">
        <label className="mb-1 block text-[13px] font-medium text-gray-700">{label}</label>
        <input type={type} value={value} onChange={e => onChange(e.target.value)}
          spellCheck={false} autoComplete="new-password" name={`cs-${n}`}
          data-lpignore="true" data-form-type="other"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm" />
        {where && (
          <button type="button"
            onClick={() => anchor && document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="mt-1 text-[11px] text-brand hover:underline">
            {where} ↓
          </button>
        )}
      </div>
      {value.trim() && <Check size={16} className="mt-9 shrink-0 text-green-500" />}
    </div>
  )
}

export default function CloudStorageConnectPage() {
  return (
    <div className="max-w-3xl pb-24">
      <Crumbs section="Первичная настройка" sectionHref="/dashboard/help/s/setup"
              title="Шаг 2 — Связать с ПЛЮСОН" />

      <Hero
        title="Шаг 2 — Свяжите хранилище с ПЛЮСОНом"
        subtitle="Нужно получить в Cloud.ru три значения и вставить их в ПЛЮСОН. Занимает минут 10."
      />

      <Accent title="Ваша цель — получить три значения">
        <ol className="mt-1 space-y-1.5">
          <li><b>1. ID тенанта</b> — номер вашего хранилища в Cloud.ru</li>
          <li><b>2. Key ID</b> — ключ доступа</li>
          <li><b>3. Key Secret</b> — секретный ключ</li>
        </ol>
        <p className="mt-2">
          Вставляйте их в поля ниже по мере получения — можно прямо во время
          настройки, не запоминая и не переписывая никуда.
        </p>
      </Accent>

      {/* ⚠️ Поля ввода — ПРЯМО В СТАТЬЕ, а не на отдельной странице настроек:
          человек получает значения по одному, переходя между экранами Cloud.ru.
          Заставлять его запоминать три длинные строки и нести их в другой
          раздел — верный способ потерять Key Secret, который показывают раз. */}
      <ConnectForm />

      <div className="my-5 rounded-2xl border border-gray-200 bg-white p-5">
        <p className="mb-3 text-[15px] text-gray-700">
          Откройте Cloud.ru в соседней вкладке и выполняйте шаги ниже по порядку.
        </p>
        <a href={CLOUD} target="_blank" rel="noreferrer"
           className="btn-gold inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold">
          Перейти в Cloud.ru <ExternalLink size={15} />
        </a>
      </div>

      <h2 className="mt-8 mb-3 text-lg font-bold" style={{ color: '#25455D' }}>
        Теперь получите три значения
      </h2>

      <Step step="1" id="v1" title="Как получить значение 1 — ID тенанта">
        <p>
          В кабинете Cloud.ru откройте раздел <b>«Object Storage»</b>. Строка
          <b> «ID тенанта»</b> — сразу под заголовком раздела, над списком хранилищ.
          Она светло-серая и мелкая, её легко не заметить.
        </p>

        {/* ⚠️ Второй путь — не роскошь. На главном экране раздела значение набрано
            бледно-серым мелким шрифтом, и человек его проскакивает. В «Параметрах
            работы с API» то же значение лежит нормальной строкой таблицы. Из-за
            того, что был описан только первый путь, клиент взял ID из профиля и
            получил `NoSuchTenant` (случай 18.09.2026). */}
        <p className="mt-3">
          Не нашли? Есть второй путь, там значение видно лучше: откройте любое
          своё хранилище → в меню слева <b>«Object Storage API»</b>. Строка
          <b> «ID тенанта»</b> будет в таблице рядом с Endpoint и Регионом.
        </p>

        <Warn title="Не перепутайте с похожими строками">
          В Cloud.ru есть ещё два длинных значения с дефисами, и они <b>не подойдут</b>:
          <b> ID пользователя</b> в профиле под вашим именем и <b>ID проекта</b> на
          главной странице. Возьмёте их — при подключении увидите ошибку
          «ID тенанта не найден». Нужный ID лежит только в разделе Object Storage.
        </Warn>

        <Note title="Хранилище создавать не нужно">
          ID тенанта виден и без него — это номер вашего аккаунта, а не бакета.
          Само хранилище создаст ПЛЮСОН, когда вы заполните три поля выше.
        </Note>
        <Screenshot src={`${S}/13-api-params.jpg`}
          alt="Экран «Параметры работы с API»: строка «ID тенанта» в таблице"
          caption="Второй путь: хранилище → «Object Storage API». «ID тенанта» — строкой в таблице" />
      </Step>

      <Step step="2" id="v23" title="Как получить значения 2 и 3 — Key ID и Key Secret">
        <p>
          Нажмите на свой аватар в правом верхнем углу, затем на <b>шестерёнку</b> рядом
          с именем. Откройте вкладку <b>«Ключи доступа»</b> → <b>«Создать ключ доступа»</b>.
        </p>

        <p className="mt-3">В окне создания заполните:</p>
        <ul className="mt-2 space-y-1.5 text-[15px] text-gray-700">
          <li>• <b>Описание</b> — <code className="rounded bg-gray-100 px-1">Хранилище файлов ПЛЮСОН</code></li>
          <li>• <b>Время жизни ключа</b> — <b>«Бессрочно»</b></li>
        </ul>

        <Warn title="Только «Бессрочно»">
          Временный ключ действует от 15 минут до суток. Выберете его — и через день
          загрузка файлов перестанет работать, а причина будет неочевидна.
        </Warn>

        <Screenshot src={`${S}/17-key-lifetime.jpg`}
          alt="Окно создания ключа с полем «Время жизни ключа»"
          caption="Описание + «Бессрочно» → «Создать»" />

        <p className="mt-3">
          После создания появятся <b>Key ID</b> и <b>Key Secret</b> — это второе и третье
          значения.
        </p>

        <Warn title="Key Secret показывают один раз">
          Закроете окно — посмотреть снова нельзя, придётся создавать новый ключ.
          Скопируйте сразу и вставьте в ПЛЮСОН, не откладывая.
        </Warn>

      </Step>

      <h2 className="mt-8 mb-3 text-lg font-bold" style={{ color: '#25455D' }}>
        Последний шаг — вписать имя в Cloud.ru
      </h2>

      <Step step="3" title="Впишите глобальное название">
        <p>
          После нажатия <b>«Подключить хранилище»</b> мы создадим бакет и покажем
          готовое имя. Его нужно вписать в Cloud.ru — иначе ваши картинки не
          откроются у посетителей.
        </p>

        <Note title="Почему это нельзя сделать за вас">
          Глобальное название задаётся только вручную в кабинете Cloud.ru —
          через их программный интерфейс оно не меняется. Всё остальное
          (создание хранилища, публичный доступ) ПЛЮСОН делает сам.
        </Note>

        <p className="mt-3">В Cloud.ru:</p>
        <ol className="mt-2 space-y-1.5 text-[15px] text-gray-700">
          <li>1. <b>Обновите страницу</b> — появится новое хранилище с именем вида
            <code className="mx-1 rounded bg-gray-100 px-1">pluson-12</code>.</li>
          <li>2. Справа от строки хранилища нажмите <b>три точки</b> и выберите
            <b> «Редактировать»</b>.</li>
        </ol>

        <Screenshot src={`${S}/12-edit-bucket.jpg`}
          alt="Список хранилищ, меню трёх точек с пунктом «Редактировать»"
          caption="Три точки справа от хранилища → «Редактировать»" />

        <ol className="mt-3 space-y-1.5 text-[15px] text-gray-700" start={3}>
          <li>3. Вставьте скопированное имя в поле <b>«Глобальное название»</b>.</li>
          <li>4. Сохраните.</li>
        </ol>

        <Screenshot src={`${S}/07-bucket-form.jpg`}
          alt="Форма хранилища с полями «Название» и «Глобальное название»"
          caption="Поле «Глобальное название» — второе сверху" />

        <p className="mt-3">
          Готово. Вернитесь в ПЛЮСОН и нажмите <b>«Я вписал — проверить»</b>:
          мы загрузим проверочную картинку и покажем её — если видно, всё работает.
        </p>
      </Step>
    </div>
  )
}
