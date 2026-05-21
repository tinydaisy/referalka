// Тонкая обёртка: список турниров — это та же страница что у конференций.
// Компонент сам детектит pathname и подставляет module_slug='turnir', UI-лейблы и
// иконку Trophy вместо Mic. См. ../conferences/page.tsx.
export { default } from '../conferences/page'
