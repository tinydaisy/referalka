/**
 * Публичная страница собранного лендинга события (миграция 240).
 *
 *   /e/{slug}         — основная страница
 *   /e/{slug}/thanks  — страница после оплаты (return-url платёжки)
 *
 * Данные приходят одним запросом с бэка уже собранными: оформление, блоки в
 * нужном порядке и содержимое живых блоков (спикеры, программа, тарифы). Здесь
 * — только загрузка и передача в рендер.
 *
 * Черновик (`is_published = FALSE`) бэк отдаёт 404 → показываем «не найдено».
 * Исключение — `?preview=<токен>`: подписанная ссылка владельца из кабинета.
 * ⚠️ Токен идёт ПАРАМЕТРОМ АДРЕСА: страница рендерится на сервере, заголовка
 * `Authorization` из браузера у неё нет.
 */
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import LandingRenderer from './LandingRenderer'
import PreviewBar from '@/components/PreviewBar'

export const dynamic = 'force-dynamic'   // цены и «осталось мест» должны быть свежими

const apiBase =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000'

async function getLanding(slug: string, kind: 'main' | 'post_pay', preview?: string) {
  try {
    const qs = preview ? `&preview=${encodeURIComponent(preview)}` : ''
    const res = await fetch(
      `${apiBase}/api/v1/public/event-landing/${encodeURIComponent(slug)}?kind=${kind}${qs}`,
      { cache: 'no-store' },
    )
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** Дата события для подписи карточки: «26 октября в 10:00 МСК»,
 *  «с 24 сентября по 1 октября» или «24–30 сентября».
 *
 * ⚠️ Время ВСЕГДА московское и подписано «МСК». Карточку мессенджер забирает
 * один раз и показывает её всем одинаково — подставить каждому читателю его
 * часовой пояс физически некуда, а время без пояса читается как местное и
 * зовёт людей не в тот час.
 *
 * ⚠️ Полночь (00:00) печатаем без времени. У события, которому задали только
 * дату, время в базе выходит нулевым — и «в 00:00» выглядело бы как ночное
 * мероприятие.
 *
 * ⚠️⚠️ МНОГОДНЕВНОЕ СОБЫТИЕ — ПЕРИОД, А НЕ ПЕРВЫЙ ДЕНЬ (24.09.2026, прод).
 * У конференции/премии даты берутся из ПРОГРАММЫ (`conf_days`): `start_at` —
 * первый день, `end_at` — последний (см. event_landing_public.py). В подпись
 * уходил только `start_at`, и конференция длиной в неделю звала «приходи 24
 * сентября» — человек читал это как однодневное событие и мог решить, что
 * опоздал, увидев ссылку 26-го.
 */
const EVENT_TZ = 'Europe/Moscow'

/** Идёт ли событие больше одного дня. Единая точка правила — от неё зависит и
 *  формат даты, и выбор умолчания, и они обязаны совпадать. */
function isDateRange(startAt?: string | null, endAt?: string | null): boolean {
  if (!startAt || !endAt) return false
  const d = new Date(startAt), e = new Date(endAt)
  if (isNaN(d.getTime()) || isNaN(e.getTime())) return false
  // Сравниваем календарные сутки в МСК, а не метки времени: у однодневного
  // события `end_at` обычно стоит вечером того же дня.
  const key = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: EVENT_TZ })
  return key(e) > key(d)
}

function formatEventDate(
  startAt?: string | null,
  datesFromProgram?: boolean,
  endAt?: string | null,
): string {
  if (!startAt) return ''
  const d = new Date(startAt)
  if (isNaN(d.getTime())) return ''
  const TZ = EVENT_TZ
  const fmt = (x: Date, withMonth = true) =>
    x.toLocaleDateString('ru', withMonth
      ? { day: 'numeric', month: 'long', timeZone: TZ }
      : { day: 'numeric', timeZone: TZ })
  const day = fmt(d)

  if (isDateRange(startAt, endAt)) {
    const e = new Date(endAt as string)
    const sameMonth = d.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7)
      === e.toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7)
    // Внутри одного месяца месяц не повторяем: «24–30 сентября», а не
    // «с 24 сентября по 30 сентября» — в карточке каждый символ на счету.
    return sameMonth ? `${fmt(d, false)}–${fmt(e)}` : `с ${day} по ${fmt(e)}`
  }

  // Даты собраны из программы → у дня своё расписание по слотам, общего времени
  // старта у события нет (см. dates_from_program в API лендинга).
  if (datesFromProgram) return day
  const hm = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: TZ })
  return hm === '00:00' ? day : `${day} в ${hm} МСК`
}

/** Подпись под ссылкой события в мессенджере.
 *
 * Клиент задаёт свой текст в настройках события («Как выглядит ссылка в
 * мессенджере»); пусто — берём это умолчание. Умолчание живёт ЗДЕСЬ, а не в
 * базе: скопируй мы его в каждое событие при создании, поменять формулировку
 * разом стало бы нельзя.
 */
const SHARE_PREVIEW_DEFAULT = 'Приходи {дата} на «{название}»'
// ⚠️ Отдельное умолчание для события БЕЗ даты («идёт постоянно»). Вырезать
// {дата} из общей фразы мало: остаётся «Приходи на «Клуб»» — а предлог там
// нужен ровно такой же, поэтому фразу проще задать целиком, чем чинить
// падежи вычитанием.
const SHARE_PREVIEW_DEFAULT_NO_DATE = 'Приходи на «{название}»'
// ⚠️ И отдельное — для МНОГОДНЕВНОГО: в общую фразу период не вставляется без
// спотыкания, «Приходи с 24 сентября по 1 октября на «…»» — два предлога
// подряд. Здесь дата идёт после названия, и фраза читается ровно.
const SHARE_PREVIEW_DEFAULT_RANGE = '«{название}» — {дата}. Приходи!'

// ⚠️ БЕЗ `export`: Next.js разрешает странице экспортировать только свой набор
// (default, generateMetadata, dynamic и т.п.) и падает на сборке —
// «buildSharePreviewText is not a valid Page export field». Функция нужна
// только здесь; понадобится снаружи — выносить в отдельный модуль, а не
// экспортировать из файла страницы.
function buildSharePreviewText(
  template: string | null | undefined,
  { title, date, isRange }: { title: string; date: string; isRange?: boolean },
): string {
  const tpl = (template || '').trim()
    || (!date ? SHARE_PREVIEW_DEFAULT_NO_DATE
      : isRange ? SHARE_PREVIEW_DEFAULT_RANGE
        : SHARE_PREVIEW_DEFAULT)
  const out = tpl
    .replace(/\{дата\}/g, date)
    .replace(/\{название\}/g, title)
  // ⚠️ У события может не быть даты вовсе («идёт постоянно»), и тогда на месте
  // {дата} остаётся пустота с разделителем клиента вокруг неё: «Приходи на  —
  // «Клуб»» или, если {дата} стояла первой, строка вовсе начиналась с тире.
  // Поэтому схлопываем двойные пробелы и срезаем осиротевшие разделители по
  // краям и перед кавычкой — в чат должна уходить целая фраза.
  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[—–-]\s*(?=[«"])/g, ' ')
    .replace(/^\s*[—–-]\s*/, '')
    .replace(/\s*[—–-]\s*$/, '')
    .trim()
}

export async function generateMetadata(
  { params }: { params: { slug: string } },
): Promise<Metadata> {
  const data = await getLanding(params.slug, 'main')
  if (!data) return { title: 'Событие' }
  const { event } = data
  const brandLogo = data.data?.brand?.logo_url || data.data?.organizer?.brand_logo_url
  // ⚠️ ФАВИКОН — ТЁМНАЯ ВЕРСИЯ ЗНАКА («логотип для светлых фонов»). Вкладка
  // браузера белая, и основной логотип — обычно белый — сливается с ней в
  // пустой квадрат. Не загружена тёмная версия — берём основной: пустая
  // вкладка хуже плохо различимой.
  const favicon = data.data?.brand?.logo_light_url
    || data.data?.organizer?.brand_logo_light_url
    || brandLogo
  // ⚠️ КАРТИНКА КАРТОЧКИ — АФИША СОБЫТИЯ, и только если её нет — логотип
  // основателя (решение владельца 23.09.2026). Было наоборот: логотип стоял
  // первым, и в переписке у всех событий клиента шла одна и та же плашка со
  // знаком вместо афиши конкретного мероприятия. Логотип остаётся запасным —
  // он лучше, чем пустая карточка или случайная картинка со страницы, из-за
  // которой в чате однажды показывался логотип ПЛЮСОНа (прод, 2026-08-18).
  const ogImage = event.poster_url || brandLogo
  // ⚠️ Подпись — отдельное короткое поле, а НЕ описание лендинга. Описание
  // написано для открывшего страницу, допускает HTML (`<b>`, `<a href>`) и,
  // обрезанное по 200 символов, обрывалось посреди слова или тега — а теги в
  // карточке Telegram показываются как текст.
  const shareText = buildSharePreviewText(event.share_preview_text, {
    title: event.title,
    date: formatEventDate(event.start_at, event.dates_from_program, event.end_at),
    isRange: isDateRange(event.start_at, event.end_at),
  })
  return {
    title: event.title,
    description: shareText || undefined,
    // Фавикон вкладки — тоже логотип клиента: страница открыта на ЕГО домене
    // и под его брендом, наш значок там выглядит чужим.
    icons: favicon ? { icon: favicon } : undefined,
    openGraph: {
      title: event.title,
      description: shareText || undefined,
      images: ogImage ? [ogImage] : undefined,
    },
    // Без этого X/Twitter рисует маленькую карточку с миниатюрой сбоку —
    // афиша в ней нечитаема.
    twitter: {
      card: 'summary_large_image',
      title: event.title,
      description: shareText || undefined,
      images: ogImage ? [ogImage] : undefined,
    },
  }
}

export default async function EventLandingPage(
  { params, searchParams }: {
    params: { slug: string }
    searchParams: {
      pid?: string; c?: string; utm_source?: string; preview?: string
      /** Площадка пришедшего — едет дальше в форму регистрации (см. LandingRenderer). */
      tg_id?: string; vk_id?: string; max_id?: string
      /** `1` — страницу открыл наш рендерер PDF (см. backend/app/services/landing_pdf.py). */
      pdf?: string
    }
  },
) {
  const preview = searchParams?.preview
  // ⚠️ Режим печати. Нужен там, где на бумаге интерактив не работает: у
  // галереи-карусели прокрутки в PDF нет, и человек видел только первую
  // карточку без всякого намёка, что рядом есть ещё.
  const forPdf = searchParams?.pdf === '1'
  // Абсолютный адрес страницы — для ссылок внутри PDF (относительные там мертвы).
  // Домен берём из заголовка запроса: у клиента он может быть свой.
  const host = headers().get('host') || ''
  const pageUrl = host ? `https://${host}/e/${params.slug}` : ''
  const data = await getLanding(params.slug, 'main', preview)

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Страница не найдена</h1>
          <p className="mt-2 text-gray-600">
            Лендинг ещё не опубликован или ссылка неверна.
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Шрифты лежат у нас (см. web/scripts/fetch_landing_fonts.sh) — не
          подтягиваются с Google, чтобы не мигали и не резались у части
          пользователей в РФ. */}
      <link rel="stylesheet" href="/fonts/landing-fonts.css" />
      {preview && <PreviewBar />}
      <LandingRenderer data={data} slug={params.slug}
                       pid={searchParams.pid || null}
                       contactId={searchParams.c || null}
                       tgId={searchParams.tg_id || null}
                       vkId={searchParams.vk_id || null}
                       maxId={searchParams.max_id || null}
                       utmSource={searchParams.utm_source || null}
                       forPdf={forPdf}
                       pageUrl={pageUrl} />
    </>
  )
}
