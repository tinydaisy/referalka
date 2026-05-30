'use client'
import { useState } from 'react'
import { api } from '@/lib/api'

/**
 * Кнопка экспорта ZIP-архива материалов для спикеров/жюри.
 *
 * Лейбл зависит от типа события:
 *   • премия (awards) → «МАТЕРИАЛЫ ДЛЯ ЖЮРИ»
 *   • остальное (конференция/турнир) → «МАТЕРИАЛЫ ДЛЯ СПИКЕРОВ»
 *
 * Внутри архива (см. бэкенд GET /events/{id}/materials-export):
 *   • Реферальные ссылки.txt
 *   • Тексты для анонсов/Анонс N.txt
 *   • Афиши/<Ориентация>.<ext> + Афиши/Индивидуальные афиши/Имя_Фамилия.<ext>
 *   • Кодовые слова для розыгрыша.txt (если розыгрыш включён)
 */
export default function MaterialsExportButton({
  eventId,
  moduleSlug,
}: {
  eventId: number
  moduleSlug?: string | null
}) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // «Премии/Турниры» (module_slug='turnir', историч. 'awards') → жюри;
  // конференция → спикеры.
  const isJury = moduleSlug === 'awards' || moduleSlug === 'turnir'
  const label = isJury ? 'МАТЕРИАЛЫ ДЛЯ ЖЮРИ' : 'МАТЕРИАЛЫ ДЛЯ СПИКЕРОВ'

  async function handleExport() {
    setLoading(true)
    setErr(null)
    try {
      const blob = await api.referralProgram.exportMaterials(eventId)
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${isJury ? 'Материалы для жюри' : 'Материалы для спикеров'}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch (e: any) {
      setErr(e.message || 'Ошибка экспорта')
      // eslint-disable-next-line no-alert
      alert(e.message || 'Ошибка экспорта')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleExport}
      disabled={loading}
      title="Скачать ZIP-архив: реф-ссылки, тексты-анонсы, афиши, индивидуальные афиши"
      className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-[#25455D] to-[#0a1520] px-4 py-2 text-xs font-semibold tracking-wide text-[#FFCFA4] shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
    >
      {loading ? (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
        </svg>
      ) : (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      )}
      {loading ? 'Готовим архив…' : label}
    </button>
  )
}
