// Тонкая обёртка: карточка спикера премии/турнира — та же страница что у
// конференции. Компонент сам детектит pathname и подставляет
// basePath='/dashboard/tournaments' (сайдбар и «назад» остаются в Премиях).
export { default } from '../../../../conferences/[id]/speakers/[speakerId]/page'
