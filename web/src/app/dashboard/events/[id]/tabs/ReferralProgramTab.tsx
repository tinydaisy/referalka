'use client'
import { useState, useEffect } from 'react'
import { Gift, Plus, Trash2, ImageIcon, MessageSquare, Save, ExternalLink, Download, X } from 'lucide-react'
import { api } from '@/lib/api'
import FileUploader from '@/components/FileUploader'

type SubTab = 'gifts' | 'materials' | 'templates'

export default function ReferralProgramTab({ eventId }: { eventId: number }) {
  const [sub, setSub] = useState<SubTab>('gifts')
  const [showImport, setShowImport] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const subTabs: { key: SubTab; label: string; icon: any }[] = [
    { key: 'gifts',     label: 'Подарки',   icon: Gift },
    { key: 'materials', label: 'Материалы', icon: ImageIcon },
    { key: 'templates', label: 'Шаблоны',   icon: MessageSquare },
  ]

  return (
    <div>
      {/* Sub-tabs + import */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="inline-flex p-1 bg-gray-100 rounded-lg">
          {subTabs.map(({ key, label, icon: Icon }) => (
            <button key={key} onClick={() => setSub(key)}
                    className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-medium transition ${
                      sub === key
                        ? 'bg-white shadow-sm text-gray-900'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}>
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
        <button onClick={() => setShowImport(true)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm border border-gray-300 text-gray-700 hover:bg-gray-50">
          <Download size={14} /> Импортировать из другого события
        </button>
      </div>

      {sub === 'gifts'     && <GiftsSection     key={`g-${reloadKey}`} eventId={eventId} />}
      {sub === 'materials' && <MaterialsSection key={`m-${reloadKey}`} eventId={eventId} />}
      {sub === 'templates' && <TemplatesSection key={`t-${reloadKey}`} eventId={eventId} />}

      {showImport && (
        <ImportModal
          eventId={eventId}
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); setReloadKey(k => k + 1) }}
        />
      )}
    </div>
  )
}


function ImportModal({ eventId, onClose, onImported }: {
  eventId: number; onClose: () => void; onImported: () => void
}) {
  const [sources, setSources] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.referralProgram.importSources(eventId)
      .then((r: any) => setSources(r.items || []))
      .finally(() => setLoading(false))
  }, [eventId])

  async function handleImport(srcId: number, srcTitle: string) {
    if (!confirm(
      `Импортировать реф-программу из «${srcTitle}»?\n\n` +
      `ВНИМАНИЕ: текущие подарки, материалы и шаблоны этого события будут заменены!`
    )) return
    setImporting(srcId); setErr(null)
    try {
      await api.referralProgram.importFrom(eventId, srcId)
      onImported()
    } catch (e: any) {
      setErr(e.message || 'Ошибка импорта')
      setImporting(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-lg w-full p-6 max-h-[80vh] overflow-y-auto"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold" style={{ color: '#25455D' }}>
            Импорт реф-программы
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={20} /></button>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          Выберите событие/конференцию, реф-программу которой хотите скопировать сюда.
          Текущие настройки будут заменены.
        </p>

        {loading ? (
          <div className="text-gray-400 text-sm py-6 text-center">Загрузка…</div>
        ) : sources.length === 0 ? (
          <div className="text-gray-500 text-sm py-6 text-center">
            Нет других событий с настроенной реф-программой
          </div>
        ) : (
          <div className="border border-gray-200 rounded-lg divide-y">
            {sources.map((s: any) => (
              <div key={s.id} className="p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 truncate">{s.title}</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {s.module_slug === 'conference' ? 'Конференция' : 'Мероприятие'}
                    {' · '}
                    {s.thresholds_count} {s.thresholds_count === 1 ? 'порог' : 'порогов'}
                  </div>
                </div>
                <button onClick={() => handleImport(s.id, s.title)} disabled={importing !== null}
                        className="px-3 py-1.5 rounded-lg text-xs text-white font-medium disabled:opacity-50"
                        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                  {importing === s.id ? 'Импорт…' : 'Импортировать'}
                </button>
              </div>
            ))}
          </div>
        )}

        {err && <div className="mt-3 text-sm text-red-600">{err}</div>}
      </div>
    </div>
  )
}


// ─── Подарки ─────────────────────────────────

function GiftsSection({ eventId }: { eventId: number }) {
  const [items, setItems] = useState<any[]>([])
  const [leadMagnets, setLeadMagnets] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<any>(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true)
    const [r, lm] = await Promise.all([
      api.referralProgram.thresholds.list(eventId),
      api.leadMagnets.list(),
    ])
    setItems(r.items || [])
    setLeadMagnets(lm.items || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [eventId])

  async function handleDelete(id: number) {
    if (!confirm('Удалить порог?')) return
    await api.referralProgram.thresholds.delete(eventId, id).catch((e: any) => alert(e.message))
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-gray-500">
          Пороги-подарки: за сколько приведённых друзей и какой лид-магнит выдаётся.
        </p>
        <button onClick={() => setCreating(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <Plus size={16} /> Добавить порог
        </button>
      </div>

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <Gift className="mx-auto mb-3 text-gray-300" size={36} />
          <p className="text-gray-500 text-sm mb-2">Пороги ещё не настроены</p>
          {leadMagnets.length === 0 && (
            <p className="text-xs text-gray-400">
              Сначала добавьте лид-магниты в общей базе:{' '}
              <a href="/dashboard/lead-magnets" className="underline">Лид-магниты →</a>
            </p>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y">
          {items.map(t => (
            <div key={t.id} className="p-4 flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold shrink-0"
                   style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                {t.threshold_count}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-900">
                  {t.threshold_count === 0 ? (
                    <>Сразу при регистрации</>
                  ) : (
                    <>За <strong>{t.threshold_count}</strong>{' '}
                       {t.threshold_count === 1 ? 'друга' : 'друзей'}</>
                  )}
                </div>
                {t.lead_magnet_name ? (
                  <div className="text-sm text-gray-700 mt-0.5">🎁 {t.lead_magnet_name}</div>
                ) : (
                  <div className="text-xs text-orange-600 mt-0.5">⚠️ Лид-магнит не выбран</div>
                )}
                {t.gift_template_text && (
                  <div className="text-xs text-gray-500 mt-1 line-clamp-2">{t.gift_template_text}</div>
                )}
                {t.certificate_url && (
                  <a href={t.certificate_url} target="_blank" rel="noreferrer"
                     className="inline-flex items-center gap-1 text-xs text-gray-400 hover:underline mt-1">
                    <ExternalLink size={11} /> Сертификат
                  </a>
                )}
              </div>
              <div className="flex gap-1">
                <button onClick={() => setEditing(t)}
                        className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded">
                  Изменить
                </button>
                <button onClick={() => handleDelete(t.id)}
                        className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <ThresholdForm
          eventId={eventId}
          initial={editing}
          leadMagnets={leadMagnets}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}
    </div>
  )
}


function ThresholdForm({ eventId, initial, leadMagnets, onClose, onSaved }: any) {
  const [count, setCount] = useState(initial?.threshold_count ?? 0)
  const [leadMagnetId, setLeadMagnetId] = useState<number | null>(initial?.lead_magnet_id || null)
  const [certificateUrl, setCertificateUrl] = useState(initial?.certificate_url || '')
  const [giftText, setGiftText] = useState(initial?.gift_template_text || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (count < 0) return setErr('Количество не может быть отрицательным')
    setSaving(true); setErr(null)
    try {
      const payload = {
        threshold_count: count,
        lead_magnet_id: leadMagnetId,
        certificate_url: certificateUrl.trim() || null,
        gift_template_text: giftText.trim() || null,
        sort: count,
      }
      if (initial) {
        await api.referralProgram.thresholds.update(eventId, initial.id, payload)
      } else {
        await api.referralProgram.thresholds.create(eventId, payload)
      }
      onSaved()
    } catch (e: any) { setErr(e.message); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4" style={{ color: '#25455D' }}>
          {initial ? 'Изменить порог' : 'Новый порог'}
        </h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Количество приведённых *</label>
            <input type="number" min={0} value={count}
                   onChange={e => setCount(Math.max(0, parseInt(e.target.value) || 0))}
                   className="w-full px-3 py-2 border border-gray-300 rounded-lg" autoFocus />
            <p className="text-xs text-gray-400 mt-1">0 — подарок выдаётся сразу всем участникам, без условий</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Лид-магнит</label>
            <select value={leadMagnetId || ''}
                    onChange={e => setLeadMagnetId(e.target.value ? Number(e.target.value) : null)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg">
              <option value="">— не выбран —</option>
              {leadMagnets.map((lm: any) => (
                <option key={lm.id} value={lm.id}>{lm.name}</option>
              ))}
            </select>
            {leadMagnets.length === 0 && (
              <p className="text-xs text-gray-400 mt-1">
                <a href="/dashboard/lead-magnets" className="underline">Добавить лид-магнит →</a>
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Сертификат (опц.)</label>
            <FileUploader
              mode="single"
              kind="certificate"
              eventId={eventId}
              value={certificateUrl || null}
              onChange={u => setCertificateUrl(u || '')}
              accept="image/*"
              aspectClass="aspect-[4/3]"
              emptyText="Картинка сертификата за этот порог"
              buttonLabel="Загрузить"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Текст выдачи от бота</label>
            <textarea value={giftText} rows={3}
                      onChange={e => setGiftText(e.target.value)}
                      placeholder="Спасибо! Вот твой подарок: {{lead_magnet_url}}"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Отмена</button>
            <button type="submit" disabled={saving}
                    className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                    style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}


// ─── Материалы ───────────────────────────────

function MaterialsSection({ eventId }: { eventId: number }) {
  const [items, setItems] = useState<any[]>([])
  const [posters, setPosters] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)

  async function load() {
    setLoading(true)
    const [m, p] = await Promise.all([
      api.referralProgram.materials.list(eventId),
      api.referralProgram.posters.list(eventId),
    ])
    setItems(m.items || [])
    setPosters(p.items || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [eventId])

  async function handleDelete(id: number) {
    if (!confirm('Удалить материал?')) return
    await api.referralProgram.materials.delete(eventId, id).catch((e: any) => alert(e.message))
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-gray-500">
          Картинки которые участник копирует и шерит друзьям. Можно выбрать из афиш события или загрузить свои.
        </p>
        <button onClick={() => setShowForm(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <Plus size={16} /> Добавить
        </button>
      </div>

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <ImageIcon className="mx-auto mb-3 text-gray-300" size={36} />
          <p className="text-gray-500 text-sm">Материалов пока нет</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map(m => (
            <div key={m.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="aspect-video bg-gray-100">
                <img src={m.image_url} alt="" className="w-full h-full object-cover" />
              </div>
              <div className="p-3 flex items-center justify-between">
                <span className="text-xs text-gray-500">
                  {m.source === 'event_poster' ? 'Из афиши' : 'Загружено'}
                </span>
                <button onClick={() => handleDelete(m.id)}
                        className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <MaterialForm eventId={eventId} posters={posters}
                      onClose={() => setShowForm(false)}
                      onSaved={() => { setShowForm(false); load() }} />
      )}
    </div>
  )
}


function MaterialForm({ eventId, posters, onClose, onSaved }: any) {
  const [mode, setMode] = useState<'event_poster' | 'custom'>('custom')
  const [posterId, setPosterId] = useState<number | null>(posters[0]?.id || null)
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setErr(null)
    try {
      let payload: any
      if (mode === 'event_poster') {
        if (!posterId) throw new Error('Выберите афишу')
        const poster = posters.find((p: any) => p.id === posterId)
        payload = { image_url: poster.url, source: 'event_poster', source_poster_id: posterId, sort: 0 }
      } else {
        if (!url.trim()) throw new Error('Укажите URL')
        payload = { image_url: url.trim(), source: 'custom', source_poster_id: null, sort: 0 }
      }
      await api.referralProgram.materials.create(eventId, payload)
      onSaved()
    } catch (e: any) { setErr(e.message); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4" style={{ color: '#25455D' }}>Добавить материал</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex gap-2">
            <button type="button" onClick={() => setMode('event_poster')}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm border ${
                      mode === 'event_poster' ? 'border-gray-900 bg-gray-50 font-medium' : 'border-gray-200 text-gray-500'
                    }`}>
              Из афиш события
            </button>
            <button type="button" onClick={() => setMode('custom')}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm border ${
                      mode === 'custom' ? 'border-gray-900 bg-gray-50 font-medium' : 'border-gray-200 text-gray-500'
                    }`}>
              Загрузить URL
            </button>
          </div>

          {mode === 'event_poster' ? (
            posters.length === 0 ? (
              <p className="text-sm text-gray-400">Афиш ещё нет. Добавьте их во вкладке «Афиши».</p>
            ) : (
              <select value={posterId || ''} onChange={e => setPosterId(Number(e.target.value))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg">
                {posters.map((p: any) => (
                  <option key={p.id} value={p.id}>
                    Афиша #{p.id} ({p.orientation === 'horizontal' ? 'гориз.' : 'верт.'})
                  </option>
                ))}
              </select>
            )
          ) : (
            <FileUploader
              mode="single"
              kind="referral_material"
              eventId={eventId}
              value={url || null}
              onChange={u => setUrl(u || '')}
              accept="image/*"
              aspectClass="aspect-video"
              emptyText="Загрузите свою картинку для шеринга"
              buttonLabel="Загрузить"
            />
          )}

          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Отмена</button>
            <button type="submit" disabled={saving}
                    className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                    style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
              {saving ? 'Сохраняю…' : 'Добавить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}


// ─── Шаблоны ────────────────────────────────

function TemplatesSection({ eventId }: { eventId: number }) {
  const [welcomeText, setWelcomeText] = useState('')
  const [shareText, setShareText] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.referralProgram.settings.get(eventId)
      .then((d: any) => {
        setWelcomeText(d.welcome_text || '')
        setShareText(d.share_text || '')
      })
      .finally(() => setLoading(false))
  }, [eventId])

  async function handleSave() {
    setSaving(true); setErr(null)
    try {
      await api.referralProgram.settings.save(eventId, {
        welcome_text: welcomeText.trim() || null,
        share_text:   shareText.trim()   || null,
      })
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1800)
    } catch (e: any) { setErr(e.message) }
    finally { setSaving(false) }
  }

  if (loading) return <div className="text-gray-400 text-sm">Загрузка…</div>

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Текст приветствия от бота
        </label>
        <p className="text-xs text-gray-400 mb-2">
          Когда участник заходит впервые. Опиши что за реф-программа и какие подарки получит.
        </p>
        <textarea value={welcomeText} onChange={e => setWelcomeText(e.target.value)}
                  rows={5}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Привет! Зови друзей на iVision-7 и получай подарки:&#10;• 1 друг → Чек-лист&#10;• 3 друга → Гайд&#10;• 10 друзей → Курс" />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Текст-анонс для шеринга
        </label>
        <p className="text-xs text-gray-400 mb-2">
          Готовый текст, который участник копирует и отправляет друзьям. Реф-ссылка добавляется автоматически.
        </p>
        <textarea value={shareText} onChange={e => setShareText(e.target.value)}
                  rows={5}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Зову на iVision-7 — главное событие года! Регистрируйся по моей ссылке:" />
      </div>

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
    </div>
  )
}
