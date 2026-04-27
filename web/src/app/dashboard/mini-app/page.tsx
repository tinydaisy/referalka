'use client'
/**
 * Настройка Mini App — что видят участники в Telegram.
 *
 * Две вкладки:
 *   - «Визитка» (clients.bio/photo/positioning/achievements/social_links) → шапка вкладки «Экосистема» в Mini App
 *   - «Продукты» (client_offerings) → блоки «Платно» и «Бесплатно» во вкладке «Экосистема»
 */
import { useEffect, useState } from 'react'
import { Smartphone, Plus, Pencil, Trash2, X, Save, Eye, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

const BRAND = '#25455D'
const GRADIENT = 'linear-gradient(45deg, #25455D, #0a1520)'

type Tab = 'profile' | 'offerings'

interface Achievement { label: string; value: string }
interface Profile {
  id: number
  name: string
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
  const [tab, setTab] = useState<Tab>('profile')

  return (
    <div>
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg text-white" style={{ background: GRADIENT }}>
            <Smartphone size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: BRAND }}>
              Настройка Mini App
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Что видят ваши участники, когда открывают Telegram Mini App
            </p>
          </div>
        </div>
        <a
          href="/tg/" target="_blank" rel="noreferrer"
          className="flex items-center gap-2 text-sm border border-gray-300 hover:border-gray-400 rounded-lg px-3 py-2 text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <Eye size={15} /> Превью
        </a>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 mb-6">
        {([
          { id: 'profile',   label: 'Визитка'  },
          { id: 'offerings', label: 'Продукты' },
        ] as { id: Tab; label: string }[]).map(t => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active ? '' : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
              style={active ? { color: BRAND, borderColor: '#FFCFA4' } : undefined}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'profile'   && <ProfileSection />}
      {tab === 'offerings' && <OfferingsSection />}
    </div>
  )
}

// ════════════════════════════════════════════
// ВКЛАДКА «Визитка»
// ════════════════════════════════════════════
function ProfileSection() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    api.miniApp.profile.get().then(setProfile).catch(() => {})
  }, [])

  if (!profile) {
    return <p className="text-gray-400 text-sm">Загрузка…</p>
  }

  function update<K extends keyof Profile>(key: K, value: Profile[K]) {
    setProfile(p => p ? { ...p, [key]: value } : p)
  }

  function updateSocial(key: string, value: string) {
    if (!profile) return
    const next = { ...profile.social_links }
    if (value.trim()) next[key] = value.trim()
    else delete next[key]
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

  async function save() {
    if (!profile) return
    setSaving(true)
    try {
      const ach = profile.achievements.filter(a => a.label.trim() && a.value.trim())
      const updated = await api.miniApp.profile.update({
        bio:               profile.bio || null,
        profile_photo_url: profile.profile_photo_url || null,
        positioning:       profile.positioning || null,
        achievements:      ach,
        social_links:      profile.social_links,
      })
      setProfile(p => p ? { ...p, ...updated } : updated)
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(null), 2000)
    } catch (e: any) {
      alert(e.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Photo + name + position + bio */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h2 className="font-semibold" style={{ color: BRAND }}>Шапка визитки</h2>

        <div>
          <label className="label">Ссылка на фото</label>
          <input
            type="url"
            value={profile.profile_photo_url || ''}
            onChange={e => update('profile_photo_url', e.target.value)}
            placeholder="https://..."
            className="input"
          />
          {profile.profile_photo_url && (
            <img src={profile.profile_photo_url} alt=""
                 className="mt-3 w-24 h-24 rounded-full object-cover border-2"
                 style={{ borderColor: '#FFCFA4' }}
                 onError={e => (e.currentTarget.style.display = 'none')} />
          )}
          <p className="text-gray-400 text-xs mt-1.5">
            Можно загрузить через «Лид-магниты» / «Афиши» и скопировать ссылку.
          </p>
        </div>

        <div>
          <label className="label">Имя</label>
          <input type="text" value={profile.name} disabled
                 className="input opacity-60 cursor-not-allowed" />
          <p className="text-gray-400 text-xs mt-1.5">Имя редактируется в «Настройках» аккаунта</p>
        </div>

        <div>
          <label className="label">Позиционирование (одна строка)</label>
          <input
            type="text"
            value={profile.positioning || ''}
            onChange={e => update('positioning', e.target.value)}
            placeholder="Эксперт по личному бренду и продажам"
            className="input"
            maxLength={120}
          />
        </div>

        <div>
          <label className="label">Биография</label>
          <textarea
            value={profile.bio || ''}
            onChange={e => update('bio', e.target.value)}
            placeholder="Кратко расскажите о себе и о том, чем занимаетесь..."
            className="input min-h-[120px]"
          />
        </div>
      </div>

      {/* Achievements */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold" style={{ color: BRAND }}>Регалии</h2>
          <button onClick={addAchievement}
                  className="text-sm flex items-center gap-1"
                  style={{ color: BRAND }}>
            <Plus size={15} /> Добавить
          </button>
        </div>
        <p className="text-gray-500 text-xs">Краткие цифры для шапки. Например: «1500+» / «учеников».</p>

        {profile.achievements.map((a, i) => (
          <div key={i} className="flex gap-2 items-start">
            <input type="text" value={a.value}
                   onChange={e => updateAchievement(i, 'value', e.target.value)}
                   placeholder="1500+" className="input w-28" />
            <input type="text" value={a.label}
                   onChange={e => updateAchievement(i, 'label', e.target.value)}
                   placeholder="учеников" className="input flex-1" />
            <button onClick={() => removeAchievement(i)}
                    className="p-2 text-gray-400 hover:text-red-600"
                    title="Удалить">
              <Trash2 size={16} />
            </button>
          </div>
        ))}

        {profile.achievements.length === 0 && (
          <p className="text-gray-400 text-sm">Пока нет регалий — добавьте до 3-х значимых.</p>
        )}
      </div>

      {/* Socials */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
        <h2 className="font-semibold" style={{ color: BRAND }}>Соцсети и сайт</h2>

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

      {/* Save bar */}
      <div className="sticky bottom-4 bg-white border border-gray-200 rounded-xl shadow-md p-3 flex items-center justify-between gap-3">
        <p className="text-gray-600 text-sm">
          {savedAt ? '✓ Сохранено' : 'Изменения появятся в Mini App сразу после сохранения'}
        </p>
        <button onClick={save} disabled={saving}
                className="flex items-center gap-2 px-4 py-2 rounded-lg btn-gold disabled:opacity-60">
          <Save size={16} />
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════
// ВКЛАДКА «Продукты»
// ════════════════════════════════════════════
function OfferingsSection() {
  const [items, setItems] = useState<Offering[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Offering | null>(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const r = await api.miniApp.offerings.list()
      setItems(r.items || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleDelete(id: number) {
    if (!confirm('Удалить продукт? Он сразу пропадёт из Mini App.')) return
    try {
      await api.miniApp.offerings.delete(id)
      await load()
    } catch (e: any) {
      alert(e.message || 'Ошибка удаления')
    }
  }

  const paid = items.filter(i => i.is_paid)
  const free = items.filter(i => !i.is_paid)

  return (
    <div className="max-w-2xl">
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <p className="text-gray-600 text-sm">
          Карточки во вкладке «Экосистема» в Mini App. Делятся на «Платно» и «Бесплатно».
        </p>
        <button onClick={() => setCreating(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium whitespace-nowrap"
                style={{ background: GRADIENT }}>
          <Plus size={16} /> Добавить
        </button>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">Загрузка…</p>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <Smartphone className="mx-auto mb-3 text-gray-300" size={40} />
          <p className="text-gray-500 text-sm mb-4">Пока нет продуктов</p>
          <button onClick={() => setCreating(true)}
                  className="text-sm underline" style={{ color: BRAND }}>
            Создать первый
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {paid.length > 0 && <Block title="💼 Платно"    items={paid} onEdit={setEditing} onDelete={handleDelete} />}
          {free.length > 0 && <Block title="📄 Бесплатно" items={free} onEdit={setEditing} onDelete={handleDelete} />}
        </div>
      )}

      {(creating || editing) && (
        <OfferingModal
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={async () => { setCreating(false); setEditing(null); await load() }}
        />
      )}
    </div>
  )
}

function Block({
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
            <label className="label">Ссылка (куда ведёт кнопка)</label>
            <input type="url" value={url} onChange={e => setUrl(e.target.value)}
                   className="input" placeholder="https://..." />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setIsPaid(true)}
                    className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      isPaid ? 'bg-amber-50 border-amber-300 text-amber-800' : 'border-gray-300 text-gray-500'
                    }`}>
              💼 Платно
            </button>
            <button type="button" onClick={() => setIsPaid(false)}
                    className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      !isPaid ? 'bg-green-50 border-green-300 text-green-700' : 'border-gray-300 text-gray-500'
                    }`}>
              📄 Бесплатно
            </button>
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
