import React from 'react'
import ReactDOM from 'react-dom/client'
import bridge from '@vkontakte/vk-bridge'
import App from './App'
import './styles/global.css'
import { setPlatform } from './platform'
import { initPlatform } from './platform/vk'

// VK Mini App присылает системные отступы (insets) — область под шапкой VK
// (кнопки «К списку», крестик, статус-бар). Без учёта наш заголовок уходит
// под них — это причина отказа модерации VK «кнопки перекрывают UI» (2026-07).
// Подписываемся на VKWebAppUpdateInsets и пишем top в CSS-переменную #root.
function applyVkInsets(insets: any) {
  const top = Number(insets?.top)
  if (Number.isFinite(top) && top >= 0) {
    document.documentElement.style.setProperty('--vk-inset-top', `${top}px`)
  }
}
bridge.subscribe((e: any) => {
  const t = e?.detail?.type
  if (t === 'VKWebAppUpdateInsets') applyVkInsets(e.detail.data?.insets)
  // При старте VK шлёт VKWebAppUpdateConfig с insets внутри.
  if (t === 'VKWebAppUpdateConfig' && e.detail.data?.insets) applyVkInsets(e.detail.data.insets)
})

// Точка входа VK Mini App: инициализируем VK Bridge до рендера App.
// VKWebAppInit + GetUserInfo асинхронные — поэтому top-level await.
(async () => {
  const adapter = await initPlatform()
  setPlatform(adapter)
  await adapter.ready()

  // Начальные insets (если VK уже прислал конфиг до подписки).
  try {
    const cfg: any = await bridge.send('VKWebAppGetConfig')
    if (cfg?.insets) applyVkInsets(cfg.insets)
  } catch (_) { /* не критично — придёт через UpdateInsets */ }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})()
