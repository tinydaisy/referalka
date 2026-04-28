'use client'
import { useState, useEffect } from 'react'
import {
  Plus, Radio, Users, BellOff, Edit2, Trash2, X, Eye, EyeOff,
  Crown, Copy, ExternalLink, CheckCircle2, ArrowRight,
} from 'lucide-react'
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
  bot_token: string | null
}

interface Me {
  id: number
  tariff_slug: string
  tariff_name?: string
  allow_custom_bot: boolean
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
  const [me, setMe] = useState<Me | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Channel | null>(null)
  const [creating, setCreating] = useState(false)
  const [vipWizardOpen, setVipWizardOpen] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const [meRes, chs, pls] = await Promise.all([
        api.auth.me(),
        api.channels.list(),
        api.platforms.list(),
      ])
      setMe(meRes)
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

  if (loading) {
    return <div className="p-6 text-gray-400 text-sm">Загрузка...</div>
  }

  const isVip = me?.allow_custom_bot === true

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Radio size={24} /> Каналы
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Боты Telegram, группы VK и MAX-каналы для рассылок и подписок
        </p>
      </div>

      {!isVip ? (
        <NonVipView onUpgrade={() => alert('Свяжитесь с поддержкой для перехода на VIP')} />
      ) : (
        <VipView
          channels={channels}
          platforms={platforms}
          onEdit={ch => setEditing(ch)}
          onCreate={() => setCreating(true)}
          onDelete={handleDelete}
          onOpenWizard={() => setVipWizardOpen(true)}
        />
      )}

      {(creating || editing) && (
        <ChannelModal
          channel={editing}
          platforms={platforms}
          onClose={() => { setEditing(null); setCreating(false) }}
          onSaved={() => { setEditing(null); setCreating(false); load() }}
        />
      )}

      {vipWizardOpen && (
        <VipBotWizard
          clientId={me!.id}
          onClose={() => setVipWizardOpen(false)}
          onDone={() => { setVipWizardOpen(false); load() }}
        />
      )}
    </div>
  )
}

/* ─────── Не-VIP: read-only + апсейл ─────── */
function NonVipView({ onUpgrade }: { onUpgrade: () => void }) {
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex items-center gap-4">
        <PlatformBadge slug="telegram" color="#0088CC" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900">@pluson_bot</h3>
            <span className="text-[10px] bg-green-50 text-green-700 px-2 py-0.5 rounded-full font-medium">
              активен
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Общий бот ПЛЮСОНа — отправляет рассылки и приветствия от вашего имени
          </p>
        </div>
      </div>

      <div
        className="rounded-2xl p-6 text-white relative overflow-hidden"
        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
      >
        <div
          className="absolute top-0 right-0 w-40 h-40 -mr-12 -mt-12 rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(255,207,164,0.25) 0%, transparent 70%)' }}
        />
        <div className="relative">
          <div className="inline-flex items-center gap-2 bg-white/10 px-3 py-1 rounded-full text-xs font-medium mb-4">
            <Crown size={14} style={{ color: '#FFCFA4' }} />
            <span>VIP-тариф</span>
          </div>
          <h2 className="text-xl font-bold mb-2">Хотите свой брендовый бот?</h2>
          <p className="text-white/75 text-sm mb-5 max-w-lg">
            Подключите собственный Telegram-бот — рассылки приходят от вашего имени, в Mini App
            открывается ваш персональный кабинет вместо общего ПЛЮСОН-бота.
          </p>

          <ul className="text-sm text-white/85 space-y-2 mb-5">
            <li className="flex items-center gap-2">
              <CheckCircle2 size={16} style={{ color: '#FFCFA4' }} />
              Свой бот в Telegram (например @your_event_bot)
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 size={16} style={{ color: '#FFCFA4' }} />
              Mini App с вашей визиткой и продуктами
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 size={16} style={{ color: '#FFCFA4' }} />
              Рассылки от имени вашего бота, не от @pluson_bot
            </li>
          </ul>

          <button
            onClick={onUpgrade}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm"
            style={{ background: '#FFCFA4', color: '#25455D' }}
          >
            Перейти на VIP <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─────── VIP: полный CRUD + кнопка wizard ─────── */
function VipView({ channels, platforms, onEdit, onCreate, onDelete, onOpenWizard }: {
  channels: Channel[]
  platforms: Platform[]
  onEdit: (ch: Channel) => void
  onCreate: () => void
  onDelete: (id: number) => void
  onOpenWizard: () => void
}) {
  const tgChannel = channels.find(c => c.platform_slug === 'telegram' && c.is_active)

  return (
    <div className="space-y-4">
      {!tgChannel ? (
        <div
          className="rounded-2xl p-6 border-2 border-dashed cursor-pointer hover:bg-gray-50 transition"
          style={{ borderColor: '#FFCFA4' }}
          onClick={onOpenWizard}
        >
          <div className="flex items-start gap-4">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
              style={{ background: '#FFCFA4' }}
            >
              <Crown size={20} style={{ color: '#25455D' }} />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-gray-900 mb-1">Подключите свой Telegram-бот</h3>
              <p className="text-sm text-gray-600">
                Вставьте токен от @BotFather — мы подключим бот, настроим Mini App и дадим
                инструкцию для финальной привязки. Займёт 2 минуты.
              </p>
              <button
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium"
                style={{ color: '#25455D' }}
              >
                Запустить мастер <ArrowRight size={14} />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <ChannelCard
          channel={tgChannel}
          onEdit={() => onEdit(tgChannel)}
          onDelete={() => onDelete(tgChannel.id)}
          onReplaceBot={onOpenWizard}
        />
      )}

      {/* Остальные каналы (VK/MAX) и доп. каналы */}
      {channels.filter(c => c !== tgChannel).map(ch => (
        <ChannelCard
          key={ch.id}
          channel={ch}
          onEdit={() => onEdit(ch)}
          onDelete={() => onDelete(ch.id)}
        />
      ))}

      {platforms.length > 1 && (
        <button
          onClick={onCreate}
          className="w-full py-3 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-2"
        >
          <Plus size={16} /> Добавить канал на другой платформе
        </button>
      )}
    </div>
  )
}

function ChannelCard({ channel: ch, onEdit, onDelete, onReplaceBot }: {
  channel: Channel
  onEdit: () => void
  onDelete: () => void
  onReplaceBot?: () => void
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-4">
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
        {onReplaceBot && (
          <button
            onClick={onReplaceBot}
            className="px-3 py-1.5 text-xs rounded-lg font-medium"
            style={{ background: '#FFCFA4', color: '#25455D' }}
            title="Заменить бот"
          >
            Заменить
          </button>
        )}
        <button
          onClick={onEdit}
          className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-[#25455D]"
          title="Редактировать"
        ><Edit2 size={14} /></button>
        <button
          onClick={onDelete}
          className="p-2 hover:bg-red-50 rounded-lg text-gray-500 hover:text-red-500"
          title="Удалить"
        ><Trash2 size={14} /></button>
      </div>
    </div>
  )
}

/* ─────── VIP-wizard: подключение своего бота ─────── */
function VipBotWizard({ clientId, onClose, onDone }: {
  clientId: number
  onClose: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ bot_username: string; mini_app_url: string } | null>(null)

  async function submitToken() {
    setError('')
    setSubmitting(true)
    try {
      const r = await api.channels.connectTelegramBot(token.trim())
      setResult({ bot_username: r.bot_username, mini_app_url: r.mini_app_url })
      setStep(3)
    } catch (e: any) {
      setError(e.message || 'Не удалось подключить бот')
    } finally {
      setSubmitting(false)
    }
  }

  function copy(value: string) {
    navigator.clipboard.writeText(value).then(
      () => alert('Скопировано'),
      () => alert('Не удалось скопировать'),
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Crown size={18} style={{ color: '#FFCFA4' }} />
            Подключение своего бота
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X size={18} />
          </button>
        </div>

        {/* Шаг-индикатор */}
        <div className="flex items-center px-5 py-3 border-b border-gray-100 text-xs text-gray-500">
          {[1, 2, 3].map(n => (
            <div key={n} className="flex items-center flex-1 last:flex-none">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold
                  ${step >= n ? 'text-white' : 'text-gray-400 bg-gray-100'}`}
                style={step >= n ? { background: '#25455D' } : undefined}
              >
                {step > n ? '✓' : n}
              </div>
              {n < 3 && <div className={`flex-1 h-0.5 mx-2 ${step > n ? 'bg-[#25455D]' : 'bg-gray-100'}`} />}
            </div>
          ))}
        </div>

        <div className="p-5">
          {step === 1 && (
            <div className="space-y-4">
              <h3 className="font-semibold text-gray-900">Шаг 1. Создайте бот в @BotFather</h3>
              <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5">
                <li>Откройте <a href="https://t.me/BotFather" target="_blank" rel="noopener" className="font-medium" style={{ color: '#25455D' }}>@BotFather</a> в Telegram</li>
                <li>Отправьте команду <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono text-xs">/newbot</code></li>
                <li>Придумайте имя и username (должен заканчиваться на <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono text-xs">_bot</code>)</li>
                <li>BotFather пришлёт токен — скопируйте его</li>
              </ol>
              <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-xs text-blue-900">
                💡 Если бот уже есть — пропустите этот шаг и сразу перейдите к шагу 2.
              </div>
              <button
                onClick={() => setStep(2)}
                className="w-full py-3 rounded-xl font-semibold text-sm text-white"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
              >
                У меня есть токен →
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h3 className="font-semibold text-gray-900">Шаг 2. Вставьте токен</h3>
              <p className="text-sm text-gray-600">
                Мы проверим токен через Telegram, сохраним его и автоматически настроим Mini App
                в вашем боте.
              </p>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Bot Token</label>
                <div className="relative">
                  <input
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    className="w-full px-3 py-2.5 pr-10 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
                    placeholder="123456:ABC-DEF1234..."
                    disabled={submitting}
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700"
                  >{showToken ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                </div>
              </div>
              {error && (
                <div className="bg-red-50 border border-red-100 text-red-700 text-sm rounded-xl p-3">
                  {error}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setStep(1)}
                  className="flex-1 py-2.5 rounded-xl font-medium text-sm border border-gray-200 text-gray-600 hover:bg-gray-50"
                  disabled={submitting}
                >Назад</button>
                <button
                  onClick={submitToken}
                  disabled={!token.trim() || submitting}
                  className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white disabled:opacity-50"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
                >
                  {submitting ? 'Подключаем…' : 'Подключить'}
                </button>
              </div>
            </div>
          )}

          {step === 3 && result && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-100 rounded-xl">
                <CheckCircle2 size={20} className="text-green-600 mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold text-green-900">Бот @{result.bot_username} подключён</p>
                  <p className="text-sm text-green-800 mt-0.5">
                    Кнопка «Открыть кабинет» добавлена в бот автоматически.
                  </p>
                </div>
              </div>

              <h3 className="font-semibold text-gray-900">Шаг 3. Привяжите Mini App в @BotFather</h3>
              <p className="text-sm text-gray-600">
                Один последний шаг — нужно сделать вручную через BotFather (Telegram не даёт
                сделать это автоматически).
              </p>

              <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5">
                <li>Откройте <a href="https://t.me/BotFather" target="_blank" rel="noopener" className="font-medium" style={{ color: '#25455D' }}>@BotFather</a></li>
                <li>Отправьте команду <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono text-xs">/newapp</code></li>
                <li>Выберите вашего бота <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono text-xs">@{result.bot_username}</code></li>
                <li>На шаге «Web App URL» вставьте URL ниже</li>
              </ol>

              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                <div className="text-xs text-gray-500 mb-1.5">Web App URL для копирования:</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono break-all text-gray-900">
                    {result.mini_app_url}
                  </code>
                  <button
                    onClick={() => copy(result.mini_app_url)}
                    className="p-2 rounded-lg hover:bg-gray-200 text-gray-600"
                    title="Скопировать"
                  ><Copy size={14} /></button>
                </div>
              </div>

              <a
                href={`https://t.me/${result.bot_username}`}
                target="_blank"
                rel="noopener"
                className="block text-center py-2.5 rounded-xl font-medium text-sm border border-gray-200 hover:bg-gray-50"
                style={{ color: '#25455D' }}
              >
                <ExternalLink size={14} className="inline mr-1.5 -mt-0.5" />
                Открыть @{result.bot_username}
              </a>

              <button
                onClick={onDone}
                className="w-full py-3 rounded-xl font-semibold text-sm text-white"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
              >Готово</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─────── Старая модалка ручного редактирования (для VK/MAX и edit existing) ─────── */
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
  const [showToken, setShowToken] = useState(false)
  const [isActive, setIsActive] = useState(channel?.is_active ?? true)
  const [saving, setSaving] = useState(false)

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

          {platformSlug === 'telegram' && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Bot Token <span className="text-gray-400">(секрет)</span>
              </label>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={botToken}
                  onChange={e => setBotToken(e.target.value)}
                  className="w-full px-3 py-2 pr-10 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
                  placeholder="123456:ABC-DEF..."
                />
                <button
                  type="button"
                  onClick={() => setShowToken(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700"
                >{showToken ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              </div>
            </div>
          )}

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
