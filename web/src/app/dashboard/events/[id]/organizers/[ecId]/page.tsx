'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ExternalLink, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import RefLinkInline from '@/components/RefLinkInline'

/**
 * Страница соорганизатора в контексте конкретного мероприятия.
 *
 * Показывает per-event поля (партнёрская ссылка) + per-event настройки
 * проверки подписки на канал (как у спикеров конференции).
 * Глобальная карточка коллаборатора — отдельная страница в /dashboard/collaborations.
 */
export default function EventOrganizerPage() {
  const router = useRouter()
  const { id, ecId } = useParams()
  const eventId = Number(id)
  const ecIdNum = Number(ecId)

  const [event, setEvent] = useState<any>(null)
  const [item, setItem] = useState<any>(null)
  const [mainBotHandle, setMainBotHandle] = useState<string>('')
  const [loading, setLoading] = useState(true)

  const [verifying, setVerifying] = useState(false)
  const [verifyMsg, setVerifyMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [savingExclude, setSavingExclude] = useState(false)

  function reloadCollab() {
    return api.events.listCollaborators(eventId, 'organizer').then((colRes: any) => {
      const arr = Array.isArray(colRes) ? colRes : (colRes?.items ?? colRes?.collaborators ?? [])
      const found = arr.find((c: any) => c.id === ecIdNum)
      if (!found) {
        router.push(`/dashboard/events/${eventId}?tab=co_organizers`)
        return null
      }
      setItem(found)
      return found
    })
  }

  useEffect(() => {
    Promise.all([
      api.events.get(eventId),
      api.events.listCollaborators(eventId, 'organizer'),
      api.auth.me().catch(() => null),
    ])
      .then(([evRes, colRes, me]: any) => {
        setEvent(evRes?.event || null)
        const arr = Array.isArray(colRes) ? colRes : (colRes?.items ?? colRes?.collaborators ?? [])
        const found = arr.find((c: any) => c.id === ecIdNum)
        if (!found) { router.push(`/dashboard/events/${eventId}?tab=co_organizers`); return }
        setItem(found)
        if (me?.main_bot_handle) setMainBotHandle(String(me.main_bot_handle))
      })
      .catch(() => router.push(`/dashboard/events/${eventId}?tab=co_organizers`))
      .finally(() => setLoading(false))
  }, [eventId, ecIdNum])

  async function handleVerify() {
    setVerifying(true)
    setVerifyMsg(null)
    try {
      const res: any = await api.events.verifyCollaboratorChannel(eventId, ecIdNum)
      setVerifyMsg({ ok: true, text: res.message || 'Подписка подтверждена' })
      await reloadCollab()
    } catch (err: any) {
      setVerifyMsg({ ok: false, text: err.message || 'Ошибка проверки' })
    } finally {
      setVerifying(false)
    }
  }

  async function handleExcludeToggle(checked: boolean) {
    setSavingExclude(true)
    try {
      await api.events.updateCollaborator(eventId, ecIdNum, {
        exclude_channel_from_subscription: checked,
      })
      await reloadCollab()
    } catch (err: any) {
      alert(err.message || 'Не удалось сохранить')
    } finally {
      setSavingExclude(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="text-brand text-3xl" />
      </div>
    )
  }
  if (!item || !event) return null

  const requireSubscription: boolean = !!event.require_subscription
  const channelMatters = requireSubscription
  const hasChannel = !!(item.tg_channel_id && String(item.tg_channel_id).trim())
  const hasPersonalTg = !!item.personal_tg_id

  return (
    <div className="max-w-2xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link href="/dashboard/events" className="hover:text-gray-700">Мероприятия</Link>
        <span>/</span>
        <Link href={`/dashboard/events/${eventId}?tab=co_organizers`} className="hover:text-gray-700">{event.title}</Link>
        <span>/</span>
        <span className="text-gray-700">{item.name}</span>
      </div>

      {/* Шапка */}
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/dashboard/events/${eventId}?tab=co_organizers`}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex items-center gap-3 flex-1">
          {item.photo_url ? (
            <img src={item.photo_url} alt={item.name} className="w-14 h-14 rounded-full object-cover" />
          ) : (
            <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs">
              {item.name.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 truncate">{item.name}</h1>
            {item.title && <p className="text-gray-500 text-sm truncate">{item.title}</p>}
            {item.personal_tg_username && (
              <p className="text-xs text-gray-400 truncate">@{String(item.personal_tg_username).replace(/^@/, '')}</p>
            )}
          </div>
        </div>
        <Link href={`/dashboard/collaborations/${item.collaborator_id}`}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-[#25455D] px-2.5 py-1.5 rounded-lg border border-gray-200 hover:border-gray-300">
          <ExternalLink size={13} /> Профиль
        </Link>
      </div>

      {/* Партнёрская ссылка для ЭТОГО мероприятия */}
      <div className="mb-6">
        <RefLinkInline slug={event.slug} refCode={item.ref_code} eventStatus={event.status} />
      </div>

      {/* Регалии (read-only превью; правится в карточке коллаборатора) */}
      {Array.isArray(item.achievements) && item.achievements.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-3">Регалии</h2>
          <ul className="space-y-1.5">
            {item.achievements.map((a: string, i: number) => (
              <li key={i} className="text-sm text-gray-700 flex items-start gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#25455D] shrink-0 mt-2" />
                {a}
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-400 mt-3">
            Чтобы изменить — откройте <Link href={`/dashboard/collaborations/${item.collaborator_id}`} className="underline">профиль коллаборатора</Link>.
          </p>
        </div>
      )}

      {/* Проверка подписки на канал */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 mb-6">
        <h2 className="text-sm font-semibold text-gray-800 mb-3">Канал для проверки подписки</h2>

        {!channelMatters ? (
          <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-xl p-3">
            Проверка подписки на каналы соорганизаторов отключена в{' '}
            <Link href={`/dashboard/events/${eventId}?tab=overview`} className="underline">настройках мероприятия</Link>{' '}
            (тумблер «Требовать подписку на каналы соорганизаторов»). Канал этого соорганизатора в проверке не участвует.
          </div>
        ) : item.exclude_channel_from_subscription ? (
          <div className="space-y-3">
            <div className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-xl p-3">
              Канал этого соорганизатора <b>исключён из проверки подписки</b> вручную. Участникам он не показывается.
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!item.exclude_channel_from_subscription}
                disabled={savingExclude}
                onChange={e => handleExcludeToggle(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-brand"
              />
              <span className="text-sm text-gray-700">Исключить канал из проверки подписки</span>
            </label>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-gray-600 leading-relaxed bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
              <div className="font-semibold text-gray-800">Как подключить канал к проверке подписки:</div>
              <ol className="list-decimal pl-4 space-y-1.5">
                <li>
                  В <Link href={`/dashboard/collaborations/${item.collaborator_id}`} className="underline font-semibold">профиле коллаборатора</Link>{' '}
                  заполните <b>«ID канала»</b> и <b>«ID личного аккаунта»</b> и сохраните — без них автопроверка не запустится.
                </li>
                <li>Откройте канал в Telegram → «Управление каналом» → «Администраторы» → «Добавить администратора».</li>
                <li>
                  Найдите бота{' '}
                  <span className="font-mono font-semibold text-gray-800">
                    @{mainBotHandle || 'ваш_главный_бот'}
                  </span>
                  {!mainBotHandle && (
                    <span className="text-amber-700"> (подключите главный бот в разделе <Link href="/dashboard/channels" className="underline">«Каналы»</Link>)</span>
                  )}
                  {' '}и добавьте его.
                </li>
                <li><b>Снимите ВСЕ галки прав</b> — бот не должен ничего публиковать в канале, он нужен только чтобы видеть подписчиков. Сохраните.</li>
                <li>Нажмите кнопку ниже — бот сам проверит, видит ли он подписку самого соорганизатора на свой канал.</li>
              </ol>
            </div>

            {/* Состояние «бот в канале» */}
            <div className={`flex items-start gap-2 p-3 rounded-xl border ${item.bot_in_channel ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
              {item.bot_in_channel ? (
                <CheckCircle2 size={18} className="text-green-600 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle size={18} className="text-amber-500 shrink-0 mt-0.5" />
              )}
              <div className="text-sm flex-1">
                {item.bot_in_channel ? (
                  <>
                    <div className="font-semibold text-green-800">Бот в канале — проверка работает.</div>
                    <div className="text-xs text-green-700 mt-0.5">Если что-то изменили в канале (бота удалили или переподключили) — нажмите «Проверить ещё раз».</div>
                  </>
                ) : (
                  <>
                    <div className="font-semibold text-amber-800">Бот не подтверждён в канале — проверка будет ложной.</div>
                    <div className="text-xs text-amber-700 mt-0.5">
                      Канал участникам показывается, но <b>{`getChatMember`}</b> не сможет видеть подписчиков, пока бот не добавлен админом. Все будут получать «вы не подписаны», даже если подписаны.
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <button
                type="button"
                onClick={handleVerify}
                disabled={verifying || !hasChannel || !hasPersonalTg}
                className="btn-gold py-2 px-4 rounded-xl text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed">
                {verifying
                  ? 'Проверяю...'
                  : (item.bot_in_channel ? 'Проверить ещё раз' : 'Проверить, что бот в канале')}
              </button>
              {(!hasChannel || !hasPersonalTg) && (
                <span className="text-xs text-amber-700">
                  Сначала заполните{' '}
                  {!hasChannel && <b>«ID канала»</b>}
                  {!hasChannel && !hasPersonalTg && ' и '}
                  {!hasPersonalTg && <b>«ID личного аккаунта»</b>}
                  {' '}в профиле коллаборатора.
                </span>
              )}
            </div>

            {verifyMsg && (
              <p className={`text-xs px-3 py-2 rounded-lg ${verifyMsg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                {verifyMsg.text}
              </p>
            )}

            <label className="flex items-center gap-2 cursor-pointer select-none pt-2 border-t border-gray-100">
              <input
                type="checkbox"
                checked={!!item.exclude_channel_from_subscription}
                disabled={savingExclude}
                onChange={e => handleExcludeToggle(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-brand"
              />
              <span className="text-sm text-gray-700">Исключить канал из проверки подписки</span>
            </label>
          </div>
        )}
      </div>
    </div>
  )
}
