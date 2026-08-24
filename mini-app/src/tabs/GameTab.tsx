import { useEffect, useState } from 'react'
import { getGifts, getShareTexts, getShareMaterials, sendShareTextToBot, getEventShareLinks } from '../api'
import ContactCardModal from '../components/ContactCardModal'
import { getPlatformName, getPlatform } from '../platform'
import { buildAllLinksText, countLinks } from '../utils/allLinksText'

// botClientId — клиент, ЧЕЙ БОТ открыл Mini App. В коллабе ≠ владельцу события:
// реф-ссылка участника должна идти через бота ЕГО организатора.
interface Props { event: any; participant: any; tgUser: any; botClientId?: number | null }

const APP_URL = import.meta.env.VITE_APP_URL || 'https://pluson.ru'
const PEACH = '#FFCFA4'
const DARK = '#25455D'

interface Gift {
  id: number
  title: string
  description?: string
  points_cost: number
  link_url?: string
  // Ссылки на воронку подарка ПО ПЛОЩАДКАМ: {telegram, vk, max}.
  platform_links?: Record<string, string>
  web_url?: string
}

interface RefPerson {
  id: number | string
  name: string
  username?: string
  is_registered: boolean
  link_clicked?: boolean
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

export default function GameTab({ event, participant, tgUser, botClientId }: Props) {
  const [gifts, setGifts] = useState<Gift[]>([])
  const [view, setView] = useState<'game' | 'gifts' | 'materials'>('game')
  const [showAllGifts, setShowAllGifts] = useState(false)   // «Развернуть подарки» в окне подарков
  const [topOpen, setTopOpen] = useState(false)
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedTextId, setCopiedTextId] = useState<number | null>(null)
  const [openCardId, setOpenCardId] = useState<number | null>(null)
  const [shareTexts, setShareTexts] = useState<{ id: number; content: string; sort: number }[]>([])
  const [shareImages, setShareImages] = useState<{ id: number; media_type?: string; image_url?: string; video_url?: string; source: string }[]>([])
  const [sendingAll, setSendingAll] = useState(false)
  // Реф-ссылки для всех активных платформ клиента: {telegram?, vk?, max?}.
  // Бэк сам резолвит handle бота / vk_app_id, добавляет _pid{refCode}.
  // Пустой объект пока грузится — UI показывает скелетон.
  const [shareLinks, setShareLinks] = useState<{ telegram?: string; vk?: string; max?: string }>({})
  const [copiedPlatform, setCopiedPlatform] = useState<string | null>(null)

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
  // Партнёрская ссылка для placeholder {link} в текстах-примерах и для нативного
  // шеринга. Приоритет — прямой deeplink в TG (или платформу, на которой сейчас
  // открыт Mini App), который пришёл с бэка. Пока shareLinks грузятся —
  // временный фолбэк на pluson.ru/l/{slug}, чтобы UI не моргал.
  const currentPlatform = getPlatformName()

  // ── Подарок: куда вести человека ────────────────────────────────────
  // ⚠️ В БОТА ВЛАДЕЛЬЦА ПОДАРКА, а не на веб-страницу. Открыл в Telegram —
  // получай файл в Telegram-боте. Веб-адрес оставляем только на крайний
  // случай: у владельца может не быть ни одного бота.
  const [giftPick, setGiftPick] = useState<Gift | null>(null)
  // Какие описания подарков раскрыты. ⚠️ Свёрнуты по умолчанию: описание
  // бывает на пол-экрана, и раскрытым оно превращает список в простыню, где
  // не видно ни самих подарков, ни кнопки «Открыть».
  const [descOpen, setDescOpen] = useState<Record<number, boolean>>({})

  const giftOpenHref = (g: Gift): string | null => {
    const links = g.platform_links || {}
    // Своя площадка — открываем сразу, без лишнего выбора.
    if (currentPlatform !== 'web' && links[currentPlatform]) return links[currentPlatform]
    // Ботов нет вовсе — остаётся веб-страница.
    if (!Object.keys(links).length) return g.web_url || g.link_url || null
    return null   // есть боты, но не на его площадке → покажем выбор
  }
  const hasAnyGiftLink = (g: Gift) => Object.keys(g.platform_links || {}).length > 0

  /** Открыть подарок.
   *
   * ⚠️⚠️ ОБЫЧНАЯ ССЫЛКА ЗДЕСЬ НЕ РАБОТАЕТ. Внутри Mini App браузерная
   * `<a target="_blank">` часто не открывается вовсе — кнопка выглядит живой,
   * но по нажатию не происходит НИЧЕГО. Площадка должна открыть ссылку сама.
   *
   * ⚠️ Ссылку на телеграм-бота открываем `openTelegramLink`, а не `openLink`:
   * второй уводит во внешний браузер, и человек попадает на веб-страницу
   * вместо чата с ботом.
   */
  const openGift = (url: string) => {
    const twa = (window as any).Telegram?.WebApp
    const isTg = /(?:t|telegram)\.me\//i.test(url)
    // ⚠️ Домен приводим к `t.me`: `openTelegramLink` понимает только его.
    const tgUrl = url.replace(/^https:\/\/telegram\.me\//i, 'https://t.me/')

    // ⚠️⚠️ ПРОБУЕМ ВСЕ СПОСОБЫ ПО ОЧЕРЕДИ, А НЕ ОДИН.
    // Раньше на ссылку в бота звали ТОЛЬКО `openTelegramLink` и на этом
    // останавливались (`return`). Если он молчал — а он молчит в части
    // сборок Telegram, ничего не сообщая и не бросая ошибку, — нажатие
    // уходило впустую: карточка выглядела живой, подарок не открывался
    // (прод, 25.08, жалоба «не нажимается ни карточка, ни кнопка»).
    //
    // Теперь каждый способ проверяется на деле: не сработал — идём к
    // следующему. Последний — обычный переход, он работает всегда.
    const tries: Array<() => void> = []
    if (isTg && typeof twa?.openTelegramLink === 'function') {
      tries.push(() => twa.openTelegramLink(tgUrl))
    }
    if (typeof twa?.openLink === 'function') {
      tries.push(() => twa.openLink(tgUrl))
    }
    const p: any = getPlatform()
    if (typeof p?.openExternal === 'function') {
      tries.push(() => p.openExternal(tgUrl))
    }
    tries.push(() => { window.location.href = tgUrl })

    for (const run of tries) {
      try {
        run()
        // ⚠️⚠️ ЗАКРЫВАЕМ MINI APP — ИНАЧЕ ЧЕЛОВЕК НЕ УВИДИТ ПОДАРОК.
        // Бот команду получает и подарок присылает, но Telegram НЕ
        // переключает на чат: приложение остаётся поверх, человек смотрит
        // в ту же карточку и решает, что нажатие не сработало (прод,
        // 25.08 — «оказывается сообщение отправляется, просто меня в бот
        // не перекидывает»). Закрываем окно сами — тогда под ним чат с
        // ботом и присланный подарок.
        //
        // ⚠️ С задержкой: закрыть сразу — и Telegram не успевает открыть
        // ссылку, окно закрывается впустую.
        if (isTg && typeof twa?.close === 'function') {
          setTimeout(() => { try { twa.close() } catch (_) {} }, 700)
        }
        return
      } catch (_) { /* следующий способ */ }
    }
  }
  const refLink =
    shareLinks.telegram
    || shareLinks[currentPlatform as 'telegram' | 'vk' | 'max']
    || shareLinks.vk
    || shareLinks.max
    || `${APP_URL}/l/${slug}?app=tg&pid=${refCode}`

  // Загружаем подарки → понимаем «следующий» по порогу.
  // tgId прокидываем, чтобы бэк подставил {ref} (реф-код рефовода) в ссылках.
  useEffect(() => {
    if (event?.slug) {
      const tgId = tgUser?.id ?? tgUser?.tg_id
      getGifts(event.slug, tgId)
        .then(r => setGifts(r.gifts || []))
        .catch(() => setGifts([]))
    }
  }, [event?.slug, tgUser])

  // Материалы для шеринга — тексты и картинки
  useEffect(() => {
    if (event?.id) {
      getShareTexts(event.id).then(r => setShareTexts(r.items || [])).catch(() => setShareTexts([]))
      getShareMaterials(event.id).then(r => setShareImages(r.items || [])).catch(() => setShareImages([]))
    }
  }, [event?.id])

  // Реф-ссылки для всех активных платформ клиента — грузим раз когда знаем slug+ref_code.
  // Бэк отдаёт только те платформы, что у клиента подключены или системные.
  useEffect(() => {
    if (slug && refCode && refCode !== 'demo') {
      getEventShareLinks(slug, refCode).then((r: any) => setShareLinks(r?.links || {})).catch(() => setShareLinks({}))
    }
  }, [slug, refCode])

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
          ✓ Доступно · {got.length}
        </h3>
        {got.length === 0
          ? <div style={{ color: 'var(--muted)', fontSize: 12, padding: 10, textAlign: 'center' }}>Пока ничего не доступно</div>
          : got.map(g => (
            // ⚠️ Нажимается ВСЯ КАРТОЧКА, а не только кнопка сбоку. Человек
            // тычет в подарок целиком — и справедливо: маленькая кнопка
            // выглядит как украшение, а не как единственное рабочее место.
            <div key={g.id}
              onClick={() => {
                const href = giftOpenHref(g)
                if (href) openGift(href)
                else if (hasAnyGiftLink(g)) setGiftPick(g)
              }}
              style={{
                background: 'white', borderRadius: 14, padding: 14, marginBottom: 10,
                display: 'flex', gap: 12, alignItems: 'center',
                boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
                cursor: (giftOpenHref(g) || hasAnyGiftLink(g)) ? 'pointer' : 'default',
              }}>
              <div style={{
                width: 48, height: 48, borderRadius: 12, flexShrink: 0,
                background: 'linear-gradient(135deg, #fff4e0, #FFCFA4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
              }}>🎁</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a', marginBottom: 3 }}>{g.title}</div>
                {g.description && (
                  <div style={{ marginTop: 4 }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); setDescOpen(o => ({ ...o, [g.id]: !o[g.id] })) }}
                      style={{
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        fontSize: 11, color: '#6b7c8e', display: 'flex', alignItems: 'center', gap: 4,
                      }}>
                      <span>{descOpen[g.id] ? 'Свернуть' : 'Подробнее'}</span>
                      <span style={{ fontSize: 9 }}>{descOpen[g.id] ? '▲' : '▼'}</span>
                    </button>
                    {descOpen[g.id] && (
                      // ⚠️ whiteSpace: 'pre-wrap' — переносы строк из описания
                      // сохраняются. Без него весь текст слипался в одну кашу.
                      <div style={{
                        fontSize: 11, color: '#6b7c8e', marginTop: 6,
                        whiteSpace: 'pre-wrap', lineHeight: 1.45,
                      }}>{g.description}</div>
                    )}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#2e7d32',
                              background: '#e8f5e9', padding: '3px 7px', borderRadius: 5 }}>за {g.points_cost} чел</div>
                {/* ⚠️ Открываем ссылку ТОЙ ПЛОЩАДКИ, откуда пришёл человек:
                    он в Telegram — значит и подарок должен прийти в
                    Telegram-бота владельца. Раньше отдавался веб-адрес
                    pluson.ru/m/… — открывалось окно «Открыть ссылку?»,
                    человек попадал на страницу, а файл не приходил.
                    Нет ссылки на его площадке (или он в вебе) — показываем
                    выбор из тех площадок, что у организатора есть. */}
                {giftOpenHref(g) ? (
                  <button onClick={(e) => { e.stopPropagation(); openGift(giftOpenHref(g)!) }} style={{
                    background: 'linear-gradient(135deg, #25455D, #0a1520)', color: PEACH,
                    padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                    border: 'none', cursor: 'pointer',
                  }}>Открыть</button>
                ) : hasAnyGiftLink(g) ? (
                  <button onClick={(e) => { e.stopPropagation(); setGiftPick(g) }} style={{
                    background: 'linear-gradient(135deg, #25455D, #0a1520)', color: PEACH,
                    padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                    border: 'none', cursor: 'pointer',
                  }}>Открыть</button>
                ) : null}
              </div>
            </div>
          ))}

        {locked.length > 0 && (
          <>
            <h3 style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
                         color: '#6b7c8e', margin: '14px 4px 10px' }}>
              🔒 Заблокировано · {locked.length}
            </h3>
            {/* Всегда видно минимум 2 подарка (с учётом полученных). Остальные —
                по кнопке «Развернуть», чтобы было понятно, что подарков больше. */}
            {(showAllGifts ? locked : locked.slice(0, 2)).map(g => {
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
            {/* Кнопка «Развернуть / Свернуть» — если скрытых подарков больше */}
            {locked.length > 2 && (
              <button onClick={() => setShowAllGifts(v => !v)} style={{
                width: '100%', background: 'white', border: '1px solid #e3e8ee',
                borderRadius: 12, padding: '12px', marginTop: 4, cursor: 'pointer',
                color: '#25455D', fontSize: 13, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}>
                {showAllGifts
                  ? <>Свернуть подарки <span style={{ fontSize: 15 }}>▲</span></>
                  : <>Развернуть подарки <span style={{ fontSize: 15 }}>▼</span></>}
              </button>
            )}
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

        {/* Партнёрские ссылки — дубль с главного экрана, чтобы можно было
            скопировать прямо здесь, не возвращаясь назад. */}
        <div style={{ marginBottom: 14 }}>
          <ShareLinksBlock
            links={shareLinks}
            refLink={refLink}
            currentPlatform={getPlatformName()}
            copiedPlatform={copiedPlatform}
            onCopy={(p, url) => {
              navigator.clipboard.writeText(url)
              setCopiedPlatform(p)
              setTimeout(() => setCopiedPlatform(null), 2000)
            }}
          />
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

        {(() => {
          const pics   = shareImages.filter(m => m.media_type !== 'video' && m.image_url)
          const videos = shareImages.filter(m => m.media_type === 'video' && m.video_url)
          return (
            <>
              {pics.length > 0 && (
                <>
                  <h3 style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
                    color: '#6b7c8e', margin: '4px 4px 10px',
                  }}>
                    🖼 Афиши для друзей · {pics.length}
                  </h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {pics.map(img => (
                      <div key={img.id} onClick={() => downloadImage(img.image_url!)}
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

              {videos.length > 0 && (
                <>
                  <h3 style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
                    color: '#6b7c8e', margin: pics.length > 0 ? '18px 4px 10px' : '4px 4px 10px',
                  }}>
                    🎬 Видео для друзей · {videos.length}
                  </h3>
                  <div style={{ display: 'grid', gap: 10 }}>
                    {videos.map(v => (
                      <div key={v.id} style={{
                        background: 'white', borderRadius: 12, overflow: 'hidden',
                        boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
                      }}>
                        <video src={v.video_url} controls playsInline
                               style={{ width: '100%', display: 'block', background: '#000', maxHeight: 360 }} />
                        <div onClick={() => downloadImage(v.video_url!)} style={{
                          padding: '8px 10px', fontSize: 11, color: DARK, fontWeight: 600,
                          textAlign: 'center', background: PEACH, cursor: 'pointer',
                        }}>
                          Открыть и сохранить
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )
        })()}

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
  const cabName = (participant?.contact_name || tgUser?.first_name || '').toString().trim()

  return (
    <div className="fade-in">
      {/* Выбор площадки для подарка: показываем, когда у владельца есть боты,
          но НЕ на той площадке, где человек сейчас (или он открыл в вебе).
          ⚠️ Окно НЕ закрывается по клику на фон — только «Отмена». */}
      {giftPick && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 100,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 18, width: '100%', maxWidth: 340 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: DARK, marginBottom: 4 }}>
              Где забрать подарок?
            </div>
            <div style={{ fontSize: 12, color: '#6b7c8e', marginBottom: 14 }}>
              Выберите приложение — подарок придёт в бот организатора.
            </div>
            {Object.entries(giftPick.platform_links || {}).map(([plat, url]) => {
              const meta = PLATFORM_META[plat]
              return (
                <a key={plat} href={url}
                   onClick={(e) => { e.preventDefault(); setGiftPick(null); openGift(url) }}
                   style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
                            borderRadius: 10, marginBottom: 8, textDecoration: 'none',
                            background: meta?.bg || '#f0f3f7', color: meta?.fg || DARK,
                            fontWeight: 700, fontSize: 13 }}>
                  <span>{meta?.icon || '•'}</span>
                  <span>{meta?.label || plat}</span>
                </a>
              )
            })}
            <button onClick={() => setGiftPick(null)}
                    style={{ width: '100%', marginTop: 6, padding: '10px 12px', borderRadius: 10,
                             background: '#f0f3f7', color: DARK, border: 'none',
                             fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {/* Имя того, чей это кабинет */}
      {cabName && (
        <div style={{ fontSize: 18, fontWeight: 900, color: DARK, marginBottom: 10 }}>{cabName}</div>
      )}
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
            <div style={{ fontSize: 12, color: '#6b7c8e' }}>Доступно подарков</div>
            {/* ⚠️ Название полученного подарка здесь НЕ показываем: те же самые
                подарки идут списком сразу под этим блоком, и название
                повторялось дважды подряд — нагромождение вместо сводки.
                Что дальше — говорит строка «ещё N человек до подарка» ниже. */}
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
            : '🎉 Все подарки открыты!'}
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

      {/* Первые 2 подарка сразу видны + кнопка «Все подарки» — чтобы было понятно,
          что подарков больше (не только цифра в сводке). */}
      {sortedGifts.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {sortedGifts.slice(0, 2).map(g => {
            const unlocked = giftCountValue >= g.points_cost
            // ⚠️ Карточка в КРАТКОМ списке тоже должна открывать подарок.
            // Раньше нажималась только карточка в полном списке, а человек
            // жмёт на ту, что видит первой — и подарок казался сломанным.
            const href = unlocked ? giftOpenHref(g) : null
            const canOpen = unlocked && (href || hasAnyGiftLink(g))
            return (
              <div key={g.id}
                onClick={() => {
                  if (!unlocked) return
                  if (href) openGift(href)
                  else if (hasAnyGiftLink(g)) setGiftPick(g)
                }}
                style={{
                  background: 'white', borderRadius: 12, padding: '10px 12px', marginBottom: 8,
                  display: 'flex', gap: 10, alignItems: 'center', opacity: unlocked ? 1 : 0.75,
                  boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
                  cursor: canOpen ? 'pointer' : 'default',
                }}>
                <div style={{ fontSize: 20, flexShrink: 0 }}>{unlocked ? '🎁' : '🔒'}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a',
                    overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
                    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{g.title}</div>
                  <div style={{ fontSize: 11, color: unlocked ? '#2e7d32' : '#b86b00', fontWeight: 700, marginTop: 2 }}>
                    {unlocked ? '✓ Доступен — нажмите' : `за ${g.points_cost} чел`}
                  </div>
                </div>
              </div>
            )
          })}
          <button onClick={() => setView('gifts')} style={{
            width: '100%', background: 'white', border: '1px solid #e3e8ee',
            borderRadius: 12, padding: '11px', cursor: 'pointer',
            color: '#25455D', fontSize: 13, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
            Все подарки ({sortedGifts.length}) <span style={{ fontSize: 15 }}>▼</span>
          </button>
        </div>
      )}

      {/* ТОП — expander (скрыт, если клиент отключил рейтинг для события) */}
      {!participant?.hide_rating && (
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
      )}

      {/* Партнёрские ссылки для всех активных платформ клиента (TG/VK/MAX).
          Пользователь сам выбирает какую отправить другу: TG-юзеру → TG-ссылку,
          VK-юзеру → VK-ссылку. Сначала идёт ссылка текущей платформы (откуда
          открыт Mini App), затем остальные. */}
      <ShareLinksBlock
        links={shareLinks}
        refLink={refLink}
        currentPlatform={getPlatformName()}
        copiedPlatform={copiedPlatform}
        onCopy={(p, url) => {
          navigator.clipboard.writeText(url)
          setCopiedPlatform(p)
          setTimeout(() => setCopiedPlatform(null), 2000)
        }}
      />

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

      {/* Ваши люди — expander.
          Заголовок и галочки динамические: для контестов «проголосовали»,
          для обычных событий — «пришли в эфир». «Зарегистрировались» —
          вторая колонка-галочка. */}
      {(() => {
        const isContestPeople = event?.module_slug === 'contest'
        const clicked = participant?.clicked_count ?? myPeople.filter(p => p.link_clicked).length
        const clickedWord = isContestPeople ? 'проголосовали' : 'пришли в эфир'
        const clickedWordSingular = isContestPeople ? 'проголосовал' : 'пришёл в эфир'
        // Какое из чисел показывать в заголовке: соответствует gift_count_mode.
        const giftMode: string = participant?.gift_count_mode || 'registered'
        const headerCount: number =
          giftMode === 'clicked_link' ? clicked :
          giftMode === 'visited'      ? visited :
          registered
        const headerWord: string =
          giftMode === 'clicked_link' ? clickedWordSingular :
          giftMode === 'visited'      ? 'перешли по ссылке' :
          'зарегистрировался'
        return (
      <div style={{
        background: 'white', borderRadius: 14, padding: 14,
        boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
      }}>
        <div onClick={() => setPeopleOpen(!peopleOpen)}
             style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a' }}>
            👥 Ваши люди
          </div>
          <div style={{ fontSize: 20, color: peopleOpen ? PEACH : '#c5cdd6',
                        transform: peopleOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>›</div>
        </div>

        {/* Полная статистика — три строки. Каждая со своей иконкой-легендой,
            которая совпадает с галочкой возле имени каждого человека ниже:
            «·» — просто переход, ✓ — регистрация, 🗳/🎬 — голос/эфир. */}
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Строка 1: переходы (нейтральная иконка, как у не-проголосовавшего/не-зареганного) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 22, height: 22, borderRadius: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#f0f3f7', color: '#8a96a3',
              fontSize: 14, fontWeight: 800,
            }}>👤</div>
            <div style={{ fontSize: 12, color: '#1a2a3a', fontWeight: 600 }}>
              {visited} <span style={{ color: '#8a96a3', fontWeight: 500 }}>переходов по ссылке</span>
            </div>
          </div>
          {/* Строка 2: зарегистрировались (зелёная галочка) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 22, height: 22, borderRadius: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#e8f5e9', color: '#2e7d32',
              fontSize: 13, fontWeight: 800,
            }}>✓</div>
            <div style={{ fontSize: 12, color: '#1a2a3a', fontWeight: 600 }}>
              {registered} <span style={{ color: '#8a96a3', fontWeight: 500 }}>регистраций</span>
            </div>
          </div>
          {/* Строка 3: проголосовали / в эфире (персиковая иконка) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 22, height: 22, borderRadius: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#fff3e0', color: '#b86b00',
              fontSize: 13, fontWeight: 800,
            }}>{isContestPeople ? '🗳' : '🎬'}</div>
            <div style={{ fontSize: 12, color: '#1a2a3a', fontWeight: 600 }}>
              {clicked} <span style={{ color: '#8a96a3', fontWeight: 500 }}>{clickedWord}</span>
            </div>
          </div>
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

                  {/* 2 галочки: «зарегистрировался» и «проголосовал/в эфире». */}
                  <div style={{ display: 'flex', gap: 6, marginRight: 4 }}>
                    <div
                      title={p.is_registered ? 'Зарегистрировался' : 'Не зарегистрирован'}
                      style={{
                        width: 22, height: 22, borderRadius: 6,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: p.is_registered ? '#e8f5e9' : '#f0f3f7',
                        color: p.is_registered ? '#2e7d32' : '#c5cdd6',
                        fontSize: 13, fontWeight: 800,
                      }}>{p.is_registered ? '✓' : '·'}</div>
                    <div
                      title={p.link_clicked
                        ? (isContestPeople ? 'Проголосовал' : 'Был в эфире')
                        : (isContestPeople ? 'Не голосовал' : 'Не был в эфире')}
                      style={{
                        width: 22, height: 22, borderRadius: 6,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: p.link_clicked ? '#fff3e0' : '#f0f3f7',
                        color: p.link_clicked ? '#b86b00' : '#c5cdd6',
                        fontSize: 13, fontWeight: 800,
                      }}>
                      {p.link_clicked ? (isContestPeople ? '🗳' : '🎬') : '·'}
                    </div>
                  </div>

                  {canOpen && (
                    <div style={{ color: PEACH, fontSize: 18, fontWeight: 700 }}>›</div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
        )
      })()}

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


// ── Блок партнёрских ссылок для разных платформ ────────────────────────
//
// Показывает каждую активную у клиента площадку отдельной строкой с deeplink-ом
// в её Mini App. Пользователь сам выбирает какую отправить другу:
//   - другу в Telegram — TG-ссылка
//   - другу ВКонтакте — VK-ссылка
//   - другу в MAX — MAX-ссылка
// Сначала идёт ссылка текущей платформы (откуда открыт Mini App), затем остальные.
//
// Если бэк ещё не отдал ссылки (грузятся) или у клиента нет ни одной активной
// платформы — фолбэк на универсальный refLink (веб-лендинг с редиректом).

interface ShareLinksBlockProps {
  links: { telegram?: string; vk?: string; max?: string }
  refLink: string
  currentPlatform: string
  copiedPlatform: string | null
  onCopy: (platform: string, url: string) => void
}

const PLATFORM_META: Record<string, { label: string; icon: string; bg: string; fg: string }> = {
  telegram: { label: 'Telegram', icon: '✈️', bg: 'rgba(0,136,204,0.10)', fg: '#0088cc' },
  vk:       { label: 'ВКонтакте', icon: 'VK', bg: 'rgba(70,128,189,0.10)', fg: '#4680bd' },
  max:      { label: 'MAX',      icon: 'M', bg: 'rgba(255,138,0,0.12)',   fg: '#e07b00' },
}

function ShareLinksBlock({ links, refLink, currentPlatform, copiedPlatform, onCopy }: ShareLinksBlockProps) {
  const PEACH = '#FFCFA4'
  const DARK = '#25455D'

  // Порядок: текущая платформа сверху, затем остальные. Платформы без ссылки
  // (бэк не вернул) — пропускаем.
  const order: ('telegram' | 'vk' | 'max')[] = []
  if (links[currentPlatform as 'telegram' | 'vk' | 'max']) order.push(currentPlatform as any)
  for (const p of ['telegram', 'vk', 'max'] as const) {
    if (p !== currentPlatform && links[p]) order.push(p)
  }

  // Фолбэк: бэк не отдал ни одной ссылки (грузится / клиент без подключённых платформ).
  // Показываем универсальную веб-ссылку как раньше.
  if (order.length === 0) {
    return (
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
          <button onClick={() => onCopy('web', refLink)} style={{
            background: 'linear-gradient(135deg, #FFCFA4, #f5b97e)', color: DARK,
            padding: '10px 14px', borderRadius: 10, fontWeight: 700, fontSize: 13,
            cursor: 'pointer', border: 'none',
          }}>{copiedPlatform === 'web' ? '✓' : 'Копировать'}</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      background: 'white', borderRadius: 14, padding: 14, marginBottom: 12,
      boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
    }}>
      <div style={{ fontSize: 13, color: DARK, marginBottom: 4, fontWeight: 700 }}>
        🔗 Ваши партнёрские ссылки
      </div>
      <div style={{ fontSize: 11, color: '#6b7c8e', marginBottom: 10, lineHeight: 1.4 }}>
        Отправьте другу ту ссылку, которая ведёт в его привычное приложение.
      </div>
      {order.map((p, idx) => {
        const url = links[p]!
        const meta = PLATFORM_META[p]
        const isCopied = copiedPlatform === p
        const isCurrent = p === currentPlatform
        return (
          <div key={p} style={{
            display: 'flex', gap: 8, alignItems: 'center',
            marginTop: idx === 0 ? 0 : 8,
          }}>
            <div style={{
              flexShrink: 0, width: 36, height: 36, borderRadius: 10,
              background: meta.bg, color: meta.fg,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 800,
            }}>{meta.icon}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: '#6b7c8e', fontWeight: 600, marginBottom: 2 }}>
                {meta.label}{isCurrent ? ' · здесь' : ''}
              </div>
              <div style={{
                background: '#f7f8fa', padding: '6px 10px', borderRadius: 8,
                fontSize: 11, color: DARK, fontWeight: 500,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{url}</div>
            </div>
            <button onClick={() => onCopy(p, url)} style={{
              flexShrink: 0,
              background: isCurrent ? 'linear-gradient(135deg, #FFCFA4, #f5b97e)' : '#f0f3f7',
              color: isCurrent ? DARK : DARK,
              padding: '10px 12px', borderRadius: 10, fontWeight: 700, fontSize: 12,
              cursor: 'pointer', border: 'none', minWidth: 84,
            }}>{isCopied ? '✓ Скоп.' : 'Копировать'}</button>
          </div>
        )
      })}
      {countLinks(links) > 1 && (
        <button
          onClick={() => onCopy('__all__', buildAllLinksText(links))}
          style={{
            marginTop: 10, width: '100%', background: '#f0f3f7', color: DARK,
            padding: '10px 12px', borderRadius: 10, fontWeight: 700, fontSize: 12,
            cursor: 'pointer', border: 'none',
          }}
        >
          {copiedPlatform === '__all__' ? '✓ Все ссылки скопированы' : '📋 Скопировать все ссылки'}
        </button>
      )}
    </div>
  )
}
