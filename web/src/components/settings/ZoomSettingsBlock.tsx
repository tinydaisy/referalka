'use client'
/**
 * Подключение своего Zoom (миграция 444).
 *
 * Блок живёт во вкладке «Интеграция» настроек, рядом с автообзвонами.
 *
 * ⚠️ Ключей здесь НЕТ и быть не должно: клиент подключает зум входом в свой
 * аккаунт (OAuth), как в любом сервисе «войти через…». Поля для ключей означали
 * бы, что человек идёт искать их в кабинете разработчика Zoom — а это не то,
 * чего мы от него хотим.
 *
 * ⚠️ Блок сам скрывается без фичи: он в общей вкладке рядом с другими
 * интеграциями, и замок на пол-экрана тут был бы шумом (так же устроен
 * CallSettingsBlock).
 */
import { useEffect, useState } from 'react'
import { Video, ExternalLink, Check, AlertTriangle, RefreshCw, Unplug } from 'lucide-react'
import { api } from '@/lib/api'

export default function ZoomSettingsBlock() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [denied, setDenied] = useState(false)
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<any>(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      setData(await api.zoom.get())
    } catch (e: any) {
      // Нет фичи — блок не показываем вовсе.
      if (String(e?.message || '').includes('недоступна')) setDenied(true)
      else setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function connect() {
    setConnecting(true); setError('')
    try {
      const r = await api.zoom.oauthUrl()
      // ⚠️ Новая вкладка, а не редирект: человек остаётся в кабинете, и после
      // согласия ему не нужно заново искать, где он был.
      window.open(r.oauth_url, '_blank', 'noopener')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setConnecting(false)
    }
  }

  async function check() {
    setChecking(true); setCheckResult(null); setError('')
    try {
      setCheckResult(await api.zoom.check())
      await load()
    } catch (e: any) { setError(e.message) } finally { setChecking(false) }
  }

  async function disconnect() {
    if (!confirm('Отключить Zoom? Уже созданные конференции останутся — мы просто перестанем создавать новые.')) return
    setError('')
    try {
      await api.zoom.disconnect()
      await load()
    } catch (e: any) { setError(e.message) }
  }

  if (loading || denied) return null

  const connected = !!data?.connected
  const needsReconnect = !!data?.needs_reconnect

  return (
    <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
          <Video size={18} className="text-white" />
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-gray-800">Интеграция с Zoom</h3>
          <p className="text-sm text-gray-500 mt-0.5 leading-snug">
            Подключите свой Zoom — и конференция на день эфира будет создаваться одной
            кнопкой во вкладке «Вебинар»: сразу с трансляцией в вашу вебинарную комнату
            и ссылкой входа для спикеров. Переносить RTMP-адрес и ключ руками больше не нужно.
          </p>
        </div>
      </div>

      {/* Приложение не настроено на сервере — подключать нечего. Говорим прямо,
          чтобы человек не думал, что сломалось у него. */}
      {!data?.app_configured && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-900">
          Интеграция ещё не настроена на стороне платформы. Напишите в поддержку —
          подключим.
        </div>
      )}

      {data?.app_configured && (
        <>
          {/* Что произойдёт после подключения. Короткий список: человек должен
              понимать, что мы делаем в его зуме, до того как разрешит доступ. */}
          {!connected && (
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 mb-5 text-sm text-blue-900">
              <p className="font-medium mb-1">Что мы будем делать в вашем Zoom</p>
              <ul className="list-disc ml-4 space-y-1 text-blue-800">
                <li>создавать конференцию на день эфира — по названию и времени из программы;</li>
                <li>включать ей трансляцию в вашу вебинарную комнату;</li>
                <li>подставлять ссылку входа спикерам в настройки дня.</li>
              </ul>
              <p className="mt-2 text-blue-800">
                Ничего другого мы не трогаем: чужие конференции, записи и настройки аккаунта
                нам недоступны. Отключить можно в любой момент — здесь же.
              </p>
            </div>
          )}

          {connected ? (
            <div className="space-y-4">
              <div className={`rounded-xl border p-4 ${
                needsReconnect ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'}`}>
                <div className="flex items-start gap-2">
                  {needsReconnect
                    ? <AlertTriangle size={16} className="text-red-600 mt-0.5 shrink-0" />
                    : <Check size={16} className="text-emerald-600 mt-0.5 shrink-0" />}
                  <div className="text-sm">
                    {needsReconnect ? (
                      <>
                        <p className="font-medium text-red-800">Доступ к Zoom больше не действует</p>
                        <p className="text-red-700 mt-0.5">
                          {data?.error || 'Похоже, доступ отозвали в самом Zoom.'} Нажмите
                          «Подключить заново» — конференции снова будут создаваться.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="font-medium text-emerald-800">
                          Подключён{data?.email ? <>: {data.email}</> : null}
                        </p>
                        {data?.account_name && (
                          <p className="text-emerald-700 mt-0.5">{data.account_name}</p>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* ⚠️ Тариф Zoom — не придирка: ниже Pro у них нет трансляции на
                  произвольный адрес, значит конференция создастся, а в комнату
                  не польётся. Сказать это нужно здесь, а не в момент эфира. */}
              {!needsReconnect && data?.can_livestream === false && (
                <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-900">
                  <p className="font-medium mb-1">У аккаунта базовый тариф Zoom</p>
                  <p>
                    Конференции создавать сможем, а вот трансляцию в вебинарную комнату —
                    нет: Zoom разрешает вещание на свой адрес с тарифа Pro. Эфир при этом
                    пройдёт в самом Zoom, но наша комната с чатом и продающими блоками
                    останется пустой.
                  </p>
                </div>
              )}

              {checkResult && (
                <div className={`rounded-xl border p-3 text-sm ${
                  checkResult.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                 : 'border-red-200 bg-red-50 text-red-800'}`}>
                  {checkResult.ok
                    ? <>Связь есть. Аккаунт: {checkResult.email || '—'}
                        {checkResult.can_livestream === false && ' (тариф ниже Pro — трансляции не будет)'}</>
                    : <>{checkResult.error}</>}
                </div>
              )}

              {/* Где уже созданы конференции — доказательство, что всё работает. */}
              {(data?.meetings || []).length > 0 && (
                <div className="rounded-xl border border-gray-200 p-4">
                  <p className="text-sm font-medium text-gray-700 mb-2">Созданные конференции</p>
                  <ul className="space-y-1.5">
                    {data.meetings.map((m: any) => (
                      <li key={`${m.event_id}-${m.day_number}`}
                          className="text-sm text-gray-600 flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-gray-800">{m.event_title}</span>
                        <span className="text-gray-400">· день {m.day_number}</span>
                        {m.livestream_ok
                          ? <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">с трансляцией</span>
                          : <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">без трансляции</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={check} disabled={checking}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-1.5">
                  <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
                  {checking ? 'Проверяем…' : 'Проверить связь'}
                </button>
                <button type="button" onClick={connect} disabled={connecting}
                  className="px-4 py-2 rounded-xl border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-1.5">
                  <ExternalLink size={14} /> Подключить заново
                </button>
                <button type="button" onClick={disconnect}
                  className="px-4 py-2 rounded-xl border border-red-200 text-sm text-red-600 hover:bg-red-50 inline-flex items-center gap-1.5">
                  <Unplug size={14} /> Отключить
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={connect} disabled={connecting} className="btn-gold inline-flex items-center gap-2">
                <ExternalLink size={16} />
                {connecting ? 'Открываем Zoom…' : 'Подключить Zoom'}
              </button>
              <span className="text-xs text-gray-500">
                Откроется окно Zoom — войдите в свой аккаунт и разрешите доступ.
              </span>
            </div>
          )}

          {/* Человек подключался в соседней вкладке — здесь данные обновятся
              только по кнопке. Без неё он вернётся и увидит «не подключён». */}
          {!connected && (
            <button type="button" onClick={load}
              className="mt-3 text-xs text-gray-500 hover:text-gray-700 underline">
              Уже подключили? Обновить состояние
            </button>
          )}
        </>
      )}

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
    </div>
  )
}
