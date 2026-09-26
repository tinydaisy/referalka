'use client'
/**
 * Кнопки службы заботы на экране «спасибо» после отправки анкеты
 * (режим `support`, миграция 519).
 *
 * ⚠️ Один компонент на все места показа — страницу анкеты `/f/{slug}` и блок
 * анкеты на лендинге: экран после отправки должен выглядеть одинаково.
 * Mini App — отдельный пакет, там своя копия в TariffPicker.
 *
 * ⚠️ Кодовое слово подставляется в сообщение ТОЛЬКО в Telegram (ссылку с
 * `?text=` собирает сервер). ВКонтакте и MAX так не умеют — поэтому слово
 * всегда пишем текстом над кнопками.
 */
import { PlatformLogo, PLATFORM_COLORS } from '@/components/PlatformLogo'

export type SupportInfo = {
  keyword: string | null
  links: { platform: string; url: string }[]
} | null | undefined

const NAMES: Record<string, string> = { telegram: 'Telegram', vk: 'ВКонтакте', max: 'MAX' }

export default function SupportButtons({ support }: { support: SupportInfo }) {
  if (!support || !support.links?.length) return null
  return (
    <div className="mt-4">
      {support.keyword && (
        <p className="mb-3 text-sm">
          Напишите нам «<b>{support.keyword}</b>»:
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {support.links.map(l => (
          <a key={l.platform} href={l.url} target="_blank" rel="noreferrer"
             className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white"
             style={{ background: PLATFORM_COLORS[l.platform] || '#25455D' }}>
            <PlatformLogo slug={l.platform} size={18} color="#fff" />
            {NAMES[l.platform] || l.platform}
          </a>
        ))}
      </div>
    </div>
  )
}
