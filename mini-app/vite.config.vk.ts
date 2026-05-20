import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// VK Mini App: собирает index_vk.html → dist-vk/. nginx раздаёт
// dist-vk/ под путём /vk/. ассеты получают base="/vk/" → /vk/assets/...
//
// Запуск: `npm run build:vk`
export default defineConfig({
  plugins: [react()],
  base: '/vk/',
  build: {
    outDir: 'dist-vk',
    emptyOutDir: true,
    rollupOptions: {
      input: 'index_vk.html',
    },
  },
  server: { port: 5174, host: true },
})
