'use client'
import { HubHeader, CollabsView } from '../_components/shared'

export default function CollabsPage() {
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <HubHeader subtitle="Ваши коллабы — совместные события, где вы один из организаторов." />
      <CollabsView />
    </div>
  )
}
