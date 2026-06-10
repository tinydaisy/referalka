'use client'
import { useState } from 'react'
import { Save } from 'lucide-react'
import { api } from '@/lib/api'
import PublicLinks from '@/components/PublicLinks'
import EventChatsField, { EventChatsValue, ChatPlatform } from '@/components/EventChatsField'

export default function ContestOverviewTab({
  event, eventId, onReload,
}: {
  event: any
  eventId: number
  onReload: () => Promise<void>
}) {
  const [title, setTitle] = useState(event.title || '')
  const [description, setDescription] = useState(event.description || '')
  const [descriptionPostRegister, setDescriptionPostRegister] = useState(event.description_post_register || '')
  // «Ссылка на голосование» сохраняется в events.stream_url
  // (то же поле, что у мероприятий — там оно для ZOOM/стрима). Mini App
  // в режиме контестa показывает её плиткой «Перейти к голосованию».
  const [votingUrl, setVotingUrl] = useState(event.stream_url || '')
  const [chats, setChats] = useState<EventChatsValue>({
    tg:  event.chat_url_tg  || (event.primary_chat_platform === 'telegram' ? (event.chat_url || '') : ''),
    vk:  event.chat_url_vk  || '',
    max: event.chat_url_max || '',
    primary: (event.primary_chat_platform as ChatPlatform | null) || (event.chat_url ? 'telegram' : null),
    chatIds: event.telegram_chat_ids || '',
  })
  const [startAt, setStartAt] = useState(toLocalInput(event.start_at))
  const [endAt, setEndAt] = useState(toLocalInput(event.end_at))
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
      const payload: any = {}
      const t = title.trim()
      if (t !== (event.title || ''))                            payload.title = t || null
      const d = description.trim()
      if (d !== (event.description || ''))                      payload.description = d || null
      const dpr = descriptionPostRegister.trim()
      if (dpr !== (event.description_post_register || ''))      payload.description_post_register = dpr || null
      const v = votingUrl.trim()
      if (v !== (event.stream_url || ''))                       payload.stream_url = v || null
      const tg  = chats.tg.trim()
      const vk  = chats.vk.trim()
      const mx  = chats.max.trim()
      if (tg  !== (event.chat_url_tg  || ''))                   payload.chat_url_tg  = tg  || null
      if (vk  !== (event.chat_url_vk  || ''))                   payload.chat_url_vk  = vk  || null
      if (mx  !== (event.chat_url_max || ''))                   payload.chat_url_max = mx  || null
      const initPrimary = (event.primary_chat_platform as ChatPlatform | null) || null
      if (chats.primary !== initPrimary)                        payload.primary_chat_platform = chats.primary || null
      const ids = chats.chatIds.trim()
      if (ids !== (event.telegram_chat_ids || ''))              payload.telegram_chat_ids = ids || null
      const startIso = startAt ? new Date(startAt).toISOString() : null
      const eventStartIso = event.start_at ? new Date(event.start_at).toISOString() : null
      if (startIso !== eventStartIso)                           payload.start_at = startIso
      const endIso = endAt ? new Date(endAt).toISOString() : null
      const eventEndIso = event.end_at ? new Date(event.end_at).toISOString() : null
      if (endIso !== eventEndIso)                               payload.end_at = endIso

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
      {/* 1) ПАРАМЕТРЫ */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <h2 className="block-title mb-4">Параметры конкурса</h2>

        <div className="space-y-4">
          <Field label="Название конкурса">
            <input value={title} onChange={e => setTitle(e.target.value)}
                   className="input" placeholder="Премия Forbes Woman" />
          </Field>

          <Field
            label="Описание для лендинга"
            hint={'Продающий текст. Показывается на лендинге конкурса (веб-странице и в Mini App до регистрации). Можно использовать HTML: <b>, <i>, <a href="...">, <br>, <ul><li>, <h3>.'}
          >
            <textarea value={description} onChange={e => setDescription(e.target.value)}
                      rows={4} className="input"
                      placeholder="Расскажите голосующему о конкурсе — пара предложений. Поддерживается HTML." />
          </Field>

          <Field
            label="Описание после регистрации"
            hint={'Инструкция: как именно проголосовать. Показывается в Mini App на вкладке «Программа» под кнопками голосования и чата. Можно использовать HTML: <b>, <i>, <a>, <br>, <ul><li>. В простом тексте ссылки http(s) кликабельны автоматически.'}
          >
            <textarea value={descriptionPostRegister} onChange={e => setDescriptionPostRegister(e.target.value)}
                      rows={5} className="input"
                      placeholder="1) Перейдите на сайт премии 2) Найдите номинацию … 3) Нажмите ПРОГОЛОСОВАТЬ …" />
          </Field>

          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Старт голосования">
              <input type="datetime-local" value={startAt} onChange={e => setStartAt(e.target.value)}
                     className="input" />
            </Field>
            <Field label="Окончание голосования">
              <input type="datetime-local" value={endAt} onChange={e => setEndAt(e.target.value)}
                     className="input" />
            </Field>
          </div>
        </div>
      </div>

      {/* 2) НАСТРОЙКА ССЫЛОК */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <h2 className="block-title mb-4">Настройка ссылок</h2>

        <div className="space-y-4">
          <Field label="Ссылка на голосование" hint="Появится плиткой «Перейти к голосованию» в Mini App.">
            <input value={votingUrl} onChange={e => setVotingUrl(e.target.value)}
                   className="input" placeholder="https://forbes.ru/vote/..." />
          </Field>

          <EventChatsField value={chats} onChange={setChats} />
        </div>
      </div>

      {/* Save bar */}
      {err && <div className="text-sm text-red-600">{err}</div>}
      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving}
                className="flex items-center gap-2 px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <Save size={16} />
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </button>
        {savedFlash && <span className="text-sm text-green-600">Сохранено ✓</span>}
      </div>

      {/* 3) ПУБЛИЧНЫЕ ССЫЛКИ */}
      <PublicLinks slug={event?.slug} eventId={eventId} onSlugSaved={onReload} eventStatus={event?.status} linkMode={event?.link_mode} />

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
        .block-title {
          font-size: 0.875rem;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #25455D;
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
