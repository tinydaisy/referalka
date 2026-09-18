import { useEffect, useState } from 'react'
import { getClientProfile, getClientOfferings } from '../api'
import OwnerPage from '../pages/OwnerPage'
import EventDescription from '../components/EventDescription'
import { linkify } from '../utils/linkify'
import { getPlatform, getPlatformName } from '../platform'
import { focalCss } from '../utils/photoFocal'

interface Props {
  clientId: number
  /** Организаторы КОЛЛАБ-события (`collab_owners`). Если их больше одного —
   *  вкладка сначала показывает СПИСОК брендов, и только по клику открывает
   *  карточку выбранного. Раньше показывался один «первый владелец», и
   *  второй организатор общего события не был виден нигде. */
  owners?: CollabOwner[]
}

export interface CollabOwner {
  client_id: number
  name: string
  /** Имя и фамилия основателя — показываем в скобках рядом с брендом. */
  owner_name?: string | null
  brand_logo_url?: string | null
  profile_photo_url?: string | null
  positioning?: string | null
}

interface Achievement { label: string; value: string }
interface Profile {
  id: number
  name: string
  // Бренд
  brand_name?: string | null
  brand_logo_url?: string | null
  profile_photo_url?: string | null   // фото бренда
  positioning?: string | null         // позиционирование бренда
  achievements?: Achievement[]
  brand_bio?: string | null           // рассказ о проекте (мигр. 446)
  // Основатель (имя берётся из clients.name — отдельной колонки нет)
  owner_photo_url?: string | null
  owner_photo_focal?: string | null   // точка лица: за что держаться при обрезке
  owner_positioning?: string | null
  owner_achievements?: Achievement[]
  bio?: string | null
  // social_links: telegram_channels — массив (миграция 114), остальные — одиночные.
  social_links?: {
    telegram_channels?: { url: string; chat_id?: string; name?: string }[]
    instagram?: string
    youtube?: string
    vk?: string
    website?: string
  } & Record<string, any>
}
interface Offering {
  id: number
  title: string
  description?: string
  action_url?: string
  is_paid: boolean
  cover_url?: string
  /** ⚠️ Карточка может выдавать ЛИД-МАГНИТ вместо перехода по своей ссылке.
   *  Ссылка у него РАЗНАЯ на каждой площадке (у Telegram своя, у ВКонтакте
   *  своя, у MAX своя), поэтому бэкенд отдаёт НАБОР — {telegram|vk|max → url}.
   *  Берём ссылку своей площадки; нет её — предлагаем выбрать из доступных. */
  gift_links?: Record<string, string> | null
}

/** Подписи площадок для окна выбора. Держать в синхроне с `PLATFORM_LABEL`
 *  бэкенда (share_links.py) — человек видит эти слова и в рассылках. */
const PLATFORM_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  vk: 'ВКонтакте',
  max: 'MAX',
}

const PEACH = 'var(--peach)'
const DARK = 'var(--dark)'

function initials(name: string): string {
  const parts = (name || '').trim().split(/\s+/)
  if (!parts[0]) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

function OfferingCard({ o }: { o: Offering }) {
  // Описание свёрнуто — раскрывается по клику на заголовок/стрелку (синяя стрелка
  // в жёлтом круге). Слово «Бесплатно» не пишем — уже понятно из вкладки.
  const [open, setOpen] = useState(false)
  const [pickOpen, setPickOpen] = useState(false)
  const hasDesc = !!(o.description && o.description.trim())

  // ⚠️⚠️ ССЫЛКА ЛИД-МАГНИТА ВЫБИРАЕТСЯ ПОД ПЛОЩАДКУ ЗРИТЕЛЯ. Человек, который
  // смотрит из MAX, должен уйти в MAX-бота: чужая площадка означает, что
  // подарок он просто не получит — аккаунта там может не быть вовсе.
  const gift = o.gift_links || null
  const platforms = gift ? Object.keys(gift).filter(k => gift[k]) : []
  const mine = getPlatformName()
  // В вебе своей площадки нет вовсе — там всегда предлагаем выбор.
  const myLink = gift && mine !== 'web' ? gift[mine] : undefined

  // Что делает кнопка: своя площадка есть → ведём сразу; нет → выбор
  // (решение владельца). Открыть «первую попавшуюся» нельзя — человек
  // ушёл бы в мессенджер, которым не пользуется.
  const href = myLink || o.action_url
  const needsPick = !myLink && !o.action_url && platforms.length > 0

  function openGift(p: string) {
    setPickOpen(false)
    const url = gift?.[p]
    if (url) getPlatform().openExternal(url)
  }

  // ⚠️ Карточка без выдачи вовсе (лид-магнит удалён либо у клиента нет ни
  // одного бота) остаётся видимой, но БЕЗ кнопки: название и описание полезны
  // сами по себе, а кнопка, ведущая в никуда, выглядит поломкой.
  return (
    <div style={{
      background: 'white', borderRadius: 14, padding: 14, marginBottom: 10,
      boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
    }}>
      <div style={{ display: 'flex', gap: 12 }}>
        {o.cover_url ? (
          <img src={o.cover_url} alt=""
               style={{ width: 44, height: 44, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
        ) : (
          <div style={{
            width: 44, height: 44, borderRadius: 10, flexShrink: 0,
            background: 'linear-gradient(135deg, var(--warn-bg), var(--peach))',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
          }}>{o.is_paid ? '💼' : '📄'}</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            onClick={() => hasDesc && setOpen(v => !v)}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              cursor: hasDesc ? 'pointer' : 'default',
            }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{o.title}</div>
            {hasDesc && (
              <span style={{
                flexShrink: 0, width: 26, height: 26, borderRadius: '50%',
                background: 'var(--peach)', display: 'flex', alignItems: 'center',
                justifyContent: 'center', marginTop: 1,
                transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s',
              }}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                     stroke="var(--dark)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
            )}
          </div>
          {hasDesc && open && (
            <EventDescription
              text={o.description!}
              style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4, marginTop: 6 }}
              renderPlain={(t) => linkify(t)}
            />
          )}
        </div>
      </div>
      {(href || needsPick) && (
        <button
          onClick={() => { if (href) getPlatform().openExternal(href); else setPickOpen(true) }}
          style={{
            display: 'block', width: '100%', marginTop: 10, border: 'none', cursor: 'pointer',
            background: o.is_paid
              ? 'var(--gradient-peach)'
              : 'var(--gradient-135)',
            color: o.is_paid ? DARK : PEACH,
            padding: 10, borderRadius: 10, textAlign: 'center',
            fontWeight: 700, fontSize: 13,
            boxShadow: o.is_paid ? '0 2px 6px rgba(var(--peach-rgb), 0.4)' : 'none',
          }}>
          Получить
        </button>
      )}

      {/* ⚠️ Своей площадки у человека нет (смотрит из MAX, а MAX-бота у
          клиента нет) — предлагаем выбрать из тех, что есть, вместо того
          чтобы молча увести в чужой мессенджер. */}
      {pickOpen && (
        <div className="modal-bg" onClick={e => { if (e.target === e.currentTarget) setPickOpen(false) }}>
          <div className="modal-sheet">
            <h2>Где вам удобно получить?</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16, lineHeight: 1.4 }}>
              Выберите мессенджер — материалы придут туда.
            </p>
            {platforms.map(p => (
              <button key={p} className="btn btn-primary" onClick={() => openGift(p)}
                      style={{ marginBottom: 8 }}>
                {PLATFORM_LABEL[p] || p}
              </button>
            ))}
            <button onClick={() => setPickOpen(false)}
                    style={{ marginTop: 4, background: 'none', border: 'none', color: 'var(--muted)', fontSize: 13, width: '100%', padding: 10, cursor: 'pointer' }}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Список брендов организаторов коллабы — первый экран вкладки «О проекте». */
function OwnersList({ owners, onPick }: { owners: CollabOwner[]; onPick: (id: number) => void }) {
  return (
    <div className="fade-in">
      <div style={{
        padding: '20px 18px 16px',
        background: 'var(--gradient)',
        color: 'white',
      }}>
        <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.2 }}>Проекты организаторов</div>
        <div style={{ fontSize: 13, color: 'rgba(var(--peach-rgb), 0.85)', marginTop: 6 }}>
          Событие проводят {owners.length} организатора — выберите, чей проект посмотреть
        </div>
      </div>
      <div style={{ padding: 14, display: 'grid', gap: 10 }}>
        {owners.map(o => (
          <div key={o.client_id} className="card"
               onClick={() => onPick(o.client_id)}
               style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
            {o.brand_logo_url || o.profile_photo_url ? (
              <img src={(o.brand_logo_url || o.profile_photo_url) as string} alt=""
                   style={{ width: 52, height: 52, borderRadius: 10, objectFit: 'contain', flexShrink: 0 }} />
            ) : (
              <div style={{
                width: 52, height: 52, borderRadius: 10, flexShrink: 0,
                background: 'rgba(37,69,93,0.08)', color: DARK,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 700, fontSize: 14,
              }}>{initials(o.name)}</div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* ⚠️ Имя основателя в скобках: у коллабы в списке одни названия
                  компаний, и по ним не понять, чей это проект. */}
              <div style={{ fontSize: 15, fontWeight: 700, color: DARK, lineHeight: 1.25 }}>
                {o.name}
                {o.owner_name && o.owner_name !== o.name && (
                  <span style={{ fontWeight: 500, color: 'var(--muted)' }}> ({o.owner_name})</span>
                )}
              </div>
              {o.positioning && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.3 }}>
                  {o.positioning}
                </div>
              )}
            </div>
            <div style={{ fontSize: 22, color: PEACH, fontWeight: 700 }}>›</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function EcosystemTab({ clientId, owners }: Props) {
  // У коллабы с несколькими организаторами первый экран — список брендов.
  // Выбрали бренд → показываем ЕГО карточку (тот же код, что у обычного
  // события), с кнопкой «Назад» к списку.
  const collabOwners = (owners || []).filter(o => o?.client_id)
  const isMultiOwner = collabOwners.length > 1
  const [pickedId, setPickedId] = useState<number | null>(null)
  const shownId = isMultiOwner ? pickedId : clientId

  if (isMultiOwner && !pickedId) {
    return <OwnersList owners={collabOwners} onPick={setPickedId} />
  }
  return (
    <EcosystemCard
      clientId={shownId as number}
      onBackToOwners={isMultiOwner ? () => setPickedId(null) : undefined}
    />
  )
}

function EcosystemCard({ clientId, onBackToOwners }: { clientId: number; onBackToOwners?: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [paid, setPaid] = useState<Offering[]>([])
  const [free, setFree] = useState<Offering[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'free' | 'paid'>('free')
  const [showOwner, setShowOwner] = useState(false)
  // ⚠️ Текст о бренде раскрывается ЗДЕСЬ ЖЕ, вниз, а не отдельной страницей как
  // у основателя. Он про то, что уже на экране (шапка бренда сверху и факты под
  // ней), и ради пары абзацев уводить человека на другой экран незачем. У
  // основателя своя страница оправдана: там большое фото, факты и соцсети.
  const [showBrandBio, setShowBrandBio] = useState(false)

  useEffect(() => {
    Promise.all([
      getClientProfile(clientId).catch(() => null),
      getClientOfferings(clientId).catch(() => ({ paid: [], free: [] })),
    ])
      .then(([p, o]: any) => {
        setProfile(p)
        setPaid(o?.paid || [])
        setFree(o?.free || [])
      })
      .finally(() => setLoading(false))
  }, [clientId])

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>Загружаем…</div>
  if (!profile) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>Нет данных</div>

  // Отдельная страница «Об основателе»
  if (showOwner) {
    return <OwnerPage profile={profile} onBack={() => setShowOwner(false)} />
  }

  const brand = profile.brand_name || profile.name
  const brandRole = profile.positioning || ''
  const brandAch = (profile.achievements || []).slice(0, 4)
  const items = tab === 'free' ? free : paid
  // Нечего показывать — блок продуктов не рисуем совсем
  const hasOfferings = free.length > 0 || paid.length > 0

  // Карточка-тизер основателя — показываем только если хоть что-то заполнено
  const ownerName = profile.name || ''
  const hasOwner = !!(ownerName || profile.owner_photo_url || profile.owner_positioning || profile.bio)

  return (
    <div className="fade-in">
      {/* Возврат к списку организаторов — только в коллабе (их несколько). */}
      {/* ⚠️ Кнопка «назад» ПОВЕРХ шапки и с фоном: шапка бренда идёт с
          отрицательным отступом (margin:-16px) и наезжала на неё — выйти к
          списку организаторов было нечем (жалоба 2026-08-18). */}
      {onBackToOwners && (
        <div onClick={onBackToOwners}
             style={{
               // ⚠️ БЕЗ отрицательного отступа и без sticky: кнопка стоит НАД
               // шапкой бренда, а не поверх неё. С `margin:-16px` и `sticky`
               // она наезжала на название бренда и перекрывала его
               // (жалоба 2026-08-18).
               display: 'flex', alignItems: 'center', gap: 6,
               margin: '0 -16px 0', padding: '12px 16px',
               cursor: 'pointer', background: 'var(--surface)',
               borderBottom: '1px solid var(--border)',
               color: DARK, fontSize: 15, fontWeight: 700,
             }}>
          <span style={{ fontSize: 20, lineHeight: 1 }}>‹</span> Все организаторы
        </div>
      )}
      {/* Шапка-бренд */}
      <div style={{
        padding: '20px 18px 16px',
        background: 'var(--gradient)',
        color: 'white', position: 'relative', overflow: 'hidden',
        margin: '-16px -16px 12px', borderRadius: 0,
      }}>
        <div style={{
          position: 'absolute', top: -40, right: -40, width: 160, height: 160,
          background: 'radial-gradient(circle, rgba(var(--peach-rgb), 0.18) 0%, transparent 70%)',
        }} />
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', position: 'relative' }}>
          {profile.brand_logo_url ? (
            <img src={profile.brand_logo_url} alt=""
                 style={{
                   width: 72, height: 72, borderRadius: 14,
                   objectFit: 'contain', background: 'transparent',
                   flexShrink: 0,
                 }} />
          ) : (
            <div style={{
              width: 72, height: 72, borderRadius: 14,
              background: 'linear-gradient(135deg, #d4789a, #8b4561)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'white', fontWeight: 700, fontSize: 24,
              border: `2px solid ${PEACH}`, flexShrink: 0,
            }}>{initials(brand)}</div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 0.5, lineHeight: 1.15 }}>{brand}</div>
            {brandRole && (
              <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.75)', marginTop: 5, lineHeight: 1.35 }}>
                {brandRole}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Регалии бренда — скрываем если пусто */}
      {brandAch.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {brandAch.map((a, i) => (
              <div key={i} style={{
                background: 'white',
                padding: '10px 12px', borderRadius: 12,
                boxShadow: '0 1px 4px rgba(37,69,93,0.06)',
                border: '1px solid #f0f0f0',
              }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: DARK, lineHeight: 1.1 }}>{a.value}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, lineHeight: 1.25 }}>{a.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ Плашка «О бренде» — НАД основателем, раскрывается вниз ═══
          Пусто — не рисуем вовсе (так же, как «Факты в цифрах» выше).
          Цвет тот же, что у тизера основателя: обе плашки — про «кто мы»,
          и разный фон читался бы как разные по важности блоки. */}
      {!!(profile.brand_bio || '').trim() && (
        <div style={{
          background: 'rgba(var(--peach-rgb), 0.14)', borderRadius: 14,
          border: '1px solid rgba(var(--peach-rgb), 0.35)',
          boxShadow: '0 1px 4px rgba(37,69,93,0.06)',
          padding: 12, marginBottom: 14,
        }}>
          <button onClick={() => setShowBrandBio(v => !v)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                    background: 'transparent', border: 'none', padding: 0,
                    textAlign: 'left', cursor: 'pointer', font: 'inherit',
                  }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: DARK,
                          fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase' }}>
              О бренде
            </div>
            {/* Стрелка смотрит вниз, а в раскрытом виде — вверх: так видно,
                что блок сворачивается обратно, а не ведёт куда-то дальше. */}
            <span style={{ fontSize: 20, color: DARK, fontWeight: 600, lineHeight: 1,
                           transform: showBrandBio ? 'rotate(180deg)' : 'none',
                           transition: 'transform .2s' }}>⌄</span>
          </button>
          {/* ⚠️ Обрезка по строкам — на ОБЁРТКЕ, а не внутри EventDescription:
              текст с тегами приходит своими абзацами и списками, и обрезать
              надо всё разом. Свёрнуто видно 3 строки — этого хватает понять,
              о чём текст, и не занимает пол-экрана. */}
          <div style={showBrandBio ? { marginTop: 8 } : {
            marginTop: 8, overflow: 'hidden',
            display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
          }}>
            <EventDescription
              text={profile.brand_bio}
              style={{ fontSize: 14, color: '#3a4a5a', lineHeight: 1.55 }}
            />
          </div>
          {!showBrandBio && (
            <div onClick={() => setShowBrandBio(true)}
                 style={{ marginTop: 6, fontSize: 12.5, fontWeight: 700,
                          color: DARK, cursor: 'pointer' }}>
              Читать полностью
            </div>
          )}
        </div>
      )}

      {/* Карточка-тизер основателя */}
      {hasOwner && (
        <button onClick={() => setShowOwner(true)}
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer',
                  background: 'rgba(var(--peach-rgb), 0.14)', borderRadius: 14, padding: 12,
                  border: '1px solid rgba(var(--peach-rgb), 0.35)',
                  boxShadow: '0 1px 4px rgba(37,69,93,0.06)',
                  marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12,
                }}>
          {profile.owner_photo_url && (
            <img src={profile.owner_photo_url} alt=""
                 style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover',
                          objectPosition: focalCss(profile.owner_photo_focal), flexShrink: 0,
                          border: `2px solid ${PEACH}` }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: DARK, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase' }}>
              Об основателе
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginTop: 2, lineHeight: 1.2 }}>
              {ownerName}
            </div>
            {profile.owner_positioning && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.3,
                            overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
                            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {profile.owner_positioning}
              </div>
            )}
          </div>
          <div style={{ fontSize: 24, color: DARK, fontWeight: 600, marginRight: 4 }}>›</div>
        </button>
      )}

      {/* Переключатель Бесплатно/Платно — только если продукты есть */}
      {hasOfferings && (<>
      <div style={{
        display: 'flex', padding: 4, margin: '0 0 12px',
        background: 'var(--gradient-135)',
        borderRadius: 14, gap: 4, boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.15)',
      }}>
        {(['free', 'paid'] as const).map(t => (
          <div key={t}
               onClick={() => setTab(t)}
               style={{
                 flex: 1, padding: '10px 4px', textAlign: 'center',
                 fontSize: 13, fontWeight: 700,
                 color: tab === t ? DARK : 'rgba(255,255,255,0.55)',
                 background: tab === t ? 'var(--gradient-peach)' : 'transparent',
                 borderRadius: 11, cursor: 'pointer',
                 boxShadow: tab === t ? '0 2px 8px rgba(var(--peach-rgb), 0.4)' : 'none',
               }}>
            {t === 'free' ? 'Бесплатно' : 'Платно'}
          </div>
        ))}
      </div>

      {/* Список продуктов */}
      {items.length === 0 ? (
        <div style={{ color: 'var(--muted)', textAlign: 'center', padding: 30, fontSize: 13 }}>
          {tab === 'free' ? 'Бесплатных продуктов пока нет' : 'Платных продуктов пока нет'}
        </div>
      ) : items.map(o => <OfferingCard key={o.id} o={o} />)}
      </>)}
    </div>
  )
}
