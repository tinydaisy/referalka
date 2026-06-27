'use client'
import { useEffect, useState } from 'react'
import { ShieldAlert, Plus, Trash2, RefreshCw, CheckCircle2, XCircle, Loader2, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'

/**
 * Раздел «Гейт по подписке в Telegram-чатах» (миграция 115).
 *
 * Клиент указывает чаты, в которых бот удаляет сообщения от пользователей,
 * не подписанных на ВСЕ TG-каналы основателя (массив `social_links.telegram_channels`).
 *
 * UI:
 *   - Если нет каналов основателя — баннер «Сначала настройте» и блокировка добавления.
 *   - Список чатов: chat_id, title, состояние (вкл/выкл), кнопка «Проверить настройки», действия.
 *   - Кнопка «+ Добавить чат» открывает модалку.
 */

interface Gate {
  id: number
  chat_id: string
  chat_title: string | null
  warning_text: string | null
  warning_ttl_sec: number
  is_active: boolean
  last_error: string | null
  last_error_at: string | null
  last_check_at: string | null
  created_at: string
  updated_at: string
}

interface VerifyResult {
  bot_username: string
  bot_in_chat: boolean
  bot_in_chat_can_delete: boolean
  chat_check_error: string | null
  channels: { url: string; name: string; chat_id: string; bot_in_channel: boolean; error: string | null }[]
  no_channels: boolean
  ready: boolean
}

const DEFAULT_WARNING_TEXT =
  '{user_name}, чтобы писать в этот чат, подпишитесь на канал(ы) основателя:\n{channels_list}'

export default function ChatGatesTab() {
  const [gates, setGates] = useState<Gate[]>([])
  const [loading, setLoading] = useState(true)
  const [hasChannels, setHasChannels] = useState<boolean | null>(null)
  // Handle бота клиента (VIP — собственный, у Марго @ivision_conf_bot; обычный — @pluson_bot).
  // Подставляется в инструкцию про privacy mode и в подсказку при добавлении чата.
  const [botHandle, setBotHandle] = useState<string>('pluson_bot')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Gate | null>(null)
  const [verifyResults, setVerifyResults] = useState<Record<number, VerifyResult>>({})
  const [verifyingId, setVerifyingId] = useState<number | null>(null)

  async function loadAll() {
    setLoading(true)
    try {
      const [list, profile, me] = await Promise.all([
        api.miniApp.chatGates.list(),
        api.miniApp.profile.get().catch(() => null),
        api.auth.me().catch(() => null),
      ])
      setGates(list.items || [])
      const channels = (profile as any)?.social_links?.telegram_channels
      setHasChannels(Array.isArray(channels) && channels.length > 0)
      // Резолв какого бота показывать в инструкции:
      // VIP-клиент с подключённым TG-каналом → `me.bot_handles.telegram` (например @ivision_conf_bot)
      // Иначе fallback на системный @pluson_bot
      const handles = (me as any)?.bot_handles || {}
      const tg = (handles.telegram || '').replace(/^@/, '')
      setBotHandle(tg || 'pluson_bot')
    } catch (e: any) {
      alert(e?.message || 'Не удалось загрузить гейты')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAll() }, [])

  async function toggleActive(g: Gate) {
    const turningOn = !g.is_active
    try {
      const updated = await api.miniApp.chatGates.update(g.id, { is_active: turningOn })
      setGates(prev => prev.map(x => x.id === g.id ? updated : x))
      // Явная обратная связь — иначе клиент не понимает, сохранилось ли изменение.
      if (turningOn) {
        alert(
          'Гейт активирован.\n\nТеперь все сообщения от неподписанных будут удаляться. ' +
          'Если бот не получает сообщений в чате — проверьте отключение privacy mode в @BotFather (см. жёлтый баннер выше).'
        )
      }
    } catch (e: any) {
      alert(e?.message || 'Не удалось переключить')
    }
  }

  async function remove(g: Gate) {
    if (!confirm(`Удалить гейт для чата ${g.chat_title || g.chat_id}?`)) return
    try {
      await api.miniApp.chatGates.delete(g.id)
      setGates(prev => prev.filter(x => x.id !== g.id))
    } catch (e: any) {
      alert(e?.message || 'Не удалось удалить')
    }
  }

  async function runVerify(g: Gate) {
    setVerifyingId(g.id)
    try {
      const res: VerifyResult = await api.miniApp.chatGates.verify(g.id)
      setVerifyResults(prev => ({ ...prev, [g.id]: res }))
    } catch (e: any) {
      alert(e?.message || 'Не удалось проверить')
    } finally {
      setVerifyingId(null)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <ShieldAlert size={20} /> Гейт по подписке в Telegram-чатах
        </h2>
        <p className="text-sm text-gray-600 mt-1">
          Бот будет проверять каждое сообщение в указанных чатах: если автор не подписан на все
          ваши TG-каналы основателя — сообщение удаляется и бот пишет предупреждение.
          Для VK/MAX чатов фича появится позже.
        </p>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
        <div className="font-semibold text-amber-900 mb-1 flex items-center gap-1.5">
          <AlertTriangle size={16} /> Отключите privacy mode у бота <code className="font-mono">@{botHandle}</code>
        </div>
        <div className="text-amber-800">
          В <a href="https://t.me/BotFather" target="_blank" rel="noopener" className="underline">@BotFather</a>:
          {' '}<code className="font-mono">/mybots</code> → выберите <code className="font-mono">@{botHandle}</code> → <code>Bot Settings</code> → <code>Group Privacy</code> → <code>Turn off</code>.
          После этого нужно <strong>удалить бота из чата и заново добавить</strong> — privacy mode применяется только при добавлении.
          Без этого Telegram присылает боту только сообщения с упоминанием — гейт работать не будет.
        </div>
      </div>

      {hasChannels === false && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm">
          <div className="font-semibold text-red-900 mb-1">Сначала настройте каналы основателя</div>
          <div className="text-red-800">
            Гейт проверяет подписку на ваши TG-каналы основателя. Без них проверять нечего.{' '}
            <a href="/dashboard/mini-app?tab=owner" className="underline font-medium">Добавить канал →</a>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-gray-400 text-sm">Загрузка…</p>
      ) : gates.length === 0 ? (
        <div className="bg-gray-50 border border-dashed border-gray-300 rounded-xl p-8 text-center">
          <p className="text-gray-500 text-sm">Пока нет ни одного гейта</p>
        </div>
      ) : (
        <div className="space-y-3">
          {gates.map(g => (
            <GateCard
              key={g.id}
              gate={g}
              hasChannels={!!hasChannels}
              verifying={verifyingId === g.id}
              verifyResult={verifyResults[g.id]}
              onToggle={() => toggleActive(g)}
              onEdit={() => setEditing(g)}
              onRemove={() => remove(g)}
              onVerify={() => runVerify(g)}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setCreating(true)}
        disabled={hasChannels === false}
        className="w-full px-4 py-3 text-sm font-medium border-2 border-dashed border-gray-300 rounded-lg text-gray-700 hover:border-[#25455D] hover:text-[#25455D] flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus size={18} />
        Добавить чат
      </button>

      {(creating || editing) && (
        <GateModal
          initial={editing}
          botHandle={botHandle}
          usedChatIds={gates.map(g => g.chat_id)}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={async () => { setCreating(false); setEditing(null); await loadAll() }}
        />
      )}
    </div>
  )
}


// ───────────────────── Card ─────────────────────

function GateCard({
  gate, hasChannels, verifying, verifyResult,
  onToggle, onEdit, onRemove, onVerify,
}: {
  gate: Gate
  hasChannels: boolean
  verifying: boolean
  verifyResult?: VerifyResult
  onToggle: () => void
  onEdit: () => void
  onRemove: () => void
  onVerify: () => void
}) {
  const ready = verifyResult?.ready ?? null
  const toggleDisabled = !hasChannels || (verifyResult ? !verifyResult.ready : false)

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-gray-900 truncate">
            {gate.chat_title || 'Без названия'}
          </div>
          <div className="text-xs text-gray-500 font-mono mt-0.5">{gate.chat_id}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onEdit}
            className="px-3 py-1.5 text-xs rounded border border-gray-200 hover:border-[#25455D] text-gray-700"
          >
            Изменить
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="p-2 text-gray-400 hover:text-red-600"
            title="Удалить"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {gate.last_error && (
        <div className="text-xs rounded border border-red-200 bg-red-50 px-3 py-2 text-red-800">
          <span className="font-semibold">⚠️ Гейт автовыключен:</span> {gate.last_error}
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          role="switch"
          aria-checked={gate.is_active}
          onClick={() => {
            if (toggleDisabled) {
              if (!hasChannels) {
                alert('Сначала добавьте хотя бы один TG-канал основателя на вкладке «Основатель» в Mini App.')
              } else {
                alert('Сначала нажмите «Проверить настройки» — бот должен быть админом и в чате, и во всех каналах основателя.')
              }
              return
            }
            onToggle()
          }}
          className={`relative inline-flex items-center h-7 w-12 rounded-full transition-colors ${
            toggleDisabled
              ? 'bg-gray-200 cursor-not-allowed'
              : gate.is_active
                ? 'bg-green-500'
                : 'bg-gray-300'
          }`}
          title={toggleDisabled ? 'Сначала «Проверить настройки» — должны быть все зелёные галочки ниже' : (gate.is_active ? 'Выключить гейт' : 'Включить гейт')}
        >
          <span
            className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${
              gate.is_active ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
        <span className={`text-sm font-semibold ${
          toggleDisabled
            ? 'text-gray-400'
            : gate.is_active
              ? 'text-green-700'
              : 'text-gray-600'
        }`}>
          {gate.is_active ? 'ГЕЙТ АКТИВЕН' : 'ГЕЙТ ВЫКЛЮЧЕН'}
        </span>
        <button
          type="button"
          onClick={onVerify}
          disabled={verifying}
          className="ml-auto px-3 py-1.5 text-xs rounded bg-[#25455D] text-white flex items-center gap-1.5 disabled:opacity-50"
        >
          {verifying ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Проверить настройки
        </button>
        {gate.last_check_at && (
          <span className="text-xs text-gray-400 w-full">
            Проверено: {new Date(gate.last_check_at).toLocaleString('ru')}
          </span>
        )}
      </div>

      {verifyResult && (
        <div className="text-xs space-y-1 border-t border-gray-100 pt-3">
          <CheckLine
            ok={verifyResult.bot_in_chat}
            okText={`@${verifyResult.bot_username} — админ в чате${verifyResult.bot_in_chat_can_delete ? ' (может удалять сообщения)' : ' (но без прав «Удалять сообщения» — добавьте право)'}`}
            failText={`@${verifyResult.bot_username} не админ в этом чате (${verifyResult.chat_check_error || 'добавьте бота админом'})`}
          />
          {verifyResult.no_channels && (
            <CheckLine ok={false} failText="У клиента нет каналов основателя — добавьте хотя бы один." />
          )}
          {!verifyResult.no_channels && verifyResult.channels.map((c, i) => (
            <CheckLine
              key={i}
              ok={c.bot_in_channel}
              okText={`Бот в канале: ${c.name || c.url}`}
              failText={`Бот НЕ в канале «${c.name || c.url}» — добавьте админом. Причина: ${c.error || 'unknown'}`}
            />
          ))}
          {ready ? (
            <div className="text-green-700 font-semibold mt-2">Готово — можно включать гейт.</div>
          ) : (
            <div className="text-amber-700 mt-2">Гейт нельзя включить пока есть ошибки выше.</div>
          )}
        </div>
      )}
    </div>
  )
}

function CheckLine({ ok, okText, failText }: { ok: boolean; okText?: string; failText?: string }) {
  return (
    <div className={`flex items-start gap-1.5 ${ok ? 'text-green-700' : 'text-red-700'}`}>
      {ok
        ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
        : <XCircle size={14} className="mt-0.5 shrink-0" />}
      <span>{ok ? okText : failText}</span>
    </div>
  )
}


// ───────────────────── Modal ─────────────────────

interface BroadcastChat {
  id: number
  platform: string
  chat_id: string
  title: string | null
  chat_url: string | null
}

function GateModal({
  initial, botHandle, usedChatIds, onClose, onSaved,
}: {
  initial: Gate | null
  botHandle: string
  usedChatIds: string[]        // chat_id уже подключённых к гейтам (кроме редактируемого)
  onClose: () => void
  onSaved: () => void
}) {
  const [chatId, setChatId] = useState(initial?.chat_id || '')
  const [chatTitle, setChatTitle] = useState(initial?.chat_title || '')
  // TG-чаты из общей базы клиента (Каналы → «Чаты для рассылок»).
  const [tgChats, setTgChats] = useState<BroadcastChat[]>([])
  const [chatsLoading, setChatsLoading] = useState(true)
  useEffect(() => {
    let alive = true
    api.miniApp.broadcastChats.list()
      .then((r: any) => {
        if (!alive) return
        const all: BroadcastChat[] = r.chats || r.items || []
        setTgChats(all.filter(c => c.platform === 'telegram' && (c.chat_id || '').trim()))
      })
      .catch(() => {})
      .finally(() => { if (alive) setChatsLoading(false) })
    return () => { alive = false }
  }, [])
  // При создании сразу заполняем дефолтным шаблоном, чтобы клиент его видел
  // и мог сразу редактировать, а не вводить с нуля. При редактировании
  // существующего гейта: если в БД NULL (применяется дефолт на бэке) —
  // тоже показываем тот же текст в поле.
  const [warningText, setWarningText] = useState(initial?.warning_text || DEFAULT_WARNING_TEXT)
  const [ttl, setTtl] = useState(initial?.warning_ttl_sec || 15)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      // Если текст совпадает с дефолтом — в БД пишем NULL (бэк сам подставит
      // дефолт при отправке). Так клиент может «откатить к дефолту», очистив
      // поле, и дефолт продолжает обновляться централизованно.
      const trimmed = warningText.trim()
      const customText = trimmed && trimmed !== DEFAULT_WARNING_TEXT.trim() ? trimmed : null
      const payload = {
        chat_id: chatId.trim(),
        chat_title: chatTitle.trim() || null,
        warning_text: customText,
        warning_ttl_sec: Math.max(5, Math.min(600, Number(ttl) || 15)),
      }
      if (initial) {
        await api.miniApp.chatGates.update(initial.id, payload)
      } else {
        await api.miniApp.chatGates.create(payload)
      }
      onSaved()
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div
        className="bg-white rounded-xl max-w-lg w-full p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold text-gray-900">
          {initial ? 'Изменить гейт' : 'Добавить чат с гейтом'}
        </h3>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Чат Telegram</label>
          {chatsLoading ? (
            <p className="text-sm text-gray-400">Загрузка чатов…</p>
          ) : tgChats.length === 0 ? (
            <div className="text-sm text-gray-600 rounded border border-gray-200 bg-gray-50 px-3 py-3">
              У вас нет Telegram-чатов в базе.{' '}
              <a href="/dashboard/channels" target="_blank" rel="noopener" className="text-[#25455D] underline">
                Добавьте чат в Каналы → «Чаты для рассылок»
              </a>{' '}— там определяется ID и название. Потом выберите его здесь.
            </div>
          ) : (
            <div className="space-y-2 max-h-56 overflow-y-auto">
              {tgChats.map(c => {
                const used = usedChatIds.includes(c.chat_id) && c.chat_id !== initial?.chat_id
                const selected = chatId === c.chat_id
                return (
                  <button
                    key={c.id}
                    type="button"
                    disabled={used}
                    onClick={() => { setChatId(c.chat_id); setChatTitle(c.title || '') }}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                      used
                        ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                        : selected
                          ? 'border-[#FFCFA4] bg-[#FFF7F0]'
                          : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <div className="text-sm font-medium text-gray-800 flex items-center gap-2">
                      {c.title || <span className="text-gray-400">Без названия</span>}
                      {selected && <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: '#FFCFA4', color: '#25455D' }}>Выбран</span>}
                      {used && <span className="text-[10px] text-gray-400">уже в гейте</span>}
                    </div>
                    <div className="text-[11px] font-mono text-gray-400 mt-0.5">{c.chat_id}</div>
                  </button>
                )
              })}
            </div>
          )}
          <p className="text-xs text-gray-500 mt-2">
            Чаты берутся из вашей базы (<a href="/dashboard/channels" target="_blank" rel="noopener" className="text-[#25455D] underline">Каналы → «Чаты для рассылок»</a>).
            Добавьте бота <code className="font-mono">@{botHandle}</code> админом в чат с правом «Удаление сообщений».
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Текст предупреждения</label>
          <textarea
            value={warningText}
            onChange={e => setWarningText(e.target.value)}
            placeholder={DEFAULT_WARNING_TEXT}
            rows={4}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded focus:outline-none focus:border-[#25455D]"
          />
          <p className="text-xs text-gray-500 mt-1">
            Плейсхолдеры: <code className="font-mono">{'{user_name}'}</code>,{' '}
            <code className="font-mono">{'{channels_list}'}</code>,{' '}
            <code className="font-mono">{'{founder_name}'}</code>,{' '}
            <code className="font-mono">{'{channel_url}'}</code>. Можно править под себя или очистить поле — тогда подставится текущий дефолт.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Авто-удаление предупреждения через
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={5}
              max={600}
              value={ttl}
              onChange={e => setTtl(Number(e.target.value))}
              className="w-24 px-3 py-2 text-sm border border-gray-200 rounded focus:outline-none focus:border-[#25455D]"
            />
            <span className="text-sm text-gray-600">секунд (5–600)</span>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
            Отмена
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !chatId.trim()}
            className="px-4 py-2 text-sm rounded-lg text-white font-medium disabled:opacity-50"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
          >
            {saving ? 'Сохраняю…' : (initial ? 'Сохранить' : 'Создать')}
          </button>
        </div>
      </div>
    </div>
  )
}
