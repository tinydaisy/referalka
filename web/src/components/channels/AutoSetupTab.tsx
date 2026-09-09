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
import { api } from '@/lib/api'
import {
  AlertTriangle, ArrowRight, Check, Clock, Copy, Loader2,
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
  telegram_username?: string | null
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true)
      const data = await api.tgAutosetup.get()
      setState(data)
      if (!username && data?.suggestions?.length) setUsername(data.suggestions[0])
    } catch {
      /* молча — экран перезапросит себя через интервал */
    } finally {
      setLoading(false)
    }
  }, [username])

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
  if (!state) return null

  const order = state.order
  const st = order?.setup_state
  const inProgress = st === 'queued' || st === 'running'
  const waitingUser = st === 'awaiting_user'
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
  const sellingClosed = state.service.coming_soon && !paid

  return (
    <div className="max-w-3xl">
      {/* ─── Шапка услуги ─── */}
      <div className="rounded-2xl p-6 mb-6 text-white"
           style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        <div className="flex items-start gap-3">
          <Sparkles size={22} style={{ color: '#FFCFA4' }} className="mt-1 shrink-0" />
          <div className="flex-1">
            <h2 className="text-xl font-bold">{state.service.name}</h2>
            {state.service.tagline && (
              <p className="text-white/80 text-sm mt-1">{state.service.tagline}</p>
            )}
            {state.service.description && (
              <p className="text-white/70 text-sm mt-3 leading-relaxed">
                {state.service.description}
              </p>
            )}
            {!!state.service.bullet_points?.length && (
              <ul className="mt-4 space-y-1.5">
                {state.service.bullet_points.map((b, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-white/85">
                    <Check size={15} style={{ color: '#FFCFA4' }} className="mt-0.5 shrink-0" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex items-center gap-3">
              <div className="text-2xl font-bold" style={{ color: '#FFCFA4' }}>
                {state.service.price} ₽
              </div>
              <div className="text-white/60 text-sm">разово</div>
              {/* Оплатившему «СКОРО» не показываем — у него услуга уже есть. */}
              {sellingClosed && (
                <span className="px-2.5 py-1 rounded-lg text-xs font-semibold"
                      style={{ background: '#FFCFA4', color: '#25455D' }}>
                  СКОРО
                </span>
              )}
              {paid && (
                <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-green-500 text-white">
                  ОПЛАЧЕНО
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Скоро: без кнопки оплаты ─── */}
      {sellingClosed && !order && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-600">
          Услуга скоро появится. Мы допишем последние детали и включим её —
          пока настроить бота можно вручную на вкладке «Боты».
        </div>
      )}

      {/* ─── Нет ника в Telegram — передать права будет некому ─── */}
      {!state.telegram_username && !sellingClosed && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-4 mb-5 flex gap-3">
          <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-900">
            <b>Укажите свой ник в Telegram</b> в Настройках — без него мы не сможем
            передать вам права на бота и группу.
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
      {!sellingClosed && (!order || (paid && !order.bot_username && !inProgress
                                     && !waitingUser && !finished)) && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="font-semibold text-gray-900 mb-1">Как назвать бота</h3>
          <p className="text-sm text-gray-500 mb-4">
            {paid
              ? 'Услуга оплачена. Придумайте имя боту — и мы начнём настройку.'
              : 'Имя латиницей, заканчивается на «bot». Проверим, свободно ли оно, ещё до оплаты.'}
          </p>

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
            {starting
              ? (paid ? 'Запускаем…' : 'Открываем оплату…')
              : (paid ? 'Начать настройку' : `Настроить за ${state.service.price} ₽`)}
          </button>
          {!nameCheck?.free && (
            <p className="text-xs text-gray-400 mt-2 text-center">
              Сначала проверьте, свободно ли имя
            </p>
          )}
        </div>
      )}

      {/* ─── Очередь ─── */}
      {inProgress && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 mb-5">
          <div className="flex items-center gap-2.5 mb-3">
            <Loader2 size={18} className="animate-spin" style={{ color: '#25455D' }} />
            <div className="font-semibold text-gray-900">
              {st === 'queued' ? 'Вы в очереди' : 'Настраиваем…'}
            </div>
          </div>
          {st === 'queued' && state.queue_position && state.queue_position > 1 && (
            <p className="text-sm text-gray-600">
              Перед вами {state.queue_position - 1} — начнём, как только освободится место.
              Обычно это занимает несколько минут.
            </p>
          )}
          {st === 'queued' && state.queue_position === 1 && (
            <p className="text-sm text-gray-600">Вы первый в очереди, начинаем.</p>
          )}
          <SetupLog log={order?.setup_log || []} />
        </div>
      )}

      {/* ─── Что осталось сделать клиенту ─── */}
      {waitingUser && order && (
        <div className="rounded-xl border-2 p-5 mb-5" style={{ borderColor: '#FFCFA4' }}>
          <h3 className="font-bold text-gray-900 mb-1">
            Почти готово — осталось два нажатия
          </h3>
          <p className="text-sm text-gray-500 mb-4">
            Дальше всё произойдёт само: мы увидим ваши действия и передадим права.
          </p>

          <ActionRow
            done={!!order.steps?.client_started_bot}
            title="Зайдите в своего бота и нажмите «Запустить»"
            hint="Так мы сможем передать вам права владельца"
            href={order.bot_username ? `https://telegram.me/${order.bot_username}` : undefined}
            label={order.bot_username ? `@${order.bot_username}` : 'Открыть бота'}
            icon={<MessageSquare size={16} />}
          />
          <ActionRow
            done={!!order.steps?.client_joined}
            title="Вступите в группу уведомлений"
            hint="Мы сразу сделаем вас её админом"
            href={order.group_invite_link || undefined}
            label="Открыть группу"
            icon={<Users size={16} />}
          />

          {order.claim_deadline && !order.steps?.bot_transferred && (
            <div className="mt-4 flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <Clock size={15} className="mt-0.5 shrink-0" />
              <span>
                Заберите бота до {new Date(order.claim_deadline).toLocaleDateString('ru-RU', {
                  day: 'numeric', month: 'long',
                })} — иначе он удалится, и настройку придётся запустить заново
                (платить повторно не нужно).
              </span>
            </div>
          )}

          <SetupLog log={order.setup_log || []} />
        </div>
      )}

      {/* ─── Готово ─── */}
      {finished && order && (
        <div className="rounded-xl border border-green-300 bg-green-50 p-5 mb-5">
          <div className="flex items-center gap-2 font-bold text-green-900 mb-2">
            <Check size={18} /> Настройка завершена
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

      {order?.setup_error && !expired && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800">
          {order.setup_error}
        </div>
      )}
    </div>
  )
}

/** Строка «что сделать» с галочкой готовности. */
function ActionRow({ done, title, hint, href, label, icon }: {
  done: boolean; title: string; hint: string
  href?: string; label: string; icon: React.ReactNode
}) {
  return (
    <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 mb-2.5 ${
      done ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white'}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
        done ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-400'}`}>
        {done ? <Check size={15} /> : icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium ${done ? 'text-green-900' : 'text-gray-900'}`}>
          {title}
        </div>
        <div className="text-xs text-gray-500 mt-0.5">{done ? 'Сделано' : hint}</div>
      </div>
      {!done && href && (
        <a href={href} target="_blank" rel="noreferrer"
           className="btn-primary px-3 py-2 text-sm whitespace-nowrap flex items-center gap-1.5">
          {label} <ArrowRight size={14} />
        </a>
      )}
    </div>
  )
}

/** Живой лог шагов — то, что происходит прямо сейчас. */
function SetupLog({ log }: { log: Step[] }) {
  if (!log?.length) return null
  return (
    <div className="mt-4 space-y-1.5 border-t border-gray-100 pt-3">
      {log.slice(-8).map((s, i) => (
        <div key={i} className="flex items-start gap-2 text-sm">
          {s.ok
            ? <Check size={14} className="text-green-600 mt-0.5 shrink-0" />
            : <AlertTriangle size={14} className="text-amber-600 mt-0.5 shrink-0" />}
          <span className={s.ok ? 'text-gray-600' : 'text-amber-800'}>{s.text}</span>
        </div>
      ))}
    </div>
  )
}
