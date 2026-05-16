'use client'
import EventParticipants from '@/components/EventParticipants'

export default function ParticipantsTab({ eventId }: { eventId: number }) {
  return <EventParticipants eventId={eventId} moduleSlug="conference" />
}
