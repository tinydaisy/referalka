'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, Search, Users, ChevronRight, Trash2, Upload, X, FileJson, CheckCircle2, AlertCircle, Mail, Phone, UserPlus } from 'lucide-react'
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

        <div className="mb-5 bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
          Если коллаба с таким именем нет в Контактах — создастся новый пустой контакт (без email/телефона). Заполнить его можно потом в разделе «Контакты».
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

// Модалка: «Добавить коллаборатора из контактов». Коллаб обязан быть привязан
// к существующему контакту — это «расширение» контакта, а не отдельная сущность.
function AddFromContactModal({
  onClose,
  takenContactIds,
}: {
  onClose: () => void
  takenContactIds: Set<number>
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true)
      api.contacts.list(query, 50, 0, false)
        .then((r: any) => setContacts(r.contacts || r.items || []))
        .catch(() => setContacts([]))
        .finally(() => setLoading(false))
    }, query ? 250 : 0)
    return () => clearTimeout(t)
  }, [query])

  async function pickContact(c: any) {
    if (takenContactIds.has(c.id)) return
    setCreating(c.id); setError('')
    try {
      const res = await api.collaborators.create({ contact_id: c.id, name: c.name || undefined })
      onClose()
      router.push(`/dashboard/collaborations/${res.collaborator.id}`)
    } catch (e: any) {
      setError(e?.message || 'Не удалось создать коллаборатора')
    } finally {
      setCreating(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 shrink-0">
          <div>
            <h3 className="font-bold text-gray-900 text-lg">Добавить коллаборатора</h3>
            <p className="text-xs text-gray-500 mt-0.5">Выберите контакт — коллаб создастся как его «расширение»</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 border-b border-gray-100 shrink-0">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              type="text"
              placeholder="Имя, email или телефон..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="w-6 h-6 border-2 border-brand rounded-full border-t-transparent animate-spin" />
            </div>
          ) : contacts.length === 0 ? (
            <div className="p-8 text-center">
              <Users size={28} className="mx-auto mb-3 text-gray-300" />
              <p className="text-sm text-gray-500 mb-2">
                {query ? 'Ничего не найдено' : 'Нет контактов'}
              </p>
              <p className="text-xs text-gray-400">
                Сначала создайте контакт в разделе{' '}
                <Link href="/dashboard/clients" className="text-brand hover:underline">«Контакты»</Link>
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-50">
              {contacts.map(c => {
                const taken = takenContactIds.has(c.id)
                const isCreating = creating === c.id
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => pickContact(c)}
                      disabled={taken || isCreating}
                      className={`w-full text-left px-3 py-3 rounded-xl flex items-center gap-3 transition-colors
                        ${taken ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`}
                    >
                      <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                        {(c.name || '?').trim().charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-sm text-gray-900 truncate">{c.name || 'Без имени'}</div>
                        <div className="text-xs text-gray-500 truncate flex items-center gap-3">
                          {c.email && <span className="flex items-center gap-1"><Mail size={10} />{c.email}</span>}
                          {c.phone && <span className="flex items-center gap-1"><Phone size={10} />{c.phone}</span>}
                          {!c.email && !c.phone && <span className="text-gray-400">без email/телефона</span>}
                        </div>
                      </div>
                      {taken ? (
                        <span className="text-[11px] text-gray-400 shrink-0">уже коллаб</span>
                      ) : isCreating ? (
                        <Spinner />
                      ) : (
                        <UserPlus size={16} className="text-gray-400 shrink-0" />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {error && (
          <div className="p-3 border-t border-red-200 bg-red-50 text-red-700 text-sm flex items-center gap-2">
            <AlertCircle size={15} /> {error}
          </div>
        )}

        <div className="p-4 border-t border-gray-100 text-xs text-gray-500 shrink-0">
          Не нашли человека?{' '}
          <Link href="/dashboard/clients" className="text-brand hover:underline">
            Добавьте контакт
          </Link>{' '}
          — и вернитесь сюда.
        </div>
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
  const [showAdd, setShowAdd] = useState(false)
  const [showCreateNew, setShowCreateNew] = useState(false)

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

  const takenContactIds = new Set<number>(
    items.map(i => i.contact_id).filter((x: any): x is number => typeof x === 'number')
  )

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
          <button onClick={() => setShowAdd(true)}
            className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2">
            <Plus size={15} /> Из контактов
          </button>
          <button onClick={() => setShowCreateNew(true)}
            className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2">
            <Plus size={16} /> Создать нового
          </button>
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
            <button onClick={() => setShowAdd(true)}
              className="btn-gold inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold">
              <Plus size={16} /> Добавить из контактов
            </button>
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
                  <Link href={`/dashboard/collaborations/${item.id}`} className="font-semibold text-gray-900 truncate hover:text-brand transition-colors block">{item.name}</Link>
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
            <button onClick={() => setShowAdd(true)}
              className="w-full flex items-center gap-3 px-5 py-4 text-sm text-gray-400 hover:text-brand hover:bg-gray-50 transition-colors text-left">
              <div className="w-10 h-10 rounded-full border-2 border-dashed border-gray-200 flex items-center justify-center">
                <Plus size={16} />
              </div>
              <span>Добавить из контактов</span>
            </button>
          </div>
        </div>
      )}

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={() => load()}
        />
      )}

      {showAdd && (
        <AddFromContactModal
          onClose={() => setShowAdd(false)}
          takenContactIds={takenContactIds}
        />
      )}

      {showCreateNew && (
        <QuickCreateCollabModal
          onClose={() => setShowCreateNew(false)}
          onCreated={() => { setShowCreateNew(false); load() }}
        />
      )}
    </div>
  )
}

// Модалка создания коллаборатора «с нуля» — имя + опц. поля.
// При совпадении имени с существующим контактом бэк возвращает needs_choice,
// и мы показываем список совпадений с кнопками «использовать» или «всё равно создать».
function QuickCreateCollabModal({
  onClose, onCreated,
}: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [tgUsername, setTgUsername] = useState('')
  const [instagram, setInstagram] = useState('')
  const [saving, setSaving] = useState(false)
  const [choice, setChoice] = useState<{ matches: any[] } | null>(null)

  async function submit(opts?: { force_create?: boolean; existing_contact_id?: number }) {
    if (!name.trim()) return
    setSaving(true)
    try {
      const payload: any = {
        name: name.trim(),
        title: title.trim() || null,
        assistant_tg_username: tgUsername.trim().replace(/^@/, '') || null,
        instagram_url: instagram.trim() || null,
        ...(opts || {}),
      }
      const res = await api.collaborators.quick(payload)
      if (res?.needs_choice) {
        setChoice({ matches: res.matches || [] })
        return
      }
      onCreated()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-gray-900">{choice ? 'Похожий контакт уже есть' : 'Новый коллаборатор'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
        </div>

        {!choice ? (
          <>
            <div className="space-y-3">
              <div>
                <label className="label">Имя и фамилия *</label>
                <input
                  type="text" value={name} autoFocus
                  onChange={e => setName(e.target.value)}
                  className="input" placeholder="Например, Иван Петров"
                />
              </div>
              <div>
                <label className="label">Должность / роль</label>
                <input
                  type="text" value={title}
                  onChange={e => setTitle(e.target.value)}
                  className="input" placeholder="Бизнес-тренер, продюсер, и т.д."
                />
              </div>
              <div>
                <label className="label">Telegram username</label>
                <input
                  type="text" value={tgUsername}
                  onChange={e => setTgUsername(e.target.value)}
                  className="input" placeholder="ivan_petrov (без @)"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  tg_id подцепится автоматически когда коллаб напишет в бот клиента.
                </p>
              </div>
              <div>
                <label className="label">Instagram URL</label>
                <input
                  type="text" value={instagram}
                  onChange={e => setInstagram(e.target.value)}
                  className="input" placeholder="https://instagram.com/..."
                />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => submit()} disabled={!name.trim() || saving}
                className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${saving ? 'btn-loading' : ''}`}>
                {saving ? 'Создаём...' : 'Создать'}
              </button>
              <button onClick={onClose} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
                Отмена
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-600 mb-3">
              У вас уже есть {choice.matches.length === 1 ? 'контакт' : 'контакты'} с именем
              <b> «{name.trim()}»</b>. Привязать коллаб к существующему или создать нового всё равно?
            </p>
            <div className="space-y-2 mb-4">
              {choice.matches.map(m => (
                <button
                  key={m.id}
                  onClick={() => submit({ existing_contact_id: m.id })}
                  disabled={m.has_collab || saving}
                  className="w-full text-left p-3 rounded-xl border border-gray-200 hover:border-brand hover:bg-brand/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="font-medium text-gray-900">{m.name}</div>
                  {(m.email || m.phone) && (
                    <div className="text-xs text-gray-400 mt-0.5">{[m.email, m.phone].filter(Boolean).join(' · ')}</div>
                  )}
                  {m.has_collab && <div className="text-xs text-amber-600 mt-1">⚠️ У этого контакта уже есть коллаборатор</div>}
                </button>
              ))}
            </div>
            <div className="flex gap-3">
              <button onClick={() => submit({ force_create: true })} disabled={saving}
                className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm ${saving ? 'btn-loading' : ''}`}>
                {saving ? 'Создаём...' : 'Всё равно создать нового'}
              </button>
              <button onClick={() => setChoice(null)} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
                Назад
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
