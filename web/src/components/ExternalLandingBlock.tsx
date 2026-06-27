'use client'
import { Globe } from 'lucide-react'

interface Props {
  slug?: string | null
  value: string
  onChange: (v: string) => void
}

// Возврат после регистрации на стороннем лендинге — теперь по-платформенно.
// Клиент копирует ту ссылку, через которую привлекает участников:
//   TG  → t.me/{bot}/pluson?startapp=ref_pg{slug}_reg
//         (для VIP — свой бот, для остальных — @pluson_bot; в обоих случаях
//          short-name «pluson» уникален per-бот). Промежуточная страница
//          /r/{slug} больше как универсал не нужна — её можно оставить как
//          legacy fallback, но в UI выводим прямые ссылки на платформу.
//   VK  → vk.com/app{vk_app_id}#ref_pg{slug}_reg
//         (только если у клиента подключено собственное VK-сообщество с
//          Mini App — системный VK ПЛЮСОНа для чужих клиентов не используется).
//   MAX → max.ru/{handle}?startapp=ref_pg{slug}_reg
//         (только если у клиента свой MAX-бот).
//
// Mini App при загрузке парсит `ref_pg{slug}_reg` → ставит is_registered=true и
// открывает «Интро» (welcomed_at IS NULL). Идентично потоку TG, что был раньше.
export default function ExternalLandingBlock({ value, onChange }: Props) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <Globe size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-800">
          Подключение стороннего лендинга
        </h3>
      </div>
      <p className="text-xs text-gray-500 mb-3 leading-relaxed">
        Если у вас уже есть лендинг события на Tilda, GetCourse, Taplink или
        другом конструкторе — вставьте сюда его адрес. Mini App будет
        открывать ваш лендинг для участников вместо встроенной страницы.
      </p>

      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        URL вашего лендинга
      </label>
      <input
        type="url"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="https://yoursite.com/event"
        className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
      />

    </div>
  )
}
