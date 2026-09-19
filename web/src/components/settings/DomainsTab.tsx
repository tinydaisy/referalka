'use client'
import { useEffect, useState } from 'react'
import {
  Globe, Mail, Plus, Trash2, RefreshCw, CheckCircle2, XCircle,
  Loader2, ShieldCheck, Copy, Check, AlertTriangle, Clock,
  Info, ExternalLink,
} from 'lucide-react'
import { api } from '@/lib/api'
import FeatureLock from '@/components/FeatureLock'

/**
 * Раздел «Свой домен» (миграция 270, фича custom_domain).
 *
 * Два независимых домена:
 *   • Страницы — лендинги событий, кабинет спикера и жюри, турнирные таблицы,
 *     воронки, оферта. Подключается через CNAME + сертификат Let's Encrypt.
 *   • Почта — адрес отправителя рассылок. Подключается через SPF/DKIM/DMARC.
 *
 * Кабинет (/dashboard) на свой домен не переезжает — там вход и вебхуки
 * платёжек завязаны на pluson.ru.
 */

interface DnsRecord {
  kind: string
  type: string
  host: string
  value: string
  title: string
  note?: string
}

/** Панель, где клиент правит DNS — определяется по NS-записям домена. */
interface DnsProvider {
  key: string
  title: string
  panel_url: string
  steps: string[]
  note?: string
}

interface Domain {
  id: number
  kind: 'landing' | 'mail'
  domain: string
  status: 'pending' | 'dns_ok' | 'active' | 'error'
  is_primary: boolean
  dns_ok: boolean
  dns_checked_at: string | null
  dns_details: any
  last_error: string | null
  // landing
  cert_expires_at?: string | null
  cert_days_left?: number | null
  dns_instruction?: { type: string; host: string; value: string; note?: string }
  /** Что открывается на корне домена: events | about | event (миграция 278). */
  home_kind?: string
  home_event_id?: number | null
  // mail
  mail_from_local?: string | null
  mail_from_name?: string | null
  from_address?: string
  dns_records?: DnsRecord[]
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Ждём DNS',
  dns_ok:  'DNS настроен',
  active:  'Работает',
  error:   'Ошибка',
}

function StatusChip({ status }: { status: string }) {
  const style =
    status === 'active' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : status === 'error' ? 'bg-red-50 text-red-700 border-red-200'
    : status === 'dns_ok' ? 'bg-blue-50 text-blue-700 border-blue-200'
    : 'bg-slate-100 text-slate-600 border-slate-200'
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${style}`}>
      {status === 'active' && <CheckCircle2 size={12} />}
      {status === 'error' && <XCircle size={12} />}
      {STATUS_LABEL[status] || status}
    </span>
  )
}

/** Строка DNS-записи с кнопкой копирования — значения длинные, руками не перепечатать. */
function RecordRow({ rec }: { rec: DnsRecord | { type: string; host: string; value: string; note?: string; title?: string } }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(rec.value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-white">
      {rec.title && <div className="text-sm font-medium text-slate-800 mb-2">{rec.title}</div>}
      <div className="grid grid-cols-[70px_1fr] gap-x-3 gap-y-1.5 text-sm">
        <span className="text-slate-500">Тип</span>
        <span className="font-mono text-slate-800">{rec.type}</span>
        <span className="text-slate-500">Имя</span>
        <span className="font-mono text-slate-800 break-all">{rec.host}</span>
        <span className="text-slate-500">Значение</span>
        <div className="flex items-start gap-2 min-w-0">
          <span className="font-mono text-slate-800 break-all flex-1">{rec.value}</span>
          <button
            onClick={copy}
            className="shrink-0 p-1 rounded hover:bg-slate-100 text-slate-500"
            title="Скопировать"
          >
            {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
          </button>
        </div>
      </div>
      {rec.note && <p className="text-xs text-slate-500 mt-2">{rec.note}</p>}
    </div>
  )
}

/**
 * Подсказка «куда именно вписывать» — под панель конкретного провайдера.
 *
 * Провайдера определяет бэкенд по NS-записям домена ([dns_providers.py]).
 * Раньше клиент получал «добавьте CNAME» и дальше искал нужный раздел сам:
 * у всех панелей он называется по-разному («Управление зоной», «DNS-записи»,
 * «Ресурсные записи»), и это давало заметную часть обращений в поддержку.
 *
 * ⚠️ Провайдер не определился (свой DNS, редкий хостер) — блок просто не
 * показывается, общая инструкция с записью остаётся на месте. Это частый
 * и нормальный случай, а не ошибка.
 *
 * ⚠️ Прописать записи за клиента автоматически нельзя: у российских
 * регистраторов API авторизуется логином и паролем от всего аккаунта
 * (не токеном с ограниченными правами), а Domain Connect они не
 * поддерживают. Поэтому помогаем инструкцией.
 */
function ProviderHint({ provider }: { provider?: DnsProvider | null }) {
  if (!provider) return null
  return (
    <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50/60 p-3">
      <div className="flex items-start gap-2 mb-2">
        <Info size={15} className="text-blue-600 mt-0.5 shrink-0" />
        <p className="text-sm text-slate-800">
          Ваш домен обслуживается в <span className="font-medium">{provider.title}</span> —
          записи добавляются там.
        </p>
      </div>
      {!!provider.steps?.length && (
        <ol className="list-decimal pl-8 space-y-1 text-sm text-slate-700 mb-2">
          {provider.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
      {provider.note && (
        <p className="text-xs text-slate-600 pl-8 mb-2">{provider.note}</p>
      )}
      {provider.panel_url && (
        <a href={provider.panel_url} target="_blank" rel="noopener noreferrer"
           className="inline-flex items-center gap-1.5 pl-8 text-sm text-blue-700 hover:text-blue-900 font-medium">
          Открыть панель {provider.title} <ExternalLink size={13} />
        </a>
      )}
    </div>
  )
}

/**
 * Что открывается на КОРНЕ домена (миграция 278).
 *
 * ⚠️ Без этой настройки на корне клиентского домена открывался лендинг
 * ПЛЮСОНа — клиент платил за домен и показывал на нём нашу рекламу.
 * Варианты: витрина событий, витрина на вкладке «О проекте», лендинг события.
 */
function HomePagePicker({ domain, onSaved }: { domain: Domain; onSaved: () => void }) {
  const [kind, setKind] = useState(domain.home_kind || 'about')
  const [eventId, setEventId] = useState<number | null>(domain.home_event_id ?? null)
  const [events, setEvents] = useState<any[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')

  // Список событий грузим только когда он реально нужен — при выборе «лендинг
  // события», а не при каждом открытии вкладки настроек.
  useEffect(() => {
    if (kind !== 'event' || events.length) return
    api.miniApp.domains.homeEvents()
      .then((r: any) => setEvents(r?.items || []))
      .catch(() => setEvents([]))
  }, [kind])

  const dirty = kind !== (domain.home_kind || 'about')
    || (kind === 'event' && eventId !== (domain.home_event_id ?? null))

  const save = async () => {
    setSaving(true); setErr('')
    try {
      await api.miniApp.domains.setHome(domain.id, {
        home_kind: kind,
        home_event_id: kind === 'event' ? eventId : null,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      onSaved()
    } catch (e: any) {
      setErr(e?.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  // Первым — дефолт: на главную заходит человек, который про клиента ещё
  // ничего не знает, ему сначала визитка, а события — соседней вкладкой.
  const OPTIONS = [
    { v: 'about',  t: 'О проекте',         d: 'Ваша визитка: фото, описание, регалии' },
    { v: 'events', t: 'Календарь событий', d: 'Все ваши события карточками' },
    { v: 'event',  t: 'Лендинг события',   d: 'Сразу страница выбранного события' },
  ]

  return (
    <div className="mt-4 pt-4 border-t border-slate-200">
      <div className="text-sm font-medium text-slate-800 mb-1">Главная страница</div>
      <p className="text-xs text-slate-500 mb-3">
        Что увидит человек, открыв <span className="font-mono">{domain.domain}</span> без адреса страницы.
      </p>

      <div className="grid gap-2 sm:grid-cols-3">
        {OPTIONS.map(o => (
          <button
            key={o.v}
            onClick={() => setKind(o.v)}
            className={`text-left rounded-lg border p-3 transition ${
              kind === o.v
                ? 'border-brand bg-brand/5 ring-1 ring-brand'
                : 'border-slate-200 hover:bg-slate-50'
            }`}
          >
            <div className="text-sm font-medium text-slate-800">{o.t}</div>
            <div className="text-xs text-slate-500 mt-0.5">{o.d}</div>
          </button>
        ))}
      </div>

      {kind === 'event' && (
        <div className="mt-3">
          <select
            value={eventId ?? ''}
            onChange={e => setEventId(e.target.value ? Number(e.target.value) : null)}
            className="input"
          >
            <option value="">— выберите событие —</option>
            {events.map(ev => (
              <option key={ev.id} value={ev.id}>{ev.title}</option>
            ))}
          </select>
          {!events.length && (
            <p className="text-xs text-slate-500 mt-1">
              Здесь только события с опубликованным лендингом — черновик на главную поставить нельзя.
            </p>
          )}
        </div>
      )}

      {err && <p className="text-xs text-red-600 mt-2">{err}</p>}

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={save}
          disabled={!dirty || saving || (kind === 'event' && !eventId)}
          className="btn-primary inline-flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : null}
          Сохранить
        </button>
        {saved && <span className="text-xs text-emerald-600">Сохранено</span>}
      </div>
    </div>
  )
}

export default function DomainsTab() {
  const [domains, setDomains] = useState<Domain[]>([])
  const [platformDomain, setPlatformDomain] = useState('pluson.ru')
  const [loading, setLoading] = useState(true)
  const [noAccess, setNoAccess] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [adding, setAdding] = useState<'landing' | 'mail' | null>(null)
  const [newDomain, setNewDomain] = useState('')
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const r = await api.miniApp.domains.list()
      setDomains(r.domains || [])
      setPlatformDomain(r.platform_domain || 'pluson.ru')
      setNoAccess(false)
    } catch (e: any) {
      // ⚠️ Ловим по КОДУ ответа, а не по тексту: сообщение бэкенда правится без
      // оглядки на фронт, и проверка «содержит ли слово Экстра» молча
      // перестала бы срабатывать — вкладка показывала бы пустоту вместо замка.
      if (e?.status === 403) setNoAccess(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const addDomain = async (kind: 'landing' | 'mail') => {
    setError('')
    const d = newDomain.trim()
    if (!d) { setError('Укажите домен'); return }
    try {
      await api.miniApp.domains.create({ kind, domain: d })
      setNewDomain('')
      setAdding(null)
      await load()
    } catch (e: any) {
      setError(e?.message || 'Не удалось добавить домен')
    }
  }

  const checkDns = async (id: number) => {
    setBusyId(id)
    try {
      const r = await api.miniApp.domains.checkDns(id)
      await load()
      const res = r.result || {}
      if (res.ok) {
        alert('DNS настроен верно.')
      } else if (res.spf || res.dkim) {
        alert(
          'Пока не всё готово:\n\n' +
          `SPF: ${res.spf?.message || '—'}\n` +
          `DKIM: ${res.dkim?.message || '—'}\n` +
          `DMARC: ${res.dmarc?.message || '—'}\n\n` +
          'Записи обновляются не мгновенно — если только что добавили, ' +
          'подождите и проверьте ещё раз.'
        )
      } else {
        alert(res.message || 'DNS пока не сошёлся')
      }
    } catch (e: any) {
      alert(e?.message || 'Проверка не удалась')
    } finally {
      setBusyId(null)
    }
  }

  const [certInfo, setCertInfo] = useState<Record<number, any>>({})

  const checkCert = async (id: number) => {
    setBusyId(id)
    try {
      const r: any = await api.miniApp.domains.checkCert(id)
      setCertInfo(prev => ({ ...prev, [id]: r }))
    } catch (e: any) {
      setCertInfo(prev => ({ ...prev, [id]: { ok: false, error: e?.message || 'Ошибка' } }))
    } finally { setBusyId(null) }
  }

  const issueCert = async (id: number, source: 'letsencrypt' | 'zerossl' = 'letsencrypt') => {
    setBusyId(id)
    try {
      await api.miniApp.domains.issueCert(id, source)
      await load()
      alert('Сертификат выпущен — домен работает.')
    } catch (e: any) {
      alert(e?.message || 'Не удалось выпустить сертификат')
    } finally {
      setBusyId(null)
    }
  }

  const removeDomain = async (d: Domain) => {
    const what = d.kind === 'landing' ? 'страницы перестанут открываться на этом домене'
                                      : 'письма снова будут уходить с адреса ПЛЮСОНа'
    if (!confirm(`Отключить ${d.domain}?\n\nПосле отключения ${what}.`)) return
    setBusyId(d.id)
    try {
      await api.miniApp.domains.delete(d.id)
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось отключить домен')
    } finally {
      setBusyId(null)
    }
  }

  const saveMailSettings = async (d: Domain, local: string, name: string) => {
    setBusyId(d.id)
    try {
      await api.miniApp.domains.update(d.id, { mail_from_local: local, mail_from_name: name })
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return <div className="py-12 text-center text-slate-400"><Loader2 className="animate-spin inline" /></div>
  }

  if (noAccess) {
    return (
      <div className="max-w-2xl space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Свой домен</h2>
          <p className="mt-1 text-sm text-gray-500">
            Лендинги событий и все ссылки для партнёров и участников могут
            открываться на вашем домене, а письма — уходить с вашего адреса,
            а не с общего <span className="font-mono">noreply@pluson.ru</span>.
          </p>
        </div>
        {/* ⚠️ Замок общий (FeatureLock), а не свой текст: название тарифа он
            берёт из базы. Раньше здесь было захардкожено «Экстра» — при
            переносе фичи в другой тариф надпись врала бы, а правку никто не
            вспомнил бы. Он же даёт кнопку перехода к тарифам. */}
        <FeatureLock anyOf={['custom_domain']} />
      </div>
    )
  }

  const landing = domains.filter(d => d.kind === 'landing')
  const mail = domains.filter(d => d.kind === 'mail')

  return (
    <div className="max-w-3xl space-y-8">

      {/* ── Домен страниц ── */}
      <section>
        <div className="flex items-center gap-2 mb-1">
          <Globe size={18} className="text-slate-700" />
          <h3 className="text-lg font-semibold text-slate-800">Домен для страниц</h3>
        </div>
        <p className="text-sm text-slate-600 mb-4">
          Лендинги событий, оферта и все ссылки для партнёров и участников
          откроются на вашем домене.
          {' '}Кабинет останется на {platformDomain} — там вход и оплаты.
        </p>

        {landing.length === 0 && adding !== 'landing' && (
          <button onClick={() => { setAdding('landing'); setNewDomain(''); setError('') }}
                  className="btn-primary inline-flex items-center gap-2">
            <Plus size={16} /> Подключить домен
          </button>
        )}

        {adding === 'landing' && (
          <div className="border border-slate-200 rounded-xl p-4 bg-white">
            <label className="block text-sm text-slate-700 mb-1">Домен</label>
            <input
              value={newDomain}
              onChange={e => setNewDomain(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-1"
              autoFocus
            />
            <p className="text-xs text-slate-500 mb-3">
              Например, отдельный поддомен для событий — он не займёт ваш основной сайт.
            </p>
            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
            <div className="flex gap-2">
              <button onClick={() => addDomain('landing')} className="btn-gold">Добавить</button>
              <button onClick={() => { setAdding(null); setError('') }}
                      className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">
                Отмена
              </button>
            </div>
          </div>
        )}

        <div className="space-y-4">
          {landing.map(d => (
            <div key={d.id} className="border border-slate-200 rounded-xl p-4 bg-white">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="font-medium text-slate-800 break-all">{d.domain}</div>
                  <div className="mt-1"><StatusChip status={d.status} /></div>
                </div>
                <button onClick={() => removeDomain(d)} disabled={busyId === d.id}
                        className="p-2 text-slate-400 hover:text-red-600 shrink-0" title="Отключить домен">
                  <Trash2 size={16} />
                </button>
              </div>

              {d.status === 'active' && d.cert_expires_at && (
                <div className="flex items-center gap-2 text-sm text-slate-600 mb-3">
                  <ShieldCheck size={15} className="text-emerald-600" />
                  Сертификат действует до{' '}
                  {new Date(d.cert_expires_at).toLocaleDateString('ru-RU',
                    { day: 'numeric', month: 'long', year: 'numeric' })}
                  {typeof d.cert_days_left === 'number' && (
                    <span className={d.cert_days_left <= 14 ? 'text-amber-700' : 'text-slate-500'}>
                      (осталось {d.cert_days_left} дн.)
                    </span>
                  )}
                </div>
              )}

              {d.status === 'active' && (
                <p className="text-xs text-slate-500 mb-3">
                  Продлевается автоматически. Если продление не пройдёт — предупредим заранее.
                </p>
              )}

              {d.last_error && (
                <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>{d.last_error}</span>
                </div>
              )}

              {d.status !== 'active' && d.dns_instruction && (
                <div className="mb-3">
                  {/* Найденные чужие записи показываем ПЕРВЫМ шагом: пока они
                      на месте, добавленная новая работать не будет — домен
                      продолжит вести на заглушку регистратора. */}
                  {(d.dns_details?.a?.length || d.dns_details?.cname?.length) && !d.dns_ok ? (
                    <div className="mb-2 text-sm text-slate-700">
                      <p className="mb-1">
                        <span className="font-medium">Шаг 1.</span> Удалите записи, которые
                        сейчас стоят у домена — они ведут не на нас:
                      </p>
                      <ul className="list-disc pl-5 text-xs text-slate-600 font-mono">
                        {(d.dns_details?.cname || []).map((v: string) => <li key={`c${v}`}>CNAME → {v}</li>)}
                        {(d.dns_details?.a || []).map((v: string) => <li key={`a${v}`}>A → {v}</li>)}
                      </ul>
                      <p className="mt-2 mb-2">
                        <span className="font-medium">Шаг 2.</span> Добавьте эту запись:
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-700 mb-2">
                      Добавьте эту запись там, где куплен домен:
                    </p>
                  )}
                  <RecordRow rec={{ ...d.dns_instruction, title: undefined }} />
                  <ProviderHint provider={d.dns_details?.provider} />
                  <p className="text-xs text-slate-500 mt-2">
                    NS-серверы менять не нужно — домен остаётся под вашим управлением.
                    Запись расходится по интернету не сразу — обычно от нескольких минут до пары часов.
                  </p>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button onClick={() => checkDns(d.id)} disabled={busyId === d.id}
                        className="btn-primary inline-flex items-center gap-2">
                  {busyId === d.id ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                  Проверить DNS
                </button>
                {d.status === 'active' && (
                  <button onClick={() => checkCert(d.id)} disabled={busyId === d.id}
                          className="btn-primary inline-flex items-center gap-2">
                    <ShieldCheck size={15} /> Проверить сертификат
                  </button>
                )}
              </div>

              {d.status === 'active' && certInfo[d.id] && (
                <div className={`mt-3 rounded-xl px-4 py-3 text-sm ${
                  certInfo[d.id].ok ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-900'}`}>
                  {certInfo[d.id].ok ? (
                    <>
                      <b>Сертификат работает.</b> Выдал: {certInfo[d.id].issuer}.
                      {certInfo[d.id].days_left != null &&
                        ` Осталось ${certInfo[d.id].days_left} дн.`}
                    </>
                  ) : (
                    <><b>Не работает.</b> {certInfo[d.id].error}</>
                  )}
                </div>
              )}

              {d.status !== 'active' && d.dns_ok && (
                <CertPicker domain={d} busy={busyId === d.id}
                            onIssue={(src) => issueCert(d.id, src)}
                            onUploaded={load} />
              )}
              {d.status !== 'active' && !d.dns_ok && (
                <p className="text-xs text-slate-500 mt-2 flex items-center gap-1">
                  <Clock size={12} /> Сертификат можно выпустить после того, как домен начнёт вести на нас.
                </p>
              )}

              {d.status === 'active' && <HomePagePicker domain={d} onSaved={load} />}
            </div>
          ))}
        </div>
      </section>

      {/* ── Домен почты ── */}
      <section>
        <div className="flex items-center gap-2 mb-1">
          <Mail size={18} className="text-slate-700" />
          <h3 className="text-lg font-semibold text-slate-800">Адрес отправителя писем</h3>
        </div>
        <p className="text-sm text-slate-600 mb-4">
          Рассылки будут приходить с вашего адреса вместо адреса ПЛЮСОНа.
          Но с IP-адреса нашего сервиса.
        </p>

        {mail.length === 0 && adding !== 'mail' && (
          <button onClick={() => { setAdding('mail'); setNewDomain(''); setError('') }}
                  className="btn-primary inline-flex items-center gap-2">
            <Plus size={16} /> Подключить домен почты
          </button>
        )}

        {adding === 'mail' && (
          <div className="border border-slate-200 rounded-xl p-4 bg-white">
            <label className="block text-sm text-slate-700 mb-1">Домен</label>
            <input
              value={newDomain}
              onChange={e => setNewDomain(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-1"
              autoFocus
            />
            <p className="text-xs text-slate-500 mb-3">
              Тот домен, с которого хотите писать. Ваша обычная почта на нём продолжит работать.
            </p>
            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
            <div className="flex gap-2">
              <button onClick={() => addDomain('mail')} className="btn-gold">Добавить</button>
              <button onClick={() => { setAdding(null); setError('') }}
                      className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">
                Отмена
              </button>
            </div>
          </div>
        )}

        <div className="space-y-4">
          {mail.map(d => (
            <MailDomainCard
              key={d.id}
              d={d}
              busy={busyId === d.id}
              onCheck={() => checkDns(d.id)}
              onRemove={() => removeDomain(d)}
              onSave={(local, name) => saveMailSettings(d, local, name)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function MailDomainCard({ d, busy, onCheck, onRemove, onSave }: {
  d: Domain
  busy: boolean
  onCheck: () => void
  onRemove: () => void
  onSave: (local: string, name: string) => void
}) {
  const [local, setLocal] = useState(d.mail_from_local || 'noreply')
  const [name, setName] = useState(d.mail_from_name || '')

  useEffect(() => {
    setLocal(d.mail_from_local || 'noreply')
    setName(d.mail_from_name || '')
  }, [d.mail_from_local, d.mail_from_name])

  const details = d.dns_details || {}
  const checks: { key: string; label: string }[] = [
    { key: 'spf', label: 'SPF' },
    { key: 'dkim', label: 'DKIM' },
    { key: 'dmarc', label: 'DMARC' },
  ]

  return (
    <div className="border border-slate-200 rounded-xl p-4 bg-white">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="font-medium text-slate-800 break-all">{d.domain}</div>
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <StatusChip status={d.status} />
            {d.status === 'active' && d.from_address && (
              <span className="text-xs text-slate-500">письма от {local}@{d.domain}</span>
            )}
          </div>
        </div>
        <button onClick={onRemove} disabled={busy}
                className="p-2 text-slate-400 hover:text-red-600 shrink-0" title="Отключить домен">
          <Trash2 size={16} />
        </button>
      </div>

      {d.last_error && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{d.last_error}</span>
        </div>
      )}

      {/* Итоги последней проверки — видно, какая из трёх записей ещё не встала */}
      {details.spf && (
        <div className="flex flex-wrap gap-3 mb-3">
          {checks.map(c => {
            const r = details[c.key]
            if (!r) return null
            return (
              <span key={c.key}
                    className={`inline-flex items-center gap-1 text-xs ${r.ok ? 'text-emerald-700' : 'text-slate-500'}`}
                    title={r.message}>
                {r.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {c.label}
              </span>
            )
          })}
        </div>
      )}

      {d.status !== 'active' && !!d.dns_records?.length && (
        <div className="mb-3">
          <p className="text-sm text-slate-700 mb-2">
            Добавьте эти три записи там, где куплен домен:
          </p>
          <div className="space-y-2">
            {d.dns_records.map(r => <RecordRow key={r.kind} rec={r} />)}
          </div>
          <ProviderHint provider={details.provider} />
        </div>
      )}

      {/* Настройки отправителя */}
      <div className="grid sm:grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs text-slate-600 mb-1">Адрес до собачки</label>
          <div className="flex items-center">
            <input value={local} onChange={e => setLocal(e.target.value)}
                   className="w-full border border-slate-300 rounded-l-lg px-3 py-2 text-sm" />
            <span className="px-2 py-2 text-sm text-slate-500 bg-slate-50 border border-l-0 border-slate-300 rounded-r-lg whitespace-nowrap">
              @{d.domain}
            </span>
          </div>
        </div>
        <div>
          <label className="block text-xs text-slate-600 mb-1">Имя отправителя</label>
          <input value={name} onChange={e => setName(e.target.value)}
                 className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
          <p className="text-[11px] text-slate-500 mt-1">Пусто — возьмём название вашего бренда</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={onCheck} disabled={busy}
                className="btn-primary inline-flex items-center gap-2">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          Проверить DNS
        </button>
        <button onClick={() => onSave(local, name)} disabled={busy} className="btn-gold">
          Сохранить
        </button>
      </div>
    </div>
  )
}


/** Карточки выбора: как получить сертификат.
 *
 * ⚠️ ZeroSSL показывается ТОЛЬКО для не-.ru доменов — Sectigo отвечает
 * «DNS identifier is disallowed» на всю зону .ru (проверено на четырёх
 * доменах, .online при этом выпускается). Список доступных вариантов
 * решает бэкенд, здесь его не дублируем.
 */
function CertPicker({ domain, busy, onIssue, onUploaded }: {
  domain: any
  busy: boolean
  onIssue: (src: 'letsencrypt' | 'zerossl') => void
  onUploaded: () => void
}) {
  const [sources, setSources] = useState<string[]>([])
  const [openUpload, setOpenUpload] = useState(false)
  const [cert, setCert] = useState('')
  const [key, setKey] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.miniApp.domains.certSources(domain.id)
      .then((r: any) => setSources(r.sources || []))
      .catch(() => setSources(['letsencrypt', 'upload']))
  }, [domain.id])

  const upload = async () => {
    setErr(''); setSaving(true)
    try {
      await api.miniApp.domains.uploadCert(domain.id,
        { certificate: cert, private_key: key })
      setOpenUpload(false); setCert(''); setKey('')
      onUploaded()
    } catch (e: any) {
      setErr(e?.message || 'Не удалось установить сертификат')
    } finally { setSaving(false) }
  }

  const Card = ({ children }: any) => (
    <div className="flex-1 min-w-[240px] rounded-2xl border border-slate-200 bg-white p-4 flex flex-col">
      {children}
    </div>
  )

  return (
    <div className="mt-4">
      <h4 className="font-semibold text-slate-900">Чтобы ваш сайт открывался у всех</h4>
      <p className="text-sm text-slate-600 mt-1 mb-3">
        Без сертификата браузеры вообще не пускают на сайт. Выберите, как его получить:
      </p>

      <div className="flex flex-wrap gap-3">
        <Card>
          <div className="font-semibold text-slate-900">Let’s Encrypt</div>
          <div className="text-xs text-slate-500 mt-0.5">Бесплатно</div>
          <p className="text-sm text-slate-600 mt-2">Обновляется само.</p>
          <p className="text-sm text-amber-700 mt-2 flex-1">
            ⚠️ У части людей со старыми телефонами и компьютерами сайт может не открыться.
          </p>
          <button onClick={() => onIssue('letsencrypt')} disabled={busy}
                  className="btn-primary mt-3 w-full justify-center inline-flex items-center gap-2">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
            Получить
          </button>
        </Card>

        {sources.includes('zerossl') && (
          <Card>
            <div className="font-semibold text-slate-900">ZeroSSL</div>
            <div className="text-xs text-slate-500 mt-0.5">Бесплатно</div>
            <p className="text-sm text-slate-600 mt-2">Обновляется само.</p>
            <p className="text-sm text-emerald-700 mt-2 flex-1">
              ✅ Открывается у всех.
            </p>
            <button onClick={() => onIssue('zerossl')} disabled={busy}
                    className="btn-gold mt-3 w-full justify-center inline-flex items-center gap-2">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
              Получить
            </button>
          </Card>
        )}

        <Card>
          <div className="font-semibold text-slate-900">Свой сертификат</div>
          <p className="text-sm text-slate-600 mt-2 flex-1">
            Бесплатный сертификат часто дают там, где вы покупали домен.
            Например, у reg.ru в разделе «SSL-сертификаты» есть
            «Бесплатный SSL-сертификат» от GlobalSign.
          </p>
          <button onClick={() => setOpenUpload(v => !v)}
                  className="btn-primary mt-3 w-full justify-center">
            Загрузить
          </button>
        </Card>
      </div>

      {openUpload && (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm text-slate-700 mb-3">
            Скопируйте из личного кабинета регистратора <b>два блока текста</b> и вставьте сюда.
          </p>
          <label className="block text-sm font-medium text-slate-800 mb-1">
            Сертификат <span className="font-normal text-slate-500">— начинается с -----BEGIN CERTIFICATE-----</span>
          </label>
          <textarea value={cert} onChange={e => setCert(e.target.value)} rows={5}
                    className="w-full rounded-xl border border-slate-300 p-2 font-mono text-xs" />
          <p className="text-xs text-slate-500 mt-1 mb-3">
            Если регистратор прислал ещё «промежуточный сертификат» — вставьте его следом, в это же поле.
          </p>
          <label className="block text-sm font-medium text-slate-800 mb-1">
            Приватный ключ <span className="font-normal text-slate-500">— начинается с -----BEGIN PRIVATE KEY-----</span>
          </label>
          <textarea value={key} onChange={e => setKey(e.target.value)} rows={5}
                    className="w-full rounded-xl border border-slate-300 p-2 font-mono text-xs" />
          {err && <p className="text-sm text-red-600 mt-2">{err}</p>}
          <button onClick={upload} disabled={saving || !cert.trim() || !key.trim()}
                  className="btn-gold mt-3 inline-flex items-center gap-2 disabled:opacity-40">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
            Установить
          </button>
        </div>
      )}
    </div>
  )
}
