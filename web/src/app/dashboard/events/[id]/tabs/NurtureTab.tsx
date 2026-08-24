'use client'
import { useState, useEffect, useRef } from 'react'
import { Plus, Trash2, Clock, Save, ExternalLink, RotateCcw } from 'lucide-react'
import { api } from '@/lib/api'

interface Step {
  id: number
  sort_order: number
  offset_seconds: number
  text: string
  button_label: string
  button_kind: 'event' | 'support'
  is_active: boolean
}

interface Props {
  eventId: number
  /** Коллаб-событие — доступен плейсхолдер {support_link_org} (служба заботы того,
   *  от кого пришёл участник: в коллабе у каждого организатора своя база и свой бот). */
  isCollab?: boolean
}

// Единицы для интервалов. Множитель в секундах.
type Unit = 'seconds' | 'minutes' | 'hours' | 'days'
const UNIT_FACTORS: Record<Unit, number> = {
  seconds: 1,
  minutes: 60,
  hours:   3600,
  days:    86400,
}
const UNIT_LABELS: Record<Unit, [string, string, string]> = {
  seconds: ['секунда',  'секунды',  'секунд'],
  minutes: ['минута',   'минуты',   'минут'],
  hours:   ['час',      'часа',     'часов'],
  days:    ['сутки',    'суток',    'суток'],
}

function plural(n: number, one: string, few: string, many: string) {
  const m = n % 10, t = n % 100
  if (m === 1 && t !== 11) return one
  if (m >= 2 && m <= 4 && (t < 12 || t > 14)) return few
  return many
}

function secondsToValueUnit(sec: number): { value: number; unit: Unit } {
  if (sec === 0) return { value: 0, unit: 'minutes' }
  if (sec % 86400 === 0) return { value: sec / 86400, unit: 'days' }
  if (sec % 3600 === 0)  return { value: sec / 3600,  unit: 'hours' }
  if (sec % 60 === 0)    return { value: sec / 60,    unit: 'minutes' }
  return { value: sec, unit: 'seconds' }
}

function formatOffset(sec: number): string {
  if (sec === 0) return 'сразу'
  const { value, unit } = secondsToValueUnit(sec)
  const [one, few, many] = UNIT_LABELS[unit]
  return `через ${value} ${plural(value, one, few, many)}`
}

// Рендер предпросмотра «как в Telegram». Логика:
//  1) экранируем сырой текст шаблона (он от клиента — мог содержать опечатки в тегах);
//  2) возвращаем разрешённые inline-теги Telegram (<b>/<i>/<u>/<s>/<a>/<br>);
//  3) ТОЛЬКО ПОТОМ подставляем плейсхолдеры — их значения (chats/ссылки/контакты)
//     мы формируем сами на бэке, это доверенный HTML, экранировать его не нужно.
const ALLOWED_INLINE = /&lt;(\/?(?:b|strong|i|em|u|s|br\s*\/?))&gt;/gi
function escapeHtml(x: string): string {
  return (x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function restoreTags(s: string): string {
  return s
    .replace(ALLOWED_INLINE, '<$1>')
    .replace(/&lt;a href=&quot;([^&]*?)&quot;&gt;/gi,
      (_m, href) => `<a href="${href}" style="color:#2563eb;text-decoration:underline" target="_blank" rel="noopener">`)
    .replace(/&lt;\/a&gt;/gi, '</a>')
}
function renderPreviewHtml(raw: string, vars: Record<string, string>): string {
  // 1+2: экранируем текст шаблона и возвращаем разрешённые теги
  let s = restoreTags(escapeHtml(raw || ''))
  // 3: подставляем плейсхолдеры доверенными HTML-значениями
  for (const [k, v] of Object.entries(vars)) {
    s = s.split(`{${k}}`).join(v ?? '')
  }
  // оставшиеся неизвестные {placeholder} — серой меткой
  s = s.replace(/\{([a-z_]+)\}/gi, '<span style="color:#9ca3af">{$1}</span>')
  // переносы строк → <br>
  s = s.replace(/\n/g, '<br/>')
  return s
}

type Audience = 'unreg' | 'reg'

export default function NurtureTab({ eventId, isCollab }: Props) {
  const [audience, setAudience] = useState<Audience>('unreg')
  return (
    <div className="space-y-4">
      {/* Подвкладки: незарегистрированным / зарегистрированным */}
      <div className="flex gap-2">
        <button
          onClick={() => setAudience('unreg')}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
            audience === 'unreg'
              ? 'text-white'
              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
          }`}
          style={audience === 'unreg' ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : {}}
        >
          Незарегистрированным
        </button>
        <button
          onClick={() => setAudience('reg')}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
            audience === 'reg'
              ? 'text-white'
              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
          }`}
          style={audience === 'reg' ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : {}}
        >
          Зарегистрированным
        </button>
      </div>

      {/* Один и тот же редактор шагов, разный API-клиент и тексты-подсказки */}
      {audience === 'unreg'
        ? <NurtureEditor eventId={eventId} audience="unreg" isCollab={isCollab} />
        : <NurtureEditor eventId={eventId} audience="reg" isCollab={isCollab} />}
    </div>
  )
}

// ─── Редактор шагов одной воронки ──────────────────────────────────────

function NurtureEditor({ eventId, audience, isCollab }: { eventId: number; audience: Audience; isCollab?: boolean }) {
  const client = audience === 'unreg' ? api.eventNurture : api.eventNurtureReg

  const [steps, setSteps] = useState<Step[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Record<number, Partial<Step>>>({})
  const [previewUrls, setPreviewUrls] = useState<any>(null)
  const lastAddedRef = useRef<number | null>(null)
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({})

  useEffect(() => {
    client.previewUrls(eventId).then((r: any) => setPreviewUrls(r || null)).catch(() => {})
  }, [eventId, audience])

  useEffect(() => {
    if (lastAddedRef.current && steps.find(s => s.id === lastAddedRef.current)) {
      const el = cardRefs.current[lastAddedRef.current]
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.style.outline = '2px solid #FFCFA4'
        setTimeout(() => { if (el) el.style.outline = '' }, 2000)
      }
      lastAddedRef.current = null
    }
  }, [steps])

  async function load() {
    setLoading(true)
    try {
      const r = await client.list(eventId)
      setSteps(r.steps || [])
      setDrafts({})
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [eventId, audience])

  function patchDraft(stepId: number, p: Partial<Step>) {
    setDrafts(d => ({ ...d, [stepId]: { ...d[stepId], ...p } }))
  }

  async function saveStep(s: Step) {
    const d = drafts[s.id]
    if (!d) return
    setSaving(s.id)
    try {
      await client.update(s.id, d)
      await load()
    } finally {
      setSaving(null)
    }
  }

  async function toggleActive(s: Step) {
    await client.update(s.id, { is_active: !s.is_active })
    load()
  }

  async function deleteStep(s: Step) {
    if (!confirm(`Удалить этот шаг воронки догрева?`)) return
    await client.remove(s.id)
    load()
  }

  async function restoreDefaults() {
    if (!confirm('Добавить шаги по умолчанию?\n\nОни появятся выключенными в конце списка. То, что уже написано, останется на месте.')) return
    await client.restoreDefaults(eventId)
    load()
  }

  async function addStep() {
    const lastOffset = steps.length ? steps[steps.length - 1].offset_seconds : 30 * 60
    const r = await client.create(eventId, {
      offset_seconds: lastOffset + 86400,
      text: 'Новое сообщение воронки. Допишите текст и включите шаг ↑',
      button_label: audience === 'reg' ? '' : 'Зарегистрироваться',
      button_kind: 'event',
      is_active: false,
    })
    lastAddedRef.current = r?.id || null
    load()
  }

  if (loading) {
    return <div className="text-sm text-gray-400 py-8">Загрузка…</div>
  }

  // Значения плейсхолдеров для предпросмотра. Известные — реальные из API,
  // остальные — примерные подписи. {chats} рендерим как HTML-блок.
  const previewVars: Record<string, string> = audience === 'reg'
    ? {
        event_title: previewUrls?.event_title || 'Название события',
        chats: previewUrls?.chats_html || '<i>(чаты события не заданы)</i>',
        bot_handle: previewUrls?.bot_handle || '(ваш бот)',
        // В коллабе — служба заботы организатора, приведшего участника (в превью показываем свою).
        support_link_org: previewUrls?.support_link || 'в этом боте',
        support_link: previewUrls?.support_link || 'в этом боте',
        program_link: previewUrls?.program_link || '',
        gifts_link: previewUrls?.gifts_link || '',
        speakers_link: previewUrls?.speakers_link || '',
        vip_link: previewUrls?.vip_link || '',
      }
    : {
        event_title: previewUrls?.event_title || 'Название события',
        event_date_short: '28 мая в 11:00 МСК',
        owner_telegram: previewUrls?.owner_telegram || '@organizer',
        support_link_org: previewUrls?.support_link || 'в этом боте',
        support_link: previewUrls?.support_link || 'в этом боте',
        brand_name: previewUrls?.brand_name ? `«${previewUrls.brand_name}»` : '',
      }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Clock size={18} /> {audience === 'reg' ? 'Воронка догрева — зарегистрированным' : 'Воронка догрева — незарегистрированным'}
        </h3>
        {audience === 'reg' ? (
          <p className="text-sm text-gray-500 mt-1">
            Серия сообщений человеку, который <b>зарегистрировался</b> на событие. Помогает
            не потеряться: вступить в чаты, закрепить бота. Отсчёт интервалов идёт от момента
            регистрации. Останавливается автоматически, когда событие завершается.
          </p>
        ) : (
          <p className="text-sm text-gray-500 mt-1">
            Серия сообщений человеку, который открыл событие, но <b>не зарегистрировался</b>.
            Отсчёт интервалов идёт от момента первого открытия — каждый получает в своё время.
            Останавливается автоматически, когда человек регистрируется или событие завершается.
          </p>
        )}
        <p className="text-xs text-gray-500 mt-2">
          Поддерживается HTML-форматирование: <code>&lt;b&gt;жирный&lt;/b&gt;</code>,{' '}
          <code>&lt;i&gt;курсив&lt;/i&gt;</code>, <code>&lt;a href="..."&gt;ссылка&lt;/a&gt;</code>.
          {' '}<span className="text-amber-700">
            Работает только в&nbsp;Telegram и&nbsp;MAX — в&nbsp;ВКонтакте теги срезаются автоматически
            (отправляется чистый текст).
          </span>
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Плейсхолдеры в тексте подставляются автоматически при отправке:
        </p>
        <ul className="text-xs text-gray-500 mt-1 ml-4 list-disc space-y-0.5">
          <li><code>{'{event_title}'}</code> — название события</li>
          {isCollab && (
            <li className="text-[#C77B3B]">
              <code>{'{support_link_org}'}</code> — <b>служба заботы того организатора, от которого пришёл участник</b>.
              Это совместное событие: у каждого организатора своя база и свой бот, поэтому человеку
              подставятся контакты именно «его» организатора (того, по чьей ссылке он пришёл).
              Если определить не удалось — подставится ваша служба заботы.
            </li>
          )}
          {audience === 'unreg' && (
            <>
              <li><code>{'{event_date_short}'}</code> — дата в формате «28 мая в 11:00 МСК»</li>
              <li><code>{'{owner_telegram}'}</code> — Telegram-контакт организатора из настроек профиля</li>
              <li><code>{'{support_link}'}</code> — служба поддержки (поле в Профиле). Если пусто — «в этом боте»</li>
              <li><code>{'{brand_name}'}</code> — название вашего бренда</li>
            </>
          )}
          {audience === 'reg' && (
            <>
              <li><code>{'{chats}'}</code> — список чатов события (TG/VK/MAX), главный сверху и жирным</li>
              <li><code>{'{bot_handle}'}</code> — @ник бота, через который пришло сообщение</li>
              <li><code>{'{support_link}'}</code> — служба поддержки (поле в Профиле)</li>
              <li><code>{'{program_link}'}</code> — раздел «Программа» в Mini App</li>
              <li><code>{'{gifts_link}'}</code> — раздел «Подарки» (если включена реф-программа)</li>
              <li><code>{'{speakers_link}'}</code> — раздел «Спикеры» (для конференций/турниров)</li>
              <li><code>{'{vip_link}'}</code> — ссылка на VIP-тариф (если задана)</li>
            </>
          )}
        </ul>
        {audience === 'reg' && previewUrls?.chats_html && (
          <div className="text-[11px] text-gray-400 mt-2">
            <span>Предпросмотр блока <code>{'{chats}'}</code>:</span>
            <div className="ml-2 mt-1 p-2 bg-gray-50 rounded border border-gray-100"
                 dangerouslySetInnerHTML={{ __html: previewUrls.chats_html.replace(/\n/g, '<br/>') }} />
          </div>
        )}
        {audience === 'reg' && !previewUrls?.chats_html && (
          <p className="text-[11px] text-amber-700 mt-2">
            ⚠️ Чаты события не заданы — плейсхолдер <code>{'{chats}'}</code> будет пустым.
            Заполните ссылки на чаты во вкладке «Настройки» события.
          </p>
        )}
      </div>

      {/* Один раз на весь раздел, НАД списком шагов. Очередь догрева проверяется
          раз в 5 минут (celery beat nurture-tick / nurture-reg-tick, 300 сек),
          поэтому шаг уходит не ровно в свою секунду. Без этой подписи клиент
          считает опоздание поломкой (жалоба 2026-08-17: «пришло через 19 минут
          вместо 15»). */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 mb-4 text-[13px] text-blue-900">
        Отправка может опоздать на несколько минут: очередь проверяется
        раз в 5 минут. Указали 15 минут — придёт в промежутке 15–20.
      </div>

      {steps.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500">
          Шагов пока нет. Добавьте первый ниже.
        </div>
      ) : (
        steps.map((s, i) => {
          const d = drafts[s.id] || {}
          const dirty = Object.keys(d).length > 0
          const currentOffset = d.offset_seconds ?? s.offset_seconds
          const currentText = d.text ?? s.text
          const currentLabel = d.button_label ?? s.button_label
          const currentKind = (d.button_kind ?? s.button_kind) || 'event'
          const hasButton = !!(currentLabel && currentLabel.trim())
          const { value: vuValue, unit: vuUnit } = secondsToValueUnit(currentOffset)
          const tgUrl = previewUrls?.tg_url || previewUrls?.program_link || ''
          const vkUrl = previewUrls?.vk_url || ''
          return (
            <div
              key={s.id}
              ref={el => { cardRefs.current[s.id] = el }}
              className={`bg-white rounded-2xl border shadow-sm p-5 transition-all ${s.is_active ? 'border-gray-100' : 'border-gray-200 bg-gray-50 opacity-75'}`}>
              <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                       style={{ background: '#FFCFA4', color: '#25455D' }}>
                    {i + 1}
                  </div>
                  <span className="text-sm font-semibold text-gray-900">
                    Шаг {i + 1} — {formatOffset(currentOffset)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input type="checkbox" checked={s.is_active} onChange={() => toggleActive(s)} />
                    <span className="text-gray-600">{s.is_active ? 'Включён' : 'Выключен'}</span>
                  </label>
                  <button onClick={() => deleteStep(s)}
                          className="p-1.5 text-gray-400 hover:text-red-500 rounded">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Через</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min={0}
                      value={vuValue}
                      onChange={e => {
                        const v = Math.max(0, Number(e.target.value) || 0)
                        patchDraft(s.id, { offset_seconds: v * UNIT_FACTORS[vuUnit] })
                      }}
                      className="w-20 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                    />
                    <select
                      value={vuUnit}
                      onChange={e => {
                        const newUnit = e.target.value as Unit
                        patchDraft(s.id, { offset_seconds: (vuValue || 0) * UNIT_FACTORS[newUnit] })
                      }}
                      className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                    >
                      <option value="seconds">секунд</option>
                      <option value="minutes">минут</option>
                      <option value="hours">часов</option>
                      <option value="days">суток</option>
                    </select>
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1">
                    {audience === 'reg' ? 'от момента регистрации' : 'от первого открытия события'}
                  </p>
                </div>
                <div className="sm:col-span-2">
                  {/* Тоггл «Добавить кнопку»: выкл → кнопки нет, сообщение уходит просто текстом */}
                  <label className="flex items-center gap-2 text-xs text-gray-700 mb-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hasButton}
                      onChange={e => patchDraft(s.id, {
                        button_label: e.target.checked
                          ? (audience === 'reg' ? 'Открыть программу' : 'Зарегистрироваться')
                          : '',
                      })}
                    />
                    <span className="font-medium">Добавить кнопку под сообщением</span>
                  </label>
                  {!hasButton && (
                    <div className="text-[11px] text-gray-400 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                      Без кнопки — сообщение уйдёт просто текстом. Включите галочку выше, чтобы добавить кнопку.
                    </div>
                  )}
                  {hasButton && (
                    <>
                      <label className="block text-xs text-gray-500 mb-1">Надпись на кнопке</label>
                      <input
                        value={currentLabel}
                        onChange={e => patchDraft(s.id, { button_label: e.target.value })}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                        placeholder={audience === 'reg' ? 'Например: Открыть программу' : 'Зарегистрироваться'}
                      />
                      <div className="mt-2">
                        <label className="block text-xs text-gray-500 mb-1">Кнопка ведёт на</label>
                        <select
                          value={currentKind}
                          onChange={e => patchDraft(s.id, { button_kind: e.target.value as 'event' | 'support' })}
                          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                        >
                          <option value="event">{audience === 'reg' ? 'Программу события' : 'Страницу события'}</option>
                          <option value="support">Службу поддержки (Telegram)</option>
                        </select>
                      </div>
                      {currentKind === 'event' && (tgUrl || vkUrl) && (
                        <div className="text-[11px] text-gray-400 mt-1 space-y-0.5">
                          <div className="flex items-start gap-1">
                            <ExternalLink size={11} className="mt-0.5 shrink-0" />
                            <span>Ведёт в Mini App вашего бота:</span>
                          </div>
                          {tgUrl && <div className="ml-4"><code className="text-[10px]">TG: {tgUrl}</code></div>}
                          {vkUrl && <div className="ml-4"><code className="text-[10px]">VK: {vkUrl}</code></div>}
                        </div>
                      )}
                      {currentKind === 'support' && (
                        <p className="text-[11px] text-gray-400 mt-1">
                          Ведёт на ваш Telegram службы поддержки (поле «Служба поддержки» в Профиле).
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="mt-3">
                <label className="block text-xs text-gray-500 mb-1">Текст сообщения (HTML)</label>
                <textarea
                  value={currentText}
                  onChange={e => patchDraft(s.id, { text: e.target.value })}
                  rows={6}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D] font-mono"
                  placeholder="Текст с HTML-разметкой..."
                />
              </div>

              {/* Предпросмотр сообщения — как придёт в Telegram */}
              <div className="mt-3">
                <label className="block text-xs text-gray-500 mb-1">Предпросмотр (как в Telegram)</label>
                <div className="rounded-2xl px-3 py-3" style={{ background: '#e7f3ff' }}>
                  <div
                    className="text-sm text-gray-900 leading-relaxed"
                    style={{ wordBreak: 'break-word' }}
                    dangerouslySetInnerHTML={{ __html: renderPreviewHtml(currentText, previewVars) }}
                  />
                  {hasButton && currentLabel && (
                    <div className="mt-2 pt-2 border-t" style={{ borderColor: '#cfe4fb' }}>
                      <div
                        className="w-full text-center py-2 rounded-lg text-sm font-medium"
                        style={{ background: '#ffffff', color: '#2563eb' }}
                      >
                        {currentLabel}
                      </div>
                    </div>
                  )}
                </div>
                <p className="text-[11px] text-gray-400 mt-1">
                  Плейсхолдеры подставлены примерными значениями. В реальном сообщении — данные конкретного человека и события.
                </p>
              </div>

              <div className="mt-3 flex justify-end">
                <button
                  onClick={() => saveStep(s)}
                  disabled={!dirty || saving === s.id}
                  className="px-4 py-2 rounded-lg text-white font-semibold text-sm inline-flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
                >
                  <Save size={14} /> {saving === s.id ? 'Сохранение…' : dirty ? 'Сохранить' : 'Сохранено'}
                </button>
              </div>
            </div>
          )
        })
      )}

      <div className="flex flex-col sm:flex-row gap-2">
        <button
          onClick={addStep}
          className="flex-1 py-3 rounded-xl border-2 border-dashed border-gray-200 text-sm font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 inline-flex items-center justify-center gap-2"
        >
          <Plus size={16} /> Добавить ещё шаг
        </button>
        <button
          onClick={restoreDefaults}
          title="Добавит стандартные шаги выключенными — то, что уже написано, не тронет"
          className="flex-1 py-3 rounded-xl border-2 border-dashed border-gray-200 text-sm font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 inline-flex items-center justify-center gap-2"
        >
          <RotateCcw size={16} /> Вернуть шаги по умолчанию
        </button>
      </div>
    </div>
  )
}
