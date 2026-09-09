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
import { BRAND_NAME, BRAND_TAGLINE, BRAND_HEADLINE, BRAND_FEATURES } from '@/lib/brand'

const PEACH = '#FFCFA4'

export default function AuthAside() {
  return (
    <div className="hidden lg:flex lg:w-1/2 gradient-bg flex-col justify-center px-16 py-12">
      <div className="mb-8">
        <div className="flex items-center gap-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/logo_no_ivision_wwhite.png" alt={BRAND_NAME}
            className="auth-logo shrink-0"
            width={110} height={90} />
          <div>
            <div className="text-2xl font-bold leading-tight" style={{ color: PEACH }}>
              {BRAND_NAME}
            </div>
            {/* ⚠️ Без ручного <br />: подзаголовок стал длиннее и жёсткий перенос
                рвал его не по смыслу. Ширину держит max-w. */}
            <p className="text-white/70 text-sm mt-1 leading-snug max-w-md">
              {BRAND_TAGLINE}
            </p>
          </div>
        </div>

        {/* ⚠️ Перенос — по ширине колонки, а не вручную: лозунг живёт в одном
            месте (lib/brand.ts) и не должен нести в себе вёрстку. */}
        <h1 className="text-white text-3xl font-bold mt-8 leading-tight">
          {BRAND_HEADLINE}
        </h1>
      </div>

      <div className="space-y-4">
        {BRAND_FEATURES.map(item => (
          <div key={item} className="flex items-start gap-3">
            <CheckCircle className="shrink-0 mt-0.5" size={20} style={{ color: PEACH }} />
            <span className="text-white/90 leading-snug">{item}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
