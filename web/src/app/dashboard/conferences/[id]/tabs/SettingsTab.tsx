'use client'
import { useState, useEffect } from 'react'
import { Save, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'
import PublicLinks from '@/components/PublicLinks'
import LandingSettingsBlock from '@/components/LandingSettingsBlock'
import EventChatsField, { EventChatsValue, ChatPlatform } from '@/components/EventChatsField'
import MainButtonsBlock, { AccentButton, normalizeAccent } from '@/components/MainButtonsBlock'

function SaveBar({ saving, saved, onSave }: { saving: boolean; saved: boolean; onSave: () => void }) {
  const { t } = useLang()
  return (
    <div className="flex items-center gap-3 mt-2">
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
  const [form, setForm] = useState({
    title: event?.title || '',
    description: event?.description || '',
    description_post_register: event?.description_post_register || '',
    stream_url: conf?.stream_url || '',
    hide_stream_button: !!conf?.hide_stream_button,
    // landing_url — единое поле для всех событий (events.landing_url),
    // после миграции 057. Старое conf_conferences.registration_url удалено.
    landing_url: event?.landing_url || '',
    vip_url: conf?.vip_url || '',
    vip_button_label: conf?.vip_button_label || '',
    chat_button_label: conf?.chat_button_label || '',
    accent_button: normalizeAccent(conf?.accent_button) as AccentButton,
    raffle_url: conf?.raffle_url || '',
    subscription_mode: conf?.subscription_mode || 'none',
    skip_contact_form: !!event?.skip_contact_form,
    // Текст кнопки на встроенном лендинге (миграция 212). Пусто → дефолт Mini App.
    landing_cta_label: event?.landing_cta_label || '',
    // Что показывать на «Итогах» при завершении события (миграция 195).
    end_action: (conf?.end_action as 'next_event' | 'gift') || 'next_event',
    end_gift: conf?.end_gift_package_id
      ? `p:${conf.end_gift_package_id}`
      : conf?.end_gift_lead_magnet_id ? `m:${conf.end_gift_lead_magnet_id}` : '',
  })
  // Список лид-магнитов и пакетов клиента — для выбора подарка при завершении.
  const [leadMagnets, setLeadMagnets] = useState<Array<{ id: number; name: string }>>([])
  const [leadPackages, setLeadPackages] = useState<Array<{ id: number; name: string }>>([])
  // Чаты события — ref на записи client_broadcast_chats + radio (primary).
  const [chats, setChats] = useState<EventChatsValue>({
    tgChatRef:  conf?.tg_chat_ref  ?? null,
    vkChatRef:  conf?.vk_chat_ref  ?? null,
    maxChatRef: conf?.max_chat_ref ?? null,
    primary: (conf?.primary_chat_platform as ChatPlatform | null) || null,
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Лид-магниты и пакеты для выбора подарка при завершении события.
  useEffect(() => {
    api.leadMagnets.list().then((r: any) => setLeadMagnets(r.items || [])).catch(() => {})
    api.leadMagnetPackages.list().then((r: any) => setLeadPackages(r.items || [])).catch(() => {})
  }, [])

  useEffect(() => {
    setForm(f => ({
      ...f,
      description: event?.description || '',
      description_post_register: event?.description_post_register || '',
      stream_url: conf?.stream_url || '',
    hide_stream_button: !!conf?.hide_stream_button,
      landing_url: event?.landing_url || '',
      vip_url: conf?.vip_url || '',
      vip_button_label: conf?.vip_button_label || '',
      chat_button_label: conf?.chat_button_label || '',
      accent_button: normalizeAccent(conf?.accent_button) as AccentButton,
      raffle_url: conf?.raffle_url || '',
      subscription_mode: conf?.subscription_mode || 'none',
      skip_contact_form: !!event?.skip_contact_form,
      landing_cta_label: event?.landing_cta_label || '',
      end_action: (conf?.end_action as 'next_event' | 'gift') || 'next_event',
      end_gift: conf?.end_gift_package_id
        ? `p:${conf.end_gift_package_id}`
        : conf?.end_gift_lead_magnet_id ? `m:${conf.end_gift_lead_magnet_id}` : '',
    }))
    setChats({
      tgChatRef:  conf?.tg_chat_ref  ?? null,
      vkChatRef:  conf?.vk_chat_ref  ?? null,
      maxChatRef: conf?.max_chat_ref ?? null,
      primary: (conf?.primary_chat_platform as ChatPlatform | null) || null,
    })
  }, [conf, event?.landing_url, event?.skip_contact_form, event?.landing_cta_label, event?.description, event?.description_post_register])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSave() {
    setSaving(true); setSaved(false)
    try {
      // PATCH-семантика: отправляем ТОЛЬКО реально изменённые поля.
      // Иначе при переключении одного radio (subscription_mode) на бэк
      // улетают все поля формы — если что-то пустое, оно обнуляет БД.
      // Сравниваем с props.conf / props.event как с initial-снапшотом.
      const eventPatch: any = {}
      if (form.title !== (event?.title || ''))                  eventPatch.title = form.title
      if (form.landing_url !== (event?.landing_url || ''))      eventPatch.landing_url = form.landing_url || null
      if (form.skip_contact_form !== !!event?.skip_contact_form) eventPatch.skip_contact_form = form.skip_contact_form
      if (form.landing_cta_label !== (event?.landing_cta_label || ''))
        eventPatch.landing_cta_label = form.landing_cta_label.trim() || null
      if (form.description !== (event?.description || ''))
        eventPatch.description = form.description || null
      if (form.description_post_register !== (event?.description_post_register || ''))
        eventPatch.description_post_register = form.description_post_register || null
      if (Object.keys(eventPatch).length > 0) {
        await api.events.update(eventId, eventPatch)
        onEventUpdated?.(eventPatch)
      }

      const confPatch: any = {}
      if (form.stream_url !== (conf?.stream_url || ''))                confPatch.stream_url = form.stream_url || null
      if (form.hide_stream_button !== !!conf?.hide_stream_button)      confPatch.hide_stream_button = form.hide_stream_button
      if (form.vip_url !== (conf?.vip_url || ''))                      confPatch.vip_url = form.vip_url || null
      if (form.vip_button_label !== (conf?.vip_button_label || ''))    confPatch.vip_button_label = form.vip_button_label || null
      if (form.chat_button_label !== (conf?.chat_button_label || ''))  confPatch.chat_button_label = form.chat_button_label || null
      const initAccent = normalizeAccent(conf?.accent_button)
      if (form.accent_button !== initAccent)                           confPatch.accent_button = form.accent_button
      if (form.raffle_url !== (conf?.raffle_url || ''))                confPatch.raffle_url = form.raffle_url || null
      if (form.subscription_mode !== (conf?.subscription_mode || 'none')) confPatch.subscription_mode = form.subscription_mode
      // Действие при завершении + подарок (взаимоисключающий m:/p:).
      const initEndAction = (conf?.end_action as string) || 'next_event'
      const initEndGift = conf?.end_gift_package_id
        ? `p:${conf.end_gift_package_id}`
        : conf?.end_gift_lead_magnet_id ? `m:${conf.end_gift_lead_magnet_id}` : ''
      if (form.end_action !== initEndAction) confPatch.end_action = form.end_action
      if (form.end_gift !== initEndGift) {
        if (form.end_gift.startsWith('m:')) {
          confPatch.end_gift_lead_magnet_id = Number(form.end_gift.slice(2))
          confPatch.end_gift_package_id = null
        } else if (form.end_gift.startsWith('p:')) {
          confPatch.end_gift_package_id = Number(form.end_gift.slice(2))
          confPatch.end_gift_lead_magnet_id = null
        } else {
          confPatch.end_gift_lead_magnet_id = null
          confPatch.end_gift_package_id = null
        }
      }
      // Чаты события — ref на записи client_broadcast_chats + primary
      const initPrimary = (conf?.primary_chat_platform as ChatPlatform | null) || null
      if (chats.tgChatRef  !== (conf?.tg_chat_ref  ?? null))           confPatch.tg_chat_ref  = chats.tgChatRef
      if (chats.vkChatRef  !== (conf?.vk_chat_ref  ?? null))           confPatch.vk_chat_ref  = chats.vkChatRef
      if (chats.maxChatRef !== (conf?.max_chat_ref ?? null))           confPatch.max_chat_ref = chats.maxChatRef
      if (chats.primary !== initPrimary)                               confPatch.primary_chat_platform = chats.primary || null

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
      {/* 1) ПАРАМЕТРЫ КОНФЕРЕНЦИИ */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
        <h2 className="block-title">Параметры конференции</h2>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">{ts.confTitle}</label>
          <input type="text" value={form.title} onChange={set('title')}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
        </div>
        {/* «Описание для лендинга» переехало в блок «Настройки страницы регистрации» ниже. */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Описание после регистрации
          </label>
          <textarea value={form.description_post_register}
            onChange={e => setForm(f => ({ ...f, description_post_register: e.target.value }))}
            rows={4}
            placeholder="Инструкции для зарегистрировавшихся (что делать дальше). Поддерживается HTML."
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand resize-none" />
          <p className="text-xs text-gray-400 mt-1">
            Показывается в Mini App на вкладке «Программа» под кнопками стрима и чата.
            Поддерживается HTML: {'<b>, <i>, <a href="...">, <br>, <ul><li>'}. В простом тексте ссылки http(s) кликабельны автоматически.
          </p>
        </div>
      </div>

      {/* 2) НАСТРОЙКА ССЫЛОК */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
        <h2 className="block-title">Настройка ссылок</h2>
        <div>
          {/* Ссылка эфира — ПО ДНЯМ в разделе «Вебинары» (комната дня/сторонняя). */}
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={form.hide_stream_button}
              onChange={e => setForm(f => ({ ...f, hide_stream_button: e.target.checked }))}
              className="mt-0.5 accent-[#25455D]" />
            <span className="text-sm text-gray-700">
              Скрыть кнопку стрима
              <span className="block text-xs text-gray-400 mt-0.5">
                Кнопка не будет показываться участникам ни в Mini App / на веб-странице, ни в меню бота события — даже если ссылка задана.
                {' '}Ссылки на эфир настраиваются в разделе{' '}
                <a href={`/dashboard/tournaments/${eventId}?tab=webinar`} className="text-[#25455D] underline hover:opacity-70">Вебинары</a>
                {' '}(у каждого дня своя).
              </span>
            </span>
          </label>
        </div>
        <EventChatsField value={chats} onChange={setChats} />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Ссылка на оплату VIP-тарифа
            <span className="text-gray-400 font-normal ml-1">— опционально</span>
          </label>
          <input type="url" value={form.vip_url} onChange={set('vip_url')}
            placeholder="https://..."
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          <p className="text-xs text-gray-400 mt-1">Если задана — в Mini App на «Программе» и в «Интро» появится кнопка. Если участника привёл партнёр (pid), к ссылке добавится партнёрский параметр коллаборатора, как у стороннего лендинга. В итогах остаётся «Купить VIP-тариф с записями».</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Ссылка на информацию про розыгрыш
            <span className="text-gray-400 font-normal ml-1">— для шаблона «Итоги дня»</span>
          </label>
          <input type="url" value={form.raffle_url} onChange={set('raffle_url')}
            placeholder="https://..."
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
        </div>

        {/* Что показывать на вкладке «Итоги» после завершения события (миграция 195) */}
        <div className="pt-2 border-t border-gray-100">
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            При завершении события показывать
          </label>
          <div className="space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="radio" name="end_action" checked={form.end_action === 'next_event'}
                onChange={() => setForm(f => ({ ...f, end_action: 'next_event' }))}
                className="mt-0.5 accent-[#25455D]" />
              <span className="text-sm text-gray-700">
                Следующее событие
                <span className="block text-xs text-gray-400 mt-0.5">
                  Ближайшее незавершённое опубликованное событие. Завершённые не показываются.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="radio" name="end_action" checked={form.end_action === 'gift'}
                onChange={() => setForm(f => ({ ...f, end_action: 'gift' }))}
                className="mt-0.5 accent-[#25455D]" />
              <span className="text-sm text-gray-700">
                Подарок
                <span className="block text-xs text-gray-400 mt-0.5">
                  Лид-магнит или пакет из ваших лид-магнитов.
                </span>
              </span>
            </label>
          </div>
          {form.end_action === 'gift' && (
            <div className="mt-2 pl-6">
              <select value={form.end_gift}
                onChange={e => setForm(f => ({ ...f, end_gift: e.target.value }))}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand bg-white">
                <option value="">— выберите подарок —</option>
                {leadMagnets.length > 0 && (
                  <optgroup label="Лид-магниты">
                    {leadMagnets.map(m => <option key={`m${m.id}`} value={`m:${m.id}`}>{m.name}</option>)}
                  </optgroup>
                )}
                {leadPackages.length > 0 && (
                  <optgroup label="Пакеты">
                    {leadPackages.map(p => <option key={`p${p.id}`} value={`p:${p.id}`}>{p.name}</option>)}
                  </optgroup>
                )}
              </select>
              {leadMagnets.length === 0 && leadPackages.length === 0 && (
                <p className="text-xs text-gray-400 mt-1">
                  Нет лид-магнитов. Создайте их в разделе «Лид-магниты».
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Главные кнопки в Mini App */}
      <MainButtonsBlock
        vipLabel={form.vip_button_label}
        chatLabel={form.chat_button_label}
        accent={form.accent_button}
        onVipLabel={(v) => setForm(f => ({ ...f, vip_button_label: v }))}
        onChatLabel={(v) => setForm(f => ({ ...f, chat_button_label: v }))}
        onAccent={(v) => setForm(f => ({ ...f, accent_button: v }))}
      />

      {/* 3) ПОДПИСКА НА КАНАЛЫ ОРГАНИЗАТОРОВ */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-3">
        <h2 className="block-title">{ts.subscription}</h2>
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

      {/* 4) НАСТРОЙКИ СТРАНИЦЫ РЕГИСТРАЦИИ — единая секция с переключателем
             внутренний/сторонний лендинг (общий компонент с мероприятиями). */}
      <LandingSettingsBlock
        description={form.description}
        onDescription={(v) => setForm(f => ({ ...f, description: v }))}
        landingUrl={form.landing_url}
        onLandingUrl={(v) => setForm(f => ({ ...f, landing_url: v }))}
        ctaLabel={form.landing_cta_label}
        onCtaLabel={(v) => setForm(f => ({ ...f, landing_cta_label: v }))}
        skipContactForm={form.skip_contact_form}
        onSkipContactForm={(v) => setForm(f => ({ ...f, skip_contact_form: v }))}
        allowExternal={!event?.is_collab}
      />

      {/* 5) ПУБЛИЧНЫЕ ССЫЛКИ — выбор типа сохраняется общей кнопкой ниже */}
      <PublicLinks
        slug={event?.slug}
        eventId={eventId}
        onSlugSaved={(s) => onEventUpdated?.({ slug: s })}
        eventStatus={event?.status}
      />

      {/* Кнопка сохранения — в самом низу страницы */}
      <SaveBar saving={saving} saved={saved} onSave={handleSave} />

      <style jsx>{`
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
