/** @type {import('next').NextConfig} */
const nextConfig = {
  // ⚠️ Сборка без простоя. Прод собирается ПРЯМО НА рабочем сервере, и пока
  // Next перезаписывает `.next`, сайт отдаёт ошибки. Поэтому собираем в
  // отдельный каталог (`NEXT_BUILD_DIR=.next-build npm run build`), затем
  // подменяем каталог и перезапускаем — простой равен одному рестарту.
  //
  // Без этой строки переменная НИЧЕГО не делает: Next читает только `distDir`,
  // и сборка молча идёт в `.next`. Ровно так уже был потерян рабочий каталог
  // (`mv .next .next-old` при пустом `.next-build`), и сайт держался лишь на
  // памяти процесса — любой рестарт положил бы его.
  distDir: process.env.NEXT_BUILD_DIR || '.next',
  images: {
    domains: ['localhost'],
  },
  productionBrowserSourceMaps: false,
  webpack: (config, { dev }) => {
    if (!dev) {
      config.devtool = false
    }
    return config
  },
}

module.exports = nextConfig
