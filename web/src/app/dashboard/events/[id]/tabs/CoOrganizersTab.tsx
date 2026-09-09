'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Plus, X, Search, AlertTriangle, CheckCircle2, EyeOff } from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'

interface Collaborator {
  id: number  // event_collaborators.id (запись связи)
  collaborator_id: number
  role: string
  sort_order: number
  name: string
  title?: string | null
  photo_url?: string | null
  achievements?: string[] | null
  personal_tg_username?: string | null
  ref_code?: string | null
  bot_in_channel?: boolean
  exclude_channel_from_subscription?: boolean
  tg_channel_id?: string | null
}

interface GlobalCollaborator {
  id: number
  name: string
  title?: string | null
  photo_url?: string | null
  achievements?: string[] | null
}

export default function CoOrganizersTab({ eventId, requireSubscription = false }: { eventId: number; eventSlug?: string | null; requireSubscription?: boolean }) {
  const { isAssistant } = useMe()
  const [items, setItems] = useState<Collaborator[]>([])
  const [loading, setLoading] = useState(true)
  const [showPicker, setShowPicker] = useState(false)
  const [removing, setRemoving] = useState<number | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await api.events.listCollaborators(eventId, 'organizer')
      const arr = Array.isArray(res) ? res : (res?.items ?? res?.collaborators ?? [])
      setItems(Array.isArray(arr) ? arr : [])
    } catch (e) {
      console.error('listCollaborators failed:', e)
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [eventId])

  // Владельцы коллаборации (event_owners) — клиенты-организаторы совместного события.
  // Это ДРУГОЙ слой, чем спикеры-коллабораторы ниже.
  const [collabOwners, setCollabOwners] = useState<any[]>([])
  useEffect(() => {
    api.collabHub.eventOwners(eventId)
      .then((r: any) => setCollabOwners((r.owners || []).filter((o: any) => o.status === 'accepted')))
      .catch(() => setCollabOwners([]))
  }, [eventId])

  async function handleAdd(collaboratorId: number) {
    await api.events.addCollaborator(eventId, collaboratorId, 'organizer')
    setShowPicker(false)
    load()
  }

  async function handleRemove(ecId: number) {
    if (!confirm('Убрать организатора из этого события?')) return
    setRemoving(ecId)
    try {
      await api.events.removeCollaborator(eventId, ecId)
      load()
    } finally {
      setRemoving(null)
    }
  }

  if (loading) return <div className="text-gray-400 text-sm">Загрузка…</div>

  return (
    <div className="space-y-4">
      {/* Организаторы коллаборации (клиенты-совладельцы из Коллабораторной) */}
      {collabOwners.length > 1 && (
        <div className="bg-white rounded-2xl border-2 shadow-sm p-6" style={{ borderColor: '#FFCFA4' }}>
          <h3 className="font-semibold text-gray-800 mb-1">Организаторы коллаборации</h3>
          <p className="text-sm text-gray-500 mb-3">Это совместное событие. Каждый из организаторов ведёт свою аудиторию.</p>
          <div className="flex flex-wrap gap-2">
            {collabOwners.map((o: any) => (
              <div key={o.client_id} className="px-3 py-1.5 rounded-xl bg-gray-50 text-sm" style={{ color: '#25455D' }}>
                {o.name}{o.role === 'owner' ? ' (создатель)' : ''}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div>
            <h3 className="font-semibold text-gray-800">Спикеры / соорганизаторы</h3>
            <p className="text-sm text-gray-500 mt-1">
              Кто ещё ведёт это мероприятие — отображается на странице события в Mini App.
              Берётся из общей базы Коллаборации.
            </p>
          </div>
          <button
            onClick={() => setShowPicker(true)}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ background: '#25455D' }}
          >
            <span className="inline-flex items-center gap-1.5"><Plus size={14} /> Добавить</span>
          </button>
        </div>

        {items.length === 0 ? (
          <div className="text-sm text-gray-400 py-8 text-center border-2 border-dashed border-gray-200 rounded-xl">
            Организаторы не добавлены
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {items.map(c => (
              <div key={c.id} className="flex items-start gap-3 p-3 rounded-xl border border-gray-100 hover:border-gray-300 transition-colors">
                <Link
                  href={`/dashboard/events/${eventId}/organizers/${c.id}`}
                  className="flex items-start gap-3 flex-1 min-w-0 group"
                  title="Открыть карточку организатора в этом мероприятии"
                >
                  {c.photo_url ? (
                    <img src={c.photo_url} alt="" className="w-14 h-14 rounded-full object-cover shrink-0" />
                  ) : (
                    <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs shrink-0">
                      {c.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-800 text-sm truncate group-hover:text-[#25455D]">{c.name}</div>
                    {c.title && <div className="text-xs text-gray-500 truncate">{c.title}</div>}
                    {c.personal_tg_username && (
                      <div className="text-xs text-gray-400 truncate">@{c.personal_tg_username.replace(/^@/, '')}</div>
                    )}
                    {requireSubscription && (() => {
                      const hasChannel = !!(c.tg_channel_id && String(c.tg_channel_id).trim())
                      if (!hasChannel) return null
                      if (c.exclude_channel_from_subscription) {
                        return (
                          <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-gray-600 bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded">
                            <EyeOff size={11} /> Канал исключён из проверки
                          </div>
                        )
                      }
                      if (!c.bot_in_channel) {
                        return (
                          <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded"
                               title="Бот не подтверждён в канале — проверка автоматически выдаёт ложное «подписан» и пропускает людей">
                            <AlertTriangle size={11} /> Бот не в канале — пропускаем ложно
                          </div>
                        )
                      }
                      return (
                        <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-green-700 bg-green-50 border border-green-200 px-1.5 py-0.5 rounded">
                          <CheckCircle2 size={11} /> Бот в канале
                        </div>
                      )
                    })()}
                  </div>
                </Link>
                {!isAssistant && (
                  <button
                    onClick={() => handleRemove(c.id)}
                    disabled={removing === c.id}
                    className="p-1.5 text-gray-300 hover:text-red-500 transition-colors shrink-0 disabled:opacity-50"
                    title="Убрать"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showPicker && (
        <CollaboratorPicker
          alreadyAddedIds={items.map(i => i.collaborator_id)}
          onPick={handleAdd}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}

function CollaboratorPicker({
  alreadyAddedIds,
  onPick,
  onClose,
}: {
  alreadyAddedIds: number[]
  onPick: (id: number) => void
  onClose: () => void
}) {
  const [list, setList] = useState<GlobalCollaborator[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    // По имени: здесь человека ищут глазами, порядок по приходу тут мешает.
    api.collaborators.list(q || undefined, 'name')
      .then((d: any) => {
        const arr = Array.isArray(d) ? d : (d?.items ?? d?.collaborators ?? [])
        setList(Array.isArray(arr) ? arr : [])
      })
      .catch((e) => { console.error('collaborators.list failed:', e); setList([]) })
      .finally(() => setLoading(false))
  }, [q])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">Выбрать из коллабораций</h3>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-700">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 border-b border-gray-100">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Поиск по имени"
              value={q}
              onChange={e => setQ(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand/30"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="text-center text-gray-400 text-sm py-8">Загрузка…</div>
          ) : list.length === 0 ? (
            <div className="text-center text-gray-400 text-sm py-8">
              Никого не найдено. Создать нового можно в разделе «Коллаборации».
            </div>
          ) : (
            <div className="space-y-1">
              {list.map(c => {
                const added = alreadyAddedIds.includes(c.id)
                return (
                  <button
                    key={c.id}
                    onClick={() => !added && onPick(c.id)}
                    disabled={added}
                    className={`w-full flex items-center gap-3 p-2.5 rounded-lg text-left transition-colors ${
                      added ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'
                    }`}
                  >
                    {c.photo_url ? (
                      <img src={c.photo_url} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs shrink-0">
                        {c.name.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-800 text-sm truncate">{c.name}</div>
                      {c.title && <div className="text-xs text-gray-500 truncate">{c.title}</div>}
                    </div>
                    {added && <span className="text-xs text-gray-400 shrink-0">уже добавлен</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
