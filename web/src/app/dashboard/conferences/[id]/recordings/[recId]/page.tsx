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
  const videoRef = useRef<HTMLVideoElement>(null)

  // На какой секунде ФАЙЛА начался эфир: плеер живёт в секундах файла,
  // таймлайн — в секундах эфира. Переводим одним слагаемым.
  const offset = meta?.live_offset_sec ?? 0
  const hasOffset = meta?.live_offset_sec !== null && meta?.live_offset_sec !== undefined
  const liveDur = Math.max(1, (meta?.duration_sec || 0) - offset)

  const load = () => api.webinar.cuts(eventId, day, recordingId)
    .then((r: any) => { setCuts(r.cuts || []); setMeta(r.recording); setDirty(false) })
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

  const seekLive = (sec: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, sec + offset)
    v.play().catch(() => {})
  }

  /** Текущая секунда ЭФИРА (плеер отдаёт секунду файла). */
  const curLive = Math.max(0, cur - offset)

  const addMark = (sec: number) => {
    const s = Math.max(0, Math.round(sec))
    if (cuts.some(c => Math.abs(c.start_sec - s) < 2)) return   // метка уже тут
    setCuts([...cuts, { start_sec: s, title: 'Новый кусок' }]
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

  const fromProgram = async () => {
    if (!hasOffset) {
      alert('У этой записи неизвестно, на какой секунде начался эфир — расставьте метки вручную.')
      return
    }
    if (cuts.length && !confirm('Метки будут заменены раскладкой по программе. Продолжить?')) return
    setBusy('Считаю по программе…')
    try {
      const r: any = await api.webinar.programMarks(eventId, day, recordingId, 0)
      const marks: Cut[] = (r.marks || [])
      if (!marks.length) { alert('В программе этого дня нет слотов со временем.'); return }
      // Готовые куски не трогаем — их файлы могли уже уйти спикерам.
      const keep = cuts.filter(c => c.status === 'ready')
      setCuts([...keep, ...marks].sort((a, b) => a.start_sec - b.start_sec))
      setDirty(true)
    } catch (e: any) {
      alert(e?.message || 'Не получилось разложить по программе')
    } finally { setBusy('') }
  }

  /** Сдвинуть ВСЕ метки — эфир начался позже объявленного. */
  const shiftAll = (deltaSec: number) => {
    setCuts(cuts.map(c => c.status === 'ready' ? c
      : { ...c, start_sec: Math.max(0, c.start_sec + deltaSec) })
      .sort((a, b) => a.start_sec - b.start_sec))
    setDirty(true)
  }

  const save = async () => {
    setBusy('Сохраняю…')
    try {
      const r: any = await api.webinar.saveCuts(eventId, day, recordingId,
        cuts.filter(c => c.status !== 'ready').map(c => ({
          start_sec: c.start_sec, title: c.title,
          speaker_ec_id: c.speaker_ec_id ?? null, session_id: c.session_id ?? null,
        })))
      setCuts(r.cuts || []); setMeta(r.recording); setDirty(false)
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

      {/* Таймлайн */}
      <div className="relative h-14 rounded-xl bg-gray-100 border overflow-hidden cursor-pointer"
           onClick={e => {
             const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
             seekLive(((e.clientX - box.left) / box.width) * liveDur)
           }}>
        {cuts.map((c, i) => {
          const next = cuts[i + 1]
          const end = next ? next.start_sec : liveDur
          const left = (c.start_sec / liveDur) * 100
          const w = Math.max(0.4, ((end - c.start_sec) / liveDur) * 100)
          return (
            <div key={c.id ?? `n${i}`} style={{ left: `${left}%`, width: `${w}%` }}
                 className={`absolute inset-y-0 border-r-2 ${
                   c.status === 'ready' ? 'bg-emerald-100 border-emerald-500'
                   : c.status === 'processing' ? 'bg-amber-100 border-amber-500'
                   : c.status === 'failed' ? 'bg-red-100 border-red-500'
                   : 'bg-[#FFCFA4]/40 border-[#25455D]'}`}>
              <span className="absolute top-1 left-1.5 text-[11px] text-[#25455D] truncate max-w-[95%]">
                {c.title}
              </span>
            </div>
          )
        })}
        <div className="absolute inset-y-0 w-0.5 bg-red-600 pointer-events-none"
             style={{ left: `${Math.min(100, (curLive / liveDur) * 100)}%` }} />
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
        <button onClick={fromProgram} disabled={!!busy}
                className="btn-primary text-sm flex items-center gap-1.5 disabled:opacity-50">
          <ListOrdered size={15} /> Расставить по программе дня
        </button>
        {cuts.length > 0 && (
          <>
            <button onClick={() => shiftAll(-60)}
                    className="px-3 py-1.5 rounded-lg border text-sm text-gray-600 hover:text-[#25455D]">−1 мин всем</button>
            <button onClick={() => shiftAll(60)}
                    className="px-3 py-1.5 rounded-lg border text-sm text-gray-600 hover:text-[#25455D]">+1 мин всем</button>
          </>
        )}
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

      {!hasOffset && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 mb-4">
          У этой записи неизвестно, на какой секунде начался эфир (старая запись).
          Раскладка по программе недоступна — ставьте метки вручную по видео.
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
                Дальше посмотрите видео и поправьте то, что не совпало: если уехало
                всё сразу (поговорили дольше, чем планировали), двигайте кнопками «±1 мин всем».
              </>
            ) : (
              <>
                <div className="font-medium text-[#25455D] mb-1">Ставьте метки вручную</div>
                У этой записи неизвестен момент начала эфира, поэтому по программе
                разложить нельзя. Перематывайте видео к началу каждого выступления
                и нажимайте «Поставить метку здесь».
              </>
            )}
          </div>
        ) : cuts.map((c, i) => {
          const next = cuts[i + 1]
          const end = next ? next.start_sec : liveDur
          return (
            <div key={c.id ?? `n${i}`}
                 className="flex flex-wrap items-center gap-2 border rounded-xl p-2.5 bg-white">
              <button onClick={() => seekLive(c.start_sec)}
                      className="px-2 py-1 rounded-md bg-gray-100 text-sm tabular-nums text-[#25455D] shrink-0"
                      title="Перемотать сюда">▶ {mmss(c.start_sec)}</button>
              <input
                defaultValue={mmss(c.start_sec)} key={`t${c.id ?? i}-${c.start_sec}`}
                onBlur={e => {
                  const v = parseTime(e.target.value)
                  if (v === null) { e.target.value = mmss(c.start_sec); return }
                  patch(i, { start_sec: v })
                }}
                disabled={c.status === 'ready'}
                className="w-24 px-2 py-1 border rounded-md text-sm tabular-nums disabled:bg-gray-50"
              />
              <input
                value={c.title}
                onChange={e => patch(i, { title: e.target.value })}
                disabled={c.status === 'ready'}
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
        Кусок идёт до следующей метки — отдельно задавать конец не нужно.
        Перерывы не вырезаются: пауза после выступления попадает в кусок этого же спикера.
        Исходная запись остаётся на месте, её можно удалить отдельно.
      </p>
    </div>
  )
}
