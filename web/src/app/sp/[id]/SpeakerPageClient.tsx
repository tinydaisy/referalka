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

type Photo = { id: number; url: string; label: string | null; is_primary: boolean }
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
  social_links: Record<string, any>
  media_assets: MediaAsset[]
  photos: Photo[]
}

const DARK = 'linear-gradient(45deg, #25455D, #0a1520)'

// Названия площадок для блока охватов. Внутренние ключи вида plusson_tg —
// это наши каналы, они организатору ничего не говорят, поэтому пропускаем.
const PLATFORM_LABEL: Record<string, string> = {
  tg: 'Telegram', youtube: 'YouTube', vk: 'ВКонтакте',
  tiktok: 'TikTok', instagram: 'Instagram', max: 'MAX', rutube: 'Rutube',
}

export default function SpeakerPageClient({ data }: { data: Data }) {
  const displayName = data.name || data.brand_name || 'Спикер'
  const photos = data.photos?.length
    ? data.photos
    : (data.owner_photo_url ? [{ id: 0, url: data.owner_photo_url, label: null, is_primary: true }] : [])

  const achievements = (data.owner_achievements || []).filter(a => a?.value || a?.label)
  const assets = (data.media_assets || []).filter(
    a => a?.platform && !a.platform.startsWith('plusson_') && Number(a.subscribers) > 0
  )
  const channels = collectChannels(data.social_links || {})

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Шапка */}
      <header className="text-white" style={{ background: DARK }}>
        <div className="max-w-4xl mx-auto px-5 sm:px-8 py-10 sm:py-14">
          <h1 className="text-3xl sm:text-4xl font-bold">{displayName}</h1>
          {data.brand_name && data.brand_name !== data.name && (
            <p className="mt-1 text-white/60">{data.brand_name}</p>
          )}
          {data.owner_positioning && (
            <p className="mt-3 text-base sm:text-lg text-white/80 max-w-2xl">{data.owner_positioning}</p>
          )}
          <p className="mt-5 text-xs text-white/50">
            Материалы для организаторов — скачивайте и копируйте, что нужно
          </p>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 sm:px-8 py-8 sm:py-12 space-y-8">

        {/* Фото */}
        {photos.length > 0 && (
          <Section title="Фото">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {photos.map(p => (
                <div key={p.id} className="rounded-xl overflow-hidden border border-gray-200 bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url} alt={p.label || displayName} className="w-full aspect-[3/4] object-cover" />
                  <div className="p-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-gray-500 truncate">{p.label || 'Фото'}</span>
                    <DownloadBtn url={p.url} name={`${displayName}-фото`} />
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Логотипы — каждый на своём фоне */}
        {(data.brand_logo_url || data.brand_logo_light_url) && (
          <Section title="Логотипы">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {data.brand_logo_light_url && (
                <LogoCard url={data.brand_logo_light_url} name={displayName}
                          caption="Для тёмного фона" background={DARK} />
              )}
              {data.brand_logo_url && (
                <LogoCard url={data.brand_logo_url} name={displayName}
                          caption="Для светлого фона" background="#ffffff" bordered />
              )}
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
        {data.bio && (
          <Section title="О спикере" action={<CopyBtn text={stripTags(data.bio)} label="Скопировать" />}>
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

        {/* Охваты */}
        {assets.length > 0 && (
          <Section title="Охваты">
            <div className="flex flex-wrap gap-2">
              {assets.map((a, i) => (
                <span key={i} className="px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-sm">
                  <b style={{ color: '#25455D' }}>{Number(a.subscribers).toLocaleString('ru-RU')}</b>
                  <span className="text-gray-500 ml-1.5">
                    {PLATFORM_LABEL[a.platform!] || a.platform}
                  </span>
                </span>
              ))}
            </div>
          </Section>
        )}
      </main>

      <footer className="py-8 text-center text-xs text-gray-400">
        Страница собрана в{' '}
        <a href="https://pluson.ru" className="hover:text-gray-600">iViSiON: ПЛЮСОН</a>
      </footer>
    </div>
  )
}

function Section({ title, action, children }: {
  title: string; action?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
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

/** Убирает теги — организатор копирует чистый текст в свою афишу. */
function stripTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Собирает каналы из social_links: массивы каналов по площадкам + одиночные ссылки. */
function collectChannels(social: Record<string, any>): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = []
  const seen = new Set<string>()

  const push = (name: string, url: any) => {
    const u = String(url || '').trim()
    if (!u || !u.startsWith('http') || seen.has(u)) return
    seen.add(u)
    out.push({ name, url: u })
  }

  for (const [key, fallbackName] of [
    ['telegram_channels', 'Telegram'],
    ['vk_channels', 'ВКонтакте'],
    ['max_channels', 'MAX'],
  ] as const) {
    const list = social[key]
    if (Array.isArray(list)) {
      for (const ch of list) push(ch?.name || fallbackName, ch?.url)
    }
  }

  // Одиночные ссылки старого формата — только если такого адреса ещё нет.
  for (const [key, name] of [
    ['telegram', 'Telegram'], ['vk', 'ВКонтакте'], ['max', 'MAX'],
    ['instagram', 'Instagram'], ['youtube', 'YouTube'], ['website', 'Сайт'],
  ] as const) {
    if (typeof social[key] === 'string') push(name, social[key])
  }

  return out
}
