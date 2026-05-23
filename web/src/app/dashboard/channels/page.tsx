'use client'
import { useState, useEffect } from 'react'
import {
  Plus, Radio, Users, BellOff, Edit2, Trash2, X, Eye, EyeOff,
  Crown, Copy, ExternalLink, CheckCircle2, ArrowRight, Megaphone, AlertTriangle,
  Upload, Download, FileText, HelpCircle, Sparkles, Loader2,
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
  is_system?: boolean   // системный канал iViSiON: ПЛЮСОНа (общий @pluson_bot и т.п.)
  is_test?: boolean     // в тестовом режиме админа (не выдан клиентам)
  subscribers: number
  unsubscribed: number
  created_at: string
  bot_token: string | null
}

interface Me {
  id: number
  features?: string[]
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
  const [vkWizardOpen, setVkWizardOpen] = useState(false)
  const [deletingChannel, setDeletingChannel] = useState<Channel | null>(null)
  const [importingChannel, setImportingChannel] = useState<Channel | null>(null)

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

  if (loading) {
    return <div className="p-6 text-gray-400 text-sm">Загрузка...</div>
  }

  const isVip = (me?.features || []).includes('channels')

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
          onDelete={ch => setDeletingChannel(ch)}
          onOpenWizard={() => setVipWizardOpen(true)}
          onOpenVkWizard={() => setVkWizardOpen(true)}
          onImport={ch => setImportingChannel(ch)}
        />
      )}

      {(creating || editing) && (
        <ChannelModal
          key={editing ? `edit-${editing.id}` : 'create-new'}
          channel={editing}
          platforms={platforms}
          onClose={() => { setEditing(null); setCreating(false) }}
          onSaved={() => { setEditing(null); setCreating(false); load() }}
          onSwitchToVkWizard={() => { setEditing(null); setCreating(false); setVkWizardOpen(true) }}
        />
      )}

      {vipWizardOpen && (
        <VipBotWizard
          clientId={me!.id}
          onClose={() => setVipWizardOpen(false)}
          onDone={() => { setVipWizardOpen(false); load() }}
        />
      )}

      {vkWizardOpen && (
        <VipVkWizard
          clientId={me!.id}
          onClose={() => setVkWizardOpen(false)}
          onDone={() => { setVkWizardOpen(false); load() }}
        />
      )}

      {deletingChannel && (
        <DeleteChannelModal
          channel={deletingChannel}
          onClose={() => setDeletingChannel(null)}
          onDone={() => { setDeletingChannel(null); load() }}
        />
      )}

      {importingChannel && (
        <ImportCsvModal
          channel={importingChannel}
          onClose={() => setImportingChannel(null)}
          onDone={() => { setImportingChannel(null); load() }}
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
            Общий бот iViSiON: ПЛЮСОНа — отправляет рассылки и приветствия от вашего имени
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
            открывается ваш персональный кабинет вместо общего iViSiON: ПЛЮСОН-бота.
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
function VipView({ channels, platforms, onEdit, onCreate, onDelete, onOpenWizard, onOpenVkWizard, onImport }: {
  channels: Channel[]
  platforms: Platform[]
  onEdit: (ch: Channel) => void
  onCreate: () => void
  onDelete: (ch: Channel) => void
  onOpenWizard: () => void
  onOpenVkWizard: () => void
  onImport: (ch: Channel) => void
}) {
  const mainTgChannel = channels.find(c => c.platform_slug === 'telegram' && c.is_active && !c.is_system)
  const mainVkChannel = channels.find(c => c.platform_slug === 'vk' && c.is_active && !c.is_system)
  const restChannels = channels.filter(c => c !== mainTgChannel && c !== mainVkChannel)

  return (
    <div className="space-y-4">
      {!mainTgChannel ? (
        <ConnectInvite
          title="Подключите свой Telegram-бот"
          description="Вставьте токен от @BotFather — мы подключим бот, настроим Mini App и дадим инструкцию для финальной привязки. Займёт 2 минуты."
          buttonText="Запустить мастер"
          badge="TG"
          badgeColor="#0088CC"
          onClick={onOpenWizard}
        />
      ) : (
        <ChannelCard
          channel={mainTgChannel}
          onEdit={() => onEdit(mainTgChannel)}
          onDelete={() => onDelete(mainTgChannel)}
          onImport={() => onImport(mainTgChannel)}
        />
      )}

      {!mainVkChannel ? (
        <ConnectInvite
          title="Подключите своё VK-сообщество"
          description="Создайте сообщество и Mini App в ВКонтакте, вставьте 4 параметра — мы валидируем токен и включим Long Poll. Подробная инструкция со скриншотами — внутри мастера."
          buttonText="Запустить мастер VK"
          badge="VK"
          badgeColor="#0077FF"
          onClick={onOpenVkWizard}
        />
      ) : (
        <>
          <ChannelCard
            channel={mainVkChannel}
            onEdit={() => onEdit(mainVkChannel)}
            onDelete={() => onDelete(mainVkChannel)}
            onImport={() => onImport(mainVkChannel)}
          />
          <VkVideoTokenBlock channel={mainVkChannel} />
        </>
      )}

      {/* Остальные каналы (системные + дополнительные TG-боты для рассылок) */}
      {restChannels.map(ch => (
        <ChannelCard
          key={ch.id}
          channel={ch}
          onEdit={() => onEdit(ch)}
          onDelete={() => onDelete(ch)}
          onImport={() => onImport(ch)}
        />
      ))}

      <button
        onClick={onCreate}
        className="w-full py-3 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-2"
      >
        <Plus size={16} /> Добавить ещё канал
      </button>
      <p className="text-xs text-gray-400 text-center -mt-2">
        Можно подключить несколько ботов на одной площадке. «Воронка событий» (приветствия, /start,
        регистрации) — только через один из них, остальные = база для рассылок.
      </p>
    </div>
  )
}

function ChannelCard({ channel: ch, onEdit, onDelete, onImport }: {
  channel: Channel
  onEdit: () => void
  onDelete: () => void
  onImport: () => void
}) {
  const isTelegram = ch.platform_slug === 'telegram'
  const isSystem = !!ch.is_system
  return (
    <div className={`bg-white rounded-2xl border shadow-sm p-4 flex items-center gap-4 ${
      isSystem ? 'border-amber-100 bg-gradient-to-r from-amber-50/40 to-white' : 'border-gray-100'
    }`}>
      <PlatformBadge slug={ch.platform_slug} color={ch.platform_color_hex} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-gray-900 truncate">{ch.display_name}</h3>
          {isSystem && (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold"
              style={{ background: '#FFCFA4', color: '#25455D' }}
              title="Общий бот сервиса iViSiON: ПЛЮСОН — управляется администратором, доступен всем клиентам"
            >
              <Sparkles size={10} /> Системный
            </span>
          )}
          {ch.is_active ? (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold"
              style={{ background: '#FFCFA4', color: '#25455D' }}
              title="Через этот бот идут /start, регистрации и приветствия"
            >
              <Crown size={10} /> Воронка событий
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-500"
              title="Бот используется только как база для рассылок — события не слушает"
            >
              <Megaphone size={10} /> Только рассылки
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 truncate">
          {ch.platform_display_name}
          {ch.handle && <span className="ml-2 font-mono">{ch.handle}</span>}
        </p>
      </div>
      <div className="flex items-center gap-4 text-sm shrink-0">
        <div className="flex items-center gap-1.5 text-green-600" title="Подписчики (ваши)">
          <Users size={14} />
          <span>{ch.subscribers.toLocaleString('ru')}</span>
        </div>
        <div className="flex items-center gap-1.5 text-red-400" title="Отписавшиеся (ваши)">
          <BellOff size={14} />
          <span>{ch.unsubscribed.toLocaleString('ru')}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isSystem ? (
          // Для системного канала — только информационная иконка с пояснением.
          // Управление (токен, удаление, импорт) — у администратора iViSiON: ПЛЮСОНа.
          <button
            type="button"
            onClick={() => alert(
              'Это общий бот сервиса iViSiON: ПЛЮСОН.\n\n' +
              '• Токен и параметры бота управляются администратором iViSiON: ПЛЮСОНа.\n' +
              '• Удалить нельзя — он подключён ко всем клиентам сервиса.\n' +
              '• Импорт CSV не нужен — подписчики приходят сами через /start или Mini App.\n' +
              '• Подписки ваших клиентов отделены от других клиентов: вы видите только своих подписчиков.'
            )}
            className="p-2 hover:bg-amber-50 rounded-lg text-amber-500 hover:text-amber-600"
            title="Системный канал — почему нельзя редактировать"
          ><HelpCircle size={16} /></button>
        ) : (
          <>
            {isTelegram && (
              <button
                onClick={onImport}
                className="p-2 hover:bg-amber-50 rounded-lg text-gray-500 hover:text-[#c98852]"
                title="Импорт пользователей из CSV"
              ><Upload size={14} /></button>
            )}
            <button
              onClick={onEdit}
              className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-[#25455D]"
              title="Редактировать"
            ><Edit2 size={14} /></button>
            <button
              onClick={onDelete}
              className="p-2 hover:bg-red-50 rounded-lg text-gray-500 hover:text-red-500"
              title="Удалить навсегда"
            ><Trash2 size={14} /></button>
          </>
        )}
      </div>
    </div>
  )
}

/* ─────── Карточка-приглашение «Подключите свой канал» ─────── */
function ConnectInvite({ title, description, buttonText, badge, badgeColor, onClick }: {
  title: string
  description: string
  buttonText: string
  badge: string
  badgeColor: string
  onClick: () => void
}) {
  return (
    <div
      className="rounded-2xl p-6 border-2 border-dashed cursor-pointer hover:bg-gray-50 transition"
      style={{ borderColor: '#FFCFA4' }}
      onClick={onClick}
    >
      <div className="flex items-start gap-4">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-white font-bold text-xs"
          style={{ background: badgeColor }}
        >
          {badge}
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-gray-900 mb-1 flex items-center gap-2">
            <Crown size={16} style={{ color: '#FFCFA4' }} />
            {title}
          </h3>
          <p className="text-sm text-gray-600">{description}</p>
          <button
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium"
            style={{ color: '#25455D' }}
          >
            {buttonText} <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─────── VK видео-токен админа (OAuth Implicit Flow) ───────
 *
 * Зачем: community-токен VK запрещает video.save (нужны права scope=video).
 * Чтобы видео в воронках лид-магнитов уходило с нативным VK-плеером
 * (а не файлом MP4), клиент проходит OAuth у себя в аккаунте админа сообщества
 * и пастит редирект-URL сюда. Бэк парсит #access_token и пишет в platform_meta.
 */
function VkVideoTokenBlock({ channel }: { channel: Channel }) {
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connected = !!(channel as any).vk_admin_token_connected
  const adminName = (channel as any).vk_admin_user_name || ''
  const adminScreen = (channel as any).vk_admin_user_screen || ''

  async function startOauth() {
    setError(null)
    try {
      const r = await api.channels.vkOauthUrl(channel.id) as { oauth_url: string }
      window.open(r.oauth_url, '_blank', 'noopener')
      setWaiting(true)
      // Poll: каждые 3 сек запрашиваем list channels, если у нашего канала
      // появился флаг vk_admin_token_connected — обновляем страницу.
      const started = Date.now()
      const interval = setInterval(async () => {
        try {
          const res = await api.channels.list() as { items: any[] }
          const updated = res.items?.find(c => c.id === channel.id)
          if (updated?.vk_admin_token_connected) {
            clearInterval(interval)
            window.location.reload()
          }
          // через 5 минут — стоп polling, юзер видимо забил или произошла ошибка
          if (Date.now() - started > 5 * 60 * 1000) {
            clearInterval(interval)
            setWaiting(false)
          }
        } catch {}
      }, 3000)
    } catch (e: any) {
      setError(e.message || 'Не удалось получить OAuth URL')
    }
  }

  async function disconnect() {
    if (!confirm('Отключить токен для нативного видео? Видео в воронках будут уходить файлом MP4, не плеером.')) return
    try {
      await api.channels.vkDeleteAdminToken(channel.id)
      window.location.reload()
    } catch (e: any) {
      setError(e.message || 'Не удалось отключить')
    }
  }

  return (
    <div className="bg-blue-50/40 border border-blue-100 rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
          <span className="text-sm font-bold text-blue-700">📹</span>
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-semibold text-gray-800 text-sm">Нативное видео в VK-воронках</h4>
          <p className="text-xs text-gray-500 mt-0.5">
            Чтобы видео в шаблонах воронок лид-магнитов приходило получателям с инлайн-плеером
            (а не файлом MP4), VK требует токен админа сообщества с правом <code>video</code>.
            Сообществу такие права не выдаются.
          </p>
          {connected ? (
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-2 py-1">
                ✓ Подключён{adminName ? `: ${adminName}` : ''}
                {adminScreen && (
                  <a href={`https://vk.com/${adminScreen}`} target="_blank" rel="noopener"
                     className="ml-1 underline">vk.com/{adminScreen}</a>
                )}
              </span>
              <button onClick={disconnect}
                className="text-xs text-red-600 hover:underline">Отключить</button>
            </div>
          ) : (
            <>
              {!waiting ? (
                <button onClick={startOauth}
                  className="mt-3 px-3 py-1.5 rounded-lg text-white text-xs font-medium"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                  Подключить VK для нативного видео →
                </button>
              ) : (
                <div className="mt-3 bg-white border border-blue-200 rounded-lg p-3 text-xs text-gray-700 space-y-1.5">
                  <p>
                    <Loader2 size={12} className="inline animate-spin mr-1" />
                    Открыли VK-вкладку. Подтвердите права <code>video</code> и нажмите «Разрешить».
                  </p>
                  <p className="text-gray-500">
                    После подтверждения вкладка покажет «Готово». Эта страница автоматически обновится.
                  </p>
                  <button onClick={() => setWaiting(false)}
                    className="text-blue-600 hover:underline">Отменить ожидание</button>
                </div>
              )}
            </>
          )}
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        </div>
      </div>
    </div>
  )
}


/* ─────── VIP-wizard VK: подключение своего сообщества ─────── */
function VipVkWizard({ clientId, onClose, onDone }: {
  clientId: number
  onClose: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [form, setForm] = useState({
    access_token: '',
    app_id: '',
    secure_key: '',
    group_id: '',
  })
  const [showToken, setShowToken] = useState(false)
  const [showSecure, setShowSecure] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ group_name: string; screen_name: string; mini_app_url: string } | null>(null)

  async function submit() {
    setError('')
    const app_id = Number(form.app_id)
    const group_id = Number(form.group_id)
    if (!form.access_token.trim()) return setError('Введите Access Token сообщества')
    if (!app_id || app_id <= 0)   return setError('Неверный VK App ID')
    if (!form.secure_key.trim())   return setError('Введите Secure key Mini App')
    if (!group_id || group_id <= 0) return setError('Неверный ID сообщества')

    setSubmitting(true)
    try {
      const r = await api.channels.connectVkCommunity({
        access_token: form.access_token.trim(),
        app_id, secure_key: form.secure_key.trim(), group_id,
      })
      setResult({ group_name: r.group_name, screen_name: r.screen_name, mini_app_url: r.mini_app_url })
      setStep(3)
    } catch (e: any) {
      setError(e?.message || 'Не удалось подключить сообщество')
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
            Подключение своего VK-сообщества
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
              <h3 className="font-semibold text-gray-900">Шаг 1. Создайте сообщество и Mini App</h3>
              <p className="text-sm text-gray-600">
                Пошаговая инструкция со скриншотами — в разделе{' '}
                <a href="/dashboard/help/vk-setup" target="_blank" rel="noopener"
                   className="font-medium underline" style={{ color: '#25455D' }}>
                  Инструкции → Mini App в VK-сообществе
                </a>.
              </p>
              <p className="text-sm text-gray-600">Когда выполните 1–7 пункты — вам понадобятся <b>4 параметра</b>:</p>
              <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5">
                <li><b>Access Token сообщества</b> — токен с правами <code className="bg-gray-100 px-1 rounded text-xs">messages + manage</code></li>
                <li><b>VK Mini App ID</b> — число из dev.vk.com/mini-apps/...</li>
                <li><b>Защищённый ключ Mini App</b> (Secure Key) — там же. <span className="text-amber-700">Не путать с «Сервисным ключом доступа» — это другой ключ, нам нужен именно «Защищённый».</span></li>
                <li><b>ID сообщества</b> — число из URL (например vk.com/club<b>123456</b>)</li>
              </ul>
              <button
                onClick={() => setStep(2)}
                className="w-full py-3 rounded-xl font-semibold text-sm text-white"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
              >
                Параметры готовы →
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <h3 className="font-semibold text-gray-900">Шаг 2. Вставьте параметры</h3>
              <p className="text-sm text-gray-600">
                Мы проверим токен через VK API, получим название сообщества и включим Long Poll
                автоматически.
              </p>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Access Token сообщества <span className="text-red-500">*</span></label>
                <div className="relative">
                  <input
                    type={showToken ? 'text' : 'password'}
                    value={form.access_token}
                    onChange={e => setForm(f => ({ ...f, access_token: e.target.value }))}
                    className="w-full px-3 py-2.5 pr-10 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
                    placeholder="vk1.a.zZJ..."
                    disabled={submitting}
                    autoComplete="off"
                  />
                  <button type="button" onClick={() => setShowToken(v => !v)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700">
                    {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">VK App ID <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    value={form.app_id}
                    onChange={e => setForm(f => ({ ...f, app_id: e.target.value.replace(/\D/g, '') }))}
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
                    placeholder="54592404"
                    disabled={submitting}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">ID сообщества <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    value={form.group_id}
                    onChange={e => setForm(f => ({ ...f, group_id: e.target.value.replace(/\D/g, '') }))}
                    className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
                    placeholder="238697730"
                    disabled={submitting}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Защищённый ключ Mini App (Secure Key) <span className="text-red-500">*</span></label>
                <div className="relative">
                  <input
                    type={showSecure ? 'text' : 'password'}
                    value={form.secure_key}
                    onChange={e => setForm(f => ({ ...f, secure_key: e.target.value }))}
                    className="w-full px-3 py-2.5 pr-10 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
                    placeholder="qvlnu84MSNtLKn1zcT90"
                    disabled={submitting}
                    autoComplete="off"
                  />
                  <button type="button" onClick={() => setShowSecure(v => !v)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700">
                    {showSecure ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-100 text-red-700 text-sm rounded-xl p-3">
                  {error}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setStep(1)}
                  className="flex-1 py-2.5 rounded-xl font-medium text-sm border border-gray-200 text-gray-600 hover:bg-gray-50"
                  disabled={submitting}
                >Назад</button>
                <button
                  onClick={submit}
                  disabled={submitting}
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
                  <p className="font-semibold text-green-900">Сообщество «{result.group_name}» подключено ✓</p>
                  <p className="text-sm text-green-800 mt-0.5">
                    Через ~10 секунд бот вашего сообщества будет готов: начнёт принимать
                    сообщения от подписчиков, отвечать в Mini App и слать ваши рассылки.
                  </p>
                </div>
              </div>

              <h3 className="font-semibold text-gray-900">Последний шаг — вставить адрес Mini App в ВК</h3>
              <p className="text-sm text-gray-600">
                Если вы уже сделали это в шаге 7 инструкции — пропустите.
                Если нет: откройте <a href="https://dev.vk.com" target="_blank" rel="noopener" className="font-medium underline" style={{ color: '#25455D' }}>dev.vk.com</a> →
                ваш Mini App → раздел <b>«Настройки» → «Размещение»</b>. Туда нужно
                вставить эту ссылку (во все три поля URL — мобильное приложение, десктоп, мобильный сайт):
              </p>

              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                <div className="text-xs text-gray-500 mb-1.5">Ваш персональный URL Mini App:</div>
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
                <div className="text-xs text-gray-400 mt-1.5">
                  ⚠️ Косая черта (слэш) в конце обязательна — не удаляйте её.
                </div>
              </div>

              {result.screen_name && (
                <a
                  href={`https://vk.com/${result.screen_name}`}
                  target="_blank"
                  rel="noopener"
                  className="block text-center py-2.5 rounded-xl font-medium text-sm border border-gray-200 hover:bg-gray-50"
                  style={{ color: '#25455D' }}
                >
                  <ExternalLink size={14} className="inline mr-1.5 -mt-0.5" />
                  Открыть vk.com/{result.screen_name}
                </a>
              )}

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

              <h3 className="font-semibold text-gray-900">Шаг 3. Настройте Main Mini App в @BotFather</h3>
              <p className="text-sm text-gray-600">
                Это <b>главное приложение бота</b> — открывается одной кнопкой в чате,
                ссылки получаются короткие <code className="bg-gray-100 px-1 rounded text-xs">t.me/{result.bot_username}?startapp=…</code>.
                Telegram не даёт настроить это через API — придётся пройти через @BotFather.
              </p>

              <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5">
                <li>Откройте <a href="https://t.me/BotFather" target="_blank" rel="noopener" className="font-medium" style={{ color: '#25455D' }}>@BotFather</a></li>
                <li>Команда <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono text-xs">/mybots</code> → выберите <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono text-xs">@{result.bot_username}</code></li>
                <li>Нажмите <b>«Bot Settings»</b> → <b>«Configure Mini App»</b></li>
                <li>Если Mini App ещё не включён — <b>«Enable Mini App»</b></li>
                <li><b>«Edit Mini App URL»</b> → вставьте URL из блока ниже. Должно прийти «Success! URL updated» — это всё, других полей в Configure Mini App нет.</li>
              </ol>

              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                <div className="text-xs text-gray-500 mb-1.5">Mini App URL для копирования:</div>
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
                <div className="text-xs text-gray-400 mt-1.5">
                  ⚠️ Слэш в конце обязателен — без него Telegram не загрузит ассеты.
                </div>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
                🧹 <b>Если раньше создавали Mini App через старую команду <code className="bg-amber-100 px-1 rounded">/newapp</code></b> —
                его обязательно нужно удалить, иначе он будет открываться параллельно
                с правильным и показывать старую версию приложения. В @BotFather:
                <code className="bg-amber-100 px-1 rounded">/myapps</code> → выберите старый Mini App →
                <b> «Delete App»</b> → подтвердите именем приложения.
              </div>

              <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900">
                💡 Полная пошаговая инструкция со всеми деталями (включая Menu Button и <code className="bg-blue-100 px-1 rounded">/setdomain</code>) — в разделе{' '}
                <a href="/dashboard/help/connect-bot" target="_blank" rel="noopener" className="font-medium underline">Инструкции → Подключение Mini App</a>.
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
function ChannelModal({ channel, platforms, onClose, onSaved, onSwitchToVkWizard }: {
  channel: Channel | null
  platforms: Platform[]
  onClose: () => void
  onSaved: () => void
  onSwitchToVkWizard?: () => void
}) {
  const [platformSlug, setPlatformSlug] = useState(channel?.platform_slug || 'telegram')
  const [displayName, setDisplayName] = useState(channel?.display_name || '')
  const [handle, setHandle] = useState(channel?.handle || '')
  const [botToken, setBotToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [isActive, setIsActive] = useState(channel?.is_active ?? false)
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

          {/* VK подключается отдельным мастером — у обычной формы нет нужных полей
              (Access Token, App ID, Secure Key, ID сообщества). Перебрасываем туда. */}
          {!channel && platformSlug === 'vk' ? (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
              <div className="text-sm font-semibold text-gray-900 mb-1">
                Для VK нужен отдельный мастер
              </div>
              <p className="text-sm text-gray-700 mb-3">
                Сообщество ВКонтакте подключается через специальный мастер из 3 шагов
                (Access Token сообщества, ID сообщества, App ID и Secure Key Mini App) —
                эта обычная форма не подходит, в ней нет нужных полей.
              </p>
              {onSwitchToVkWizard && (
                <button
                  type="button"
                  onClick={onSwitchToVkWizard}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
                >
                  Открыть мастер VK
                </button>
              )}
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Название (для себя)</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore="true"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Handle</label>
                <input
                  type="text"
                  value={handle}
                  onChange={e => setHandle(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore="true"
                />
              </div>
            </>
          )}

          {platformSlug === 'telegram' && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Bot Token</label>
              <div className="relative">
                {/* type="text" умышленно — иначе Chrome принимает поле за password
                    и пытается автозаполнить сохранённым паролем. Видимость
                    переключается ниткой *...* / реальный текст через CSS. */}
                <input
                  type="text"
                  value={botToken}
                  onChange={e => setBotToken(e.target.value)}
                  className="w-full px-3 py-2 pr-10 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  style={showToken ? undefined : { WebkitTextSecurity: 'disc' } as React.CSSProperties}
                />
                <button
                  type="button"
                  onClick={() => setShowToken(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700"
                >{showToken ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              </div>
            </div>
          )}

          {/* Главный канал — переключение через явное действие с подтверждением.
              Без простой галочки, чтобы случайно не переключить воронку.
              Для VK при создании прячем — там отдельный мастер. */}
          {!channel && platformSlug === 'vk' ? null : !channel ? (
            // Создание нового канала — обычная галочка
            <label className="flex items-start gap-3 cursor-pointer p-3 rounded-xl border border-gray-200 hover:bg-gray-50">
              <input
                type="checkbox"
                checked={isActive}
                onChange={e => setIsActive(e.target.checked)}
                className="mt-0.5 rounded"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
                  <Crown size={14} style={{ color: '#FFCFA4' }} />
                  Сделать главным каналом
                </div>
                <p className="text-xs text-gray-500 mt-1 leading-snug">
                  /start, регистрации и приветствия пойдут через этот бот. Текущий главный станет дополнительным.
                </p>
              </div>
            </label>
          ) : channel.is_active ? (
            // Уже главный в БД — просто плашка, переключают через другой канал
            <div className="p-3 rounded-xl border" style={{ borderColor: '#FFCFA4', background: 'rgba(255,207,164,0.12)' }}>
              <div className="text-sm font-semibold flex items-center gap-1.5" style={{ color: '#25455D' }}>
                <Crown size={14} style={{ color: '#FFCFA4' }} />
                ✓ Это главный канал
              </div>
              <p className="text-xs text-gray-600 mt-1 leading-snug">
                Через него идёт воронка событий: /start, регистрации, приветствия. Чтобы переключить — откройте редактирование другого канала и нажмите «Сделать главным».
              </p>
            </div>
          ) : isActive ? (
            // Был неактивен, в этой сессии нажали «Сделать главным» — ждёт сохранения
            <div className="p-3 rounded-xl border border-amber-300 bg-amber-50">
              <div className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                <Crown size={14} style={{ color: '#FFCFA4' }} />
                Будет сделан главным после «Сохранить»
              </div>
              <p className="text-xs text-amber-800 mt-1 leading-snug mb-2">
                Текущий главный станет дополнительным (только база для рассылок). Действие применится после клика «Сохранить» внизу.
              </p>
              <button
                type="button"
                onClick={() => setIsActive(false)}
                className="text-xs font-medium text-amber-900 underline"
              >
                Отменить — оставить дополнительным
              </button>
            </div>
          ) : (
            // Неактивен — кнопка с подтверждением
            <div className="p-3 rounded-xl border border-gray-200">
              <div className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                <Megaphone size={14} className="text-gray-400" />
                Дополнительный канал — только база для рассылок
              </div>
              <p className="text-xs text-gray-500 mt-1 leading-snug mb-3">
                Рассылки через него идут, но воронка событий и Mini App работают через главный канал.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Сделать «${displayName}» главным каналом?\n\nТекущий главный станет дополнительным (только база для рассылок). /start, регистрации и приветствия пойдут через этот бот.\n\nДействие применится после клика «Сохранить».`)) {
                    setIsActive(true)
                  }
                }}
                className="text-xs font-semibold px-3 py-2 rounded-lg"
                style={{ background: '#FFCFA4', color: '#25455D' }}
              >
                Сделать главным
              </button>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">
            {(!channel && platformSlug === 'vk') ? 'Закрыть' : 'Отмена'}
          </button>
          {!(!channel && platformSlug === 'vk') && (
            <button
              onClick={submit}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg text-white font-medium disabled:opacity-50"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
            >
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─────── Модалка удаления с защитой от случайности ─────── */
function DeleteChannelModal({ channel, onClose, onDone }: {
  channel: Channel
  onClose: () => void
  onDone: () => void
}) {
  const [confirmText, setConfirmText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const canDelete = confirmText === 'ПОДТВЕРДИТЬ'

  async function doDelete() {
    if (!canDelete) return
    setError('')
    setSubmitting(true)
    try {
      await api.channels.delete(channel.id)
      onDone()
    } catch (e: any) {
      setError(e?.message || 'Не удалось удалить канал')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <AlertTriangle size={18} className="text-red-500" />
            Удалить канал навсегда?
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="font-semibold mb-1">Перед удалением подумайте</div>
            <p className="leading-snug">
              Если вы хотите перестать использовать этот бот, но <b>сохранить базу подписчиков</b> —
              лучше переведите его в неактивный (рассылки по нему всё равно можно будет делать).
              Удалять стоит только если бот вам совсем не нужен — например, вы передаёте управление
              этим ботом в другой сервис.
            </p>
          </div>

          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            При удалении канала <b className="font-mono">{channel.display_name}</b>: бот, его
            подписчики (<b>{channel.subscribers.toLocaleString('ru')}</b>) и история отписок будут
            стёрты безвозвратно.
          </div>

          <div>
            <label className="block text-sm text-gray-700 mb-2">
              Чтобы подтвердить, введите <b className="font-mono">ПОДТВЕРДИТЬ</b> заглавными
              буквами:
            </label>
            <input
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg font-mono uppercase tracking-wider focus:outline-none focus:border-red-500"
              placeholder="ПОДТВЕРДИТЬ"
              autoFocus
              disabled={submitting}
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-3">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
            disabled={submitting}
          >
            Отмена
          </button>
          <button
            onClick={doDelete}
            disabled={!canDelete || submitting}
            className="px-4 py-2 text-sm rounded-lg text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed bg-red-600 hover:bg-red-700"
          >
            {submitting ? 'Удаляем…' : 'ОК, удалить навсегда'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─────── Импорт из CSV ─────── */

interface ImportResult {
  stats: {
    total_rows: number
    created_contacts: number
    matched_by_tg_id: number
    merged_by_email_phone: number
    matched_existing: number
    subscribed: number
    unsubscribed: number
    skipped_no_tgid: number
    skipped_invalid_tgid: number
    duplicates_in_file: number
    mismatches: number
    tg_clash_skipped: number
  }
  report_text: string
  channel_name: string
}

const CSV_TEMPLATE = `telegram_id,name,telegram_username,email,phone,subscribed
123456789,Иван Петров,ivan_p,ivan@mail.ru,+79991234567,1
987654321,Мария Сидорова,,maria@mail.ru,89998887766,1
555444333,Пётр,petr_x,,,0
`

function ImportCsvModal({ channel, onClose, onDone }: {
  channel: Channel
  onClose: () => void
  onDone: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)

  function downloadTemplate() {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'plusson_import_template.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  function downloadReport() {
    if (!result) return
    const blob = new Blob([result.report_text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const safeName = channel.display_name.replace(/[^a-zа-я0-9_-]/gi, '_')
    a.download = `import_report_${safeName}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function submit() {
    if (!file) return
    setError('')
    setSubmitting(true)
    try {
      const r = await api.channels.importCsv(channel.id, file)
      setResult(r)
    } catch (e: any) {
      setError(e?.message || 'Не удалось импортировать файл')
    } finally {
      setSubmitting(false)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) setFile(f)
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Upload size={18} />
            Импорт пользователей в «{channel.display_name}»
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {!result ? (
            <>
              {/* Инструкция */}
              <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-900 space-y-2">
                <div className="font-semibold">Как сформировать CSV</div>
                <p className="leading-snug">
                  Файл с заголовком в первой строке. Колонки:
                </p>
                <ul className="space-y-1 pl-4 list-disc text-[13px] leading-snug">
                  <li><b className="font-mono">telegram_id</b> — обязательно. Без него строка пропускается.</li>
                  <li><b className="font-mono">name</b> — имя контакта</li>
                  <li><b className="font-mono">telegram_username</b> — никнейм без @</li>
                  <li><b className="font-mono">email</b>, <b className="font-mono">phone</b> — для мерджа с существующими контактами</li>
                  <li><b className="font-mono">subscribed</b> — <code className="bg-blue-100 px-1 rounded">1</code>/<code className="bg-blue-100 px-1 rounded">да</code> (по умолчанию) или <code className="bg-blue-100 px-1 rounded">0</code>/<code className="bg-blue-100 px-1 rounded">нет</code></li>
                </ul>
                <p className="leading-snug pt-1">
                  <b>Что делает мердж:</b> если человек с таким <code className="bg-blue-100 px-1 rounded">telegram_id</code> уже
                  есть (например, подписан на другой ваш канал) — он не дублируется, ему просто добавляется подписка
                  на этот канал. То же если в базе уже есть контакт с таким email или телефоном.
                </p>
                <p className="leading-snug">
                  <b>Что НЕ перетираем:</b> если в базе уже есть имя/email/телефон, и в CSV пришли другие — оставим
                  как в базе. Все нестыковки попадут в отчёт об ошибках.
                </p>
              </div>

              <button
                onClick={downloadTemplate}
                className="inline-flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"
                style={{ color: '#25455D' }}
              >
                <Download size={14} /> Скачать шаблон CSV
              </button>

              {/* Зона выбора файла */}
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={`rounded-2xl border-2 border-dashed p-8 text-center transition cursor-pointer
                  ${dragOver ? 'bg-amber-50' : 'bg-gray-50 hover:bg-gray-100'}`}
                style={dragOver ? { borderColor: '#FFCFA4' } : { borderColor: '#e5e7eb' }}
                onClick={() => document.getElementById('csv-file-input')?.click()}
              >
                <input
                  id="csv-file-input"
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={e => setFile(e.target.files?.[0] || null)}
                />
                {file ? (
                  <div className="flex items-center justify-center gap-3">
                    <FileText size={28} style={{ color: '#25455D' }} />
                    <div className="text-left">
                      <div className="font-semibold text-gray-900 text-sm">{file.name}</div>
                      <div className="text-xs text-gray-500">{(file.size / 1024).toFixed(1)} КБ</div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); setFile(null) }}
                      className="text-xs text-red-500 hover:text-red-700 font-medium ml-2"
                    >Убрать</button>
                  </div>
                ) : (
                  <>
                    <Upload size={32} className="mx-auto mb-2 text-gray-400" />
                    <p className="text-sm text-gray-700 font-medium">
                      Перетащите CSV-файл или нажмите чтобы выбрать
                    </p>
                    <p className="text-xs text-gray-500 mt-1">До 10 МБ. UTF-8 или CP1251.</p>
                  </>
                )}
              </div>

              {error && (
                <div className="bg-red-50 border border-red-100 text-red-700 text-sm rounded-xl p-3">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
                  disabled={submitting}
                >Отмена</button>
                <button
                  onClick={submit}
                  disabled={!file || submitting}
                  className="px-5 py-2 text-sm rounded-lg text-white font-semibold disabled:opacity-50"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
                >
                  {submitting ? 'Загружаем…' : 'Импортировать'}
                </button>
              </div>
            </>
          ) : (
            <ImportResultView
              result={result}
              onDownloadReport={downloadReport}
              onClose={onDone}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function ImportResultView({ result, onDownloadReport, onClose }: {
  result: ImportResult
  onDownloadReport: () => void
  onClose: () => void
}) {
  const s = result.stats
  const hasIssues = s.skipped_no_tgid + s.skipped_invalid_tgid + s.duplicates_in_file + s.mismatches + (s.tg_clash_skipped || 0) > 0

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-100 rounded-xl">
        <CheckCircle2 size={20} className="text-green-600 mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold text-green-900">Импорт завершён</p>
          <p className="text-sm text-green-800 mt-0.5">
            Обработано {s.total_rows.toLocaleString('ru')} строк
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Создано контактов" value={s.created_contacts} color="#25455D" />
        <StatCard label="Уже были (по tg_id)" value={s.matched_by_tg_id} color="#25455D" />
        <StatCard label="Объединили по email/телефону" value={s.merged_by_email_phone} color="#7c3aed" />
        <StatCard label="Подписано на канал" value={s.subscribed} color="#16a34a" />
        <StatCard label="Отписано от канала" value={s.unsubscribed} color="#9ca3af" />
        {s.tg_clash_skipped > 0 && (
          <StatCard label="Конфликт TG-identity" value={s.tg_clash_skipped} color="#dc2626" />
        )}
      </div>

      {hasIssues && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="font-semibold text-amber-900 text-sm mb-2 flex items-center gap-2">
            <AlertTriangle size={16} /> Есть нестыковки и пропуски
          </div>
          <ul className="text-sm text-amber-900 space-y-1">
            {s.skipped_no_tgid > 0 && <li>• Пропущено без telegram_id: <b>{s.skipped_no_tgid}</b></li>}
            {s.skipped_invalid_tgid > 0 && <li>• Пропущено с невалидным telegram_id: <b>{s.skipped_invalid_tgid}</b></li>}
            {s.duplicates_in_file > 0 && <li>• Дубликатов внутри файла: <b>{s.duplicates_in_file}</b></li>}
            {s.mismatches > 0 && <li>• Нестыковок (CSV ≠ БД, оставлено как в БД): <b>{s.mismatches}</b></li>}
            {s.tg_clash_skipped > 0 && <li>• Конфликт TG-identity (не привязали): <b>{s.tg_clash_skipped}</b></li>}
          </ul>
        </div>
      )}

      <button
        onClick={onDownloadReport}
        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 font-medium text-sm"
        style={{ color: '#25455D' }}
      >
        <Download size={15} /> Скачать полный отчёт (TXT)
      </button>

      <button
        onClick={onClose}
        className="w-full py-3 rounded-xl font-semibold text-sm text-white"
        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
      >Готово</button>
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-3 shadow-sm">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-2xl font-bold" style={{ color }}>{value.toLocaleString('ru')}</div>
    </div>
  )
}
