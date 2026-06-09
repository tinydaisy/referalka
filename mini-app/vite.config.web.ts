import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Веб-витрина события: собирает index_web.html → dist-web/index.html.
// nginx раздаёт dist-web/ под путём /event/ (SPA-fallback: любой /event/{slug}
// и /event/{slug}#tab отдаёт тот же index.html, slug парсится на клиенте).
// base='/event/' — ассеты грузятся с /event/assets/... независимо от slug в пути.
//
// Запуск: `npm run build:web`
export default defineConfig({
  plugins: [react()],
  base: '/event/',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    rollupOptions: {
      input: 'index_web.html',
    },
  },
  server: { port: 5175, host: true },
})
