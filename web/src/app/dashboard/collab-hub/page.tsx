'use client'
import { HubHeader, CatalogView } from './_components/shared'

export default function CollabHubCatalogPage() {
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <HubHeader subtitle="Находите партнёров для совместных событий, обменивайтесь аудиторией честно — каждый ведёт своих." />
      <CatalogView />
    </div>
  )
}
