'use client'
import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { api } from '@/lib/api'
import PublicLinks from '@/components/PublicLinks'

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
  const [address, setAddress] = useState(event.address || '')
  const [startAt, setStartAt] = useState(toLocalInput(event.start_at))
  const [endAt, setEndAt] = useState(toLocalInput(event.end_at))
  const [successorEventId, setSuccessorEventId] = useState<string>(
    event.successor_event_id ? String(event.successor_event_id) : ''
  )
  const [otherEvents, setOtherEvents] = useState<{ id: number; title: string }[]>([])
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.events.list().then((res: any) => {
      const items: any[] = res?.items || res || []
      setOtherEvents(items
        .filter(e => e.id !== eventId)
        .map(e => ({ id: e.id, title: e.title || `Событие #${e.id}` }))
      )
    }).catch(() => {})
  }, [eventId])

  function toLocalInput(iso: string | null | undefined) {
    if (!iso) return ''
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  async function handleSave() {
    setSaving(true); setErr(null)
    try {
      const payload: any = {
        title: title.trim() || null,
        description: description.trim() || null,
        landing_url: landingUrl.trim() || null,
        address: address.trim() || null,
        start_at: startAt ? new Date(startAt).toISOString() : null,
        end_at:   endAt   ? new Date(endAt).toISOString()   : null,
        successor_event_id: successorEventId ? Number(successorEventId) : null,
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

          <Field label="Ссылка на ZOOM или вебинарную комнату (для онлайн-событий)" hint="Можно вставить ссылку трансляции, запись или офлайн-адрес">
            <input value={address} onChange={e => setAddress(e.target.value)}
                   className="input" placeholder="https://us02web.zoom.us/j/..." />
          </Field>

          <Field label="URL лендинга" hint="Если у вас есть отдельная страница события на сайте">
            <input value={landingUrl} onChange={e => setLandingUrl(e.target.value)}
                   className="input" placeholder="https://yoursite.com/event" />
          </Field>

          <Field label="Следующее событие" hint="Покажется участникам в Mini App после завершения этого события — блок «А дальше». Можно оставить пустым.">
            <select value={successorEventId} onChange={e => setSuccessorEventId(e.target.value)}
                    className="input">
              <option value="">— Не выбрано —</option>
              {otherEvents.map(e => (
                <option key={e.id} value={e.id}>{e.title}</option>
              ))}
            </select>
          </Field>
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
