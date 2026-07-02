"""
Резолвер реф-кодов реферальной программы ПЛЮСОНа.

Единая точка, которая по входящему коду определяет, за каким КЛИЕНТОМ ПЛЮСОНа
закрепить нового клиента (`clients.referred_by_client_id`).

Зачем отдельный сервис. В системе сосуществуют ДВА независимых типа реф-кодов:

  1. `clients.referral_code` — код клиента ПЛЮСОНа (реф-программа самого ПЛЮСОНа:
     «этот клиент привёл нового клиента»).
  2. `contacts.ref_code` — код контакта внутри базы клиента (реф-программа
     события: «этот человек привёл кого-то ко мне»). Глобально уникален
     (constraint `contacts_ref_code_key` на одном столбце).

Это РАЗНЫЕ коды у одного человека. Пример: Элла Тот как контакт Марго имеет
`ref_code=FH4LX9A6`, а как клиент ПЛЮСОНа — `referral_code=mrszq4xj`.

Сценарий, ради которого написан резолвер. Спикер Маша прорекламила событие
клиента → Вася пришёл по её реф-ссылке события → его реферер записан как
`event_participants.referrer_ref_code` = код-КОНТАКТ Маши. Вася берёт «ПЛЮСОН»
как подарок и регистрируется клиентом ПЛЮСОНа. Надо закрепить его за Машей в
реф-программе ПЛЮСОНа. Но `/register` принимает только `clients.referral_code`,
а у нас на руках код-контакт. Резолвер строит мост:

    код-контакт Маши
      → contacts.id
        → collaborators.linked_client_id   (Маша привязала свой ПЛЮСОН-аккаунт
                                             к карточке спикера попапом-логином)
          → это и есть client_id Маши как клиента ПЛЮСОНа

Поэтому в ссылку-подарок можно класть ОБЫЧНЫЙ pid рефовода (код-контакт), а
резолвер сам поймёт, клиентский это код или код-контакта-спикера, и вернёт
нужного клиента. Никакой подмены кода на стороне подарка — любой сервис умеет
резолвить коды ПЛЮСОНа единообразно через эту функцию.
"""
from typing import Optional

import asyncpg


async def resolve_plusson_referrer(
    db: asyncpg.Connection, code: Optional[str]
) -> Optional[int]:
    """
    По входящему коду вернуть `client_id`, за которым закрепить нового клиента
    ПЛЮСОНа, либо None если закреплять не за кем.

    Порядок поиска:
      1. code == clients.referral_code            → это уже клиентский код,
                                                     вернуть его client_id.
      2. code == contacts.ref_code (глоб. уник.)  → это код-контакт;
         или в contacts.merged_ref_codes            если у контакта есть привязка
                                                     collaborators.linked_client_id
                                                     (контакт-спикер привязал свой
                                                     ПЛЮСОН) — вернуть этот client_id.
      3. иначе                                    → None (рефовод не является
                                                     клиентом ПЛЮСОНа / кода нет).
    """
    if not code:
        return None
    code = code.strip()
    if not code:
        return None

    # 1) Уже клиентский код ПЛЮСОНа?
    client_id = await db.fetchval(
        "SELECT id FROM clients WHERE referral_code = $1", code
    )
    if client_id:
        return client_id

    # 2) Код-контакт (глобально уникален) → его привязка к клиенту ПЛЮСОНа.
    #    Приоритет: contacts.linked_client_id (любой участник связал свой ПЛЮСОН,
    #    миграция 191), затем fallback на collaborators.linked_client_id (спикер).
    #    Прямое совпадение по ref_code + fallback на merged_ref_codes (старые коды
    #    после ручного мерджа контактов — чтобы старые ссылки жили).
    linked = await db.fetchval(
        """
        SELECT COALESCE(c.linked_client_id, col.linked_client_id)
          FROM contacts c
          LEFT JOIN collaborators col ON col.contact_id = c.id
         WHERE (c.ref_code = $1 OR c.merged_ref_codes ? $1)
           AND COALESCE(c.linked_client_id, col.linked_client_id) IS NOT NULL
         LIMIT 1
        """,
        code,
    )
    return linked  # int или None
