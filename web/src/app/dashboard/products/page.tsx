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
import FeatureLock from '@/components/FeatureLock'
import { Plus, Trash2, Package, Library, X, FileText } from 'lucide-react'
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
  if (me && !hasFeature) {
    return (
      <div className="max-w-3xl">
        <h1 className="mb-1 text-2xl font-bold text-gray-900">Продукты и услуги</h1>
        <p className="mb-6 text-sm text-gray-500">
          Продавайте то, что не привязано к событию: наставничество, мастер-класс,
          консультацию. У каждого свой лендинг, тарифы и материалы для клиента.
        </p>
        <FeatureLock anyOf={['products']} />
      </div>
    )
  }

  return (
    <div className="max-w-5xl">
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
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  const load = async () => {
    try {
      const r = await api.products.list()
      setList(r.products || [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  if (loading) return <p className="text-sm text-gray-400">Загружаем…</p>

  return (
    <div>
      {!readOnly && (
        <button onClick={() => setAdding(true)} className="btn-gold mb-4 inline-flex items-center gap-2">
          <Plus size={16} /> Создать продукт
        </button>
      )}

      {adding && (
        <ProductForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load() }} />
      )}

      {!list.length && !adding && (
        <p className="text-sm text-gray-400">
          Пока ничего нет. Например: «Наставничество», «Мастер-класс по выступлениям»,
          «Разовая консультация».
        </p>
      )}

      <div className="space-y-2">
        {list.map(p => (
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
                {p.subtitle && (
                  <p className="mt-0.5 truncate text-sm text-gray-500">{p.subtitle}</p>
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
  const [subtitle, setSubtitle] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await api.products.create({ title: title.trim(), subtitle: subtitle.trim() || null })
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
        <div>
          <label className="mb-1 block text-sm text-gray-600">Короткое пояснение</label>
          <input
            value={subtitle}
            onChange={e => setSubtitle(e.target.value)}
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
  )
}
