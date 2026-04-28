'use client'
/**
 * Настройка Mini App — что видят участники в Telegram.
 *
 * Структура страницы повторяет структуру вкладки «Экосистема» в Mini App
 * сверху вниз — Шапка → Регалии → Соцсети → Продукты — чтобы клиенту
 * было очевидно, какой блок что настраивает.
 *
 * - profile (clients.bio/photo/positioning/achievements/social_links) → одна общая кнопка «Сохранить»
 * - offerings (client_offerings) → CRUD через модалку, каждый продукт сохраняется отдельно
 */
import { useEffect, useState } from 'react'
import { Smartphone, Plus, Pencil, Trash2, X, Save, Eye, ExternalLink, Calendar, Globe } from 'lucide-react'
import { api } from '@/lib/api'

const BRAND = '#25455D'
const GRADIENT = 'linear-gradient(45deg, #25455D, #0a1520)'

interface Achievement { label: string; value: string }
interface Profile {
  id: number
  name: string
  brand_name?: string | null
  bio?: string | null
  profile_photo_url?: string | null
  positioning?: string | null
  achievements: Achievement[]
  social_links: Record<string, string>
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

const SOCIAL_FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: 'telegram',  label: 'Telegram',  placeholder: 'https://t.me/your_channel' },
  { key: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/your_profile' },
  { key: 'youtube',   label: 'YouTube',   placeholder: 'https://youtube.com/@yourchannel' },
  { key: 'vk',        label: 'VK',        placeholder: 'https://vk.com/your_page' },
  { key: 'website',   label: 'Сайт',      placeholder: 'https://yourwebsite.ru' },
]

export default function MiniAppSettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [offerings, setOfferings] = useState<Offering[]>([])
  const [loadingOff, setLoadingOff] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [editing, setEditing] = useState<Offering | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    api.miniApp.profile.get().then(setProfile).catch(() => {})
    loadOfferings()
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
  function updateAchievement(idx: number, field: 'label' | 'value', value: string) {
    if (!profile) return
    const ach = [...profile.achievements]
    ach[idx] = { ...ach[idx], [field]: value }
    update('achievements', ach)
  }
  function addAchievement() {
    if (!profile) return
    update('achievements', [...profile.achievements, { label: '', value: '' }])
  }
  function removeAchievement(idx: number) {
    if (!profile) return
    update('achievements', profile.achievements.filter((_, i) => i !== idx))
  }

  async function saveProfile() {
    if (!profile) return
    setSaving(true)
    try {
      const ach = profile.achievements.filter(a => a.label.trim() && a.value.trim())
      const updated = await api.miniApp.profile.update({
        brand_name:        profile.brand_name || null,
        bio:               profile.bio || null,
        profile_photo_url: profile.profile_photo_url || null,
        positioning:       profile.positioning || null,
        achievements:      ach,
        social_links:      profile.social_links,
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
              Что видят ваши участники, когда открывают Telegram Mini App
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a href="/dashboard/help/connect-bot"
             className="flex items-center gap-2 text-sm rounded-lg px-3 py-2 text-white hover:opacity-90 transition-colors"
             style={{ background: GRADIENT }}>
            📖 Как подключить к боту
          </a>
          <a href="/tg/" target="_blank" rel="noreferrer"
             className="flex items-center gap-2 text-sm border border-gray-300 hover:border-gray-400 rounded-lg px-3 py-2 text-gray-700 hover:bg-gray-50 transition-colors">
            <Eye size={15} /> Открыть Mini App
          </a>
        </div>
      </div>

      {/* Подсказка о структуре Mini App */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-6 max-w-3xl">
        <p className="text-sm text-gray-700 mb-3">
          В вашем Mini App две вкладки внизу:
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex items-start gap-2 flex-1">
            <Calendar size={18} className="mt-0.5 text-gray-500 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-gray-800">📅 Календарь</p>
              <p className="text-xs text-gray-500 mt-0.5">Список ваших событий — заполняется автоматически из «Мероприятий»</p>
            </div>
          </div>
          <div className="flex items-start gap-2 flex-1">
            <Globe size={18} className="mt-0.5 text-amber-500 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-gray-800">🌐 Экосистема ← настраивается здесь</p>
              <p className="text-xs text-gray-500 mt-0.5">Ваша визитка + продукты, которые продвигаете</p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-amber-50 border-l-4 border-amber-300 rounded-r-lg px-4 py-2.5 mb-6 max-w-3xl">
        <p className="text-xs text-amber-900">
          ↓ Все блоки ниже отображаются на одном экране во вкладке «Экосистема» — сверху вниз в этом же порядке.
        </p>
      </div>

      {/* ════════════════════════════════════════════════
           БЛОК 1: Шапка профиля
         ════════════════════════════════════════════════ */}
      {profile && (
        <Section
          step={1}
          title="Шапка профиля"
          hint="В Mini App: верх вкладки «Экосистема» — фото, имя, позиционирование и описание."
        >
          <div className="space-y-4 max-w-2xl">
            <Field label="Ссылка на фото"
                   hint="Можно загрузить через «Лид-магниты» или «Афиши» и скопировать URL.">
              <input type="url" value={profile.profile_photo_url || ''}
                     onChange={e => update('profile_photo_url', e.target.value)}
                     placeholder="https://..." className="input" />
              {profile.profile_photo_url && (
                <img src={profile.profile_photo_url} alt=""
                     className="mt-3 w-24 h-24 rounded-full object-cover border-2"
                     style={{ borderColor: '#FFCFA4' }}
                     onError={e => (e.currentTarget.style.display = 'none')} />
              )}
            </Field>

            <Field label="Имя" hint="Имя редактируется в общих «Настройках» аккаунта.">
              <input type="text" value={profile.name} disabled
                     className="input opacity-60 cursor-not-allowed" />
            </Field>

            <Field label="Название бренда" hint="Крупное название компании/бренда (например iVISION). Если оставить пустым — будет показано имя.">
              <input type="text" value={profile.brand_name || ''}
                     onChange={e => update('brand_name', e.target.value)}
                     placeholder="iVISION"
                     className="input" maxLength={60} />
            </Field>

            <Field label="Позиционирование" hint="Одна короткая строка — кто вы внутри бренда. Например: «основатель iVISION».">
              <input type="text" value={profile.positioning || ''}
                     onChange={e => update('positioning', e.target.value)}
                     placeholder="основатель iVISION"
                     className="input" maxLength={120} />
            </Field>

            <Field label="Биография" hint="Несколько предложений о вас. Покажется обычным текстом ниже позиционирования.">
              <textarea value={profile.bio || ''}
                        onChange={e => update('bio', e.target.value)}
                        placeholder="Кратко расскажите о себе и о том, чем занимаетесь…"
                        className="input min-h-[120px]" />
            </Field>
          </div>
        </Section>
      )}

      {/* ════════════════════════════════════════════════
           БЛОК 2: Регалии
         ════════════════════════════════════════════════ */}
      {profile && (
        <Section
          step={2}
          title="Регалии"
          hint="В Mini App: три карточки под фото с короткими цифрами достижений. Например — «1500+ учеников», «12 лет в нише»."
          action={
            <button onClick={addAchievement}
                    className="text-sm flex items-center gap-1" style={{ color: BRAND }}>
              <Plus size={15} /> Добавить
            </button>
          }
        >
          <div className="space-y-2 max-w-2xl">
            {profile.achievements.map((a, i) => (
              <div key={i} className="flex gap-2 items-start">
                <input type="text" value={a.value}
                       onChange={e => updateAchievement(i, 'value', e.target.value)}
                       placeholder="Цифра — 1500+" className="input w-40" />
                <input type="text" value={a.label}
                       onChange={e => updateAchievement(i, 'label', e.target.value)}
                       placeholder="Подпись — учеников" className="input flex-1" />
                <button onClick={() => removeAchievement(i)}
                        className="p-2 text-gray-400 hover:text-red-600" title="Удалить">
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            {profile.achievements.length === 0 && (
              <p className="text-gray-400 text-sm">Пока нет регалий — добавьте до 3-х значимых.</p>
            )}
          </div>
        </Section>
      )}

      {/* ════════════════════════════════════════════════
           БЛОК 3: Соцсети
         ════════════════════════════════════════════════ */}
      {profile && (
        <Section
          step={3}
          title="Соцсети и сайт"
          hint="В Mini App: ряд иконок под регалиями. Тап по иконке открывает соцсеть в новой вкладке. Заполните только то что хотите показать."
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
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ════════════════════════════════════════════════
           БЛОК 4: Продукты
         ════════════════════════════════════════════════ */}
      <Section
        step={4}
        title="Продукты и материалы"
        hint='В Mini App: ниже соцсетей идут два блока — «💼 Платно» и «📄 Бесплатно». Сюда складывайте всё что хотите продавать или раздавать (курсы, мастер-группы, гайды, чек-листы, ссылки на канал).'
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
              <SubBlock title="💼 Платно" items={offerings.filter(o => o.is_paid)} onEdit={setEditing} onDelete={deleteOffering} />
            )}
            {offerings.filter(o => !o.is_paid).length > 0 && (
              <SubBlock title="📄 Бесплатно" items={offerings.filter(o => !o.is_paid)} onEdit={setEditing} onDelete={deleteOffering} />
            )}
          </div>
        )}
      </Section>

      {/* ════════════════════════════════════════════════
           Sticky-панель «Сохранить» (только для профиля)
         ════════════════════════════════════════════════ */}
      <div className="fixed bottom-4 left-4 right-4 lg:left-[256px] lg:right-6 bg-white border border-gray-200 rounded-xl shadow-lg p-3 flex items-center justify-between gap-3 z-30">
        <div className="text-sm">
          <p className="text-gray-700 font-medium">
            {savedAt ? '✓ Сохранено — изменения уже видны в Mini App' : 'Шапка / Регалии / Соцсети'}
          </p>
          <p className="text-gray-400 text-xs">Продукты сохраняются автоматически при создании / редактировании</p>
        </div>
        <button onClick={saveProfile} disabled={saving}
                className="flex items-center gap-2 px-4 py-2 rounded-lg btn-gold disabled:opacity-60 whitespace-nowrap">
          <Save size={16} />
          {saving ? 'Сохраняем…' : 'Сохранить визитку'}
        </button>
      </div>

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
  title, items, onEdit, onDelete,
}: { title: string; items: Offering[]; onEdit: (o: Offering) => void; onDelete: (id: number) => void }) {
  return (
    <div>
      <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">{title}</p>
      <div className="bg-white rounded-xl border border-gray-200 divide-y">
        {items.map(o => (
          <div key={o.id} className="p-4 flex gap-3 items-start hover:bg-gray-50">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-gray-900">{o.title}</p>
              {o.description && (
                <p className="text-gray-500 text-sm mt-1">{o.description}</p>
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
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <form onSubmit={save}
            className="bg-white rounded-xl max-w-md w-full p-6"
            onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold" style={{ color: BRAND }}>
            {initial ? 'Редактировать продукт' : 'Новый продукт'}
          </h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label">Название</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
                   className="input" placeholder="Программа «Делай имя»" autoFocus />
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
                      className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        isPaid ? 'bg-amber-50 border-amber-300 text-amber-800' : 'border-gray-300 text-gray-500'
                      }`}>
                💼 В блок «Платно»
              </button>
              <button type="button" onClick={() => setIsPaid(false)}
                      className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        !isPaid ? 'bg-green-50 border-green-300 text-green-700' : 'border-gray-300 text-gray-500'
                      }`}>
                📄 В блок «Бесплатно»
              </button>
            </div>
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button type="button" onClick={onClose}
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
