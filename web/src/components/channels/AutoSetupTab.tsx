'use client'

/**
 * Автонастройка Telegram «под ключ» — вкладка в разделе «Каналы» (миграция 364).
 *
 * Клиент вводит имя будущего бота, оплачивает разовую услугу и видит живой
 * статус: создаём бота → привязываем приложение → заводим группу → передаём
 * права. Дальше два его действия — зайти в бота и вступить в группу.
 *
 * ⚠️ Экран сам обновляется раз в 5 секунд, пока настройка идёт. Без этого
 * клиент смотрит в застывший экран и решает, что услуга не работает.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'
import {
  AUTOSETUP_STEPS, AUTOSETUP_FROM_CLIENT, AUTOSETUP_NOT_INCLUDED,
} from '@/lib/autosetupSteps'
import {
  AlertTriangle, ArrowRight, Check, Clock, Copy, Loader2, XCircle,
  MessageSquare, Sparkles, Users,
} from 'lucide-react'

type Step = { at: string; step: string; ok: boolean; text: string }
type Order = {
  id: number
  status: string
  setup_state: string
  setup_error?: string | null
  setup_log?: Step[]
  bot_username?: string | null
  bot_title?: string | null
  group_invite_link?: string | null
  claim_deadline?: string | null
  steps?: Record<string, boolean>
}
type State = {
  service: {
    name: string; tagline?: string; description?: string
    bullet_points: string[]; price: number
    coming_soon: boolean; payable: boolean
  }
  order?: Order
  queue_position?: number | null
  /** Сколько всего задач сейчас в очереди и в работе (по всей платформе). */
  queue_total?: number | null
  telegram_username?: string | null
  /** Заполнена ли «Служба заботы» — по ней решаем, подставлять ли туда ник. */
  support_filled?: boolean
  suggestions: string[]
  claim_days: number
}

// Пока настройка идёт — обновляем экран часто; когда всё замерло — редко.
const POLL_ACTIVE_MS = 5000
const POLL_IDLE_MS = 30000

export default function AutoSetupTab() {
  const [state, setState] = useState<State | null>(null)
  const [loading, setLoading] = useState(true)
  const [username, setUsername] = useState('')
  const [title, setTitle] = useState('')
  const [checking, setChecking] = useState(false)
  const [nameCheck, setNameCheck] = useState<{ free: boolean; message: string } | null>(null)
  const [starting, setStarting] = useState(false)
  /**
   * Услуга ещё не открыта этому кабинету (ручка ответила 403).
   *
   * ⚠️ Это НЕ ошибка: пока идёт обкатка, услуга раздаётся по коду доступа,
   * и у большинства кабинетов её нет. Раньше такой ответ глотался молча, и
   * вкладка рисовала пустоту — человек видел белый экран без объяснений.
   */
  const [noAccess, setNoAccess] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true)
      const data = await api.tgAutosetup.get()
      setState(data)
      setNoAccess(false)
      if (!username && data?.suggestions?.length) setUsername(data.suggestions[0])
    } catch (e: any) {
      // 403 — доступа нет: показываем экран с вводом кода, а не пустоту.
      // Сверяем по КОДУ ответа, а не по тексту: текст правится в бэкенде
      // без оглядки на фронт, и проверка по нему тихо перестанет срабатывать.
      if (e?.status === 403) setNoAccess(true)
    } finally {
      setLoading(false)
    }
  }, [username])

  /**
   * Ник в Telegram — правится ПРЯМО ЗДЕСЬ, а не в Настройках.
   *
   * ⚠️ Раньше здесь висела плашка «укажите ник в Настройках»: человек уходил
   * в другой раздел, искал нужную вкладку и часто не возвращался. Поле в
   * кабинете НЕобязательное и лежит отдельно — значит закрыть этот пробел
   * должна сама настройка «под ключ», раз без ника права передать некому.
   *
   * ⚠️ Сохраняется СРАЗУ в двух местах: ник профиля и «Служба заботы»
   * (см. saveNick) — иначе останется незаполненным то, ради чего услуга
   * и делается.
   */
  // ⚠️ `null` = поле не трогали, показываем ник из настроек. Пустая строка —
  // это «стёрли руками», и её нельзя путать с «не редактировали».
  const [nick, setNick] = useState<string | null>(null)
  const [savingNick, setSavingNick] = useState(false)
  const [nickSaved, setNickSaved] = useState(false)
  const [nickError, setNickError] = useState<string | null>(null)

  const saveNick = async () => {
    const value = (nick ?? '').trim().replace(/^@/, '')
    if (!value) return
    setSavingNick(true); setNickError(null); setNickSaved(false)
    try {
      // ⚠️ Пишем ник профиля (по нему передаются права на бота) и заодно
      // «Службу заботы» — по ней работают /support в ботах, кнопка
      // «Тех. поддержка» на лендинге и в рассылках, подпись в письмах.
      // Ссылкой, а не ником: так это поле заполняется во всём проекте.
      //
      // ⚠️ Службу заботы трогаем ТОЛЬКО когда она пуста: у части клиентов
      // поддержку ведёт отдельный аккаунт, и затирать его настройку нельзя.
      await api.auth.updateMe({
        telegram_username: value,
        ...(state?.support_filled
          ? {}
          : { work_tg_username: `https://telegram.me/${value}` }),
      })
      setNickSaved(true)
      await load(true)
    } catch (e: any) {
      setNickError(e?.message || 'Не удалось сохранить')
    } finally {
      setSavingNick(false)
    }
  }

  // ⚠️ Ввода кода здесь НЕТ: он живёт в ОДНОМ месте — в карточке услуги на
  // странице «Подписка». Держать вторую форму значило бы чинить обе.

  /**
   * Отметки «я это сделал» — их ставит сам клиент.
   *
   * ⚠️ Нужны потому, что автоматика срабатывает не всегда: бот услуги не
   * слушается процессом до его перезапуска, а вступление в группу проходит
   * мимо нас, если человек вступил сам (у большинства закрыты настройки
   * приватности, и добавить его мы не можем). По этим отметкам фоновая задача
   * передаёт права.
   */
  const [confirming, setConfirming] = useState<'bot' | 'group' | 'channel' | null>(null)

  const confirmStep = async (step: 'bot' | 'group' | 'channel') => {
    setConfirming(step)
    try {
      if (step === 'bot') await api.tgAutosetup.confirmStartedBot()
      else if (step === 'group') await api.tgAutosetup.confirmJoinedGroup()
      else await api.tgAutosetup.confirmChannel()
      await load(true)
    } catch (e: any) {
      alert(e?.message || 'Не удалось отметить шаг')
    } finally {
      setConfirming(null)
    }
  }

  /** Передать права немедленно — кнопка в конце списка действий. */
  const [transferring, setTransferring] = useState(false)
  const transferNow = async () => {
    setTransferring(true)
    try {
      await api.tgAutosetup.transferNow()
      await load(true)
    } catch (e: any) {
      alert(e?.message || 'Не удалось запустить передачу')
    } finally {
      setTransferring(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Автообновление статуса.
  useEffect(() => {
    const st = state?.order?.setup_state
    const active = st === 'queued' || st === 'running' || st === 'awaiting_user'
    const delay = active ? POLL_ACTIVE_MS : POLL_IDLE_MS
    timer.current = setTimeout(() => load(true), delay)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [state, load])

  const checkName = async () => {
    setChecking(true); setNameCheck(null)
    try {
      const r = await api.tgAutosetup.checkName(username)
      setNameCheck({ free: !!r.free, message: r.message || '' })
    } catch {
      setNameCheck({ free: false, message: 'Не удалось проверить, попробуйте ещё раз' })
    } finally {
      setChecking(false)
    }
  }

  const start = async () => {
    setStarting(true)
    try {
      const r = await api.tgAutosetup.start(username, title || undefined)
      if (r.payment_url) { window.location.href = r.payment_url; return }
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не получилось запустить настройку')
    } finally {
      setStarting(false)
    }
  }

  if (loading && !state) {
    return (
      <div className="flex items-center gap-2 text-gray-500 py-12 justify-center">
        <Loader2 size={18} className="animate-spin" /> Загружаем…
      </div>
    )
  }

  /**
   * Услуга ещё не открыта — показываем, ЧТО она делает, и куда идти за ней.
   *
   * ⚠️⚠️ ФОРМЫ КОДА ЗДЕСЬ НЕТ НАМЕРЕННО. Код вводится в ОДНОМ месте — в
   * карточке услуги на странице «Подписка», рядом с остальными покупками.
   * Два места ввода означали бы, что человек ищет, где именно «правильно»
   * подключить, и оба надо чинить при каждой правке.
   */
  if (noAccess) {
    return (
      <div className="max-w-3xl">
        <div className="rounded-2xl p-6 text-white"
             style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <div className="flex items-start gap-3">
            <Sparkles size={22} style={{ color: '#FFCFA4' }} className="mt-1 shrink-0" />
            <div className="flex-1">
              <h2 className="text-xl font-bold">Автонастройка ПЛЮСОНа и экспресс-подключение</h2>
              <p className="text-white/80 text-sm mt-1">
                Настроим Telegram за вас — вам останется два нажатия.
              </p>

              <p className="text-white/60 text-xs uppercase tracking-wide mt-5 mb-2">
                Что сделаем за вас
              </p>
              <ul className="space-y-1.5">
                {AUTOSETUP_STEPS.map((b, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-white/85">
                    <Check size={15} style={{ color: '#FFCFA4' }} className="mt-0.5 shrink-0" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>

              <p className="text-white/60 text-xs uppercase tracking-wide mt-5 mb-2">
                От вас — два действия
              </p>
              <ul className="space-y-1.5">
                {AUTOSETUP_FROM_CLIENT.map((b, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-white/85">
                    <span className="shrink-0 mt-0.5 w-[15px] text-center text-xs font-bold"
                          style={{ color: '#FFCFA4' }}>{i + 1}</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>

              <ul className="mt-5 space-y-1.5">
                {AUTOSETUP_NOT_INCLUDED.map((b, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-white/55">
                    <span className="shrink-0 mt-0.5">—</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>

              {/* ⚠️ «Бесплатно · Скоро будет» — честное состояние: цена 0, но
                  услуга ещё в обкатке и всем не открыта. */}
              <div className="mt-5 flex items-center gap-3 flex-wrap">
                <div className="text-2xl font-bold" style={{ color: '#FFCFA4' }}>
                  Бесплатно
                </div>
                <span className="px-2.5 py-1 rounded-lg text-xs font-semibold"
                      style={{ background: '#FFCFA4', color: '#25455D' }}>
                  СКОРО БУДЕТ
                </span>
              </div>

              <p className="mt-4 text-sm text-white/70 leading-relaxed">
                Пока подключаем по промокоду — за ним{' '}
                <Link href={SUPPORT_URL} className="underline hover:text-white"
                      style={{ color: '#FFCFA4' }}>
                  обратитесь в тех.поддержку
                </Link>
                .
              </p>

              {/* ⚠️ Ведём ТОЧНО К КАРТОЧКЕ услуги (#service-tg_autosetup), а не
                  на верх страницы подписки: там тарифы, модули и история, и
                  услугу пришлось бы искать прокруткой. Якорь у карточки есть. */}
              <Link href="/dashboard/subscription#service-tg_autosetup"
                    className="btn-gold inline-block mt-4 px-5 py-2.5 text-sm font-semibold">
                Подключить по промокоду
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!state) return null

  /**
   * ⚠️⚠️ ЗАКАЗА НЕТ — ЭТО `{}`, А НЕ `undefined`.
   *
   * `_order_out` на бэкенде при отсутствии заказа возвращает ПУСТОЙ ОБЪЕКТ.
   * В JavaScript `{}` — истина, поэтому проверка «заказа нет» (`!order`) не
   * срабатывала, и форма ввода имени бота не рисовалась ВООБЩЕ: человек с
   * выданной услугой видел только тёмную витрину и не мог ничего запустить.
   *
   * Приводим к `undefined` по наличию `id` — единственного поля, которое есть
   * у настоящего заказа всегда.
   */
  const order = state.order?.id ? state.order : undefined
  const st = order?.setup_state
  const inProgress = st === 'queued' || st === 'running'
  /**
   * ⚠️ `failed` ПОКАЗЫВАЕМ ТАК ЖЕ, как «ждём ваших действий».
   *
   * Состояния `failed` в списке не было вовсе, и экран становился ПУСТЫМ:
   * человек нажимал «Передать мне», задача останавливалась после двух попыток
   * — и всё исчезало. Ни чек-листа, ни причины, ни кнопки повторить.
   *
   * На деле сорвался ОДИН шаг (передача прав), а бот и группа уже созданы и
   * работают. Значит показывать надо то же самое, только с красной причиной
   * и возможностью повторить.
   */
  const failedTransfer = st === 'failed'
  const waitingUser = st === 'awaiting_user' || failedTransfer
  const finished = st === 'done'
  const expired = st === 'expired'

  /**
   * ⚠️ ОПЛАЧЕННЫЙ ЗАКАЗ ГЛАВНЕЕ РЫЧАГА «СКОРО».
   *
   * `coming_soon` закрывает ПРОДАЖУ (нет кнопки оплаты), а не саму услугу.
   * Раньше по нему пряталась и форма ввода имени бота — и клиент, которому
   * услугу уже выдали (оплата мимо кассы, отметка админом), видел «Услуга
   * скоро появится» и не мог ничего запустить. Поймано у клиента 174.
   *
   * `status='paid'` — единственный признак, что человеку услуга положена;
   * `setup_state` тут не годится: у нового заказа он `new`, как и у ещё
   * не оплаченного.
   */
  const paid = order?.status === 'paid'

  /**
   * ⚠️⚠️ УСЛУГА ДОСТУПНА — ЗНАЧИТ ФОРМА ОТКРЫТА, даже если заказа ещё нет.
   *
   * Здесь была ошибка: доступ определялся по ОПЛАЧЕННОМУ ЗАКАЗУ (`paid`).
   * Но при выдаче по коду заказа нет вовсе — есть только фича, а заказ
   * рождается уже при запуске настройки. Из-за этого человек вводил код,
   * получал доступ и всё равно видел «СКОРО» без единой кнопки.
   *
   * Признак доступа — сам факт, что эта ручка ответила: `_assert_feature`
   * отдаёт 403 всем, у кого фичи нет, и до отрисовки дело не доходит
   * (показывается экран ввода кода). Значит `coming_soon` здесь означает
   * ровно одно: продажа за деньги закрыта — а доступ у человека уже есть,
   * и прятать по нему форму нельзя.
   */

  return (
    <div className="max-w-3xl">
      {/*
        ⚠️ ТЁМНОЙ ВИТРИНЫ ЗДЕСЬ НЕТ НАМЕРЕННО.

        До этого экрана доходит только тот, у кого услуга УЖЕ подключена:
        без доступа ручка отдаёт 403 и рисуется отдельный экран «Скоро будет»
        с описанием и переходом в «Подписку». Значит рассказывать здесь, что
        входит в услугу и сколько она стоит, некому — человек за этим уже
        пришёл. Блок на пол-экрана только отодвигал вниз то, ради чего
        открывают вкладку: поля ника и имени бота.
      */}

      {/*
        ─── Ник в Telegram: спрашиваем и сохраняем ЗДЕСЬ ЖЕ ───

        ⚠️ Раньше тут висела плашка «укажите ник в Настройках»: человек уходил
        в другой раздел, искал вкладку и часто не возвращался. Поле в кабинете
        необязательное — значит закрыть пробел должна сама настройка «под ключ»:
        без ника некому передать права на бота и группу.

        ⚠️ Ник показываем и когда он УЖЕ есть — с просьбой проверить: в кабинет
        его мог вписать кто угодно (или это ник другого человека), а ошибка
        всплывёт в самом конце, когда бот уже создан и передавать его будет
        некому. Поправленное сохраняется сразу, без ухода со страницы.
      */}
      {!order && (
        <div className={`rounded-xl border px-5 py-4 mb-5 ${
          state.telegram_username
            ? 'border-gray-200 bg-white'
            : 'border-amber-300 bg-amber-50'}`}>
          <div className="flex gap-3">
            {!state.telegram_username && (
              <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${
                state.telegram_username ? 'text-gray-800' : 'text-amber-900'}`}>
                {state.telegram_username
                  ? 'Проверьте свой ник в Telegram'
                  : 'Укажите свой ник в Telegram'}
              </p>
              <p className={`text-xs mt-0.5 ${
                state.telegram_username ? 'text-gray-500' : 'text-amber-800'}`}>
                На этот аккаунт мы передадим права на бота и группу.
                {!state.support_filled && ' Он же станет вашей «Службой заботы» — по нему люди напишут вам из бота и с лендинга.'}
              </p>

              <div className="flex gap-2 mt-3">
                <div className="flex-1 flex items-center rounded-lg border border-gray-300 bg-white px-3 focus-within:border-gray-400">
                  <span className="text-gray-400 select-none">@</span>
                  <input
                    /**
                     * ⚠️ Ник ВСЕГДА берётся из настроек (`clients.telegram_username`),
                     * своей копии у вкладки нет.
                     *
                     * Здесь было `nick || state.telegram_username`, и это ломалось:
                     * стоит один раз тронуть поле — `nick` перестаёт быть пустым и
                     * НАВСЕГДА перекрывает значение из настроек. Человек менял ник
                     * в Настройках, возвращался сюда и видел старый — казалось,
                     * что мы храним ник у себя и не обновляем.
                     *
                     * Теперь `nick` — только «черновик правки»: null, пока не
                     * начали печатать. Не трогали поле → показываем настройки,
                     * и любое обновление данных сразу видно.
                     */
                    value={nick ?? (state.telegram_username || '').replace(/^@/, '')}
                    onChange={e => {
                      setNick(e.target.value.trim().replace(/^@/, ''))
                      setNickSaved(false); setNickError(null)
                    }}
                    onKeyDown={e => { if (e.key === 'Enter') saveNick() }}
                    placeholder="ваш_ник"
                    className="flex-1 py-2.5 px-1 outline-none text-sm bg-transparent"
                  />
                </div>
                <button onClick={saveNick} disabled={savingNick || !(nick ?? '').trim()}
                        className="btn-primary px-4 whitespace-nowrap disabled:opacity-50">
                  {savingNick ? <Loader2 size={15} className="animate-spin" /> : 'Сохранить'}
                </button>
              </div>

              {nickSaved && (
                <p className="mt-2 text-sm text-green-700 flex items-center gap-1.5">
                  <Check size={15} /> Сохранено
                </p>
              )}
              {nickError && (
                <p className="mt-2 text-sm text-red-600 flex items-center gap-1.5">
                  <AlertTriangle size={15} /> {nickError}
                </p>
              )}
              {state.telegram_username && nick === null && !nickSaved && (
                <p className="mt-2 text-xs text-gray-400">
                  Всё верно — можно запускать настройку ниже.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── Форма запуска ─── */}
      {/*
        ⚠️ Показываем и ОПЛАЧЕННОМУ заказу, у которого ещё нет имени бота.
        Так выглядит услуга, выданная админом без денег: заказ есть, статус
        `paid`, `setup_state='new'` — то есть человеку остаётся только назвать
        бота. Условие `!order` прятало форму, и запустить настройку было нечем.
      */}
      {(!order || (paid && !order.bot_username && !inProgress
                   && !waitingUser && !finished)) && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="font-semibold text-gray-900 mb-1">Как назвать бота</h3>
          {/* ⚠️ Про оплату не пишем: сюда попадает только тот, у кого услуга
              уже подключена. */}
          <p className="text-sm text-gray-500 mb-1">
            Имя латиницей, заканчивается на «bot». Проверим, свободно ли оно,
            прежде чем ставить задачу в очередь.
          </p>
          {/* ⚠️ Длину очереди показываем ДО запуска: человек сразу понимает,
              ждать ему минуту или дольше, и не пишет в поддержку «почему не
              начинается». */}
          {!!state.queue_total && state.queue_total > 0 && (
            <p className="text-sm text-gray-500 mb-4">
              Сейчас в очереди {state.queue_total}{' '}
              {state.queue_total === 1 ? 'задача' : state.queue_total < 5 ? 'задачи' : 'задач'}
              {' '}— вы встанете следующим.
            </p>
          )}
          {!state.queue_total && <div className="mb-4" />}

          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Адрес бота
          </label>
          <div className="flex gap-2">
            <div className="flex-1 flex items-center rounded-lg border border-gray-300 px-3 focus-within:border-gray-400">
              <span className="text-gray-400 select-none">@</span>
              <input
                value={username}
                onChange={e => { setUsername(e.target.value.trim()); setNameCheck(null) }}
                placeholder="medialift_bot"
                className="flex-1 py-2.5 px-1 outline-none text-sm"
              />
            </div>
            <button onClick={checkName} disabled={checking || !username}
                    className="btn-primary px-4 whitespace-nowrap">
              {checking ? <Loader2 size={15} className="animate-spin" /> : 'Проверить'}
            </button>
          </div>

          {!!state.suggestions?.length && (
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              <span className="text-xs text-gray-400 py-1">Например:</span>
              {state.suggestions.map(s => (
                <button key={s} onClick={() => { setUsername(s); setNameCheck(null) }}
                        className="text-xs px-2 py-1 rounded-md border border-gray-200 text-gray-600 hover:border-gray-400">
                  {s}
                </button>
              ))}
            </div>
          )}

          {nameCheck && (
            <div className={`mt-3 text-sm flex items-center gap-2 ${
              nameCheck.free ? 'text-green-700' : 'text-red-600'}`}>
              {nameCheck.free ? <Check size={15} /> : <AlertTriangle size={15} />}
              {nameCheck.message}
            </div>
          )}

          <label className="block text-sm font-medium text-gray-700 mt-5 mb-1.5">
            Название бота <span className="text-gray-400 font-normal">— как его увидят люди</span>
          </label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Клуб МедиаЛифт"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-gray-400"
          />

          {/* ⚠️ Условие про 3 дня показываем ДО оплаты, а не после — иначе споры. */}
          <div className="mt-5 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-600">
            После настройки нужно будет <b>зайти в бота и вступить в группу</b> —
            это два нажатия. Забрать бота нужно в течение {state.claim_days} дней:
            иначе он удаляется, и настройку придётся запустить заново
            (повторно платить не нужно).
          </div>

          <button
            onClick={start}
            disabled={starting || !nameCheck?.free || !state.telegram_username}
            className="btn-gold w-full mt-4 py-3 disabled:opacity-50"
          >
            {/* ⚠️ Про деньги здесь не пишем. До этого экрана доходит только
                тот, у кого услуга уже подключена, — платить ему нечего, а
                «Настроить за 0 ₽» читалось как сбой. Кнопка ставит задачу в
                очередь, о чём и говорит подпись.
                ⚠️ Не завязываемся на `paid`: при выдаче по промокоду заказа
                нет, и ветка «оплатить» включалась у того, кто уже подключён. */}
            {starting ? 'Ставим в очередь…' : 'Поставить в очередь на автонастройку'}
          </button>
          {!nameCheck?.free && (
            <p className="text-xs text-gray-400 mt-2 text-center">
              Сначала проверьте, свободно ли имя
            </p>
          )}
        </div>
      )}

      {/* ─── Очередь ─── */}
      {/* ⚠️ Чек-лист виден С НАЧАЛА и заполняется по ходу: человек должен
          видеть ОБЪЁМ работы, а не только то, что уже сделано. */}
      {(inProgress || waitingUser) && order && (
        <ServiceChecklist steps={order.steps}
                          botUsername={order.bot_username}
                          groupLink={order.group_invite_link}
                          supportFilled={state.support_filled}
                          log={order.setup_log} />
      )}

      {inProgress && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 mb-5">
          <div className="flex items-center gap-2.5 mb-3">
            <Loader2 size={18} className="animate-spin" style={{ color: '#25455D' }} />
            <div className="font-semibold text-gray-900">
              {st === 'queued' ? 'Вы в очереди' : 'Настраиваем…'}
            </div>
          </div>
          {/*
            ⚠️ Показываем НОМЕР В ОЧЕРЕДИ ЦИФРОЙ, а не только словами.
            Настройка идёт минутами, и без цифры экран выглядит зависшим:
            человек решает, что услуга не работает, и пишет в поддержку.
            По номеру видно движение — обновил страницу, номер уменьшился.
          */}
          {st === 'queued' && !!state.queue_position && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-[#25455D]">
                  {state.queue_position}
                </span>
                <span className="text-sm text-gray-600">
                  — ваш номер в очереди
                  {!!state.queue_total && state.queue_total > 1 && (
                    <span className="text-gray-400"> из {state.queue_total}</span>
                  )}
                </span>
              </div>
              <p className="text-sm text-gray-600 mt-1.5">
                {state.queue_position === 1
                  ? 'Вы первый — настройка начнётся в ближайшую минуту.'
                  : `Перед вами ${state.queue_position - 1} — начнём, как только освободится место.`}
              </p>
              {/* Обновлять руками не обязательно: экран сам перезапрашивает
                  состояние каждые 5 секунд, пока настройка идёт. */}
              <p className="text-xs text-gray-400 mt-1.5">
                Страница обновляется сама — можно не перезагружать.
              </p>
            </div>
          )}
          {st === 'running' && (
            <p className="text-sm text-gray-600">
              Ваша очередь подошла — выполняем шаги настройки.
            </p>
          )}
          {/* ⚠️ Второго списка шагов здесь НЕТ намеренно — отчёт о работе один,
              выше (ServiceChecklist). Два списка про одно и то же расходились. */}
        </div>
      )}

      {/* ─── Что осталось сделать клиенту ─── */}
      {waitingUser && order && (
        <div className="rounded-xl border-2 p-5 mb-5" style={{ borderColor: '#FFCFA4' }}>
          {/* ⚠️⚠️ ЭКРАН ЦЕЛИКОМ ЗАВИСИТ ОТ ТОГО, ИДЁТ ЛИ НАСТРОЙКА.
              «Почти готово — осталось одно действие» и «занимает меньше минуты»
              висели и на ОСТАНОВЛЕННОЙ настройке, а под ними — шаги «зайдите в
              бота», «вступите в группу» и галочки «Сделала». Человек читал бодрое
              обещание, делал шаги, которые ничего не дают (задача остановлена), и
              только внизу красным видел «служебный аккаунт заморожен».
              Провалилось — так и пишем, и единственное действие тут — поддержка. */}
          {failedTransfer ? (
            <>
              <h3 className="font-bold text-gray-900 mb-1">
                Настройка не завершилась
              </h3>
              <p className="text-sm text-gray-500 mb-4">
                Мы остановились и передали задачу в тех.поддержку. Что успели
                сделать — показано выше, это никуда не денется. Оплата
                сохраняется: настройку можно будет запустить заново.
              </p>
              <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 px-4 py-3">
                <XCircle size={18} className="text-red-600 shrink-0 mt-0.5" />
                <div className="text-sm text-red-800">
                  {/* Причина уже по-русски — её готовит _human_error на бэкенде. */}
                  {order.setup_error || 'Не удалось выполнить один из шагов'}
                  <div className="mt-2">
                    <Link href={SUPPORT_URL} className="underline font-medium">
                      {SUPPORT_LABEL}
                    </Link>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <h3 className="font-bold text-gray-900 mb-1">
                Почти готово — осталось одно действие
              </h3>
              {/* ⚠️ Прямо говорим, КАК мы поймём, что человек это сделал. Раньше
                  было «мы увидим ваши действия» — оставалось гадать, надо ли где-то
                  нажать галочку. Никаких галочек: бот узнаёт клиента по нику из
                  кабинета и отмечает шаг сам. */}
              <p className="text-sm text-gray-500 mb-4">
                Нажмите «Запустить» в своём боте — мы узнаем вас по нику
                <b> @{state.telegram_username?.replace(/^@/, '') || '…'}</b> из настроек,
                отметим шаг сами и передадим вам права владельца. Обычно занимает
                меньше минуты.
              </p>

              {/* ⚠️⚠️ КАЖДЫЙ ШАГ — ТОЛЬКО ЕСЛИ ОН ФИЗИЧЕСКИ ВОЗМОЖЕН.
                  Раньше все три карточки рисовались безусловно, и на заказе без
                  созданной группы человек видел «Вступите по ссылке» и галочку
                  «Сделала» — при том, что ссылки не существует. Просить о
                  невозможном нельзя: шаг показываем, когда есть куда идти. */}
              {!!order.bot_username && (
                <ActionRow
                  done={!!order.steps?.client_started_bot}
                  title="Зайдите в своего бота и нажмите «Запустить»"
                  hint="После этого мы автоматически передадим вам права владельца"
                  doneHint="Сделано — передаём вам права на бота"
                  href={`https://telegram.me/${order.bot_username}`}
                  label={`@${order.bot_username}`}
                  icon={<MessageSquare size={16} />}
                  onConfirm={() => confirmStep('bot')}
                  confirming={confirming === 'bot'}
                />
              )}

              {!!order.steps?.group_created && (
                <ActionRow
                  done={!!order.steps?.client_joined}
                  title="Группа уведомлений"
                  hint="Вступите по ссылке — после этого сделаем вас админом"
                  doneHint="Вы в группе. Ссылка продублирована в Настройках → «Каналы уведомлений»"
                  href={order.group_invite_link || undefined}
                  label="Перейти в группу"
                  icon={<Users size={16} />}
                  onConfirm={() => confirmStep('group')}
                  confirming={confirming === 'group'}
                />
              )}

              {/*
                ⚠️ Свой канал — НЕОБЯЗАТЕЛЬНЫЙ шаг, и это сказано вслух: канал есть
                не у всех, а без пометки человек считает настройку незавершённой и
                идёт в поддержку.
                ⚠️ Галочка нужна и здесь. Раньше её не было: рассчитывали, что
                платформа увидит добавление бота сама через `my_chat_member`. Но
                апдейт доходит, только пока бот слушается процессом plusson-bot, а
                бот услуги создан позже его старта — человек добавил бота в канал
                и не мог никак об этом сообщить.
                ⚠️ Показываем только когда бот есть: добавлять в канал нечего.
              */}
              {!!order.bot_username && (
                <ActionRow
                  done={!!order.steps?.channel_linked}
                  title="Добавьте бота в свой канал (если он есть)"
                  hint="Админом, с правом «Публикация сообщений» — тогда сможете рассылать и в канал"
                  doneHint="Канал подключён к рассылкам"
                  icon={<Users size={16} />}
                  label=""
                  onConfirm={() => confirmStep('channel')}
                  confirming={confirming === 'channel'}
                />
              )}
            </>
          )}

          {/* ─── Шаг 4: передать права ───
              ⚠️ Кнопка нужна, хотя передачу делает и фоновая задача: она ходит
              раз в минуту, и человек, отметивший шаги, смотрит в неизменившийся
              экран и не понимает — ждать или сломалось. Кнопка даёт явное
              действие. Своей логики передачи здесь нет: она «будит» ту же
              задачу, чтобы не разошлись две реализации. */}
          {!order.steps?.bot_transferred && (
            <div className="rounded-lg border-2 px-4 py-3 mb-2.5"
                 style={{ borderColor: '#FFCFA4' }}>
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center shrink-0">
                  <ArrowRight size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900">
                    Передать права на бота и группу
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Когда отметили шаги выше — нажмите, и бот станет вашим
                  </div>
                </div>
                <button onClick={transferNow} disabled={transferring}
                        className="btn-gold px-4 py-2 text-sm whitespace-nowrap disabled:opacity-50">
                  {transferring ? 'Передаём…' : 'Передать мне'}
                </button>
              </div>

              {/*
                ⚠️ ОТВЕТ — ПРЯМО ЗДЕСЬ, ПОД КНОПКОЙ.
                Раньше причина неудачи выводилась внизу страницы и только в
                одном случае: человек нажимал «Передать мне», ждал, и НИЧЕГО не
                происходило — ни ошибки, ни объяснения. Экран выглядел
                сломанным. Ответ должен быть там же, где действие.
              */}
              {order.setup_error && (
                <div className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2.5">
                  <XCircle size={16} className="text-red-600 shrink-0 mt-0.5" />
                  <div className="text-sm text-red-800">
                    {order.setup_error}
                    <div className="mt-1.5">
                      <Link href={SUPPORT_URL} className="underline font-medium">
                        Написать в тех.поддержку
                      </Link>
                    </div>
                  </div>
                </div>
              )}
              {transferring && (
                <p className="mt-3 text-sm text-gray-500">
                  Идёт передача — это занимает до полминуты, не закрывайте страницу.
                </p>
              )}
            </div>
          )}

          {/* ⚠️ «Заберите бота» убрано: человек не понимал, что от него нужно —
              казалось, что есть какое-то отдельное действие «забрать». Забрать
              = зайти в бота, то есть тот же первый шаг. Так и пишем. */}
          {order.claim_deadline && !order.steps?.bot_transferred && (
            <div className="mt-4 flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <Clock size={15} className="mt-0.5 shrink-0" />
              <span>
                Зайдите в бота до {new Date(order.claim_deadline).toLocaleDateString('ru-RU', {
                  day: 'numeric', month: 'long',
                })} — иначе он удалится, и настройку придётся запустить заново
                (платить повторно не нужно).
              </span>
            </div>
          )}
        </div>
      )}

      {/* ─── Готово ─── */}
      {finished && order && (
        <div className="rounded-xl border border-green-300 bg-green-50 p-5 mb-5">
          <div className="flex items-center gap-2 font-bold text-green-900 mb-2">
            <Check size={18} /> Поздравляем — всё готово!
          </div>
          <p className="text-sm text-green-900/80">
            Бот <b>@{order.bot_username}</b> и группа уведомлений теперь ваши.
            Всё прописано в кабинете — можно работать.
          </p>
          <div className="mt-4 rounded-lg bg-white border border-green-200 px-4 py-3 text-sm text-gray-700">
            <b>Последний шаг, если нужно:</b> добавьте бота в свой канал —
            тогда сможете рассылать и туда. Права можно отключить все,
            кроме «Публикация сообщений». Как добавите — мы увидим это сами
            и подключим канал.
          </div>

          {/* ⚠️ Не бросаем человека на «готово»: бот есть, а что с ним делать —
              непонятно. Сразу предлагаем взять готовую воронку, чтобы бот начал
              приносить заявки, а не стоял пустым. */}
          <div className="mt-4 rounded-lg bg-white border border-green-200 px-4 py-3">
            <p className="text-sm font-medium text-gray-900">
              Какое готовое решение вам нужно?
            </p>
            <p className="text-sm text-gray-600 mt-1">
              Загрузим в вашего бота готовую воронку — например, запись на
              консультацию: человек подписывается, заполняет анкету, а заявка
              приходит вам.
            </p>
            <Link href="/dashboard/lead-magnets"
                  className="btn-gold inline-block mt-3 px-4 py-2 text-sm font-semibold">
              Выбрать готовое решение
            </Link>
          </div>
        </div>
      )}

      {/* ─── Сгорело ─── */}
      {expired && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-5 mb-5">
          <div className="flex items-center gap-2 font-bold text-amber-900 mb-2">
            <AlertTriangle size={18} /> Бот удалён
          </div>
          <p className="text-sm text-amber-900/80 mb-4">
            {order?.setup_error || 'Бота не забрали за 3 дня, и он был удалён.'}
          </p>
          <button onClick={() => window.location.reload()} className="btn-gold px-5 py-2.5">
            Запустить настройку заново — бесплатно
          </button>
        </div>
      )}

      {/* ⚠️ ЗДЕСЬ БЫЛ ПОВТОР ТЕКСТА ОШИБКИ — УБРАН. Та же причина уже показана
          под кнопкой «Передать мне» (там, где человек нажимал), и внизу
          страницы она выглядела вторым, отдельным сбоем. */}
    </div>
  )
}

/** Строка «что сделать» с галочкой готовности. */
/**
 * Чек-лист услуги: ВСЕ обещанные шаги сразу, галочки — по мере выполнения.
 *
 * ⚠️ Показывается С НАЧАЛА настройки, а не по факту сделанного. Раньше внизу
 * копился только список уже выполненного, и объём работы был не виден: человек
 * не понимал, что вообще происходит и сколько ещё осталось. Здесь он видит
 * весь перечень и как он заполняется — это и есть подтверждение услуги.
 *
 * ⚠️ Шаги берутся из ОТМЕТОК ЗАКАЗА (`order.steps`), а не из текстового лога:
 * лог — это лента сообщений, по ней нельзя понять, что именно уже готово.
 */
/**
 * Отчёт о работе — ЕДИНСТВЕННЫЙ на экране.
 *
 * ⚠️⚠️ ВТОРОГО СПИСКА БЫТЬ НЕ ДОЛЖНО. Раньше рядом жил ещё и построчный лог
 * (`SetupLog`), и они РАСХОДИЛИСЬ: чек-лист рисовался по галочкам заказа, а лог
 * — по фактическим записям, причём в другом порядке. Человек видел два разных
 * рассказа об одной и той же работе («так группа создана или нет?») и не знал,
 * какому верить. Оставлен этот: у него есть ссылки «проверить», которых в логе
 * не было. Точность лога перенесена сюда — см. `failed` ниже.
 */
function ServiceChecklist({ steps, botUsername, groupLink, supportFilled, log }: {
  steps?: Record<string, boolean>
  botUsername?: string | null
  groupLink?: string | null
  supportFilled?: boolean
  log?: Step[]
}) {
  const s = steps || {}

  // ⚠️ Ошибки берём ИЗ ЛОГА и раскладываем по своим пунктам — за этим лог и был
  // нужнее: он один показывал, ЧТО именно не получилось. Тексты приходят уже
  // по-русски (см. _human_error на бэкенде); английских имён исключений быть
  // не должно — если что-то просочилось, это баг бэкенда, а не фронта.
  const failedByStep: Record<string, string> = {}
  for (const e of log || []) {
    if (!e.ok && e.step) failedByStep[e.step] = e.text
  }

  const rows: {
    done: boolean; text: string; proof?: string; proofLabel?: string
    /** Ключ шага в логе — по нему подтягивается ошибка. */
    key?: string
  }[] = [
    { done: !!s.bot_created, text: 'Создали вашего бота', key: 'bot',
      proof: botUsername ? `https://telegram.me/${botUsername}` : undefined,
      proofLabel: botUsername ? `@${botUsername}` : undefined },
    // ⚠️ Свой флаг, а не «раз бот создан, значит подключён»: подключение к
    // кабинету — отдельное действие, и оно может не пройти само по себе.
    { done: !!s.bot_channel_linked, text: 'Подключили бота к кабинету', key: 'channel',
      proof: '/dashboard/channels?tab=bots', proofLabel: 'Проверить' },
    { done: !!s.miniapp_linked, text: 'Привязали приложение (Mini App)', key: 'miniapp' },
    { done: !!s.group_created, text: 'Создали закрытую группу для уведомлений',
      key: 'group', proof: groupLink || undefined, proofLabel: 'Открыть группу' },
    { done: !!s.group_in_settings, text: 'Прописали группу в настройках кабинета',
      proof: '/dashboard/settings?tab=tech', proofLabel: 'Проверить' },
    { done: !!supportFilled, text: 'Заполнили «Службу заботы»', key: 'support',
      proof: '/dashboard/settings', proofLabel: 'Проверить' },
    { done: !!s.client_started_bot, text: 'Вы зашли в бота' },
    { done: !!s.bot_transferred, text: 'Передали вам права на бота', key: 'transfer' },
    { done: !!s.client_joined, text: 'Вы вступили в группу' },
    { done: !!s.group_transferred, text: 'Сделали вас админом группы' },
    { done: !!s.channel_linked, text: 'Подключили ваш канал к рассылкам' },
  ]
  const doneCount = rows.filter(r => r.done).length

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 mb-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="font-semibold text-gray-900">Что делаем за вас</h3>
        <span className="text-sm text-gray-500 shrink-0">
          {doneCount} из {rows.length}
        </span>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => {
          // Ошибка показывается только у НЕсделанного шага: сорвалось, потом
          // получилось — говорить об этом уже незачем.
          const err = !r.done && r.key ? failedByStep[r.key] : undefined
          return (
            <div key={i}>
              <div className="flex items-center gap-2.5 text-sm">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                  r.done ? 'bg-green-500 text-white'
                         : err ? 'bg-red-100 text-red-600' : 'bg-gray-100'}`}>
                  {r.done ? <Check size={12} />
                          : err ? <XCircle size={12} />
                                : <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />}
                </span>
                <span className={r.done ? 'text-gray-800' : err ? 'text-red-700' : 'text-gray-400'}>
                  {r.text}
                </span>
                {/* ⚠️ Ссылка-подтверждение: чтобы человек мог УБЕДИТЬСЯ, что шаг
                    действительно выполнен, а не поверить на слово. */}
                {r.done && r.proof && (
                  <a href={r.proof}
                     target={r.proof.startsWith('http') ? '_blank' : undefined}
                     rel="noreferrer"
                     className="text-xs text-[#25455D] underline shrink-0 ml-auto">
                    {r.proofLabel || 'Открыть'}
                  </a>
                )}
              </div>
              {/* ⚠️ Причина — прямо под своим пунктом, а не отдельным списком
                  внизу: иначе непонятно, к какому шагу она относится. Рядом —
                  выход в поддержку: сам человек тут ничего не починит. */}
              {err && (
                <div className="ml-[30px] mt-1 text-xs text-red-600">
                  {err}{' · '}
                  {/* ⚠️ Адрес поддержки — только из SUPPORT_URL, руками не
                      прописывать: он один на весь кабинет. */}
                  <Link href={SUPPORT_URL} className="underline">
                    {SUPPORT_LABEL}
                  </Link>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Шаг, который делает САМ КЛИЕНТ: перейти по ссылке и отметить галочкой.
 *
 * ⚠️⚠️ ГАЛОЧКУ СТАВИТ ЧЕЛОВЕК, А НЕ ТОЛЬКО АВТОМАТИКА.
 *
 * Автоматика есть, но срабатывает не всегда:
 *   • заход в бота ловится, лишь пока бот слушается процессом `plusson-bot`,
 *     а бот услуги создан позже его старта — до перезапуска сервиса сообщения
 *     до нас не доходят (поймано на живом заказе: человек нажал «Запустить»,
 *     отметки нет, настройка встала);
 *   • вступление в группу приходит апдейтом `chat_member`, но только пока наш
 *     аккаунт в группе; добавить человека мы часто вообще не можем — у него
 *     закрыты настройки приватности, и он вступает сам.
 *
 * Поэтому: перешёл → отметил галочкой → по ней запускается передача прав.
 * Автоматика остаётся: сработала раньше — галочка уже стоит.
 */
function ActionRow({ done, title, hint, doneHint, href, label, icon,
                     onConfirm, confirming }: {
  done: boolean; title: string; hint: string
  /** Что написать, когда шаг уже сделан. Пусто → «Сделано». */
  doneHint?: string
  href?: string; label: string; icon: React.ReactNode
  /** Отметить шаг выполненным. Нет — галочка не показывается. */
  onConfirm?: () => void
  confirming?: boolean
}) {
  return (
    <div className={`rounded-lg border px-4 py-3 mb-2.5 ${
      done ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-center gap-3">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
          done ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-400'}`}>
          {done ? <Check size={15} /> : icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-medium ${done ? 'text-green-900' : 'text-gray-900'}`}>
            {title}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {done ? (doneHint || 'Сделано') : hint}
          </div>
        </div>
        {/* ⚠️ Кнопка остаётся и у ВЫПОЛНЕННОГО шага: после вступления в группу
            попасть в неё было неоткуда — ссылку человек уже закрыл, а по
            chat_id в Telegram не вступишь. */}
        {href && (
          <a href={href} target="_blank" rel="noreferrer"
             className={`px-3 py-2 text-sm whitespace-nowrap flex items-center gap-1.5 rounded-lg ${
               done
                 ? 'border border-green-300 text-green-800 hover:bg-green-100'
                 : 'btn-primary'}`}>
            {label} <ArrowRight size={14} />
          </a>
        )}
      </div>

      {/* Галочка «я это сделал» — под строкой, чтобы не тесниться с кнопкой. */}
      {!done && onConfirm && (
        <label className="flex items-center gap-2 mt-3 pl-10 cursor-pointer select-none">
          <input type="checkbox" checked={false} disabled={confirming}
                 onChange={onConfirm}
                 className="w-4 h-4 rounded border-gray-300 cursor-pointer" />
          <span className="text-sm text-gray-700">
            {confirming ? 'Отмечаем…' : 'Сделала'}
          </span>
        </label>
      )}
    </div>
  )
}

// ⚠️⚠️ ЗДЕСЬ БЫЛ ВТОРОЙ СПИСОК ШАГОВ (`SetupLog`) — УДАЛЁН, НЕ ВОЗВРАЩАТЬ.
//
// Он показывал те же шаги, что и `ServiceChecklist`, но по другим данным и в
// другом порядке — и они расходились: человек видел два отчёта об одной работе
// и спрашивал, какому верить. Плюс лог печатал сырые имена ошибок
// (`FrozenMethodInvalidError`), непонятные никому, кроме разработчика.
//
// Что было в нём ценного и куда переехало:
//   • точные причины неудач → в `ServiceChecklist`, строкой под своим пунктом;
//   • русские формулировки ошибок → `_human_error` в backend/app/tasks/tg_setup.py.
//
// Сами записи `setup_log` в базе остаются — они нужны поддержке и разбору.
