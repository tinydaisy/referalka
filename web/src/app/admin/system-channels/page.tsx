'use client'
import { useEffect, useState } from 'react'
import { Plus, Radio, Users, BellOff, Sparkles, AlertTriangle, Loader2, X, Trash2, Edit2, CheckCircle2 } from 'lucide-react'

interface SystemChannel {
  id: number
  platform_slug: string
  display_name: string
  handle: string | null
  is_system: boolean
  is_test: boolean
  clients_attached: number
  subscribers: number
  unsubscribed: number
  created_at: string
  updated_at: string
}

const API = process.env.NEXT_PUBLIC_API_URL || ''

async function adminFetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = localStorage.getItem('plusson_admin_token') || localStorage.getItem('plusson_token')
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(init.headers || {}),
    },
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error(err.detail || `HTTP ${r.status}`)
  }
  return r.json()
}

interface PlussonPlatform {
  slug: string
  label: string
  /** Отмечена в админке — показываем клиентам. */
  enabled: boolean
  /** У платформы есть бот на этой площадке (handle + токен). */
  has_bot: boolean
  handle: string
  /** Реально показывается прямо сейчас = enabled И has_bot. */
  shown: boolean
}

/**
 * ⚠️⚠️ ОДНА НАСТРОЙКА НА ТРИ МЕСТА (миграция 476). Что отмечено здесь, то
 * клиент и видит: ссылки Плюсоновского подарка, «Написать в тех.поддержку» и
 * «Партнёрка ПЛЮСОНа». Раньше каждое место решало само, и они разъехались —
 * в подарке ВК показывался, в партнёрке его не было вовсе, а поддержка вообще
 * жила захардкоженным списком во фронте.
 */
function PlussonPlatformsBlock() {
  const [items, setItems] = useState<PlussonPlatform[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState('')
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    try {
      const r = await adminFetch('/api/v1/admin/plusson-platforms')
      setItems(r.items || [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function toggle(slug: string) {
    const next = items.map(p => p.slug === slug ? { ...p, enabled: !p.enabled } : p)
    setItems(next)          // сразу рисуем новое состояние — галочка не должна «думать»
    setSaving(slug); setError('')
    try {
      await adminFetch('/api/v1/admin/plusson-platforms', {
        method: 'PATCH',
        body: JSON.stringify({ platforms: next.filter(p => p.enabled).map(p => p.slug) }),
      })
      await load()          // перечитываем: `shown` считает бэкенд, а не экран
    } catch (e: any) {
      setError(e.message)
      await load()          // не сохранилось — возвращаем то, что в базе
    } finally {
      setSaving('')
    }
  }

  return (
    <div className="bg-white rounded-2xl border-2 border-[#25455D]/20 overflow-hidden mb-6">
      <div className="px-4 py-3" style={{ background: '#FFCFA4' }}>
        <h2 className="font-semibold" style={{ color: '#25455D' }}>
          Площадки ПЛЮСОНа, которые видят клиенты
        </h2>
      </div>
      <div className="p-4">
        <p className="text-sm text-gray-500 mb-3">
          Действует сразу в трёх местах: ссылки Плюсоновского подарка, «Написать
          в тех.поддержку» и «Партнёрка ПЛЮСОНа». Снимете галочку — площадка
          пропадёт везде, без пересборки сайта.
        </p>

        {error && (
          <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center gap-2">
            <AlertTriangle size={16} /> {error}
          </div>
        )}

        {loading ? (
          <div className="text-gray-400 flex items-center gap-2 text-sm">
            <Loader2 className="animate-spin" size={16} /> Загрузка…
          </div>
        ) : (
          <div className="space-y-2">
            {items.map(p => (
              <label
                key={p.slug}
                className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                  p.enabled ? 'border-[#25455D]/30 bg-[#25455D]/[0.04]' : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={p.enabled}
                  disabled={!!saving}
                  onChange={() => toggle(p.slug)}
                  className="w-4 h-4 accent-[#25455D] shrink-0"
                />
                <span className="font-medium text-gray-900 w-28 shrink-0">{p.label}</span>
                <span className="text-xs text-gray-500 flex-1 min-w-0 truncate">
                  {p.has_bot ? `@${p.handle}` : 'бота нет — ссылку показать не из чего'}
                </span>
                {saving === p.slug ? (
                  <Loader2 className="animate-spin text-gray-400 shrink-0" size={14} />
                ) : p.shown ? (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold flex items-center gap-1 shrink-0">
                    <CheckCircle2 size={10} /> показывается
                  </span>
                ) : (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-semibold shrink-0">
                    скрыта
                  </span>
                )}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function AdminSystemChannelsPage() {
  const [items, setItems] = useState<SystemChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<SystemChannel | null>(null)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true); setError('')
    try {
      const r = await adminFetch('/api/v1/admin/system-channels')
      setItems(r.items || [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Radio /> Системные каналы
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Общие боты и каналы сервиса (@pluson_bot, MAX, VK). Доступны всем клиентам.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium text-sm"
          style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
        >
          <Plus size={16} /> Добавить
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      <PlussonPlatformsBlock />

      {loading && <div className="text-gray-400 flex items-center gap-2"><Loader2 className="animate-spin" size={16} /> Загрузка…</div>}

      {!loading && items.length === 0 && (
        <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-8 text-center text-gray-500">
          Нет системных каналов. Нажмите «Добавить» — первый канал создаётся в тестовом режиме.
        </div>
      )}

      <div className="space-y-3">
        {items.map(ch => (
          <div key={ch.id} className={`bg-white rounded-2xl border p-4 flex items-center gap-4 ${
            ch.is_test ? 'border-amber-200 bg-amber-50/30' : 'border-gray-100'
          }`}>
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: '#FFCFA4' }}>
              <Sparkles size={18} style={{ color: '#25455D' }} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-gray-900 truncate">{ch.display_name}</h3>
                {ch.is_test ? (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">
                    🧪 ТЕСТ — клиентам не выдан
                  </span>
                ) : (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold flex items-center gap-1">
                    <CheckCircle2 size={10} /> В БОЮ — выдан клиентам
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 truncate mt-0.5">
                {ch.platform_slug} {ch.handle && <span className="ml-2 font-mono">{ch.handle}</span>}
              </p>
              <div className="flex items-center gap-4 text-xs text-gray-500 mt-2">
                <span className="flex items-center gap-1"><Users size={12}/> {ch.subscribers} подписчиков</span>
                <span className="flex items-center gap-1"><BellOff size={12}/> {ch.unsubscribed} отписалось</span>
                <span>· у {ch.clients_attached} клиентов</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setEditing(ch)}
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-[#25455D]"
                title="Редактировать / выпустить в бой"
              ><Edit2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>

      {(creating || editing) && (
        <ChannelModal
          channel={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
          onDelete={async () => {
            if (!editing) return
            if (!confirm(`Удалить канал "${editing.display_name}"? Только если 0 подписок.`)) return
            try {
              await adminFetch(`/api/v1/admin/system-channels/${editing.id}`, { method: 'DELETE' })
              setEditing(null); load()
            } catch (e: any) {
              alert('Ошибка: ' + e.message)
            }
          }}
        />
      )}
    </div>
  )
}

function ChannelModal({ channel, onClose, onSaved, onDelete }: {
  channel: SystemChannel | null
  onClose: () => void
  onSaved: () => void
  onDelete: () => Promise<void>
}) {
  const isNew = !channel
  const [platformSlug, setPlatformSlug] = useState(channel?.platform_slug || 'telegram')
  const [displayName, setDisplayName] = useState(channel?.display_name || '')
  const [handle, setHandle] = useState(channel?.handle || '')
  const [botToken, setBotToken] = useState('')
  const [isTest, setIsTest] = useState(channel?.is_test ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setSaving(true); setError('')
    try {
      if (isNew) {
        await adminFetch('/api/v1/admin/system-channels', {
          method: 'POST',
          body: JSON.stringify({
            platform_slug: platformSlug,
            display_name: displayName,
            handle: handle || null,
            bot_token: botToken || null,
          }),
        })
      } else {
        const body: any = {
          display_name: displayName,
          handle: handle || null,
          is_test: isTest,
        }
        if (botToken) body.bot_token = botToken
        await adminFetch(`/api/v1/admin/system-channels/${channel!.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
      }
      onSaved()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto scroll-visible">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 sticky top-0 bg-white">
          <h2 className="text-lg font-bold text-gray-900">{isNew ? 'Новый системный канал' : 'Редактирование'}</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
          )}

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">Платформа</label>
            <select
              value={platformSlug}
              onChange={e => setPlatformSlug(e.target.value)}
              disabled={!isNew}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50"
            >
              <option value="telegram">Telegram</option>
              <option value="vk">ВКонтакте</option>
              <option value="max">MAX</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">Название (для клиентов)</label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Общий бот iViSiON: ПЛЮСОНа"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">Handle (@username)</label>
            <input
              type="text"
              value={handle}
              onChange={e => setHandle(e.target.value)}
              placeholder="@pluson_bot"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5">
              Bot Token {!isNew && <span className="text-gray-400 font-normal">(оставьте пустым чтобы не менять)</span>}
            </label>
            <input
              type="password"
              value={botToken}
              onChange={e => setBotToken(e.target.value)}
              placeholder={isNew ? '12345:AAA...' : '••••••••'}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono"
            />
            {!isNew && (
              <p className="text-xs text-gray-400 mt-1">
                Токен можно менять только в тесте без подписчиков. Иначе — 409.
              </p>
            )}
          </div>

          {!isNew && (
            <div className="border-t border-gray-100 pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-gray-900">Режим</div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Тест → клиенты НЕ видят. В бою → выдан всем клиентам.
                  </p>
                </div>
                <select
                  value={isTest ? '1' : '0'}
                  onChange={e => setIsTest(e.target.value === '1')}
                  className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
                >
                  <option value="1">🧪 Тест</option>
                  <option value="0">✅ В бой (выдать клиентам)</option>
                </select>
              </div>
              {channel && !channel.is_test && isTest && (
                <p className="text-xs text-amber-700 mt-2">
                  ⚠️ Возврат в тест возможен только если 0 подписок.
                </p>
              )}
              {channel && channel.is_test && !isTest && (
                <p className="text-xs text-green-700 mt-2">
                  ✓ После сохранения создастся запись client_channels для всех клиентов.
                </p>
              )}
            </div>
          )}
        </div>
        <div className="p-5 border-t border-gray-100 flex items-center justify-between gap-3">
          {!isNew && (
            <button
              onClick={onDelete}
              className="px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg flex items-center gap-1.5"
            ><Trash2 size={14} /> Удалить</button>
          )}
          <div className="flex gap-2 ml-auto">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50"
            >Отмена</button>
            <button
              onClick={save}
              disabled={saving || !displayName.trim()}
              className="px-4 py-2 rounded-lg text-white font-medium text-sm disabled:opacity-40"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
            >
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
