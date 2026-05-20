import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import { setPlatform } from './platform'
import { initPlatform } from './platform/telegram'

// Точка входа Telegram Mini App: инициализируем TG-адаптер до рендера App,
// чтобы getPlatform() работал из api/ChatGate/EventPage синхронно.
(async () => {
  const adapter = await initPlatform()
  setPlatform(adapter)
  await adapter.ready()

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})()
