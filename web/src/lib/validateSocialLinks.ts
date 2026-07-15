// Соцсети коллаба/спикера указываются ТОЛЬКО полной ссылкой (https://…), не
// никнеймом. Ник (@name / name) не открывается из карточки в Mini App и ломает
// проверку подписки. Единая проверка для всех точек ввода: карточка коллаба,
// быстрое создание, карточка спикера конференции, кабинет спикера.

export type SocialField = [label: string, value: string | null | undefined]

/** Возвращает список подписей полей, где введён ник вместо полной ссылки. */
export function findBadSocialLinks(fields: SocialField[]): string[] {
  return fields
    .filter(([, v]) => {
      const s = (v || '').trim()
      if (!s) return false
      return !/^https?:\/\//i.test(s)
    })
    .map(([label]) => label)
}

/** Готовый текст ошибки для перечисленных полей. */
export function socialLinksError(bad: string[]): string {
  return (
    `Соцсети нужно указывать полной ссылкой, а не никнеймом. ` +
    `Исправьте: ${bad.join(', ')}. ` +
    `Например: https://telegram.me/username, https://vk.com/username, https://instagram.com/username`
  )
}

/**
 * Проверяет соцсети и, если есть ники вместо ссылок, возвращает текст ошибки;
 * иначе null. Одна строка на вызове: `const e = validateSocialLinks([...]); if (e) { setError(e); return }`
 */
export function validateSocialLinks(fields: SocialField[]): string | null {
  const bad = findBadSocialLinks(fields)
  return bad.length ? socialLinksError(bad) : null
}
