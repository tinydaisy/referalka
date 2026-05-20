import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import { setPlatform } from './platform'
import { initPlatform } from './platform/vk'

// Точка входа VK Mini App: инициализируем VK Bridge до рендера App.
// VKWebAppInit + GetUserInfo асинхронные — поэтому top-level await.
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
