'use client'

/**
 * Редактор материала (миграция 294) — страница из блоков, как урок в GetCourse.
 *
 * Внутри одного материала: текст с форматированием, картинки, видео по ссылке,
 * файлы на скачивание, аудио и кнопки — в любом порядке и количестве.
 *
 * ⚠️ Видео — ТОЛЬКО ссылка на YouTube / VK Видео / Rutube. Своё видео не
 * храним: это гигабайты и отдельная раздача, а у клиента ролики и так лежат
 * на площадках.
 *
 * ⚠️ Картинки, файлы и аудио грузятся как `material_media` — у продукта нет
 * event_id, и обычный `landing_media` упал бы с «требует event_id».
 */
import { useEffect, useRef, useState } from 'react'
import {
  Plus, Trash2, X, Loader2, Type, Image as ImageIcon, Video, FileText,
  Music, MousePointerClick, ChevronUp, ChevronDown,
} from 'lucide-react'
import { api } from '@/lib/api'
import FileUploader from '@/components/FileUploader'
import HtmlTextArea from '@/components/HtmlTextArea'
import { embedUrl, isFileVideo, videoHost } from '@/lib/videoEmbed'

type Kind = 'text' | 'image' | 'video' | 'file' | 'audio' | 'button'

const KINDS: Array<{ kind: Kind; label: string; hint: string; Icon: any }> = [
  { kind: 'text',   label: 'Текст',   hint: 'Заголовки, списки, ссылки', Icon: Type },
  { kind: 'image',  label: 'Картинка', hint: 'Скриншот, схема, обложка', Icon: ImageIcon },
  { kind: 'video',  label: 'Видео',   hint: 'Ссылка на YouTube, VK или Rutube', Icon: Video },
  { kind: 'file',   label: 'Файл',    hint: 'PDF, презентация, таблица', Icon: FileText },
  { kind: 'audio',  label: 'Аудио',   hint: 'Голосовое, подкаст', Icon: Music },
  { kind: 'button', label: 'Кнопка',  hint: 'Ссылка на чат, форму, оплату', Icon: MousePointerClick },
]

export default function MaterialEditor({
  materialId, title, onClose, onRenamed, mode = 'modal',
}: {
  materialId: number
  title: string
  onClose: () => void
  onRenamed?: (title: string) => void
  /**
   * ⚠️ `page` — тот же редактор, но БЕЗ затемнения и рамки модалки: урок
   * правится на отдельной странице. В окне длинный урок неудобен — он
   * прокручивается внутри коробки высотой в экран, ссылки и видео некуда
   * развернуть, а свернуть окно, чтобы свериться с соседним уроком, нельзя.
   */
  mode?: 'modal' | 'page'
}) {
  const [blocks, setBlocks] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState(title)
  const timers = useRef<Record<string, any>>({})
  const pending = useRef<Record<number, any>>({})

  const load = async () => {
    try {
      const r = await api.materials.blocks(materialId)
      setBlocks(r.blocks || [])
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [materialId])

  /* ── правки блока: копим и шлём одним запросом ────────────────────────── */
  const patch = (id: number, data: any) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, ...data } : b))
    pending.current[id] = { ...(pending.current[id] || {}), ...data }
    clearTimeout(timers.current[id])
    timers.current[id] = setTimeout(async () => {
      const body = pending.current[id]
      pending.current[id] = {}
      if (!body || !Object.keys(body).length) return
      setSaving(true)
      try { await api.materials.updateBlock(materialId, id, body) }
      catch { /* следующая правка отправит заново */ }
      finally { setSaving(false) }
    }, 600)
  }

  const add = async (kind: Kind) => {
    try {
      const created = await api.materials.addBlock(materialId, { kind })
      setBlocks(prev => [...prev, created])
    } catch (e: any) {
      alert(e?.message || 'Не удалось добавить блок')
    }
  }

  const remove = async (id: number) => {
    if (!confirm('Удалить блок?')) return
    setBlocks(prev => prev.filter(b => b.id !== id))
    try { await api.materials.deleteBlock(materialId, id) } catch { load() }
  }

  const move = async (idx: number, dir: -1 | 1) => {
    const j = idx + dir
    if (j < 0 || j >= blocks.length) return
    const list = [...blocks]
    ;[list[idx], list[j]] = [list[j], list[idx]]
    setBlocks(list)
    try { await api.materials.reorderBlocks(materialId, list.map(b => b.id)) }
    catch { load() }
  }

  const rename = async (v: string) => {
    setName(v)
    clearTimeout(timers.current['name'])
    timers.current['name'] = setTimeout(async () => {
      try {
        await api.materials.update(materialId, { title: v.trim() })
        onRenamed?.(v.trim())
      } catch { /* следующая правка отправит заново */ }
    }, 600)
  }

  const isPage = mode === 'page'

  // ⚠️ Модалка-форма не закрывается по клику на фон (правило проекта):
  // на внешнем div нет onClick — иначе набранный урок потеряется.
  // В режиме `page` затемнения и коробки нет вовсе — содержимое ложится
  // прямо на страницу, и длинный урок прокручивается всей страницей.
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    isPage ? (
      <div className="w-full">{children}</div>
    ) : (
      <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4">
        <div
          onClick={e => e.stopPropagation()}
          className="my-6 max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-6"
        >
          {children}
        </div>
      </div>
    )

  return (
    <Wrapper>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <input
              value={name}
              onChange={e => rename(e.target.value)}
              className="w-full rounded-lg border border-transparent px-2 py-1 text-lg font-semibold text-gray-900 hover:border-gray-200 focus:border-gray-300 focus:outline-none"
            />
            <p className="px-2 text-xs text-gray-400">
              Соберите материал из блоков — как страницу урока.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {saving && <Loader2 size={15} className="animate-spin text-gray-400" />}
            {/* На отдельной странице крестик не нужен — есть ссылка «назад». */}
            {!isPage && (
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-gray-400">Загружаем…</p>
        ) : (
          <>
            {!blocks.length && (
              <p className="mb-4 rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">
                Пока пусто. Добавьте текст, видео или файл — кнопки ниже.
              </p>
            )}

            <div className="space-y-3">
              {blocks.map((b, i) => (
                <BlockEditor
                  key={b.id}
                  block={b}
                  canUp={i > 0}
                  canDown={i < blocks.length - 1}
                  onMove={(dir) => move(i, dir)}
                  onPatch={(d) => patch(b.id, d)}
                  onRemove={() => remove(b.id)}
                />
              ))}
            </div>

            <div className="mt-5 rounded-xl border border-dashed border-gray-300 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700">
                <Plus size={15} /> Добавить блок
              </div>
              <div className="flex flex-wrap gap-2">
                {KINDS.map(k => (
                  <button
                    key={k.kind}
                    onClick={() => add(k.kind)}
                    title={k.hint}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:border-gray-400"
                  >
                    <k.Icon size={14} /> {k.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="mt-5">
          <button onClick={onClose} className="btn-gold">
            {isPage ? 'Готово — вернуться к списку' : 'Готово'}
          </button>
        </div>
    </Wrapper>
  )
}

/* ────────────────────────────── Блок ────────────────────────────────────── */

function BlockEditor({ block, canUp, canDown, onMove, onPatch, onRemove }: {
  block: any
  canUp: boolean
  canDown: boolean
  onMove: (dir: -1 | 1) => void
  onPatch: (data: any) => void
  onRemove: () => void
}) {
  const meta = KINDS.find(k => k.kind === block.kind) || KINDS[0]

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <meta.Icon size={15} className="text-gray-400" />
        <span className="text-sm font-medium text-gray-700">{meta.label}</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => canUp && onMove(-1)} disabled={!canUp}
                  className="p-1 text-gray-300 hover:text-gray-500 disabled:opacity-30">
            <ChevronUp size={16} />
          </button>
          <button onClick={() => canDown && onMove(1)} disabled={!canDown}
                  className="p-1 text-gray-300 hover:text-gray-500 disabled:opacity-30">
            <ChevronDown size={16} />
          </button>
          <button onClick={onRemove} className="p-1 text-gray-400 hover:text-red-600">
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {block.kind === 'text' && (
        // ⚠️ Обычное поле с HTML-тегами, НЕ визуальный редактор. Визуальный
        // (contentEditable) терял содержимое: нажатие «B» без выделения
        // стирало набранный урок, а правки не всегда доезжали до сохранения.
        // Теги проверяются на месте — незакрытый или перевёрнутый подсвечивается.
        <HtmlTextArea
          rows={8}
          value={block.body || ''}
          onChange={v => onPatch({ body: v })}
          placeholder="Текст урока. Жирный — <b>текст</b>, курсив — <i>текст</i>, ссылка — <a href=&quot;https://…&quot;>текст</a>"
        />
      )}

      {block.kind === 'video' && (
        <div className="space-y-2">
          <input
            value={block.url || ''}
            onChange={e => onPatch({ url: e.target.value })}
            placeholder="Ссылка на YouTube, VK Видео или Rutube"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            value={block.title || ''}
            onChange={e => onPatch({ title: e.target.value })}
            placeholder="Подпись над видео"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          {block.url && (
            <div className="overflow-hidden rounded-xl bg-black">
              {isFileVideo(block.url) ? (
                <video src={block.url} controls className="w-full" />
              ) : (
                <iframe
                  src={embedUrl(block.url)}
                  allowFullScreen
                  className="aspect-video w-full"
                />
              )}
            </div>
          )}
          {block.url && !videoHost(block.url) && !isFileVideo(block.url) && (
            <p className="text-xs text-amber-600">
              Площадку не узнали — плеер может не открыться. Поддержаны
              YouTube, VK Видео и Rutube.
            </p>
          )}

          {/* ⚠️ Обложка нужна для VK и Rutube: адрес их обложки из ссылки не
              достать, а метод их API требует токен владельца сообщества —
              поэтому без своей картинки видео выглядит чёрным прямоугольником.
              У YouTube обложка берётся из ссылки сама, поле можно не трогать. */}
          <div className="pt-1">
            <div className="mb-1 text-xs text-gray-600">
              Обложка{' '}
              <span className="text-gray-400">
                — у видео из VK и Rutube без неё чёрный экран
              </span>
            </div>
            <FileUploader
              mode="single" kind="material_media"
              value={block.poster_url || null}
              aspectClass="aspect-video"
              onChange={(u: string | null) => onPatch({ poster_url: u || null })}
            />
          </div>
        </div>
      )}

      {(block.kind === 'image' || block.kind === 'file' || block.kind === 'audio') && (
        <div className="space-y-2">
          <FileUploader
            kind="material_media"
            mode="single"
            value={block.url || ''}
            onChange={(url: string | null) => onPatch({ url })}
          />
          <input
            value={block.title || ''}
            onChange={e => onPatch({ title: e.target.value })}
            placeholder={block.kind === 'image' ? 'Подпись под картинкой' : 'Название файла'}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      )}

      {block.kind === 'button' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={block.title || ''}
            onChange={e => onPatch({ title: e.target.value })}
            placeholder="Текст кнопки"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            value={block.url || ''}
            onChange={e => onPatch({ url: e.target.value })}
            placeholder="Куда ведёт"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      )}
    </div>
  )
}
