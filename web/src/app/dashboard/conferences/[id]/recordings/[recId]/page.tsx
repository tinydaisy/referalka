'use client'

/**
 * Нарезка записи эфира по спикерам — ОТДЕЛЬНАЯ СТРАНИЦА.
 *
 * ⚠️ Именно страница, а не модалка: здесь плеер, таймлайн и список кусков —
 * работы на десятки минут. В модалке тесно, её не свернуть, адрес не сохранить
 * и вернуться потом некуда.
 *
 * ⚠️ Зачем вообще. Эфир пишется одним файлом: сначала настройка звука до
 * «Начать эфир», потом открытие, потом выступления подряд. Целиком это никому
 * не отдать — спикеру нужно СВОЁ выступление.
 *
 * ⚠️ Одна палочка = одна граница (решение владельца): кусок начинается там, где
 * кончился предыдущий, перерывы не вырезаются. Конец куска здесь не задаётся —
 * его считает бэкенд из начала следующего.
 *
 * ⚠️ Секунды на таймлайне — ОТ НАЧАЛА ЭФИРА, а не от начала файла: так их видит
 * клиент. Смещение (подготовка до «Начать эфир») прибавляет бэкенд при резке;
 * здесь оно нужно только чтобы перемотать плеер.
 */
import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams, usePathname } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Scissors, ListOrdered, Save, Download, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

type Cut = {
  id?: number
  /** ⚠️ Свой ключ для React, живёт только в браузере. У меток из раскладки по
   *  программе id ещё нет, а индекс и время меняются при перетаскивании —
   *  элемент пересоздавался бы под мышью и терял захват. */
  _k?: number
  start_sec: number
  end_sec?: number | null
  title: string
  speaker_ec_id?: number | null
  session_id?: number | null
  status?: string
  url?: string | null
  duration_sec?: number | null
  size_bytes?: number | null
  error?: string | null
  speaker_name?: string | null
  /** Время слота по расписанию ("11:00") — подпись для сверки с программой.
   *  Приходит с сервера через session_id, копией не хранится. */
  program_time?: string | null
}

const mmss = (s: number) => {
  const t = Math.max(0, Math.floor(s || 0))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`
}

/** "1:23:45" / "12:30" / "750" → секунды. Клиент вписывает время как привык. */
const parseTime = (v: string): number | null => {
  const s = (v || '').trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  const parts = s.split(':').map(x => x.trim())
  if (parts.some(x => !/^\d+$/.test(x))) return null
  const nums = parts.map(x => parseInt(x, 10))
  if (nums.length === 2) return nums[0] * 60 + nums[1]
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2]
  return null
}

/** Выдаёт уникальные номера новым меткам — источник значения Cut._k. */
let _keySeq = 1
const newKey = () => _keySeq++

const fmtSize = (b?: number | null) =>
  !b ? '' : b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} ГБ` : `${Math.round(b / 1024 ** 2)} МБ`

export default function RecordingCutPage() {
  // ⚠️ Next 14.2.3: params читаем через useParams(), НЕ через use(params) —
  // второе появилось в Next 15 и роняет страницу Application error.
  const { id, recId } = useParams<{ id: string; recId: string }>()
  const sp = useSearchParams()
  // ⚠️ Турнир открывается по /dashboard/tournaments, конференция по
  // /dashboard/conferences — страница одна на оба раздела (тонкая обёртка-
  // реэкспорт, как у карточки события). Жёсткий путь увёл бы турнир в чужой.
  const pathname = usePathname()
  const basePath = pathname?.startsWith('/dashboard/tournaments')
    ? '/dashboard/tournaments' : '/dashboard/conferences'
  const eventId = Number(id)
  const recordingId = Number(recId)
  // День комнаты нужен всем эндпоинтам записи. Приходит из ссылки со вкладки.
  const day = Number(sp.get('day') || 1)

  const [cuts, setCuts] = useState<Cut[]>([])
  const [meta, setMeta] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [cur, setCur] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const [videoError, setVideoError] = useState(false)
  // ⚠️ Идёт перемотка. В большом файле она занимает секунды, и без индикатора
  // кажется, что нажатие не сработало.
  const [seeking, setSeeking] = useState(false)
  // Окно «покажите момент» — для записей, у которых система не знает начала эфира.
  const [askAnchor, setAskAnchor] = useState(false)
  const [anchorTime, setAnchorTime] = useState('')
  // Перетаскивание метки по таймлайну.
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  // Метка под курсором — подсвечиваем её и меняем курсор на «руку», чтобы было
  // видно, что схватится именно она.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  // Тянут красный курсор плеера.
  const [scrubbing, setScrubbing] = useState(false)
  const dragStartX = useRef(0)
  const barRef = useRef<HTMLDivElement>(null)
  // ⚠️ После перетаскивания браузер шлёт click по полосе — без этого флага
  // видео перематывалось бы туда, где отпустили мышь.
  const justDragged = useRef(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  // На какой секунде ФАЙЛА начался эфир: плеер живёт в секундах файла,
  // таймлайн — в секундах эфира. Переводим одним слагаемым.
  const offset = meta?.live_offset_sec ?? 0
  const hasOffset = meta?.live_offset_sec !== null && meta?.live_offset_sec !== undefined
  const liveDur = Math.max(1, (meta?.duration_sec || 0) - offset)

  const load = () => api.webinar.cuts(eventId, day, recordingId)
    .then((r: any) => {
      setCuts((r.cuts || []).map((c: Cut) => ({ ...c, _k: newKey() })))
      setMeta(r.recording); setDirty(false)
    })
    .catch(() => {})
    .finally(() => setLoading(false))

  useEffect(() => { load() }, [eventId, day, recordingId])

  // Пока идёт нарезка — перечитываем, чтобы были видны готовые куски.
  const anyProcessing = cuts.some(c => c.status === 'processing')
  useEffect(() => {
    if (!anyProcessing) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [anyProcessing])

  // ⚠️ Предупреждаем о несохранённых метках: расставить их — работа на десятки
  // минут, потерять её при случайном закрытии вкладки обидно.
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  /**
   * Перемотать плеер на секунду ЭФИРА.
   *
   * ⚠️ В трёхчасовом файле перемотка идёт секунды: браузер докачивает нужный
   * кусок. Без индикатора экран не меняется вовсе, и кажется, что нажатие не
   * сработало. Гасим по событиям самого плеера (`seeked`/`canplay`), а не по
   * таймеру — только они знают, когда картинка реально доехала.
   */
  const seekLive = (sec: number) => {
    const v = videoRef.current
    if (!v) return
    setSeeking(true)
    v.currentTime = Math.max(0, sec + offset)
    v.play().catch(() => {})
  }

  /**
   * Перетаскивание КРАСНОГО КУРСОРА — перемотка живьём.
   *
   * ⚠️ Картинку меняем ПРЯМО ВО ВРЕМЯ движения, а не когда отпустят: смысл в
   * том, чтобы искать глазами нужный момент, а для этого надо видеть, куда попал.
   *
   * ⚠️ Ставим currentTime напрямую, минуя seekLive: тот включает колесо
   * «Перематываю…», и при движении оно мигало бы на каждый пиксель. Плеер сам
   * покажет кадры по ходу.
   */
  useEffect(() => {
    if (!scrubbing) return
    const move = (e: MouseEvent) => {
      const box = barRef.current?.getBoundingClientRect()
      const v = videoRef.current
      if (!box || !v) return
      const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
      const sec = ratio * liveDur
      v.currentTime = Math.max(0, sec + offset)
      setCur(v.currentTime)
    }
    const up = () => { justDragged.current = true; setScrubbing(false) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [scrubbing, liveDur, offset])

  /**
   * Какую метку схватить, если нажали в секунде `sec`.
   *
   * ⚠️ Ищем БЛИЖАЙШУЮ в пределах ~20 пикселей, а не ту, в чью тонкую линию
   * попали. Иначе получается «иногда хватается, иногда нет»: промах по
   * двухпиксельной палке превращался в перемотку, и было непонятно, куда
   * целиться.
   *
   * Нарезанные куски пропускаем — их файлы уже готовы, двигать нечего.
   * null = рядом ничего нет, значит это обычная перемотка.
   */
  const nearestDraggable = (sec: number, barWidth: number): number | null => {
    const tolerance = (20 / Math.max(1, barWidth)) * liveDur   // 20px в секундах
    let best: number | null = null
    let bestDist = Infinity
    cuts.forEach((c, i) => {
      if (c.status === 'ready' || c.status === 'processing') return
      const d = Math.abs(c.start_sec - sec)
      if (d < bestDist && d <= tolerance) { bestDist = d; best = i }
    })
    return best
  }

  /**
   * Перетаскивание метки по таймлайну.
   *
   * ⚠️ Слушаем на ВСЁМ окне, а не на самой метке: если тянуть быстро, курсор
   * убегает за пределы палочки, и события на ней перестают приходить —
   * перетаскивание «залипает» на полпути.
   *
   * ⚠️ Хук объявлен ДО early-return по loading — иначе React ругается на разное
   * число хуков между отрисовками (правило проекта).
   */
  useEffect(() => {
    if (dragIdx === null) return
    const move = (e: MouseEvent) => {
      const box = barRef.current?.getBoundingClientRect()
      if (!box) return
      const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
      const sec = Math.round(ratio * liveDur)
      setCuts(prev => {
        const c = prev[dragIdx]
        if (!c || c.start_sec === sec) return prev
        // ⚠️ Порядок НЕ пересортировываем на лету: индекс перетаскиваемой метки
        // тогда менялся бы прямо под мышью, и она перескакивала бы на соседнюю.
        // Сортировка — один раз, когда отпустят.
        const next = [...prev]
        next[dragIdx] = { ...c, start_sec: sec }
        return next
      })
      setDirty(true)
    }
    const up = (e: MouseEvent) => {
      // ⚠️ Гасим последующий click ТОЛЬКО если мышь реально ехала. Нажали на
      // метку и отпустили не двигая — это обычный клик, и видео должно
      // перемотаться туда, как везде на полосе.
      justDragged.current = Math.abs(e.clientX - dragStartX.current) > 3
      setDragIdx(null)
      setCuts(prev => [...prev].sort((a, b) => a.start_sec - b.start_sec))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [dragIdx, liveDur])

  /** Текущая секунда ЭФИРА (плеер отдаёт секунду файла). */
  const curLive = Math.max(0, cur - offset)

  const addMark = (sec: number) => {
    const s = Math.max(0, Math.round(sec))
    if (cuts.some(c => Math.abs(c.start_sec - s) < 2)) return   // метка уже тут
    setCuts([...cuts, { _k: newKey(), start_sec: s, title: 'Новый кусок' }]
      .sort((a, b) => a.start_sec - b.start_sec))
    setDirty(true)
  }

  const patch = (i: number, upd: Partial<Cut>) => {
    const next = cuts.map((c, j) => j === i ? { ...c, ...upd } : c)
    next.sort((a, b) => a.start_sec - b.start_sec)
    setCuts(next); setDirty(true)
  }

  const removeAt = async (i: number) => {
    const c = cuts[i]
    if (c.id && c.status === 'ready') {
      if (!confirm(`Удалить готовый кусок «${c.title}»? Файл будет удалён.`)) return
      await api.webinar.deleteCut(eventId, day, recordingId, c.id).catch(() => {})
      return load()
    }
    setCuts(cuts.filter((_, j) => j !== i)); setDirty(true)
  }

  /**
   * Разложить по программе.
   *
   * ⚠️ Раскладке нужна ОДНА вещь — точка отсчёта: какому времени программы
   * соответствует какая секунда записи. Обычно её знает система (момент
   * «Начать эфир»). Если не знает — её показывает человек: перематывает на
   * начало любого известного места и говорит, какое это время по программе.
   * Дальше расчёт одинаковый. Раньше во втором случае был тупик «ставьте
   * вручную», хотя данных хватало.
   */
  const fromProgram = async (anchorSec?: number, anchorTime?: string) => {
    if (!hasOffset && !anchorTime) { setAskAnchor(true); return }
    if (cuts.length && !confirm('Метки будут заменены раскладкой по программе. Продолжить?')) return
    setBusy('Считаю по программе…')
    try {
      const r: any = await api.webinar.programMarks(
        eventId, day, recordingId, 0, anchorSec, anchorTime)
      const marks: Cut[] = (r.marks || [])
      if (!marks.length) { alert('В программе этого дня нет слотов со временем.'); return }
      // Готовые куски не трогаем — их файлы могли уже уйти спикерам.
      const keep = cuts.filter(c => c.status === 'ready')
      setCuts([...keep, ...marks.map(m => ({ ...m, _k: newKey() }))]
        .sort((a, b) => a.start_sec - b.start_sec))
      setDirty(true)
      setAskAnchor(false)
    } catch (e: any) {
      alert(e?.message || 'Не получилось разложить по программе')
    } finally { setBusy('') }
  }

  const save = async () => {
    setBusy('Сохраняю…')
    try {
      const r: any = await api.webinar.saveCuts(eventId, day, recordingId,
        cuts.filter(c => c.status !== 'ready').map(c => ({
          start_sec: c.start_sec, title: c.title,
          speaker_ec_id: c.speaker_ec_id ?? null, session_id: c.session_id ?? null,
        })))
      setCuts((r.cuts || []).map((c: Cut) => ({ ...c, _k: newKey() })))
      setMeta(r.recording); setDirty(false)
    } catch (e: any) {
      alert(e?.message || 'Не получилось сохранить')
    } finally { setBusy('') }
  }

  const runCut = async () => {
    if (dirty) { alert('Сначала сохраните метки.'); return }
    if (!confirm('Нарезать запись на куски? Исходник останется на месте.')) return
    setBusy('Ставлю в очередь…')
    try {
      await api.webinar.runCut(eventId, day, recordingId)
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не получилось запустить нарезку')
    } finally { setBusy('') }
  }

  if (loading) return <Spinner />
  if (!meta) return (
    <div className="max-w-3xl">
      <Link href={`${basePath}/${eventId}?tab=webinar`}
            className="text-sm text-gray-500 hover:text-[#25455D]">← Назад к вебинарам</Link>
      <p className="mt-6 text-gray-500">Запись не найдена.</p>
    </div>
  )

  const readyCount = cuts.filter(c => c.status === 'ready').length

  return (
    <div className="max-w-5xl pb-10">
      {/* Шапка */}
      <div className="flex items-center gap-3 mb-6">
        <Link href={`${basePath}/${eventId}?tab=webinar`}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">Нарезка записи по спикерам</h1>
          <p className="text-gray-500 text-sm">
            Эфир {mmss(liveDur)}
            {hasOffset && offset > 0 && ` · до эфира в файле ${mmss(offset)} подготовки`}
            {readyCount > 0 && ` · нарезано ${readyCount}`}
          </p>
        </div>
      </div>

      {/* Видео.
          ⚠️ Запись эфира — это часы и гигабайты, а оглавление mp4 (moov) у
          такого файла весит десятки мегабайт: браузер обязан скачать его
          ЦЕЛИКОМ до первого кадра. Поэтому пока идёт загрузка — говорим об
          этом словами. Немое колесо читается как «сломалось». */}
      <div className="relative rounded-2xl overflow-hidden bg-black mb-4">
        <video ref={videoRef} src={meta.url} controls preload="metadata"
               onLoadedMetadata={() => {
                 setVideoReady(true)
                 if (offset > 0 && videoRef.current) videoRef.current.currentTime = offset
               }}
               onError={() => setVideoError(true)}
               onSeeking={() => setSeeking(true)}
               onSeeked={() => setSeeking(false)}
               onCanPlay={() => setSeeking(false)}
               onWaiting={() => setSeeking(true)}
               onPlaying={() => setSeeking(false)}
               onTimeUpdate={e => setCur((e.target as HTMLVideoElement).currentTime)}
               className="w-full max-h-[55vh] mx-auto block" />
        {!videoReady && !videoError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2
                          bg-black/80 text-white text-sm pointer-events-none px-6 text-center">
            <div className="w-7 h-7 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            <div>Загружаю запись…</div>
            <div className="text-white/60 text-xs">
              Файл {fmtSize(meta.size_bytes)} — первый запуск занимает до минуты.
              Метки можно расставлять, не дожидаясь видео.
            </div>
          </div>
        )}
        {seeking && videoReady && !videoError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2
                          bg-black/40 text-white text-sm pointer-events-none">
            <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            <div className="text-xs text-white/80">Перематываю…</div>
          </div>
        )}
        {videoError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2
                          bg-black/85 text-white text-sm px-6 text-center">
            <div>Браузер не смог открыть запись.</div>
            <a href={meta.url} download className="underline text-white/80 text-xs">
              Скачать файл ({fmtSize(meta.size_bytes)})
            </a>
          </div>
        )}
      </div>

      {/* Таймлайн. ⚠️ Метки ТЯНУТСЯ мышью — это первое, что человек пробует
          сделать, увидев палочку на полосе. Двигать только цифрами в поле ниже
          неочевидно: выглядит как «сломалось». */}
      {/* ⚠️ Полоса высокая и с полем сверху (pt-3): палки-ручки выступают ЗА её
          верхний край, поэтому overflow-hidden тут нельзя — он бы их срезал.
          Скругление держим на внутреннем слое. */}
      {/* ⚠️ Захват метки решает ВСЯ ПОЛОСА, а не тонкая ручка на палке.
          Раньше надо было попасть в узкую зону, а промах превращался в
          перемотку — со стороны это «иногда хватается, иногда нет», и
          непонятно, куда целиться. Теперь: нажали рядом с палкой и повели —
          она поехала. Просто клик (без движения) по-прежнему перематывает. */}
      <div ref={barRef}
           className="relative h-24 pt-3 select-none"
           style={{ cursor: dragIdx !== null ? 'grabbing' : (hoverIdx !== null ? 'grab' : 'pointer') }}
           onMouseDown={e => {
             const box = barRef.current?.getBoundingClientRect()
             if (!box) return
             const sec = ((e.clientX - box.left) / box.width) * liveDur
             const i = nearestDraggable(sec, box.width)
             if (i === null) return          // рядом нет метки — оставляем перемотку
             e.preventDefault()              // иначе браузер начнёт выделять текст
             dragStartX.current = e.clientX
             setDragIdx(i)
           }}
           onMouseMove={e => {
             if (dragIdx !== null) return
             const box = barRef.current?.getBoundingClientRect()
             if (!box) return
             const sec = ((e.clientX - box.left) / box.width) * liveDur
             setHoverIdx(nearestDraggable(sec, box.width))
           }}
           onMouseLeave={() => setHoverIdx(null)}
           onClick={e => {
             // Клик по полосе — перемотка. Но не после перетаскивания: браузер
             // шлёт click следом за mouseup, и видео прыгало бы.
             if (justDragged.current) { justDragged.current = false; return }
             const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
             seekLive(((e.clientX - box.left) / box.width) * liveDur)
           }}>
        <div className="absolute left-0 right-0 bottom-0 top-3 rounded-xl bg-gray-100 border" />
        {cuts.map((c, i) => {
          const next = cuts[i + 1]
          const end = next ? next.start_sec : liveDur
          const left = (c.start_sec / liveDur) * 100
          const w = Math.max(0.4, ((end - c.start_sec) / liveDur) * 100)
          const locked = c.status === 'ready' || c.status === 'processing'
          const dragging = dragIdx === i
          const active = dragging || hoverIdx === i     // подсветка «схватится эта»
          return (
            // ⚠️ Ключ — собственный номер метки (_k), а не индекс: у меток из
            // раскладки по программе своего id нет, и при пересортировке React
            // переиспользовал не тот элемент — перетаскивание рвалось.
            // ⚠️ pointer-events-none у всего блока: нажатия ловит САМА полоса,
            // она же решает, какую метку схватить. Иначе кусок перехватывал бы
            // событие и захват снова зависел бы от попадания.
            <div key={c._k ?? c.id ?? i}
                 style={{ left: `${left}%`, width: `${w}%` }}
                 className={`absolute bottom-0 top-3 pointer-events-none ${
                   c.status === 'ready' ? 'bg-emerald-100'
                   : c.status === 'processing' ? 'bg-amber-100'
                   : c.status === 'failed' ? 'bg-red-100'
                   : 'bg-[#FFCFA4]/40'} ${active ? 'z-30' : ''}`}>
              {/* ⚠️ На полосе — ТОЛЬКО имя (решение владельца). Тему тут всё
                  равно не прочесть: колонка узкая, а строк много. Полное
                  название с темой — в списке снизу. */}
              <span className="absolute top-1 left-2.5 text-[11px] font-medium text-[#25455D] truncate max-w-[92%]">
                {c.speaker_name || c.title}
              </span>

              {/* Вертикальная палка-граница с кружком сверху. Кружок нужен,
                  чтобы было видно, что метку можно тянуть; подсветка — чтобы
                  было понятно, какая именно схватится. */}
              <div className="absolute -left-1 -top-3 bottom-0 w-2 flex flex-col items-center">
                <span className={`rounded-full shrink-0 shadow-sm border-2 border-white transition-all ${
                  active ? 'w-4 h-4' : 'w-3.5 h-3.5'} ${
                  locked ? 'bg-gray-400'
                  : dragging ? 'bg-[#FFCFA4] ring-2 ring-[#25455D]'
                  : active ? 'bg-[#25455D] ring-2 ring-[#FFCFA4]'
                  : 'bg-[#25455D]'}`} />
                <span className={`flex-1 ${active && !locked ? 'w-1' : 'w-0.5'} ${
                  c.status === 'ready' ? 'bg-emerald-500'
                  : c.status === 'processing' ? 'bg-amber-500'
                  : c.status === 'failed' ? 'bg-red-500'
                  : 'bg-[#25455D]'}`} />
              </div>
            </div>
          )
        })}
        {/* Курсор плеера. ⚠️ Тоже тянется — это первое, что пробуют сделать с
            красной полоской. Кружки сверху и снизу показывают, что за неё можно
            взяться. Перемотка идёт ЖИВЬЁМ во время движения: смотреть, куда
            попал, нужно сразу, а не после того как отпустил. */}
        <div className={`absolute bottom-0 -top-3 w-6 -ml-3 z-20 flex flex-col items-center
                         ${scrubbing ? 'cursor-grabbing' : 'cursor-grab'}`}
             style={{ left: `${Math.min(100, (curLive / liveDur) * 100)}%` }}
             title="Потяните, чтобы перемотать"
             onMouseDown={e => { e.stopPropagation(); e.preventDefault(); setScrubbing(true) }}>
          <span className="w-3.5 h-3.5 rounded-full bg-red-600 shrink-0 shadow-sm border-2 border-white" />
          <span className="w-0.5 flex-1 bg-red-600" />
          <span className="w-3.5 h-3.5 rounded-full bg-red-600 shrink-0 shadow-sm border-2 border-white -mb-1.5" />
        </div>
      </div>
      <div className="flex justify-between text-[11px] text-gray-400 mt-1 mb-4">
        <span>0:00</span><span className="tabular-nums text-[#25455D]">{mmss(curLive)}</span>
        <span>{mmss(liveDur)}</span>
      </div>

      {/* Кнопки */}
      <div className="flex flex-wrap gap-2 items-center mb-3">
        <button onClick={() => addMark(curLive)} className="btn-gold text-sm flex items-center gap-1.5">
          <Scissors size={15} /> Поставить метку здесь ({mmss(curLive)})
        </button>
        {/* ⚠️ Именно стрелка, а не onClick={fromProgram}: иначе в первый
            параметр прилетит объект события клика вместо секунды. */}
        <button onClick={() => fromProgram()} disabled={!!busy}
                className="btn-primary text-sm flex items-center gap-1.5 disabled:opacity-50">
          <ListOrdered size={15} /> Расставить по программе дня
        </button>
        {/* ⚠️ Кнопки «±1 мин всем» убраны (решение владельца): вслепую двигать
            все метки разом бессмысленно — всё равно надо смотреть глазами, куда
            попал. Порядок работы другой: красным курсором нашли момент на видео,
            убедились — и перенесли туда нужную метку кнопкой «сюда» в её строке. */}
        <div className="flex-1" />
        {dirty && <span className="text-xs text-amber-600">есть несохранённые изменения</span>}
        <button onClick={save} disabled={!dirty || !!busy}
                className="px-4 py-1.5 rounded-lg border text-sm flex items-center gap-1.5 disabled:opacity-40">
          <Save size={15} /> Сохранить
        </button>
        <button onClick={runCut} disabled={!!busy || dirty || !cuts.some(c => c.status !== 'ready')}
                className="btn-gold text-sm flex items-center gap-1.5 disabled:opacity-40">
          <Scissors size={15} /> Нарезать
        </button>
      </div>
      {busy && <div className="text-sm text-gray-500 mb-3">{busy}</div>}

      {/* ⚠️ У записей, сделанных до появления учёта смещения, момент начала
          эфира системе неизвестен. Это НЕ повод отбирать раскладку: данных для
          неё хватает, не хватает только точки отсчёта — а её человек видит
          глазами. Раньше здесь был тупик «ставьте вручную». */}
      {!hasOffset && !askAnchor && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 mb-4">
          У этой записи система не знает, на какой секунде начался эфир (старая запись).
          Покажите это сами — перемотайте видео на начало любого места из программы
          и нажмите «Расставить по программе дня»: остальное разложится само.
        </div>
      )}

      {askAnchor && (
        <div className="rounded-xl bg-white border-2 border-[#25455D] p-4 mb-4">
          <div className="font-semibold text-[#25455D] mb-1">Покажите одну точку</div>
          <p className="text-sm text-gray-600 mb-3">
            Перемотайте видео на начало любого места, время которого знаете по программе
            (обычно это открытие или первый спикер), и впишите это время. От него
            разложатся все остальные метки.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-500">Сейчас на видео</span>
            <span className="px-2 py-1 rounded-md bg-gray-100 text-sm tabular-nums text-[#25455D]">
              {mmss(curLive)}
            </span>
            <span className="text-sm text-gray-500">— это по программе</span>
            <input
              value={anchorTime}
              onChange={e => setAnchorTime(e.target.value)}
              placeholder="11:00"
              className="w-24 px-2 py-1 border rounded-md text-sm tabular-nums"
            />
            <span className="text-sm text-gray-500">МСК</span>
            <div className="flex-1" />
            <button onClick={() => setAskAnchor(false)}
                    className="px-3 py-1.5 rounded-lg border text-sm text-gray-600">Отмена</button>
            <button
              onClick={() => {
                const t = anchorTime.trim()
                if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(t)) {
                  alert('Впишите время в формате ЧЧ:ММ — например 11:00'); return
                }
                fromProgram(Math.round(curLive), t.length === 4 ? '0' + t : t)
              }}
              disabled={!!busy}
              className="btn-gold text-sm disabled:opacity-50">Разложить</button>
          </div>
        </div>
      )}

      {/* Список кусков */}
      <div className="space-y-2">
        {!cuts.length ? (
          <div className="py-4 text-sm text-gray-500 leading-relaxed">
            {hasOffset ? (
              <>
                <div className="font-medium text-[#25455D] mb-1">Нажмите «Расставить по программе дня»</div>
                Искать ничего не нужно: момент начала эфира известен, а времена
                выступлений берутся из программы — метки встанут сами, вместе с открытием.
                Дальше проверьте по видео: красной полосой найдите начало выступления и,
                если метка встала не туда — перетащите её мышью по полосе.
              </>
            ) : (
              <>
                <div className="font-medium text-[#25455D] mb-1">Нажмите «Расставить по программе дня»</div>
                У этой записи система не знает момент начала эфира, поэтому спросит
                одну точку: перемотайте видео на начало любого места из программы
                и впишите его время. Дальше метки разложатся сами. Можно и вручную —
                кнопкой «Поставить метку здесь».
              </>
            )}
          </div>
        ) : cuts.map((c, i) => {
          const next = cuts[i + 1]
          const end = next ? next.start_sec : liveDur
          return (
            <div key={c._k ?? c.id ?? i}
                 className="flex flex-wrap items-center gap-2 border rounded-xl p-2.5 bg-white">
              {/* ⚠️ Было ДВА поля с одним и тем же числом — кнопка перемотки и
                  поле правки. Выглядело как задвоение, и непонятно, зачем оба.
                  Теперь одно поле (его же можно править) + отдельная кнопка «▶». */}
              <button onClick={() => seekLive(c.start_sec)}
                      className="p-1.5 rounded-md bg-gray-100 text-[#25455D] shrink-0"
                      title="Перемотать сюда">▶</button>
              {/* ⚠️ Главное действие рабочего порядка: красным курсором нашли на
                  видео нужный момент, убедились глазами — и переносите границу
                  ровно туда. Точнее, чем тянуть мышью по трёхчасовой полосе, где
                  один пиксель это секунд десять. */}
              <input
                defaultValue={mmss(c.start_sec)} key={`t${c._k ?? c.id ?? i}-${c.start_sec}`}
                onBlur={e => {
                  const v = parseTime(e.target.value)
                  if (v === null) { e.target.value = mmss(c.start_sec); return }
                  patch(i, { start_sec: v })
                }}
                disabled={c.status === 'ready'}
                title="Время на записи"
                className="w-24 px-2 py-1 border rounded-md text-sm tabular-nums disabled:bg-gray-50"
              />
              {/* ⚠️ Время по ПРОГРАММЕ — не то же, что время на записи. Человек
                  держит в голове расписание («Светлана в 11:00»), и без этой
                  подписи не может проверить, туда ли встала метка. */}
              {c.program_time && (
                <span className="text-xs text-gray-400 tabular-nums shrink-0"
                      title="Время по программе дня">
                  {c.program_time} МСК
                </span>
              )}
              {/* ⚠️ Фамилия и имя — ОТДЕЛЬНО и первыми: по ним ищут строку
                  глазами. Порядок «Фамилия Имя» задаёт бэкенд (правило проекта:
                  для поиска — фамилия вперёд, для показа — имя). */}
              {c.speaker_name && (
                <span className="text-sm font-medium text-[#25455D] shrink-0 max-w-[220px] truncate"
                      title={c.speaker_name}>
                  {c.speaker_name}
                </span>
              )}
              <input
                value={c.title}
                onChange={e => patch(i, { title: e.target.value })}
                disabled={c.status === 'ready'}
                title="Тема выступления"
                className="flex-1 px-2 py-1 border rounded-md text-sm disabled:bg-gray-50"
                style={{ minWidth: 0 }}
              />
              <span className="text-xs text-gray-400 tabular-nums shrink-0">
                {mmss(Math.max(0, end - c.start_sec))}
              </span>
              {c.status === 'ready' && c.url && (
                <a href={c.url} download
                   className="px-2 py-1 rounded-md border text-xs text-gray-600 shrink-0 flex items-center gap-1">
                  <Download size={13} />{c.size_bytes ? fmtSize(c.size_bytes) : 'Скачать'}
                </a>
              )}
              {c.status === 'processing' && <span className="text-xs text-amber-600 shrink-0">режется…</span>}
              {c.status === 'failed' && (
                <span className="text-xs text-red-600 shrink-0" title={c.error || ''}>ошибка</span>
              )}
              <button onClick={() => removeAt(i)}
                      className="p-1.5 rounded-md border text-gray-400 hover:text-red-500 shrink-0">
                <X size={13} />
              </button>
            </div>
          )
        })}
      </div>

      <p className="mt-5 text-xs text-gray-500 leading-relaxed">
        Красную полосу тяните, чтобы найти нужный момент — картинка меняется на ходу. Метку двигают мышью по полосе или вписывают время в поле слева от названия;
        серым рядом — время по программе дня.
        Кусок идёт до следующей метки — отдельно задавать конец не нужно.
        Перерывы не вырезаются: пауза после выступления попадает в кусок этого же спикера.
        Исходная запись остаётся на месте, её можно удалить отдельно.
      </p>
    </div>
  )
}
