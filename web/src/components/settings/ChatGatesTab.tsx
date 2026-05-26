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
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Gate | null>(null)
  const [verifyResults, setVerifyResults] = useState<Record<number, VerifyResult>>({})
  const [verifyingId, setVerifyingId] = useState<number | null>(null)

  async function loadAll() {
    setLoading(true)
    try {
      const [list, profile] = await Promise.all([
        api.miniApp.chatGates.list(),
        api.miniApp.profile.get().catch(() => null),
      ])
      setGates(list.items || [])
      const channels = (profile as any)?.social_links?.telegram_channels
      setHasChannels(Array.isArray(channels) && channels.length > 0)
    } catch (e: any) {
      alert(e?.message || 'Не удалось загрузить гейты')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAll() }, [])

  async function toggleActive(g: Gate) {
    try {
      const updated = await api.miniApp.chatGates.update(g.id, { is_active: !g.is_active })
      setGates(prev => prev.map(x => x.id === g.id ? updated : x))
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
          <AlertTriangle size={16} /> Включите отключение privacy mode у бота
        </div>
        <div className="text-amber-800">
          В <a href="https://t.me/BotFather" target="_blank" rel="noopener" className="underline">@BotFather</a>:
          {' '}<code className="font-mono">/mybots</code> → выберите бот → <code>Bot Settings</code> → <code>Group Privacy</code> → <code>Disable</code>.
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
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={gate.is_active}
            onChange={onToggle}
            disabled={toggleDisabled}
            className="w-4 h-4"
          />
          <span className={`text-sm ${toggleDisabled ? 'text-gray-400' : 'text-gray-700'}`}>
            {gate.is_active ? 'Активен' : 'Выключен'}
          </span>
        </label>
        <button
          type="button"
          onClick={onVerify}
          disabled={verifying}
          className="px-3 py-1.5 text-xs rounded bg-[#25455D] text-white flex items-center gap-1.5 disabled:opacity-50"
        >
          {verifying ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Проверить настройки
        </button>
        {gate.last_check_at && (
          <span className="text-xs text-gray-400">
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

function GateModal({
  initial, onClose, onSaved,
}: {
  initial: Gate | null
  onClose: () => void
  onSaved: () => void
}) {
  const [chatId, setChatId] = useState(initial?.chat_id || '')
  const [chatTitle, setChatTitle] = useState(initial?.chat_title || '')
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
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl max-w-lg w-full p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold text-gray-900">
          {initial ? 'Изменить гейт' : 'Добавить чат с гейтом'}
        </h3>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">ID чата</label>
          <input
            type="text"
            value={chatId}
            onChange={e => setChatId(e.target.value)}
            placeholder="-1001234567890"
            className="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded focus:outline-none focus:border-[#25455D]"
          />
          <p className="text-xs text-gray-500 mt-1">
            Числовой ID супергруппы/группы (начинается с «-100»). Как узнать:{' '}
            <a href="/dashboard/settings#tg-chat-id" className="text-[#25455D] underline">инструкция</a>.
            Не забудьте добавить вашего бота админом в этот чат с правом «Удаление сообщений».
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Название чата</label>
          <input
            type="text"
            value={chatTitle}
            onChange={e => setChatTitle(e.target.value)}
            placeholder="Например, «Чат участников»"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded focus:outline-none focus:border-[#25455D]"
          />
          <p className="text-xs text-gray-500 mt-1">Только для удобства, в Telegram не отправляется.</p>
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
