'use client'

/**
 * Блок «Чаты события» — ВЫБОР чата из базы клиента (Каналы → «Группы/Каналы для рассылок»),
 * по одному на платформу (Telegram / ВКонтакте / MAX) + radio «какой главный».
 *
 * Клиент добавляет чат ОДИН раз в Каналы→Чаты (там ID и ссылка определяются),
 * а здесь просто выбирает его из списка — никаких ручных ID/ссылок.
 * Значение события — ref на запись client_broadcast_chats (миграция 174).
 *
 * Родитель хранит value/onChange, сам собирает diff и шлёт PATCH (tg_chat_ref и т.д.).
 */
import { useState, useEffect } from 'react'
import { api } from '@/lib/api'

export type ChatPlatform = 'telegram' | 'vk' | 'max'

export interface EventChatsValue {
  tgChatRef: number | null   // events.tg_chat_ref → client_broadcast_chats.id
  vkChatRef: number | null   // events.vk_chat_ref
  maxChatRef: number | null  // events.max_chat_ref
  primary: ChatPlatform | null  // events.primary_chat_platform
}

interface ClientChat {
  id: number
  platform: ChatPlatform
  chat_id: string
  title: string | null
  chat_url: string | null
}

interface Props {
  value: EventChatsValue
  onChange: (next: EventChatsValue) => void
}

const PLATFORM_META: Record<ChatPlatform, { label: string; badge: string; color: string }> = {
  telegram: { label: 'Telegram',  badge: 'TG',  color: '#229ED9' },
  vk:       { label: 'ВКонтакте', badge: 'VK',  color: '#0077FF' },
  max:      { label: 'MAX',       badge: 'MAX', color: '#F45D22' },
}

const REF_KEY: Record<ChatPlatform, 'tgChatRef' | 'vkChatRef' | 'maxChatRef'> = {
  telegram: 'tgChatRef', vk: 'vkChatRef', max: 'maxChatRef',
}

export default function EventChatsField({ value, onChange }: Props) {
  const [chats, setChats] = useState<ClientChat[]>([])
  const [loading, setLoading] = useState(true)
  const [picker, setPicker] = useState<ChatPlatform | null>(null)
  const [activeTab, setActiveTab] = useState<ChatPlatform>('telegram')
  // Бот-админ в чате. ⚠️ ТОЛЬКО Telegram: у VK/MAX нет метода, который отдал бы боту
  // состав ЧУЖОЙ беседы. Без бота в чате рассылка туда не уйдёт, а чтобы бот слушал
  // чат (кодовые слова, баллы) и мог удалять по гейту — он должен быть АДМИНОМ.
  const [botCheck, setBotCheck] = useState<any>(null)
  const [botChecking, setBotChecking] = useState(false)

  useEffect(() => {
    let alive = true
    api.miniApp.broadcastChats.list()
      .then((r: any) => { if (alive) setChats(r.items || r.chats || []) })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const chatById = (id: number | null) => id ? chats.find(c => c.id === id) || null : null

  // Проверяем бота в выбранном TG-чате (пере-проверяем при смене чата).
  const tgRef = value[REF_KEY['telegram']]
  async function checkBot(id: number) {
    setBotChecking(true)
    try { setBotCheck(await api.miniApp.broadcastChats.checkBot(id)) }
    catch { setBotCheck(null) }
    finally { setBotChecking(false) }
  }
  useEffect(() => {
    setBotCheck(null)
    if (tgRef) checkBot(tgRef)
  }, [tgRef])

  function pickChat(platform: ChatPlatform, chatId: number | null) {
    const next = { ...value, [REF_KEY[platform]]: chatId }
    // авто-primary: первый выбранный становится главным
    if (chatId && !next.primary) next.primary = platform
    // сняли выбор у главного → главным следующий выбранный
    if (!chatId && next.primary === platform) {
      const others = (['telegram', 'vk', 'max'] as ChatPlatform[]).filter(p => p !== platform)
      next.primary = others.find(p => next[REF_KEY[p]]) || null
    }
    onChange(next)
    setPicker(null)
  }

  const anySelected = !!(value.tgChatRef || value.vkChatRef || value.maxChatRef)

  return (
    <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-3">
      <div>
        <label className="block text-sm font-semibold text-gray-800">Чаты/каналы события</label>
        <p className="text-xs text-gray-500 mt-1">
          Выберите чат или канал для каждой площадки из вашей базы. Чаты/каналы добавляются один раз в{' '}
          <a href="/dashboard/channels" target="_blank" className="text-[#25455D] underline">Каналы → «Группы/Каналы для рассылок»</a>{' '}
          (там определяется ID и ссылка).
        </p>
      </div>

      {/* Вкладки площадок: TG / VK / MAX (зелёная точка на заполненной) */}
      <div className="flex gap-1 border-b border-gray-200">
        {(['telegram', 'vk', 'max'] as const).map(platform => {
          const meta = PLATFORM_META[platform]
          const filled = !!value[REF_KEY[platform]]
          const isActive = activeTab === platform
          return (
            <button key={platform} type="button" onClick={() => setActiveTab(platform)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive ? 'border-[#25455D] text-[#25455D]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              <span className="inline-flex items-center justify-center w-7 h-5 rounded text-[9px] font-bold text-white shrink-0"
                    style={{ background: meta.color }}>{meta.badge}</span>
              {meta.label}
              {filled && <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Чат выбран" />}
            </button>
          )
        })}
      </div>

      {/* Контент активной площадки */}
      {(() => {
        const platform = activeTab
        const meta = PLATFORM_META[platform]
        const ref = value[REF_KEY[platform]]
        const selected = chatById(ref)
        const platformChats = chats.filter(c => c.platform === platform)
        return (
          <div className="bg-white border border-gray-200 rounded p-3">
            <div className="text-sm font-medium text-gray-700">Чат/канал события ({meta.label})</div>

            <div className="mt-3">
              {selected ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-gray-800 font-medium">
                    {selected.title || <span className="text-gray-400">Без названия</span>}
                  </span>
                  {selected.chat_id && (
                    <span className="text-[11px] font-mono text-gray-400">{selected.chat_id}</span>
                  )}
                  <button type="button" onClick={() => setPicker(platform)}
                          className="text-xs text-[#25455D] underline ml-1">Сменить чат</button>
                  <button type="button" onClick={() => pickChat(platform, null)}
                          className="text-xs text-gray-400 hover:text-red-500 underline">Убрать</button>
                </div>
              ) : (
                <button type="button" onClick={() => setPicker(platform)}
                        className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
                  + Добавить чат
                </button>
              )}

              {/* Статус бота — живая проверка через Telegram (getChat + getChatMember)
                  при заходе на страницу и смене чата. Две строки:
                  1) бот в чате/канале?  2) может ли реально писать/публиковать?
                  Логика прав различается для группы (админ пишет всегда) и канала
                  (нужно право «Публикация сообщений»). */}
              {platform === 'telegram' && selected && (
                <div className="mt-2">
                  {botChecking ? (
                    <div className="text-xs text-gray-400">Проверяем бота…</div>
                  ) : botCheck ? (
                    <BotStatus check={botCheck} onRecheck={() => selected && checkBot(selected.id)} />
                  ) : null}
                </div>
              )}
            </div>

            {/* Модалка выбора чата этой платформы */}
            {picker === platform && (
              <ChatPickerModal
                platform={platform}
                chats={platformChats}
                loading={loading}
                currentRef={ref}
                onPick={id => pickChat(platform, id)}
                onClose={() => setPicker(null)}
              />
            )}
          </div>
        )
      })()}

      {!anySelected && (
        <p className="text-xs text-gray-400 italic">
          Если ни один чат не выбран — плитка «Чат» в Mini App у участников не покажется.
        </p>
      )}
    </div>
  )
}

/* ─────── Статус бота в чате/канале (2 строки) ─────── */
function BotStatus({ check, onRecheck }: { check: any; onRecheck: () => void }) {
  const isChannel = !!check.is_channel
  const inChat = !!check.in_chat
  const isAdmin = !!check.is_admin
  const canPost = !!check.can_post
  const place = isChannel ? 'канале' : 'чате'

  // Строка 1 — присутствие в чате/канале.
  const line1ok = inChat
  const line1 = line1ok
    ? `Бот в ${place}`
    : `Бота нет в ${place} — добавьте своего бота`

  // Строка 2 — может ли реально писать/публиковать.
  let line2ok = false
  let line2 = ''
  if (isChannel) {
    // Канал: нужно право «Публикация сообщений».
    if (canPost) { line2ok = true; line2 = 'Может публиковать' }
    else if (isAdmin) { line2 = 'Нет права «Публикация сообщений» — включите его боту в настройках канала' }
    else { line2 = 'Бот не админ — сделайте его администратором канала' }
  } else {
    // Группа/супергруппа: админ пишет всегда.
    if (isAdmin) { line2ok = true; line2 = 'Может писать' }
    else { line2 = 'Бот не админ — сделайте его администратором' }
  }

  const Row = ({ ok, text }: { ok: boolean; text: string }) => (
    <div className={`text-xs flex items-start gap-1 ${ok ? 'text-green-600' : 'text-red-600'}`}>
      <span className="shrink-0">{ok ? '✓' : '✕'}</span>
      <span className={ok ? '' : 'font-medium'}>{text}</span>
    </div>
  )

  return (
    <div className={`rounded-lg px-3 py-2 space-y-1 ${line1ok && line2ok ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
      <Row ok={line1ok} text={line1} />
      <Row ok={line2ok} text={line2} />
      <button type="button" onClick={onRecheck} className="text-[11px] text-gray-500 underline mt-0.5">Проверить снова</button>
    </div>
  )
}

/* ─────── Модалка выбора чата платформы ─────── */
function ChatPickerModal({ platform, chats, loading, currentRef, onPick, onClose }: {
  platform: ChatPlatform
  chats: ClientChat[]
  loading: boolean
  currentRef: number | null
  onPick: (id: number) => void
  onClose: () => void
}) {
  const meta = PLATFORM_META[platform]
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      {/* клик по фону НЕ закрывает (модалка-форма) — только крестик/Отмена */}
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-semibold text-gray-900">Выбрать чат {meta.label}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        <div className="p-4 overflow-y-auto flex-1 space-y-2">
          {loading ? (
            <p className="text-sm text-gray-400">Загрузка…</p>
          ) : chats.length === 0 ? (
            <div className="text-sm text-gray-500">
              У вас нет чатов {meta.label} в базе.{' '}
              <a href="/dashboard/channels" target="_blank" className="text-[#25455D] underline">
                Добавьте в Каналы → «Группы/Каналы для рассылок»
              </a>.
            </div>
          ) : chats.map(c => (
            <button key={c.id} type="button" onClick={() => onPick(c.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                      c.id === currentRef ? 'border-[#FFCFA4] bg-[#FFF7F0]' : 'border-gray-200 hover:bg-gray-50'}`}>
              <div className="text-sm font-medium text-gray-800">
                {c.title || <span className="text-gray-400">Без названия</span>}
              </div>
              {c.chat_id && <div className="text-[11px] font-mono text-gray-400">{c.chat_id}</div>}
            </button>
          ))}
        </div>
        <div className="p-3 border-t">
          <button onClick={onClose}
                  className="w-full py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
            Отмена
          </button>
        </div>
      </div>
    </div>
  )
}
