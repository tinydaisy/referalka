'use client'

import FeatureLock from '@/components/FeatureLock'

/**
 * Вкладка «Платёжные системы» (миграция 257).
 *
 * Клиент подключает СВОЙ кабинет платёжной системы — деньги за тарифы его
 * событий идут ему. Поддержаны LeadPay, Продамус (миграция 269) и эквайринг
 * Т-Банка (миграция 276); всюду нужно два значения из кабинета системы.
 *
 * Вебхук настраивать не нужно ни в одной: его адрес мы передаём сами вместе
 * с заказом.
 *
 * ⚠️ У Т-Банка тестовый терминал — ОТДЕЛЬНАЯ пара ключей, а не режим в
 * запросе. Держим обе пары рядом и переключаем галочкой: иначе после проверки
 * клиент стирал бы тестовые ключи, и вернуться к проверке было бы нечем.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, CheckCircle2, AlertCircle, ExternalLink, BookOpen, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'

/**
 * Ссылка на пошаговую инструкцию по своей платёжной системе.
 *
 * ⚠️ Нарочно яркая, золотом и первой строкой блока: человек открывает форму,
 * видит два пустых поля и не знает, где брать значения — «я что, экстрасенс?»
 * (владелец, 17.09.2026). Неприметная серая ссылка внизу эту задачу не решает.
 */
function HelpLink({ href, title }: { href: string; title: string }) {
  return (
    <Link
      href={href}
      className="flex items-start gap-3 rounded-xl border-2 p-3 transition-colors hover:brightness-95"
      style={{ borderColor: '#FFCFA4', background: 'rgba(255,207,164,0.25)' }}
    >
      <BookOpen className="mt-0.5 h-5 w-5 shrink-0" style={{ color: '#25455D' }} />
      <span className="flex-1 text-sm font-semibold leading-snug" style={{ color: '#25455D' }}>
        Инструкция по настройке — {title}
      </span>
      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" style={{ color: '#25455D' }} />
    </Link>
  )
}

export default function PaymentSettingsTab() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [denied, setDenied] = useState(false)
  const [data, setData] = useState<any>(null)
  const [login, setLogin] = useState('')
  const [token, setToken] = useState('')
  // Продамус: адрес формы оплаты и секретный ключ магазина.
  const [pdUrl, setPdUrl] = useState('')
  const [pdSecret, setPdSecret] = useState('')
  // Т-Банк: две пары ключей (боевая и тестовая) + режим работы.
  const [tbKey, setTbKey] = useState('')
  const [tbPass, setTbPass] = useState('')
  const [tbTestKey, setTbTestKey] = useState('')
  const [tbTestPass, setTbTestPass] = useState('')
  const [tbTest, setTbTest] = useState(false)
  const [tbTax, setTbTax] = useState('')
  const [tbVat, setTbVat] = useState('')
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
      setPdUrl(res.pay_prodamus_url || '')
      setTbKey(res.pay_tbank_terminal_key || '')
      setTbTestKey(res.pay_tbank_test_terminal_key || '')
      setTbTest(!!res.pay_tbank_test_mode)
      setTbTax(res.pay_tbank_taxation || '')
      setTbVat(res.pay_tbank_vat || '')
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
      // Ключи обратно не приходят — очищаем поля, чтобы не смущал плейсхолдер.
      if (patch.pay_leadpay_token !== undefined) setToken('')
      if (patch.pay_prodamus_secret !== undefined) setPdSecret('')
      if (patch.pay_tbank_password !== undefined) setTbPass('')
      if (patch.pay_tbank_test_password !== undefined) setTbTestPass('')
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  const check = async () => {
    setChecking(true)
    setResult(null)
    try {
      const res = await api.paymentSettings.check({
        pay_provider: data?.pay_provider || undefined,
        pay_leadpay_login: login || undefined,
        pay_leadpay_token: token || undefined,
        pay_prodamus_url: pdUrl || undefined,
        pay_prodamus_secret: pdSecret || undefined,
        pay_tbank_terminal_key: tbKey || undefined,
        pay_tbank_password: tbPass || undefined,
        pay_tbank_test_terminal_key: tbTestKey || undefined,
        pay_tbank_test_password: tbTestPass || undefined,
        // ⚠️ Режим шлём всегда: клиент жмёт «Проверить» сразу после
        // переключения галочки, и проверить надо НОВЫЙ режим, а не сохранённый.
        pay_tbank_test_mode: tbTest,
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
    // ⚠️ Не просто «недоступно»: показываем ЧТО подключить и ведём туда,
    // где это делается. Название возможности берётся из справочника фич —
    // в коде тарифов не хардкодим.
    return (
      <div className="max-w-2xl space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Приём оплаты за тарифы</h2>
          <p className="mt-1 text-sm text-gray-500">
            Здесь подключается платёжная система, через которую участники
            оплачивают платные тарифы ваших событий.
          </p>
        </div>
        <FeatureLock anyOf={['payments']} />
      </div>
    )
  }

  const provider = data?.pay_provider || ''

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
                {data?.needs_product_id
                  ? 'В тарифах указывайте код товара — заказы и оплаты будут отмечаться сами.'
                  : 'Заказы и оплаты будут отмечаться сами — от вас нужны только название и сумма тарифа.'}
              </div>
            </>
          ) : (
            <>
              <div className="font-medium text-amber-900">Платёжная система не подключена</div>
              <div className="mt-0.5 text-amber-800">
                Продавать всё равно можно: в каждом тарифе есть поле для ссылки
                на оплату — вставьте туда ссылку на свою платёжную страницу или
                счёт. Человек оплатит там, а вы отметите оплату руками в списке
                заказов. Подключите систему ниже — и заказы начнут отмечаться
                оплаченными сами.
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
          <option value="prodamus">Продамус</option>
          <option value="tbank">Эквайринг Т-Банка</option>
        </select>
      </div>

      {/* Система ещё не выбрана — показываем инструкции по всем трём сразу:
          иначе выбирать приходится вслепую, а инструкции спрятаны за выбором. */}
      {!provider && (
        <div className="space-y-2 rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-1 font-medium text-gray-800">
            Выберите систему — или сначала почитайте, как подключается каждая
          </div>
          <p className="mb-3 text-sm text-gray-500">
            Во всех трёх нужны два значения из вашего кабинета. Где их брать —
            расписано по шагам.
          </p>
          <HelpLink href="/dashboard/help/pay-prodamus" title="как подключить Продамус" />
          <HelpLink href="/dashboard/help/pay-leadpay" title="как подключить LeadPay" />
          <HelpLink href="/dashboard/help/pay-tbank" title="как подключить эквайринг Т-Банка" />
        </div>
      )}

      {provider === 'tbank' && tbTest && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-medium">Включён тестовый терминал</div>
          <div className="mt-0.5">
            Оплаты проходят понарошку, деньги вам не приходят. Закончите
            проверку — снимите галочку, иначе настоящие покупатели заплатят
            в никуда.
          </div>
        </div>
      )}

      {provider === 'leadpay' && (
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
          <HelpLink href="/dashboard/help/pay-leadpay" title="как подключить LeadPay" />

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

          {/* ⚠️⚠️ БЕЗ ЭТОЙ НАСТРОЙКИ ОПЛАТА НЕ ОТКРОЕТСЯ. LeadPay берёт способы
              приёма денег из карточки товара; когда мы передаём цену напрямую
              (а так работают скидки и промокоды), карточки нет — и способы
              нужно один раз выбрать в разделе «Настройки методов оплат для
              интеграции». Не сделано → человек видит у них «нет подходящих
              форм оплаты» и уходит, а в кабинете всё выглядит исправным.
              Стоило дня разбирательств 15.09.2026 — поэтому написано прямо
              здесь, а не в инструкции, куда никто не заглянет. */}
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm font-medium text-amber-900">
              Один раз включите способы оплаты в LeadPay
            </p>
            <p className="mt-1 text-xs text-amber-800">
              В кабинете LeadPay откройте <b>Настройки → Варианты оплаты</b> и
              отметьте, чем можно платить (карта, СБП и прочее).{' '}
              <a href="https://lead-pay001.cloud.gram.ax/LeadPay/integracii/nastroyki-metodov-oplat-dlya-integracii"
                 target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1 font-medium underline">
                Их инструкция <ExternalLink className="h-3 w-3" />
              </a>
            </p>
            <p className="mt-2 text-xs text-amber-800">
              Пока это не сделано, покупатель на странице оплаты увидит
              «нет подходящих форм оплаты» — даже если у вас всё настроено верно.
              После этого оплата работает <b>на любую сумму и без кодов товара</b>,
              а значит заработают скидки и промокоды.
            </p>
          </div>

          {/* ⚠️ Та же таблица «что в каком поле их кабинета», что и у
              Продамуса — требование владельца 17.09.2026: писать на фронте,
              а не в инструкции. У LeadPay адреса возврата и уведомления тоже
              уходят в запросе (`notification_url`, `redirect_url_ok/error`),
              поэтому в кабинете их настраивать не надо вовсе. Единственное,
              что там ОБЯЗАТЕЛЬНО — варианты оплаты (см. плашку выше). */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="text-sm font-medium text-gray-800">
              Что заполнять в самом кабинете LeadPay
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs text-gray-700">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="py-1 pr-3 font-semibold">Что у них</th>
                    <th className="py-1 font-semibold">Что делать</th>
                  </tr>
                </thead>
                <tbody className="align-top">
                  <tr className="border-b border-gray-100">
                    <td className="py-1.5 pr-3">Настройки → Варианты оплаты</td>
                    <td className="py-1.5">
                      <b>обязательно отметить</b> карту, СБП и остальное — без
                      этого оплата не откроется
                    </td>
                  </tr>
                  <tr className="border-b border-gray-100">
                    <td className="py-1.5 pr-3">Адреса возврата и уведомлений</td>
                    <td className="py-1.5">не трогать — передаём сами с каждым заказом</td>
                  </tr>
                  <tr className="border-b border-gray-100">
                    <td className="py-1.5 pr-3">Карточки товаров</td>
                    <td className="py-1.5">
                      не заводить — название и цену берём из вашего тарифа
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-3">Их промокоды</td>
                    <td className="py-1.5">
                      не работают через интеграцию — пользуйтесь нашими,
                      во вкладке «Промокоды»
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
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

      {provider === 'prodamus' && (
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
          <HelpLink href="/dashboard/help/pay-prodamus" title="как подключить Продамус" />

          <p className="text-sm text-gray-600">
            Оба значения берутся в вашем кабинете{' '}
            <a href="https://prodamus.ru" target="_blank" rel="noreferrer"
               className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
              Продамуса <ExternalLink className="h-3 w-3" />
            </a>
            . Где именно — расписано в инструкции выше.
          </p>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Адрес формы оплаты
            </label>
            {/* ⚠️ Автозаполнение выключено: Chrome принимал пару полей за
                форму входа и подставлял сюда имя менеджера паролей, а в ключ —
                сохранённый пароль. */}
            <input
              type="text" value={pdUrl}
              onChange={e => setPdUrl(e.target.value)}
              autoComplete="off" name="pd-url-x" data-lpignore="true"
              data-1p-ignore="true" data-form-type="other"
              placeholder="https://вашмагазин.payform.ru/"
              className="input font-mono text-[13px]"
            />
            <p className="mt-1 text-xs text-gray-500">
              Тот самый адрес, по которому открывается ваша платёжная форма.
              Откройте свою форму в браузере и скопируйте адрес из адресной
              строки — до первого «/» после названия магазина.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Секретный ключ
            </label>
            <input
              type="text" value={pdSecret}
              onChange={e => setPdSecret(e.target.value)}
              autoComplete="off" name="pd-secret-x" data-lpignore="true"
              data-1p-ignore="true" data-form-type="other"
              spellCheck={false}
              placeholder={data?.has_prodamus_secret
                ? `сохранён, оканчивается на ${data.prodamus_secret_tail}`
                : 'вставьте ключ'}
              className="input font-mono text-[13px]"
            />
            <p className="mt-1 text-xs text-gray-500">
              В кабинете Продамуса: <b>Настройки → Настройки уведомлений →
              Секретный ключ</b> (в старых кабинетах раздел называется
              «Интеграции»). Храним у себя и наружу не показываем. Вебхук в
              Продамусе настраивать не нужно — его адрес мы передаём сами
              с каждым заказом.
            </p>
          </div>

          {/* ⚠️⚠️ Таблица «что в каком поле» — ПРЯМО ЗДЕСЬ, а не в инструкции
              (требование владельца 17.09.2026, дословно: «в инструкции нет —
              на фронте: что впишите, то-то и туда»).

              Повод: вписала «URL адреса для уведомлений» руками и попала на
              приёмник оплаты ПОДПИСКИ (/integrations/prodamus/webhook) вместо
              тарифов событий (/integrations/client-pay/prodamus) — оплата бы
              прошла, а участник не отметился.

              ⚠️ Success/Fail URL кабинета трогать НЕ надо: для тарифов мы шлём
              свои в самой ссылке (urlSuccess/urlReturn в `_prodamus_link`),
              они перекрывают настройки кабинета. А в кабинете стоят адреса
              под оплату подписки на ПЛЮСОН — сотрёшь, сломается подписка. */}
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm font-medium text-amber-900">
              Что заполнять в самом кабинете Продамуса
            </p>
            <p className="mt-1 text-xs text-amber-800">
              Раздел <b>Настройки → Настройка адресов и уведомлений</b>:
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs text-amber-900">
                <thead>
                  <tr className="border-b border-amber-200">
                    <th className="py-1 pr-3 font-semibold">Поле у них</th>
                    <th className="py-1 font-semibold">Что делать</th>
                  </tr>
                </thead>
                <tbody className="align-top">
                  <tr className="border-b border-amber-100">
                    <td className="py-1.5 pr-3">Success URL</td>
                    <td className="py-1.5">оставить как есть, не трогать</td>
                  </tr>
                  <tr className="border-b border-amber-100">
                    <td className="py-1.5 pr-3">Fail URL</td>
                    <td className="py-1.5">оставить как есть, не трогать</td>
                  </tr>
                  <tr className="border-b border-amber-100">
                    <td className="py-1.5 pr-3">URL адреса для уведомлений</td>
                    <td className="py-1.5">
                      <b>очистить</b> — кнопка с корзиной справа от поля
                    </td>
                  </tr>
                  <tr className="border-b border-amber-100">
                    <td className="py-1.5 pr-3">e-mail адреса</td>
                    <td className="py-1.5">ваша почта — или пусто, как удобно</td>
                  </tr>
                  <tr className="border-b border-amber-100">
                    <td className="py-1.5 pr-3">номера телефонов</td>
                    <td className="py-1.5">пусто</td>
                  </tr>
                  {/* ⚠️ Деморежим Продамуса — единственный способ проверить
                      секретный ключ без денег: по сети он не проверяется
                      (см. check_prodamus_credentials). Включается на ВСЮ форму,
                      то есть и на оплату подписки тоже — отсюда предупреждение
                      снять после проверки. */}
                  <tr>
                    <td className="py-1.5 pr-3">
                      Настройка формы → «Деморежим без приёма оплаты»
                    </td>
                    <td className="py-1.5">
                      удобно для проверки: оплата понарошку картой{' '}
                      <span className="font-mono">4111 1111 1111 1111</span>,
                      срок 12/24, CVV 123, дальше выбрать «Success».{' '}
                      <b>После проверки обязательно выключите</b> — иначе
                      настоящие покупатели заплатить не смогут
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-amber-800">
              Почему так: все три адреса — куда вернуть покупателя и куда
              сообщить об оплате — мы передаём <b>сами с каждым заказом</b>,
              и они перекрывают настройки кабинета. А вписанный руками адрес
              уведомлений попадает не в тот приёмник: покупатель заплатит,
              а участником не отметится.
            </p>
          </div>

          <div className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
            Товары в Продамусе заводить не нужно: название и сумму мы берём
            из вашего тарифа и передаём прямо в ссылку на оплату.
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => save({
                pay_prodamus_url: pdUrl.trim(),
                ...(pdSecret.trim() ? { pay_prodamus_secret: pdSecret.trim() } : {}),
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

      {provider === 'tbank' && (
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
          <HelpLink href="/dashboard/help/pay-tbank" title="как подключить эквайринг Т-Банка" />

          <p className="text-sm text-gray-600">
            Оба значения — в кабинете Т-Бизнеса:{' '}
            <a href="https://business.tbank.ru" target="_blank" rel="noreferrer"
               className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
              Магазины → Терминалы <ExternalLink className="h-3 w-3" />
            </a>
            {' '}Там же рядом лежат ключи тестового терминала.
          </p>

          {/* Боевые ключи */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Terminal Key (боевой)
            </label>
            {/* ⚠️ Автозаполнение выключено: Chrome принимает пару полей за
                форму входа и подставляет в ключ сохранённый пароль. */}
            <input
              type="text" value={tbKey}
              onChange={e => setTbKey(e.target.value)}
              autoComplete="off" name="tb-key-x" data-lpignore="true"
              data-1p-ignore="true" data-form-type="other"
              placeholder="1234567890123"
              className="input font-mono text-[13px]"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Пароль терминала (боевой)
            </label>
            <input
              type="text" value={tbPass}
              onChange={e => setTbPass(e.target.value)}
              autoComplete="off" name="tb-pass-x" data-lpignore="true"
              data-1p-ignore="true" data-form-type="other"
              spellCheck={false}
              placeholder={data?.has_tbank_password
                ? `сохранён, оканчивается на ${data.tbank_password_tail}`
                : 'вставьте пароль'}
              className="input font-mono text-[13px]"
            />
            <p className="mt-1 text-xs text-gray-500">
              Храним у себя и наружу не показываем. Вебхук в Т-Банке настраивать
              не нужно — его адрес мы передаём сами с каждым заказом.
            </p>
          </div>

          {/* Тестовый терминал */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox" checked={tbTest}
                onChange={e => setTbTest(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
              />
              <span className="text-sm">
                <span className="font-medium text-gray-800">
                  Работать на тестовом терминале
                </span>
                <span className="mt-0.5 block text-gray-500">
                  Проверка без настоящих денег. Ключи тестового терминала — свои,
                  их выдаёт Т-Банк в том же разделе кабинета.
                </span>
              </span>
            </label>

            {tbTest && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Terminal Key (тестовый)
                  </label>
                  <input
                    type="text" value={tbTestKey}
                    onChange={e => setTbTestKey(e.target.value)}
                    autoComplete="off" name="tb-tkey-x" data-lpignore="true"
                    data-1p-ignore="true" data-form-type="other"
                    placeholder="1234567890123DEMO"
                    className="input font-mono text-[13px]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Пароль терминала (тестовый)
                  </label>
                  <input
                    type="text" value={tbTestPass}
                    onChange={e => setTbTestPass(e.target.value)}
                    autoComplete="off" name="tb-tpass-x" data-lpignore="true"
                    data-1p-ignore="true" data-form-type="other"
                    spellCheck={false}
                    placeholder={data?.has_tbank_test_password
                      ? `сохранён, оканчивается на ${data.tbank_test_password_tail}`
                      : 'вставьте пароль'}
                    className="input font-mono text-[13px]"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Чек. Нужен, только если у клиента подключён сервис «Чеки». */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Система налогообложения
              </label>
              <select value={tbTax} onChange={e => setTbTax(e.target.value)}
                      className="input bg-white">
                <option value="">УСН «Доходы» (по умолчанию)</option>
                {Object.entries(data?.tbank_taxations || {}).map(([k, v]) => (
                  <option key={k} value={k}>{String(v)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Ставка НДС
              </label>
              <select value={tbVat} onChange={e => setTbVat(e.target.value)}
                      className="input bg-white">
                <option value="">Без НДС (по умолчанию)</option>
                {Object.entries(data?.tbank_vats || {}).map(([k, v]) => (
                  <option key={k} value={k}>{String(v)}</option>
                ))}
              </select>
            </div>
          </div>

          {/* ⚠️ Та же таблица «что в каком поле их кабинета», что и у двух
              других систем — требование владельца 17.09.2026. У Т-Банка
              NotificationURL/SuccessURL/FailURL тоже уходят в запросе Init,
              настройки терминала перекрываются. */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="text-sm font-medium text-gray-800">
              Что заполнять в самом кабинете Т-Бизнеса
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs text-gray-700">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="py-1 pr-3 font-semibold">Что у них</th>
                    <th className="py-1 font-semibold">Что делать</th>
                  </tr>
                </thead>
                <tbody className="align-top">
                  <tr className="border-b border-gray-100">
                    <td className="py-1.5 pr-3">
                      Notification URL, Success URL, Fail URL у терминала
                    </td>
                    <td className="py-1.5">не трогать — передаём сами с каждым заказом</td>
                  </tr>
                  <tr className="border-b border-gray-100">
                    <td className="py-1.5 pr-3">Товары, витрина</td>
                    <td className="py-1.5">
                      не заводить — название и сумму берём из вашего тарифа
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-3">Сервис «Чеки от Т-Бизнеса»</td>
                    <td className="py-1.5">
                      по желанию. Включите у них — банк сам выдаст покупателю
                      чек, а здесь заполните налогообложение и НДС
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
            Товары в Т-Банке заводить не нужно: название и сумму мы берём из
            вашего тарифа и передаём прямо в запрос на оплату. Если у вас
            подключён сервис «Чеки от Т-Бизнеса», банк выдаст покупателю чек
            сам — для этого и нужны налогообложение со ставкой НДС.
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => save({
                pay_tbank_terminal_key: tbKey.trim(),
                ...(tbPass.trim() ? { pay_tbank_password: tbPass.trim() } : {}),
                pay_tbank_test_terminal_key: tbTestKey.trim(),
                ...(tbTestPass.trim() ? { pay_tbank_test_password: tbTestPass.trim() } : {}),
                pay_tbank_test_mode: tbTest,
                pay_tbank_taxation: tbTax || null,
                pay_tbank_vat: tbVat || null,
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
            покажет нужный ID. Обратите внимание: у вас как администратора должна
            быть выключена анонимность, иначе бот не увидит, кто пишет.
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
