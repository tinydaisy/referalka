import { useEffect, useState } from 'react'
import { getClientProfile } from '../api'

/**
 * Экран-объяснение ПЕРЕД запросом разрешений ВКонтакте.
 *
 * ⚠️⚠️ ЗАЧЕМ ОН НУЖЕН — ТРЕБОВАНИЕ МОДЕРАЦИИ, А НЕ УКРАШЕНИЕ.
 * Пункт 1.1.2 правил Mini Apps (dev.vk.com/ru/mini-apps-rules): человека
 * обязаны предупредить ЗАРАНЕЕ, до окна «Разрешить?», как именно будут
 * использованы права. Раньше три окна ВКонтакте выскакивали сразу при
 * открытии, без единого слова от нас — модерация отклонила приложение с
 * формулировкой «сервис запрашивает довольно много прав» (18.06.2026).
 *
 * ⚠️ Права перечислены В ТОМ ЖЕ ПОРЯДКЕ, в каком их потом спрашивает
 * ВКонтакте (профиль → сообщения → подписка): человек читает сверху вниз
 * ровно то, что сейчас увидит. Меняете порядок вызовов — правьте и список.
 *
 * ⚠️ Показывается ОДИН РАЗ на устройство (localStorage по vk_user_id).
 * Спросить у ВКонтакте «уже разрешено?» до показа окна нельзя — такого
 * метода нет. А сами вызовы идут при КАЖДОМ открытии (ВКонтакте молча
 * отвечает, если право уже выдано) — без этой отметки экран всплывал бы
 * каждый раз и задерживал человека там, где окон уже не будет.
 *
 * ⚠️ Отступ сверху — переменная --vk-inset-top (её ставит main-vk.tsx по
 * VKWebAppUpdateInsets). Это второй пункт того же замечания модератора:
 * «функциональные кнопки перекрывают элементы UI». Фиксированное число
 * пикселей не годится — высота шапки разная на разных устройствах.
 */

const STORAGE_PREFIX = 'vk_perm_intro_'

/**
 * Тёмный ли фон? Нужно, чтобы выбрать цвет текста.
 *
 * ⚠️ Считаем по ПЕРВОМУ цвету градиента и по формуле яркости, а не «на глаз»:
 * у клиентов фон бывает и почти чёрным, и светло-бежевым, и тёмно-синий текст
 * на тёмном фоне сливается полностью — экран становится нечитаемым.
 */
function isDarkBg(bg: string): boolean {
  const m = bg.match(/#([0-9a-f]{6})/i)
  if (!m) return false
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  // Стандартная формула воспринимаемой яркости (0 — чёрный, 255 — белый).
  return (0.299 * r + 0.587 * g + 0.114 * b) < 140
}

/** Показывали ли уже этому человеку экран на этом устройстве. */
export function vkIntroWasShown(vkUserId: string | number): boolean {
  if (!vkUserId) return false
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${vkUserId}`) === '1'
  } catch {
    // Приватный режим / запрет хранилища — не повод ломать вход.
    // Покажем экран лишний раз, это безопаснее пустого окна.
    return false
  }
}

function markShown(vkUserId: string | number) {
  try { localStorage.setItem(`${STORAGE_PREFIX}${vkUserId}`, '1') } catch { /* см. выше */ }
}

export default function VkPermissionsIntro({
  vkUserId,
  clientId,
  onContinue,
}: {
  vkUserId: string | number
  clientId: number | null
  onContinue: () => void
}) {
  const [brand, setBrand] = useState<string>('')
  const [logo, setLogo] = useState<string>('')
  // Фирменный фон клиента. ⚠️ Экран показывается ДО загрузки события, поэтому
  // общий светлый фон приложения тут не годится: у клиента с тёмной темой
  // первый экран выглядел чужой страницей. Цвета берём из его же профиля.
  const [bg, setBg] = useState<string>('')

  // Логотип и название бренда КЛИЕНТА (не наши) — человек пришёл к нему,
  // а не в ПЛЮСОН. Нет логотипа → название текстом; нет и его → просто
  // ничего, экран остаётся рабочим.
  useEffect(() => {
    if (!clientId) return
    getClientProfile(clientId)
      .then((p: any) => {
        setBrand(p?.brand_name || p?.name || '')
        setLogo(p?.brand_logo_url || '')
        const c1 = p?.lp_bg_color
        const c2 = p?.lp_bg_color_2
        // Второй цвет не задан — заливаем первым, без градиента.
        if (c1) setBg(c2 ? `linear-gradient(${p?.lp_bg_angle ?? 45}deg, ${c1}, ${c2})` : c1)
      })
      .catch(() => { /* без шапки экран всё равно понятен */ })
  }, [clientId])

  const handleContinue = () => {
    markShown(vkUserId)
    onContinue()
  }

  // Тёмный фон → белый текст, светлый → фирменный тёмно-синий.
  const fg = isDarkBg(bg) ? '#ffffff' : '#25455D'

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        // ⚠️ Содержимое прижато к НИЗУ (justifyContent: flex-end): сверху
        // остаётся свободное поле, куда ВКонтакте кладёт крестик и «…».
        justifyContent: 'flex-end',
        padding: '0 24px 40px',
        boxSizing: 'border-box',
        // Фирменный фон клиента, пока не загрузился — общий фон приложения.
        background: bg || 'var(--bg, #ffffff)',
        fontFamily: 'Roboto, sans-serif',
      }}
    >
      <div style={{ marginBottom: 28, textAlign: 'center', minHeight: 56 }}>
        {logo ? (
          <img
            src={logo}
            alt=""
            style={{ maxWidth: 160, maxHeight: 56, width: 'auto', height: 'auto', objectFit: 'contain' }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : brand ? (
          <div style={{ fontSize: 20, fontWeight: 700, color: fg, letterSpacing: 0.3 }}>
            {brand}
          </div>
        ) : null}
      </div>

      <p style={{ fontSize: 16, lineHeight: 1.5, color: fg, margin: '0 0 18px' }}>
        Чтобы регистрироваться на события, получать напоминания или подарки — разрешите:
      </p>

      <ul style={{ margin: '0 0 32px', padding: 0, listStyle: 'none' }}>
        {['доступ к имени и фото', 'отправку вам сообщений', 'подписку на сообщество'].map(item => (
          <li
            key={item}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              fontSize: 15,
              lineHeight: 1.45,
              color: fg,
              marginBottom: 10,
            }}
          >
            <span style={{
              flex: '0 0 auto',
              width: 6, height: 6, borderRadius: '50%',
              background: fg, marginTop: 8,
            }} />
            <span>{item}</span>
          </li>
        ))}
      </ul>

      {/* ⚠️ Оба класса: .btn — размеры и поведение, .btn-gold — фирменный цвет.
          Свой style={{background}} тут нельзя (правило проекта). */}
      <button onClick={handleContinue} className="btn btn-gold">
        Продолжить
      </button>
    </div>
  )
}
