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

  // Логотип и название бренда КЛИЕНТА (не наши) — человек пришёл к нему,
  // а не в ПЛЮСОН. Нет логотипа → название текстом; нет и его → просто
  // ничего, экран остаётся рабочим.
  useEffect(() => {
    if (!clientId) return
    getClientProfile(clientId)
      .then((p: any) => {
        setBrand(p?.brand_name || p?.name || '')
        setLogo(p?.brand_logo_url || '')
      })
      .catch(() => { /* без шапки экран всё равно понятен */ })
  }, [clientId])

  const handleContinue = () => {
    markShown(vkUserId)
    onContinue()
  }

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
        background: 'var(--bg, #ffffff)',
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
          <div style={{ fontSize: 20, fontWeight: 700, color: '#25455D', letterSpacing: 0.3 }}>
            {brand}
          </div>
        ) : null}
      </div>

      <p style={{ fontSize: 16, lineHeight: 1.5, color: '#25455D', margin: '0 0 18px' }}>
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
              color: '#25455D',
              marginBottom: 10,
            }}
          >
            <span style={{
              flex: '0 0 auto',
              width: 6, height: 6, borderRadius: '50%',
              background: '#25455D', marginTop: 8,
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
