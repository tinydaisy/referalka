import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Telegram Mini App: собирает index_tg.html → dist/index.html (через
// post-build rename в package.json). nginx раздаёт dist/ под путём /tg/.
// ассеты получают base="/tg/" → /tg/assets/...
//
// outDir=dist намеренно: nginx на проде уже указывает сюда, не надо менять.
// Запуск: `npm run build:tg`
export default defineConfig({
  plugins: [react()],
  base: '/tg/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'index_tg.html',
    },
  },
  server: { port: 5173, host: true },
})
