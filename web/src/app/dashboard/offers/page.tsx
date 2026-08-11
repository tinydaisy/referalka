'use client'

import FeatureLock from '@/components/FeatureLock'

/**
 * Раздел «Оферты» (миграция 249).
 *
 * У клиента обычно несколько продуктов, и оферта у каждого своя. Текст
 * хранится у нас, публичная ссылка — pluson.ru/o/{адрес}: не протухнет, если
 * клиент переедет с другой площадки. Можно и просто указать внешний адрес.
 *
 * Привязка к событию и к тарифу — в карточке события (вкладка «Тарифы»).
 */
import { useEffect, useState } from 'react'
import { FileText, Plus, Trash2, Loader2, ExternalLink, Copy, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'

export default function OffersPage() {
  // publicBase/publicHost — домен клиента: оферту он отдаёт своим покупателям.
  const { me, publicBase, publicHost } = useMe()
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState<number | null>(null)

  const hasFeature = (me?.features || []).includes('offers')

  const load = async () => {
    try {
      const res = await api.offers.list()
      setItems(res.items || [])
    } catch (e: any) {
      if (!String(e?.message || '').includes('недоступен')) {
        alert(e?.message || 'Не удалось загрузить оферты')
      }
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const openNew = () => setEditing({
    title: '', slug: '', body: '', external_url: '', is_active: true,
  })

  const openEdit = async (id: number) => {
    try { setEditing(await api.offers.get(id)) }
    catch (e: any) { alert(e?.message || 'Не удалось открыть') }
  }

  const save = async () => {
    if (!editing?.title?.trim()) { alert('Впишите название оферты'); return }
    setSaving(true)
    try {
      if (editing.id) await api.offers.update(editing.id, editing)
      else await api.offers.create(editing)
      setEditing(null)
      await load()
    } catch (e: any) { alert(e?.message || 'Не удалось сохранить') }
    finally { setSaving(false) }
  }

  const remove = async (o: any) => {
    const used = (o.events_count || 0) + (o.tariffs_count || 0)
    const warn = used
      ? `\n\nЭта оферта привязана к ${used} местам — ссылки там перестанут работать.`
      : ''
    if (!confirm(`Удалить «${o.title}»?${warn}`)) return
    try { await api.offers.remove(o.id); await load() }
    catch (e: any) { alert(e?.message || 'Не удалось удалить') }
  }

  if (!hasFeature && !loading) {
    return (
      <div className="max-w-2xl space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Оферты</h2>
          <p className="mt-1 text-sm text-gray-500">
            Документ с условиями участия: показывается галочкой при оплате
            платного тарифа события.
          </p>
        </div>
        <FeatureLock anyOf={['offers']} />
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Оферты</h1>
          <p className="mt-1 text-sm text-gray-500">
            Тексты договоров под ваши продукты. Ссылку можно поставить в тарифах и в подвале лендинга.
          </p>
        </div>
        <button onClick={openNew} className="btn-primary inline-flex items-center gap-2">
          <Plus className="h-4 w-4" /> Добавить оферту
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin" /> Загружаем…
        </div>
      ) : !items.length ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-gray-500">
          Пока ни одной оферты. Добавьте первую — например, для конференции.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(o => {
            // ⚠️ Не location.origin: кабинет открыт на pluson.ru, а оферту
            // клиент отдаёт покупателям — она должна быть на ЕГО домене.
            const url = o.external_url || `${publicBase}/o/${o.slug}`
            return (
              <div key={o.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4">
                <FileText className="h-5 w-5 shrink-0 text-gray-400" />
                <button onClick={() => openEdit(o.id)} className="min-w-0 flex-1 text-left">
                  <div className={`font-medium ${o.is_active ? 'text-gray-900' : 'text-gray-400'}`}>
                    {o.title}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-gray-500">{url}</div>
                </button>

                {!!(o.events_count || o.tariffs_count) && (
                  <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                    используется: {o.events_count + o.tariffs_count}
                  </span>
                )}

                <button
                  onClick={() => { navigator.clipboard.writeText(url); setCopied(o.id); setTimeout(() => setCopied(null), 1500) }}
                  className="shrink-0 rounded p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                  title="Скопировать ссылку"
                >
                  {copied === o.id ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                </button>
                <a href={url} target="_blank" rel="noreferrer"
                   className="shrink-0 rounded p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                   title="Открыть">
                  <ExternalLink className="h-4 w-4" />
                </a>
                <button onClick={() => remove(o)}
                        className="shrink-0 rounded p-2 text-gray-400 hover:bg-red-50 hover:text-red-600">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* ⚠️ Модалка-форма закрывается только по кнопке — клик по фону не
          закрывает, иначе теряется набранный текст (правило проекта). */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-10">
          <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-gray-900">
              {editing.id ? 'Оферта' : 'Новая оферта'}
            </h2>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Название</label>
                <input
                  type="text" value={editing.title || ''}
                  onChange={e => setEditing({ ...editing, title: e.target.value })}
                  placeholder="Оферта конференции iViSiON"
                  className="input"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Адрес страницы
                </label>
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-sm text-gray-500">https://{publicHost}/o/</span>
                  <input
                    type="text" value={editing.slug || ''}
                    onChange={e => setEditing({ ...editing, slug: e.target.value })}
                    placeholder="oferta-conf"
                    className="input font-mono"
                  />
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Только латиница и дефисы. Пусто — подставим сами.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Текст оферты
                </label>
                <textarea
                  rows={14}
                  value={editing.body || ''}
                  onChange={e => setEditing({ ...editing, body: e.target.value })}
                  placeholder="Вставьте текст договора…"
                  className="input font-mono text-[13px]"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Можно вставить как обычный текст или с HTML-разметкой.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Или ссылка на внешнюю страницу
                </label>
                <input
                  type="text" value={editing.external_url || ''}
                  onChange={e => setEditing({ ...editing, external_url: e.target.value })}
                  placeholder="https://…"
                  className="input"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Заполнено — ведём туда, текст выше не показывается.
                </p>
              </div>

              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox" checked={editing.is_active !== false}
                  onChange={e => setEditing({ ...editing, is_active: e.target.checked })}
                  className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                />
                <span className="text-sm text-gray-700">Действует</span>
              </label>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button onClick={() => setEditing(null)}
                      className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                Отмена
              </button>
              <button onClick={save} disabled={saving}
                      className="btn-primary inline-flex items-center gap-2 disabled:opacity-60">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Сохранить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
