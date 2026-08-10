'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Repeat, Loader2, Lock } from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'

/**
 * Смена типа события: Мероприятие ↔ Конференция ↔ Турнир.
 *
 * Зачем. Клиент завёл обычное мероприятие, а оно разрослось до конференции с
 * программой и спикерами — раньше пришлось бы заводить событие заново и терять
 * всё накопленное. Технически все типы это одна таблица `events` с разным
 * `module_slug`: участники, подарки, реф-программа, рассылки, лендинг, тарифы
 * и афиши висят на событии и от типа не зависят.
 *
 * ⚠️ При ПОНИЖЕНИИ данные не удаляются — программа и спикеры остаются в базе,
 * просто перестают показываться. Вернули тип обратно — всё на месте. Поэтому в
 * подтверждении так и написано: пугать «всё удалится» неправильно, это неправда.
 *
 * ⚠️ Повышение — только на ОПЛАЧЕННЫЙ модуль. Иначе любой клиент переводил бы
 * обычное событие в конференцию и получал платный модуль даром. Кнопку типа без
 * модуля показываем с замком (видно, что возможность есть), но не даём нажать.
 */

const TYPES: { slug: 'base' | 'conference' | 'turnir'; label: string; feature?: string }[] = [
  { slug: 'base',       label: 'Мероприятие' },
  { slug: 'conference', label: 'Конференция', feature: 'conference' },
  { slug: 'turnir',     label: 'Турнир',      feature: 'tournaments' },
]

export default function ChangeEventTypeButton({
  eventId, currentType, onChanged,
}: {
  eventId: number
  currentType: string
  onChanged?: (newType: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const { me, isAssistant } = useMe()
  const router = useRouter()

  const features: string[] = (me as any)?.features || []

  // Из конкурса, МедиаЛифта и коллабы не переводим: у них своя структура,
  // и молчаливый перевод её сломает.
  if (!TYPES.some(t => t.slug === currentType)) return null
  // Смена типа меняет доступные разделы — это решение владельца, не помощника.
  if (isAssistant) return null

  async function change(target: 'base' | 'conference' | 'turnir') {
    const from = TYPES.find(t => t.slug === currentType)?.label || currentType
    const to = TYPES.find(t => t.slug === target)?.label || target
    const downgrade = target === 'base'

    const warn = downgrade
      ? `Событие станет «${to}».\n\n` +
        'Программа и спикеры останутся в базе — они не удаляются, просто перестанут ' +
        'показываться участникам. Вернёте тип обратно — всё будет на месте.\n\n' +
        'Рассылки по спикерам и программе отправляться не будут.'
      : `Событие станет «${to}».\n\n` +
        'Всё уже заполненное сохранится — участники, подарки, рассылки, лендинг. ' +
        'Добавятся разделы этого типа.'

    if (!confirm(`Сменить тип: «${from}» → «${to}»?\n\n${warn}`)) return

    setBusy(true)
    try {
      await api.events.changeType(eventId, target)
      setOpen(false)
      onChanged?.(target)
      // ⚠️ У типов РАЗНЫЕ адреса раздела в кабинете. Оставить человека на
      // прежнем URL нельзя — страница мероприятия не умеет рисовать
      // конференцию, и наоборот.
      const path = target === 'base' ? '/dashboard/events'
                 : target === 'turnir' ? '/dashboard/tournaments'
                 : '/dashboard/conferences'
      router.push(`${path}/${eventId}`)
      router.refresh()
    } catch (e: any) {
      alert(e?.message || 'Не удалось сменить тип события')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen(v => !v)} disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300
                   text-sm text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50">
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Repeat size={14} />}
        Сменить тип
      </button>

      {open && (
        <>
          {/* Клик мимо закрывает — это не форма с данными, терять нечего */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-64 rounded-xl border border-gray-200 bg-white shadow-lg p-1">
            {TYPES.map(t => {
              const isCurrent = t.slug === currentType
              const locked = !!t.feature && !features.includes(t.feature)
              return (
                <button key={t.slug}
                  disabled={isCurrent || locked || busy}
                  onClick={() => change(t.slug)}
                  title={locked ? 'Модуль не подключён' : undefined}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center justify-between gap-2
                    ${isCurrent ? 'bg-gray-50 text-gray-400 cursor-default'
                      : locked ? 'text-gray-400 cursor-not-allowed'
                      : 'text-gray-800 hover:bg-gray-50'}`}>
                  <span>{t.label}</span>
                  {isCurrent && <span className="text-xs">сейчас</span>}
                  {locked && !isCurrent && <Lock size={13} />}
                </button>
              )
            })}
            <p className="px-3 py-2 text-[11px] leading-snug text-gray-500 border-t border-gray-100 mt-1">
              Заполненные данные сохраняются при любой смене типа.
            </p>
          </div>
        </>
      )}
    </div>
  )
}
