'use client'
import { useState } from 'react'
import { X } from 'lucide-react'

export function ImageThumb({ url, alt, className }: { url: string; alt?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  if (!url) return null
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className={className || 'w-10 h-10 rounded-lg overflow-hidden border border-gray-200 shrink-0 hover:border-brand transition-colors'}>
        <img src={url} alt={alt || ''} className="w-full h-full object-cover" />
      </button>
      {open && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/80"
          onClick={() => setOpen(false)}>
          <div className="relative max-w-4xl max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <img src={url} alt={alt || ''} className="max-w-full max-h-[90vh] rounded-xl shadow-2xl object-contain" />
            <button onClick={() => setOpen(false)}
              className="absolute top-2 right-2 bg-black/50 text-white rounded-full p-1.5 hover:bg-black/80 transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
