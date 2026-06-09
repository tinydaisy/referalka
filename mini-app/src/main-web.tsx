import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import './styles/web.css'
import { setPlatform } from './platform'
import { initPlatform } from './platform/web'

// Точка входа веб-витрины (pluson.ru/event/{slug}). Тот же App, что в Mini App,
// но через web-адаптер: данные по slug, идентификация по contact_id из query,
// вкладки по #hash. Узкая центральная колонка задаётся в styles/web.css.
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
