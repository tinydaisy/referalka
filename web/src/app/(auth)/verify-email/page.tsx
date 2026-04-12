import Link from 'next/link'
import { Mail, RefreshCw } from 'lucide-react'

export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen gradient-bg flex items-center justify-center px-4">
      <div className="bg-white rounded-3xl shadow-2xl p-10 max-w-md w-full text-center">
        <div
          className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6"
          style={{ background: 'rgba(255,207,164,0.15)', border: '2px solid #FFCFA4' }}
        >
          <Mail size={36} style={{ color: '#FFCFA4' }} strokeWidth={1.5} />
        </div>

        <h1 className="text-2xl font-bold text-gray-900 mb-3">Проверьте почту</h1>
        <p className="text-gray-500 mb-6 leading-relaxed">
          Мы отправили ссылку подтверждения на вашу почту. Перейдите по ней, чтобы войти в кабинет.
        </p>

        <div className="p-4 bg-gray-50 rounded-xl mb-6">
          <p className="text-sm text-gray-600">
            Не получили письмо? Проверьте папку «Спам» или нажмите кнопку ниже.
          </p>
        </div>

        <button
          className="w-full py-3 rounded-xl border-2 text-sm font-medium flex items-center justify-center gap-2 hover:bg-gray-50 transition-colors mb-4"
          style={{ borderColor: '#25455D', color: '#25455D' }}
        >
          <RefreshCw size={16} />
          Отправить снова
        </button>

        <Link href="/login" className="block text-sm text-gray-400 hover:text-gray-600">
          Вернуться к входу
        </Link>
      </div>
    </div>
  )
}
