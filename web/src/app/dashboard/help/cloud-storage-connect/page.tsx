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

  const filled = v.tenant_id.trim() && v.access_key.trim() && v.secret_key.trim()

  return (
    <div className="my-5 rounded-2xl border-2 p-5" style={{ borderColor: '#FFCFA4' }}>
      <div className="mb-3 font-semibold text-gray-800">Вставьте значения сюда</div>
      <div className="space-y-3">
        <Row n="1" label="ID тенанта" value={v.tenant_id} onChange={x => upd('tenant_id', x)}
             where="Как получить — ниже, шаг 3" anchor="v1" />
        <Row n="2" label="Key ID (ключ доступа)" value={v.access_key} onChange={x => upd('access_key', x)}
             where="Как получить — ниже, шаг 4" anchor="v23" />
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
          <p className="mb-2 font-medium">Остался один шаг в Cloud.ru</p>
          <p>Впишите это в поле «Глобальное название» вашего хранилища:</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded-lg border border-amber-200 bg-white px-3 py-1.5 font-mono text-sm">
              {done.global_name}
            </code>
            <button onClick={() => navigator.clipboard.writeText(done.global_name)}
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs text-amber-900 hover:bg-amber-100">
              Скопировать
            </button>
          </div>
          <Link href="/dashboard/settings?tab=storage"
                className="btn-gold mt-3 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold">
            Проверить подключение <ArrowRight size={14} />
          </Link>
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
          В кабинете Cloud.ru откройте раздел <b>«Object Storage»</b>. Прямо под
          заголовком, над списком хранилищ, будет строка <b>«ID тенанта»</b> —
          длинная, с дефисами. Скопируйте её.
        </p>

        <Note title="Хранилище создавать не нужно">
          ID тенанта виден и без него — это номер вашего аккаунта, а не бакета.
          Само хранилище создаст ПЛЮСОН, когда вы заполните три поля выше.
        </Note>
        <Screenshot src={`${S}/12-edit-bucket.jpg`}
          alt="Раздел Object Storage: строка «ID тенанта» под заголовком"
          caption="«ID тенанта» — строка под заголовком раздела" />
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

      <Accent title="Всё — дальше ПЛЮСОН сам">
        Заполните три поля наверху страницы и нажмите «Подключить хранилище».
        Мы создадим бакет, откроем доступ и проверим связь — вам останется только
        вписать в Cloud.ru одну строку, которую покажем.
      </Accent>
    </div>
  )
}
