import type { Metadata } from 'next'
import './globals.css'

const isDev = process.env.NEXT_PUBLIC_APP_ENV === 'dev'

export const metadata: Metadata = {
  title: isDev ? 'DEV-iViSiON: ПЛЮСОН' : 'iViSiON: ПЛЮСОН',
  description: 'Платформа для организаторов и экспертов: управляйте событием от А до Я — спикеры, рассылки, рефералы в одном месте',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
