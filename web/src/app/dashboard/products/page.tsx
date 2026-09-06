'use client'

/**
 * Продукты/услуги вне событий (миграция 290).
 *
 * Две вкладки:
 *  - «Продукты» — то, что продаётся: наставничество, мастер-класс, консультация.
 *    У каждого свой лендинг, тарифы с оплатой и состав из материалов.
 *  - «Материалы» — ОБЩАЯ библиотека кабинета. ⚠️ Отдельного пункта меню у неё
 *    нет намеренно: материал добавляется прямо из продукта, а сюда заходят,
 *    когда нужно переименовать, заменить файл или посмотреть, где он стоит.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import { LockedOverlayIf } from '@/components/LockedOverlay'
import { Plus, Trash2, Package, Library, X, FileText, FolderTree } from 'lucide-react'
import MaterialEditor from '@/components/products/MaterialEditor'

const STATUS_LABEL: Record<string, string> = {
  draft: 'Черновик',
  published: 'Опубликован',
  archived: 'В архиве',
}

export default function ProductsPage() {
  const { me, isAssistant } = useMe()
  const [tab, setTab] = useState<'products' | 'materials'>('products')

  // ⚠️ Гейт по фиче, не по тарифу. Замок нужен на САМОЙ странице: пункт меню
  // не мешает открыть раздел по прямой ссылке (правило проекта).
  const hasFeature = (me?.features || []).includes('products')
  // ⚠️ Раздел не подменяем замком: содержимое видно замыленным,
  // чтобы человек видел, что данные на месте. Запрет — на сервере.
  const locked = Boolean(me) && !hasFeature

  return (
    <LockedOverlayIf locked={locked} feature="products">    <div className="max-w-5xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">Продукты и услуги</h1>
      <p className="mb-6 text-sm text-gray-500">
        То, что продаётся вне событий. У каждого продукта своя страница, тарифы
        и материалы, которые человек получает после оплаты.
      </p>

      <div className="mb-6 flex gap-2 border-b border-gray-200">
        {([
          ['products', 'Продукты', Package],
          ['materials', 'Материалы', Library],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm ${
              tab === key
                ? 'border-[#25455D] font-semibold text-[#25455D]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === 'products'
        ? <ProductsTab readOnly={isAssistant} />
        : <MaterialsTab readOnly={isAssistant} />}
    </div>
  )
}

/* ────────────────────────────── Продукты ────────────────────────────────── */

function ProductsTab({ readOnly }: { readOnly: boolean }) {
  const [list, setList] = useState<any[]>([])
  const [cats, setCats] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [managing, setManaging] = useState(false)

  const load = async () => {
    try {
      const r = await api.products.list()
      setList(r.products || [])
      setCats(r.categories || [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  /* ⚠️ Раскладка по категориям: продуктов у клиента больше десятка, и одним
     списком они читаются как свалка — «Фокусировка» рядом с «Крео СПРИНТ»,
     хотя это разные направления бизнеса. Продукты без категории идут ПОСЛЕДНЕЙ
     группой: это не «прочее», а «ещё не разложено». */
  const groups: Array<{ id: number | null; title: string; items: any[] }> = [
    ...cats.map(c => ({
      id: c.id as number,
      title: c.title as string,
      items: list.filter(p => p.category_id === c.id),
    })),
    { id: null, title: 'Без категории', items: list.filter(p => !p.category_id) },
  ].filter(g => g.items.length > 0 || g.id !== null)

  return (
    <div>
      {!readOnly && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button onClick={() => setAdding(true)} className="btn-gold inline-flex items-center gap-2">
            <Plus size={16} /> Создать продукт
          </button>
          <button
            onClick={() => setManaging(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            <FolderTree size={15} /> Категории
          </button>
        </div>
      )}

      {adding && (
        <ProductForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load() }} />
      )}

      {managing && (
        <CategoriesModal
          cats={cats}
          onClose={() => setManaging(false)}
          onChanged={load}
        />
      )}

      {!list.length && !adding && (
        <p className="text-sm text-gray-400">
          Пока ничего нет. Например: «Наставничество», «Мастер-класс по выступлениям»,
          «Разовая консультация».
        </p>
      )}

      <div className="space-y-6">
        {groups.map(g => (
          <div key={String(g.id)}>
            {(cats.length > 0) && (
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {g.title} <span className="text-gray-300">· {g.items.length}</span>
              </h3>
            )}
            {!g.items.length ? (
              <p className="rounded-xl border border-dashed border-gray-200 p-3 text-xs text-gray-400">
                Пусто — перенесите сюда продукты полем «Категория» в карточке.
              </p>
            ) : (
              <div className="space-y-2">
                {g.items.map(p => (
                  <Link
                    key={p.id}
                    href={`/dashboard/products/${p.id}`}
                    className="block rounded-xl border border-gray-200 bg-white p-4 transition hover:border-gray-300"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-900">{p.title}</span>
                          <StatusChip status={p.status} />
                        </div>
                        {p.description && (
                          <p className="mt-0.5 truncate text-sm text-gray-500">{p.description}</p>
                        )}
                        <p className="mt-1 text-xs text-gray-400">
                          Тарифов: {p.tariffs_count} · Материалов: {p.materials_count} ·
                          {' '}Клиентов: {p.buyers_count}
                        </p>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ────────────────────────── Категории продуктов ──────────────────────────── */

function CategoriesModal({ cats, onClose, onChanged }: {
  cats: any[]; onClose: () => void; onChanged: () => void
}) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async () => {
    const t = title.trim()
    if (!t) return
    setBusy(true)
    try {
      await api.products.createCategory({ title: t })
      setTitle('')
      onChanged()
    } catch (e: any) {
      alert(e?.message || 'Не удалось создать категорию')
    } finally { setBusy(false) }
  }

  const rename = async (c: any) => {
    const t = prompt('Название категории', c.title)
    if (t === null) return
    if (!t.trim()) return
    await api.products.updateCategory(c.id, { title: t.trim() })
    onChanged()
  }

  const remove = async (c: any) => {
    // ⚠️ Явно говорим, что продукты не пропадут: иначе удаление категории
    // выглядит как удаление всего, что в ней лежит.
    if (!confirm(`Удалить категорию «${c.title}»?\n\nПродукты останутся — они перейдут в «Без категории».`)) return
    await api.products.deleteCategory(c.id)
    onChanged()
  }

  return (
    // Модалка-форма НЕ закрывается по клику на фон (правило проекта).
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4">
      <div className="my-10 w-full max-w-lg rounded-2xl bg-white p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Категории продуктов</h2>
            <p className="text-xs text-gray-400">
              Раскладка по направлениям — например «Организация конференций»,
              «Финансовое планирование», «Продажи и маркетинг».
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <div className="mb-4 flex gap-2">
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add() }}
            placeholder="Название категории"
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button onClick={add} disabled={busy || !title.trim()} className="btn-gold px-4 text-sm">
            Добавить
          </button>
        </div>

        {!cats.length ? (
          <p className="text-sm text-gray-400">Категорий пока нет.</p>
        ) : (
          <div className="space-y-2">
            {cats.map(c => (
              <div key={c.id} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2">
                <span className="flex-1 text-sm text-gray-800">{c.title}</span>
                <button onClick={() => rename(c)} className="text-xs text-gray-500 hover:text-gray-700">
                  Переименовать
                </button>
                <button onClick={() => remove(c)} className="text-gray-400 hover:text-red-600">
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5">
          <button onClick={onClose} className="btn-gold">Готово</button>
        </div>
      </div>
    </div>
  )
}

function StatusChip({ status }: { status: string }) {
  const cls = status === 'published'
    ? 'bg-green-50 text-green-700 border-green-200'
    : status === 'archived'
      ? 'bg-gray-100 text-gray-500 border-gray-200'
      : 'bg-amber-50 text-amber-700 border-amber-200'
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${cls}`}>
      {STATUS_LABEL[status] || status}
    </span>
  )
}

function ProductForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await api.products.create({ title: title.trim() })
      onSaved()
    } finally { setSaving(false) }
  }

  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-semibold text-gray-900">Новый продукт</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
      </div>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm text-gray-600">Название</label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex gap-2">
          <button onClick={save} disabled={saving || !title.trim()} className="btn-gold">
            {saving ? 'Создаём…' : 'Создать'}
          </button>
          <button onClick={onClose} className="btn-primary">Отмена</button>
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────── Библиотека материалов ────────────────────────── */

function MaterialsTab({ readOnly }: { readOnly: boolean }) {
  const [list, setList] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState('')

  const load = async (query?: string) => {
    try {
      const r = await api.materials.list(query)
      setList(r.materials || [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  return (
    <div>
      <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
        Материал живёт в одном месте и может стоять сразу в нескольких продуктах —
        поправили здесь, обновилось везде. Обычно материалы добавляются прямо
        из продукта, а сюда заходят, чтобы переименовать или заменить файл.
      </div>

      <div className="mb-4 flex gap-2">
        {!readOnly && (
          <button onClick={() => setAdding(true)} className="btn-gold inline-flex items-center gap-2">
            <Plus size={16} /> Добавить материал
          </button>
        )}
        <input
          value={q}
          onChange={e => { setQ(e.target.value); load(e.target.value) }}
          placeholder="Поиск по названию"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      {adding && (
        <MaterialForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(q) }} />
      )}

      {!list.length && !adding && (
        <p className="text-sm text-gray-400">
          {q ? 'Ничего не нашлось.' : 'Пока пусто. Материалы появятся здесь, как только вы добавите их в продукт.'}
        </p>
      )}

      <div className="space-y-2">
        {list.map(m => (
          <MaterialRow key={m.id} material={m} readOnly={readOnly} onChanged={() => load(q)} />
        ))}
      </div>
    </div>
  )
}

function MaterialRow({ material, readOnly, onChanged }: {
  material: any; readOnly: boolean; onChanged: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [editing, setEditing] = useState(false)

  const remove = async () => {
    if (!confirm(`Удалить «${material.title}» из библиотеки?`)) return
    try {
      await api.materials.delete(material.id)
      onChanged()
    } catch (e: any) {
      // Бэк отвечает 409 со списком продуктов, где материал используется —
      // текст ошибки уже понятный, показываем как есть.
      alert(e?.message || 'Не удалось удалить')
    }
  }

  if (renaming) {
    return (
      <MaterialForm
        material={material}
        onClose={() => setRenaming(false)}
        onSaved={() => { setRenaming(false); onChanged() }}
      />
    )
  }

  return (
    <>
      <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
        <FileText size={18} className="shrink-0 text-gray-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-gray-900">{material.title}</div>
          <div className="text-xs text-gray-400">
            {material.blocks_count ? `${material.blocks_count} блок(ов)` : 'пустой'}
            {material.used_count > 0 && ` · используется в ${material.used_count} продукт(ах)`}
          </div>
        </div>
        {!readOnly && (
          <>
            <button onClick={() => setEditing(true)}
                    className="text-sm font-medium text-[#25455D] hover:underline">
              Содержимое
            </button>
            <button onClick={() => setRenaming(true)} className="text-sm text-gray-500 hover:text-gray-700">
              Переименовать
            </button>
            <button onClick={remove} className="text-gray-400 hover:text-red-600" title="Удалить">
              <Trash2 size={16} />
            </button>
          </>
        )}
      </div>

      {editing && (
        <MaterialEditor
          materialId={material.id}
          title={material.title}
          onClose={() => { setEditing(false); onChanged() }}
          onRenamed={() => onChanged()}
        />
      )}
    </>
  )
}

function MaterialForm({ material, onClose, onSaved }: {
  material?: any; onClose: () => void; onSaved: () => void
}) {
  const [title, setTitle] = useState(material?.title || '')
  const [description, setDescription] = useState(material?.description || '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      const data = { title: title.trim(), description: description.trim() || null }
      if (material) await api.materials.update(material.id, data)
      else await api.materials.create(data)
      onSaved()
    } finally { setSaving(false) }
  }

  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-semibold text-gray-900">
          {material ? 'Материал' : 'Новый материал'}
        </span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm text-gray-600">Название</label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-600">Описание</label>
          <input
            value={description}
            onChange={e => setDescription(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <p className="text-xs text-gray-400">
          Содержимое — текст, картинки, видео и файлы — собирается отдельно,
          кнопкой «Содержимое».
        </p>

        <div className="flex gap-2">
          <button onClick={save} disabled={saving || !title.trim()} className="btn-gold">
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button onClick={onClose} className="btn-primary">Отмена</button>
        </div>
      </div>
    </div>
  </LockedOverlayIf>
  )
}
