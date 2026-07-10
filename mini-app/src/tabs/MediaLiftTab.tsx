import { useEffect, useState } from 'react'
import {
  getMedialiftChain, medialiftCheckSubscribe, medialiftAddChannel, medialiftMyCabinet, registerParticipant,
} from '../api'

const DARK = '#25455D'
const PEACH = '#FFCFA4'
const PASTELS = ['#fff8f0', '#f0f5fb', '#fbf2f0', '#f3f5f0', '#fdf6e8', '#f5f0fb']

interface Card {
  ec_id: number
  collaborator_id: number
  contact_id: number
  name: string
  description?: string | null
  tg_channel_url?: string | null
  photo_url?: string | null
  linked_client_id?: number | null
  gift_lead_magnet_id?: number | null
}

interface Props {
  event: any          // landing события (module_slug='medialift')
  tgUser?: any        // { id, first_name, last_name, username }
  contactId?: number  // contact_id зашедшего (если известен из startapp _ct)
  partnerId?: string  // pid = реф-код рефовода (кто привёл) — для цепочки
  isRegistered?: boolean
  onRegistered?: () => void
}

function initials(name?: string) {
  if (!name) return '?'
  const p = name.trim().split(/\s+/)
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase()
}

function tgLink(url?: string | null): string | null {
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return url
  if (url.startsWith('@')) return `https://t.me/${url.slice(1)}`
  return `https://t.me/${url}`
}

export default function MediaLiftTab({ event, tgUser, contactId, partnerId, isRegistered, onRegistered }: Props) {
  const [cards, setCards] = useState<Card[]>([])
  const [required, setRequired] = useState(3)
  const [selected, setSelected] = useState<Set<number>>(new Set())  // collaborator_id
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [registered, setRegistered] = useState(!!isRegistered)

  // «Добавь свой канал» + апселл
  const [channelUrl, setChannelUrl] = useState('')
  const [channelDesc, setChannelDesc] = useState('')
  const [channelAdded, setChannelAdded] = useState(false)
  const [addedTitle, setAddedTitle] = useState<string | null>(null)
  // Кабинет после добавления канала: ссылка, материалы, статистика.
  const [cabinet, setCabinet] = useState<any>(null)

  const slug = event?.slug

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const r = await getMedialiftChain(slug, contactId)
        if (!cancelled) {
          setCards(r.cards || [])
          setRequired(r.required_subscriptions ?? 3)
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Не удалось загрузить')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [slug, contactId])

  function toggle(collaboratorId: number) {
    setSelected(s => {
      const n = new Set(s)
      n.has(collaboratorId) ? n.delete(collaboratorId) : n.add(collaboratorId)
      return n
    })
  }

  async function handleEnter() {
    setError(null)
    if (selected.size < required) {
      setError(`Выберите и подпишитесь минимум на ${required}`)
      return
    }
    setBusy(true)
    try {
      // 1. Проверяем подписку на выбранные каналы
      const chk = await medialiftCheckSubscribe(slug, tgUser?.id, Array.from(selected))
      if (!chk.ok) {
        const names = (chk.not_subscribed || []).map((x: any) => x.name).join(', ')
        setError(`Не вижу подписки на: ${names}. Подпишитесь и нажмите ещё раз.`)
        setBusy(false)
        return
      }
      // 2. Регистрируем участника
      await registerParticipant({
        event_slug: slug,
        tg_id: tgUser?.id,
        username: tgUser?.username,
        first_name: tgUser?.first_name,
        last_name: tgUser?.last_name,
        ref_code: partnerId,   // pid рефовода → встаём в цепочку под ним
        contact_id: contactId,
      } as any)
      setRegistered(true)
      onRegistered?.()
    } catch (e: any) {
      setError(e.message || 'Ошибка входа')
    } finally {
      setBusy(false)
    }
  }

  async function handleAddChannel() {
    setError(null)
    const url = channelUrl.trim()
    if (!url) { setError('Укажите ссылку на ваш Telegram-канал'); return }
    setBusy(true)
    try {
      const r = await medialiftAddChannel(slug, tgUser?.id, url, channelDesc.trim() || undefined)
      setChannelAdded(true)
      setAddedTitle(r.channel_title || null)
      // Грузим кабинет (ссылка, материалы, статистика) по contact_id из ответа.
      if (r.contact_id) {
        try { setCabinet(await medialiftMyCabinet(slug, r.contact_id)) } catch {}
      }
    } catch (e: any) {
      setError(e.message || 'Не удалось добавить канал')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div style={{ padding: 20, color: '#6b7c8e' }}>Загружаем…</div>

  // ── Экран ПОСЛЕ добавления канала — апселл (2 платные ступени) ──
  if (channelAdded) {
    const st = cabinet?.stats
    const link = cabinet?.link || ''
    const texts: string[] = cabinet?.share_texts || []
    // Прикидка роста (та же логика, что на бэке): показы ветки → живые подписчики.
    const reach = st?.branch_reach ?? 0
    const estShows = Math.max(reach, st?.clicked ?? 0) * 4
    const estLive = Math.round(estShows * 0.43 * 0.6)
    const copy = (t: string) => { try { navigator.clipboard.writeText(t) } catch {} }
    return (
      <div style={{ padding: '20px 14px 90px' }}>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <div style={{ fontSize: 40 }}>✅</div>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: DARK, margin: '8px 0 4px' }}>
            Канал добавлен{addedTitle ? `: «${addedTitle}»` : ''}!
          </h1>
          <p style={{ fontSize: 14, color: '#6b7c8e', margin: 0 }}>
            Тут ваша ссылка и материалы. Рассказывайте — и ваш канал будет предлагаться всем, кто зайдёт под вами.
          </p>
        </div>

        {/* Ваша ссылка */}
        {link && (
          <div style={{ background: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, boxShadow: '0 2px 8px rgba(37,69,93,.05)' }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: DARK, marginBottom: 8 }}>🔗 Ваша ссылка</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input readOnly value={link} style={{ flex: 1, padding: '9px 11px', fontSize: 12, border: '1px solid #cfd8e0', borderRadius: 9 }} />
              <button onClick={() => copy(link)} style={{ background: DARK, color: '#fff', border: 'none', borderRadius: 9, padding: '0 14px', fontWeight: 700, fontSize: 13 }}>Копировать</button>
            </div>
          </div>
        )}

        {/* Статистика */}
        {st && (
          <div style={{ background: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, boxShadow: '0 2px 8px rgba(37,69,93,.05)' }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: DARK, marginBottom: 10 }}>📊 Статистика</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                [st.clicked, 'перешли по вашей ссылке'],
                [st.joined, 'подписались и вошли'],
                [st.branch_reach, 'всего под вами в ветке'],
                [st.total_system, 'всего в системе'],
              ].map(([n, l], i) => (
                <div key={i} style={{ background: '#f8fafc', borderRadius: 12, padding: 12, textAlign: 'center' }}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: DARK }}>{n as number}</div>
                  <div style={{ fontSize: 12, color: '#6b7c8e', marginTop: 2 }}>{l as string}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Готовые материалы */}
        {texts.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 14, padding: 14, marginBottom: 12, boxShadow: '0 2px 8px rgba(37,69,93,.05)' }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: DARK, marginBottom: 4 }}>✍️ Готовые материалы</div>
            <p style={{ fontSize: 12, color: '#6b7c8e', margin: '0 0 10px' }}>Скопируйте и разошлите — так растёт ваша аудитория.</p>
            {texts.map((t, i) => (
              <div key={i} style={{ background: '#f8fafc', borderRadius: 12, padding: 12, marginBottom: 10 }}>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginBottom: 8 }}>{t}</div>
                <button onClick={() => copy(t)} style={{ background: '#eef2f6', color: DARK, border: 'none', borderRadius: 8, padding: '7px 13px', fontWeight: 600, fontSize: 13 }}>📋 Скопировать</button>
              </div>
            ))}
          </div>
        )}

        {/* Свёрнутые прикидки роста */}
        {st && (
          <details style={{ background: '#fff', borderRadius: 14, padding: '12px 14px', marginBottom: 12 }}>
            <summary style={{ fontWeight: 700, color: DARK, cursor: 'pointer' }}>📈 Как можно вырасти (прикидка)</summary>
            <p style={{ fontSize: 13, color: '#6b7c8e', marginTop: 10 }}>
              Каждый, кто зашёл по вашей ссылке, подписывается на вас и приводит своих. За 3–4 уровня ветки под вами
              набирается порядка <b>{estShows}</b> показов вашего канала. При конверсии в подписку ~43% и с учётом
              отписок это примерно <b>{estLive} живых подписчиков</b> — без вложений в рекламу.
            </p>
          </details>
        )}

        {/* Апселл */}
        <div style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)', color: '#fff', borderRadius: 14, padding: 16, marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>Свой материал эффективнее канала</div>
          <p style={{ fontSize: 13, opacity: 0.85, margin: '0 0 12px' }}>Заведите лид-магнит — люди получат ценность и попадут в вашу базу.</p>
          <a href="https://pluson.ru/register" target="_blank" rel="noreferrer"
            style={{ display: 'block', textAlign: 'center', background: PEACH, color: DARK, fontWeight: 800, fontSize: 14, padding: '11px', borderRadius: 10, textDecoration: 'none' }}>
            🎁 ПЛЮСОН с лид-магнитом — 14 дней бесплатно
          </a>
        </div>
        <a href="https://pluson.ru/dashboard/collab-hub" target="_blank" rel="noreferrer"
          style={{ display: 'block', textAlign: 'center', background: DARK, color: '#fff', fontWeight: 800, fontSize: 14, padding: '12px', borderRadius: 12, textDecoration: 'none' }}>
          🤝 Коллабораторная — закрытый Хаб
        </a>
      </div>
    )
  }

  // ── Экран ПОСЛЕ регистрации — «добавь свой канал» ──
  if (registered) {
    return (
      <div style={{ padding: '20px 14px 90px' }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: DARK, margin: '4px 0 6px' }}>
          Добавьте свой канал
        </h1>
        <p style={{ fontSize: 14, color: '#6b7c8e', margin: '0 0 16px' }}>
          Вставьте ссылку на свой Telegram-канал — и вы попадёте в цепочку. Название
          подтянется автоматически.
        </p>
        {error && <div style={{ color: '#c0392b', fontSize: 13, marginBottom: 10 }}>{error}</div>}
        <input
          value={channelUrl} onChange={e => setChannelUrl(e.target.value)}
          placeholder="https://t.me/ваш_канал"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '11px 12px', fontSize: 14,
            border: '1px solid #cfd8e0', borderRadius: 10, marginBottom: 10,
          }} />
        <textarea
          value={channelDesc} onChange={e => setChannelDesc(e.target.value)}
          placeholder="Пара строк о себе (необязательно)"
          rows={3}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '11px 12px', fontSize: 14,
            border: '1px solid #cfd8e0', borderRadius: 10, marginBottom: 14, resize: 'vertical',
          }} />
        <button
          onClick={handleAddChannel} disabled={busy}
          style={{
            width: '100%', background: 'linear-gradient(45deg, #25455D, #0a1520)', color: '#fff',
            fontWeight: 800, fontSize: 15, padding: '13px', borderRadius: 12, border: 'none',
            cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
          }}>
          {busy ? 'Добавляем…' : 'Добавить канал'}
        </button>
      </div>
    )
  }

  // ── Экран ДО регистрации — карточки ветки + выбор 3 ──
  return (
    <div style={{ padding: '16px 12px 90px' }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, color: DARK, margin: '4px 8px 4px' }}>
        Подпишитесь минимум на {required}
      </h1>
      <p style={{ fontSize: 13, color: '#6b7c8e', margin: '0 8px 14px' }}>
        Отметьте карточки, подпишитесь на их каналы и войдите в систему.
      </p>

      {/* Счётчик */}
      <div style={{
        position: 'sticky', top: 8, zIndex: 5, margin: '0 4px 14px',
        background: selected.size >= required ? PEACH : '#fff',
        border: `2px solid ${selected.size >= required ? PEACH : '#e2e8ee'}`,
        borderRadius: 12, padding: '10px 14px', display: 'flex',
        alignItems: 'center', justifyContent: 'space-between',
        color: DARK, fontWeight: 800, fontSize: 14,
        boxShadow: '0 2px 8px rgba(37,69,93,0.08)',
      }}>
        <span>Выбрано: {selected.size} из {required}</span>
        <button
          onClick={handleEnter} disabled={busy || selected.size < required}
          style={{
            background: DARK, color: '#fff', fontWeight: 800, fontSize: 13,
            padding: '8px 16px', borderRadius: 9, border: 'none',
            cursor: (busy || selected.size < required) ? 'default' : 'pointer',
            opacity: (busy || selected.size < required) ? 0.5 : 1,
          }}>
          {busy ? '…' : 'Я подписался — войти'}
        </button>
      </div>

      {error && <div style={{ color: '#c0392b', fontSize: 13, margin: '0 8px 12px' }}>{error}</div>}

      {cards.length === 0 && (
        <div style={{ padding: 20, color: '#6b7c8e', textAlign: 'center' }}>
          Пока некого показать. Загляните позже.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {cards.map((c, idx) => {
          const isSel = selected.has(c.collaborator_id)
          const tg = tgLink(c.tg_channel_url)
          const isRich = !!c.linked_client_id  // клиент ПЛЮСОНа — «богатая» карточка
          return (
            <div key={c.collaborator_id}
              onClick={() => toggle(c.collaborator_id)}
              style={{
                background: PASTELS[idx % PASTELS.length],
                borderRadius: 14, padding: 14, cursor: 'pointer',
                border: isSel ? `2px solid ${PEACH}` : '2px solid transparent',
                boxShadow: isSel ? '0 4px 16px rgba(255,207,164,0.5)' : '0 2px 8px rgba(37,69,93,0.05)',
                transition: 'border-color .2s, box-shadow .2s',
              }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                {/* Чекбокс */}
                <div style={{
                  width: 24, height: 24, borderRadius: 6, flexShrink: 0, marginTop: 2,
                  border: `2px solid ${isSel ? PEACH : '#c4cfd8'}`,
                  background: isSel ? PEACH : '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: DARK, fontWeight: 800, fontSize: 15,
                }}>{isSel ? '✓' : ''}</div>

                {/* Аватар — фото только у «богатой» карточки, иначе инициалы */}
                <div style={{
                  width: 52, height: 52, borderRadius: '50%', flexShrink: 0,
                  background: (isRich && c.photo_url)
                    ? `center/cover url(${c.photo_url})`
                    : 'linear-gradient(45deg, #25455D, #0a1520)',
                  border: `2px solid ${PEACH}`, display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  color: PEACH, fontWeight: 700, fontSize: 17,
                }}>{(!isRich || !c.photo_url) && initials(c.name)}</div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#1a2a3a' }}>{c.name}</div>
                  {c.description && (
                    <div style={{ fontSize: 12, color: '#6b7c8e', marginTop: 3, lineHeight: 1.4 }}>
                      {c.description}
                    </div>
                  )}
                  {/* Подарок — только у «богатой» карточки (клиент ПЛЮСОНа) */}
                  {isRich && c.gift_lead_magnet_id && (
                    <div style={{ fontSize: 12, color: DARK, fontWeight: 700, marginTop: 6 }}>
                      🎁 Подарок за подписку
                    </div>
                  )}
                  {tg && (
                    <a href={tg} target="_blank" rel="noreferrer"
                      onClick={e => e.stopPropagation()}
                      style={{
                        display: 'inline-block', marginTop: 8, background: DARK, color: '#fff',
                        fontSize: 12, fontWeight: 700, padding: '6px 12px', borderRadius: 8,
                        textDecoration: 'none',
                      }}>
                      Открыть канал →
                    </a>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
