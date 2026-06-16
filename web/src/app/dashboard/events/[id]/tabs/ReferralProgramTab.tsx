'use client'
import { useState, useEffect } from 'react'
import { Gift, Plus, Trash2, ImageIcon, Type, ExternalLink, Download, X, Save } from 'lucide-react'
import { api } from '@/lib/api'
import FileUploader from '@/components/FileUploader'

type SubTab = 'gifts' | 'materials'

export default function ReferralProgramTab({ eventId, moduleSlug }: { eventId: number; moduleSlug?: string }) {
  const [sub, setSub] = useState<SubTab>('gifts')
  const [showImport, setShowImport] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const subTabs: { key: SubTab; label: string; icon: any }[] = [
    { key: 'gifts',     label: 'Подарки',   icon: Gift },
    { key: 'materials', label: 'Материалы', icon: ImageIcon },
  ]

  return (
    <div>
      {/* Активация вкладки «Игра» в Mini App */}
      <ReferralEnabledToggle eventId={eventId} />

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

      {sub === 'gifts'     && <GiftsSection     key={`g-${reloadKey}`} eventId={eventId} moduleSlug={moduleSlug} />}
      {sub === 'materials' && <MaterialsSection key={`m-${reloadKey}`} eventId={eventId} />}

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


function ReferralEnabledToggle({ eventId }: { eventId: number }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const settingsRef = { current: null as any }

  useEffect(() => {
    api.referralProgram.settings.get(eventId)
      .then((d: any) => { settingsRef.current = d; setEnabled(!!d?.is_enabled) })
      .catch(() => setEnabled(false))
  }, [eventId])

  async function toggle() {
    if (enabled === null) return
    const next = !enabled
    setSaving(true); setErr(null)
    try {
      const cur = settingsRef.current || {}
      await api.referralProgram.settings.save(eventId, {
        gift_count_mode: cur.gift_count_mode ?? 'registered',
        is_enabled:      next,
      })
      setEnabled(next)
    } catch (e: any) {
      setErr(e?.message || 'Не получилось сохранить')
    } finally {
      setSaving(false)
    }
  }

  if (enabled === null) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-5 text-sm text-gray-400">
        Загружаем…
      </div>
    )
  }

  return (
    <div className={`rounded-xl p-4 mb-5 border ${
      enabled ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'
    }`}>
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          disabled={saving}
          aria-label="Переключить активность"
          className={`relative w-12 h-7 rounded-full transition flex-shrink-0 ${
            enabled ? 'bg-green-600' : 'bg-gray-300'
          } disabled:opacity-50`}>
          <span className={`absolute top-1 left-1 w-5 h-5 bg-white rounded-full transition shadow ${
            enabled ? 'translate-x-5' : ''
          }`} />
        </button>
        <div className="flex-1">
          <div className="text-sm font-semibold text-gray-800">
            {enabled ? 'Реф-программа активна' : 'Реф-программа выключена'}
          </div>
          <div className="text-xs text-gray-600 mt-0.5">
            {enabled
              ? 'Участники видят вкладку «🎯 Подарки» в Mini App — партнёрская ссылка, прогресс, подарки.'
              : 'Включите чтобы вкладка «🎯 Подарки» появилась в Mini App у участников события.'}
          </div>
          {err && <div className="text-xs text-red-600 mt-1">{err}</div>}
        </div>
      </div>
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
      `ВНИМАНИЕ: текущие подарки, картинки и тексты этого события будут заменены!`
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

function GiftsSection({ eventId, moduleSlug }: { eventId: number; moduleSlug?: string }) {
  const [items, setItems] = useState<any[]>([])
  const [leadMagnets, setLeadMagnets] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<any>(null)
  const [creating, setCreating] = useState(false)
  // Коллаб-событие (несколько организаторов) — показываем «чей подарок».
  // У обычного события пометки нет. Участнику в Mini App пометка тоже не видна.
  const [isCollab, setIsCollab] = useState(false)

  async function load() {
    setLoading(true)
    // api.leadMagnets.list() отдаёт лид-магниты ТЕКУЩЕГО клиента (по JWT) — значит
    // каждый организатор в форме «Добавить» видит только свои. Фильтр автоматический.
    const [r, lm] = await Promise.all([
      api.referralProgram.thresholds.list(eventId),
      api.leadMagnets.list(),
    ])
    setItems(r.items || [])
    setIsCollab(!!r.is_collab)
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
      {/* Логика подсчёта подарков */}
      <GiftCountModeBlock eventId={eventId} moduleSlug={moduleSlug} />

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
                {/* Чей подарок — только в коллаб-событии (для организаторов). В Mini App участник этого не видит. */}
                {isCollab && t.owner_name && (
                  <div className="inline-flex items-center mt-1 text-[11px] text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">
                    от: {t.owner_name}
                  </div>
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


type GiftMode = 'registered' | 'visited' | 'clicked_link'

function GiftCountModeBlock({ eventId, moduleSlug }: { eventId: number; moduleSlug?: string }) {
  const [mode, setMode] = useState<GiftMode | null>(null)
  const [enabled, setEnabled] = useState<boolean>(false)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Лейбл третьей опции зависит от типа события:
  //   contest → «За проголосовавших»; остальные → «За присутствовавших в эфире».
  const isContest = moduleSlug === 'contest'
  const clickedLabel = isContest ? 'За проголосовавших' : 'За присутствовавших в эфире'
  const clickedHint  = isContest
    ? 'Подарок выдаётся когда приведённый человек реально нажал «Перейти к голосованию» в Mini App.'
    : 'Подарок выдаётся когда приведённый человек реально нажал «Смотреть стрим» в Mini App в момент эфира.'

  useEffect(() => {
    api.referralProgram.settings.get(eventId)
      .then((d: any) => {
        const m: GiftMode =
          d.gift_count_mode === 'visited'      ? 'visited'      :
          d.gift_count_mode === 'clicked_link' ? 'clicked_link' :
          'registered'
        setMode(m)
        setEnabled(!!d.is_enabled)
      })
      .catch(() => setMode('registered'))
  }, [eventId])

  async function save(next: GiftMode) {
    setSaving(true); setErr(null)
    try {
      await api.referralProgram.settings.save(eventId, {
        gift_count_mode: next,
        is_enabled:      enabled,
      })
      setMode(next)
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1500)
    } catch (e: any) { setErr(e.message || 'Ошибка сохранения') }
    finally { setSaving(false) }
  }

  if (mode === null) {
    return <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm text-gray-400">Загружаем…</div>
  }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <div className="text-sm font-semibold text-gray-800">За что выдаются подарки участнику</div>
        {savedFlash && <span className="text-xs text-green-700">Сохранено ✓</span>}
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Mini App покажет это правило с жёлтым треугольником наверху окна подарков.
      </p>
      {/* Порядок — по убыванию «сложности» зачётного действия:
            1) clicked_link — самое строгое (реально нажал/проголосовал)
            2) registered  — средне (заполнил форму)
            3) visited     — самое мягкое (просто перешёл по ссылке) */}
      <div className="space-y-2">
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="radio" className="mt-1" name={`gcm-${eventId}`}
                 disabled={saving}
                 checked={mode === 'clicked_link'}
                 onChange={() => save('clicked_link')} />
          <div>
            <div className="text-sm font-medium">{clickedLabel}</div>
            <div className="text-xs text-gray-500">{clickedHint}</div>
          </div>
        </label>
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="radio" className="mt-1" name={`gcm-${eventId}`}
                 disabled={saving}
                 checked={mode === 'registered'}
                 onChange={() => save('registered')} />
          <div>
            <div className="text-sm font-medium">За зарегистрировавшихся (рекомендуется)</div>
            <div className="text-xs text-gray-500">Подарок выдаётся когда приведённый человек зарегистрировался на событие.</div>
          </div>
        </label>
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="radio" className="mt-1" name={`gcm-${eventId}`}
                 disabled={saving}
                 checked={mode === 'visited'}
                 onChange={() => save('visited')} />
          <div>
            <div className="text-sm font-medium">За переходы по ссылке</div>
            <div className="text-xs text-gray-500">Любой переход по партнёрской ссылке считается. Будут «накручивать», но проще запустить.</div>
          </div>
        </label>
      </div>
      {err && <div className="text-xs text-red-600 mt-2">{err}</div>}
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


// ─── Материалы (картинки + тексты) ────────────

function MaterialsSection({ eventId }: { eventId: number }) {
  return (
    <div className="space-y-8">
      <ShareTextsBlock eventId={eventId} />
      <ImagesBlock     eventId={eventId} />
    </div>
  )
}


// ─── Тексты-примеры ──────────────────────────

function ShareTextsBlock({ eventId }: { eventId: number }) {
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<any>(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true)
    const r = await api.referralProgram.shareTexts.list(eventId)
    setItems(r.items || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [eventId])

  async function handleDelete(id: number) {
    if (!confirm('Удалить текст?')) return
    await api.referralProgram.shareTexts.delete(eventId, id).catch((e: any) => alert(e.message))
    load()
  }

  return (
    <section>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <div>
          <h4 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
            <Type size={16} /> Тексты для шеринга
          </h4>
          <p className="text-xs text-gray-500 mt-0.5">
            Готовые тексты, которые участник копирует и отправляет друзьям. Реф-ссылка добавляется автоматически.
          </p>
        </div>
        <button onClick={() => setCreating(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <Plus size={16} /> Добавить текст
        </button>
      </div>

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <Type className="mx-auto mb-2 text-gray-300" size={28} />
          <p className="text-gray-500 text-sm">Текстов пока нет</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y">
          {items.map(t => (
            <div key={t.id} className="p-4 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-800 whitespace-pre-wrap line-clamp-4">{t.content}</div>
                <div className="text-xs text-gray-400 mt-1">Порядок: {t.sort}</div>
              </div>
              <div className="flex gap-1 shrink-0">
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
        <ShareTextForm
          eventId={eventId}
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}
    </section>
  )
}


// Список плейсхолдеров — один источник правды.
// При изменении — отрази те же коды в подстановке Mini App ([GameTab.tsx](mini-app/src/tabs/GameTab.tsx)).
const SHARE_PLACEHOLDERS: { code: string; label: string }[] = [
  { code: '{link}',  label: 'партнёрская ссылка участника' },
  { code: '{event}', label: 'название события' },
  { code: '{date}',  label: 'дата события (или диапазон для конференции)' },
  { code: '{name}',  label: 'имя участника (из Telegram)' },
  { code: '{brand}', label: 'название бренда клиента' },
]


function PlaceholdersHint({ onInsert }: { onInsert: (code: string) => void }) {
  return (
    <div className="mt-2 bg-blue-50 border border-blue-200 rounded-lg p-3">
      <div className="text-xs font-semibold text-blue-900 mb-2">
        Коды-вставки — подставятся автоматически в Mini App у участника:
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SHARE_PLACEHOLDERS.map(p => (
          <button key={p.code} type="button" onClick={() => onInsert(p.code)}
                  title={`Вставить ${p.code} — ${p.label}`}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-white border border-blue-200 rounded text-xs font-mono text-blue-800 hover:bg-blue-100">
            {p.code}
          </button>
        ))}
      </div>
      <div className="text-[11px] text-blue-700 mt-2 leading-snug">
        {SHARE_PLACEHOLDERS.map(p => (
          <div key={p.code}><code className="font-mono">{p.code}</code> — {p.label}</div>
        ))}
      </div>
    </div>
  )
}


function ShareTextForm({ eventId, initial, onClose, onSaved }: any) {
  const [content, setContent] = useState<string>(initial?.content ?? '')
  const [sort, setSort]       = useState<number>(initial?.sort ?? 0)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = content.trim()
    if (!trimmed) return setErr('Введите текст')
    setSaving(true); setErr(null)
    try {
      const payload = { content: trimmed, sort }
      if (initial) {
        await api.referralProgram.shareTexts.update(eventId, initial.id, payload)
      } else {
        await api.referralProgram.shareTexts.create(eventId, payload)
      }
      onSaved()
    } catch (e: any) { setErr(e.message); setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4" style={{ color: '#25455D' }}>
          {initial ? 'Изменить текст' : 'Новый текст для шеринга'}
        </h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Текст *</label>
            <textarea value={content}
                      rows={6}
                      onChange={e => setContent(e.target.value)}
                      placeholder="Зову на iVision-7 — главное событие года! Регистрируйся по моей ссылке: {link}"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      autoFocus />
            <PlaceholdersHint onInsert={(code) => setContent(c => c + (c && !c.endsWith(' ') && !c.endsWith('\n') ? ' ' : '') + code)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Порядок</label>
            <input type="number" value={sort}
                   onChange={e => setSort(parseInt(e.target.value) || 0)}
                   className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
            <p className="text-xs text-gray-400 mt-1">Меньше — выше в списке.</p>
          </div>
          {err && <div className="text-sm text-red-600">{err}</div>}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Отмена</button>
            <button type="submit" disabled={saving}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                    style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
              <Save size={14} />
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}


// ─── Картинки для шеринга ────────────────────

function ImagesBlock({ eventId }: { eventId: number }) {
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
    <section>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <div>
          <h4 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
            <ImageIcon size={16} /> Картинки и видео для шеринга
          </h4>
          <p className="text-xs text-gray-500 mt-0.5">
            Афиши и видео, которые участник копирует и шерит друзьям. Картинку можно выбрать из афиш события или загрузить свою, видео — загрузить файлом.
          </p>
        </div>
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
                {m.media_type === 'video' ? (
                  <video src={m.video_url} controls className="w-full h-full object-cover" />
                ) : (
                  <img src={m.image_url} alt="" className="w-full h-full object-cover" />
                )}
              </div>
              <div className="p-3 flex items-center justify-between">
                <span className="text-xs text-gray-500">
                  {m.media_type === 'video' ? 'Видео' : (m.source === 'event_poster' ? 'Из афиши' : 'Загружено')}
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
    </section>
  )
}


function MaterialForm({ eventId, posters, onClose, onSaved }: any) {
  const [mediaType, setMediaType] = useState<'image' | 'video'>('image')
  const [mode, setMode] = useState<'event_poster' | 'custom'>('custom')
  const [posterId, setPosterId] = useState<number | null>(posters[0]?.id || null)
  const [url, setUrl] = useState('')        // URL картинки
  const [videoUrl, setVideoUrl] = useState('')  // URL видео
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setErr(null)
    try {
      let payload: any
      if (mediaType === 'video') {
        if (!videoUrl.trim()) throw new Error('Загрузите видео')
        payload = { media_type: 'video', video_url: videoUrl.trim(), source: 'custom', source_poster_id: null, sort: 0 }
      } else if (mode === 'event_poster') {
        if (!posterId) throw new Error('Выберите афишу')
        const poster = posters.find((p: any) => p.id === posterId)
        payload = { media_type: 'image', image_url: poster.url, source: 'event_poster', source_poster_id: posterId, sort: 0 }
      } else {
        if (!url.trim()) throw new Error('Укажите URL')
        payload = { media_type: 'image', image_url: url.trim(), source: 'custom', source_poster_id: null, sort: 0 }
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
          {/* Тип материала */}
          <div className="flex gap-2">
            <button type="button" onClick={() => setMediaType('image')}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm border ${
                      mediaType === 'image' ? 'border-gray-900 bg-gray-50 font-medium' : 'border-gray-200 text-gray-500'
                    }`}>
              🖼 Картинка
            </button>
            <button type="button" onClick={() => setMediaType('video')}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm border ${
                      mediaType === 'video' ? 'border-gray-900 bg-gray-50 font-medium' : 'border-gray-200 text-gray-500'
                    }`}>
              🎬 Видео
            </button>
          </div>

          {mediaType === 'video' ? (
            <>
              <FileUploader
                mode="single"
                kind="referral_video"
                eventId={eventId}
                value={videoUrl || null}
                onChange={u => setVideoUrl(u || '')}
                accept="video/*"
                aspectClass="aspect-video"
                emptyText="Загрузите видео для шеринга (до 100 МБ, лучше MP4)"
                buttonLabel="Загрузить видео"
              />
              <p className="text-xs text-gray-400">Лимит 100 МБ. Лучше формат MP4 — он откроется на всех устройствах.</p>
            </>
          ) : (
            <>
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
                  Загрузить свою
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
            </>
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
