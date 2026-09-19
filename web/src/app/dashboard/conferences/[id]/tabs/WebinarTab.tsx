'use client'
import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import { usePathname } from 'next/navigation'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import { Spinner } from '@/components/Spinner'
import { Copy, RefreshCw, Trash2, Plus, BarChart3, Radio, Video } from 'lucide-react'
import WebinarAnalytics from './WebinarAnalytics'
import ProductPicker from '@/components/ProductPicker'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// Дата дня "YYYY-MM-DD" → "26 июл." БЕЗ new Date() (иначе UTC-парс уедет на сутки).
const _DM = ['янв.', 'фев.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сен.', 'окт.', 'ноя.', 'дек.']
function fmtDayDate(d?: string | null): string {
  if (!d) return ''
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ''
  return `${parseInt(m[3], 10)} ${_DM[parseInt(m[2], 10) - 1]}`
}

type DayItem = {
  day_number: number
  day_date: string | null
  day_title: string | null
  room: any | null
}

// Модалка-форма: фон БЕЗ onClick (правило проекта — не закрывать по клику мимо).
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 scroll-visible">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

type SubView = 'settings' | 'blocks' | 'auto' | 'analytics' | 'records' | 'referrals' | 'console' | 'audience'

export default function WebinarTab({ eventId, event }: { eventId: number; event: any }) {
  const [loading, setLoading] = useState(true)
  const [level, setLevel] = useState<'room' | 'link'>('room')
  // Доступно ли создание конференции Zoom кнопкой. Считает БЭКЕНД (фича
  // `zoom_integration` + ключи приложения в окружении) — на фронте это не
  // вывести: про ключи сервера браузер не знает.
  const [zoomEnabled, setZoomEnabled] = useState(false)
  // Фича есть, но зум ещё не подключён — показываем не кнопку, а подсказку,
  // куда идти подключать. Иначе человек не узнает, что возможность существует.
  const [zoomConnectable, setZoomConnectable] = useState(false)
  const { me } = useMe()
  const hasAuto = !!me?.features?.includes('autowebinar')
  const [days, setDays] = useState<DayItem[]>([])
  const [activeDay, setActiveDay] = useState<number | null>(null)
  const [subView, setSubView] = useUrlTab<SubView>('sub', 'settings')

  // Запоминаем выбранную подвкладку и день (по событию) — чтобы после reload
  // остаться там, где были, а не сбрасываться на «Настройки»/первый день.
  const svKey = `webinar_sub_${eventId}`
  const dayKey = `webinar_day_${eventId}`
  useEffect(() => {
    try {
      const sv = localStorage.getItem(svKey) as SubView | null
      if (sv) setSubView(sv)
    } catch {}
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const setSub = (v: SubView) => { setSubView(v); try { localStorage.setItem(svKey, v) } catch {} }
  const setDay = (n: number) => { setActiveDay(n); try { localStorage.setItem(dayKey, String(n)) } catch {} }

  const load = useCallback(async () => {
    try {
      const res = await api.webinar.listRooms(eventId)
      setLevel(res.level)
      setZoomEnabled(!!res.zoom_enabled)
      setZoomConnectable(!!res.zoom_connectable)
      setDays(res.days || [])
      setActiveDay(prev => {
        if (prev != null) return prev
        let saved: number | null = null
        try { const s = localStorage.getItem(dayKey); saved = s ? Number(s) : null } catch {}
        // берём сохранённый день, если он есть среди дней; иначе первый
        if (saved != null && (res.days || []).some((d: any) => d.day_number === saved)) return saved
        return res.days?.[0]?.day_number ?? null
      })
    } catch (e: any) {
      // 403/пусто обрабатываем ниже
    } finally {
      setLoading(false)
    }
  }, [eventId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  if (loading) return <div className="py-16 flex justify-center"><Spinner /></div>

  if (!days.length) {
    return (
      <div className="bg-white rounded-2xl border p-8 text-center text-gray-600">
        <Radio className="mx-auto mb-3 text-gray-400" size={32} />
        <p className="font-semibold text-gray-900 mb-1">Нет дней программы</p>
        <p className="text-sm">Вебинарная комната создаётся на каждый день события со слотами.
          Сначала добавьте дни во вкладке «Программа».</p>
      </div>
    )
  }

  const active = days.find(d => d.day_number === activeDay) || days[0]

  return (
    <div>
      {/* Табы дней — как этапы турнира */}
      <div className="flex items-end gap-1 overflow-x-auto -mb-px mb-4">
        {days.map(d => {
          const on = d.day_number === active.day_number
          const live = d.room?.status === 'live'
          return (
            <button
              key={d.day_number}
              onClick={() => setDay(d.day_number)}
              className={`shrink-0 px-4 py-2.5 rounded-t-xl border border-b-0 text-sm font-medium transition ${
                on ? 'bg-white border-gray-200 text-gray-900 relative z-10'
                   : 'bg-gray-100 border-transparent text-gray-500 hover:bg-gray-200/70'}`}
            >
              <span className="flex items-center gap-2">
                {live && <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />}
                {fmtDayDate(d.day_date) || d.day_title?.trim() || `День ${d.day_number}`}
              </span>
            </button>
          )
        })}
      </div>

      <div className="bg-white rounded-2xl border p-5">
        {/* Сторонний вебинар этого дня → активна только вкладка «Настройки». */}
        {/* Подтабы дня */}
        <div className="flex gap-2 mb-5 flex-wrap">
          {([
            ['settings', 'Настройки'],
            ['blocks', 'Продающие блоки'],
            // ⚠️ Автовебинар — отдельная фича (Экстра). Обычная комната есть и
            // на Профи, поэтому проверяем именно `autowebinar`.
            // ⚠️ «(бета)» — раздел обкатывается (решение владельца, 19.09.2026):
            // фича `autowebinar`, сейчас только админ. Пометка в названии
            // честно говорит, что поведение ещё может меняться.
            ...(hasAuto ? [['auto', 'Автовебинар (бета)'] as const] : []),
            ['analytics', 'Аналитика'],
            ['records', 'Записи'],
            ['referrals', 'Рефералы'],
            ['console', 'Пульт ведущего'],
            ['audience', 'Зрители'],
          ] as const).map(([k, lbl]) => {
            const ext = active.room?.stream_type === 'external_link'
            const disabled = ext && k !== 'settings'
            return (
            <button
              key={k}
              disabled={disabled}
              title={disabled ? 'Недоступно при сторонней комнате — переключите тип на «Видеокодер»' : undefined}
              onClick={() => !disabled && setSub(k)}
              className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition ${
                disabled ? 'bg-gray-50 text-gray-300 cursor-not-allowed'
                : subView === k ? 'text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              style={subView === k && !disabled ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : undefined}
            >
              {lbl === 'Аналитика' && <BarChart3 size={14} className="inline mr-1 -mt-0.5" />}
              {lbl}
            </button>
          )})}
        </div>

        {/* Сторонний вебинар → только настройки (одна ссылка), что бы ни было выбрано. */}
        {active.room?.stream_type === 'external_link' ? (
          <RoomSettings eventId={eventId} day={active} level={level} slug={event?.slug} onSaved={load} daysCount={days.length} zoomEnabled={zoomEnabled} zoomConnectable={zoomConnectable} />
        ) : (<>
        {subView === 'settings' && (
          <RoomSettings eventId={eventId} day={active} level={level} slug={event?.slug} onSaved={load} daysCount={days.length} zoomEnabled={zoomEnabled} zoomConnectable={zoomConnectable} />
        )}
        {subView === 'blocks' && (
          <BlocksEditor eventId={eventId} day={active} event={event} />
        )}
        {subView === 'auto' && active.room && (
          <AutoWebinarTab eventId={eventId} day={active} onSaved={load} />
        )}
        {subView === 'auto' && !active.room && (
          <p className="text-sm text-gray-500">Сначала создайте комнату этого дня.</p>
        )}
        {subView === 'analytics' && active.room && (
          <WebinarAnalytics eventId={eventId} day={active.day_number} />
        )}
        {subView === 'analytics' && !active.room && (
          <p className="text-sm text-gray-500">Сначала создайте комнату этого дня.</p>
        )}
        {subView === 'records' && active.room && (
          <RecordsTab eventId={eventId} day={active.day_number} />
        )}
        {subView === 'records' && !active.room && (
          <p className="text-sm text-gray-500">Сначала создайте комнату этого дня.</p>
        )}
        {subView === 'referrals' && active.room && (
          <ReferralsTab eventId={eventId} day={active.day_number} slug={event?.slug} />
        )}
        {subView === 'referrals' && !active.room && (
          <p className="text-sm text-gray-500">Сначала создайте комнату этого дня.</p>
        )}
        {subView === 'console' && active.room && (
          <ConsolePanel eventId={eventId} day={active} event={event} slug={event?.slug} onChanged={load} />
        )}
        {subView === 'console' && !active.room && (
          <p className="text-sm text-gray-500">Сначала создайте комнату этого дня.</p>
        )}
        {subView === 'audience' && active.room && (
          <AudienceTab eventId={eventId} day={active.day_number} />
        )}
        {subView === 'audience' && !active.room && (
          <p className="text-sm text-gray-500">Сначала создайте комнату этого дня.</p>
        )}
        </>)}
      </div>
    </div>
  )
}

// ─────────────────────────── настройки комнаты дня ───────────────────────────
function RoomSettings({ eventId, day, level, slug, onSaved, daysCount = 1, zoomEnabled = false, zoomConnectable = false }: { eventId: number; day: DayItem; level: 'room' | 'link'; slug?: string; onSaved: () => void; daysCount?: number; zoomEnabled?: boolean; zoomConnectable?: boolean }) {
  // Домен клиента: ссылку на комнату он отдаёт своим зрителям.
  const { publicBase } = useMe()
  const r = day.room
  const [f, setF] = useState<any>({
    title: r?.title || day.day_title || '',
    stream_type: r?.stream_type || (level === 'room' ? 'encoder' : 'external_link'),
    external_url: r?.external_url || '',
    speaker_join_url: r?.speaker_join_url || '',
    hide_viewer_count: r?.hide_viewer_count || false,
    chat_enabled: r?.chat_enabled ?? true,
    premoderation: r?.premoderation || false,
    redirect_url: r?.redirect_url || '',
    // Экран «эфир завершён» (миграция 441). ⚠️ Значения НЕ пустые по умолчанию:
    // пустое поле с подсказкой не даёт понять, покажется что-то в итоге или нет.
    outro_offer_text: r?.outro_offer_text ?? 'А пока у нас для вас предложение',
    outro_button_label: r?.outro_button_label ?? 'Смотреть предложение',
    outro_redirect_sec: r?.outro_redirect_sec ?? 15,
    reaction_up_label: r?.reaction_up_label || 'Огонь',
    reaction_down_label: r?.reaction_down_label || 'Слабо',
    show_down_reaction: r?.show_down_reaction ?? true,
    intro_text: r?.intro_text || '',
    buttons_per_row: r?.buttons_per_row || 1,
    auth_mode: r?.auth_mode || 'auto',
    auth_require_name: r?.auth_require_name ?? true,
    auth_require_email: r?.auth_require_email || false,
    auth_require_phone: r?.auth_require_phone || false,
    auth_require_tg: r?.auth_require_tg || false,
    auth_intro_text: r?.auth_intro_text || '',
  })
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState('')
  const [copyingJoin, setCopyingJoin] = useState(false)
  const [joinCopied, setJoinCopied] = useState(false)
  const [zoomBusy, setZoomBusy] = useState(false)
  const [zoomMsg, setZoomMsg] = useState('')
  const [zoomMsgOk, setZoomMsgOk] = useState(true)

  // Создать конференцию в зуме клиента и подставить её ссылку в поле входа.
  //
  // ⚠️ Сначала СОХРАНЯЕМ день — по той же причине, что и у копирования ссылки
  // ниже: бэкенд читает комнату из базы, и у несохранённого дня её может не
  // быть вовсе (тогда «Сначала сохраните комнату»), либо тип трансляции в базе
  // окажется прежним.
  async function createZoom() {
    if (r?.zoom_meeting_id &&
        !confirm('Пересоздать конференцию? Прежняя будет удалена, и старая ссылка перестанет работать.')) return
    setZoomBusy(true); setZoomMsg('')
    try {
      await api.webinar.upsertRoom(eventId, day.day_number, f)
      const res = await api.webinar.createZoomMeeting(eventId, day.day_number)
      setF((prev: any) => ({ ...prev, speaker_join_url: res.join_url || prev.speaker_join_url }))
      setZoomMsgOk(!!res.livestream_ok)
      setZoomMsg(res.livestream_ok
        ? 'Конференция создана, трансляция в комнату включена, ссылка входа подставлена.'
        : `Конференция создана, но трансляцию в комнату включить не удалось: ${
            res.livestream_warning || 'Zoom отказал'}. Чаще всего дело в тарифе Zoom ниже Pro.`)
      await onSaved()
    } catch (e: any) {
      setZoomMsgOk(false)
      setZoomMsg(e.message || 'Не получилось создать конференцию')
    } finally { setZoomBusy(false) }
  }

  const [copyingAll, setCopyingAll] = useState(false)

  // Настройки этого дня — в остальные дни программы.
  // ⚠️ Сначала СОХРАНЯЕМ текущий день: бэкенд копирует то, что лежит в базе, а
  // не то, что набрано в форме. Иначе кнопка разнесла бы прошлые значения.
  async function copySettingsToAllDays() {
    if (daysCount < 2) return
    if (!confirm(
      `Скопировать настройки этого дня в остальные дни (${daysCount - 1} шт.)?\n\n` +
      'Перенесутся: чат, реакции, форма входа, экран после эфира, тип трансляции.\n' +
      'НЕ перенесутся: название дня, афиши, ключ трансляции и RTMP, ссылка входа ' +
      'в зум и встреча Zoom — они свои у каждого дня.'
    )) return
    setCopyingAll(true)
    try {
      await api.webinar.upsertRoom(eventId, day.day_number, f)
      const res = await api.webinar.copySettings(eventId, day.day_number)
      alert(`Готово: настройки скопированы в ${res?.updated ?? 0} дн.`)
      onSaved()
    } catch (e: any) {
      alert(e?.message || 'Не получилось скопировать')
    } finally {
      setCopyingAll(false)
    }
  }

  // Ссылку входа спикера — во все дни программы.
  // ⚠️ Сначала СОХРАНЯЕМ текущий день: бэкенд копирует то, что лежит в базе, а
  // не то, что набрано в поле. Без этого кнопка разнесла бы по дням прошлую
  // ссылку (или ничего), и человек узнал бы об этом уже во время эфира.
  async function copyJoinUrlToAllDays() {
    const url = (f.speaker_join_url || '').trim()
    if (!url) { alert('Сначала укажите ссылку входа для спикеров.'); return }
    setCopyingJoin(true); setJoinCopied(false)
    try {
      await api.webinar.upsertRoom(eventId, day.day_number, f)
      await api.webinar.copySpeakerJoinUrl(eventId, day.day_number)
      setJoinCopied(true)
      setTimeout(() => setJoinCopied(false), 3000)
      onSaved()
    } catch (e: any) {
      alert(e?.message || 'Не получилось скопировать')
    } finally {
      setCopyingJoin(false)
    }
  }

  useEffect(() => {
    const rr = day.room
    setF({
      title: rr?.title || day.day_title || '',
      stream_type: rr?.stream_type || (level === 'room' ? 'encoder' : 'external_link'),
      external_url: rr?.external_url || '',
      speaker_join_url: rr?.speaker_join_url || '',
      hide_viewer_count: rr?.hide_viewer_count || false,
      chat_enabled: rr?.chat_enabled ?? true,
      premoderation: rr?.premoderation || false,
      redirect_url: rr?.redirect_url || '',
      outro_offer_text: rr?.outro_offer_text ?? 'А пока у нас для вас предложение',
      outro_button_label: rr?.outro_button_label ?? 'Смотреть предложение',
      outro_redirect_sec: rr?.outro_redirect_sec ?? 15,
      reaction_up_label: rr?.reaction_up_label || 'Огонь',
      reaction_down_label: rr?.reaction_down_label || 'Слабо',
      show_down_reaction: rr?.show_down_reaction ?? true,
      intro_text: rr?.intro_text || '',
      buttons_per_row: rr?.buttons_per_row || 1,
      auth_mode: rr?.auth_mode || 'auto',
      auth_require_name: rr?.auth_require_name ?? true,
      auth_require_email: rr?.auth_require_email || false,
      auth_require_phone: rr?.auth_require_phone || false,
      auth_require_tg: rr?.auth_require_tg || false,
      auth_intro_text: rr?.auth_intro_text || '',
    })
    // Синхронизируем при любом изменении данных комнаты, а не только смене id —
    // иначе после сохранения/reload галочки формы не отражают сохранённое.
  }, [day.day_number, day.room?.id, day.room?.updated_at,
      day.room?.auth_require_phone, day.room?.auth_require_email, day.room?.auth_require_tg,
      day.room?.auth_mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const [savedMsg, setSavedMsg] = useState(false)
  async function save() {
    setSaving(true)
    try {
      const res = await api.webinar.upsertRoom(eventId, day.day_number, f)
      // Сразу отражаем сохранённое (чтобы поля не «слетали» на плейсхолдеры).
      if (res?.room) {
        const rr = res.room
        setF((prev: any) => ({
          ...prev,
          title: rr.title ?? prev.title,
          stream_type: rr.stream_type ?? prev.stream_type,
          external_url: rr.external_url ?? '',
          speaker_join_url: rr.speaker_join_url ?? '',
          hide_viewer_count: rr.hide_viewer_count ?? false,
          chat_enabled: rr.chat_enabled ?? true,
          premoderation: rr.premoderation ?? false,
          redirect_url: rr.redirect_url ?? '',
          outro_offer_text: rr.outro_offer_text ?? 'А пока у нас для вас предложение',
          outro_button_label: rr.outro_button_label ?? 'Смотреть предложение',
          outro_redirect_sec: rr.outro_redirect_sec ?? 15,
          reaction_up_label: rr.reaction_up_label ?? 'Огонь',
          reaction_down_label: rr.reaction_down_label ?? 'Слабо',
          show_down_reaction: rr.show_down_reaction ?? true,
          intro_text: rr.intro_text ?? '',
          buttons_per_row: rr.buttons_per_row ?? 1,
          auth_mode: rr.auth_mode ?? 'auto',
          auth_require_name: rr.auth_require_name ?? true,
          auth_require_email: rr.auth_require_email ?? false,
          auth_require_phone: rr.auth_require_phone ?? false,
          auth_require_tg: rr.auth_require_tg ?? false,
          auth_intro_text: rr.auth_intro_text ?? '',
        }))
      }
      await onSaved()
      setSavedMsg(true); setTimeout(() => setSavedMsg(false), 2500)
    } finally { setSaving(false) }
  }

  async function regen() {
    if (!confirm('Перегенерировать ключ потока? Старый перестанет работать.')) return
    await api.webinar.regenerateKey(eventId, day.day_number)
    await onSaved()
  }

  function copy(text: string, tag: string) {
    navigator.clipboard.writeText(text); setCopied(tag); setTimeout(() => setCopied(''), 1500)
  }

  const isEncoder = f.stream_type === 'encoder'
  // Вебинарной комнаты БЕЗ зума не бывает: картинка в неё идёт из зума
  // (Zoom/OBS → RTMP → плеер). Обратное возможно — эфир может быть только в
  // зуме, без нашей комнаты. Поэтому обязателен он ровно при своей комнате.
  const joinMissing = isEncoder && !(f.speaker_join_url || '').trim()

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Дата дня — для ориентира, чтобы понимать какой это день (не редактируется здесь) */}
      <div className="rounded-lg bg-gray-50 border px-3 py-2 text-sm text-gray-600 flex items-center gap-2">
        <span className="text-gray-400">День {day.day_number}</span>
        {day.day_date && <span className="font-semibold text-gray-800">· {new Date(day.day_date).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' })}</span>}
      </div>
      <div>
        <label className="label">Название вебинара (дня)</label>
        <input className="input" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder={day.day_title || `День ${day.day_number}`} />
      </div>

      {/* Тип трансляции */}
      <div>
        <label className="label">Тип трансляции</label>
        <div className="flex gap-2">
          {level === 'room' && (
            <button
              onClick={() => setF({ ...f, stream_type: 'encoder' })}
              className={`flex-1 rounded-xl border p-3 text-left text-sm ${isEncoder ? 'border-brand ring-2 ring-gold' : 'border-gray-200'}`}
            >
              <div className="font-semibold">🎥 Видеокодер (наша комната)</div>
              <div className="text-gray-500 text-xs mt-1">Zoom/OBS → RTMP → наш плеер. Чат, блоки, аналитика.</div>
            </button>
          )}
          <button
            onClick={() => setF({ ...f, stream_type: 'external_link' })}
            className={`flex-1 rounded-xl border p-3 text-left text-sm ${!isEncoder ? 'border-brand ring-2 ring-gold' : 'border-gray-200'}`}
          >
            <div className="font-semibold">🔗 Ссылка на стороннюю</div>
            <div className="text-gray-500 text-xs mt-1">Кнопка ведёт на внешнюю вебинарную комнату.</div>
          </button>
        </div>
        {level === 'link' && (
          <p className="text-xs text-amber-600 mt-2">Своя комната (видеокодер) доступна на тарифе Экстра. На Профи — только ссылка.</p>
        )}
      </div>

      {/* Ссылка на вебинарную комнату дня — для зрителей (над данными видеокодера). */}
      {isEncoder && slug && (
        <div className="rounded-xl border border-brand/30 bg-white p-4">
          <div className="text-xs text-gray-500 mb-1">Ссылка на комнату дня (для зрителей)</div>
          <div className="flex gap-2 items-center">
            <input readOnly className="input flex-1 font-mono text-xs"
              value={`${publicBase}/webinar/${slug}/${day.day_number}`} />
            <button onClick={() => { navigator.clipboard.writeText(`${publicBase}/webinar/${slug}/${day.day_number}`); setCopied('roomlink'); setTimeout(() => setCopied(''), 1500) }}
              className="px-3 py-2 rounded-lg border text-sm hover:bg-gray-50 shrink-0 flex items-center gap-1">
              <Copy size={13} /> {copied === 'roomlink' ? '✓' : ''}
            </button>
          </div>
          <p className="text-[11px] text-gray-400 mt-1">К ссылке добавляйте <code>?pid=реф-код</code> для реферальных ссылок спикеров.</p>
          {/* ⚠️ Ссылку НЕ прячем, пока зум не настроен (решение владельца,
              19.09.2026) — рассылки готовят заранее, и спрятанная ссылка
              мешала бы работе. Но предупреждаем: без зума комната будет
              пустой, а узнать об этом в момент эфира — худший вариант. */}
          {joinMissing && (
            <p className="text-[11px] text-red-700 font-medium mt-1.5">
              Пока не настроен Zoom, эта ссылка приведёт зрителей в пустую комнату —
              картинка в неё идёт из зума.
            </p>
          )}
        </div>
      )}

      {/* ⚠️⚠️ ОДИН БЛОК «ОТКУДА ИДЁТ КАРТИНКА», А НЕ ТРИ ВРАЗНОБОЙ (правило
          владельца, 19.09.2026). Раньше по странице были раскиданы: RTMP-данные
          с инструкцией, ниже кнопка создания зума, ещё ниже поле ссылки
          спикеров — и человек не понимал, что из этого делать и в каком
          порядке, а подключение стояло НИЖЕ инструкции «как подключить
          вручную». Теперь сверху развилка: автоматически или вручную. Итог у
          обеих веток один — заполненная ссылка входа спикеров. */}
      {isEncoder && zoomEnabled && (
        <div className="rounded-xl border border-brand/30 bg-white p-4 space-y-3">
          <div>
            <p className="text-sm font-semibold text-gray-900">Настроить автоматически</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Заведём конференцию в вашем Zoom на дату и время этого дня, включим ей
              трансляцию в эту комнату и подставим ссылку входа спикеров — ниже.
            </p>
          </div>

          {/* ⚠️ Состояние ПЕРВЫМ, до кнопки: главный вопрос человека — «создано
              или нет». Раньше описание «Заведём конференцию…» висело и после
              создания, и читалось как «ещё не создано» (прод, 19.09.2026). */}
          {r?.zoom_meeting_id ? (
            <div className={`rounded-lg border p-3 text-sm ${
              r.zoom_livestream_ok
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
              <p className="font-medium">
                {r.zoom_livestream_ok
                  ? '✓ Конференция создана, трансляция в комнату включена'
                  : '⚠ Конференция создана, но трансляция в комнату не включена'}
              </p>
              <p className="text-xs mt-1 opacity-90">
                Номер конференции {r.zoom_meeting_id}. Ссылка входа для спикеров — в поле ниже.
                {!r.zoom_livestream_ok && ' Эфир пройдёт в Zoom, но наша комната останется пустой.'}
              </p>
            </div>
          ) : (
            <p className="text-sm text-gray-500">Конференция ещё не создана.</p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={createZoom} disabled={zoomBusy}
              className="btn-gold text-sm inline-flex items-center gap-1.5 disabled:opacity-60">
              <Video size={14} />
              {zoomBusy ? 'Создаём…'
                : r?.zoom_meeting_id ? 'Создать заново' : 'Создать конференцию Zoom'}
            </button>
            {r?.zoom_meeting_id && (
              <span className="text-[11px] text-gray-500">
                Прежняя конференция удалится — её ссылка перестанет работать.
              </span>
            )}
          </div>

          {zoomMsg && (
            <p className={`text-xs ${zoomMsgOk ? 'text-green-600' : 'text-red-600'}`}>{zoomMsg}</p>
          )}
        </div>
      )}

      {/* Фича есть, но зум не подключён — говорим, что так можно, и куда идти. */}
      {isEncoder && !zoomEnabled && zoomConnectable && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm font-semibold text-gray-900">Настроить автоматически</p>
          <p className="text-xs text-gray-500 mt-1">
            Подключите свой Zoom — и конференция будет создаваться одной кнопкой, вместе
            с трансляцией в эту комнату.{' '}
            <a href="/dashboard/settings?tab=integration&svc=zoom"
               className="text-blue-600 hover:underline">Настройки → Интеграция</a>
          </p>
        </div>
      )}

      {isEncoder ? (
        <div className="rounded-xl bg-gray-50 border p-4 space-y-3">
          <div>
            <p className="text-sm font-semibold text-gray-900">Настроить вручную</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Заводите конференцию в Zoom сами и переносите эти два значения в его настройки.
            </p>
          </div>
          {r?.rtmp_url ? (
            <>
              <Field label="RTMP-адрес" value={r.rtmp_url} onCopy={() => copy(r.rtmp_url, 'rtmp')} copied={copied === 'rtmp'} />
              <Field label="Ключ трансляции" value={r.stream_key} onCopy={() => copy(r.stream_key, 'key')} copied={copied === 'key'} />
              <button onClick={regen} className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1">
                <RefreshCw size={12} /> Перегенерировать ключ
              </button>

              {/* Куда эти два значения вставить в Zoom. Без инструкции поля
                  выглядят как «технические данные непонятно для чего»:
                  в самом Zoom они называются иначе (Stream URL / Stream Key),
                  а трансляция включается не в настройках, а из идущей встречи. */}
              <div className="rounded-xl bg-blue-50 border border-blue-200 p-3.5 space-y-2.5">
                <p className="text-sm font-semibold text-blue-900">Куда вставить это в Zoom</p>

                <div className="space-y-1.5 text-xs text-blue-900 leading-relaxed">
                  <p className="font-medium">Один раз — включить возможность трансляции:</p>
                  <ol className="list-decimal list-inside space-y-1 ml-0.5">
                    <li>Откройте <b>zoom.us</b> → войдите в аккаунт → <b>Настройки</b> (Settings).</li>
                    <li>Вкладка <b>Встреча</b> (Meeting) → раздел <b>На встрече (расширенные)</b> —
                        англ. «In Meeting (Advanced)».</li>
                    <li>
                      Включите <b>Прямая трансляция встреч</b> (Allow livestreaming of meetings)
                      и поставьте галочку <b>Пользовательская служба трансляции</b>
                      (Custom Live Streaming Service).
                    </li>
                  </ol>
                  <p className="text-[11px] text-blue-700">
                    Нужен платный тариф Zoom — на бесплатном трансляции нет.
                  </p>
                </div>

                <div className="space-y-1.5 text-xs text-blue-900 leading-relaxed">
                  <p className="font-medium">Перед каждым эфиром — запустить трансляцию:</p>
                  <ol className="list-decimal list-inside space-y-1 ml-0.5">
                    <li>Начните встречу Zoom (ту, куда заходят спикеры).</li>
                    <li>
                      Внизу нажмите <b>Подробнее</b> (More, три точки) →
                      <b> Прямой эфир</b> → <b>Пользовательская служба трансляции</b>.
                    </li>
                    <li>
                      В открывшемся окне заполните три поля:
                      <div className="mt-1.5 space-y-1 rounded-lg bg-white/70 border border-blue-200 p-2">
                        <p><b>URL трансляции</b> (Stream URL) — RTMP-адрес выше</p>
                        <p><b>Ключ трансляции</b> (Stream Key) — ключ выше</p>
                        <p><b>URL страницы трансляции</b> (Live streaming page URL) —
                           «Ссылка на комнату дня (для зрителей)» — она выше на этой
                           же странице</p>
                      </div>
                    </li>
                    <li>Нажмите <b>Начать трансляцию</b> (Go Live!) — и подождите 20–30 секунд.</li>
                  </ol>
                </div>

                <p className="text-xs text-blue-900 leading-relaxed">
                  Как поток дойдёт — кнопка <b>«Начать эфир»</b> на вкладке
                  <b> «Пульт ведущего»</b> загорится сама. Зрители увидят картинку только после нажатия этой
                  кнопки: сам поток из Zoom эфир не открывает.
                </p>

                <p className="text-[11px] text-blue-700 leading-relaxed">
                  Через OBS — то же самое: <b>Настройки → Вещание</b>, сервис
                  «Настраиваемый», в «Сервер» RTMP-адрес, в «Ключ потока» ключ.
                </p>
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-500">Сохраните комнату — появятся RTMP-адрес и ключ.</p>
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 space-y-2">
          <label className="label">Ссылка на стороннюю комнату</label>
          <input className="input" value={f.external_url} onChange={e => setF({ ...f, external_url: e.target.value })} placeholder="https://..." />
          <p className="text-xs text-amber-700">
            Сторонний вебинар — мы только даём кнопку на вашу внешнюю комнату (Zoom/GetCourse/др.).
            Наш плеер, чат, продающие блоки, аналитика, записи, пульт и зрители тут недоступны —
            их предоставляет ваш внешний сервис. Нужна одна ссылка.
          </p>
        </div>
      )}

      {/* ⚠️ ВХОД СПИКЕРА — НЕ ссылка на эфир, и поэтому стоит ОТДЕЛЬНО от
          настроек комнаты (и вне блока isEncoder: нужна при любом типе эфира).
          Зрители идут в вебинарную комнату, а спикер заходит сюда — чтобы его
          картинка попала В эту комнату. Ссылка своя у каждого дня: зум-конференцию
          заводят под конкретный эфир. */}
      {/* ⚠️ У НАШЕЙ комнаты зум ОБЯЗАТЕЛЕН: картинка в неё идёт из зума
          (Zoom/OBS → RTMP → плеер). Без него комната пустая — эфира не будет
          вовсе, и выяснится это в момент старта. Поэтому пустое поле светим
          красным, а не оставляем «необязательным». У сторонней комнаты эфир
          ведёт чужой сервис — там зум не нужен. */}
      <div className={`rounded-xl border p-4 space-y-2 ${
        joinMissing ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
        <label className={`label ${joinMissing ? 'text-red-700' : ''}`}>
          Ссылка для входа спикеров (Zoom)
          {isEncoder && <span className="text-red-600"> *</span>}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input className={`input flex-1 min-w-[220px] ${
                   joinMissing ? 'border-red-400 focus:border-red-500' : ''}`}
                 value={f.speaker_join_url}
                 onChange={e => setF({ ...f, speaker_join_url: e.target.value })}
                 placeholder="https://zoom.us/j/..." />
          {daysCount > 1 && (
            <button type="button" onClick={copyJoinUrlToAllDays} disabled={copyingJoin}
              className="px-3 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap">
              {copyingJoin ? 'Копируем…' : 'Скопировать во все дни'}
            </button>
          )}
        </div>
        {joinCopied && (
          <p className="text-xs text-green-600">Скопировано во все дни программы.</p>
        )}
        {joinMissing && (
          <p className="text-xs font-medium text-red-700">
            Без зума эфира не будет: картинка в вашу комнату идёт именно оттуда.
            Укажите ссылку — по ней зайдут спикеры.
          </p>
        )}
        <p className="text-xs text-gray-500">
          Куда заходит спикер, чтобы его картинка попала в эфир. Уходит в рассылке
          «вы следующие» в чат спикеров — плейсхолдер {'{speaker_join_url}'}.
          Зрители по ней не ходят: они открывают вебинарную комнату.
          {daysCount > 1 && ' Обычно зум один на всё событие — заполните здесь и нажмите «Скопировать во все дни».'}
        </p>
      </div>

      {/* Все настройки нашей комнаты — ТОЛЬКО при видеокодере. У сторонней —
          одна ссылка выше, остальное недоступно (ведёт внешний сервис). */}
      {isEncoder && (<>
      <div className="grid sm:grid-cols-2 gap-4">
        <Toggle label="Скрывать число зрителей в эфире" checked={f.hide_viewer_count} onChange={v => setF({ ...f, hide_viewer_count: v })} />
        <Toggle label="Чат включён" checked={f.chat_enabled} onChange={v => setF({ ...f, chat_enabled: v })} />
        <Toggle label="Премодерация чата" checked={f.premoderation} onChange={v => setF({ ...f, premoderation: v })} />
        <Toggle label="Показывать отрицательную реакцию (👎)" checked={f.show_down_reaction} onChange={v => setF({ ...f, show_down_reaction: v })} />
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Название положительной реакции</label>
          <input className="input" value={f.reaction_up_label} onChange={e => setF({ ...f, reaction_up_label: e.target.value })} placeholder="Огонь" />
        </div>
        {f.show_down_reaction && (
          <div>
            <label className="label">Название отрицательной реакции</label>
            <input className="input" value={f.reaction_down_label} onChange={e => setF({ ...f, reaction_down_label: e.target.value })} placeholder="Слабо" />
          </div>
        )}
      </div>

      <div>
        <label className="label">Продающих кнопок в ряд</label>
        <select className="input max-w-[200px]" value={f.buttons_per_row}
          onChange={e => setF({ ...f, buttons_per_row: Number(e.target.value) })}>
          <option value={1}>1 — столбиком</option>
          <option value={2}>2 в ряд</option>
          <option value={3}>3 в ряд</option>
          <option value={4}>4 в ряд</option>
        </select>
        <p className="text-xs text-gray-500 mt-1">Формы заявок всегда идут на всю ширину — раскладка касается только кнопок.</p>
      </div>

      {/* Что видит зритель, когда эфир уже кончился. Раньше тут была одна
          ссылка и молчаливый переход через 4 секунды: пришедший после эфира
          не узнавал ни про следующий день, ни про предложение. */}
      <div className="rounded-xl border border-gray-200 p-4 space-y-3">
        <div className="font-semibold text-sm">Экран после завершения эфира</div>
        <p className="text-xs text-gray-500 -mt-1">
          Если у события есть следующий день — на этом экране сам появится
          «Встречаемся завтра в 11:00 МСК на День 2». Задавать ничего не нужно,
          у последнего дня строки не будет.
        </p>

        <div>
          <label className="label">Ссылка перехода</label>
          <input className="input" value={f.redirect_url}
                 onChange={e => setF({ ...f, redirect_url: e.target.value })}
                 placeholder="https://... (куда перебросить зрителя)" />
          <p className="text-[11px] text-gray-400 mt-1">
            Туда ведёт и кнопка, и автопереход. Пусто — экран покажет только
            «Спасибо, что были с нами» и следующий день.
          </p>
        </div>

        <div>
          <label className="label">Подводка к предложению</label>
          <input className="input" value={f.outro_offer_text}
                 onChange={e => setF({ ...f, outro_offer_text: e.target.value })} />
        </div>

        <div>
          <label className="label">Надпись на кнопке</label>
          <input className="input" value={f.outro_button_label}
                 onChange={e => setF({ ...f, outro_button_label: e.target.value })} />
        </div>

        <div>
          <label className="label">Автопереход через (секунд)</label>
          <input type="number" min={0} max={600} className="input w-32"
                 value={f.outro_redirect_sec}
                 onChange={e => setF({ ...f, outro_redirect_sec: Math.max(0, Math.min(600, Number(e.target.value) || 0)) })} />
          <p className="text-[11px] text-gray-400 mt-1">
            На экране идёт видимый обратный отсчёт. <b>0</b> — не переводить
            автоматически, только по кнопке.
          </p>
        </div>
      </div>

      <div>
        <label className="label">Текст до эфира</label>
        <textarea className="input" rows={2} value={f.intro_text} onChange={e => setF({ ...f, intro_text: e.target.value })} placeholder="Трансляция скоро начнётся…" />
      </div>

      {/* Форма авторизации зрителя (работает и для нашей комнаты, и для Zoom) */}
      <div className="rounded-xl border p-4 space-y-3">
        <div className="font-semibold text-sm">Форма авторизации зрителя</div>
        <Toggle label="Просить контакты перед входом в эфир"
          checked={f.auth_mode !== 'off'}
          onChange={v => setF({ ...f, auth_mode: v ? 'auto' : 'off' })} />
        {f.auth_mode !== 'off' && (
          <Toggle label="Спрашивать даже у знакомых (кого опознали по ссылке)"
            checked={f.auth_mode === 'always'}
            onChange={v => setF({ ...f, auth_mode: v ? 'always' : 'auto' })} />
        )}
        <p className="text-xs text-gray-500">Галочка выключена — эфир открывается сразу, без формы. Включена — незнакомых (из рассылки в чат) просим оставить контакты; пришедших по личной ссылке/из бота опознаём сами.</p>
        {f.auth_mode !== 'off' && (
          <>
            <div className="text-xs text-gray-500">Какие поля показывать в форме:</div>
            <div className="grid sm:grid-cols-2 gap-2">
              <Toggle label="Имя (всегда)" checked={true} disabled onChange={() => {}} />
              <Toggle label="Телефон" checked={f.auth_require_phone} onChange={v => setF({ ...f, auth_require_phone: v })} />
              <Toggle label="Email" checked={f.auth_require_email} onChange={v => setF({ ...f, auth_require_email: v })} />
              <Toggle label="Ник в Telegram" checked={f.auth_require_tg} onChange={v => setF({ ...f, auth_require_tg: v })} />
            </div>
            <div className="text-[11px] text-gray-400 -mt-1">Показываются только включённые поля, и все они обязательны для входа. Имя спрашивается всегда.</div>
            <div>
              <label className="label">Текст над формой</label>
              <input className="input" value={f.auth_intro_text} onChange={e => setF({ ...f, auth_intro_text: e.target.value })} placeholder="Оставьте контакты для входа в эфир" />
            </div>
          </>
        )}
      </div>
      </>)}

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="btn-gold">
          {saving ? 'Сохраняю…' : r ? 'Сохранить' : 'Создать комнату'}
        </button>
        {savedMsg && <span className="text-sm text-green-600">✓ Сохранено</span>}
        {/* Настраивать каждый день заново — работа на ровном месте: отличаются
            обычно только афиша и время. Показываем, когда дней больше одного. */}
        {r && daysCount > 1 && (
          <button type="button" onClick={copySettingsToAllDays} disabled={copyingAll || saving}
            className="px-3 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            {copyingAll ? 'Копируем…' : 'Скопировать настройки в другие дни'}
          </button>
        )}
      </div>
    </div>
  )
}

function Field({ label, value, onCopy, copied }: { label: string; value: string; onCopy: () => void; copied: boolean }) {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="flex gap-2">
        <input readOnly className="input flex-1 font-mono text-xs" value={value} />
        <button onClick={onCopy} className="px-3 rounded-lg border text-sm hover:bg-gray-50 flex items-center gap-1">
          <Copy size={13} /> {copied ? '✓' : ''}
        </button>
      </div>
    </div>
  )
}

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-3 text-sm ${disabled ? 'opacity-60 cursor-default' : 'cursor-pointer'}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`w-10 h-6 rounded-full transition relative shrink-0 ${checked ? 'bg-brand' : 'bg-gray-300'} ${disabled ? 'cursor-default' : ''}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition ${checked ? 'translate-x-4' : ''}`} />
      </button>
      <span className="text-gray-700">{label}</span>
    </label>
  )
}

// ─────────────────────────── конструктор блоков ───────────────────────────
function BlocksEditor({ eventId, day, event }: { eventId: number; day: DayItem; event: any }) {
  const [blocks, setBlocks] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<any | null>(null)
  const [speakers, setSpeakers] = useState<any[]>([])

  const load = useCallback(async () => {
    if (!day.room) { setLoading(false); return }
    try {
      const [b, sp] = await Promise.all([
        api.webinar.blocks(eventId, day.day_number),
        api.conference.speakers.list(eventId).catch(() => ({ speakers: [] })),
      ])
      setBlocks(b.blocks || [])
      setSpeakers(sp.speakers || [])
    } finally { setLoading(false) }
  }, [eventId, day.day_number, day.room])

  useEffect(() => { load() }, [load])

  if (!day.room) return <p className="text-sm text-gray-500">Сначала создайте комнату этого дня во вкладке «Настройки».</p>
  if (loading) return <Spinner />

  async function remove(id: number) {
    if (!confirm('Удалить блок?')) return
    await api.webinar.deleteBlock(eventId, day.day_number, id)
    await load()
  }

  // Порядок блоков — единый (как видит зритель). Переставляем в ОБЩЕМ списке
  // и перенумеровываем sort_order 0..N (надёжно даже если он был NULL у всех).
  async function move(idx: number, dir: -1 | 1) {
    const j = idx + dir
    if (j < 0 || j >= blocks.length) return
    const arr = [...blocks]
    ;[arr[idx], arr[j]] = [arr[j], arr[idx]]
    setBlocks(arr) // мгновенный отклик
    await Promise.all(arr.map((b, i) =>
      api.webinar.updateBlock(eventId, day.day_number, b.id, { sort_order: i })))
    await load()
  }

  const KIND_LABEL: Record<string, string> = {
    // ⚠️ «Регистрация на ДРУГОЕ событие» (правило владельца, 19.09.2026):
    // прежнее «Регистрация на событие» не отвечало на вопрос «на какое?» —
    // блок зовёт на любое событие клиента из списка, а не на текущее.
    button: '🔘 Кнопка', form: '📝 Форма заявки', event_reg: '📅 Регистрация на другое событие',
    speaker_follow: '➕ Подписка на спикера', gift: '🎁 Подарок спикера',
    tariff_upgrade: '⬆️ Повысить тариф', product_landing: '🛍 Лендинг продукта',
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-gray-500">Продающие блоки появляются в комнате по таймингу эфира.</p>
        <button onClick={() => setEditing({ kind: 'button' })} className="btn-gold flex items-center gap-1 text-sm">
          <Plus size={15} /> Блок
        </button>
      </div>
      <div className="space-y-2">
        {blocks.map((b, idx) => (
          <div key={b.id} className="flex items-center justify-between border rounded-xl p-3">
            <div className="flex flex-col mr-2 shrink-0">
              <button onClick={() => move(idx, -1)} className="text-gray-400 hover:text-gray-700 leading-none text-sm">▲</button>
              <button onClick={() => move(idx, 1)} className="text-gray-400 hover:text-gray-700 leading-none text-sm">▼</button>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs text-gray-400">{KIND_LABEL[b.kind] || b.kind}</div>
              <div className="font-medium truncate">{b.title || '(без названия)'}</div>
              {(b.show_at_min != null || b.hide_at_min != null) && (
                <div className="text-xs text-gray-500">
                  показ: {b.show_at_min ?? 0}–{b.hide_at_min ?? '∞'} мин
                </div>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setEditing(b)} className="text-sm text-gray-500 hover:text-gray-700">Править</button>
              <button onClick={() => remove(b.id)} className="text-gray-400 hover:text-red-500"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
        {!blocks.length && <p className="text-sm text-gray-400 py-4 text-center">Блоков пока нет.</p>}
      </div>

      {editing && (
        <BlockModal
          eventId={eventId} day={day.day_number} block={editing} speakers={speakers}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load() }}
        />
      )}
    </div>
  )
}

function BlockModal({ eventId, day, block, speakers, onClose, onSaved }: any) {
  const [f, setF] = useState<any>({
    kind: block.kind || 'button',
    title: block.title || '',
    url: block.url || '',
    body: block.body || '',
    form_tag: block.form_tag || '',
    follow_mode: block.follow_mode || 'auto',
    speaker_id: block.speaker_id || null,
    reg_event_id: block.reg_event_id || null,
    tariff_id: block.tariff_id || null,
    product_id: block.product_id || null,
    show_at_min: block.show_at_min ?? '',
    hide_at_min: block.hide_at_min ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [upcoming, setUpcoming] = useState<any[]>([])
  const [tariffs, setTariffs] = useState<any[]>([])

  useEffect(() => {
    if (f.kind !== 'event_reg') return
    api.webinar.upcomingEvents(eventId).then((r: any) => setUpcoming(r.events || [])).catch(() => {})
  }, [f.kind, eventId])

  // Тарифы ЭТОГО события — для блока «Повысить тариф».
  useEffect(() => {
    if (f.kind !== 'tariff_upgrade') return
    api.eventTariffs.list(eventId).then((r: any) => setTariffs(r.items || [])).catch(() => {})
  }, [f.kind, eventId])

  async function save() {
    if (f.kind === 'event_reg' && !f.reg_event_id) { alert('Выберите событие для регистрации'); return }
    if (f.kind === 'tariff_upgrade' && !f.tariff_id) { alert('Выберите тариф'); return }
    if (f.kind === 'product_landing' && !f.product_id) { alert('Выберите продукт'); return }
    setSaving(true)
    try {
      const data = {
        ...f,
        show_at_min: f.show_at_min === '' ? null : Number(f.show_at_min),
        hide_at_min: f.hide_at_min === '' ? null : Number(f.hide_at_min),
      }
      if (block.id) await api.webinar.updateBlock(eventId, day, block.id, data)
      else await api.webinar.createBlock(eventId, day, data)
      await onSaved()
    } finally { setSaving(false) }
  }

  const isForm = f.kind === 'form'
  const isSpeaker = f.kind === 'speaker_follow' || f.kind === 'gift'
  const isEventReg = f.kind === 'event_reg'
  const isTariff = f.kind === 'tariff_upgrade'
  const isProduct = f.kind === 'product_landing'
  // ⚠️ Только платные и включённые: «повысить» до бесплатного нечего, а
  // выключенный тариф купить нельзя — кнопка вела бы зрителя в тупик.
  const paidTariffs = tariffs.filter((t: any) => Number(t.price) > 0 && t.is_active !== false)
  const fmtDate = (s?: string) => {
    if (!s) return ''
    try { return new Date(s).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', timeZone: 'Europe/Moscow' }) } catch { return '' }
  }

  return (
    <Modal title={block.id ? 'Блок' : 'Новый блок'} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Тип блока</label>
          <select className="input" value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}>
            <option value="button">Кнопка (название + ссылка)</option>
            <option value="form">Форма заявки</option>
            <option value="event_reg">Регистрация на другое событие</option>
            <option value="tariff_upgrade">Повысить тариф</option>
            <option value="product_landing">Лендинг продукта</option>
            <option value="speaker_follow">Подписка на спикера</option>
            <option value="gift">Подарок спикера</option>
          </select>
        </div>

        {!isSpeaker && (
          <div>
            <label className="label">{isEventReg ? 'Текст кнопки' : 'Заголовок'}</label>
            <input className="input" value={f.title} onChange={e => setF({ ...f, title: e.target.value })}
              placeholder={isEventReg ? 'напр. Зарегистрироваться на конференцию' : ''} />
          </div>
        )}

        {isEventReg && (
          <div className="space-y-2">
            <div>
              <label className="label">Событие для регистрации</label>
              <select className="input" value={f.reg_event_id || ''} onChange={e => setF({ ...f, reg_event_id: Number(e.target.value) || null })}>
                <option value="">— выберите предстоящее событие —</option>
                {upcoming.map((ev: any) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.title}{ev.starts_at ? ` · ${fmtDate(ev.starts_at)}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-gray-500">
              Зритель жмёт → регистрируется на это событие сразу (его контакты уже есть).
              Если он в ваших ботах — бот пришлёт подтверждение; если нет — увидит выбор
              мессенджера (TG/MAX/VK), чтобы не потерять информацию.
            </p>
          </div>
        )}

        {/* ⚠️ Повышение тарифа — тарифы ЭТОГО события и только ПЛАТНЫЕ:
            «повысить» до бесплатного нечего, а в списке он сбивал бы с толку.
            Выключенные тарифы тоже не показываем — купить их нельзя. */}
        {isTariff && (
          <div className="space-y-2">
            <div>
              <label className="label">Какой тариф предлагаем</label>
              <select className="input" value={f.tariff_id || ''}
                      onChange={e => setF({ ...f, tariff_id: Number(e.target.value) || null })}>
                <option value="">— выберите тариф —</option>
                {paidTariffs.map((t: any) => (
                  <option key={t.id} value={t.id}>
                    {t.title} · {Number(t.price).toLocaleString('ru-RU')} ₽
                  </option>
                ))}
              </select>
            </div>
            {paidTariffs.length === 0 && (
              <p className="text-xs text-amber-700">
                У события нет платных тарифов. Заведите их во вкладке «Тарифы» — тогда
                их можно будет предложить прямо в эфире.
              </p>
            )}
            <p className="text-xs text-gray-500">
              Зритель жмёт → попадает на страницу оплаты этого тарифа, где его данные
              уже подставлены. Название и цена берутся из тарифа в момент показа —
              поменяете цену, кнопка покажет новую.
            </p>
          </div>
        )}

        {/* ⚠️ Продукт выбирается ОБЩИМ компонентом ProductPicker, а не своим
            `<select>`: до него в проекте было три разных селектора продукта, и
            ни один не отбирал опубликованные. Подробности — в шапке компонента. */}
        {isProduct && (
          <div className="space-y-2">
            <div>
              <label className="label">Какой продукт показываем</label>
              <ProductPicker
                value={f.product_id || null}
                onChange={id => setF({ ...f, product_id: id })}
                placeholder="— выберите продукт —"
              />
            </div>
            <p className="text-xs text-gray-500">
              Зритель жмёт → открывается лендинг продукта. В списке только
              опубликованные: черновик отдаёт «страница не найдена».
            </p>
          </div>
        )}

        {f.kind === 'button' && (
          <div>
            <label className="label">Ссылка</label>
            <input className="input" value={f.url} onChange={e => setF({ ...f, url: e.target.value })} placeholder="https://..." />
          </div>
        )}

        {isForm && (
          <div>
            <label className="label">Тег «группа» (вешается на контакт)</label>
            <input className="input" value={f.form_tag} onChange={e => setF({ ...f, form_tag: e.target.value })} placeholder="напр. заявка-курс" />
            <p className="text-xs text-gray-500 mt-1">Известный контакт увидит кнопку «Оставить заявку» в один тап; новый — форму ввода.</p>
          </div>
        )}

        {isSpeaker && (
          <div className="space-y-3">
            <div>
              <label className="label">Кого показывать</label>
              <select className="input" value={f.follow_mode} onChange={e => setF({ ...f, follow_mode: e.target.value })}>
                <option value="auto">Текущего спикера по программе (авто-смена)</option>
                <option value="fixed">Конкретного спикера</option>
              </select>
            </div>
            {f.follow_mode === 'fixed' && (
              <div>
                <label className="label">Спикер</label>
                <select className="input" value={f.speaker_id || ''} onChange={e => setF({ ...f, speaker_id: Number(e.target.value) || null })}>
                  <option value="">— выберите —</option>
                  {speakers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}
            <p className="text-xs text-gray-500">
              {f.kind === 'speaker_follow'
                ? 'Плашка «Сейчас выступает: {имя}» + кнопка подписки на канал спикера.'
                : 'Подарок спикера всплывает по таймингу его слота.'}
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Показать с минуты</label>
            <input className="input" type="number" value={f.show_at_min} onChange={e => setF({ ...f, show_at_min: e.target.value })} placeholder="0" />
          </div>
          <div>
            <label className="label">Скрыть на минуте</label>
            <input className="input" type="number" value={f.hide_at_min} onChange={e => setF({ ...f, hide_at_min: e.target.value })} placeholder="—" />
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <button onClick={save} disabled={saving} className="btn-gold flex-1">{saving ? '…' : 'Сохранить'}</button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg border">Отмена</button>
        </div>
      </div>
    </Modal>
  )
}

// ─────────────────────────── пульт ведущего ───────────────────────────
// Управление эфиром: поток от Zoom пришёл ≠ зрители его видят.
// Спикер настраивается в Zoom → ведущий смотрит превью → «Начать эфир» → зрители видят.
function LiveControl({ eventId, day, onChanged }: { eventId: number; day: DayItem; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const r = day.room
  const status = r?.status || 'idle'
  const streamActive = r?.stream_active
  const previewRef = useRef<HTMLVideoElement | null>(null)

  // авто-обновление статуса каждые 8 сек — и чтобы кнопка «Начать эфир» ожила при
  // приходе потока, и чтобы бейдж/кнопки не залипали (эфир мог завершиться/сброситься
  // на бэке, а фронт думал бы «В ЭФИРЕ»). Обновляем ВСЕГДА.
  useEffect(() => {
    const t = setInterval(() => { onChanged() }, 8000)
    return () => clearInterval(t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // превью потока — только ведущему, пока эфир не начат
  useEffect(() => {
    if (!streamActive || !r?.hls_url) return
    const v = previewRef.current
    if (!v) return
    let hls: any
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = r.hls_url
    } else {
      import('hls.js').then(({ default: Hls }) => {
        if (Hls.isSupported()) { hls = new Hls(); hls.loadSource(r.hls_url); hls.attachMedia(v) }
      })
    }
    return () => { if (hls) hls.destroy() }
  }, [streamActive, r?.hls_url])

  const roomState = r?.room_state || 'created'
  const isLive = status === 'live'

  async function go(action: 'go' | 'end' | 'open' | 'close' | 'reset') {
    if (action === 'end' && !confirm('Завершить текущий эфир? Комната останется открытой — люди общаются в чате, потом можно начать эфир снова.')) return
    if (action === 'close' && !confirm('Закрыть комнату? Завершится эфир, всех уведёт по ссылке после эфира, подведётся статистика и сохранится запись.')) return
    if (action === 'reset' && !confirm('Начать заново? Комната вернётся к экрану ожидания (афиша + отсчёт), без формы. Данные прошлых эфиров сохранятся.')) return
    setBusy(true)
    try {
      if (action === 'go') await api.webinar.goLive(eventId, day.day_number)
      else if (action === 'end') await api.webinar.endLive(eventId, day.day_number)
      else if (action === 'open') await api.webinar.openRoom(eventId, day.day_number)
      else if (action === 'close') await api.webinar.closeRoom(eventId, day.day_number)
      else await api.webinar.resetRoom(eventId, day.day_number)
      await onChanged()
    } catch (e: any) {
      alert(e?.message || 'Ошибка')
    } finally { setBusy(false) }
  }

  // Единый статус-бейдж по машине состояний.
  let sbT = 'Комната закрыта · зрители видят отсчёт', sbC = 'bg-gray-100 text-gray-600'
  if (roomState === 'open' && isLive) { sbT = '● В ЭФИРЕ · зрители видят трансляцию'; sbC = 'bg-red-100 text-red-700' }
  else if (roomState === 'open') { sbT = '● Комната открыта · ждём эфир'; sbC = 'bg-green-100 text-green-700' }
  else if (roomState === 'closed') { sbT = 'Вебинар завершён · редирект'; sbC = 'bg-gray-100 text-gray-500' }

  const btnRed = 'px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:opacity-40'
  const btnAmber = 'px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 disabled:opacity-40'
  const btnBorder = 'px-4 py-2 rounded-lg border text-sm text-gray-600 hover:text-[#25455D] disabled:opacity-40'

  return (
    <div className="border rounded-xl p-4">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h4 className="font-semibold">🚪 Управление комнатой</h4>
        <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${sbC}`}>{sbT}</span>
      </div>

      {/* Подсказка по текущему шагу */}
      <p className="text-xs text-gray-500 mb-3">
        {roomState === 'created' && 'Зрители видят афишу и обратный отсчёт. Формы входа нет — регистраций не будет, пока не откроете комнату.'}
        {roomState === 'open' && !isLive && 'Зрители входят по имени/почте и ждут эфир. Нажмите «Начать эфир», когда Zoom готов.'}
        {roomState === 'open' && isLive && 'Идёт трансляция. «Завершить эфир» = пауза (чат остаётся). «Закрыть комнату» = финал с редиректом.'}
        {roomState === 'closed' && 'Комната завершена. «Начать заново» вернёт экран ожидания (афиша + отсчёт).'}
      </p>

      {/* Все кнопки — здесь, по машине состояний */}
      <div className="flex gap-2 flex-wrap">
        {roomState === 'created' && (
          <button onClick={() => go('open')} disabled={busy} className="btn-gold text-sm disabled:opacity-40">
            {busy ? '…' : '🔓 Открыть комнату'}
          </button>
        )}

        {roomState === 'open' && !isLive && (
          <>
            <button onClick={() => go('go')} disabled={busy || !streamActive}
              className="btn-gold text-sm disabled:opacity-40 disabled:cursor-not-allowed">
              {busy ? '…' : '▶ Начать эфир'}
            </button>
            <button onClick={() => go('close')} disabled={busy} className={btnRed}>🔒 Закрыть комнату</button>
          </>
        )}

        {roomState === 'open' && isLive && (
          <>
            <button onClick={() => go('end')} disabled={busy} className={btnAmber}>⏸ Завершить эфир</button>
            <button onClick={() => go('close')} disabled={busy} className={btnRed}>🔒 Закрыть комнату</button>
          </>
        )}

        {roomState === 'closed' && (
          <button onClick={() => go('reset')} disabled={busy} className="btn-gold text-sm disabled:opacity-40">
            {busy ? '…' : '↩ Начать заново'}
          </button>
        )}
      </div>

      {/* Ждём поток от Zoom, когда комната открыта, но эфир ещё не начат */}
      {roomState === 'open' && !isLive && !streamActive && (
        <p className="text-xs text-gray-500 mt-2">
          Ждём поток от Zoom/OBS… Кнопка «Начать эфир» загорится сама, как только пойдёт трансляция на RTMP-адрес из «Настроек».
        </p>
      )}

      {/* Превью потока — только ведущему, пока эфир не начат */}
      {streamActive && !isLive && roomState === 'open' && (
        <div className="mt-3">
          <div className="text-xs text-gray-500 mb-1">Превью — видите только вы. Проверьте картинку и звук:</div>
          <video ref={previewRef} controls muted playsInline className="w-full rounded-lg bg-black aspect-video" />
        </div>
      )}
    </div>
  )
}

// Показ продающих блоков ВЖИВУЮ. Тайминг «с минуты N» ненадёжен — спикеры
// подключаются по программе, эфир плывёт. Менеджер сам решает, когда показать.
function BlocksLive({ eventId, day, onSettingsChanged }: { eventId: number; day: DayItem; onSettingsChanged?: () => void }) {
  const [blocks, setBlocks] = useState<any[]>([])
  const [busy, setBusy] = useState<number | null>(null)
  const [perRow, setPerRow] = useState<number>(day.room?.buttons_per_row || 1)

  const load = useCallback(async () => {
    if (!day.room) return
    const r = await api.webinar.blocks(eventId, day.day_number)
    // Руками управляем только кнопками и формами. Спикерские блоки
    // (подписка, подарок) идут сами по таймингу слота программы.
    setBlocks((r.blocks || []).filter((b: any) => b.kind === 'button' || b.kind === 'form' || b.kind === 'event_reg'))
  }, [eventId, day.day_number, day.room])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPerRow(day.room?.buttons_per_row || 1) }, [day.room?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(b: any) {
    setBusy(b.id)
    try {
      await api.webinar.pinBlock(eventId, day.day_number, b.id, !b.is_pinned)
      await load()
    } finally { setBusy(null) }
  }

  // порядок: переставить в общем списке + перенумеровать sort_order 0..N
  async function move(idx: number, dir: -1 | 1) {
    const j = idx + dir
    if (j < 0 || j >= blocks.length) return
    const arr = [...blocks]
    ;[arr[idx], arr[j]] = [arr[j], arr[idx]]
    setBlocks(arr)
    await Promise.all(arr.map((b, i) => api.webinar.updateBlock(eventId, day.day_number, b.id, { sort_order: i })))
    await load()
  }

  // сетка: сохраняем buttons_per_row на комнату дня
  async function saveGrid(n: number) {
    setPerRow(n)
    await api.webinar.upsertRoom(eventId, day.day_number, { buttons_per_row: n })
    onSettingsChanged?.()
  }

  const KIND: Record<string, string> = {
    button: '🔘', form: '📝', event_reg: '📅', speaker_follow: '➕', gift: '🎁',
  }

  return (
    <div className="border rounded-xl p-4">
      <h4 className="font-semibold mb-1">🛒 Показ блоков в эфире</h4>
      <p className="text-xs text-gray-500 mb-3">
        «Показать» — блок сразу появится у зрителей. Стрелками задайте порядок, ниже — сколько кнопок в ряд.
      </p>

      {!blocks.length ? (
        <p className="text-sm text-gray-500">Блоков нет. Создайте их во вкладке «Продающие блоки».</p>
      ) : (
        <>
          <div className="space-y-2">
            {blocks.map((b, idx) => (
              <div key={b.id} className={`flex items-center justify-between gap-3 border rounded-lg p-2.5 ${b.is_pinned ? 'border-green-400 bg-green-50/50' : ''}`}>
                <div className="flex flex-col shrink-0">
                  <button onClick={() => move(idx, -1)} className="text-gray-400 hover:text-gray-700 leading-none text-xs">▲</button>
                  <button onClick={() => move(idx, 1)} className="text-gray-400 hover:text-gray-700 leading-none text-xs">▼</button>
                </div>
                <div className="min-w-0 flex items-center gap-2 flex-1">
                  <span>{KIND[b.kind] || '•'}</span>
                  <span className="truncate text-sm font-medium">{b.title || '(без названия)'}</span>
                  {b.is_pinned && <span className="text-xs text-green-600 font-semibold shrink-0">в эфире</span>}
                </div>
                <button
                  onClick={() => toggle(b)} disabled={busy === b.id}
                  className={`shrink-0 px-3 py-1.5 rounded-lg text-sm font-semibold ${b.is_pinned ? 'bg-gray-200 text-gray-700' : 'btn-gold'}`}
                >
                  {busy === b.id ? '…' : b.is_pinned ? 'Скрыть' : 'Показать'}
                </button>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center gap-2">
            <span className="text-sm text-gray-600">Кнопок в ряд:</span>
            {[1, 2, 3, 4].map(n => (
              <button key={n} onClick={() => saveGrid(n)}
                className={`w-9 h-9 rounded-lg text-sm font-semibold border ${perRow === n ? 'bg-brand text-white border-brand' : 'border-gray-300 text-gray-600'}`}>
                {n}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ConsolePanel({ eventId, day, event, slug, onChanged }: any) {
  // Домен клиента: комнату смотрят его зрители.
  const { publicBase } = useMe()
  const [pollQ, setPollQ] = useState('')
  const [pollOpts, setPollOpts] = useState(['', ''])
  const [battleTitle, setBattleTitle] = useState('')
  const [battleSpeakers, setBattleSpeakers] = useState<number[]>([])
  const [speakers, setSpeakers] = useState<any[]>([])
  const [msg, setMsg] = useState('')

  useEffect(() => {
    api.conference.speakers.list(eventId).then(r => setSpeakers(r.speakers || [])).catch(() => {})
  }, [eventId])

  // ⚠️ Не window.location.origin: кабинет открыт на pluson.ru, а комнату
  // смотрят зрители клиента — ссылка должна быть на ЕГО домене.
  const roomUrl = slug ? `${publicBase}/webinar/${slug}/${day.day_number}` : ''

  async function launchPoll() {
    const opts = pollOpts.map(o => o.trim()).filter(Boolean)
    if (!pollQ.trim() || opts.length < 2) { setMsg('Введите вопрос и минимум 2 варианта'); return }
    try {
      await api.webinar.createPoll(eventId, day.day_number, { question: pollQ, options: opts })
      setMsg('Опрос запущен ✓'); setPollQ(''); setPollOpts(['', ''])
    } catch (e: any) { setMsg(e?.message || 'Не удалось запустить опрос') }
  }
  async function launchBattle() {
    if (battleSpeakers.length < 1) { setMsg('Выберите хотя бы одного спикера'); return }
    try {
      await api.webinar.createBattle(eventId, day.day_number, { title: battleTitle, speaker_ids: battleSpeakers })
      setMsg('Батл запущен ✓'); setBattleTitle(''); setBattleSpeakers([]); onChanged?.()
    } catch (e: any) { setMsg(e?.message || 'Не удалось запустить батл') }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {roomUrl && (
        <div className="rounded-xl bg-gray-50 border p-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-gray-500">Ссылка на комнату дня</div>
            <a href={roomUrl} target="_blank" rel="noreferrer" className="text-sm text-brand truncate block">{roomUrl}</a>
          </div>
          <button onClick={() => { navigator.clipboard.writeText(roomUrl); setMsg('Ссылка скопирована') }} className="px-3 py-1.5 rounded-lg border text-sm shrink-0">Копировать</button>
        </div>
      )}

      {msg && <div className={`text-sm ${/не удалось|минимум|хотя бы/i.test(msg) ? 'text-red-600' : 'text-green-600'}`}>{msg}</div>}

      {/* Управление эфиром — главное на пульте */}
      <LiveControl eventId={eventId} day={day} onChanged={onChanged} />

      {/* Текущий спикер: авто по программе или вручную (если программа поехала) */}
      <CurrentSpeakerControl eventId={eventId} day={day} speakers={speakers} onChanged={onChanged} />

      {/* Показ блоков вживую + порядок + сетка — менеджер управляет внешним видом */}
      <BlocksLive eventId={eventId} day={day} onSettingsChanged={onChanged} />

      {/* Опрос */}
      <div className="border rounded-xl p-4">
        <h4 className="font-semibold mb-3">📊 Запустить опрос</h4>
        <input className="input mb-2" placeholder="Вопрос" value={pollQ} onChange={e => setPollQ(e.target.value)} />
        {pollOpts.map((o, i) => (
          <input key={i} className="input mb-2" placeholder={`Вариант ${i + 1}`} value={o}
            onChange={e => setPollOpts(pollOpts.map((x, j) => j === i ? e.target.value : x))} />
        ))}
        <div className="flex gap-2">
          <button onClick={() => setPollOpts([...pollOpts, ''])} className="text-sm text-gray-500">+ вариант</button>
          <button onClick={launchPoll} className="btn-gold text-sm ml-auto">Запустить</button>
        </div>
      </div>

      {/* Батл — только в Премиях/Турнирах (module_slug='turnir') */}
      {event?.module_slug === 'turnir' && (
        <div className="border rounded-xl p-4">
          <h4 className="font-semibold mb-3">⚔️ Запустить батл</h4>
          <input className="input mb-3" placeholder="Название батла (необязательно)" value={battleTitle} onChange={e => setBattleTitle(e.target.value)} />
          <div className="text-xs text-gray-500 mb-2">Выберите спикеров из события:</div>
          <div className="flex flex-wrap gap-2 mb-3">
            {speakers.map((s: any) => {
              const on = battleSpeakers.includes(s.id)
              return (
                <button key={s.id}
                  onClick={() => setBattleSpeakers(on ? battleSpeakers.filter(x => x !== s.id) : [...battleSpeakers, s.id])}
                  className={`px-3 py-1.5 rounded-full text-sm border ${on ? 'bg-brand text-white border-brand' : 'border-gray-300 text-gray-600'}`}>
                  {s.name}
                </button>
              )
            })}
          </div>
          <button onClick={launchBattle} className="btn-gold text-sm">Запустить батл</button>
        </div>
      )}

      <p className="text-xs text-gray-400">
        Модерация чата и удаление участников — прямо на странице комнаты во время эфира.
      </p>
    </div>
  )
}

// ─────────────────────────── записи эфира + обзор батлов ───────────────────────────
function RecordsTab({ eventId, day }: { eventId: number; day: number }) {
  // ⚠️ Турнир открывается по /dashboard/tournaments, конференция по
  // /dashboard/conferences — страница одна, определяем раздел по адресу.
  // Жёсткий /conferences увёл бы турнир в чужой раздел.
  const pathname = usePathname()
  const basePath = pathname?.startsWith('/dashboard/tournaments')
    ? '/dashboard/tournaments' : '/dashboard/conferences'
  const [recs, setRecs] = useState<any[]>([])
  const [battles, setBattles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [viewer, setViewer] = useState<any | null>(null)
  const [dlBusy, setDlBusy] = useState(false)

  /**
   * Скачать запись целиком.
   *
   * ⚠️ Ссылку на сохранение выдаёт СЕРВЕР (подписанная, с пометкой «это
   * вложение»). Прямая ссылка на хранилище открывает проигрыватель, а атрибут
   * `download` на чужом домене не действует — «Скачать» показывало видео.
   */
  const downloadRecording = async (recId: number) => {
    setDlBusy(true)
    try {
      const r: any = await api.webinar.downloadRecordingUrl(eventId, day, recId)
      const a = document.createElement('a')
      a.href = r.url; a.rel = 'noopener'
      document.body.appendChild(a); a.click(); a.remove()
    } catch (e: any) {
      alert(e?.message || 'Не получилось скачать')
    } finally { setDlBusy(false) }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, b] = await Promise.all([
        api.webinar.recordings(eventId, day),
        api.webinar.allBattles(eventId).catch(() => ({ battles: [] })),
      ])
      setRecs(r.recordings || [])
      setBattles(b.battles || [])
    } finally { setLoading(false) }
  }, [eventId, day])

  useEffect(() => { load() }, [load])

  // ⚠️ Пока сервер режет запись — перечитываем список, чтобы «Нарезка идёт»
  // сама сменилась на «Нарезана на N». Иначе человек сидит на неменяющемся
  // экране и не понимает, закончилось оно или зависло.
  const cutting = recs.some((r: any) => (r.cuts_processing || 0) > 0)
  useEffect(() => {
    if (!cutting) return
    const t = setInterval(load, 8000)
    return () => clearInterval(t)
  }, [cutting, load])

  if (loading) return <Spinner />

  async function remove(id: number) {
    if (!confirm('Удалить запись? Файл удалится безвозвратно.')) return
    await api.webinar.deleteRecording(eventId, day, id)
    await load()
  }
  const fmtSize = (b: number) => b ? (b / 1048576).toFixed(0) + ' МБ' : '—'
  const fmtDur = (s: number) => s ? Math.floor(s / 60) + ' мин' : '—'
  const fmtDt = (d: string) => d ? new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '…'

  return (
    <div className="space-y-6">
      {/* Записи */}
      <div>
        <h4 className="font-semibold mb-2">🎬 Записи эфира</h4>
        {!recs.length ? (
          <p className="text-sm text-gray-500">Записей пока нет. Они появляются после завершения эфира.</p>
        ) : (
          <div className="space-y-2">
            {recs.map(r => (
              <div key={r.id} className="flex items-center justify-between gap-3 border rounded-xl p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{fmtDt(r.started_at)} – {fmtDt(r.ended_at)}</div>
                  <div className="text-xs text-gray-500">
                    {r.status === 'ready' ? `${fmtDur(r.duration_sec)} · ${fmtSize(r.size_bytes)}`
                      : r.status === 'processing' ? '⏳ обрабатывается…' : '⚠️ ошибка обработки'}
                  </div>
                  {/* ⚠️ Состояние нарезки — словами и здесь тоже: человек
                      смотрит в список, а не только на страницу нарезки.
                      Раньше строка писала «нарезано на 8», когда готов был один
                      нарезка, а семь ещё резались. */}
                  {r.cuts_processing > 0 ? (
                    <div className="text-xs text-amber-700 mt-0.5 flex items-center gap-1.5">
                      <span className="w-3 h-3 border-2 border-amber-300 border-t-amber-700 rounded-full animate-spin shrink-0" />
                      Нарезка идёт — готово {r.cuts_ready} из {r.cuts_count}
                    </div>
                  ) : r.cuts_ready > 0 ? (
                    <div className="text-xs text-emerald-700 mt-0.5">
                      Нарезана на {r.cuts_ready} — нарезки внутри
                    </div>
                  ) : r.cuts_count > 0 ? (
                    <div className="text-xs text-gray-500 mt-0.5">
                      Метки расставлены ({r.cuts_count}), нарезка не запущена
                    </div>
                  ) : null}
                </div>
                <div className="flex gap-2 shrink-0">
                  {r.status === 'ready' && r.url && (
                    <button onClick={() => setViewer(r)} className="btn-gold text-sm">▶ Смотреть</button>
                  )}
                  {r.status === 'ready' && r.url && (
                    // ⚠️ Отдельная СТРАНИЦА, не модалка: там плеер, таймлайн и
                    // список нарезок — работа на десятки минут, её нужно уметь
                    // отложить, сохранить адрес и вернуться.
                    <a href={`${basePath}/${eventId}/recordings/${r.id}?day=${day}`}
                       className="px-3 py-1.5 rounded-lg border text-sm text-gray-600 hover:text-[#25455D]">
                      {r.cuts_processing > 0 ? '✂️ Нарезка идёт'
                        : r.cuts_ready > 0 ? '✂️ Нарезки' : '✂️ Нарезать'}
                    </a>
                  )}
                  {r.status === 'ready' && r.url && (
                    <button onClick={() => downloadRecording(r.id)} disabled={dlBusy}
                            className="px-3 py-1.5 rounded-lg border text-sm text-gray-600 hover:text-[#25455D] disabled:opacity-50">
                      {dlBusy ? 'Готовлю…' : 'Скачать'}
                    </button>
                  )}
                  <button onClick={() => remove(r.id)} className="px-3 py-1.5 rounded-lg border text-sm text-gray-500 hover:text-red-500">Удалить</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Обзор батлов события */}
      {battles.length > 0 && (
        <div>
          <h4 className="font-semibold mb-2">⚔️ Батлы события</h4>
          <div className="space-y-3">
            {battles.map((b: any) => (
              <div key={b.id} className="border rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-medium">{b.title || 'Батл'} <span className="text-gray-400">· День {b.day_number}</span></div>
                  <span className="text-xs text-gray-400">{b.status === 'ended' ? 'завершён' : b.status === 'live' ? 'идёт' : 'черновик'}</span>
                </div>
                <div className="space-y-1">
                  {b.players.map((p: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span>{i + 1}. {p.name || `#${p.speaker_id}`}</span>
                      <span className="tabular-nums">🔥 {p.up_count} · 👎 {p.down_count}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewer && (
        <RecordingViewer eventId={eventId} day={day} rec={viewer}
                         onClose={() => setViewer(null)} />
      )}

    </div>
  )
}

// ─────────────────────────── реферальный отчёт вебинара ───────────────────────────
function ReferralsTab({ eventId, day, slug }: { eventId: number; day: number; slug?: string }) {
  // ⚠️ Хук — до early-return по loading. Домен клиента: реф-ссылку на комнату
  // раздают его зрители.
  const { publicBase } = useMe()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.webinar.referrals(eventId, day).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [eventId, day])

  if (loading) return <Spinner />
  const base = publicBase
  const refs = data?.referrers || []

  return (
    <div className="space-y-5">
      <div className="rounded-xl bg-gray-50 border p-4 text-sm text-gray-600">
        <div className="font-semibold text-gray-900 mb-1">Как это работает</div>
        Каждый (спикер, участник) зовёт людей на вебинар по своей ссылке
        <code className="mx-1 px-1.5 py-0.5 bg-white rounded text-brand">{base}/webinar/{slug}/{day}?pid=РЕФ-КОД</code>.
        Пришедший регистрируется (заполняет форму или опознаётся) — и засчитывается рефоводу.
        Работает даже если человек не в боте. Реф-код каждого — в разделе «Люди» / карточке контакта.
      </div>

      <div>
        <h4 className="font-semibold mb-2">Кто сколько привёл на вебинар <span className="text-gray-400 font-normal">· всего регистраций: {data?.total_registrations ?? 0}</span></h4>
        {!refs.length ? (
          <p className="text-sm text-gray-500">Пока никто не привёл по реф-ссылке.</p>
        ) : (
          <div className="border rounded-xl overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs">
                <tr>
                  <th className="text-left px-3 py-2">Рефовод</th>
                  <th className="px-3 py-2">Реф-код</th>
                  <th className="px-3 py-2">Привёл (регистраций)</th>
                  <th className="px-3 py-2">Из них были в эфире</th>
                </tr>
              </thead>
              <tbody>
                {refs.map((r: any, i: number) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-2">{r.referrer_name || '—'}</td>
                    <td className="px-3 py-2 text-center font-mono text-xs text-gray-500">{r.referrer_ref_code}</td>
                    <td className="px-3 py-2 text-center font-semibold tabular-nums">{r.brought}</td>
                    <td className="px-3 py-2 text-center tabular-nums text-gray-500">{r.attended}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────── зрители вебинара ───────────────────────────
function AudienceTab({ eventId, day }: { eventId: number; day: number }) {
  const [viewers, setViewers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<number | null>(null)
  const [timeline, setTimeline] = useState<Record<number, any[]>>({})

  useEffect(() => {
    api.webinar.audience(eventId, day).then(r => setViewers(r.viewers || [])).catch(() => {}).finally(() => setLoading(false))
  }, [eventId, day])

  async function toggle(cid: number) {
    if (openId === cid) { setOpenId(null); return }
    setOpenId(cid)
    if (!timeline[cid]) {
      const r = await api.webinar.audienceTimeline(eventId, day, cid).catch(() => ({ intervals: [] }))
      setTimeline(t => ({ ...t, [cid]: r.intervals || [] }))
    }
  }

  if (loading) return <Spinner />
  const tm = (d: string) => d ? new Date(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—'
  // дата + время (для истории входов — важна и дата)
  const dtm = (d: string) => d ? new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—'

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold">Зрители вебинара <span className="text-gray-400 font-normal">· {viewers.length}</span></h4>
      </div>
      {!viewers.length ? (
        <p className="text-sm text-gray-500">Пока никто не заходил в эфир.</p>
      ) : (
        <div className="border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs">
                <tr>
                  <th className="text-left px-3 py-2">Зритель</th>
                  <th className="text-left px-3 py-2">Контакты</th>
                  <th className="text-left px-3 py-2">Кто привёл</th>
                  <th className="px-3 py-2">Был в эфире</th>
                  <th className="px-3 py-2">Активность</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {viewers.map((v: any) => (
                  <Fragment key={v.contact_id}>
                    <tr className="border-t hover:bg-gray-50/50">
                      <td className="px-3 py-2">
                        <a href={`/dashboard/clients?contact=${v.contact_id}`} className="text-brand hover:underline font-medium">
                          {v.name || `#${v.contact_id}`}
                        </a>
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">
                        {[v.email, v.tg_username ? '@' + v.tg_username : null, v.phone].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-3 py-2 text-xs">{v.referrer_name || (v.referrer_ref_code ? v.referrer_ref_code : '—')}</td>
                      <td className="px-3 py-2 text-center text-xs">
                        {v.first_seen ? `${tm(v.first_seen)}–${tm(v.last_seen)}` : '—'}
                        {v.minutes_online ? <span className="text-gray-400"> · {v.minutes_online} мин</span> : null}
                      </td>
                      <td className="px-3 py-2 text-center text-xs tabular-nums">💬 {v.messages} · 🔥 {v.reactions}</td>
                      <td className="px-3 py-2 text-center">
                        <button onClick={() => toggle(v.contact_id)} className="text-xs text-gray-500 hover:text-gray-700">
                          {openId === v.contact_id ? '▾ история' : '▸ история'}
                        </button>
                      </td>
                    </tr>
                    {openId === v.contact_id && (
                      <tr className="bg-gray-50/50">
                        <td colSpan={6} className="px-3 py-2">
                          <div className="text-xs text-gray-600">
                            <div className="font-semibold mb-1">Заходы в эфир:</div>
                            {(timeline[v.contact_id] || []).length ? (
                              <ul className="space-y-0.5">
                                {(timeline[v.contact_id] || []).map((iv: any, i: number) => (
                                  <li key={i}>вход {dtm(iv.from)} → выход {dtm(iv.to)}</li>
                                ))}
                              </ul>
                            ) : <span className="text-gray-400">нет данных о присутствии</span>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────── управление текущим спикером ───────────────────────────
function CurrentSpeakerControl({ eventId, day, speakers, onChanged }: any) {
  const [mode, setMode] = useState<'auto' | 'manual'>(day.room?.speaker_mode || 'auto')
  const [ecId, setEcId] = useState<number | ''>(day.room?.manual_speaker_ec_id || '')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    setMode(day.room?.speaker_mode || 'auto')
    setEcId(day.room?.manual_speaker_ec_id || '')
  }, [day.room?.id, day.room?.speaker_mode, day.room?.manual_speaker_ec_id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function apply(m: 'auto' | 'manual', ec?: number) {
    try {
      await api.webinar.setCurrentSpeaker(eventId, day.day_number, m, ec)
      setMsg(m === 'auto' ? 'Спикер определяется по программе ✓' : 'Спикер задан вручную ✓')
      setTimeout(() => setMsg(''), 2000)
      onChanged?.()
    } catch (e: any) { setMsg(e?.message || 'Ошибка') }
  }

  // Кто реально показан в комнате: при manual — выбранный спикер; при auto — по программе.
  const curManual = day.room?.manual_speaker_ec_id
  const curManualName = curManual ? (speakers.find((s: any) => s.id === curManual)?.name || `#${curManual}`) : null

  return (
    <div className="border rounded-xl p-4">
      <h4 className="font-semibold mb-1">🎤 Сейчас выступает</h4>
      <p className="text-xs text-gray-500 mb-3">По умолчанию — по программе. Если программа поехала — задайте спикера вручную.</p>

      {/* Явно показываем, чей спикер/подарок сейчас в комнате */}
      {(day.room?.speaker_mode || 'auto') === 'manual' ? (
        <div className="mb-3 text-sm bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
          <span>В комнате показан вручную: <b>{curManualName || '— не выбран —'}</b> (его подарок и кнопка подписки).</span>
          <button onClick={() => { setMode('auto'); setEcId(''); apply('auto') }}
            className="shrink-0 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700">
            ✕ Убрать спикера
          </button>
        </div>
      ) : (
        <div className="mb-3 text-sm bg-gray-50 border rounded-lg px-3 py-2 text-gray-600">
          Спикер и подарок определяются по программе (по времени слота). Сейчас вне слота — ничего не показывается.
        </div>
      )}

      <div className="flex gap-2 mb-3">
        <button onClick={() => { setMode('auto'); apply('auto') }}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium ${mode === 'auto' ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600'}`}>
          Авто (по программе)
        </button>
        <button onClick={() => setMode('manual')}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium ${mode === 'manual' ? 'bg-brand text-white' : 'bg-gray-100 text-gray-600'}`}>
          Вручную
        </button>
      </div>
      {mode === 'manual' && (
        <div className="flex gap-2 items-center">
          <select className="input flex-1" value={ecId} onChange={e => setEcId(Number(e.target.value) || '')}>
            <option value="">— выберите спикера —</option>
            {speakers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button onClick={() => ecId && apply('manual', Number(ecId))} disabled={!ecId} className="btn-gold text-sm disabled:opacity-40">
            Поставить
          </button>
        </div>
      )}
      {msg && <div className="text-sm text-green-600 mt-2">{msg}</div>}
    </div>
  )
}


/** Просмотр записи эфира: слева видео, справа чат этого запуска.
 *
 * ⚠️ Чат и запись показываем ВМЕСТЕ — по отдельности они бесполезны: в списке
 * реплик не видно, к какому моменту эфира они относятся, а в записи не видно,
 * что писали зрители. Клик по реплике перематывает видео на её секунду
 * (offset_sec считает бэкенд от started_at сессии).
 */
function RecordingViewer({ eventId, day, rec, onClose }: {
  eventId: number; day: number; rec: any; onClose: () => void
}) {
  const [msgs, setMsgs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [cur, setCur] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    if (!rec.session_id) { setLoading(false); return }
    api.webinar.sessionChat(eventId, day, rec.session_id)
      .then((r: any) => setMsgs(r.messages || []))
      .catch(() => setMsgs([]))
      .finally(() => setLoading(false))
  }, [eventId, day, rec.session_id])

  const mmss = (s: number) => {
    const t = Math.max(0, Math.floor(s || 0))
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60
    const p = (n: number) => String(n).padStart(2, '0')
    return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`
  }
  const clock = (iso: string) => iso
    ? new Date(iso).toLocaleTimeString('ru-RU',
        { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
    : ''

  const seek = (sec: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, sec)
    v.play().catch(() => {})
  }

  // Подсветка реплики, звучащей сейчас, + автопрокрутка списка за видео.
  const activeIdx = (() => {
    let idx = -1
    for (let i = 0; i < msgs.length; i++) {
      if ((msgs[i].offset_sec ?? 0) <= cur) idx = i; else break
    }
    return idx
  })()

  useEffect(() => {
    if (!follow || activeIdx < 0 || !listRef.current) return
    const el = listRef.current.querySelector(`[data-i="${activeIdx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, follow])

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
         role="dialog">
      <div className="bg-white rounded-2xl w-full max-w-6xl max-h-[92vh] overflow-hidden flex flex-col"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div className="min-w-0">
            <div className="font-semibold text-[#25455D] truncate">Запись эфира</div>
            <div className="text-xs text-gray-500">
              {rec.duration_sec ? `${Math.floor(rec.duration_sec / 60)} мин` : ''}
              {msgs.length ? ` · ${msgs.length} сообщений в чате` : ''}
            </div>
          </div>
          <button onClick={onClose}
                  className="text-gray-400 hover:text-gray-700 text-2xl leading-none px-2">×</button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
          <div className="lg:flex-1 bg-black flex items-center">
            <video ref={videoRef} src={rec.url} controls preload="metadata"
                   onTimeUpdate={e => setCur((e.target as HTMLVideoElement).currentTime)}
                   className="w-full max-h-[60vh] lg:max-h-[78vh]" />
          </div>

          <div className="lg:w-[380px] flex flex-col border-t lg:border-t-0 lg:border-l min-h-0">
            <div className="px-4 py-2 border-b flex items-center justify-between">
              <span className="text-sm font-medium text-[#25455D]">Чат эфира</span>
              <label className="text-xs text-gray-500 flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={follow}
                       onChange={e => setFollow(e.target.checked)} />
                следить за видео
              </label>
            </div>
            <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0 scroll-visible">
              {loading ? <Spinner /> : !msgs.length ? (
                <p className="text-sm text-gray-500">В этом запуске сообщений не было.</p>
              ) : msgs.map((m: any, i: number) => (
                <div key={m.id} data-i={i}
                     onClick={() => seek(m.offset_sec ?? 0)}
                     className={`text-sm cursor-pointer rounded-lg px-2 py-1.5 transition
                       ${i === activeIdx ? 'bg-[#FFCFA4]/30' : 'hover:bg-gray-50'}
                       ${m.status !== 'visible' ? 'opacity-40 line-through' : ''}`}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[11px] tabular-nums text-gray-400 shrink-0">
                      {mmss(m.offset_sec ?? 0)}
                    </span>
                    <span className="font-semibold text-[#25455D]">{m.author_name || 'Гость'}</span>
                    <span className="text-[11px] text-gray-400 ml-auto shrink-0">{clock(m.at)}</span>
                  </div>
                  <div className="text-gray-700 mt-0.5">{m.text}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


/** Настройка автовебинара: какую запись крутить, когда и что пишут в чате.
 *
 * ⚠️ Отдельной сущности «автовебинар» нет — это та же комната со
 * stream_type='auto'. Продающие блоки, опросы и аналитика настраиваются на
 * своих вкладках и работают как в живом эфире.
 */
function AutoWebinarTab({ eventId, day, onSaved }: {
  eventId: number; day: any; onSaved: () => void
}) {
  const [recs, setRecs] = useState<any[]>([])
  const [sched, setSched] = useState<any[]>([])
  const [chat, setChat] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const room = day.room || {}
  const [on, setOn] = useState(room.stream_type === 'auto')
  const [recId, setRecId] = useState<number | ''>(room.auto_recording_id || '')
  const [mode, setMode] = useState(room.auto_mode || 'schedule')
  const [delay, setDelay] = useState(room.auto_delay_min ?? 15)
  const [seek, setSeek] = useState(!!room.auto_allow_seek)

  // форма запуска
  const [sKind, setSKind] = useState('daily')
  const [sTime, setSTime] = useState('19:00')
  const [sDays, setSDays] = useState<number[]>([])
  const [sDate, setSDate] = useState('')

  // форма реплики
  const [cMin, setCMin] = useState('')
  const [cName, setCName] = useState('')
  const [cText, setCText] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, sc, ch] = await Promise.all([
        api.webinar.recordings(eventId, day.day_number),
        api.webinar.autoSchedule(eventId, day.day_number).catch(() => ({ items: [] })),
        api.webinar.autoChat(eventId, day.day_number).catch(() => ({ items: [] })),
      ])
      setRecs((r.recordings || []).filter((x: any) => x.status === 'ready'))
      setSched(sc.items || []); setChat(ch.items || [])
    } finally { setLoading(false) }
  }, [eventId, day.day_number])
  useEffect(() => { load() }, [load])

  const save = async () => {
    setSaving(true)
    try {
      await api.webinar.upsertRoom(eventId, day.day_number, {
        stream_type: on ? 'auto' : 'encoder',
        auto_recording_id: recId || null,
        auto_mode: mode, auto_delay_min: Number(delay) || 0,
        auto_allow_seek: seek,
      })
      onSaved()
    } finally { setSaving(false) }
  }

  const addSched = async () => {
    await api.webinar.autoScheduleAdd(eventId, day.day_number, {
      kind: sKind, at_time: sTime, weekdays: sDays,
      once_date: sKind === 'once' ? (sDate || null) : null, is_active: true,
    })
    setSDays([]); setSDate(''); load()
  }

  const addChat = async () => {
    const sec = Math.round(parseFloat(cMin.replace(',', '.') || '0') * 60)
    await api.webinar.autoChatAdd(eventId, day.day_number, {
      at_sec: sec, author_name: cName.trim() || 'Гость', text: cText.trim(),
    })
    setCMin(''); setCText(''); load()
  }

  const fromRecord = async () => {
    const rec = recs.find(r => r.id === recId) || recs[0]
    if (!rec?.session_id) { alert('У выбранной записи нет чата эфира.'); return }
    if (!confirm('Добавить в сценарий все реплики того эфира с их таймингами?')) return
    const r: any = await api.webinar.autoChatFromRecord(eventId, day.day_number, rec.session_id)
    alert(`Добавлено реплик: ${r.added}`)
    load()
  }

  const mmss = (s: number) => {
    const t = Math.max(0, s || 0)
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
  }
  const DAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']

  if (loading) return <Spinner />

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-gray-50 border p-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={on} onChange={e => setOn(e.target.checked)}
                 className="mt-1" />
          <span>
            <b className="text-[#25455D]">Включить автовебинар</b>
            <span className="block text-sm text-gray-600 mt-0.5">
              Готовая запись показывается зрителям как живой эфир: чат, продающие
              блоки и опросы работают по таймингу.
            </span>
          </span>
        </label>
      </div>

      {on && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Какую запись показывать</label>
            {!recs.length ? (
              <p className="text-sm text-gray-500">
                Готовых записей нет. Проведите эфир — запись появится на вкладке «Записи».
              </p>
            ) : (
              <select value={recId} onChange={e => setRecId(Number(e.target.value) || '')}
                      className="w-full border rounded-lg px-3 py-2 text-sm">
                <option value="">— выберите запись —</option>
                {recs.map(r => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.started_at).toLocaleDateString('ru-RU')} ·{' '}
                    {Math.floor((r.duration_sec || 0) / 60)} мин
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Когда начинается</label>
            <div className="flex flex-wrap gap-2">
              {([['schedule', 'По расписанию — все смотрят вместе'],
                 ['on_signup', 'После регистрации — свой старт у каждого']] as const)
                .map(([k, lbl]) => (
                <button key={k} onClick={() => setMode(k)}
                        className={`px-3 py-1.5 rounded-lg text-sm ${mode === k
                          ? 'text-white' : 'bg-gray-100 text-gray-600'}`}
                        style={mode === k ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : undefined}>
                  {lbl}
                </button>
              ))}
            </div>
            {mode === 'on_signup' && (
              <div className="mt-2 flex items-center gap-2 text-sm">
                Старт через
                <input type="number" min={0} value={delay}
                       onChange={e => setDelay(Number(e.target.value))}
                       className="w-20 border rounded-lg px-2 py-1" />
                минут после захода зрителя
              </div>
            )}
          </div>

          <label className="flex items-start gap-3 text-sm cursor-pointer">
            <input type="checkbox" checked={seek} onChange={e => setSeek(e.target.checked)}
                   className="mt-0.5" />
            <span>
              Разрешить перематывать вперёд
              <span className="block text-xs text-gray-500">
                По умолчанию запрещено: перемотка «проскакивает» продающие блоки,
                которые появляются по таймингу.
              </span>
            </span>
          </label>

          <button onClick={save} disabled={saving} className="btn-gold">
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>

          {mode === 'schedule' && (
            <div className="border-t pt-5">
              <h4 className="font-semibold mb-2">🗓 Расписание запусков</h4>
              <p className="text-xs text-gray-500 mb-3">Время московское.</p>
              {sched.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  {sched.map(x => (
                    <div key={x.id} className="flex items-center justify-between border rounded-lg px-3 py-2 text-sm">
                      <span>
                        {x.kind === 'daily' ? 'Каждый день'
                          : x.kind === 'weekly' ? (x.weekdays || []).map((d: number) => DAYS[d - 1]).join(', ')
                          : x.once_date}
                        {' в '}<b>{x.at_time}</b>
                      </span>
                      <button onClick={async () => {
                        await api.webinar.autoScheduleDel(eventId, day.day_number, x.id); load()
                      }} className="text-gray-400 hover:text-red-500">Удалить</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <select value={sKind} onChange={e => setSKind(e.target.value)}
                        className="border rounded-lg px-2 py-1.5 text-sm">
                  <option value="daily">Каждый день</option>
                  <option value="weekly">По дням недели</option>
                  <option value="once">Один раз</option>
                </select>
                {sKind === 'weekly' && (
                  <div className="flex gap-1">
                    {DAYS.map((d, i) => (
                      <button key={d} onClick={() => setSDays(p =>
                        p.includes(i + 1) ? p.filter(x => x !== i + 1) : [...p, i + 1])}
                        className={`w-9 h-8 rounded-lg text-xs ${sDays.includes(i + 1)
                          ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600'}`}>{d}</button>
                    ))}
                  </div>
                )}
                {sKind === 'once' && (
                  <input type="date" value={sDate} onChange={e => setSDate(e.target.value)}
                         className="border rounded-lg px-2 py-1.5 text-sm" />
                )}
                <input type="time" value={sTime} onChange={e => setSTime(e.target.value)}
                       className="border rounded-lg px-2 py-1.5 text-sm" />
                <button onClick={addSched} className="btn-primary text-sm">Добавить</button>
              </div>
            </div>
          )}

          <div className="border-t pt-5">
            <h4 className="font-semibold mb-1">💬 Сценарий чата</h4>
            <p className="text-xs text-gray-500 mb-3">
              Реплики появляются в чате на своей минуте записи — как будто пишут зрители.
            </p>
            {recs.length > 0 && (
              <button onClick={fromRecord} className="btn-primary text-sm mb-3">
                Взять чат из прошедшего эфира
              </button>
            )}
            {chat.length > 0 && (
              <div className="space-y-1 mb-3 max-h-72 overflow-y-auto">
                {chat.map(x => (
                  <div key={x.id} className="flex items-center gap-2 text-sm border rounded-lg px-3 py-1.5">
                    <span className="tabular-nums text-xs text-gray-400 w-12 shrink-0">{mmss(x.at_sec)}</span>
                    <b className="text-[#25455D] shrink-0">{x.author_name}</b>
                    <span className="text-gray-700 truncate">{x.text}</span>
                    <button onClick={async () => {
                      await api.webinar.autoChatDel(eventId, day.day_number, x.id); load()
                    }} className="ml-auto text-gray-400 hover:text-red-500 shrink-0">✕</button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input value={cMin} onChange={e => setCMin(e.target.value)} placeholder="мин"
                     className="w-20 border rounded-lg px-2 py-1.5 text-sm" />
              <input value={cName} onChange={e => setCName(e.target.value)} placeholder="имя"
                     className="w-36 border rounded-lg px-2 py-1.5 text-sm" />
              <input value={cText} onChange={e => setCText(e.target.value)} placeholder="текст реплики"
                     className="flex-1 min-w-[200px] border rounded-lg px-2 py-1.5 text-sm" />
              <button onClick={addChat} disabled={!cText.trim()}
                      className="btn-primary text-sm disabled:opacity-40">Добавить</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
