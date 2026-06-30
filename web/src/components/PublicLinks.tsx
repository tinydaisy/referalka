'use client'
import { useEffect, useState } from 'react'
import { Copy, Check, Globe, Save } from 'lucide-react'
import { api } from '@/lib/api'
import QrLinkButton from '@/components/QrLinkButton'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://pluson.ru'

interface LinkRow {
  key: string
  label: string
  badge: string         // 'TG' | 'MAX' | 'WEB' и т.д.
  color: string
  url: string
  hint?: string
}

type PlatformLinks = { telegram?: string; vk?: string; max?: string }

export default function PublicLinks({
  slug,
  eventId,
  onSlugSaved,
  eventStatus,
  linkMode,
  onLinkModeChange,
}: {
  slug: string | null | undefined
  eventId?: number
  onSlugSaved?: (newSlug: string) => void | Promise<void>
  /** Если 'draft' — ссылки затуманены, копирование заблокировано (партнёру отдавать нельзя). */
  eventStatus?: 'draft' | 'published' | 'ended' | null
  /** Текущий тип ссылок события: 'miniapp' (Mini App) | 'bot' (через ботов). */
  linkMode?: 'miniapp' | 'bot' | null
  /** Если передан — управляемый режим: радио НЕ сохраняет сразу, а зовёт callback
   *  (сохранение делает общая кнопка «Сохранить» на странице). Иначе — авто-сохранение. */
  onLinkModeChange?: (mode: 'miniapp' | 'bot') => void
}) {
  const isDraft = eventStatus === 'draft'
  const [copied, setCopied] = useState<string | null>(null)
  const [draft, setDraft] = useState(slug || '')
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Активный режим. Источник истины — общая настройка клиента
  // (clients.default_link_mode из /auth/me). Проп linkMode — необязательный
  // override (заложено на будущее пер-событийное переопределение).
  const [mode, setMode] = useState<'miniapp' | 'bot'>(linkMode === 'bot' ? 'bot' : 'miniapp')
  useEffect(() => {
    if (linkMode === 'miniapp' || linkMode === 'bot') { setMode(linkMode); return }
    // Иначе берём общий клиентский флаг.
    api.auth.me().then((m: any) => {
      setMode(m?.default_link_mode === 'bot' ? 'bot' : 'miniapp')
    }).catch(() => {})
  }, [linkMode])

  // Грузим ОБА набора ссылок (Mini App и через ботов), чтобы показать обе группы.
  const [miniappLinks, setMiniappLinks] = useState<PlatformLinks>({})
  const [botLinks, setBotLinks] = useState<PlatformLinks>({})
  useEffect(() => {
    if (!slug) { setMiniappLinks({}); setBotLinks({}); return }
    api.events.shareLinks(slug, undefined, 'miniapp')
      .then((r: any) => setMiniappLinks(r?.links || {})).catch(() => setMiniappLinks({}))
    api.events.shareLinks(slug, undefined, 'bot')
      .then((r: any) => setBotLinks(r?.links || {})).catch(() => setBotLinks({}))
  }, [slug])

  useEffect(() => { setDraft(slug || '') }, [slug])

  const editable = typeof eventId === 'number'
  const dirty = draft.trim().toLowerCase() !== (slug || '').toLowerCase()
  const canSave = editable && dirty && /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/.test(draft.trim().toLowerCase()) && draft.trim().length >= 3

  async function handleSave() {
    if (!editable || !canSave) return
    const newSlug = draft.trim().toLowerCase()
    setSaving(true); setErr(null)
    try {
      await api.events.update(eventId!, { slug: newSlug })
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1800)
      await onSlugSaved?.(newSlug)
    } catch (e: any) {
      setErr(String(e?.message || 'Не получилось сохранить код'))
    } finally {
      setSaving(false)
    }
  }


  // Сборка строк одной группы.
  const buildRows = (pl: PlatformLinks, kind: 'miniapp' | 'bot'): LinkRow[] => {
    if (!slug) return []
    const rows: LinkRow[] = []
    if (kind === 'miniapp') {
      rows.push({
        key: 'web', label: 'Веб-страница', badge: 'WEB', color: '#25455D',
        url: `${APP_URL}/l/${slug}`,
        hint: 'Лендинг события — публикуй в соцсетях, рассылках, на сайте',
      })
    }
    if (pl.telegram) rows.push({
      key: `${kind}-tg`, label: 'Telegram', badge: 'TG', color: '#229ED9', url: pl.telegram,
      hint: kind === 'miniapp'
        ? 'Открывает Mini App вашего бота (или @pluson_bot)'
        : 'Открывает бота — он пришлёт сообщение события с кнопкой «Зарегистрироваться»',
    })
    if (pl.vk) rows.push({
      key: `${kind}-vk`, label: 'ВКонтакте', badge: 'VK', color: '#0077FF', url: pl.vk,
      hint: kind === 'miniapp'
        ? 'Открывает VK Mini App'
        : 'Лёгкая заглушка — сообщество пишет в ЛС сообщение события',
    })
    if (pl.max) rows.push({
      key: `${kind}-max`, label: 'MAX', badge: 'MAX', color: '#FFCFA4', url: pl.max,
      hint: 'Используй когда подключите свой MAX-канал',
    })
    return rows
  }

  const miniappRows = buildRows(miniappLinks, 'miniapp')
  const botRows = buildRows(botLinks, 'bot')

  // Есть ли хоть одна платформенная ссылка (TG/VK/MAX) — бэк отдаёт их только при
  // подключённом своём канале. Если нет ни одной — показываем баннер «Каналы не
  // подключены» внутри блока. Завязка на реальные ссылки (не на кешированный /auth/me).
  const hasAnyPlatformLink =
    !!(miniappLinks.telegram || miniappLinks.vk || miniappLinks.max ||
       botLinks.telegram || botLinks.vk || botLinks.max)
  // Пока slug не загружен — ссылки ещё не запрашивались, баннер не показываем (не мигаем).
  const showNoChannelsBanner = !!slug && !hasAnyPlatformLink

  const copy = async (key: string, url: string) => {
    if (isDraft) {
      alert('Событие в черновике — ссылка не сработает у получателя. Сначала опубликуйте событие (статус справа сверху).')
      return
    }
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = url
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  const renderRow = (l: LinkRow) => (
    <div key={l.key} className="border border-gray-100 rounded-xl p-3">
      <div className="flex items-center gap-3">
        <span
          className="inline-flex items-center justify-center w-9 h-9 rounded-full text-[10px] font-bold text-white shrink-0"
          style={{ background: l.color }}
        >
          {l.badge}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-800">{l.label}</p>
          {isDraft ? (
            <span
              className="text-xs text-[#25455D] truncate block select-none"
              style={{ filter: 'blur(4px)' }}
              title="Опубликуйте событие, чтобы открыть ссылку"
            >
              {l.url}
            </span>
          ) : (
            <a href={l.url} target="_blank" rel="noreferrer"
               className="text-xs text-[#25455D] truncate block hover:underline">
              {l.url}
            </a>
          )}
        </div>
        <button
          onClick={() => copy(l.key, l.url)}
          className={`p-2 rounded-lg ${isDraft ? 'text-gray-300 cursor-not-allowed' : 'hover:bg-gray-100 text-gray-500'}`}
          title={isDraft ? 'Сначала опубликуйте событие' : 'Скопировать ссылку'}
        >
          {copied === l.key ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
        </button>
        {!isDraft && (
          <QrLinkButton url={l.url} name={l.label} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 flex items-center" iconSize={15} iconClass="" />
        )}
      </div>
      {l.hint && <p className="text-xs text-gray-400 mt-1.5 ml-12">{l.hint}</p>}
    </div>
  )

  // Заголовок группы (информационный, без выбора — режим задаётся общей
  // настройкой клиента в /dashboard/mini-app → «Бот и ссылки»).
  const groupHeader = (title: string, desc: string) => (
    <div className="w-full text-left flex items-start gap-3 p-3 rounded-xl border border-[#FFCFA4] bg-[#FFF8F1]">
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-gray-800">{title}</span>
        <span className="block text-xs text-gray-500 mt-0.5">{desc}</span>
      </span>
    </div>
  )

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6">
      <div className="flex items-center gap-2 mb-1">
        <Globe size={18} className="text-gray-500" />
        <h2 className="text-sm font-bold uppercase tracking-wider text-gray-800">Публичные ссылки</h2>
      </div>
      <p className="text-xs text-gray-400 mb-4">
        Эти ссылки выдаются спикерам и участникам (в кабинетах и материалах). Режим открытия
        (Mini App / веб) задаётся общей настройкой в разделе «Mini App» → «Бот и ссылки».
      </p>

      {/* Баннер «Каналы не подключены» — красный полупрозрачный, только если
          реально нет ни одной платформенной ссылки (TG/VK/MAX). */}
      {showNoChannelsBanner && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-500/10 p-4 flex items-start gap-3">
          <svg className="text-red-600 shrink-0 mt-0.5" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <div className="flex-1 text-sm">
            <div className="font-semibold text-red-800 mb-1">Каналы не подключены</div>
            <div className="text-red-700/90">
              Без подключённого бота/сообщества ссылки на площадки ниже не появятся, а регистрация
              и рассылки работать не будут. Подключите хотя бы один канал.
            </div>
            <a
              href="/dashboard/channels"
              className="inline-flex items-center gap-1 mt-2 text-sm font-medium underline text-red-800 hover:text-red-600"
            >
              Подключить каналы →
            </a>
          </div>
        </div>
      )}

      {/* Редактор slug */}
      {editable && (
        <div className="mb-5 p-4 rounded-xl bg-gray-50 border border-gray-100">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Код ссылки</label>
          <p className="text-xs text-gray-500 mb-2">
            По умолчанию — короткий случайный код. Можно заменить на свой: латиница, цифры и дефис.
            Например <span className="font-mono">ivision-8</span>.
          </p>
          <div className="flex items-stretch gap-2">
            <div className="flex-1 flex items-center rounded-lg border border-gray-200 bg-white overflow-hidden">
              <span className="px-3 py-2 text-xs text-gray-400 font-mono whitespace-nowrap border-r border-gray-100">
                {APP_URL.replace(/^https?:\/\//, '')}/l/
              </span>
              <input
                value={draft}
                onChange={e => setDraft(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="ivision-8"
                className="flex-1 px-2 py-2 text-sm font-mono text-[#25455D] outline-none"
                maxLength={60}
              />
            </div>
            <button
              onClick={handleSave}
              disabled={!canSave || saving}
              className="px-4 rounded-lg text-white text-sm font-medium disabled:opacity-40 flex items-center gap-1.5"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
            >
              <Save size={14} />
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
          {err && <p className="text-xs text-red-500 mt-2">{err}</p>}
          {savedFlash && <p className="text-xs text-green-600 mt-2">Сохранено ✓ — ссылки ниже обновились</p>}
        </div>
      )}

      {!slug ? (
        <p className="text-sm text-gray-400">Появятся после сохранения мероприятия (нужен код).</p>
      ) : (
        <>
          {isDraft && (
            <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 leading-relaxed">
              ⚠️ Событие в черновике — эти ссылки <b>не работают</b> у получателей.
              Чтобы запустить, переключите статус «Опубликовано» в правом верхнем углу.
            </div>
          )}

          {/* Показываем только актуальный набор — режим задаётся общей
              настройкой клиента (Mini App / веб). */}
          {mode === 'miniapp' ? (
            <div>
              {groupHeader('Регистрация через Mini App',
                'Открывает приложение (Mini App) внутри Telegram/VK. + веб-лендинг.')}
              <div className="space-y-2 mt-2">{miniappRows.map(renderRow)}</div>
            </div>
          ) : (
            <div>
              {groupHeader('Регистрация через ботов',
                'Открывает бота — он пишет в личку сообщение события с кнопкой «Зарегистрироваться».')}
              {botRows.length ? (
                <div className="space-y-2 mt-2">{botRows.map(renderRow)}</div>
              ) : (
                <p className="text-xs text-gray-400 mt-2 ml-1">
                  Ссылки появятся, когда у клиента подключён бот на платформе.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
