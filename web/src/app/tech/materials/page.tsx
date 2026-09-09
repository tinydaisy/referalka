'use client'

/**
 * Материалы Коллабораторной — правка внедренцем.
 *
 * ⚠️⚠️ СВОЕГО РЕДАКТОРА ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО. Материалы правятся тремя
 * десятками готовых ручек, а вёрстка блоков — общими компонентами. Вторая копия
 * редактора неминуемо разъедется с первой: у одних правка выглядела бы так, у
 * других иначе.
 *
 * Вместо этого по кнопке выдаётся короткий токен системного кабинета, где
 * материалы лежат, и человек попадает в ТОТ ЖЕ редактор, что у владельца.
 *
 * ⚠️ Токен живёт 2 часа: это полноценный доступ в системный кабинет, и висеть в
 * браузере неделями он не должен.
 */
import { useState } from 'react'
import { BookOpen, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

export default function TechMaterialsPage() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function open() {
    setBusy(true); setError('')
    try {
      const r: any = await api.tech.materialsSession()
      // ⚠️ Кладём токен и уходим на основной домен: редактор живёт там, а на
      // поддомене его нет — приложение одно, но адрес кабинета другой.
      localStorage.setItem('plusson_token', r.token)
      document.cookie = `plusson_token=${r.token}; path=/; domain=.pluson.ru; max-age=7200; SameSite=Lax`
      window.location.href = `https://pluson.ru${r.url}`
    } catch (e: any) {
      setError(e?.message || 'Не удалось открыть')
      setBusy(false)
    }
  }

  return (
    <div className="max-w-2xl p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">Материалы Коллабораторной</h1>
      <p className="mb-6 text-sm text-gray-500">
        Записи вебинаров, разделы и обложки — то, что видят купившие модуль.
      </p>

      <div className="rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <BookOpen size={18} className="text-gray-400" />
          <div className="font-semibold text-gray-800">Открыть редактор</div>
        </div>
        <p className="mb-5 text-sm text-gray-500">
          Откроется тот же редактор, в котором материалы ведёт владелец
          платформы. Доступ действует 2 часа, потом нужно открыть заново.
        </p>

        {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

        <button onClick={open} disabled={busy} className="btn-gold px-5 py-2.5 text-sm">
          {busy ? 'Открываем…' : 'Открыть редактор'}
          <ExternalLink size={15} />
        </button>

        <p className="mt-4 text-xs text-gray-400">
          Правки видны всем, у кого куплен модуль «Коллабораторная», — сразу
          после сохранения.
        </p>
      </div>
    </div>
  )
}
