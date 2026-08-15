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
import { embedUrl } from '@/lib/videoEmbed'
import SafeHtml from '@/components/SafeHtml'

interface Props {
  data: any
  slug: string
  /**
   * Чья это страница. `product` — лендинг продукта (миграция 293): те же
   * блоки, но заголовок берётся из продукта, а кнопки ведут на заказ
   * продукта, а не на регистрацию на событие.
   */
  ownerType?: 'event' | 'product'
  /** Кто привёл (?pid=) — прокидываем во все ссылки заказа и регистрации. */
  pid?: string | null
  contactId?: string | null
  utmSource?: string | null
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
  // Края почти не затемняем: даже -12% на персике давали грязный тёмный
  // ободок. Блик широкий и яркий — металл читается как светлый, а не как
  // тёмная полоса сверху и снизу.
  const edge = shade(color, -4)
  const light = shade(color, 75)
  return `linear-gradient(180deg, ${edge}, ${color} 18%, ${light} 48%, ${light} 56%, ${color} 82%, ${edge})`
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

export default function LandingRenderer({
  data, slug, pid = null, contactId = null, utmSource = null, ownerType = 'event',
}: Props) {
  // Хвост с метками: подставляем в каждую ссылку, чтобы реф-код не терялся
  // при переходе на форму заказа или регистрацию.
  const track = [
    pid && `pid=${encodeURIComponent(pid)}`,
    contactId && `c=${encodeURIComponent(contactId)}`,
    utmSource && `utm_source=${encodeURIComponent(utmSource)}`,
  ].filter(Boolean).join('&')
  const withTrack = (url: string) =>
    track ? `${url}${url.includes('?') ? '&' : '?'}${track}` : url
  const { page, blocks, data: content } = data
  // ⚠️ У продукта поля `event` нет — берём продукт и подставляем те же ключи,
  // которых ждёт разметка (title/description/start_at). Даты у продукта нет:
  // hero сам прячет плашку, когда start_at пуст.
  const isProduct = ownerType === 'product' || data.owner_type === 'product'
  const event = isProduct
    ? { ...(data.product || {}), start_at: null, end_at: null, dates_from_program: null }
    : data.event
  // Куда ведут кнопки: у события — регистрация, у продукта — заказ тарифа.
  const ctaHref = isProduct ? `/pr/${slug}#tariffs` : `/event/${slug}/register`
  const orderHref = (tariffId: number | string) =>
    isProduct ? `/pr/${slug}?tariff=${tariffId}` : `/e/${slug}/order/${tariffId}`
  const radius = page.radius ?? 5

  /**
   * Плавная прокрутка по якорям.
   *
   * ⚠️ Обычный `href="#lp-tariffs"` внутри Next.js перехватывается роутером:
   * страница ПЕРЕЗАГРУЖАЕТСЯ и только потом прыгает к секции. Нам нужен
   * скролл на месте, поэтому клики по якорным ссылкам обрабатываем сами.
   * Один слушатель на всю страницу — работает и для кнопок, и для меню,
   * и для тех, что появятся позже.
   */
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.('a')
      const href = a?.getAttribute('href')
      if (!href || !href.startsWith('#')) return
      const el = document.getElementById(href.slice(1))
      if (!el) return
      e.preventDefault()
      el.scrollIntoView({
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          ? 'auto' : 'smooth',
        block: 'start',
      })
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

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
          // ⚠️ Рамка берёт СВЕТЛЫЙ металл (metallicButton), а не тёмный
          // заголовочный: на тонкой рамке тёмные края читаются как грязь,
          // нужен именно яркий блик.
          background: page.btn_border_metallic
            ? `${asLayer(btnFill)} padding-box, ${metallicButton(page.btn_border_color || '#FFCFA4')} border-box`
            : `${asLayer(btnFill)} padding-box, linear-gradient(${page.btn_border_color || '#FFCFA4'}, ${page.btn_border_color || '#FFCFA4'}) border-box`,
        }
      : { background: btnFill }),
  }

  // Заливка карточки — свой цвет с прозрачностью из темы.
  // ⚠️ Металл и градиенты только В РАМКЕ: заливать карточку ярким градиентом
  // нельзя, текст поверх становится нечитаемым.
  const cardFill = hexToRgba(page.card_bg || '#0F1E2E', (page.card_bg_opacity ?? 55) / 100)
  const brd = page.border_color || '#FFCFA4'

  // Цвет текста ВНУТРИ карточек. Пусто → наследуем общий текст страницы.
  // ⚠️ Нужен, когда фон страницы и карточки контрастны друг другу: тёмная
  // страница + светлые карточки одним color_body не собирались — текст
  // совпадал по цвету с карточкой и пропадал.
  const cardText = page.card_text_color || undefined

  const cardStyle: React.CSSProperties = page.border_style === 'fade'
    // «Растворяющаяся» рамка: яркая по углам, к середине сторон уходит в ноль.
    // Делается двумя слоями фона — заливка в padding-box, рамка в border-box.
    ? {
        borderRadius: radius,
        border: '1px solid transparent',
        background:
          `linear-gradient(${cardFill}, ${cardFill}) padding-box, ` +
          `conic-gradient(from 45deg at 50% 50%, ${brd}, transparent 25%, ${brd} 50%, transparent 75%, ${brd}) border-box`,
        ...(cardText ? { color: cardText } : {}),
      }
    : {
        borderRadius: radius,
        border: `1px solid ${brd}`,
        background: cardFill,
        ...(cardText ? { color: cardText } : {}),
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
    // ⚠️ ПУСТО, а не цвет. Слой с фоновой картинкой лежит в `-z-10`, то есть
    // ПОЗАДИ корня: непрозрачный фон на корне полностью закрывал картинку —
    // от фото не оставалось ничего. Подложка на случай незагрузившейся
    // картинки задана ниже, на самом слое картинки (под ней, а не над).
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
        <div
          className="fixed inset-0 -z-10"
          // Подложка ПОД картинкой: пока фото грузится (сотни КБ) или если
          // не загрузилось, страница не будет белой — светлый текст на белом
          // не читается. Именно под, а не на корне: корень лежит ПОВЕРХ
          // этого слоя и непрозрачным фоном закрывал картинку целиком.
          style={{ background: page.bg_css_screen || page.bg_css || page.bg_color || '#25455D' }}
        >
          {/* Фон — картинкой блока, а НЕ <img> с transform: scale.
              ⚠️ scale() ужимал саму картинку внутри контейнера: по краям
              появлялись пустые поля, а сдвиг переставал что-либо менять.

              ⚠️ Масштаб = cover × коэффициент, а НЕ «N% ширины»:
              `N% auto` считает высоту от ширины, и на узком высоком экране
              телефона широкая картинка выходила НИЖЕ экрана — сдвигать её
              по вертикали было физически нечего (ползунок не работал).
              Задавать `N% N%` тоже нельзя: это растягивает картинку и ломает
              пропорции. Поэтому cover (пропорции целы, экран перекрыт) плюс
              увеличение самого слоя — запас для сдвига появляется по обеим
              осям. Слой растёт от центра, поэтому вылезающие края уходят
              за пределы экрана и обрезаются родителем. */}
          <div
            className="lp-bg-img absolute inset-0 bg-cover bg-no-repeat"
            style={{
              backgroundImage: `url(${page.bg_image_url})`,
              backgroundPosition: page.bg_position || '50% 50%',
              ...(Math.max(100, page.bg_scale ?? 300) !== 100
                ? { transform: `scale(${Math.max(100, page.bg_scale ?? 300) / 100})` }
                : {}),
            }}
          />
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
        /* Полоса прокрутки карусели — своя, акцентного цвета и ВСЕГДА видимая.
           ⚠️ На телефоне системный скроллбар скрыт (overlay-режим), поэтому
           понять, что ленту можно листать, было невозможно. Задаём дорожку и
           бегунок явно — работает и на мобильных, и на десктопе. */
        /* ⚠️ min-width:0 + max-width:100% обязательны: flex-контейнер без них
           растягивается по содержимому и распирает страницу — появлялась
           горизонтальная прокрутка ВСЕЙ страницы вместо прокрутки ленты. */
        /* Лента: пока карточки помещаются — стоят по центру, дальше
           обычная прокрутка от левого края. */
        .lp-scroll { justify-content: safe center; }
        .lp-scroll {
          min-width: 0;
          max-width: 100%;
          scrollbar-width: thin;
          scrollbar-color: ${iconColor} ${hexToRgba(iconColor, 0.18)};
        }
        .lp-scroll::-webkit-scrollbar {
          height: 6px;
          -webkit-appearance: none;
          display: block;
        }
        .lp-scroll::-webkit-scrollbar-track {
          background: ${hexToRgba(iconColor, 0.18)};
          border-radius: 3px;
        }
        .lp-scroll::-webkit-scrollbar-thumb { background: ${iconColor}; border-radius: 3px; }
        /* Регалии основателя: выделенное жирным — акцентным цветом темы.
           Строка регалии и так полужирная, поэтому «ещё жирнее» на ней не
           читается — цвет отличает выделение куда лучше. */
        .lp-bio b, .lp-bio strong { color: ${iconColor}; }
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
        /* ⚠️ Неполный ряд стоит ПО ЦЕНТРУ, а не липнет к левому краю.
           «justify-content» сам по себе тут бессилен: колонки шириной «1fr»
           занимают всю ширину сетки целиком, и центрировать нечего — при
           2 партнёрах на 3 колонки третья просто оставалась пустой справа.
           Поэтому ширину колонки ограничиваем сверху («--lp-col-w»): колонки
           перестают растягиваться, и весь ряд центрируется целиком. */
        .lp-grid { grid-template-columns: 1fr; justify-content: center; --lp-col-w: 1fr; }
        /* Цифры на телефоне — 2 в ряд: по одной они растягивали бы секцию в
           бесконечную колонку, а цифра узкая и вполне помещается.
           ⚠️ НО если под цифрой стоит скриншот-доказательство, две колонки
           делают его нечитаемым (там мелкие числа) — тогда одна в ряд. */
        /* ⚠️ Оба правила действуют ТОЛЬКО до 560px (телефон). Раньше они шли
           без медиазапроса и перебивали брейкпоинты .lp-grid — из-за большей
           специфичности («.lp-grid-2sm.lp-has-proof» весомее «.lp-grid»).
           Из-за этого цифры со скриншотами стояли по одной в ряд и на широком
           экране, хотя клиент выбрал две колонки. */
        @media (max-width: 559px) {
          .lp-grid-2sm { grid-template-columns: repeat(min(2, var(--lp-cols-lg, 4)), 1fr); }
          .lp-grid-2sm.lp-has-proof { grid-template-columns: 1fr; }
        }
        /* Ширина картинки в карточке: на телефоне всегда 100% (см. w-full),
           с 640px — как задал клиент настройкой «Размер фото». */
        @media (min-width: 640px) { .lp-card-img { width: var(--lp-img-w, 100%); } }
        /* ⚠️ Пропорция картинки в карточке на ТЕЛЕФОНЕ не применяется.
           Заданное соотношение (например 1.6) держит рамку широкой и низкой,
           а вписанный в неё вертикальный скриншот упирается в высоту и
           занимает лишь узкую полоску посреди карточки — по бокам пустота.
           На узком экране картинка рисуется в своих пропорциях во всю ширину;
           с 640px работает настройка клиента. */
        .lp-card-img { aspect-ratio: auto; height: auto; }
        @media (min-width: 640px) { .lp-card-img { aspect-ratio: var(--lp-img-ratio, auto); } }
        /* Картинка секции: на телефоне во всю ширину, с 640px — как задал клиент. */
        .lp-sec-img { width: 100%; }
        @media (min-width: 640px) { .lp-sec-img { width: var(--lp-sec-img-w, 100%); } }
        /* Боковые поля секции: на телефоне узкие (см. padXMobile), с 640px —
           как задал клиент настройкой. */
        @media (min-width: 640px) { .lp-section { --lp-pad-x: var(--lp-pad-x-lg); } }
        /* ⚠️ Колонка — «minmax(0, var(--lp-col-w))», а не голый «1fr».
           Обычно «--lp-col-w» = «1fr» (ряд полный, карточки тянутся на всю
           ширину — как было). Когда карточек МЕНЬШЕ, чем колонок, компонент
           подставляет конкретную ширину — тогда колонки перестают тянуться,
           и «justify-content: center» ставит неполный ряд по центру.
           «minmax(0, …)» обязателен: без него длинное слово внутри карточки
           раздувает колонку шире сетки. */
        @media (min-width: 560px)  { .lp-grid { grid-template-columns: repeat(min(2, var(--lp-cols-lg, 3)), minmax(0, var(--lp-col-w, 1fr))); } }
        @media (min-width: 900px)  { .lp-grid { grid-template-columns: repeat(min(3, var(--lp-cols-lg, 3)), minmax(0, var(--lp-col-w, 1fr))); } }
        @media (min-width: 1160px) { .lp-grid { grid-template-columns: repeat(var(--lp-cols-lg, 3), minmax(0, var(--lp-col-w, 1fr))); } }
        /* Бегущая подсветка: в каждый момент выделена РОВНО ОДНА карточка —
           золотистая полупрозрачная заливка + свечение. Предыдущая гаснет
           до того, как загорится следующая, поэтому «огонёк» бежит по списку.
           Длительность цикла задаётся переменной --lp-cycle (число карточек). */
        @keyframes lp-glow {
          0%, 100% { background-color: transparent; box-shadow: none; border-color: var(--lp-brd); }
          4%  { background-color: var(--lp-glow-soft);
                box-shadow: 0 0 42px 6px var(--lp-glow-dim), inset 0 0 26px var(--lp-glow-soft);
                border-color: var(--lp-glow); }
          14% { background-color: var(--lp-glow-soft);
                box-shadow: 0 0 42px 6px var(--lp-glow-dim), inset 0 0 26px var(--lp-glow-soft);
                border-color: var(--lp-glow); }
          20%, 99% { background-color: transparent; box-shadow: none; border-color: var(--lp-brd); }
        }
        .lp-glow > * { animation: lp-glow var(--lp-cycle, 10s) ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .lp-glow > * { animation: none; } }
        /* ⚠️ overflow-x: hidden НЕЛЬЗЯ ставить ни на .lp-root, ни на html/body:
           он создаёт контейнер прокрутки, и position: sticky у шапки
           перестаёт работать — она уезжает вместе со страницей.
           От горизонтальной прокрутки защищаемся иначе: ограничиваем ширину
           содержимого (max-width на картинках, перенос длинных слов). */
        ${(page.bg_position_mobile || page.bg_scale_mobile) ? `
        /* Свой кадр фона на телефоне: на узком экране картинка срезается по
           БОКАМ, и объект сбоку пропадает. Фокус и масштаб — отдельно. */
        @media (max-width: 767px) {
          .lp-bg-img {
            ${page.bg_position_mobile ? `background-position: ${page.bg_position_mobile} !important;` : ''}
            ${page.bg_scale_mobile ? `transform: scale(${Math.max(100, page.bg_scale_mobile) / 100}) !important;` : ''}
          }
        }` : ''}
        .lp-root { max-width: 100vw; }
        .lp-root img { max-width: 100%; }
        .lp-root h1, .lp-root h2, .lp-root h3 { overflow-wrap: anywhere; }
      `}</style>

      {/* Липкая шапка: логотип + якоря на секции + кнопка регистрации. */}
      {page.nav_enabled && (
        <LandingNav ctaHref={ctaHref} page={page} blocks={blocks} content={content}
                    btnStyle={btnStyle} slug={slug} withTrack={withTrack} />
      )}

      {blocks.map((b: any) => (
        <Section ctaHref={ctaHref} orderHref={orderHref}
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
          withTrack={withTrack}
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
function LandingNav({ page, blocks, content, btnStyle, slug, withTrack, ctaHref }: any) {
  const [open, setOpen] = useState(false)
  const items: Array<{ label: string; block_kind: string }> =
    Array.isArray(page.nav_items) ? page.nav_items : []
  // Показываем только пункты, чья секция реально есть и включена.
  const present = new Set(blocks.map((b: any) => b.kind))
  const presentIds = new Set(blocks.map((b: any) => String(b.id)))
  const links = items.filter((i: any) =>
    i.block_id ? presentIds.has(String(i.block_id)) : present.has(i.block_kind))
  // Ссылка пункта: на КОНКРЕТНЫЙ блок, если он указан, иначе на первую
  // секцию такого типа (как было раньше).
  const navHref = (i: any) =>
    i.block_id ? `#lp-b${i.block_id}` : `#lp-${i.block_kind}`
  // На телефоне показываем только отмеченные галочкой пункты. Ключа нет —
  // считаем видимым (так было до появления настройки).
  const mobileLinks = links.filter((i: any) => i.mobile !== false)
  // 'register' → форма регистрации; иначе — якорь на секцию страницы.
  const navTarget = (!page.nav_button_target || page.nav_button_target === 'register')
    ? withTrack(ctaHref)
    : `#lp-${page.nav_button_target}`
  const logo = content?.brand?.logo_url
  // ⚠️ У КОЛЛАБЫ в шапке — знаки ВСЕХ организаторов, а не одного. Событие
  // общее, аудитория приходит от каждого, и один логотип выдавал бы чужое
  // мероприятие за своё. Бэкенд отдаёт `organizers` только у коллаб-события.
  const organizers: any[] = Array.isArray(content?.organizers) ? content.organizers : []

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
        {organizers.length > 1 ? (
          /* Коллаба: знаки всех организаторов в ряд. На телефоне ряд
             прокручивается — трём логотипам рядом с кнопкой места нет,
             а ужимать их до нечитаемого размера хуже, чем скролл. */
          <a href="#top"
             className="flex min-w-0 shrink items-center gap-3 overflow-x-auto sm:gap-4">
            {organizers.map((o: any, i: number) => (
              o.logo_url ? (
                <img key={o.id ?? i} src={o.logo_url} alt={o.name || ''}
                     title={o.name || ''}
                     className="h-8 w-auto shrink-0 object-contain sm:h-9" />
              ) : (
                <span key={o.id ?? i}
                      className="shrink-0 whitespace-nowrap text-[.8em] font-bold uppercase tracking-wide sm:text-[.9em]"
                      style={{ color: page.color_heading || '#FFCFA4' }}>
                  {o.name || ''}
                </span>
              )
            ))}
          </a>
        ) : (
          <a href="#top" className="shrink-0">
            {logo
              ? <img src={logo} alt="" className="h-9 w-auto object-contain" />
              : <span className="font-bold uppercase tracking-wide"
                      style={{ color: page.color_heading || '#FFCFA4' }}>
                  {content?.brand?.name || ''}
                </span>}
          </a>
        )}

        {/* Пункты меню — ПО ЦЕНТРУ шапки, между логотипом и кнопкой.
            Цвет — основного текста страницы (у нас белый): на тёмной шапке
            он читается, а фирменный акцент оставлен кнопке.
            На телефоне пункты уезжают в раскрывашку, кнопка остаётся. */}
        <nav className="mx-auto hidden items-center gap-6 md:flex">
          {links.map(i => (
            <a key={(i as any).block_id || i.block_kind}
               href={navHref(i)}
               className="text-[.9em] font-medium uppercase tracking-wide transition-opacity hover:opacity-70"
               style={{ color: page.color_body || '#FFFFFF' }}>
              {i.label}
            </a>
          ))}
        </nav>

        {/* ⚠️ Кнопка видна ВСЕГДА, включая телефон: это главное действие
            страницы. Гамбургер лишь прячет пункты, которые не помещаются. */}
        {page.nav_button_label && (
          <a href={navTarget}
             className="ml-auto shrink-0 truncate px-3 py-2 text-[.75em] font-bold uppercase sm:px-5 sm:py-2.5 sm:text-[.85em] md:ml-0"
             style={{ ...btnStyle, maxWidth: '52vw' }}>
            {page.nav_button_label}
          </a>
        )}

        {!!mobileLinks.length && (
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-label="Меню"
            className={`shrink-0 md:hidden ${page.nav_button_label ? 'ml-2' : 'ml-auto'}`}
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
          {mobileLinks.map((i: any) => (
            <a key={(i as any).block_id || i.block_kind} href={navHref(i)}
               onClick={() => setOpen(false)}
               className="py-2 text-[.95em] font-medium uppercase tracking-wide"
               style={{ color: page.color_body || '#FFFFFF' }}>
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
  ctaHref, orderHref,
  block, page, radius, headingStyle, btnStyle, cardStyle, iconColor, event, content, slug,
  withTrack,
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

  // ⚠️ У ШАПКИ заголовок рисует она сама (крупным, с металликом, вместе с
  // надзаголовком и пилюльками). Обёртка секции его показывать НЕ должна —
  // иначе один и тот же текст выводится на странице дважды подряд.
  const title = block.kind === 'hero' ? '' : block.title
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
        // Значения подняты: 14% заливки почти не читались на тёмном фоне.
        ['--lp-glow-soft' as any]: hexToRgba(page.icon_color || '#FFCFA4', 0.3),
        ['--lp-glow-dim' as any]: hexToRgba(page.icon_color || '#FFCFA4', 0.75),
        ['--lp-brd' as any]: page.border_color || '#FFCFA4',
      } as React.CSSProperties)
    : {}

  /* Содержимое блока — своё для каждого типа. */
  const blockBody = <BlockBody ctaHref={ctaHref} orderHref={orderHref}
    block={block} page={page} radius={radius} btnStyle={btnStyle}
    cardStyle={cards} iconColor={iconColor} headingStyle={ownHeading}
    glowCls={glowCls} glowVars={glowVars}
    event={event} content={content} slug={slug} withTrack={withTrack}
  />

  /* Картинка-контент секции (не фон): встаёт рядом с содержимым или над ним. */
  const pic = block.image_url ? (
    <img
      src={block.image_url}
      alt=""
      loading="lazy"
      // ⚠️ `lp-sec-img`: на ТЕЛЕФОНЕ картинка всегда во всю ширину. Настройка
      // «ширина картинки» (например 38%) задумана для широкого экрана, где
      // картинка стоит сбоку от текста; на узком колонки складываются
      // друг под друга, и те же 38% превращаются в тонкую полоску.
      className="lp-sec-img object-cover"
      style={{
        borderRadius: radius,
        ['--lp-sec-img-w' as any]: `${block.image_width || 100}%`,
        // По центру — картинка сама центрируется в колонке.
        margin: block.image_position === 'center' ? '0 auto' : undefined,
        display: 'block',
      }}
    />
  ) : null

  const align = block.title_align || 'left'

  // Кнопка секции: доступна у ЛЮБОГО блока, текст и ссылка — из настроек.
  // hero и speakers рисуют свою кнопку внутри (регистрация / разворот регалий).
  // ⚠️ У отдельного элемента-кнопки отступа сверху нет: он сам себе секция,
  // и её отступ уже задан настройкой pad_y. Двойной зазор смотрелся дырой.
  const ownButton = block.button_label && !['hero', 'speakers'].includes(block.kind) ? (
    <div className={`${block.kind === 'el_button' ? '' : 'mt-8'} ${
      align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : ''}`}>
      <a
        href={block.button_url || withTrack(ctaHref)}
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
  // У элемента-кнопки заголовка нет вовсе — он и не настраивается.
  const heading = (title && block.kind !== 'el_button') ? (
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

  // ⚠️ У шапки подзаголовок, как и заголовок, рисует она сама — иначе он
  // выводится дважды подряд.
  const subtitle = (block.subtitle && block.kind !== 'hero') ? (
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
  // ⚠️ На телефоне боковой отступ ограничиваем 16px, даже если клиент задал
  // больше: на широком экране 36px — это воздух по краям, а на 390px это
  // 72px из 390 (почти пятая часть ширины), и содержимое, особенно
  // скриншоты, становится нечитаемо узким.
  const padX = Math.max(16, page.pad_x ?? 24)
  const padXMobile = Math.min(16, padX)
  const padY = block.pad_y ?? page.section_gap ?? 64
  const maxW = page.content_width ?? 1120

  return (
    <section
      /* ⚠️ Якорь по типу — «первая секция такого типа». Галерей на странице
         бывает несколько, поэтому ниже есть ещё якорь по НОМЕРУ блока. */
      id={`lp-${block.kind}`}

      /* ⚠️ `isolate` обязателен: секция создаёт свой контекст наложения.
         Без него слой фона уезжает за пределы секции — под фон СТРАНИЦЫ — и
         непрозрачная заливка корня закрывает его целиком. */
      className="lp-section relative isolate scroll-mt-20"
      style={{
        ...sectionStyle,
        paddingLeft: 'var(--lp-pad-x)', paddingRight: 'var(--lp-pad-x)',
        ['--lp-pad-x' as any]: `${padXMobile}px`,
        ['--lp-pad-x-lg' as any]: `${padX}px`,
        paddingTop: padY, paddingBottom: padY,
      }}
    >
      {/* ⚠️ Якорь по НОМЕРУ блока: галерей и текстовых секций на странице
          бывает несколько, и пункт меню по типу всегда уводил на первую. */}
      <span id={`lp-b${block.id}`} className="absolute -top-20" aria-hidden="true" />
      {block.bg_image_url && (
        // ⚠️ `-z-10` здесь стоять НЕ должен: он уводил картинку ЗА корень
        // страницы, и при сплошной заливке корня (bg_mode='page') фон секции
        // не было видно вовсе — клиент грузил фото и получал пустой экран
        // (событие 88). Нулевой слой держит фон внутри секции: он под
        // содержимым (оно ниже и поднято `relative z-10`), но над заливкой.
        <div className="absolute inset-0 overflow-hidden"
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

      <div className="relative z-10 mx-auto w-full" style={{ maxWidth: maxW ? maxW : undefined }}>
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
            {/* ⚠️ Текст секции выравнивается ТОЙ ЖЕ настройкой, что заголовок.
                Раньше она двигала только заголовок: клиент ставил «по центру»,
                а абзац под ним оставался прижатым влево — выглядело как
                недоделка. */}
            {body && <p className="mt-4 whitespace-pre-wrap opacity-90"
                        style={{ ...textSizeStyle, textAlign: align as any }}>{body}</p>}
            {/* Отступ нужен, только когда выше реально что-то есть: у голого
                элемента-кнопки заголовка и текста нет, и mt-8 давал дыру. */}
            <div className={heading || subtitle || body ? 'mt-8' : ''}
                 style={textSizeStyle}>{inner}</div>
            {ownButton}
          </>
        )}
      </div>
    </section>
  )
}

/* ─────────────────────────────────────────────────────────────────────────── */

function BlockBody({
  ctaHref, orderHref,
  block, page, radius, btnStyle, cardStyle, iconColor, headingStyle, event, content, slug,
  glowCls = '', glowVars = {}, withTrack = (u: string) => u,
}: any) {
  const items = block.items

  switch (block.kind) {
    /* ── Шапка ─────────────────────────────────────────────────────────── */
    case 'hero': {
      // На странице после оплаты (kind='post_pay') бэк присылает `bots` —
      // кнопки на ботов клиента вместо кнопки регистрации, плюс свой текст.
      const bots = content.bots
      const isThanks = Array.isArray(bots)
      // Куда прижат текст шапки. По умолчанию центр — как было всегда.
      // ⚠️ Нужно для фонов со смысловым объектом сбоку: текст по центру
      // ложится прямо на него. Сдвиг решает это без правки картинки.
      const hAlign = block.hero_align === 'left' || block.hero_align === 'right'
        ? block.hero_align : 'center'
      const heroAlignCls =
        hAlign === 'left' ? 'text-left items-start'
        : hAlign === 'right' ? 'text-right items-end'
        : 'text-center items-center'
      // При сдвиге в сторону колонка занимает половину ширины, иначе строки
      // растянулись бы на весь экран и «прижатость» была бы не видна.
      const heroWidthCls = hAlign === 'center' ? '' : 'md:max-w-[56%]'
      const heroSelfCls =
        hAlign === 'right' ? 'md:ml-auto' : hAlign === 'left' ? 'md:mr-auto' : ''
      return (
        <div className={`flex flex-col ${heroAlignCls} ${heroWidthCls} ${heroSelfCls}`}>
          {/* Формат и дата — двумя овалами в один ряд над заголовком.
              Цвет рамки и текста — основного текста страницы, заливка
              полупрозрачная и сгущается к центру. */}
          {!isThanks && (block.date_position || 'above') === 'above' && (
            <HeroPills
              kicker={block.kicker}
              date={event.start_at
                ? formatDate(event.start_at, event.end_at, event.dates_from_program)
                : ''}
              color={page.color_body || '#FFFFFF'}
              size={block.date_size}
              className="mb-5"
            />
          )}
          {/* Надзаголовок — тип события НАД названием («Фестиваль практик и
              медитаций» над «Г.У.Р.У.»). Цветом основного текста, чтобы не
              спорить с золотым названием. */}
          {!isThanks && block.overline && (
            // ⚠️ mb-5 — такой же отступ, как у подзаголовка снизу (mt-5):
            // название стоит ровно посередине между надзаголовком и
            // подзаголовком. Было mb-2 — сверху зазор 8px, снизу 20px,
            // и шапка выглядела съехавшей вверх.
            // ⚠️ Без uppercase: текст показывается ровно так, как его набрал
            // клиент. Заглавные буквы — его решение, а не наше.
            <p
              className="mb-5 font-bold leading-tight tracking-wide"
              style={{
                fontSize: `clamp(${Math.round((block.overline_size || 30) * 0.6)}px, ${((block.overline_size || 30) / 24).toFixed(1)}vw, ${block.overline_size || 30}px)`,
              }}
            >
              {block.overline}
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
            {/* ⚠️ Заголовок по умолчанию — НАЗВАНИЕ (события/продукта), но его
                можно переопределить полем блока: на продающей странице нужен
                призыв («ВЫСТУПИТЕ СПИКЕРОМ…»), а не служебное название
                продукта из кабинета. Пусто в блоке — показываем название. */}
            {isThanks ? page.post_pay_title : (block.title || event.title)}
          </h1>

          {isThanks ? (
            <>
              {page.post_pay_text && (
                <p className="mx-auto mt-5 max-w-2xl whitespace-pre-wrap opacity-90"
                   style={{ fontSize: block.subtitle_size ? `${block.subtitle_size}px` : '1.25em' }}>
                  {page.post_pay_text}
                </p>
              )}
              {/* На странице после оплаты выбор мессенджера — целевое
                  действие, поэтому кнопки полноценные. На телефоне держим их
                  в одну строку, сжимая по ширине. */}
              {!!bots.length && (
                <div className="mt-8 flex flex-nowrap justify-center gap-2 sm:gap-3">
                  {bots.map((b: any) => (
                    <a key={b.platform} href={b.url} target="_blank" rel="noreferrer"
                       className="min-w-0 truncate px-4 py-3 text-[.85em] font-bold uppercase transition-transform hover:scale-105 sm:px-7 sm:py-4 sm:text-[1em]"
                       style={btnStyle}>
                      {b.label}
                    </a>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {/* Подзаголовок — описание из настроек события/продукта; поле
                  блока его переопределяет (как и заголовок выше). */}
              {(block.subtitle || event.description) && (
                // ⚠️ mx-auto только при центре: при сдвиге влево/вправо он
                // вернул бы абзац на середину и выравнивание не сработало бы.
                <p className={`mt-5 max-w-3xl opacity-90 ${hAlign === 'center' ? 'mx-auto' : ''}`}
                   style={{ fontSize: block.subtitle_size ? `${block.subtitle_size}px` : '1.25em' }}>
                  {block.subtitle || event.description}
                </p>
              )}
              {block.date_position === 'below' && (
                <HeroPills
                  kicker={block.kicker}
                  date={event.start_at
                    ? formatDate(event.start_at, event.end_at, event.dates_from_program)
                    : ''}
                  color={page.color_body || '#FFFFFF'}
                  size={block.date_size}
                  className="mt-5"
                />
              )}
              {/* Счётчик мест — рядом с кнопкой, а не отдельной секцией.
                  Положение задаётся в блоке «Шапка»: над кнопкой или сбоку. */}
              <div className={`mt-8 flex flex-wrap items-center gap-5 ${
                hAlign === 'left' ? 'justify-start' : hAlign === 'right' ? 'justify-end' : 'justify-center'
              } ${
                block.seats_position === 'side' ? 'flex-row' : 'flex-col'
              }`}>
                {block.show_seats && content.seats && (
                  <SeatsBadge seats={content.seats} iconColor={iconColor} radius={radius} />
                )}
                {/* Подпись кнопки — только из настроек блока. Значений по
                    умолчанию в коде нет: не задана — кнопки не будет. */}
                {block.button_label && (
                  // Куда ведёт — настраивается, как у любой другой кнопки:
                  // на регистрацию, к секции страницы (#lp-…) или на свой URL.
                  <a
                    href={(block.button_url || '').trim() || withTrack(ctaHref)}
                    {...((block.button_url || '').trim().startsWith('http')
                      ? { target: '_blank', rel: 'noreferrer' } : {})}
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

      /* ⚠️ Режим «список» (`display_mode='list'`): ОДНА большая картинка
         секции сверху и пункты списком под ней — так устроен исходный лендинг.
         Сетка карточек с картинкой в каждой дробит внимание и мельчит
         скриншоты: на них важны цифры, которые в маленькой карточке
         нечитаемы. */
      if (block.display_mode === 'list') {
        return (
          <div>
            {block.image_url && (
              <div className="mb-8 overflow-hidden rounded-2xl"
                   style={{ border: `1px solid ${hexToRgba(iconColor, .25)}` }}>
                <img src={block.image_url} alt="" loading="lazy" className="block w-full" />
              </div>
            )}
            <div className="space-y-5">
              {list.map((c: any, i: number) => (
                <div key={i} className="flex items-start gap-4">
                  {/* Номер — вместо галочки: пункты читаются как последовательность */}
                  <span
                    className="mt-0.5 flex shrink-0 items-center justify-center rounded-full font-bold"
                    style={{
                      width: 38, height: 38,
                      border: `2px solid ${iconColor}`,
                      color: iconColor,
                      fontFamily: page.font_heading_css,
                      fontSize: 20, lineHeight: 1,
                    }}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold uppercase leading-snug"
                         style={{ color: page.color_heading || '#FFCFA4' }}>
                      {c.title}
                    </div>
                    {c.text && (
                      <p className="mt-1.5 text-[.95em] leading-relaxed opacity-85">{c.text}</p>
                    )}
                    {/* Картинка пункта — во всю ширину под его текстом,
                        чтобы цифры на скриншоте оставались читаемыми. */}
                    {c.image && (
                      <div className="mt-3 overflow-hidden rounded-xl"
                           style={{ border: `1px solid ${hexToRgba(iconColor, .2)}` }}>
                        <img src={c.image} alt="" loading="lazy" className="block w-full" />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      }

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
                // ⚠️ На телефоне картинка идёт во ВСЮ ширину карточки, без
                // боковых отступов: экран узкий, и поля по 16px с каждой
                // стороны заметно съедают и без того мелкий скриншот.
                <div className="p-0 pb-0 sm:p-4 sm:pb-0">
                  <img src={c.image} alt="" loading="lazy"
                       className="lp-card-img mx-auto block w-full sm:w-auto"
                       style={{
                         // Ширина фото в % от карточки — иначе фото всегда
                         // занимало её целиком и выглядело громоздким.
                         // ⚠️ На узком экране настройка не применяется (см.
                         // w-full выше): там картинка всегда во всю ширину.
                         ['--lp-img-w' as any]: `${block.card_img_size || 100}%`,
                         // ⚠️ Пропорция идёт ПЕРЕМЕННОЙ, а не свойством
                         // `aspectRatio`: инлайн-стиль перебил бы правило
                         // `.lp-card-img`, которое снимает пропорцию на
                         // телефоне (иначе вертикальный скриншот сжимается
                         // в узкую полоску посреди карточки).
                         ['--lp-img-ratio' as any]: String(block.card_img_ratio || 1.6),
                         borderRadius: `${block.card_img_radius_x || 0}% / ${block.card_img_radius_y || 0}%`,
                         background: 'rgba(255,255,255,.06)',
                         // ⚠️ «Вписать целиком» (contain) вместо обрезки: на
                         // скриншотах важны ЦИФРЫ по краям, а `cover` режет
                         // их вместе с краями кадра. Обрезка остаётся
                         // выбором — `card_img_fit='crop'`.
                         objectFit: block.card_img_fit === 'crop' ? 'cover' : 'contain',
                       }} />
                </div>
              )}
              <div className="flex flex-1 flex-col gap-2 p-5">
                <div className="flex items-start gap-3">
                  {/* ⚠️ Маркер пункта настраивается блоком (`marker`): галочка
                      (как было), НОМЕР по порядку или иконка из набора.
                      Нумерация нужна, когда пункты — это шаги: галочки
                      порядок не показывают. Значение по умолчанию — 'check',
                      поэтому уже собранные лендинги не меняются. */}
                  {(block.marker || 'check') === 'number' ? (
                    <span
                      className="mt-0.5 flex shrink-0 items-center justify-center rounded-full font-bold"
                      style={{
                        width: Math.round((block.icon_size || 88) * 0.34),
                        height: Math.round((block.icon_size || 88) * 0.34),
                        border: `2px solid ${iconColor}`,
                        color: iconColor,
                        fontSize: Math.round((block.icon_size || 88) * 0.19),
                        fontFamily: page.font_heading_css,
                        lineHeight: 1,
                      }}
                    >
                      {i + 1}
                    </span>
                  ) : (block.marker === 'icon' && c.icon) ? (
                    <div className="mt-0.5 shrink-0">
                      <CardIcon
                        iconKey={c.icon}
                        color={iconColor}
                        metallic={!!page.icon_metallic}
                        size={Math.round((block.icon_size || 88) * 0.34)}
                        id={`${block.id}-au-${i}`}
                      />
                    </div>
                  ) : (
                    <svg viewBox="0 0 24 24" className="mt-1 shrink-0"
                         width={Math.round((block.icon_size || 88) * 0.24)}
                         height={Math.round((block.icon_size || 88) * 0.24)}
                         fill="none" stroke={iconColor} strokeWidth="3"
                         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
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
      // Пункт — объект {title, text}: название и описание двумя полями.
      // ⚠️ Строки поддерживаем и дальше: так пункты лежат у всех, кто
      // заполнял блок раньше. Строку с переносом делим на название и описание,
      // строку без переноса показываем как одно название.
      const list = (Array.isArray(items) ? items : [])
        .map((i: any) => {
          if (i && typeof i === 'object') return { title: i.title || '', text: i.text || '' }
          if (typeof i === 'string' && i) {
            const [head, ...rest] = i.split('\n')
            return { title: head, text: rest.join('\n').trim() }
          }
          return null
        })
        .filter(Boolean) as Array<{ title: string; text: string }>
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
              {/* Название — цветом заголовков (акцент), описание под ним
                  обычным текстом.
                  ⚠️ Без uppercase: капс был зашит намертво и «съедал» пункты
                  из нескольких предложений — название и описание сливались
                  в сплошную кричащую строку. Регистр задаёт сам текст. */}
              <span className="min-w-0 pt-1">
                <span className="block font-bold"
                      style={{ color: page.color_heading || '#FFCFA4' }}>
                  {t.title}
                </span>
                {t.text && (
                  <span className="mt-1 block whitespace-pre-line font-normal opacity-90">
                    {t.text}
                  </span>
                )}
              </span>
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

    /* ── Процесс: этапы по вертикальной линии ──────────────────────────── */
    // Для премий, турниров и конференций: «приём заявок → оценочные эфиры →
    // народное признание → финал». Обычной сеткой карточек ПОСЛЕДОВАТЕЛЬНОСТЬ
    // не читается — не видно, что за чем идёт. Здесь линия задаёт направление,
    // а карточки встают по её сторонам поочерёдно.
    //
    // items: [{ date, title, text, image }]
    case 'process': {
      const list = Array.isArray(items) ? items.filter((s: any) => s && (s.title || s.text)) : []
      const line = hexToRgba(iconColor, .45)
      return (
        <div className="relative">
          {/* Линия: на телефоне уходит влево (места на две колонки нет),
              на широком экране — по центру. */}
          <div className="absolute bottom-0 left-[11px] top-0 w-px md:left-1/2 md:-translate-x-1/2"
               style={{ background: `linear-gradient(180deg, transparent, ${line} 8%, ${line} 92%, transparent)` }} />
          <div className="space-y-8 md:space-y-2">
            {list.map((s: any, i: number) => {
              const right = i % 2 === 1   // чередование сторон
              return (
                <div key={i} className="relative md:grid md:grid-cols-2 md:gap-10">
                  {/* Точка на линии */}
                  <div className="absolute left-[11px] top-3 z-10 -translate-x-1/2 md:left-1/2">
                    <span className="block h-3 w-3 rounded-full"
                          style={{ background: iconColor, boxShadow: `0 0 0 5px ${hexToRgba(iconColor, .18)}` }} />
                  </div>
                  {/* Пустая половина — чтобы карточка ушла на нужную сторону */}
                  {right && <div className="hidden md:block" />}
                  <div className={`ml-8 md:ml-0 ${right ? '' : 'md:text-right'}`}>
                    <div className="p-5" style={cardStyle}>
                      {s.date && (
                        <div className="mb-1 text-[.8em] uppercase tracking-wider opacity-70">
                          {s.date}
                        </div>
                      )}
                      {s.title && (
                        <h3 className="text-[1.05em] font-bold uppercase tracking-wider"
                            style={{ color: page.color_heading || '#FFCFA4' }}>
                          {s.title}
                        </h3>
                      )}
                      {s.text && (
                        <p className="mt-2 text-[.9em] leading-relaxed opacity-90">{s.text}</p>
                      )}
                      {s.image && (
                        <div className="mt-4 overflow-hidden rounded-xl"
                             style={{ border: `1px solid ${hexToRgba(iconColor, .25)}` }}>
                          <img src={s.image} alt={s.title || ''} loading="lazy"
                               className="block w-full" />
                        </div>
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
        <div className={`lp-grid lp-grid-2sm grid gap-x-6 gap-y-10 ${
               list.some((n: any) => n.image) ? 'lp-has-proof' : ''}`}
             style={{ ['--lp-cols-lg' as any]: Math.max(1, Math.min(6, block.columns || 4)) }}>
          {list.map((n: any, i: number) => (
            <div key={i} className="flex flex-col p-5 text-center" style={cardStyle}>
              <div className="text-[2.6em] font-bold leading-none sm:text-[3.2em]"
                   style={metalNum}>
                <CountUp value={n.value} />
              </div>
              {block.show_divider && (
                <div className="mx-auto mt-3 h-px w-10"
                     style={{ background: page.color_body || '#FFFFFF', opacity: .6 }} />
              )}
              {/* Подпись под цифрой слушается настройки «размер текста»
                  блока: .9em было зашито намертво, и «спикеров»/«практик»
                  нельзя было укрупнить под крупную цифру. */}
              <div className="mt-3 opacity-85"
                   style={{ fontSize: block.text_size ? `${block.text_size}px` : '.9em' }}>
                {n.label}
              </div>
              {/* ⚠️ Скриншот-ДОКАЗАТЕЛЬСТВО прямо под своей цифрой (`n.image`).
                  Собранные отдельным блоком «доказательства» внизу страницы, они
                  выглядели оторванно: непонятно, какую цифру подтверждает какая
                  картинка. Здесь связь видна сразу. */}
              {n.image && (
                <div className="mt-4 overflow-hidden rounded-xl"
                     style={{ border: `1px solid ${hexToRgba(iconColor, .25)}` }}>
                  <img src={n.image} alt={n.image_caption || n.label || ''}
                       loading="lazy" className="block w-full" />
                </div>
              )}
              {n.image_caption && (
                <div className="mt-2 text-[.75em] opacity-60">{n.image_caption}</div>
              )}
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

    /* ── Что входит (состав продукта, миграция 293) ────────────────────── */
    case 'product_content': {
      const pc = content.product_content || { sections: [], items: [] }
      const sections: any[] = pc.sections || []
      const items: any[] = pc.items || []
      if (!items.length && !sections.length) return null

      // Дерево «разделы + материалы»: материал без раздела идёт первым уровнем.
      const bySection: Record<string, any[]> = {}
      for (const it of items) {
        const k = String(it.section_id ?? 'root')
        ;(bySection[k] ||= []).push(it)
      }
      const byParent: Record<string, any[]> = {}
      for (const sec of sections) {
        const k = String(sec.parent_id ?? 'root')
        ;(byParent[k] ||= []).push(sec)
      }
      const renderSection = (sec: any, depth: number): any => (
        <div key={`s${sec.id}`} style={{ marginLeft: depth * 16 }} className="mb-3">
          <div className="font-semibold" style={{ color: page.color_heading || '#FFCFA4' }}>
            {sec.title}
          </div>
          {sec.description && (
            <div className="text-sm opacity-80">{sec.description}</div>
          )}
          <div className="mt-2 space-y-2">
            {(byParent[String(sec.id)] || []).map((c: any) => renderSection(c, depth + 1))}
            {(bySection[String(sec.id)] || []).map((it: any) => (
              <div key={it.link_id} className="rounded-xl px-4 py-3" style={cardStyle}>
                <div className="font-medium">{it.title}</div>
                {it.description && <div className="text-sm opacity-80">{it.description}</div>}
              </div>
            ))}
          </div>
        </div>
      )

      return (
        <div className="space-y-3">
          {(byParent['root'] || []).map((sec: any) => renderSection(sec, 0))}
          {(bySection['root'] || []).map((it: any) => (
            <div key={it.link_id} className="rounded-xl px-4 py-3" style={cardStyle}>
              <div className="font-medium">{it.title}</div>
              {it.description && <div className="text-sm opacity-80">{it.description}</div>}
            </div>
          ))}
        </div>
      )
    }

    /* ── Тарифы ────────────────────────────────────────────────────────── */
    case 'tariffs': {
      const t = content.tariffs || { items: [] }
      return (
        <>
          {/* ⚠️ У тарифов бегущая подсветка не нужна: выделен ОДИН тариф,
              отмеченный галочкой «Выделить на лендинге». */}
          {/* ⚠️ Колонок не больше, чем самих тарифов: при настройке «3 колонки»
              единственный тариф прижимался к левому краю узкой карточкой, а
              справа зияла пустота. Один тариф → одна колонка, на всю ширину. */}
          <div className="lp-grid grid gap-5"
               style={{
                 ['--lp-cols-lg' as any]: Math.max(
                   1,
                   Math.min(6, block.columns || 3, (t.items || []).length || 1),
                 ),
               }}>
            {(t.items || []).map((x: any, i: number) => (
              // Выделенный тариф (галочка «рекомендуемый» в разделе Тарифы) —
              // подсвеченная рамка и мягкое свечение, чтобы взгляд цеплялся.
              <div key={x.id} className="relative flex flex-col p-6"
                   style={{
                     ...cardStyle,
                     animationDelay: `calc(var(--lp-cycle, 10s) / var(--lp-count, 5) * ${i})`,
                     // Выделенный тариф: яркий ореол + подсвеченная заливка.
                     // Ширина ореола настраивается в блоке (featured_glow).
                     ...(x.is_featured ? {
                       borderColor: iconColor,
                       borderWidth: 2,
                       boxShadow: `0 0 ${block.featured_glow ?? 24}px ${Math.round((block.featured_glow ?? 24) / 6)}px ${hexToRgba(iconColor, 0.75)}, `
                         + `inset 0 0 ${Math.round((block.featured_glow ?? 24) * 1.2)}px ${hexToRgba(iconColor, 0.18)}`,
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
                {/* Два списка: что входит (галочка) и чего нет (зачёркнуто).
                    «Не входит» задаётся отдельным полем в форме тарифа.
                    Минус в начале строки основного описания тоже работает —
                    так было раньше, у кого уже заполнено, не сломается. */}
                {(x.description || x.excluded_description) && (
                  <ul className="mt-4 flex-1 list-none space-y-2.5 p-0 text-[.9em] leading-relaxed">
                    {[
                      ...String(x.description || '').split('\n')
                        .map((r: string) => r.trim()).filter(Boolean)
                        .map((row: string) => ({
                          excluded: /^[-–—]\s*/.test(row),
                          text: row.replace(/^[-–—]\s*/, ''),
                        })),
                      ...String(x.excluded_description || '').split('\n')
                        .map((r: string) => r.trim()).filter(Boolean)
                        .map((row: string) => ({
                          excluded: true,
                          text: row.replace(/^[-–—]\s*/, ''),
                        })),
                    ].map(({ excluded, text }, k: number) => (
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
                    ))}
                  </ul>
                )}
                {/* Кнопка ведёт на НАШУ форму заказа: она опознаёт человека
                    по email/телефону, создаёт заказ и уводит на оплату.
                    Бесплатный тариф форма регистрирует сразу. */}
                <a
                  href={withTrack(orderHref(x.id))}
                  className="mt-6 block px-5 py-3.5 text-center font-bold uppercase"
                  style={btnStyle}
                >
                  {Number(x.price) > 0 ? 'Выбрать' : 'Участвовать'}
                </a>
              </div>
            ))}
          </div>
          {/* ⚠️ Строку «Покупая, вы соглашаетесь с офертой» здесь не выводим:
              ссылка на оферту есть в подвале, дублировать её под тарифами
              не нужно. Согласие фиксируется на странице заказа. */}
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
                    {/* ⚠️ Регалии клиент пишет тегами (<b>жирный</b>) — выводим
                        разметку, а не текст: иначе на лендинге видны сами теги.
                        SafeHtml чистит всё небезопасное.
                        Выделенное жирным красим АКЦЕНТНЫМ цветом темы: на
                        лендинге вся строка и так полужирная, и без цвета
                        выделение в ней не читалось. */}
                    <SafeHtml html={x} className="lp-bio" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )
    }

    /* ── Галерея / отзывы ──────────────────────────────────────────────── */
    // Вынесена в отдельный компонент: карусели нужен свой стейт (стрелки
    // прокрутки), а хук нельзя объявлять внутри switch.
    // ⚠️ Считаем вид карточек здесь же, а не берём сырой `cardStyle`: иначе
    // выбор «Вид карточек → без оформления» на галерею не действовал —
    // рамка оставалась всегда. Та же логика, что в Section выше.
    case 'gallery': {
      const gcs = block.card_style || (block.cards_bordered === false ? 'plain' : 'border')
      const gCards: React.CSSProperties =
        gcs === 'divider'
          ? { borderRadius: 0, border: 'none',
              borderBottom: `1px solid ${page.border_color || '#FFCFA4'}40`,
              background: 'transparent' }
          : gcs === 'plain'
            ? { borderRadius: radius, border: 'none', background: 'transparent' }
            : cardStyle
      return <GalleryBlock
        block={block} content={content} cardStyle={gCards}
        radius={radius} iconColor={iconColor}
      />
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
      // ⚠️ Это не призыв к действию, а способы связи: кнопки мельче и
      // акцентного цвета, чтобы не спорить с настоящей CTA. На телефоне
      // держим их в ОДНУ строку — сжимаются, но не переносятся.
      return (
        <div className="flex flex-nowrap items-center justify-center gap-2 sm:gap-3">
          {links.map(([label, url]: any) => (
            <a key={label} href={url} target="_blank" rel="noreferrer"
               className="min-w-0 truncate px-3 py-2 text-[.8em] font-bold uppercase transition-opacity hover:opacity-85 sm:px-5 sm:py-2.5 sm:text-[.85em]"
               style={{
                 borderRadius: page.btn_radius ?? radius,
                 background: iconColor,
                 color: page.day_tab_text_color || page.bg_color || '#0a1520',
                 fontFamily: page.font_body_css,
               }}>
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
          {/* ⚠️ У коллабы в копирайте — ВСЕ организаторы. Юр-данные выше
              остаются одного продавца (деньги принимает он), но подписывать
              общее событие именем одного партнёра неверно. */}
          <div className="opacity-60">
            © {new Date().getFullYear()}{' '}
            {Array.isArray(content?.organizers) && content.organizers.length > 1
              ? content.organizers.map((o: any) => o.name).filter(Boolean).join(' · ')
              : f.brand_name}
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

/**
 * Формат и дата над заголовком — два овала в один ряд.
 *
 * Рамка и текст цветом основного текста страницы; заливка полупрозрачная и
 * сгущается к центру, поэтому овал читается и на светлом, и на тёмном фоне.
 * На узком экране овалы переносятся, но остаются по центру.
 */
function HeroPills({
  kicker, date, color, size, className = '',
}: {
  kicker?: string | null
  date?: string
  color: string
  size?: number | null
  className?: string
}) {
  const pills = [kicker, date].map(t => (t || '').trim()).filter(Boolean)
  if (!pills.length) return null

  const style: React.CSSProperties = {
    color,
    border: `1px solid ${hexToRgba(color, 0.55)}`,
    // Заливка гуще в середине — как на боевом лендинге.
    background: `radial-gradient(ellipse at center, ${hexToRgba(color, 0.16)}, ${hexToRgba(color, 0.04)} 70%)`,
    fontSize: size ? `${size}px` : undefined,
  }

  return (
    <div className={`flex flex-wrap items-center justify-center gap-3 ${className}`}>
      {pills.map((t, i) => (
        <span key={i}
              className="inline-flex items-center rounded-full px-6 py-2 leading-snug"
              style={style}>
          {t}
        </span>
      ))}
    </div>
  )
}

function SeatsBadge({ seats, iconColor, radius }: any) {
  const metalText: React.CSSProperties = {
    background: metallic(iconColor),
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
  }
  const pos = seats.label_position || 'top'
  // ⚠️ Подпись — ТОГО ЖЕ размера, что и цифра: это одна надпись «Осталось
  // мест 30/100», просто из двух частей. Мельчить её нельзя — было в 3 раза
  // меньше цифры и выглядело сноской.
  const label = seats.label
    ? <span className="font-bold uppercase leading-none tracking-wide"
            style={{
              // Подпись — тем же акцентным цветом, что и цифра (цвет иконок темы).
              color: iconColor,
              fontSize: seats.size ? `${seats.size}px` : '2.6em',
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
 * Галерея отзывов и кейсов: фото и видео, каруселью или сеткой.
 *
 * Карусель со стрелками по бокам — и на компьютере, и на телефоне: без них
 * непонятно, что ленту вообще можно листать. Стрелки акцентного цвета,
 * прячутся, когда листать больше некуда.
 */
function GalleryBlock({ block, content, cardStyle, radius, iconColor }: any) {
  const scroller = useRef<HTMLDivElement>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(false)

  const g = block.items && !Array.isArray(block.items) ? block.items : {}
  // Источник: свои картинки в блоке либо общая база отзывов по меткам.
  const fromBase = block.gallery_source === 'testimonials'
    ? (content.testimonials?.[String(block.id)] || [])
    : null
  const list = fromBase
    ? fromBase.map((t: any) => ({
        url: t.url,
        caption: t.caption || t.title,
        kind: t.kind,
        preview_url: t.preview_url,
      }))
    : (Array.isArray(g.list) ? g.list.filter((x: any) => x?.url) : [])

  // ⚠️ Хуки объявляем ДО любых return — иначе при пустом списке порядок
  // хуков поменяется и React упадёт (правило проекта).
  const sync = () => {
    const el = scroller.current
    if (!el) return
    setAtStart(el.scrollLeft <= 4)
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4)
  }
  useEffect(() => { sync() }, [list.length])

  if (!list.length) return null

  // При выборе из базы тип берём у самого отзыва (фото/видео).
  const isVideo = fromBase ? undefined : g.media === 'video'
  const carousel = (g.mode || 'carousel') === 'carousel'
  // Ширина карточки в карусели — настройка блока. Видео по умолчанию шире
  // фото: мелкое видео не рассмотреть.
  const cardW = block.media_size || ((isVideo ?? false) ? 420 : 320)
  const showCaptions = block.show_captions !== false

  // Две НЕЗАВИСИМЫЕ настройки вида карточек (решение клиента 2026-08-12):
  //   photo_fit: 'crop' — фото заполняет карточку, края обрезаются
  //              'fit'  — фото видно целиком, пустое место прозрачное
  //   caption_align: 'top' — подписи начинаются на одной линии
  //                  'bottom' — подписи заканчиваются на одной линии
  // В обоих случаях фото занимает окно одной высоты, поэтому ряд ровный.
  const photoFit: 'crop' | 'fit' = g.photo_fit || 'crop'
  const captionAlign: 'top' | 'bottom' = g.caption_align || 'bottom'
  // Форма окна под фото. Пусто → 4/3.
  const ratio = g.ratio || '4 / 3'

  const scrollBy = (dir: 1 | -1) => {
    const el = scroller.current
    if (!el) return
    el.scrollBy({ left: dir * (cardW + 16), behavior: 'smooth' })
  }

  const cards = list.map((x: any, i: number) => (
    // ⚠️ Фото лежит в окне ФИКСИРОВАННЫХ пропорций (`aspectRatio`), поэтому у
    // всех карточек ряда оно одной высоты — подписи встают на одну линию сами.
    // `cover` заполняет окно и режет края, `contain` показывает фото целиком
    // (пустое место остаётся прозрачным — сквозь него виден фон секции).
    //
    // ⚠️ Подпись «по нижнему краю» прижимается через mt-auto — именно БЕЗ
    // h-full. Контейнер (и flex-карусель, и grid) растягивает карточки на
    // высоту ряда сам (align-items: stretch), а height:100% от родителя без
    // заданной высоты это растягивание ломает: карточка снова сжимается по
    // своему фото, и подпись уезжает вверх (жалоба 2026-08-12).
    <figure
      key={i}
      className={`flex flex-col ${carousel ? 'shrink-0 snap-start' : ''}`}
      style={{ ...cardStyle, ...(carousel ? { width: `min(${cardW}px, 82vw)` } : {}) }}
    >
      {(isVideo ?? x.kind === 'video') ? (
        // ⚠️ Видео бывает двух видов: наш файл в хранилище (mp4/webm) и
        // ссылка на YouTube/VK/Rutube. Файл нужно проигрывать тегом <video>
        // — в <iframe> он не открывается, получался пустой чёрный кадр.
        isFileVideo(x.url) ? (
          <video
            src={x.url}
            poster={x.preview_url || undefined}
            controls
            playsInline
            preload="metadata"
            className="w-full"
            style={{
              borderRadius: radius,
              background: '#000',
              aspectRatio: ratio,
              objectFit: photoFit === 'crop' ? 'cover' : 'contain',
            }}
          />
        ) : (
          <div
            className="w-full overflow-hidden"
            style={{ borderRadius: radius, aspectRatio: ratio }}
          >
            <iframe
              src={embedUrl(x.url)}
              className="h-full w-full"
              allowFullScreen
              loading="lazy"
              title={x.caption || `Видео ${i + 1}`}
            />
          </div>
        )
      ) : (
        <img
          src={x.url}
          alt={x.caption || ''}
          loading="lazy"
          className="w-full"
          style={{
            borderRadius: radius,
            aspectRatio: ratio,
            objectFit: photoFit === 'crop' ? 'cover' : 'contain',
          }}
        />
      )}
      {showCaptions && x.caption && (
        <figcaption
          className={`p-3 text-[.9em] opacity-80 ${captionAlign === 'bottom' ? 'mt-auto' : ''}`}
        >
          {x.caption}
        </figcaption>
      )}
    </figure>
  ))

  if (!carousel) {
    return (
      <div className="lp-grid grid gap-4"
           style={{ ['--lp-cols-lg' as any]: Math.max(1, Math.min(6, block.columns || 3)) }}>
        {cards}
      </div>
    )
  }

  return (
    <div className="relative min-w-0 max-w-full">
      <div
        ref={scroller}
        onScroll={sync}
        className="lp-scroll flex min-w-0 max-w-full snap-x snap-mandatory gap-4 overflow-x-auto pb-3"
      >
        {cards}
      </div>

      {/* Стрелки поверх ленты. Круглые, акцентного цвета — видно и на фото. */}
      {!atStart && <GalleryArrow dir="left" color={iconColor} onClick={() => scrollBy(-1)} />}
      {!atEnd && <GalleryArrow dir="right" color={iconColor} onClick={() => scrollBy(1)} />}
    </div>
  )
}

function GalleryArrow({
  dir, color, onClick,
}: { dir: 'left' | 'right'; color: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir === 'left' ? 'Назад' : 'Вперёд'}
      // ⚠️ Стрелки держим ВНУТРИ ленты (left-1/right-1): вынос за край
      // (-left-4) на телефоне вылезал за экран и добавлял горизонтальную
      // прокрутку всей странице.
      className={`absolute top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full shadow-lg transition-transform hover:scale-110 ${
        dir === 'left' ? 'left-1' : 'right-1'
      }`}
      style={{ background: color, color: '#0a1520' }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={dir === 'left' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
      </svg>
    </button>
  )
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
    <div className="lp-scroll flex min-w-0 max-w-full snap-x snap-mandatory gap-5 overflow-x-auto pb-3">
      {cards}
    </div>
  ) : (
    <div className="lp-grid grid gap-5"
         style={{ ['--lp-cols-lg' as any]: Math.min(cols, list.length) }}>
      {cards}
    </div>
  )
}

/**
 * Партнёры события — лентой со стрелками, как отзывы.
 *
 * ⚠️ Логотип показывается ЦЕЛИКОМ на белом поле (object-contain), а не
 * обрезается квадратом: у партнёров логотипы разных пропорций — часто
 * длинные горизонтальные, и кадрирование съедало половину названия.
 *
 * Описание разворачивается СРАЗУ У ВСЕХ карточек одной стрелкой — как у
 * спикеров: иначе ряд растягивается по самой высокой, а соседние выглядят
 * пустыми.
 */
function PartnersBlock({ list, block, page, cardStyle, iconColor }: any) {
  const scroller = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(false)

  // ⚠️ Хуки объявляем ДО раннего return — иначе при пустом списке порядок
  // хуков меняется и React падает (правило проекта).
  const sync = () => {
    const el = scroller.current
    if (!el) return
    setAtStart(el.scrollLeft <= 4)
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4)
  }
  useEffect(() => { sync() }, [list.length])

  if (!list.length) return null

  // ⚠️ Колонок не больше, чем самих партнёров. Иначе лишние дорожки остаются
  // ПУСТЫМИ: при 3 колонках и 2 партнёрах сетка (она блочная и занимает всю
  // ширину) центрирует ТРИ дорожки, третья пустует справа — и карточки
  // оказываются левее середины. Настройка клиента остаётся потолком.
  const cols = Math.max(1, Math.min(6, block.columns || 4, list.length))
  // Партнёры по умолчанию лентой: логотипов обычно много и они разной ширины.
  const scroll = (block.display_mode || 'scroll') === 'scroll'
  const cardW = block.media_size || 260

  const scrollBy = (dir: 1 | -1) => {
    scroller.current?.scrollBy({ left: dir * (cardW + 20), behavior: 'smooth' })
  }

  const cards = list.map((p: any) => (
    <PartnerCard
      key={p.id} p={p} page={page} cardStyle={cardStyle} iconColor={iconColor}
      open={open} onToggle={() => setOpen(o => !o)}
      className={scroll ? 'shrink-0 snap-start' : ''}
      width={scroll ? cardW : undefined}
    />
  ))

  if (!scroll) {
    return (
      <div className="lp-grid grid gap-5"
           style={{ ['--lp-cols-lg' as any]: Math.min(cols, list.length) }}>
        {cards}
      </div>
    )
  }

  return (
    <div className="relative min-w-0 max-w-full">
      <div
        ref={scroller}
        onScroll={sync}
        className="lp-scroll flex min-w-0 max-w-full snap-x snap-mandatory gap-5 overflow-x-auto pb-3"
      >
        {cards}
      </div>
      {!atStart && <GalleryArrow dir="left" color={iconColor} onClick={() => scrollBy(-1)} />}
      {!atEnd && <GalleryArrow dir="right" color={iconColor} onClick={() => scrollBy(1)} />}
    </div>
  )
}

function PartnerCard({
  p, page, cardStyle, iconColor, open, onToggle, className = '', width,
}: any) {
  // Описание партнёра: и должность/подпись, и регалии — всё, что он о себе
  // рассказал. Первые две строки видны сразу, остальное — по стрелке.
  const lines: string[] = [
    ...(p.title ? [String(p.title)] : []),
    ...(Array.isArray(p.achievements)
      ? p.achievements
          .map((a: any) => typeof a === 'string' ? a : (a?.label || ''))
          .map((a: string) => a.replace(/^[-–—•\s]+/, '').trim())
          .filter(Boolean)
      : []),
  ]
  const visible = open ? lines : lines.slice(0, 2)
  const url = p.partner_url || p.website_url

  const inner = (
    <>
      {/* ⚠️ Логотип на БЕЛОМ поле и целиком: у партнёров он может быть
          узким горизонтальным, тёмным или с прозрачным фоном. */}
      {p.photo_url && (
        <div className="flex items-center justify-center bg-white p-5"
             style={{ minHeight: 120 }}>
          <img src={p.photo_url} alt={p.name} loading="lazy"
               className="max-h-[90px] w-full object-contain" />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-4 text-center">
        <div className="font-bold uppercase leading-tight"
             style={{ color: page.color_heading || '#FFCFA4' }}>
          {p.name}
        </div>
        {!!visible.length && (
          <div className="space-y-1.5 text-[.85em] leading-relaxed opacity-85">
            {visible.map((t, i) => <p key={i}>{t}</p>)}
          </div>
        )}
        {lines.length > 2 && (
          <button
            type="button"
            onClick={e => { e.preventDefault(); onToggle() }}
            aria-label={open ? 'Свернуть' : 'Показать полностью'}
            className="mt-auto flex items-center justify-center pt-2"
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
    </>
  )

  const cls = `flex flex-col overflow-hidden ${className}`
  const style = { ...cardStyle, ...(width ? { width: `min(${width}px, 72vw)` } : {}) }

  return url
    ? <a href={url} target="_blank" rel="noreferrer"
         className={`${cls} transition-transform hover:scale-[1.02]`} style={style}>{inner}</a>
    : <div className={cls} style={style}>{inner}</div>
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
  // Цвета переключателя дней — из настроек. По умолчанию заливка акцентная,
  // текст цветом фона страницы: тёмный на светлой плашке читается всегда.
  const dayFill = page.day_tab_color || iconColor
  const dayText = page.day_tab_text_color || page.bg_color || '#0a1520'
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
                      background: dayFill,
                      color: dayText,
                      fontFamily: btnStyle.fontFamily,
                    }
                  : {
                      borderRadius: 40,
                      background: hexToRgba(dayFill, 0.12),
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

/**
 * Наш ли это видеофайл (лежит в хранилище), а не ссылка на видеохостинг.
 * Файл проигрывается тегом <video>, ссылка — встраивается iframe-ом.
 */
function isFileVideo(url: string): boolean {
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url || '')
}

/* ⚠️ Своей копии embedUrl здесь БЫЛО: она отставала от общей (не знала
   youtube.com/shorts), и вертикальные ролики не открывались, хотя в общей
   функции поддержка уже была. Импортируем общую — см. lib/videoEmbed.ts. */

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
