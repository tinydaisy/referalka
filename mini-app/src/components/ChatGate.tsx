// Общий шлюз входа в чат события.
// Делает проверку подписки на каналы соорганизаторов на каждый клик —
// см. backend/app/api/subscription_check.py.
//
// С миграции 095 у события может быть до трёх чатов: TG, VK, MAX +
// primary_chat_platform — какой считается «основным». После проверки
// подписки (если нужна) показываем модалку выбора чата с этими кнопками.
// Главный чат — крупная кнопка наверху, остальные — «Резервные чаты»
// помельче внизу. Если ссылка задана только одна — открываем сразу,
// модалку не показываем.
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
type ChatPlatform = 'telegram' | 'vk' | 'max'

// Открыть внешнюю ссылку через platform-адаптер.
// TG → openTelegramLink/openLink; VK → window.top.location (iframe);
// MAX → openLink. См. src/platform/{telegram,vk,max}.ts.
function openExternal(url: string) {
  getPlatform().openExternal(url)
}

const PLATFORM_META: Record<ChatPlatform, { label: string; badge: string; color: string }> = {
  telegram: { label: 'Telegram',  badge: 'TG',  color: '#229ED9' },
  vk:       { label: 'ВКонтакте', badge: 'VK',  color: '#4680BD' },
  max:      { label: 'MAX',       badge: 'MAX', color: '#F45D22' },
}

// Список заполненных чатов события в порядке: главный → остальные.
function collectChats(event: any): { platform: ChatPlatform; url: string; isPrimary: boolean }[] {
  const tg  = (event?.chat_url_tg  || '').trim()
  const vk  = (event?.chat_url_vk  || '').trim()
  const mx  = (event?.chat_url_max || '').trim()
  let primary = event?.primary_chat_platform as ChatPlatform | null
  // Старые данные: если новые поля пусты, но есть chat_url — это TG-ссылка
  // (исторически только TG-чаты поддерживались). primary = 'telegram'.
  const legacy = (event?.chat_url || '').trim()
  let tgUrl = tg
  if (!tg && !vk && !mx && legacy) {
    tgUrl = legacy
    primary = 'telegram'
  }
  const urls: Record<ChatPlatform, string> = { telegram: tgUrl, vk, max: mx }
  // Сначала главный (если задан и заполнен), затем остальные в фиксированном порядке
  const order: ChatPlatform[] = ['telegram', 'vk', 'max']
  const result: { platform: ChatPlatform; url: string; isPrimary: boolean }[] = []
  if (primary && urls[primary]) {
    result.push({ platform: primary, url: urls[primary], isPrimary: true })
  }
  for (const p of order) {
    if (p === primary) continue
    if (urls[p]) result.push({ platform: p, url: urls[p], isPrimary: false })
  }
  return result
}

export function useChatGate(event: any, tgUser: any) {
  const isConference = ['conference','turnir'].includes(event?.module_slug)

  const [chatGate, setChatGate] = useState<{
    loading: boolean
    notSubscribed: SubChannel[] | null
    subscribed: SubChannel[]
    error?: string | null
  }>({ loading: false, notSubscribed: null, subscribed: [] })

  // Когда true — показываем модалку с выбором чата (TG/VK/MAX).
  // Открывается, когда подписки ОК (или не нужны) и доступно больше одного чата.
  const [chooserOpen, setChooserOpen] = useState(false)
  // Организаторы коллабы, чьи боты предлагаем, когда контакт неизвестен.
  const [botOwners, setBotOwners] = useState<any[] | null>(null)

  // [DEBUG TEMP] последний результат запроса для отладки
  const [debug, setDebug] = useState<string>('')

  // Если задан ровно один чат — открыть сразу. Если несколько — показать модалку выбора.
  function openOneOrChoose(chats: ReturnType<typeof collectChats>) {
    if (chats.length === 0) return
    if (chats.length === 1) {
      openExternal(chats[0].url)
      return
    }
    setChooserOpen(true)
  }

  async function openChat() {
    const chats = collectChats(event)
    if (chats.length === 0) return
    // Проверка подписки сейчас работает только для Telegram-каналов
    // (через Bot API getChatMember). На VK/MAX площадки подписки спикеров
    // ещё не реализованы — поэтому в VK/MAX пускаем в чат без проверки.
    // TODO: реализовать проверку подписок на VK-сообщества и MAX-каналы.
    const platformName = getPlatform().name
    const needsSub = isConference || !!event?.require_subscription

    // ⚠️⚠️ ПОДПИСКУ УМЕЕМ ПРОВЕРИТЬ ТОЛЬКО В TELEGRAM — там есть аккаунт
    // человека. В браузере, MAX и ВКонтакте проверять нечем, и раньше чаты
    // отдавались СРАЗУ: человек получал ссылку, ничего не подписав, хотя
    // организатор требовал подписку.
    //
    // Правильный путь — отправить его в БОТА, где проверка и произойдёт.
    // Контакт известен → бот его организатора (`chat_bot_links`). Неизвестен
    // → показываем ботов всех организаторов (`chat_bot_owners`), первым тот,
    // кто привёл больше людей: решать за человека нельзя — у чужого
    // организатора его нет, проверку он не пройдёт и чат не получит.
    if (needsSub && platformName !== 'telegram') {
      const owners: any[] = event?.chat_bot_owners || []
      if (owners.length > 1) {
        setBotOwners(owners)
        return
      }
      const own = event?.chat_bot_links || {}
      const url = own[platformName] || own.telegram || own.max || own.vk
      if (url) { openExternal(url); return }
      // ссылок в ботов нет вовсе → отдаём чат как раньше, чтобы не запереть
    }

    const needsCheck = needsSub && platformName === 'telegram'
    if (!needsCheck || !event?.id || !tgUser?.id) {
      setDebug(`ПРОПУЩЕНО: platform=${platformName} needsCheck=${needsCheck} eventId=${event?.id} tgId=${tgUser?.id || '(пусто)'} module=${event?.module_slug} require_sub=${event?.require_subscription} isConf=${isConference}`)
      openOneOrChoose(chats)
      return
    }
    setDebug(`ИДЁТ запрос: tgId=${tgUser.id} eventId=${event.id}`)
    setChatGate({ loading: true, notSubscribed: null, subscribed: [], error: null })
    try {
      const r: any = await checkConferenceSubscription(event.id, tgUser.id)
      setDebug(`ОТВЕТ: status=${r?.status} not_sub=${(r?.not_subscribed || []).length} sub=${(r?.subscribed || []).length}`)
      if (r?.status === 1) {
        setChatGate({ loading: false, notSubscribed: null, subscribed: [] })
        openOneOrChoose(chats)
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
        openOneOrChoose(collectChats(event))
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
  function closeChooser() {
    setChooserOpen(false)
  }

  const chats = collectChats(event)
  const primaryChat = chats.find(c => c.isPrimary) || chats[0]
  const backupChats = chats.filter(c => c !== primaryChat)

  // ⚠️ Выбор организатора: в коллабе у каждого свой бот и своя база. Первым
  // идёт тот, кто привёл больше людей (порядок задаёт бэкенд).
  const ownerModal = botOwners && botOwners.length > 1 ? (
    <div onClick={() => setBotOwners(null)} style={{
      position: 'fixed', inset: 0, background: 'rgba(10,21,32,0.7)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 1000,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'white', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: 520,
        padding: '20px 18px 24px', maxHeight: '85vh', overflowY: 'auto',
      }}>
        <div style={{ width: 40, height: 4, background: '#ddd', borderRadius: 2, margin: '0 auto 16px' }} />
        <h3 style={{ color: DARK, fontSize: 17, fontWeight: 800, margin: '0 0 6px' }}>
          Войти в чат события
        </h3>
        <p style={{ color: '#666', fontSize: 13, lineHeight: 1.5, margin: '0 0 16px' }}>
          Событие ведут несколько организаторов. Выберите, через чьего бота войти —
          он проверит подписку и пришлёт ссылку на чат.
        </p>
        {botOwners.map((o: any) => (
          <div key={o.client_id} style={{ marginBottom: 14 }}>
            <div style={{
              fontSize: 11, color: '#888', textTransform: 'uppercase',
              letterSpacing: 0.5, fontWeight: 700, margin: '2px 2px 6px',
            }}>{o.name}</div>
            {Object.entries(o.links || {}).map(([plat, url]: any) => (
              <button key={plat}
                onClick={() => { setBotOwners(null); openExternal(url as string) }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', marginBottom: 6,
                  background: '#f5f7fa', border: '1px solid #e3e8ee', borderRadius: 10,
                  padding: '11px 14px', fontSize: 14, fontWeight: 700, color: DARK,
                  cursor: 'pointer',
                }}>
                {plat === 'telegram' ? 'Telegram' : plat === 'vk' ? 'ВКонтакте' : 'MAX'}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  ) : null

  const chooserModal = chooserOpen && chats.length > 1 ? (
    <div onClick={closeChooser} style={{
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
          Войти в чат события
        </h3>
        <p style={{ color: '#666', fontSize: 13, lineHeight: 1.5, margin: '0 0 16px' }}>
          Выберите площадку, на которой вам удобнее общаться.
        </p>

        {primaryChat && (
          <>
            <div style={{
              fontSize: 11, color: '#888', textTransform: 'uppercase',
              letterSpacing: 0.5, fontWeight: 700, margin: '2px 2px 6px',
            }}>
              Основной чат
            </div>
            <button
              onClick={() => { closeChooser(); openExternal(primaryChat.url) }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                background: 'linear-gradient(135deg, #FFCFA4, #f5b97e)',
                border: 0, borderRadius: 14, padding: '14px 14px',
                color: DARK, fontSize: 15, fontWeight: 800,
                cursor: 'pointer', fontFamily: 'inherit', marginBottom: 14,
              }}
            >
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: PLATFORM_META[primaryChat.platform].color,
                color: 'white', borderRadius: 8, padding: '4px 8px',
                fontSize: 11, fontWeight: 800, letterSpacing: 0.5, minWidth: 38,
              }}>
                {PLATFORM_META[primaryChat.platform].badge}
              </span>
              <span style={{ flex: 1, textAlign: 'left' }}>
                Войти в {PLATFORM_META[primaryChat.platform].label}
              </span>
              <span style={{ fontSize: 18 }}>→</span>
            </button>
          </>
        )}

        {backupChats.length > 0 && (
          <>
            <div style={{
              fontSize: 11, color: '#888', textTransform: 'uppercase',
              letterSpacing: 0.5, fontWeight: 700, margin: '2px 2px 6px',
            }}>
              Резервные чаты
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {backupChats.map(c => (
                <button
                  key={c.platform}
                  onClick={() => { closeChooser(); openExternal(c.url) }}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                    background: '#f6f8fb', border: '1px solid #e5e9f0',
                    borderRadius: 12, padding: '11px 14px',
                    color: DARK, fontSize: 13, fontWeight: 700,
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: PLATFORM_META[c.platform].color,
                    color: 'white', borderRadius: 6, padding: '3px 7px',
                    fontSize: 10, fontWeight: 800, letterSpacing: 0.5, minWidth: 34,
                  }}>
                    {PLATFORM_META[c.platform].badge}
                  </span>
                  <span style={{ flex: 1, textAlign: 'left' }}>
                    Войти в {PLATFORM_META[c.platform].label}
                  </span>
                  <span style={{ fontSize: 16, color: '#888' }}>→</span>
                </button>
              ))}
            </div>
          </>
        )}

        <button onClick={closeChooser} style={{
          width: '100%', padding: '11px', marginTop: 14, border: 0,
          background: 'transparent', color: '#888', fontSize: 13, fontWeight: 600,
          cursor: 'pointer', fontFamily: 'inherit',
        }}>
          Закрыть
        </button>
      </div>
    </div>
  ) : null

  const subscriptionModal = chatGate.notSubscribed && chatGate.notSubscribed.length > 0 ? (
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

  const modal = <>{subscriptionModal}{chooserModal}{ownerModal}</>

  return { openChat, modal, loading: chatGate.loading, debug }
}
