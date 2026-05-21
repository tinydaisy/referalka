// Общий шлюз входа в чат события.
// Делает проверку подписки на каналы соорганизаторов на каждый клик —
// см. backend/app/api/subscription_check.py.
//
// Использование:
//   const { openChat, modal, debug } = useChatGate(event, tgUser)
//   <button onClick={openChat}>Войти в чат</button>
//   {modal}
//   {debug && <div>{debug}</div>}
import { useState } from 'react'
import { checkConferenceSubscription } from '../api'
import { getPlatform } from '../platform'

const PEACH = '#FFCFA4'
const DARK = '#25455D'

type SubChannel = { speaker_id: number; name: string; tg_channel_id: string; tg_channel_url: string | null }

// Открыть внешнюю ссылку через platform-адаптер.
// TG → openTelegramLink/openLink; VK → window.top.location (iframe);
// MAX → openLink. См. src/platform/{telegram,vk,max}.ts.
function openExternal(url: string) {
  getPlatform().openExternal(url)
}

export function useChatGate(event: any, tgUser: any) {
  const isConference = ['conference','turnir'].includes(event?.module_slug)

  const [chatGate, setChatGate] = useState<{
    loading: boolean
    notSubscribed: SubChannel[] | null
    subscribed: SubChannel[]
    error?: string | null
  }>({ loading: false, notSubscribed: null, subscribed: [] })

  // [DEBUG TEMP] последний результат запроса для отладки
  const [debug, setDebug] = useState<string>('')

  async function openChat() {
    if (!event?.chat_url) return
    const needsCheck = isConference || !!event?.require_subscription
    if (!needsCheck || !event?.id || !tgUser?.id) {
      setDebug(`ПРОПУЩЕНО: needsCheck=${needsCheck} eventId=${event?.id} tgId=${tgUser?.id || '(пусто)'} module=${event?.module_slug} require_sub=${event?.require_subscription} isConf=${isConference}`)
      openExternal(event.chat_url)
      return
    }
    setDebug(`ИДЁТ запрос: tgId=${tgUser.id} eventId=${event.id}`)
    setChatGate({ loading: true, notSubscribed: null, subscribed: [], error: null })
    try {
      const r: any = await checkConferenceSubscription(event.id, tgUser.id)
      setDebug(`ОТВЕТ: status=${r?.status} not_sub=${(r?.not_subscribed || []).length} sub=${(r?.subscribed || []).length}`)
      if (r?.status === 1) {
        setChatGate({ loading: false, notSubscribed: null, subscribed: [] })
        openExternal(event.chat_url)
      } else {
        setChatGate({
          loading: false,
          notSubscribed: r?.not_subscribed || [],
          subscribed: r?.subscribed || [],
        })
      }
    } catch (e: any) {
      setDebug(`ОШИБКА: ${e?.message || 'неизвестная'}`)
      setChatGate({ loading: false, notSubscribed: null, subscribed: [], error: e?.message || 'Не удалось проверить подписку' })
    }
  }

  async function recheck() {
    if (!event?.id || !tgUser?.id) return
    setChatGate(g => ({ ...g, loading: true, error: null }))
    try {
      const r: any = await checkConferenceSubscription(event.id, tgUser.id)
      if (r?.status === 1) {
        setChatGate({ loading: false, notSubscribed: null, subscribed: [] })
        openExternal(event.chat_url)
      } else {
        setChatGate({
          loading: false,
          notSubscribed: r?.not_subscribed || [],
          subscribed: r?.subscribed || [],
        })
      }
    } catch (e: any) {
      setChatGate(g => ({ ...g, loading: false, error: e?.message || 'Не удалось проверить' }))
    }
  }

  function close() {
    setChatGate({ loading: false, notSubscribed: null, subscribed: [] })
  }

  const modal = chatGate.notSubscribed && chatGate.notSubscribed.length > 0 ? (
    <div onClick={close} style={{
      position: 'fixed', inset: 0, background: 'rgba(10,21,32,0.7)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      zIndex: 1000,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'white', borderRadius: '16px 16px 0 0',
        width: '100%', maxWidth: 520,
        padding: '20px 18px 24px', maxHeight: '85vh', overflowY: 'auto',
      }}>
        <div style={{ width: 40, height: 4, background: '#ddd', borderRadius: 2, margin: '0 auto 16px' }} />

        <h3 style={{ color: DARK, fontSize: 17, fontWeight: 800, margin: '0 0 6px' }}>
          Чтобы войти в чат
        </h3>
        <p style={{ color: '#666', fontSize: 13, lineHeight: 1.5, margin: '0 0 16px' }}>
          Подпишитесь на {chatGate.notSubscribed.length === 1 ? 'канал' : 'каналы'} ниже —
          после этого нажмите «Я подписался».
        </p>

        <ol style={{ listStyle: 'none', padding: 0, margin: '0 0 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {chatGate.notSubscribed.map((ch, idx) => (
            <li key={`ns-${ch.speaker_id}`}>
              <a href={ch.tg_channel_url || '#'} target="_blank" rel="noreferrer" style={{
                display: 'flex', alignItems: 'center', gap: 10,
                background: '#f6f8fb', borderRadius: 12, padding: '10px 12px',
                textDecoration: 'none', color: DARK, border: '1px solid #e5e9f0',
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%', background: PEACH,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, color: DARK, fontSize: 14, fontWeight: 800,
                }}>
                  {idx + 1}
                </div>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ch.name}
                </div>
                <span style={{ fontSize: 12, color: DARK, fontWeight: 700 }}>Подписаться →</span>
              </a>
            </li>
          ))}
        </ol>

        {chatGate.subscribed && chatGate.subscribed.length > 0 && (
          <>
            <div style={{
              fontSize: 11, color: '#888', textTransform: 'uppercase',
              letterSpacing: 0.5, fontWeight: 700, margin: '6px 2px 6px',
            }}>
              Уже подписаны
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {chatGate.subscribed.map(ch => (
                <li key={`s-${ch.speaker_id}`}>
                  <a href={ch.tg_channel_url || '#'} target="_blank" rel="noreferrer" style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: '#f3faf4', borderRadius: 12, padding: '8px 12px',
                    textDecoration: 'none', color: DARK, border: '1px solid #d8ecdb',
                  }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%', background: '#3aa758',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0, color: 'white', fontSize: 14, fontWeight: 800,
                    }}>
                      ✓
                    </div>
                    <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: '#3a4a3a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ch.name}
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}

        {chatGate.error && (
          <div style={{ color: '#c0392b', fontSize: 12, marginBottom: 10 }}>{chatGate.error}</div>
        )}

        <button onClick={recheck} disabled={chatGate.loading} style={{
          width: '100%', padding: '13px 16px', border: 0, borderRadius: 12,
          background: PEACH, color: DARK, fontSize: 14, fontWeight: 800,
          cursor: 'pointer', fontFamily: 'inherit',
          opacity: chatGate.loading ? 0.7 : 1,
        }}>
          {chatGate.loading ? 'Проверяем…' : 'Я подписался — проверить'}
        </button>

        <button onClick={close} style={{
          width: '100%', padding: '11px', marginTop: 8, border: 0,
          background: 'transparent', color: '#888', fontSize: 13, fontWeight: 600,
          cursor: 'pointer', fontFamily: 'inherit',
        }}>
          Закрыть
        </button>
      </div>
    </div>
  ) : null

  return { openChat, modal, loading: chatGate.loading, debug }
}
