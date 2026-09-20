'use client'
import { useState, useEffect } from 'react'
import {
  Plus, X, Trash2, Edit2, Megaphone, Crown, ArrowRight,
  CheckCircle2, Loader2, Link2, Check, Lock, ChevronDown,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import QrLinkButton from '@/components/QrLinkButton'

/**
 * Вкладка «Группы/Каналы для рассылок» в /dashboard/channels.
 *
 * База внешних групп/каналов клиента (client_broadcast_chats, фича broadcast_chats).
 * Доступна только на тарифе с фичей broadcast_chats (Экстра). Если фичи нет —
 * показываем апсейл-заглушку с динамическим названием и ценой тарифа
 * (берём из api.publicData.tariffs() — НЕ хардкодим).
 *
 * Когда чаты добавлены — в рассылке (общей или в событии) клиент ставит
 * галочку «Отправлять в общие чаты», и рассылка дублируется в эти чаты.
 */

type Platform = 'telegram' | 'vk' | 'max' | 'whatsapp'

interface BroadcastChat {
  id: number
  platform: Platform
  chat_id: string
  title: string | null
  chat_url: string | null
  is_public: boolean
  added_via: string | null
  is_active: boolean
  use_for_broadcasts: boolean
  is_private: boolean
  created_at: string
}

const PLATFORM_META: Record<Platform, { label: string; badge: string; color: string }> = {
  telegram: { label: 'Telegram',  badge: 'TG',  color: '#229ED9' },
  vk:       { label: 'ВКонтакте', badge: 'VK',  color: '#0077FF' },
  max:      { label: 'MAX',       badge: 'MX',  color: '#F45D22' },
  whatsapp: { label: 'WhatsApp',  badge: 'WA',  color: '#25D366' },
}

function PlatformBadge({ platform }: { platform: Platform }) {
  const meta = PLATFORM_META[platform]
  return (
    <span
      className="inline-flex items-center justify-center w-7 h-7 rounded-full text-[10px] font-bold text-white shrink-0"
      style={{ background: meta.color }}
    >
      {meta.badge}
    </span>
  )
}

/* ─────── Сворачиваемая группа чатов по площадке ─────── */
function CollapsibleChatGroup({ platform, count, children }: {
  platform: Platform
  count: number
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      {/* Чёткая персиковая плашка-заголовок площадки */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 text-left px-4 py-3"
        style={{ background: '#FFF3E8' }}
      >
        <PlatformBadge platform={platform} />
        <span className="text-sm font-bold uppercase tracking-wide" style={{ color: '#25455D' }}>
          {PLATFORM_META[platform].label}
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
      {open && <div className="p-3 space-y-2 bg-white">{children}</div>}
    </div>
  )
}

export default function BroadcastChatsTab() {
  const { me } = useMe()
  const [chats, setChats] = useState<BroadcastChat[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<BroadcastChat | null>(null)
  // Тариф с фичей broadcast_chats (для апсейл-заглушки) — подтягиваем динамически.
  const [upsellTariff, setUpsellTariff] = useState<{ name: string; price: number } | null>(null)
  // Уровень доступа с бэка: 'unlimited' (доступ есть, число чатов не ограничено) | null.
  // ⚠️ Уровень 'one' (по одному чату на площадку) удалён миграцией 353 — он не
  // срабатывал ни у одного клиента, а в интерфейсе обещал ограничение, которого нет.
  const [accessLevel, setAccessLevel] = useState<'unlimited' | null>(null)

  // Доступ к разделу — любая из двух фич (по одному / безлимит).
  const hasFeature = (me?.features || []).includes('broadcast_chats')

  const load = async () => {
    setLoading(true)
    try {
      const r: any = await api.miniApp.broadcastChats.list()
      setChats(r.chats || [])
      setAccessLevel(r.access_level ?? null)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (hasFeature) load()
    else setLoading(false)
  }, [hasFeature])

  // Для заглушки: ищем тариф, у которого в фичах есть broadcast_chats (не admin).
  useEffect(() => {
    if (hasFeature) return
    if (me === null) return // ждём загрузки me, чтобы не дёргать зря
    api.publicData.tariffs().then((r: any) => {
      const list: any[] = r?.tariffs || r?.items || (Array.isArray(r) ? r : [])
      // Ищем самый дешёвый тариф, дающий ЛЮБОЙ уровень доступа к чатам (по одному
      // на площадку или безлимит) — чтобы показать минимальную цену входа.
      const candidates = list.filter(x =>
        (x.slug !== 'admin') &&
        (x.feature_slugs || x.features || []).includes('broadcast_chats')
      ).sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0))
      const t = candidates[0]
      if (t) setUpsellTariff({ name: t.name, price: Number(t.price) || 0 })
    }).catch(() => {})
  }, [hasFeature, me])

  // ── Апсейл-заглушка (фичи нет) ──
  if (!hasFeature) {
    return (
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
            <span>Чаты и группы для рассылок</span>
          </div>
          <h2 className="text-xl font-bold mb-2">Рассылки в ваши группы и каналы</h2>
          <p className="text-white/75 text-sm mb-5 max-w-lg">
            Добавляйте свои группы и каналы, чтобы рассылки уходили и в них.
            {upsellTariff
              ? <> Доступно на тарифе <b style={{ color: '#FFCFA4' }}>{upsellTariff.name}</b> — {upsellTariff.price.toLocaleString('ru')} ₽.</>
              : ' Доступно на расширенном тарифе.'}
          </p>

          <ul className="text-sm text-white/85 space-y-2 mb-5">
            <li className="flex items-center gap-2">
              <CheckCircle2 size={16} style={{ color: '#FFCFA4' }} />
              Своя база групп и каналов в Telegram, VK и MAX
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 size={16} style={{ color: '#FFCFA4' }} />
              Рассылки уходят сразу и подписчикам, и в чаты
            </li>
          </ul>

          <button
            onClick={() => { window.location.href = '/dashboard/subscription' }}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm"
            style={{ background: '#FFCFA4', color: '#25455D' }}
          >
            Перейти на тариф <ArrowRight size={16} />
          </button>
        </div>
      </div>
    )
  }

  // ── Список чатов (фича есть) ──
  if (loading) {
    return <div className="py-10 text-center text-gray-400 text-sm">Загрузка...</div>
  }

  const grouped: { platform: Platform; items: BroadcastChat[] }[] = (['telegram', 'vk', 'max', 'whatsapp'] as const)
    .map(p => ({ platform: p, items: chats.filter(c => c.platform === p) }))
    .filter(g => g.items.length > 0)

  // Площадки, где уже есть хотя бы один чат.
  const usedPlatforms = new Set<Platform>(chats.map(c => c.platform))
  // Ограничения по числу чатов больше нет — кнопка «Добавить» доступна всегда.
  const allPlatformsUsed = false

  // Кнопка «Добавить чат» — общая (используется в empty-state и под списком).
  const AddBtn = ({ full }: { full?: boolean }) => {
    if (allPlatformsUsed) {
      return (
        <div className={`${full ? 'w-full' : ''} text-center`}>
          <button
            disabled
            className={`${full ? 'w-full' : ''} py-3 px-4 rounded-xl border border-gray-200 text-sm text-gray-400 flex items-center justify-center gap-2 cursor-not-allowed bg-gray-50`}
          >
            <Lock size={15} /> Добавить чат
          </button>
          <p className="text-xs text-amber-700 mt-2">
            На тарифе Профи — по одному чату на каждую площадку (Telegram, VK, MAX).
            Неограниченное число чатов доступно на тарифе <b>Экстра</b>.{' '}
            <a href="/dashboard/subscription" className="underline">Перейти</a>
          </p>
        </div>
      )
    }
    return (
      <button
        onClick={() => setCreating(true)}
        className={full
          ? 'w-full py-3 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-2'
          : 'inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm text-white'}
        style={full ? undefined : { background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
      >
        <Plus size={16} /> Добавить чат
      </button>
    )
  }

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-900">
        <Megaphone size={16} className="inline mr-1.5 -mt-0.5" />
        Сюда добавляйте группы и каналы, в которые хотите дополнительно слать рассылки.
        Потом в рассылке поставьте галочку <b>«Отправлять в общие чаты»</b> — и она уйдёт ещё и в них.
      </div>



      {chats.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-8 text-center">
          <p className="text-sm text-gray-500 mb-4">Пока нет ни одного чата для рассылок.</p>
          <AddBtn />
        </div>
      ) : (
        <>
          {grouped.map(group => (
            <CollapsibleChatGroup
              key={group.platform}
              platform={group.platform}
              count={group.items.length}
            >
              {group.items.map(chat => (
                <ChatCard
                  key={chat.id}
                  chat={chat}
                  onEdit={() => setEditing(chat)}
                  onChanged={load}
                  onDeleted={load}
                />
              ))}
            </CollapsibleChatGroup>
          ))}

          <AddBtn full />
        </>
      )}

      {creating && (
        <AddChatModal
          accessLevel={accessLevel}
          usedPlatforms={usedPlatforms}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load() }}
        />
      )}

      {editing && (
        <RenameChatModal
          chat={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}

    </div>
  )
}

/* ─────── Карточка чата ─────── */
function ChatCard({ chat, onEdit, onChanged, onDeleted }: {
  chat: BroadcastChat
  onEdit: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const [saving, setSaving] = useState(false)
  async function toggleUse() {
    setSaving(true)
    try {
      await api.miniApp.broadcastChats.update(chat.id, { use_for_broadcasts: !chat.use_for_broadcasts })
      onChanged()
    } catch (e: any) {
      alert('Не удалось сохранить: ' + (e.message || ''))
    } finally { setSaving(false) }
  }
  async function togglePrivate() {
    setSaving(true)
    try {
      await api.miniApp.broadcastChats.update(chat.id, { is_private: !chat.is_private })
      onChanged()
    } catch (e: any) {
      alert('Не удалось сохранить: ' + (e.message || ''))
    } finally { setSaving(false) }
  }
  async function remove() {
    if (!confirm(`Удалить чат «${chat.title || chat.chat_id}» из базы рассылок?`)) return
    try {
      await api.miniApp.broadcastChats.delete(chat.id)
      onDeleted()
    } catch (e: any) {
      alert('Не удалось удалить: ' + (e.message || ''))
    }
  }

  return (
    <div className="bg-white rounded-2xl border card-border shadow-sm p-4 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold text-gray-900 truncate">
          {chat.title || <span className="text-gray-400 font-normal">Без названия</span>}
        </h3>
        <div className="flex items-center gap-2 flex-wrap mt-0.5">
          <span className="text-xs font-mono text-gray-500">{chat.chat_id}</span>
          {chat.chat_url && (
            <>
              <a
                href={chat.chat_url}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1 text-xs text-[#25455D] underline truncate max-w-[180px]"
              >
                <Link2 size={11} /> ссылка
              </a>
              {/* QR на приглашение в чат — чтобы показать с экрана или
                  поставить на афишу, не пересылая ссылку текстом. */}
              <QrLinkButton
                url={chat.chat_url}
                name={chat.title || 'Чат'}
                iconSize={13}
              />
            </>
          )}
        </div>
        {/* ⚠️ Чат без ссылки виден в кабинете, но кнопка «Чат» по нему НЕ появится
            ни в Mini App, ни в меню бота: и там и там площадка берётся по наличию
            chat_url (см. ChatGate.tsx). Молчать нельзя — клиент добавил чат,
            видит его в списке и считает, что всё готово; так у клиента 191
            TG-чат был выбран в событии, а участники видели только MAX. */}
        {!chat.chat_url && (
          <p className="mt-1 text-xs text-red-600">
            Нет ссылки — кнопка «Чат» по этому чату не покажется ни в Mini App, ни в боте.
            Добавьте ссылку через «Изменить»: в Telegram она в чате → Управление → Пригласительные ссылки.
          </p>
        )}
        <label className="flex items-center gap-1.5 mt-2 text-xs text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={chat.use_for_broadcasts}
            disabled={saving}
            onChange={toggleUse}
            className="accent-[#25455D] w-4 h-4"
          />
          Использовать для рассылок анонсов
        </label>
        <label className="flex items-center gap-1.5 mt-1 text-xs text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={chat.is_private}
            disabled={saving}
            onChange={togglePrivate}
            className="accent-[#25455D] w-4 h-4"
          />
          Личный канал
          <span className="text-gray-400">— в рассылке отдельная галочка «в личные каналы»</span>
        </label>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={onEdit}
          className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 hover:text-[#25455D]"
          title="Переименовать"
        ><Edit2 size={14} /></button>
        <button
          onClick={remove}
          className="p-2 hover:bg-red-50 rounded-lg text-gray-500 hover:text-red-500"
          title="Удалить"
        ><Trash2 size={14} /></button>
      </div>
    </div>
  )
}

/* ─────── Модалка добавления ─────── */
function AddChatModal({ accessLevel, usedPlatforms, onClose, onSaved }: {
  accessLevel: 'unlimited' | null
  usedPlatforms: Set<Platform>
  onClose: () => void
  onSaved: () => void
}) {
  // Замков по площадкам больше нет: чатов можно добавлять сколько угодно.
  const isLocked = (_p: Platform) => false
  // Стартовая площадка.
  const firstFree = (['telegram', 'vk', 'max'] as const).find(p => !isLocked(p)) || 'telegram'
  const [platform, setPlatform] = useState<Platform>(firstFree)
  const [url, setUrl] = useState('')
  const [chatId, setChatId] = useState('')
  const [title, setTitle] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [addedVia, setAddedVia] = useState<'link' | 'manual'>('manual')
  const [resolving, setResolving] = useState(false)
  const [resolveErr, setResolveErr] = useState('')
  const [resolvedOk, setResolvedOk] = useState(false)
  const [saving, setSaving] = useState(false)

  // WhatsApp — чаты выбираются из привязанного аккаунта (ID вручную не вписать).
  const [waChats, setWaChats] = useState<{ id: string; name: string; isGroup: boolean }[]>([])
  const [waLoading, setWaLoading] = useState(false)
  const [waErr, setWaErr] = useState('')
  const [waSaved, setWaSaved] = useState<Set<string>>(new Set())
  const [waSearch, setWaSearch] = useState('')

  const loadWaChats = async () => {
    setWaLoading(true); setWaErr('')
    try {
      const [r, saved]: any = await Promise.all([
        api.channels.whatsappChats(),
        api.miniApp.broadcastChats.list(),
      ])
      setWaChats(r.chats || [])
      const savedRows: any[] = saved?.chats || []
      setWaSaved(new Set(savedRows.filter((x: any) => x.platform === 'whatsapp').map((x: any) => x.chat_id)))
    } catch (e: any) {
      setWaErr(e?.message || 'WhatsApp не подключён. Привяжите аккаунт: вкладка «Боты» → «Добавить канал» → WhatsApp.')
    } finally { setWaLoading(false) }
  }

  useEffect(() => {
    if (platform === 'whatsapp' && waChats.length === 0 && !waErr) loadWaChats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform])

  const toggleWa = async (c: { id: string; name: string }) => {
    const isSaved = waSaved.has(c.id)
    try {
      if (isSaved) {
        const listResp: any = await api.miniApp.broadcastChats.list()
        const row = (listResp?.chats || []).find((x: any) => x.platform === 'whatsapp' && x.chat_id === c.id)
        if (row) await api.miniApp.broadcastChats.delete(row.id)
        setWaSaved(prev => { const n = new Set(prev); n.delete(c.id); return n })
      } else {
        await api.miniApp.broadcastChats.create({
          platform: 'whatsapp', chat_id: c.id, title: c.name, is_public: false, added_via: 'manual',
        })
        setWaSaved(prev => new Set(prev).add(c.id))
      }
      onSaved()  // обновить список чатов на странице
    } catch (e: any) {
      alert(e?.message || 'Не удалось изменить список')
    }
  }

  const canResolve = platform !== 'max' && platform !== 'whatsapp'

  async function resolve() {
    setResolveErr('')
    setResolvedOk(false)
    if (!url.trim()) {
      setResolveErr('Сначала вставьте ссылку на группу или канал')
      return
    }
    setResolving(true)
    try {
      const r: any = await api.miniApp.broadcastChats.resolve({ platform, url: url.trim() })
      if (r?.chat_id) {
        setChatId(String(r.chat_id))
        if (r.title) setTitle(r.title)
        setIsPublic(r.is_public ?? true)
        setAddedVia('link')
        setResolvedOk(true)
      } else {
        setResolveErr('Не удалось определить ID. Впишите ID и название вручную.')
      }
    } catch (e: any) {
      setResolveErr((e.message || 'Не удалось определить ID') + '. Впишите ID и название вручную.')
    } finally {
      setResolving(false)
    }
  }

  async function save() {
    if (!chatId.trim()) {
      alert('Укажите ID чата')
      return
    }
    // ⚠️ Без ссылки чат бесполезен: везде, где человеку предлагают войти
    // (меню бота, письмо о регистрации, воронка догрева, {chats} в рассылке),
    // показывается именно ССЫЛКА. По номеру перейти некуда, и площадка просто
    // исчезает из списка — так у коллаб-события пропал Telegram-чат.
    // WhatsApp — исключение: там чат выбирают из списка аккаунта, ссылки нет.
    if (platform !== 'whatsapp' && !url.trim()) {
      alert('Добавьте ссылку-приглашение в чат.\n\nБез неё людям некуда переходить — чат не появится ни в меню бота, ни в письмах, ни в рассылках.')
      return
    }
    setSaving(true)
    try {
      await api.miniApp.broadcastChats.create({
        platform,
        chat_id: chatId.trim(),
        title: title.trim() || null,
        chat_url: url.trim() || null,
        is_public: isPublic,
        added_via: addedVia,
      })
      onSaved()
    } catch (e: any) {
      alert('Не удалось добавить: ' + (e.message || ''))
    } finally {
      setSaving(false)
    }
  }

  return (
    // ⚠️ Модалка НЕ закрывается по клику на фон (правило проекта) — только крестик / «Отмена».
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto scroll-visible">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Plus size={18} style={{ color: '#FFCFA4' }} /> Добавить чат для рассылок
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Платформа — сегмент */}
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">Площадка</label>
            <div className="flex gap-2 flex-wrap">
              {(['telegram', 'vk', 'max', 'whatsapp'] as const).map(p => {
                const meta = PLATFORM_META[p]
                const active = platform === p
                const locked = isLocked(p)
                return (
                  <button
                    key={p}
                    type="button"
                    disabled={locked}
                    title={locked ? 'На тарифе Профи уже добавлен чат для этой площадки. Безлимит — на Экстра.' : undefined}
                    onClick={() => {
                      if (locked) return
                      setPlatform(p)
                      setResolvedOk(false)
                      setResolveErr('')
                    }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                      locked
                        ? 'text-gray-300 border-gray-100 bg-gray-50 cursor-not-allowed'
                        : active ? 'text-white border-transparent' : 'text-gray-600 border-gray-200 bg-white hover:bg-gray-50'
                    }`}
                    style={active && !locked ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : undefined}
                  >
                    {locked ? (
                      <Lock size={14} className="text-gray-300" />
                    ) : (
                      <span
                        className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[9px] font-bold text-white"
                        style={{ background: meta.color }}
                      >{meta.badge}</span>
                    )}
                    {meta.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* WhatsApp — выбор чатов из привязанного аккаунта (ID вручную не вписать) */}
          {platform === 'whatsapp' ? (
            <div>
              {waLoading ? (
                <div className="flex items-center gap-2 text-gray-500 text-sm py-6 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" /> Загружаю чаты вашего WhatsApp…
                </div>
              ) : waErr ? (
                <div className="text-sm text-rose-600 py-4 text-center">
                  {waErr}
                  <div><button type="button" onClick={loadWaChats} className="mt-3 text-sm underline text-gray-600">Повторить</button></div>
                </div>
              ) : (
                <>
                  <input
                    value={waSearch}
                    onChange={e => setWaSearch(e.target.value)}
                    placeholder="Поиск по названию…"
                    className="w-full mb-2 rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  />
                  <p className="text-[11px] text-gray-500 mb-2">Отметьте конкретные чаты — в них будет уходить рассылка при галочке «слать в общие чаты».</p>
                  <div className="max-h-72 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded-lg">
                    {waChats.filter(c => !waSearch || (c.name || '').toLowerCase().includes(waSearch.toLowerCase())).map(c => {
                      const isSaved = waSaved.has(c.id)
                      return (
                        <button key={c.id} type="button" onClick={() => toggleWa(c)} className="w-full flex items-center gap-3 py-2.5 px-2 text-left hover:bg-gray-50">
                          <span className={`inline-flex items-center justify-center w-5 h-5 rounded-md border shrink-0 ${isSaved ? 'bg-emerald-500 border-emerald-500' : 'border-gray-300'}`}>
                            {isSaved && <Check className="w-3.5 h-3.5 text-white" />}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block truncate text-sm text-gray-800">{c.name || c.id}</span>
                            <span className="text-[11px] text-gray-400">{c.isGroup ? 'Группа' : 'Личный чат'}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </>
              )}
              <div className="flex justify-end pt-4">
                <button onClick={onClose} className="px-4 py-2.5 rounded-xl font-semibold text-sm text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>Готово</button>
              </div>
            </div>
          ) : (
          <>
          {/* Ссылка + Определить ID */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Ссылка на группу / канал<span className="text-red-500"> *</span>
            </label>
            <div className="flex gap-2 items-stretch">
              <input
                type="url"
                value={url}
                onChange={e => { setUrl(e.target.value); setResolvedOk(false) }}
                placeholder={platform === 'vk' ? 'https://vk.com/your_group' : platform === 'max' ? 'https://max.ru/your_chat' : 'https://telegram.me/your_chat'}
                className="flex-1 min-w-0 px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
              />
              {canResolve && (
                <button
                  type="button"
                  onClick={resolve}
                  disabled={resolving}
                  className="px-3 py-2 text-xs rounded-lg text-white whitespace-nowrap disabled:opacity-60"
                  style={{ background: '#25455D' }}
                >
                  {resolving ? <Loader2 size={14} className="animate-spin" /> : 'Определить ID'}
                </button>
              )}
            </div>
            {resolvedOk && (
              <p className="text-xs text-green-600 mt-1 flex items-center gap-1">
                <Check size={12} /> ID определён по ссылке
              </p>
            )}
            {resolveErr && <p className="text-xs text-red-600 mt-1">{resolveErr}</p>}
            <p className="text-[11px] text-gray-500 mt-1">
              {platform === 'max'
                ? 'Для MAX ID по ссылке определить нельзя — впишите ID и название вручную.'
                : 'Для публичных групп/каналов можно определить ID по ссылке. Для закрытых и приватных — впишите ID вручную. Чтобы определить ID, бот должен состоять в этом чате.'}
            </p>
          </div>

          {/* ID + Название (ручной ввод / коррекция) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">ID чата <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={chatId}
                onChange={e => setChatId(e.target.value)}
                placeholder="-1001234567890"
                className="w-full px-3 py-2.5 text-sm font-mono border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Название</label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Чат участников"
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl font-medium text-sm border border-gray-200 text-gray-600 hover:bg-gray-50"
              disabled={saving}
            >Отмена</button>
            <button
              onClick={save}
              disabled={saving || !chatId.trim() || !url.trim()}
              className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
            >
              {saving ? 'Добавляем…' : 'Добавить'}
            </button>
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─────── Модалка редактирования (название + ссылка) ─────── */
function RenameChatModal({ chat, onClose, onSaved }: {
  chat: BroadcastChat
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(chat.title || '')
  const [chatUrl, setChatUrl] = useState(chat.chat_url || '')
  const [saving, setSaving] = useState(false)

  async function save() {
    // ⚠️ Тот же запрет, что при добавлении и на бэкенде (PATCH отвечает 400):
    // чат без ссылки исчезает из меню бота, писем и Mini App. Здесь подсказка
    // была обратной — «Оставьте пустым, чтобы убрать ссылку», — и человек,
    // послушавшись, упирался в ошибку сервера вместо понятного объяснения.
    // WhatsApp — исключение: у его чатов ссылки-приглашения нет в принципе.
    if (chat.platform !== 'whatsapp' && !chatUrl.trim()) {
      alert('Добавьте ссылку-приглашение в чат.\n\nБез неё людям некуда переходить — чат не появится ни в меню бота, ни в письмах, ни в рассылках.')
      return
    }
    setSaving(true)
    try {
      // chat_url шлём всегда — пустая строка на бэке очищает ссылку до NULL.
      await api.miniApp.broadcastChats.update(chat.id, {
        title: title.trim() || null,
        chat_url: chatUrl.trim(),
      })
      onSaved()
    } catch (e: any) {
      alert('Не удалось сохранить: ' + (e.message || ''))
    } finally {
      setSaving(false)
    }
  }

  return (
    // ⚠️ Без закрытия по фону — только крестик / «Отмена».
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-sm w-full p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-gray-900">Редактировать чат</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X size={18} /></button>
        </div>
        <label className="block text-xs text-gray-500 mb-1">Название</label>
        <input
          type="text"
          autoFocus
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Чат участников"
          className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
        />
        <label className="block text-xs text-gray-500 mb-1 mt-3">
          Ссылка на чат{chat.platform !== 'whatsapp' && <span className="text-red-500"> *</span>}
        </label>
        <input
          type="text"
          value={chatUrl}
          onChange={e => setChatUrl(e.target.value)}
          placeholder="https://telegram.me/+abcDEF…"
          className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
        />
        {/* ⚠️ Подсказка была ровно наоборот — «Оставьте пустым, чтобы убрать
            ссылку», — хотя и фронт при добавлении, и бэкенд это запрещают. */}
        {chat.platform !== 'whatsapp' && (
          <p className="text-[11px] text-gray-400 mt-1">
            Без ссылки чат не покажется ни в Mini App, ни в меню бота.
            {chat.platform === 'telegram' && ' В Telegram её берут в чате → Управление → Пригласительные ссылки.'}
          </p>
        )}
        <p className="text-[11px] text-gray-400 mt-1.5">ID: <span className="font-mono">{chat.chat_id}</span></p>
        <div className="flex gap-2 mt-4">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl font-medium text-sm border border-gray-200 text-gray-600 hover:bg-gray-50"
            disabled={saving}
          >Отмена</button>
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white disabled:opacity-50"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
          >
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}
