'use client'
import { useState } from 'react'
import { Save } from 'lucide-react'
import { api } from '@/lib/api'
import PublicLinks from '@/components/PublicLinks'
import ExternalLandingBlock from '@/components/ExternalLandingBlock'

export default function OverviewTab({
  event, eventId, onReload,
}: {
  event: any
  eventId: number
  onReload: () => Promise<void>
}) {
  const [title, setTitle] = useState(event.title || '')
  const [description, setDescription] = useState(event.description || '')
  const [landingUrl, setLandingUrl] = useState(event.landing_url || '')
  // «Ссылка на ZOOM/стрим» сохраняется в events.stream_url (как у конференции),
  // потому что ProgramTab Mini App рендерит блок стрима по stream_url.
  // Раньше поле сохраняло в events.address — старые данные подтягиваются как fallback.
  const [streamUrl, setStreamUrl] = useState(event.stream_url || event.address || '')
  const [chatUrl, setChatUrl] = useState(event.chat_url || '')
  const [vipUrl, setVipUrl] = useState(event.vip_url || '')
  const [startAt, setStartAt] = useState(toLocalInput(event.start_at))
  const [endAt, setEndAt] = useState(toLocalInput(event.end_at))
  const [requireSubscription, setRequireSubscription] = useState<boolean>(!!event.require_subscription)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function toLocalInput(iso: string | null | undefined) {
    if (!iso) return ''
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  async function handleSave() {
    setSaving(true); setErr(null)
    try {
      // PATCH-семантика: отправляем ТОЛЬКО реально изменённые поля.
      // Иначе backend (model_dump(exclude_unset=True)) перетрёт null-ом
      // в БД любое поле, которое не было заполнено в форме.
      const payload: any = {}
      const t = title.trim()
      if (t !== (event.title || ''))                            payload.title = t || null
      const d = description.trim()
      if (d !== (event.description || ''))                      payload.description = d || null
      const lu = landingUrl.trim()
      if (lu !== (event.landing_url || ''))                     payload.landing_url = lu || null
      const su = streamUrl.trim()
      const initStream = event.stream_url || event.address || ''
      if (su !== initStream)                                    payload.stream_url = su || null
      const c = chatUrl.trim()
      if (c !== (event.chat_url || ''))                         payload.chat_url = c || null
      const v = vipUrl.trim()
      if (v !== (event.vip_url || ''))                          payload.vip_url = v || null
      const startIso = startAt ? new Date(startAt).toISOString() : null
      const eventStartIso = event.start_at ? new Date(event.start_at).toISOString() : null
      if (startIso !== eventStartIso)                           payload.start_at = startIso
      const endIso = endAt ? new Date(endAt).toISOString() : null
      const eventEndIso = event.end_at ? new Date(event.end_at).toISOString() : null
      if (endIso !== eventEndIso)                               payload.end_at = endIso
      if (requireSubscription !== !!event.require_subscription) payload.require_subscription = requireSubscription

      if (Object.keys(payload).length === 0) {
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 1800)
        return
      }
      await api.events.update(eventId, payload)
      await onReload()
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1800)
    } catch (e: any) {
      setErr(e.message || 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Поля события */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-800 mb-4">Параметры мероприятия</h2>

        <div className="space-y-4">
          <Field label="Название">
            <input value={title} onChange={e => setTitle(e.target.value)}
                   className="input" placeholder="iVision-7" />
          </Field>

          <Field label="Описание">
            <textarea value={description} onChange={e => setDescription(e.target.value)}
                      rows={3} className="input"
                      placeholder="О чём это мероприятие — пара предложений" />
          </Field>

          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Дата и время начала">
              <input type="datetime-local" value={startAt} onChange={e => setStartAt(e.target.value)}
                     className="input" />
            </Field>
            <Field label="Дата и время окончания">
              <input type="datetime-local" value={endAt} onChange={e => setEndAt(e.target.value)}
                     className="input" />
            </Field>
          </div>

          <Field label="Ссылка на ZOOM или вебинарную комнату" hint="Появится плиткой «Стрим» в Mini App в день эфира">
            <input value={streamUrl} onChange={e => setStreamUrl(e.target.value)}
                   className="input" placeholder="https://us02web.zoom.us/j/..." />
          </Field>

          <Field label="Ссылка на чат события" hint="Telegram-чат участников. Появится плиткой в Mini App">
            <input value={chatUrl} onChange={e => setChatUrl(e.target.value)}
                   className="input" placeholder="https://t.me/+abc123..." />
          </Field>

          <Field label="Ссылка на оплату VIP-тарифа" hint="Если задана — в Mini App над программой появится персиковая кнопка «Расшириться до VIP-тарифа»">
            <input value={vipUrl} onChange={e => setVipUrl(e.target.value)}
                   className="input" placeholder="https://..." />
          </Field>

          <ExternalLandingBlock
            slug={event?.slug}
            value={landingUrl}
            onChange={setLandingUrl}
          />
        </div>
      </div>

      {/* Подписка на канал организатора (события вне конференций) */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-800 mb-1">Подписка на канал организатора</h2>
        <p className="text-sm text-gray-500 mb-4">
          Если включено — участник должен быть подписан на главный Telegram-канал
          организатора, чтобы войти в чат события и получить доступ к Игре/Розыгрышу.
        </p>
        <div className="space-y-3">
          {[
            { value: false, label: 'Не требовать подписки',                desc: 'Доступ открыт всем зарегистрированным участникам' },
            { value: true,  label: 'Требовать подписку на канал организатора', desc: 'Участник должен подписаться на ваш главный канал перед входом' },
          ].map(opt => (
            <label key={String(opt.value)}
              className={`flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                requireSubscription === opt.value
                  ? 'border-[#25455D] bg-[#25455D]/5'
                  : 'border-gray-200 hover:border-gray-300'
              }`}>
              <input type="radio" name="event_sub_required" checked={requireSubscription === opt.value}
                onChange={() => setRequireSubscription(opt.value)}
                className="mt-0.5 accent-[#25455D]" />
              <div>
                <p className="text-sm font-medium text-gray-900">{opt.label}</p>
                <p className="text-xs text-gray-400 mt-0.5">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>

        {err && <div className="mt-4 text-sm text-red-600">{err}</div>}

        <div className="mt-5 flex items-center gap-3">
          <button onClick={handleSave} disabled={saving}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <Save size={16} />
            {saving ? 'Сохраняю…' : 'Сохранить'}
          </button>
          {savedFlash && <span className="text-sm text-green-600">Сохранено ✓</span>}
        </div>
      </div>

      {/* Публичные ссылки — внизу */}
      <PublicLinks slug={event?.slug} eventId={eventId} onSlugSaved={onReload} />

      <style jsx>{`
        .input {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1px solid #d1d5db;
          border-radius: 0.5rem;
          font-size: 0.875rem;
          outline: none;
        }
        .input:focus {
          border-color: #25455D;
          box-shadow: 0 0 0 3px rgba(37, 69, 93, 0.1);
        }
      `}</style>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}
