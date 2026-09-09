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
  const [copied, setCopied] = useState(false)

  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<any>(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const d = await api.callSettings.get()
      setData(d)
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
    if (!apiKey.trim()) { setError('Введите API-ключ.'); return }
    setSaving(true); setError(''); setOk('')
    try {
      const d = await api.callSettings.update({ calls_calldog_api_key: apiKey.trim() })
      setData(d)
      setApiKey('')
      setOk('Сохранено')
      setTimeout(() => setOk(''), 2500)
    } catch (e: any) { setError(e.message) } finally { setSaving(false) }
  }

  function copyWebhook() {
    navigator.clipboard.writeText(data?.webhook_url || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
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
    <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
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
          <li>Возьмите <b>API-ключ</b> в разделе «API и интеграции» — и вставьте его ниже.</li>
          <li>Запишите аудиоролик в разделе «Аудиоролики» и отправьте на модерацию —
              проверяют один раз, дальше звонки уходят сразу.</li>
          <li>Создайте <b>шаблон</b> со сценарием: что говорит робот и что происходит
              по нажатию цифр. Его выберете при создании обзвона.</li>
          <li>В шаблоне у нажатия <b>1</b> добавьте действие «Вебхук» и вставьте
              адрес из поля ниже — тогда заинтересовавшиеся будут приходить вам
              уведомлением и отмечаться тегом.</li>
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

        {/* Адрес вебхука — клиент вписывает его в шаблоне Звонопса у действия
            по нажатию «1». Подставить за него нельзя: шаблон в их кабинете. */}
        <div className="rounded-xl border border-gray-200 p-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Вебхук для уведомлений
          </label>
          <p className="text-xs text-gray-500 mb-2 leading-snug">
            Разместите этот адрес в шаблоне Звонопса — в действии по нажатию <b>1</b>
            («Действия» → «Вебхук»). Тогда, как только человек нажмёт 1, вам придёт
            уведомление в канал, а контакту проставится тег{' '}
            <code className="bg-gray-100 px-1 rounded">{data?.interest_tag || 'звонок_конфа_интерес'}</code>.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              readOnly
              value={data?.webhook_url || ''}
              onFocus={e => e.currentTarget.select()}
              className="input flex-1 min-w-0 text-xs font-mono bg-gray-50"
            />
            <button type="button" onClick={copyWebhook} className="btn-primary text-sm shrink-0">
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
          </div>
        </div>

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
