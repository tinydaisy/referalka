import Sidebar from './Sidebar'
import NavigationProgress from './NavigationProgress'
import SubscriptionBadge from './SubscriptionBadge'
import SubscriptionBanner from './SubscriptionBanner'
import EmailVerifyBanner from './EmailVerifyBanner'
import BrokenBotsBanner from './BrokenBotsBanner'
import ContactLimitBanner from './ContactLimitBanner'
import NewsBanner from './NewsBanner'
import NewsBell from './NewsBell'
import FrozenContent from './FrozenContent'
import { LangProvider } from '@/contexts/LangContext'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <LangProvider>
      <NavigationProgress />
      <div className="flex min-h-screen bg-gray-50">
        <Sidebar />
        <main className="flex-1 lg:ml-60 min-w-0">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pt-16 lg:pt-8">
            <div className="flex justify-end items-center gap-1 mb-4">
              <SubscriptionBadge />
              <NewsBell />
            </div>
            {/* ⚠️ Новости — ПОСЛЕДНЕЙ плашкой. Выше идёт то, что у клиента
                сломано или требует действия; новость подождёт. */}
            <SubscriptionBanner />
            <EmailVerifyBanner />
            <BrokenBotsBanner />
            <ContactLimitBanner />
            <NewsBanner />
            <FrozenContent>{children}</FrozenContent>
          </div>
        </main>
      </div>
    </LangProvider>
  )
}
