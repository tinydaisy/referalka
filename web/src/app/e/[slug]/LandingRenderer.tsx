'use client'

/**
 * Рендер собранного лендинга события (миграция 240).
 *
 * Данные приходят готовым деревом с бэка (`/public/event-landing/{slug}`):
 * настройки оформления + блоки в нужном порядке + содержимое живых блоков.
 * Здесь только вёрстка — никаких запросов и бизнес-логики.
 *
 * Вёрстка адаптивная: любая двухколоночная раскладка на узком экране
 * схлопывается в одну колонку (правило проекта — проверять на 375px).
 */
import { useMemo, useState } from 'react'

interface Props {
  data: any
  slug: string
}

/** Металлический градиент — «перелив» из заданного цвета. */
function metallic(color: string): string {
  return `linear-gradient(135deg, ${color} 0%, #ffffff 22%, ${color} 45%, ${shade(color, -18)} 70%, ${color} 100%)`
}

/** Затемнение/осветление HEX на процент — для градиентов и рамок. */
function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex || '#000000'
  const n = parseInt(m[1], 16)
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + (v * pct) / 100)))
  return `#${[f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]
    .map(v => v.toString(16).padStart(2, '0')).join('')}`
}

export default function LandingRenderer({ data, slug }: Props) {
  const { event, page, blocks, data: content } = data
  const radius = page.radius ?? 5

  /* Заголовок: сплошной цвет или металлический перелив по тексту. */
  const headingStyle = useMemo(() => {
    const base: React.CSSProperties = {
      fontFamily: page.font_heading_css,
      lineHeight: 1.05,
    }
    if (page.heading_metallic) {
      return {
        ...base,
        background: metallic(page.color_heading || '#FFCFA4'),
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
      } as React.CSSProperties
    }
    return { ...base, color: page.color_heading || '#FFCFA4' }
  }, [page])

  const btnStyle: React.CSSProperties = {
    background: page.btn_metallic
      ? metallic(page.btn_color || '#FFCFA4')
      : (page.btn_color || '#FFCFA4'),
    color: page.btn_text_color || '#0a1520',
    borderRadius: radius,
    fontFamily: page.font_body_css,
  }

  const cardStyle: React.CSSProperties = {
    borderRadius: radius,
    border: `1px solid transparent`,
    background: page.border_metallic
      ? `linear-gradient(rgba(255,255,255,.04), rgba(255,255,255,.04)) padding-box, ${metallic(page.border_color || '#FFCFA4')} border-box`
      : `rgba(255,255,255,.04)`,
    borderColor: page.border_metallic ? undefined : (page.border_color || '#FFCFA4'),
  }

  const iconColor = page.icon_color || '#FFCFA4'

  return (
    <div
      style={{
        background: page.bg_image_url ? undefined : page.bg_css,
        color: page.color_body || '#FFFFFF',
        fontFamily: page.font_body_css,
        minHeight: '100vh',
      }}
    >
      {/* Фоновая картинка страницы с перекрытием — чтобы текст читался. */}
      {page.bg_image_url && (
        <div className="fixed inset-0 -z-10">
          <img src={page.bg_image_url} alt="" className="h-full w-full object-cover" />
          <div
            className="absolute inset-0"
            style={{
              background: page.bg_overlay || page.bg_css,
              opacity: (page.bg_overlay_opacity ?? 60) / 100,
            }}
          />
        </div>
      )}

      <style>{`
        .lp-link { color: ${page.color_link || '#FFCFA4'}; }
        .lp-link:hover { text-decoration: underline; }
        .lp-scroll::-webkit-scrollbar { height: 6px; }
        .lp-scroll::-webkit-scrollbar-thumb { background: ${iconColor}; border-radius: 3px; }
        /* Двухколоночные секции: на телефоне одна колонка, с 768px — заданная
           пропорция из --lp-md-cols (её ставит сама секция инлайном). */
        .lp-cols { grid-template-columns: 1fr; }
        @media (min-width: 768px) {
          .lp-cols { grid-template-columns: var(--lp-md-cols, 1fr); }
        }
      `}</style>

      {blocks.map((b: any) => (
        <Section
          key={b.id}
          block={b}
          page={page}
          radius={radius}
          headingStyle={headingStyle}
          btnStyle={btnStyle}
          cardStyle={cardStyle}
          iconColor={iconColor}
          event={event}
          content={content}
          slug={slug}
        />
      ))}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────── */

function Section({
  block, page, radius, headingStyle, btnStyle, cardStyle, iconColor, event, content, slug,
}: any) {
  const sectionStyle: React.CSSProperties = {
    background: block.bg_image_url ? undefined : (block.bg_color || undefined),
    borderRadius: block.border_radius || undefined,
    border: block.border_width
      ? `${block.border_width}px solid ${block.border_color || '#FFCFA4'}`
      : undefined,
  }

  const title = block.title
  const body = block.body

  /* Содержимое блока — своё для каждого типа. */
  const blockBody = <BlockBody
    block={block} page={page} radius={radius} btnStyle={btnStyle}
    cardStyle={cardStyle} iconColor={iconColor} headingStyle={headingStyle}
    event={event} content={content} slug={slug}
  />

  /* Картинка-контент секции (не фон): встаёт рядом с содержимым или над ним. */
  const pic = block.image_url ? (
    <img
      src={block.image_url}
      alt=""
      loading="lazy"
      className="w-full object-cover"
      style={{ borderRadius: radius }}
    />
  ) : null

  const sideways = pic && (block.image_position === 'left' || block.image_position === 'right')
  const inner = !pic ? blockBody : sideways ? (
    <div className="grid items-center gap-6 sm:grid-cols-2">
      <div className={block.image_position === 'right' ? 'sm:order-2' : ''}>{pic}</div>
      <div className={block.image_position === 'right' ? 'sm:order-1' : ''}>{blockBody}</div>
    </div>
  ) : (
    <div className="space-y-6">
      {block.image_position === 'top' && pic}
      {blockBody}
      {block.image_position === 'bottom' && pic}
    </div>
  )

  const heading = title ? (
    <h2
      className="text-3xl font-bold uppercase sm:text-4xl md:text-5xl"
      style={headingStyle}
    >
      {title}
    </h2>
  ) : null

  const subtitle = block.subtitle ? (
    <p className="mt-3 text-base opacity-80 sm:text-lg">{block.subtitle}</p>
  ) : null

  /* Раскладка: заголовок сверху / слева / справа. На мобильном — всегда сверху. */
  const twoCol = block.layout === 'left' || block.layout === 'right'
  const ratio = block.split_ratio || 50

  return (
    <section className="relative px-4 py-12 sm:px-6 sm:py-16" style={sectionStyle}>
      {block.bg_image_url && (
        <div className="absolute inset-0 -z-10 overflow-hidden"
             style={{ borderRadius: block.border_radius || undefined }}>
          <img src={block.bg_image_url} alt="" className="h-full w-full object-cover" />
          <div
            className="absolute inset-0"
            style={{
              background: block.bg_overlay || '#0a1520',
              opacity: (block.bg_overlay_opacity ?? 60) / 100,
            }}
          />
        </div>
      )}

      <div className="mx-auto max-w-6xl">
        {twoCol ? (
          /* Две колонки: заголовок в одной, содержимое в другой.
             Пропорция динамическая (split_ratio), поэтому колонки задаются
             инлайновой переменной — Tailwind классы на лету не собирает.
             До 768px переменная = 1fr, то есть одна колонка (правило: 375px). */
          <div
            className="lp-cols grid items-start gap-8 md:gap-12"
            style={{
              ['--lp-md-cols' as any]: block.layout === 'right'
                ? `${100 - ratio}% ${ratio}%`
                : `${ratio}% ${100 - ratio}%`,
            }}
          >
            <div className={block.layout === 'right' ? 'md:order-2' : ''}>
              {heading}
              {subtitle}
            </div>
            <div className={block.layout === 'right' ? 'md:order-1' : ''}>
              {body && <p className="mb-6 whitespace-pre-wrap opacity-90">{body}</p>}
              {inner}
            </div>
          </div>
        ) : (
          <>
            {heading}
            {subtitle}
            {body && <p className="mt-4 whitespace-pre-wrap opacity-90">{body}</p>}
            <div className="mt-8">{inner}</div>
          </>
        )}
      </div>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────────────────── */

function BlockBody({
  block, page, radius, btnStyle, cardStyle, iconColor, headingStyle, event, content, slug,
}: any) {
  const items = block.items

  switch (block.kind) {
    /* ── Шапка ─────────────────────────────────────────────────────────── */
    case 'hero': {
      // На странице после оплаты (kind='post_pay') бэк присылает `bots` —
      // кнопки на ботов клиента вместо кнопки регистрации, плюс свой текст.
      const bots = content.bots
      const isThanks = Array.isArray(bots)
      return (
        <div className="text-center">
          <h1
            className="text-4xl font-bold uppercase sm:text-6xl md:text-7xl"
            style={headingStyle}
          >
            {isThanks ? (page.post_pay_title || 'Спасибо за оплату!') : event.title}
          </h1>

          {isThanks ? (
            <>
              {page.post_pay_text && (
                <p className="mx-auto mt-5 max-w-2xl whitespace-pre-wrap text-lg opacity-90">
                  {page.post_pay_text}
                </p>
              )}
              {!!bots.length && (
                <div className="mt-8 flex flex-wrap justify-center gap-3">
                  {bots.map((b: any) => (
                    <a key={b.platform} href={b.url} target="_blank" rel="noreferrer"
                       className="px-7 py-4 font-bold uppercase transition-transform hover:scale-105"
                       style={btnStyle}>
                      {b.label}
                    </a>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {block.subtitle && (
                <p className="mx-auto mt-5 max-w-3xl text-lg opacity-90 sm:text-xl">
                  {block.subtitle}
                </p>
              )}
              {event.start_at && (
                <p className="mt-4 text-base opacity-75">{formatDate(event.start_at)}</p>
              )}
              <a
                href={`/event/${slug}/register`}
                className="mt-8 inline-block px-8 py-4 text-base font-bold uppercase tracking-wide transition-transform hover:scale-105"
                style={btnStyle}
              >
                {block.button_label || 'Участвовать'}
              </a>
            </>
          )}
        </div>
      )
    }

    /* ── Осталось мест ─────────────────────────────────────────────────── */
    case 'seats': {
      const s = content.seats || {}
      return (
        <div className="text-center">
          {s.left != null ? (
            <>
              <div className="text-5xl font-bold sm:text-6xl" style={headingStyle}>
                {s.left}
              </div>
              <p className="mt-2 opacity-80">
                свободных мест из {s.total}
              </p>
              <div className="mx-auto mt-4 h-2 max-w-md overflow-hidden rounded-full bg-white/15">
                <div
                  className="h-full"
                  style={{
                    width: `${Math.min(100, ((s.taken || 0) / (s.total || 1)) * 100)}%`,
                    background: iconColor,
                  }}
                />
              </div>
            </>
          ) : (
            <div className="text-5xl font-bold" style={headingStyle}>
              {s.taken || 0}
              <span className="ml-2 text-lg font-normal opacity-80">уже с нами</span>
            </div>
          )}
        </div>
      )
    }

    /* ── Для кого ──────────────────────────────────────────────────────── */
    case 'audience': {
      const list: string[] = Array.isArray(items) ? items.filter((i: any) => typeof i === 'string' && i) : []
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          {list.map((t, i) => (
            <div key={i} className="flex items-start gap-3 p-5" style={cardStyle}>
              {/* Галочка — отличает «для кого» от нумерованного «что получите» */}
              <svg viewBox="0 0 24 24" className="mt-0.5 h-6 w-6 shrink-0"
                   fill="none" stroke={iconColor} strokeWidth="2.5"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              <span className="font-medium">{t}</span>
            </div>
          ))}
        </div>
      )
    }

    /* ── Список пунктов ────────────────────────────────────────────────── */
    case 'benefits': {
      const list: string[] = Array.isArray(items) ? items.filter((i: any) => typeof i === 'string' && i) : []
      return (
        <div className="space-y-3">
          {list.map((t, i) => (
            <div key={i} className="flex items-start gap-4 p-4" style={cardStyle}>
              <span
                className="shrink-0 text-2xl font-bold tabular-nums"
                style={{ color: iconColor }}
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="pt-1 font-medium uppercase">{t}</span>
            </div>
          ))}
        </div>
      )
    }

    /* ── Карточки: ценности, чем отличаемся ────────────────────────────── */
    case 'values':
    case 'difference': {
      const list = Array.isArray(items)
        ? items.filter((c: any) => c && typeof c === 'object' && (c.title || c.text))
        : []
      if (!list.length) return null
      return (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((c: any, i: number) => (
            <div key={i} className="p-6 text-center" style={cardStyle}>
              <div className="font-bold uppercase tracking-wide"
                   style={{ color: page.color_heading || '#FFCFA4' }}>
                {c.title}
              </div>
              {c.text && (
                <p className="mt-3 text-sm leading-relaxed opacity-85">{c.text}</p>
              )}
            </div>
          ))}
        </div>
      )
    }

    /* ── Цифры ─────────────────────────────────────────────────────────── */
    case 'numbers': {
      const list = Array.isArray(items) ? items.filter((n: any) => n && (n.value || n.label)) : []
      return (
        <div className="grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4">
          {list.map((n: any, i: number) => (
            <div key={i} className="p-5 text-center" style={cardStyle}>
              <div className="text-3xl font-bold sm:text-4xl" style={headingStyle}>
                {n.value}
              </div>
              <div className="mt-1 text-sm opacity-80">{n.label}</div>
            </div>
          ))}
        </div>
      )
    }

    /* ── Спикеры ───────────────────────────────────────────────────────── */
    // Раскладка проверена на боевом лендинге (GetCourse): квадратное фото,
    // имя капсом, должность, тема с акцентной полосой слева, регалии списком.
    case 'speakers': {
      const list = content.speakers || []
      if (!list.length) return null
      return (
        <div className="grid gap-5" style={{
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        }}>
          {list.map((s: any) => {
            const ach: string[] = Array.isArray(s.achievements)
              ? s.achievements
                  .map((a: any) => typeof a === 'string' ? a : (a?.label || ''))
                  // Часть регалий заведена с дефисом в начале — убираем, маркер свой.
                  .map((a: string) => a.replace(/^[-–—•\s]+/, '').trim())
                  .filter(Boolean)
                  .slice(0, 5)
              : []
            return (
              <div key={s.id} className="flex flex-col overflow-hidden" style={cardStyle}>
                {s.photo_url && (
                  <img
                    src={s.photo_url}
                    alt={s.name}
                    loading="lazy"
                    className="block w-full object-cover"
                    style={{ aspectRatio: '1 / 1', background: 'rgba(255,255,255,.06)' }}
                  />
                )}
                <div className="flex flex-1 flex-col gap-2 p-4">
                  <div className="text-lg font-bold uppercase leading-tight tracking-wide"
                       style={{ color: page.color_heading || '#FFCFA4' }}>
                    {s.name}
                  </div>
                  {s.title && (
                    <div className="text-sm font-semibold leading-snug opacity-90">{s.title}</div>
                  )}
                  {s.topic && (
                    <div className="pl-3 text-[15px] font-semibold leading-snug"
                         style={{ borderLeft: `3px solid ${iconColor}` }}>
                      {s.topic}
                    </div>
                  )}
                  {!!ach.length && (
                    <ul className="mt-1 list-disc pl-5 text-sm leading-relaxed opacity-80">
                      {ach.map((a, i) => <li key={i} className="mb-1">{a}</li>)}
                    </ul>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )
    }

    /* ── Программа ─────────────────────────────────────────────────────── */
    case 'program': {
      const p = content.program || { days: [], sessions: [] }
      return (
        <div className="space-y-8">
          {(p.days || []).map((d: any) => {
            const sess = (p.sessions || []).filter((s: any) => s.day === d.day_number)
            if (!sess.length) return null
            return (
              <div key={d.id}>
                <h3 className="mb-3 text-xl font-bold uppercase" style={{ color: page.color_heading }}>
                  {d.title || `День ${d.day_number}`}
                  {d.day_date && (
                    <span className="ml-2 text-sm font-normal opacity-70">
                      {formatDay(d.day_date)}
                    </span>
                  )}
                </h3>
                <div className="space-y-2">
                  {sess.map((s: any) => (
                    <div key={s.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 p-4" style={cardStyle}>
                      {s.start_time && (
                        <span className="shrink-0 font-mono font-bold" style={{ color: iconColor }}>
                          {s.start_time}{s.end_time ? `–${s.end_time}` : ''} МСК
                        </span>
                      )}
                      <span className="flex-1 font-medium">{s.title}</span>
                      {s.speaker_name && (
                        <span className="text-sm opacity-75">{s.speaker_name}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )
    }

    /* ── Тарифы ────────────────────────────────────────────────────────── */
    case 'tariffs': {
      const t = content.tariffs || { items: [] }
      return (
        <>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {(t.items || []).map((x: any) => (
              <div key={x.id} className="flex flex-col p-6" style={cardStyle}>
                <div className="text-xl font-bold uppercase" style={{ color: page.color_heading }}>
                  {x.title}
                </div>
                {x.price != null && (
                  <div className="mt-2 text-3xl font-bold" style={headingStyle}>
                    {Number(x.price).toLocaleString('ru-RU')} ₽
                  </div>
                )}
                {x.description && (
                  <p className="mt-3 flex-1 whitespace-pre-wrap text-sm opacity-85">
                    {x.description}
                  </p>
                )}
                {x.pay_url && (
                  <a
                    href={x.pay_url}
                    className="mt-5 block px-5 py-3 text-center font-bold uppercase"
                    style={btnStyle}
                  >
                    Купить
                  </a>
                )}
              </div>
            ))}
          </div>
          {t.offer_url && (
            <p className="mt-4 text-center text-sm opacity-70">
              Покупая, вы соглашаетесь с{' '}
              <a href={t.offer_url} target="_blank" rel="noreferrer" className="lp-link">
                офертой
              </a>
            </p>
          )}
        </>
      )
    }

    /* ── Подарки ───────────────────────────────────────────────────────── */
    case 'gifts': {
      const list = content.gifts || []
      return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((g: any, i: number) => (
            <div key={i} className="p-5" style={cardStyle}>
              <div className="text-sm font-bold uppercase" style={{ color: iconColor }}>
                {/* Порог 0 = подарок всем за сам факт регистрации. */}
                {!g.threshold_count ? 'За регистрацию' : `За ${g.threshold_count} ${plural(g.threshold_count)}`}
              </div>
              <div className="mt-2 font-medium">{g.title || 'Подарок'}</div>
              {g.description && (
                <p className="mt-1 text-sm opacity-75">{g.description}</p>
              )}
            </div>
          ))}
        </div>
      )
    }

    /* ── Организатор ───────────────────────────────────────────────────── */
    case 'organizer': {
      const o = content.organizer
      if (!o) return null
      return (
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
          {(o.owner_photo_url || o.brand_photo_url) && (
            <img
              src={o.owner_photo_url || o.brand_photo_url}
              alt={o.owner_name}
              className="h-40 w-40 shrink-0 object-cover"
              style={{ borderRadius: radius }}
            />
          )}
          <div className="text-center sm:text-left">
            <div className="text-2xl font-bold uppercase" style={{ color: page.color_heading }}>
              {o.owner_name}
            </div>
            {o.owner_positioning && (
              <p className="mt-1 opacity-85">{o.owner_positioning}</p>
            )}
            {o.bio && <p className="mt-3 whitespace-pre-wrap opacity-80">{o.bio}</p>}
            {!!(o.owner_achievements || []).length && (
              <div className="mt-5 flex flex-wrap justify-center gap-5 sm:justify-start">
                {o.owner_achievements.map((a: any, i: number) => (
                  <div key={i}>
                    <div className="text-2xl font-bold" style={{ color: iconColor }}>
                      {a.value}
                    </div>
                    <div className="text-xs opacity-75">{a.label}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )
    }

    /* ── Галерея / отзывы ──────────────────────────────────────────────── */
    case 'gallery': {
      const g = items && !Array.isArray(items) ? items : {}
      const list = Array.isArray(g.list) ? g.list.filter((x: any) => x?.url) : []
      if (!list.length) return null
      const isVideo = g.media === 'video'
      const carousel = (g.mode || 'carousel') === 'carousel'

      const cards = list.map((x: any, i: number) => (
        <figure
          key={i}
          className={carousel ? 'w-72 shrink-0 snap-start sm:w-96' : ''}
          style={cardStyle}
        >
          {isVideo ? (
            <div className="aspect-video w-full overflow-hidden" style={{ borderRadius: radius }}>
              <iframe
                src={embedUrl(x.url)}
                className="h-full w-full"
                allowFullScreen
                loading="lazy"
                title={x.caption || `Видео ${i + 1}`}
              />
            </div>
          ) : (
            <img
              src={x.url}
              alt={x.caption || ''}
              loading="lazy"
              className="w-full object-cover"
              style={{ borderRadius: radius }}
            />
          )}
          {x.caption && (
            <figcaption className="p-3 text-sm opacity-80">{x.caption}</figcaption>
          )}
        </figure>
      ))

      return carousel ? (
        <div className="lp-scroll flex snap-x snap-mandatory gap-4 overflow-x-auto pb-3">
          {cards}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{cards}</div>
      )
    }

    /* ── Есть вопросы ──────────────────────────────────────────────────── */
    case 'support': {
      const s = content.support || {}
      const links = [
        ['Telegram', s.telegram],
        ['ВКонтакте', s.vk],
        ['MAX', s.max],
      ].filter(([, url]) => !!url)
      if (!links.length) return null
      return (
        <div className="flex flex-wrap justify-center gap-3">
          {links.map(([label, url]: any) => (
            <a key={label} href={url} target="_blank" rel="noreferrer"
               className="px-6 py-3 font-bold uppercase" style={btnStyle}>
              {label}
            </a>
          ))}
        </div>
      )
    }

    /* ── Подвал ────────────────────────────────────────────────────────── */
    case 'footer': {
      const f = content.footer
      if (!f) return null
      const legal = [
        f.legal_name,
        f.legal_inn && `${f.legal_inn_label} ${f.legal_inn}`,
        f.legal_ogrn && `ОГРН ${f.legal_ogrn}`,
        f.legal_address,
      ].filter(Boolean)
      return (
        <div className="space-y-3 text-sm opacity-75">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {f.privacy_url && (
              <a href={f.privacy_url} className="lp-link">Политика конфиденциальности</a>
            )}
            {f.offer_url && (
              <a href={f.offer_url} target="_blank" rel="noreferrer" className="lp-link">Оферта</a>
            )}
            {f.email && <a href={`mailto:${f.email}`} className="lp-link">{f.email}</a>}
            {f.phone && <a href={`tel:${f.phone}`} className="lp-link">{f.phone}</a>}
          </div>
          {!!legal.length && <div>{legal.join(' · ')}</div>}
          <div className="opacity-60">
            © {new Date().getFullYear()} {f.brand_name}
          </div>
        </div>
      )
    }

    /* ── Своя секция и всё остальное (values, mission, difference) ─────── */
    // Текст этих блоков уже выведен секцией выше — здесь только кнопка, если есть.
    case 'text':
    default:
      return block.button_label && block.button_url ? (
        <a href={block.button_url} target="_blank" rel="noreferrer"
           className="inline-block px-8 py-4 font-bold uppercase" style={btnStyle}>
          {block.button_label}
        </a>
      ) : null
  }
}

/* ── Утилиты ────────────────────────────────────────────────────────────── */

/** Склонение слова «друг» по числу: 1 друг, 3 друга, 5 друзей. */
function plural(n: number): string {
  const mod10 = n % 10, mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'друга'          // «за 1 друга»
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'друга'
  return 'друзей'
}

/** Ссылка на видео → embed. Поддержаны YouTube, VK Видео, Rutube. */
function embedUrl(url: string): string {
  const yt = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/.exec(url)
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`
  const rt = /rutube\.ru\/video\/([\w]+)/.exec(url)
  if (rt) return `https://rutube.ru/play/embed/${rt[1]}`
  const vk = /vk\.com\/video(-?\d+)_(\d+)/.exec(url)
  if (vk) return `https://vk.com/video_ext.php?oid=${vk[1]}&id=${vk[2]}`
  return url
}

/** Дата события — всегда МСК (правило проекта). */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Moscow',
    }) + ' МСК'
  } catch { return '' }
}

function formatDay(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', timeZone: 'Europe/Moscow',
    })
  } catch { return '' }
}
