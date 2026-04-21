import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '[DEV] Марго Форбс - нелинейный стратег',
  description: 'Платформа управляемого вирального роста',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
