'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function SpeakerDetailRedirect({ params }: { params: { id: string } }) {
  const router = useRouter()
  useEffect(() => { router.replace(`/dashboard/collaborations/${params.id}`) }, [params.id])
  return null
}
