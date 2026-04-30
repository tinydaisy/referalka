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
import { Smartphone, Plus, Pencil, Trash2, X, Save, Eye, ExternalLink, Calendar, Globe, Building2, User } from 'lucide-react'
import FileUploader from '@/components/FileUploader'
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
  // Основатель
  owner_name?: string | null
  owner_photo_url?: string | null
  owner_positioning?: string | null
  owner_achievements: Achievement[]         // факты в цифрах основателя
  bio?: string | null                       // биография основателя
  social_links: Record<string, string>      // соцсети основателя
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

type Tab = 'brand' | 'owner' | 'products'

export default function MiniAppSettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [offerings, setOfferings] = useState<Offering[]>([])
  const [loadingOff, setLoadingOff] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [editing, setEditing] = useState<Offering | null>(null)
  const [creating, setCreating] = useState(false)
  const [tab, setTab] = useState<Tab>('brand')

  useEffect(() => {
    api.miniApp.profile.get().then((p: any) => {
      // нормализуем — на всякий случай
      setProfile({
        ...p,
        achievements:       Array.isArray(p.achievements)       ? p.achievements       : [],
        owner_achievements: Array.isArray(p.owner_achievements) ? p.owner_achievements : [],
        social_links:       p.social_links || {},
      })
    }).catch(() => {})
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
        owner_name:         profile.owner_name        || null,
        owner_photo_url:    profile.owner_photo_url   || null,
        owner_positioning:  profile.owner_positioning || null,
        owner_achievements: cleanAch(profile.owner_achievements),
        bio:                profile.bio || null,
        social_links:       profile.social_links,
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
              Что видят участники в Telegram — на всех страницах.
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
          Внизу Mini App две вкладки:
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex items-start gap-2 flex-1">
            <Calendar size={18} className="mt-0.5 text-gray-500 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-gray-800">📅 Календарь</p>
              <p className="text-xs text-gray-500 mt-0.5">События — заполняются автоматически из «Мероприятий»</p>
            </div>
          </div>
          <div className="flex items-start gap-2 flex-1">
            <Globe size={18} className="mt-0.5 text-amber-500 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-gray-800">🌐 Экосистема ← настраивается здесь</p>
              <p className="text-xs text-gray-500 mt-0.5">Бренд + основатель + продукты, которые продвигаете</p>
            </div>
          </div>
        </div>
      </div>

      {/* Табы */}
      <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-xl max-w-2xl">
        <TabBtn active={tab === 'brand'}    onClick={() => setTab('brand')}    icon={<Building2 size={15} />} label="Бренд" />
        <TabBtn active={tab === 'owner'}    onClick={() => setTab('owner')}    icon={<User size={15} />}      label="Основатель" />
        <TabBtn active={tab === 'products'} onClick={() => setTab('products')} icon={<Globe size={15} />}     label="Продукты" />
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
                       placeholder="iVISION"
                       className="input" maxLength={60} />
              </Field>

              <Field label="Позиционирование бренда"
                     hint="Одна короткая строка под названием — что вы делаете. Пример: «Сообщество предпринимателей».">
                <input type="text" value={profile.positioning || ''}
                       onChange={e => update('positioning', e.target.value)}
                       placeholder="Сообщество предпринимателей"
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
              <Field label="Имя основателя" hint="Будет показано на карточке-тизере и на странице «Об основателе».">
                <input type="text" value={profile.owner_name || ''}
                       onChange={e => update('owner_name', e.target.value)}
                       placeholder="Маргарита Владимировна"
                       className="input" maxLength={80} />
              </Field>

              <Field label="Имя из регистрации (нередактируемо)"
                     hint="Это техническое имя для входа в кабинет. Если хотите изменить — напишите в Тех.поддержку.">
                <input type="text" value={profile.name} disabled
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
                     hint="Одна строка о роли. Пример: «Эксперт по личному бренду и реферальному маркетингу».">
                <input type="text" value={profile.owner_positioning || ''}
                       onChange={e => update('owner_positioning', e.target.value)}
                       placeholder="Эксперт по личному бренду…"
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
            title="Соцсети основателя"
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
                </div>
              ))}
            </div>
          </Section>
        </>
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
                <SubBlock title="💼 Платно" items={offerings.filter(o => o.is_paid)} onEdit={setEditing} onDelete={deleteOffering} />
              )}
              {offerings.filter(o => !o.is_paid).length > 0 && (
                <SubBlock title="📄 Бесплатно" items={offerings.filter(o => !o.is_paid)} onEdit={setEditing} onDelete={deleteOffering} />
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
              {savedAt ? '✓ Сохранено — изменения уже видны в Mini App' : (tab === 'brand' ? 'Настройки бренда' : 'Настройки основателя')}
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
  // Чтобы не закрывать окно когда пользователь начал выделение текста внутри
  // и отпустил мышь снаружи (браузер считает это кликом по бэкдропу).
  const [downOnBackdrop, setDownOnBackdrop] = useState(false)

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
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
         onMouseDown={e => setDownOnBackdrop(e.target === e.currentTarget)}
         onMouseUp={e => {
           const wasOnBackdrop = downOnBackdrop
           setDownOnBackdrop(false)
           if (wasOnBackdrop && e.target === e.currentTarget) attemptClose()
         }}>
      <form onSubmit={save}
            className="bg-white rounded-xl max-w-md w-full p-6"
            onMouseDown={e => e.stopPropagation()}
            onMouseUp={e => e.stopPropagation()}>
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
