'use client'
import { LayoutGrid, List as ListIcon } from 'lucide-react'

export type ViewMode = 'list' | 'grid'

export default function ViewToggle({ view, onChange }: {
  view: ViewMode
  onChange: (v: ViewMode) => void
}) {
  return (
    <div className="inline-flex p-1 bg-gray-100 rounded-lg">
      <button
        onClick={() => onChange('list')}
        className={`p-1.5 rounded ${
          view === 'list' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400 hover:text-gray-700'
        }`}
        title="Списком"
      >
        <ListIcon size={16} />
      </button>
      <button
        onClick={() => onChange('grid')}
        className={`p-1.5 rounded ${
          view === 'grid' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400 hover:text-gray-700'
        }`}
        title="Плитками"
      >
        <LayoutGrid size={16} />
      </button>
    </div>
  )
}
