'use client'
/**
 * Вкладка «Формы заявки» — раздел «Платежи/Заявки» (миграция 363).
 *
 * Заявка: человек НЕ регистрируется и НЕ платит — заполняет анкету и получает
 * «с вами свяжутся». Ответы падают в заявки выбранной анкеты со всей готовой
 * обвязкой («Обработано», счётчик необработанных, уведомления, CRM, выгрузка).
 *
 * ⚠️ Одна форма на владельца: кнопка участия одна, при двух формах непонятно,
 * какую открывать. Разные наборы вопросов — это разные анкеты, их сколько
 * угодно в разделе «Анкеты».
 *
 * ⚠️ Один компонент на событие И продукт — второй копии быть не должно.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'

interface Props {
  ownerType: 'events' | 'products'
  ownerId: number
}

export default function RequestFormTab({ ownerType, ownerId }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [surveys, setSurveys] = useState<any[]>([])
  const [form, setForm] = useState<any>(null)

  const [surveyId, setSurveyId] = useState<number | ''>('')
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  // Как показывать вопросы: квизом (по умолчанию) или все сразу.
  const [surveyView, setSurveyView] = useState<'quiz' | 'form'>('quiz')

  async function load() {
    setLoading(true)
    try {
      const [s, f]: any = await Promise.all([
        api.surveys.list().catch(() => ({ surveys: [] })),
        api.requestForms.get(ownerType, ownerId).catch(() => ({ form: null })),
      ])
      const list = Array.isArray(s) ? s : (s?.surveys ?? s?.items ?? [])
      setSurveys(Array.isArray(list) ? list : [])
      setForm(f?.form || null)
      if (f?.form) {
        setSurveyId(f.form.survey_id)
        setTitle(f.form.title || '')
        setSubtitle(f.form.subtitle || '')
        setSurveyView(f.form.survey_view === 'form' ? 'form' : 'quiz')
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [ownerType, ownerId])

  async function save() {
    if (!surveyId) { alert('Выберите анкету — в неё будут попадать заявки'); return }
    setSaving(true)
    try {
      await api.requestForms.save(ownerType, ownerId, {
        survey_id: Number(surveyId),
        title: title.trim() || null,
        subtitle: subtitle.trim() || null,
        survey_view: surveyView,
        is_active: true,
      })
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!confirm('Убрать форму заявки? Уже собранные заявки останутся в анкете.')) return
    setSaving(true)
    try {
      await api.requestForms.remove(ownerType, ownerId)
      setForm(null); setSurveyId(''); setTitle(''); setSubtitle('')
    } catch (e: any) {
      alert(e?.message || 'Не удалось убрать')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="p-6 text-sm text-gray-400">Загружаем…</div>

  return (
    <div className="space-y-5">
      {/* ⚠️ Пояснение обязательно: без него разница с тарифами не читается —
          человек думает, что заявка тоже записывает на событие. */}
      <div className="rounded-xl bg-blue-50 border border-blue-100 p-4">
        <p className="text-sm text-gray-700 leading-relaxed">
          <b>Форма заявки не регистрирует на событие.</b> Человек заполняет вашу
          анкету и видит «с вами свяжутся», а ответ попадает в заявки этой анкеты —
          там же, где вы их обрабатываете. Программу, подарки и чат он не получает.
        </p>
        <p className="text-sm text-gray-500 mt-2 leading-relaxed">
          Нужна регистрация или оплата — это <b>Тарифы</b> на соседней вкладке.
          Можно и то и другое сразу: тогда человек выберет, купить участие или
          оставить заявку.
        </p>
      </div>

      {surveys.length === 0 ? (
        <div className="rounded-xl border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-600">
            Сначала создайте анкету — в неё будут падать заявки.
          </p>
          <Link href="/dashboard/surveys"
                className="btn-gold mt-4 inline-block px-5 py-2.5 rounded-xl text-sm">
            Перейти в Анкеты
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Анкета для заявок
            </label>
            <select
              value={surveyId}
              onChange={e => setSurveyId(e.target.value ? Number(e.target.value) : '')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
            >
              <option value="">— выберите анкету —</option>
              {surveys.map((s: any) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
            <p className="text-xs text-gray-400 mt-1.5">
              Вопросы этой анкеты человек и увидит. Ответы — во вкладке «Ответы» анкеты.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Заголовок</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
                   maxLength={80}
                   className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            <p className="text-xs text-gray-400 mt-1.5">Пусто — будет «Оставить заявку».</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Подпись под заголовком
            </label>
            <input value={subtitle} onChange={e => setSubtitle(e.target.value)}
                   maxLength={160}
                   className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Как показывать вопросы
            </label>
            <div className="flex gap-2">
              {[
                { v: 'quiz' as const, t: 'По одному, квизом' },
                { v: 'form' as const, t: 'Все вопросы сразу' },
              ].map(o => (
                <button key={o.v} type="button" onClick={() => setSurveyView(o.v)}
                  className={`flex-1 rounded-xl border px-3 py-2.5 text-sm ${
                    surveyView === o.v
                      ? 'border-[#25455D] bg-[#25455D] text-white'
                      : 'border-gray-200 bg-white text-gray-700'
                  }`}
                >{o.t}</button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">
              Квизом человек отвечает шаг за шагом и видит прогресс — длинную
              анкету так заполняют охотнее. Вопросы и ответы одни и те же,
              меняется только показ. Настройка действует и на лендинге, и на
              странице события.
            </p>
          </div>

          <div>
            {/* ⚠️ Своего текста «спасибо» у формы больше нет (миграция 519):
                экран после отправки настраивается ОДИН раз — в анкете, и
                одинаков на лендинге, странице анкеты и в Mini App. */}
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Что показать после отправки
            </label>
            <p className="text-sm text-gray-500">
              Текст «спасибо», подарок или кнопки службы заботы настраиваются в самой анкете.{' '}
              {surveyId ? (
                <a href={`/dashboard/surveys/${surveyId}?tab=edit`} className="underline text-[#25455D]">
                  Открыть настройки анкеты
                </a>
              ) : null}
            </p>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button onClick={save} disabled={saving}
                    className="btn-gold px-5 py-2.5 rounded-xl text-sm disabled:opacity-60">
              {saving ? 'Сохраняем…' : (form ? 'Сохранить' : 'Добавить форму заявки')}
            </button>
            {form && (
              <button onClick={remove} disabled={saving}
                      className="text-sm text-gray-400 hover:text-red-500">
                Убрать форму
              </button>
            )}
          </div>
        </div>
      )}

      {form && (
        <p className="text-xs text-gray-400 leading-relaxed">
          Форма показывается на странице события и на лендинге — там блок
          «Анкета / Заявка» подтянет её сам, выбирать анкету второй раз не нужно.
        </p>
      )}
    </div>
  )
}
