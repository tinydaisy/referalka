'use client'

/**
 * Карточка анкеты: настройки, вопросы, отчёт (миграция 280).
 *
 * ⚠️ Вопрос можно привязать к полю контакта — тогда ответ ложится в карточку
 * человека и по нему фильтруется база. Тип и варианты в этом случае берутся у
 * поля, чтобы накопленные значения не разъехались.
 */
import { useEffect, useState, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import AnswersTable from '@/components/surveys/AnswersTable'
import DashboardView from '@/components/analytics/DashboardView'
import { useMe } from '@/hooks/useMe'
import { useUrlTab } from '@/hooks/useUrlTab'
import { ArrowLeft, Plus, Trash2, X, Copy, Check, GripVertical, ExternalLink, Pencil, Lock } from 'lucide-react'
import FileUploader from '@/components/FileUploader'
import { MultiSelectDropdown } from '@/components/MultiSelectDropdown'

const KINDS = [
  { value: 'text', label: 'Короткий текст' },
  { value: 'textarea', label: 'Длинный текст' },
  { value: 'number', label: 'Число' },
  { value: 'date', label: 'Дата' },
  { value: 'scale', label: 'Шкала 1–10' },
  { value: 'select', label: 'Выбор одного варианта' },
  { value: 'multiselect', label: 'Выбор нескольких' },
  { value: 'bool', label: 'Да / Нет' },
]
const NEEDS_OPTIONS = new Set(['select', 'multiselect'])
const kindLabel = (k: string) => KINDS.find(x => x.value === k)?.label || k

const DARK = '#25455D'   // фирменный синий

type SurveyTab = 'edit' | 'answers' | 'report' | 'dashboard'
const SURVEY_TABS: readonly SurveyTab[] = ['edit', 'answers', 'report', 'dashboard']

/**
 * ⚠️ Обёртка в `Suspense` ОБЯЗАТЕЛЬНА: внутри страница читает вкладку из
 * адреса (useUrlTab → useSearchParams), а без обёртки СБОРКА ПАДАЕТ ЦЕЛИКОМ —
 * «useSearchParams() should be wrapped in a suspense boundary». Проверка
 * типов такую ошибку не ловит, она вылезает только при сборке страницы.
 */
export default function SurveyPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-gray-400">Загружаем…</p>}>
      <SurveyPageInner />
    </Suspense>
  )
}

function SurveyPageInner() {
  const { id } = useParams<{ id: string }>()
  const { isAssistant } = useMe()
  // ⚠️ Ответы и отчёт — РАЗНЫЕ вкладки (решение владельца): список
  // заполнивших и сводка по вопросам — разные задачи, смешивать нельзя.
  // ⚠️ Через useUrlTab: он не только читает вкладку из адреса, но и ПИШЕТ её
  // туда при переключении. Без записи обновление страницы всегда возвращало
  // на «Вопросы и настройки», даже если человек работал с ответами.
  const [tab, setTab] = useUrlTab<SurveyTab>('tab', 'edit', SURVEY_TABS)
  const [survey, setSurvey] = useState<any>(null)
  const [fields, setFields] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const [s, f] = await Promise.all([
      api.surveys.get(Number(id)),
      api.contactFields.list().catch(() => []),
    ])
    setSurvey(s); setFields(f); setLoading(false)
  }
  useEffect(() => { load() }, [id])

  if (loading) return <p className="p-6 text-sm text-gray-400">Загружаем…</p>
  if (!survey) return <p className="p-6 text-sm text-red-600">Анкета не найдена</p>

  return (
    /* ⚠️ Своей ширины страница НЕ задаёт: её держит общая обёртка кабинета
       (`max-w-6xl` в DashboardLayout) — по неё же идёт плашка тарифа сверху.
       Было `max-w-4xl`, и страница анкеты обрывалась заметно левее остальных
       разделов: таблица ответов и колонки дашборда жались, справа зияло
       пустое место. Длинные текстовые формы ограничиваются САМИ (см. ниже),
       а не за счёт всей страницы. */
    <div>
      <Link href="/dashboard/surveys"
            className="mb-4 flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft size={14} /> Все анкеты
      </Link>

      {/* Название правится прямо в заголовке — по карандашику рядом. */}
      <SurveyTitle survey={survey} onSaved={load} readOnly={isAssistant} />
      <p className="mb-6 text-sm text-gray-500">
        {survey.questions?.length || 0} вопрос(ов)
      </p>

      <div className="mb-6 flex gap-2 border-b border-gray-200">
        {([
          ['edit', 'Вопросы и настройки'],
          ['answers', 'Ответы'],
          ['report', 'Отчёт'],
          ['dashboard', 'Дашборды анкеты'],
        ] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
                  className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm ${
                    tab === key
                      ? 'border-[#25455D] font-semibold text-[#25455D]'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}>
            {label}
            {/* Сколько заявок ждут обработки. Считает бэкенд тем же
                выражением, что цифры в меню и в списке анкет — иначе
                экраны показывали бы разные числа. */}
            {key === 'answers' && survey.unprocessed_count > 0 && (
              <span title={`Заявок ждут обработки: ${survey.unprocessed_count}`}
                    className="rounded-full px-1.5 py-0.5 text-[11px] font-bold"
                    style={{ background: '#FFCFA4', color: '#25455D' }}>
                {survey.unprocessed_count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Формы и отчёт держим в читаемой колонке: строка во всю ширину
          экрана читается тяжело. Таблице ответов, дашбордам и колонкам,
          наоборот, нужна вся ширина — им лимит не ставим. */}
      {tab === 'edit' && (
        <div className="max-w-4xl">
          <EditTab survey={survey} fields={fields} onChanged={load} readOnly={isAssistant} />
        </div>
      )}
      {tab === 'answers' && <AnswersTab surveyId={Number(id)} />}
      {tab === 'report' && <div className="max-w-4xl"><ReportTab surveyId={Number(id)} /></div>}
      {/* Дашборды этой анкеты. Движок общий с разделом «Аналитика» — это
          два входа в одно место, а не два разных списка. */}
      {tab === 'dashboard' && <DashboardView surveyId={Number(id)} />}
    </div>
  )
}

/* ─────────────────────────── Вопросы и настройки ────────────────────────── */

/**
 * Название анкеты в заголовке + правка по карандашику.
 *
 * ⚠️ Правим ЗДЕСЬ, а не в списке анкет: название меняют, уже открыв анкету и
 * увидев её содержимое, — там же, где правятся остальные её настройки.
 */
function SurveyTitle({ survey, onSaved, readOnly }: any) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(survey.title || '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const v = title.trim()
    // Пусто или не менялось — просто закрываем, лишний запрос не шлём.
    if (!v || v === survey.title) { setEditing(false); setTitle(survey.title || ''); return }
    setSaving(true)
    try {
      await api.surveys.update(survey.id, { title: v })
      setEditing(false)
      onSaved()
    } catch (e: any) {
      alert(e?.message || 'Не удалось переименовать')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <div className="mb-1 flex items-center gap-2">
        <input
          autoFocus
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') save()
            // ⚠️ Esc возвращает прежнее название, а не сохраняет набранное:
            // его жмут именно когда передумали переименовывать.
            if (e.key === 'Escape') { setEditing(false); setTitle(survey.title || '') }
          }}
          disabled={saving}
          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-2xl font-bold text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button onClick={save} disabled={saving} title="Сохранить"
                className="shrink-0 rounded-lg bg-[#25455D] px-3 py-2 text-white disabled:opacity-50">
          <Check size={16} />
        </button>
        <button onClick={() => { setEditing(false); setTitle(survey.title || '') }}
                disabled={saving} title="Отмена"
                className="shrink-0 rounded-lg border border-gray-200 px-3 py-2 text-gray-500">
          <X size={16} />
        </button>
      </div>
    )
  }

  return (
    <div className="mb-1 flex items-center gap-2">
      <h1 className="text-2xl font-bold text-gray-900">{survey.title}</h1>
      {/* ⚠️ Карандашик НЕ бледно-серый: рядом крупный жирный заголовок, и на
          его фоне светлая иконка не читалась вовсе — кнопку не замечали.
          Фирменный тёмный цвет, подложка при наведении, размер побольше. */}
      {!readOnly && (
        <button onClick={() => setEditing(true)} title="Переименовать"
                className="shrink-0 rounded-lg p-1.5 text-[#25455D] transition-colors hover:bg-gray-100">
          <Pencil size={18} strokeWidth={2.2} />
        </button>
      )}
    </div>
  )
}


function EditTab({ survey, fields, onChanged, readOnly }: any) {
  const [adding, setAdding] = useState(false)
  // Быстрое добавление уже заведённого поля контакта отдельной кнопкой:
  // внутри формы вопроса эту возможность не находят (замечание владельца).
  const [addingField, setAddingField] = useState(false)
  // Поле сотрудника: тот же вопрос анкеты, но заполняют его при разборе
  // заявок, а посетитель не видит.
  const [addingStaff, setAddingStaff] = useState(false)
  const [copied, setCopied] = useState('')

  const allQuestions = survey.questions || []
  const visitorQuestions = allQuestions.filter((q: any) => q.filled_by !== 'staff')
  const staffQuestions = allQuestions.filter((q: any) => q.filled_by === 'staff')

  const copy = (url: string, key: string) => {
    navigator.clipboard.writeText(url)
    setCopied(key); setTimeout(() => setCopied(''), 1500)
  }

  const links: Array<[string, string]> = [
    ['Ссылка', survey.links?.web],
    ['Telegram', survey.links?.telegram],
    ['ВКонтакте', survey.links?.vk],
    ['MAX', survey.links?.max],
  ].filter(([, u]) => !!u) as Array<[string, string]>

  return (
    <div className="space-y-6">
      {/* ⚠️ Имя, почта и телефон в анкете УЖЕ ЕСТЬ — отдельными вопросами их
          заводить не нужно. Клиенты создавали вопрос «Имя» руками и получали
          в анкете два одинаковых поля. Плашка стоит ПЕРЕД ссылками: её читают
          ровно тогда, когда собираются анкету отправлять. */}
      <div className="rounded-xl border p-4 text-sm font-semibold"
           style={{ borderColor: '#F3D9A4', background: 'rgba(255, 207, 164, 0.28)', color: '#25455D' }}>
        Имя, почту и телефон добавлять не нужно — они подставятся сами у тех,
        кто уже есть в базе.
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="mb-2 font-semibold text-gray-800">Ссылки на анкету</h3>
        <p className="mb-3 text-sm text-gray-500">
          Отправьте любую — кнопкой в рассылке, сообщением в боте или ссылкой в сторис.
          Тем, кто перешёл из бота, имя и контакты подставятся сами.
        </p>
        {/* Копирование И открытие: ссылку надо и дать людям, и самому
            посмотреть, как анкета выглядит. Раньше была только копия —
            чтобы просто открыть, её вставляли в адресную строку руками. */}
        <div className="flex flex-wrap gap-2">
          {links.map(([label, url]) => (
            <span key={label}
                  className="inline-flex items-stretch overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
              <button onClick={() => copy(url, label)}
                      title="Скопировать ссылку"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100">
                {copied === label ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                {label}
              </button>
              <a href={url} target="_blank" rel="noopener noreferrer"
                 title="Открыть анкету"
                 className="inline-flex items-center border-l border-gray-200 px-2.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800">
                <ExternalLink size={14} />
              </a>
            </span>
          ))}
        </div>
      </div>

      {/* ⚠️ Вопросы ВЫШЕ настроек: кнопка «Сохранить» из блока настроек
          висела над списком вопросов и читалась как «сохранить вопросы».
          Кнопка должна стоять под тем, что она сохраняет. */}
      {/* Порядок на странице повторяет порядок в самой анкете: сначала то,
          что человек видит вверху, потом вопросы. */}
      <SettingsBlock survey={survey} onChanged={onChanged} readOnly={readOnly} part="header" />

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-gray-800">Вопросы анкеты</h3>
          {/* ⚠️ Порядок кнопок значим: «поле контакта» намеренно ТРЕТЬЯ.
              Раньше она стояла первой, и в неё жали не глядя — хотя нужна
              она реже всего. */}
          {!readOnly && !adding && !addingStaff && !addingField && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setAdding(true)} className="btn-gold inline-flex items-center gap-2">
                <Plus size={16} /> Добавить вопрос анкеты
              </button>
              <button onClick={() => setAddingStaff(true)}
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                <Plus size={16} /> Добавить поле сотрудника
              </button>
              {fields.length > 0 && (
                <button onClick={() => setAddingField(true)}
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  <Plus size={16} /> Добавить поле контакта
                </button>
              )}
            </div>
          )}
        </div>

        {addingField && (
          <AddFieldBlock surveyId={survey.id} fields={fields}
                         used={(survey.questions || []).map((q: any) => q.field_id).filter(Boolean)}
                         onClose={() => setAddingField(false)}
                         onSaved={() => { setAddingField(false); onChanged() }} />
        )}

        {adding && (
          <QuestionForm surveyId={survey.id} fields={fields}
                        onClose={() => setAdding(false)}
                        onSaved={() => { setAdding(false); onChanged() }} />
        )}

        {addingStaff && (
          <QuestionForm surveyId={survey.id} fields={fields} filledBy="staff"
                        onClose={() => setAddingStaff(false)}
                        onSaved={() => { setAddingStaff(false); onChanged() }} />
        )}

        {!visitorQuestions.length && !adding && (
          <p className="text-sm text-gray-400">
            Вопросов пока нет.
          </p>
        )}

        <QuestionsList survey={survey} fields={fields} questions={visitorQuestions}
                       onChanged={onChanged} readOnly={readOnly} />

        {/* Поля сотрудника — отдельным блоком: посетитель их не видит, и
            смешивать их с вопросами анкеты в одном списке значило бы
            каждый раз гадать, что увидит человек, а что нет. */}
        {staffQuestions.length > 0 && (
          /* ⚠️ Выделен фирменным синим, а не серым: серый сливался с
             белыми карточками вопросов, и блок терялся на странице. */
          <div className="mt-6 rounded-xl border-2 p-4"
               style={{ borderColor: `${DARK}40`, background: `${DARK}0F` }}>
            <div className="mb-1 flex items-center gap-2">
              <Lock size={14} style={{ color: DARK }} />
              <h4 className="font-semibold" style={{ color: DARK }}>Поля сотрудника</h4>
            </div>
            <p className="mb-3 text-sm text-gray-600">
              Их заполняете вы и ваши помощники при разборе ответов.
              В анкете посетитель их не видит.
            </p>
            <QuestionsList survey={survey} fields={fields} questions={staffQuestions}
                           onChanged={onChanged} readOnly={readOnly} />
          </div>
        )}
      </div>

      <SettingsBlock survey={survey} onChanged={onChanged} readOnly={readOnly} part="settings" />
    </div>
  )
}

function SettingsBlock({ survey, onChanged, readOnly, part }: any) {
  // Подарок, который анкета выдаёт после заполнения.
  const [giftId, setGiftId] = useState<number | ''>(survey.gift_lead_magnet_id || '')
  const [magnets, setMagnets] = useState<any[]>([])
  useEffect(() => {
    // ⚠️ Эндпоинт отдаёт {items: [...]}, а не массив. Без разворота в
    // состояние попадал объект, и `magnets.map` ронял ВСЮ страницу анкеты
    // («Application error»). Массив на входе тоже поддерживаем — на случай,
    // если формат ответа где-то отличается.
    api.leadMagnets.list()
      .then((r: any) => setMagnets(Array.isArray(r) ? r : (r?.items || [])))
      .catch(() => setMagnets([]))
  }, [])
  const [intro, setIntro] = useState(survey.intro || '')
  const [imageUrl, setImageUrl] = useState(survey.image_url || '')
  const [afterMode, setAfterMode] = useState(survey.after_mode || 'thanks')
  const [thanks, setThanks] = useState(survey.thanks_text || '')
  const [redirect, setRedirect] = useState(survey.redirect_url || '')
  const [allowRepeat, setAllowRepeat] = useState(!!survey.allow_repeat)
  const [isActive, setIsActive] = useState(survey.is_active !== false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Кому уходит письмо о заполненной анкете.
  // ⚠️ Показываем `notify_emails_effective` — это либо сохранённый список,
  // либо, если настройку ещё не открывали, значения по умолчанию (владелец и
  // менеджеры заказов). Иначе галочек не было бы вовсе, и выглядело бы так,
  // будто письма не уходят никому, хотя они уходят.
  const [notifyEmails, setNotifyEmails] = useState<string[]>(
    survey.notify_emails_effective || [])
  // ⚠️ Пока клиент список не трогал, поле в PATCH не шлём: в базе останется
  // NULL («по умолчанию»), и заведённый позже менеджер заказов начнёт
  // получать письма сам. Отправь мы список всегда — настройка застыла бы на
  // сегодняшнем составе команды.
  const [notifyTouched, setNotifyTouched] = useState(false)
  const [recipients, setRecipients] = useState<any[]>([])
  useEffect(() => {
    if (part !== 'settings') return
    api.surveys.notifyRecipients()
      .then((r: any) => setRecipients(r?.recipients || []))
      .catch(() => setRecipients([]))
  }, [part])

  const save = async () => {
    setSaving(true)
    try {
      await api.surveys.update(survey.id, {
        intro, after_mode: afterMode, thanks_text: thanks,
        redirect_url: redirect, allow_repeat: allowRepeat, is_active: isActive,
        image_url: imageUrl || null,
        ...(notifyTouched ? { notify_emails: notifyEmails } : {}),
      })
      setSaved(true); setTimeout(() => setSaved(false), 1500)
      onChanged()
    } finally { setSaving(false) }
  }

  // ⚠️ Блок один, а рисуется в ДВУХ местах страницы: «Шапка анкеты» стоит
  // НАД вопросами (картинка и текст идут перед ними и у посетителя), всё
  // остальное — под ними. Состояние и сохранение общие, поэтому это один
  // компонент с переключателем `part`, а не две копии формы.
  if (part === 'header') {
    return (
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="mb-1 font-semibold text-gray-800">Шапка анкеты</h3>
        <p className="mb-3 text-sm text-gray-500">
          Картинка и текст, которые человек видит вверху, до вопросов.
        </p>

        <div className="mb-3">
          <span className="mb-1 block text-sm text-gray-600">Картинка вверху анкеты</span>
          <FileUploader mode="single" kind="survey_media"
                        value={imageUrl || null}
                        onChange={(u: string | null) => setImageUrl(u || '')} />
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-gray-600">Текст перед вопросами</span>
          <textarea className="input min-h-[70px]" value={intro} disabled={readOnly}
                    onChange={e => setIntro(e.target.value)} />
        </label>

        {!readOnly && (
          <div className="flex items-center gap-3">
            <button onClick={save} disabled={saving} className="btn-gold disabled:opacity-50">
              {saving ? 'Сохраняем…' : 'Сохранить шапку'}
            </button>
            {saved && <span className="text-sm text-green-600">Сохранено</span>}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="mb-3 font-semibold text-gray-800">Настройки анкеты</h3>

      <label className="mb-3 block">
        <span className="mb-1 block text-sm text-gray-600">Что показать после отправки</span>
        <select className="input bg-white" value={afterMode} disabled={readOnly}
                onChange={e => setAfterMode(e.target.value)}>
          <option value="thanks">Текст «спасибо»</option>
          <option value="url">Перевести на свою ссылку</option>
        </select>
      </label>

      {afterMode === 'thanks' ? (
        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-gray-600">Текст «спасибо»</span>
          <textarea className="input min-h-[60px]" value={thanks} disabled={readOnly}
                    onChange={e => setThanks(e.target.value)}
                    placeholder="Спасибо! Мы получили ваши ответы." />
        </label>
      ) : (
        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-gray-600">Куда перевести</span>
          <input className="input" value={redirect} disabled={readOnly}
                 onChange={e => setRedirect(e.target.value)}
                 placeholder="https://…" />
        </label>
      )}

      <label className="mb-3 block">
        <span className="mb-1 block text-sm text-gray-600">
          Выдать подарок за заполнение
        </span>
        <select className="input bg-white" value={giftId} disabled={readOnly}
                onChange={e => setGiftId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Не выдавать</option>
          {magnets.map((m: any) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-gray-500">
          {giftId
            ? 'Придёт сразу после отправки — ссылкой на странице и сообщением в бот.'
            : 'Выберите лид-магнит, если он выдаётся за заполнение этой анкеты.'}
        </span>
      </label>

      <p className="mb-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-500">
        Если анкета, наоборот, стоит ПЕРЕД подарком (включается в самом
        лид-магните) — настраивать это здесь не нужно, там своя галочка.
      </p>

      {/* Кому приходит письмо о заполненной анкете. В чат уведомлений
          сообщение уходит всегда — там его видит вся команда, настраивать
          нечего; письма же нужны не каждому помощнику. */}
      <div className="mb-3">
        {readOnly ? (
          // У помощника настройки анкеты только для чтения — показываем
          // список текстом: выпадающий список с галочками намекал бы, что
          // его можно менять, а сохранить он всё равно не сможет.
          <>
            <span className="mb-1 block text-sm text-gray-600">
              Кому слать письмо о заполнении
            </span>
            <div className="input bg-gray-50 text-gray-600">
              {notifyEmails.length ? notifyEmails.join(', ') : 'Никому'}
            </div>
          </>
        ) : (
          <MultiSelectDropdown<string>
            label="Кому слать письмо о заполнении"
            options={recipients.map((r: any) => ({ value: r.email, label: r.label, hint: r.email }))}
            values={notifyEmails}
            onChange={(next) => { setNotifyEmails(next); setNotifyTouched(true) }}
            placeholder="Никому"
            searchPlaceholder="Поиск по имени или почте…"
            emptyText="Помощников пока нет"
          />
        )}
        <span className="mt-1 block text-xs text-gray-500">
          Уведомление в чат уходит всегда. По умолчанию письмо получают
          основатель и менеджеры заказов — остальных помощников можно
          отметить здесь.
        </span>
      </div>

      <label className="mb-2 flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={allowRepeat} disabled={readOnly}
               onChange={e => setAllowRepeat(e.target.checked)}
               className="h-4 w-4 rounded border-gray-300" />
        <span className="text-sm text-gray-700">Можно заполнять несколько раз</span>
      </label>
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={isActive} disabled={readOnly}
               onChange={e => setIsActive(e.target.checked)}
               className="h-4 w-4 rounded border-gray-300" />
        <span className="text-sm text-gray-700">Анкета активна</span>
      </label>

      {!readOnly && (
        <div className="mt-4 flex items-center gap-3">
          <button onClick={save} disabled={saving} className="btn-gold disabled:opacity-50">
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          {saved && <span className="text-sm text-green-600">Сохранено</span>}
        </div>
      )}
    </div>
  )
}

/**
 * Добавление уже заведённых полей контакта прямо в анкету.
 *
 * ⚠️ Отмечать можно СРАЗУ НЕСКОЛЬКО: поля заводятся пачкой («Доход», «Ниша»,
 * «Статус»), и добавлять их по одному через форму вопроса — лишняя возня.
 * Тип и варианты берутся у поля, поэтому вопрос собирается сам.
 *
 * Уже добавленные в эту анкету поля показываются отмеченными и заблокированы —
 * второй раз тот же вопрос не нужен.
 */
function AddFieldBlock({ surveyId, fields, used, onClose, onSaved }: any) {
  const [picked, setPicked] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const usedSet = new Set<number>(used || [])

  const save = async () => {
    if (!picked.length) { onClose(); return }
    setSaving(true)
    try {
      // Последовательно, а не пачкой: порядок вопросов должен совпасть с
      // порядком, в котором клиент их отметил.
      for (const id of picked) {
        const f = fields.find((x: any) => x.id === id)
        if (!f) continue
        await api.surveys.addQuestion(surveyId, {
          title: f.title, field_id: f.id, is_required: false,
        })
      }
      onSaved()
    } finally { setSaving(false) }
  }

  return (
    <div className="mb-3 rounded-xl border border-[#25455D]/30 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="font-semibold text-gray-800">Поля контакта</h4>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <X size={18} />
        </button>
      </div>
      <p className="mb-3 text-sm text-gray-500">
        Отметьте, что спросить. Ответы лягут в карточку человека и будут
        фильтровать базу.
      </p>

      <div className="space-y-1.5">
        {fields.map((f: any) => {
          const already = usedSet.has(f.id)
          return (
            <label key={f.id}
                   className={`flex items-center gap-2 rounded-lg border p-2.5 text-sm ${
                     already
                       ? 'cursor-default border-gray-100 bg-gray-50 text-gray-400'
                       : 'cursor-pointer border-gray-200 hover:bg-gray-50'
                   }`}>
              <input type="checkbox" disabled={already}
                     checked={already || picked.includes(f.id)}
                     onChange={e => setPicked(
                       e.target.checked
                         ? [...picked, f.id]
                         : picked.filter(x => x !== f.id))}
                     className="h-4 w-4 rounded border-gray-300" />
              <span className="text-gray-800">{f.title}</span>
              <span className="text-xs text-gray-400">{kindLabel(f.kind)}</span>
              {already && <span className="ml-auto text-xs">уже в анкете</span>}
            </label>
          )
        })}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600">
          Отмена
        </button>
        <button onClick={save} disabled={saving || !picked.length}
                className="btn-gold disabled:opacity-50">
          {saving ? 'Добавляем…' : `Добавить${picked.length ? ` (${picked.length})` : ''}`}
        </button>
      </div>
    </div>
  )
}


/**
 * Список вопросов с перетаскиванием.
 *
 * ⚠️ Порядок применяется сразу на экране, а запрос уходит следом: ждать
 * ответа сервера, держа карточку под курсором, — заметная задержка. Сервер
 * пишет новый порядок одной транзакцией, поэтому расхождения не будет.
 *
 * ⚠️ draggable включается ТОЛЬКО на ручке ⠿ — иначе браузер начинает тащить
 * карточку при выделении текста в полях (та же засада, что в конструкторе
 * лендинга).
 */
function QuestionsList({ survey, fields, questions, onChanged, readOnly }: any) {
  // Список приходит уже отфильтрованным по группе (вопросы посетителя либо
  // поля сотрудника) — перетаскивание работает внутри своей группы.
  const items = questions || survey.questions || []
  const [order, setOrder] = useState<any[]>(items)
  const [dragId, setDragId] = useState<number | null>(null)

  // ⚠️ Сравниваем по составу и порядку id, а не по самому массиву: он
  // новый на каждый рендер, и зависимость от него зациклила бы обновление.
  const itemsKey = items.map((q: any) => q.id).join(',')
  useEffect(() => { setOrder(items) }, [itemsKey])   // eslint-disable-line react-hooks/exhaustive-deps

  const drop = async (targetId: number) => {
    if (dragId == null || dragId === targetId) { setDragId(null); return }
    const from = order.findIndex(q => q.id === dragId)
    const to = order.findIndex(q => q.id === targetId)
    if (from < 0 || to < 0) { setDragId(null); return }
    const next = [...order]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setOrder(next)
    setDragId(null)
    try {
      await api.surveys.reorderQuestions(survey.id, next.map(q => q.id))
    } catch {
      onChanged()   // не сохранилось — вернём порядок с сервера
    }
  }

  if (!order.length) return null

  return (
    <div className="space-y-2">
      {order.map((q: any) => (
        <QuestionRow key={q.id} surveyId={survey.id} question={q} fields={fields}
                     onChanged={onChanged} readOnly={readOnly}
                     draggable={!readOnly}
                     isDragging={dragId === q.id}
                     onDragStart={() => setDragId(q.id)}
                     onDragOver={(e: React.DragEvent) => e.preventDefault()}
                     onDrop={() => drop(q.id)} />
      ))}
    </div>
  )
}


function QuestionRow({
  surveyId, question, fields, onChanged, readOnly,
  draggable, isDragging, onDragStart, onDragOver, onDrop,
}: any) {
  const [editing, setEditing] = useState(false)
  // ⚠️ draggable включаем только на ручке — иначе браузер тащит карточку
  // при выделении текста в полях.
  const [canDrag, setCanDrag] = useState(false)
  // Вопрос привязан к доп. полю контакта — правится в разделе «Поля».
  const isField = !!question.field_id

  const remove = async () => {
    if (!confirm(`Удалить вопрос «${question.title}»? Ответы на него тоже удалятся.`)) return
    await api.surveys.deleteQuestion(surveyId, question.id)
    onChanged()
  }

  if (editing) {
    return (
      <QuestionForm surveyId={surveyId} question={question} fields={fields}
                    onClose={() => setEditing(false)}
                    onSaved={() => { setEditing(false); onChanged() }} />
    )
  }

  return (
    <div
      draggable={draggable && canDrag}
      onDragStart={onDragStart}
      onDragEnd={() => setCanDrag(false)}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`flex items-center justify-between gap-2 rounded-xl border p-4 ${
        isDragging ? 'border-[#25455D] opacity-40'
                   : isField ? 'border-[#FFCFA4] bg-[#FFF8F0]' : 'border-gray-200 bg-white'
      }`}
    >
      {draggable && (
        <span
          onMouseDown={() => setCanDrag(true)}
          onMouseUp={() => setCanDrag(false)}
          onMouseLeave={() => setCanDrag(false)}
          title="Перетащите, чтобы поменять порядок"
          className="shrink-0 cursor-grab text-gray-400 active:cursor-grabbing"
        >
          <GripVertical size={18} />
        </span>
      )}
      {question.image_url && (
        <img src={question.image_url} alt=""
             className="h-12 w-12 shrink-0 rounded-lg object-cover" />
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium text-gray-900">
          {question.title}
          {question.is_required && <span className="ml-1 text-red-500">*</span>}
        </div>
        <div className="mt-0.5 text-xs text-gray-500">
          {kindLabel(question.kind)}
          {isField && (
            <span className="ml-1.5 rounded bg-[#FFCFA4] px-1.5 py-0.5 text-[11px] font-medium text-[#25455D]">
              доп. поле
            </span>
          )}
        </div>
      </div>
      {!readOnly && (
        <div className="flex shrink-0 gap-2">
          {/* ⚠️ У вопроса-поля название, тип и варианты правятся В РАЗДЕЛЕ
              «Поля контакта», а не здесь: поле общее для всех анкет и для
              карточек всех контактов. Правка тут развалила бы накопленные
              значения. Отсюда его можно только убрать из анкеты. */}
          {/* ⚠️ Открываем в НОВОЙ вкладке: клик по кнопке рядом с «Изменить»
              читается как правка вопроса, а уход со страницы терял место в
              длинном списке (жалоба владельца: «меня выбило в список анкет»). */}
          {isField ? (
            <a href="/dashboard/surveys?tab=fields" target="_blank" rel="noreferrer"
               title="Название, тип и варианты у доп. поля меняются в разделе «Поля контакта» — оно общее для всех анкет"
               className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-50">
              Настроить поле ↗
            </a>
          ) : (
          <button onClick={() => setEditing(true)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
            Изменить
          </button>
          )}
          {/* «Обработано» удалить нельзя: по ней ведётся разбор заявок и
              строится дашборд анкеты. Переименовать — можно. */}
          {question.is_protected ? (
            <span title="Это поле нельзя удалить — по нему ведётся разбор заявок"
                  className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-gray-300">
              <Lock size={15} />
            </span>
          ) : (
            <button onClick={remove}
                    className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function QuestionForm({ surveyId, question, fields, onClose, onSaved, filledBy }: any) {
  // Поле сотрудника: заполняется при разборе заявок, посетителю не видно.
  const staff = (filledBy || question?.filled_by) === 'staff'
  const [title, setTitle] = useState(question?.title || '')
  const [kind, setKind] = useState(question?.kind || (staff ? 'bool' : 'text'))
  const [fieldId, setFieldId] = useState<number | ''>(question?.field_id || '')
  const [options, setOptions] = useState<string[]>(
    Array.isArray(question?.options) ? question.options : [])
  const [required, setRequired] = useState(!!question?.is_required)
  const [imageUrl, setImageUrl] = useState(question?.image_url || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  // Привязали к полю контакта → тип и варианты берём у поля: иначе ответы
  // разъедутся с уже накопленными значениями этого поля.
  // ⚠️ У поля сотрудника привязки нет: поле контакта — одно значение на
  // человека, а обрабатывают каждую заявку отдельно.
  const linked = staff ? null : fields.find((f: any) => f.id === Number(fieldId))
  const effKind = linked ? linked.kind : kind
  const effOptions = linked
    ? (Array.isArray(linked.options) ? linked.options : [])
    : options

  const save = async () => {
    if (!title.trim()) { setErr('Впишите текст вопроса'); return }
    if (!linked && NEEDS_OPTIONS.has(kind) && options.filter(o => o.trim()).length < 2) {
      setErr('Добавьте хотя бы два варианта ответа'); return
    }
    setSaving(true); setErr('')
    try {
      const payload: any = {
        title: title.trim(), is_required: staff ? false : required,
        field_id: staff || !fieldId ? null : Number(fieldId),
        image_url: staff ? null : (imageUrl || null),
      }
      if (!question) payload.filled_by = staff ? 'staff' : 'visitor'
      if (!linked) {
        payload.kind = kind
        payload.options = NEEDS_OPTIONS.has(kind) ? options.filter(o => o.trim()) : []
        if (kind === 'scale') { payload.scale_min = 1; payload.scale_max = 10 }
      }
      if (question) await api.surveys.updateQuestion(surveyId, question.id, payload)
      else await api.surveys.addQuestion(surveyId, payload)
      onSaved()
    } catch (e: any) {
      setErr(e.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  return (
    <div className="mb-3 rounded-xl border border-[#25455D]/30 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="font-semibold text-gray-800">
          {question
            ? (staff ? 'Изменить поле сотрудника' : 'Изменить вопрос')
            : (staff ? 'Новое поле сотрудника' : 'Новый вопрос')}
        </h4>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
      </div>

      {staff && (
        <p className="mb-3 rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
          Это поле заполняете вы и ваши помощники при разборе заявок —
          прямо в таблице ответов. Посетитель его не увидит.
        </p>
      )}

      <label className="mb-3 block">
        <span className="mb-1 block text-sm text-gray-600">
          {staff ? 'Название поля' : 'Текст вопроса'}
        </span>
        <input className="input" value={title} onChange={e => setTitle(e.target.value)} />
      </label>

      {!staff && (
        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-gray-600">Записать ответ в поле контакта</span>
          <select className="input bg-white" value={fieldId}
                  onChange={e => setFieldId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Не записывать — ответ только в этой анкете</option>
            {fields.map((f: any) => (
              <option key={f.id} value={f.id}>{f.title}</option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-gray-500">
            {linked
              ? `Ответ попадёт в карточку человека. Тип берётся у поля: ${kindLabel(linked.kind)}.`
              : 'Выберите поле, чтобы ответ сохранялся в карточке и фильтровал базу.'}
          </span>
        </label>
      )}

      {/* ⚠️ У «Обработано» тип менять нельзя: на галочке держится подсветка
          строк, отбор «обработаны» и дашборд. Название — можно. */}
      {!linked && !question?.is_protected && (
        <label className="mb-3 block">
          <span className="mb-1 block text-sm text-gray-600">Что вписывают</span>
          <select className="input bg-white" value={kind} onChange={e => setKind(e.target.value)}>
            {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </label>
      )}

      {question?.is_protected && (
        <p className="mb-3 rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
          Это галочка «обработано» — по ней подсвечиваются разобранные
          ответы и считается дашборд. Поменять можно только название.
        </p>
      )}

      {NEEDS_OPTIONS.has(effKind) && (
        <div className="mb-3">
          <span className="mb-1 block text-sm text-gray-600">Варианты ответа</span>
          {linked ? (
            <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
              {effOptions.join(' · ') || 'У поля пока нет вариантов'}
              <div className="mt-1 text-xs text-gray-500">
                Варианты берутся у поля «{linked.title}» — меняются в разделе «Поля контакта».
              </div>
            </div>
          ) : (
            <>
              {options.map((o, i) => (
                <div key={i} className="mb-2 flex gap-2">
                  <input className="input flex-1 min-w-0" value={o}
                         onChange={e => {
                           const next = [...options]; next[i] = e.target.value; setOptions(next)
                         }} />
                  <button onClick={() => setOptions(options.filter((_, j) => j !== i))}
                          className="rounded-lg border border-gray-200 px-2.5 text-gray-400 hover:text-red-600">
                    <X size={15} />
                  </button>
                </div>
              ))}
              <button onClick={() => setOptions([...options, ''])}
                      className="text-sm text-[#25455D] hover:underline">
                + Добавить вариант
              </button>
            </>
          )}
        </div>
      )}

      {/* Картинка и обязательность — только у вопросов посетителя: поле
          сотрудника показывается ячейкой в таблице, картинке там не место,
          а «обязательность» ни на что не влияет (форму никто не сдаёт). */}
      {!staff && (
        <>
          <div className="mb-3">
            <span className="mb-1 block text-sm text-gray-600">Картинка к вопросу</span>
            <FileUploader mode="single" kind="survey_media"
                          value={imageUrl || null}
                          onChange={(u: string | null) => setImageUrl(u || '')} />
          </div>

          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)}
                   className="h-4 w-4 rounded border-gray-300" />
            <span className="text-sm text-gray-700">Обязательный вопрос</span>
          </label>
        </>
      )}

      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}

      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600">
          Отмена
        </button>
        <button onClick={save} disabled={saving} className="btn-gold disabled:opacity-50">
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </div>
  )
}

/* ───────────────────────────────── Отчёт ────────────────────────────────── */

/** Отчёт — только сводка по вопросам. Список заполнивших живёт в «Ответах». */
function ReportTab({ surveyId }: { surveyId: number }) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.surveys.analytics(surveyId).then(setData).finally(() => setLoading(false))
  }, [surveyId])

  if (loading) return <p className="text-sm text-gray-400">Считаем…</p>
  if (!data) return null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-2xl font-bold text-gray-900">{data.people_total}</div>
          <div className="text-sm text-gray-500">человек заполнили</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-2xl font-bold text-gray-900">{data.responses_total}</div>
          <div className="text-sm text-gray-500">всего заполнений</div>
        </div>
      </div>

      {!data.questions?.length && (
        <p className="text-sm text-gray-400">В анкете пока нет вопросов.</p>
      )}

      {data.questions.map((q: any) => (
        <div key={q.id} className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-1 font-medium text-gray-900">{q.title}</div>
          <div className="mb-3 text-xs text-gray-500">
            Ответили: {q.answers_count}
            {q.avg != null && ` · средняя оценка ${q.avg}`}
          </div>

          {q.breakdown?.length > 0 && (
            <div className="space-y-2">
              {q.breakdown.map((b: any, i: number) => (
                <div key={i}>
                  <div className="mb-0.5 flex justify-between text-sm">
                    <span className="text-gray-700">{b.option}</span>
                    <span className="text-gray-500">
                      <b className="text-gray-900">{b.count}</b> · {b.percent}%
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                    <div className="h-full rounded-full bg-[#FFCFA4]"
                         style={{ width: `${b.percent}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {q.texts?.length > 0 && (
            <div className="space-y-2">
              {q.texts.slice(0, 30).map((t: any, i: number) => (
                <div key={i} className="rounded-lg bg-gray-50 p-2 text-sm">
                  <span className="text-gray-800">{t.value}</span>
                  <span className="ml-2 text-xs text-gray-400">— {t.name || 'Без имени'}</span>
                </div>
              ))}
              {q.texts.length > 30 && (
                <p className="text-xs text-gray-400">…и ещё {q.texts.length - 30}</p>
              )}
            </div>
          )}

          {!q.breakdown?.length && !q.texts?.length && (
            <p className="text-sm text-gray-400">Пока никто не ответил.</p>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Вкладка «Ответы» — таблица заявок.
 *
 * ⚠️ Сама таблица живёт отдельным компонентом: там сортировка, фильтры,
 * настройка колонок и правка полей сотрудника прямо в ячейках — в этом
 * файле они сделали бы страницу нечитаемой.
 */
function AnswersTab({ surveyId }: { surveyId: number }) {
  return <AnswersTable surveyId={surveyId} />
}
