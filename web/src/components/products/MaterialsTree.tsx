'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, FileText } from 'lucide-react'

/**
 * Оглавление «разделы → материалы», только чтение.
 *
 * ⚠️ ОДИН КОМПОНЕНТ НА ВСЕ МЕСТА ПОКАЗА. В проекте уже было три независимых
 * реализации этого дерева (кабинет покупателя, состав продукта в кабинете
 * владельца, страница раздела) — и они разошлись: где-то разделы сворачивались,
 * где-то нет, порядок узлов считался по-разному. Четвёртая копия закрепила бы
 * расхождение. Отличается у мест ровно одно — куда ведёт материал, поэтому
 * адрес приходит функцией `hrefFor`, а не собирается внутри.
 *
 * ⚠️ Разделы СВЁРНУТЫ по умолчанию: с раскрытыми состав из двадцати материалов
 * превращается в простыню, по которой не видно структуры.
 *
 * ⚠️ Дерево приходит ГОТОВЫМ с бэкенда (`tree` из `_build_tree`), собирать его
 * на фронте не надо — иначе порядок узлов разойдётся с тем, что видит владелец
 * материалов у себя в кабинете.
 */
export default function MaterialsTree({ nodes, hrefFor }: {
  nodes: any[]
  /** Куда ведёт материал. Получает узел целиком: где-то нужен link_id, где-то material_id. */
  hrefFor: (node: any) => string
}) {
  return (
    <div className="space-y-2">
      {nodes.map((n: any) => (
        <Node key={`${n.type}-${n.id ?? n.link_id}`} node={n} hrefFor={hrefFor} />
      ))}
    </div>
  )
}

function Node({ node, hrefFor, depth = 0 }: {
  node: any; hrefFor: (n: any) => string; depth?: number
}) {
  const [open, setOpen] = useState(false)

  if (node.type === 'material') {
    // «Скоро» вместо «Открыть» у пустого материала: он заведён, но содержимого
    // в нём ещё нет — человек не должен решить, что страница сломалась.
    const filled = (node.blocks_count ?? node.blocks?.length ?? 0) > 0
    return (
      <Link
        href={hrefFor(node)}
        style={{ marginLeft: depth * 16 }}
        className="flex items-center gap-3 rounded-xl bg-white p-4 shadow-sm transition hover:shadow"
      >
        <FileText size={16} className="shrink-0 text-gray-400" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-900">{node.title}</div>
          {node.description && (
            <div className="mt-0.5 text-sm text-gray-500">{node.description}</div>
          )}
        </div>
        <span className="shrink-0 text-xs text-gray-400">
          {filled ? 'Открыть' : 'Скоро'}
        </span>
      </Link>
    )
  }

  const count = (node.children || []).filter((c: any) => c.type === 'material').length

  return (
    <div style={{ marginLeft: depth * 16 }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300"
      >
        {open
          ? <ChevronDown size={16} className="shrink-0 text-gray-400" />
          : <ChevronRight size={16} className="shrink-0 text-gray-400" />}
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-gray-900">{node.title}</div>
          {node.description && (
            <div className="text-sm text-gray-500">{node.description}</div>
          )}
        </div>
        {count > 0 && <span className="shrink-0 text-xs text-gray-400">{count}</span>}
      </button>
      {open && node.children?.length > 0 && (
        <div className="mt-2 space-y-2">
          {node.children.map((ch: any) => (
            <Node key={`${ch.type}-${ch.id ?? ch.link_id}`}
                  node={ch} hrefFor={hrefFor} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}
