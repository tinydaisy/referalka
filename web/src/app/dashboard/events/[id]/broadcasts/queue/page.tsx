// Унифицированная страница: тот же компонент, что на /dashboard/conferences/[id]/broadcasts/queue.
// Один движок рассылок (см. memory/feedback_unified_event_features.md и
// memory/project_broadcasts_unified.md). useParams() сам берёт {id} из URL.
export { default } from '@/app/dashboard/conferences/[id]/broadcasts/queue/page'
