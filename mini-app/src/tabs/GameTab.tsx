import { useEffect, useState } from 'react'
import { getGifts, getShareTexts, getShareMaterials, sendShareTextToBot } from '../api'
import ContactCardModal from '../components/ContactCardModal'

interface Props { event: any; participant: any; tgUser: any }

const APP_URL = import.meta.env.VITE_APP_URL || 'https://pluson.ru'
const PEACH = '#FFCFA4'
const DARK = '#25455D'

interface Gift {
  id: number
  title: string
  description?: string
  points_cost: number
  link_url?: string
}

interface RefPerson {
  id: number | string
  name: string
  username?: string
  is_registered: boolean
  initials: string
  color: string
}

const COLORS = [
  ['#d4789a', '#8b4561'],
  ['#4a90e2', '#2c5f9b'],
  ['#6bb572', '#3d7a44'],
  ['#c9a14b', '#8a6b2e'],
  ['#9c27b0', '#6a1b9a'],
]

const RU_MONTHS = ['января','февраля','марта','апреля','мая','июня',
                   'июля','августа','сентября','октября','ноября','декабря']

function fmtMSK(iso?: string | null): { day: number; month: number; year: number } | null {
  if (!iso) return null
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return null
    // Парсим компоненты в МСК
    const opts: Intl.DateTimeFormatOptions = { timeZone: 'Europe/Moscow', day: 'numeric', month: 'numeric', year: 'numeric' }
    const parts = new Intl.DateTimeFormat('ru-RU', opts).formatToParts(d)
    const day = Number(parts.find(p => p.type === 'day')?.value || 0)
    const month = Number(parts.find(p => p.type === 'month')?.value || 0)
    const year = Number(parts.find(p => p.type === 'year')?.value || 0)
    if (!day || !month) return null
    return { day, month: month - 1, year }
  } catch { return null }
}

function formatEventDates(startAt?: string | null, endAt?: string | null): string {
  const a = fmtMSK(startAt)
  const b = fmtMSK(endAt)
  if (!a && !b) return ''
  if (a && !b) return `${a.day} ${RU_MONTHS[a.month]} ${a.year}`
  if (!a && b) return `${b!.day} ${RU_MONTHS[b!.month]} ${b!.year}`
  // оба есть
  if (a!.year === b!.year && a!.month === b!.month && a!.day === b!.day) {
    return `${a!.day} ${RU_MONTHS[a!.month]} ${a!.year}`
  }
  if (a!.year === b!.year && a!.month === b!.month) {
    return `${a!.day}–${b!.day} ${RU_MONTHS[a!.month]} ${a!.year}`
  }
  if (a!.year === b!.year) {
    return `${a!.day} ${RU_MONTHS[a!.month]} – ${b!.day} ${RU_MONTHS[b!.month]} ${a!.year}`
  }
  return `${a!.day} ${RU_MONTHS[a!.month]} ${a!.year} – ${b!.day} ${RU_MONTHS[b!.month]} ${b!.year}`
}

export default function GameTab({ event, participant, tgUser }: Props) {
  const [gifts, setGifts] = useState<Gift[]>([])
  const [view, setView] = useState<'game' | 'gifts' | 'materials'>('game')
  const [topOpen, setTopOpen] = useState(false)
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedTextId, setCopiedTextId] = useState<number | null>(null)
  const [openCardId, setOpenCardId] = useState<number | null>(null)
  const [shareTexts, setShareTexts] = useState<{ id: number; content: string; sort: number }[]>([])
  const [shareImages, setShareImages] = useState<{ id: number; image_url: string; source: string }[]>([])
  const [sendingAll, setSendingAll] = useState(false)

  // Данные участника
  const refCode  = participant?.ref_code || 'demo'
  const slug     = event?.slug || 'event'
  const visited     = participant?.visited_count    ?? participant?.referrals_count ?? 0
  const registered  = participant?.registered_count ?? participant?.points_total    ?? 0
  const myRank      = participant?.my_rank
  // gift_count_value — то число, по которому реально открываются подарки;
  // зависит от gift_count_mode (registered/visited/clicked_link) клиента.
  // Если бэк не отдал (старая версия) — fallback на registered.
  const giftCountValue: number = participant?.gift_count_value ?? registered
  // Партнёрская ссылка → веб-лендинг с редиректом.
  // Если у клиента настроен внешний лендинг (events.landing_url, обычно Tilda/GetCourse) —
  // друг попадает СНАЧАЛА на него (формы клиента, аналитика, brand) и только потом
  // в Telegram-бот. redirect_web_app.js парсит ?app=tg&pid=... → startapp=ref_pg{slug}_pid{pid}.
  const refLink = `${APP_URL}/l/${slug}?app=tg&pid=${refCode}`

  // Загружаем подарки → понимаем «следующий» по порогу
  useEffect(() => {
    if (event?.slug) {
      getGifts(event.slug)
        .then(r => setGifts(r.gifts || []))
        .catch(() => setGifts([]))
    }
  }, [event?.slug])

  // Материалы для шеринга — тексты и картинки
  useEffect(() => {
    if (event?.id) {
      getShareTexts(event.id).then(r => setShareTexts(r.items || [])).catch(() => setShareTexts([]))
      getShareMaterials(event.id).then(r => setShareImages(r.items || [])).catch(() => setShareImages([]))
    }
  }, [event?.id])

  const sortedGifts = [...gifts].sort((a, b) => a.points_cost - b.points_cost)
  // Получено подарков считаем локально из загруженных порогов: даёт честное
  // число и для случая «подарок за 0 регистраций» (порог 0 ≤ registered).
  // Если бэк уже вернул gifts_received_count и пороги ещё не догрузились —
  // используем серверное число, чтобы не моргать нулём.
  // Полученные подарки (по убыванию порога — последний в массиве самый «сильный»).
  const receivedGifts = sortedGifts.filter(g => giftCountValue >= g.points_cost)
  const giftsCount = sortedGifts.length > 0
    ? receivedGifts.length
    : (participant?.gifts_received_count ?? 0)
  const lastReceived = receivedGifts.length > 0 ? receivedGifts[receivedGifts.length - 1] : null
  const nextGift = sortedGifts.find(g => g.points_cost > giftCountValue)
  const toNext = nextGift ? nextGift.points_cost - giftCountValue : 0
  const progressPct = nextGift ? Math.min(100, Math.round((giftCountValue / nextGift.points_cost) * 100)) : 100

  // ТОП и Ваши люди — приходят с бэка
  const top: {
    rank: number; name: string; count: number;
    username?: string | null; tg_id?: string | null;
    participant_id?: number; isMe?: boolean
  }[] = participant?.top || []
  const myPeople: RefPerson[] = (participant?.my_people || []).map((p: any, i: number) => ({
    ...p,
    initials: (p.name || '?').slice(0, 2).toUpperCase(),
    color: COLORS[i % COLORS.length].join('|'),
  }))

  function copy(text: string) {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Подстановка плейсхолдеров в тексты-примеры. Должно совпадать со списком
  // SHARE_PLACEHOLDERS в дашборде ([ReferralProgramTab.tsx](web/src/app/dashboard/events/[id]/tabs/ReferralProgramTab.tsx)).
  function applyPlaceholders(tpl: string): string {
    const eventTitle = (event?.title as string) || ''
    const userName   = (tgUser?.first_name as string) || ''
    const brandName  = (event?.client_brand as string) || (event?.client_name as string) || ''
    const dateStr    = formatEventDates(event?.start_at, event?.end_at)
    return (tpl || '')
      .replaceAll('{link}',  refLink)
      .replaceAll('{event}', eventTitle)
      .replaceAll('{date}',  dateStr)
      .replaceAll('{name}',  userName)
      .replaceAll('{brand}', brandName)
  }

  function share() {
    const twa = (window as any).Telegram?.WebApp
    const text = `Присоединяйтесь к ${event?.title || 'событию'}: ${refLink}`
    if (twa?.openTelegramLink) {
      twa.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent(text)}`)
    } else {
      copy(refLink)
    }
  }

  // ──────────── view: gifts (окно «Подарки») ────────────
  if (view === 'gifts') {
    const got = sortedGifts.filter(g => giftCountValue >= g.points_cost)
    const locked = sortedGifts.filter(g => giftCountValue < g.points_cost)
    // Текст про правило подсчёта зависит от gift_count_mode и типа события.
    const giftMode: string = participant?.gift_count_mode || 'registered'
    const isContest = event?.module_slug === 'contest'
    const giftRuleHint =
      giftMode === 'visited'      ? <>Подарки выдаются за <strong>любой переход</strong> по партнёрской ссылке.</> :
      giftMode === 'clicked_link' ? (isContest
        ? <>Подарки выдаются за <strong>проголосовавших</strong> людей — кто нажал «Перейти к голосованию» в Mini App.</>
        : <>Подарки выдаются за <strong>присутствовавших в эфире</strong> — кто нажал «Смотреть стрим» в Mini App.</>
      ) :
      <>Подарки выдаются за <strong>зарегистрировавшихся</strong> людей (не за переходы).</>
    return (
      <div className="fade-in" style={{ padding: '0 0 24px' }}>
        <button onClick={() => setView('game')} style={{
          background: 'none', border: 'none', color: 'var(--muted)',
          fontSize: 13, padding: '4px 0', cursor: 'pointer', marginBottom: 8,
        }}>← Назад в Игру</button>

        {/* Жёлтое предупреждение */}
        <div style={{
          background: '#fff8e1', border: '1px solid #ffd54f',
          borderRadius: 12, padding: '10px 12px', marginBottom: 14,
          display: 'flex', gap: 10, alignItems: 'flex-start',
        }}>
          <div style={{ fontSize: 18, lineHeight: 1, color: '#b86b00', flexShrink: 0 }}>⚠</div>
          <div style={{ fontSize: 11, color: '#7a5a00', lineHeight: 1.5 }}>
            {giftRuleHint}
          </div>
        </div>

        <h3 style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
                     color: '#6b7c8e', margin: '4px 4px 10px' }}>
          ✓ Получено · {got.length}
        </h3>
        {got.length === 0
          ? <div style={{ color: 'var(--muted)', fontSize: 12, padding: 10, textAlign: 'center' }}>Пока ничего не получено</div>
          : got.map(g => (
            <div key={g.id} style={{
              background: 'white', borderRadius: 14, padding: 14, marginBottom: 10,
              display: 'flex', gap: 12, alignItems: 'center',
              boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
            }}>
              <div style={{
                width: 48, height: 48, borderRadius: 12, flexShrink: 0,
                background: 'linear-gradient(135deg, #fff4e0, #FFCFA4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
              }}>🎁</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a', marginBottom: 3 }}>{g.title}</div>
                {g.description && <div style={{ fontSize: 11, color: '#6b7c8e' }}>{g.description}</div>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#2e7d32',
                              background: '#e8f5e9', padding: '3px 7px', borderRadius: 5 }}>за {g.points_cost} чел</div>
                {g.link_url && (
                  <a href={g.link_url} target="_blank" rel="noreferrer" style={{
                    background: 'linear-gradient(135deg, #25455D, #0a1520)', color: PEACH,
                    padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                    textDecoration: 'none',
                  }}>Открыть</a>
                )}
              </div>
            </div>
          ))}

        {locked.length > 0 && (
          <>
            <h3 style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
                         color: '#6b7c8e', margin: '14px 4px 10px' }}>
              🔒 Заблокировано · {locked.length}
            </h3>
            {locked.map(g => {
              const need = g.points_cost - giftCountValue
              return (
                <div key={g.id} style={{
                  background: '#f7f8fa', borderRadius: 14, padding: 14, marginBottom: 10,
                  display: 'flex', gap: 12, alignItems: 'center', opacity: 0.7,
                }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: 12, flexShrink: 0,
                    background: '#eef2f7',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
                    color: '#b0bcc8', position: 'relative',
                  }}>🎁<div style={{
                    position: 'absolute', right: -4, bottom: -4,
                    background: DARK, color: PEACH, width: 20, height: 20,
                    borderRadius: '50%', display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, border: '2px solid white',
                  }}>🔒</div></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a', marginBottom: 3 }}>{g.title}</div>
                    <div style={{ fontSize: 11, color: '#b86b00', fontWeight: 700 }}>Нужно ещё {need} {need === 1 ? 'человек' : 'человека'}</div>
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#b86b00',
                                background: '#fff4e0', padding: '3px 7px', borderRadius: 5, flexShrink: 0 }}>за {g.points_cost} чел</div>
                </div>
              )
            })}
          </>
        )}
      </div>
    )
  }

  // ──────────── view: materials ────────────
  if (view === 'materials') {
    function copyText(id: number, rendered: string) {
      navigator.clipboard.writeText(rendered)
      setCopiedTextId(id)
      setTimeout(() => setCopiedTextId(null), 2000)
    }

    function downloadImage(url: string) {
      // Открываем в новой вкладке — Telegram Mini App покажет в браузере, оттуда уже Save
      const twa = (window as any).Telegram?.WebApp
      if (twa?.openLink) twa.openLink(url)
      else window.open(url, '_blank')
    }

    async function sendAllToBot() {
      const tgId = tgUser?.id ?? tgUser?.tg_id
      if (!event?.slug || !tgId) return
      const renderedTexts = shareTexts.map(t => applyPlaceholders(t.content)).filter(Boolean)
      if (renderedTexts.length === 0 && shareImages.length === 0) return
      setSendingAll(true)
      try {
        await sendShareTextToBot(event.slug, Number(tgId), renderedTexts)
        // Закрываем Mini App — Telegram возвращает в чат с ботом, где уже
        // лежат афиши и тексты. Юзер форвардит их друзьям из чата.
        const twa = (window as any).Telegram?.WebApp
        if (twa?.close) twa.close()
      } catch (e: any) {
        alert(e?.message || 'Не получилось отправить материалы в бот')
        setSendingAll(false)
      }
    }

    const isEmpty = shareTexts.length === 0 && shareImages.length === 0

    return (
      <div className="fade-in" style={{ padding: '0 0 24px' }}>
        <button onClick={() => setView('game')} style={{
          background: 'none', border: 'none', color: 'var(--muted)',
          fontSize: 13, padding: '4px 0', cursor: 'pointer', marginBottom: 8,
        }}>← Назад в Игру</button>

        {/* Партнёрская ссылка — дубль с главного экрана, чтобы можно было
            скопировать прямо здесь, не возвращаясь назад. */}
        <div style={{
          background: 'white', borderRadius: 14, padding: 14, marginBottom: 14,
          boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
        }}>
          <div style={{ fontSize: 11, color: '#6b7c8e', marginBottom: 6, fontWeight: 500 }}>
            Ваша партнёрская ссылка на событие
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{
              flex: 1, background: '#f7f8fa', padding: 10, borderRadius: 10,
              fontSize: 12, color: DARK, fontWeight: 600,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{refLink}</div>
            <button onClick={() => copy(refLink)} style={{
              background: 'linear-gradient(135deg, #FFCFA4, #f5b97e)', color: DARK,
              padding: '10px 14px', borderRadius: 10, fontWeight: 700, fontSize: 13,
              cursor: 'pointer', border: 'none',
            }}>{copied ? '✓' : 'Копировать'}</button>
          </div>
        </div>

        {isEmpty && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--muted)', fontSize: 13 }}>
            Материалы для шеринга пока не добавлены
          </div>
        )}

        {!isEmpty && (
          <button onClick={sendAllToBot}
            disabled={sendingAll}
            style={{
              width: '100%', border: 'none', borderRadius: 12,
              padding: '14px 16px', fontSize: 14, fontWeight: 800,
              cursor: sendingAll ? 'wait' : 'pointer',
              background: PEACH,
              color: DARK,
              marginBottom: 14,
              boxShadow: '0 2px 8px rgba(255,207,164,0.35)',
              opacity: sendingAll ? 0.7 : 1,
              lineHeight: 1.35,
            }}>
            {sendingAll ? 'Отправляем…' : '📨 Нажмите, чтобы отправить себе в бот готовые сообщения'}
          </button>
        )}

        {shareImages.length > 0 && (
          <>
            <h3 style={{
              fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
              color: '#6b7c8e', margin: '4px 4px 10px',
            }}>
              🖼 Афиши для друзей · {shareImages.length}
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {shareImages.map(img => (
                <div key={img.id} onClick={() => downloadImage(img.image_url)}
                  style={{
                    background: 'white', borderRadius: 12, overflow: 'hidden',
                    boxShadow: '0 2px 8px rgba(37,69,93,0.05)', cursor: 'pointer',
                  }}>
                  <div style={{ aspectRatio: '1 / 1', background: '#f0f3f7' }}>
                    <img src={img.image_url} alt=""
                         style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  </div>
                  <div style={{
                    padding: '8px 10px', fontSize: 11, color: DARK, fontWeight: 600,
                    textAlign: 'center', background: PEACH,
                  }}>
                    Открыть и сохранить
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {shareTexts.length > 0 && (
          <>
            <h3 style={{
              fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
              color: '#6b7c8e', margin: '18px 4px 10px',
            }}>
              ✍️ Тексты для друзей · {shareTexts.length}
            </h3>
            {shareTexts.map(t => {
              const rendered = applyPlaceholders(t.content)
              const isCopied = copiedTextId === t.id
              return (
                <div key={t.id} style={{
                  background: 'white', borderRadius: 14, padding: 14, marginBottom: 10,
                  boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
                }}>
                  <div style={{
                    fontSize: 13, color: '#1a2a3a', whiteSpace: 'pre-wrap',
                    lineHeight: 1.55, marginBottom: 10, wordBreak: 'break-word',
                  }}>{rendered}</div>
                  <button onClick={() => copyText(t.id, rendered)}
                    style={{
                      width: '100%', border: 'none', borderRadius: 10,
                      padding: '10px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                      background: isCopied ? '#6bb572' : PEACH,
                      color: isCopied ? 'white' : DARK,
                      transition: 'background 0.2s',
                    }}>
                    {isCopied ? '✓ Скопировано' : '📋 Скопировать текст'}
                  </button>
                </div>
              )
            })}
          </>
        )}
      </div>
    )
  }

  // ──────────── view: game (главный) ────────────
  return (
    <div className="fade-in">
      {/* Компактные пиллы статистики */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div style={{
          flex: 1, background: 'white', borderRadius: 10, padding: '10px 12px',
          textAlign: 'center', boxShadow: '0 2px 6px rgba(37,69,93,0.05)',
        }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: '#6b7c8e', lineHeight: 1 }}>{visited}</div>
          <div style={{ fontSize: 10, color: '#6b7c8e', marginTop: 4 }}>переходов</div>
        </div>
        <div style={{
          flex: 1, background: 'linear-gradient(135deg, #fff8f0 0%, white 100%)',
          border: `1.5px solid ${PEACH}`,
          borderRadius: 10, padding: '10px 12px', textAlign: 'center',
          boxShadow: '0 2px 6px rgba(37,69,93,0.05)',
        }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: DARK, lineHeight: 1 }}>{registered}</div>
          <div style={{ fontSize: 10, color: '#6b7c8e', marginTop: 4 }}>регистраций</div>
        </div>
      </div>

      {/* Получено подарков (кликабельный блок → окно подарков) */}
      <div onClick={() => setView('gifts')}
           style={{
             background: 'white', borderRadius: 14, padding: 14, marginBottom: 12,
             cursor: 'pointer', boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
           }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Большая цифра «получено/всего». Если порогов нет — просто число. */}
          <div style={{ fontSize: 30, fontWeight: 900, color: DARK, lineHeight: 1, whiteSpace: 'nowrap' }}>
            {giftsCount}
            {sortedGifts.length > 0 && (
              <span style={{ fontSize: 18, fontWeight: 700, color: '#8a96a3' }}>/{sortedGifts.length}</span>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: '#6b7c8e' }}>Получено подарков</div>
            {lastReceived && (
              <div style={{
                fontSize: 13, fontWeight: 700, color: DARK, marginTop: 2,
                overflow: 'hidden', textOverflow: 'ellipsis',
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              }}>
                «{lastReceived.title}»
              </div>
            )}
          </div>
          <div style={{ color: '#c5cdd6', fontSize: 22, fontWeight: 300 }}>›</div>
        </div>

        {/* Следующий подарок — отдельной строкой ниже, другим цветом. */}
        <div style={{
          fontSize: 12, fontWeight: 700, marginTop: 10,
          color: nextGift ? '#b86b00' : '#2e7d32',
        }}>
          {nextGift
            ? `🎁 Ещё ${toNext} ${toNext === 1 ? 'человек' : 'человека'} до подарка «${nextGift.title}»`
            : '🎉 Все подарки получены!'}
        </div>

        {nextGift && (
          <div style={{ height: 6, background: '#eef2f7', borderRadius: 3, overflow: 'hidden', marginTop: 8 }}>
            <div style={{
              height: '100%', width: `${progressPct}%`,
              background: 'linear-gradient(90deg, #FFCFA4, #f5b97e)', borderRadius: 3,
            }} />
          </div>
        )}
      </div>

      {/* ТОП — expander */}
      <div style={{
        background: 'white', borderRadius: 14, padding: 14, marginBottom: 10,
        boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
      }}>
        <div onClick={() => setTopOpen(!topOpen)}
             style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a' }}>
            🏆 ТОП рейтинг {myRank ? `· вы №${myRank}` : ''}
          </div>
          <div style={{ fontSize: 20, color: topOpen ? PEACH : '#c5cdd6',
                        transform: topOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>›</div>
        </div>
        {topOpen && (
          <div style={{ marginTop: 10 }}>
            {top.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: 10, textAlign: 'center' }}>
                Рейтинг пока пуст
              </div>
            ) : top.slice(0, 10).map((t, i) => {
              const handle = t.username ? t.username.replace(/^@+/, '') : null
              const canOpenCard = !t.isMe && !!t.participant_id && !!tgUser?.id
              return (
                <button
                  key={i}
                  onClick={() => canOpenCard && t.participant_id && setOpenCardId(t.participant_id)}
                  disabled={!canOpenCard}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '6px 8px', borderTop: i === 0 ? 'none' : '1px solid #f0f2f5',
                    background: t.isMe ? '#fff8f0' : 'transparent',
                    borderRadius: t.isMe ? 6 : 0,
                    border: 'none', width: '100%', textAlign: 'left',
                    fontFamily: 'inherit',
                    cursor: canOpenCard ? 'pointer' : 'default',
                  }}
                >
                  <div style={{ width: 24, textAlign: 'center', fontWeight: 700,
                                color: t.rank === 1 ? PEACH : t.rank === 2 ? '#c5cdd6' : t.rank === 3 ? '#b86b00' : DARK }}>
                    {t.rank === 1 ? '🥇' : t.rank === 2 ? '🥈' : t.rank === 3 ? '🥉' : t.rank}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: t.isMe ? 700 : 600, color: '#1a2a3a',
                                   overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.isMe ? 'Вы' : t.name}
                    </div>
                    {handle ? (
                      <span style={{ color: '#0088cc', fontSize: 11, fontWeight: 500 }}>
                        @{handle}
                      </span>
                    ) : t.tg_id ? (
                      <span style={{ color: '#8a96a3', fontSize: 11 }}>id {t.tg_id}</span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{t.count}</div>
                  {canOpenCard && (
                    <div style={{ color: PEACH, fontSize: 18, fontWeight: 700, marginLeft: 4 }}>›</div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Партнёрская ссылка */}
      <div style={{
        background: 'white', borderRadius: 14, padding: 14, marginBottom: 12,
        boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
      }}>
        <div style={{ fontSize: 11, color: '#6b7c8e', marginBottom: 6, fontWeight: 500 }}>
          Ваша партнёрская ссылка на событие
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{
            flex: 1, background: '#f7f8fa', padding: 10, borderRadius: 10,
            fontSize: 12, color: DARK, fontWeight: 600,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{refLink}</div>
          <button onClick={() => copy(refLink)} style={{
            background: 'linear-gradient(135deg, #FFCFA4, #f5b97e)', color: DARK,
            padding: '10px 14px', borderRadius: 10, fontWeight: 700, fontSize: 13,
            cursor: 'pointer', border: 'none',
          }}>{copied ? '✓' : 'Копировать'}</button>
        </div>
      </div>

      {/* 3 кнопки: Подарки, Материалы, Поделиться */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
        {[
          { ico: '🎁', label: 'Мои подарки',            onClick: () => setView('gifts') },
          { ico: '🖼', label: 'Материалы для приглашения', onClick: () => setView('materials') },
          { ico: '📤', label: 'Поделиться',             onClick: share },
        ].map((b, i) => (
          <div key={i} onClick={b.onClick} style={{
            background: 'white', borderRadius: 14, padding: '14px 8px',
            textAlign: 'center', cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
          }}>
            <div style={{ fontSize: 22, marginBottom: 6 }}>{b.ico}</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: DARK }}>{b.label}</div>
          </div>
        ))}
      </div>

      {/* Ваши люди — expander */}
      <div style={{
        background: 'white', borderRadius: 14, padding: 14,
        boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
      }}>
        <div onClick={() => setPeopleOpen(!peopleOpen)}
             style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a' }}>
            👥 Ваши люди {registered ? `· ${registered} зарегистрировались` : ''}
          </div>
          <div style={{ fontSize: 20, color: peopleOpen ? PEACH : '#c5cdd6',
                        transform: peopleOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>›</div>
        </div>
        {peopleOpen && (
          <div style={{ marginTop: 10 }}>
            {myPeople.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: 10, textAlign: 'center' }}>
                Поделитесь ссылкой — приглашённые появятся здесь
              </div>
            ) : myPeople.map((p, i) => {
              const [c1, c2] = p.color.split('|')
              const canOpen = !!tgUser?.id && typeof p.id === 'number'
              return (
                <button
                  key={p.id}
                  onClick={() => canOpen && setOpenCardId(p.id as number)}
                  disabled={!canOpen}
                  style={{
                    padding: '10px 0', display: 'flex', alignItems: 'center', gap: 10,
                    borderTop: i === 0 ? 'none' : '1px solid #f0f2f5',
                    background: 'transparent', border: 'none',
                    width: '100%', textAlign: 'left', cursor: canOpen ? 'pointer' : 'default',
                    fontFamily: 'inherit',
                  }}
                >
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%',
                    background: `linear-gradient(135deg, ${c1}, ${c2})`,
                    color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 700, fontSize: 12, flexShrink: 0,
                  }}>{p.initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a' }}>{p.name}</div>
                    {p.username && (
                      <span style={{ fontSize: 11, color: '#0088cc', fontWeight: 500 }}>
                        @{p.username.replace(/^@/, '')}
                      </span>
                    )}
                  </div>
                  {p.is_registered && <div style={{ fontSize: 14, color: '#2e7d32', fontWeight: 700 }}>✓</div>}
                  {canOpen && (
                    <div style={{ color: PEACH, fontSize: 18, fontWeight: 700, marginLeft: 4 }}>›</div>
                  )}
                </button>
              )
            })}
            {visited > registered && (
              <div style={{
                padding: '10px 0', display: 'flex', alignItems: 'center', gap: 10,
                borderTop: '1px solid #f0f2f5', color: '#8a96a3',
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%', background: '#eef2f7',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, fontSize: 12,
                }}>?</div>
                <div style={{ flex: 1, fontSize: 11 }}>
                  {visited - registered} переходов без регистрации
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {openCardId !== null && tgUser?.id && event?.slug && (
        <ContactCardModal
          eventSlug={event.slug}
          participantId={openCardId}
          viewerTgId={tgUser.id}
          onClose={() => setOpenCardId(null)}
        />
      )}
    </div>
  )
}
