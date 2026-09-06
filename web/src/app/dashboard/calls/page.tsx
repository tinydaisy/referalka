'use client'
/**
 * Автообзвоны — обзвон базы роботом через сервис Звонопёс (миграция 359).
 *
 * Устроено как рассылки: выбираете аудиторию тем же фильтром, выбираете
 * сценарий звонка — робот звонит и записывает, кто ответил и что нажал.
 *
 * ⚠️ Страница БЕЗ динамического сегмента и с useSearchParams → обязана быть в
 * <Suspense>, иначе сборка Next падает целиком («useSearchParams() should be
 * wrapped in a suspense boundary»). tsc эту ошибку не видит — только сборка.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  Phone, Plus, Play, X, Trash2, BarChart3, AlertTriangle, Check, Clock,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import { LockedOverlayIf } from '@/components/LockedOverlay'
import BroadcastTagPicker from '@/components/BroadcastTagPicker'

const STATUS_LABEL: Record<string, string> = {
  draft: 'Черновик',
  pending: 'В очереди',
  running: 'Звоним…',
  done: 'Завершён',
  cancelled: 'Отменён',
  failed: 'Ошибка',
}
const STATUS_CLASS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  pending: 'bg-blue-50 text-blue-700',
  running: 'bg-amber-50 text-amber-700',
  done: 'bg-green-50 text-green-700',
  cancelled: 'bg-gray-100 text-gray-500',
  failed: 'bg-red-50 text-red-700',
}

const CALL_STATUS_LABEL: Record<string, string> = {
  queued: 'Ожидает',
  answered: 'Ответил',
  no_answer: 'Не взял трубку',
  busy: 'Занято',
  declined: 'Отклонил',
  failed: 'Не дозвонились',
}

export default function CallsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">Загружаем…</div>}>
      <CallsInner />
    </Suspense>
  )
}

function CallsInner() {
  const sp = useSearchParams()
  const eventId = sp.get('event_id') ? Number(sp.get('event_id')) : undefined
  const { me, isAssistant } = useMe()

  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [settings, setSettings] = useState<any>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [logFor, setLogFor] = useState<any>(null)

  const hasFeature = !me || (me.features || []).includes('calls')

  useEffect(() => { if (hasFeature) load() }, [hasFeature, eventId])

  async function load() {
    setLoading(true)
    try {
      const [r, s] = await Promise.all([
        api.calls.list(eventId),
        api.callSettings.get().catch(() => null),
      ])
      setItems(r.campaigns || [])
      setSettings(s)
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }

  async function start(c: any) {
    if (!confirm(`Запустить обзвон «${c.name}»? Звонки платные — деньги спишутся с вашего счёта в Звонопсе.`)) return
    try {
      const r = await api.calls.start(c.id)
      alert(`Обзвон запущен. В очереди: ${r.queued} номеров.`)
      load()
    } catch (e: any) { alert(e.message) }
  }

  async function cancel(c: any) {
    if (!confirm(`Отменить обзвон «${c.name}»? Ещё не состоявшиеся звонки будут сняты.`)) return
    try { await api.calls.cancel(c.id); load() } catch (e: any) { alert(e.message) }
  }

  async function remove(c: any) {
    if (!confirm(`Удалить обзвон «${c.name}»? Результаты тоже удалятся.`)) return
    try { await api.calls.remove(c.id); load() } catch (e: any) { alert(e.message) }
  }

  // ⚠️ Раздел не подменяем замком: содержимое видно замыленным,
  // чтобы человек видел, что данные на месте. Запрет — на сервере.
  const locked = Boolean(me) && !hasFeature

  const notConfigured = settings && !settings.is_configured

  return (
    <LockedOverlayIf locked={locked} feature="calls">    <div className="p-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <Phone size={22} /> Автообзвоны
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Обзвон базы роботом через сервис Звонопёс. Аудитория выбирается так же, как в рассылках.
          </p>
        </div>
        {!isAssistant && (
          <button
            onClick={() => { setEditing(null); setShowForm(true) }}
            disabled={!!notConfigured}
            className="btn-gold inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Plus size={16} /> Новый обзвон
          </button>
        )}
      </div>

      {/* Не подключён сервис — объясняем, куда идти. Без этого кнопка просто
          не работает, и причина непонятна. */}
      {notConfigured && (
        <div className="rounded-xl bg-amber-50 border border-amber-100 p-4 mb-5 text-sm text-amber-900">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Звонопёс ещё не подключён</p>
              <p className="mt-0.5">
                Укажите API-ключ и номер, с которого звонить, в{' '}
                <Link href="/dashboard/settings?tab=integration" className="underline font-medium">
                  Настройках → Интеграция
                </Link>.
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-100 p-3 mb-4 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500">Загружаем…</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center">
          <Phone size={32} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-700 font-medium">Обзвонов пока нет</p>
          <p className="text-sm text-gray-500 mt-1">
            Создайте обзвон — робот позвонит выбранной части базы и запишет, кто что ответил.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(c => (
            <div key={c.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-800">{c.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_CLASS[c.status] || 'bg-gray-100 text-gray-600'}`}>
                      {STATUS_LABEL[c.status] || c.status}
                    </span>
                    {c.event_title && (
                      <span className="text-xs text-gray-500">· {c.event_title}</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-1 space-x-3">
                    {c.fire_at && (
                      <span className="inline-flex items-center gap-1">
                        <Clock size={11} /> {fmt(c.fire_at)}
                      </span>
                    )}
                    {c.targets_total > 0 && <span>номеров: {c.targets_total}</span>}
                    {Number(c.calls_answered) > 0 && (
                      <span className="text-green-600">ответили: {c.calls_answered}</span>
                    )}
                    {c.start_time && c.end_time && (
                      <span>звоним {c.start_time}–{c.end_time} МСК</span>
                    )}
                  </div>
                  {c.error_log && (
                    <p className="text-xs text-red-600 mt-1">{c.error_log}</p>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {Number(c.calls_total) > 0 && (
                    <button onClick={() => setLogFor(c)}
                            title="Результаты"
                            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500">
                      <BarChart3 size={16} />
                    </button>
                  )}
                  {!isAssistant && c.status === 'draft' && (
                    <>
                      <button onClick={() => { setEditing(c); setShowForm(true) }}
                              className="text-sm px-3 py-1.5 rounded-lg hover:bg-gray-100 text-gray-600">
                        Изменить
                      </button>
                      <button onClick={() => start(c)} title="Запустить"
                              className="p-2 rounded-lg hover:bg-green-50 text-green-600">
                        <Play size={16} />
                      </button>
                    </>
                  )}
                  {!isAssistant && ['pending', 'running'].includes(c.status) && (
                    <button onClick={() => cancel(c)} title="Отменить"
                            className="p-2 rounded-lg hover:bg-amber-50 text-amber-600">
                      <X size={16} />
                    </button>
                  )}
                  {!isAssistant && c.status !== 'running' && (
                    <button onClick={() => remove(c)} title="Удалить"
                            className="p-2 rounded-lg hover:bg-red-50 text-red-500">
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <CampaignModal
          eventId={eventId}
          initial={editing}
          onClose={() => { setShowForm(false); setEditing(null) }}
          onSaved={() => { setShowForm(false); setEditing(null); load() }}
        />
      )}
      {logFor && <LogModal campaign={logFor} onClose={() => setLogFor(null)} />}
    </div>
  )
}

function fmt(iso: string) {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }) + ' МСК'
  } catch { return iso }
}

// ─── Форма обзвона ───────────────────────────────────────────────────────────
function CampaignModal({ eventId, initial, onClose, onSaved }: any) {
  const [name, setName] = useState(initial?.name || 'Обзвон')
  const [templateId, setTemplateId] = useState<number | ''>(initial?.template_id || '')
  const [templates, setTemplates] = useState<any[] | null>(null)
  const [tagsInc, setTagsInc] = useState<string[]>(initial?.audience_tags_include || [])
  const [tagsExc, setTagsExc] = useState<string[]>(initial?.audience_tags_exclude || [])
  const [audIn, setAudIn] = useState(initial?.audience_include || (eventId ? 'all_event' : 'all_client'))
  const [audEx, setAudEx] = useState(initial?.audience_exclude || 'none')
  const [startTime, setStartTime] = useState(initial?.start_time || '10:00')
  const [endTime, setEndTime] = useState(initial?.end_time || '20:00')
  const [smartDelay, setSmartDelay] = useState<number | ''>(initial?.smart_delay || 60)
  const [requireConsent, setRequireConsent] = useState(false)
  const [fireAt, setFireAt] = useState('')
  const [count, setCount] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // ⚠️ Замок повторной отправки — useRef, а не состояние: состояние применяется
  // к следующей перерисовке, и два быстрых клика проходят оба.
  const busy = useRef(false)

  useEffect(() => {
    api.callSettings.templates()
      .then((r: any) => setTemplates(r.templates || []))
      .catch(() => setTemplates([]))
  }, [])

  // Пересчитываем охват при смене фильтров.
  useEffect(() => {
    const t = setTimeout(() => {
      api.calls.audienceCount({
        event_id: eventId,
        audience_include: audIn,
        audience_exclude: audEx,
        audience_tags_include: tagsInc,
        audience_tags_exclude: tagsExc,
        require_consent: requireConsent,
      }).then(setCount).catch(() => setCount(null))
    }, 400)
    return () => clearTimeout(t)
  }, [eventId, audIn, audEx, tagsInc, tagsExc, requireConsent])

  async function save() {
    if (busy.current) return
    if (!templateId) { setError('Выберите сценарий звонка.'); return }
    busy.current = true
    setSaving(true); setError('')
    try {
      const payload: any = {
        name, event_id: eventId, template_id: Number(templateId),
        audience_include: audIn, audience_exclude: audEx,
        audience_tags_include: tagsInc, audience_tags_exclude: tagsExc,
        start_time: startTime, end_time: endTime,
        smart_delay: smartDelay === '' ? null : Number(smartDelay),
        fire_at: fireAt || null,
      }
      if (initial?.id) await api.calls.update(initial.id, payload)
      else await api.calls.create(payload)
      onSaved()
    } catch (e: any) {
      setError(e.message); busy.current = false
    } finally { setSaving(false) }
  }

  return (
    // ⚠️ Модалка-форма НЕ закрывается по клику на фон — иначе теряется ввод.
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-2xl my-8 p-6" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-gray-800 mb-4">
          {initial ? 'Изменить обзвон' : 'Новый обзвон'}
        </h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Название</label>
            <input value={name} onChange={e => setName(e.target.value)} className="input" />
            <p className="text-xs text-gray-500 mt-1">Видно только вам — чтобы отличать обзвоны в списке.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Сценарий звонка</label>
            {templates === null ? (
              <div className="text-sm text-gray-500">Загружаем сценарии…</div>
            ) : templates.length === 0 ? (
              <div className="rounded-xl bg-amber-50 border border-amber-100 p-3 text-sm text-amber-900">
                Сценариев нет. Создайте шаблон в кабинете Звонопса (раздел «Шаблоны API»)
                и дождитесь модерации — незаверенный шаблон не позвонит.
              </div>
            ) : (
              <select value={templateId} onChange={e => setTemplateId(Number(e.target.value) || '')} className="input">
                <option value="">— выберите сценарий —</option>
                {templates.map((t: any) => (
                  <option key={t.id} value={t.id}>{t.name || `Шаблон ${t.id}`}</option>
                ))}
              </select>
            )}
          </div>

          {eventId && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Кому звоним</label>
                <select value={audIn} onChange={e => setAudIn(e.target.value)} className="input">
                  <option value="all_event">Всем участникам события</option>
                  <option value="registered_event">Зарегистрированным</option>
                  <option value="unregistered_event">Не зарегистрированным</option>
                  <option value="paid_event">Оплатившим</option>
                  <option value="unpaid_event">Не оплатившим</option>
                  <option value="all_client">Всей базе</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Исключить</label>
                <select value={audEx} onChange={e => setAudEx(e.target.value)} className="input">
                  <option value="none">Никого</option>
                  <option value="registered_event">Зарегистрированных</option>
                  <option value="unregistered_event">Не зарегистрированных</option>
                  <option value="paid_event">Оплативших</option>
                  <option value="unpaid_event">Не оплативших</option>
                </select>
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Фильтр по тегам</label>
            <BroadcastTagPicker
              include={tagsInc} exclude={tagsExc}
              onChange={(inc, exc) => { setTagsInc(inc); setTagsExc(exc) }}
            />
          </div>

          {/* Охват. ⚠️ Показываем ОБЕ цифры: телефон есть далеко не у всех, и без
              второй клиент решит, что обзвон сломался. */}
          {count && (
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 text-sm text-blue-900">
              Дозвонимся до <b>{count.reachable}</b> из <b>{count.total}</b> человек.
              {count.skipped_no_phone > 0 && (
                <span className="block text-xs mt-0.5">
                  У {count.skipped_no_phone} нет телефона — им звонок не уйдёт.
                </span>
              )}
              {count.skipped_unsub > 0 && (
                <span className="block text-xs mt-0.5">
                  {count.skipped_unsub} отказались от звонков.
                </span>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Звонить с</label>
              <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">по (МСК)</label>
              <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} className="input" />
            </div>
          </div>
          <p className="text-xs text-gray-500 -mt-2">
            Звонок ранним утром или ночью — верный путь к жалобе. Окно соблюдает сервис.
          </p>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Перезвонить тем, кто не взял трубку (минут)
            </label>
            <input type="number" min={2} max={1440} value={smartDelay}
                   onChange={e => setSmartDelay(e.target.value === '' ? '' : Number(e.target.value))}
                   className="input max-w-[160px]" />
            <p className="text-xs text-gray-500 mt-1">
              Пусто — не перезванивать. От 2 до 1440 минут.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Когда начать</label>
            <input type="datetime-local" value={fireAt} onChange={e => setFireAt(e.target.value)} className="input max-w-xs" />
            <p className="text-xs text-gray-500 mt-1">
              Пусто — начнём сразу после нажатия «Запустить».
            </p>
          </div>

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-100 p-3 text-sm text-red-700">{error}</div>
          )}
        </div>

        <div className="flex items-center gap-2 mt-6">
          <button onClick={save} disabled={saving} className="btn-gold disabled:opacity-50">
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button onClick={onClose} className="btn-primary text-sm">Отмена</button>
        </div>
      </div>
    </div>
  )
}

// ─── Результаты обзвона ──────────────────────────────────────────────────────
function LogModal({ campaign, onClose }: any) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.calls.log(campaign.id)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [campaign.id])

  const stats = data?.stats || {}

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-3xl my-8 p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-800">Результаты · {campaign.name}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="text-sm text-gray-500">Загружаем…</div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
              <Stat label="Всего" value={stats.total} />
              <Stat label="Ответили" value={stats.answered} tone="green" />
              <Stat label="Не взяли трубку" value={stats.no_answer} />
              <Stat label="Потрачено" value={stats.total_cost != null ? `${Number(stats.total_cost).toFixed(2)} ₽` : '—'} />
            </div>

            <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-gray-100">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr className="text-left text-gray-600">
                    <th className="px-3 py-2 font-medium">Кто</th>
                    <th className="px-3 py-2 font-medium">Телефон</th>
                    <th className="px-3 py-2 font-medium">Итог</th>
                    <th className="px-3 py-2 font-medium">Ответ</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.calls || []).map((c: any) => (
                    <tr key={c.id} className="border-t border-gray-100">
                      <td className="px-3 py-2">{c.contact_name || '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{c.phone}</td>
                      <td className="px-3 py-2">
                        <span className={c.status === 'answered' ? 'text-green-600' : 'text-gray-600'}>
                          {CALL_STATUS_LABEL[c.status] || c.status}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {c.ivr_answer
                          ? <span className="inline-flex items-center gap-1 text-blue-700">
                              <Check size={12} /> нажал {c.ivr_answer}
                            </span>
                          : <span className="text-gray-400">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(data?.calls || []).length === 0 && (
                <div className="p-6 text-center text-sm text-gray-500">Звонков пока нет.</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: any; tone?: string }) {
  return (
    <div className={`rounded-xl p-3 ${tone === 'green' ? 'bg-green-50' : 'bg-gray-50'}`}>
      <div className={`text-xl font-semibold ${tone === 'green' ? 'text-green-700' : 'text-gray-800'}`}>
        {value ?? 0}
      </div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  </LockedOverlayIf>
  )
}
