'use client'

/**
 * Вкладка «Платёжные системы» (миграция 257).
 *
 * Клиент подключает СВОЙ кабинет платёжной системы — деньги за тарифы его
 * событий идут ему. Нужно всего два значения из кабинета LeadPay:
 * «Настройки → Для внешних систем» → адрес лендинга и секретный ключ.
 *
 * Вебхук настраивать не нужно: его адрес мы передаём сами в каждом запросе
 * за ссылкой оплаты.
 */
import { useEffect, useState } from 'react'
import { Loader2, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

export default function PaymentSettingsTab() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [denied, setDenied] = useState(false)
  const [data, setData] = useState<any>(null)
  const [login, setLogin] = useState('')
  const [token, setToken] = useState('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  // Куда слать уведомления об оплатах: у каждой площадки свой канал.
  const [me, setMe] = useState<any>(null)
  const [notifyTab, setNotifyTab] = useState<'telegram' | 'vk' | 'max'>('telegram')
  const [notify, setNotify] = useState({
    payments_telegram_chat_id: '',
    payments_max_chat_id: '',
    payments_vk_peer_id: '',
  })
  const [notifySaving, setNotifySaving] = useState(false)

  const load = async () => {
    try {
      const res = await api.paymentSettings.get()
      setData(res)
      setLogin(res.pay_leadpay_login || '')
    } catch (e: any) {
      if (String(e?.message || '').includes('недоступен')) setDenied(true)
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    api.auth.me().then((m: any) => {
      setMe(m)
      setNotify({
        payments_telegram_chat_id: m?.payments_telegram_chat_id || '',
        payments_max_chat_id: m?.payments_max_chat_id || '',
        payments_vk_peer_id: m?.payments_vk_peer_id || '',
      })
    }).catch(() => {})
  }, [])

  const saveNotify = async () => {
    setNotifySaving(true)
    try {
      await api.auth.updateMe(notify)
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally { setNotifySaving(false) }
  }

  const save = async (patch: any) => {
    setSaving(true)
    setResult(null)
    try {
      const res = await api.paymentSettings.update(patch)
      setData(res)
      // Ключ обратно не приходит — очищаем поле, чтобы не смущал плейсхолдер.
      if (patch.pay_leadpay_token !== undefined) setToken('')
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  const check = async () => {
    setChecking(true)
    setResult(null)
    try {
      const res = await api.paymentSettings.check({
        pay_leadpay_login: login || undefined,
        pay_leadpay_token: token || undefined,
      })
      setResult(res)
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || 'Не удалось проверить' })
    } finally { setChecking(false) }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Загружаем…
      </div>
    )
  }

  if (denied) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 text-gray-600">
        Раздел «Платёжные системы» недоступен на вашем тарифе.
      </div>
    )
  }

  const on = data?.pay_provider === 'leadpay'

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Приём оплаты за тарифы</h2>
        <p className="mt-1 text-sm text-gray-500">
          Подключите свой кабинет платёжной системы — деньги за тарифы ваших
          событий будут приходить вам напрямую.
        </p>
      </div>

      {/* Состояние */}
      <div className={`flex items-start gap-3 rounded-xl border p-4 ${
        data?.is_configured
          ? 'border-green-200 bg-green-50'
          : 'border-amber-200 bg-amber-50'
      }`}>
        {data?.is_configured
          ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
          : <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />}
        <div className="text-sm">
          {data?.is_configured ? (
            <>
              <div className="font-medium text-green-900">Подключено</div>
              <div className="mt-0.5 text-green-800">
                В тарифах указывайте код товара — заказы и оплаты будут
                отмечаться сами.
              </div>
            </>
          ) : (
            <>
              <div className="font-medium text-amber-900">Не подключено</div>
              <div className="mt-0.5 text-amber-800">
                Пока в тарифах работает внешняя ссылка на оплату, а оплаты
                придётся отмечать вручную.
              </div>
            </>
          )}
        </div>
      </div>

      {/* Выбор системы */}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          Платёжная система
        </label>
        <select
          value={data?.pay_provider || ''}
          onChange={e => save({ pay_provider: e.target.value || null })}
          className="input bg-white"
        >
          <option value="">Не подключена</option>
          <option value="leadpay">LeadPay</option>
        </select>
      </div>

      {on && (
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm text-gray-600">
            Оба значения — в кабинете LeadPay:{' '}
            <a href="https://app.leadpay.ru" target="_blank" rel="noreferrer"
               className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
              Настройки → Для внешних систем <ExternalLink className="h-3 w-3" />
            </a>
          </p>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Адрес лендинга (Логин)
            </label>
            {/* ⚠️ Автозаполнение выключено: Chrome принимал пару полей за
                форму входа и подставлял сюда имя менеджера паролей, а в ключ —
                сохранённый пароль. name с случайной частью — браузер не
                узнаёт поле по имени. */}
            <input
              type="text" value={login}
              onChange={e => setLogin(e.target.value)}
              autoComplete="off" name="lp-login-x" data-lpignore="true"
              data-1p-ignore="true" data-form-type="other"
              placeholder="https://app.leadpay.ru/23382/"
              className="input font-mono text-[13px]"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Секретный ключ
            </label>
            <input
              type="text" value={token}
              onChange={e => setToken(e.target.value)}
              autoComplete="off" name="lp-secret-x" data-lpignore="true"
              data-1p-ignore="true" data-form-type="other"
              spellCheck={false}
              placeholder={data?.has_token ? `сохранён, оканчивается на ${data.token_tail}` : 'вставьте ключ'}
              className="input font-mono text-[13px]"
            />
            <p className="mt-1 text-xs text-gray-500">
              Храним у себя и наружу не показываем. Вебхук настраивать не нужно —
              его адрес мы передаём сами.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => save({
                pay_leadpay_login: login.trim(),
                ...(token.trim() ? { pay_leadpay_token: token.trim() } : {}),
              })}
              disabled={saving || checking}
              className="btn-primary disabled:opacity-60"
            >
              Сохранить
            </button>
            <button
              onClick={check} disabled={checking || saving}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              {checking && <Loader2 className="h-4 w-4 animate-spin" />}
              Проверить связь
            </button>
            {saving && (
              <span className="inline-flex items-center gap-1.5 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Сохраняем…
              </span>
            )}
          </div>

          {result && (
            <div className={`rounded-lg p-3 text-sm ${
              result.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'
            }`}>
              {result.message}
            </div>
          )}
        </div>
      )}

      {/* Куда сообщать об оплатах. Отдельно от общего канала уведомлений:
          там оплаты теряются среди «новых интересов» и вопросов. */}
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-1 font-medium text-gray-800">Куда сообщать об оплатах</div>
        <p className="mb-3 text-sm text-gray-500">
          Ваш бот пришлёт сюда каждый новый заказ и каждую оплату: событие,
          тариф, сумма и контакты покупателя. Не заполните — уведомления пойдут
          в общий канал из «Технических» настроек.
        </p>

        <div className="mb-3 flex gap-1 border-b border-gray-200">
          {([
            ['telegram', 'Telegram'], ['vk', 'ВКонтакте'], ['max', 'MAX'],
          ] as const).map(([k, label]) => {
            const filled = k === 'telegram' ? notify.payments_telegram_chat_id
              : k === 'vk' ? notify.payments_vk_peer_id : notify.payments_max_chat_id
            return (
              <button
                key={k}
                onClick={() => setNotifyTab(k as any)}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium ${
                  notifyTab === k ? 'border-brand text-brand'
                                  : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
                {!!filled && <span className="h-1.5 w-1.5 rounded-full bg-green-500" />}
              </button>
            )
          })}
        </div>

        {notifyTab === 'telegram' && (
          <NotifyField
            label="ID канала или чата в Telegram"
            value={notify.payments_telegram_chat_id}
            onChange={v => setNotify(n => ({ ...n, payments_telegram_chat_id: v }))}
            placeholder="-1001234567890"
          />
        )}
        {notifyTab === 'vk' && (
          <NotifyField
            label="ID беседы во ВКонтакте"
            value={notify.payments_vk_peer_id}
            onChange={v => setNotify(n => ({ ...n, payments_vk_peer_id: v }))}
            placeholder="2000000001"
          />
        )}
        {notifyTab === 'max' && (
          <NotifyField
            label="ID чата в MAX"
            value={notify.payments_max_chat_id}
            onChange={v => setNotify(n => ({ ...n, payments_max_chat_id: v }))}
            placeholder="-70123456789"
          />
        )}

        <div className="mt-3 flex items-center gap-3">
          <button onClick={saveNotify} disabled={notifySaving}
                  className="btn-primary disabled:opacity-60">
            {notifySaving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <span className="text-xs text-gray-500">
            Добавьте своего бота в канал и отправьте там команду /getmyid — он
            покажет нужный ID.
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
        <div className="mb-1 font-medium text-gray-800">Как это работает</div>
        Человек выбирает тариф на лендинге → заполняет короткую форму →
        попадает на оплату. После оплаты платёжная система сообщает нам об
        этом, участник отмечается оплатившим, а сумма видна в списке
        участников. Ничего отмечать вручную не нужно.
      </div>
    </div>
  )
}

function NotifyField({
  label, value, onChange, placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <input
        type="text" value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="input font-mono text-[13px]"
      />
    </div>
  )
}
