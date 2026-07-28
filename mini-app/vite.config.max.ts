import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// MAX Mini App: собирает index_max.html → dist-max/. nginx раздаёт
// dist-max/ под путём /max/. ассеты получают base="/max/" → /max/assets/...
//
// ⚠️ В настройках бота MAX (business.max.ru → Чат-боты → Мини-приложение)
// указывается адрес С НОМЕРОМ КЛИЕНТА: https://pluson.ru/c/{client_id}/max/
// (напр. /c/1/max/ — кабинет Марго). nginx делает internal rewrite
// ^/c/\d+/(.*)$ → /$1, поэтому одна сборка обслуживает всех клиентов, а
// приложение узнаёт клиента из пути — ровно как у Telegram (/c/{N}/tg/).
//
// Запуск: `npm run build:max`
export default defineConfig({
  plugins: [react()],
  base: '/max/',
  build: {
    outDir: 'dist-max',
    emptyOutDir: true,
    rollupOptions: {
      input: 'index_max.html',
    },
  },
  server: { port: 5175, host: true },
})
