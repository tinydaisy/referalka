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
      if (!r.ok) {
        let detail = ''
        try { detail = (await r.json()).detail || '' } catch { /* тело не JSON */ }
        if (r.status === 401) throw new Error('Сессия истекла. Обновите страницу и войдите заново.')
        if (r.status === 413) throw new Error('Файл слишком большой. Максимум — 10 МБ.')
        throw new Error(detail || `Сервер ответил ошибкой ${r.status}. Попробуйте ещё раз.`)
      }
      setResult(await r.json())
    } catch (e: any) {
      // «Failed to fetch» — браузер не получил ответ (обрыв связи, закрытая вкладка,
      // блокировка расширением). Показывать это клиенту как есть нельзя: непонятно
      // и, главное, часть контактов могла уже загрузиться.
      const isNetwork = e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(e?.message || '')
      setError(isNetwork
        ? 'Связь с сервером прервалась — ответ не дошёл. Часть контактов могла уже загрузиться: откройте список контактов и проверьте, прежде чем загружать файл снова.'
        : e.message)
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
      <div className="text-sm text-gray-600 mb-8 space-y-4">
        <p>Загрузите файл со списком контактов — система добавит их в вашу базу.</p>

        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <p className="font-semibold text-gray-800 mb-1">Если у вас только почты</p>
          <p className="mb-2">
            Впишите по одной почте в строку и загружайте файл как есть — больше ничего делать не нужно.
          </p>
          <pre className="bg-white border border-gray-200 rounded-lg p-3 text-xs text-gray-700 overflow-x-auto">{`ivan@mail.ru
maria@yandex.ru`}</pre>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <p className="font-semibold text-gray-800 mb-1">Если данных несколько (имя, телефон, ник)</p>
          <p className="mb-2">
            Добавьте в файл самую первую строку и напишите в ней, что лежит в каждом столбце.
            Пишите эти слова: <code>name</code> — имя, <code>email</code> — почта,{' '}
            <code>phone</code> — телефон, <code>telegram_username</code> — ник в Telegram.
            Ставьте столбцы в любом порядке и берите только нужные.
          </p>
          <pre className="bg-white border border-gray-200 rounded-lg p-3 text-xs text-gray-700 overflow-x-auto">{`name,email,phone
Иван Петров,ivan@mail.ru,+79001234567
Мария Сидорова,maria@yandex.ru,`}</pre>
        </div>

        <p className="text-gray-500">
          Если человек уже есть в базе с такой же почтой или телефоном — система дополнит его карточку,
          а не создаст второго. После загрузки вы увидите, что именно прочиталось из файла.
        </p>
      </div>

      <div className="bg-white rounded-2xl border card-border shadow-sm p-6 mb-6">
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
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
          <h2 className="font-semibold text-gray-800 mb-4">Результат импорта</h2>
          <dl className="space-y-2 text-sm">
            {typeof result.rows_total === 'number' && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Строк с данными в файле</dt>
                <dd className="font-semibold text-gray-700">{result.rows_total}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-gray-500">Создано новых контактов</dt>
              <dd className="font-semibold text-green-700">{result.created}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Объединено с существующими</dt>
              <dd className="font-semibold text-blue-700">{result.merged}</dd>
            </div>
            {result.skipped_empty > 0 && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Пропущено пустых строк</dt>
                <dd className="font-semibold text-gray-500">{result.skipped_empty}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-gray-500">Конфликтов</dt>
              <dd className="font-semibold text-amber-600">{result.conflicts?.length || 0}</dd>
            </div>
          </dl>

          {result.created === 0 && result.merged === 0 && (
            <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
              <b>Ни один контакт не загружен.</b>{' '}
              {result.invalid_emails?.length > 0
                ? 'Похоже, почты записаны с ошибкой — список ниже.'
                : 'Проверьте, что в файле есть колонка с почтой или телефоном.'}
            </div>
          )}

          {result.recognized && (
            <div className="mt-4 text-sm">
              <h3 className="font-semibold text-gray-700 mb-2">Что система прочитала в файле</h3>
              <ul className="space-y-1">
                {[
                  ['email', 'Почта'],
                  ['phone', 'Телефон'],
                  ['name', 'Имя'],
                  ['telegram_username', 'Telegram-ник'],
                ].map(([key, label]) => {
                  const col = result.recognized[key]
                  const used = result.has_header ? !!col : key === 'email' || key === 'phone'
                  return (
                    <li key={key} className="flex justify-between gap-3">
                      <span className="text-gray-500">{label}</span>
                      <span className={used ? 'text-green-700' : 'text-gray-400'}>
                        {result.has_header
                          ? (col ? `колонка «${col}»` : 'нет в файле')
                          : (used ? 'определено по содержимому' : 'нет в файле')}
                      </span>
                    </li>
                  )
                })}
              </ul>
              {!result.has_header && (
                <p className="text-xs text-gray-500 mt-2">
                  В файле нет строки с названиями колонок — это нормально, мы определили данные по их виду.
                </p>
              )}
            </div>
          )}

          {result.unknown_columns?.length > 0 && (
            <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm">
              <h3 className="font-semibold text-amber-800 mb-1">Колонки, которые не распознаны</h3>
              <p className="text-xs text-amber-700 mb-2">
                Данные из них не загружены. Переименуйте колонку в <code>name</code>, <code>email</code>,{' '}
                <code>phone</code> или <code>telegram_username</code> и загрузите файл снова.
              </p>
              <ul className="list-disc pl-5 text-amber-900">
                {result.unknown_columns.map((c: any, i: number) => (
                  <li key={i}>«{c.column}» — {c.position}-я колонка</li>
                ))}
              </ul>
            </div>
          )}

          {result.invalid_emails?.length > 0 && (
            <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-4 text-sm">
              <h3 className="font-semibold text-red-800 mb-1">
                Строки с ошибкой в почте — не загружены ({result.invalid_emails.length})
              </h3>
              <ul className="list-disc pl-5 text-red-900">
                {result.invalid_emails.map((c: any, i: number) => (
                  <li key={i}>Строка {c.row}: «{c.value}»</li>
                ))}
              </ul>
            </div>
          )}

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
