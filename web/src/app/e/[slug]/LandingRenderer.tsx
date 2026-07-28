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
import { useEffect, useMemo, useRef, useState } from 'react'
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

/**
 * Заливка кнопки — металл посветлее, чем у заголовков: тёмные края лишь
 * слегка притемнены, а блик в середине шире. Тёмный металл на кнопке
 * «съедает» текст и выглядит грязно.
 */
function metallicButton(color: string): string {
  const edge = shade(color, -12)   // мягкая граница, без черноты
  const light = shade(color, 55)   // широкий светлый блик
  return `linear-gradient(180deg, ${edge}, ${color} 22%, ${light} 50%, ${color} 78%, ${edge})`
}

/** HEX + прозрачность → rgba(). Мусорный цвет не роняет страницу. */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return `rgba(15,30,46,${alpha})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/**
 * Оттенок HEX: минус — темнее (умножение), плюс — светлее (к белому).
 * Осветление именно «к белому», иначе светлый персик упирается в потолок 255
 * и блик не виден.
 */
function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  // Мусор в поле цвета (недописанный HEX) не должен ронять страницу.
  if (!m) return '#000000'
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

  // Заливка кнопки: свой градиент из двух цветов → металлик → сплошной цвет.
  // Для padding-box слой должен быть именно фоном-картинкой: сплошной цвет
  // оборачиваем в градиент, готовый градиент берём как есть.
  const asLayer = (v: string) =>
    v.startsWith('linear-gradient') ? v : `linear-gradient(${v}, ${v})`

  const btnFill = page.btn_color_2
    ? `linear-gradient(${page.btn_angle ?? 180}deg, ${page.btn_color || '#FFCFA4'}, ${page.btn_color_2})`
    : page.btn_metallic
      ? metallicButton(page.btn_color || '#FFCFA4')
      : (page.btn_color || '#FFCFA4')

  const btnStyle: React.CSSProperties = {
    color: page.btn_text_color || '#0a1520',
    // Скругление кнопок задаётся отдельно от карточек.
    borderRadius: page.btn_radius ?? radius,
    fontFamily: page.font_body_css,
    letterSpacing: '.04em',
    // Внутренний блик сверху + мягкая тень — объём, как у боевой кнопки.
    boxShadow: page.btn_metallic || page.btn_color_2
      ? 'inset 0 1px 0 rgba(255,255,255,.45), 0 6px 18px rgba(0,0,0,.35)'
      : undefined,
    // Рамка вокруг кнопки. Градиентная рамка делается двумя фонами:
    // заливка в padding-box, рамка — в border-box. Обычным border градиент
    // не задать, поэтому цвет границы ставим прозрачным.
    ...(page.btn_border_width
      ? {
          border: `${page.btn_border_width}px solid transparent`,
          background: page.btn_border_metallic
            ? `${asLayer(btnFill)} padding-box, ${metallic(page.btn_border_color || '#FFCFA4')} border-box`
            : `${asLayer(btnFill)} padding-box, linear-gradient(${page.btn_border_color || '#FFCFA4'}, ${page.btn_border_color || '#FFCFA4'}) border-box`,
        }
      : { background: btnFill }),
  }

  // Заливка карточки — свой цвет с прозрачностью из темы.
  // ⚠️ Металл и градиенты только В РАМКЕ: заливать карточку ярким градиентом
  // нельзя, текст поверх становится нечитаемым.
  const cardFill = hexToRgba(page.card_bg || '#0F1E2E', (page.card_bg_opacity ?? 55) / 100)
  const brd = page.border_color || '#FFCFA4'

  const cardStyle: React.CSSProperties = page.border_style === 'fade'
    // «Растворяющаяся» рамка: яркая по углам, к середине сторон уходит в ноль.
    // Делается двумя слоями фона — заливка в padding-box, рамка в border-box.
    ? {
        borderRadius: radius,
        border: '1px solid transparent',
        background:
          `linear-gradient(${cardFill}, ${cardFill}) padding-box, ` +
          `conic-gradient(from 45deg at 50% 50%, ${brd}, transparent 25%, ${brd} 50%, transparent 75%, ${brd}) border-box`,
      }
    : {
        borderRadius: radius,
        border: `1px solid ${brd}`,
        background: cardFill,
      }

  const iconColor = page.icon_color || '#FFCFA4'

  // Режим градиента:
  //   page   — растянут на всю страницу (на длинном лендинге переход не виден);
  //   screen — повторяется на каждом экране (по умолчанию — читается везде);
  //   block  — свой градиент у каждой секции.
  const bgMode = page.bg_mode || 'screen'
  // ⚠️ Фон — ОДИН градиент на всю высоту страницы, без повторов и без
  // background-attachment: fixed. Оба приёма давали видимую горизонтальную
  // границу: повтор — на стыке плиток, fixed — на краю окна (фон стоит,
  // а секции едут поверх). Режим «на каждом экране» отличается только тем,
  // что градиент зеркальный — переход читается на любом участке страницы.
  const rootBg: React.CSSProperties = page.bg_image_url
    ? {}
    : bgMode === 'block'
      // Фон рисует каждая секция; здесь только базовый цвет под ними.
      ? { background: page.bg_color || '#25455D' }
      : bgMode === 'screen'
        ? { background: page.bg_css_screen || page.bg_css }
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
        /* ⚠️ min() везде: если клиент выбрал 1 или 2 колонки, промежуточные
           брейкпоинты не должны навязывать больше — настройка всегда потолок. */
        .lp-grid { grid-template-columns: 1fr; }
        @media (min-width: 560px)  { .lp-grid { grid-template-columns: repeat(min(2, var(--lp-cols-lg, 3)), 1fr); } }
        @media (min-width: 900px)  { .lp-grid { grid-template-columns: repeat(min(3, var(--lp-cols-lg, 3)), 1fr); } }
        @media (min-width: 1160px) { .lp-grid { grid-template-columns: repeat(var(--lp-cols-lg, 3), 1fr); } }
        /* Бегущая подсветка: в каждый момент выделена РОВНО ОДНА карточка —
           золотистая полупрозрачная заливка + свечение. Предыдущая гаснет
           до того, как загорится следующая, поэтому «огонёк» бежит по списку.
           Длительность цикла задаётся переменной --lp-cycle (число карточек). */
        @keyframes lp-glow {
          0%, 100% { background-color: transparent; box-shadow: none; border-color: var(--lp-brd); }
          4%  { background-color: var(--lp-glow-soft);
                box-shadow: 0 0 26px 2px var(--lp-glow-dim); border-color: var(--lp-glow); }
          14% { background-color: var(--lp-glow-soft);
                box-shadow: 0 0 26px 2px var(--lp-glow-dim); border-color: var(--lp-glow); }
          20%, 99% { background-color: transparent; box-shadow: none; border-color: var(--lp-brd); }
        }
        .lp-glow > * { animation: lp-glow var(--lp-cycle, 10s) ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .lp-glow > * { animation: none; } }
        .lp-root { overflow-x: hidden; }
        .lp-root img { max-width: 100%; }
        .lp-root h1, .lp-root h2, .lp-root h3 { overflow-wrap: anywhere; }
      `}</style>

      {/* Липкая шапка: логотип + якоря на секции + кнопка регистрации. */}
      {page.nav_enabled && (
        <LandingNav page={page} blocks={blocks} content={content}
                    btnStyle={btnStyle} slug={slug} />
      )}

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

/**
 * Липкая шапка лендинга: логотип бренда слева, пункты меню и кнопка справа.
 *
 * Пункты — якоря на секции ЭТОЙ же страницы: у каждой секции автоматически
 * есть id вида `lp-<тип блока>` (см. Section), поэтому расставлять якоря
 * руками не нужно — клиент выбирает секцию из списка.
 */
function LandingNav({ page, blocks, content, btnStyle, slug }: any) {
  const [open, setOpen] = useState(false)
  const items: Array<{ label: string; block_kind: string }> =
    Array.isArray(page.nav_items) ? page.nav_items : []
  // Показываем только пункты, чья секция реально есть и включена.
  const present = new Set(blocks.map((b: any) => b.kind))
  const links = items.filter(i => present.has(i.block_kind))
  // 'register' → форма регистрации; иначе — якорь на секцию страницы.
  const navTarget = (!page.nav_button_target || page.nav_button_target === 'register')
    ? `/event/${slug}/register`
    : `#lp-${page.nav_button_target}`
  const logo = content?.brand?.logo_url

  return (
    <header
      className="sticky top-0 z-40 border-b backdrop-blur"
      style={{
        borderColor: `${page.border_color || '#FFCFA4'}33`,
        background: 'rgba(10,21,32,.72)',
      }}
    >
      <div className="mx-auto flex items-center gap-4 px-4 py-3 sm:px-6"
           style={{ maxWidth: page.content_width || 1120 }}>
        <a href="#top" className="shrink-0">
          {logo
            ? <img src={logo} alt="" className="h-9 w-auto object-contain" />
            : <span className="font-bold uppercase tracking-wide"
                    style={{ color: page.color_heading || '#FFCFA4' }}>
                {content?.brand?.name || ''}
              </span>}
        </a>

        {/* Пункты меню: на широком экране в строку, на телефоне — в раскрывашке */}
        <nav className="ml-auto hidden items-center gap-6 md:flex">
          {links.map(i => (
            <a key={i.block_kind} href={`#lp-${i.block_kind}`}
               className="text-[.9em] font-medium uppercase tracking-wide opacity-85 hover:opacity-100">
              {i.label}
            </a>
          ))}
        </nav>

        {page.nav_button_label && (
          // Цель кнопки: регистрация или якорь на секцию (например, тарифы).
          <a href={navTarget}
             className="ml-auto hidden shrink-0 px-5 py-2.5 text-[.85em] font-bold uppercase md:ml-0 md:inline-block"
             style={btnStyle}>
            {page.nav_button_label}
          </a>
        )}

        {!!links.length && (
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-label="Меню"
            className="ml-auto md:hidden"
            style={{ color: page.color_heading || '#FFCFA4' }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-1 border-t px-4 pb-4 pt-2 md:hidden"
             style={{ borderColor: `${page.border_color || '#FFCFA4'}22` }}>
          {links.map(i => (
            <a key={i.block_kind} href={`#lp-${i.block_kind}`}
               onClick={() => setOpen(false)}
               className="py-2 text-[.95em] font-medium uppercase tracking-wide opacity-90">
              {i.label}
            </a>
          ))}
          {page.nav_button_label && (
            <a href={navTarget} onClick={() => setOpen(false)}
               className="mt-2 px-5 py-3 text-center text-[.9em] font-bold uppercase"
               style={btnStyle}>
              {page.nav_button_label}
            </a>
          )}
        </div>
      )}
    </header>
  )
}

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

  // Свечение карточек: класс на контейнер сетки + переменные цвета.
  // Задержку каждой карточке проставляем инлайном (--i), чтобы огонёк бежал.
  const glowCls = block.cards_glow ? 'lp-glow' : ''
  // Длительность цикла = 2.2с на карточку: подсветка успевает загореться и
  // погаснуть до перехода к следующей.
  const glowCount = Array.isArray(block.items) ? Math.max(1, block.items.length) : 4
  const glowVars: React.CSSProperties = block.cards_glow
    ? ({
        ['--lp-cycle' as any]: `${(glowCount * 2.2).toFixed(1)}s`,
        ['--lp-count' as any]: String(glowCount),
        ['--lp-glow' as any]: page.icon_color || '#FFCFA4',
        // Полупрозрачная заливка тем же акцентом — «подсвеченная» карточка.
        ['--lp-glow-soft' as any]: hexToRgba(page.icon_color || '#FFCFA4', 0.14),
        ['--lp-glow-dim' as any]: hexToRgba(page.icon_color || '#FFCFA4', 0.45),
        ['--lp-brd' as any]: page.border_color || '#FFCFA4',
      } as React.CSSProperties)
    : {}

  /* Содержимое блока — своё для каждого типа. */
  const blockBody = <BlockBody
    block={block} page={page} radius={radius} btnStyle={btnStyle}
    cardStyle={cards} iconColor={iconColor} headingStyle={ownHeading}
    glowCls={glowCls} glowVars={glowVars}
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

  const align = block.title_align || 'left'

  // Кнопка секции: доступна у ЛЮБОГО блока, текст и ссылка — из настроек.
  // hero и speakers рисуют свою кнопку внутри (регистрация / разворот регалий).
  const ownButton = block.button_label && !['hero', 'speakers'].includes(block.kind) ? (
    <div className={`mt-8 ${align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : ''}`}>
      <a
        href={block.button_url || `/event/${slug}/register`}
        {...(block.button_url ? { target: '_blank', rel: 'noreferrer' } : {})}
        className="inline-block px-8 py-4 font-bold uppercase"
        style={btnStyle}
      >
        {block.button_label}
      </a>
    </div>
  ) : null

  // Размер содержимого секции: списки, карточки, подарки, тарифы. Не задан —
  // берётся размер основного текста страницы.
  const textSizeStyle: React.CSSProperties = block.text_size
    ? { fontSize: `${block.text_size}px` }
    : {}

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
    <p className="mt-3 opacity-80"
       style={{
         textAlign: (block.title_align || 'left') as any,
         fontSize: block.subtitle_size ? `${block.subtitle_size}px` : undefined,
       }}>
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
      id={`lp-${block.kind}`}
      className="relative scroll-mt-20"
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
            // ⚠️ Заголовок сбоку центрируем ПО ВЕРТИКАЛИ: прижатый к верху, он
            // «висит» напротив пустоты, когда содержимое длинное.
            // По горизонтали — как задано настройкой title_align.
            className="lp-cols grid items-center gap-8 md:gap-12"
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
              {body && <p className="mb-6 whitespace-pre-wrap opacity-90"
                          style={textSizeStyle}>{body}</p>}
              <div style={textSizeStyle}>{inner}</div>
              {ownButton}
            </div>
          </div>
        ) : (
          <>
            {heading}
            {subtitle}
            {body && <p className="mt-4 whitespace-pre-wrap opacity-90"
                        style={textSizeStyle}>{body}</p>}
            <div className="mt-8" style={textSizeStyle}>{inner}</div>
            {ownButton}
          </>
        )}
      </div>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────────────────── */

function BlockBody({
  block, page, radius, btnStyle, cardStyle, iconColor, headingStyle, event, content, slug,
  glowCls = '', glowVars = {},
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
          {/* Дата: включается галочкой, ставится над заголовком или под
              подзаголовком. Цвет — основного текста страницы, не акцент. */}
          {!isThanks && event.start_at && block.show_date !== false
            && (block.date_position || 'above') === 'above' && (
            <p className="mb-4 opacity-85" style={{ color: page.color_body || '#FFFFFF' }}>
              {formatDate(event.start_at, event.end_at, event.dates_from_program)}
            </p>
          )}
          {/* Размер задаётся в блоке «Шапка» (title_size). Дефолт крупнее,
              чем у обычных секций; clamp — чтобы не вылезал на телефоне. */}
          <h1
            className="font-bold uppercase"
            style={{
              ...headingStyle,
              fontSize: `clamp(${Math.round((block.title_size || 72) * 0.45)}px, ${((block.title_size || 72) / 11).toFixed(1)}vw, ${block.title_size || 72}px)`,
            }}
          >
            {isThanks ? page.post_pay_title : event.title}
          </h1>

          {isThanks ? (
            <>
              {page.post_pay_text && (
                <p className="mx-auto mt-5 max-w-2xl whitespace-pre-wrap opacity-90"
                   style={{ fontSize: block.subtitle_size ? `${block.subtitle_size}px` : '1.25em' }}>
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
                <p className="mx-auto mt-5 max-w-3xl opacity-90"
                   style={{ fontSize: block.subtitle_size ? `${block.subtitle_size}px` : '1.25em' }}>
                  {event.description}
                </p>
              )}
              {event.start_at && block.show_date !== false
                && block.date_position === 'below' && (
                <p className="mt-4 opacity-85" style={{ color: page.color_body || '#FFFFFF' }}>
                  {formatDate(event.start_at, event.end_at, event.dates_from_program)}
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
                {/* Подпись кнопки — только из настроек блока. Значений по
                    умолчанию в коде нет: не задана — кнопки не будет. */}
                {block.button_label && (
                  <a
                    href={`/event/${slug}/register`}
                    className="inline-block px-8 py-4 text-[1em] font-bold uppercase tracking-wide transition-transform hover:scale-105"
                    style={btnStyle}
                  >
                    {block.button_label}
                  </a>
                )}
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
      // Формат карточки: {title, text, image}. Старый формат (просто строки)
      // поддержан — у кого блок уже заполнен, ничего не сломается.
      const raw = Array.isArray(items) ? items : []
      const list = raw
        .map((i: any) => typeof i === 'string' ? { title: i } : i)
        .filter((i: any) => i && (i.title || i.text || i.image))
      if (!list.length) return null
      const cols = Math.max(1, Math.min(6, block.columns || 2))
      return (
        <div className={`lp-grid grid gap-5 ${glowCls}`}
             style={{ ['--lp-cols-lg' as any]: cols, ...glowVars }}>
          {list.map((c: any, i: number) => (
            <div key={i} className="flex flex-col overflow-hidden"
                 style={{ ...cardStyle, animationDelay: `calc(var(--lp-cycle, 10s) / var(--lp-count, 5) * ${i})` }}>
              {c.image && (
                // Форма фото: скругление по ширине/высоте в % даёт круг,
                // овал или квадрат; пропорция — чтобы фото не обрезалось
                // случайной рамкой.
                <div className="p-4 pb-0">
                  <img src={c.image} alt="" loading="lazy"
                       className="mx-auto block w-full object-cover"
                       style={{
                         aspectRatio: String(block.card_img_ratio || 1.6),
                         borderRadius: `${block.card_img_radius_x || 0}% / ${block.card_img_radius_y || 0}%`,
                         background: 'rgba(255,255,255,.06)',
                       }} />
                </div>
              )}
              <div className="flex flex-1 flex-col gap-2 p-5">
                <div className="flex items-start gap-3">
                  <svg viewBox="0 0 24 24" className="mt-1 shrink-0"
                       width={Math.round((block.icon_size || 88) * 0.24)}
                       height={Math.round((block.icon_size || 88) * 0.24)}
                       fill="none" stroke={iconColor} strokeWidth="3"
                       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  <span className="font-bold uppercase leading-snug"
                        style={{ color: page.color_heading || '#FFCFA4' }}>
                    {c.title}
                  </span>
                </div>
                {c.text && (
                  <p className="text-[.9em] leading-relaxed opacity-85">{c.text}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )
    }

    /* ── Список пунктов ────────────────────────────────────────────────── */
    case 'benefits': {
      const list: string[] = Array.isArray(items) ? items.filter((i: any) => typeof i === 'string' && i) : []
      return (
        <div className={`space-y-3 ${glowCls}`} style={glowVars}>
          {list.map((t, i) => (
            <div key={i} className="flex items-start gap-4 p-4"
                 style={{ ...cardStyle, animationDelay: `calc(var(--lp-cycle, 10s) / var(--lp-count, 5) * ${i})` }}>
              <span
                className="shrink-0 text-[1.6em] font-bold tabular-nums"
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
        <div className={`lp-grid grid gap-6 ${glowCls}`}
             style={{ ['--lp-cols-lg' as any]: Math.max(1, Math.min(6, block.columns || 3)), ...glowVars }}>
          {list.map((c: any, i: number) => (
            <div key={i}
                 className="flex flex-col items-center px-6 pb-7 pt-8 text-center"
                 style={{ ...cardStyle, animationDelay: `calc(var(--lp-cycle, 10s) / var(--lp-count, 5) * ${i})` }}>
              {c.icon && (
                <div className="mb-5">
                  <CardIcon
                    iconKey={c.icon}
                    color={iconColor}
                    metallic={!!page.icon_metallic}
                    size={block.icon_size || 88}
                    id={`${block.id}-${i}`}
                  />
                </div>
              )}
              <h3 className="text-[1.05em] font-bold uppercase tracking-wider"
                  style={{ color: page.color_heading || '#FFCFA4' }}>
                {c.title}
              </h3>
              {c.text && (
                <p className="mt-3 text-[.9em] leading-relaxed opacity-90">{c.text}</p>
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
      // ⚠️ Число колонок — это НАСТРОЙКА, а не «сколько влезло»: auto-fit
      // игнорировал её на широком экране. На узких экранах колонок всегда
      // меньше (см. .lp-grid), но потолок задаёт клиент.
      return (
        <div className="lp-grid grid gap-x-6 gap-y-10"
             style={{ ['--lp-cols-lg' as any]: Math.max(1, Math.min(6, block.columns || 4)) }}>
          {list.map((n: any, i: number) => (
            <div key={i} className="p-5 text-center" style={cardStyle}>
              <div className="text-[2.6em] font-bold leading-none sm:text-[3.2em]"
                   style={metalNum}>
                <CountUp value={n.value} />
              </div>
              {block.show_divider && (
                <div className="mx-auto mt-3 h-px w-10"
                     style={{ background: page.color_body || '#FFFFFF', opacity: .6 }} />
              )}
              <div className="mt-3 text-[.9em] opacity-85">{n.label}</div>
            </div>
          ))}
        </div>
      )
    }

    /* ── Спикеры ───────────────────────────────────────────────────────── */
    // Раскладка проверена на боевом лендинге (GetCourse): квадратное фото,
    // имя капсом, должность, тема с акцентной полосой слева, регалии списком.
    case 'partners':
      return <PartnersBlock
        list={content.partners || []} block={block} page={page}
        cardStyle={cardStyle} iconColor={iconColor}
      />

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
          {/* ⚠️ У тарифов бегущая подсветка не нужна: выделен ОДИН тариф,
              отмеченный галочкой «Выделить на лендинге». */}
          <div className="lp-grid grid gap-5"
               style={{ ['--lp-cols-lg' as any]: Math.max(1, Math.min(6, block.columns || 3)) }}>
            {(t.items || []).map((x: any, i: number) => (
              // Выделенный тариф (галочка «рекомендуемый» в разделе Тарифы) —
              // подсвеченная рамка и мягкое свечение, чтобы взгляд цеплялся.
              <div key={x.id} className="relative flex flex-col p-6"
                   style={{
                     ...cardStyle,
                     animationDelay: `calc(var(--lp-cycle, 10s) / var(--lp-count, 5) * ${i})`,
                     ...(x.is_featured ? {
                       borderColor: iconColor,
                       borderWidth: 2,
                       boxShadow: `0 0 24px -2px ${iconColor}80`,
                     } : {}),
                   }}>
                <div className="text-[1.3em] font-bold uppercase" style={{ color: page.color_heading }}>
                  {x.title}
                </div>
                {x.price != null && (
                  <div className="mt-2 text-[2em] font-bold"
                       style={page.price_color
                         ? { fontFamily: page.font_heading_css, color: page.price_color }
                         : headingStyle}>
                    {Number(x.price).toLocaleString('ru-RU')} ₽
                  </div>
                )}
                {x.description && (
                  // Строка, начинающаяся с «-», означает «в тариф НЕ входит»:
                  // такие показываем крестиком и зачёркнутыми, остальные —
                  // галочкой. Клиенту достаточно поставить минус в описании.
                  <ul className="mt-4 flex-1 list-none space-y-2.5 p-0 text-[.9em] leading-relaxed">
                    {String(x.description).split('\n').map((r: string) => r.trim()).filter(Boolean)
                      .map((row: string, k: number) => {
                        const excluded = /^[-–—]\s*/.test(row)
                        const text = row.replace(/^[-–—]\s*/, '')
                        return (
                          <li key={k} className="flex gap-2.5">
                            <svg viewBox="0 0 24 24" className="mt-[.35em] h-4 w-4 shrink-0"
                                 fill="none" stroke={excluded ? 'currentColor' : iconColor}
                                 strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                                 style={excluded ? { opacity: .45 } : undefined} aria-hidden="true">
                              {excluded ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M20 6 9 17l-5-5" />}
                            </svg>
                            <span className={excluded ? 'line-through opacity-50' : 'opacity-90'}>
                              {text}
                            </span>
                          </li>
                        )
                      })}
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
            <p className="mt-4 text-center text-[.9em] opacity-70">
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
                <span className="font-bold">{g.title}</span>
                {g.description && (
                  <span className="opacity-85"> — {g.description}</span>
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
            <div className="text-[1.9em] font-bold uppercase leading-tight tracking-wide md:text-[2.4em]">
              {o.owner_name}
            </div>
            {o.owner_positioning && (
              <p className="mt-3 text-[1.15em] font-bold leading-snug" style={{ color: iconColor }}>
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
      // Источник: свои картинки в блоке либо общая база отзывов по тегам.
      const fromBase = block.gallery_source === 'testimonials'
        ? (content.testimonials?.[String(block.id)] || [])
        : null
      const list = fromBase
        ? fromBase.map((t: any) => ({ url: t.url, caption: t.caption || t.title, kind: t.kind }))
        : (Array.isArray(g.list) ? g.list.filter((x: any) => x?.url) : [])
      if (!list.length) return null
      // При выборе из базы тип берём у самого отзыва (фото/видео).
      const isVideo = fromBase ? undefined : g.media === 'video'
      const carousel = (g.mode || 'carousel') === 'carousel'

      const cards = list.map((x: any, i: number) => (
        <figure
          key={i}
          className={carousel ? 'w-[min(288px,80vw)] shrink-0 snap-start sm:w-96' : ''}
          style={cardStyle}
        >
          {(isVideo ?? x.kind === 'video') ? (
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
            <figcaption className="p-3 text-[.9em] opacity-80">{x.caption}</figcaption>
          )}
        </figure>
      ))

      return carousel ? (
        <div className="lp-scroll flex snap-x snap-mandatory gap-4 overflow-x-auto pb-3">
          {cards}
        </div>
      ) : (
        <div className="lp-grid grid gap-4"
             style={{ ['--lp-cols-lg' as any]: Math.max(1, Math.min(6, block.columns || 3)) }}>{cards}</div>
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
      // Состав подвала: только ИП с ФИО и ИНН + документы. Адрес, ОГРНИП,
      // email и телефон в подвал лендинга не выносим — они есть в оферте
      // и в политике, дублировать их на продающей странице незачем.
      const legal = [f.legal_name, f.legal_inn && `${f.legal_inn_label} ${f.legal_inn}`]
        .filter(Boolean)
      return (
        <div className="space-y-3 text-[.9em] opacity-75">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {f.privacy_url && (
              <a href={f.privacy_url} className="lp-link">Политика конфиденциальности</a>
            )}
            {f.offer_url && (
              <a href={f.offer_url} target="_blank" rel="noreferrer" className="lp-link">Оферта</a>
            )}
          </div>
          {!!legal.length && <div>{legal.join(' · ')}</div>}
          <div className="opacity-60">
            © {new Date().getFullYear()} {f.brand_name}
          </div>
        </div>
      )
    }

    /* ── Отдельные элементы: заголовок, текст, кнопка, картинка ────────── */
    // Заголовок/текст/кнопку рисует сама секция (heading, body, ownButton),
    // картинку — блок image_url. Здесь дополнительного содержимого нет.
    case 'el_heading':
    case 'el_text':
    case 'el_button':
    case 'el_image':
      return null

    /* ── Своя секция и всё остальное (values, mission, difference) ─────── */
    // Текст этих блоков уже выведен секцией выше — здесь только кнопка, если есть.
    // Текст этих блоков выводит сама секция, кнопку — тоже (ownButton).
    case 'text':
    default:
      return null
  }
}

/* ── Утилиты ────────────────────────────────────────────────────────────── */

/**
 * Бейдж «осталось мест»: цифра металликом из цвета иконок.
 * Подпись и её положение (сверху / слева / справа от рамки) задаются рядом
 * с числом мест — в настройках события, а не в двух разных местах.
 */
/**
 * Счётчик: число набегает от нуля, когда блок появился на экране.
 * Анимируется только числовая часть — «1100+» считается как 1100, знаки
 * остаются на месте. Нечисловое значение показывается как есть.
 */
function CountUp({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState<string>(String(value ?? ''))

  useEffect(() => {
    const m = /^(\D*)(\d[\d\s\u00a0]*)(.*)$/.exec(String(value ?? ''))
    const el = ref.current
    if (!m || !el) { setShown(String(value ?? '')); return }
    const pre = m[1], post = m[3]
    const target = parseInt(m[2].replace(/[^\d]/g, ''), 10)
    if (!Number.isFinite(target)) { setShown(String(value)); return }

    if (typeof IntersectionObserver === 'undefined'
        || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setShown(String(value)); return
    }

    setShown(`${pre}0${post}`)
    let raf = 0
    const io = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) return
      io.disconnect()
      const t0 = performance.now()
      const tick = (t: number) => {
        const k = Math.min(1, (t - t0) / 1400)
        // Плавное замедление к концу — цифра «доезжает», а не обрывается.
        const cur = Math.round(target * (1 - Math.pow(1 - k, 3)))
        setShown(`${pre}${cur.toLocaleString('ru-RU')}${post}`)
        if (k < 1) raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }, { threshold: 0.4 })
    io.observe(el)
    return () => { io.disconnect(); cancelAnimationFrame(raf) }
  }, [value])

  return <span ref={ref}>{shown}</span>
}

function SeatsBadge({ seats, iconColor, radius }: any) {
  const metalText: React.CSSProperties = {
    background: metallic(iconColor),
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
  }
  const pos = seats.label_position || 'top'
  const label = seats.label
    ? <span className="font-semibold uppercase tracking-widest"
            style={{
              // Подпись — тем же акцентным цветом, что и цифра (цвет иконок темы).
              color: iconColor,
              fontSize: seats.size ? `${Math.round(seats.size * 0.34)}px` : '.9em',
            }}>
        {seats.label}
      </span>
    : null

  const box = (
    <span className="inline-flex items-center justify-center px-6 py-3"
          style={{ border: `2px solid ${iconColor}`, borderRadius: Math.max(radius, 8),
                   background: 'rgba(255,255,255,.05)' }}>
      <span className="font-bold leading-none"
            style={{ ...metalText, fontSize: seats.size ? `${seats.size}px` : '2.6em' }}>
        {seats.left != null ? `${seats.left}/${seats.total}` : (seats.taken || 0)}
      </span>
    </span>
  )

  if (!label) return box
  return pos === 'top'
    ? <span className="inline-flex flex-col items-center gap-2">{label}{box}</span>
    : <span className="inline-flex items-center gap-3">
        {pos === 'left' ? <>{label}{box}</> : <>{box}{label}</>}
      </span>
}

/**
 * Секция спикеров. Регалии разворачиваются СРАЗУ У ВСЕХ карточек одной
 * кнопкой: если раскрывать по одной, ряд растягивается по самой высокой
 * карточке, а соседние выглядят пустыми коробками.
 */
function SpeakersBlock({ list, block, page, cardStyle, iconColor }: any) {
  // Раскрытие общее на ряд: стрелка есть у каждой карточки, но жмёшь любую —
  // разворачиваются все. Иначе ряд растягивается по самой высокой карточке,
  // а соседние выглядят пустыми коробками.
  const [open, setOpen] = useState(false)
  if (!list.length) return null

  const cols = Math.max(1, Math.min(6, block.columns || 3))
  const scroll = block.display_mode === 'scroll'

  const cards = list.map((s: any) => (
    <SpeakerCard key={s.id} s={s} page={page} cardStyle={cardStyle}
                 iconColor={iconColor} open={open}
                 onToggle={() => setOpen(o => !o)}
                 className={scroll ? 'w-[min(280px,75vw)] shrink-0 snap-start' : ''} />
  ))

  return scroll ? (
    <div className="lp-scroll flex snap-x snap-mandatory gap-5 overflow-x-auto pb-3">
      {cards}
    </div>
  ) : (
    <div className="lp-grid grid gap-5" style={{ ['--lp-cols-lg' as any]: cols }}>
      {cards}
    </div>
  )
}

/** Партнёры события — те же карточки, но роли general_partner/partner. */
function PartnersBlock({ list, block, page, cardStyle, iconColor }: any) {
  if (!list.length) return null
  const cols = Math.max(1, Math.min(6, block.columns || 4))
  const scroll = block.display_mode === 'scroll'

  const cards = list.map((p: any) => {
    const inner = (
      <>
        {p.photo_url && (
          <img src={p.photo_url} alt={p.name} loading="lazy"
               className="block w-full object-cover"
               style={{ aspectRatio: '1 / 1', background: 'rgba(255,255,255,.06)' }} />
        )}
        <div className="p-4 text-center">
          <div className="font-bold uppercase leading-tight"
               style={{ color: page.color_heading || '#FFCFA4' }}>
            {p.name}
          </div>
          {p.title && (
            <div className="mt-1 text-[.85em] leading-snug opacity-80">{p.title}</div>
          )}
        </div>
      </>
    )
    const url = p.partner_url || p.website_url
    const cls = `flex flex-col overflow-hidden ${scroll ? 'w-[min(240px,70vw)] shrink-0 snap-start' : ''}`
    return url
      ? <a key={p.id} href={url} target="_blank" rel="noreferrer"
           className={`${cls} transition-transform hover:scale-[1.02]`} style={cardStyle}>{inner}</a>
      : <div key={p.id} className={cls} style={cardStyle}>{inner}</div>
  })

  return scroll ? (
    <div className="lp-scroll flex snap-x snap-mandatory gap-5 overflow-x-auto pb-3">
      {cards}
    </div>
  ) : (
    <div className="lp-grid grid gap-5" style={{ ['--lp-cols-lg' as any]: cols }}>
      {cards}
    </div>
  )
}

/**
 * Карточка спикера: фото, имя, должность и регалии тонким шрифтом.
 * Тему выступления не показываем — она есть в программе, в карточке это
 * дублирование. Стрелка есть у каждой карточки, но раскрывает весь ряд
 * (проп `open` общий на секцию) — иначе соседние карточки выглядят пустыми.
 */
function SpeakerCard({
  s, page, cardStyle, iconColor, open, onToggle, className = '',
}: any) {
  const ach: string[] = Array.isArray(s.achievements)
    ? s.achievements
        .map((a: any) => typeof a === 'string' ? a : (a?.label || ''))
        // Часть регалий заведена с дефисом в начале — маркер свой.
        .map((a: string) => a.replace(/^[-–—•\s]+/, '').trim())
        .filter(Boolean)
    : []
  // Свёрнутая карточка показывает первые две регалии, остальные — по стрелке.
  const visible = open ? ach : ach.slice(0, 2)

  return (
    <div className={`flex flex-col overflow-hidden ${className}`} style={cardStyle}>
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
        <div className="text-[1.15em] font-bold uppercase leading-tight tracking-wide"
             style={{ color: page.color_heading || '#FFCFA4' }}>
          {s.name}
        </div>
        {s.title && (
          <div className="text-[.9em] font-semibold leading-snug opacity-90">{s.title}</div>
        )}

        {!!visible.length && (
          <ul className="mt-1 list-none space-y-1.5 p-0 text-[.85em] font-light leading-relaxed opacity-80">
            {visible.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-[.55em] h-1 w-1 shrink-0 rounded-full"
                      style={{ background: iconColor }} />
                <span>{a}</span>
              </li>
            ))}
          </ul>
        )}

        {ach.length > 2 && (
          <button
            type="button"
            onClick={onToggle}
            aria-label={open ? 'Свернуть' : 'Показать все регалии'}
            className="mt-auto flex items-center justify-center pt-3"
            style={{ color: iconColor }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                 strokeLinejoin="round" aria-hidden="true"
                 style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
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
                className="px-8 py-4 text-[1.15em] font-bold leading-tight transition-transform hover:scale-[1.02] sm:text-[1.3em]"
                // ⚠️ Это переключатель дней, а не кнопка призыва: красим
                // акцентным цветом из настроек, без градиента, рамки и тени
                // фирменной кнопки.
                style={on
                  ? {
                      borderRadius: 40,
                      background: iconColor,
                      color: page.btn_text_color || '#0a1520',
                      fontFamily: btnStyle.fontFamily,
                    }
                  : {
                      borderRadius: 40,
                      background: hexToRgba(iconColor, 0.12),
                      color: 'inherit',
                      fontFamily: btnStyle.fontFamily,
                    }}
              >
                {d.title || `День ${d.day_number}`}
                {d.day_date && (
                  <small className="mt-1 block text-[.75em] font-medium opacity-80">
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
              <div className="shrink-0 pl-5 text-[.9em] font-bold leading-snug sm:ml-1 sm:w-[130px] sm:border-l-0 sm:border-r sm:pl-0 sm:pr-6"
                   style={{ borderLeft: `1px solid ${iconColor}66`, borderRightColor: `${iconColor}66` }}>
                {s.start_time}{s.end_time ? `–${s.end_time}` : ''}
                <span className="mt-0.5 block text-[.7em] font-normal opacity-60">МСК</span>
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
                <div className="mt-1 text-[.9em] font-semibold" style={{ color: iconColor }}>
                  {s.speaker_name}
                </div>
              )}
              {s.speaker_position && (
                <div className="mt-0.5 text-[.82em] leading-snug opacity-70">
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

/**
 * Дата события — всегда МСК (правило проекта).
 * Если даты взяты из программы (у конференции events.start_at пуст), время
 * не показываем: у каждого дня своё расписание по слотам. Диапазон дней
 * выводим как «30–31 июля».
 */
function formatDate(iso: string, end?: string | null, fromProgram?: boolean): string {
  try {
    const d1 = new Date(iso)
    const opts: Intl.DateTimeFormatOptions = fromProgram
      ? { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }
      : { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }
    const s1 = d1.toLocaleString('ru-RU', opts)
    if (fromProgram && end) {
      const d2 = new Date(end)
      if (d2.getTime() !== d1.getTime()) {
        const sameMonth = d1.getMonth() === d2.getMonth()
        const left = sameMonth
          ? d1.toLocaleString('ru-RU', { day: 'numeric', timeZone: 'Europe/Moscow' })
          : s1
        const right = d2.toLocaleString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })
        return `${left}–${right}`
      }
    }
    return fromProgram ? s1 : `${s1} МСК`
  } catch { return '' }
}

function formatDay(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', timeZone: 'Europe/Moscow',
    })
  } catch { return '' }
}
