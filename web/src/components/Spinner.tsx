/**
 * Spinner — индикатор загрузки.
 * Стиль задан в globals.css (.spinner), правь там для изменения на всём сайте.
 */
export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`spinner ${className}`} aria-label="Загрузка..." />
}
