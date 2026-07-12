'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Users, Star, Save, Plus, X, Gift, Image as ImageIcon } from 'lucide-react'
import { api } from '@/lib/api'
import RefLinkInline from '@/components/RefLinkInline'

const PEACH = '#FFCFA4'
const DARK = '#25455D'

/**
 * Карточка ОРГАНИЗАТОРА коллаб-события — как карточка спикера в конференции:
 *   «Выступление» — тема, подарки, индивидуальная афиша
 *   «Ссылки»      — реф-ссылки ЧЕРЕЗ ЕГО БОТА
 *
 * ⚠️ Отличия от конференции:
 *  1. Подарки — ТОЛЬКО из ПЛЮСОНа (лид-магниты/пакеты своего кабинета), до 4.
 *     Задать «названием + ссылкой» вручную здесь НЕЛЬЗЯ (в конференции — можно).
 *  2. Редактировать можно ТОЛЬКО СВОЮ карточку. Чужая — просмотр.
 */
export default function CollabOrganizerCardPage() {
  const params = useParams()
  const router = useRouter()
  const eventId = Number(params?.id)
  const clientId = Number(params?.clientId)

  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<'talk' | 'links'>('talk')
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  // Форма (только для своей карточки)
  const [topics, setTopics] = useState<string[]>([''])
  const [gifts, setGifts] = useState<any[]>([])
  const [posterId, setPosterId] = useState<number | null>(null)
  // Каталог своих лид-магнитов/пакетов — для выбора подарков
  const [magnets, setMagnets] = useState<any[]>([])
  const [packages, setPackages] = useState<any[]>([])

  const load = async () => {
    try {
      const r: any = await api.collabHub.organizerCard(eventId, clientId)
      setData(r)
      setTopics(r.topics?.length ? r.topics.map((t: any) => t.topic) : [''])
      setGifts(r.gift_lead_magnets || [])
      setPosterId(r.organizer?.poster_id ?? null)
      if (r.can_edit) {
        // Подарки берутся ТОЛЬКО из ПЛЮСОНа — грузим свой каталог
        const [lm, lp]: any[] = await Promise.all([
          api.leadMagnets.list().catch(() => ({ lead_magnets: [] })),
          api.leadMagnetPackages.list().catch(() => ({ packages: [] })),
        ])
        setMagnets(lm.lead_magnets || lm.items || [])
        setPackages(lp.packages || lp.items || [])
      }
    } catch (e: any) {
      setErr(e?.message || 'Не удалось загрузить')
    }
  }
  useEffect(() => { load() }, [eventId, clientId])

  const save = async () => {
    setSaving(true)
    try {
      await api.collabHub.updateOrganizerCard(eventId, clientId, {
        topics: topics.map(t => t.trim()).filter(Boolean),
        gift_lead_magnets: gifts.map(g => ({ kind: g.kind, id: g.id })),
        poster_id: posterId,
      })
      await load()
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1800)
    } catch (e: any) {
      alert(e?.message || 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  const addGift = (kind: 'magnet' | 'package', id: number, name: string) => {
    if (gifts.length >= 4) { alert('Можно добавить не больше 4 подарков'); return }
    if (gifts.some(g => g.kind === kind && g.id === id)) return
    setGifts([...gifts, { kind, id, name }])
  }
  const removeGift = (i: number) => setGifts(gifts.filter((_, idx) => idx !== i))

  if (err) return <div className="p-8 max-w-3xl mx-auto text-gray-400 text-center">{err}</div>
  if (!data) return <div className="p-8 text-gray-400 text-center">Загрузка…</div>

  const o = data.organizer || {}
  const canEdit = !!data.can_edit
  const posters: any[] = data.posters || []

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <button onClick={() => router.push(`/dashboard/events/${eventId}?tab=collab_organizers`)}
        className="text-sm text-gray-500 inline-flex items-center gap-1 mb-4">
        <ArrowLeft className="w-4 h-4" />К организаторам
      </button>

      {/* Шапка */}
      <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-5">
        <div className="flex items-start gap-4">
          {o.photo_url
            ? <img src={o.photo_url} alt="" className="w-16 h-16 rounded-xl object-cover shrink-0" />
            : <div className="w-16 h-16 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 shrink-0"><Users className="w-6 h-6" /></div>}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold" style={{ color: DARK }}>{o.name}</h1>
              {canEdit && (
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                      style={{ background: PEACH, color: DARK }}>
                  <Star className="w-3 h-3" />Это вы
                </span>
              )}
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                {o.role === 'owner' ? 'Организатор' : 'Соорганизатор'}
              </span>
            </div>
            {o.brand_name && o.brand_name !== o.name && (
              <div className="text-sm text-gray-600 mt-0.5">Проект: <span className="font-medium">{o.brand_name}</span></div>
            )}
            {o.positioning && <div className="text-sm text-gray-500 mt-0.5">{o.positioning}</div>}
          </div>
        </div>
        {!canEdit && (
          <p className="text-xs text-gray-400 mt-4">
            Это карточка другого организатора — только просмотр. Редактировать можно лишь свою.
          </p>
        )}
      </div>

      {/* Подвкладки */}
      <div className="flex gap-6 border-b border-gray-200 mb-5">
        {([['talk', 'Выступление'], ['links', 'Ссылки']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`pb-2.5 text-sm font-medium border-b-2 -mb-px transition ${
              tab === k ? 'border-[#25455D] text-[#25455D]' : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── ВЫСТУПЛЕНИЕ ── */}
      {tab === 'talk' && (
        <div className="space-y-5">
          {/* Тема */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6">
            <h2 className="font-bold text-gray-900 mb-1">Тема выступления</h2>
            <p className="text-xs text-gray-500 mb-3">Показывается в программе и на странице события.</p>
            {canEdit ? (
              <div className="space-y-2">
                {topics.map((t, i) => (
                  <div key={i} className="flex gap-2">
                    <input value={t} onChange={e => { const n = [...topics]; n[i] = e.target.value; setTopics(n) }}
                      placeholder={`Тема ${i + 1}`}
                      className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm" />
                    {topics.length > 1 && (
                      <button onClick={() => setTopics(topics.filter((_, idx) => idx !== i))}
                        className="p-2 text-gray-400 hover:text-red-500"><X className="w-4 h-4" /></button>
                    )}
                  </div>
                ))}
                <button onClick={() => setTopics([...topics, ''])}
                  className="text-xs inline-flex items-center gap-1" style={{ color: '#C77B3B' }}>
                  <Plus className="w-3 h-3" />Добавить тему
                </button>
              </div>
            ) : (
              topics.filter(Boolean).length
                ? <ul className="text-sm text-gray-700 space-y-1">{topics.filter(Boolean).map((t, i) => <li key={i}>• {t}</li>)}</ul>
                : <p className="text-sm text-gray-400">Тема не задана.</p>
            )}
          </div>

          {/* Подарки — ТОЛЬКО из ПЛЮСОНа, до 4 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6">
            <h2 className="font-bold text-gray-900 mb-1 flex items-center gap-2">
              <Gift className="w-4 h-4" style={{ color: '#C77B3B' }} />Подарки (до 4)
            </h2>
            <p className="text-xs text-gray-500 mb-3">
              Только из вашего ПЛЮСОНа — лид-магниты или пакеты. Выдаются участникам за приглашённых друзей.
            </p>

            {gifts.length > 0 ? (
              <div className="space-y-2 mb-3">
                {gifts.map((g, i) => (
                  <div key={`${g.kind}-${g.id}`} className="flex items-center gap-2 border border-gray-200 rounded-xl px-3 py-2">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0"
                          style={{ background: DARK, color: PEACH }}>
                      {g.kind === 'package' ? 'ПАКЕТ' : 'МАГНИТ'}
                    </span>
                    <span className="text-sm text-gray-800 flex-1 truncate">{g.name || `#${g.id}`}</span>
                    {canEdit && (
                      <button onClick={() => removeGift(i)} className="text-gray-400 hover:text-red-500">
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400 mb-3">Подарки не выбраны.</p>
            )}

            {canEdit && gifts.length < 4 && (
              <div className="grid sm:grid-cols-2 gap-3 pt-3 border-t border-gray-100">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Добавить лид-магнит</label>
                  <select value="" onChange={e => {
                      const id = Number(e.target.value)
                      const m = magnets.find((x: any) => x.id === id)
                      if (m) addGift('magnet', m.id, m.name)
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm bg-white">
                    <option value="">— выбрать —</option>
                    {magnets.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Добавить пакет</label>
                  <select value="" onChange={e => {
                      const id = Number(e.target.value)
                      const p = packages.find((x: any) => x.id === id)
                      if (p) addGift('package', p.id, p.name)
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm bg-white">
                    <option value="">— выбрать —</option>
                    {packages.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* Индивидуальная афиша */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6">
            <h2 className="font-bold text-gray-900 mb-1 flex items-center gap-2">
              <ImageIcon className="w-4 h-4" style={{ color: '#C77B3B' }} />Индивидуальная афиша
            </h2>
            <p className="text-xs text-gray-500 mb-3">
              Из вашей библиотеки афиш. Используется в рассылках и на странице события.
            </p>
            {posters.length === 0 ? (
              <p className="text-sm text-gray-400">
                Библиотека афиш пуста. Загрузите афиши в разделе «Партнёры» → ваша карточка.
              </p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {posters.map(p => {
                  const active = posterId === p.id
                  return (
                    <button key={p.id} disabled={!canEdit}
                      onClick={() => setPosterId(active ? null : p.id)}
                      className={`rounded-xl overflow-hidden border-2 transition ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}
                      style={{ borderColor: active ? PEACH : '#e5e7eb' }}>
                      <img src={p.url} alt={p.label || ''} className="w-full h-24 object-cover" />
                      {p.label && <div className="text-[10px] text-gray-500 truncate px-1 py-0.5">{p.label}</div>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {canEdit && (
            <button onClick={save} disabled={saving}
              className="w-full py-2.5 rounded-xl text-white font-medium inline-flex items-center justify-center gap-2 disabled:opacity-60"
              style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
              <Save className="w-4 h-4" />
              {saving ? 'Сохраняю…' : savedFlash ? 'Сохранено' : 'Сохранить'}
            </button>
          )}
        </div>
      )}

      {/* ── ССЫЛКИ ── */}
      {tab === 'links' && (
        <div className="space-y-4">
          <div className="rounded-2xl border p-4" style={{ borderColor: PEACH, background: '#FFF8F1' }}>
            <p className="text-sm" style={{ color: '#C77B3B' }}>
              {canEdit
                ? <>Это <b>ваши</b> ссылки — через <b>вашего бота</b>. Кого приведёте по ним, тот попадёт в вашу базу и засчитается вам во вклад.</>
                : <>Ссылки этого организатора — через <b>его бота</b>. Кого он приведёт, тот попадёт в его базу.</>}
            </p>
          </div>

          {Object.keys(data.links || {}).length > 0 ? (
            <RefLinkInline
              slug={null}
              refCode={o.ref_code}
              links={data.links}
              eventStatus={data.event_status}
              title={canEdit ? 'Ваши ссылки (через вашего бота)' : `Ссылки ${o.name} (через его бота)`}
            />
          ) : (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
              {canEdit
                ? 'У вас не подключён свой бот — ссылка не строится. Подключите бота в разделе «Каналы».'
                : 'У этого организатора не подключён свой бот — ссылка не строится.'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
