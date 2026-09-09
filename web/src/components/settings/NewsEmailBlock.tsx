'use client'

/**
 * Настройка «получать письма с новостями ПЛЮСОНа».
 *
 * ⚠️ Влияет ТОЛЬКО на почту — в кабинете новости остаются (плашка,
 * колокольчик, страница). Иначе человек, отписавшись от писем, перестал бы
 * узнавать о новом вообще.
 *
 * ⚠️ Нужна ровно потому, что отписка есть в письме: отписался случайно —
 * вернуть должно быть чем.
 */
import { useEffect, useState } from 'react'
import { Megaphone } from 'lucide-react'
import { api } from '@/lib/api'

export default function NewsEmailBlock() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.news.emailPreference()
      .then((r: any) => setEnabled(r?.enabled !== false))
      .catch(() => setEnabled(true))
  }, [])

  async function toggle() {
    if (enabled === null || saving) return
    const next = !enabled
    setEnabled(next)          // сразу, не дожидаясь сети — тумблер не должен «залипать»
    setSaving(true)
    try {
      await api.news.setEmailPreference(next)
    } catch (e: any) {
      setEnabled(!next)       // не сохранилось — возвращаем как было
      alert(e?.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
          <Megaphone size={18} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-800">Новости ПЛЮСОНа</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Письма о новых возможностях и изменениях платформы. Выключите, если не хотите
            их получать — <strong>в кабинете новости всё равно останутся</strong>: плашкой
            вверху и в колокольчике.
          </p>

          <label className="mt-3 inline-flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={enabled === true}
              onChange={toggle}
              disabled={enabled === null || saving}
              className="w-4 h-4 rounded"
            />
            <span className="text-sm text-gray-700">Получать письма с новостями</span>
          </label>
        </div>
      </div>
    </div>
  )
}
