'use client'

/**
 * «Как выглядит ссылка в мессенджере» — подпись карточки события (мигр. 503).
 *
 * Когда человек кидает в чат прямую ссылку `pluson.ru/e/{slug}`, мессенджер сам
 * идёт на наш домен и собирает карточку: афиша + название + эта подпись. Здесь
 * клиент правит подпись и сразу видит, что получится.
 *
 * ⚠️ Блок ОБЩИЙ для всех трёх экранов настроек события (мероприятия,
 * конференции/премии, конкурсы). Отдельные «примерно такие же» поля в каждом
 * файле означали бы три расходящиеся формулировки умолчания и три памятки про
 * сброс кеша, которые чинят по одной.
 *
 * ⚠️ Работает только на ПРЯМОЙ ссылке через наш домен. На ссылках вида
 * `t.me/{бот}?start=…` карточку рисует сам Telegram из профиля бота — туда
 * подставить свою картинку и текст нельзя, домен чужой.
 */

import { useState } from 'react'

/** Умолчания продублированы со страницы /e/[slug] — здесь они только
 *  показываются в предпросмотре, а в карточку их подставляет сервер.
 *  ⚠️ Меняешь формулировку — меняй в ОБОИХ местах (web/src/app/e/[slug]/page.tsx). */
const DEFAULT_WITH_DATE = 'Приходи {дата} на «{название}»'
const DEFAULT_NO_DATE = 'Приходи на «{название}»'

export function buildPreview(
  template: string | null | undefined,
  { title, date }: { title: string; date: string },
): string {
  const tpl = (template || '').trim() || (date ? DEFAULT_WITH_DATE : DEFAULT_NO_DATE)
  return tpl
    .replace(/\{дата\}/g, date)
    .replace(/\{название\}/g, title)
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[—–-]\s*(?=[«"])/g, ' ')
    .replace(/^\s*[—–-]\s*/, '')
    .replace(/\s*[—–-]\s*$/, '')
    .trim()
}

/** Дата события для предпросмотра — тем же видом, что уйдёт в карточку.
 *  Время всегда московское: карточку мессенджер забирает один раз и
 *  показывает всем одинаково, подставить каждому его пояс некуда. */
export function formatPreviewDate(startAt?: string | null, datesFromProgram?: boolean): string {
  if (!startAt) return ''
  const d = new Date(startAt)
  if (isNaN(d.getTime())) return ''
  const TZ = 'Europe/Moscow'
  const day = d.toLocaleDateString('ru', { day: 'numeric', month: 'long', timeZone: TZ })
  if (datesFromProgram) return day
  const hm = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: TZ })
  return hm === '00:00' ? day : `${day} в ${hm} МСК`
}

export default function SharePreviewField({
  value,
  onChange,
  title,
  startAt,
  datesFromProgram,
  posterUrl,
  brandLogoUrl,
}: {
  value: string
  onChange: (v: string) => void
  title?: string | null
  startAt?: string | null
  datesFromProgram?: boolean
  /** Афиша события — она и идёт в карточку. */
  posterUrl?: string | null
  /** Логотип основателя — запасной вариант, когда афиши нет. */
  brandLogoUrl?: string | null
}) {
  const [hintOpen, setHintOpen] = useState(false)
  const date = formatPreviewDate(startAt, datesFromProgram)
  const shownTitle = title || 'Название события'
  const text = buildPreview(value, { title: shownTitle, date })
  const image = posterUrl || brandLogoUrl || null

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        Как выглядит ссылка в мессенджере
      </label>

      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={2}
        placeholder={date ? DEFAULT_WITH_DATE : DEFAULT_NO_DATE}
        className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand resize-none"
      />
      <p className="text-xs text-gray-400 mt-1">
        Когда вы отправляете ссылку на событие в Telegram, ВКонтакте или WhatsApp, под ней
        появляется карточка — афиша, название и эта подпись. Оставьте поле пустым, чтобы
        использовать текст по умолчанию. Можно подставить{' '}
        <code className="px-1 py-0.5 rounded bg-gray-100 text-[11px]">{'{дата}'}</code> и{' '}
        <code className="px-1 py-0.5 rounded bg-gray-100 text-[11px]">{'{название}'}</code>.
      </p>

      {/* Предпросмотр карточки. Показываем ровно то, что соберёт сервер:
          иначе клиент правит текст вслепую и проверяет его, отправляя ссылки
          себе в чат — а там она ещё и закеширована (см. памятку ниже). */}
      <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-3">
        <p className="text-[11px] uppercase tracking-wider text-gray-400 mb-2">
          Так увидят в чате
        </p>
        <div className="flex gap-3 rounded-lg bg-white border-l-[3px] border-[#25455D] p-3">
          {image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt=""
              className="w-16 h-16 rounded object-cover flex-shrink-0 bg-gray-100"
            />
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#25455D] truncate">{shownTitle}</p>
            <p className="text-xs text-gray-600 mt-0.5 line-clamp-3">{text}</p>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          {posterUrl
            ? 'В карточке — афиша события.'
            : brandLogoUrl
              ? 'Афиши у события нет, поэтому в карточке — ваш логотип. Загрузите афишу, и она встанет сюда.'
              : 'Ни афиши, ни логотипа — карточка будет без картинки. Загрузите афишу события.'}
        </p>
      </div>

      {/* ⚠️ ПАМЯТКА ПРО КЕШ. Мессенджер запоминает карточку надолго и при
          повторной отправке той же ссылки показывает старую — клиент решает,
          что правки не сохранились, и правит их по второму разу. */}
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setHintOpen(o => !o)}
          className="text-xs text-[#25455D] underline underline-offset-2 hover:opacity-70"
        >
          Поменяли афишу или текст, а в чате показывается старое?
        </button>
        {hintOpen && (
          <div className="mt-2 rounded-xl bg-[#FFCFA4]/20 border border-[#FFCFA4] p-3 text-xs text-[#25455D] leading-relaxed">
            <p>
              Мессенджеры запоминают карточку и какое-то время показывают сохранённую —
              даже если на странице уже всё новое. Это их кеш, на нашей стороне уже
              обновлено.
            </p>
            <p className="mt-2 font-semibold">Как сбросить в Telegram:</p>
            <ol className="mt-1 ml-4 list-decimal space-y-0.5">
              <li>
                Откройте бота{' '}
                <a
                  href="https://t.me/WebpageBot"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold underline"
                >
                  @WebpageBot
                </a>{' '}
                и нажмите «Начать».
              </li>
              <li>Отправьте ему ссылку на событие — ту самую, которую рассылаете.</li>
              <li>
                В ответ придёт «Success! Link preview was updated» — теперь новая карточка
                покажется и в чатах.
              </li>
            </ol>
            <p className="mt-2">
              ВКонтакте и WhatsApp сбросить вручную нельзя — они обновят карточку сами
              через несколько часов. Если нужно срочно, добавьте к ссылке в конце{' '}
              <code className="px-1 py-0.5 rounded bg-white/70">?v=2</code> — для них это
              новый адрес, и карточку они соберут заново.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
