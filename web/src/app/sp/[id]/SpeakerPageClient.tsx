'use client'
/**
 * Публичная страница спикера — то, что организатор забирает сам.
 *
 * Логотипы показываются на своих фонах: светлый вариант на тёмной плашке,
 * тёмный — на светлой. Организатор сразу видит, какой подойдёт его афише,
 * и не гадает, что скачивать.
 *
 * У картинок кнопка «Скачать», у текстов — «Скопировать», у ссылок ещё и QR.
 * Ничего не надо выделять мышкой или сохранять через правую кнопку.
 */
import { useState } from 'react'
import { Download, Copy, Check, ExternalLink } from 'lucide-react'
import QrCodeButton from '@/components/QrCodeButton'
import SafeHtml from '@/components/SafeHtml'
import { focalCss } from '@/lib/photoFocal'

type Photo = { id: number; url: string; label: string | null; is_primary: boolean; focal?: string | null }
type Logo = { id: number; url: string; label: string | null; on_dark: boolean; is_primary: boolean }
type Channel = { name: string; url: string; platform: string }
type Achievement = { label?: string; value?: string }
type MediaAsset = { platform?: string; subscribers?: number }

interface Data {
  id: number
  name: string | null
  brand_name: string | null
  brand_logo_url: string | null
  brand_logo_light_url: string | null
  owner_photo_url: string | null
  owner_positioning: string | null
  owner_achievements: Achievement[]
  bio: string | null
  /** Позиционирование БРЕНДА — не путать с owner_positioning (про человека). */
  positioning: string | null
  /** Рассказ о проекте (миграция 446). */
  brand_bio: string | null
  social_links: Record<string, any>
  media_assets: MediaAsset[]
  photos: Photo[]
  /** Библиотека версий знака (миграция 449). */
  logos: Logo[]
}

const DARK = 'linear-gradient(45deg, #25455D, #0a1520)'
// Фирменный акцент платформы. Страницу отдают организаторам, и она должна
// выглядеть как бренд клиента, а не как нейтральная админка.
const ACCENT = '#FFCFA4'

export default function SpeakerPageClient({ data }: { data: Data }) {
  const displayName = data.name || data.brand_name || 'Спикер'
  // ⚠️ Фото основателя показываем ВСЕГДА, а не только когда галерея пуста.
  // Раньше загруженная галерея его вытесняла — организатор терял главный
  // портрет, хотя именно он чаще всего и нужен для афиши.
  // Дубль отсекаем по адресу: тот же снимок мог попасть и в галерею.
  const gallery = data.photos || []
  const hasOwnerInGallery = data.owner_photo_url
    ? gallery.some(p => p.url === data.owner_photo_url)
    : true
  const photos = [
    ...(data.owner_photo_url && !hasOwnerInGallery
      ? [{ id: 0, url: data.owner_photo_url, label: 'Основное фото', is_primary: true, focal: (data as any).owner_photo_focal }]
      : []),
    ...gallery,
  ]

  const achievements = (data.owner_achievements || []).filter(a => a?.value || a?.label)
  const channels = collectChannels(data.social_links || {})

  // ⚠️ Логотипы собираем из ДВУХ источников. Библиотека (миграция 449) — то,
  // что клиент загрузил для организаторов; два рабочих поля бренда — знак,
  // который и так стоит в шапках и на афишах. Второе добавляем только если
  // такого адреса нет в библиотеке: иначе один и тот же файл показался бы
  // дважды подряд, и организатор гадал бы, чем они отличаются.
  const logoLib = data.logos || []
  function inLib(url: string | null) {
    return !!url && logoLib.some(l => l.url === url)
  }
  const logos: Logo[] = [
    ...logoLib,
    // `brand_logo_url` — ОСНОВНОЙ (светлый) знак, он рисуется на тёмном фоне;
    // `brand_logo_light_url` — ТЁМНАЯ версия «для светлого фона» (так поле и
    // подписано в кабинете). ⚠️ Слово light в названии колонки вводит в
    // заблуждение — смотреть надо на подпись, иначе организатор скачает не тот.
    ...(data.brand_logo_url && !inLib(data.brand_logo_url)
      ? [{ id: -1, url: data.brand_logo_url, label: 'Для тёмного фона', on_dark: true, is_primary: false }]
      : []),
    ...(data.brand_logo_light_url && !inLib(data.brand_logo_light_url)
      ? [{ id: -2, url: data.brand_logo_light_url, label: 'Для светлого фона', on_dark: false, is_primary: false }]
      : []),
  ]

  // Есть ли вообще что показать в разделе бренда — иначе заголовок повиснет
  // над пустотой.
  const hasBrandInfo = !!(data.brand_name || data.positioning
                          || data.brand_bio || logos.length)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Шапка */}
      <header className="text-white" style={{ background: DARK }}>
        <div className="max-w-4xl mx-auto px-5 sm:px-8 py-10 sm:py-14">
          <div className="flex items-center gap-4">
            {/* Знак у имени — ОСНОВНОЙ (светлый): шапка тёмная, тёмный знак на
                ней не виден. */}
            {data.brand_logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={data.brand_logo_url} alt={displayName}
                   className="h-12 sm:h-14 w-auto shrink-0 object-contain" />
            )}
            <div className="min-w-0">
              <h1 className="text-3xl sm:text-4xl font-bold">{displayName}</h1>
              {data.brand_name && data.brand_name !== data.name && (
                <p className="mt-1 text-white/60">{data.brand_name}</p>
              )}
            </div>
          </div>
          {/* ⚠️ Позиционирование основателя из шапки УБРАНО (решение владельца
              18.09.2026): его место — под именем человека в разделе
              «Информация о спикере». В шапке оно стояло рядом с логотипом
              бренда, и было не разобрать, к кому относится — к человеку или к
              проекту. Здесь остаётся только связка «знак → имя → бренд». */}
          {/* Персиковым — это главная подсказка, ради чего страницу открыли. */}
          <p className="mt-5 text-sm font-medium" style={{ color: ACCENT }}>
            Материалы для организаторов — скачивайте и копируйте, что нужно
          </p>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 sm:px-8 py-8 sm:py-12 space-y-8">

        {/* ═══════════ ИНФОРМАЦИЯ О СПИКЕРЕ ═══════════
            ⚠️ Страница поделена на два раздела (решение владельца 18.09.2026).
            Раньше блоки шли вперемешку — логотипы бренда вклинивались между
            фото человека и его регалиями, и было не понять, где кончается
            «я» и начинается «мы». Порядок такой же, как на витрине
            организатора: сначала человек, потом проект. */}
        <GroupHeading
          title="Информация о спикере"
          name={displayName}
          subtitle={data.owner_positioning}
        />

        {/* Фото */}
        {photos.length > 0 && (
          <Section title="Фото">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {photos.map(p => (
                <div key={p.id} className="rounded-xl overflow-hidden border border-gray-200 bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url} alt={p.label || displayName} className="w-full aspect-[3/4] object-cover"
                       style={{ objectPosition: focalCss(p.focal) }} />
                  <div className="p-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-gray-500 truncate">{p.label || 'Фото'}</span>
                    <DownloadBtn url={p.url} name={`${displayName}-фото`} />
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Регалии */}
        {achievements.length > 0 && (
          <Section title="Регалии"
                   action={<CopyBtn text={achievements.map(a => `${a.value ?? ''} ${a.label ?? ''}`.trim()).join('\n')}
                                    label="Скопировать все" />}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {achievements.map((a, i) => (
                <div key={i} className="bg-white rounded-xl border border-gray-200 p-4">
                  <p className="text-2xl font-bold" style={{ color: '#25455D' }}>{a.value}</p>
                  <p className="text-xs text-gray-500 mt-1 leading-snug">{a.label}</p>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Био. ⚠️ Хранится с разметкой (<b> и переносы) — выводим через SafeHtml,
            иначе организатор увидит сырые теги. Копируется при этом чистый текст:
            он вставляет его в свою афишу, теги там не нужны. */}
        {/* ⚠️ Заголовок «Биография», а не «О спикере»: раздел выше теперь и так
            называется «Информация о спикере», и два похожих заголовка подряд
            читались как повтор.
            ⚠️⚠️ Комментарий стоит ЗДЕСЬ, а не первой строкой внутри
            `{data.bio && (` — там он роняет сборку всей ветки: после `&& (`
            ожидается один родительский тег, а `{/* … */}` им не является. */}
        {data.bio && (
          <Section title="Биография" action={<CopyBtn text={stripTags(data.bio)} label="Скопировать" />}>
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <SafeHtml html={data.bio} className="text-sm text-gray-700 leading-relaxed rich-text" />
            </div>
          </Section>
        )}

        {/* Каналы и соцсети */}
        {channels.length > 0 && (
          <Section title="Каналы и соцсети">
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
              {channels.map((c, i) => (
                <div key={i} className="flex items-center gap-2 px-4 py-3">
                  <ChannelBadge platform={c.platform} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{c.name}</p>
                    <p className="text-xs text-gray-400 truncate">{c.url}</p>
                  </div>
                  <QrCodeButton url={c.url} title={c.name} fileBase={c.name} />
                  <CopyBtn text={c.url} iconOnly />
                  <a href={c.url} target="_blank" rel="noopener noreferrer"
                     title="Открыть"
                     className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition">
                    <ExternalLink size={16} />
                  </a>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ⚠️ Блок «Охваты» убран по решению владельца: цифры подписчиков из
            media_assets вводили в заблуждение — они вносятся вручную, устаревают
            и выглядели как заявленный охват. Организатору для афиши они не нужны. */}

        {/* ═══════════ ИНФОРМАЦИЯ О БРЕНДЕ ═══════════ */}
        {hasBrandInfo && (
          <>
            {/* ⚠️ Отступ больше обычного: здесь страница переходит с «я» на
                «мы», и переход должен читаться глазом, а не только по тексту
                заголовка. */}
            <div className="pt-4">
              <GroupHeading
                title="Информация о бренде"
                name={data.brand_name}
                subtitle={data.positioning}
              />
            </div>

            {/* Логотипы — каждый на своей подложке */}
            {logos.length > 0 && (
              <Section title="Логотипы">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {logos.map(l => (
                    <LogoCard key={l.id} url={l.url}
                              name={data.brand_name || displayName}
                              caption={l.label || (l.on_dark ? 'Для тёмного фона' : 'Для светлого фона')}
                              background={l.on_dark ? DARK : '#ffffff'}
                              bordered={!l.on_dark} />
                  ))}
                </div>
              </Section>
            )}

            {/* Текст о проекте. ⚠️ Как и био, хранится с разметкой — выводим
                через SafeHtml, а копируется чистый текст: организатор вставит
                его в свой анонс, теги там не нужны. */}
            {data.brand_bio && (
              <Section title="О проекте"
                       action={<CopyBtn text={stripTags(data.brand_bio)} label="Скопировать" />}>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <SafeHtml html={data.brand_bio}
                            className="text-sm text-gray-700 leading-relaxed rich-text" />
                </div>
              </Section>
            )}
          </>
        )}
      </main>

      <footer className="py-8 text-center text-xs text-gray-400">
        Страница собрана в{' '}
        <a href="https://pluson.ru" className="hover:text-gray-600">iViSiON: ПЛЮСОН</a>
      </footer>
    </div>
  )
}

/**
 * Заголовок большого раздела: «Информация о спикере» / «Информация о бренде».
 *
 * Под ним — к кому раздел относится: у спикера имя человека и его
 * позиционирование, у бренда название проекта и позиционирование бренда.
 * ⚠️ Позиционирование стоит ИМЕННО ЗДЕСЬ, а не в шапке страницы: в шапке оно
 * соседствовало с логотипом бренда, и было не разобрать, чьё оно.
 */
function GroupHeading({ title, name, subtitle }: {
  title: string; name?: string | null; subtitle?: string | null
}) {
  return (
    <div className="border-b-2 pb-3" style={{ borderColor: ACCENT }}>
      <p className="text-xs font-bold uppercase tracking-widest" style={{ color: '#25455D' }}>
        {title}
      </p>
      {name && (
        <h2 className="mt-1.5 text-2xl sm:text-3xl font-bold" style={{ color: '#25455D' }}>
          {name}
        </h2>
      )}
      {subtitle && (
        <p className="mt-1.5 text-sm sm:text-base text-gray-600 max-w-2xl leading-relaxed">
          {subtitle}
        </p>
      )}
    </div>
  )
}

function Section({ title, action, children }: {
  title: string; action?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        {/* Персиковый акцент, а не серый: страница должна читаться как бренд
            клиента. ⚠️ На БЕЛОМ фоне персиковый почти не виден — поэтому здесь
            он идёт по тёмной подложке-плашке, а не голым текстом. */}
        <h2 className="text-sm font-semibold uppercase tracking-wide px-3 py-1 rounded-lg"
            style={{ background: DARK, color: ACCENT }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function LogoCard({ url, name, caption, background, bordered }: {
  url: string; name: string; caption: string; background: string; bordered?: boolean
}) {
  return (
    <div className={`rounded-xl overflow-hidden ${bordered ? 'border border-gray-200' : ''} bg-white`}>
      <div className="flex items-center justify-center p-8" style={{ background }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={name} className="max-h-20 max-w-full object-contain" />
      </div>
      <div className="p-3 flex items-center justify-between gap-2 border-t border-gray-100">
        <span className="text-xs text-gray-500">{caption}</span>
        <DownloadBtn url={url} name={`${name}-логотип`} />
      </div>
    </div>
  )
}

function DownloadBtn({ url, name }: { url: string; name: string }) {
  const [busy, setBusy] = useState(false)

  async function download() {
    setBusy(true)
    try {
      // Качаем в память и отдаём как файл: у ссылки на хранилище свой домен,
      // и атрибут download на ней браузер игнорирует — картинка просто
      // открылась бы в новой вкладке вместо сохранения.
      const resp = await fetch(url)
      const blob = await resp.blob()
      const ext = (url.split('.').pop() || 'jpg').split('?')[0].slice(0, 4)
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = `${name.replace(/[^a-zа-я0-9]+/gi, '_')}.${ext}`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(href)
    } catch {
      window.open(url, '_blank')
    } finally { setBusy(false) }
  }

  return (
    <button type="button" onClick={download} disabled={busy} title="Скачать"
      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition disabled:opacity-40">
      <Download size={16} />
    </button>
  )
}

function CopyBtn({ text, label, iconOnly }: { text: string; label?: string; iconOnly?: boolean }) {
  const [done, setDone] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setDone(true); setTimeout(() => setDone(false), 1500)
    })
  }
  if (iconOnly) {
    return (
      <button type="button" onClick={copy} title="Скопировать ссылку"
        className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition">
        {done ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
      </button>
    )
  }
  return (
    <button type="button" onClick={copy}
      className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1.5">
      {done ? <><Check size={13} className="text-green-600" /> Скопировано</> : <><Copy size={13} /> {label}</>}
    </button>
  )
}

/** Убирает теги и хештеги — организатор копирует чистый текст в свою афишу.
 *
 * ⚠️ Хештеги ПОКАЗЫВАЕМ (они часть авторского текста), но в буфер не кладём:
 * организатор вставляет био в афишу или программу, где чужие #метки не нужны
 * и выглядят мусором. Разметка при этом рендерится через SafeHtml — на экране
 * человек видит оформленный текст, а копирует голый.
 */
function stripTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    // Хештег = # + буквы/цифры/подчёркивание, кириллица тоже. Решётку внутри
    // слова (цвет #FFCFA4, «дом №5») не трогаем — только отдельные метки.
    .replace(/(^|\s)#[\wа-яёА-ЯЁ][\wа-яёА-ЯЁ-]*/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Собирает каналы из social_links: массивы каналов по площадкам + одиночные ссылки.
 *
 * Вместе с названием отдаём КОД ПЛОЩАДКИ — по нему рисуется её значок. Названия
 * каналов клиент пишет свои («ПЛЮСОН СЕРВИС»), и по одному тексту непонятно,
 * куда ведёт ссылка; значок читается мгновенно.
 */
function collectChannels(social: Record<string, any>): Channel[] {
  const out: Channel[] = []
  const seen = new Set<string>()

  const push = (name: string, url: any, platform: string) => {
    const u = String(url || '').trim()
    if (!u || !u.startsWith('http') || seen.has(u)) return
    seen.add(u)
    out.push({ name, url: u, platform })
  }

  for (const [key, fallbackName, platform] of [
    ['telegram_channels', 'Telegram', 'telegram'],
    ['vk_channels', 'ВКонтакте', 'vk'],
    ['max_channels', 'MAX', 'max'],
  ] as const) {
    const list = social[key]
    if (Array.isArray(list)) {
      for (const ch of list) push(ch?.name || fallbackName, ch?.url, platform)
    }
  }

  // Одиночные ссылки старого формата — только если такого адреса ещё нет.
  for (const [key, name] of [
    ['telegram', 'Telegram'], ['vk', 'ВКонтакте'], ['max', 'MAX'],
    ['instagram', 'Instagram'], ['youtube', 'YouTube'], ['website', 'Сайт'],
  ] as const) {
    if (typeof social[key] === 'string') push(name, social[key], key)
  }

  return out
}

/** Значок площадки: цветной кружок с буквой.
 *
 * ⚠️ Своих SVG-иконок соцсетей в проекте нет, а тянуть картинки с чужих сайтов
 * нельзя — они отвалятся вместе с чужим хостингом. Кружок в фирменном цвете
 * площадки решает задачу «сразу видно, куда ведёт ссылка».
 */
const PLATFORM_BADGE: Record<string, { letter: string; bg: string }> = {
  telegram:  { letter: 'T', bg: '#2AABEE' },
  vk:        { letter: 'B', bg: '#0077FF' },
  max:       { letter: 'M', bg: '#7B61FF' },
  instagram: { letter: 'I', bg: '#C13584' },
  youtube:   { letter: 'Y', bg: '#FF0000' },
  website:   { letter: '@', bg: '#25455D' },
}

function ChannelBadge({ platform }: { platform: string }) {
  const b = PLATFORM_BADGE[platform] || PLATFORM_BADGE.website
  return (
    <span
      className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold"
      style={{ background: b.bg }}
      aria-hidden
    >
      {b.letter}
    </span>
  )
}
