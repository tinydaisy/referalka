'use client'

/**
 * «Автонастройка и готовые решения» — раздел в Тех.поддержке, над Инструкциями.
 *
 * ⚠️ Оба блока раньше жили подвкладками в «Каналах» и там терялись: человек
 * заходил туда подключать бота, а не искать помощь с настройкой. По смыслу это
 * именно поддержка — «сделайте за меня» и «возьмите готовый сценарий», поэтому
 * они переехали к инструкциям (решение владельца 12.09.2026).
 *
 * ⚠️ Компоненты переиспользуются КАК ЕСТЬ (`AutoSetupTab`, `SolutionsTab`) —
 * своих копий здесь нет и быть не должно: разъедутся при первой же правке.
 * В «Каналах» они больше не показываются, чтобы раздел не жил в двух местах.
 */

import { useState } from 'react'
import { Wand2, Sparkles } from 'lucide-react'
import AutoSetupTab from '@/components/channels/AutoSetupTab'
import SolutionsTab from '@/components/solutions/SolutionsTab'
import { useMe } from '@/hooks/useMe'

const DARK = '#25455D'

export default function AutoSetupPage() {
  const { me } = useMe()
  // ⚠️ «Готовые решения» пока обкатываются — раздел скрыт без фичи, а не
  // показан с замком: клиентам он ещё не продаётся, дразнить незачем.
  const hasSolutions = (me?.features || []).includes('ready_solutions')
  // Вкладку можно открыть по адресу `?tab=solutions` — на неё ведут страницы
  // описаний решений.
  // ⚠️ Читаем `window.location.search`, а НЕ `useSearchParams`: у страницы нет
  // динамического сегмента, поэтому Next пререндерит её на сборке, и хук без
  // <Suspense> роняет сборку ВСЕГО проекта («useSearchParams() should be
  // wrapped in a suspense boundary»). `tsc` этого не ловит — только сборка.
  const [tab, setTab] = useState<'autosetup' | 'solutions'>(() => {
    if (typeof window === 'undefined') return 'autosetup'
    return new URLSearchParams(window.location.search).get('tab') === 'solutions'
      ? 'solutions' : 'autosetup'
  })

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1" style={{ color: DARK }}>
        Автонастройка и готовые решения
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Настроим Telegram за вас — или возьмите готовый сценарий и включите его в пару нажатий.
      </p>

      <div className="flex gap-2 mb-6 border-b border-gray-200">
        <TabBtn active={tab === 'autosetup'} onClick={() => setTab('autosetup')}>
          <Wand2 size={15} /> Автонастройка
        </TabBtn>
        {hasSolutions && (
          <TabBtn active={tab === 'solutions'} onClick={() => setTab('solutions')}>
            <Sparkles size={15} /> Готовые решения (beta)
          </TabBtn>
        )}
      </div>

      {tab === 'autosetup' && <AutoSetupTab />}
      {tab === 'solutions' && hasSolutions && <SolutionsTab />}
    </div>
  )
}

function TabBtn({ active, onClick, children }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-current'
          : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
      style={active ? { color: DARK } : undefined}
    >
      {children}
    </button>
  )
}
