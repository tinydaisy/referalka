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
 * ⚠️ Рисуются НА СЕРВЕРЕ (без `ssr: false`) — иначе поисковик видит пустую
 * страницу и публикация не даёт трафика, ради которого затевалась.
 * Обращения к `window` в статьях защищены проверкой и стоят в useEffect,
 * поэтому на сервере не выполняются.
 */
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Loader2 } from 'lucide-react'
import PublicHelpFrame from '../PublicHelpFrame'
import { findPublicArticle } from '../../dashboard/help/sections'

function Loading() {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-400 py-12">
      <Loader2 size={16} className="animate-spin" /> Загружаем статью…
    </div>
  )
}

const ARTICLES: Record<string, React.ComponentType> = {
  'alt-launch-links': dynamic(() => import('../../dashboard/help/alt-launch-links/page'), { loading: Loading }),
  'award-analytics': dynamic(() => import('../../dashboard/help/award-analytics/page'), { loading: Loading }),
  'award-assignments': dynamic(() => import('../../dashboard/help/award-assignments/page'), { loading: Loading }),
  'award-broadcasts': dynamic(() => import('../../dashboard/help/award-broadcasts/page'), { loading: Loading }),
  'award-criteria': dynamic(() => import('../../dashboard/help/award-criteria/page'), { loading: Loading }),
  'award-intro': dynamic(() => import('../../dashboard/help/award-intro/page'), { loading: Loading }),
  'award-invite': dynamic(() => import('../../dashboard/help/award-invite/page'), { loading: Loading }),
  'award-jury-cabinet': dynamic(() => import('../../dashboard/help/award-jury-cabinet/page'), { loading: Loading }),
  'award-leaderboard': dynamic(() => import('../../dashboard/help/award-leaderboard/page'), { loading: Loading }),
  'award-nominations': dynamic(() => import('../../dashboard/help/award-nominations/page'), { loading: Loading }),
  'award-people': dynamic(() => import('../../dashboard/help/award-people/page'), { loading: Loading }),
  'award-setup': dynamic(() => import('../../dashboard/help/award-setup/page'), { loading: Loading }),
  'cloud-storage': dynamic(() => import('../../dashboard/help/cloud-storage/page'), { loading: Loading }),
  'cloud-storage-connect': dynamic(() => import('../../dashboard/help/cloud-storage-connect/page'), { loading: Loading }),
  'collab-announce': dynamic(() => import('../../dashboard/help/collab-announce/page'), { loading: Loading }),
  'collab-audience-exchange': dynamic(() => import('../../dashboard/help/collab-audience-exchange/page'), { loading: Loading }),
  'collab-broadcasts': dynamic(() => import('../../dashboard/help/collab-broadcasts/page'), { loading: Loading }),
  'collab-card': dynamic(() => import('../../dashboard/help/collab-card/page'), { loading: Loading }),
  'collab-chat': dynamic(() => import('../../dashboard/help/collab-chat/page'), { loading: Loading }),
  'collab-checklist': dynamic(() => import('../../dashboard/help/collab-checklist/page'), { loading: Loading }),
  'collab-find': dynamic(() => import('../../dashboard/help/collab-find/page'), { loading: Loading }),
  'collab-multi': dynamic(() => import('../../dashboard/help/collab-multi/page'), { loading: Loading }),
  'collab-prepare': dynamic(() => import('../../dashboard/help/collab-prepare/page'), { loading: Loading }),
  'conf-analytics': dynamic(() => import('../../dashboard/help/conf-analytics/page'), { loading: Loading }),
  'conf-announcements': dynamic(() => import('../../dashboard/help/conf-announcements/page'), { loading: Loading }),
  'conf-broadcasts': dynamic(() => import('../../dashboard/help/conf-broadcasts/page'), { loading: Loading }),
  'conf-intro': dynamic(() => import('../../dashboard/help/conf-intro/page'), { loading: Loading }),
  'conf-landing': dynamic(() => import('../../dashboard/help/conf-landing/page'), { loading: Loading }),
  'conf-program': dynamic(() => import('../../dashboard/help/conf-program/page'), { loading: Loading }),
  'conf-raffle': dynamic(() => import('../../dashboard/help/conf-raffle/page'), { loading: Loading }),
  'conf-speaker-cabinet': dynamic(() => import('../../dashboard/help/conf-speaker-cabinet/page'), { loading: Loading }),
  'conf-speaker-invite': dynamic(() => import('../../dashboard/help/conf-speaker-invite/page'), { loading: Loading }),
  'conf-speakers': dynamic(() => import('../../dashboard/help/conf-speakers/page'), { loading: Loading }),
  'connect-bot': dynamic(() => import('../../dashboard/help/connect-bot/page'), { loading: Loading }),
  'contact': dynamic(() => import('../../dashboard/help/contact/page'), { loading: Loading }),
  'event-analytics': dynamic(() => import('../../dashboard/help/event-analytics/page'), { loading: Loading }),
  'event-broadcasts': dynamic(() => import('../../dashboard/help/event-broadcasts/page'), { loading: Loading }),
  'event-create': dynamic(() => import('../../dashboard/help/event-create/page'), { loading: Loading }),
  'event-landing': dynamic(() => import('../../dashboard/help/event-landing/page'), { loading: Loading }),
  'event-lead-magnets': dynamic(() => import('../../dashboard/help/event-lead-magnets/page'), { loading: Loading }),
  'event-nurture': dynamic(() => import('../../dashboard/help/event-nurture/page'), { loading: Loading }),
  'event-referral': dynamic(() => import('../../dashboard/help/event-referral/page'), { loading: Loading }),
  'event-setup': dynamic(() => import('../../dashboard/help/event-setup/page'), { loading: Loading }),
  'event-tariffs': dynamic(() => import('../../dashboard/help/event-tariffs/page'), { loading: Loading }),
  'event-webinar': dynamic(() => import('../../dashboard/help/event-webinar/page'), { loading: Loading }),
  'recording-cuts': dynamic(() => import('../../dashboard/help/recording-cuts/page'), { loading: Loading }),
  'event-welcome': dynamic(() => import('../../dashboard/help/event-welcome/page'), { loading: Loading }),
  'getting-started': dynamic(() => import('../../dashboard/help/getting-started/page'), { loading: Loading }),
  'lead-magnet-survey': dynamic(() => import('../../dashboard/help/lead-magnet-survey/page'), { loading: Loading }),
  'survey-processing': dynamic(() => import('../../dashboard/help/survey-processing/page'), { loading: Loading }),
  'instagram-setup': dynamic(() => import('../../dashboard/help/instagram-setup/page'), { loading: Loading }),
  'instagram-funnel': dynamic(() => import('../../dashboard/help/instagram-funnel/page'), { loading: Loading }),
  'max-bot': dynamic(() => import('../../dashboard/help/max-bot/page'), { loading: Loading }),
  'max-setup': dynamic(() => import('../../dashboard/help/max-setup/page'), { loading: Loading }),
  'miniapp-deeplinks': dynamic(() => import('../../dashboard/help/miniapp-deeplinks/page'), { loading: Loading }),
  'partner-program': dynamic(() => import('../../dashboard/help/partner-program/page'), { loading: Loading }),
  'seo-basics': dynamic(() => import('../../dashboard/help/seo-basics/page'), { loading: Loading }),
  'tariff-buyers': dynamic(() => import('../../dashboard/help/tariff-buyers/page'), { loading: Loading }),
  'tournament-task-control': dynamic(() => import('../../dashboard/help/tournament-task-control/page'), { loading: Loading }),
  'utm-lead-magnets': dynamic(() => import('../../dashboard/help/utm-lead-magnets/page'), { loading: Loading }),
  'video-playlists': dynamic(() => import('../../dashboard/help/video-playlists/page'), { loading: Loading }),
  'vk-setup': dynamic(() => import('../../dashboard/help/vk-setup/page'), { loading: Loading }),
}

export default function ArticleView() {
  const params = useParams()
  const slug = String(params?.slug || '')
  const Article = ARTICLES[slug]
  const found = findPublicArticle(slug)

  if (!Article) {
    return (
      <div className="max-w-6xl">
        <div className="bg-white rounded-2xl border card-border p-6">
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
      {/* Крошки собираем сами: у статьи внутри свои («Дашборд / Инструкции»),
          но они ведут в кабинет и снаружи бессмысленны — прячутся в
          PublicHelpFrame. */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Link href="/help" className="text-sm text-gray-400 hover:text-gray-700">База знаний</Link>
        {found && (
          <>
            <span className="text-gray-300">/</span>
            <Link href={`/help/s/${found.section.id}`}
                  className="text-sm text-gray-400 hover:text-gray-700">
              {found.section.title}
            </Link>
          </>
        )}
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
