'use client'
import { HubHeader, CollabEventsView } from '../_components/shared'

export default function CollabEventsPage() {
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <HubHeader subtitle="Совместные события, где вы один из организаторов." />
      <CollabEventsView />
    </div>
  )
}
