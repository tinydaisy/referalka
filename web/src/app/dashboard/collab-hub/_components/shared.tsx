'use client'
import { useState, useEffect, useRef } from 'react'
import { Search, Star, Send, MapPin, Check, X, Sparkles, Users, Calendar, Pencil, ChevronDown, ChevronUp, ExternalLink, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import MediaAssetsField from '@/components/MediaAssetsField'
import { MultiSelectDropdown } from '@/components/MultiSelectDropdown'
import SafeHtml from '@/components/SafeHtml'
import HtmlTextArea from '@/components/HtmlTextArea'

export const PEACH = '#FFCFA4'
export const DARK = '#25455D'

/** Фирменный цвет с прозрачностью — для тонких линий и подложек. */
export function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

// Лайтбокс для фото
export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-6" onClick={onClose}>
      <img src={src} alt="" className="max-w-full max-h-full rounded-2xl object-contain" onClick={e => e.stopPropagation()} />
      <button onClick={onClose} className="absolute top-4 right-4 text-white/80 hover:text-white"><X className="w-7 h-7" /></button>
    </div>
  )
}

export const CATEGORIES: Record<string, string> = {
  offline_business: 'Офлайн-бизнес', online_business: 'Онлайн-бизнес', freelancer: 'Фрилансер', private_practice: 'Частный практик', consultant: 'Консультант', expert: 'Эксперт',
}
export const TIERS: Record<string, string> = {
  under_1k: 'до 1 000', '1k_5k': 'до 5 000', '5k_10k': '5–10 тыс', over_10k: 'выше 10 тыс',
}

export function HubHeader({ subtitle }: { subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold mb-1" style={{ color: DARK }}>Коллабораторная</h1>
      <p className="text-gray-500 text-sm">{subtitle}</p>
    </div>
  )
}

export function MediaTierBadge({ tier }: { tier?: string }) {
  if (!tier) return null
  return <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600"><Users className="w-3 h-3" /> {TIERS[tier] || tier}</span>
}

/** Био/регалии основателя = СПИСОК СТРОК. В профиле каждая регалия введена с новой
 *  строки (часто с ведущим «•»). Режем строго по переносам строк, ведущий маркер
 *  срезаем — «•» ВНУТРИ строки («7 конференций • 50+ лидеров») остаётся текстом.
 *  Раньше резали по «•» и игнорировали \n → всё слипалось в кучу. */
export function bioLines(bio: string): string[] {
  return (bio || '')
    .split(/\r?\n/)
    .map(s => s.replace(/^\s*[•·‣\-–—*]\s*/, '').trim())
    .filter(Boolean)
}

/** Био списком: свёрнуто — первые 2 строки, развёрнуто — все.
 *
 *  ⚠️ Если регалии сохранены С РАЗМЕТКОЙ (редактор в режиме `web`), резать их
 *  по переносам нельзя — теги вылезли бы текстом, а свой маркер «•» встал бы
 *  рядом с маркером списка. Такой текст отдаём в SafeHtml как есть.
 *  Старые записи (обычный текст) продолжают работать по-прежнему. */
// ⚠️ `open` больше не влияет на обрезку (её задаёт вызывающий через line-clamp),
// но параметр оставлен: его передают несколько мест, и убрать его — значит
// править их все ради ничего.
export function BioBlock({ bio, className = '' }: { bio: string; open?: boolean; className?: string }) {
  // ⚠️ Регалии выглядят ОДИНАКОВО, есть в них теги или нет: те же синие точки,
  // тот же размер. Раньше добавленный <b> переключал показ на другую ветку —
  // маркеры-точки пропадали, и карточка менялась на вид от одной правки текста.
  // Поэтому режем по строкам ВСЕГДА, а каждую строку отдаём в SafeHtml: он
  // покажет разметку, если она есть, и обычный текст, если её нет.
  const lines = bioLines(bio)
  if (lines.length === 0) return null
  // ⚠️ Обрезкой занимается ВЫЗЫВАЮЩИЙ (обёртка с line-clamp): своя обрезка
  // внутри конфликтовала бы с внешней — блок резался дважды и по разным
  // правилам (по ПУНКТАМ здесь и по СТРОКАМ снаружи), из-за чего высота
  // карточек всё равно расходилась.
  const shown = lines
  return (
    <ul className={`text-sm text-gray-500 space-y-1 list-none ${className}`}>
      {shown.map((line, i) => (
        <li key={i} className="flex gap-1.5">
          {/* Маркер — фирменный синий: персиковый на белом почти не виден. */}
          <span style={{ color: DARK }} className="shrink-0">•</span>
          <SafeHtml html={line} />
        </li>
      ))}
    </ul>
  )
}

/**
 * Персиковый блок карточки каталога («Что предлагает партнёрам», «Что создаёт
 * и меняет в мире», «Капелька безумия»).
 *
 * ⚠️ Свёрнут до ФИКСИРОВАННЫХ 3 строк у всех блоков и у всех карточек —
 * иначе участник с длинным текстом растягивал свою карточку, и ряд каталога
 * разъезжался по высоте. Разворачивается по «Подробнее». Столько же строк
 * у регалий (BioBlock) — блоки в карточке должны выглядеть одинаково.
 *
 * ⚠️ «Подробнее» показываем по РЕАЛЬНОЙ высоте текста (scrollHeight против
 * clientHeight), а не по длине строки: в HTML-тексте символы считать
 * бессмысленно — теги в длину входят, а переносы строк нет, и кнопка
 * появлялась там, где текст и так помещался целиком.
 */
export function PeachBlock({ title, html, first = false, tone = 'peach' }: { title: string; html: string; first?: boolean; tone?: 'peach' | 'blue' }) {
  const [open, setOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Голубой — светлые оттенки фирменного синего #25455D. Нужен, чтобы блок
  // «Что предлагает партнёрам» отличался от остальных: это главное, ради чего
  // карточку открывают, а три одинаковых персиковых блока сливались.
  const skin = tone === 'blue'
    ? { bg: '#F1F6FA', border: '#B9CEDD', text: '#25455D' }
    : { bg: '#FFF8F1', border: PEACH,     text: '#C77B3B' }
  useEffect(() => {
    const el = bodyRef.current
    if (!el || open) return
    // +1px — запас на дробную высоту строки, иначе кнопка мигает без нужды.
    setClamped(el.scrollHeight > el.clientHeight + 1)
  }, [html, open])
  if (!html) return null
  return (
    <div className={`${first ? 'mt-3' : 'mt-2'} rounded-xl px-3 py-2`}
         style={{ background: skin.bg, border: `1px solid ${skin.border}` }}>
      {/* Заголовки блоков — ЗАГЛАВНЫМИ: так они читаются как рубрики карточки,
          а не как часть текста под ними. uppercase в CSS, а не в самой строке —
          заголовок остаётся редактируемым в одном месте. */}
      <div className="text-[11px] font-semibold mb-0.5 uppercase tracking-wide" style={{ color: skin.text }}>{title}</div>
      {/* ⚠️ Обрезка висит на ОБЁРТКЕ, которую и меряем. SafeHtml не принимает
          ref, а меряя обёртку вокруг обрезанного ребёнка, мы всегда получали
          бы scrollHeight === clientHeight — кнопка «Подробнее» не появлялась
          бы никогда. */}
      <div ref={bodyRef} className={open ? '' : 'line-clamp-3'}>
        <SafeHtml className="text-sm" style={{ color: skin.text }} html={html} />
      </div>
      {(clamped || open) && (
        <button onClick={() => setOpen(!open)} className="text-xs mt-1 inline-flex items-center gap-0.5" style={{ color: skin.text }}>
          {open ? <>Свернуть <ChevronUp className="w-3 h-3" /></> : <>Подробнее <ChevronDown className="w-3 h-3" /></>}
        </button>
      )}
    </div>
  )
}

/** Справочник ниш slug→title. Грузится один раз на модуль — карточке не нужно
 *  прокидывать ниши пропсами через каждый список (каталог, сват, запросы). */
let _nichesCache: Record<string, string> | null = null
let _nichesPromise: Promise<Record<string, string>> | null = null
export function useNicheTitles(): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>(_nichesCache || {})
  useEffect(() => {
    if (_nichesCache) { setMap(_nichesCache); return }
    if (!_nichesPromise) {
      _nichesPromise = api.collabHub.niches()
        .then((r: any) => {
          _nichesCache = Object.fromEntries((r.niches || []).map((n: any) => [n.slug, n.title]))
          return _nichesCache!
        })
        .catch(() => ({}))
    }
    _nichesPromise.then(setMap)
  }, [])
  return map
}

export function CollabCard({ item, onRequest }: { item: any; onRequest?: () => void }) {
  const isMe = item.is_me
  const hadCollabs = (item.collabs_count || 0) > 0
  // Win-Win коэффициент (миграция 268): 1.00 = сработал вровень с партнёрами.
  // Не процент: старая метрика наказывала за размер команды.
  const contribution = hadCollabs && item.win_win != null ? Number(item.win_win).toFixed(2) : '—'
  const achievements: any[] = Array.isArray(item.achievements) ? item.achievements : []
  const [bioOpen, setBioOpen] = useState(false)
  const [bioClamped, setBioClamped] = useState(false)
  const bioRef = useRef<HTMLDivElement>(null)
  const [lightbox, setLightbox] = useState(false)
  const niches = useNicheTitles()
  const bio = item.bio || ''
  // «Подробнее» — по РЕАЛЬНОЙ высоте, как у персиковых блоков: считать пункты
  // нельзя, один длинный пункт занимает три строки, а три коротких — одну.
  useEffect(() => {
    const el = bioRef.current
    if (!el || bioOpen) return
    setBioClamped(el.scrollHeight > el.clientHeight + 1)
  }, [bio, bioOpen])
  // Заголовок карточки — ИМЯ ОСНОВАТЕЛЯ; название проекта — отдельной строкой.
  const ownerName = item.owner_name || item.name
  const project = item.brand_name && item.brand_name !== ownerName ? item.brand_name : null
  const about = item.hub_about || ''
  const impact = item.hub_impact || ''   // бэк уже вернул null если скрыто галочкой
  const wow = item.hub_wow || ''
  return (
    <div className={`rounded-2xl p-4 transition flex flex-col ${isMe ? 'border-2' : 'border bg-white hover:shadow-md'}`}
         style={isMe ? { borderColor: PEACH, background: '#FFF8F1' } : {}}>
      {isMe && <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="text-[11px] font-semibold inline-flex items-center gap-1" style={{ color: '#C77B3B' }}><Star className="w-3 h-3" fill={PEACH} stroke={PEACH} />ВАША КАРТОЧКА</span>
        {item.is_published_in_hub === false && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-600">не опубликована</span>}
      </div>}
      {/* ⚠️ ВЫСОТА ШАПКИ ФИКСИРОВАНА (h-32): имя + проект + позиционирование +
          плашки занимают одинаковое место у ВСЕХ. Резерва по строкам не
          хватало: у кого не заполнены ни проект, ни позиционирование, блок
          схлопывался по высоте фото — плашки и разделительная линия
          оказывались выше, чем у соседей, и ряд выглядел разъехавшимся. */}
      <div className="flex items-start gap-3 h-32">
        {item.photo_url
          ? <img src={item.photo_url} alt="" onClick={() => setLightbox(true)} className="w-14 h-14 rounded-xl object-cover cursor-zoom-in hover:opacity-90" />
          : <div className="w-14 h-14 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400"><Users className="w-6 h-6" /></div>}
        {/* ⚠️ ШАПКА ФИКСИРОВАННОЙ ВЫСОТЫ. Имя + проект + позиционирование
            занимают одинаковое место у ВСЕХ, даже если что-то не заполнено, —
            иначе плашки категории/ниши, а за ними и все блоки карточки,
            начинались бы у каждого на своей высоте, и ряд выглядел
            разъехавшимся. Пустые строки просто остаются пустыми. */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Имя ОСНОВАТЕЛЯ — заголовок; название проекта — отдельной строкой. */}
          <div className="font-semibold" style={{ color: DARK }}>{ownerName}</div>
          {/* Название проекта — целиком (в форме предел 60 символов), место
              под одну строку резервируем, чтобы шапки совпадали по высоте. */}
          <div className="text-xs text-gray-600 min-h-[1rem]">
            {project ? <>Проект: <span className="font-medium">{project}</span></> : ''}
          </div>
          {/* ⚠️ Позиционирование показывается ЦЕЛИКОМ (до 140 символов —
              столько разрешает форма), НЕ обрезаем. Но место под него
              одинаковое у всех: иначе плашки категории и ниши у каждого
              вставали на своей высоте — у кого текст в строку, у кого в
              четыре. Пустое место просто остаётся пустым. */}
          <div className="text-xs text-gray-500 mt-0.5 min-h-[4rem]">
            {item.positioning || ''}
          </div>
          {/* ⚠️ Теги в ОДНУ строку с прокруткой вправо, а не переносом: ниш
              можно выбрать несколько, и при переносе строка тегов росла вниз —
              у одного участника в один ряд, у другого в три, и карточки снова
              разъезжались. Город здесь же, на одном уровне с категорией. */}
          <div className="flex items-center gap-1 mt-auto pt-1 overflow-x-auto whitespace-nowrap [&>*]:shrink-0">
            {item.hub_category && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: PEACH, color: DARK }}>{CATEGORIES[item.hub_category] || item.hub_category}</span>}
            {/* Ниша — раньше не показывалась в карточке вообще */}
            {(item.hub_niches?.length ? item.hub_niches : (item.hub_niche ? [item.hub_niche] : [])).map((sl: string) => (
              <span key={sl} className="text-xs px-2 py-0.5 rounded-full border" style={{ borderColor: PEACH, color: '#C77B3B' }}>{niches[sl] || sl}</span>
            ))}
            <MediaTierBadge tier={item.media_tier} />

            {/* Город — рядом с нишей, а не в подвале карточки: там он терялся
                под цифрами коллабораций, и найти земляка в списке было нельзя. */}
            {item.hub_city && (
              <span className="text-xs text-gray-500 inline-flex items-center gap-1">
                <MapPin className="w-3 h-3" />{item.hub_city}
              </span>
            )}
          </div>
        </div>
      </div>
      {/* ⚠️ Разделительные линии делят карточку на три части: кто это →
          что предлагает → результаты. Фирменный синий, полупрозрачный —
          строгая линия резала бы глаз в лёгкой карточке. Линии помогают
          сравнивать карточки построчно, а не искать глазами границы блоков. */}
      <div className="mt-3 border-t" style={{ borderColor: hexA(DARK, 0.18) }} />
      {/* Персиковые блоки — НАД регалиями. Все три свёрнуты до одинаковой
          высоты и разворачиваются по «Подробнее»: иначе длинный текст у
          одного участника растягивал его карточку, и ряд каталога разъезжался. */}
      <PeachBlock title="Что предлагает партнёрам" html={about} first tone="blue" />
      <PeachBlock title="Что создаёт и меняет в мире" html={impact} />
      <PeachBlock title="Капелька безумия / WOW-факт" html={wow} />
      <div className="mt-3 border-t" style={{ borderColor: hexA(DARK, 0.18) }} />
      {/* Био/регалии — КАЖДАЯ С НОВОЙ СТРОКИ (режем по \n, не по «•»).
          ⚠️ РОВНО 4 СТРОКИ У ВСЕХ, дальше «Подробнее» (решение владельца:
          эталон — заполненная карточка, полотна быть не должно). Число строк
          одинаково независимо от того, сколько человек написал о себе. */}
      {bio && (
        <div className="mt-2">
          {/* clamp — на обёртке, которую и меряем (BioBlock не принимает ref). */}
          {/* ⚠️ Ограничение по ВЫСОТЕ (4 строки ≈ 5rem), а не line-clamp:
              line-clamp режет только сплошной текст и НЕ действует на список
              <ul> из отдельных пунктов. Из-за этого у одних участников
              регалии показывались целиком, у других обрезались — правило
              выглядело случайным. */}
          <div ref={bioRef}
               style={bioOpen ? undefined : { maxHeight: '5rem', overflow: 'hidden' }}>
            <BioBlock bio={bio} />
          </div>
          {(bioClamped || bioOpen) && <button onClick={() => setBioOpen(!bioOpen)} className="text-xs mt-1 inline-flex items-center gap-0.5 shrink-0" style={{ color: '#C77B3B' }}>
            {bioOpen ? <>Свернуть <ChevronUp className="w-3 h-3" /></> : <>Подробнее <ChevronDown className="w-3 h-3" /></>}
          </button>}
        </div>
      )}
      {/* ⚠️ ПОДВАЛ ПРИЖАТ К НИЗУ: цифры, рейтинг и кнопки стоят на одном уровне
          у всех карточек ряда, сколько бы текста ни было выше. Над ним —
          разделительная линия. */}
      <div className="mt-auto" />
      <div className="mt-3 border-t" style={{ borderColor: hexA(DARK, 0.18) }} />
      {achievements.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {/* ⚠️ До 6 цифр — столько же, сколько человек может ввести в форме.
              Раньше показывались 4, и часть введённого молча пропадала. */}
          {achievements.slice(0, 6).map((a: any, i: number) => (
            <span key={i} className="text-[11px] px-2 py-1 rounded-lg bg-gray-50 text-gray-600">
              {a.value ? <b style={{ color: DARK }}>{a.value}</b> : null} {a.label}
            </span>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 mt-3">
        <div className="rounded-xl bg-gray-50 p-2 text-center">
          <div className="font-bold text-sm" style={{ color: DARK }}>{item.collabs_count ?? 0}</div>
          <div className="text-[10px] text-gray-500 leading-tight">коллабораций</div>
        </div>
        <div className="rounded-xl bg-gray-50 p-2 text-center" title="Win-Win коэффициент: во сколько раз организатор привёл больше или меньше среднего по коллаборации. 1.00 — сработал вровень с партнёрами, выше — вытянул коллабу на себе. Число партнёров на коэффициент не влияет.">
          <div className="font-bold text-sm" style={{ color: DARK }}>{contribution}</div>
          <div className="text-[10px] text-gray-500 leading-tight">Win-Win</div>
        </div>
      </div>
      {/* ⚠️ Строка рейтинга занимает место ВСЕГДА, даже когда оценок ещё нет:
          иначе у карточки без рейтинга кнопки поднимались выше, чем у соседа,
          и ряд снова выглядел неровным. */}
      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500 min-h-[1.25rem]">
        {item.avg_rating && (
          <span className="inline-flex items-center gap-1"><Star className="w-3 h-3" fill={PEACH} stroke={PEACH} />{item.avg_rating}</span>
        )}
      </div>
      {isMe ? (
        <a href="/dashboard/collab-hub/card" className="mt-3 w-full text-sm py-2 rounded-xl border text-center" style={{ borderColor: PEACH, color: '#C77B3B' }}>Редактировать карточку</a>
      ) : (
        <div className="flex gap-2 mt-3">
          <a href={`/dashboard/collab-hub/org/${item.client_id}`} className="flex-1 text-sm py-2 rounded-xl border text-center hover:bg-gray-50">Профиль</a>
          {onRequest && <button onClick={onRequest} className="flex-1 text-sm py-2 rounded-xl text-white" style={{ background: DARK }}>Предложить</button>}
        </div>
      )}
      {lightbox && item.photo_url && <Lightbox src={item.photo_url} onClose={() => setLightbox(false)} />}
    </div>
  )
}

export function RequestModal({ target, onClose }: { target: any; onClose: () => void }) {
  const [events, setEvents] = useState<any[]>([])
  const [eventId, setEventId] = useState('')
  const [msg, setMsg] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  // В списке — только мои СУЩЕСТВУЮЩИЕ коллабы (is_collab), куда можно добавить ещё партнёра.
  // Обычные/прошедшие события сюда не идут — для новой коллабы выбирают «Без события».
  useEffect(() => {
    api.collabHub.collabs()
      .then((r: any) => setEvents((r.collabs || []).map((c: any) => ({ id: c.event_id, title: c.title }))))
      .catch(() => setEvents([]))
  }, [])
  const send = async () => {
    setErr('')
    try { await api.collabHub.createRequest({ to_client_id: target.client_id, event_id: eventId ? Number(eventId) : null, message: msg || null }); setSent(true) }
    catch (e: any) { setErr(e?.message || 'Ошибка') }
  }
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-lg" style={{ color: DARK }}>Предложить коллаборацию</h3>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        {sent ? (
          <div className="text-center py-4">
            <Check className="w-10 h-10 mx-auto mb-2 text-green-500" />
            <p className="text-gray-700">Запрос отправлен <b>{target.name}</b>. Будет «серым», пока не ответят.</p>
            <button onClick={onClose} className="mt-4 px-4 py-2 rounded-xl text-white" style={{ background: DARK }}>Готово</button>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-600 mb-3">Кому: <b>{target.name}</b></p>
            <label className="block text-sm text-gray-500 mb-1">Присоединить к коллабе</label>
            <select value={eventId} onChange={e => setEventId(e.target.value)} className="w-full border rounded-xl px-3 py-2 text-sm mb-3">
              <option value="">Новая коллаба (создастся при принятии)</option>
              {events.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}
            </select>
            <textarea value={msg} onChange={e => setMsg(e.target.value)} placeholder="Сообщение (необязательно)" className="w-full border rounded-xl px-3 py-2 text-sm mb-3" rows={3} />
            {err && <p className="text-red-500 text-sm mb-2">{err}</p>}
            <button onClick={send} className="w-full py-2.5 rounded-xl text-white font-medium" style={{ background: DARK }}>Отправить запрос</button>
          </>
        )}
      </div>
    </div>
  )
}

export function CatalogView() {
  const [items, setItems] = useState<any[]>([])
  const [me, setMe] = useState<any | null>(null)
  const [niches, setNiches] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [f, setF] = useState<Record<string, string>>({})
  const [reqTarget, setReqTarget] = useState<any | null>(null)
  const load = async () => {
    setLoading(true)
    try { const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v)); const r: any = await api.collabHub.catalog(clean as any); setItems(r.items || []); setMe(r.me || null) } catch { setItems([]) }
    setLoading(false)
  }
  useEffect(() => { api.collabHub.niches().then((r: any) => setNiches(r.niches || [])).catch(() => {}) }, [])
  useEffect(() => { load() }, [f])
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        {/* ⚠️ Все фильтры — МНОЖЕСТВЕННЫЕ: партнёра ищут сразу в двух-трёх
            нишах, а не по одной за раз. Значения уходят на бэк строкой через
            запятую; там же выбранное «или-или» внутри одного фильтра. */}
        <MultiSelectDropdown
          label="Ниши" placeholder="Все ниши"
          options={niches.map(n => ({ value: n.slug, label: n.title }))}
          values={(f.niche || '').split(',').filter(Boolean)}
          onChange={next => setF({ ...f, niche: next.join(',') })}
        />
        <MultiSelectDropdown
          label="Категории" placeholder="Все категории"
          options={Object.entries(CATEGORIES).map(([k, v]) => ({ value: k, label: v }))}
          values={(f.category || '').split(',').filter(Boolean)}
          onChange={next => setF({ ...f, category: next.join(',') })}
        />
        <MultiSelectDropdown
          label="Медийность" placeholder="Любая медийность"
          options={Object.entries(TIERS).map(([k, v]) => ({ value: k, label: v }))}
          values={(f.media_tier || '').split(',').filter(Boolean)}
          onChange={next => setF({ ...f, media_tier: next.join(',') })}
        />
        <input value={f.q || ''} onChange={e => setF({ ...f, q: e.target.value })} placeholder="Поиск по имени…" className="border rounded-xl px-3 py-2 text-sm flex-1 min-w-[150px]" />
      </div>
      {loading ? <div className="text-gray-400 py-10 text-center">Загрузка…</div>
        : <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {me && <CollabCard item={me} />}
            {items.map(it => <CollabCard key={it.client_id} item={it} onRequest={() => setReqTarget(it)} />)}
            {items.length === 0 && !me && <div className="text-gray-400 py-10 text-center col-span-full">Пока никого нет в каталоге по этим фильтрам.</div>}
          </div>}
      {reqTarget && <RequestModal target={reqTarget} onClose={() => setReqTarget(null)} />}
    </div>
  )
}

export function RequestsView() {
  const [dir, setDir] = useState<'incoming' | 'outgoing'>('incoming')
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const load = async () => {
    setLoading(true)
    try { const r: any = await api.collabHub.requests(dir); setRows(r.requests || []) } catch { setRows([]) }
    setLoading(false)
  }
  useEffect(() => { load() }, [dir])
  const [busy, setBusy] = useState<number | null>(null)   // только для accept (долгое создание коллабы)
  const [declineId, setDeclineId] = useState<number | null>(null)  // открыта модалка причины отклонения
  const [aboutCollab, setAboutCollab] = useState<any | null>(null) // модалка «О коллабе»
  const accept = async (id: number) => {
    setBusy(id)
    try { await api.collabHub.respondRequest(id, true); await load() }
    catch (e: any) { alert(e?.message || 'Не удалось') }
    finally { setBusy(null) }
  }
  const doDecline = async (id: number, reason: string) => {
    setDeclineId(null)
    try { await api.collabHub.respondRequest(id, false, reason); await load() }
    catch (e: any) { alert(e?.message || 'Не удалось') }
  }
  const del = async (id: number) => { if (!confirm('Удалить этот запрос?')) return; try { await api.collabHub.deleteRequest(id); load() } catch (e: any) { alert(e?.message || 'Не удалось') } }
  const reconsider = async (id: number) => { if (!confirm('Передумать? Вы выйдете из коллабы, запрос вернётся в «ждёт ответа».')) return; try { await api.collabHub.reconsiderRequest(id); load() } catch (e: any) { alert(e?.message || 'Не удалось') } }
  const chip = (s: string) => { const m: any = { pending: ['Ждёт ответа', 'bg-gray-200 text-gray-600'], accepted: ['Принято', 'bg-green-100 text-green-700'], declined: ['Отклонено', 'bg-red-100 text-red-600'] }; const [t, c] = m[s] || [s, 'bg-gray-100']; return <span className={`text-xs px-2 py-0.5 rounded-full ${c}`}>{t}</span> }
  const fmtDate = (s?: string) => { if (!s) return ''; try { return new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

  const Avatar = ({ r }: { r: any }) => r.other_photo
    ? <img src={r.other_photo} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0" />
    : <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 shrink-0"><Users className="w-5 h-5" /></div>

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setDir('incoming')} className={`px-4 py-2 rounded-xl text-sm ${dir === 'incoming' ? 'text-white' : 'border'}`} style={dir === 'incoming' ? { background: DARK } : {}}>Входящие</button>
        <button onClick={() => setDir('outgoing')} className={`px-4 py-2 rounded-xl text-sm ${dir === 'outgoing' ? 'text-white' : 'border'}`} style={dir === 'outgoing' ? { background: DARK } : {}}>Отправленные</button>
      </div>
      {loading ? <div className="text-gray-400 py-10 text-center">Загрузка…</div>
        : rows.length === 0 ? <div className="text-gray-400 py-10 text-center">{dir === 'incoming' ? 'Входящих запросов нет.' : 'Вы пока никому не предлагали коллаборацию.'}</div>
        : <div className="space-y-2">{rows.map(r => (
          <div key={r.id} className="border rounded-2xl p-4 flex items-start gap-3 bg-white">
            <Avatar r={r} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium" style={{ color: DARK }}>{r.other_name}</span>
                <span className="text-xs text-gray-400">{fmtDate(r.created_at)}</span>
              </div>
              {/* Присоединение к УЖЕ СУЩЕСТВУЮЩЕЙ коллабе — название события + кто уже внутри */}
              {r.event_title && (
                <div className="text-xs text-gray-600 mt-0.5">
                  Коллаба: <span className="font-medium" style={{ color: DARK }}>{r.event_title}</span>
                  {Array.isArray(r.collab_organizers) && r.collab_organizers.length > 0 && (
                    <span className="text-gray-500"> · уже в коллабе: {r.collab_organizers.map((o: any) => o.name).join(', ')}</span>
                  )}
                </div>
              )}
              {r.message && <div className="text-sm text-gray-600 mt-1">{r.message}</div>}
              {/* Причина отклонения — видна обеим сторонам */}
              {r.status === 'declined' && (
                <div className="text-xs text-red-500 mt-1">
                  Причина отказа: {r.decline_reason || 'Причина не указана'}
                  {r.responded_at && <span className="text-gray-400"> · {fmtDate(r.responded_at)}</span>}
                </div>
              )}
              <div className="mt-1 flex items-center gap-2 flex-wrap">
                {chip(r.status)}
                {r.status === 'accepted' && r.event_id && <a href={`/dashboard/events/${r.event_id}`} className="text-xs px-2.5 py-1 rounded-lg border inline-flex items-center gap-1" style={{ color: '#C77B3B', borderColor: PEACH }}>Перейти в коллабу →</a>}
                <a href={`/dashboard/collab-hub/org/${r.other_client_id}`} className="text-xs px-2.5 py-1 rounded-lg border inline-flex items-center gap-1 hover:bg-gray-50"><ExternalLink className="w-3 h-3" />Профиль</a>
                {/* Запрос на присоединение к существующей коллабе — подробности о ней */}
                {r.event_id && r.event_title && (
                  <button onClick={() => setAboutCollab(r)} className="text-xs px-2.5 py-1 rounded-lg border inline-flex items-center gap-1 hover:bg-gray-50" style={{ borderColor: PEACH, color: '#C77B3B' }}>
                    <Calendar className="w-3 h-3" />О коллабе
                  </button>
                )}
                {r.other_tg && <a href={`https://telegram.me/${(r.other_tg||'').replace('@','')}?text=Здравствуйте! По коллаборации в ПЛЮСОН`} target="_blank" rel="noreferrer" className="text-xs px-2.5 py-1 rounded-lg border inline-flex items-center gap-1 text-blue-600"><Send className="w-3 h-3" />Написать в Telegram</a>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {dir === 'incoming' && r.status === 'pending' && (busy === r.id
                ? <span className="text-xs text-gray-500 px-2">Создаём коллабу…</span>
                : <>
                  <button onClick={() => accept(r.id)} className="text-sm px-3.5 py-1.5 rounded-xl text-white font-medium inline-flex items-center gap-1.5 whitespace-nowrap" style={{ background: '#16a34a' }}>
                    <Check className="w-4 h-4" />Принять приглашение
                  </button>
                  <button onClick={() => setDeclineId(r.id)} className="text-sm px-3 py-1.5 rounded-xl border text-red-500" title="Отклонить"><X className="w-4 h-4" /></button>
                </>)}
              {dir === 'incoming' && r.status === 'declined' && <button onClick={() => accept(r.id)} className="text-xs px-3 py-1.5 rounded-xl border" style={{ color: '#16a34a', borderColor: '#16a34a' }}>Передумать — принять</button>}
              {dir === 'incoming' && r.status === 'accepted' && <button onClick={() => reconsider(r.id)} className="text-xs px-3 py-1.5 rounded-xl border text-gray-500" title="Выйти и вернуть в «ждёт ответа»">Передумать</button>}
              {dir === 'outgoing' && r.status !== 'accepted' && <button onClick={() => del(r.id)} className="text-sm px-3 py-1.5 rounded-xl border text-red-500" title="Удалить запрос"><Trash2 className="w-4 h-4" /></button>}
            </div>
          </div>
        ))}</div>}
      {declineId !== null && <DeclineModal onClose={() => setDeclineId(null)} onSubmit={(reason) => doDecline(declineId, reason)} />}
      {aboutCollab && <AboutCollabModal req={aboutCollab} onClose={() => setAboutCollab(null)} />}
    </div>
  )
}

/** «О коллабе» — название события, описание и карточки организаторов, которые уже внутри. */
function AboutCollabModal({ req, onClose }: { req: any; onClose: () => void }) {
  const orgs: any[] = Array.isArray(req.collab_organizers) ? req.collab_organizers : []
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 max-w-lg w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-3 gap-3">
          <div>
            <h3 className="font-bold text-lg" style={{ color: DARK }}>{req.event_title}</h3>
            <p className="text-xs text-gray-400 mt-0.5">Совместное событие</p>
          </div>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        {req.event_description
          ? <p className="text-sm text-gray-600 whitespace-pre-wrap mb-4">{req.event_description}</p>
          : <p className="text-sm text-gray-400 mb-4">Описание пока не заполнено.</p>}
        <div className="text-sm font-medium text-gray-500 mb-2">
          Кто уже в коллабе {orgs.length > 0 && <span className="text-gray-400">({orgs.length})</span>}
        </div>
        {orgs.length === 0 ? (
          <p className="text-sm text-gray-400">Организаторы не найдены.</p>
        ) : (
          <div className="space-y-2">
            {orgs.map(o => (
              <div key={o.client_id} className="flex items-center gap-3 border rounded-xl p-2.5">
                {o.photo_url
                  ? <img src={o.photo_url} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
                  : <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center text-gray-400 shrink-0"><Users className="w-4 h-4" /></div>}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate" style={{ color: DARK }}>{o.name}</div>
                  {o.brand_name && o.brand_name !== o.name && <div className="text-xs text-gray-500 truncate">Проект: {o.brand_name}</div>}
                </div>
                <a href={`/dashboard/collab-hub/org/${o.client_id}`} target="_blank" rel="noreferrer"
                   className="text-xs px-2.5 py-1 rounded-lg border inline-flex items-center gap-1 hover:bg-gray-50 shrink-0">
                  <ExternalLink className="w-3 h-3" />Профиль
                </a>
              </div>
            ))}
          </div>
        )}
        <button onClick={onClose} className="mt-5 w-full py-2.5 rounded-xl text-white font-medium" style={{ background: DARK }}>Закрыть</button>
      </div>
    </div>
  )
}

function DeclineModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-bold text-lg" style={{ color: DARK }}>Отклонить запрос</h3>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <label className="block text-sm text-gray-500 mb-1">Причина отказа (необязательно)</label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Например: не совпадает ниша / нет времени" className="w-full border rounded-xl px-3 py-2 text-sm mb-4" rows={3} />
        <div className="flex gap-2">
          <button onClick={() => onSubmit(reason)} className="flex-1 py-2.5 rounded-xl text-white font-medium" style={{ background: '#ef4444' }}>Отклонить</button>
          <button onClick={onClose} className="px-5 py-2.5 rounded-xl border">Отмена</button>
        </div>
      </div>
    </div>
  )
}


// Запросы соорганизаторов на рассылку по МОЕЙ базе (коллаб-события).
export function BroadcastConfirmationsView() {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const load = () => {
    api.collabHub.broadcastConfirmations()
      .then((r: any) => { setRows(r.confirmations || []); setLoading(false) })
      .catch(() => { setRows([]); setLoading(false) })
  }
  useEffect(() => { load() }, [])
  const respond = async (batchId: string, accept: boolean) => {
    try { await api.collabHub.respondBroadcastConfirmation(batchId, accept); load() }
    catch (e: any) { alert(e?.message || 'Не удалось') }
  }
  if (loading || rows.length === 0) return null
  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold mb-1" style={{ color: DARK }}>Рассылки на подтверждение</h2>
      <p className="text-sm text-gray-500 mb-3">Соорганизаторы просят разослать это по вашей базе. Подтвердите — уйдёт через вашего бота.</p>
      <div className="space-y-3">
        {rows.map(c => (
          <div key={c.confirm_batch_id} className="rounded-xl border-2 p-4 bg-white" style={{ borderColor: PEACH }}>
            <p className="text-sm text-gray-800">
              <b>{c.origin_name || 'Организатор'}</b> — {c.msg_count > 1 ? `пакет из ${c.msg_count} сообщений` : 'сообщение'} по событию «{c.event_title}».
            </p>
            {c.sample_text && <p className="text-xs text-gray-500 mt-1 whitespace-pre-wrap line-clamp-3">{c.sample_text}</p>}
            <div className="flex gap-2 mt-3">
              <button onClick={() => respond(c.confirm_batch_id, true)}
                className="px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ background: DARK }}>
                Подтвердить {c.msg_count > 1 ? 'пакет' : ''}
              </button>
              <button onClick={() => respond(c.confirm_batch_id, false)}
                className="px-4 py-2 rounded-lg border text-sm text-gray-500">Отклонить</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


export function MatchmakerView() {
  const [data, setData] = useState<any>(null)
  const [reqTarget, setReqTarget] = useState<any | null>(null)
  useEffect(() => { api.collabHub.matchmaker().then(setData).catch(() => setData({ suggestions: [] })) }, [])
  if (!data) return <div className="text-gray-400 py-10 text-center">Подбираем партнёров…</div>
  return (
    <div>
      <div className="rounded-2xl p-4 mb-5 text-white" style={{ background: `linear-gradient(45deg, ${DARK}, #0a1520)` }}>
        <div className="flex items-center gap-2 mb-1"><Sparkles className="w-5 h-5" style={{ color: PEACH }} /><b>Умный сват</b></div>
        <p className="text-sm opacity-90">Подбираем по вашей нише и аудитории. {data.my_niche ? '' : 'Заполните нишу в «Моя карточка» для точного подбора.'}</p>
      </div>
      {data.suggestions?.length === 0 ? <div className="text-gray-400 py-10 text-center">Пока некого предложить — каталог наполняется.</div>
        : <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{data.suggestions.map((it: any) => <CollabCard key={it.client_id} item={it} onRequest={() => setReqTarget(it)} />)}</div>}
      {reqTarget && <RequestModal target={reqTarget} onClose={() => setReqTarget(null)} />}
    </div>
  )
}

export function MyCardView() {
  const [card, setCard] = useState<any>(null)
  const [niches, setNiches] = useState<any[]>([])
  // media_assets — медийность КЛИЕНТА (clients.media_assets). Именно её каталог Хаба
  // показывает как «до 1 000 / до 10 000 / …». Раньше поля не было в форме → оно было
  // пустым почти у всех, и в каталоге у всех рисовалась нижняя градация.
  const [form, setForm] = useState<any>({ is_published_in_hub: true, hub_category: '', hub_niche: '', hub_niches: [], hub_city: '', hub_about: '', hub_impact: '', hub_impact_public: true, hub_wow: '', hub_wow_public: true, media_assets: [] })
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')
  const load = async () => {
    const r: any = await api.collabHub.myCard()
    setCard(r.card)
    setForm({ is_published_in_hub: r.card.is_published_in_hub ?? true, hub_category: r.card.hub_category || '', hub_niche: r.card.hub_niche || '', hub_niches: Array.isArray(r.card.hub_niches) ? r.card.hub_niches : (r.card.hub_niche ? [r.card.hub_niche] : []), hub_city: r.card.hub_city || '', hub_about: r.card.hub_about || '', hub_impact: r.card.hub_impact || '', hub_impact_public: r.card.hub_impact_public ?? true, hub_wow: r.card.hub_wow || '', hub_wow_public: r.card.hub_wow_public ?? true, media_assets: Array.isArray(r.card.media_assets) ? r.card.media_assets : [] })
  }
  useEffect(() => { load().catch(() => {}); api.collabHub.niches().then((r: any) => setNiches(r.niches || [])).catch(() => {}) }, [])
  const save = async () => {
    setErr('')
    try {
      await api.collabHub.publishCard(form)
      setSaved(true); setTimeout(() => setSaved(false), 2000)
      load()
    } catch (e: any) { setErr(e?.message || 'Ошибка') }
  }
  if (!card) return <div className="text-gray-400 py-10 text-center">Загрузка…</div>
  const achievements: any[] = Array.isArray(card.achievements) ? card.achievements : []
  const social = card.social_links || {}
  const tg = social.telegram_channels?.[0]?.url || social.telegram
  return (
    <div className="grid lg:grid-cols-2 gap-8">
      <div>
        <div className="text-sm font-medium text-gray-500 mb-2">Так вас увидят в каталоге</div>
        <div className="border rounded-2xl p-5 bg-white">
          <div className="flex items-start gap-4">
            {card.photo_url ? <img src={card.photo_url} alt="" className="w-20 h-20 rounded-2xl object-cover" />
              : <div className="w-20 h-20 rounded-2xl bg-gray-100 flex items-center justify-center text-gray-400"><Users className="w-8 h-8" /></div>}
            <div className="min-w-0">
              {/* Имя ОСНОВАТЕЛЯ; название проекта — отдельной строкой */}
              <div className="font-bold text-lg" style={{ color: DARK }}>{card.owner_name || card.name || '—'}</div>
              {card.brand_name && card.brand_name !== (card.owner_name || card.name) &&
                <div className="text-sm text-gray-600">Проект: <span className="font-medium">{card.brand_name}</span></div>}
              {card.positioning && <div className="text-sm text-gray-500 mt-0.5">{card.positioning}</div>}
              <div className="flex flex-wrap gap-1 mt-1 items-center">
                {form.hub_category && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: PEACH, color: DARK }}>{CATEGORIES[form.hub_category] || form.hub_category}</span>}
                {(form.hub_niches || []).map((sl: string) => (
                  <span key={sl} className="text-xs px-2 py-0.5 rounded-full border" style={{ borderColor: PEACH, color: '#C77B3B' }}>{niches.find(n => n.slug === sl)?.title || sl}</span>
                ))}
                <MediaTierBadge tier={card.media_tier} />
              </div>
            </div>
          </div>
          {/* «Что предлагаете партнёрам» — НАД регалиями, ГОЛУБЫМ (живое превью
              из формы). Цвет тот же, что в каталоге, — превью должно совпадать
              с тем, что увидят партнёры. */}
          {form.hub_about && (
            <div className="mt-4 rounded-xl px-3 py-2" style={{ background: '#F1F6FA', border: '1px solid #B9CEDD' }}>
              <div className="text-[11px] font-semibold mb-0.5 uppercase tracking-wide" style={{ color: DARK }}>Что предлагает партнёрам</div>
              <SafeHtml className="text-sm " style={{ color: DARK }} html={form.hub_about} />
            </div>
          )}
          {/* Импакт и WOW-факт — живое превью; «скрыто» если снята галочка публичности */}
          {form.hub_impact && (
            <div className="mt-3 rounded-xl px-3 py-2" style={{ background: '#FFF8F1', border: `1px solid ${PEACH}` }}>
              <div className="text-[11px] font-semibold mb-0.5 uppercase tracking-wide" style={{ color: '#C77B3B' }}>
                Что создаёт и меняет в мире{!form.hub_impact_public && <span className="ml-1 text-gray-400 font-normal">· скрыто в публичной</span>}
              </div>
              <SafeHtml className={`text-sm  ${form.hub_impact_public ? '' : 'opacity-40'}`} style={{ color: '#C77B3B' }} html={form.hub_impact} />
            </div>
          )}
          {form.hub_wow && (
            <div className="mt-3 rounded-xl px-3 py-2" style={{ background: '#FFF8F1', border: `1px solid ${PEACH}` }}>
              <div className="text-[11px] font-semibold mb-0.5 uppercase tracking-wide" style={{ color: '#C77B3B' }}>
                Капелька безумия / WOW-факт{!form.hub_wow_public && <span className="ml-1 text-gray-400 font-normal">· скрыто в публичной</span>}
              </div>
              <SafeHtml className={`text-sm  ${form.hub_wow_public ? '' : 'opacity-40'}`} style={{ color: '#C77B3B' }} html={form.hub_wow} />
            </div>
          )}
          {/* Регалии — каждая с новой строки (как введены в профиле Основателя). */}
          {card.bio && <BioBlock bio={card.bio} open className="mt-4" />}
          {/* ⚠️ До 6 цифр — столько же, сколько показывает карточка в каталоге
              и сколько можно ввести в форме. Здесь стояло 3, и введённые
              четвёртая-шестая цифры молча исчезали из превью. */}
          {achievements.length > 0 && (
            <div className="grid grid-cols-3 gap-2 mt-4">
              {achievements.slice(0, 6).map((a: any, i: number) => (
                <div key={i} className="rounded-xl bg-gray-50 p-2 text-center">
                  <div className="font-bold text-sm" style={{ color: DARK }}>{a.value}</div>
                  <div className="text-[11px] text-gray-500 leading-tight">{a.label}</div>
                </div>
              ))}
            </div>
          )}
          {tg && <a href={tg} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm mt-4 text-blue-600"><Send className="w-3.5 h-3.5" />Telegram-канал</a>}
        </div>
        <div className="text-xs text-gray-400 mt-3 flex items-start gap-1">
          <Pencil className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          Фото, имя, регалии, био и каналы берутся из вашего профиля. Изменить — в <a href="/dashboard/mini-app" className="underline">Настройки → Mini App</a> (вкладка «Основатель»).
        </div>
      </div>
      <div>
        <div className="text-sm font-medium text-gray-500 mb-2">Параметры для биржи</div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Категория</label>
        <select value={form.hub_category} onChange={e => setForm({ ...form, hub_category: e.target.value })} className="w-full border rounded-xl px-3 py-2 text-sm mb-3">
          <option value="">— не выбрано —</option>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="block text-sm font-medium text-gray-700 mb-1">Ниша</label>
        {/* ⚠️ Ниш можно выбрать НЕСКОЛЬКО: человек редко укладывается в одну
            (психолог работает и с «Отношениями», и со «Здоровьем»). В каталоге
            его найдут по любой из отмеченных. */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {niches.map(n => {
            const on = (form.hub_niches || []).includes(n.slug)
            return (
              <button key={n.slug} type="button"
                onClick={() => setForm((f: any) => ({
                  ...f,
                  hub_niches: on
                    ? (f.hub_niches || []).filter((x: string) => x !== n.slug)
                    : [...(f.hub_niches || []), n.slug],
                }))}
                className="text-xs px-2.5 py-1 rounded-full border transition"
                style={on
                  ? { background: DARK, borderColor: DARK, color: '#fff' }
                  : { borderColor: '#d1d5db', color: '#6b7280' }}>
                {on ? '✓ ' : ''}{n.title}
              </button>
            )
          })}
        </div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Город (для офлайн-коллабораций)</label>
        <input value={form.hub_city} onChange={e => setForm({ ...form, hub_city: e.target.value })} className="w-full border rounded-xl px-3 py-2 text-sm mb-3" />
        {/* ⚠️ ЗДЕСЬ ОБЫЧНЫЕ ПОЛЯ С ТЕГАМИ, А НЕ ВИЗУАЛЬНЫЙ РЕДАКТОР.
            Редактор на contentEditable терял набранный текст: значение уходило
            в сохранение из состояния формы, а не из самого поля. Теги пишутся
            руками, как в рассылках, и проверяются на корректность до сохранения. */}
        <label className="block text-sm font-medium text-gray-700 mb-1">Что предлагаете партнёрам</label>
        <HtmlTextArea rows={5} value={form.hub_about} className="mb-3"
          onChange={v => setForm((f: any) => ({ ...f, hub_about: v }))} />

        <label className="block text-sm font-medium text-gray-700 mb-1">Что я создаю и меняю в стране/мире своей деятельностью и проектами?</label>
        <HtmlTextArea rows={5} value={form.hub_impact} className="mb-1.5"
          onChange={v => setForm((f: any) => ({ ...f, hub_impact: v }))} />
        <label className="flex items-center gap-2 mb-4 text-sm text-gray-600">
          <input type="checkbox" checked={form.hub_impact_public} onChange={e => setForm({ ...form, hub_impact_public: e.target.checked })} />
          Показывать в публичной карточке в каталоге
        </label>

        <label className="block text-sm font-medium text-gray-700 mb-1">Моя «капелька безумия» или WOW-факт</label>
        <HtmlTextArea rows={5} value={form.hub_wow} className="mb-1.5"
          onChange={v => setForm((f: any) => ({ ...f, hub_wow: v }))} />
        <label className="flex items-center gap-2 mb-4 text-sm text-gray-600">
          <input type="checkbox" checked={form.hub_wow_public} onChange={e => setForm({ ...form, hub_wow_public: e.target.checked })} />
          Показывать в публичной карточке в каталоге
        </label>

        {/* Медийные активы — по ним каталог считает градацию охвата («до 1 000», «до 10 000»…).
            Без них у всех показывается нижняя градация. */}
        <label className="block text-sm font-medium text-gray-700 mb-1">Медийные активы</label>
        <p className="text-xs text-gray-500 mb-2">
          Сколько подписчиков на каждой площадке. По этим цифрам в каталоге считается ваш охват.
        </p>
        <div className="mb-4">
          {/* autoCounts — реальные размеры баз ПЛЮСОНа по площадкам. Строки
              «… в ПЛЮСОН» ими и заполняются: цифру считает система, руками
              её не ввести. */}
          <MediaAssetsField value={form.media_assets || []}
                            autoCounts={card?.plusson_base || {}}
                            onChange={(next) => setForm((f: any) => ({ ...f, media_assets: next }))} />
        </div>
        <label className="flex items-center gap-2 mb-4 text-sm">
          <input type="checkbox" checked={form.is_published_in_hub} onChange={e => setForm({ ...form, is_published_in_hub: e.target.checked })} />
          Опубликовать в каталоге
        </label>
        {err && <p className="text-red-500 text-sm mb-2">{err}</p>}
        <button onClick={save} className="px-5 py-2.5 rounded-xl text-white font-medium" style={{ background: DARK }}>{saved ? '✓ Сохранено' : 'Сохранить'}</button>
      </div>
    </div>
  )
}

// Совместные события — где клиент co_owner (>1 владелец)
// Коллабы — совместные события, где я владелец. С ФИО организаторов + выход из коллабы.
export function CollabsView() {
  const [collabs, setCollabs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const load = () => { api.collabHub.collabs().then((r: any) => { setCollabs(r.collabs || []); setLoading(false) }).catch(() => { setCollabs([]); setLoading(false) }) }
  useEffect(() => { load() }, [])
  const leave = async (eventId: number) => {
    if (!confirm('Выйти из этой коллабы? Вы перестанете быть её организатором.')) return
    try { await api.collabHub.leaveCollab(eventId); load() } catch (e: any) { alert(e?.message || 'Не удалось выйти') }
  }
  if (loading) return <div className="text-gray-400 py-10 text-center">Загрузка…</div>
  if (collabs.length === 0) return (
    <div className="text-gray-400 py-10 text-center">
      Коллаб пока нет.<br />
      <span className="text-sm">Коллаба появится, когда вы примете запрос на коллаборацию или ваш будет принят.</span>
    </div>
  )
  return (
    <div className="space-y-2">
      {collabs.map(c => {
        const orgs: any[] = c.organizers || []
        return (
          <div key={c.event_id} className="border rounded-2xl p-4 bg-white">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-gray-400" />
              <a href={`/dashboard/events/${c.event_id}`} className="font-medium hover:underline" style={{ color: DARK }}>{c.title}</a>
              {/* ⚠️ Статус события — из списка было не понять, какая коллаба
                  ещё готовится, какая идёт, а какая уже завершена и учтена
                  в рейтинге. Завершённую нельзя перезапустить сменой даты —
                  для нового захода её копируют. */}
              <span className="text-xs px-2 py-0.5 rounded-full ml-auto"
                style={c.status === 'ended'
                  ? { background: '#E8F0F6', color: DARK }
                  : c.status === 'published'
                    ? { background: '#E7F6EC', color: '#1B7F4C' }
                    : { background: '#F3F4F6', color: '#6B7280' }}>
                {c.status === 'ended' ? 'Завершена' : c.status === 'published' ? 'Опубликована' : 'Черновик'}
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: PEACH, color: DARK }}>Коллаба</span>
            </div>
            {/* ФИО организаторов */}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {orgs.map((o: any) => (
                <a key={o.client_id} href={`/dashboard/collab-hub/org/${o.client_id}`} className="text-xs px-2 py-1 rounded-lg bg-gray-50 hover:bg-gray-100" style={{ color: DARK }}>
                  {o.name}{o.role === 'owner' ? ' (создатель)' : ''}
                </a>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <a href={`/dashboard/events/${c.event_id}`} className="text-sm px-3 py-1.5 rounded-xl text-white" style={{ background: DARK }}>Открыть событие</a>
              <button onClick={() => leave(c.event_id)} className="text-sm px-3 py-1.5 rounded-xl border text-red-500">Выйти из коллабы</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
