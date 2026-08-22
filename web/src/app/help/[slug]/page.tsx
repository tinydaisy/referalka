'use client'
/**
 * Статья публичной базы знаний — /help/{slug}
 *
 * ⚠️ Статьи НЕ копируются. Здесь подключаются те же компоненты, что и в
 * кабинете: правка статьи меняет её сразу в обоих местах. Две копии
 * разъехались бы в первый же месяц.
 *
 * ⚠️ Карта импортов нужна явная — Next не умеет `import(переменная)`:
 * при сборке он должен видеть все пути. 54 статьи; шесть технических
 * (раздел «API-функции») наружу не идут.
 *
 * ⚠️ ssr: false — статьи писались для кабинета и местами читают
 * `window`/`localStorage`. На сервере это упало бы; рисуем в браузере.
 */
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Loader2 } from 'lucide-react'
import PublicHelpFrame from '../PublicHelpFrame'

function Loading() {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-400 py-12">
      <Loader2 size={16} className="animate-spin" /> Загружаем статью…
    </div>
  )
}

const ARTICLES: Record<string, React.ComponentType> = {
  'alt-launch-links': dynamic(() => import('../../dashboard/help/alt-launch-links/page'), { ssr: false, loading: Loading }),
  'award-analytics': dynamic(() => import('../../dashboard/help/award-analytics/page'), { ssr: false, loading: Loading }),
  'award-assignments': dynamic(() => import('../../dashboard/help/award-assignments/page'), { ssr: false, loading: Loading }),
  'award-broadcasts': dynamic(() => import('../../dashboard/help/award-broadcasts/page'), { ssr: false, loading: Loading }),
  'award-criteria': dynamic(() => import('../../dashboard/help/award-criteria/page'), { ssr: false, loading: Loading }),
  'award-intro': dynamic(() => import('../../dashboard/help/award-intro/page'), { ssr: false, loading: Loading }),
  'award-invite': dynamic(() => import('../../dashboard/help/award-invite/page'), { ssr: false, loading: Loading }),
  'award-jury-cabinet': dynamic(() => import('../../dashboard/help/award-jury-cabinet/page'), { ssr: false, loading: Loading }),
  'award-leaderboard': dynamic(() => import('../../dashboard/help/award-leaderboard/page'), { ssr: false, loading: Loading }),
  'award-nominations': dynamic(() => import('../../dashboard/help/award-nominations/page'), { ssr: false, loading: Loading }),
  'award-people': dynamic(() => import('../../dashboard/help/award-people/page'), { ssr: false, loading: Loading }),
  'award-setup': dynamic(() => import('../../dashboard/help/award-setup/page'), { ssr: false, loading: Loading }),
  'cloud-storage': dynamic(() => import('../../dashboard/help/cloud-storage/page'), { ssr: false, loading: Loading }),
  'cloud-storage-connect': dynamic(() => import('../../dashboard/help/cloud-storage-connect/page'), { ssr: false, loading: Loading }),
  'collab-announce': dynamic(() => import('../../dashboard/help/collab-announce/page'), { ssr: false, loading: Loading }),
  'collab-audience-exchange': dynamic(() => import('../../dashboard/help/collab-audience-exchange/page'), { ssr: false, loading: Loading }),
  'collab-broadcasts': dynamic(() => import('../../dashboard/help/collab-broadcasts/page'), { ssr: false, loading: Loading }),
  'collab-card': dynamic(() => import('../../dashboard/help/collab-card/page'), { ssr: false, loading: Loading }),
  'collab-chat': dynamic(() => import('../../dashboard/help/collab-chat/page'), { ssr: false, loading: Loading }),
  'collab-checklist': dynamic(() => import('../../dashboard/help/collab-checklist/page'), { ssr: false, loading: Loading }),
  'collab-find': dynamic(() => import('../../dashboard/help/collab-find/page'), { ssr: false, loading: Loading }),
  'collab-multi': dynamic(() => import('../../dashboard/help/collab-multi/page'), { ssr: false, loading: Loading }),
  'collab-prepare': dynamic(() => import('../../dashboard/help/collab-prepare/page'), { ssr: false, loading: Loading }),
  'conf-analytics': dynamic(() => import('../../dashboard/help/conf-analytics/page'), { ssr: false, loading: Loading }),
  'conf-announcements': dynamic(() => import('../../dashboard/help/conf-announcements/page'), { ssr: false, loading: Loading }),
  'conf-broadcasts': dynamic(() => import('../../dashboard/help/conf-broadcasts/page'), { ssr: false, loading: Loading }),
  'conf-intro': dynamic(() => import('../../dashboard/help/conf-intro/page'), { ssr: false, loading: Loading }),
  'conf-landing': dynamic(() => import('../../dashboard/help/conf-landing/page'), { ssr: false, loading: Loading }),
  'conf-program': dynamic(() => import('../../dashboard/help/conf-program/page'), { ssr: false, loading: Loading }),
  'conf-raffle': dynamic(() => import('../../dashboard/help/conf-raffle/page'), { ssr: false, loading: Loading }),
  'conf-speaker-cabinet': dynamic(() => import('../../dashboard/help/conf-speaker-cabinet/page'), { ssr: false, loading: Loading }),
  'conf-speaker-invite': dynamic(() => import('../../dashboard/help/conf-speaker-invite/page'), { ssr: false, loading: Loading }),
  'conf-speakers': dynamic(() => import('../../dashboard/help/conf-speakers/page'), { ssr: false, loading: Loading }),
  'connect-bot': dynamic(() => import('../../dashboard/help/connect-bot/page'), { ssr: false, loading: Loading }),
  'contact': dynamic(() => import('../../dashboard/help/contact/page'), { ssr: false, loading: Loading }),
  'event-analytics': dynamic(() => import('../../dashboard/help/event-analytics/page'), { ssr: false, loading: Loading }),
  'event-broadcasts': dynamic(() => import('../../dashboard/help/event-broadcasts/page'), { ssr: false, loading: Loading }),
  'event-create': dynamic(() => import('../../dashboard/help/event-create/page'), { ssr: false, loading: Loading }),
  'event-landing': dynamic(() => import('../../dashboard/help/event-landing/page'), { ssr: false, loading: Loading }),
  'event-lead-magnets': dynamic(() => import('../../dashboard/help/event-lead-magnets/page'), { ssr: false, loading: Loading }),
  'event-nurture': dynamic(() => import('../../dashboard/help/event-nurture/page'), { ssr: false, loading: Loading }),
  'event-referral': dynamic(() => import('../../dashboard/help/event-referral/page'), { ssr: false, loading: Loading }),
  'event-setup': dynamic(() => import('../../dashboard/help/event-setup/page'), { ssr: false, loading: Loading }),
  'event-tariffs': dynamic(() => import('../../dashboard/help/event-tariffs/page'), { ssr: false, loading: Loading }),
  'event-webinar': dynamic(() => import('../../dashboard/help/event-webinar/page'), { ssr: false, loading: Loading }),
  'event-welcome': dynamic(() => import('../../dashboard/help/event-welcome/page'), { ssr: false, loading: Loading }),
  'getting-started': dynamic(() => import('../../dashboard/help/getting-started/page'), { ssr: false, loading: Loading }),
  'max-setup': dynamic(() => import('../../dashboard/help/max-setup/page'), { ssr: false, loading: Loading }),
  'miniapp-deeplinks': dynamic(() => import('../../dashboard/help/miniapp-deeplinks/page'), { ssr: false, loading: Loading }),
  'tariff-buyers': dynamic(() => import('../../dashboard/help/tariff-buyers/page'), { ssr: false, loading: Loading }),
  'tournament-task-control': dynamic(() => import('../../dashboard/help/tournament-task-control/page'), { ssr: false, loading: Loading }),
  'utm-lead-magnets': dynamic(() => import('../../dashboard/help/utm-lead-magnets/page'), { ssr: false, loading: Loading }),
  'video-playlists': dynamic(() => import('../../dashboard/help/video-playlists/page'), { ssr: false, loading: Loading }),
  'vk-setup': dynamic(() => import('../../dashboard/help/vk-setup/page'), { ssr: false, loading: Loading }),
}

export default function PublicHelpArticle() {
  const params = useParams()
  const slug = String(params?.slug || '')
  const Article = ARTICLES[slug]

  if (!Article) {
    return (
      <div className="max-w-3xl">
        <div className="bg-white rounded-2xl border border-gray-100 p-6">
          <div className="text-base font-bold mb-1" style={{ color: '#25455D' }}>
            Такой статьи нет
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Возможно, ссылка устарела или статья доступна только в кабинете.
          </p>
          <Link href="/help"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <ArrowLeft size={15} /> Вся база знаний
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Link href="/help" className="text-sm text-gray-400 hover:text-gray-700">База знаний</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Статья</span>
      </div>

      <PublicHelpFrame>
        <Article />
      </PublicHelpFrame>

      <div className="mt-8 rounded-2xl p-5 text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        <div className="text-lg font-bold mb-1">Всё это настраивается мышкой</div>
        <p className="text-sm text-white/70 mb-4">
          Без программиста и технического задания. 7 дней бесплатно, карта не нужна.
        </p>
        <Link href="/register" className="btn-gold inline-block px-5 py-2.5 rounded-xl text-sm font-semibold">
          Попробовать бесплатно
        </Link>
      </div>
    </div>
  )
}
