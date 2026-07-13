'use client'
import { useState, useEffect } from 'react'
import { Gift, Plus, Pencil, Trash2, ExternalLink, X, Copy, Check, Package, FileText, BarChart3, AlertTriangle, Users, QrCode, Download, Eye } from 'lucide-react'
import { api } from '@/lib/api'
import FileUploader from '@/components/FileUploader'
import { useMe } from '@/hooks/useMe'

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogg)(\?|$)/i
function inferMediaType(url: string | null | undefined): 'photo' | 'video' | null {
  if (!url) return null
  return VIDEO_EXT_RE.test(url) ? 'video' : 'photo'
}

type Tab = 'magnets' | 'packages' | 'template'

const PEACH = '#FFCFA4'
const DARK = '#25455D'

type PlatformLinks = Partial<Record<'telegram' | 'vk' | 'max', string>>

interface LeadMagnet {
  id: number
  name: string
  description: string | null
  url: string
  slug: string
  platform_links?: PlatformLinks
  created_at: string
  updated_at: string
}

interface PackageItem {
  lead_magnet_id: number
  sort_order: number
  name: string
  url: string
  slug: string
}

interface Package {
  id: number
  name: string
  description: string | null
  slug: string
  platform_links?: PlatformLinks
  items: PackageItem[]
  created_at: string
  updated_at: string
}

function getPublicBase() {
  if (typeof window === 'undefined') return 'https://pluson.ru'
  return window.location.origin.replace(/^http:\/\/localhost:3000/, 'https://dev.pluson.ru')
}

// Готовность выдачи воронки: бот админ во ВСЕХ каналах основателя. Пока не
// готов — ссылки на воронку показываем размыто. Хук, т.к. статус нужен и в
// списке лид-магнитов, и в списке пакетов (это разные компоненты).
type ChannelsReady = { ready: boolean; has_bot: boolean; channels: any[] } | null
function useFounderChannelsReady(): ChannelsReady {
  const [channelsReady, setChannelsReady] = useState<ChannelsReady>(null)
  useEffect(() => {
    api.miniApp.chatGates.founderChannelsStatus()
      .then((s: any) => setChannelsReady({ ready: !!s?.ready, has_bot: !!s?.has_bot, channels: s?.channels || [] }))
      .catch(() => setChannelsReady(null))
  }, [])
  return channelsReady
}

export default function LeadMagnetsPage() {
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'magnets'
    const t = new URLSearchParams(window.location.search).get('tab')
    return (t === 'packages' || t === 'template') ? t as Tab : 'magnets'
  })
  // Канал(ы) основателя для воронки — массив (миграция 114).
  // null = ещё не загружено или загружено и пусто; [] = загружено и пусто; [..] = есть.
  const [tgChannels, setTgChannels] = useState<{ url: string; name?: string }[] | null>(null)
  // Сводные счётчики по всем лид-магнитам + всем пакетам (есть contact_id / получили)
  const [totals, setTotals] = useState<{ reached: number; received: number } | null>(null)
  // Главный бот воронки перехвачен сторонним сервисом (webhook) → воронки НЕ работают:
  // Telegram отдаёт /start туда, а не нам. Проверяем только is_active-бота —
  // именно через него идёт выдача лид-магнитов.
  const [hijackedBot, setHijackedBot] = useState<{ handle: string; host: string } | null>(null)

  useEffect(() => {
    api.miniApp.profile.get()
      .then((p: any) => {
        const list = (p?.social_links || {}).telegram_channels
        setTgChannels(Array.isArray(list) ? list : [])
      })
      .catch(() => setTgChannels([]))
  }, [])

  useEffect(() => {
    api.channels.telegramHealth()
      .then((r: any) => {
        const bad = (r?.items || []).find((i: any) => i.hijacked && i.is_active)
        setHijackedBot(bad ? { handle: bad.handle || '', host: bad.webhook_host || '' } : null)
      })
      .catch(() => setHijackedBot(null))
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.leadMagnets.counts().catch(() => ({ items: [] })),
      api.leadMagnetPackages.counts().catch(() => ({ items: [] })),
    ]).then(([m, p]: any) => {
      if (cancelled) return
      const sum = (arr: any[], k: string) => arr.reduce((acc, r) => acc + (r?.[k] || 0), 0)
      setTotals({
        // known — живые контакты, зашедшие по ссылке (та же логика, что у плиток)
        reached:  sum(m.items || [], 'known')     + sum(p.items || [], 'known'),
        received: sum(m.items || [], 'delivered') + sum(p.items || [], 'delivered'),
      })
    })
    return () => { cancelled = true }
  }, [])

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: DARK }}>
            <Gift size={24} /> Лид-магниты
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Общая база материалов клиента + воронка их выдачи через бот.
          </p>
        </div>
        {totals && (
          <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5">
            <Users size={16} className="text-[#25455D] shrink-0" />
            <div className="text-sm">
              <span className="text-[#25455D] font-bold">{totals.reached}</span>
              <span className="text-gray-400 mx-1">/</span>
              <span className="text-[#25455D] font-bold">{totals.received}</span>
              <span className="ml-2 text-xs text-gray-500">перешли / получили</span>
            </div>
          </div>
        )}
      </div>

      {hijackedBot && (
        <div className="mb-6 rounded-xl border border-red-300 bg-red-50 p-4 flex items-start gap-3">
          <AlertTriangle className="text-red-600 shrink-0 mt-0.5" size={20} />
          <div className="flex-1 text-sm">
            <div className="font-semibold text-red-900 mb-1">
              Воронки не работают — вашего бота перехватил другой сервис
            </div>
            <div className="text-red-800">
              Telegram сейчас отдаёт все сообщения бота{' '}
              {hijackedBot.handle && <span className="font-mono font-semibold">{hijackedBot.handle}</span>}{' '}
              сюда: <span className="font-mono font-semibold">{hijackedBot.host || 'сторонний сервис'}</span>.
              Пока это так, люди жмут по ссылке лид-магнита, но бот им не отвечает — и счётчики стоят на нуле.
              Так бывает, если бота подключали в другом конструкторе (LeadConverter, Salebot, BotHelp).
            </div>
            <a
              href="/dashboard/channels"
              className="inline-flex items-center gap-1 mt-2 text-sm font-semibold underline text-red-900 hover:text-red-700"
            >
              Забрать бота в ПЛЮСОН →
            </a>
          </div>
        </div>
      )}

      {tgChannels !== null && tgChannels.length === 0 && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle className="text-amber-600 shrink-0 mt-0.5" size={20} />
          <div className="flex-1 text-sm">
            <div className="font-semibold text-amber-900 mb-1">Канал(ы) основателя не настроены</div>
            <div className="text-amber-800">
              Без канала бот не сможет проверить подписку — материалы по воронке выдаваться не будут.
              Укажите хотя бы один Telegram-канал основателя.
            </div>
            <a
              href="/dashboard/mini-app?tab=owner"
              className="inline-flex items-center gap-1 mt-2 text-sm font-medium underline text-amber-900 hover:text-amber-700"
            >
              Настроить каналы →
            </a>
          </div>
        </div>
      )}
      {tgChannels !== null && tgChannels.length > 0 && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
          <div className="font-semibold text-gray-900 mb-1">
            Воронка проверит подписку на {tgChannels.length === 1 ? 'канал' : `${tgChannels.length} канала(ов)`}:
          </div>
          <ul className="space-y-0.5">
            {tgChannels.map((ch, i) => (
              <li key={i} className="text-gray-700">
                • {ch.name ? `${ch.name} — ` : ''}<a href={ch.url} target="_blank" rel="noopener" className="text-[#25455D] underline">{ch.url}</a>
              </li>
            ))}
          </ul>
          <a
            href="/dashboard/mini-app?tab=owner"
            className="inline-flex items-center gap-1 mt-2 text-xs underline text-[#25455D]"
          >
            Изменить список каналов →
          </a>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200 overflow-x-auto">
        {[
          { id: 'magnets', label: 'Лид-магниты', icon: FileText },
          { id: 'packages', label: 'Пакеты', icon: Package },
          { id: 'template', label: 'Шаблон воронки', icon: Pencil },
        ].map(({ id, label, icon: Icon }) => {
          const active = tab === (id as Tab)
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id as Tab)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
                active ? 'border-[#25455D] text-[#25455D]' : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              <Icon size={16} /> {label}
            </button>
          )
        })}
      </div>

      {tab === 'magnets' && <MagnetsList />}
      {tab === 'packages' && <PackagesList />}
      {tab === 'template' && <TemplateEditor />}
    </div>
  )
}

// ============== Лид-магниты ==============

interface CountRow { id: number; landed: number; known: number; started: number; delivered: number; not_delivered: number }

/**
 * Плитка «все / забрали / не забрали» — каждая цифра кликабельна и ведёт в
 * Контакты с соответствующим фильтром (`lead_magnet_stage`).
 * Цифры считаются по живым контактам, поэтому совпадают с числом строк в списке.
 */
function LandedCounter({
  reached, received, notReceived, href,
}: { reached: number; received: number; notReceived: number; href: string }) {
  const empty = reached === 0
  if (empty) {
    return (
      <span className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-400"
            title="Никто ещё не дошёл до бота">
        <Users size={12} /> 0/0/0
      </span>
    )
  }
  const cell = 'px-1 rounded hover:bg-white/50 transition-colors'
  return (
    <span className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-[#FFCFA4] text-[#25455D]">
      <Users size={12} />
      <a href={href} className={cell} title={`${reached} — зашли по ссылке (все)`}>{reached}</a>
      <span className="text-[#25455D]/40">/</span>
      <a href={`${href}&lead_magnet_stage=delivered`} className={cell} title={`${received} — забрали материалы`}>{received}</a>
      <span className="text-[#25455D]/40">/</span>
      <a href={`${href}&lead_magnet_stage=not_delivered`} className={cell} title={`${notReceived} — не забрали материалы`}>{notReceived}</a>
    </span>
  )
}

function MagnetsList() {
  const { isAssistant } = useMe()
  const [items, setItems] = useState<LeadMagnet[]>([])
  const [counts, setCounts] = useState<Record<number, CountRow>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<LeadMagnet | null>(null)
  const [creating, setCreating] = useState(false)
  const [analyticsOpen, setAnalyticsOpen] = useState<LeadMagnet | null>(null)
  const channelsReady = useFounderChannelsReady()

  async function load() {
    setLoading(true)
    try {
      const [res, cnt] = await Promise.all([
        api.leadMagnets.list(),
        api.leadMagnets.counts().catch(() => ({ items: [] })),
      ])
      setItems(res.items || [])
      const map: Record<number, CountRow> = {}
      for (const c of (cnt.items || []) as CountRow[]) map[c.id] = c
      setCounts(map)
      setError(null)
    } catch (e: any) {
      setError(e.message || 'Не получилось загрузить')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function handleDelete(id: number) {
    if (!confirm('Удалить лид-магнит? Связанные пороги в реф-программах останутся, но без подарка.')) return
    try { await api.leadMagnets.delete(id); await load() }
    catch (e: any) { alert(e.message || 'Ошибка удаления') }
  }

  return (
    <div>
      {!isAssistant && (
        <div className="flex justify-end mb-4">
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
          >
            <Plus size={18} /> Добавить
          </button>
        </div>
      )}

      {error && <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">{error}</div>}

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        isAssistant
          ? <div className="text-gray-400 text-sm">Лид-магнитов пока нет.</div>
          : <EmptyState icon={Gift} text="У вас пока нет лид-магнитов" onCreate={() => setCreating(true)} />
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y">
          {items.map(lm => (
            <div key={lm.id} className="p-4 flex items-start gap-3 hover:bg-gray-50">
              <div className="mt-1 w-9 h-9 rounded-lg flex items-center justify-center text-white"
                   style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                <Gift size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900">{lm.name}</div>
                <a href={lm.url} target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-1 text-xs mt-1 text-gray-400 hover:underline truncate">
                  <ExternalLink size={12} />
                  <span className="truncate">{lm.url}</span>
                </a>
                <div><CopyIdButton slug={lm.slug} /></div>
                <div className="mt-2">
                  <PlatformShareLinks kind="m" slug={lm.slug} links={lm.platform_links} name={lm.name} blocked={!!channelsReady && channelsReady.has_bot && !channelsReady.ready} />
                </div>
              </div>
              <div className="flex gap-1 items-center">
                <LandedCounter
                  reached={counts[lm.id]?.known || 0}
                  received={counts[lm.id]?.delivered || 0}
                  notReceived={counts[lm.id]?.not_delivered || 0}
                  href={`/dashboard/clients?lead_magnet_ids=${lm.id}`}
                />
                <button onClick={() => setAnalyticsOpen(lm)} title="Аналитика"
                        className="p-2 rounded text-gray-400 hover:text-[#25455D] hover:bg-gray-100">
                  <BarChart3 size={16} />
                </button>
                {!isAssistant && (
                  <>
                    <button onClick={() => setEditing(lm)} title="Редактировать"
                            className="p-2 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => handleDelete(lm.id)} title="Удалить"
                            className="p-2 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <LeadMagnetForm
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}
      {analyticsOpen && (
        <AnalyticsModal
          kind="m"
          item={analyticsOpen}
          onClose={() => setAnalyticsOpen(null)}
        />
      )}
    </div>
  )
}

function LeadMagnetForm({ initial, onClose, onSaved }: {
  initial: LeadMagnet | null; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [url, setUrl] = useState(initial?.url || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!name.trim() || !url.trim()) { setErr('Название и ссылка обязательны'); return }
    setSaving(true)
    try {
      const payload = { name: name.trim(), description: description.trim() || null, url: url.trim() }
      if (initial) await api.leadMagnets.update(initial.id, payload)
      else await api.leadMagnets.create(payload)
      onSaved()
    } catch (e: any) { setErr(e.message || 'Ошибка сохранения'); setSaving(false) }
  }

  return (
    <Modal title={initial ? 'Редактировать лид-магнит' : 'Новый лид-магнит'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Название *">
          <input type="text" value={name} onChange={e => setName(e.target.value)}
                 className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                 placeholder="Чек-лист по продажам" autoFocus />
        </Field>
        <Field label="Ссылка *">
          <input type="url" value={url} onChange={e => setUrl(e.target.value)}
                 className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                 placeholder="https://example.com/file.pdf" />
        </Field>
        <Field label="Описание">
          <textarea value={description} onChange={e => setDescription(e.target.value)}
                 rows={2}
                 className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                 placeholder="Короткое описание — покажется в воронке под названием подарка (плейсхолдер {materials_list_description})" />
        </Field>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <FormActions saving={saving} onClose={onClose} />
      </form>
    </Modal>
  )
}

// ============== Пакеты ==============

function PackagesList() {
  const { isAssistant } = useMe()
  const channelsReady = useFounderChannelsReady()
  const [items, setItems] = useState<Package[]>([])
  const [magnets, setMagnets] = useState<LeadMagnet[]>([])
  const [counts, setCounts] = useState<Record<number, CountRow>>({})
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Package | null>(null)
  const [creating, setCreating] = useState(false)
  const [analyticsOpen, setAnalyticsOpen] = useState<Package | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [pkgs, lms, cnt] = await Promise.all([
        api.leadMagnetPackages.list(),
        api.leadMagnets.list(),
        api.leadMagnetPackages.counts().catch(() => ({ items: [] })),
      ])
      setItems(pkgs.items || [])
      setMagnets(lms.items || [])
      const map: Record<number, CountRow> = {}
      for (const c of (cnt.items || []) as CountRow[]) map[c.id] = c
      setCounts(map)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function handleDelete(id: number) {
    if (!confirm('Удалить пакет? Сами лид-магниты останутся.')) return
    try { await api.leadMagnetPackages.delete(id); await load() }
    catch (e: any) { alert(e.message || 'Ошибка удаления') }
  }

  return (
    <div>
      {!isAssistant && (
        <div className="flex justify-end mb-4">
          <button
            onClick={() => setCreating(true)}
            disabled={magnets.length === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium disabled:opacity-50"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
            title={magnets.length === 0 ? 'Сначала создайте хотя бы один лид-магнит' : ''}
          >
            <Plus size={18} /> Создать пакет
          </button>
        </div>
      )}

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        isAssistant
          ? <div className="text-gray-400 text-sm">Пакетов пока нет.</div>
          : <EmptyState icon={Package} text="У вас пока нет пакетов" onCreate={() => setCreating(true)} />
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y">
          {items.map(pkg => (
            <div key={pkg.id} className="p-4 flex items-start gap-3 hover:bg-gray-50">
              <div className="mt-1 w-9 h-9 rounded-lg flex items-center justify-center text-white"
                   style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                <Package size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900">{pkg.name}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {pkg.items.length} {plural(pkg.items.length, 'материал', 'материала', 'материалов')}
                </div>
                {pkg.items.length > 0 && (
                  <ul className="mt-2 text-xs text-gray-600 list-decimal pl-5 space-y-0.5">
                    {pkg.items.slice(0, 5).map(i => <li key={i.lead_magnet_id}>{i.name}</li>)}
                    {pkg.items.length > 5 && <li className="text-gray-400">…ещё {pkg.items.length - 5}</li>}
                  </ul>
                )}
                <div><CopyIdButton slug={pkg.slug} /></div>
                <div className="mt-2">
                  <PlatformShareLinks kind="p" slug={pkg.slug} links={pkg.platform_links} name={pkg.name} blocked={!!channelsReady && channelsReady.has_bot && !channelsReady.ready} />
                </div>
              </div>
              <div className="flex gap-1 items-center">
                <LandedCounter
                  reached={counts[pkg.id]?.known || 0}
                  received={counts[pkg.id]?.delivered || 0}
                  notReceived={counts[pkg.id]?.not_delivered || 0}
                  href={`/dashboard/clients?package_ids=${pkg.id}`}
                />
                <button onClick={() => setAnalyticsOpen(pkg)} title="Аналитика"
                        className="p-2 rounded text-gray-400 hover:text-[#25455D] hover:bg-gray-100">
                  <BarChart3 size={16} />
                </button>
                {!isAssistant && (
                  <>
                    <button onClick={() => setEditing(pkg)} title="Редактировать"
                            className="p-2 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => handleDelete(pkg.id)} title="Удалить"
                            className="p-2 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <PackageForm
          initial={editing}
          magnets={magnets}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}
      {analyticsOpen && (
        <AnalyticsModal kind="p" item={analyticsOpen} onClose={() => setAnalyticsOpen(null)} />
      )}
    </div>
  )
}

function PackageForm({ initial, magnets, onClose, onSaved }: {
  initial: Package | null; magnets: LeadMagnet[]; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [selected, setSelected] = useState<number[]>(
    initial ? initial.items.sort((a, b) => a.sort_order - b.sort_order).map(i => i.lead_magnet_id) : []
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function toggle(id: number) {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  }
  function move(idx: number, dir: -1 | 1) {
    setSelected(s => {
      const next = idx + dir
      if (next < 0 || next >= s.length) return s
      const out = [...s]
      const tmp = out[idx]; out[idx] = out[next]; out[next] = tmp
      return out
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!name.trim()) { setErr('Название обязательно'); return }
    if (selected.length === 0) { setErr('Выберите хотя бы один лид-магнит'); return }
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        items: selected.map((id, i) => ({ lead_magnet_id: id, sort_order: i })),
      }
      if (initial) await api.leadMagnetPackages.update(initial.id, payload)
      else await api.leadMagnetPackages.create(payload)
      onSaved()
    } catch (e: any) { setErr(e.message || 'Ошибка сохранения'); setSaving(false) }
  }

  return (
    <Modal title={initial ? 'Редактировать пакет' : 'Новый пакет'} onClose={onClose} large>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Название пакета *">
          <input type="text" value={name} onChange={e => setName(e.target.value)}
                 className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                 placeholder="Стартовый набор для предпринимателя" autoFocus />
        </Field>
        <Field label="Заметка">
          <textarea value={description} onChange={e => setDescription(e.target.value)}
                    rows={2}
                    placeholder="Видна только вам в дашборде"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <p className="text-xs text-gray-500 mt-1">
            Только для вас — в сообщениях бота не используется.
          </p>
        </Field>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Лид-магниты в пакете * <span className="text-gray-400 text-xs">({selected.length} выбрано)</span>
          </label>

          {/* Selected (orderable) */}
          {selected.length > 0 && (
            <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg p-2 space-y-1">
              {selected.map((id, idx) => {
                const m = magnets.find(x => x.id === id)
                if (!m) return null
                return (
                  <div key={id} className="flex items-center gap-2 bg-white rounded p-2 text-sm">
                    <span className="text-xs text-gray-500 w-5">{idx + 1}.</span>
                    <span className="flex-1 truncate">{m.name}</span>
                    <button type="button" onClick={() => move(idx, -1)} disabled={idx === 0}
                            className="text-xs px-2 py-0.5 rounded hover:bg-gray-100 disabled:opacity-30">↑</button>
                    <button type="button" onClick={() => move(idx, 1)} disabled={idx === selected.length - 1}
                            className="text-xs px-2 py-0.5 rounded hover:bg-gray-100 disabled:opacity-30">↓</button>
                    <button type="button" onClick={() => toggle(id)}
                            className="text-xs text-red-600 hover:bg-red-50 px-2 py-0.5 rounded">Убрать</button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Available */}
          <div className="border border-gray-200 rounded-lg max-h-60 overflow-y-auto">
            {magnets.filter(m => !selected.includes(m.id)).length === 0 && selected.length === magnets.length ? (
              <div className="p-4 text-center text-sm text-gray-400">Все лид-магниты добавлены</div>
            ) : magnets.length === 0 ? (
              <div className="p-4 text-center text-sm text-gray-400">У вас нет лид-магнитов. Создайте на вкладке «Лид-магниты».</div>
            ) : (
              magnets.filter(m => !selected.includes(m.id)).map(m => (
                <button key={m.id} type="button" onClick={() => toggle(m.id)}
                        className="w-full text-left p-3 hover:bg-gray-50 border-b border-gray-100 last:border-b-0 flex items-center gap-2">
                  <Plus size={14} className="text-gray-400" />
                  <span className="flex-1 text-sm truncate">{m.name}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {err && <div className="text-sm text-red-600">{err}</div>}
        <FormActions saving={saving} onClose={onClose} />
      </form>
    </Modal>
  )
}

// ============== Шаблон воронки ==============

// Шаги воронки — для превью (глазик у каждого текста).
type FunnelStep = 'text_1' | 'text_2' | 'text_3_delivered' | 'text_3_stuck'
const STEP_TITLES: Record<FunnelStep, string> = {
  text_1: 'Текст 1 — приветствие со списком подарков',
  text_2: 'Текст 2 — выдача материалов',
  text_3_delivered: 'Текст 3 — получившим материалы',
  text_3_stuck: 'Текст 3 — зависшим на проверке подписки',
}

function TemplateEditor() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // ── Превью текста воронки ──
  // Тексты 1 и 2 подставляют список подарков — поэтому в превью выбирается
  // конкретный лид-магнит или пакет. Тексты 3 от подарков не зависят, но выбор
  // оставляем: там тоже могут стоять {materials_*}.
  const [previewStep, setPreviewStep] = useState<FunnelStep | null>(null)
  const [previewText, setPreviewText] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [magnets, setMagnets] = useState<any[]>([])
  const [packages, setPackages] = useState<any[]>([])
  // Что выдаём в превью: 'm:<id>' — лид-магнит, 'p:<id>' — пакет.
  const [previewSource, setPreviewSource] = useState('')
  const [previewPlatform, setPreviewPlatform] = useState<'telegram' | 'vk' | 'max'>('telegram')

  async function load() {
    setLoading(true)
    try { setData(await api.funnelTemplates.get('lead_magnet')) }
    catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  // Списки для селектора в превью — грузим один раз.
  useEffect(() => {
    Promise.all([
      api.leadMagnets.list().catch(() => ({ items: [] })),
      api.leadMagnetPackages.list().catch(() => ({ items: [] })),
    ]).then(([m, p]) => {
      const ms = m.items || m.lead_magnets || []
      const ps = p.items || p.packages || []
      setMagnets(ms)
      setPackages(ps)
      setPreviewSource(prev => prev || (ms[0] ? `m:${ms[0].id}` : (ps[0] ? `p:${ps[0].id}` : '')))
    })
  }, [])

  // Рендер превью на бэке — та же логика, что при реальной отправке.
  async function runPreview(step: FunnelStep, source: string, platform: 'telegram' | 'vk' | 'max') {
    setPreviewLoading(true)
    setPreviewErr(null)
    try {
      const [kind, idStr] = source.split(':')
      const id = Number(idStr) || null
      const res = await api.funnelTemplates.preview('lead_magnet', {
        step,
        lead_magnet_id: kind === 'm' ? id : null,
        package_id: kind === 'p' ? id : null,
        platform,
        // Шлём текст «как в форме» — превью работает и до сохранения.
        text: data?.[step] ?? '',
      })
      setPreviewText(res.text || '')
    } catch (e: any) {
      setPreviewErr(e.message)
      setPreviewText('')
    } finally {
      setPreviewLoading(false)
    }
  }

  function openPreview(step: FunnelStep) {
    setPreviewStep(step)
    runPreview(step, previewSource, previewPlatform)
  }

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      await api.funnelTemplates.update('lead_magnet', {
        text_1: data.text_1,
        button_label: data.button_label,
        text_2: data.text_2,
        text_3_delivered: data.text_3_delivered,
        text_3_stuck: data.text_3_stuck,
        text_1_media_url:  data.text_1_media_url  || null,
        text_1_media_type: data.text_1_media_url ? inferMediaType(data.text_1_media_url) : null,
        text_2_media_url:  data.text_2_media_url  || null,
        text_2_media_type: data.text_2_media_url ? inferMediaType(data.text_2_media_url) : null,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e: any) { setErr(e.message) }
    finally { setSaving(false) }
  }

  function setMedia(field: 'text_1_media_url' | 'text_2_media_url') {
    return (url: string | null) => setData((d: any) => ({ ...d, [field]: url }))
  }

  if (loading) return <div className="text-gray-400 text-sm">Загрузка…</div>
  if (!data) return <div className="text-red-600 text-sm">{err || 'Ошибка загрузки'}</div>

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setData((d: any) => ({ ...d, [k]: e.target.value }))

  // Заполнить поле заводским текстом из шаблона (на случай если клиент очистил).
  function fillFromDefault(k: 'text_1' | 'text_2' | 'button_label') {
    setData((d: any) => {
      const def = d?.defaults?.[k]
      if (def == null) return d
      if (d[k] && d[k].trim() && !confirm('Заменить текущий текст заводским шаблоном?')) return d
      return { ...d, [k]: def }
    })
  }

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="text-sm text-gray-600 bg-amber-50 border border-amber-100 rounded-lg p-3">
        Один шаблон на все лид-магниты и пакеты. Тексты можно править — создавать новые
        шаблоны пока нельзя. Доступные плейсхолдеры:
        <dl className="mt-2 space-y-1.5 text-xs">
          {[
            ['{materials_list}', 'нумерованный список названий подарков жирным (без ссылок)'],
            ['{materials_list_description}', 'список подарков: жирное название — описание (без ссылок). Описание пакета — сверху списка'],
            ['{materials_list_description_links}', 'то же, но со ссылкой на файл отдельной строкой под каждым подарком'],
            ['{materials_with_links}', 'список подарков с готовыми ссылками на файлы'],
            ['{client_brand_name}', 'название вашего бренда'],
            ['{client_owner_name}', 'имя основателя'],
            ['{client_owner_positioning}', 'позиционирование основателя (короткая строка о вас)'],
            ['{client_owner_bio}', 'биография основателя'],
            ['{client_owner_achievements}', 'ваши регалии и факты в цифрах'],
            ['{subscription_channel}', 'ссылка на канал, на который нужно подписаться за подарок'],
            ['{owner_telegram}', 'личный Telegram основателя — тот, что вы указали при регистрации (Настройки → Профиль). Это не служба заботы'],
            ['{support_platform}', 'служба заботы на той площадке, где человек в воронке: в Telegram — телеграм-контакт, в ВК — ВК, в MAX — MAX'],
            ['{support_links}', 'все каналы службы заботы (ВКонтакте, Telegram, MAX) — по строке на каждый'],
          ].map(([ph, desc]) => (
            <div key={ph} className="flex flex-col sm:flex-row sm:gap-2">
              <code className="font-mono text-amber-900 whitespace-nowrap">{ph}</code>
              <span className="text-gray-600">— {desc}</span>
            </div>
          ))}
        </dl>
      </div>

      <div className="text-xs text-gray-600 bg-sky-50 border border-sky-100 rounded-lg p-3 leading-snug">
        <strong>HTML-разметка</strong> (<span className="font-mono">&lt;b&gt; &lt;i&gt; &lt;u&gt; &lt;s&gt; &lt;a href=...&gt;</span>) работает
        только в&nbsp;Telegram и&nbsp;MAX. В&nbsp;ВКонтакте теги не поддерживаются — при отправке они
        автоматически срезаются, останется чистый текст. Ссылки <span className="font-mono">&lt;a&gt;</span> в&nbsp;ВК
        превращаются в обычный URL (превью ВК разворачивает сам).
      </div>

      {/* === Текст 1 === */}
      <section className="bg-white rounded-xl border-2 border-gray-300 p-5 space-y-4">
        <header className="border-b border-gray-200 pb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold" style={{ color: DARK }}>Текст 1 — приветствие со списком подарков</h3>
            <p className="text-xs text-gray-500 mt-1">Уходит сразу когда человек открыл бота по ссылке лид-магнита.</p>
          </div>
          <div className="shrink-0 flex gap-2">
            <button type="button" onClick={() => openPreview('text_1')}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
              <Eye size={13} /> Просмотреть
            </button>
            <button type="button" onClick={() => fillFromDefault('text_1')}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
              Заполнить из шаблона
            </button>
          </div>
        </header>

        <Field label="Текст сообщения">
          <textarea value={data.text_1 || ''} onChange={set('text_1')} rows={8}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm" />
        </Field>

        <Field label="Фото или видео (опционально)">
          <FileUploader
            mode="single"
            kind="funnel_media"
            accept="image/*,video/mp4,video/webm,video/quicktime"
            aspectClass="aspect-video"
            emptyText="Перетащите фото или видео — пойдёт вместе с Текстом 1"
            buttonLabel="Загрузить медиа"
            value={data.text_1_media_url || null}
            onChange={setMedia('text_1_media_url')}
          />
          <p className="text-xs text-gray-500 mt-1">
            Если медиа добавлено и итоговый текст ≤ 1024 символов — отправим одно сообщение
            с подписью и кнопкой. Если длиннее — сначала медиа, потом текст отдельным сообщением.
          </p>
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-1.5">
            ⚠️ В MAX и VK видео не отправляется — только фото. Видео уйдёт лишь подписчикам в Telegram.
          </p>
        </Field>

        <Field label="Подпись на кнопке">
          <input type="text" value={data.button_label || ''} onChange={set('button_label')}
                 className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </Field>
      </section>

      {/* === Текст 2 === */}
      <section className="bg-white rounded-xl border-2 border-gray-300 p-5 space-y-4">
        <header className="border-b border-gray-200 pb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold" style={{ color: DARK }}>Текст 2 — выдача материалов</h3>
            <p className="text-xs text-gray-500 mt-1">Уходит после того как человек нажал «ГОТОВО» и подписка на канал подтверждена.</p>
          </div>
          <div className="shrink-0 flex gap-2">
            <button type="button" onClick={() => openPreview('text_2')}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
              <Eye size={13} /> Просмотреть
            </button>
            <button type="button" onClick={() => fillFromDefault('text_2')}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
              Заполнить из шаблона
            </button>
          </div>
        </header>

        <Field label="Текст сообщения">
          <textarea value={data.text_2 || ''} onChange={set('text_2')} rows={5}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm" />
        </Field>

        <Field label="Фото или видео (опционально)">
          <FileUploader
            mode="single"
            kind="funnel_media"
            accept="image/*,video/mp4,video/webm,video/quicktime"
            aspectClass="aspect-video"
            emptyText="Перетащите фото или видео — пойдёт вместе с Текстом 2"
            buttonLabel="Загрузить медиа"
            value={data.text_2_media_url || null}
            onChange={setMedia('text_2_media_url')}
          />
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-1.5">
            ⚠️ В MAX и VK видео не отправляется — только фото. Видео уйдёт лишь подписчикам в Telegram.
          </p>
        </Field>
      </section>

      {/* === Текст 3 === */}
      <section className="bg-white rounded-xl border-2 border-gray-300 p-5 space-y-4">
        <header className="border-b border-gray-200 pb-3">
          <h3 className="text-base font-semibold" style={{ color: DARK }}>Текст 3 — follow-up через 30 минут</h3>
          <p className="text-xs text-gray-500 mt-1">Автоматически уходит спустя 30 минут после Текста 1. Два варианта в зависимости от того, дошёл ли человек до выдачи.</p>
        </header>

        <Field label="Получившим материалы">
          <textarea value={data.text_3_delivered || ''} onChange={set('text_3_delivered')} rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm" />
          <button type="button" onClick={() => openPreview('text_3_delivered')}
                  className="mt-1.5 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">
            <Eye size={13} /> Просмотреть
          </button>
        </Field>

        <Field label="Зависшим на проверке подписки">
          <textarea value={data.text_3_stuck || ''} onChange={set('text_3_stuck')} rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm" />
          <button type="button" onClick={() => openPreview('text_3_stuck')}
                  className="mt-1.5 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">
            <Eye size={13} /> Просмотреть
          </button>
        </Field>
      </section>

      {/* === Модалка превью текста воронки === */}
      {previewStep && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-200">
              <h3 className="font-semibold text-gray-800 text-sm">
                Просмотр: {STEP_TITLES[previewStep]}
              </h3>
              <button onClick={() => setPreviewStep(null)} className="shrink-0 text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-3">
              {/* Что выдаётся — от этого зависит список подарков в тексте */}
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Лид-магнит или пакет</label>
                <select
                  value={previewSource}
                  onChange={e => {
                    setPreviewSource(e.target.value)
                    runPreview(previewStep, e.target.value, previewPlatform)
                  }}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                  {magnets.length === 0 && packages.length === 0 && (
                    <option value="">Нет лид-магнитов и пакетов</option>
                  )}
                  {magnets.length > 0 && (
                    <optgroup label="Лид-магниты">
                      {magnets.map((m: any) => (
                        <option key={`m${m.id}`} value={`m:${m.id}`}>{m.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {packages.length > 0 && (
                    <optgroup label="Пакеты">
                      {packages.map((p: any) => (
                        <option key={`p${p.id}`} value={`p:${p.id}`}>{p.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              {/* Площадка — от неё зависит {support_platform} и канал подписки */}
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Площадка</label>
                <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                  {(['telegram', 'vk', 'max'] as const).map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        setPreviewPlatform(p)
                        runPreview(previewStep, previewSource, p)
                      }}
                      className={`px-3 py-1.5 border-l first:border-l-0 border-gray-200 ${
                        previewPlatform === p ? 'bg-brand text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                      }`}
                      style={previewPlatform === p ? { background: 'linear-gradient(45deg,#25455D,#0a1520)' } : {}}>
                      {p === 'telegram' ? 'Telegram' : p === 'vk' ? 'ВКонтакте' : 'MAX'}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-gray-400 mt-1">
                  От площадки зависит {'{support_platform}'} и ссылка на канал подписки.
                </p>
              </div>

              {/* Само сообщение */}
              <div className="rounded-xl border border-gray-200 bg-[#eef7e6] p-4">
                {previewLoading ? (
                  <p className="text-sm text-gray-400">Собираем сообщение…</p>
                ) : previewErr ? (
                  <p className="text-sm text-red-600">{previewErr}</p>
                ) : (
                  <div
                    className="text-sm text-gray-800 whitespace-pre-wrap break-words"
                    style={{ overflowWrap: 'anywhere' }}
                    dangerouslySetInnerHTML={{ __html: previewText || '<span class="text-gray-400">Текст пустой</span>' }}
                  />
                )}
                {(previewStep === 'text_1') && data.button_label && (
                  <div className="mt-3 pt-3 border-t border-gray-200 text-center text-sm font-medium text-blue-700">
                    {data.button_label}
                  </div>
                )}
              </div>

              <p className="text-[11px] text-gray-400">
                Показан текст из формы (даже несохранённый). В ВКонтакте HTML-теги срежутся — останется чистый текст и ссылки.
              </p>
            </div>

            <div className="p-5 pt-0">
              <button onClick={() => setPreviewStep(null)}
                      className="w-full py-2 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}

      {err && <div className="text-sm text-red-600">{err}</div>}

      <button onClick={save} disabled={saving}
              className="px-5 py-2.5 rounded-lg text-white font-medium disabled:opacity-50"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        {saving ? 'Сохраняем…' : saved ? 'Сохранено ✓' : 'Сохранить шаблон'}
      </button>
    </div>
  )
}

// ============== Аналитика ==============

function AnalyticsModal({ kind, item, onClose }: {
  kind: 'm' | 'p'; item: { id: number; name: string }; onClose: () => void
}) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  // Только два состояния: «Перешли» (все с contact_id) или «Получили» (delivered)
  const [filter, setFilter] = useState<'all' | 'delivered'>('all')

  useEffect(() => {
    const fn = kind === 'm' ? api.leadMagnets.analytics : api.leadMagnetPackages.analytics
    fn(item.id).then(setData).catch(e => alert(e.message)).finally(() => setLoading(false))
  }, [kind, item.id])

  // Показываем только тех, у кого есть contact_id — без него имя/платформа неизвестны
  // и строка бесполезна. Анонимные landed только в счётчике (если бы хотели — но мы их тоже отключили).
  const runs = (data?.runs || []).filter((r: any) => {
    if (!r.contact_id) return false
    if (filter === 'delivered') return r.stage === 'delivered'
    return true
  })

  // counts.started в API = записи с contact_id (stage IN started/subscribed/delivered)
  const reached = data?.counts?.started || 0
  const received = data?.counts?.delivered || 0

  return (
    <Modal title={`Аналитика: ${item.name}`} onClose={onClose} large>
      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Counter label="Перешли по ссылке" value={reached} active={filter === 'all'} onClick={() => setFilter('all')} />
            <Counter label="Получили материалы" value={received} active={filter === 'delivered'} onClick={() => setFilter('delivered')} />
          </div>

          {runs.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-6">Нет данных</div>
          ) : (
            <div className="border border-gray-200 rounded-lg max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2">Дата</th>
                    <th className="text-left px-3 py-2">Кто</th>
                    <th className="text-left px-3 py-2">Этап</th>
                    <th className="text-left px-3 py-2">UTM</th>
                    <th className="text-left px-3 py-2">Привёл</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {runs.map((r: any) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-xs text-gray-500">{formatDt(r.landed_at)}</td>
                      <td className="px-3 py-2">
                        <a href={`/dashboard/clients?contact=${r.contact_id}`} className="text-[#25455D] hover:underline inline-flex items-center gap-1.5">
                          <PlatformBadge slug={r.platform_slug} />
                          <span>{r.contact_username ? `@${r.contact_username}` : (r.contact_name || `#${r.contact_id}`)}</span>
                        </a>
                      </td>
                      <td className="px-3 py-2"><StageBadge stage={r.stage} /></td>
                      <td className="px-3 py-2 text-xs text-gray-500">{(r.utm && r.utm.utm_source) || '—'}</td>
                      <td className="px-3 py-2">
                        {r.referrer_contact_id ? (
                          <a href={`/dashboard/clients?contact=${r.referrer_contact_id}`} className="text-[#25455D] hover:underline text-xs">
                            {r.referrer_username ? `@${r.referrer_username}` : (r.referrer_name || `#${r.referrer_contact_id}`)}
                          </a>
                        ) : <span className="text-gray-400 text-xs">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function Counter({ label, value, active, onClick }: { label: string; value: number; active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick}
            className={`p-3 rounded-lg border text-left transition-colors ${
              active ? 'border-[#25455D] bg-[#25455D] text-white' : 'border-gray-200 bg-white hover:border-gray-300'
            }`}>
      <div className={`text-2xl font-bold ${active ? 'text-white' : 'text-[#25455D]'}`}>{value}</div>
      <div className={`text-xs mt-0.5 ${active ? 'text-white/80' : 'text-gray-500'}`}>{label}</div>
    </button>
  )
}

function StageBadge({ stage }: { stage: string }) {
  // После того как мы скрыли строки без contact_id, остаются только started/subscribed/delivered.
  // started/subscribed — это люди, которые дошли до бота (= «Перешёл» в новой терминологии).
  if (stage === 'delivered') {
    return <span className="text-xs px-2 py-0.5 rounded bg-green-50 text-green-700">Получил</span>
  }
  return <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">Перешёл</span>
}

function PlatformBadge({ slug }: { slug: string | null | undefined }) {
  const map: Record<string, { label: string; color: string }> = {
    telegram: { label: 'TG', color: 'bg-[#2AABEE]/10 text-[#2AABEE]' },
    vk:       { label: 'VK', color: 'bg-[#0077FF]/10 text-[#0077FF]' },
    max:      { label: 'MAX', color: 'bg-[#FFCFA4]/30 text-[#25455D]' },
  }
  const m = slug ? map[slug] : null
  if (!m) return null
  return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${m.color}`}>{m.label}</span>
}

// ============== Утилиты ==============

type PlatformKey = 'telegram' | 'vk' | 'max'

const PLATFORM_META: Record<PlatformKey, { label: string; color: string; Icon: (p: { size?: number }) => JSX.Element }> = {
  telegram: {
    label: 'Telegram',
    color: '#229ED9',
    Icon: ({ size = 14 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.43 3.64 12.1c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>
      </svg>
    ),
  },
  vk: {
    label: 'VK',
    color: '#0077FF',
    Icon: ({ size = 14 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M13.16 17.46c-5.46 0-8.57-3.75-8.7-9.98h2.74c.09 4.58 2.1 6.51 3.7 6.91V7.48h2.58v3.95c1.57-.17 3.23-1.96 3.79-3.95h2.58c-.43 2.45-2.22 4.25-3.49 4.99 1.27.6 3.31 2.17 4.08 5.0h-2.84c-.6-1.87-2.12-3.32-4.12-3.52v3.52h-.32z"/>
      </svg>
    ),
  },
  max: {
    label: 'MAX',
    color: '#F45D22',
    Icon: ({ size = 14 }) => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M3 4h2.5l3.5 6 3.5-6H15v16h-2.5V9.4L9 15.4 5.5 9.4V20H3V4zm14 0h2.4l3.6 16h-2.5l-.8-3.6h-3l-.8 3.6h-2.5L17 4zm.3 9.8h2l-1-4.6-1 4.6z"/>
      </svg>
    ),
  },
}

// Кнопка «копировать уникальный идентификатор» (слаг) — спикеры вставляют его
// в кабинете, чтобы привязать лид-магнит как подарок (миграция 167).
function CopyIdButton({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => navigator.clipboard.writeText(slug).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })}
      title="Скопировать уникальный идентификатор — спикер вставит его в своём кабинете, чтобы привязать этот подарок"
      className="inline-flex items-center gap-1 text-[11px] mt-1 px-1.5 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
    >
      {copied ? <Check size={11} className="text-green-600" /> : <Copy size={11} className="text-gray-400" />}
      <span className="font-mono">ID: {slug}</span>
    </button>
  )
}

function PlatformShareLinks({ kind, slug, links, name, blocked }: {
  kind: 'm' | 'p'
  slug: string
  links?: PlatformLinks
  name?: string
  blocked?: boolean
}) {
  // Ссылки строятся ТОЛЬКО из platform_links, которые отдал бэк — по площадкам,
  // где у клиента подключён СВОЙ бот/сообщество. Системный @pluson_bot больше не
  // подставляется (с 2026-07-08): у клиента без своего бота ссылки на этой
  // площадке нет — показываем подсказку подключить канал, а не мёртвую ссылку
  // на чужой бот.
  const resolved: PlatformLinks = links || {}
  const order: PlatformKey[] = ['telegram', 'vk', 'max']
  const available = order.filter(p => resolved[p])
  if (available.length === 0) {
    return (
      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
        Нет подключённого бота. Подключите свой бот в разделе{' '}
        <a href="/dashboard/channels" className="underline font-medium">Каналы</a>, чтобы получить ссылку.
      </div>
    )
  }
  // Бот не админ в каналах основателя → воронка не сможет проверить подписку и
  // лид-магнит не отдастся. Пока не настроено — ссылки размыты и заблокированы,
  // сверху объяснение (чтобы клиент не гадал «почему материал не приходит»).
  if (blocked) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-2.5">
        <div className="flex items-start gap-2 text-xs text-red-800 mb-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div>
            <b>Бот не в админах канала.</b> Пока не добавите бота администратором в
            канал(ы) основателя, воронка не проверит подписку — материал не выдаётся.
            <a href="/dashboard/mini-app?tab=owner" className="underline font-medium ml-1">Настроить каналы →</a>
          </div>
        </div>
        <div className="relative">
          <div className="flex flex-col gap-1 blur-sm select-none pointer-events-none">
            {available.map(p => (
              <PlatformLinkRow key={p} platform={p} url={resolved[p] as string} slug={slug} kind={kind} name={name} />
            ))}
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      {available.map(p => (
        <PlatformLinkRow key={p} platform={p} url={resolved[p] as string} slug={slug} kind={kind} name={name} />
      ))}
    </div>
  )
}

// URL картинки QR-кода (PNG) через quickchart.io — генерится на лету, без
// npm-зависимостей. color = 'black' | 'white' (цвет модулей),
// bg = 'transparent' | 'contrast' (прозрачный фон ИЛИ контрастный:
// белый под чёрный QR / чёрный под белый QR).
function qrPngUrl(
  data: string,
  opts: { color?: 'black' | 'white'; bg?: 'transparent' | 'contrast'; size?: number } = {}
): string {
  const { color = 'black', bg = 'contrast', size = 600 } = opts
  const dark = color === 'white' ? 'ffffff' : '000000'
  const light = bg === 'transparent'
    ? '00000000'
    : (color === 'white' ? '000000' : 'ffffff')   // контрастный фон
  return `https://quickchart.io/qr?text=${encodeURIComponent(data)}&size=${size}&margin=2&dark=${dark}&light=${light}&ecLevel=M&format=png`
}

function PlatformLinkRow({ platform, url, slug, kind, name }: { platform: PlatformKey; url: string; slug: string; kind: 'm' | 'p'; name?: string }) {
  const [copied, setCopied] = useState(false)
  const [qrOpen, setQrOpen] = useState(false)
  const meta = PLATFORM_META[platform]

  function copy() {
    navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }

  return (
    <div className="flex items-center gap-1.5 text-xs min-w-0">
      <span
        className="inline-flex items-center justify-center w-4 h-4 shrink-0"
        style={{ color: meta.color }}
        title={meta.label}
      >
        <meta.Icon size={14} />
      </span>
      <span className="font-mono text-gray-500 truncate flex-1 min-w-0">{url}</span>
      <IconBtn tip="Скопировать ссылку" onClick={copy} disabled={false}>
        {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} className="text-gray-400" />}
      </IconBtn>
      <IconBtn tip="QR-код" onClick={() => setQrOpen(true)} disabled={false}>
        <QrCode size={12} className="text-gray-400" />
      </IconBtn>
      {qrOpen && (
        <QrModal url={url} platform={platform} slug={slug} kind={kind} name={name} onClose={() => setQrOpen(false)} />
      )}
    </div>
  )
}

// Модалка QR-кода: вкладки цвета (Чёрный / Белый) + радио фона
// (Прозрачный / Контрастный) + превью + скачать/скопировать.
function QrModal({ url, platform, slug, kind, name, onClose }: {
  url: string; platform: PlatformKey; slug: string; kind: 'm' | 'p'; name?: string; onClose: () => void
}) {
  const [color, setColor] = useState<'black' | 'white'>('black')
  const [bg, setBg] = useState<'transparent' | 'contrast'>('contrast')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const meta = PLATFORM_META[platform]
  const previewUrl = qrPngUrl(url, { color, bg, size: 360 })
  const safeName = (name || slug).replace(/[^a-zа-я0-9]+/gi, '_').slice(0, 40)
  const fileName = `qr-${safeName}-${platform}-${color}-${bg}.png`

  // Шахматный фон под превью — чтобы прозрачность была видна.
  const checker = 'repeating-conic-gradient(#e5e7eb 0% 25%, #fff 0% 50%) 50% / 16px 16px'

  async function downloadQr() {
    setBusy(true)
    try {
      const resp = await fetch(qrPngUrl(url, { color, bg }))
      const blob = await resp.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href; a.download = fileName
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(href)
    } catch {
      window.open(qrPngUrl(url, { color, bg }), '_blank')
    } finally { setBusy(false) }
  }

  async function copyQr() {
    setBusy(true)
    try {
      const resp = await fetch(qrPngUrl(url, { color, bg }))
      const blob = await resp.blob()
      let pngBlob = blob
      if (blob.type !== 'image/png') {
        pngBlob = await new Promise<Blob>((resolve, reject) => {
          const img = new Image()
          img.onload = () => {
            const cv = document.createElement('canvas')
            cv.width = img.width; cv.height = img.height
            cv.getContext('2d')!.drawImage(img, 0, 0)
            cv.toBlob(b => b ? resolve(b) : reject(new Error('no blob')), 'image/png')
          }
          img.onerror = reject
          img.src = URL.createObjectURL(blob)
        })
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    } catch {
      alert('Не удалось скопировать картинку в этом браузере. Используйте «Скачать».')
    } finally { setBusy(false) }
  }

  return (
    <Modal title={`QR-код · ${meta.label}`} onClose={onClose}>
      <div className="space-y-4">
        {/* Что именно скачиваешь — название лид-магнита / пакета */}
        {name && (
          <div className="rounded-xl bg-[#FFF6EE] border border-[#FFCFA4] px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">
              {kind === 'p' ? 'Пакет' : 'Лид-магнит'}
            </p>
            <p className="text-sm font-semibold text-[#25455D] break-words">{name}</p>
          </div>
        )}
        {/* Вкладки цвета */}
        <div>
          <p className="text-xs font-medium text-gray-700 mb-1.5">Цвет кода</p>
          <div className="flex gap-2">
            {(['black', 'white'] as const).map(c => (
              <button key={c} type="button" onClick={() => setColor(c)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${
                  color === c ? 'border-transparent text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                style={color === c ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : {}}>
                {c === 'black' ? 'Чёрный' : 'Белый'}
              </button>
            ))}
          </div>
        </div>

        {/* Радио фона */}
        <div>
          <p className="text-xs font-medium text-gray-700 mb-1.5">Фон</p>
          <div className="flex flex-col gap-1.5">
            {([['transparent', 'Прозрачный'],
               ['contrast', color === 'white' ? 'Контрастный (чёрный)' : 'Контрастный (белый)']] as const).map(([v, lbl]) => (
              <label key={v} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="radio" name="qrbg" checked={bg === v} onChange={() => setBg(v as any)} />
                {lbl}
              </label>
            ))}
          </div>
        </div>

        {/* Превью на шахматке */}
        <div className="flex justify-center">
          <div className="p-3 rounded-xl border border-gray-200" style={{ background: checker }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="QR" width={180} height={180} className="block" />
          </div>
        </div>

        {color === 'white' && bg === 'transparent' && (
          <p className="text-[11px] text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
            Белый QR на прозрачном фоне читается только на тёмном фоне (афиша, баннер).
          </p>
        )}

        {/* Действия */}
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={copyQr} disabled={busy}
            className="flex-1 py-2.5 rounded-lg text-sm font-semibold border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5">
            {copied ? <><Check size={14} className="text-green-600" /> Скопировано</> : <><QrCode size={14} /> Скопировать</>}
          </button>
          <button type="button" onClick={downloadQr} disabled={busy}
            className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white disabled:opacity-50 flex items-center justify-center gap-1.5"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <Download size={14} /> Скачать
          </button>
        </div>
      </div>
    </Modal>
  )
}

// Кнопка-иконка с мгновенной CSS-подсказкой при наведении (group/tooltip).
function IconBtn({ tip, onClick, disabled, children }: {
  tip: string; onClick: () => void; disabled: boolean; children: React.ReactNode
}) {
  return (
    <span className="relative group/tip shrink-0">
      <button type="button" onClick={onClick} disabled={disabled}
        className="p-1 rounded hover:bg-gray-100 disabled:opacity-40 flex items-center">
        {children}
      </button>
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1
        rounded-md bg-gray-900 text-white text-[11px] whitespace-nowrap opacity-0 group-hover/tip:opacity-100
        transition-opacity z-20">
        {tip}
      </span>
    </span>
  )
}

function EmptyState({ icon: Icon, text, onCreate }: { icon: any; text: string; onCreate: () => void }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
      <Icon className="mx-auto mb-3 text-gray-300" size={40} />
      <p className="text-gray-500 text-sm mb-4">{text}</p>
      <button onClick={onCreate} className="text-sm underline" style={{ color: DARK }}>Создать первый</button>
    </div>
  )
}

function Modal({ title, onClose, children, large }: {
  title: string; onClose: () => void; children: React.ReactNode; large?: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className={`bg-white rounded-xl w-full p-6 max-h-[90vh] overflow-y-auto ${large ? 'max-w-2xl' : 'max-w-md'}`}
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold" style={{ color: DARK }}>{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  )
}

function FormActions({ saving, onClose }: { saving: boolean; onClose: () => void }) {
  return (
    <div className="flex gap-2 justify-end pt-2">
      <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Отмена</button>
      <button type="submit" disabled={saving}
              className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        {saving ? 'Сохраняю…' : 'Сохранить'}
      </button>
    </div>
  )
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

function formatDt(v: string) {
  if (!v) return ''
  const d = new Date(v)
  return d.toLocaleString('ru', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}
