// Тонкая обёртка: карточка турнира — та же страница что у конференции.
// Компонент сам детектит pathname и подставляет basePath='/dashboard/tournaments'.
export { default } from '../../conferences/[id]/page'
