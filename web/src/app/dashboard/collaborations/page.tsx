'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { Plus, Search, Users, ChevronRight, Trash2, Upload, X, FileJson, CheckCircle2, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { useLang } from '@/contexts/LangContext'
import { Spinner } from '@/components/Spinner'

const JSON_EXAMPLE = `{
  "collaborations": [
    {
      "name": "Иван Иванов",
      "title": "Эксперт по маркетингу",
      "achievements": ["Регалия 1", "Регалия 2"],
      "tg_channel_url": "https://t.me/username",
      "tg_channel_id": "-100123456789",
      "personal_tg_id": "123456789",
      "personal_tg_username": "username",
      "assistant_tg_username": "assistant",
      "photo_url": "https://...",
      "instagram_url": "https://instagram.com/...",
      "website_url": "https://..."
    }
  ]
}`

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [dragging, setDragging] = useState(false)
  const [fileContent, setFileContent] = useState('')
  const [fileName, setFileName] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  function readFile(file: File) {
    if (!file.name.endsWith('.json') && !file.name.endsWith('.csv')) {
      setError('Поддерживаются только .json файлы'); return
    }
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = e => setFileContent(e.target?.result as string || '')
    reader.readAsText(file, 'utf-8')
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) readFile(file)
  }, [])

  async function handleImport() {
    if (!fileContent.trim()) { setError('Файл не выбран'); return }
    setImporting(true); setError(''); setResult(null)
    try {
      const parsed = JSON.parse(fileContent)
      const res = await api.collaborators.import(parsed)
      setResult(res)
      onImported()
    } catch (e: any) {
      setError(e.message || 'Ошибка импорта')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-gray-900 text-lg">Пакетный импорт коллабораций</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"><X size={18} /></button>
        </div>

        {/* Формат файла */}
        <div className="mb-5 bg-gray-50 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <FileJson size={15} className="text-brand" />
            <span className="text-sm font-medium text-gray-700">Формат JSON-файла</span>
          </div>
          <p className="text-xs text-gray-500 mb-2">Файл должен содержать объект с ключом <code className="bg-white px-1 rounded border border-gray-200">collaborations</code> — массив объектов:</p>
          <pre className="text-xs bg-white border border-gray-200 rounded-lg p-3 overflow-x-auto text-gray-600 leading-relaxed">{JSON_EXAMPLE}</pre>
          <p className="text-xs text-gray-400 mt-2">Обязательное поле: <code className="bg-white px-1 rounded border border-gray-200">name</code>. Дубликаты по имени пропускаются.</p>
        </div>

        {/* Drag & drop зона */}
        {!result && (
          <>
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors mb-4
                ${dragging ? 'border-brand bg-brand/5' : 'border-gray-200 hover:border-brand hover:bg-gray-50'}`}>
              <Upload size={24} className="mx-auto mb-3 text-gray-400" />
              {fileName ? (
                <p className="text-sm font-medium text-gray-700">{fileName}</p>
              ) : (
                <>
                  <p className="text-sm font-medium text-gray-700">Перетащите JSON-файл сюда</p>
                  <p className="text-xs text-gray-400 mt-1">или нажмите для выбора файла</p>
                </>
              )}
              <input ref={fileRef} type="file" accept=".json" className="hidden"
                onChange={e => { if (e.target.files?.[0]) readFile(e.target.files[0]) }} />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-red-600 text-sm mb-4 bg-red-50 px-4 py-3 rounded-xl">
                <AlertCircle size={15} /> {error}
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={handleImport} disabled={!fileContent || importing}
                className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${importing ? 'btn-loading' : ''}`}>
                {importing ? <><Spinner /> Импортирую...</> : 'Импортировать'}
              </button>
              <button onClick={onClose} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
                Отмена
              </button>
            </div>
          </>
        )}

        {/* Результат */}
        {result && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-green-600 font-medium">
              <CheckCircle2 size={18} /> {result.summary}
            </div>
            {result.created.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1">Создано ({result.created.length}):</p>
                <div className="text-xs text-gray-700 space-y-0.5 max-h-32 overflow-y-auto">
                  {result.created.map((c: any) => <div key={c.id}>✓ {c.name}</div>)}
                </div>
              </div>
            )}
            {result.skipped.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-400 mb-1">Пропущено (уже есть):</p>
                <div className="text-xs text-gray-400 space-y-0.5 max-h-20 overflow-y-auto">
                  {result.skipped.map((n: string) => <div key={n}>— {n}</div>)}
                </div>
              </div>
            )}
            {result.errors.length > 0 && (
              <div>
                <p className="text-xs font-medium text-red-500 mb-1">Ошибки:</p>
                <div className="text-xs text-red-500 space-y-0.5">
                  {result.errors.map((e: any) => <div key={e.name}>✗ {e.name}: {e.error}</div>)}
                </div>
              </div>
            )}
            <button onClick={onClose} className="btn-gold w-full py-2.5 rounded-xl font-semibold text-sm mt-2">
              Готово
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function CollaborationsPage() {
  const { t } = useLang()
  const tc = t.collaborations
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [showImport, setShowImport] = useState(false)

  function load(q?: string) {
    setLoading(true)
    api.collaborators.list(q)
      .then(r => setItems(r.collaborators || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    load(query || undefined)
  }

  async function handleDelete(id: number, name: string) {
    if (!confirm(tc.deleteConfirm(name))) return
    try {
      await api.collaborators.delete(id)
      setItems(s => s.filter(x => x.id !== id))
    } catch (err: any) {
      alert(err.message)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{tc.title}</h1>
          <p className="text-gray-500 mt-1">{tc.subtitle}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowImport(true)}
            className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2">
            <Upload size={15} /> Импорт из файла
          </button>
          <Link href="/dashboard/collaborations/new"
            className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2">
            <Plus size={16} /> {tc.addNew}
          </Link>
        </div>
      </div>

      <form onSubmit={handleSearch} className="mb-6 flex gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" placeholder={t.common.searchPlaceholder} value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
        </div>
        <button type="submit" className="px-4 py-2.5 rounded-xl bg-white border border-gray-200 text-sm text-gray-700 hover:border-brand transition-colors">
          {t.common.find}
        </button>
        {query && (
          <button type="button" onClick={() => { setQuery(''); load() }}
            className="px-4 py-2.5 rounded-xl bg-white border border-gray-200 text-sm text-gray-500 hover:text-gray-700 transition-colors">
            {t.common.reset}
          </button>
        )}
      </form>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-8 h-8 border-2 border-brand rounded-full border-t-transparent animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
          <div className="w-20 h-20 rounded-full gradient-bg flex items-center justify-center mx-auto mb-6">
            <Users size={36} className="text-white" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">
            {query ? tc.empty.searchTitle : tc.empty.title}
          </h2>
          <p className="text-gray-500 mb-8 max-w-sm mx-auto">
            {query ? tc.empty.searchHint : tc.empty.subtitle}
          </p>
          {!query && (
            <Link href="/dashboard/collaborations/new"
              className="btn-gold inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold">
              <Plus size={16} /> {tc.empty.btn}
            </Link>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="divide-y divide-gray-50">
            {items.map(item => (
              <div key={item.id} className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 group transition-colors">
                <div className="w-10 h-10 rounded-full overflow-hidden shrink-0 bg-gray-100 flex items-center justify-center">
                  {item.photo_url
                    ? <img src={item.photo_url} alt={item.name} className="w-full h-full object-cover" />
                    : <Users size={18} className="text-gray-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900 truncate">{item.name}</p>
                  {item.title && <p className="text-sm text-gray-500 truncate">{item.title}</p>}
                </div>
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => handleDelete(item.id, item.name)}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title={t.common.delete}>
                    <Trash2 size={15} />
                  </button>
                </div>
                <Link href={`/dashboard/collaborations/${item.id}`} className="flex items-center text-gray-400 hover:text-brand transition-colors">
                  <ChevronRight size={18} />
                </Link>
              </div>
            ))}
          </div>
          <div className="border-t border-gray-100">
            <Link href="/dashboard/collaborations/new"
              className="flex items-center gap-3 px-5 py-4 text-sm text-gray-400 hover:text-brand hover:bg-gray-50 transition-colors">
              <div className="w-10 h-10 rounded-full border-2 border-dashed border-gray-200 flex items-center justify-center">
                <Plus size={16} />
              </div>
              <span>{tc.addRow}</span>
            </Link>
          </div>
        </div>
      )}

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={() => load()}
        />
      )}
    </div>
  )
}
