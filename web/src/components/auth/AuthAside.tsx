/**
 * Левая колонка страниц входа и регистрации.
 *
 * ⚠️ Общий компонент, а не копия на каждой странице: раньше на входе висело
 * «С возвращением», а на регистрации — лозунг с возможностями, и человек,
 * которого разлогинило, видел совсем другой текст. Две копии неминуемо
 * расходятся.
 *
 * ⚠️ Название СПРАВА от логотипа, а не бледной строкой над ним: так это бренд,
 * а не подпись к картинке.
 */
import { CheckCircle } from 'lucide-react'

const PEACH = '#FFCFA4'

/**
 * ⚠️ Коротко, без перечня после двоеточия. Раньше каждый пункт был строкой
 * на всю ширину с шестью запятыми — экран превращался в сплошной текст,
 * который не читают. Подробности человек увидит на лендинге и в тарифах.
 *
 * ⚠️ «Отдельными модулями» оставлено — они докупаются, и человек не должен
 * решить, что всё включено.
 */
const FEATURES = [
  'Упаковаться, привлечь и продать — в одном месте',
  'Лендинги, эфиры, лид-магниты, готовые воронки в ТГ, ВК и МАХ',
  'Рост без вложений в рекламу — обмен аудиторией',
  'Авторские события: конференции, премии, турниры — отдельными модулями',
]

export default function AuthAside() {
  return (
    <div className="hidden lg:flex lg:w-1/2 gradient-bg flex-col justify-center px-16 py-12">
      <div className="mb-8">
        <div className="flex items-center gap-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/logo_no_ivision_wwhite.png" alt="iViSiON: ПЛЮСОН"
            className="auth-logo shrink-0"
            width={110} height={90} />
          <div>
            <div className="text-2xl font-bold leading-tight" style={{ color: PEACH }}>
              iViSiON: ПЛЮСОН
            </div>
            <p className="text-white/70 text-sm mt-1 leading-snug">
              Платформа для экспертов,<br />спикеров и организаторов
            </p>
          </div>
        </div>

        {/* Лозунг в ДВЕ строки: тремя он занимал пол-экрана и спорил
            с логотипом за внимание. */}
        <h1 className="text-white text-3xl font-bold mt-8 leading-tight">
          Всё, что вы попросили бы для привлечения<br />клиентов у технаря. Только без технаря.
        </h1>
      </div>

      <div className="space-y-4">
        {FEATURES.map(item => (
          <div key={item} className="flex items-start gap-3">
            <CheckCircle className="shrink-0 mt-0.5" size={20} style={{ color: PEACH }} />
            <span className="text-white/90 leading-snug">{item}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
