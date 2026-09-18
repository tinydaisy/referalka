'use client'

/**
 * ДЕМО «шага ноль» — подтверждение почты + вход в бота поддержки.
 *
 * ⚠️ СТРАНИЦА НАМЕРЕННО НЕ ПОДКЛЮЧЕНА К МЕНЮ. Её нет ни в сайдбаре, ни в
 * справке — открывается только по прямой ссылке. Смысл в том, чтобы владелец
 * посмотрел механику вживую, до того как шаг встанет перед автонастройкой и
 * начнёт что-то блокировать живым клиентам.
 *
 * ⚠️ Работает по-настоящему: письмо реально уходит, ссылка на бота настоящая и
 * подписанная, бот реально записывает подписку. Ничего не имитируется — иначе
 * проверять было бы нечего.
 *
 * Встроим в автонастройку — эта страница удаляется, а разметка переезжает
 * в AutoSetupTab. Второй копии быть не должно.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import {
  MailCheck, Mail, Check, ExternalLink, Loader2, ShieldCheck, RefreshCw,
} from 'lucide-react'

const BRAND = '#25455D'
const GOLD = '#FFCFA4'

type Platform = {
  slug: string
  label: string
  enabled: boolean
  subscribed: boolean
  url: string
}

type State = {
  email: string
  email_verified: boolean
  platforms: Platform[]
  any_subscribed: boolean
  can_continue: boolean
}

export default function StepZeroPreviewPage() {
  const [state, setState] = useState<State | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const data = await api.supportOnboarding.get()
      setState(data)
    } catch (e: any) {
      setNote(e?.message || 'Не удалось загрузить состояние')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  /**
   * ⚠️ Опрос нужен: человек уходит подтверждать почту и жать ссылку бота в
   * ДРУГОЙ вкладке и в другом приложении. Без опроса он вернётся на страницу,
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
      <div className="flex items-center gap-2 text-gray-500 p-6">
        <Loader2 size={18} className="animate-spin" /> Загружаем…
      </div>
    )
  }

  if (!state) {
    return <div className="p-6 text-gray-600">{note || 'Нет данных'}</div>
  }

  const emailDone = state.email_verified
  const botDone = state.any_subscribed

  return (
    <div className="pb-24 max-w-3xl">
      {/* Хлебные крошки — страница живёт в справке, но вне её оглавления. */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">
          Дашборд
        </Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Демо: шаг ноль</span>
      </div>

      <div className="flex items-start gap-3 mb-2">
        <div className="p-2 rounded-lg text-white shrink-0"
             style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <ShieldCheck size={22} />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>
            Прежде чем начать
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Два коротких шага — чтобы мы могли до вас дописаться, если по ходу
            настройки что-то понадобится.
          </p>
        </div>
      </div>

      <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900 mb-6">
        Это демо-страница для проверки механики. В меню её нет — она откроется
        только по прямой ссылке.
      </div>

      {/* ─── Шаг 1: почта ─── */}
      <div className="rounded-2xl border-2 bg-white p-5 mb-4"
           style={{ borderColor: emailDone ? '#86efac' : GOLD }}>
        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
            emailDone ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
            {emailDone ? <Check size={18} /> : <Mail size={18} />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-gray-900">
              Шаг 1. Подтвердите почту
            </div>
            <div className="text-sm text-gray-600 mt-0.5 break-words">
              {emailDone
                ? <>Почта <b>{state.email}</b> подтверждена.</>
                : <>Отправим письмо на <b>{state.email}</b> — откройте его и
                   нажмите ссылку внутри.</>}
            </div>

            {!emailDone && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button onClick={resend} disabled={sending}
                        className="btn-gold px-4 py-2 text-sm font-semibold disabled:opacity-50">
                  {sending ? 'Отправляем…' : 'Отправить письмо'}
                </button>
                <button onClick={() => load(true)}
                        className="text-sm text-gray-500 hover:text-gray-800 flex items-center gap-1.5">
                  <RefreshCw size={13} /> Уже подтвердил
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Шаг 2: бот поддержки ─── */}
      <div className="rounded-2xl border-2 bg-white p-5 mb-4"
           style={{ borderColor: botDone ? '#86efac' : GOLD }}>
        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
            botDone ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
            {botDone ? <Check size={18} /> : <MailCheck size={18} />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-gray-900">
              Шаг 2. Зайдите к нам в бота
            </div>
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
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 font-bold ${
                      p.subscribed
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-500'}`}>
                      {p.subscribed ? <Check size={17} /> : p.label[0]}
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
                  /* ⚠️ Неподключённую площадку показываем серой, а не прячем:
                     человек должен видеть, что она будет. */
                  <div key={p.slug}
                       className="flex items-center gap-3 p-3 rounded-xl border border-dashed border-gray-200 bg-gray-50">
                    <div className="w-9 h-9 rounded-lg bg-gray-100 text-gray-400 flex items-center justify-center shrink-0 font-bold">
                      {p.label[0]}
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

      {/* ─── Итог ─── */}
      <div className="rounded-2xl border-2 p-5"
           style={{ borderColor: state.can_continue ? '#86efac' : '#e5e7eb',
                    background: state.can_continue ? '#f0fdf4' : '#fff' }}>
        {state.can_continue ? (
          <>
            <div className="font-semibold text-green-800 mb-1">
              Готово — можно приступать
            </div>
            <div className="text-sm text-green-700 mb-3">
              Почта подтверждена, связь с вами есть — шаг пройден.
            </div>
            {/* ⚠️ Кнопка ЖИВАЯ и ведёт в автонастройку: заглушка с `disabled`
                читалась как поломка — «оба шага зелёные, а кнопка серая».
                В рабочем варианте этот экран будет стоять ПЕРЕД вкладкой
                автонастройки, а не вести на неё ссылкой. */}
            <Link href="/dashboard/autosetup"
                  className="btn-gold inline-block px-5 py-2.5 text-base font-semibold">
              Продолжить настройку
            </Link>
          </>
        ) : (
          <div className="text-sm text-gray-500">
            Кнопка «Продолжить настройку» откроется, когда почта подтверждена
            и вы зашли хотя бы в одного бота.
          </div>
        )}
      </div>

      {note && <div className="mt-4 text-sm text-gray-700">{note}</div>}
    </div>
  )
}
