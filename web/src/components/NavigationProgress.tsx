'use client'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

export default function NavigationProgress() {
  const pathname = usePathname()
  const [loading, setLoading] = useState(false)
  const [prev, setPrev] = useState(pathname)

  useEffect(() => {
    if (pathname !== prev) {
      setLoading(true)
      setPrev(pathname)
      const t = setTimeout(() => setLoading(false), 600)
      return () => clearTimeout(t)
    }
  }, [pathname])

  if (!loading) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] h-0.5">
      <div className="h-full gradient-bg animate-[progress_0.6s_ease-out_forwards]" />
      <style>{`
        @keyframes progress {
          from { width: 0% }
          to   { width: 100% }
        }
      `}</style>
    </div>
  )
}
