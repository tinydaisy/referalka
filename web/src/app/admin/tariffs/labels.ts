// Лейблы фич тарифов. Вынесено из page.tsx — Next.js App Router запрещает
// произвольные export'ы из page-файлов (можно только default + спец-поля).
// Импортируется в admin/tariffs/page.tsx и admin/tariffs/[id]/page.tsx.
export const FEATURE_LABELS: Record<string, string> = {
  lead_magnets:    'Лид-магниты',
  conference:      'Конференции',
  awards:          'Премии',
  channels:        'Свой бот',
  export_contacts: 'Экспорт контактов',
  collab_hub:      'Коллабораторная (Хаб)',
  contests:        'Участие в конкурсах',
}
