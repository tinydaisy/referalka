'use client'

/**
 * «Шаг ноль» автонастройки — подтверждение почты + вход в бота поддержки.
 *
 * ⚠️⚠️ ОДИН КОМПОНЕНТ НА ОБА МЕСТА. Его показывает и вкладка автонастройки
 * (первым шагом, сразу после приветствия), и демо-страница
 * `/dashboard/help/step-zero-preview`. Копии быть не должно: тексты и логика
 * «чего ещё не хватает» разъедутся на первой же правке.
 *
 * ⚠️ ЗАЧЕМ ШАГ ВООБЩЕ. Автонастройка в нескольких местах упирается в действие
 * клиента (зайти в бота, открыть приватность, вступить в группу). Без рабочего
 * канала связи услуга встаёт молча — так вышло с заказами 8 и 13 в сентябре
 * 2026: письма не доходили, в боте человек не был, и после оплаты он просто
 * сидел в тишине. Поэтому шаг идёт ПЕРЕД настройкой, а не после.
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { PlatformLogo, PLATFORM_COLORS } from '@/components/PlatformLogo'
import { ArrowRight, Check, ExternalLink, Loader2, Mail, RefreshCw } from 'lucide-react'

const GOLD = '#FFCFA4'

export type StepZeroState = {
  email: string
  email_verified: boolean
  platforms: {
    slug: string
    label: string
    enabled: boolean
    subscribed: boolean
    url: string
  }[]
  any_subscribed: boolean
  can_continue: boolean
}

type Props = {
  /** Зовётся, когда оба условия выполнены — родитель открывает следующий шаг. */
  onReady?: (ready: boolean) => void
  /** Заголовок: на демо-странице свой, в автонастройке — «Шаг 1». */
  title?: string
  /**
   * Показывать кнопку «Продолжить настройку» под карточками площадок.
   *
   * ⚠️⚠️ КНОПКА НУЖНА, ХОТЯ ПЕРЕХОД И АВТОМАТИЧЕСКИЙ. Когда оба шага пройдены,
   * блок исчезает сам и появляются поля — но человек этого НЕ ЗНАЕТ. Он сидит
   * на экране, где всё зелёное, и ждёт, что нажать. Кнопка даёт явное действие
   * и понятный конец шага; пока шаги не пройдены — она неактивна и прямо
   * говорит, чего не хватает.
   */
  showContinue?: boolean
}

export function StepZero({ onReady, title = 'Прежде чем начать',
                           showContinue = false }: Props) {
  const [state, setState] = useState<StepZeroState | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const data = await api.supportOnboarding.get()
      setState(data)
      onReady?.(!!data?.can_continue)
    } catch (e: any) {
      setNote(e?.message || 'Не удалось загрузить состояние')
    } finally {
      setLoading(false)
    }
  }, [onReady])

  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * ⚠️ Опрос обязателен: человек уходит подтверждать почту и жать ссылку бота
   * в ДРУГОЙ вкладке и в другом приложении. Без опроса он вернётся на экран,
   * где по-прежнему «не подтверждено», и решит, что ничего не сработало.
   */
  useEffect(() => {
    if (state?.can_continue) return
    const t = setInterval(() => load(true), 5000)
    return () => clearInterval(t)
  }, [state?.can_continue, load])

  const resend = async () => {
    setSending(true)
    setNote(null)
    try {
      const r = await api.supportOnboarding.resendEmail()
      setNote(r?.already_verified
        ? 'Почта уже подтверждена.'
        : 'Письмо отправлено — проверьте почту, в том числе папку «Спам».')
      await load(true)
    } catch (e: any) {
      setNote(e?.message || 'Не удалось отправить письмо')
    } finally {
      setSending(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-500 py-4">
        <Loader2 size={18} className="animate-spin" /> Загружаем…
      </div>
    )
  }
  if (!state) return <div className="text-gray-600 py-4">{note || 'Нет данных'}</div>

  const emailDone = state.email_verified
  const botDone = state.any_subscribed

  return (
    <div>
      <h3 className="font-bold text-gray-900 mb-1">{title}</h3>
      <p className="text-sm text-gray-500 mb-4">
        Два коротких шага — чтобы мы могли до вас дописаться, если по ходу
        настройки что-то понадобится.
      </p>

      {/* ─── Почта ─── */}
      <div className="rounded-2xl border-2 bg-white p-5 mb-4"
           style={{ borderColor: emailDone ? '#86efac' : GOLD }}>
        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
            emailDone ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
            {emailDone ? <Check size={18} /> : <Mail size={18} />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-gray-900">Подтвердите почту</div>
            <div className="text-sm text-gray-600 mt-0.5 break-words">
              {emailDone
                ? <>Почта <b>{state.email}</b> подтверждена.</>
                : <>Отправим письмо на <b>{state.email}</b> — откройте его
                   и нажмите ссылку внутри.</>}
            </div>
            {/* ⚠️ Про «Спам» — отдельной строкой: письмо чаще всего именно там,
                и без этой подсказки человек ждёт его во «Входящих». */}
            {!emailDone && (
              <>
                <div className="text-sm font-semibold text-gray-700 mt-2">
                  Не нашли письмо? Проверьте папку «Спам».
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button onClick={resend} disabled={sending}
                          className="btn-gold px-4 py-2 text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-2">
                    {sending
                      ? <><Loader2 size={15} className="animate-spin" /> Отправляем…</>
                      : <><Mail size={15} /> Отправить письмо</>}
                  </button>
                  <button onClick={() => load(true)}
                          className="text-sm text-gray-500 hover:text-gray-800 flex items-center gap-1.5">
                    <RefreshCw size={13} /> Уже подтвердил
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ─── Бот поддержки ─── */}
      <div className="rounded-2xl border-2 bg-white p-5"
           style={{ borderColor: botDone ? '#86efac' : GOLD }}>
        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
            botDone ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
            {botDone ? <Check size={18} /> : <ExternalLink size={18} />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-gray-900">Зайдите к нам в бота</div>
            {/* ⚠️ Формулировка владельца: зовём в ОБЕ площадки, но для прохода
                хватает одной — упираться в человека без Telegram нельзя. */}
            <div className="text-sm text-gray-600 mt-0.5">
              Выберите площадку, с которой вам удобнее общаться с тех.поддержкой
              и вашим менеджером. Лучше зайти в обе — но хотя бы в одну.
            </div>

            <div className="grid gap-2.5 sm:grid-cols-2 mt-3">
              {state.platforms.map(p => (
                p.enabled ? (
                  <a key={p.slug} href={p.url} target="_blank" rel="noopener noreferrer"
                     className="group flex items-center gap-3 p-3 rounded-xl border bg-white hover:shadow-md transition-all"
                     style={{ borderColor: p.subscribed ? '#86efac' : '#e5e7eb' }}>
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                         style={{ background: p.subscribed
                           ? '#16a34a'
                           : (PLATFORM_COLORS[p.slug] || '#25455D') }}>
                      {p.subscribed
                        ? <Check size={22} className="text-white" />
                        : <PlatformLogo slug={p.slug} size={24} color="#fff" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-gray-900 flex items-center gap-1.5 text-sm">
                        {p.label}
                        {!p.subscribed && (
                          <ExternalLink size={12} className="text-gray-400" />
                        )}
                      </div>
                      <div className={`text-xs ${
                        p.subscribed ? 'text-green-700' : 'text-gray-500'}`}>
                        {p.subscribed ? 'вы зашли' : 'нажмите, чтобы открыть'}
                      </div>
                    </div>
                  </a>
                ) : (
                  /* Неподключённую площадку показываем серой, а не прячем:
                     человек должен видеть, что она будет. */
                  <div key={p.slug}
                       className="flex items-center gap-3 p-3 rounded-xl border border-dashed border-gray-200 bg-gray-50">
                    <div className="w-11 h-11 rounded-xl bg-gray-100 flex items-center justify-center shrink-0">
                      <PlatformLogo slug={p.slug} size={22} color="#9ca3af" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-500 text-sm">{p.label}</div>
                      <div className="text-xs text-gray-400">скоро</div>
                    </div>
                  </div>
                )
              ))}
            </div>

            {!botDone && (
              <div className="text-xs text-gray-500 mt-2.5">
                Откроется бот — нажмите в нём «Запустить». Отметка появится
                здесь сама, обновлять страницу не нужно.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ⚠️ Кнопка ПОД карточками площадок — там, где человек заканчивает шаг.
          Неактивная прямо говорит, чего не хватает, а не молчит серым. */}
      {showContinue && (
        <div className="mt-4">
          <button
            onClick={() => load(true)}
            disabled={!emailDone || !botDone}
            className="btn-gold px-5 py-2.5 text-base font-semibold disabled:opacity-50 inline-flex items-center gap-2">
            Продолжить настройку <ArrowRight size={17} />
          </button>
          {(!emailDone || !botDone) && (
            <p className="text-xs text-gray-500 mt-2">
              {!emailDone && !botDone
                ? 'Подтвердите почту и зайдите в бота — кнопка откроется сама.'
                : !emailDone
                  ? 'Осталось подтвердить почту.'
                  : 'Осталось зайти хотя бы в одного бота.'}
            </p>
          )}
        </div>
      )}

      {note && <div className="mt-4 text-sm text-gray-700">{note}</div>}
    </div>
  )
}

export default StepZero
