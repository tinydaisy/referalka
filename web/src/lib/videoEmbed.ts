/**
 * Ссылка на видео → адрес для встраивания плеером.
 *
 * ⚠️ Своё видео мы не храним (решение владельца): клиент даёт ссылку на
 * YouTube, VK Видео или Rutube, а страница встраивает плеер. Хранение
 * роликов — это гигабайты и отдельная раздача, а у клиента они и так лежат
 * на площадках.
 *
 * Вынесено из LandingRenderer, чтобы редактор материалов, кабинет купившего
 * и лендинг работали по одному правилу: разъедутся — видео будет
 * проигрываться на странице и не проигрываться в кабинете.
 */

/** Прямая ссылка на видеофайл — такое проигрывается тегом <video>, не iframe. */
export function isFileVideo(url: string): boolean {
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url || '')
}

/** YouTube, VK Видео, Rutube → embed-адрес. Незнакомое — возвращаем как есть. */
export function embedUrl(url: string): string {
  // ⚠️ `shorts/` — тоже YouTube: вертикальные ролики публикуют именно так,
  // и без этой ветки они не открывались вовсе (ссылка уходила в iframe как
  // есть, а YouTube такой адрес встраивать не разрешает).
  const yt = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/.exec(url)
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`
  const rt = /rutube\.ru\/video\/([\w]+)/.exec(url)
  if (rt) return `https://rutube.ru/play/embed/${rt[1]}`
  const vk = /vk\.com\/video(-?\d+)_(\d+)/.exec(url)
  if (vk) return `https://vk.com/video_ext.php?oid=${vk[1]}&id=${vk[2]}`
  return url
}

/** Узнаём площадку — для подписи и подсказок в редакторе. */
export function videoHost(url: string): string | null {
  if (/youtube\.com|youtu\.be/.test(url)) return 'YouTube'
  if (/rutube\.ru/.test(url)) return 'Rutube'
  if (/vk\.com|vkvideo\.ru/.test(url)) return 'VK Видео'
  return null
}
