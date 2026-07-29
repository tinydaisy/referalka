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
export default function LandingSettingsBlock({
  description, onDescription,
  landingUrl, onLandingUrl,
  ctaLabel, onCtaLabel,
  skipContactForm, onSkipContactForm,
  allowExternal = true,
  hasLanding = false,
  landingUrlInternal,
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
}) {
  // Режим держим в state — иначе, стерев URL, нельзя было бы остаться в «стороннем»
  // и напечатать новый адрес (поле исчезало бы на первом же символе).
  const [mode, setMode] = useState<'internal' | 'external'>(
    allowExternal && landingUrl.trim() ? 'external' : 'internal'
  )
  // Событие подгрузилось позже — синхронизируем режим один раз, когда пришёл URL.
  useEffect(() => {
    if (allowExternal && landingUrl.trim()) setMode('external')
  }, [allowExternal, landingUrl])

  const chooseInternal = () => {
    setMode('internal')
    if (landingUrl) onLandingUrl('')   // внутренний лендинг = стороннего URL нет
  }

  const isExternal = allowExternal && mode === 'external'

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
      <h2 className="block-title">Настройки страницы регистрации</h2>

      {allowExternal && (
        <div className="grid gap-3 sm:grid-cols-3">
          <button
            type="button"
            onClick={chooseInternal}
            className={`flex items-start gap-3 p-3.5 rounded-xl border-2 text-left transition-all ${
              !isExternal ? 'border-[#25455D] bg-[#25455D]/5' : 'border-gray-200 hover:border-gray-300'
            }`}>
            <Layout size={18} className={!isExternal ? 'text-[#25455D] mt-0.5' : 'text-gray-400 mt-0.5'} />
            <div>
              <p className="text-sm font-medium text-gray-900">Простая страница события</p>
              <p className="text-xs text-gray-400 mt-0.5">Афиша, описание и кнопка записаться — верстать ничего не нужно.</p>
            </div>
          </button>

          {/* Плюсоновский лендинг — продающая страница из конструктора.
              Плитка информационная: собирается он на вкладке «Лендинг», а
              не здесь, поэтому просто показываем состояние и адрес. */}
          <div className={`flex items-start gap-3 rounded-xl border-2 p-3.5 text-left ${
            hasLanding ? 'border-[#25455D] bg-[#25455D]/5' : 'border-gray-200'
          }`}>
            <Sparkles size={18} className={hasLanding ? 'mt-0.5 text-[#25455D]' : 'mt-0.5 text-gray-400'} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">Плюсоновский лендинг</p>
              {hasLanding ? (
                <p className="mt-0.5 truncate text-xs text-gray-400">
                  Опубликован: {landingUrlInternal || '—'}
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-gray-400">
                  Соберите на вкладке «Лендинг» — он заменит простую страницу.
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setMode('external')}
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

      {isExternal ? (
        /* ── СТОРОННИЙ: только URL ── */
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">URL вашего лендинга</label>
          <input
            type="url"
            value={landingUrl}
            onChange={e => onLandingUrl(e.target.value)}
            placeholder="https://yoursite.com/event"
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
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
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Описание для лендинга</label>
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

          <label
            className={`flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
              skipContactForm ? 'border-[#25455D] bg-[#25455D]/5' : 'border-gray-200 hover:border-gray-300'
            }`}>
            <input type="checkbox" checked={skipContactForm}
              onChange={e => onSkipContactForm(e.target.checked)}
              className="mt-0.5 accent-[#25455D]" />
            <div>
              <p className="text-sm font-medium text-gray-900">Регистрировать без ввода контактных данных</p>
              <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
                Клик по кнопке сразу создаёт участника по его Telegram-аккаунту — без формы
                с именем, email и телефоном.
              </p>
            </div>
          </label>
        </div>
      )}
    </div>
  )
}
