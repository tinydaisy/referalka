'use client'
import Link from 'next/link'
import { BookOpen, Youtube, ExternalLink } from 'lucide-react'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

// Плейлисты видео-инструкций по первичной настройке ПЛЮСОН.
const YT_PLAYLIST = 'PLYceogy52n7c'
// listType=playlist + list — надёжно грузит ВЕСЬ плейлист с боковой навигацией.
// (videoseries?list= у Google часто показывает только первое видео.)
const YT_EMBED = `https://www.youtube-nocookie.com/embed/?listType=playlist&list=${YT_PLAYLIST}`
const YT_LINK = `https://youtube.com/playlist?list=${YT_PLAYLIST}`

// VK: видео 456239050 из плейлиста -212804884_2 сообщества 212804884.
// &list=… подключает плейлист (навигация по видео внутри плеера).
const VK_EMBED = 'https://vkvideo.ru/video_ext.php?oid=-212804884&id=456239050&hd=2&list=-212804884_2'
const VK_LINK = 'https://vkvideo.ru/video-212804884_456239050?pl=-212804884_2'

const STEPS = [
  'Регистрация в ПЛЮСОН и создание бота в телеграм',
  'Подключение телеграм-канала и информации о себе и своём проекте в Мини-апп',
  'Настройка воронки на выдачу лид-магнита и создание QR-кода на подарок для спикерства',
  'Как смотреть статистику заинтересованных Лид-магнитом',
  'Настройка закрытой группы под уведомления о всех заходящих лидах',
  'Магия рассылок: пакетные рассылки + ИИ',
]

export default function VideoPlaylistsPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Плейлисты с видео-инструкциями</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Плейлисты с видео-инструкциями</h1>
          <p className="text-sm text-gray-500 mt-1">
            Вся первичная настройка платформы по шагам — в коротких видео. Смотрите прямо здесь или откройте плейлист целиком на YouTube / ВКонтакте.
          </p>
        </div>
      </div>

      {/* YouTube-плейлист */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 mb-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 font-bold" style={{ color: BRAND }}>
            <Youtube size={20} className="text-red-600" /> Плейлист на YouTube
          </div>
          <a href={YT_LINK} target="_blank" rel="noopener noreferrer"
             className="text-xs text-blue-600 hover:underline flex items-center gap-1 flex-shrink-0">
            Открыть на YouTube <ExternalLink size={12} />
          </a>
        </div>
        <div className="relative w-full rounded-xl overflow-hidden bg-black" style={{ paddingTop: '56.25%' }}>
          <iframe
            src={YT_EMBED}
            title="Видео-инструкции ПЛЮСОН (YouTube)"
            className="absolute inset-0 w-full h-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      </div>

      {/* VK-плейлист */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 mb-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 font-bold" style={{ color: BRAND }}>
            <span className="w-5 h-5 rounded flex items-center justify-center text-white text-xs font-bold" style={{ background: '#0077FF' }}>VK</span>
            Плейлист во ВКонтакте
          </div>
          <a href={VK_LINK} target="_blank" rel="noopener noreferrer"
             className="text-xs text-blue-600 hover:underline flex items-center gap-1 flex-shrink-0">
            Открыть во ВКонтакте <ExternalLink size={12} />
          </a>
        </div>
        <div className="relative w-full rounded-xl overflow-hidden bg-black" style={{ paddingTop: '56.25%' }}>
          <iframe
            src={VK_EMBED}
            title="Видео-инструкции ПЛЮСОН (ВКонтакте)"
            className="absolute inset-0 w-full h-full"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture; screen-wake-lock;"
            allowFullScreen
            frameBorder="0"
          />
        </div>
      </div>

      {/* Что в плейлистах — по шагам */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <h2 className="text-base font-bold mb-3" style={{ color: BRAND }}>Что внутри — по шагам</h2>
        <div className="space-y-2.5">
          {STEPS.map((text, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                   style={{ background: 'linear-gradient(135deg, #25455D, #0a1520)' }}>
                {i + 1}
              </div>
              <div className="text-sm text-gray-700 leading-snug pt-0.5">{text}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-4">
          Все материалы разложены по шагам в обоих плейлистах — смотрите в удобном порядке.
        </p>
      </div>
    </div>
  )
}
