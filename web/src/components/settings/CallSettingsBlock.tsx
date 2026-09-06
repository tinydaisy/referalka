'use client'
/**
 * Подключение автообзвонов — сервис Звонопёс (миграция 359).
 *
 * Блок живёт во вкладке «Интеграция» настроек: клиент вписывает свой API-ключ,
 * выбирает номер, с которого звонить, и видит баланс.
 *
 * ⚠️ Ключ выдаёт менеджер Звонопса — в их кабинете его не взять. Поэтому рядом
 * с полем стоит ссылка на регистрацию: без неё человек не поймёт, где ключ
 * добыть, и решит, что раздел не работает.
 */
import { useEffect, useState } from 'react'
import { Phone, ExternalLink, Check, AlertTriangle, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'

export default function CallSettingsBlock() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [denied, setDenied] = useState(false)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')

  const [apiKey, setApiKey] = useState('')
  const [outgoing, setOutgoing] = useState('')
  const [duty, setDuty] = useState(false)

  const [phones, setPhones] = useState<any[] | null>(null)
  const [phonesLoading, setPhonesLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<any>(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const d = await api.callSettings.get()
      setData(d)
      setOutgoing(d.calls_calldog_outgoing_phone || '')
      setDuty(!!d.calls_calldog_duty_phone)
    } catch (e: any) {
      // Нет фичи — блок просто не показываем: он в общей вкладке рядом с
      // другими интеграциями, и замок на пол-экрана тут был бы шумом.
      if (String(e?.message || '').includes('недоступен')) setDenied(true)
      else setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    setSaving(true); setError(''); setOk('')
    try {
      const payload: any = {
        calls_calldog_outgoing_phone: outgoing,
        calls_calldog_duty_phone: duty,
      }
      // Пустое поле ключа = «не меняем». Иначе сохранение любой другой
      // настройки стирало бы ключ, который мы наружу не отдаём.
      if (apiKey.trim()) payload.calls_calldog_api_key = apiKey.trim()
      const d = await api.callSettings.update(payload)
      setData(d)
      setApiKey('')
      setOk('Сохранено')
      setTimeout(() => setOk(''), 2500)
    } catch (e: any) { setError(e.message) } finally { setSaving(false) }
  }

  async function loadPhones() {
    setPhonesLoading(true); setError('')
    try {
      const r = await api.callSettings.phones()
      setPhones(r.phones || [])
      if (!r.phones?.length) setError(r.message || 'В аккаунте Звонопса нет исходящих номеров.')
    } catch (e: any) { setError(e.message) } finally { setPhonesLoading(false) }
  }

  async function check() {
    setChecking(true); setCheckResult(null); setError('')
    try {
      const r = await api.callSettings.check(apiKey.trim() ? { calls_calldog_api_key: apiKey.trim() } : {})
      setCheckResult(r)
    } catch (e: any) { setError(e.message) } finally { setChecking(false) }
  }

  if (loading || denied) return null

  const signupUrl = data?.signup_url || 'https://lk.calldog.ru'

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
          <Phone size={18} className="text-white" />
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-gray-800">Интеграция с сервисом Звонопёс</h3>
          <p className="text-sm text-gray-500 mt-0.5 leading-snug">
            Обзвон базы роботом: выбираете аудиторию так же, как в рассылках, робот звонит
            и записывает, кто ответил и что нажал. Звонки идут через ваш аккаунт Звонопса —
            вы платите сервису напрямую.
          </p>
        </div>
      </div>

      {/* Где взять ключ. Без этой подсказки человек упрётся: в кабинете
          Звонопса ключа нет, его выдаёт менеджер. */}
      <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 mb-5 text-sm text-blue-900">
        <p className="font-medium mb-1">Как подключить</p>
        <ol className="list-decimal ml-4 space-y-1 text-blue-800">
          <li>
            Зарегистрируйтесь в Звонопсе —{' '}
            <a href={signupUrl} target="_blank" rel="noreferrer"
               className="underline inline-flex items-center gap-0.5 font-medium">
              lk.calldog.ru <ExternalLink size={12} />
            </a>
          </li>
          <li>Запросите <b>API-ключ у менеджера сервиса</b> — в кабинете его нет.</li>
          <li>Там же попросите <b>отключить модерацию для генерации голоса</b>, иначе каждый
              озвученный текст будет ждать ручной проверки.</li>
          <li>Добавьте и подтвердите номер, с которого будете звонить.</li>
          <li>Создайте сценарий звонка в разделе «Шаблоны API» — его выберете при обзвоне.</li>
        </ol>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">API-ключ Звонопса</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={data?.has_api_key ? `Сохранён ··· ${data.api_key_tail}` : ''}
            className="input max-w-xl"
            autoComplete="off"
          />
          {data?.has_api_key && (
            <p className="text-xs text-gray-500 mt-1">
              Ключ уже сохранён. Оставьте поле пустым, чтобы не менять его.
            </p>
          )}
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={duty} onChange={e => setDuty(e.target.checked)} />
            Брать случайный номер из дежурных
          </label>
          <p className="text-xs text-gray-500 mt-1 ml-6">
            Если у вас в Звонопсе настроены дежурные номера — сервис сам выберет, с какого звонить.
          </p>
        </div>

        {!duty && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Номер, с которого звоним
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {phones === null ? (
                <>
                  <input
                    value={outgoing}
                    onChange={e => setOutgoing(e.target.value)}
                    placeholder="79161234567"
                    className="input max-w-xs"
                  />
                  <button
                    type="button"
                    onClick={loadPhones}
                    disabled={phonesLoading || !data?.has_api_key}
                    className="btn-primary text-sm disabled:opacity-50"
                  >
                    {phonesLoading ? 'Загружаем…' : 'Выбрать из аккаунта'}
                  </button>
                </>
              ) : (
                <select
                  value={outgoing}
                  onChange={e => setOutgoing(e.target.value)}
                  className="input max-w-md"
                >
                  <option value="">— выберите номер —</option>
                  {phones.map((p: any) => (
                    <option key={p.id} value={String(p.phone)} disabled={p.enable === false}>
                      {p.phone}{p.enable === false ? ' — не подтверждён' : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Номер должен быть подтверждён в кабинете Звонопса — иначе звонки не пойдут.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button onClick={save} disabled={saving} className="btn-gold disabled:opacity-50">
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button
            onClick={check}
            disabled={checking || (!data?.has_api_key && !apiKey.trim())}
            className="btn-primary text-sm disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
            {checking ? 'Проверяем…' : 'Проверить связь'}
          </button>
          {ok && <span className="text-sm text-green-600 inline-flex items-center gap-1"><Check size={14} />{ok}</span>}
        </div>

        {checkResult && (
          <div className={`rounded-xl p-3 text-sm border ${
            checkResult.ok ? 'bg-green-50 border-green-100 text-green-800'
                           : 'bg-amber-50 border-amber-100 text-amber-800'}`}>
            <div className="flex items-start gap-2">
              {checkResult.ok ? <Check size={16} className="mt-0.5 shrink-0" />
                              : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
              <div>
                <p>{checkResult.message}</p>
                {checkResult.ok && (
                  <p className="mt-0.5 text-xs">
                    Баланс: <b>{checkResult.balance ?? '—'} ₽</b>
                    {typeof checkResult.phones_count === 'number' && (
                      <> · номеров для звонка: <b>{checkResult.phones_count}</b></>
                    )}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl bg-red-50 border border-red-100 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {data?.is_configured && (
          <p className="text-xs text-gray-500">
            Всё подключено — обзвоны запускаются в разделе{' '}
            <a href="/dashboard/calls" className="text-blue-600 hover:underline">«Автообзвоны»</a>.
          </p>
        )}
      </div>
    </div>
  )
}
