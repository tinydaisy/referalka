'use client'
import { useState, useEffect } from 'react'
import { Gift, Plus, Pencil, Trash2, ExternalLink, X, Copy, Check, Package, FileText, BarChart3, AlertTriangle, Users } from 'lucide-react'
import { api } from '@/lib/api'

type Tab = 'magnets' | 'packages' | 'template'

const PEACH = '#FFCFA4'
const DARK = '#25455D'

interface LeadMagnet {
  id: number
  name: string
  description: string | null
  url: string
  slug: string
  created_at: string
  updated_at: string
}

interface PackageItem {
  lead_magnet_id: number
  sort_order: number
  name: string
  url: string
  slug: string
}

interface Package {
  id: number
  name: string
  description: string | null
  slug: string
  items: PackageItem[]
  created_at: string
  updated_at: string
}

function getPublicBase() {
  if (typeof window === 'undefined') return 'https://pluson.ru'
  return window.location.origin.replace(/^http:\/\/localhost:3000/, 'https://dev.pluson.ru')
}

export default function LeadMagnetsPage() {
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'magnets'
    const t = new URLSearchParams(window.location.search).get('tab')
    return (t === 'packages' || t === 'template') ? t as Tab : 'magnets'
  })
  const [tgChannel, setTgChannel] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    api.miniApp.profile.get()
      .then((p: any) => setTgChannel((p?.social_links || {}).telegram || null))
      .catch(() => setTgChannel(null))
  }, [])

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: DARK }}>
          <Gift size={24} /> Лид-магниты
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Общая база материалов клиента + воронка их выдачи через бот.
        </p>
      </div>

      {tgChannel === null && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle className="text-amber-600 shrink-0 mt-0.5" size={20} />
          <div className="flex-1 text-sm">
            <div className="font-semibold text-amber-900 mb-1">Канал подписки не настроен</div>
            <div className="text-amber-800">
              Без канала бот не сможет проверить подписку — материалы по воронке выдаваться не будут.
              Укажите ссылку на ваш Telegram-канал в визитке основателя.
            </div>
            <a
              href="/dashboard/mini-app?tab=owner"
              className="inline-flex items-center gap-1 mt-2 text-sm font-medium underline text-amber-900 hover:text-amber-700"
            >
              Настроить канал →
            </a>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200 overflow-x-auto">
        {[
          { id: 'magnets', label: 'Лид-магниты', icon: FileText },
          { id: 'packages', label: 'Пакеты', icon: Package },
          { id: 'template', label: 'Шаблон воронки', icon: Pencil },
        ].map(({ id, label, icon: Icon }) => {
          const active = tab === (id as Tab)
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id as Tab)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
                active ? 'border-[#25455D] text-[#25455D]' : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              <Icon size={16} /> {label}
            </button>
          )
        })}
      </div>

      {tab === 'magnets' && <MagnetsList />}
      {tab === 'packages' && <PackagesList />}
      {tab === 'template' && <TemplateEditor />}
    </div>
  )
}

// ============== Лид-магниты ==============

interface CountRow { id: number; landed: number; started: number; delivered: number }

function LandedCounter({ count, href }: { count: number; href: string }) {
  return (
    <a href={href}
       title={count > 0 ? 'Перейти к контактам, зашедшим по ссылке' : 'Никто ещё не переходил'}
       className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
         count > 0
           ? 'bg-[#FFCFA4] text-[#25455D] hover:opacity-80'
           : 'bg-gray-100 text-gray-400 pointer-events-none'
       }`}
       onClick={(e) => { if (count === 0) e.preventDefault() }}
    >
      <Users size={12} /> {count}
    </a>
  )
}

function MagnetsList() {
  const [items, setItems] = useState<LeadMagnet[]>([])
  const [counts, setCounts] = useState<Record<number, CountRow>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<LeadMagnet | null>(null)
  const [creating, setCreating] = useState(false)
  const [analyticsOpen, setAnalyticsOpen] = useState<LeadMagnet | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [res, cnt] = await Promise.all([
        api.leadMagnets.list(),
        api.leadMagnets.counts().catch(() => ({ items: [] })),
      ])
      setItems(res.items || [])
      const map: Record<number, CountRow> = {}
      for (const c of (cnt.items || []) as CountRow[]) map[c.id] = c
      setCounts(map)
      setError(null)
    } catch (e: any) {
      setError(e.message || 'Не получилось загрузить')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function handleDelete(id: number) {
    if (!confirm('Удалить лид-магнит? Связанные пороги в реф-программах останутся, но без подарка.')) return
    try { await api.leadMagnets.delete(id); await load() }
    catch (e: any) { alert(e.message || 'Ошибка удаления') }
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium"
          style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
        >
          <Plus size={18} /> Добавить
        </button>
      </div>

      {error && <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">{error}</div>}

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        <EmptyState icon={Gift} text="У вас пока нет лид-магнитов" onCreate={() => setCreating(true)} />
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y">
          {items.map(lm => (
            <div key={lm.id} className="p-4 flex items-start gap-3 hover:bg-gray-50">
              <div className="mt-1 w-9 h-9 rounded-lg flex items-center justify-center text-white"
                   style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                <Gift size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900">{lm.name}</div>
                <a href={lm.url} target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-1 text-xs mt-1 text-gray-400 hover:underline truncate">
                  <ExternalLink size={12} />
                  <span className="truncate">{lm.url}</span>
                </a>
                <div className="mt-2">
                  <ShareLink kind="m" slug={lm.slug} />
                </div>
              </div>
              <div className="flex gap-1 items-center">
                <LandedCounter
                  count={counts[lm.id]?.landed || 0}
                  href={`/dashboard/clients?lead_magnet_ids=${lm.id}`}
                />
                <button onClick={() => setAnalyticsOpen(lm)} title="Аналитика"
                        className="p-2 rounded text-gray-400 hover:text-[#25455D] hover:bg-gray-100">
                  <BarChart3 size={16} />
                </button>
                <button onClick={() => setEditing(lm)} title="Редактировать"
                        className="p-2 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                  <Pencil size={16} />
                </button>
                <button onClick={() => handleDelete(lm.id)} title="Удалить"
                        className="p-2 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <LeadMagnetForm
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}
      {analyticsOpen && (
        <AnalyticsModal
          kind="m"
          item={analyticsOpen}
          onClose={() => setAnalyticsOpen(null)}
        />
      )}
    </div>
  )
}

function LeadMagnetForm({ initial, onClose, onSaved }: {
  initial: LeadMagnet | null; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [url, setUrl] = useState(initial?.url || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!name.trim() || !url.trim()) { setErr('Название и ссылка обязательны'); return }
    setSaving(true)
    try {
      const payload = { name: name.trim(), description: null, url: url.trim() }
      if (initial) await api.leadMagnets.update(initial.id, payload)
      else await api.leadMagnets.create(payload)
      onSaved()
    } catch (e: any) { setErr(e.message || 'Ошибка сохранения'); setSaving(false) }
  }

  return (
    <Modal title={initial ? 'Редактировать лид-магнит' : 'Новый лид-магнит'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Название *">
          <input type="text" value={name} onChange={e => setName(e.target.value)}
                 className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                 placeholder="Чек-лист по продажам" autoFocus />
        </Field>
        <Field label="Ссылка *">
          <input type="url" value={url} onChange={e => setUrl(e.target.value)}
                 className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                 placeholder="https://example.com/file.pdf" />
        </Field>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <FormActions saving={saving} onClose={onClose} />
      </form>
    </Modal>
  )
}

// ============== Пакеты ==============

function PackagesList() {
  const [items, setItems] = useState<Package[]>([])
  const [magnets, setMagnets] = useState<LeadMagnet[]>([])
  const [counts, setCounts] = useState<Record<number, CountRow>>({})
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Package | null>(null)
  const [creating, setCreating] = useState(false)
  const [analyticsOpen, setAnalyticsOpen] = useState<Package | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [pkgs, lms, cnt] = await Promise.all([
        api.leadMagnetPackages.list(),
        api.leadMagnets.list(),
        api.leadMagnetPackages.counts().catch(() => ({ items: [] })),
      ])
      setItems(pkgs.items || [])
      setMagnets(lms.items || [])
      const map: Record<number, CountRow> = {}
      for (const c of (cnt.items || []) as CountRow[]) map[c.id] = c
      setCounts(map)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function handleDelete(id: number) {
    if (!confirm('Удалить пакет? Сами лид-магниты останутся.')) return
    try { await api.leadMagnetPackages.delete(id); await load() }
    catch (e: any) { alert(e.message || 'Ошибка удаления') }
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => setCreating(true)}
          disabled={magnets.length === 0}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium disabled:opacity-50"
          style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
          title={magnets.length === 0 ? 'Сначала создайте хотя бы один лид-магнит' : ''}
        >
          <Plus size={18} /> Создать пакет
        </button>
      </div>

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        <EmptyState icon={Package} text="У вас пока нет пакетов" onCreate={() => setCreating(true)} />
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y">
          {items.map(pkg => (
            <div key={pkg.id} className="p-4 flex items-start gap-3 hover:bg-gray-50">
              <div className="mt-1 w-9 h-9 rounded-lg flex items-center justify-center text-white"
                   style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                <Package size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900">{pkg.name}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {pkg.items.length} {plural(pkg.items.length, 'материал', 'материала', 'материалов')}
                </div>
                {pkg.items.length > 0 && (
                  <ul className="mt-2 text-xs text-gray-600 list-decimal pl-5 space-y-0.5">
                    {pkg.items.slice(0, 5).map(i => <li key={i.lead_magnet_id}>{i.name}</li>)}
                    {pkg.items.length > 5 && <li className="text-gray-400">…ещё {pkg.items.length - 5}</li>}
                  </ul>
                )}
                <div className="mt-2">
                  <ShareLink kind="p" slug={pkg.slug} />
                </div>
              </div>
              <div className="flex gap-1 items-center">
                <LandedCounter
                  count={counts[pkg.id]?.landed || 0}
                  href={`/dashboard/clients?package_ids=${pkg.id}`}
                />
                <button onClick={() => setAnalyticsOpen(pkg)} title="Аналитика"
                        className="p-2 rounded text-gray-400 hover:text-[#25455D] hover:bg-gray-100">
                  <BarChart3 size={16} />
                </button>
                <button onClick={() => setEditing(pkg)} title="Редактировать"
                        className="p-2 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100">
                  <Pencil size={16} />
                </button>
                <button onClick={() => handleDelete(pkg.id)} title="Удалить"
                        className="p-2 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <PackageForm
          initial={editing}
          magnets={magnets}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}
      {analyticsOpen && (
        <AnalyticsModal kind="p" item={analyticsOpen} onClose={() => setAnalyticsOpen(null)} />
      )}
    </div>
  )
}

function PackageForm({ initial, magnets, onClose, onSaved }: {
  initial: Package | null; magnets: LeadMagnet[]; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [selected, setSelected] = useState<number[]>(
    initial ? initial.items.sort((a, b) => a.sort_order - b.sort_order).map(i => i.lead_magnet_id) : []
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function toggle(id: number) {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  }
  function move(idx: number, dir: -1 | 1) {
    setSelected(s => {
      const next = idx + dir
      if (next < 0 || next >= s.length) return s
      const out = [...s]
      const tmp = out[idx]; out[idx] = out[next]; out[next] = tmp
      return out
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!name.trim()) { setErr('Название обязательно'); return }
    if (selected.length === 0) { setErr('Выберите хотя бы один лид-магнит'); return }
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        items: selected.map((id, i) => ({ lead_magnet_id: id, sort_order: i })),
      }
      if (initial) await api.leadMagnetPackages.update(initial.id, payload)
      else await api.leadMagnetPackages.create(payload)
      onSaved()
    } catch (e: any) { setErr(e.message || 'Ошибка сохранения'); setSaving(false) }
  }

  return (
    <Modal title={initial ? 'Редактировать пакет' : 'Новый пакет'} onClose={onClose} large>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Название пакета *">
          <input type="text" value={name} onChange={e => setName(e.target.value)}
                 className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                 placeholder="Стартовый набор для предпринимателя" autoFocus />
        </Field>
        <Field label="Описание (необязательно)">
          <textarea value={description} onChange={e => setDescription(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </Field>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Лид-магниты в пакете * <span className="text-gray-400 text-xs">({selected.length} выбрано)</span>
          </label>

          {/* Selected (orderable) */}
          {selected.length > 0 && (
            <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg p-2 space-y-1">
              {selected.map((id, idx) => {
                const m = magnets.find(x => x.id === id)
                if (!m) return null
                return (
                  <div key={id} className="flex items-center gap-2 bg-white rounded p-2 text-sm">
                    <span className="text-xs text-gray-500 w-5">{idx + 1}.</span>
                    <span className="flex-1 truncate">{m.name}</span>
                    <button type="button" onClick={() => move(idx, -1)} disabled={idx === 0}
                            className="text-xs px-2 py-0.5 rounded hover:bg-gray-100 disabled:opacity-30">↑</button>
                    <button type="button" onClick={() => move(idx, 1)} disabled={idx === selected.length - 1}
                            className="text-xs px-2 py-0.5 rounded hover:bg-gray-100 disabled:opacity-30">↓</button>
                    <button type="button" onClick={() => toggle(id)}
                            className="text-xs text-red-600 hover:bg-red-50 px-2 py-0.5 rounded">Убрать</button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Available */}
          <div className="border border-gray-200 rounded-lg max-h-60 overflow-y-auto">
            {magnets.filter(m => !selected.includes(m.id)).length === 0 && selected.length === magnets.length ? (
              <div className="p-4 text-center text-sm text-gray-400">Все лид-магниты добавлены</div>
            ) : magnets.length === 0 ? (
              <div className="p-4 text-center text-sm text-gray-400">У вас нет лид-магнитов. Создайте на вкладке «Лид-магниты».</div>
            ) : (
              magnets.filter(m => !selected.includes(m.id)).map(m => (
                <button key={m.id} type="button" onClick={() => toggle(m.id)}
                        className="w-full text-left p-3 hover:bg-gray-50 border-b border-gray-100 last:border-b-0 flex items-center gap-2">
                  <Plus size={14} className="text-gray-400" />
                  <span className="flex-1 text-sm truncate">{m.name}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {err && <div className="text-sm text-red-600">{err}</div>}
        <FormActions saving={saving} onClose={onClose} />
      </form>
    </Modal>
  )
}

// ============== Шаблон воронки ==============

function TemplateEditor() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try { setData(await api.funnelTemplates.get('lead_magnet')) }
    catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      await api.funnelTemplates.update('lead_magnet', {
        text_1: data.text_1,
        button_label: data.button_label,
        text_2: data.text_2,
        text_3_delivered: data.text_3_delivered,
        text_3_stuck: data.text_3_stuck,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e: any) { setErr(e.message) }
    finally { setSaving(false) }
  }

  if (loading) return <div className="text-gray-400 text-sm">Загрузка…</div>
  if (!data) return <div className="text-red-600 text-sm">{err || 'Ошибка загрузки'}</div>

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setData((d: any) => ({ ...d, [k]: e.target.value }))

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5 max-w-2xl">
      <div className="text-sm text-gray-600 bg-amber-50 border border-amber-100 rounded-lg p-3">
        Один шаблон на все лид-магниты и пакеты. Тексты можно править — создавать новые
        шаблоны пока нельзя. Доступные плейсхолдеры:
        <code className="block mt-1 font-mono text-xs">
          {'{materials_list}'} · {'{materials_with_links}'} · {'{client_brand_name}'} ·{' '}
          {'{client_owner_name}'} · {'{client_owner_achievements}'} · {'{subscription_channel}'} ·{' '}
          {'{owner_telegram}'}
        </code>
      </div>

      <Field label="Текст 1 — приветствие со списком подарков">
        <textarea value={data.text_1 || ''} onChange={set('text_1')} rows={8}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm" />
      </Field>

      <Field label="Подпись на кнопке">
        <input type="text" value={data.button_label || ''} onChange={set('button_label')}
               className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
      </Field>

      <Field label="Текст 2 — после успешной проверки подписки (выдача материалов)">
        <textarea value={data.text_2 || ''} onChange={set('text_2')} rows={5}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm" />
      </Field>

      <Field label="Текст 3 — через 30 минут (получившим материалы)">
        <textarea value={data.text_3_delivered || ''} onChange={set('text_3_delivered')} rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm" />
      </Field>

      <Field label="Текст 3 — через 30 минут (зависшим на проверке подписки)">
        <textarea value={data.text_3_stuck || ''} onChange={set('text_3_stuck')} rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm" />
      </Field>

      {err && <div className="text-sm text-red-600">{err}</div>}

      <button onClick={save} disabled={saving}
              className="px-5 py-2.5 rounded-lg text-white font-medium disabled:opacity-50"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        {saving ? 'Сохраняем…' : saved ? 'Сохранено ✓' : 'Сохранить шаблон'}
      </button>
    </div>
  )
}

// ============== Аналитика ==============

function AnalyticsModal({ kind, item, onClose }: {
  kind: 'm' | 'p'; item: { id: number; name: string }; onClose: () => void
}) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'started' | 'delivered'>('all')

  useEffect(() => {
    const fn = kind === 'm' ? api.leadMagnets.analytics : api.leadMagnetPackages.analytics
    fn(item.id).then(setData).catch(e => alert(e.message)).finally(() => setLoading(false))
  }, [kind, item.id])

  const runs = (data?.runs || []).filter((r: any) => {
    if (filter === 'all') return true
    if (filter === 'started') return ['started', 'subscribed', 'delivered'].includes(r.stage)
    if (filter === 'delivered') return r.stage === 'delivered'
    return true
  })

  return (
    <Modal title={`Аналитика: ${item.name}`} onClose={onClose} large>
      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Counter label="Перешли по ссылке" value={data.counts.landed} active={filter === 'all'} onClick={() => setFilter('all')} />
            <Counter label="Запустили воронку" value={data.counts.started} active={filter === 'started'} onClick={() => setFilter('started')} />
            <Counter label="Получили материалы" value={data.counts.delivered} active={filter === 'delivered'} onClick={() => setFilter('delivered')} />
          </div>

          {runs.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-6">Нет данных</div>
          ) : (
            <div className="border border-gray-200 rounded-lg max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2">Дата</th>
                    <th className="text-left px-3 py-2">Кто</th>
                    <th className="text-left px-3 py-2">Этап</th>
                    <th className="text-left px-3 py-2">UTM</th>
                    <th className="text-left px-3 py-2">Привёл</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {runs.map((r: any) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-xs text-gray-500">{formatDt(r.landed_at)}</td>
                      <td className="px-3 py-2">
                        {r.contact_id ? (
                          <a href={`/dashboard/clients?contact=${r.contact_id}`} className="text-[#25455D] hover:underline">
                            {r.contact_username ? `@${r.contact_username}` : (r.contact_name || `#${r.contact_id}`)}
                          </a>
                        ) : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-3 py-2"><StageBadge stage={r.stage} /></td>
                      <td className="px-3 py-2 text-xs text-gray-500">{(r.utm && r.utm.utm_source) || '—'}</td>
                      <td className="px-3 py-2">
                        {r.referrer_contact_id ? (
                          <a href={`/dashboard/clients?contact=${r.referrer_contact_id}`} className="text-[#25455D] hover:underline text-xs">
                            {r.referrer_username ? `@${r.referrer_username}` : (r.referrer_name || `#${r.referrer_contact_id}`)}
                          </a>
                        ) : <span className="text-gray-400 text-xs">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function Counter({ label, value, active, onClick }: { label: string; value: number; active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick}
            className={`p-3 rounded-lg border text-left transition-colors ${
              active ? 'border-[#25455D] bg-[#25455D] text-white' : 'border-gray-200 bg-white hover:border-gray-300'
            }`}>
      <div className={`text-2xl font-bold ${active ? 'text-white' : 'text-[#25455D]'}`}>{value}</div>
      <div className={`text-xs mt-0.5 ${active ? 'text-white/80' : 'text-gray-500'}`}>{label}</div>
    </button>
  )
}

function StageBadge({ stage }: { stage: string }) {
  const map: Record<string, { label: string; color: string }> = {
    landed: { label: 'Перешёл', color: 'bg-gray-100 text-gray-600' },
    started: { label: 'Запустил', color: 'bg-blue-50 text-blue-700' },
    subscribed: { label: 'Подписан', color: 'bg-amber-50 text-amber-700' },
    delivered: { label: 'Получил', color: 'bg-green-50 text-green-700' },
  }
  const m = map[stage] || map.landed
  return <span className={`text-xs px-2 py-0.5 rounded ${m.color}`}>{m.label}</span>
}

// ============== Утилиты ==============

function ShareLink({ kind, slug }: { kind: 'm' | 'p'; slug: string }) {
  const [copied, setCopied] = useState(false)
  const url = `${getPublicBase()}/${kind}/${slug}`
  function copy() {
    navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="font-mono text-gray-500 truncate">{url}</span>
      <button type="button" onClick={copy} className="p-1 rounded hover:bg-gray-100" title="Скопировать">
        {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} className="text-gray-400" />}
      </button>
    </div>
  )
}

function EmptyState({ icon: Icon, text, onCreate }: { icon: any; text: string; onCreate: () => void }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
      <Icon className="mx-auto mb-3 text-gray-300" size={40} />
      <p className="text-gray-500 text-sm mb-4">{text}</p>
      <button onClick={onCreate} className="text-sm underline" style={{ color: DARK }}>Создать первый</button>
    </div>
  )
}

function Modal({ title, onClose, children, large }: {
  title: string; onClose: () => void; children: React.ReactNode; large?: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className={`bg-white rounded-xl w-full p-6 max-h-[90vh] overflow-y-auto ${large ? 'max-w-2xl' : 'max-w-md'}`}
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold" style={{ color: DARK }}>{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  )
}

function FormActions({ saving, onClose }: { saving: boolean; onClose: () => void }) {
  return (
    <div className="flex gap-2 justify-end pt-2">
      <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Отмена</button>
      <button type="submit" disabled={saving}
              className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        {saving ? 'Сохраняю…' : 'Сохранить'}
      </button>
    </div>
  )
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

function formatDt(v: string) {
  if (!v) return ''
  const d = new Date(v)
  return d.toLocaleString('ru', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}
