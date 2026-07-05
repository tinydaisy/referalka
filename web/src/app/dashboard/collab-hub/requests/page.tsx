'use client'
import { HubHeader, RequestsView, BroadcastConfirmationsView } from '../_components/shared'

export default function CollabRequestsPage() {
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <HubHeader subtitle="Входящие и отправленные предложения о коллаборации." />
      <BroadcastConfirmationsView />
      <RequestsView />
    </div>
  )
}
