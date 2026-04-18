'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function SpeakersNewRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/dashboard/collaborations/new') }, [])
  return null
}
