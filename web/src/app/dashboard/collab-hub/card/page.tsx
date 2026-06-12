'use client'
import { HubHeader, MyCardView } from '../_components/shared'

export default function CollabCardPage() {
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <HubHeader subtitle="Так вас видят другие организаторы в каталоге." />
      <MyCardView />
    </div>
  )
}
