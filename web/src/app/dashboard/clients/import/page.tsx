'use client'

/**
 * Импорт CSV контактов (Этап 4).
 *
 * Что делает:
 * - Принимает CSV с колонками name/email/phone/telegram_username
 * - Создаёт контакты с автомерджем по email/phone
 * - При конфликте (например, email совпал с одним, phone — с другим) — создаёт
 *   новый контакт + показывает в списке «Возможные дубликаты», которые клиент
 *   разрулит вручную через карточку контакта
 *
 * Не делает (отдельная задача):
 * - Импорт в TG-канал — для этого есть /dashboard/channels (туда грузим
 *   с привязкой к каналу, есть Long Poll и т.д.)
 */
import { useState } from 'react'
import Link from 'next/link'
import { Upload, ArrowLeft } from 'lucide-react'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function ContactsImportPage() {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  async function upload() {
    if (!file) return
    setUploading(true); setError(null); setResult(null)
    try {
      const token = localStorage.getItem('plusson_token') || ''
      const form = new FormData()
      form.append('file', file)
      const r = await fetch(`${API_BASE}/api/v1/contacts/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      if (!r.ok) throw new Error((await r.json()).detail || 'Ошибка')
      setResult(await r.json())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="max-w-3xl">
      <Link href="/dashboard/clients" className="flex items-center gap-2 text-sm text-gray-500 mb-4 hover:text-gray-700">
        <ArrowLeft size={14} /> К списку контактов
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">Импорт контактов из CSV</h1>
      <p className="text-sm text-gray-500 mb-8">
        Колонки: <code>name</code>, <code>email</code>, <code>phone</code>, <code>telegram_username</code>.
        Любой порядок, регистр заголовков. Дубликаты по email или телефону объединяются автоматически.
      </p>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-6">
        <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center">
          <Upload size={32} className="mx-auto mb-3 text-gray-400" />
          <input type="file" accept=".csv,text/csv,text/plain"
            onChange={e => setFile(e.target.files?.[0] || null)}
            className="block mx-auto text-sm" />
          {file && (
            <p className="text-sm text-gray-600 mt-3">
              Выбран: <b>{file.name}</b> ({Math.round(file.size / 1024)} КБ)
            </p>
          )}
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={upload} disabled={!file || uploading}
            className="px-6 py-3 bg-brand text-white rounded-xl text-sm font-medium disabled:opacity-50">
            {uploading ? 'Загружаем...' : 'Импортировать'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm mb-4">
          {error}
        </div>
      )}

      {result && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="font-semibold text-gray-800 mb-4">Результат импорта</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Создано новых контактов</dt>
              <dd className="font-semibold text-green-700">{result.created}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Объединено с существующими</dt>
              <dd className="font-semibold text-blue-700">{result.merged}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Конфликтов</dt>
              <dd className="font-semibold text-amber-600">{result.conflicts?.length || 0}</dd>
            </div>
          </dl>

          {result.conflicts && result.conflicts.length > 0 && (
            <div className="mt-6">
              <h3 className="font-semibold text-amber-700 mb-3">⚠️ Конфликты — разрули вручную</h3>
              <p className="text-xs text-gray-500 mb-3">
                Email из CSV совпал с одним контактом, а телефон — с другим. Мы создали новый
                контакт. Открой каждый и решите: объединить с одним из совпадений или оставить как есть.
              </p>
              <div className="space-y-2">
                {result.conflicts.map((c: any, i: number) => (
                  <div key={i} className="border border-amber-200 bg-amber-50 rounded-xl p-3 text-sm">
                    <div className="text-gray-800">
                      <b>Строка {c.row}:</b> {c.csv_name || '?'} — {c.csv_email} / {c.csv_phone}
                    </div>
                    <div className="text-xs text-amber-700 mt-1">{c.reason}</div>
                    <div className="text-xs mt-2 flex gap-2 flex-wrap">
                      <Link href={`/dashboard/clients?contact=${c.created_contact_id}`}
                        className="px-2 py-1 bg-white border border-amber-300 rounded">
                        Новый #{c.created_contact_id}
                      </Link>
                      <Link href={`/dashboard/clients?contact=${c.match_by_email_id}`}
                        className="px-2 py-1 bg-white border border-amber-300 rounded">
                        По email #{c.match_by_email_id}
                      </Link>
                      <Link href={`/dashboard/clients?contact=${c.match_by_phone_id}`}
                        className="px-2 py-1 bg-white border border-amber-300 rounded">
                        По телефону #{c.match_by_phone_id}
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
