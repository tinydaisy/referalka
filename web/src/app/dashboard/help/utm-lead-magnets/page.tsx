'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ExternalLink, Copy, Check, BarChart3 } from 'lucide-react'
import { api } from '@/lib/api'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

type PlatformLinks = { telegram?: string; vk?: string; max?: string }
interface MagnetRow { id: number; name: string; slug: string; platform_links?: PlatformLinks }
interface PackageRow { id: number; name: string; slug: string; platform_links?: PlatformLinks }

// Каналы-пресеты — просто удобные готовые значения для utm_source.
// Клиент может вписать своё в поле «своё значение».
const PRESETS = [
  { value: 'insta',    label: 'Инстаграм' },
  { value: 'telegram', label: 'Телеграм-канал' },
  { value: 'vk',       label: 'ВКонтакте' },
  { value: 'rassylka', label: 'Рассылка' },
  { value: 'youtube',  label: 'YouTube' },
  { value: 'shorts',   label: 'Reels / Shorts' },
] as const

const PLATFORM_LABEL: Record<keyof PlatformLinks, string> = {
  telegram: 'Telegram',
  vk: 'ВКонтакте',
  max: 'MAX',
}

// Добавляем &utm_source=... к готовой ссылке лид-магнита.
// В ссылке уже есть ?to=tg — значит клеим через &.
function withUtm(url: string, source: string): string {
  const src = source.trim()
  if (!src) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}utm_source=${encodeURIComponent(src)}`
}

export default function UtmLeadMagnetsPage() {
  const [magnets, setMagnets] = useState<MagnetRow[]>([])
  const [packages, setPackages] = useState<PackageRow[]>([])
  const [loading, setLoading] = useState(true)

  const [kind, setKind] = useState<'m' | 'p'>('m')
  const [slug, setSlug] = useState('')
  const [preset, setPreset] = useState<string>('insta')
  const [custom, setCustom] = useState('')

  useEffect(() => {
    Promise.all([
      api.leadMagnets.list().then((r: any) => Array.isArray(r) ? r : (r?.items || r?.lead_magnets || [])).catch(() => []),
      api.leadMagnetPackages.list().then((r: any) => Array.isArray(r) ? r : (r?.items || r?.packages || [])).catch(() => []),
    ]).then(([lm, pkg]: [MagnetRow[], PackageRow[]]) => {
      setMagnets(lm || [])
      setPackages(pkg || [])
      if (lm && lm.length) { setKind('m'); setSlug(lm[0].slug) }
      else if (pkg && pkg.length) { setKind('p'); setSlug(pkg[0].slug) }
      setLoading(false)
    })
  }, [])

  const rows = kind === 'm' ? magnets : packages
  const selected = rows.find(r => r.slug === slug)
  const links = selected?.platform_links || {}
  const source = custom.trim() || preset

  const platformKeys = (Object.keys(PLATFORM_LABEL) as (keyof PlatformLinks)[]).filter(k => links[k])

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">UTM-метки в ссылках лид-магнитов</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>UTM-метки в ссылках лид-магнитов</h1>
          <p className="text-sm text-gray-500 mt-1">
            Пометьте одну и ту же ссылку по-разному под каждый канал — и увидите в «Аналитике»,
            откуда пришло больше людей и кто забрал файл.
          </p>
        </div>
      </div>

      {/* Как это работает */}
      <Section step="?" title="Как это работает">
        <p className="text-sm text-gray-700 mb-3">
          Ваша ссылка на лид-магнит выглядит так: <code>pluson.ru/m/x7q9k?to=tg</code>.
          В ней уже есть <code>?to=tg</code> — это площадка. Чтобы добавить метку источника,
          дописываете через <strong><code>&amp;</code></strong>:
        </p>
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 mb-3">
          <code className="text-sm font-mono text-gray-800 break-all">
            pluson.ru/m/x7q9k?to=tg<span style={{ color: '#b45309', fontWeight: 700 }}>&amp;utm_source=insta</span>
          </code>
        </div>
        <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5">
          <li>Первая метка после <code>?to=tg</code> всегда через <code>&amp;</code> (потому что <code>?</code> уже занят площадкой).</li>
          <li>Значение — любое, латиницей без пробелов: <code>insta</code>, <code>telegram</code>, <code>rassylka_maya</code>.</li>
          <li>Можно добавить и другие метки: <code>&amp;utm_medium=…</code>, <code>&amp;utm_campaign=…</code> — все сохраняются.</li>
        </ul>
        <div className="mt-3 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
          ⚠️ Формат <code>_srcinsta</code> — это для <strong>прямых ссылок в бот</strong> (<code>startapp=ref_pg…_srcinsta</code>),
          а не для ссылок лид-магнитов. У лид-магнитов (<code>/m/</code> и <code>/p/</code>) — обычный <code>&amp;utm_source=…</code>.
        </div>
      </Section>

      {/* Генератор */}
      <Section step="●" title="Соберите размеченную ссылку">
        {loading ? (
          <p className="text-sm text-gray-400 italic">Загружаем ваши лид-магниты…</p>
        ) : (magnets.length === 0 && packages.length === 0) ? (
          <p className="text-sm text-gray-600">
            У вас пока нет лид-магнитов. Создайте их в разделе{' '}
            <Link href="/dashboard/lead-magnets" className="text-blue-600 hover:underline">Лид-магниты</Link>.
          </p>
        ) : (
          <>
            {/* Тип: магнит / пакет */}
            {magnets.length > 0 && packages.length > 0 && (
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => { setKind('m'); setSlug(magnets[0].slug) }}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                    kind === 'm' ? 'border-transparent text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                  style={kind === 'm' ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : {}}
                >
                  Лид-магнит
                </button>
                <button
                  onClick={() => { setKind('p'); setSlug(packages[0].slug) }}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                    kind === 'p' ? 'border-transparent text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                  }`}
                  style={kind === 'p' ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : {}}
                >
                  Пакет
                </button>
              </div>
            )}

            {/* Лид-магнит */}
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">
              {kind === 'm' ? 'Лид-магнит' : 'Пакет'}
            </label>
            <select
              value={slug}
              onChange={e => setSlug(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm mb-4 bg-white"
            >
              {rows.map(r => (
                <option key={r.id} value={r.slug}>{r.name} ({r.slug})</option>
              ))}
            </select>

            {/* Источник */}
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">Источник (utm_source)</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
              {PRESETS.map(p => {
                const active = !custom.trim() && preset === p.value
                return (
                  <button
                    key={p.value}
                    onClick={() => { setPreset(p.value); setCustom('') }}
                    className={`text-left rounded-lg border px-3 py-2 transition-all ${
                      active ? 'border-transparent text-white shadow-sm' : 'border-gray-200 bg-white hover:border-gray-300'
                    }`}
                    style={active ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : {}}
                  >
                    <div className="text-sm font-semibold">{p.label}</div>
                    <div className={`text-xs ${active ? 'text-white/70' : 'text-gray-400'}`}>{p.value}</div>
                  </button>
                )
              })}
            </div>
            <input
              value={custom}
              onChange={e => setCustom(e.target.value.replace(/\s+/g, '_'))}
              placeholder="или своё значение, напр. webinar_may"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm mb-4 bg-white"
            />

            {/* Результат по площадкам */}
            {platformKeys.length === 0 ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                У этого лид-магнита пока нет готовых ссылок — подключите своего бота или сообщество в разделе{' '}
                <Link href="/dashboard/channels" className="text-blue-700 hover:underline">Каналы</Link>.
              </div>
            ) : (
              <div className="space-y-3">
                {platformKeys.map(pk => (
                  <div key={pk} className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                    <div className="text-xs font-semibold text-gray-600 mb-2">
                      {PLATFORM_LABEL[pk]} · источник <span style={{ color: '#b45309' }}>{source}</span>
                    </div>
                    <CopyBlock value={withUtm(links[pk]!, source)} />
                  </div>
                ))}
                <p className="text-xs text-gray-400">
                  Готовые ссылки — вставляйте в посты, рассылки, кнопки на лендинге. Метка приедет в «Аналитику» сама.
                </p>
              </div>
            )}
          </>
        )}
      </Section>

      {/* Где смотреть */}
      <Section step="●" title="Где увидеть результат">
        <p className="text-sm text-gray-700 mb-3">
          Всё, что пришло с UTM-меткой, попадает в базу автоматически. Смотреть — в двух местах:
        </p>
        <Link
          href="/dashboard/analytics"
          className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white hover:border-gray-300 p-3 mb-2 transition-colors"
        >
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#f8fafc' }}>
            <BarChart3 size={17} className="text-gray-500" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold" style={{ color: BRAND }}>Раздел «Аналитика»</div>
            <div className="text-xs text-gray-500 leading-snug">
              Сводка по каждому значению метки: сколько зашло в бот и сколько получили файл. Переключатель source / medium / campaign.
            </div>
          </div>
        </Link>
        <Link
          href="/dashboard/clients"
          className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white hover:border-gray-300 p-3 transition-colors"
        >
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#f8fafc' }}>
            👥
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold" style={{ color: BRAND }}>Контакты</div>
            <div className="text-xs text-gray-500 leading-snug">
              Фильтр по UTM-источнику + колонка «Откуда пришёл» в CSV-экспорте.
            </div>
          </div>
        </Link>
      </Section>

      <div className="p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
        <p className="text-sm text-gray-600">
          Напишите в поддержку —{' '}
          <Link href={SUPPORT_URL}
               className="text-blue-600 hover:underline inline-flex items-center gap-1">
              {SUPPORT_LABEL} <ExternalLink size={12}/>
            </Link>
        </p>
      </div>
    </div>
  )
}

function Section({ step, title, children }: { step: string; title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border card-border p-5 mb-4 shadow-sm">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
             style={{ background: PEACH, color: BRAND }}>
          {step}
        </div>
        <h2 className="text-base font-bold" style={{ color: BRAND }}>{title}</h2>
      </div>
      <div className="pl-11">{children}</div>
    </section>
  )
}

function CopyBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <div className="flex gap-2">
      <code className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono overflow-x-auto whitespace-nowrap text-gray-800">
        {value}
      </code>
      <button
        onClick={copy}
        className="px-3 py-2.5 rounded-lg text-white font-medium text-sm flex items-center gap-1.5 flex-shrink-0"
        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        {copied ? <><Check size={15}/> Скопировано</> : <><Copy size={15}/> Копировать</>}
      </button>
    </div>
  )
}
