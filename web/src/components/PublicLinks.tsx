'use client'
import { useEffect, useState } from 'react'
import { Copy, Check, Globe, Save } from 'lucide-react'
import { api } from '@/lib/api'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://pluson.ru'

interface LinkRow {
  key: string
  label: string
  badge: string         // 'TG' | 'MAX' | 'WEB' и т.д.
  color: string
  url: string
  hint?: string
}

export default function PublicLinks({
  slug,
  eventId,
  onSlugSaved,
  eventStatus,
}: {
  slug: string | null | undefined
  eventId?: number
  onSlugSaved?: (newSlug: string) => void | Promise<void>
  /** Если 'draft' — ссылки затуманены, копирование заблокировано (партнёру отдавать нельзя). */
  eventStatus?: 'draft' | 'published' | 'ended' | null
}) {
  const isDraft = eventStatus === 'draft'
  const [copied, setCopied] = useState<string | null>(null)
  const [draft, setDraft] = useState(slug || '')
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [err, setErr] = useState<string | null>(null)

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

  const links: LinkRow[] = slug ? [
    {
      key: 'web',
      label: 'Веб-страница',
      badge: 'WEB',
      color: '#25455D',
      url: `${APP_URL}/l/${slug}`,
      hint: 'Лендинг события — публикуй в соцсетях, рассылках, на сайте',
    },
    {
      key: 'telegram',
      label: 'Telegram (Mini App)',
      badge: 'TG',
      color: '#229ED9',
      url: `${APP_URL}/l/${slug}?app=tg`,
      hint: 'Открывает событие в вашем Telegram-боте (или @pluson_bot, если свой не подключён). Используй в TG-постах и личке',
    },
    {
      key: 'vk',
      label: 'ВКонтакте (Mini App)',
      badge: 'VK',
      color: '#0077FF',
      url: `https://vk.com/app54592404#ref_pg${slug}`,
      hint: 'Открывает событие в VK Mini App «iViSiON: ПЛЮСОН». Используй в VK-постах и личке',
    },
    {
      key: 'max',
      label: 'MAX',
      badge: 'MAX',
      color: '#FFCFA4',
      url: `${APP_URL}/l/${slug}?app=max`,
      hint: 'Открывает событие в MAX-канале (как только подключим бота в MAX)',
    },
  ] : []

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

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6">
      <div className="flex items-center gap-2 mb-1">
        <Globe size={18} className="text-gray-500" />
        <h2 className="text-sm font-bold uppercase tracking-wider text-gray-800">Публичные ссылки</h2>
      </div>
      <p className="text-xs text-gray-400 mb-4">
        Под каждую площадку — своя ссылка. Хвостик после <span className="font-mono">/l/</span> — это код события.
      </p>

      {/* Редактор slug */}
      {editable && (
        <div className="mb-5 p-4 rounded-xl bg-gray-50 border border-gray-100">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Код ссылки
          </label>
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
        <p className="text-sm text-gray-400">
          Появятся после сохранения мероприятия (нужен код).
        </p>
      ) : (
        <>
          {isDraft && (
            <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 leading-relaxed">
              ⚠️ Событие в черновике — эти ссылки <b>не работают</b> у получателей.
              Чтобы запустить, переключите статус «Опубликовано» в правом верхнем углу.
            </div>
          )}
          <div className="space-y-2">
            {links.map(l => (
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
                      <a
                        href={l.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-[#25455D] truncate block hover:underline"
                      >
                        {l.url}
                      </a>
                    )}
                  </div>
                  <button
                    onClick={() => copy(l.key, l.url)}
                    className={`p-2 rounded-lg ${isDraft ? 'text-gray-300 cursor-not-allowed' : 'hover:bg-gray-100 text-gray-500'}`}
                    title={isDraft ? 'Сначала опубликуйте событие' : 'Скопировать ссылку'}
                  >
                    {copied === l.key ? (
                      <Check size={15} className="text-green-600" />
                    ) : (
                      <Copy size={15} />
                    )}
                  </button>
                </div>
                {l.hint && <p className="text-xs text-gray-400 mt-1.5 ml-12">{l.hint}</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
