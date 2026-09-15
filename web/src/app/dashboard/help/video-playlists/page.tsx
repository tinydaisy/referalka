'use client'
import { useState, Suspense } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import Link from 'next/link'
import { BookOpen, Youtube, ExternalLink } from 'lucide-react'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

const YT_PLAYLIST = 'PLYceogy52n7c'
const YT_LINK = `https://youtube.com/playlist?list=${YT_PLAYLIST}`
const VK_PLAYLIST_LINK = 'https://vkvideo.ru/playlist/-212804884_2'

// Уроки первичной настройки. Порядок = порядок в плейлисте YouTube.
// videoId получены из плейлиста PLYceogy52n7c.
type Lesson = { step: number; title: string; yt: string; vk?: string }
const LESSONS: Lesson[] = [
  { step: 1, title: 'Регистрация в ПЛЮСОН и создание бота в телеграм', yt: 'zadOotz1Zp4' },
  { step: 2, title: 'Подключение телеграм-канала и информации о себе и своём проекте в Мини-апп', yt: 'L6u05lK0DEo' },
  { step: 3, title: 'Настройка воронки на выдачу лид-магнита и создание QR-кода на подарок для спикерства', yt: 'ciqinrlnT9U' },
  { step: 4, title: 'Как смотреть статистику заинтересованных Лид-магнитом', yt: 'bsmcUojMPXE' },
  { step: 5, title: 'Настройка закрытой группы под уведомления о всех заходящих лидах', yt: 'nyUQpm9mY-4' },
  { step: 6, title: 'Магия рассылок: пакетные рассылки + ИИ', yt: 'iFh2qMMYtVA', vk: '456239050' },
]

type TabKey = 'yt' | 'vk'


// ⚠️⚠️ ОБЯЗАТЕЛЬНАЯ ОБЁРТКА. У страницы нет динамического сегмента в адресе,
// поэтому Next пререндерит её на сборке. `useUrlTab` внутри читает адрес
// (`useSearchParams`), а такой хук на пререндеренной странице требует
// <Suspense> — без неё падает сборка ВСЕГО проекта:
// «useSearchParams() should be wrapped in a suspense boundary».
// ⚠️ `tsc` эту ошибку НЕ ловит — только сборка. Поймано 15.09.2026.
export default function VideoPlaylistsPage() {
  return (
    <Suspense fallback={null}>
      <VideoPlaylistsPageInner />
    </Suspense>
  )
}

function VideoPlaylistsPageInner() {
  const [tab, setTab] = useUrlTab<TabKey>('tab', 'yt')

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
            Вся первичная настройка платформы — по шагам, каждый шаг отдельным видео. Выберите площадку.
          </p>
        </div>
      </div>

      {/* Переключатель площадок */}
      <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-xl max-w-md">
        <button
          onClick={() => setTab('yt')}
          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
            tab === 'yt' ? 'bg-white text-[#25455D] shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <Youtube size={16} className="text-red-600" /> YouTube
        </button>
        <button
          onClick={() => setTab('vk')}
          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
            tab === 'vk' ? 'bg-white text-[#25455D] shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <span className="w-5 h-5 rounded flex items-center justify-center text-white text-[10px] font-bold" style={{ background: '#0077FF' }}>VK</span>
          ВКонтакте
        </button>
      </div>

      {/* Ссылка на весь плейлист */}
      <div className="flex justify-end mb-3">
        <a
          href={tab === 'yt' ? YT_LINK : VK_PLAYLIST_LINK}
          target="_blank" rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline flex items-center gap-1"
        >
          Открыть весь плейлист {tab === 'yt' ? 'на YouTube' : 'во ВКонтакте'} <ExternalLink size={12} />
        </a>
      </div>

      {/* YouTube — каждый урок отдельным плеером */}
      {tab === 'yt' && (
        <div className="space-y-4">
          {LESSONS.map((l) => (
            <div key={l.step} className="bg-white rounded-2xl border card-border p-4">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                     style={{ background: 'linear-gradient(135deg, #25455D, #0a1520)' }}>
                  {l.step}
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#c98a4b' }}>Шаг {l.step}</div>
                  <h2 className="text-sm font-bold leading-snug" style={{ color: BRAND }}>{l.title}</h2>
                </div>
              </div>
              <div className="relative w-full rounded-xl overflow-hidden bg-black" style={{ paddingTop: '56.25%' }}>
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${l.yt}`}
                  title={`Шаг ${l.step}: ${l.title}`}
                  className="absolute inset-0 w-full h-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ВКонтакте — один плеер всего плейлиста (VK не даёт встроить отдельные видео
          без прямых ссылок) + список шагов. Навигация по урокам — внутри плеера. */}
      {tab === 'vk' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border card-border p-5">
            <h2 className="text-base font-bold mb-3" style={{ color: BRAND }}>Уроки в плейлисте — по шагам</h2>
            <div className="space-y-2.5">
              {LESSONS.map((l) => (
                <div key={l.step} className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0"
                       style={{ background: 'linear-gradient(135deg, #25455D, #0a1520)' }}>
                    {l.step}
                  </div>
                  <div className="text-sm text-gray-700 leading-snug pt-0.5">{l.title}</div>
                </div>
              ))}
            </div>
            <a href={VK_PLAYLIST_LINK} target="_blank" rel="noopener noreferrer"
               className="inline-flex items-center gap-1.5 mt-4 px-3 py-2 rounded-lg text-white text-sm font-medium"
               style={{ background: '#0077FF' }}>
              Открыть весь плейлист во ВКонтакте <ExternalLink size={14} />
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
