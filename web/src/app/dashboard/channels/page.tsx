'use client'
import { useState, useEffect } from 'react'
import { Plus, Radio, Users, BellOff, Edit2, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'

interface Platform {
  slug: string
  display_name: string
  icon_url: string | null
  color_hex: string | null
  is_active: boolean
}

interface Channel {
  id: number
  platform_slug: string
  platform_display_name: string
  platform_color_hex: string | null
  display_name: string
  handle: string | null
  is_active: boolean
  subscribers: number
  unsubscribed: number
  created_at: string
  bot_token?: string | null
}

function PlatformBadge({ slug, color }: { slug: string; color?: string | null }) {
  const labels: Record<string, string> = { telegram: 'TG', vk: 'VK', max: 'MX' }
  return (
    <span
      className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold text-white shrink-0"
      style={{ background: color || '#25455D' }}
    >
      {labels[slug] || slug.slice(0, 2).toUpperCase()}
    </span>
  )
}

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Channel | null>(null)
  const [creating, setCreating] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [chs, pls] = await Promise.all([api.channels.list(), api.platforms.list()])
      setChannels(chs.items || [])
      setPlatforms(pls.items || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleDelete = async (id: number) => {
    if (!confirm('Удалить канал? Все подписки на нём пропадут.')) return
    try {
      await api.channels.delete(id)
      await load()
    } catch (e) {
      alert('Ошибка: ' + (e as Error).message)
    }
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Radio size={24} /> Каналы
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Боты Telegram, группы VK и MAX-каналы для рассылок и подписок
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-white font-medium text-sm"
          style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
        >
          <Plus size={16} />Добавить канал
        </button>
      </div>

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка...</div>
      ) : channels.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-12 text-center">
          <Radio size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 mb-4">Каналов пока нет</p>
          <button
            onClick={() => setCreating(true)}
            className="text-sm text-[#25455D] underline"
          >Добавить первый канал</button>
        </div>
      ) : (
        <div className="space-y-3">
          {channels.map(ch => (
            <div key={ch.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-4">
              <PlatformBadge slug={ch.platform_slug} color={ch.platform_color_hex} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-gray-900 truncate">{ch.display_name}</h3>
                  {!ch.is_active && (
                    <span className="text-[10px] bg-gray-100 text-gray-400 px-2 py-0.5 rounded-full">выключен</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 truncate">
                  {ch.platform_display_name}
                  {ch.handle && <span className="ml-2 font-mono">{ch.handle}</span>}
                </p>
              </div>
              <div className="flex items-center gap-4 text-sm shrink-0">
                <div className="flex items-center gap-1.5 text-green-600">
                  <Users size={14} />
                  <span>{ch.subscribers.toLocaleString('ru')}</span>
                </div>
                <div className="flex items-center gap-1.5 text-red-400">
                  <BellOff size={14} />
                  <span>{ch.unsubscribed.toLocaleString('ru')}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setEditing(ch)}
                  className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-[#25455D]"
                ><Edit2 size={14} /></button>
                <button
                  onClick={() => handleDelete(ch.id)}
                  className="p-2 hover:bg-red-50 rounded-lg text-gray-500 hover:text-red-500"
                ><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <ChannelModal
          channel={editing}
          platforms={platforms}
          onClose={() => { setEditing(null); setCreating(false) }}
          onSaved={() => { setEditing(null); setCreating(false); load() }}
        />
      )}
    </div>
  )
}

function ChannelModal({ channel, platforms, onClose, onSaved }: {
  channel: Channel | null
  platforms: Platform[]
  onClose: () => void
  onSaved: () => void
}) {
  const [platformSlug, setPlatformSlug] = useState(channel?.platform_slug || 'telegram')
  const [displayName, setDisplayName] = useState(channel?.display_name || '')
  const [handle, setHandle] = useState(channel?.handle || '')
  const [botToken, setBotToken] = useState('')
  const [isActive, setIsActive] = useState(channel?.is_active ?? true)
  const [saving, setSaving] = useState(false)

  // Подгружаем bot_token при редактировании
  useEffect(() => {
    if (channel) {
      api.channels.get(channel.id).then(d => {
        setBotToken(d.bot_token || '')
      }).catch(() => {})
    }
  }, [channel])

  const submit = async () => {
    if (!displayName.trim()) {
      alert('Введите название канала')
      return
    }
    setSaving(true)
    try {
      if (channel) {
        await api.channels.update(channel.id, {
          display_name: displayName,
          handle: handle || null,
          bot_token: botToken || null,
          is_active: isActive,
        })
      } else {
        await api.channels.create({
          platform_slug: platformSlug,
          display_name: displayName,
          handle: handle || null,
          bot_token: botToken || null,
          is_active: isActive,
        })
      }
      onSaved()
    } catch (e) {
      alert('Ошибка: ' + (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">
            {channel ? 'Редактировать канал' : 'Добавить канал'}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {!channel && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Платформа</label>
              <select
                value={platformSlug}
                onChange={e => setPlatformSlug(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
              >
                {platforms.map(p => (
                  <option key={p.slug} value={p.slug}>{p.display_name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs text-gray-500 mb-1">Название (для себя)</label>
            <input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
              placeholder="Например: Основной TG-бот"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Handle <span className="text-gray-400">(@username бота / id группы)</span>
            </label>
            <input
              value={handle}
              onChange={e => setHandle(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
              placeholder="@pluson_bot"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Bot Token <span className="text-gray-400">(секрет — для отправки сообщений)</span>
            </label>
            <input
              type="password"
              value={botToken}
              onChange={e => setBotToken(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
              placeholder="123456:ABC-DEF..."
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={e => setIsActive(e.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-gray-700">Канал активен</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">
            Отмена
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg text-white font-medium disabled:opacity-50"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
          >
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}
