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
import { CardIcon } from '@/components/landing/icons'

interface Props {
  data: any
  slug: string
}

/**
 * Металлический градиент — вертикальный перелив из цвета темы.
 * Формула снята с боевого лендинга: тёмный → цвет → светлый блик → цвет →
 * тёмный. Именно вертикаль (180deg) и симметрия дают ощущение металла;
 * диагональный блик выглядит как обычная заливка.
 */
function metallic(color: string): string {
  const dark = shade(color, -45)   // #FFCFA4 → примерно #8A5628
  const light = shade(color, 30)   // #FFCFA4 → примерно #FFE4C9
  return `linear-gradient(180deg, ${dark}, ${color}, ${light}, ${color}, ${dark})`
}

/** Заливка кнопки — тот же металл, но мягче по краям (как .gold-btn). */
function metallicButton(color: string): string {
  const edge = shade(color, -22)   // #FFCFA4 → примерно #C99A6E
  const light = shade(color, 42)   // → #FFF0DE
  return `linear-gradient(180deg, ${edge}, ${color}, ${light}, ${color}, ${edge})`
}

/**
 * Оттенок HEX: минус — темнее (умножение), плюс — светлее (к белому).
 * Осветление именно «к белому», иначе светлый персик упирается в потолок 255
 * и блик не виден.
 */
function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex || '#000000'
  const n = parseInt(m[1], 16)
  const f = (v: number) => pct >= 0
    ? Math.round(v + (255 - v) * (pct / 100))
    : Math.round(v * (1 + pct / 100))
  return `#${[f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]
    .map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`
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
      ? metallicButton(page.btn_color || '#FFCFA4')
      : (page.btn_color || '#FFCFA4'),
    color: page.btn_text_color || '#0a1520',
    borderRadius: radius,
    fontFamily: page.font_body_css,
    letterSpacing: '.04em',
    // Внутренний блик сверху + мягкая тень — объём, как у боевой кнопки.
    boxShadow: page.btn_metallic
      ? 'inset 0 1px 0 rgba(255,255,255,.45), 0 6px 18px rgba(0,0,0,.35)'
      : undefined,
  }

  // ⚠️ Металл — только В РАМКЕ, фон карточки остаётся прозрачным. Заливать
  // карточку градиентом нельзя: текст поверх становится нечитаемым.
  const cardStyle: React.CSSProperties = {
    borderRadius: radius,
    border: `1px solid ${page.border_color || '#FFCFA4'}`,
    background: 'rgba(255,255,255,.02)',
  }

  const iconColor = page.icon_color || '#FFCFA4'

  // Режим градиента:
  //   page   — растянут на всю страницу (на длинном лендинге переход не виден);
  //   screen — повторяется на каждом экране (по умолчанию — читается везде);
  //   block  — свой градиент у каждой секции.
  const bgMode = page.bg_mode || 'screen'
  const rootBg: React.CSSProperties = page.bg_image_url
    ? {}
    : bgMode === 'screen'
      // ⚠️ Именно `repeat-y` НЕЛЬЗЯ: конец градиента (тёмный) упирается в
      // начало следующего (светлый) — на стыке видна резкая полоса.
      // `repeat: round` + зеркальный градиент дают бесшовный перелив.
      ? { background: page.bg_css_screen || page.bg_css,
          backgroundSize: '100% 200vh', backgroundRepeat: 'repeat-y' }
      : bgMode === 'block'
        // Фон рисует каждая секция; здесь только базовый цвет под ними.
        ? { background: page.bg_color || '#25455D' }
        : { background: page.bg_css }

  return (
    <div
      className="lp-root"
      style={{
        ...rootBg,
        color: page.color_body || '#FFFFFF',
        fontFamily: page.font_body_css,
        fontSize: page.body_size ? `${page.body_size}px` : undefined,
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
        /* Страховка от горизонтальной прокрутки: страница не должна ездить
           вбок ни на одном экране (правило проекта — проверять на 375px).
           Длинные ссылки и заголовки переносим, картинки не шире родителя. */
        /* Сетка карточек: число колонок задаётся в блоке (--lp-cols-lg),
           но на узких экранах их всегда меньше — иначе карточки схлопнутся
           в нечитаемые полоски. */
        .lp-grid { grid-template-columns: 1fr; }
        @media (min-width: 560px)  { .lp-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (min-width: 900px)  { .lp-grid { grid-template-columns: repeat(min(3, var(--lp-cols-lg, 3)), 1fr); } }
        @media (min-width: 1160px) { .lp-grid { grid-template-columns: repeat(var(--lp-cols-lg, 3), 1fr); } }
        .lp-root { overflow-x: hidden; }
        .lp-root img { max-width: 100%; }
        .lp-root h1, .lp-root h2, .lp-root h3 { overflow-wrap: anywhere; }
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
  // В режиме «градиент по блокам» каждая секция получает полный градиент —
  // переход виден внутри каждой, а не размазан по всей странице.
  const blockGradient = page.bg_mode === 'block' && !block.bg_color ? page.bg_css : undefined
  // Рамку карточек можно снять у секции — например, у цифр она лишняя.
  // Стиль карточек: рамка вокруг каждой / линия-разделитель снизу / без всего.
  const cs = block.card_style || (block.cards_bordered === false ? 'plain' : 'border')
  const cards: React.CSSProperties =
    cs === 'divider'
      ? { borderRadius: 0, border: 'none',
          borderBottom: `1px solid ${page.border_color || '#FFCFA4'}40`,
          background: 'transparent' }
      : cs === 'plain'
        ? { borderRadius: radius, border: 'none', background: 'transparent' }
        : cardStyle

  // Секция может переопределить цвет заголовка (например, белым вместо
  // фирменного) и признак металлика — не трогая тему всей страницы.
  const ownColor = block.title_color || page.color_heading || '#FFCFA4'
  const ownMetal = block.title_metallic == null ? !!page.heading_metallic : !!block.title_metallic
  const ownHeading: React.CSSProperties = ownMetal
    ? { fontFamily: page.font_heading_css, lineHeight: 1.05,
        background: metallic(ownColor), WebkitBackgroundClip: 'text',
        backgroundClip: 'text', color: 'transparent' }
    : { fontFamily: page.font_heading_css, lineHeight: 1.05, color: ownColor }
  const sectionStyle: React.CSSProperties = {
    background: block.bg_image_url ? undefined : (block.bg_color || blockGradient || undefined),
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
    cardStyle={cards} iconColor={iconColor} headingStyle={ownHeading}
    event={event} content={content} slug={slug}
  />

  /* Картинка-контент секции (не фон): встаёт рядом с содержимым или над ним. */
  const pic = block.image_url ? (
    <img
      src={block.image_url}
      alt=""
      loading="lazy"
      className="object-cover"
      style={{
        borderRadius: radius,
        width: `${block.image_width || 100}%`,
        // По центру — картинка сама центрируется в колонке.
        margin: block.image_position === 'center' ? '0 auto' : undefined,
        display: 'block',
      }}
    />
  ) : null

  const sideways = pic && (block.image_position === 'left' || block.image_position === 'right')
  const centered = pic && block.image_position === 'center'
  const inner = !pic ? blockBody : centered ? (
    // По центру: содержимое сверху, картинка под ним по середине колонки.
    <div className="space-y-8">
      {blockBody}
      <div className="text-center">{pic}</div>
    </div>
  ) : sideways ? (
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

  // Размер заголовка задаётся в блоке (px на широком экране). clamp даёт
  // плавное уменьшение на телефоне — фиксированный размер вылезал бы за экран.
  const tSize = block.title_size || 48
  const align = block.title_align || 'left'
  const heading = title ? (
    <h2
      className="font-bold uppercase"
      style={{
        ...ownHeading,
        textAlign: align as any,
        fontSize: `clamp(${Math.round(tSize * 0.55)}px, ${(tSize / 12).toFixed(1)}vw, ${tSize}px)`,
      }}
    >
      {title}
    </h2>
  ) : null

  const subtitle = block.subtitle ? (
    <p className="mt-3 text-base opacity-80 sm:text-lg"
       style={{ textAlign: (block.title_align || 'left') as any }}>
      {block.subtitle}
    </p>
  ) : null

  /* Раскладка: заголовок сверху / слева / справа. На мобильном — всегда сверху. */
  const twoCol = block.layout === 'left' || block.layout === 'right'
  const ratio = block.split_ratio || 50

  // Отступы — из настроек страницы. Боковые не меньше 16px на телефоне,
  // иначе текст упирается в край экрана.
  const padX = Math.max(16, page.pad_x ?? 24)
  const padY = block.pad_y ?? page.section_gap ?? 64
  const maxW = page.content_width ?? 1120

  return (
    <section
      className="relative"
      style={{
        ...sectionStyle,
        paddingLeft: padX, paddingRight: padX,
        paddingTop: padY, paddingBottom: padY,
      }}
    >
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

      <div className="mx-auto w-full" style={{ maxWidth: maxW ? maxW : undefined }}>
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
          {/* Дата — над заголовком, как на боевом лендинге. */}
          {!isThanks && event.start_at && (
            <p className="mb-4 text-base opacity-80">{formatDate(event.start_at)}</p>
          )}
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
              {/* Подзаголовок — «Описание для лендинга» из настроек события.
                  Отдельного поля в конструкторе нет: название и описание
                  правятся в одном месте, на лендинге не дублируются. */}
              {event.description && (
                <p className="mx-auto mt-5 max-w-3xl text-lg opacity-90 sm:text-xl">
                  {event.description}
                </p>
              )}
              {/* Счётчик мест — рядом с кнопкой, а не отдельной секцией.
                  Положение задаётся в блоке «Шапка»: над кнопкой или сбоку. */}
              <div className={`mt-8 flex flex-wrap items-center justify-center gap-5 ${
                block.seats_position === 'side' ? 'flex-row' : 'flex-col'
              }`}>
                {block.show_seats && content.seats && (
                  <SeatsBadge seats={content.seats} iconColor={iconColor} radius={radius} />
                )}
                <a
                  href={`/event/${slug}/register`}
                  className="inline-block px-8 py-4 text-base font-bold uppercase tracking-wide transition-transform hover:scale-105"
                  style={btnStyle}
                >
                  {block.button_label || 'Участвовать'}
                </a>
              </div>
            </>
          )}
        </div>
      )
    }

    /* ── Осталось мест (отдельной секцией) ─────────────────────────────── */
    // Обычно счётчик встраивают в шапку рядом с кнопкой (галочка в блоке
    // «Шапка»), но при желании его можно вывести и самостоятельной секцией.
    case 'seats':
      return content.seats
        ? <div className="text-center">
            <SeatsBadge seats={content.seats} iconColor={iconColor} radius={radius} />
          </div>
        : null

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
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((c: any, i: number) => (
            <div key={i}
                 className="flex flex-col items-center px-6 pb-7 pt-8 text-center"
                 style={cardStyle}>
              {c.icon && (
                <div className="mb-5">
                  <CardIcon
                    iconKey={c.icon}
                    color={iconColor}
                    metallic={!!page.icon_metallic}
                    size={88}
                    id={`${block.id}-${i}`}
                  />
                </div>
              )}
              <h3 className="text-base font-bold uppercase tracking-wider"
                  style={{ color: page.color_heading || '#FFCFA4' }}>
                {c.title}
              </h3>
              {c.text && (
                <p className="mt-3 text-sm leading-relaxed opacity-90">{c.text}</p>
              )}
            </div>
          ))}
        </div>
      )
    }

    /* ── Цифры ─────────────────────────────────────────────────────────── */
    case 'numbers': {
      const list = Array.isArray(items) ? items.filter((n: any) => n && (n.value || n.label)) : []
      // Цифры — крупным металликом из цвета иконок; число колонок настраивается.
      const metalNum: React.CSSProperties = {
        fontFamily: page.font_heading_css,
        background: metallic(iconColor),
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
        lineHeight: 1,
      }
      return (
        <div className="lp-grid grid gap-8"
             style={{ ['--lp-cols-lg' as any]: Math.max(1, Math.min(6, block.columns || 4)) }}>
          {list.map((n: any, i: number) => (
            <div key={i} className="p-5 text-center" style={cardStyle}>
              <div className="text-5xl font-bold sm:text-6xl" style={metalNum}>
                {n.value}
              </div>
              <div className="mt-3 text-sm opacity-85">{n.label}</div>
            </div>
          ))}
        </div>
      )
    }

    /* ── Спикеры ───────────────────────────────────────────────────────── */
    // Раскладка проверена на боевом лендинге (GetCourse): квадратное фото,
    // имя капсом, должность, тема с акцентной полосой слева, регалии списком.
    case 'speakers':
      return <SpeakersBlock
        list={content.speakers || []} block={block} page={page}
        cardStyle={cardStyle} iconColor={iconColor} btnStyle={btnStyle}
      />

    /* ── Программа ─────────────────────────────────────────────────────── */
    // Дни — кнопками-табами (как на боевом лендинге), слоты — карточками:
    // время слева с акцентной полосой, круглое фото спикера, тема, должность.
    case 'program':
      return <ProgramBlock
        program={content.program} page={page} cardStyle={cardStyle}
        iconColor={iconColor} radius={radius} btnStyle={btnStyle}
      />

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
                  <ul className="mt-4 flex-1 list-none space-y-2 p-0 text-sm leading-relaxed opacity-90">
                    {String(x.description).split('\n').map((r: string) => r.trim()).filter(Boolean)
                      .map((row: string, k: number) => (
                        <li key={k} className="flex gap-2">
                          <span style={{ color: iconColor }}>—</span>
                          <span>{row}</span>
                        </li>
                      ))}
                  </ul>
                )}
                {/* Ссылка оплаты не задана — ведём на регистрацию (бесплатный
                    тариф или оплата настраивается позже). */}
                <a
                  href={x.pay_url || `/event/${slug}/register`}
                  className="mt-6 block px-5 py-3.5 text-center font-bold uppercase"
                  style={btnStyle}
                >
                  Выбрать
                </a>
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
    // Список с иконкой-подарком (вёрстка с боевого лендинга). Названия и
    // пороги — из реф-программы события, здесь ничего не дублируется.
    case 'gifts': {
      const list = content.gifts || []
      if (!list.length) return null
      return (
        <ul className="mx-auto flex max-w-3xl list-none flex-col gap-5 p-0">
          {list.map((g: any, i: number) => (
            <li key={i} className="flex items-start gap-4">
              <GiftIcon color={iconColor} id={`g${i}`} />
              <div className="min-w-0 flex-1 pt-1">
                <span className="font-bold">{g.title || 'Подарок'}</span>
                {g.description && (
                  <span className="opacity-85"> — {g.description}</span>
                )}
                {!!g.threshold_count && (
                  <span className="ml-2 whitespace-nowrap text-sm font-semibold"
                        style={{ color: iconColor }}>
                    за {g.threshold_count} {plural(g.threshold_count)}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )
    }

    /* ── Организатор ───────────────────────────────────────────────────── */
    // Вёрстка с боевого лендинга: крупное фото слева, справа имя,
    // позиционирование и биография точками. Рамка золотая, фон прозрачный.
    case 'organizer': {
      const o = content.organizer
      if (!o) return null
      const photo = o.owner_photo_url || o.brand_photo_url
      // Биография — построчно; ведущие маркеры из текста срезаем, точка своя.
      const bio: string[] = String(o.bio || '')
        .split('\n')
        .map((x: string) => x.replace(/^[•\-–—\s]+/, '').trim())
        .filter(Boolean)

      return (
        <div
          className="flex flex-col items-center gap-8 p-7 text-center md:flex-row md:gap-11 md:p-10 md:text-left"
          style={{
            border: `1px solid ${page.border_color || '#FFCFA4'}`,
            borderRadius: Math.max(radius, 16),
            background: 'transparent',
          }}
        >
          {photo && (
            <img
              src={photo}
              alt={o.owner_name}
              loading="lazy"
              className="w-full shrink-0 object-cover md:w-[360px]"
              style={{
                aspectRatio: '4 / 5',
                borderRadius: Math.max(radius, 12),
                background: 'rgba(255,255,255,.06)',
                boxShadow: '0 10px 30px rgba(0,0,0,.35)',
              }}
            />
          )}

          <div className="min-w-0 flex-1">
            <div className="text-3xl font-bold uppercase leading-tight tracking-wide md:text-4xl">
              {o.owner_name}
            </div>
            {o.owner_positioning && (
              <p className="mt-3 text-lg font-bold leading-snug" style={{ color: iconColor }}>
                {o.owner_positioning}
              </p>
            )}
            {!!bio.length && (
              <ul className="mt-6 list-none space-y-3 p-0 text-left">
                {bio.map((x, i) => (
                  <li key={i} className="flex gap-3 font-semibold leading-relaxed">
                    <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: iconColor }} />
                    <span>{x}</span>
                  </li>
                ))}
              </ul>
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
          className={carousel ? 'w-[min(288px,80vw)] shrink-0 snap-start sm:w-96' : ''}
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

/** Бейдж «осталось мест» — цифра металликом из цвета иконок темы. */
function SeatsBadge({
  seats, iconColor, radius,
}: {
  seats: any
  iconColor: string
  radius: number
}) {
  const metalText: React.CSSProperties = {
    background: metallic(iconColor),
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
  }
  return (
    <div className="inline-flex flex-col items-center gap-1 px-6 py-3"
         style={{ border: `2px solid ${iconColor}`, borderRadius: Math.max(radius, 8),
                  background: 'rgba(255,255,255,.05)' }}>
      <span className="text-[13px] font-semibold uppercase tracking-widest opacity-90">
        {seats.left != null ? 'Осталось мест:' : 'Уже с нами:'}
      </span>
      <span className="text-4xl font-bold leading-none" style={metalText}>
        {seats.left != null ? `${seats.left}/${seats.total}` : (seats.taken || 0)}
      </span>
    </div>
  )
}

/**
 * Секция спикеров. Регалии разворачиваются СРАЗУ У ВСЕХ карточек одной
 * кнопкой: если раскрывать по одной, ряд растягивается по самой высокой
 * карточке, а соседние выглядят пустыми коробками.
 */
function SpeakersBlock({ list, block, page, cardStyle, iconColor, btnStyle }: any) {
  const [open, setOpen] = useState(false)
  if (!list.length) return null

  const cols = Math.max(1, Math.min(6, block.columns || 3))
  const hasAch = list.some((s: any) => Array.isArray(s.achievements) && s.achievements.length)

  return (
    <div>
      <div className="lp-grid grid gap-5" style={{ ['--lp-cols-lg' as any]: cols }}>
        {list.map((s: any) => (
          <SpeakerCard key={s.id} s={s} page={page}
                       cardStyle={cardStyle} iconColor={iconColor} open={open} />
        ))}
      </div>

      {hasAch && (
        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="inline-flex items-center gap-2 px-7 py-3 text-sm font-bold uppercase"
            style={btnStyle}
          >
            {open ? 'Свернуть' : 'Подробнее о спикерах'}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                 strokeLinejoin="round" aria-hidden="true"
                 style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Карточка спикера: фото, имя, должность и тема видны всегда. Регалии
 * показываются, когда раскрыта вся секция (проп `open`) — своего состояния
 * у карточки нет специально, чтобы ряд не «прыгал».
 */
function SpeakerCard({
  s, page, cardStyle, iconColor, open,
}: any) {
  const ach: string[] = Array.isArray(s.achievements)
    ? s.achievements
        .map((a: any) => typeof a === 'string' ? a : (a?.label || ''))
        // Часть регалий заведена с дефисом в начале — маркер свой.
        .map((a: string) => a.replace(/^[-–—•\s]+/, '').trim())
        .filter(Boolean)
    : []

  return (
    <div className="flex flex-col overflow-hidden" style={cardStyle}>
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
               style={{ borderLeft: `1px solid ${iconColor}` }}>
            {s.topic}
          </div>
        )}

        {open && !!ach.length && (
          <ul className="mt-1 list-disc pl-5 text-sm leading-relaxed opacity-80">
            {ach.map((a, i) => <li key={i} className="mb-1">{a}</li>)}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * Программа: дни — кнопками-табами, слоты — карточками.
 * Вынесена в отдельный компонент, потому что нужен свой стейт (активный день),
 * а хук нельзя объявлять внутри switch в BlockBody.
 */
function ProgramBlock({
  program, page, cardStyle, iconColor, radius, btnStyle,
}: any) {
  const p = program || { days: [], sessions: [] }
  const days = useMemo(
    () => [...(p.days || [])]
      .filter((d: any) => (p.sessions || []).some((s: any) => s.day === d.day_number))
      .sort((a: any, b: any) => a.day_number - b.day_number),
    [p],
  )
  const [active, setActive] = useState<number | null>(null)
  const current = active ?? days[0]?.day_number ?? null

  if (!days.length) return null

  const sessions = (p.sessions || [])
    .filter((s: any) => s.day === current)
    .sort((a: any, b: any) => String(a.start_time || '').localeCompare(String(b.start_time || '')))

  return (
    <div>
      {/* Дни — крупные кнопки. Активный выделен цветом кнопки темы. */}
      {days.length > 1 && (
        <div className="mb-7 flex flex-wrap justify-center gap-3">
          {days.map((d: any) => {
            const on = d.day_number === current
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => setActive(d.day_number)}
                className="px-8 py-4 text-lg font-bold leading-tight transition-transform hover:scale-[1.02] sm:text-xl"
                style={on
                  ? { ...btnStyle, borderRadius: 40 }
                  : {
                      borderRadius: 40,
                      background: 'rgba(255,255,255,.08)',
                      color: 'inherit',
                      fontFamily: btnStyle.fontFamily,
                    }}
              >
                {d.title || `День ${d.day_number}`}
                {d.day_date && (
                  <small className="mt-1 block text-xs font-medium opacity-80">
                    {formatDay(d.day_date)}
                  </small>
                )}
              </button>
            )
          })}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {sessions.map((s: any) => (
          <div key={s.id} className="flex flex-wrap items-start gap-4 p-4 sm:flex-nowrap"
               style={cardStyle}>
            {s.start_time && (
              // Полоска тонкая (1px), время отбито от неё отступом — иначе
              // цифры липнут к линии.
              // Линия отбита от цифр отступом с ОБЕИХ сторон — вплотную
              // к тексту она смотрится грязно.
              <div className="shrink-0 pl-5 text-sm font-bold leading-snug sm:ml-1 sm:w-[130px] sm:border-l-0 sm:border-r sm:pl-0 sm:pr-6"
                   style={{ borderLeft: `1px solid ${iconColor}66`, borderRightColor: `${iconColor}66` }}>
                {s.start_time}{s.end_time ? `–${s.end_time}` : ''}
                <span className="mt-0.5 block text-[11px] font-normal opacity-60">МСК</span>
              </div>
            )}

            {s.speaker_photo_url && (
              <img
                src={s.speaker_photo_url}
                alt={s.speaker_name || ''}
                loading="lazy"
                className="h-14 w-14 shrink-0 rounded-full object-cover sm:h-16 sm:w-16"
                style={{ background: 'rgba(255,255,255,.06)' }}
              />
            )}

            <div className="min-w-0 flex-1 basis-full sm:basis-auto">
              <div className="font-bold leading-snug">{s.title}</div>
              {s.speaker_name && (
                <div className="mt-1 text-sm font-semibold" style={{ color: iconColor }}>
                  {s.speaker_name}
                </div>
              )}
              {s.speaker_position && (
                <div className="mt-0.5 text-[13px] leading-snug opacity-70">
                  {s.speaker_position}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Иконка подарка с металлической заливкой из цвета иконок темы.
 * `id` уникален на страницу — иначе градиенты SVG перетрут друг друга.
 */
function GiftIcon({ color, id }: { color: string; id: string }) {
  const gid = `lp-gift-${id}`
  return (
    <svg viewBox="0 0 64 64" width={38} height={38} aria-hidden="true"
         className="shrink-0" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0%" stopColor={shade(color, -45)} />
          <stop offset="30%" stopColor={color} />
          <stop offset="50%" stopColor={shade(color, 30)} />
          <stop offset="70%" stopColor={color} />
          <stop offset="100%" stopColor={shade(color, -45)} />
        </linearGradient>
      </defs>
      <rect x="6" y="26" width="52" height="32" rx="3" fill={`url(#${gid})`} />
      <rect x="4" y="17" width="56" height="12" rx="3" fill={`url(#${gid})`} />
      <rect x="27" y="17" width="10" height="41" fill="#25455D" opacity=".28" />
      <path d="M32 17C32 17 25 4 17 7c-6 2-4 10 3 10h12z" fill={`url(#${gid})`} />
      <path d="M32 17C32 17 39 4 47 7c6 2 4 10-3 10H32z" fill={`url(#${gid})`} />
    </svg>
  )
}

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
