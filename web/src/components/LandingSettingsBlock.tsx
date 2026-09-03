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
  ctaRepeat, onCtaRepeat,
  regClosed, onRegClosed,
  preRegText, onPreRegText,
  preRegBtnLabel, onPreRegBtnLabel,
  preRegBtnUrl, onPreRegBtnUrl,
  registeredCount = 0,
  skipContactForm, onSkipContactForm,
  allowExternal = true,
  hasLanding = false,
  landingUrlInternal,
  regMode,
  onRegMode,
  onValidity,
  showDescription = true,
}: {
  description: string
  onDescription: (v: string) => void
  // ⚠️ Описание может выводиться выше, в основных настройках события — там его
  // и ищут. Тогда здесь его прятать, иначе одно и то же поле стоит на странице
  // дважды и непонятно, какое из них главное.
  showDescription?: boolean
  landingUrl: string
  onLandingUrl: (v: string) => void
  ctaLabel: string
  onCtaLabel: (v: string) => void
  /** Дублировать кнопку под описанием (миграция 314). */
  ctaRepeat?: boolean
  onCtaRepeat?: (v: boolean) => void
  /** «Регистрация ещё не открыта» (миграция 345): событие видно, записаться
   *  нельзя. Вместо любой страницы регистрации — заглушка с текстом и
   *  необязательной кнопкой. */
  regClosed?: boolean
  onRegClosed?: (v: boolean) => void
  preRegText?: string
  onPreRegText?: (v: string) => void
  preRegBtnLabel?: string
  onPreRegBtnLabel?: (v: string) => void
  preRegBtnUrl?: string
  onPreRegBtnUrl?: (v: string) => void
  /** Сколько уже зарегистрировалось — предупреждаем при закрытии записи. */
  registeredCount?: number
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
  // ⚠️ Синхронизируем ТОЛЬКО когда значение пришло с сервера и отличается от
  // того, что уже выбрал человек. Безусловный setMode(initialMode) откатывал
  // выбор при каждой перерисовке: пользователь ставил «Встроенный лендинг», а
  // список тут же возвращался к «простой форме», и до сохранения не доходило.
  useEffect(() => {
    if (regMode && regMode !== mode) setMode(regMode as RegMode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regMode])

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
  // ⚠️ При закрытой регистрации проверка не действует: страницы регистрации
  // человек всё равно не увидит, а требование заполнить адрес лендинга просто
  // не дало бы сохранить событие — то есть включить саму заглушку.
  const error = regClosed ? '' :
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

      {/* ⚠️ «Регистрация ещё не открыта» — ВЫШЕ выбора страницы, а не пунктом
          внутри него: это не способ регистрации, а её отсутствие. Пунктом
          списка настройка была бы недоступна тем, кто выбрал сторонний
          лендинг, — а им она нужна ровно так же. */}
      {onRegClosed && (
        <div className={`rounded-xl border-2 p-3.5 transition-colors ${
          regClosed ? 'border-[#25455D] bg-[#25455D]/5' : 'border-gray-200'
        }`}>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={!!regClosed}
              onChange={e => {
                const next = e.target.checked
                // ⚠️ Предупреждаем, если записи уже есть: клиент должен знать,
                // что закрывает приём НОВЫХ, а не отменяет чужие регистрации.
                if (next && registeredCount > 0) {
                  const ok = confirm(
                    `На событие уже зарегистрировано ${registeredCount} чел. `
                    + 'Они останутся зарегистрированными и сохранят доступ в свой кабинет — '
                    + 'закроется только приём новых.\n\nЗакрыть регистрацию?'
                  )
                  if (!ok) return
                }
                onRegClosed(next)
              }}
              className="mt-0.5 accent-[#25455D]"
            />
            <div>
              <p className="text-sm font-medium text-gray-800">Регистрация ещё не открыта</p>
              <p className="mt-0.5 text-xs text-gray-400 leading-relaxed">
                Событие видно в календаре, но записаться нельзя. Вместо страницы регистрации
                человек увидит афишу, описание и ваш текст. Нужно, когда дата уже известна,
                а спикеры, программа и лендинг ещё готовятся.
              </p>
            </div>
          </label>

          {regClosed && (
            <div className="mt-4 space-y-4 border-t border-gray-200 pt-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">Текст вместо кнопки</label>
                <textarea
                  value={preRegText || ''}
                  onChange={e => onPreRegText?.(e.target.value)}
                  rows={2}
                  maxLength={300}
                  className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-brand focus:outline-none"
                />
                <p className="mt-1.5 text-xs text-gray-400">
                  Главное на странице — крупным шрифтом. Пусто — будет «Скоро сообщим о старте регистрации».
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Кнопка <span className="font-normal text-gray-400">— необязательно</span>
                </label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    value={preRegBtnLabel || ''}
                    onChange={e => onPreRegBtnLabel?.(e.target.value)}
                    maxLength={40}
                    placeholder="Например: Выступить спикером"
                    className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-brand focus:outline-none"
                    style={{ flex: '0 0 42%', minWidth: 0 }}
                  />
                  <input
                    value={preRegBtnUrl || ''}
                    onChange={e => onPreRegBtnUrl?.(e.target.value)}
                    placeholder="https://…"
                    className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm focus:border-brand focus:outline-none"
                    style={{ flex: '1 1 auto', minWidth: 0 }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-gray-400">
                  Кнопка появится, только если заполнены оба поля. Ведёт куда угодно —
                  на анкету, в чат, на форму заявки.
                </p>
              </div>

              <div className="rounded-xl bg-gray-50 px-3.5 py-2.5 text-xs leading-relaxed text-gray-500">
                Афиша на этой странице — своя: <b>«Афиша до старта регистрации»</b> на вкладке «Афиши».
                Не загрузите — возьмётся обычная афиша события.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Настройки страницы регистрации не удаляем и не прячем при закрытой
          записи — они сохранены и заработают, когда клиент её откроет. */}
      {regClosed && (
        <p className="text-xs text-gray-400">
          Пока регистрация закрыта, настройки ниже не действуют — они сохранятся и
          заработают, когда вы её откроете.
        </p>
      )}

      <div className={regClosed ? 'pointer-events-none space-y-5 opacity-45' : 'space-y-5'}>

      {allowExternal && (
        <div className="grid gap-3 sm:grid-cols-2">
          {/* ⚠️ Две карточки: наша страница или чужой сайт. ЧТО именно
              показывать на нашей — простую форму или собранный лендинг —
              выбирается списком внутри: так видно, что это одна ветка, а не
              три равноправных варианта. */}
          <button
            type="button"
            onClick={() => choose(mode === 'external' ? 'form' : mode)}
            className={`flex items-start gap-3 p-3.5 rounded-xl border-2 text-left transition-all ${
              !isExternal ? 'border-[#25455D] bg-[#25455D]/5' : 'border-gray-200 hover:border-gray-300'
            }`}>
            <Layout size={18} className={!isExternal ? 'text-[#25455D] mt-0.5' : 'text-gray-400 mt-0.5'} />
            <div>
              <p className="text-sm font-medium text-gray-900">Плюсоновская страница</p>
              <p className="text-xs text-gray-400 mt-0.5">
                Регистрация проходит у нас — верстать ничего не нужно.
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

      {!isExternal ? (
        /* ── НАША СТРАНИЦА: чем именно регистрируем ── */
        <div className="space-y-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              Что показываем человеку
            </label>
            <select
              value={mode}
              onChange={e => choose(e.target.value as RegMode)}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm focus:border-brand focus:outline-none"
            >
              <option value="form">Простая форма регистрации</option>
              <option value="landing">Встроенный лендинг</option>
            </select>
            <p className="mt-1.5 text-xs text-gray-400">
              {mode === 'landing'
                ? (hasLanding
                    ? `Человек с кнопки события попадёт на ${landingUrlInternal || 'ваш лендинг'}.`
                    : 'Лендинг ещё не опубликован — соберите его на вкладке «Лендинг», иначе останется простая форма.')
                : 'Афиша, описание и кнопка записаться.'}
            </p>
          </div>

          {showDescription && (
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
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Текст кнопки</label>
            <input
              value={ctaLabel}
              onChange={e => onCtaLabel(e.target.value)}
              maxLength={40}
              placeholder="Хочу участвовать"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
            />
            <p className="text-xs text-gray-400 mt-1.5">
              Главная кнопка события. Пусто — будет «Хочу участвовать».
            </p>

            {/* ⚠️ Кнопка дублируется ПОД описанием, а не заменяет верхнюю:
                у длинного описания верхняя кнопка уезжает за экран, и человек,
                дочитавший до конца, остаётся без действия. */}
            {onCtaRepeat && (
              <label className="mt-3 flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={!!ctaRepeat}
                  onChange={e => onCtaRepeat(e.target.checked)}
                  className="mt-0.5 accent-[#25455D]" />
                <div>
                  <p className="text-sm font-medium text-gray-800">Повторить кнопку под описанием</p>
                  <p className="mt-0.5 text-xs text-gray-400 leading-relaxed">
                    При длинном описании кнопка вверху уезжает — дочитавший не увидит,
                    что делать дальше.
                  </p>
                </div>
              </label>
            )}
          </div>

          {/* ⚠️ Галочка ОДНА на оба варианта — то же поле skip_contact_form.
              Второго поля с тем же смыслом в базе не заводим. */}
          <SkipContactCheckbox
            checked={skipContactForm}
            onChange={onSkipContactForm}
          />
        </div>
      ) : (
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
      )}
      </div>
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
