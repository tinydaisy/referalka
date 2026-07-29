'use client'
import { useState, useEffect } from 'react'
import { Globe, Layout, Sparkles } from 'lucide-react'

/**
 * Единая секция «Настройки страницы регистрации».
 *
 * Три разных страницы, которые часто путают:
 *  • Простая страница события — встроенная, есть у всех: афиша, описание,
 *    кнопка записаться. Настраивается тут же (описание, текст кнопки,
 *    регистрация без контактных данных).
 *  • Плюсоновский лендинг — продающая страница, собранная в конструкторе
 *    (вкладка «Лендинг»). Показывается вместо простой, когда опубликован.
 *  • Сторонний лендинг — чужой сайт (Tilda, GetCourse, Taplink).
 *
 * Режим — локальный state (обе плитки КЛИКАБЕЛЬНЫ). Инициализируется по landing_url:
 * заполнен → сторонний. Выбор «внутренний» очищает URL (иначе Mini App продолжит
 * открывать чужую страницу). Поле URL видно ТОЛЬКО в режиме «сторонний».
 *
 * ⚠️ У КОЛЛАБ-события стороннего лендинга нет (allowExternal=false) — только внутренний.
 *
 * Общий компонент для мероприятий (OverviewTab) и конференций/турниров (SettingsTab).
 */
type RegMode = 'form' | 'landing' | 'external'

export default function LandingSettingsBlock({
  description, onDescription,
  landingUrl, onLandingUrl,
  ctaLabel, onCtaLabel,
  skipContactForm, onSkipContactForm,
  allowExternal = true,
  hasLanding = false,
  landingUrlInternal,
  regMode,
  onRegMode,
  onValidity,
}: {
  description: string
  onDescription: (v: string) => void
  landingUrl: string
  onLandingUrl: (v: string) => void
  ctaLabel: string
  onCtaLabel: (v: string) => void
  skipContactForm: boolean
  onSkipContactForm: (v: boolean) => void
  /** false — только внутренний лендинг (коллаб-событие) */
  allowExternal?: boolean
  /** Плюсоновский лендинг собран и опубликован (вкладка «Лендинг»). */
  hasLanding?: boolean
  /** Адрес плюсоновского лендинга — pluson.ru/e/{slug}. */
  landingUrlInternal?: string
  /** Способ регистрации: form | landing | external (миграция 262). */
  regMode?: string | null
  onRegMode?: (v: RegMode) => void
  /** Сообщает наверх текст ошибки ('' = всё в порядке). Страница по нему
      блокирует сохранение: ссылка регистрации не может быть пустой. */
  onValidity?: (error: string) => void
}) {
  // Режим держим в state — иначе, стерев URL, нельзя было бы остаться в «стороннем»
  // и напечатать новый адрес (поле исчезало бы на первом же символе).
  // ⚠️ Способ регистрации задаётся ЯВНО (миграция 262), а не угадывается по
  // заполненности URL: собранный в конструкторе лендинг в старую схему
  // «пусто = встроенная, заполнено = чужой сайт» не помещался вовсе.
  const initialMode: RegMode =
    regMode === 'landing' || regMode === 'external' || regMode === 'form'
      ? regMode
      : (allowExternal && landingUrl.trim() ? 'external' : 'form')
  const [mode, setMode] = useState<RegMode>(initialMode)
  useEffect(() => { setMode(initialMode) }, [initialMode])

  const choose = (m: RegMode) => {
    setMode(m)
    onRegMode?.(m)
    // Свой сайт больше не используется — адрес чистим, иначе Mini App
    // продолжит открывать чужую страницу.
    if (m !== 'external' && landingUrl) onLandingUrl('')
  }

  const isExternal = allowExternal && mode === 'external'

  // ⚠️ Ссылка регистрации не может быть пустой: с неё идут кнопки в рассылках
  // ({landing_url}), в боте и в Mini App. Поэтому не даём сохранить событие,
  // если выбранный способ не может дать рабочий адрес.
  const error =
    isExternal && !landingUrl.trim()
      ? 'Укажите адрес стороннего лендинга — без него кнопка «Зарегистрироваться» ведёт в никуда.'
      : (mode === 'landing' && !hasLanding)
        ? 'Плюсоновский лендинг ещё не опубликован — соберите и опубликуйте его на вкладке «Лендинг».'
        : ''
  useEffect(() => { onValidity?.(error) }, [error])

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
      <h2 className="block-title">Настройки страницы регистрации</h2>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      {allowExternal && (
        <div className="grid gap-3 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => choose('form')}
            className={`flex items-start gap-3 p-3.5 rounded-xl border-2 text-left transition-all ${
              mode === 'form' ? 'border-[#25455D] bg-[#25455D]/5' : 'border-gray-200 hover:border-gray-300'
            }`}>
            <Layout size={18} className={mode === 'form' ? 'text-[#25455D] mt-0.5' : 'text-gray-400 mt-0.5'} />
            <div>
              <p className="text-sm font-medium text-gray-900">Простая страница события</p>
              <p className="text-xs text-gray-400 mt-0.5">Афиша, описание и кнопка записаться — верстать ничего не нужно.</p>
            </div>
          </button>

          {/* Наш лендинг: регистрация идёт через него — человек попадает
              на pluson.ru/e/{slug}, а не на простую страницу. */}
          <button
            type="button"
            onClick={() => choose('landing')}
            className={`flex items-start gap-3 rounded-xl border-2 p-3.5 text-left transition-all ${
              mode === 'landing'
                ? 'border-[#25455D] bg-[#25455D]/5'
                : 'border-gray-200 hover:border-gray-300'
            }`}>
            <Sparkles size={18} className={mode === 'landing' ? 'mt-0.5 text-[#25455D]' : 'mt-0.5 text-gray-400'} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">Плюсоновский лендинг</p>
              <p className="mt-0.5 truncate text-xs text-gray-400">
                {hasLanding
                  ? `Опубликован: ${landingUrlInternal || ''}`
                  : 'Соберите его на вкладке «Лендинг»'}
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={() => choose('external')}
            className={`flex items-start gap-3 p-3.5 rounded-xl border-2 text-left transition-all ${
              isExternal ? 'border-[#25455D] bg-[#25455D]/5' : 'border-gray-200 hover:border-gray-300'
            }`}>
            <Globe size={18} className={isExternal ? 'text-[#25455D] mt-0.5' : 'text-gray-400 mt-0.5'} />
            <div>
              <p className="text-sm font-medium text-gray-900">Сторонний лендинг</p>
              <p className="text-xs text-gray-400 mt-0.5">Ваша страница на Tilda, GetCourse, Taplink и т.п.</p>
            </div>
          </button>
        </div>
      )}

      {mode === 'landing' ? (
        /* ── НАШ ЛЕНДИНГ: только галочка регистрации ── */
        <div className="space-y-3">
          <p className="text-sm text-gray-500">
            Человек с кнопки события попадёт на{' '}
            <span className="font-medium text-gray-700">{landingUrlInternal || 'ваш лендинг'}</span>.
            {!hasLanding && ' Лендинг ещё не опубликован — соберите его на вкладке «Лендинг».'}
          </p>
          {/* ⚠️ Галочка ОДНА на оба режима — то же поле skip_contact_form.
              К чему она относится, определяет выбранный способ регистрации:
              к простой странице или к нашему лендингу. Второго поля в базе
              заводить не нужно — смысл тот же. */}
          <SkipContactCheckbox
            checked={skipContactForm}
            onChange={onSkipContactForm}
          />
        </div>
      ) : isExternal ? (
        /* ── СТОРОННИЙ: только URL ── */
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">URL вашего лендинга</label>
          <input
            type="url"
            value={landingUrl}
            onChange={e => onLandingUrl(e.target.value)}
            placeholder="https://yoursite.com/event"
            className={`w-full px-4 py-2.5 rounded-xl border text-sm focus:outline-none ${
              landingUrl.trim() ? 'border-gray-200 focus:border-brand' : 'border-red-300 bg-red-50/40'
            }`}
          />
          <p className="text-xs text-gray-500 mt-2 leading-relaxed">
            Mini App будет открывать вашу страницу вместо встроенной. Чтобы вернуться к странице
            от ПЛЮСОНа — выберите «Внутренний лендинг» (адрес очистится).
          </p>
        </div>
      ) : (
        /* ── ВНУТРЕННИЙ: описание + текст кнопки + регистрация без контактов ── */
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Описание под афишей</label>
            <textarea
              value={description}
              onChange={e => onDescription(e.target.value)}
              rows={4}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
              placeholder="О чём это событие — пара предложений. Поддерживается HTML."
            />
            <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">
              Продающий текст. Показывается на странице события (веб и Mini App) до регистрации.
              Можно использовать HTML: {'<b>жирный</b>, <i>курсив</i>, <a href="...">ссылка</a>, <br>, <ul><li>списки</li></ul>'}.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Текст кнопки на лендинге</label>
            <input
              value={ctaLabel}
              onChange={e => onCtaLabel(e.target.value)}
              maxLength={40}
              placeholder="Хочу участвовать"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
            />
            <p className="text-xs text-gray-400 mt-1.5">
              Главная кнопка на встроенном лендинге. Пусто — будет «Хочу участвовать».
            </p>
          </div>

          {/* Обычная галочка: это настройка ВНУТРИ простой страницы, а не
              ещё один тип лендинга — рамкой-плиткой не выделяем. */}
          <SkipContactCheckbox
            checked={skipContactForm}
            onChange={onSkipContactForm}
          />
        </div>
      )}
    </div>
  )
}

/** Одна галочка на оба режима: и простую страницу, и наш лендинг. */
function SkipContactCheckbox({
  checked, onChange,
}: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 accent-[#25455D]" />
      <div>
        <p className="text-sm font-medium text-gray-800">Регистрировать без ввода контактных данных</p>
        <p className="mt-0.5 text-xs text-gray-400 leading-relaxed">
          Человек пришёл из бота — записываем сразу по его аккаунту, без формы.
          С рекламы и репостов форма всё равно нужна: иначе непонятно, кого записывать.
        </p>
      </div>
    </label>
  )
}
