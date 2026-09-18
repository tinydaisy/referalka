'use client'
import { useEffect, useState } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Users, Star, Save, Plus, X, Gift, Image as ImageIcon } from 'lucide-react'
import { api } from '@/lib/api'
import LeadMagnetPicker from '@/components/LeadMagnetPicker'
import RefLinkInline from '@/components/RefLinkInline'
import FileUploader from '@/components/FileUploader'
import CabinetPreviewBlock from '@/components/CabinetPreviewBlock'
import MarkupHints, { MarkupTip } from '@/components/MarkupHints'
import { useMe } from '@/hooks/useMe'
import { focalCss } from '@/lib/photoFocal'

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
  // Домен клиента: ссылки предпросмотра ведут на публичную страницу события.
  const { publicHost } = useMe()
  const params = useParams()
  const router = useRouter()
  const eventId = Number(params?.id)
  const clientId = Number(params?.clientId)

  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useUrlTab<'talk' | 'profile' | 'links'>('tab', 'talk', ['talk', 'profile', 'links'])
  // Профиль спикера — карточка коллаба (та же, что в программе и на лендинге).
  const [prof, setProf] = useState<any>(null)
  const [achText, setAchText] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [leaving, setLeaving] = useState(false)

  // Выйти из коллабы. Только своя карточка; создателя бэк не выпустит (403) —
  // он распускает коллабу удалением события.
  async function leave() {
    if (!confirm('Покинуть событие? Вы перестанете быть организатором, ваши реф-ссылки в нём работать не будут.')) return
    setLeaving(true)
    try {
      await api.collabHub.leaveCollab(eventId)
      router.push('/dashboard/collab-hub/events')
    } catch (e: any) {
      alert(e?.message || 'Не удалось выйти из события')
    } finally {
      setLeaving(false)
    }
  }

  // Форма (только для своей карточки)
  const [topics, setTopics] = useState<string[]>([''])
  const [gifts, setGifts] = useState<any[]>([])
  const [posterId, setPosterId] = useState<number | null>(null)
  // Каталог своих лид-магнитов/пакетов — для выбора подарков
  const [magnets, setMagnets] = useState<any[]>([])
  const [packages, setPackages] = useState<any[]>([])
  // Согласие «разрешаю рассылки по моей базе в этом событии» (одноразовое на событие).
  const [allowBroadcasts, setAllowBroadcasts] = useState(false)
  const [savingConsent, setSavingConsent] = useState(false)

  const load = async () => {
    try {
      const r: any = await api.collabHub.organizerCard(eventId, clientId)
      setData(r)
      setTopics(r.topics?.length ? r.topics.map((t: any) => t.topic) : [''])
      setGifts(r.gift_lead_magnets || [])
      setPosterId(r.organizer?.poster_id ?? null)
      setAllowBroadcasts(!!r.allow_collab_broadcasts)
      setProf(r.profile || null)
      setAchText(Array.isArray(r.profile?.achievements) ? r.profile.achievements.join('\n') : '')
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

  // Согласие сохраняем СРАЗУ при клике (не ждём общего «Сохранить»).
  const toggleConsent = async (next: boolean) => {
    setAllowBroadcasts(next)          // оптимистично
    setSavingConsent(true)
    try {
      await api.collabHub.updateOrganizerCard(eventId, clientId, { allow_collab_broadcasts: next })
    } catch (e: any) {
      setAllowBroadcasts(!next)        // откат
      alert(e?.message || 'Не удалось сохранить')
    } finally {
      setSavingConsent(false)
    }
  }

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

  // Сохранение профиля спикера. ⚠️ Отдельной кнопкой, а не общим «Сохранить»:
  // вкладки правятся независимо, и человек не должен терять правки другой.
  const saveProfile = async () => {
    if (!prof) return
    setSavingProfile(true)
    try {
      await api.collabHub.updateOrganizerCard(eventId, clientId, {
        name: prof.name || null,
        last_name: prof.last_name || null,
        title: prof.title || null,
        achievements: achText.split('\n').map(a => a.trim()).filter(Boolean),
        photo_url: prof.photo_url || null,
        tg_channel_url: prof.tg_channel_url || null,
        tg_channel_id: prof.tg_channel_id || null,
        vk_url: prof.vk_url || null,
        max_url: prof.max_url || null,
        instagram_url: prof.instagram_url || null,
        website_url: prof.website_url || null,
      })
      await load()
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1800)
    } catch (e: any) {
      alert(e?.message || 'Ошибка сохранения')
    } finally {
      setSavingProfile(false)
    }
  }

  const addGift = (kind: 'magnet' | 'package', id: number, name: string) => {
    if (gifts.length >= 4) { alert('Можно добавить не больше 4 подарков'); return }
    if (gifts.some(g => g.kind === kind && g.id === id)) return
    setGifts([...gifts, { kind, id, name }])
  }
  const removeGift = (i: number) => setGifts(gifts.filter((_, idx) => idx !== i))

  if (err) return <div className="p-4 md:p-8 text-gray-400">{err}</div>
  if (!data) return <div className="p-4 md:p-8 text-gray-400">Загрузка…</div>

  const o = data.organizer || {}
  const canEdit = !!data.can_edit
  const posters: any[] = data.posters || []
  // Площадки ЭТОГО организатора — только те, по которым бэк реально вернул ссылку
  // (у кого подключён MAX — будет MAX, у кого только TG — только Telegram).
  // Режим (Mini App / веб) у каждой площадки СВОЙ — берём из link_modes.
  const PLATFORM_TITLES: Record<string, string> = { telegram: 'Telegram', vk: 'ВКонтакте', max: 'MAX' }
  const platformList = Object.keys(data.links || {})
    .filter(k => (data.links as any)[k])
    .map(k => ({
      key: k,
      title: PLATFORM_TITLES[k] || k,
      mode: (data.link_modes || {})[k] || data.link_mode,
    }))

  return (
    <div className="p-4 md:p-8">
      <button onClick={() => router.push(`/dashboard/events/${eventId}?tab=collab_organizers`)}
        className="text-sm text-gray-500 inline-flex items-center gap-1 mb-4">
        <ArrowLeft className="w-4 h-4" />К организаторам
      </button>

      {/* Шапка */}
      <div className="bg-white rounded-2xl border card-border p-6 mb-5">
        <div className="flex items-start gap-4">
          {o.photo_url
            ? <img src={o.photo_url} alt="" className="w-16 h-16 rounded-xl object-cover shrink-0" style={{ objectPosition: focalCss(o.photo_focal) }} />
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
        {([['talk', 'Выступление'], ['profile', 'Профиль спикера'], ['links', 'Ссылки']] as const).map(([k, label]) => (
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
          {/* Согласие «разрешаю рассылки по моей базе в этом событии»
              (event_owners.allow_collab_broadcasts).

              ⚠️ СКРЫТО ИЗ ИНТЕРФЕЙСА по решению владельца (2026-08-24).
              Сам флаг и логика на бэкенде живы: он решает, уходит ли анонс по
              базе партнёра сразу или ждёт подтверждения
              (services/collab_broadcast.py). Убрана только галочка — включать
              согласие через кабинет больше нельзя. Вернуть = снять `false &&`. */}
          {false && canEdit && (
            <div className="rounded-2xl border p-5" style={{ borderColor: PEACH, background: '#FFF8F1' }}>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowBroadcasts}
                  disabled={savingConsent || !!data.event_ended}
                  onChange={e => toggleConsent(e.target.checked)}
                  className="mt-0.5 w-5 h-5 shrink-0 cursor-pointer disabled:opacity-50"
                  style={{ accentColor: DARK }}
                />
                <span className="text-sm" style={{ color: '#C77B3B' }}>
                  <b>Разрешаю рассылки по моей базе в этом событии.</b> Любой анонс этого
                  события будет уходить и по моей базе через моего бота — без отдельного
                  подтверждения каждый раз. Действует только для этого события.
                  {data.event_ended && (
                    <span className="block mt-1 text-gray-500">
                      Событие завершено — рассылки в него больше не отправляются.
                    </span>
                  )}
                </span>
              </label>
            </div>
          )}

          {/* Тема */}
          <div className="bg-white rounded-2xl border card-border p-6">
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
          <div className="bg-white rounded-2xl border card-border p-6">
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

            {/* ⚠️ ОДИН пикер вместо двух списков: он сам делит магниты и
                пакеты группами и даёт поиск по названию — их у клиента
                десятки, и двумя списками без поиска нужный не найти.
                ⚠️ Комментарий — ВЫШЕ условия: сразу после `&& (` JSX ждёт
                элемент, а JSX-комментарий там роняет сборку («Unexpected
                token div. Expected jsx identifier»).
                ⚠️⚠️ И НЕ ПИСАТЬ здесь звёздочку со слэшем: она закрывает
                ЭТОТ комментарий раньше времени, остаток строки уезжает в
                разметку и сборка падает снова — ровно так и вышло 16.09.2026,
                когда пояснение к этой ловушке само её и устроило. */}
            {canEdit && gifts.length < 4 && (
              <div className="pt-3 border-t border-gray-100">
                <label className="block text-xs text-gray-500 mb-1">
                  Добавить лид-магнит или пакет
                </label>
                <LeadMagnetPicker
                  allowEmpty={false}
                  placeholder="— выбрать —"
                  value={null}
                  onPick={v => {
                    if (!v) return
                    const src = v.kind === 'package' ? packages : magnets
                    const it = src.find((x: any) => x.id === v.id)
                    if (it) addGift(v.kind, it.id, it.name)
                  }}
                />
              </div>
            )}
          </div>

          {/* Индивидуальная афиша */}
          <div className="bg-white rounded-2xl border card-border p-6">
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

      {/* ── ПРОФИЛЬ СПИКЕРА ──
          ⚠️ Это карточка коллаба (collaborators), ТА ЖЕ, что читают программа,
          лендинг, рассылки и проверка подписки. Раньше её отсюда править было
          нельзя, и организатор коллабы — который сам выступает — не мог
          поправить себя как спикера вообще. */}
      {tab === 'profile' && (
        <div className="space-y-4">
          {!prof ? (
            <p className="text-sm text-gray-500">Карточка спикера ещё не создана.</p>
          ) : (
            <>
              {!canEdit && (
                <p className="text-sm text-gray-500">Это чужая карточка — только просмотр.</p>
              )}

              {/* Предпросмотр кабинета участника: как страница события выглядит
                  до регистрации и после неё. Компонент общий с карточками
                  спикера конференции и соорганизатора мероприятия. */}
              <CabinetPreviewBlock
                publicHost={publicHost}
                slug={data.event_slug}
                contactId={prof.contact_id}
                personLabel="этого организатора"
              />

              <div className="bg-white rounded-2xl border card-border shadow-sm p-6 space-y-4">
                <h2 className="font-semibold text-gray-900">Основная информация</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Имя</label>
                    <input type="text" value={prof.name || ''} disabled={!canEdit}
                      onChange={e => setProf({ ...prof, name: e.target.value })}
                      className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-[#25455D] disabled:bg-gray-50" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Фамилия</label>
                    <input type="text" value={prof.last_name || ''} disabled={!canEdit}
                      onChange={e => setProf({ ...prof, last_name: e.target.value })}
                      className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-[#25455D] disabled:bg-gray-50" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Краткое позиционирование / Должность</label>
                  <input type="text" value={prof.title || ''} disabled={!canEdit}
                    onChange={e => setProf({ ...prof, title: e.target.value })}
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-[#25455D] disabled:bg-gray-50" />
                  <p className="mt-1 text-xs text-gray-400">{(prof.title || '').length} из 140</p>
                  {/* Позиционирование тоже показывается через SafeHtml — ошибка
                      в теге так же расползается жирным по карточке. */}
                  <MarkupHints value={prof.title || ''} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Регалии (по одной на строку)</label>
                  <textarea value={achText} rows={6} disabled={!canEdit}
                    onChange={e => setAchText(e.target.value)}
                    placeholder={'Регалия 1\nРегалия 2\nРегалия 3'}
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-[#25455D] resize-y disabled:bg-gray-50" />
                  <p className="mt-1 text-xs text-gray-400">{achText.length} из 1100</p>
                  <MarkupTip />
                  <MarkupHints value={achText} />
                </div>
              </div>

              <div className="bg-white rounded-2xl border card-border shadow-sm p-6 space-y-4">
                <h2 className="font-semibold text-gray-900">Фото</h2>
                <FileUploader
                  mode="single" kind="speaker_photo"
                  collaboratorId={prof.id}
                  value={prof.photo_url || null}
                  onChange={(u: any) => setProf({ ...prof, photo_url: u || '' })}
                  accept="image/*"
                />
              </div>

              <div className="bg-white rounded-2xl border card-border shadow-sm p-6 space-y-4">
                <h2 className="font-semibold text-gray-900">Каналы и ссылки</h2>
                {/* ⚠️ Номер TG-канала нужен для ПРОВЕРКИ ПОДПИСКИ при входе в чат
                    события: без него канал показывается человеку, но подтвердить
                    подписку нечем — он навсегда остаётся в «подпишитесь». */}
                {([
                  ['tg_channel_url', 'Ссылка на Telegram-канал'],
                  ['tg_channel_id', 'ID Telegram-канала (нужен для проверки подписки)'],
                  ['vk_url', 'Ссылка ВКонтакте'],
                  ['max_url', 'Ссылка MAX'],
                  ['instagram_url', 'Instagram'],
                  ['website_url', 'Сайт'],
                ] as const).map(([k, label]) => (
                  <div key={k}>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
                    <input type="text" value={(prof as any)[k] || ''} disabled={!canEdit}
                      onChange={e => setProf({ ...prof, [k]: e.target.value })}
                      className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-[#25455D] disabled:bg-gray-50" />
                  </div>
                ))}
              </div>

              {canEdit && (
                <button onClick={saveProfile} disabled={savingProfile}
                  className="btn-gold px-6 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                  {savingProfile ? 'Сохраняем…' : 'Сохранить профиль'}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* ── ССЫЛКИ ── */}
      {tab === 'links' && (
        <div className="space-y-4">
          <div className="rounded-2xl border p-4 space-y-2" style={{ borderColor: PEACH, background: '#FFF8F1' }}>
            <p className="text-sm" style={{ color: '#C77B3B' }}>
              {canEdit
                ? <>Это <b>ваши</b> ссылки — через <b>вашего бота</b>. Кого приведёте по ним, тот попадёт в вашу базу и засчитается вам во вклад.</>
                : <>Ссылки этого организатора — через <b>его бота</b>. Кого он приведёт, тот попадёт в его базу.</>}
            </p>
            {/* Через что идёт регистрация именно у ЭТОГО организатора — режим и площадки
                берутся из ЕГО настроек («Mini App» → «Бот и ссылки») и ЕГО подключённых каналов.
                ⚠️ Режим у КАЖДОЙ площадки свой (Mini App может быть в Telegram и не быть во
                ВКонтакте), поэтому пишем его напротив каждой, а не одной общей фразой. */}
            {platformList.length > 0 && (
              <p className="text-xs" style={{ color: '#C77B3B' }}>
                Регистрация {canEdit ? 'у вас' : `у ${o.name}`} идёт:{' '}
                {platformList.map((p, i) => (
                  <span key={p.key}>
                    {i > 0 && ' · '}
                    <b>{p.title}</b> — {p.mode === 'bot' ? 'веб-страница события' : 'Mini App'}
                  </span>
                ))}
              </p>
            )}
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

      {/* Покинуть событие — ТОЛЬКО в своей карточке (в чужих её нет вообще). */}
      {canEdit && (
        <div className="mt-8 rounded-2xl border border-red-200 bg-red-50 p-5">
          <div className="text-sm font-semibold text-red-700">Покинуть событие</div>
          <p className="mt-1 text-xs text-red-600">
            Вы выйдете из числа организаторов. Ваша карточка, тема и подарки в этом событии
            будут отвязаны, ваши реф-ссылки перестанут работать. Участники, которых вы уже
            привели, останутся в вашей базе.
          </p>
          <button
            onClick={leave}
            disabled={leaving}
            className="mt-3 px-4 py-2 rounded-xl bg-red-600 text-white text-sm font-medium disabled:opacity-50">
            {leaving ? 'Выходим…' : 'Покинуть событие'}
          </button>
        </div>
      )}
    </div>
  )
}
