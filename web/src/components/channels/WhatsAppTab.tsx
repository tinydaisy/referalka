'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { CheckCircle2, Loader2, Smartphone, RefreshCw, Trash2, Check, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'

/**
 * Вкладка «WhatsApp» в /dashboard/channels.
 *
 * WhatsApp работает не через бота с токеном, а через WhatsApp-мост (whatsapp-web.js):
 * клиент привязывает свой аккаунт по QR-коду, дальше выбирает свои чаты/группы —
 * они попадают в базу чатов для рассылок (client_broadcast_chats, platform=whatsapp).
 *
 * Гейт — та же фича 'channels', что и для своего бота.
 */

type WaState = 'none' | 'starting' | 'qr' | 'authenticated' | 'ready' | 'auth_failure' | 'disconnected' | 'unknown'

interface WaChat { id: string; name: string; isGroup: boolean; unread: number }
interface SavedChat { id: number; chat_id: string; title: string | null; use_for_broadcasts: boolean }

const READY_STATES: WaState[] = ['ready', 'authenticated']

export default function WhatsAppTab() {
  const { me } = useMe()
  const hasFeature = (me?.features || []).includes('channels')

  const [connected, setConnected] = useState(false)
  const [state, setState] = useState<WaState>('none')
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [chats, setChats] = useState<WaChat[]>([])
  const [saved, setSaved] = useState<SavedChat[]>([])
  const [loadingChats, setLoadingChats] = useState(false)
  const [search, setSearch] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const isReady = READY_STATES.includes(state)

  const loadStatus = useCallback(async () => {
    try {
      const r = await api.channels.whatsappStatus()
      setConnected(!!r.connected)
      setState((r.state || 'none') as WaState)
      return r.state as WaState
    } catch { return 'unknown' as WaState }
  }, [])

  const loadSaved = useCallback(async () => {
    try {
      const r = await api.miniApp.broadcastChats.list()
      const rows: SavedChat[] = (r || []).filter((c: any) => c.platform === 'whatsapp')
      setSaved(rows)
    } catch {}
  }, [])

  useEffect(() => {
    if (!hasFeature) return
    loadStatus()
    loadSaved()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFeature])

  // Поллинг QR/статуса, пока идёт привязка
  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const q = await api.channels.whatsappQr()
        setState((q.state || 'none') as WaState)
        setQr(q.state === 'qr' ? q.qr : null)
        if (READY_STATES.includes(q.state as WaState)) {
          if (pollRef.current) clearInterval(pollRef.current)
          setQr(null)
          setConnected(true)
        }
      } catch {}
    }, 3000)
  }, [])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const connect = async () => {
    setBusy(true)
    try {
      await api.channels.connectWhatsapp()
      setConnected(true)
      setState('starting')
      startPolling()
    } catch (e: any) {
      alert(e?.message || 'Не удалось запустить привязку WhatsApp')
    } finally { setBusy(false) }
  }

  const loadChats = async () => {
    setLoadingChats(true)
    try {
      const r = await api.channels.whatsappChats()
      setChats(r.chats || [])
    } catch (e: any) {
      alert(e?.message || 'WhatsApp ещё не готов — подождите пару секунд и повторите')
    } finally { setLoadingChats(false) }
  }

  const savedByChatId = new Map(saved.map(s => [s.chat_id, s]))

  const toggleChat = async (c: WaChat) => {
    const already = savedByChatId.get(c.id)
    try {
      if (already) {
        await api.miniApp.broadcastChats.delete(already.id)
      } else {
        await api.miniApp.broadcastChats.create({
          platform: 'whatsapp', chat_id: c.id, title: c.name,
          is_public: false, added_via: 'manual',
        })
      }
      await loadSaved()
    } catch (e: any) {
      alert(e?.message || 'Не удалось изменить список')
    }
  }

  const disconnect = async () => {
    if (!confirm('Отвязать WhatsApp? Рассылки в его чаты перестанут отправляться.')) return
    setBusy(true)
    try {
      await api.channels.whatsappLogout()
      setConnected(false); setState('none'); setQr(null); setChats([]); setSaved([])
    } catch (e: any) {
      alert(e?.message || 'Не удалось отвязать')
    } finally { setBusy(false) }
  }

  if (!hasFeature) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">
        <p className="font-semibold text-slate-800 mb-1">WhatsApp доступен на тарифе с подключением своих каналов.</p>
        <p className="text-sm">Перейдите на нужный тариф в настройках профиля, чтобы привязать свой WhatsApp.</p>
      </div>
    )
  }

  const filtered = chats.filter(c =>
    !search || (c.name || '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="space-y-6">
      {/* Статус подключения */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex items-center gap-3 mb-3">
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-full text-white text-xs font-bold shrink-0" style={{ background: '#25D366' }}>WA</span>
          <div>
            <h3 className="font-semibold text-slate-900">WhatsApp</h3>
            <p className="text-xs text-slate-500">Привяжите свой аккаунт по QR-коду и выберите чаты для рассылок.</p>
          </div>
        </div>

        {!connected && (
          <button
            onClick={connect}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-white font-medium disabled:opacity-60"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Smartphone className="w-4 h-4" />}
            Подключить WhatsApp
          </button>
        )}

        {connected && !isReady && (
          <div className="mt-2">
            {qr ? (
              <div className="text-center">
                <p className="text-sm text-slate-700 mb-2">
                  WhatsApp на телефоне → <b>Настройки → Связанные устройства → Привязать устройство</b> → наведите на QR:
                </p>
                <img src={qr} alt="QR WhatsApp" className="mx-auto rounded-xl border border-slate-200" style={{ width: 'min(80vw, 300px)' }} />
                <p className="text-xs text-slate-400 mt-2">QR обновляется автоматически · состояние: {state}</p>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-slate-600 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Готовим QR-код… (состояние: {state})
              </div>
            )}
          </div>
        )}

        {connected && isReady && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-emerald-700 text-sm font-medium">
              <CheckCircle2 className="w-4 h-4" /> WhatsApp привязан
            </span>
            <button onClick={disconnect} disabled={busy}
              className="inline-flex items-center gap-1.5 text-sm text-rose-600 hover:text-rose-700">
              <Trash2 className="w-4 h-4" /> Отвязать
            </button>
          </div>
        )}
      </div>

      {/* Выбор чатов */}
      {connected && isReady && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-semibold text-slate-900">Чаты для рассылок</h3>
              <p className="text-xs text-slate-500">Отметьте свои группы/чаты — в них будет уходить рассылка при галочке «слать в общие чаты».</p>
            </div>
            <button onClick={loadChats} disabled={loadingChats}
              className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 disabled:opacity-60">
              {loadingChats ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Загрузить чаты
            </button>
          </div>

          {chats.length > 0 && (
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск по названию…"
              className="w-full mb-3 rounded-xl border border-slate-200 px-3 py-2 text-sm"
            />
          )}

          {chats.length === 0 && !loadingChats && (
            <p className="text-sm text-slate-400 py-4 text-center">Нажмите «Загрузить чаты», чтобы увидеть список групп и диалогов вашего WhatsApp.</p>
          )}

          <div className="max-h-96 overflow-y-auto divide-y divide-slate-100">
            {filtered.map(c => {
              const isSaved = savedByChatId.has(c.id)
              return (
                <button
                  key={c.id}
                  onClick={() => toggleChat(c)}
                  className="w-full flex items-center gap-3 py-2.5 px-1 text-left hover:bg-slate-50 rounded-lg"
                >
                  <span className={`inline-flex items-center justify-center w-5 h-5 rounded-md border shrink-0 ${isSaved ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300'}`}>
                    {isSaved && <Check className="w-3.5 h-3.5 text-white" />}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-sm text-slate-800">{c.name || c.id}</span>
                    <span className="text-[11px] text-slate-400">{c.isGroup ? 'Группа' : 'Личный чат'}</span>
                  </span>
                  {c.isGroup && <Users className="w-4 h-4 text-slate-300 shrink-0" />}
                </button>
              )
            })}
          </div>

          {saved.length > 0 && (
            <p className="text-xs text-emerald-700 mt-3">Выбрано для рассылок: {saved.length}</p>
          )}
        </div>
      )}
    </div>
  )
}
