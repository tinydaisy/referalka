'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Users, Star, Send, MapPin, ArrowLeft } from 'lucide-react'
import { api } from '@/lib/api'
import { PEACH, DARK, MediaTierBadge, CATEGORIES, Lightbox } from '../../_components/shared'

export default function OrgProfilePage() {
  const params = useParams()
  const id = Number(params?.id)
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')
  const [lightbox, setLightbox] = useState(false)
  const [reqOpen, setReqOpen] = useState(false)
  const [myRating, setMyRating] = useState(0)
  const [myText, setMyText] = useState('')
  const [reviewSaved, setReviewSaved] = useState(false)

  const load = async () => {
    try { const r: any = await api.collabHub.profile(id); setData(r); if (r.my_review) { setMyRating(r.my_review.rating); setMyText(r.my_review.text || '') } }
    catch (e: any) { setErr(e?.message || 'Не удалось загрузить') }
  }
  useEffect(() => { load() }, [id])

  const saveReview = async () => {
    if (!myRating) return
    await api.collabHub.addReview({ client_id: id, rating: myRating, text: myText || null })
    setReviewSaved(true); setTimeout(() => setReviewSaved(false), 2000); load()
  }

  if (err) return <div className="p-8 max-w-3xl mx-auto"><a href="/dashboard/collab-hub" className="text-sm text-gray-500 inline-flex items-center gap-1 mb-4"><ArrowLeft className="w-4 h-4" />Назад</a><div className="text-gray-400 py-10 text-center">{err}</div></div>
  if (!data) return <div className="p-8 text-gray-400 text-center">Загрузка…</div>
  const c = data.card
  const achievements: any[] = Array.isArray(c.achievements) ? c.achievements : []
  const social = c.social_links || {}
  const tg = social.telegram_channels?.[0]?.url || social.telegram
  const hadCollabs = (data.rating.collabs_count || 0) > 0
  const contribution = hadCollabs && data.rating.avg_contribution != null ? `${data.rating.avg_contribution}%` : '—'

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <a href="/dashboard/collab-hub" className="text-sm text-gray-500 inline-flex items-center gap-1 mb-4"><ArrowLeft className="w-4 h-4" />К каталогу</a>

      <div className="border rounded-2xl p-6 bg-white">
        <div className="flex items-start gap-5">
          {c.photo_url
            ? <img src={c.photo_url} alt="" onClick={() => setLightbox(true)} className="w-28 h-28 rounded-2xl object-cover cursor-zoom-in hover:opacity-90" />
            : <div className="w-28 h-28 rounded-2xl bg-gray-100 flex items-center justify-center text-gray-400"><Users className="w-10 h-10" /></div>}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold" style={{ color: DARK }}>{c.name}</h1>
            {c.positioning && <p className="text-gray-500 mt-1">{c.positioning}</p>}
            <div className="flex flex-wrap gap-2 mt-2">
              {c.hub_category && <span className="text-xs px-2.5 py-1 rounded-full" style={{ background: PEACH, color: DARK }}>{CATEGORIES[c.hub_category] || c.hub_category}</span>}
              <MediaTierBadge tier={c.media_tier} />
              {c.hub_city && <span className="text-xs text-gray-500 inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{c.hub_city}</span>}
            </div>
          </div>
        </div>

        {c.bio && (c.bio.includes('•')
          ? <ul className="text-gray-600 mt-5 space-y-1.5 list-none">
              {c.bio.split('•').map((s: string) => s.trim()).filter(Boolean).map((line: string, i: number) => (
                <li key={i} className="flex gap-2"><span style={{ color: PEACH }}>•</span><span>{line}</span></li>
              ))}
            </ul>
          : <p className="text-gray-600 mt-5 whitespace-pre-wrap">{c.bio}</p>)}

        {achievements.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-5">
            {achievements.map((a: any, i: number) => (
              <div key={i} className="rounded-xl bg-gray-50 p-3 text-center">
                <div className="font-bold" style={{ color: DARK }}>{a.value}</div>
                <div className="text-xs text-gray-500 leading-tight">{a.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* рейтинг */}
        <div className="grid grid-cols-2 gap-3 mt-5">
          <div className="rounded-xl border p-3 text-center">
            <div className="text-xl font-bold" style={{ color: DARK }}>{data.rating.collabs_count}</div>
            <div className="text-xs text-gray-500">коллабораций</div>
          </div>
          <div className="rounded-xl border p-3 text-center" title="Средняя доля участников, которых организатор приводил сам">
            <div className="text-xl font-bold" style={{ color: DARK }}>{contribution}</div>
            <div className="text-xs text-gray-500">средний вклад</div>
          </div>
        </div>

        {/* контакты */}
        {(tg || c.telegram_username) && (
          <div className="flex flex-wrap gap-2 mt-5">
            {c.telegram_username && <a href={`https://t.me/${c.telegram_username.replace('@', '')}?text=Здравствуйте! По коллаборации в ПЛЮСОН`} target="_blank" rel="noreferrer" className="text-sm px-4 py-2 rounded-xl text-white inline-flex items-center gap-1.5" style={{ background: DARK }}><Send className="w-4 h-4" />Написать в Telegram</a>}
            {tg && <a href={tg} target="_blank" rel="noreferrer" className="text-sm px-4 py-2 rounded-xl border inline-flex items-center gap-1.5">Канал</a>}
          </div>
        )}
      </div>

      {/* Отзывы */}
      <div className="mt-6">
        <h2 className="font-bold text-lg mb-3" style={{ color: DARK }}>Отзывы</h2>
        {!data.is_me && (
          <div className="border rounded-2xl p-4 bg-white mb-4">
            <div className="text-sm font-medium mb-2">Ваш отзыв</div>
            <div className="flex gap-1 mb-2">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} onClick={() => setMyRating(n)}>
                  <Star className="w-6 h-6" fill={n <= myRating ? PEACH : 'none'} stroke={n <= myRating ? PEACH : '#cbd5e1'} />
                </button>
              ))}
            </div>
            <textarea value={myText} onChange={e => setMyText(e.target.value)} placeholder="Как прошла коллаборация?" className="w-full border rounded-xl px-3 py-2 text-sm mb-2" rows={2} />
            <button onClick={saveReview} disabled={!myRating} className="text-sm px-4 py-2 rounded-xl text-white disabled:opacity-40" style={{ background: DARK }}>{reviewSaved ? '✓ Сохранено' : 'Оставить отзыв'}</button>
          </div>
        )}
        {data.reviews.length === 0 ? <div className="text-gray-400 text-sm py-4">Отзывов пока нет.</div>
          : <div className="space-y-2">{data.reviews.map((rv: any, i: number) => (
            <div key={i} className="border rounded-2xl p-4 bg-white">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm" style={{ color: DARK }}>{rv.author_name}</span>
                <span className="flex">{[1, 2, 3, 4, 5].map(n => <Star key={n} className="w-3.5 h-3.5" fill={n <= rv.rating ? PEACH : 'none'} stroke={n <= rv.rating ? PEACH : '#cbd5e1'} />)}</span>
              </div>
              {rv.text && <p className="text-sm text-gray-600 mt-1">{rv.text}</p>}
            </div>
          ))}</div>}
      </div>

      {lightbox && c.photo_url && <Lightbox src={c.photo_url} onClose={() => setLightbox(false)} />}
    </div>
  )
}
