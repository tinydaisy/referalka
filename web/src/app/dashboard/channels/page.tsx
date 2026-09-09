'use client'
import { useState, useEffect, useRef, type ReactNode } from 'react'
import {
  Plus, Radio, Users, BellOff, Edit2, Trash2, X, Eye, EyeOff,
  Crown, Copy, ExternalLink, CheckCircle2, ArrowRight, Megaphone, AlertTriangle,
  Upload, Download, FileText, HelpCircle, Sparkles, Loader2, ChevronDown, Smartphone,
  RefreshCw,
} from 'lucide-react'
import { api } from '@/lib/api'
import BroadcastChatsTab from '@/components/channels/BroadcastChatsTab'
import AutoSetupTab from '@/components/channels/AutoSetupTab'
import QrLinkButton from '@/components/QrLinkButton'
import LockedOverlay from '@/components/LockedOverlay'

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
  subscribers: number       // получают ваши сообщения — база рассылки
  unsubscribed: number
  /** Подписчики САМОГО сообщества ВКонтакте (цифра от площадки).
   *  ⚠️ Не путать с `subscribers`: подписка на стену НЕ даёт права писать в
   *  личку. null — спросить у ВКонтакте не удалось, цифру не показываем. */
  community_members?: number | null
  created_at: string
  bot_token: string | null
}

/**
 * Публичная ссылка на бота по его handle — для QR-кода.
 *
 * ⚠️ У email-канала и у канала без handle ссылки нет: возвращаем null, и QR
 * не рисуется. WhatsApp тоже без handle — привязка там живёт на мосту.
 */
function botLinkOf(ch: Channel): string | null {
  const h = (ch.handle || '').trim().replace(/^@/, '')
  if (!h) return null
  if (h.startsWith('http://') || h.startsWith('https://')) return h
  switch (ch.platform_slug) {
    case 'telegram': return `https://telegram.me/${h}`
    case 'max':      return `https://max.ru/${h}`
    case 'vk':       return `https://vk.me/${h}`
    default:         return null
  }
}

interface Me {
  id: number
  features?: string[]
  is_system_service?: boolean
}

// Диагностика TG-бота: держит ли его сторонний сервис (webhook) вместо ПЛЮСОНа
interface BotHealth {
  channel_id: number
  handle: string
  is_active: boolean
  hijacked: boolean      // на боте стоит чужой webhook → у нас он молчит
  webhook_url: string
  webhook_host: string
  checked: boolean       // удалось ли спросить Telegram
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

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium -mb-px border-b-2 transition-colors ${
        active ? 'border-[#25455D] text-[#25455D]' : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >
      {children}
    </button>
  )
}

export default function ChannelsPage() {
  /**
   * Вкладка открывается и по адресу: `/dashboard/channels?tab=autosetup`.
   * На неё ведёт кнопка «Перейти к настройке» со страницы подписки — без
   * этого человек попадал на «Боты» и сам искал нужную вкладку.
   *
   * ⚠️ Читаем адрес НАПРЯМУЮ, а не хуком `useUrlTab`: внутри него
   * `useSearchParams`, а страница без динамического сегмента с ним обязана
   * быть завёрнута в <Suspense> — иначе падает сборка ВСЕГО проекта
   * («useSearchParams() should be wrapped in a suspense boundary»).
   * Здесь нужен разовый выбор вкладки при открытии, ради него городить
   * обёртку не стоит.
   */
  const [tab, setTabState] = useState<'bots' | 'chats' | 'autosetup'>(() => {
    if (typeof window === 'undefined') return 'bots'
    const v = new URLSearchParams(window.location.search).get('tab')
    return v === 'autosetup' || v === 'chats' ? v : 'bots'
  })

  /**
   * Переключение вкладки пишется в адрес — чтобы обновление страницы (F5)
   * оставляло человека на той же вкладке, а не сбрасывало на «Боты».
   *
   * ⚠️ `replaceState`, а не push: переключение вкладок не должно засорять
   * историю — иначе «Назад» будет ходить по вкладкам вместо возврата на
   * предыдущую страницу. Тот же приём, что в `useUrlTab`.
   */
  const setTab = (v: 'bots' | 'chats' | 'autosetup') => {
    setTabState(v)
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (v === 'bots') url.searchParams.delete('tab')
    else url.searchParams.set('tab', v)
    window.history.replaceState(window.history.state, '', url.toString())
  }
  const [me, setMe] = useState<Me | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Channel | null>(null)
  const [creating, setCreating] = useState(false)
  // С какой площадки открыть форму добавления. Пусто — обычное «Добавить канал»
  // (стартует с Telegram), задано — кнопка конкретной площадки.
  const [creatingPlatform, setCreatingPlatform] = useState<string | undefined>(undefined)
  const [vipWizardOpen, setVipWizardOpen] = useState(false)
  const [vkWizardOpen, setVkWizardOpen] = useState(false)
  const [maxWizardOpen, setMaxWizardOpen] = useState(false)
  const [deletingChannel, setDeletingChannel] = useState<Channel | null>(null)
  const [importingChannel, setImportingChannel] = useState<Channel | null>(null)
  // Кто держит TG-ботов: мы или сторонний сервис (webhook). channel_id → health
  const [health, setHealth] = useState<Record<number, BotHealth>>({})
  // Результат возврата из Facebook (подключение Instagram).
  //
  // ⚠️⚠️ Читается ЗДЕСЬ, на уровне страницы, а не внутри формы «Добавить
  // канал»: после возврата из Facebook форма закрыта, и её обработчик не
  // выполняется вовсе — человек попадал в пустой список каналов без единого
  // слова о том, получилось или нет. Поймано 2026-09-07.
  const [igResult, setIgResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [igPickKey, setIgPickKey] = useState<string | null>(null)

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
      // ⚠️ Instagram прячем без фичи `instagram_funnel` — иначе клиент выберет
      // площадку в списке и упрётся в 403 вместо объяснения. Фильтр стоит в
      // ОДНОЙ точке (при записи в состояние), поэтому форма подхватывает сама.
      const feats: string[] = meRes?.features || []
      setPlatforms(
        (pls.items || []).filter((p: Platform) =>
          p.slug !== 'instagram' || feats.includes('instagram_funnel'),
        ),
      )
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  // Разбираем возврат из Facebook. Адрес чистим сразу, чтобы обновление
  // страницы не показывало то же окно повторно.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const err = p.get('ig_error')
    const pick = p.get('ig_pick')
    if (err) setIgResult({ ok: false, text: err })
    if (pick) setIgPickKey(pick)
    if (err || pick) window.history.replaceState({}, '', window.location.pathname)
  }, [])

  // Спрашиваем Telegram, не перехватил ли ботов сторонний сервис. Отдельно от
  // load() — идёт в Telegram по сети, страницу ждать не заставляем.
  const loadHealth = async () => {
    try {
      const r: any = await api.channels.telegramHealth()
      const map: Record<number, BotHealth> = {}
      for (const it of (r?.items || [])) map[it.channel_id] = it
      setHealth(map)
    } catch { /* Telegram недоступен — просто не показываем диагностику */ }
  }

  useEffect(() => { load(); loadHealth() }, [])

  if (loading) {
    return <div className="p-6 text-gray-400 text-sm">Загрузка...</div>
  }

  const isVip = (me?.features || []).includes('channels')
  // Системный сервисный аккаунт ПЛЮСОНа (client 3): для него системный @pluson_bot
  // (и системные VK/MAX) — это фактически ЕГО собственные боты. Поэтому апсейл
  // «подключите свой бот» и красный баннер ему не показываем.
  const isSystemService = !!me?.is_system_service
  // Есть ли у клиента хоть один СВОЙ (не системный) бот/сообщество — TG/VK/MAX.
  // Без него сервис не работает: воронки, события, рассылки, чаты идут только
  // через бот клиента (системный @pluson_bot для клиентов больше не используется).
  // Для системного сервисного аккаунта системные каналы считаются «своими».
  const hasOwnBot = channels.some(c => !c.is_system) || (isSystemService && channels.some(c => c.is_system))

  // ⚠️ Боты есть, а главного нет — воронка не работает, и заметить это нечем:
  // рассылки уходят, бот в списке, а /start, регистрации и приветствия молчат.
  // Такое стало возможно с тех пор, как бот можно подключить «только для
  // рассылок» и снять роль главного у единственного.
  const hasPrimaryBot = channels.some(c => c.is_active && (!c.is_system || isSystemService))

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

      {!hasOwnBot && (
        <div className="mb-6 rounded-xl bg-red-600 text-white px-5 py-4 shadow-lg">
          <div className="text-lg font-bold">Подключите хотя бы 1 бот</div>
          <div className="text-sm text-white/90 mt-1">
            Подключите своего бота Telegram, сообщество ВКонтакте или бота MAX —
            чтобы сервис работал и вы могли пользоваться полным функционалом
            (воронки, события, рассылки, чаты).
          </div>
        </div>
      )}

      {hasOwnBot && !hasPrimaryBot && (
        <div className="mb-6 rounded-xl bg-red-600 text-white px-5 py-4 shadow-lg">
          <div className="text-lg font-bold">Ни один бот не отвечает за воронки</div>
          <div className="text-sm text-white/90 mt-1">
            Боты подключены — рассылки идут. Но пока ни один не отмечен главным,
            воронка не работает: на <b>/start</b> никто не отвечает, регистрации,
            приветствия и подарки не уходят.
          </div>
          <div className="text-sm text-white/90 mt-2">
            Выберите бот, который будет за это отвечать: нажмите на нём карандаш
            <Edit2 size={13} className="inline mx-1 align-[-1px]" />
            и отметьте <b>«Сделать главным»</b>.
          </div>
        </div>
      )}

      {/* Подвкладки: Боты / Чаты для рассылок / Автонастройка.
          ⚠️ «Автонастройка» СКРЫТА без фичи, а не показана с замком: услуга
          пока не продаётся клиентам, дразнить незачем (тот же приём, что у
          «Автообзвонов» в сайдбаре). */}
      <div className="flex gap-2 mb-6 border-b border-gray-200">
        <TabBtn active={tab === 'bots'} onClick={() => setTab('bots')}>Боты</TabBtn>
        <TabBtn active={tab === 'chats'} onClick={() => setTab('chats')}>Чаты для рассылок</TabBtn>
        {/* ⚠️ Вкладка видна ВСЕМ, а не только с фичей. Услуга открывается по
            коду доступа, и вводить его человеку негде, если вкладки нет вовсе.
            Внутри без доступа показывается описание услуги и поле для кода. */}
        <TabBtn active={tab === 'autosetup'} onClick={() => setTab('autosetup')}>
          Автонастройка
        </TabBtn>
      </div>


      {tab === 'bots' && (
        !isVip ? (
          <NonVipView
            channels={channels}
            onUpgrade={() => { window.location.href = '/dashboard/subscription' }}
          />
        ) : (
          <VipView
            channels={channels}
            platforms={platforms}
            isSystemService={isSystemService}
            health={health}
            onEdit={ch => setEditing(ch)}
            onCreate={() => setCreating(true)}
            onDelete={ch => setDeletingChannel(ch)}
            onOpenWizard={() => setVipWizardOpen(true)}
            onOpenVkWizard={() => setVkWizardOpen(true)}
            onOpenMaxWizard={() => setMaxWizardOpen(true)}
            hasInstagram={(me?.features || []).includes('instagram_funnel')}
            onOpenInstagram={() => { setCreatingPlatform('instagram'); setCreating(true) }}
            onImport={ch => setImportingChannel(ch)}
            onRestarted={loadHealth}
          />
        )
      )}

      {tab === 'chats' && <BroadcastChatsTab />}

      {tab === 'autosetup' && <AutoSetupTab />}

      {(creating || editing) && (
        <ChannelModal
          key={editing ? `edit-${editing.id}` : `create-${creatingPlatform || 'new'}`}
          channel={editing}
          platforms={platforms}
          initialPlatform={creatingPlatform}
          onClose={() => { setEditing(null); setCreating(false); setCreatingPlatform(undefined) }}
          onSaved={() => { setEditing(null); setCreating(false); setCreatingPlatform(undefined); load() }}
          onSwitchToVkWizard={() => { setEditing(null); setCreating(false); setCreatingPlatform(undefined); setVkWizardOpen(true) }}
        />
      )}

      {vipWizardOpen && (
        <VipBotWizard
          clientId={me!.id}
          hasOwnBot={channels.some(c => c.platform_slug === 'telegram' && !c.is_system)}
          onClose={() => setVipWizardOpen(false)}
          onDone={() => { setVipWizardOpen(false); load() }}
        />
      )}

      {vkWizardOpen && (
        <VipVkWizard
          clientId={me!.id}
          hasPrimary={channels.some(c => c.platform_slug === 'vk' && !c.is_system && c.is_active)}
          onClose={() => setVkWizardOpen(false)}
          onDone={() => { setVkWizardOpen(false); load() }}
        />
      )}

      {maxWizardOpen && (
        <VipMaxWizard
          clientId={me!.id}
          hasPrimary={channels.some(c => c.platform_slug === 'max' && !c.is_system && c.is_active)}
          onClose={() => setMaxWizardOpen(false)}
          onDone={() => { setMaxWizardOpen(false); load() }}
        />
      )}

      {deletingChannel && (
        <DeleteChannelModal
          channel={deletingChannel}
          onClose={() => setDeletingChannel(null)}
          onDone={() => { setDeletingChannel(null); load() }}
        />
      )}

      {/* Результат подключения Instagram — окном, а не молчаливым возвратом.
          ⚠️ Без него человек после Facebook попадал в список каналов, где
          ничего не появилось, и не понимал: не получилось или ещё грузится. */}
      {igResult && (
        <IgResultModal result={igResult} onClose={() => setIgResult(null)} />
      )}
      {igPickKey && (
        <IgPickModal
          pickKey={igPickKey}
          onClose={() => setIgPickKey(null)}
          onDone={() => { setIgPickKey(null); load() }}
          onError={(t) => { setIgPickKey(null); setIgResult({ ok: false, text: t }) }}
          onOk={(t) => { setIgPickKey(null); setIgResult({ ok: true, text: t }); load() }}
        />
      )}

      {importingChannel && (
        <ImportCsvModal
          channel={importingChannel}
          onClose={() => setImportingChannel(null)}
          onDone={() => { setImportingChannel(null); load() }}
        />
      )}

      {/* Юридическая сноска про Meta.
          ⚠️ Показывается ТОЛЬКО тем, у кого Instagram вообще доступен: у
          остальных площадка скрыта (см. фильтр по `instagram_funnel` выше), и
          сноска про непоказанную площадку читалась бы как случайный текст.
          ⚠️ Внизу и мелким шрифтом — это пометка, а не сообщение клиенту. */}
      {(me?.features || []).includes('instagram_funnel') && (
        <p className="mt-8 pt-4 border-t border-gray-100 text-[11px] leading-relaxed text-gray-400">
          Instagram принадлежит компании Meta, признанной экстремистской организацией
          и запрещённой на территории Российской Федерации.
        </p>
      )}
    </div>
  )
}

/* ─────── Не-VIP: read-only + апсейл ─────── */
function NonVipView({ channels, onUpgrade }: { channels: Channel[]; onUpgrade: () => void }) {
  // Не-VIP клиенту доступны общие системные каналы сервиса (TG / VK / MAX / Email).
  // Берём их из реального списка с бэка — НЕ хардкодим, чтобы фронт не расходился
  // с тем, что по API доступно клиенту. Редактировать/удалять их нельзя
  // (это видно по плашке «Системный» внутри ChannelCard).
  const systemChannels = channels.filter(c => c.is_system)

  // ⚠️⚠️ СВОИ БОТЫ ПОКАЗЫВАЕМ ВСЕГДА, даже когда тариф кончился (решение
  // владельца). Раньше они отфильтровывались вместе со всем не-системным, и
  // человек видел пустой раздел с рекламой «подключите бота» — при том, что
  // его боты подключены, настроены и в базе лежат с десятком тысяч
  // подписчиков. Это читается как «у меня всё удалили», а не как «тариф
  // истёк»: ровно так и вышло на кабинете Виктории.
  //
  // Показываем замыленными и некликабельными: видно, что всё живо, но
  // пользоваться нельзя, пока не продлена подписка.
  const ownChannels = channels.filter(c => !c.is_system)
  return (
    <div className="space-y-4">
      {systemChannels.length > 0 ? (
        systemChannels.map(ch => (
          <ChannelCard
            key={ch.id}
            channel={ch}
            onEdit={() => {}}
            onDelete={() => {}}
            onImport={() => {}}
          />
        ))
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 text-sm text-gray-500">
          Общие каналы сервиса пока не подключены к вашему кабинету.
        </div>
      )}

      {ownChannels.length > 0 && (
        <LockedOverlay
          title="Ваши боты подключены, но сейчас не работают"
          hint="Данные и подписчики на месте — ничего не удалено. Продлите подписку, и боты снова заработают."
        >
          <div className="space-y-4">
            {ownChannels.map(ch => (
              <ChannelCard
                key={ch.id}
                channel={ch}
                onEdit={() => {}}
                onDelete={() => {}}
                onImport={() => {}}
              />
            ))}
          </div>
        </LockedOverlay>
      )}

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
            <span>Тариф ПРОФИ</span>
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
            Перейти на ПРОФИ <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─────── Сворачиваемая группа каналов по площадке ─────── */
function PlatformGroup({ title, count, children, defaultOpen = true }: {
  title: string
  count: number
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      {/* Чёткая персиковая плашка-заголовок площадки */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 text-left px-4 py-3"
        style={{ background: '#FFF3E8' }}
      >
        <span className="text-sm font-bold uppercase tracking-wide" style={{ color: '#25455D' }}>
          {title}
        </span>
        <span
          className="text-[11px] font-bold px-2 py-0.5 rounded-full"
          style={{ background: '#FFCFA4', color: '#25455D' }}
        >
          {count}
        </span>
        <span className="flex-1" />
        <ChevronDown
          size={18}
          strokeWidth={2.5}
          className={`shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
          style={{ color: '#25455D' }}
        />
      </button>
      {open && <div className="p-3 space-y-3 bg-white">{children}</div>}
    </div>
  )
}

/* ─────── VIP: полный CRUD + кнопка wizard ─────── */
function VipView({ channels, platforms, isSystemService, health, onEdit, onCreate, onDelete, onOpenWizard, onOpenVkWizard, onOpenMaxWizard, hasInstagram, onOpenInstagram, onImport, onRestarted }: {
  channels: Channel[]
  platforms: Platform[]
  isSystemService?: boolean
  health: Record<number, BotHealth>
  onEdit: (ch: Channel) => void
  onCreate: () => void
  onDelete: (ch: Channel) => void
  onOpenWizard: () => void
  onOpenVkWizard: () => void
  onOpenMaxWizard: () => void
  /** Доступен ли Instagram этому клиенту (фича `instagram_funnel`). */
  hasInstagram: boolean
  onOpenInstagram: () => void
  onImport: (ch: Channel) => void
  onRestarted: () => void
}) {
  // Для системного сервисного аккаунта системные каналы = его собственные, поэтому
  // любой его канал (даже не помеченный is_active в client_channels, как MAX)
  // считается «главным» на площадке — карточка канала вместо апсейла «подключите бот».
  const isMainOnPlatform = (c: Channel) =>
    isSystemService ? true : (c.is_active && !c.is_system)
  const mainTgChannel = channels.find(c => c.platform_slug === 'telegram' && isMainOnPlatform(c))
  const mainVkChannel = channels.find(c => c.platform_slug === 'vk' && isMainOnPlatform(c))
  const mainMaxChannel = channels.find(c => c.platform_slug === 'max' && isMainOnPlatform(c))

  const card = (ch: Channel) => (
    <ChannelCard
      key={ch.id}
      channel={ch}
      health={health[ch.id]}
      onEdit={() => onEdit(ch)}
      onDelete={() => onDelete(ch)}
      onImport={() => onImport(ch)}
      onRestarted={onRestarted}
    />
  )

  // Доп. каналы каждой площадки (кроме главного, у которого своя карточка выше)
  const tgRest = channels.filter(c => c.platform_slug === 'telegram' && c !== mainTgChannel)
  const vkRest = channels.filter(c => c.platform_slug === 'vk' && c !== mainVkChannel)
  const maxRest = channels.filter(c => c.platform_slug === 'max' && c !== mainMaxChannel)
  // ⚠️ Instagram — СВОЯ секция (как у TG/VK/MAX), а не «Другие»: иначе о нём
  // можно было узнать, только нажав «Добавить канал» и найдя его в списке
  // площадок. Подключённые аккаунты показываем в ней же, поэтому из «Других»
  // Instagram исключён — иначе показался бы дважды.
  const igChannels = channels.filter(c => c.platform_slug === 'instagram')
  // Прочие площадки (email и любые будущие) — в отдельную группу «Другие»
  const otherChannels = channels.filter(
    c => !['telegram', 'vk', 'max', 'instagram'].includes(c.platform_slug),
  )
  // Заголовки групп с человекочитаемыми названиями площадок
  const platformTitle = (slug: string) =>
    platforms.find(p => p.slug === slug)?.display_name ||
    ({ telegram: 'Telegram', vk: 'ВКонтакте', max: 'MAX', email: 'Email' }[slug] || slug)

  // Группируем «Другие» по площадкам
  const otherBySlug = otherChannels.reduce<Record<string, Channel[]>>((acc, c) => {
    (acc[c.platform_slug] ||= []).push(c)
    return acc
  }, {})

  const tgCount = (mainTgChannel ? 1 : 0) + tgRest.length
  const vkCount = (mainVkChannel ? 1 : 0) + vkRest.length
  const maxCount = (mainMaxChannel ? 1 : 0) + maxRest.length

  return (
    <div className="space-y-6">
      <PlatformGroup title="Telegram" count={tgCount}>
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
          card(mainTgChannel)
        )}
        {tgRest.map(card)}
      </PlatformGroup>

      <PlatformGroup title="ВКонтакте" count={vkCount}>
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
            {card(mainVkChannel)}
            <VkVideoTokenBlock channel={mainVkChannel} />
          </>
        )}
        {vkRest.map(card)}
      </PlatformGroup>

      <PlatformGroup title="MAX" count={maxCount}>
        {!mainMaxChannel ? (
          <ConnectInvite
            title="Подключите свой MAX-бот"
            description="Создайте бота в @MasterBot на платформе MAX, вставьте токен — мы проверим его и зарегистрируем webhook. Бот начнёт принимать сообщения и слать ваши рассылки от вашего имени."
            buttonText="Запустить мастер MAX"
            badge="MX"
            badgeColor="#5B2FC0"
            onClick={onOpenMaxWizard}
          />
        ) : (
          card(mainMaxChannel)
        )}
        {maxRest.map(card)}
      </PlatformGroup>

      {/* ⚠️ Секция Instagram показывается ТОЛЬКО с фичей `instagram_funnel` —
          так же, как площадка скрыта из списка «Добавить канал». Дразнить тех,
          кому он не продаётся, незачем. */}
      {hasInstagram && (
        <PlatformGroup title="Instagram" count={igChannels.length}>
          {igChannels.length === 0 ? (
            <ConnectInvite
              title="Подключите свой Instagram"
              description="Вход через Facebook — токен выдаёт сама Meta, пароль вводить не нужно. Дальше бот отвечает на комментарии под рилсами кодовым словом и присылает человеку лид-магнит в директ."
              buttonText="Подключить Instagram"
              badge="IG"
              badgeColor="#C13584"
              onClick={onOpenInstagram}
            />
          ) : (
            igChannels.map(card)
          )}
        </PlatformGroup>
      )}

      {Object.entries(otherBySlug).map(([slug, chs]) => (
        <PlatformGroup key={slug} title={platformTitle(slug)} count={chs.length}>
          {chs.map(card)}
        </PlatformGroup>
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

function ChannelCard({ channel: ch, health, onEdit, onDelete, onImport, onRestarted }: {
  channel: Channel
  health?: BotHealth
  onEdit: () => void
  onDelete: () => void
  onImport: () => void
  onRestarted?: () => void
}) {
  const isTelegram = ch.platform_slug === 'telegram'
  const isSystem = !!ch.is_system
  const [restarting, setRestarting] = useState(false)

  // Бота перехватил сторонний сервис (webhook). Красным подсвечиваем только
  // ГЛАВНЫЙ бот воронки (is_active) — именно через него идут /start, воронки и
  // регистрации. Доп. боты (только рассылки) от webhook не страдают: рассылки
  // шлются через sendMessage, а он работает и при чужом webhook.
  const hijacked = !!health?.hijacked
  const critical = hijacked && ch.is_active

  // Бот молчит, хотя токен верный? Значит его перехватил сторонний конструктор
  // (LeadConverter, Salebot, BotHelp…): он прописал себя webhook'ом, а Telegram
  // отдаёт сообщения только одному получателю. Снимаем webhook — бот снова наш.
  const restart = async () => {
    if (restarting) return
    if (!confirm(
      'Перезапустить бота?\n\n' +
      'Заберём управление ботом в ПЛЮСОН: если его перехватил другой сервис ' +
      '(LeadConverter, Salebot, BotHelp и т.п.) — бот перестанет работать там ' +
      'и снова начнёт отвечать здесь.'
    )) return
    setRestarting(true)
    try {
      const r: any = await api.channels.restartPolling(ch.id)
      if (r?.had_webhook) {
        let host = ''
        try { host = new URL(r.webhook_url).hostname } catch { host = r.webhook_url }
        alert(
          `Готово — бот снова работает в ПЛЮСОНе.\n\n` +
          `Его перехватывал сторонний сервис: ${host}\n\n` +
          `Важно: если бот всё ещё подключён в том сервисе, он может перехватить его снова. ` +
          `Отключите бота там, чтобы этого не повторилось.`
        )
      } else {
        alert('Готово — бот перезапущен. Сторонних сервисов на нём не было.')
      }
      onRestarted?.()
    } catch (e: any) {
      alert(e?.message || 'Не удалось перезапустить бота')
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div className="space-y-0">
    {/* ⚠️ На узком экране карточка разворачивается в КОЛОНКУ (flex-col →
        sm:flex-row). Раньше всё жило одной строкой, и на телефоне бейдж
        «Воронка событий» наезжал на счётчики подписчиков и на кнопки —
        читать было нельзя. Ширину держит min-w-0 у каждой колонки: без него
        flex не даёт тексту сжиматься, и он выталкивает соседей за край. */}
    <div className={`bg-white rounded-2xl border shadow-sm p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 ${
      critical ? 'border-red-300 bg-red-50/40'
        : isSystem ? 'border-amber-100 bg-gradient-to-r from-amber-50/40 to-white'
        : 'border-gray-100'
    }`}>
      <div className="flex items-start gap-3 min-w-0 flex-1">
      <PlatformBadge slug={ch.platform_slug} color={ch.platform_color_hex} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          {/* break-words вместо truncate: на телефоне длинное имя бота
              переносится, а не режется многоточием. */}
          <h3 className="font-semibold text-gray-900 break-words min-w-0">{ch.display_name}</h3>
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
          {critical && (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold bg-red-100 text-red-700"
              title="Бота перехватил сторонний сервис — в ПЛЮСОНе он не отвечает"
            >
              <AlertTriangle size={10} /> Бот не отвечает
            </span>
          )}
        </div>
        <p className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
          <span className="break-all">
            {ch.platform_display_name}
            {ch.handle && <span className="ml-2 font-mono">{ch.handle}</span>}
          </span>
          {/* QR на бота — чтобы показать с экрана или поставить на афишу.
              У email-канала ссылки нет, там QR не рисуем. */}
          {botLinkOf(ch) && (
            <QrLinkButton
              url={botLinkOf(ch)!}
              name={ch.display_name || ch.handle || 'Бот'}
              iconSize={13}
            />
          )}
        </p>
      </div>
      </div>
      {/* Счётчики и кнопки: на телефоне — своей строкой под названием,
          на компьютере — справа в ряд, как было. */}
      <div className="flex items-center justify-between gap-3 sm:gap-4 shrink-0">
      <div className="flex items-center gap-4 text-sm shrink-0">
        {/* ⚠️ Подписчики СООБЩЕСТВА ВК — отдельная цифра, и стоит она ПЕРВОЙ,
            потому что клиент ищет глазами именно её («у меня 184 подписчика»).
            Это НЕ база рассылки: подписка на стену не даёт права писать в
            личку. У Марго 184 в сообществе против 52 получающих сообщения —
            без этой цифры кажется, что рассылка уходит всем подписчикам.
            null = спросить у ВКонтакте не удалось → не рисуем вовсе, выдумывать
            число нельзя. */}
        {typeof ch.community_members === 'number' && (
          <div
            className="flex items-center gap-1.5 text-blue-500"
            title={ch.platform_slug === 'instagram'
              ? 'Подписаны на ваш аккаунт Instagram. Рассылку им слать нельзя: Instagram разрешает писать человеку только 24 часа после его сообщения.'
              : 'Подписаны на сообщество ВКонтакте. Это НЕ база рассылки: чтобы получать ваши сообщения, человек отдельно нажимает «Разрешить сообщения».'}
          >
            <Megaphone size={14} />
            <span>{ch.community_members.toLocaleString('ru')}</span>
          </div>
        )}
        {/* ⚠️⚠️ У Instagram эти два счётчика НЕ показываем вовсе.
            «Получают сообщения» и «отписавшиеся» считают базу рассылки, а
            рассылок в Instagram нет: Meta разрешает писать только 24 часа
            после сообщения человека. Там всегда стоял ноль — и клиент читал
            это как «ничего не работает», хотя у аккаунта 716 подписчиков.
            Показывать заведомый ноль хуже, чем не показывать ничего. */}
        {ch.platform_slug !== 'instagram' && (
          <>
            <div className="flex items-center gap-1.5 text-green-600" title="Получают ваши сообщения — это и есть база рассылки">
              <Users size={14} />
              <span>{ch.subscribers.toLocaleString('ru')}</span>
            </div>
            <div className="flex items-center gap-1.5 text-red-400" title="Отписавшиеся (ваши)">
              <BellOff size={14} />
              <span>{ch.unsubscribed.toLocaleString('ru')}</span>
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-1 sm:gap-2 shrink-0">
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
                onClick={restart}
                disabled={restarting}
                className={`p-2 rounded-lg disabled:opacity-50 ${
                  critical
                    ? 'bg-red-100 text-red-600 hover:bg-red-200'
                    : 'hover:bg-blue-50 text-gray-500 hover:text-blue-600'
                }`}
                title="Бот не отвечает? Перезапустить и забрать управление в ПЛЮСОН"
              >{restarting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}</button>
            )}
            {/* ⚠️ Импорт открыт для ВСЕХ площадок, а не только Telegram:
                механизм общий, отличается лишь имя колонки с идентификатором
                (telegram_id / vk_id / max_id — или просто «id»). */}
            {(
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
    </div>

    {critical && (
      <div className="mt-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold">Бот не работает в ПЛЮСОНе — им управляет другой сервис</p>
            <p className="text-red-700">
              Через этот бот идёт воронка событий (/start, регистрации, лид-магниты), но
              Telegram сейчас отдаёт все сообщения сюда:{' '}
              <span className="font-mono font-semibold">{health?.webhook_host || 'сторонний сервис'}</span>.
              Так бывает, если бота подключали в другом конструкторе (LeadConverter, Salebot, BotHelp).
            </p>
            <button
              onClick={restart}
              disabled={restarting}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            >
              {restarting ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Забрать бота в ПЛЮСОН
            </button>
          </div>
        </div>
      </div>
    )}
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
/** Выбор роли подключаемого канала — ОДИН на все площадки (TG, VK, MAX).
 *
 * ⚠️ Роль выбирается ДО подключения. Раньше канал безусловно становился
 * главным, и клиент, добавлявший его ради рассылок, молча терял работающую
 * воронку на прежнем.
 *
 * ⚠️ Слово «главный» — то же, что в форме канала и в плашках. «Основной» было
 * расхождением с интерфейсом.
 *
 * ⚠️ Сам выбор — нейтральными карточками, это ШАГ, а не предупреждение.
 * Красным — только предупреждение про чужие сервисы: в мягких тонах его не
 * читают, а не прочитать значит получить канал с неработающими воронками.
 */
function PrimaryRoleStep({ value, onChange, what, warnOtherServices }: {
  value: boolean
  onChange: (v: boolean) => void
  what: string                 // «этот бот» / «это сообщество»
  warnOtherServices?: string   // чем грозит чужой сервис; нет — блок не рисуем
}) {
  return (
    <>
      <h3 className="font-semibold text-gray-900">Шаг 1. Кем будет {what}</h3>

      <label className="block rounded-xl border-2 p-3 cursor-pointer transition"
             style={value
               ? { borderColor: '#25455D', background: 'rgba(37,69,93,0.04)' }
               : { borderColor: '#e5e7eb' }}>
        <div className="flex gap-2.5">
          <input type="radio" checked={value} onChange={() => onChange(true)} className="mt-1" />
          <div>
            <div className="text-sm font-bold" style={{ color: '#25455D' }}>
              Главный — воронки и рассылки
            </div>
            {/* ⚠️ Прямо сказано, что рассылки ТОЖЕ его: иначе читается как
                выбор «или воронки, или рассылки», и человек не понимает, что
                выбрать, если нужно и то и другое. */}
            <p className="text-sm text-gray-600 mt-0.5 leading-snug">
              Делает всё: /start, регистрации, приветствия, подарки, Mini App —
              и рассылки тоже. Такой канал на площадке один.
            </p>
          </div>
        </div>
      </label>

      <label className="block rounded-xl border-2 p-3 cursor-pointer transition"
             style={!value
               ? { borderColor: '#25455D', background: 'rgba(37,69,93,0.04)' }
               : { borderColor: '#e5e7eb' }}>
        <div className="flex gap-2.5">
          <input type="radio" checked={!value} onChange={() => onChange(false)} className="mt-1" />
          <div>
            <div className="text-sm font-bold" style={{ color: '#25455D' }}>
              Только рассылки
            </div>
            <p className="text-sm text-gray-600 mt-0.5 leading-snug">
              Импорт базы и отправка сообщений. Воронка останется на том канале,
              который уже главный.
            </p>
          </div>
        </div>
      </label>

      {value && warnOtherServices && (
        <div className="rounded-xl border-2 border-red-300 bg-red-50 p-3">
          <div className="text-sm font-bold text-red-800">
            Главный канал не должен быть подключён к другим сервисам
          </div>
          <p className="text-sm text-red-900 mt-1 leading-snug">{warnOtherServices}</p>
          <p className="text-sm text-red-900 mt-1.5 leading-snug">
            Возьмите <b>новый</b> — или отвяжите старый от других сервисов.
          </p>
        </div>
      )}
    </>
  )
}

function VipVkWizard({ clientId, hasPrimary, onClose, onDone }: {
  clientId: number
  hasPrimary?: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  // ⚠️ Если главный на площадке УЖЕ ЕСТЬ — по умолчанию «только рассылки»:
  // иначе новый канал молча забрал бы воронку у работающего.
  const [makePrimary, setMakePrimary] = useState(!hasPrimary)
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
              make_primary: makePrimary,
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
              <PrimaryRoleStep
                value={makePrimary} onChange={setMakePrimary} what="это сообщество"
                warnOtherServices="ВКонтакте отдаёт сообщения только одному получателю. Если сообщество уже подключено к другому сервису — тот перехватит управление, и наши воронки работать не будут."
              />

              <h3 className="font-semibold text-gray-900 pt-1">Шаг 2. Создайте сообщество и Mini App</h3>
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
              <h3 className="font-semibold text-gray-900">Шаг 3. Вставьте параметры</h3>
              <p className="text-sm text-gray-600">
                Мы проверим токен через VK API, получим название сообщества и включим Long Poll
                автоматически.
              </p>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Access Token сообщества <span className="text-red-500">*</span></label>
                <div className="relative">
                  <input
                    type="text"
                    value={form.access_token}
                    onChange={e => setForm(f => ({ ...f, access_token: e.target.value }))}
                    className="w-full px-3 py-2.5 pr-10 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
                    style={showToken ? undefined : { WebkitTextSecurity: 'disc' } as React.CSSProperties}
                    placeholder="vk1.a.zZJ..."
                    disabled={submitting}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    name="vk_access_token_field"
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
                /* ⚠️ Красный — только для настоящих ошибок. Повтор части во
                   время загрузки идёт синим (это ход работы), а приостановка —
                   янтарным: данные целы, нужно лишь нажать ещё раз. Красная
                   плашка на каждый разрыв читается как «платформа не работает». */
                <div className={`border text-sm rounded-xl p-3 ${
                  submitting
                    ? 'bg-blue-50 border-blue-100 text-blue-800'
                    : error.startsWith('Загрузка приостановлена')
                      ? 'bg-amber-50 border-amber-200 text-amber-900'
                      : 'bg-red-50 border-red-100 text-red-700'
                }`}>
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

/* ─────── VIP-wizard MAX: подключение своего MAX-бота ─────── */
function VipMaxWizard({ clientId, hasPrimary, onClose, onDone }: {
  clientId: number
  hasPrimary?: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  // ⚠️ Если главный на площадке УЖЕ ЕСТЬ — по умолчанию «только рассылки»:
  // иначе новый канал молча забрал бы воронку у работающего.
  const [makePrimary, setMakePrimary] = useState(!hasPrimary)
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ bot_username: string; bot_name: string; bot_handle: string } | null>(null)

  async function submitToken() {
    setError('')
    setSubmitting(true)
    try {
      const r = await api.channels.connectMaxBot(token.trim(), makePrimary)
      setResult({ bot_username: r.bot_username, bot_name: r.bot_name, bot_handle: r.bot_handle })
      setStep(3)
    } catch (e: any) {
      setError(e.message || 'Не удалось подключить бот')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Crown size={18} style={{ color: '#FFCFA4' }} />
            Подключение своего MAX-бота
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
              <PrimaryRoleStep
                value={makePrimary} onChange={setMakePrimary} what="этот бот"
                warnOtherServices="MAX отдаёт сообщения только одному получателю. Если бот уже подключён к другому сервису — тот перехватит управление, и наши воронки работать не будут."
              />

              <h3 className="font-semibold text-gray-900 pt-1">Шаг 2. Создайте бота в @MasterBot</h3>
              <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5">
                <li>Откройте в MAX бота <b>@MasterBot</b> (официальный бот для создания ботов)</li>
                <li>Отправьте команду <code className="bg-gray-100 px-1.5 py-0.5 rounded font-mono text-xs">/newbot</code></li>
                <li>Придумайте имя и адрес (username) бота</li>
                <li>@MasterBot пришлёт <b>токен</b> — скопируйте его</li>
              </ol>
              <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-xs text-blue-900">
                💡 Если бот уже есть — пропустите этот шаг. Токен можно получить заново через @MasterBot → <code className="bg-blue-100 px-1 rounded">/mybots</code> → выбрать бота → «Токен».
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
              <h3 className="font-semibold text-gray-900">Шаг 3. Вставьте токен</h3>
              <p className="text-sm text-gray-600">
                Мы проверим токен через MAX, сохраним его и зарегистрируем webhook —
                после этого бот начнёт принимать сообщения и слать ваши рассылки.
              </p>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Токен MAX-бота</label>
                <div className="relative">
                  <input
                    type="text"
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    className="w-full px-3 py-2.5 pr-10 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
                    style={showToken ? undefined : { WebkitTextSecurity: 'disc' } as React.CSSProperties}
                    placeholder="вставьте токен из @MasterBot"
                    disabled={submitting}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    name="max_bot_token_field"
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
                  <p className="font-semibold text-green-900">Бот {result.bot_name} (@{result.bot_username}) подключён</p>
                  <p className="text-sm text-green-800 mt-0.5">
                    Webhook зарегистрирован — бот уже принимает сообщения подписчиков
                    и готов слать ваши рассылки в MAX.
                  </p>
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900">
                💡 Ссылки на бот в MAX выглядят как <code className="bg-blue-100 px-1 rounded">{result.bot_handle}</code>.
                В рассылках и реф-ссылках MAX подставляется автоматически.
              </div>

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
function VipBotWizard({ clientId, hasOwnBot, onClose, onDone }: {
  clientId: number
  hasOwnBot?: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ bot_username: string; mini_app_url: string } | null>(null)
  // ⚠️ Второй и последующий бот по умолчанию НЕ главный. Раньше каждый новый
  // безусловно забирал эту роль: клиент подключал бота ради рассылок, а у него
  // молча переезжали воронки и регистрации на свежий бот, где ничего не настроено.
  const [makePrimary, setMakePrimary] = useState(!hasOwnBot)

  async function submitToken() {
    setError('')
    setSubmitting(true)
    try {
      const r = await api.channels.connectTelegramBot(token.trim(), makePrimary)
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
              <PrimaryRoleStep
                value={makePrimary} onChange={setMakePrimary} what="этот бот"
                warnOtherServices="Telegram отдаёт сообщения только одному получателю. Если бот уже работает в BotHelp, Salebot или похожем сервисе — тот перехватит управление, и наши воронки работать не будут."
              />

              <h3 className="font-semibold text-gray-900 pt-1">Шаг 2. Создайте бота в @BotFather</h3>
              <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5">
                <li>Откройте <a href="https://telegram.me/BotFather" target="_blank" rel="noopener" className="font-medium" style={{ color: '#25455D' }}>@BotFather</a> в Telegram</li>
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
              <h3 className="font-semibold text-gray-900">Шаг 3. Вставьте токен</h3>
              <p className="text-sm text-gray-600">
                Мы проверим токен через Telegram, сохраним его и автоматически настроим Mini App
                в вашем боте.
              </p>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Bot Token</label>
                <div className="relative">
                  <input
                    type="text"
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    className="w-full px-3 py-2.5 pr-10 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
                    style={showToken ? undefined : { WebkitTextSecurity: 'disc' } as React.CSSProperties}
                    placeholder="123456:ABC-DEF1234..."
                    disabled={submitting}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    name="bot_token_field"
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

              <h3 className="font-semibold text-gray-900">Шаг 4. Настройте Main Mini App в @BotFather</h3>
              <p className="text-sm text-gray-600">
                Это <b>главное приложение бота</b> — открывается одной кнопкой в чате,
                ссылки получаются короткие <code className="bg-gray-100 px-1 rounded text-xs">t.me/{result.bot_username}?startapp=…</code>.
                Telegram не даёт настроить это через API — придётся пройти через @BotFather.
              </p>

              <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5">
                <li>Откройте <a href="https://telegram.me/BotFather" target="_blank" rel="noopener" className="font-medium" style={{ color: '#25455D' }}>@BotFather</a></li>
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
                href={`https://telegram.me/${result.bot_username}`}
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
function ChannelModal({ channel, platforms, onClose, onSaved, onSwitchToVkWizard, initialPlatform }: {
  channel: Channel | null
  platforms: Platform[]
  onClose: () => void
  onSaved: () => void
  onSwitchToVkWizard?: () => void
  /** С какой площадки открыть форму. Нужен кнопкам площадок: человек нажал
   *  «Подключить Instagram» — форма обязана открыться сразу на ней, а не на
   *  Telegram, который пришлось бы менять в списке. */
  initialPlatform?: string
}) {
  const [platformSlug, setPlatformSlug] = useState(channel?.platform_slug || initialPlatform || 'telegram')
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

          {/* WhatsApp — привязка по QR прямо в форме (нет токена/handle). */}
          {!channel && platformSlug === 'whatsapp' ? (
            <WhatsAppConnectInline onClose={onClose} />
          ) : /* Instagram — вход через Facebook, токен выдаёт Meta.
                 Ни токена, ни handle руками не вводят: обычная форма не подходит. */
          !channel && platformSlug === 'instagram' ? (
            <InstagramConnectInline />
          ) : /* VK подключается отдельным мастером — у обычной формы нет нужных полей
              (Access Token, App ID, Secure Key, ID сообщества). Перебрасываем туда. */
          !channel && platformSlug === 'vk' ? (
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
          {!channel && (platformSlug === 'vk' || platformSlug === 'whatsapp' || platformSlug === 'instagram') ? null : !channel ? (
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
          ) : channel.is_active && !isActive ? (
            // Главный в базе, но в этой сессии сняли роль — ждёт сохранения.
            // ⚠️ Пока главного нет ни у одного канала, воронка на площадке не
            // работает: /start, регистрации и приветствия отвечать некому.
            // Говорим об этом прямо, чтобы клиент не искал потом причину молча
            // переставшего работать бота.
            <div className="p-3 rounded-xl border border-amber-300 bg-amber-50">
              <div className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                <Megaphone size={14} className="text-gray-500" />
                Станет дополнительным после «Сохранить»
              </div>
              <p className="text-xs text-amber-800 mt-1 leading-snug mb-2">
                Рассылки и импорт базы продолжат работать. Но если это ваш
                единственный бот на площадке — воронка событий отвечать перестанет:
                /start, регистрации и приветствия идут только через главный канал.
              </p>
              <button
                type="button"
                onClick={() => setIsActive(true)}
                className="text-xs font-medium text-amber-900 underline"
              >
                Отменить — оставить главным
              </button>
            </div>
          ) : (
            /* ⚠️ Тот же выбор, что при подключении: две радиокнопки, а не
               мелкая ссылка внизу плашки. Раньше «сделать дополнительным» была
               подчёркнутой строчкой, которую надо было разглядывать под лупой —
               клиент её просто не видел и считал, что переключить нельзя.
               ⚠️ Двух главных не бывает: выбрал этот — прежний автоматически
               становится дополнительным (это делает бэкенд одной транзакцией). */
            <div className="space-y-2">
              <label className="block rounded-xl border-2 p-3 cursor-pointer transition"
                     style={isActive
                       ? { borderColor: '#25455D', background: 'rgba(37,69,93,0.04)' }
                       : { borderColor: '#e5e7eb' }}>
                <div className="flex gap-2.5">
                  <input type="radio" checked={isActive} onChange={() => setIsActive(true)} className="mt-1" />
                  <div>
                    <div className="text-sm font-bold flex items-center gap-1.5" style={{ color: '#25455D' }}>
                      <Crown size={14} style={{ color: '#FFCFA4' }} />
                      Главный — воронки и рассылки
                    </div>
                    <p className="text-sm text-gray-600 mt-0.5 leading-snug">
                      /start, регистрации, приветствия, подарки, Mini App — и рассылки тоже.
                      Такой канал на площадке один: прежний главный станет дополнительным.
                    </p>
                  </div>
                </div>
              </label>

              <label className="block rounded-xl border-2 p-3 cursor-pointer transition"
                     style={!isActive
                       ? { borderColor: '#25455D', background: 'rgba(37,69,93,0.04)' }
                       : { borderColor: '#e5e7eb' }}>
                <div className="flex gap-2.5">
                  <input type="radio" checked={!isActive} onChange={() => setIsActive(false)} className="mt-1" />
                  <div>
                    <div className="text-sm font-bold flex items-center gap-1.5" style={{ color: '#25455D' }}>
                      <Megaphone size={14} className="text-gray-400" />
                      Только рассылки
                    </div>
                    <p className="text-sm text-gray-600 mt-0.5 leading-snug">
                      Импорт базы и отправка сообщений. Воронка останется на том канале,
                      который главный.
                    </p>
                  </div>
                </div>
              </label>

              {channel.is_active && !isActive && (
                <p className="text-sm text-amber-800 leading-snug px-1">
                  ⚠️ Если это ваш единственный канал на площадке — воронка отвечать
                  перестанет: на /start, регистрации и приветствия будет некому ответить.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">
            {(!channel && (platformSlug === 'vk' || platformSlug === 'whatsapp' || platformSlug === 'instagram')) ? 'Закрыть' : 'Отмена'}
          </button>
          {!(!channel && (platformSlug === 'vk' || platformSlug === 'whatsapp' || platformSlug === 'instagram')) && (
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
  const [deactivating, setDeactivating] = useState(false)
  const [error, setError] = useState('')
  // Второе предупреждение: при наличии подписчиков реально удаляем только
  // после второго нажатия (первое — показ красного «точно?»).
  const [secondConfirm, setSecondConfirm] = useState(false)
  const hasSubscribers = channel.subscribers > 0
  const canDelete = confirmText === 'ПОДТВЕРДИТЬ'
  const busy = submitting || deactivating

  async function doDelete() {
    if (!canDelete) return
    // Если есть подписчики и второе подтверждение ещё не показано — показываем
    // его и ждём повторного клика. Реально удаляем только на втором нажатии.
    if (hasSubscribers && !secondConfirm) {
      setSecondConfirm(true)
      setError('')
      return
    }
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

  // Деактивировать = сделать канал неактивным (база сохраняется, рассылки работают,
  // но событийный флоу/воронка через него не идёт). Альтернатива удалению.
  async function doDeactivate() {
    setError('')
    setDeactivating(true)
    try {
      await api.channels.update(channel.id, { is_active: false } as any)
      onDone()
    } catch (e: any) {
      setError(e?.message || 'Не удалось деактивировать канал')
    } finally {
      setDeactivating(false)
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
              нажмите <b>«Сделать неактивным»</b> ниже (рассылки по нему всё равно можно будет делать).
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

          {secondConfirm && (
            <div className="rounded-xl border-2 border-red-400 bg-red-100 p-3 text-sm text-red-900 font-medium">
              ⚠️ У канала <b>{channel.subscribers.toLocaleString('ru')}</b> подписчик(ов). База будет
              стёрта безвозвратно. Если точно нужно — нажмите ещё раз
              «<b>Да, всё равно удалить</b>». Чтобы сохранить базу — нажмите «Сделать неактивным».
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-3">
              {error}
            </div>
          )}
        </div>

        <div className="flex flex-nowrap items-center justify-end gap-2 p-5 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 whitespace-nowrap"
            disabled={busy}
          >
            Отмена
          </button>
          {channel.is_active && (
            <button
              onClick={doDeactivate}
              disabled={busy}
              className="px-4 py-2 text-sm rounded-lg font-medium text-white whitespace-nowrap disabled:opacity-40"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
            >
              {deactivating ? 'Деактивируем…' : 'Сделать неактивным'}
            </button>
          )}
          <button
            onClick={doDelete}
            disabled={!canDelete || busy}
            className="px-4 py-2 text-sm rounded-lg text-white font-medium whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed bg-red-600 hover:bg-red-700"
          >
            {submitting
              ? 'Удаляем…'
              : secondConfirm
                ? 'Да, всё равно удалить'
                : 'ОК, удалить навсегда'}
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

// ⚠️ Колонка идентификатора зависит от площадки канала: механизм импорта
// общий, а имя колонки своё. Понимается и просто «id» — человек выгружает
// базу из чужого сервиса и не должен переименовывать заголовок под нас.
const ID_COLUMN: Record<string, string> = {
  telegram: 'telegram_id', vk: 'vk_id', max: 'max_id',
}

// Как называть площадку и ник в текстах ДЛЯ КЛИЕНТА. «telegram_id» и
// «никнейм» он видит в шапке файла, а на экране должен читать человеческие
// слова — и уж точно не слово «Telegram», когда грузит базу ВКонтакте.
//
// ⚠️ `unit` — как называть саму точку доставки. Слово «канал» пришло из БД
// (там боты, сообщества и почта лежат в одной таблице `channels`) и вылезло
// на экран как есть: клиент читал «подписано на канал» и не понимал, речь про
// бот, куда он грузит базу, или про его личный Telegram-канал. Пишем «бот» /
// «сообщество» и рядом название — тогда двусмысленности нет.
const PLATFORM_WORDS: Record<string, { title: string; nick: string; unit: string }> = {
  telegram: { title: 'Telegram',   nick: 'ников',             unit: 'бот' },
  vk:       { title: 'ВКонтакте',  nick: 'коротких адресов',  unit: 'сообщество' },
  max:      { title: 'MAX',        nick: 'ников',             unit: 'бот' },
}

function csvTemplate(idCol: string) {
  // Колонка ника есть только у Telegram: у ВКонтакте и MAX мы его не спрашиваем.
  const nick = idCol === 'telegram_id' ? 'telegram_username,' : ''
  const ex = (n: string) => nick ? `${n},` : ''
  return `${idCol},name,${nick}email,phone,subscribed
123456789,Иван Петров,${ex('ivan_p')}ivan@mail.ru,+79991234567,1
987654321,Мария Сидорова,${ex('')}maria@mail.ru,89998887766,1
555444333,Пётр,${ex('petr_x')},,0
`
}

function ImportCsvModal({ channel, onClose, onDone }: {
  channel: Channel
  onClose: () => void
  onDone: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Прогресс импорта: процент, секунды и число строк — чтобы человек видел
  // объём работы и что она идёт, а не гадал, живой ли процесс.
  const [progress, setProgress] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [rowCount, setRowCount] = useState<number | null>(null)
  // Имя колонки с идентификатором — по площадке канала.
  const idCol = ID_COLUMN[channel.platform_slug] || 'id'
  // Сколько строк УЖЕ обработано — это и показываем в кнопке.
  const [doneRows, setDoneRows] = useState(0)
  // В файле нет колонки с ником → импорт будет спрашивать ники у Telegram
  // по каждому id, и это ощутимо дольше. Предупреждаем заранее.
  const [needsUsernameLookup, setNeedsUsernameLookup] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  // Остановка между частями: рвать импорт закрытием вкладки — плохой способ,
  // а другого до этого не было (кнопка «Отмена» блокировалась на время работы).
  const cancelRef = useRef(false)

  // Пока идёт загрузка — браузер переспросит при попытке закрыть вкладку.
  // Цикл по частям крутится здесь, в браузере: закрыли страницу — оставшиеся
  // части не уйдут, и человек об этом не узнает.
  useEffect(() => {
    if (!submitting) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [submitting])

  function downloadTemplate() {
    const blob = new Blob([csvTemplate(idCol)], { type: 'text/csv;charset=utf-8' })
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

  // Грузим файл ЧАСТЯМИ, а не целиком.
  //
  // ⚠️ Целиком большой файл не проходит: nginx обрывает запрос через 3 минуты
  // («Gateway Time-out»), а импорт идёт построчно — на каждую строку свои
  // запросы в базу. Человек при этом видел вечное «Загружаем…» и не понимал,
  // работает оно или умерло. По частям каждый запрос укладывается в лимит,
  // а прогресс виден в процентах.
  //
  // ⚠️ Повторный импорт того же файла безопасен: контакт ищется по
  // telegram_id / email / телефону и не дублируется. Поэтому при обрыве можно
  // просто запустить заново.
  const CHUNK_ROWS = 1000

  async function submit() {
    if (!file) return
    setError('')
    setSubmitting(true)
    setProgress(0)
    setElapsed(0)
    setDoneRows(0)
    cancelRef.current = false
    const timer = setInterval(() => setElapsed(s => s + 1), 1000)
    try {
      const text = await file.text()
      const lines = text.split(/\r?\n/)
      const header = lines[0]
      const rows = lines.slice(1).filter(l => l.trim() !== '')
      const total = rows.length
      setRowCount(total)

      // Складываем итоги частей в один отчёт.
      //
      // ⚠️ Счётчики лежат ВНУТРИ `stats`, а не на верхнем уровне ответа.
      // Плоское сложение их не видело: `stats` — объект, а не число, и он
      // записывался один раз от первой части. Человек грузил 10 000 контактов,
      // а в отчёте видел 1 000 (итог первой порции) и думал, что загрузилось
      // не всё. Поэтому `stats` складываем отдельно, поключно.
      const sum: any = { stats: {}, report_text: '', channel_name: channel.display_name }
      const addUp = (r: any) => {
        for (const [k, v] of Object.entries(r?.stats || {})) {
          if (typeof v === 'number') sum.stats[k] = (sum.stats[k] || 0) + v
        }
        if (r?.report_text) {
          sum.report_text = (sum.report_text ? sum.report_text + '\n' : '') + r.report_text
        }
      }

      for (let i = 0; i < total; i += CHUNK_ROWS) {
        if (cancelRef.current) break
        const part = [header, ...rows.slice(i, i + CHUNK_ROWS)].join('\n')
        const blob = new File([part], file.name, { type: 'text/csv' })

        // ⚠️ Часть повторяется до трёх раз. Выкатка на прод рестартует веб и
        // API — на это уходят секунды, но идущий импорт при этом обрывался, и
        // человек видел «связь прервалась» посреди работы. Повтор той же части
        // безопасен: контакт ищется по идентификатору и не дублируется.
        let res: any = null
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            res = await api.channels.importCsv(channel.id, blob)
            break
          } catch (err: any) {
            const m = String(err?.message || '')
            const temporary = !m || /недоступен|Failed to fetch|network|timeout|gateway|502|503|504/i.test(m)
            if (!temporary || attempt === 3) throw err
            setError(`Обновляем соединение и продолжаем — попытка ${attempt} из 3…`)
            await new Promise(r => setTimeout(r, attempt * 4000))
          }
        }
        setError('')
        addUp(res)
        // Показываем СДЕЛАННОЕ, а не размер файла: «19% · 2 000 из 10 469».
        // Раньше в кнопке стояло общее число строк — по нему нельзя было
        // понять, сколько уже прошло.
        const done = Math.min(i + CHUNK_ROWS, total)
        setDoneRows(done)
        setProgress(Math.round((done / total) * 100))
      }
      if (!cancelRef.current) setProgress(100)
      // Остановили на середине — говорим это прямо. Иначе экран «Импорт
      // завершён» соврёт: часть файла осталась незагруженной.
      sum.stopped = cancelRef.current
      setResult(sum)
    } catch (e: any) {
      const msg = String(e?.message || '')
      const looksLikeTimeout = !msg || /недоступен|Failed to fetch|network|timeout|gateway/i.test(msg)
      // ⚠️ Формулировка спокойная и с готовым следующим шагом. Прежняя
      // («связь с сервером прервалась») читалась как «платформа не работает»,
      // хотя загруженное сохранено и всё чинится одним нажатием.
      setError(looksLikeTimeout
        ? `Загрузка приостановлена${doneRows ? `: перенесено ${doneRows.toLocaleString('ru-RU')} из ${rowCount?.toLocaleString('ru-RU')}` : ''}. `
          + 'Это бывает, когда соединение ненадолго прерывается. Нажмите «Импортировать» ещё раз — '
          + 'загрузка продолжится, а уже перенесённые контакты не задвоятся.'
        : msg)
    } finally {
      clearInterval(timer)
      setSubmitting(false)
    }
  }

  // Считаем контакты СРАЗУ при выборе файла — до нажатия кнопки. Иначе человек
  // не знает, сколько там строк, и не понимает, чего ждать: 200 контактов
  // загрузятся мгновенно, 5000 — за несколько минут.
  async function pickFile(f: File | null) {
    setFile(f)
    setRowCount(null)
    setNeedsUsernameLookup(false)
    setResult(null)
    setError('')
    if (!f) return
    try {
      const text = await f.text()
      const lines = text.split(/\r?\n/)
      setRowCount(lines.slice(1).filter(l => l.trim() !== '').length)
      // Есть ли в заголовке колонка с ником? Список синонимов — тот же, что
      // на бэкенде (_HEADER_ALIASES['telegram_username']).
      const aliases = ['telegram_username', 'username', 'tg_username', 'tg_login', 'login', 'никнейм']
      const headers = (lines[0] || '')
        .split(/[;,\t]/)
        .map(h => h.trim().toLowerCase().replace(/^["']|["']$/g, '').replace(/[- ]/g, '_'))
      setNeedsUsernameLookup(!headers.some(h => aliases.includes(h)))
    } catch {
      // Не смогли прочитать — не беда: посчитаем при самой загрузке.
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) pickFile(f)
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
                  <li><b className="font-mono">{idCol}</b> — обязательно (можно назвать просто <b className="font-mono">id</b>). Без него строка пропускается.</li>
                  <li><b className="font-mono">name</b> — имя контакта</li>
                  {/* ⚠️ У MAX ников нет вовсе — строку не показываем. */}
                  {channel.platform_slug === 'telegram' && (
                    <li><b className="font-mono">telegram_username</b> — никнейм без @ (подтянем сами, если не указан)</li>
                  )}
                  {channel.platform_slug === 'vk' && (
                    <li><b className="font-mono">screen_name</b> — короткий адрес страницы (подтянем сами, если не указан)</li>
                  )}
                  <li><b className="font-mono">email</b>, <b className="font-mono">phone</b> — для мерджа с существующими контактами</li>
                  <li><b className="font-mono">subscribed</b> — <code className="bg-blue-100 px-1 rounded">1</code>/<code className="bg-blue-100 px-1 rounded">да</code> (по умолчанию) или <code className="bg-blue-100 px-1 rounded">0</code>/<code className="bg-blue-100 px-1 rounded">нет</code></li>
                </ul>
                <p className="leading-snug pt-1">
                  <b>Что делает мердж:</b> если человек с таким <code className="bg-blue-100 px-1 rounded">{idCol}</code> уже
                  есть (например, подписан на другой ваш канал) — он не дублируется, ему просто добавляется подписка
                  на этот канал. То же если в базе уже есть контакт с таким email или телефоном.
                </p>
                <p className="leading-snug">
                  <b>Если данные разошлись:</b> человек нашёлся, но в файле у него другое имя,
                  почта или телефон — оставим то, что в базе, а расхождение запишем в отчёт.
                  База — это то, что человек указал сам, файл может быть старой выгрузкой.
                  Совпадающие данные ничего не меняют и в отчёт не попадают.
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
                  onChange={e => pickFile(e.target.files?.[0] || null)}
                />
                {file ? (
                  <div className="flex items-center justify-center gap-3">
                    <FileText size={28} style={{ color: '#25455D' }} />
                    <div className="text-left">
                      <div className="font-semibold text-gray-900 text-sm">{file.name}</div>
                      <div className="text-xs text-gray-500">
                        {(file.size / 1024).toFixed(1)} КБ
                        {rowCount !== null && ` · ${rowCount.toLocaleString('ru-RU')} контактов`}
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); pickFile(null) }}
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

              {/* Ников в файле нет — импорт будет спрашивать их у Telegram
                  по каждому id. На десяти тысячах это лишние минуты, и без
                  объяснения человек думает, что всё зависло.
                  ⚠️ ТОЛЬКО для Telegram: у ВКонтакте и MAX спросить ник по id
                  нечем, и плашка обещала бы несуществующее. */}
              {file && needsUsernameLookup && !submitting
                && (channel.platform_slug === 'telegram' || channel.platform_slug === 'vk') && (
                <div className="bg-amber-50 border border-amber-200 text-amber-900 text-sm rounded-xl p-3 leading-snug">
                  <b>В файле нет колонки с никнеймами.</b> Загрузка займёт больше обычного:
                  мы попутно соберём их у {channel.platform_slug === 'vk' ? 'ВКонтакте' : 'Telegram'} по id пользователей.
                  {rowCount ? (channel.platform_slug === 'vk'
                    ? ` Для ${rowCount.toLocaleString('ru-RU')} контактов это меньше минуты — ВКонтакте отдаёт их пачками.`
                    : ` Для ${rowCount.toLocaleString('ru-RU')} контактов это примерно ${Math.max(1, Math.ceil(rowCount / 1200))}–${Math.max(2, Math.ceil(rowCount / 600))} мин.`) : ''}
                </div>
              )}

              {submitting && (
                <div className="bg-blue-50 border border-blue-100 text-blue-900 text-sm rounded-xl p-3 leading-snug">
                  <b>Не закрывайте это окно и вкладку, пока идёт загрузка.</b> Файл грузится
                  частями прямо отсюда — если закрыть страницу, оставшиеся контакты не дойдут.
                  Прервать можно кнопкой «Остановить»: уже загруженные контакты сохранятся,
                  а повторный запуск того же файла дублей не создаст.
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => { if (submitting) cancelRef.current = true; else onClose() }}
                  className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
                >{submitting ? 'Остановить' : 'Отмена'}</button>
                <button
                  onClick={submit}
                  disabled={!file || submitting}
                  className="px-5 py-2 text-sm rounded-lg text-white font-semibold disabled:opacity-50"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
                >
                  {submitting
                    ? `Загружаем… ${progress}%`
                      + (rowCount ? ` · ${doneRows.toLocaleString('ru-RU')} из ${rowCount.toLocaleString('ru-RU')} · ${elapsed} с` : ` · ${elapsed} с`)
                    : 'Импортировать'}
                </button>
              </div>
            </>
          ) : (
            <ImportResultView
              result={result}
              platformSlug={channel.platform_slug}
              channelName={channel.display_name}
              onDownloadReport={downloadReport}
              onClose={onDone}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function ImportResultView({ result, platformSlug, channelName, onDownloadReport, onClose }: {
  result: ImportResult
  platformSlug: string
  channelName: string
  onDownloadReport: () => void
  onClose: () => void
}) {
  const s = result.stats
  const words = PLATFORM_WORDS[platformSlug] || { title: 'площадки', nick: 'ников', unit: 'канал' }
  // Название точки доставки прямо в подписи: «подписано на канал» клиент читал
  // как «на мой личный Telegram-канал» и не понимал, добавились ли люди в бот,
  // куда он только что грузил базу.
  const where = `«${channelName}»`
  const hasIssues = s.skipped_no_tgid + s.skipped_invalid_tgid + s.duplicates_in_file + s.mismatches + (s.tg_clash_skipped || 0) > 0

  return (
    <div className="space-y-4">
      {(result as any).stopped ? (
        <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
          <AlertTriangle size={20} className="text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-amber-900">Импорт остановлен</p>
            <p className="text-sm text-amber-800 mt-0.5">
              Успели обработать {s.total_rows.toLocaleString('ru')} строк — они сохранены.
              Остальные не загружены: запустите тот же файл ещё раз, дублей не будет.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-100 rounded-xl">
          <CheckCircle2 size={20} className="text-green-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-green-900">Импорт завершён</p>
            <p className="text-sm text-green-800 mt-0.5">
              Обработано {s.total_rows.toLocaleString('ru')} строк
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Новых людей добавлено" value={s.created_contacts} color="#25455D" />
        <StatCard label={`Уже были у вас — добавлены еще и в этот ${words.unit}`} value={s.matched_by_tg_id} color="#25455D" />
        <StatCard label="Узнали по почте или телефону" value={s.merged_by_email_phone} color="#7c3aed" />
        <StatCard label={`Подписано на ${where}`} unit="человек" value={s.subscribed} color="#16a34a" />
        <StatCard label={`Отписано от ${where}`} unit="человек" value={s.unsubscribed} color="#9ca3af" />
        {((s as any).usernames_resolved > 0 || (s as any).usernames_already_known > 0) && (
          <StatCard label={`Узнали ${words.nick} у ${words.title}`} value={(s as any).usernames_resolved || 0} color="#25455D" />
        )}
        {s.tg_clash_skipped > 0 && (
          <StatCard label="Пропустили — аккаунт занят" value={s.tg_clash_skipped} color="#dc2626" />
        )}
      </div>

      {hasIssues && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="font-semibold text-amber-900 text-sm mb-2 flex items-center gap-2">
            <AlertTriangle size={16} /> На что стоит посмотреть
          </div>
          <ul className="text-sm text-amber-900 space-y-1.5">
            {s.skipped_no_tgid > 0 && (
              <li>• <b>{s.skipped_no_tgid}</b> — пропустили, в строке не указан {ID_COLUMN[platformSlug] || 'id'}</li>
            )}
            {s.skipped_invalid_tgid > 0 && (
              <li>• <b>{s.skipped_invalid_tgid}</b> — пропустили, {ID_COLUMN[platformSlug] || 'id'} не похож на настоящий</li>
            )}
            {s.duplicates_in_file > 0 && (
              <li>• <b>{s.duplicates_in_file}</b> — эти люди встретились в файле дважды. Второй раз не заводили</li>
            )}
            {s.mismatches > 0 && (
              <li>
                • <b>{s.mismatches}</b> — в файле про них написано одно, а в вашей базе уже
                записано другое (например, другое имя). Оставили как в базе — то, что вы
                правили руками, файл не перетирает
              </li>
            )}
            {s.tg_clash_skipped > 0 && (
              <li>
                • <b>{s.tg_clash_skipped}</b> — пропустили: почта или телефон совпали с человеком,
                у которого в {words.title} уже указан другой аккаунт
              </li>
            )}
          </ul>
          <p className="text-xs text-amber-800 mt-2.5">
            Кто именно — в отчёте ниже, там перечислены строки поимённо.
          </p>
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

function StatCard({ label, value, color, unit }: { label: string; value: number; color: string; unit?: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-3 shadow-sm">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-2xl font-bold" style={{ color }}>
        {value.toLocaleString('ru')}
        {unit && <span className="text-sm font-medium text-gray-500 ml-1.5">{unit}</span>}
      </div>
    </div>
  )
}


// Привязка WhatsApp по QR прямо внутри формы «Добавить канал».
// Нет токена/handle — жмёшь «Подключить», сканируешь QR, дальше чаты выбираются
// на вкладке «Чаты для рассылок».
function WhatsAppConnectInline({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<string>('none')
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const READY = ['ready', 'authenticated']
  const isReady = READY.includes(state)

  useEffect(() => {
    // при открытии проверим — вдруг уже привязан
    api.channels.whatsappStatus().then((r: any) => {
      if (r.connected) setState(r.state || 'none')
    }).catch(() => {})
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const q: any = await api.channels.whatsappQr()
        setState(q.state || 'none')
        setQr(q.state === 'qr' ? q.qr : null)
        if (READY.includes(q.state)) {
          if (pollRef.current) clearInterval(pollRef.current)
          setQr(null)
        }
      } catch {}
    }, 3000)
  }

  const connect = async () => {
    setBusy(true)
    try {
      const r: any = await api.channels.connectWhatsapp()
      if (r?.already_connected) {
        setState(r.state || 'ready')  // уже привязан — не крутим QR
      } else {
        setState('starting')
        startPolling()
      }
    } catch (e: any) {
      alert(e?.message || 'Не удалось запустить привязку WhatsApp')
    } finally { setBusy(false) }
  }

  if (isReady) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center">
        <CheckCircle2 className="w-6 h-6 text-emerald-600 mx-auto mb-1" />
        <p className="text-sm font-semibold text-emerald-800">WhatsApp привязан</p>
        <p className="text-xs text-emerald-700 mt-1">Теперь на вкладке «Чаты для рассылок» выберите свои группы WhatsApp.</p>
        <button onClick={onClose} className="mt-3 text-sm font-semibold px-4 py-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>Готово</button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
      <p className="text-sm text-gray-700 mb-3">
        WhatsApp подключается по QR-коду.
      </p>
      {state === 'none' || state === 'unknown' ? (
        <button
          type="button"
          onClick={connect}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-60"
          style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Smartphone className="w-4 h-4" />}
          Подключить WhatsApp
        </button>
      ) : qr ? (
        <div className="text-center">
          <p className="text-xs text-gray-700 mb-2">
            WhatsApp на телефоне → <b>Настройки → Связанные устройства → Привязать устройство</b> → наведите на QR:
          </p>
          <img src={qr} alt="QR WhatsApp" className="mx-auto rounded-xl border border-gray-200" style={{ width: 'min(70vw, 260px)' }} />
          <p className="text-[11px] text-gray-400 mt-2">QR обновляется автоматически · {state}</p>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-gray-600 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Готовим QR-код… ({state})
        </div>
      )}
    </div>
  )
}


// Подключение Instagram: вход через Facebook → выбор страницы → готово.
//
// ⚠️ Ни токена, ни ника руками не вводят — их выдаёт Meta после входа.
// Поэтому обычная форма канала здесь не используется.
//
// ⚠️ Шаг выбора страницы отдельный и обязательный: страниц у человека бывает
// несколько, и с рабочим Instagram связана не обязательно первая. Молча взять
// первую — значит подключить не тот аккаунт, и воронка не увидит комментарии.
function InstagramConnectInline() {
  const [busy, setBusy] = useState(false)
  const [accounts, setAccounts] = useState<any[] | null>(null)
  const [pickKey, setPickKey] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  // Возврат из Facebook приходит параметрами адреса: ig_pick — что выбрать,
  // ig_error — понятная человеку причина отказа.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const e = p.get('ig_error')
    const k = p.get('ig_pick')
    if (e) setErr(e)
    if (k) {
      setPickKey(k)
      api.channels.instagramPending(k)
        .then((r: any) => setAccounts(r.accounts || []))
        .catch((x: any) => setErr(x?.message || 'Подключение устарело, начните заново'))
    }
    if (e || k) {
      // чистим адрес, чтобы обновление страницы не повторяло тот же экран
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  const start = async () => {
    setBusy(true); setErr(null)
    try {
      const r: any = await api.channels.instagramOauthUrl()
      window.location.href = r.oauth_url
    } catch (e: any) {
      setErr(e?.message || 'Не удалось начать подключение')
      setBusy(false)
    }
  }

  const connect = async (page_id: string) => {
    if (!pickKey) return
    setBusy(true); setErr(null)
    try {
      const r: any = await api.channels.instagramConnect(pickKey, page_id)
      setDone(r.username ? '@' + r.username : 'Аккаунт подключён')
      setAccounts(null)
    } catch (e: any) {
      setErr(e?.message || 'Не удалось подключить аккаунт')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <p className="text-sm font-semibold text-emerald-800">Instagram подключён — {done}</p>
        <p className="text-xs text-emerald-700 mt-1">
          Обновите страницу, чтобы увидеть карточку аккаунта в списке каналов.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
      {err && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {err}
        </div>
      )}

      {accounts ? (
        <>
          <p className="text-sm font-semibold text-gray-900 mb-1">Выберите аккаунт</p>
          <p className="text-xs text-gray-500 mb-3">
            Мы нашли эти аккаунты Instagram среди ваших страниц Facebook.
          </p>
          {accounts.length === 0 ? (
            <p className="text-sm text-gray-600">Подходящих аккаунтов не нашлось.</p>
          ) : (
            <div className="space-y-2">
              {accounts.map((a) => (
                <button
                  key={a.page_id}
                  onClick={() => connect(a.page_id)}
                  disabled={busy}
                  className="w-full flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 text-left hover:border-gray-300 disabled:opacity-50"
                >
                  {a.avatar
                    ? <img src={a.avatar} alt="" className="w-10 h-10 rounded-full object-cover" />
                    : <div className="w-10 h-10 rounded-full bg-gray-100" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-gray-900 truncate">
                      @{a.username || a.name || 'аккаунт'}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {a.followers != null ? `${a.followers} подписчиков · ` : ''}
                      страница «{a.page_name}»
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-gray-400 shrink-0" />
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-gray-700 mb-3">
            Instagram подключается входом через Facebook — токен выдаёт сама Meta,
            вводить ничего не нужно.
          </p>

          {/* ⚠️ Сначала ЗАЧЕМ, потом что нужно. Раньше первым блоком шли
              требования (профессиональный аккаунт, страница, VPN) — человек
              видел список условий, не понимая, ради чего их выполнять. */}
          <div className="rounded-lg border border-[#FFCFA4] bg-[#FFF8F1] p-3 mb-3">
            <p className="text-xs font-semibold text-gray-900 mb-1.5">Что это даёт</p>
            <ul className="text-xs text-gray-700 space-y-1.5 list-disc pl-4">
              <li>
                <strong>Комментарии под рилсами и ответы на сторис работают как воронка.</strong>{' '}
                Человек пишет кодовое слово — бот отвечает ему под комментарием и присылает
                лид-магнит в личные сообщения. При желании сначала проверяет подписку на аккаунт.
              </li>
              <li>
                <strong>Автопостинг афиш и анонсов</strong> — посты, карусели, рилсы и сторис
                прямо из ПЛЮСОНа. <span className="text-gray-500">Сейчас в разработке.</span>
              </li>
            </ul>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 mb-3">
            <p className="text-xs text-amber-900 font-semibold mb-1">Что нужно до подключения</p>
            <ul className="text-xs text-amber-900 space-y-1 list-disc pl-4">
              <li>аккаунт Instagram — профессиональный (Бизнес или Автор);</li>
              <li>он связан со страницей Facebook, где вы администратор;</li>
              <li>включён VPN — окно Facebook в России не открывается.</li>
            </ul>
          </div>
          <button
            onClick={start}
            disabled={busy}
            className="btn-gold w-full disabled:opacity-50"
          >
            {busy ? 'Открываем Facebook…' : 'Подключить Instagram'}
          </button>
          <p className="text-[11px] text-gray-400 mt-2">
            Платформа получит доступ только к комментариям и переписке этого аккаунта.
            Отозвать можно в любой момент: Facebook → Настройки → «Приложения и сайты».
          </p>
        </>
      )}
    </div>
  )
}


// Окно результата подключения Instagram.
//
// ⚠️ Ошибку показываем ЦЕЛИКОМ, включая список выданных прав: причина отказа
// у Meta почти всегда в правах, и без этого текста человек чинит не то.
function IgResultModal({ result, onClose }: {
  result: { ok: boolean; text: string }
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          {result.ok
            ? <CheckCircle2 className="w-6 h-6 text-emerald-500 shrink-0 mt-0.5" />
            : <AlertTriangle className="w-6 h-6 text-amber-500 shrink-0 mt-0.5" />}
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">
              {result.ok ? 'Instagram подключён' : 'Подключить не удалось'}
            </h3>
            <p className="text-sm text-gray-700 whitespace-pre-line break-words">{result.text}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="btn-gold px-5">Понятно</button>
        </div>
      </div>
    </div>
  )
}

// Выбор аккаунта Instagram после возврата из Facebook.
function IgPickModal({ pickKey, onClose, onOk, onError }: {
  pickKey: string
  onClose: () => void
  onDone: () => void
  onOk: (text: string) => void
  onError: (text: string) => void
}) {
  const [accounts, setAccounts] = useState<any[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.channels.instagramPending(pickKey)
      .then((r: any) => setAccounts(r.accounts || []))
      .catch((e: any) => onError(e?.message || 'Подключение устарело, начните заново'))
  }, [pickKey])

  const connect = async (page_id: string) => {
    setBusy(true)
    try {
      const r: any = await api.channels.instagramConnect(pickKey, page_id)
      onOk(`Аккаунт ${r.username ? '@' + r.username : ''} подключён и появился в списке каналов.`)
    } catch (e: any) {
      onError(e?.message || 'Не удалось подключить аккаунт')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Выберите аккаунт</h3>
        <p className="text-xs text-gray-500 mb-4">
          Эти аккаунты Instagram найдены среди ваших страниц Facebook.
        </p>
        {!accounts ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-6">
            <Loader2 className="w-4 h-4 animate-spin" /> Загружаем…
          </div>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-gray-600 py-4">Подходящих аккаунтов не нашлось.</p>
        ) : (
          <div className="space-y-2">
            {accounts.map((a) => (
              <button key={a.page_id} onClick={() => connect(a.page_id)} disabled={busy}
                className="w-full flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 text-left hover:border-gray-300 disabled:opacity-50">
                {a.avatar
                  ? <img src={a.avatar} alt="" className="w-10 h-10 rounded-full object-cover" />
                  : <div className="w-10 h-10 rounded-full bg-gray-100" />}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-gray-900 truncate">
                    @{a.username || a.name || 'аккаунт'}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {a.followers != null ? `${a.followers} подписчиков · ` : ''}страница «{a.page_name}»
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-gray-400 shrink-0" />
              </button>
            ))}
          </div>
        )}
        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Отмена</button>
        </div>
      </div>
    </div>
  )
}
