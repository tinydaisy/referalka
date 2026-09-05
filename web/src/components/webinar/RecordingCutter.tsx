'use client'

/**
 * Редактор нарезки записи эфира по спикерам.
 *
 * ⚠️ Зачем. Эфир пишется одним файлом: сначала настройка звука до «Начать
 * эфир», потом открытие, потом выступления подряд. Целиком это никому не
 * отдать — спикеру нужно СВОЁ выступление.
 *
 * ⚠️ Одна палочка = одна граница (решение владельца): кусок начинается там, где
 * кончился предыдущий, перерывы не вырезаются. Поэтому конец куска здесь не
 * задаётся — его считает бэкенд из начала следующего.
 *
 * ⚠️ Секунды на таймлайне отсчитываются ОТ НАЧАЛА ЭФИРА, а не от начала файла:
 * так их видит клиент. Смещение (проверка звука до «Начать эфир») прибавляет
 * бэкенд в момент резки — здесь оно нужно только чтобы перемотать плеер.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'

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

export default function RecordingCutter({ eventId, day, rec, onClose }: {
  eventId: number; day: number; rec: any; onClose: () => void
}) {
  const [cuts, setCuts] = useState<Cut[]>([])
  const [meta, setMeta] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [cur, setCur] = useState(0)
  const [dirty, setDirty] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  // Смещение: на какой секунде ФАЙЛА начался эфир. Плеер живёт в секундах
  // файла, таймлайн — в секундах эфира; переводим одним слагаемым.
  const offset = meta?.live_offset_sec ?? 0
  const hasOffset = meta?.live_offset_sec !== null && meta?.live_offset_sec !== undefined
  // Длительность ЭФИРА (а не файла) — по ней рисуем таймлайн.
  const liveDur = Math.max(1, (meta?.duration_sec || rec.duration_sec || 0) - offset)

  const load = () => api.webinar.cuts(eventId, day, rec.id)
    .then((r: any) => { setCuts(r.cuts || []); setMeta(r.recording); setDirty(false) })
    .catch(() => {})
    .finally(() => setLoading(false))

  useEffect(() => { load() }, [eventId, day, rec.id])

  // Пока идёт нарезка — перечитываем, чтобы клиент видел готовые куски.
  const anyProcessing = cuts.some(c => c.status === 'processing')
  useEffect(() => {
    if (!anyProcessing) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [anyProcessing])

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
      await api.webinar.deleteCut(eventId, day, rec.id, c.id).catch(() => {})
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
      const r: any = await api.webinar.programMarks(eventId, day, rec.id, 0)
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

  /** Сдвинуть ВСЕ метки на дельту — эфир начался позже объявленного. */
  const shiftAll = (deltaSec: number) => {
    setCuts(cuts.map(c => c.status === 'ready' ? c
      : { ...c, start_sec: Math.max(0, c.start_sec + deltaSec) })
      .sort((a, b) => a.start_sec - b.start_sec))
    setDirty(true)
  }

  const save = async () => {
    setBusy('Сохраняю…')
    try {
      const r: any = await api.webinar.saveCuts(eventId, day, rec.id,
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
      await api.webinar.runCut(eventId, day, rec.id)
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не получилось запустить нарезку')
    } finally { setBusy('') }
  }

  const readyCount = cuts.filter(c => c.status === 'ready').length

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" role="dialog">
      {/* ⚠️ Клик по фону НЕ закрывает: это форма, потеряются расставленные метки. */}
      <div className="bg-white rounded-2xl w-full max-w-6xl max-h-[94vh] overflow-hidden flex flex-col"
           onClick={e => e.stopPropagation()}>

        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="min-w-0">
            <div className="font-semibold text-[#25455D]">Нарезка записи по спикерам</div>
            <div className="text-xs text-gray-500">
              Эфир {mmss(liveDur)}
              {hasOffset && offset > 0 && ` · до эфира в файле ${mmss(offset)} подготовки`}
              {readyCount > 0 && ` · нарезано ${readyCount}`}
            </div>
          </div>
          <button onClick={onClose}
                  className="text-gray-400 hover:text-gray-700 text-2xl leading-none px-2">×</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Видео */}
          <div className="bg-black">
            <video ref={videoRef} src={rec.url} controls preload="metadata"
                   onLoadedMetadata={() => { if (offset > 0 && videoRef.current) videoRef.current.currentTime = offset }}
                   onTimeUpdate={e => setCur((e.target as HTMLVideoElement).currentTime)}
                   className="w-full max-h-[45vh] mx-auto" />
          </div>

          {/* Таймлайн */}
          <div className="px-5 pt-4">
            <div className="relative h-12 rounded-lg bg-gray-100 border overflow-hidden cursor-pointer"
                 onClick={e => {
                   const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
                   seekLive(((e.clientX - box.left) / box.width) * liveDur)
                 }}>
              {/* куски полосами */}
              {cuts.map((c, i) => {
                const next = cuts[i + 1]
                const end = next ? next.start_sec : liveDur
                const left = (c.start_sec / liveDur) * 100
                const w = Math.max(0.4, ((end - c.start_sec) / liveDur) * 100)
                return (
                  <div key={i} style={{ left: `${left}%`, width: `${w}%` }}
                       className={`absolute inset-y-0 border-r-2 ${
                         c.status === 'ready' ? 'bg-emerald-100 border-emerald-500'
                         : c.status === 'processing' ? 'bg-amber-100 border-amber-500'
                         : c.status === 'failed' ? 'bg-red-100 border-red-500'
                         : 'bg-[#FFCFA4]/40 border-[#25455D]'}`}>
                    <span className="absolute top-0.5 left-1 text-[10px] text-[#25455D] truncate max-w-[95%]">
                      {c.title}
                    </span>
                  </div>
                )
              })}
              {/* курсор плеера */}
              <div className="absolute inset-y-0 w-0.5 bg-red-600 pointer-events-none"
                   style={{ left: `${Math.min(100, (curLive / liveDur) * 100)}%` }} />
            </div>
            <div className="flex justify-between text-[11px] text-gray-400 mt-1">
              <span>0:00</span><span className="tabular-nums text-[#25455D]">{mmss(curLive)}</span>
              <span>{mmss(liveDur)}</span>
            </div>
          </div>

          {/* Кнопки */}
          <div className="px-5 pt-3 flex flex-wrap gap-2 items-center">
            <button onClick={() => addMark(curLive)} className="btn-gold text-sm">
              ✂️ Поставить метку здесь ({mmss(curLive)})
            </button>
            <button onClick={fromProgram} disabled={!!busy}
                    className="btn-primary text-sm disabled:opacity-50">
              📋 Расставить по программе дня
            </button>
            {cuts.length > 0 && (
              <>
                <button onClick={() => shiftAll(-60)}
                        className="px-3 py-1.5 rounded-lg border text-sm text-gray-600">−1 мин всем</button>
                <button onClick={() => shiftAll(60)}
                        className="px-3 py-1.5 rounded-lg border text-sm text-gray-600">+1 мин всем</button>
              </>
            )}
            <div className="flex-1" />
            {dirty && <span className="text-xs text-amber-600">есть несохранённые изменения</span>}
            <button onClick={save} disabled={!dirty || !!busy}
                    className="px-4 py-1.5 rounded-lg border text-sm disabled:opacity-40">Сохранить</button>
            <button onClick={runCut} disabled={!!busy || dirty || !cuts.some(c => c.status !== 'ready')}
                    className="btn-gold text-sm disabled:opacity-40">✂️ Нарезать</button>
          </div>
          {busy && <div className="px-5 pt-2 text-sm text-gray-500">{busy}</div>}

          {!hasOffset && (
            <div className="mx-5 mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
              У этой записи неизвестно, на какой секунде начался эфир (старая запись).
              Раскладка по программе недоступна — ставьте метки вручную по видео.
            </div>
          )}

          {/* Список кусков */}
          <div className="px-5 py-4 space-y-2">
            {loading ? <p className="text-sm text-gray-500">Загружаю…</p>
             : !cuts.length ? (
              <p className="text-sm text-gray-500">
                Меток пока нет. Найдите на видео, где начал первый спикер, и нажмите
                «Расставить по программе дня» — остальное встанет само.
              </p>
             ) : cuts.map((c, i) => {
              const next = cuts[i + 1]
              const end = next ? next.start_sec : liveDur
              return (
                <div key={c.id ?? `n${i}`}
                     className="flex flex-wrap items-center gap-2 border rounded-xl p-2.5">
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
                       className="px-2 py-1 rounded-md border text-xs text-gray-600 shrink-0">
                      Скачать{c.size_bytes ? ` · ${fmtSize(c.size_bytes)}` : ''}
                    </a>
                  )}
                  {c.status === 'processing' && <span className="text-xs text-amber-600 shrink-0">режется…</span>}
                  {c.status === 'failed' && (
                    <span className="text-xs text-red-600 shrink-0" title={c.error || ''}>ошибка</span>
                  )}
                  <button onClick={() => removeAt(i)}
                          className="px-2 py-1 rounded-md border text-xs text-gray-500 hover:text-red-500 shrink-0">✕</button>
                </div>
              )
            })}
          </div>

          <div className="px-5 pb-5 text-xs text-gray-500 leading-relaxed">
            Кусок идёт до следующей метки — отдельно задавать конец не нужно.
            Перерывы не вырезаются: пауза после выступления попадает в кусок этого же спикера.
            Исходная запись остаётся на месте, её можно удалить отдельно.
          </div>
        </div>
      </div>
    </div>
  )
}
