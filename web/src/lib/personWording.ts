/**
 * Как называть человека в событии — фронтовая копия словаря (миграция 304).
 *
 * ⚠️ Держать в синхроне с backend/app/services/person_wording.py: слово одно
 * на всё событие и обязано совпадать в кабинете, в боте и в рассылках. В
 * премии человек — «номинант», в турнире — «участник», на конференции —
 * «спикер».
 *
 * Неизвестное значение или пусто → «спикер» (поведение до миграции 304).
 */
export type PersonWording = {
  nom: string; gen: string; acc: string; dat: string; ins: string
  plural: string; plural_gen: string; plural_dat: string
  title: string; title_plural: string
}

const DICTS: Record<string, PersonWording> = {
  speaker: {
    nom: 'спикер', gen: 'спикера', acc: 'спикера', dat: 'спикеру', ins: 'спикером',
    plural: 'спикеры', plural_gen: 'спикеров', plural_dat: 'спикерам',
    title: 'Спикер', title_plural: 'Спикеры',
  },
  nominee: {
    nom: 'номинант', gen: 'номинанта', acc: 'номинанта', dat: 'номинанту', ins: 'номинантом',
    plural: 'номинанты', plural_gen: 'номинантов', plural_dat: 'номинантам',
    title: 'Номинант', title_plural: 'Номинанты',
  },
  member: {
    nom: 'участник', gen: 'участника', acc: 'участника', dat: 'участнику', ins: 'участником',
    plural: 'участники', plural_gen: 'участников', plural_dat: 'участникам',
    title: 'Участник', title_plural: 'Участники',
  },
}

export function personWording(preset?: string | null): PersonWording {
  return DICTS[(preset || '').trim().toLowerCase()] || DICTS.speaker
}
