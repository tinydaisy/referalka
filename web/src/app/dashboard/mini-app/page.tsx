'use client'
/**
 * Настройка Mini App — что видят участники в Telegram.
 *
 * Структура:
 *   • Вкладка «Бренд»     — настраивает шапку Экосистемы и логотип в углу всех страниц.
 *   • Вкладка «Основатель» — карточка-тизер «Об основателе» в Экосистеме + страница «Об основателе».
 *   • Вкладка «Продукты»   — то что в Mini App в блоках «Платно / Бесплатно».
 *
 * Сохранение:
 *   • profile (бренд + основатель) — общая кнопка «Сохранить визитку» внизу.
 *   • offerings — каждый сохраняется автоматом при создании/редактировании.
 */
import { useEffect, useState } from 'react'
import { Smartphone, Plus, Pencil, Trash2, X, Save, ExternalLink, Globe, Building2, User, ChevronUp, ChevronDown } from 'lucide-react'
import FileUploader from '@/components/FileUploader'
import { FounderTgChannelsField, FounderTgChannel } from '@/components/FounderTgChannelsField'
import { FounderMaxChannelsField, FounderMaxChannel } from '@/components/FounderMaxChannelsField'
import { FounderVkChannelsField, FounderVkChannel } from '@/components/FounderVkChannelsField'
import { api } from '@/lib/api'

const BRAND = '#25455D'
const GRADIENT = 'linear-gradient(45deg, #25455D, #0a1520)'

interface Achievement { label: string; value: string }
interface Profile {
  id: number
  name: string                              // техническое (из регистрации, readonly)
  // Бренд
  brand_name?: string | null
  brand_logo_url?: string | null
  profile_photo_url?: string | null         // фото бренда
  positioning?: string | null               // позиционирование бренда
  achievements: Achievement[]               // факты в цифрах бренда
  // Основатель (имя берётся из clients.name — отдельной колонки больше нет)
  owner_photo_url?: string | null
  owner_positioning?: string | null
  owner_achievements: Achievement[]         // факты в цифрах основателя
  bio?: string | null                       // биография основателя
  // social_links — словарь соцсетей основателя. Ключи строковые (instagram, youtube, vk, website),
  // отдельный ключ `telegram_channels` — МАССИВ TG-каналов основателя (миграция 114).
  social_links: Record<string, any>
  // Бот и ссылки
  default_link_mode?: 'miniapp' | 'bot' | null
  start_greeting_text?: string | null
  start_btn_events_label?: string | null
  start_btn_owner_label?: string | null
  start_mode?: 'greeting' | 'event' | 'lead_magnet' | null
  start_event_id?: number | null
  start_lead_magnet_id?: number | null
  start_package_id?: number | null
}
interface Offering {
  id: number
  title: string
  description?: string | null
  action_url?: string | null
  is_paid: boolean
  cover_url?: string | null
  sort_order: number
}

// Telegram-каналы основателя — отдельная секция выше (FounderTgChannelsField),
// потому что их может быть несколько и они используются для проверки подписки
// (воронки лид-магнитов + чат-гейты). Здесь только остальные соцсети.
const SOCIAL_FIELDS: { key: string; label: string; placeholder: string; hint?: string }[] = [
  { key: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/your_profile' },
  { key: 'youtube',   label: 'YouTube',   placeholder: 'https://youtube.com/@yourchannel' },
  { key: 'vk',        label: 'VK',        placeholder: 'https://vk.com/your_page' },
  { key: 'website',   label: 'Сайт',      placeholder: 'https://yourwebsite.ru' },
]

type Tab = 'brand' | 'owner' | 'products' | 'bot'

// Дефолтные значения приветствия /start — те же, что бот ставит, если поля
// пустые. Показываем их предзаполненными, чтобы клиент видел готовый шаблон.
const DEFAULT_GREETING =
  'Привет, {имя}! 👋\n\nДобро пожаловать в бот {бренд}.\n\nЗагляните в события и узнайте об организаторе по кнопкам ниже 👇'
const DEFAULT_BTN_EVENTS = '📅 Все события'
const DEFAULT_BTN_OWNER  = '🌐 Об основателе'

export default function MiniAppSettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [offerings, setOfferings] = useState<Offering[]>([])
  const [loadingOff, setLoadingOff] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [editing, setEditing] = useState<Offering | null>(null)
  const [creating, setCreating] = useState(false)
  const [eventList, setEventList] = useState<{ id: number; title: string; status?: string }[]>([])
  const [leadMagnets, setLeadMagnets] = useState<{ id: number; name: string }[]>([])
  const [leadPackages, setLeadPackages] = useState<{ id: number; name: string }[]>([])
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'brand'
    const t = new URLSearchParams(window.location.search).get('tab')
    return (t === 'owner' || t === 'products' || t === 'bot') ? t as Tab : 'brand'
  })

  useEffect(() => {
    api.miniApp.profile.get().then((p: any) => {
      // нормализуем — на всякий случай
      setProfile({
        ...p,
        achievements:       Array.isArray(p.achievements)       ? p.achievements       : [],
        owner_achievements: Array.isArray(p.owner_achievements) ? p.owner_achievements : [],
        social_links:       p.social_links || {},
        // Предзаполняем приветствие дефолтным шаблоном, если поле пустое —
        // клиент видит готовый текст и правит его.
        start_greeting_text:    p.start_greeting_text    || DEFAULT_GREETING,
        start_btn_events_label: p.start_btn_events_label || DEFAULT_BTN_EVENTS,
        start_btn_owner_label:  p.start_btn_owner_label  || DEFAULT_BTN_OWNER,
      })
    }).catch(() => {})
    loadOfferings()
    api.events.list().then((r: any) => {
      const arr = Array.isArray(r) ? r : (r?.events || r?.items || [])
      setEventList(arr.map((e: any) => ({ id: e.id, title: e.title, status: e.status })))
    }).catch(() => {})
    api.leadMagnets.list().then((r: any) => {
      const arr = Array.isArray(r) ? r : (r?.lead_magnets || r?.items || [])
      setLeadMagnets(arr.map((m: any) => ({ id: m.id, name: m.name })))
    }).catch(() => {})
    api.leadMagnetPackages.list().then((r: any) => {
      const arr = Array.isArray(r) ? r : (r?.packages || r?.lead_magnet_packages || r?.items || [])
      setLeadPackages(arr.map((p: any) => ({ id: p.id, name: p.name })))
    }).catch(() => {})
  }, [])

  async function loadOfferings() {
    setLoadingOff(true)
    try {
      const r = await api.miniApp.offerings.list()
      setOfferings(r.items || [])
    } finally {
      setLoadingOff(false)
    }
  }

  function update<K extends keyof Profile>(key: K, value: Profile[K]) {
    setProfile(p => p ? { ...p, [key]: value } : p)
  }
  function updateSocial(key: string, value: string) {
    if (!profile) return
    const next = { ...profile.social_links }
    if (value.trim()) next[key] = value.trim(); else delete next[key]
    update('social_links', next)
  }
  function updateTgChannels(list: FounderTgChannel[]) {
    if (!profile) return
    const next = { ...profile.social_links, telegram_channels: list }
    update('social_links', next)
  }
  function updateMaxChannels(list: FounderMaxChannel[]) {
    if (!profile) return
    const next = { ...profile.social_links, max_channels: list }
    update('social_links', next)
  }
  function updateVkChannels(list: FounderVkChannel[]) {
    if (!profile) return
    const next = { ...profile.social_links, vk_channels: list }
    update('social_links', next)
  }
  function updateAch(field: 'achievements' | 'owner_achievements', idx: number, key: 'label' | 'value', value: string) {
    if (!profile) return
    const next = [...profile[field]]
    next[idx] = { ...next[idx], [key]: value }
    update(field, next)
  }
  function addAch(field: 'achievements' | 'owner_achievements') {
    if (!profile) return
    update(field, [...profile[field], { label: '', value: '' }])
  }
  function removeAch(field: 'achievements' | 'owner_achievements', idx: number) {
    if (!profile) return
    update(field, profile[field].filter((_, i) => i !== idx))
  }

  async function saveProfile() {
    if (!profile) return
    setSaving(true)
    try {
      const cleanAch = (a: Achievement[]) => a.filter(x => x.label.trim() && x.value.trim())
      const updated = await api.miniApp.profile.update({
        // бренд
        brand_name:     profile.brand_name     || null,
        brand_logo_url: profile.brand_logo_url || null,
        positioning:    profile.positioning    || null,
        achievements:   cleanAch(profile.achievements),
        // основатель
        owner_photo_url:    profile.owner_photo_url   || null,
        owner_positioning:  profile.owner_positioning || null,
        owner_achievements: cleanAch(profile.owner_achievements),
        bio:                profile.bio || null,
        social_links:       profile.social_links,
        // бот и ссылки
        default_link_mode:      profile.default_link_mode || 'miniapp',
        start_greeting_text:    profile.start_greeting_text    || null,
        start_btn_events_label: profile.start_btn_events_label || null,
        start_btn_owner_label:  profile.start_btn_owner_label  || null,
        start_mode:             profile.start_mode || 'greeting',
        start_event_id:         profile.start_mode === 'event' ? (profile.start_event_id || null) : null,
        start_lead_magnet_id:   profile.start_mode === 'lead_magnet' ? (profile.start_lead_magnet_id || null) : null,
        start_package_id:       profile.start_mode === 'lead_magnet' ? (profile.start_package_id || null) : null,
      })
      setProfile(p => p ? { ...p, ...updated } : updated)
      setSavedAt(Date.now()); setTimeout(() => setSavedAt(null), 2000)
    } catch (e: any) {
      alert(e.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  async function deleteOffering(id: number) {
    if (!confirm('Удалить продукт? Он сразу пропадёт из Mini App.')) return
    try { await api.miniApp.offerings.delete(id); await loadOfferings() }
    catch (e: any) { alert(e.message || 'Ошибка удаления') }
  }

  // Перестановка продукта внутри своего блока (платно/бесплатно).
  // Перенормируем sort_order у всего блока: 0..N-1 после перемещения.
  // Это гарантирует устойчивый порядок даже если изначально у всех было sort_order=0.
  async function moveOffering(item: Offering, direction: -1 | 1) {
    const block = offerings.filter(o => o.is_paid === item.is_paid)
                           .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    const idx = block.findIndex(o => o.id === item.id)
    const newIdx = idx + direction
    if (idx < 0 || newIdx < 0 || newIdx >= block.length) return
    const reordered = [...block]
    ;[reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]]
    // Оптимистично обновляем UI
    const updatedAll = offerings.map(o => {
      const newPos = reordered.findIndex(x => x.id === o.id)
      return newPos >= 0 ? { ...o, sort_order: newPos } : o
    })
    setOfferings(updatedAll)
    // Параллельно отправляем PATCH для всех элементов блока
    try {
      await Promise.all(reordered.map((o, i) =>
        o.sort_order === i ? Promise.resolve() : api.miniApp.offerings.update(o.id, { sort_order: i })
      ))
    } catch (e: any) {
      alert(e.message || 'Не удалось сохранить порядок')
      await loadOfferings()
    }
  }

  return (
    <div className="pb-24">
      {/* Заголовок */}
      <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg text-white" style={{ background: GRADIENT }}>
            <Smartphone size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold" style={{ color: BRAND }}>
              Настройка Mini App
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Что видят участники в Telegram — на всех страницах.
            </p>
          </div>
        </div>
      </div>

      {/* Табы */}
      <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-xl max-w-2xl">
        <TabBtn active={tab === 'brand'}    onClick={() => setTab('brand')}    icon={<Building2 size={15} />} label="Бренд" />
        <TabBtn active={tab === 'owner'}    onClick={() => setTab('owner')}    icon={<User size={15} />}      label="Основатель" />
        <TabBtn active={tab === 'products'} onClick={() => setTab('products')} icon={<Globe size={15} />}     label="Продукты" />
        <TabBtn active={tab === 'bot'}      onClick={() => setTab('bot')}      icon={<Smartphone size={15} />} label="Бот и ссылки" />
      </div>

      {/* ════════════════════════════════════════════════
           ВКЛАДКА: БРЕНД
         ════════════════════════════════════════════════ */}
      {tab === 'brand' && profile && (
        <>
          <Section
            step={1}
            title="Логотип бренда"
            hint="Маленькая иконка в правом верхнем углу всех страниц Mini App. Тап → открывает Экосистему. Лучше квадратная картинка на прозрачном/белом фоне."
          >
            <div className="max-w-2xl">
              <FileUploader
                mode="single"
                kind="brand_logo"
                value={profile.brand_logo_url || null}
                onChange={url => update('brand_logo_url', url)}
                emptyText="Загрузите логотип (PNG/JPG)"
                buttonLabel="Загрузить логотип"
                aspectClass="aspect-square"
              />
            </div>
          </Section>

          <Section
            step={2}
            title="Шапка Экосистемы"
            hint="Верх вкладки «Экосистема» в Mini App — название и позиционирование. Картинка слева в шапке — это тот же логотип бренда из шага 1."
          >
            <div className="space-y-4 max-w-2xl">
              <Field label="Название бренда"
                     hint="Крупно в шапке. Если оставить пустым — будет показано имя из регистрации.">
                <input type="text" value={profile.brand_name || ''}
                       onChange={e => update('brand_name', e.target.value)}
                       className="input" maxLength={60} />
              </Field>

              <Field label="Позиционирование бренда"
                     hint="Одна короткая строка под названием — что вы делаете.">
                <input type="text" value={profile.positioning || ''}
                       onChange={e => update('positioning', e.target.value)}
                       className="input" maxLength={120} />
              </Field>
            </div>
          </Section>

          <Section
            step={3}
            title="Факты в цифрах"
            hint="Карточки под фото бренда. Пара «цифра + подпись». Если фактов нет — блок не показывается."
            action={
              <button onClick={() => addAch('achievements')}
                      className="text-sm flex items-center gap-1" style={{ color: BRAND }}>
                <Plus size={15} /> Добавить
              </button>
            }
          >
            <AchievementsEditor
              items={profile.achievements}
              onChange={(idx, key, val) => updateAch('achievements', idx, key, val)}
              onRemove={idx => removeAch('achievements', idx)}
            />
          </Section>
        </>
      )}

      {/* ════════════════════════════════════════════════
           ВКЛАДКА: ОСНОВАТЕЛЬ
         ════════════════════════════════════════════════ */}
      {tab === 'owner' && profile && (
        <>
          <div className="bg-amber-50 border-l-4 border-amber-300 rounded-r-lg px-4 py-3 mb-5 max-w-3xl">
            <p className="text-xs text-amber-900">
              В Mini App: на главной Экосистемы под Фактами бренда — <b>карточка-тизер «Об основателе»</b>.
              Тап → отдельная страница с большим фото, биографией и соцсетями.
            </p>
          </div>

          <Section
            step={1}
            title="Карточка основателя"
            hint="Имя, позиционирование, фото — это и попадёт в карточку-тизер на главной Экосистемы."
          >
            <div className="space-y-4 max-w-2xl">
              <Field label="Имя в Mini App"
                     hint="Это имя из регистрации. Для смены — напишите в Тех.поддержку.">
                <input type="text" value={profile.name || ''} disabled
                       className="input opacity-60 cursor-not-allowed" />
              </Field>

              <Field label="Фото основателя">
                <FileUploader
                  mode="single"
                  kind="owner_photo"
                  value={profile.owner_photo_url || null}
                  onChange={url => update('owner_photo_url', url)}
                  emptyText="Загрузите фото основателя"
                  buttonLabel="Загрузить фото"
                  aspectClass="aspect-square"
                />
              </Field>

              <Field label="Позиционирование основателя"
                     hint="Одна строка о роли.">
                <input type="text" value={profile.owner_positioning || ''}
                       onChange={e => update('owner_positioning', e.target.value)}
                       className="input" maxLength={140} />
              </Field>
            </div>
          </Section>

          <Section
            step={2}
            title="Факты в цифрах"
            hint="Цифры о основателе — на странице «Об основателе». Если пусто — блок скрыт."
            action={
              <button onClick={() => addAch('owner_achievements')}
                      className="text-sm flex items-center gap-1" style={{ color: BRAND }}>
                <Plus size={15} /> Добавить
              </button>
            }
          >
            <AchievementsEditor
              items={profile.owner_achievements}
              onChange={(idx, key, val) => updateAch('owner_achievements', idx, key, val)}
              onRemove={idx => removeAch('owner_achievements', idx)}
            />
          </Section>

          <Section
            step={3}
            title="Биография"
            hint="Подробный текст для страницы «Об основателе». Если пусто — раздела на странице нет."
          >
            <textarea value={profile.bio || ''}
                      onChange={e => update('bio', e.target.value)}
                      placeholder="Несколько абзацев о вас: опыт, проекты, история…"
                      className="input min-h-[160px] max-w-2xl block" />
          </Section>

          <Section
            step={4}
            title="Telegram каналы основателя"
            hint="Список всех ваших TG-каналов. Используются для проверки подписки в воронках лид-магнитов и в гейтах чатов — участник должен быть подписан на ВСЕ каналы из списка. Также отображаются на странице «Об основателе» в Mini App."
          >
            <div className="max-w-2xl">
              <FounderTgChannelsField
                value={Array.isArray(profile.social_links.telegram_channels)
                  ? profile.social_links.telegram_channels as FounderTgChannel[]
                  : []}
                onChange={updateTgChannels}
              />
            </div>
          </Section>

          <Section
            step={5}
            title="MAX каналы основателя"
            hint="Список ваших каналов в MAX. Используются для проверки подписки в воронках лид-магнитов в MAX — участник должен быть подписан на ВСЕ каналы из списка."
          >
            <div className="max-w-2xl">
              <FounderMaxChannelsField
                value={Array.isArray(profile.social_links.max_channels)
                  ? profile.social_links.max_channels as FounderMaxChannel[]
                  : []}
                onChange={updateMaxChannels}
              />
            </div>
          </Section>

          <Section
            step={6}
            title="VK сообщества основателя"
            hint="Список ваших сообществ в VK. Используются для проверки подписки в воронках лид-магнитов в VK — участник должен быть подписан на ВСЕ сообщества из списка. ID определяется автоматически по ссылке."
          >
            <div className="max-w-2xl">
              <FounderVkChannelsField
                value={Array.isArray(profile.social_links.vk_channels)
                  ? profile.social_links.vk_channels as FounderVkChannel[]
                  : []}
                onChange={updateVkChannels}
              />
            </div>
          </Section>

          <Section
            step={7}
            title="Другие соцсети основателя"
            hint="Ряд иконок на странице «Об основателе». Заполняйте только то что хотите показать."
          >
            <div className="space-y-3 max-w-2xl">
              {SOCIAL_FIELDS.map(f => (
                <div key={f.key}>
                  <label className="label">{f.label}</label>
                  <input type="url"
                         value={profile.social_links[f.key] || ''}
                         onChange={e => updateSocial(f.key, e.target.value)}
                         placeholder={f.placeholder}
                         className="input" />
                  {f.hint && <p className="text-xs text-gray-500 mt-1">{f.hint}</p>}
                </div>
              ))}
            </div>
          </Section>
        </>
      )}

      {/* ════════════════════════════════════════════════
           ВКЛАДКА: БОТ И ССЫЛКИ
         ════════════════════════════════════════════════ */}
      {tab === 'bot' && profile && (
        <div className="space-y-5 max-w-2xl pb-28">
          <Section
            step={1}
            title="Как открываются ваши ссылки"
            hint="Общая настройка для всего кабинета. Определяет, куда ведут публичные ссылки событий и кнопки приветствия в боте."
          >
            <div className="space-y-2">
              {([
                { v: 'miniapp', t: 'Mini App', d: 'Ссылки открывают приложение внутри Telegram/VK (Mini App). + веб-лендинг.' },
                { v: 'bot',     t: 'Веб-версия', d: 'Ссылки открывают веб-страницы на pluson.ru (без Mini App).' },
              ] as const).map(opt => {
                const active = (profile.default_link_mode || 'miniapp') === opt.v
                return (
                  <button key={opt.v} type="button"
                          onClick={() => update('default_link_mode', opt.v)}
                          className={`w-full text-left rounded-xl border p-3 transition ${active ? 'border-amber-300 bg-amber-50' : 'border-gray-200 hover:border-gray-300'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${active ? 'border-amber-400 bg-amber-400' : 'border-gray-300'}`} />
                      <span className="font-semibold text-gray-900 text-sm">{opt.t}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1 ml-6">{opt.d}</p>
                  </button>
                )
              })}
            </div>
          </Section>

          <Section
            step={2}
            title="Что открывать при /start"
            hint="Когда человек впервые пишет вашему боту: показать общее приветствие, сразу открыть конкретное событие или запустить воронку лид-магнита."
          >
            <div className="space-y-2 mb-4">
              {([
                { v: 'greeting', t: 'Общее приветствие', d: 'Текст-приветствие + 2 кнопки (все события / об основателе).' },
                { v: 'event',    t: 'Конкретное событие', d: 'Сразу открывается выбранное событие — его вход/регистрация/меню.' },
                { v: 'lead_magnet', t: 'Лид-магнит', d: 'Сразу запускается воронка выбранного лид-магнита (Telegram, ВКонтакте).' },
              ] as const).map(opt => {
                const active = (profile.start_mode || 'greeting') === opt.v
                return (
                  <button key={opt.v} type="button"
                          onClick={() => update('start_mode', opt.v)}
                          className={`w-full text-left rounded-xl border p-3 transition ${active ? 'border-amber-300 bg-amber-50' : 'border-gray-200 hover:border-gray-300'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${active ? 'border-amber-400 bg-amber-400' : 'border-gray-300'}`} />
                      <span className="font-semibold text-gray-900 text-sm">{opt.t}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1 ml-6">{opt.d}</p>
                  </button>
                )
              })}
            </div>

            {(profile.start_mode || 'greeting') === 'event' ? (
              <div>
                <label className="block text-sm text-gray-700 mb-1">Событие, которое откроется при /start</label>
                <select
                  value={profile.start_event_id || ''}
                  onChange={e => update('start_event_id', e.target.value ? Number(e.target.value) : null)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400 bg-white"
                >
                  <option value="">— выберите событие —</option>
                  {eventList.map(ev => (
                    <option key={ev.id} value={ev.id}>
                      {ev.title}{ev.status === 'draft' ? ' (черновик)' : ev.status === 'ended' ? ' (завершено)' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-400 mt-1">
                  Опубликуйте событие, чтобы оно открывалось у людей. Черновик/завершённое — не откроется.
                </p>
              </div>
            ) : (profile.start_mode || 'greeting') === 'lead_magnet' ? (
              <div>
                <label className="block text-sm text-gray-700 mb-1">Лид-магнит, воронка которого запустится при /start</label>
                <select
                  value={profile.start_lead_magnet_id ? `m${profile.start_lead_magnet_id}` : profile.start_package_id ? `p${profile.start_package_id}` : ''}
                  onChange={e => {
                    const v = e.target.value
                    if (!v) { update('start_lead_magnet_id', null); update('start_package_id', null) }
                    else if (v.startsWith('m')) { update('start_lead_magnet_id', Number(v.slice(1))); update('start_package_id', null) }
                    else { update('start_package_id', Number(v.slice(1))); update('start_lead_magnet_id', null) }
                  }}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400 bg-white"
                >
                  <option value="">— выберите лид-магнит —</option>
                  {leadMagnets.length > 0 && (
                    <optgroup label="Лид-магниты">
                      {leadMagnets.map(lm => <option key={`m${lm.id}`} value={`m${lm.id}`}>{lm.name}</option>)}
                    </optgroup>
                  )}
                  {leadPackages.length > 0 && (
                    <optgroup label="Пакеты">
                      {leadPackages.map(p => <option key={`p${p.id}`} value={`p${p.id}`}>{p.name}</option>)}
                    </optgroup>
                  )}
                </select>
                <p className="text-xs text-gray-400 mt-1">
                  При /start у бота человек сразу попадёт в воронку: приветствие → проверка подписки → выдача материалов.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-700 mb-1">Текст приветствия</label>
                  <textarea
                    value={profile.start_greeting_text || ''}
                    onChange={e => update('start_greeting_text', e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Можно использовать <code className="font-mono">{'{имя}'}</code> (имя человека) и
                    {' '}<code className="font-mono">{'{бренд}'}</code> (ваш бренд).
                    Поддерживается HTML: <code className="font-mono">{'<b>жирный</b>'}</code>.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">Кнопка «Все события»</label>
                    <input
                      value={profile.start_btn_events_label || ''}
                      onChange={e => update('start_btn_events_label', e.target.value)}
                      placeholder="📅 Все события"
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400"
                    />
                    <p className="text-xs text-gray-400 mt-1">Ведёт на список всех ваших событий.</p>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-700 mb-1">Кнопка «Об основателе»</label>
                    <input
                      value={profile.start_btn_owner_label || ''}
                      onChange={e => update('start_btn_owner_label', e.target.value)}
                      placeholder="🌐 Об основателе"
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400"
                    />
                    <p className="text-xs text-gray-400 mt-1">Ведёт в раздел «Экосистема» (об основателе).</p>
                  </div>
                </div>
              </div>
            )}
          </Section>
        </div>
      )}

      {/* ════════════════════════════════════════════════
           ВКЛАДКА: ПРОДУКТЫ
         ════════════════════════════════════════════════ */}
      {tab === 'products' && (
        <Section
          step={1}
          title="Продукты и материалы"
          hint='В Mini App: внизу Экосистемы два блока — «💼 Платно» и «📄 Бесплатно». Сюда складывайте всё что хотите продавать или раздавать.'
          action={
            <button onClick={() => setCreating(true)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-white text-sm font-medium"
                    style={{ background: GRADIENT }}>
              <Plus size={15} /> Добавить продукт
            </button>
          }
        >
          {loadingOff ? (
            <p className="text-gray-400 text-sm">Загрузка…</p>
          ) : offerings.length === 0 ? (
            <div className="bg-gray-50 border border-dashed border-gray-300 rounded-xl p-8 text-center">
              <p className="text-gray-500 text-sm">Пока нет продуктов</p>
              <button onClick={() => setCreating(true)}
                      className="text-sm underline mt-2" style={{ color: BRAND }}>
                Создать первый
              </button>
            </div>
          ) : (
            <div className="space-y-5 max-w-2xl">
              {offerings.filter(o => o.is_paid).length > 0 && (
                <SubBlock title="💼 Платно"
                          items={offerings.filter(o => o.is_paid).sort((a,b) => a.sort_order - b.sort_order || a.id - b.id)}
                          onEdit={setEditing} onDelete={deleteOffering} onMove={moveOffering} />
              )}
              {offerings.filter(o => !o.is_paid).length > 0 && (
                <SubBlock title="📄 Бесплатно"
                          items={offerings.filter(o => !o.is_paid).sort((a,b) => a.sort_order - b.sort_order || a.id - b.id)}
                          onEdit={setEditing} onDelete={deleteOffering} onMove={moveOffering} />
              )}
            </div>
          )}
        </Section>
      )}

      {/* ════════════════════════════════════════════════
           Sticky-панель «Сохранить» (только для профиля)
         ════════════════════════════════════════════════ */}
      {tab !== 'products' && (
        <div className="fixed bottom-4 left-4 right-4 lg:left-[256px] lg:right-6 bg-white border border-gray-200 rounded-xl shadow-lg p-3 flex items-center justify-between gap-3 z-30">
          <div className="text-sm">
            <p className="text-gray-700 font-medium">
              {savedAt ? '✓ Сохранено — изменения уже видны в Mini App' : (tab === 'brand' ? 'Настройки бренда' : tab === 'bot' ? 'Бот и ссылки' : 'Настройки основателя')}
            </p>
            <p className="text-gray-400 text-xs">Файлы сохраняются в момент загрузки. Текстовые поля — по кнопке.</p>
          </div>
          <button onClick={saveProfile} disabled={saving}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg btn-gold disabled:opacity-60 whitespace-nowrap">
            <Save size={16} />
            {saving ? 'Сохраняем…' : 'Сохранить визитку'}
          </button>
        </div>
      )}

      {(creating || editing) && (
        <OfferingModal
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={async () => { setCreating(false); setEditing(null); await loadOfferings() }}
        />
      )}

    </div>
  )
}

// ═══════════════════ Helpers ═══════════════════

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
        active
          ? 'bg-white text-[#25455D] shadow-sm'
          : 'text-gray-500 hover:text-gray-700'
      }`}
    >
      {icon} {label}
    </button>
  )
}

function AchievementsEditor({
  items, onChange, onRemove,
}: {
  items: Achievement[]
  onChange: (idx: number, key: 'label' | 'value', val: string) => void
  onRemove: (idx: number) => void
}) {
  return (
    <div className="space-y-2 max-w-2xl">
      {items.map((a, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 items-start">
          <div className="col-span-4">
            <label className="text-xs text-gray-500 mb-1 block">Цифра</label>
            <input type="text" value={a.value}
                   onChange={e => onChange(i, 'value', e.target.value)}
                   placeholder="1500+" className="input" />
          </div>
          <div className="col-span-7">
            <label className="text-xs text-gray-500 mb-1 block">Подпись</label>
            <input type="text" value={a.label}
                   onChange={e => onChange(i, 'label', e.target.value)}
                   placeholder="учеников" className="input" />
          </div>
          <div className="col-span-1 pt-6">
            <button onClick={() => onRemove(i)}
                    className="p-2 text-gray-400 hover:text-red-600" title="Удалить">
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      ))}
      {items.length === 0 && (
        <p className="text-gray-400 text-sm">Пока нет фактов — добавьте 2–4 значимых.</p>
      )}
    </div>
  )
}

function Section({
  step, title, hint, action, children,
}: { step: number; title: string; hint: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
               style={{ background: GRADIENT }}>
            {step}
          </div>
          <div>
            <h2 className="font-semibold text-lg" style={{ color: BRAND }}>{title}</h2>
            <p className="text-xs text-gray-500 mt-1 max-w-2xl">{hint}</p>
          </div>
        </div>
        {action}
      </div>
      <div className="pt-2">{children}</div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="text-gray-400 text-xs mt-1.5">{hint}</p>}
    </div>
  )
}

function SubBlock({
  title, items, onEdit, onDelete, onMove,
}: {
  title: string
  items: Offering[]
  onEdit: (o: Offering) => void
  onDelete: (id: number) => void
  onMove: (o: Offering, dir: -1 | 1) => void
}) {
  return (
    <div>
      <div className="inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-bold uppercase tracking-wider mb-2"
           style={{
             background: 'linear-gradient(135deg, #FFCFA4, #f5b97e)',
             color: '#25455D',
             boxShadow: '0 2px 6px rgba(255,207,164,0.4)',
           }}>
        {title}
      </div>
      <div className="bg-white rounded-xl border border-gray-200 divide-y">
        {items.map((o, i) => (
          <div key={o.id} className="p-4 flex gap-3 items-start hover:bg-gray-50">
            {/* Стрелки порядка */}
            <div className="flex flex-col gap-0.5 -my-1">
              <button onClick={() => onMove(o, -1)} disabled={i === 0}
                      title="Поднять выше"
                      className="p-1 rounded text-gray-400 hover:text-[#25455D] hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent">
                <ChevronUp size={15} />
              </button>
              <button onClick={() => onMove(o, 1)} disabled={i === items.length - 1}
                      title="Опустить ниже"
                      className="p-1 rounded text-gray-400 hover:text-[#25455D] hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent">
                <ChevronDown size={15} />
              </button>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-gray-900">{o.title}</p>
              {o.description && (
                <p className="text-gray-500 text-sm mt-1 whitespace-pre-wrap break-words">{o.description}</p>
              )}
              {o.action_url && (
                <a href={o.action_url} target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-1 text-xs mt-2 text-gray-400 hover:underline truncate">
                  <ExternalLink size={12} />
                  <span className="truncate" style={{ maxWidth: 360 }}>{o.action_url}</span>
                </a>
              )}
            </div>
            <div className="flex gap-1">
              <button onClick={() => onEdit(o)}
                      className="p-2 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100"><Pencil size={15} /></button>
              <button onClick={() => onDelete(o.id)}
                      className="p-2 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 size={15} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function OfferingModal({
  initial, onClose, onSaved,
}: { initial: Offering | null; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [title,  setTitle]  = useState(initial?.title || '')
  const [desc,   setDesc]   = useState(initial?.description || '')
  const [url,    setUrl]    = useState(initial?.action_url || '')
  const [isPaid, setIsPaid] = useState<boolean>(initial?.is_paid ?? true)
  const [saving, setSaving] = useState(false)

  function isDirty(): boolean {
    if (!initial) {
      return !!(title.trim() || desc.trim() || url.trim())
    }
    return title  !== (initial.title       || '')
        || desc   !== (initial.description || '')
        || url    !== (initial.action_url  || '')
        || isPaid !== (initial.is_paid ?? true)
  }

  function attemptClose() {
    if (isDirty() && !confirm('У вас несохранённые изменения. Закрыть карточку и потерять их?')) {
      return
    }
    onClose()
  }

  async function save(e?: React.FormEvent) {
    e?.preventDefault()
    if (!title.trim()) { alert('Укажите название'); return }
    setSaving(true)
    try {
      const payload = {
        title: title.trim(),
        description: desc.trim() || null,
        action_url: url.trim() || null,
        is_paid: isPaid,
      }
      if (initial) await api.miniApp.offerings.update(initial.id, payload)
      else         await api.miniApp.offerings.create(payload)
      await onSaved()
    } catch (e: any) {
      alert(e.message || 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <form onSubmit={save}
            className="bg-white rounded-xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold" style={{ color: BRAND }}>
            {initial ? 'Редактировать продукт' : 'Новый продукт'}
          </h2>
          <button type="button" onClick={attemptClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label">Название</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
                   className="input" autoFocus />
          </div>
          <div>
            <label className="label">Описание</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)}
                      className="input min-h-[80px]"
                      placeholder="Что это и кому подходит" />
          </div>
          <div>
            <label className="label">Ссылка (куда ведёт кнопка «Узнать подробнее»)</label>
            <input type="url" value={url} onChange={e => setUrl(e.target.value)}
                   className="input" placeholder="https://..." />
          </div>
          <div>
            <label className="label">Куда показывать в Mini App</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setIsPaid(true)}
                      className="flex-1 px-4 py-2.5 rounded-lg text-sm font-bold border-2 transition-all"
                      style={isPaid
                        ? { background: 'linear-gradient(135deg, #FFCFA4, #f5b97e)', borderColor: '#f5b97e', color: '#25455D', boxShadow: '0 2px 8px rgba(255,207,164,0.5)' }
                        : { background: 'white', borderColor: '#e5e7eb', color: '#9ca3af' }
                      }>
                💼 В блок «Платно»
              </button>
              <button type="button" onClick={() => setIsPaid(false)}
                      className="flex-1 px-4 py-2.5 rounded-lg text-sm font-bold border-2 transition-all"
                      style={!isPaid
                        ? { background: 'linear-gradient(135deg, #FFCFA4, #f5b97e)', borderColor: '#f5b97e', color: '#25455D', boxShadow: '0 2px 8px rgba(255,207,164,0.5)' }
                        : { background: 'white', borderColor: '#e5e7eb', color: '#9ca3af' }
                      }>
                📄 В блок «Бесплатно»
              </button>
            </div>
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button type="button" onClick={attemptClose}
                  className="flex-1 px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">
            Отмена
          </button>
          <button type="submit" disabled={saving}
                  className="flex-1 px-4 py-2 rounded-lg btn-gold disabled:opacity-60">
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </form>
    </div>
  )
}
