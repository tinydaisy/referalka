import type { Metadata } from 'next'
import './globals.css'

const isDev = process.env.NEXT_PUBLIC_APP_ENV === 'dev'

export const metadata: Metadata = {
  title: isDev ? 'DEV-ПЛЮСОН' : 'ПЛЮСОН',
  description: 'Платформа управляемого вирального роста',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
