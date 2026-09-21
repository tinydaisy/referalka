'use client'

/**
 * «За кем закреплён» — выбор менеджера лидов в карточке контакта (миграция 484).
 *
 * ⚠️ Закрепляется КОНТАКТ, а не участник события: человек один, а событий у
 * него может быть десять. Поэтому закрепление действует сразу везде — в базе
 * контактов, в отслеживании любого события и в переписке.
 *
 * ⚠️ Блок не показывается вовсе, если у клиента нет ни одного менеджера лидов:
 * пустая выпадашка «выберите менеджера», в которой некого выбрать, выглядит
 * поломкой. Роль создаётся в «Настройки → Помощники».
 */

import { useEffect, useState } from 'react'
import { UserCog } from 'lucide-react'
import { api } from '@/lib/api'

interface Manager {
  grant_id: number
  email: string
  name: string | null
  assigned_count: number
}

export default function AssignManagerField({ contactId }: { contactId: number }) {
  const [managers, setManagers] = useState<Manager[] | null>(null)
  const [grantId, setGrantId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    Promise.all([
      api.contactAssignments.managers().catch(() => ({ managers: [] })),
      api.contactAssignments.forContacts([contactId]).catch(() => ({ assignments: {} })),
    ]).then(([m, a]: any[]) => {
      if (!alive) return
      setManagers(m?.managers || [])
      setGrantId(a?.assignments?.[String(contactId)]?.grant_id ?? null)
    })
    return () => { alive = false }
  }, [contactId])

  async function save(next: number | null) {
    const prev = grantId
    setGrantId(next)          // показываем сразу, не дожидаясь сервера
    setSaving(true)
    setError('')
    try {
      await api.contactAssignments.assign([contactId], next)
    } catch (e: any) {
      setGrantId(prev)        // не сохранилось — возвращаем как было
      setError(e?.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  // Ещё грузим, или менеджеров лидов у клиента нет — блок не нужен.
  if (!managers || managers.length === 0) return null

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
        <UserCog size={13} />
        Закреплён за менеджером
      </div>
      <select
        value={grantId ?? ''}
        disabled={saving}
        onChange={e => save(e.target.value ? Number(e.target.value) : null)}
        className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-800 disabled:opacity-60"
      >
        <option value="">Никто не закреплён</option>
        {managers.map(m => (
          <option key={m.grant_id} value={m.grant_id}>
            {m.name || m.email} ({m.assigned_count})
          </option>
        ))}
      </select>
      <p className="mt-1.5 text-[11px] text-gray-400">
        Менеджер видит только закреплённых за ним людей и может им писать.
      </p>
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  )
}
