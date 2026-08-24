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

/**
 * ⚠️⚠️ ЭКРАН РИСУЕТСЯ ВСЕГДА, ЧЕМ БЫ НИ КОНЧИЛСЯ ЗАПУСК.
 *
 * Раньше отрисовка стояла ПОСЛЕ цепочки запросов к ВКонтакте. Любой из них,
 * не ответив, останавливал всё: человек видел ЗАСТЫВШИЙ ЛОГОТИП и ничего
 * больше. Так ВКонтакте не открывался у всех клиентов две-три недели.
 *
 * Опаснее всего был запрос данных профиля: он показывает окно «разрешить
 * доступ», и пока человек не нажал, ответа НЕ ПРИХОДИТ ВОВСЕ — ни да, ни
 * ошибки. Не появилось окно (медленная сеть, встроенный браузер) — вечное
 * ожидание, которое даже не считается ошибкой.
 *
 * Теперь: что успели узнать за отведённое время — используем, не успели —
 * открываем как есть. Пустой экран хуже экрана без фотографии.
 */
let rendered = false

/** Нарисовать экран. ⚠️ Ровно один раз: и обычный путь, и страховка ниже
 *  зовут именно её, иначе React смонтирует приложение дважды. */
function renderApp() {
  if (rendered) return
  rendered = true
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

async function start() {
  try {
    const adapter = await initPlatform()
    setPlatform(adapter)
    await adapter.ready()
  } catch (e) {
    // ⚠️ Даже если запуск сорвался целиком — рисуем. Приложение умеет работать
    // без данных площадки: человек хотя бы увидит события и сможет открыть их.
    console.error('Запуск ВКонтакте сорвался — открываем как есть', e)
  }

  // Отступы под шапку ВКонтакте. ⚠️ Отрисовку НЕ блокируют: не ответил —
  // подтянутся через подписку выше, а экран уже на месте.
  bridge.send('VKWebAppGetConfig')
    .then((cfg: any) => { if (cfg?.insets) applyVkInsets(cfg.insets) })
    .catch(() => { /* придёт через VKWebAppUpdateConfig */ })

  renderApp()
}

// ⚠️ Страховка на крайний случай: что бы ни случилось внутри start(), через
// 6 секунд экран обязан быть на месте. Пустое окно недопустимо.
setTimeout(() => {
  if (!rendered) {
    console.warn('ВКонтакте не ответил за 6 секунд — открываем экран без него')
    renderApp()
  }
}, 6000)

start()
