'use client'
import { useState, useEffect } from 'react'
import {
  Plus, X, Trash2, Edit2, Megaphone, Crown, ArrowRight,
  CheckCircle2, Loader2, Link2, Check,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'

/**
 * Вкладка «Чаты для рассылок» в /dashboard/channels.
 *
 * База внешних групп/каналов клиента (client_broadcast_chats, фича broadcast_chats).
 * Доступна только на тарифе с фичей broadcast_chats (Экстра). Если фичи нет —
 * показываем апсейл-заглушку с динамическим названием и ценой тарифа
 * (берём из api.publicData.tariffs() — НЕ хардкодим).
 *
 * Когда чаты добавлены — в рассылке (общей или в событии) клиент ставит
 * галочку «Отправлять в общие чаты», и рассылка дублируется в эти чаты.
 */

type Platform = 'telegram' | 'vk' | 'max'

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
  created_at: string
}

const PLATFORM_META: Record<Platform, { label: string; badge: string; color: string }> = {
  telegram: { label: 'Telegram',  badge: 'TG',  color: '#229ED9' },
  vk:       { label: 'ВКонтакте', badge: 'VK',  color: '#0077FF' },
  max:      { label: 'MAX',       badge: 'MX',  color: '#F45D22' },
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

export default function BroadcastChatsTab() {
  const { me } = useMe()
  const [chats, setChats] = useState<BroadcastChat[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<BroadcastChat | null>(null)
  // Тариф с фичей broadcast_chats (для апсейл-заглушки) — подтягиваем динамически.
  const [upsellTariff, setUpsellTariff] = useState<{ name: string; price: number } | null>(null)

  const hasFeature = (me?.features || []).includes('broadcast_chats')

  const load = async () => {
    setLoading(true)
    try {
      const r: any = await api.miniApp.broadcastChats.list()
      setChats(r.chats || [])
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
      const t = list.find(x =>
        (x.slug !== 'admin') &&
        (x.feature_slugs || x.features || []).includes('broadcast_chats')
      )
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

  const grouped: { platform: Platform; items: BroadcastChat[] }[] = (['telegram', 'vk', 'max'] as const)
    .map(p => ({ platform: p, items: chats.filter(c => c.platform === p) }))
    .filter(g => g.items.length > 0)

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
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm text-white"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
          >
            <Plus size={16} /> Добавить чат
          </button>
        </div>
      ) : (
        <>
          {grouped.map(group => (
            <div key={group.platform} className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wide px-1">
                <PlatformBadge platform={group.platform} />
                {PLATFORM_META[group.platform].label}
                <span className="text-gray-400 font-normal">· {group.items.length}</span>
              </div>
              {group.items.map(chat => (
                <ChatCard
                  key={chat.id}
                  chat={chat}
                  onEdit={() => setEditing(chat)}
                  onChanged={load}
                  onDeleted={load}
                />
              ))}
            </div>
          ))}

          <button
            onClick={() => setCreating(true)}
            className="w-full py-3 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-2"
          >
            <Plus size={16} /> Добавить чат
          </button>
        </>
      )}

      {creating && (
        <AddChatModal
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
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold text-gray-900 truncate">
          {chat.title || <span className="text-gray-400 font-normal">Без названия</span>}
        </h3>
        <div className="flex items-center gap-2 flex-wrap mt-0.5">
          <span className="text-xs font-mono text-gray-500">{chat.chat_id}</span>
          {chat.chat_url && (
            <a
              href={chat.chat_url}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1 text-xs text-[#25455D] underline truncate max-w-[180px]"
            >
              <Link2 size={11} /> ссылка
            </a>
          )}
        </div>
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
function AddChatModal({ onClose, onSaved }: {
  onClose: () => void
  onSaved: () => void
}) {
  const [platform, setPlatform] = useState<Platform>('telegram')
  const [url, setUrl] = useState('')
  const [chatId, setChatId] = useState('')
  const [title, setTitle] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [addedVia, setAddedVia] = useState<'link' | 'manual'>('manual')
  const [resolving, setResolving] = useState(false)
  const [resolveErr, setResolveErr] = useState('')
  const [resolvedOk, setResolvedOk] = useState(false)
  const [saving, setSaving] = useState(false)

  const canResolve = platform !== 'max'

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
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
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
            <div className="flex gap-2">
              {(['telegram', 'vk', 'max'] as const).map(p => {
                const meta = PLATFORM_META[p]
                const active = platform === p
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setPlatform(p)
                      setResolvedOk(false)
                      setResolveErr('')
                    }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                      active ? 'text-white border-transparent' : 'text-gray-600 border-gray-200 bg-white hover:bg-gray-50'
                    }`}
                    style={active ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : undefined}
                  >
                    <span
                      className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[9px] font-bold text-white"
                      style={{ background: meta.color }}
                    >{meta.badge}</span>
                    {meta.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Ссылка + Определить ID */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Ссылка на группу / канал</label>
            <div className="flex gap-2 items-stretch">
              <input
                type="url"
                value={url}
                onChange={e => { setUrl(e.target.value); setResolvedOk(false) }}
                placeholder={platform === 'vk' ? 'https://vk.com/your_group' : platform === 'max' ? 'https://max.ru/your_chat' : 'https://t.me/your_chat'}
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
              disabled={saving || !chatId.trim()}
              className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
            >
              {saving ? 'Добавляем…' : 'Добавить'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─────── Модалка переименования ─────── */
function RenameChatModal({ chat, onClose, onSaved }: {
  chat: BroadcastChat
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(chat.title || '')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await api.miniApp.broadcastChats.update(chat.id, { title: title.trim() || null })
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
          <h2 className="text-base font-bold text-gray-900">Переименовать чат</h2>
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
