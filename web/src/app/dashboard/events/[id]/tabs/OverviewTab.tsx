'use client'
import { useState } from 'react'
import { Save } from 'lucide-react'
import { api } from '@/lib/api'
import PublicLinks from '@/components/PublicLinks'
import LandingSettingsBlock from '@/components/LandingSettingsBlock'
import EventChatsField, { EventChatsValue, ChatPlatform } from '@/components/EventChatsField'
import MainButtonsBlock, { AccentButton, normalizeAccent } from '@/components/MainButtonsBlock'

export default function OverviewTab({
  event, eventId, onReload,
}: {
  event: any
  eventId: number
  onReload: () => Promise<void>
}) {
  const [title, setTitle] = useState(event.title || '')
  const [description, setDescription] = useState(event.description || '')
  const [descriptionPostRegister, setDescriptionPostRegister] = useState(event.description_post_register || '')
  const [landingUrl, setLandingUrl] = useState(event.landing_url || '')
  const [hideStreamButton, setHideStreamButton] = useState<boolean>(!!event.hide_stream_button)
  // МедиаЛифт: сколько каналов из ветки обязательно подписать (1..7).
  const isMedialift = event.module_slug === 'medialift'
  const [mlRequiredSubs, setMlRequiredSubs] = useState<number>(event.medialift_required_subscriptions ?? 3)
  const [chats, setChats] = useState<EventChatsValue>({
    tgChatRef:  event.tg_chat_ref  ?? null,
    vkChatRef:  event.vk_chat_ref  ?? null,
    maxChatRef: event.max_chat_ref ?? null,
    primary: (event.primary_chat_platform as ChatPlatform | null) || null,
  })
  const [vipUrl, setVipUrl] = useState(event.vip_url || '')
  const [vipButtonLabel, setVipButtonLabel] = useState(event.vip_button_label || '')
  const [chatButtonLabel, setChatButtonLabel] = useState(event.chat_button_label || '')
  const [accentButton, setAccentButton] = useState<AccentButton>(normalizeAccent(event.accent_button))
  const [startAt, setStartAt] = useState(toLocalInput(event.start_at))
  const [endAt, setEndAt] = useState(toLocalInput(event.end_at))
  const [requireSubscription, setRequireSubscription] = useState<boolean>(!!event.require_subscription)
  const [requireAllOwners, setRequireAllOwners] = useState<boolean>(!!event.require_subscribe_all_owners)
  const [skipContactForm, setSkipContactForm] = useState<boolean>(!!event.skip_contact_form)
  // Способ регистрации и галочка регистрации на нашем лендинге (миграция 262).
  const [regMode, setRegMode] = useState<string | null>(event.registration_mode || null)
  const [landingReqReg, setLandingReqReg] = useState<boolean>(
    event.landing_require_registration !== false)
  // Текст кнопки на встроенном лендинге (миграция 212). Пусто → дефолт из Mini App.
  const [landingCtaLabel, setLandingCtaLabel] = useState(event.landing_cta_label || '')
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
      const dpr = descriptionPostRegister.trim()
      if (dpr !== (event.description_post_register || ''))      payload.description_post_register = dpr || null
      const lu = landingUrl.trim()
      if (lu !== (event.landing_url || ''))                     payload.landing_url = lu || null
      if (hideStreamButton !== !!event.hide_stream_button)      payload.hide_stream_button = hideStreamButton
      if (isMedialift && mlRequiredSubs !== (event.medialift_required_subscriptions ?? 3))
        payload.medialift_required_subscriptions = mlRequiredSubs
      // Чаты события — ref на записи client_broadcast_chats + primary
      if (chats.tgChatRef  !== (event.tg_chat_ref  ?? null))    payload.tg_chat_ref  = chats.tgChatRef
      if (chats.vkChatRef  !== (event.vk_chat_ref  ?? null))    payload.vk_chat_ref  = chats.vkChatRef
      if (chats.maxChatRef !== (event.max_chat_ref ?? null))    payload.max_chat_ref = chats.maxChatRef
      const initPrimary = (event.primary_chat_platform as ChatPlatform | null) || null
      if (chats.primary !== initPrimary)                        payload.primary_chat_platform = chats.primary || null
      const v = vipUrl.trim()
      if (v !== (event.vip_url || ''))                          payload.vip_url = v || null
      const vbl = vipButtonLabel.trim()
      if (vbl !== (event.vip_button_label || ''))               payload.vip_button_label = vbl || null
      const cbl = chatButtonLabel.trim()
      if (cbl !== (event.chat_button_label || ''))              payload.chat_button_label = cbl || null
      const initAccent = normalizeAccent(event.accent_button)
      if (accentButton !== initAccent)                          payload.accent_button = accentButton
      const startIso = startAt ? new Date(startAt).toISOString() : null
      const eventStartIso = event.start_at ? new Date(event.start_at).toISOString() : null
      if (startIso !== eventStartIso)                           payload.start_at = startIso
      const endIso = endAt ? new Date(endAt).toISOString() : null
      const eventEndIso = event.end_at ? new Date(event.end_at).toISOString() : null
      if (endIso !== eventEndIso)                               payload.end_at = endIso
      if (requireSubscription !== !!event.require_subscription) payload.require_subscription = requireSubscription
      if (requireAllOwners !== !!event.require_subscribe_all_owners) payload.require_subscribe_all_owners = requireAllOwners
      if (skipContactForm !== !!event.skip_contact_form)        payload.skip_contact_form = skipContactForm
      if (regMode !== (event.registration_mode || null))         payload.registration_mode = regMode
      if (landingReqReg !== (event.landing_require_registration !== false))
        payload.landing_require_registration = landingReqReg
      const lcl = landingCtaLabel.trim()
      if (lcl !== (event.landing_cta_label || ''))             payload.landing_cta_label = lcl || null

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
      {/* 1) ПАРАМЕТРЫ МЕРОПРИЯТИЯ */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <h2 className="block-title mb-4">Параметры мероприятия</h2>

        <div className="space-y-4">
          <Field label="Название">
            <input value={title} onChange={e => setTitle(e.target.value)}
                   className="input" placeholder="iVision-7" />
          </Field>

          {/* «Описание для лендинга» переехало в блок «Настройки страницы регистрации» ниже
              (там оно логически и живёт — это текст внутреннего лендинга). */}

          <Field
            label="Описание после регистрации"
            hint={'Инструкции для зарегистрировавшихся (что делать дальше). Показывается в Mini App на вкладке «Программа» под кнопками стрима и чата. Можно использовать HTML: <b>, <i>, <a>, <br>, <ul><li>. В простом тексте ссылки http(s) кликабельны автоматически.'}
          >
            <textarea value={descriptionPostRegister} onChange={e => setDescriptionPostRegister(e.target.value)}
                      rows={4} className="input"
                      placeholder="Например: «Подключайтесь к стриму за 5 минут до начала. После эфира — заглядывайте в чат»" />
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
        </div>
      </div>

      {/* 2) НАСТРОЙКА ССЫЛОК */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <h2 className="block-title mb-4">Настройка ссылок</h2>

        <div className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3.5 text-sm text-gray-600">
            Ссылка на эфир настраивается в разделе «Вебинары» — участник попадёт в вебинарную комнату дня.
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={hideStreamButton}
              onChange={e => setHideStreamButton(e.target.checked)}
              className="mt-0.5 accent-[#25455D]" />
            <span className="text-sm text-gray-700">
              Скрыть кнопку стрима
              <span className="block text-xs text-gray-400 mt-0.5">
                Кнопка не будет показываться участникам ни в Mini App / на веб-странице, ни в меню бота события — даже если ссылка задана.
              </span>
            </span>
          </label>

          {isMedialift && (
            <Field label="Сколько каналов обязательно подписать" hint="МедиаЛифт: участнику показывается до 7 человек из его ветки, и он обязан подписаться минимум на это число, чтобы войти в систему.">
              <input type="number" min={1} max={7} value={mlRequiredSubs}
                onChange={e => setMlRequiredSubs(Math.max(1, Math.min(7, Number(e.target.value) || 1)))}
                className="input w-24" />
            </Field>
          )}

          <EventChatsField value={chats} onChange={setChats} />

          <Field label="Ссылка на оплату VIP-тарифа" hint="Если задана — в Mini App на «Программе» и в «Интро» появится кнопка. Если у участника есть pid (его привёл партнёр) — к ссылке добавится партнёрский параметр коллаборатора, как у стороннего лендинга.">
            <input value={vipUrl} onChange={e => setVipUrl(e.target.value)}
                   className="input" placeholder="https://..." />
          </Field>
        </div>
      </div>

      {/* Главные кнопки (тексты + акцент) */}
      <MainButtonsBlock
        vipLabel={vipButtonLabel}
        chatLabel={chatButtonLabel}
        accent={accentButton}
        onVipLabel={setVipButtonLabel}
        onChatLabel={setChatButtonLabel}
        onAccent={setAccentButton}
      />

      {/* 3) ПОДПИСКА НА КАНАЛЫ ОРГАНИЗАТОРОВ */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <h2 className="block-title mb-1">Подписка на каналы организаторов</h2>
        <p className="text-sm text-gray-500 mb-4">
          Если включено — участник должен быть подписан на Telegram-каналы всех
          соорганизаторов события, чтобы войти в чат и получить доступ к Игре/Розыгрышу.
        </p>
        <div className="space-y-3">
          {[
            { value: false, label: 'Не требовать подписки',                desc: 'Доступ открыт всем зарегистрированным участникам' },
            { value: true,  label: 'Требовать подписку на каналы организаторов', desc: 'Участник должен подписаться на каналы всех соорганизаторов события перед входом' },
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

        {/* Коллаб-событие: рычаг «подписка на всех организаторов-совладельцев» */}
        {event.is_collab && (
          <label
            className={`mt-3 flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
              requireAllOwners
                ? 'border-[#25455D] bg-[#25455D]/5'
                : 'border-gray-200 hover:border-gray-300'
            }`}>
            <input type="checkbox" checked={requireAllOwners}
              onChange={(e) => setRequireAllOwners(e.target.checked)}
              className="mt-0.5 accent-[#25455D]" />
            <div>
              <p className="text-sm font-medium text-gray-900">
                Требовать подписку на каналы всех организаторов коллаборации
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                Это совместное событие. Участник должен подписаться на Telegram-каналы
                каждого организатора-совладельца (проверяется ботом каждого) перед входом в чат.
              </p>
            </div>
          </label>
        )}
      </div>

      {/* 4) НАСТРОЙКИ СТРАНИЦЫ РЕГИСТРАЦИИ — единая секция с переключателем
             внутренний/сторонний лендинг. У КОЛЛАБЫ стороннего нет. */}
      <LandingSettingsBlock
        description={description}
        onDescription={setDescription}
        landingUrl={landingUrl}
        onLandingUrl={setLandingUrl}
        ctaLabel={landingCtaLabel}
        onCtaLabel={setLandingCtaLabel}
        skipContactForm={skipContactForm}
        hasLanding={!!event?.landing_published}
        landingUrlInternal={event?.slug ? `pluson.ru/e/${event.slug}` : ''}
        regMode={regMode}
        onRegMode={setRegMode}
        landingRequireReg={landingReqReg}
        onLandingRequireReg={setLandingReqReg}
        onSkipContactForm={setSkipContactForm}
        allowExternal={!event.is_collab}
      />

      {/* 5) ПУБЛИЧНЫЕ ССЫЛКИ — выбор типа сохраняется общей кнопкой ниже.
          Баннер «Каналы не подключены» теперь ВНУТРИ PublicLinks (по реальному
          наличию ссылок, без зависимости от кешированного me).
          ⚠️ У КОЛЛАБ-события общей публичной ссылки НЕТ: у каждого организатора
          свой бот и своя ссылка — они живут в карточке организатора («Люди» →
          «Организаторы» → вкладка «Ссылки»). Секцию скрываем целиком. */}
      {!event.is_collab && (
        <PublicLinks
          slug={event?.slug}
          eventId={eventId}
          onSlugSaved={onReload}
          eventStatus={event?.status}
          hasLanding={!!event?.landing_published}
        />
      )}

      {/* Save bar — в самом низу страницы */}
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
