import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import { setPlatform } from './platform'
import { initPlatform } from './platform/max'

// Точка входа MAX Mini App. SDK (`window.WebApp`) подключается тегом в
// index_max.html ДО этого бандла, поэтому к моменту initPlatform() объект
// уже доступен. API MAX почти идентичен Telegram WebApp — см. platform/max.ts.
//
// Если SDK не загрузился (открыли ссылку в обычном браузере) — адаптер сам
// падает в webFallback(), приложение остаётся работоспособным как веб-страница.
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
