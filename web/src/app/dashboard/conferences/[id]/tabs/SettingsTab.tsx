'use client'
import { useState, useEffect } from 'react'
import { Save, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'
import PublicLinks from '@/components/PublicLinks'
import ExternalLandingBlock from '@/components/ExternalLandingBlock'

function SaveBar({ saving, saved, onSave }: { saving: boolean; saved: boolean; onSave: () => void }) {
  const { t } = useLang()
  return (
    <div className="flex items-center gap-3 mt-6">
      <button
        onClick={onSave}
        disabled={saving}
        className={`btn-gold px-6 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2 ${saving ? 'btn-loading' : ''}`}
      >
        {saving ? <><Spinner /> {t.common.saving}</> : <><Save size={15} /> {t.common.save}</>}
      </button>
      {saved && (
        <span className="flex items-center gap-1.5 text-sm text-green-600">
          <Check size={15} /> {t.common.saved}
        </span>
      )}
    </div>
  )
}

export default function SettingsTab({ eventId, conf, event, onConfUpdated, onEventUpdated }: {
  eventId: number
  conf: any
  event: any
  onConfUpdated: (c: any) => void
  onEventUpdated?: (patch: any) => void
}) {
  const { t } = useLang()
  const [chatIdsError, setChatIdsError] = useState('')
  const [form, setForm] = useState({
    title: event?.title || '',
    description: conf?.description || '',
    stream_url: conf?.stream_url || '',
    chat_url: conf?.chat_url || '',
    // landing_url — единое поле для всех событий (events.landing_url),
    // после миграции 057. Старое conf_conferences.registration_url удалено.
    landing_url: event?.landing_url || '',
    vip_url: conf?.vip_url || '',
    raffle_url: conf?.raffle_url || '',
    subscription_mode: conf?.subscription_mode || 'none',
    telegram_chat_ids: conf?.telegram_chat_ids || '',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setForm(f => ({
      ...f,
      description: conf?.description || '',
      stream_url: conf?.stream_url || '',
      chat_url: conf?.chat_url || '',
      landing_url: event?.landing_url || '',
      vip_url: conf?.vip_url || '',
      raffle_url: conf?.raffle_url || '',
      subscription_mode: conf?.subscription_mode || 'none',
      telegram_chat_ids: conf?.telegram_chat_ids || '',
    }))
  }, [conf, event?.landing_url])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSave() {
    // Валидация telegram_chat_ids
    setChatIdsError('')
    if (form.telegram_chat_ids.trim()) {
      const parts = form.telegram_chat_ids.split(',').map((s: string) => s.trim()).filter(Boolean)
      if (parts.length === 0 || form.telegram_chat_ids.trim().indexOf(',') === -1 && parts.length > 1) {
        setChatIdsError('Вводите ID через запятую')
        return
      }
      const invalid = parts.filter((p: string) => !/^-?\d+$/.test(p))
      if (invalid.length > 0) {
        setChatIdsError(`Не удалось распознать: ${invalid.join(', ')} — ID должны быть числами`)
        return
      }
    }
    setSaving(true); setSaved(false)
    try {
      // PATCH-семантика: отправляем ТОЛЬКО реально изменённые поля.
      // Иначе при переключении одного radio (subscription_mode) на бэк
      // улетают все поля формы — если что-то пустое, оно обнуляет БД.
      // Сравниваем с props.conf / props.event как с initial-снапшотом.
      const eventPatch: any = {}
      if (form.title !== (event?.title || ''))           eventPatch.title = form.title
      if (form.landing_url !== (event?.landing_url || '')) eventPatch.landing_url = form.landing_url || null
      if (Object.keys(eventPatch).length > 0) {
        await api.events.update(eventId, eventPatch)
        onEventUpdated?.(eventPatch)
      }

      const confPatch: any = {}
      if (form.description !== (conf?.description || ''))             confPatch.description = form.description || null
      if (form.stream_url !== (conf?.stream_url || ''))                confPatch.stream_url = form.stream_url || null
      if (form.chat_url !== (conf?.chat_url || ''))                    confPatch.chat_url = form.chat_url || null
      if (form.vip_url !== (conf?.vip_url || ''))                      confPatch.vip_url = form.vip_url || null
      if (form.raffle_url !== (conf?.raffle_url || ''))                confPatch.raffle_url = form.raffle_url || null
      if (form.subscription_mode !== (conf?.subscription_mode || 'none')) confPatch.subscription_mode = form.subscription_mode
      if (form.telegram_chat_ids !== (conf?.telegram_chat_ids || ''))  confPatch.telegram_chat_ids = form.telegram_chat_ids || null

      if (Object.keys(confPatch).length > 0) {
        const updated = await api.conference.update(eventId, confPatch)
        onConfUpdated(updated.conference)
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  const ts = t.conferences.settings

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
        <h2 className="font-semibold text-gray-900">{ts.section}</h2>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">{ts.confTitle}</label>
          <input type="text" value={form.title} onChange={set('title')}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">{ts.description}</label>
          <textarea value={form.description} onChange={set('description') as any} rows={3}
            placeholder={ts.descPlaceholder}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand resize-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Ссылка на вебинарную комнату / стрим
            <span className="text-gray-400 font-normal ml-1">— одна на все дни</span>
          </label>
          <input type="url" value={form.stream_url} onChange={set('stream_url')}
            placeholder="https://us02web.zoom.us/j/... или https://youtube.com/live/..."
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          <p className="text-xs text-gray-400 mt-1">Если у каждого дня свой стрим — задаётся в редакторе программы по дням.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Ссылка на общий чат участников
            <span className="text-gray-400 font-normal ml-1">— Telegram-чат конференции</span>
          </label>
          <input type="url" value={form.chat_url} onChange={set('chat_url')}
            placeholder="https://t.me/+..."
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          <p className="text-xs text-gray-400 mt-1">Появится плиткой «Чат» в Mini App в программе.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Ссылка на оплату VIP-тарифа
            <span className="text-gray-400 font-normal ml-1">— опционально</span>
          </label>
          <input type="url" value={form.vip_url} onChange={set('vip_url')}
            placeholder="https://..."
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          <p className="text-xs text-gray-400 mt-1">Если задана — в Mini App над программой появится персиковая кнопка «Расшириться до VIP-тарифа», а в итогах — «Купить VIP-тариф с записями».</p>
        </div>
        <ExternalLandingBlock
          slug={event?.slug}
          value={form.landing_url}
          onChange={(v) => setForm(f => ({ ...f, landing_url: v }))}
        />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Ссылка на информацию про розыгрыш
            <span className="text-gray-400 font-normal ml-1">— для шаблона «Итоги дня»</span>
          </label>
          <input type="url" value={form.raffle_url} onChange={set('raffle_url')}
            placeholder="https://..."
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            ID Telegram-чатов/каналов события
            <span className="text-gray-400 font-normal ml-1">— через запятую, будут добавлены в рассылки</span>
          </label>
          <input type="text" value={form.telegram_chat_ids} onChange={set('telegram_chat_ids')}
            placeholder="-1001234567890, -1009876543210"
            className={`w-full px-4 py-2.5 rounded-xl border text-sm focus:outline-none font-mono ${chatIdsError ? 'border-red-400 bg-red-50' : 'border-gray-200 focus:border-brand'}`} />
          {chatIdsError && <p className="text-xs text-red-500 mt-1">{chatIdsError}</p>}
          <p className="text-xs text-gray-400 mt-1">Узнать ID канала: перешли любое сообщение из него боту @userinfobot</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">{ts.subscription}</h2>
        <p className="text-sm text-gray-500">{ts.subscriptionHint}</p>
        {[
          { value: 'none',         label: ts.subNone,      desc: ts.subNoneDesc },
          { value: 'organizer',    label: ts.subOrganizer, desc: ts.subOrganizerDesc },
          { value: 'all_speakers', label: ts.subAll,       desc: ts.subAllDesc },
        ].map(opt => (
          <label key={opt.value}
            className={`flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
              form.subscription_mode === opt.value ? 'border-brand bg-brand/5' : 'border-gray-200 hover:border-gray-300'
            }`}>
            <input type="radio" name="sub_mode" value={opt.value}
              checked={form.subscription_mode === opt.value}
              onChange={() => setForm(f => ({ ...f, subscription_mode: opt.value }))}
              className="mt-0.5 accent-brand" />
            <div>
              <p className="text-sm font-medium text-gray-900">{opt.label}</p>
              <p className="text-xs text-gray-400 mt-0.5">{opt.desc}</p>
            </div>
          </label>
        ))}
      </div>

      <SaveBar saving={saving} saved={saved} onSave={handleSave} />

      {/* Публичные ссылки — внизу */}
      <PublicLinks slug={event?.slug} eventId={eventId} onSlugSaved={(s) => onEventUpdated?.({ slug: s })} />
    </div>
  )
}
