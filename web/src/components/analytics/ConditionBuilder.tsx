'use client'

/**
 * Конструктор условий квадратика: И/ИЛИ и группы.
 *
 * Дерево: { op:'and'|'or', items:[ лист | группа ] }
 * Лист:   { source:'field'|'question', ref_id, operator, values:[] }
 *
 * ⚠️ Операторы показываются ПО ТИПУ разреза (список `operators` приходит с
 * бэка). У «Уровня дохода» это select с вилками («200.000- 300.000 рублей»),
 * поэтому «больше 200 тысяч» задаётся галочками на нужных вилках, а не
 * знаком «>» — сравнения у списка невозможны в принципе.
 */
import { useState } from 'react'

export interface SourceMeta {
  key: string
  source: 'field' | 'question'
  ref_id: number
  title: string
  kind: string
  options: string[]
  group: string
  operators: string[]
}

const OP_LABEL: Record<string, string> = {
  in: 'один из',
  not_in: 'ни один из',
  eq: 'равно',
  neq: 'не равно',
  gt: 'больше',
  gte: 'больше или равно',
  lt: 'меньше',
  lte: 'меньше или равно',
  contains: 'содержит',
  filled: 'заполнено',
  empty: 'не заполнено',
}

const NEEDS_VALUES = ['in', 'not_in']
const NEEDS_INPUT = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']

export const emptyLeaf = (s?: SourceMeta) => ({
  source: s?.source || 'field',
  ref_id: s?.ref_id || 0,
  operator: s?.operators?.[0] || 'in',
  values: [] as string[],
})

/** Пустое дерево — «условий нет». */
export const emptyTree = () => ({ op: 'and', items: [] as any[] })

function SourcePicker({ value, sources, onChange }: {
  value: string
  sources: SourceMeta[]
  onChange: (s: SourceMeta) => void
}) {
  // Группируем по происхождению: поля контакта отдельно, каждая анкета отдельно.
  const groups: Record<string, SourceMeta[]> = {}
  sources.forEach(s => { (groups[s.group] ||= []).push(s) })

  return (
    <select
      value={value}
      onChange={e => {
        const found = sources.find(s => s.key === e.target.value)
        if (found) onChange(found)
      }}
      className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm max-w-[280px]"
    >
      <option value="">— выберите —</option>
      {Object.entries(groups).map(([g, items]) => (
        <optgroup key={g} label={g}>
          {items.map(s => (
            <option key={s.key} value={s.key}>{s.title}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function Leaf({ node, sources, onChange, onRemove }: {
  node: any
  sources: SourceMeta[]
  onChange: (n: any) => void
  onRemove: () => void
}) {
  const key = `${node.source}:${node.ref_id}`
  const meta = sources.find(s => s.key === key)
  const ops = meta?.operators || ['filled', 'empty']

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 p-2">
      <SourcePicker
        value={meta ? key : ''}
        sources={sources}
        onChange={s => onChange({ ...emptyLeaf(s) })}
      />

      {meta && (
        <select
          value={node.operator}
          onChange={e => onChange({ ...node, operator: e.target.value, values: [] })}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
        >
          {ops.map(o => <option key={o} value={o}>{OP_LABEL[o] || o}</option>)}
        </select>
      )}

      {/* Список вариантов — галочками. Так «доход больше 200к» = отметить вилки. */}
      {meta && NEEDS_VALUES.includes(node.operator) && (
        meta.kind === 'bool' ? (
          <div className="flex gap-2">
            {['Да', 'Нет'].map(v => (
              <label key={v} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={(node.values || []).includes(v)}
                  onChange={e => {
                    const set = new Set<string>(node.values || [])
                    e.target.checked ? set.add(v) : set.delete(v)
                    onChange({ ...node, values: [...set] })
                  }}
                />
                {v}
              </label>
            ))}
          </div>
        ) : (
          <div className="flex max-h-32 min-w-[220px] flex-col gap-1 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2">
            {(meta.options || []).length === 0 && (
              <span className="text-xs text-gray-400">Вариантов нет</span>
            )}
            {(meta.options || []).map(opt => (
              <label key={opt} className="flex items-start gap-1.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={(node.values || []).includes(opt)}
                  onChange={e => {
                    const set = new Set<string>(node.values || [])
                    e.target.checked ? set.add(opt) : set.delete(opt)
                    onChange({ ...node, values: [...set] })
                  }}
                />
                <span>{opt}</span>
              </label>
            ))}
          </div>
        )
      )}

      {meta && NEEDS_INPUT.includes(node.operator) && (
        <input
          value={node.values?.[0] || ''}
          onChange={e => onChange({ ...node, values: [e.target.value] })}
          placeholder={['gt', 'gte', 'lt', 'lte'].includes(node.operator) ? '200000' : ''}
          className="w-32 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
        />
      )}

      <button onClick={onRemove}
              className="ml-auto text-gray-400 hover:text-red-500"
              title="Убрать условие">✕</button>
    </div>
  )
}

export default function ConditionBuilder({ value, sources, onChange, depth = 0 }: {
  value: any
  sources: SourceMeta[]
  onChange: (v: any) => void
  depth?: number
}) {
  const node = value && typeof value === 'object' ? value : emptyTree()
  const items: any[] = Array.isArray(node.items) ? node.items : []
  const op = node.op === 'or' ? 'or' : 'and'

  const setItem = (i: number, v: any) => {
    const next = [...items]; next[i] = v
    onChange({ ...node, op, items: next })
  }
  const removeItem = (i: number) => {
    const next = items.filter((_, idx) => idx !== i)
    onChange({ ...node, op, items: next })
  }

  return (
    <div className={depth ? 'rounded-lg border border-gray-200 p-2' : ''}>
      {items.length > 1 && (
        <div className="mb-2 flex items-center gap-1 text-xs">
          <span className="text-gray-500">Выполняются:</span>
          <button
            onClick={() => onChange({ ...node, op: 'and', items })}
            className={`rounded px-2 py-0.5 ${op === 'and' ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600'}`}
          >все условия (И)</button>
          <button
            onClick={() => onChange({ ...node, op: 'or', items })}
            className={`rounded px-2 py-0.5 ${op === 'or' ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600'}`}
          >любое из них (ИЛИ)</button>
        </div>
      )}

      <div className="space-y-2">
        {items.map((it, i) =>
          Array.isArray(it?.items) ? (
            <div key={i} className="relative">
              <ConditionBuilder value={it} sources={sources} depth={depth + 1}
                                onChange={v => setItem(i, v)} />
              <button onClick={() => removeItem(i)}
                      className="absolute right-1 top-1 text-gray-400 hover:text-red-500"
                      title="Убрать группу">✕</button>
            </div>
          ) : (
            <Leaf key={i} node={it} sources={sources}
                  onChange={v => setItem(i, v)} onRemove={() => removeItem(i)} />
          )
        )}
      </div>

      <div className="mt-2 flex gap-2">
        <button
          onClick={() => onChange({ ...node, op, items: [...items, emptyLeaf()] })}
          className="rounded-lg border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >+ условие</button>
        {depth < 2 && (
          <button
            onClick={() => onChange({ ...node, op, items: [...items, { op: 'or', items: [emptyLeaf()] }] })}
            className="rounded-lg border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >+ группа</button>
        )}
      </div>
    </div>
  )
}
