'use client'
import { HubHeader, MatchmakerView } from '../_components/shared'

export default function CollabMatchmakerPage() {
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <HubHeader subtitle="Сервис сам подберёт партнёров по вашей нише и аудитории." />
      <MatchmakerView />
    </div>
  )
}
