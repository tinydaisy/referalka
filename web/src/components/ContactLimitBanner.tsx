'use client'

/**
 * Плашка о лимите контактов тарифа.
 *
 * Три состояния (приходят из /auth/me полем contact_limit.kind):
 *   warn     — база подходит к лимиту, тариф пока прежний;
 *   upgrade  — контактов стало больше лимита, тариф изменён автоматически;
 *   exceeded — лимит превышен, но перейти некуда (клиент на самом ёмком тарифе).
 *
 * ⚠️ Плашка ЗАКРЫВАЕМАЯ, в отличие от «email не подтверждён» и «бот уведён».
 * Там висит проблема, которую обязан устранить клиент, а здесь система уже
 * всё сделала сама — это информирование, а не требование действия. Закрытие
 * помнится в localStorage по виду события: сменилось состояние (предупредили
 * → перевели тариф) — плашка появится снова, это уже другая новость.
 *
 * ⚠️ Только владельцу: помощник тарифом не управляет и сделать по ней ничего
 * не может.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { useMe } from '@/hooks/useMe'

const STORAGE_KEY = 'plusson_contact_limit_dismissed'

export default function ContactLimitBanner() {
  const { me, isAnyAssistant } = useMe()
  const [dismissed, setDismissed] = useState<string | null>(null)

  const info: any = me?.contact_limit || null
  const kind: string | null = info?.kind || null

  useEffect(() => {
    try { setDismissed(localStorage.getItem(STORAGE_KEY)) } catch { /* приватный режим */ }
  }, [])

  if (isAnyAssistant || !kind || dismissed === kind) return null

  function close() {
    try { localStorage.setItem(STORAGE_KEY, kind as string) } catch { /* приватный режим */ }
    setDismissed(kind)
  }

  const used = info.used as number
  const limit = info.limit as number | null
  const left = limit ? Math.max(0, limit - used) : 0

  // Зелёная — «всё под контролем, система справилась сама». Янтарная — только
  // когда от клиента реально что-то требуется (exceeded: перейти некуда).
  const isAction = kind === 'exceeded'
  const cls = isAction
    ? 'border-amber-200 bg-amber-50 text-amber-900'
    : 'border-emerald-200 bg-emerald-50 text-emerald-900'

  return (
    <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${cls}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 leading-snug">
          {kind === 'warn' && (
            <>
              <div className="font-semibold">Контакты подходят к лимиту тарифа</div>
              <div className="mt-1">
                В базе {used.toLocaleString('ru-RU')} из {limit?.toLocaleString('ru-RU')} контактов —
                осталось {left.toLocaleString('ru-RU')}. Когда лимит будет превышен, тариф
                сменится на подходящий автоматически: доплачивать не нужно, оплаченные дни
                пересчитаются по цене нового тарифа.
              </div>
            </>
          )}
          {kind === 'upgrade' && (
            <>
              <div className="font-semibold">Тариф изменён — контактов стало больше лимита</div>
              <div className="mt-1">
                В базе {used.toLocaleString('ru-RU')} контактов, поэтому тариф автоматически
                сменился на подходящий. Доплачивать не нужно — оплаченные дни пересчитаны по
                цене нового тарифа, поэтому оплаченный срок закончится раньше.{' '}
                <Link href="/dashboard/subscription" className="underline font-medium">
                  Посмотреть подписку
                </Link>
              </div>
            </>
          )}
          {kind === 'exceeded' && (
            <>
              <div className="font-semibold">Превышен лимит контактов</div>
              <div className="mt-1">
                В базе {used.toLocaleString('ru-RU')} контактов при лимите{' '}
                {limit?.toLocaleString('ru-RU')}. Подходящего тарифа для такого объёма нет —
                напишите нам, подберём решение.
              </div>
            </>
          )}
        </div>
        <button
          onClick={close}
          className="shrink-0 opacity-60 hover:opacity-100 transition"
          title="Закрыть уведомление"
          aria-label="Закрыть уведомление"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
