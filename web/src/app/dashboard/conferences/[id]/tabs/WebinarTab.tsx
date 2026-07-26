'use client'
import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { Copy, RefreshCw, Trash2, Plus, BarChart3, Radio } from 'lucide-react'
import WebinarAnalytics from './WebinarAnalytics'

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
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

type SubView = 'settings' | 'blocks' | 'analytics' | 'records' | 'referrals' | 'console' | 'audience'

export default function WebinarTab({ eventId, event }: { eventId: number; event: any }) {
  const [loading, setLoading] = useState(true)
  const [level, setLevel] = useState<'room' | 'link'>('room')
  const [days, setDays] = useState<DayItem[]>([])
  const [activeDay, setActiveDay] = useState<number | null>(null)
  const [subView, setSubView] = useState<SubView>('settings')

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
        {/* Подтабы дня */}
        <div className="flex gap-2 mb-5 flex-wrap">
          {([
            ['settings', 'Настройки'],
            ['blocks', 'Продающие блоки'],
            ['analytics', 'Аналитика'],
            ['records', 'Записи'],
            ['referrals', 'Рефералы'],
            ['console', 'Пульт ведущего'],
            ['audience', 'Зрители'],
          ] as const).map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => setSub(k)}
              className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition ${
                subView === k ? 'text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              style={subView === k ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : undefined}
            >
              {lbl === 'Аналитика' && <BarChart3 size={14} className="inline mr-1 -mt-0.5" />}
              {lbl}
            </button>
          ))}
        </div>

        {subView === 'settings' && (
          <RoomSettings eventId={eventId} day={active} level={level} onSaved={load} />
        )}
        {subView === 'blocks' && (
          <BlocksEditor eventId={eventId} day={active} event={event} />
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
      </div>
    </div>
  )
}

// ─────────────────────────── настройки комнаты дня ───────────────────────────
function RoomSettings({ eventId, day, level, onSaved }: { eventId: number; day: DayItem; level: 'room' | 'link'; onSaved: () => void }) {
  const r = day.room
  const [f, setF] = useState<any>({
    title: r?.title || day.day_title || '',
    stream_type: r?.stream_type || (level === 'room' ? 'encoder' : 'external_link'),
    external_url: r?.external_url || '',
    hide_viewer_count: r?.hide_viewer_count || false,
    chat_enabled: r?.chat_enabled ?? true,
    premoderation: r?.premoderation || false,
    redirect_url: r?.redirect_url || '',
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

  useEffect(() => {
    const rr = day.room
    setF({
      title: rr?.title || day.day_title || '',
      stream_type: rr?.stream_type || (level === 'room' ? 'encoder' : 'external_link'),
      external_url: rr?.external_url || '',
      hide_viewer_count: rr?.hide_viewer_count || false,
      chat_enabled: rr?.chat_enabled ?? true,
      premoderation: rr?.premoderation || false,
      redirect_url: rr?.redirect_url || '',
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
          hide_viewer_count: rr.hide_viewer_count ?? false,
          chat_enabled: rr.chat_enabled ?? true,
          premoderation: rr.premoderation ?? false,
          redirect_url: rr.redirect_url ?? '',
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

      {isEncoder ? (
        <div className="rounded-xl bg-gray-50 border p-4 space-y-3">
          <p className="text-sm font-semibold text-gray-900">Данные для видеокодера (Zoom / OBS)</p>
          {r?.rtmp_url ? (
            <>
              <Field label="RTMP-адрес" value={r.rtmp_url} onCopy={() => copy(r.rtmp_url, 'rtmp')} copied={copied === 'rtmp'} />
              <Field label="Ключ трансляции" value={r.stream_key} onCopy={() => copy(r.stream_key, 'key')} copied={copied === 'key'} />
              <button onClick={regen} className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1">
                <RefreshCw size={12} /> Перегенерировать ключ
              </button>
            </>
          ) : (
            <p className="text-sm text-gray-500">Сохраните комнату — появятся RTMP-адрес и ключ.</p>
          )}
        </div>
      ) : (
        <div>
          <label className="label">Ссылка на стороннюю комнату</label>
          <input className="input" value={f.external_url} onChange={e => setF({ ...f, external_url: e.target.value })} placeholder="https://..." />
        </div>
      )}

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

      <div>
        <label className="label">Ссылка после завершения эфира</label>
        <input className="input" value={f.redirect_url} onChange={e => setF({ ...f, redirect_url: e.target.value })} placeholder="https://... (куда перебросить зрителя)" />
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

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="btn-gold">
          {saving ? 'Сохраняю…' : r ? 'Сохранить' : 'Создать комнату'}
        </button>
        {savedMsg && <span className="text-sm text-green-600">✓ Сохранено</span>}
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
    button: '🔘 Кнопка', form: '📝 Форма заявки', speaker_follow: '➕ Подписка на спикера', gift: '🎁 Подарок спикера',
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
    show_at_min: block.show_at_min ?? '',
    hide_at_min: block.hide_at_min ?? '',
  })
  const [saving, setSaving] = useState(false)

  async function save() {
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

  return (
    <Modal title={block.id ? 'Блок' : 'Новый блок'} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Тип блока</label>
          <select className="input" value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}>
            <option value="button">Кнопка (название + ссылка)</option>
            <option value="form">Форма заявки</option>
            <option value="speaker_follow">Подписка на спикера</option>
            <option value="gift">Подарок спикера</option>
          </select>
        </div>

        {!isSpeaker && (
          <div>
            <label className="label">Заголовок</label>
            <input className="input" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} />
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

  // авто-обновление статуса: Zoom мог начать слать поток в любой момент —
  // перечитываем комнату каждые 8 сек, чтобы кнопка «Начать эфир» ожила сама.
  useEffect(() => {
    if (status === 'live' || status === 'ended') return
    const t = setInterval(() => { onChanged() }, 8000)
    return () => clearInterval(t)
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

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
    setBlocks((r.blocks || []).filter((b: any) => b.kind === 'button' || b.kind === 'form'))
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
    button: '🔘', form: '📝', speaker_follow: '➕', gift: '🎁',
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
  const [pollQ, setPollQ] = useState('')
  const [pollOpts, setPollOpts] = useState(['', ''])
  const [battleTitle, setBattleTitle] = useState('')
  const [battleSpeakers, setBattleSpeakers] = useState<number[]>([])
  const [speakers, setSpeakers] = useState<any[]>([])
  const [msg, setMsg] = useState('')

  useEffect(() => {
    api.conference.speakers.list(eventId).then(r => setSpeakers(r.speakers || [])).catch(() => {})
  }, [eventId])

  const roomUrl = slug ? `${(typeof window !== 'undefined' ? window.location.origin : 'https://pluson.ru')}/webinar/${slug}/${day.day_number}` : ''

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
  const [recs, setRecs] = useState<any[]>([])
  const [battles, setBattles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [chatModal, setChatModal] = useState<{ msgs: any[]; loading: boolean } | null>(null)

  async function openChat(sessionId: number) {
    setChatModal({ msgs: [], loading: true })
    try {
      const r = await api.webinar.sessionChat(eventId, day, sessionId)
      setChatModal({ msgs: r.messages || [], loading: false })
    } catch { setChatModal({ msgs: [], loading: false }) }
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
                </div>
                <div className="flex gap-2 shrink-0">
                  {r.session_id && (
                    <button onClick={() => openChat(r.session_id)} className="px-3 py-1.5 rounded-lg border text-sm text-gray-600 hover:text-[#25455D]">💬 Чат</button>
                  )}
                  {r.status === 'ready' && r.url && (
                    <a href={r.url} download className="btn-gold text-sm">Скачать</a>
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

      {chatModal && (
        <Modal title="Чат этого запуска" onClose={() => setChatModal(null)}>
          {chatModal.loading ? <Spinner /> : !chatModal.msgs.length ? (
            <p className="text-sm text-gray-500">В этом запуске сообщений не было.</p>
          ) : (
            <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
              {chatModal.msgs.map((m: any) => (
                <div key={m.id} className={`text-sm ${m.status !== 'visible' ? 'opacity-40 line-through' : ''}`}>
                  <span className="font-semibold text-[#25455D]">{m.author_name || 'Гость'}:</span>{' '}
                  <span className="text-gray-700">{m.text}</span>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}

// ─────────────────────────── реферальный отчёт вебинара ───────────────────────────
function ReferralsTab({ eventId, day, slug }: { eventId: number; day: number; slug?: string }) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.webinar.referrals(eventId, day).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [eventId, day])

  if (loading) return <Spinner />
  const base = (typeof window !== 'undefined' ? window.location.origin : 'https://pluson.ru')
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
                                  <li key={i}>вход {tm(iv.from)} → выход {tm(iv.to)}</li>
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
  }, [day.room?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function apply(m: 'auto' | 'manual', ec?: number) {
    try {
      await api.webinar.setCurrentSpeaker(eventId, day.day_number, m, ec)
      setMsg(m === 'auto' ? 'Спикер определяется по программе ✓' : 'Спикер задан вручную ✓')
      setTimeout(() => setMsg(''), 2000)
      onChanged?.()
    } catch (e: any) { setMsg(e?.message || 'Ошибка') }
  }

  return (
    <div className="border rounded-xl p-4">
      <h4 className="font-semibold mb-1">🎤 Сейчас выступает</h4>
      <p className="text-xs text-gray-500 mb-3">По умолчанию — по программе. Если программа поехала — задайте спикера вручную.</p>
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
