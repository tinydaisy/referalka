'use client'

/**
 * Настройки → «Файловое хранилище».
 *
 * Две страницы в одном компоненте (без роутинга — состояние `view`):
 *   'summary' — сколько занято, из чего складывается, подключение своего Cloud.ru
 *   'details' — список всех файлов со стрелкой «назад» и переходом в раздел
 *
 * ⚠️ Цифры берём с бэкенда (/storage/usage и /storage/files) и НИЧЕГО не
 * считаем в браузере: размер файла и его принадлежность знает только сервер.
 */
import { useEffect, useState } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import Link from 'next/link'
import {
  HardDrive, ChevronLeft, ExternalLink, Loader2, Search,
  Cloud, Info, ArrowRight,
} from 'lucide-react'

type Usage = {
  used_bytes: number; quota_bytes: number
  used_human: string; quota_human: string; used_percent: number
}
type FileRow = {
  id: number; kind: string; kind_label: string; url: string
  size_bytes: number; size_human: string; created_at: string | null
  place: string; event_id: number | null; event_title: string | null
  link: string | null; is_temp: boolean
  is_image?: boolean; is_video?: boolean; preview_url?: string | null
  unused?: boolean; used_in?: number
  places?: { title: string; block: string; link: string }[]
}
type Group = { place: string; link: string | null; count: number; size_bytes: number; size_human: string }
type KindStat = { label: string; count: number; size_bytes: number; size_human: string }

const API = process.env.NEXT_PUBLIC_API_URL || ''

export default function StorageTab() {
  const [view, setView] = useUrlTab<'summary' | 'details'>('storage', 'summary', ['summary', 'details'])
  const [usage, setUsage] = useState<Usage | null>(null)
  const [files, setFiles] = useState<FileRow[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [byKind, setByKind] = useState<KindStat[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')

  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    const token = localStorage.getItem('plusson_token')
    // ⚠️ Без токена ОБЯЗАТЕЛЬНО снять loading: раньше здесь стоял голый return,
    // и страница навсегда оставалась в «Загружаем…» — молча, без объяснения.
    if (!token) { setLoading(false); setLoadError('Не удалось определить вход — обновите страницу.'); return }
    const h = { Authorization: `Bearer ${token}` }
    Promise.all([
      fetch(`${API}/api/v1/storage/usage`, { headers: h }).then(r => r.ok ? r.json() : null),
      fetch(`${API}/api/v1/storage/files`, { headers: h }).then(r => r.ok ? r.json() : null),
    ]).then(([u, f]) => {
      if (u) setUsage(u)
      if (f) { setFiles(f.files || []); setGroups(f.groups || []); setByKind(f.by_kind || []) }
      if (!u && !f) setLoadError('Не удалось загрузить данные хранилища.')
    }).catch(() => setLoadError('Не удалось связаться с сервером.'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400">
        <Loader2 size={20} className="animate-spin mr-2" /> Загружаем…
      </div>
    )
  }
  if (loadError && !usage) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {loadError}
      </div>
    )
  }

  // ── Страница «Детализация» ────────────────────────────────────────────────
  if (view === 'details') {
    const needle = q.trim().toLowerCase()
    const shown = needle
      ? files.filter(f =>
          f.kind_label.toLowerCase().includes(needle) ||
          f.place.toLowerCase().includes(needle))
      : files

    return (
      <div className="space-y-4">
        <button onClick={() => setView('summary')}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800">
          <ChevronLeft size={16} /> Назад к хранилищу
        </button>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="font-semibold text-gray-800">Что занимает место</h3>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={q} onChange={e => setQ(e.target.value)}
              placeholder="Найти по названию или событию"
              className="pl-8 pr-3 py-2 text-sm rounded-lg border border-gray-200 w-64 max-w-full" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border card-border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium">Файл</th>
                  <th className="text-left px-4 py-2.5 font-medium">Где используется</th>
                  <th className="text-right px-4 py-2.5 font-medium">Размер</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {shown.map(f => (
                  <tr key={f.id} className="border-t border-gray-50 hover:bg-gray-50/60">
                    <td className="px-4 py-2.5">
                      <div className="flex items-start gap-2.5">
                        <Thumb f={f} />
                        <div className="min-w-0">
                          <a href={f.url} target="_blank" rel="noreferrer"
                            className="text-gray-800 hover:text-brand">{f.kind_label}</a>
                          {f.is_temp && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                              удалится через 24 ч
                            </span>
                          )}
                          {f.unused && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                              не используется
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">
                      {/* ⚠️ Файл в списке один, но мест использования может быть
                          несколько — показываем все, иначе непонятно, почему
                          удаление ломает картинку в другом событии. */}
                      {f.places && f.places.length > 1 ? (
                        <div className="space-y-0.5">
                          {f.places.map((pl, i) => (
                            <div key={i}>
                              <a href={pl.link} className="hover:text-brand">{pl.title}</a>
                              <span className="text-gray-400"> · {pl.block}</span>
                            </div>
                          ))}
                        </div>
                      ) : f.place}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-700 whitespace-nowrap">{f.size_human}</td>
                    <td className="px-4 py-2.5 text-right">
                      {f.places && f.places.length > 1 ? (
                        <span className="text-[11px] text-gray-400 whitespace-nowrap">
                          в {f.places.length} местах
                        </span>
                      ) : f.link && (
                        <a href={f.link}
                          className="inline-flex items-center gap-1 text-xs text-brand hover:underline whitespace-nowrap">
                          Перейти <ArrowRight size={12} />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">Ничего не нашлось</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-xs text-gray-400">Всего файлов: {files.length}</p>
      </div>
    )
  }

  // ── Страница «Хранилище» ──────────────────────────────────────────────────
  const pct = usage?.used_percent ?? 0
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'gradient-bg'
  const maxGroup = groups[0]?.size_bytes || 1

  return (
    <div className="space-y-5">
      {/* Занято */}
      <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
        <div className="flex items-start gap-3 mb-5">
          <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
            <HardDrive size={18} className="text-white" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-800">Файловое хранилище</h3>
            <p className="text-sm text-gray-500 mt-0.5">
              Афиши, фото спикеров, картинки лендингов, видео, уроки и записи эфиров.
            </p>
          </div>
        </div>

        <div className="flex items-baseline justify-between mb-2">
          <div className="text-lg text-gray-800">
            <span className="font-semibold">{usage?.used_human}</span>
            <span className="text-gray-400 text-sm"> из {usage?.quota_human}</span>
          </div>
          <div className={`text-sm font-medium ${
            pct >= 90 ? 'text-red-600' : pct >= 70 ? 'text-amber-600' : 'text-gray-500'}`}>
            {pct}%
          </div>
        </div>
        <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        {pct >= 90 && (
          <p className="text-xs text-red-600 mt-2">
            Хранилище почти заполнено. Удалите ненужные файлы или подключите своё хранилище — оно ниже.
          </p>
        )}

        <button onClick={() => setView('details')}
          className="btn-primary mt-5 px-4 py-2.5 rounded-xl text-sm font-medium inline-flex items-center gap-2">
          Детализация <ArrowRight size={14} />
        </button>
      </div>

      {/* Из чего складывается */}
      {groups.length > 0 && (
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
          <h4 className="font-semibold text-gray-800 mb-4">Что занимает больше всего</h4>
          <div className="space-y-3">
            {groups.slice(0, 6).map(g => (
              <div key={g.place}>
                <div className="flex items-baseline justify-between text-sm mb-1 gap-3">
                  <span className="text-gray-700 truncate">{g.place}</span>
                  <span className="text-gray-500 whitespace-nowrap shrink-0">
                    {g.size_human} · {g.count} файл{g.count % 10 === 1 && g.count % 100 !== 11 ? '' : 'ов'}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full gradient-bg"
                    style={{ width: `${Math.max(3, (g.size_bytes / maxGroup) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
          {byKind.length > 0 && (
            <div className="mt-5 pt-4 border-t border-gray-100 flex flex-wrap gap-2">
              {byKind.slice(0, 8).map(k => (
                <span key={k.label}
                  className="text-xs px-2.5 py-1 rounded-lg bg-gray-50 text-gray-600 border border-gray-100">
                  {k.label} · {k.size_human}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Своё хранилище */}
      <OwnStorageBlock />
    </div>
  )
}

/**
 * Подключение собственного хранилища Cloud.ru.
 *
 * ⚠️ Ключи вводит САМ клиент, а не присылает в поддержку: секретный ключ даёт
 * полный доступ к хранилищу, пересылать его перепиской нельзя.
 *
 * ⚠️ Реферальная ссылка приходит с бэкенда (/public/storage-promo), а не зашита
 * в код: она меняется, и ради её правки не должен выкладываться фронт.
 */
function OwnStorageBlock() {
  const [promo, setPromo] = useState<{ ref_url: string; free_gb: number } | null>(null)
  const [cfg, setCfg] = useState<any>(null)
  const [form, setForm] = useState({ endpoint: '', region: 'ru-central-1', bucket: '',
                                     tenant_id: '', access_key: '', secret_key: '', public_url: '' })
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'quick' | 'manual'>('quick')
  const [quick, setQuick] = useState({ tenant_id: '', access_key: '', secret_key: '' })
  const [created, setCreated] = useState<{ global_name: string; bucket: string } | null>(null)
  const [testUrl, setTestUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const auth = () => ({ Authorization: `Bearer ${localStorage.getItem('plusson_token')}` })

  const loadCfg = () =>
    fetch(`${API}/api/v1/clients/me/storage`, { headers: auth() })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return
        setCfg(d)
        if (d.connected) {
          setForm(f => ({ ...f, endpoint: d.endpoint || '', region: d.region || 'ru-central-1',
                          bucket: d.bucket || '', tenant_id: d.tenant_id || '',
                          access_key: d.access_key || '', public_url: d.public_url || '' }))
        }
      })

  useEffect(() => {
    fetch(`${API}/api/v1/public/storage-promo`).then(r => r.ok ? r.json() : null)
      .then(d => d && setPromo(d)).catch(() => {})
    loadCfg()
  }, [])

  const save = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(`${API}/api/v1/clients/me/storage`, {
        method: 'PUT',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.detail || 'Не удалось сохранить')
      setMsg({ ok: true, text: d.message })
      setOpen(false)
      await loadCfg()
    } catch (e: any) {
      setMsg({ ok: false, text: e.message })
    } finally { setBusy(false) }
  }

  const runQuick = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(`${API}/api/v1/clients/me/storage/quick-connect`, {
        method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify(quick),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.detail || 'Не удалось подключить')
      setCreated({ global_name: d.global_name, bucket: d.bucket })
      setMsg({ ok: true, text: d.message })
      await loadCfg()
    } catch (e: any) { setMsg({ ok: false, text: e.message }) }
    finally { setBusy(false) }
  }

  // ⚠️ Проверяем ПУБЛИЧНОЙ ссылкой, а не через ключи: только так видно то же,
  // что увидит посетитель лендинга. Проверка с ключами прошла бы и при
  // ненастроенном публичном доступе.
  const verifyPublic = async () => {
    setBusy(true); setMsg(null)
    try {
      await fetch(`${API}/api/v1/clients/me/storage/test-image`, { method: 'POST', headers: auth() })
      const r = await fetch(`${API}/api/v1/clients/me/storage/verify-public`, { method: 'POST', headers: auth() })
      const d = await r.json()
      setMsg({ ok: !!d.ok, text: d.message })
      setTestUrl(d.ok ? d.url : null)
      if (d.ok) await loadCfg()
    } finally { setBusy(false) }
  }

  const check = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(`${API}/api/v1/clients/me/storage/check`, { method: 'POST', headers: auth() })
      const d = await r.json()
      setMsg({ ok: !!d.ok, text: d.message })
    } finally { setBusy(false) }
  }

  const disconnect = async () => {
    if (!confirm('Отключить своё хранилище? Уже загруженные файлы останутся на месте и продолжат открываться, новые пойдут в хранилище ПЛЮСОНа.')) return
    setBusy(true)
    try {
      const r = await fetch(`${API}/api/v1/clients/me/storage`, { method: 'DELETE', headers: auth() })
      const d = await r.json()
      setMsg({ ok: true, text: d.message })
      await loadCfg()
    } finally { setBusy(false) }
  }

  // Подсказка имени: номер кабинета + случайный хвост. Глобальное имя уникально
  // на всю платформу Cloud.ru, а там не только клиенты ПЛЮСОНа — короткое слово
  // почти наверняка занято.
  const suggested = cfg?.suggested_global_name
    || `pluson-media-${cfg?.client_id || ''}`.replace(/-$/, '')

  const connected = cfg?.connected
  // ⚠️ Гейт по фиче own_storage (пока только admin) — см. коммент выше.
  if (cfg && cfg.feature === false) return null

  return (
    <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg bg-[#F1F6FA] border border-[#B9CEDD] flex items-center justify-center shrink-0">
          <Cloud size={18} className="text-[#25455D]" />
        </div>
        <div className="flex-1">
          <h4 className="font-semibold text-gray-800">
            {connected ? 'Своё хранилище подключено' : `Своё хранилище — ${promo?.free_gb || 15} ГБ бесплатно`}
          </h4>
          <p className="text-sm text-gray-500 mt-0.5">
            {connected
              ? `Файлы сохраняются в ваше хранилище «${cfg.bucket}». Место в ПЛЮСОНе они не занимают.`
              : 'Подключите бесплатное хранилище Cloud.ru — файлы будут храниться у вас, а место в ПЛЮСОНе перестанет заканчиваться.'}
          </p>
        </div>
      </div>

      {connected && cfg?.error && (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-700">
          Последняя проверка не прошла: {cfg.error}
        </div>
      )}

      {msg && (
        <div className={`mb-3 rounded-xl px-3.5 py-2.5 text-[13px] border ${
          msg.ok ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {!connected && !open && (
        <>
          {/* ⚠️ Два ШАГА кнопками, а не сплошной текст: подключение хранилища —
              это два похода в Cloud.ru с большим перерывом (регистрация, потом
              создание бакета и ключей). Человек должен видеть, где он сейчас. */}
          <div className="space-y-3">
            <StepCard
              n="1"
              title="Зарегистрироваться в Cloud.ru"
              text={`Бесплатно и навсегда: ${promo?.free_gb || 15} ГБ хранилища и 10 ТБ трафика в месяц. Займёт минут 5.`}
              href="/dashboard/help/cloud-storage"
              cta="Шаг 1 — Зарегистрироваться"
              primary
            />
            <StepCard
              n="2"
              title="Связать хранилище с ПЛЮСОНом"
              text="Получите три значения в Cloud.ru и вставьте их сюда — дальше всё сделаем сами."
              href="/dashboard/help/cloud-storage-connect"
              cta="Шаг 2 — Связать с ПЛЮСОН"
            />
          </div>

          <button onClick={() => { setMode('quick'); setOpen(true) }}
            className="mt-3 text-[13px] text-gray-500 hover:text-gray-800 underline">
            У меня уже есть три значения — ввести сразу
          </button>
        </>
      )}

      {/* Быстрое подключение: клиент даёт три строки, бакет создаём сами.
          ⚠️ Глобальное имя через API Cloud.ru задать НЕЛЬЗЯ (только руками
          в их кабинете), поэтому после создания показываем готовую строку
          с кнопкой копирования — это единственный ручной шаг. */}
      {open && !connected && mode === 'quick' && (
        <div className="space-y-3">
          {!created ? (
            <>
              <div className="rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-3 text-[13px] text-gray-700">
                <p className="font-medium mb-1">Понадобятся три строки из Cloud.ru.</p>
                <p className="text-gray-500">
                  Если ещё не создали хранилище и ключ —{' '}
                  <Link href="/dashboard/help/cloud-storage" className="text-brand hover:underline">
                    откройте инструкцию
                  </Link>: там каждый шаг со скриншотом.
                </p>
              </div>

              {/* ⚠️ У полей — путь ГДЕ ВЗЯТЬ, а не название из документации.
                  «ID тенанта» и «Key Secret» человеку ничего не говорят: он
                  открывает форму и не понимает, что копировать. */}
              <Field label="Строка 1 — «ID тенанта»" value={quick.tenant_id}
                onChange={v => setQuick({ ...quick, tenant_id: v })}
                hint="В Cloud.ru: Object Storage → откройте своё хранилище → пункт «Object Storage API» в меню слева → строка «ID тенанта». Длинная строка с дефисами." />
              <Field label="Строка 2 — «Key ID» (ключ доступа)" value={quick.access_key}
                onChange={v => setQuick({ ...quick, access_key: v })}
                hint="В Cloud.ru: аватар в правом верхнем углу → шестерёнка → вкладка «Ключи доступа» → «Создать ключ доступа». Время жизни — обязательно «Бессрочно»." />
              <Field label="Строка 3 — «Key Secret» (секретный ключ)" value={quick.secret_key}
                onChange={v => setQuick({ ...quick, secret_key: v })} type="password"
                hint="Показывается там же сразу после создания ключа — и только один раз. Если окно уже закрыли, создайте ключ заново." />
              <div className="flex flex-wrap gap-2 pt-1">
                <button onClick={runQuick} disabled={busy}
                  className="btn-gold px-4 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                  {busy ? 'Создаём хранилище…' : 'Создать и подключить'}
                </button>
                <button onClick={() => setMode('manual')}
                  className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
                  У меня уже есть хранилище
                </button>
                <button onClick={() => setOpen(false)}
                  className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
                  Отмена
                </button>
              </div>
              <p className="text-[11px] text-gray-400">
                <Link href="/dashboard/help/cloud-storage" className="text-brand hover:underline">
                  Где взять эти три строки — инструкция со скриншотами
                </Link>
              </p>
            </>
          ) : (
            <>
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-[13px] text-amber-900 font-medium mb-2">
                  Остался один шаг — его можно сделать только в Cloud.ru
                </p>
                <p className="text-[13px] text-amber-800">
                  Хранилище <b>{created.bucket}</b> создано, доступ открыт. Теперь откройте
                  в Cloud.ru: <b>Object Storage → ваш бакет → три точки → «Редактировать»</b> и
                  впишите в поле <b>«Глобальное название»</b> вот это:
                </p>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <code className="rounded-lg bg-white border border-amber-200 px-3 py-1.5 text-sm font-mono">
                    {created.global_name}
                  </code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(created.global_name); setMsg({ ok: true, text: 'Скопировано' }) }}
                    className="px-3 py-1.5 rounded-lg border border-amber-300 bg-white text-xs text-amber-900 hover:bg-amber-100">
                    Скопировать
                  </button>
                </div>
                <p className="text-[12px] text-amber-700 mt-2">
                  Без этого имени файлы не открываются у посетителей — Cloud.ru отдаёт их
                  только по глобальному названию.
                </p>
              </div>

              <button onClick={verifyPublic} disabled={busy}
                className="btn-gold px-4 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                {busy ? 'Проверяем…' : 'Я вписал — проверить'}
              </button>

              {testUrl && (
                <div className="rounded-xl border border-green-200 bg-green-50 p-3">
                  <p className="text-[13px] text-green-900 mb-2">
                    Видите картинку? Значит файлы открываются у посетителей — всё готово.
                  </p>
                  <img src={testUrl} alt="Проверочная картинка"
                    className="w-full max-w-sm rounded-lg border border-green-200" />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {((open && mode === 'manual') || connected) && (
        <div className="space-y-3">
          <Field label="Адрес хранилища (Endpoint)" value={form.endpoint}
            onChange={v => setForm({ ...form, endpoint: v })}
            hint="Object Storage → ваше хранилище → «Object Storage API» → строка «Endpoint». Копируйте как есть, лишнее отрежем сами."
            placeholder="https://s3.cloud.ru" />
          <Field label="Регион" value={form.region}
            onChange={v => setForm({ ...form, region: v })}
            hint="Там же, строка «Регион». Обычно ru-central-1 — оставьте как есть." placeholder="ru-central-1" />
          <Field label="Название хранилища (бакета)" value={form.bucket}
            onChange={v => setForm({ ...form, bucket: v })}
            hint="Имя, которое вы задали при создании." placeholder="pluson" />
          <Field label="Публичный адрес файлов" value={form.public_url}
            onChange={v => setForm({ ...form, public_url: v })}
            hint={`Собирается из ГЛОБАЛЬНОГО имени бакета: https://global.s3.cloud.ru/<глобальное-имя>. Например https://global.s3.cloud.ru/${suggested}`}
            placeholder={`https://global.s3.cloud.ru/${suggested}`} />
          <Field label="ID тенанта" value={form.tenant_id}
            onChange={v => setForm({ ...form, tenant_id: v })}
            hint="Object Storage → ваше хранилище → «Object Storage API» в меню слева → строка «ID тенанта»."
            placeholder="" />
          <Field label="Ключ доступа (Key ID)" value={form.access_key}
            onChange={v => setForm({ ...form, access_key: v })}
            hint="Аватар в правом верхнем углу → шестерёнка → вкладка «Ключи доступа». Время жизни — обязательно «Бессрочно»." placeholder="" />
          <Field label="Секретный ключ (Key Secret)" value={form.secret_key}
            onChange={v => setForm({ ...form, secret_key: v })}
            type="password"
            hint={cfg?.has_secret
              ? 'Ключ сохранён. Оставьте поле пустым, если менять его не нужно.'
              : 'Показывается один раз при создании ключа — скопируйте сразу.'}
            placeholder={cfg?.has_secret ? '••••••••' : ''} />

          <div className="flex flex-wrap gap-2 pt-1">
            <button onClick={save} disabled={busy}
              className="btn-gold px-4 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
              {busy ? 'Проверяем связь…' : connected ? 'Сохранить изменения' : 'Подключить хранилище'}
            </button>
            {connected && (
              <>
                <button onClick={check} disabled={busy}
                  className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60">
                  Проверить связь
                </button>
                <button onClick={disconnect} disabled={busy}
                  className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-60">
                  Отключить
                </button>
              </>
            )}
            {!connected && (
              <button onClick={() => setOpen(false)}
                className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
                Отмена
              </button>
            )}
          </div>
          <p className="text-[11px] text-gray-400">
            Перед сохранением мы проверяем связь: записываем в хранилище пробный файл и удаляем его.
            Если что-то настроено неверно — скажем, что именно.
          </p>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, onChange, hint, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void
  hint?: string; placeholder?: string; type?: string
}) {
  return (
    <div>
      <label className="block text-[13px] font-medium text-gray-700 mb-1">{label}</label>
      {/* ⚠️ Chrome игнорирует autoComplete="off" и подставляет в такие поля почту
          и пароли: видит поле без имени и считает его формой входа. Работает
          связка «нестандартное значение autoComplete + name без login/email». */}
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} spellCheck={false}
        autoComplete="new-password" name={`s3-${label.replace(/\W+/g, '')}`}
        data-lpignore="true" data-form-type="other"
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono"
      />
      {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}
    </div>
  )
}


/**
 * Карточка шага на странице хранилища.
 *
 * ⚠️ Ведёт в ИНСТРУКЦИЮ, а не сразу в Cloud.ru: там регистрация не в одну
 * кнопку — анкета, выбор личного облака, экран про карту. Человек, брошенный
 * на голый console.cloud.ru, застревает на первом же экране.
 */
function StepCard({ n, title, text, href, cta, primary }: {
  n: string; title: string; text: string; href: string; cta: string; primary?: boolean
}) {
  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <div className="flex items-start gap-3">
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm font-bold ${
          primary ? 'text-[#25455D]' : 'text-gray-500 bg-gray-100'}`}
          style={primary ? { background: '#FFCFA4' } : undefined}>
          {n}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-800">{title}</div>
          <p className="mt-0.5 text-[13px] text-gray-500">{text}</p>
          <Link href={href}
            className={`${primary ? 'btn-gold' : 'btn-primary'} mt-3 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold`}>
            {cta} <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </div>
  )
}


/**
 * Превью файла в списке.
 *
 * ⚠️ Картинка грузится ПРЯМО ИЗ ХРАНИЛИЩА — наш сервер её не читает и не
 * пережимает, нагрузки на него нет.
 *
 * ⚠️ У видео берём готовую обложку, если она есть. Если нет — <video> с
 * preload="metadata": браузер качает только начало файла ради первого кадра,
 * а не весь ролик на гигабайты.
 */
function Thumb({ f }: { f: FileRow }) {
  const box = 'h-10 w-10 shrink-0 rounded-lg border border-gray-200 object-cover bg-gray-50'
  if (f.preview_url) return <img src={f.preview_url} alt="" className={box} loading="lazy" />
  if (f.is_image) return <img src={f.url} alt="" className={box} loading="lazy" />
  if (f.is_video) return <video src={f.url} className={box} preload="metadata" muted />
  return (
    <div className={`${box} flex items-center justify-center`}>
      <HardDrive size={14} className="text-gray-300" />
    </div>
  )
}
