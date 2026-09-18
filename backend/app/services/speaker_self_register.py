"""
Самостоятельная регистрация спикером события (2026-05-29).

Сценарий:
1. Клиент во вкладке «Спикеры» события копирует прямую ссылку
   `t.me/{bot}?start=spkreg_{event_id}` (или VK / MAX аналог).
2. Человек переходит → попадает в бот → стандартный upsert contact +
   platform_user.
3. Бот шлёт фикс. текст + inline-кнопку «Добавиться в спикеры»
   (callback `spkreg_confirm_{event_id}`).
4. На callback: создаётся `collaborator` (если ещё нет) + запись в
   `event_collaborators` (если ещё нет, role='speaker' + автодефолты
   show_*). Бот шлёт `t.me/{bot}?start=spkinv_<access_code>` — это уже
   стандартный путь самообслуживания (миграция 108).

Без модерации в MVP. Клиент может удалить спикера руками если не нужен.
"""
import logging
from typing import Optional, Tuple
import asyncpg

from app.api.collaborators import _generate_unique_access_code
from app.services.person_wording import wording

logger = logging.getLogger(__name__)


def self_reg_text(person_wording: Optional[str] = None) -> str:
    """Первое сообщение по ссылке саморегистрации.

    ⚠️ Слово («спикер» / «номинант» / «участник») берётся из
    `events.person_wording` — захардкоженного «спикера» здесь быть не должно:
    в премии человек называется номинантом, и текст обязан совпадать с тем,
    что он видит в кабинете и в рассылках.
    """
    w = wording(person_wording)
    return (
        f"Вы находитесь в агенте по оформлению вас {w['ins']}. "
        f"Чтобы добавиться в состав {w['plural_gen']} — нажмите кнопку ниже."
    )


def self_reg_button(person_wording: Optional[str] = None) -> str:
    return f"Включить в {wording(person_wording)['plural']}"


async def self_pick_nominations_hint(db, event_id: int) -> str:
    """Приписка «А также выберите номинации…» — ТОЛЬКО когда организатор
    открыл самовыбор (`conf_conferences.self_pick_stages_speakers`, мигр. 328).

    ⚠️ Галочка снята → строки нет вовсе: звать человека выбирать номинации
    там, где выбора ему не дали, значит отправить его искать в кабинете блок,
    которого он не увидит.

    Смотрим именно speakers-галочку: саморегистрация всегда заводит карточку
    с `role='speaker'` (жюри приглашают, а не записываются сами).
    """
    try:
        allowed = await db.fetchval(
            "SELECT self_pick_stages_speakers FROM conf_conferences WHERE event_id = $1",
            event_id,
        )
    except Exception:
        return ""
    if not allowed:
        return ""
    return "\n\nА также выберите номинации, в которых хотите принять участие."


async def get_event_for_self_register(
    db: asyncpg.Connection, event_id: int,
) -> Optional[dict]:
    """Узнаёт client_id и slug события. Без проверок видимости/статуса —
    клиент сам делится ссылкой, если событие не публикуется, спикер всё
    равно может зарегистрироваться."""
    # person_wording отдаётся тем же запросом — иначе каждая точка отправки
    # ходила бы за словом в БД отдельно (или, что хуже, писала «спикер»).
    row = await db.fetchrow(
        "SELECT id, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=events.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id, slug, title, person_wording FROM events WHERE id = $1",
        event_id,
    )
    return dict(row) if row else None


async def find_existing_speaker(
    db: asyncpg.Connection,
    *,
    event_id: int,
    client_id: int,
    contact_id: int,
) -> Optional[dict]:
    """Если контакт уже добавлен в спикеры этого события — возвращаем
    `{collaborator_id, access_code, event_slug, name}` для редиректа в
    кабинет. Иначе None — сценарий саморегистрации."""
    row = await db.fetchrow(
        """SELECT c.id AS collaborator_id, c.access_code, c.name,
                  e.slug AS event_slug
             FROM collaborators c
             JOIN event_collaborators ec ON ec.speaker_id = c.id
             JOIN events e ON e.id = ec.event_id
            WHERE c.contact_id = $1 AND ec.event_id = $2 AND EXISTS(SELECT 1 FROM event_owners eo WHERE eo.event_id=e.id AND eo.client_id=$3 AND eo.status='accepted')
            LIMIT 1""",
        contact_id, event_id, client_id,
    )
    return dict(row) if row else None


async def complete_speaker_self_register(
    db: asyncpg.Connection,
    *,
    event_id: int,
    client_id: int,
    contact_id: int,
    contact_name: str,
) -> Tuple[int, str, str, bool]:
    """Создаёт коллаба (если ещё нет) и привязывает к событию.

    Возвращает (collaborator_id, access_code, event_slug, was_already_speaker).
    `was_already_speaker=True` если у contact уже была запись
    `event_collaborators` для этого события — тогда повтор не создаём, но
    возвращаем те же данные (access_code позволит спикеру повторно войти).
    """
    ev_row = await db.fetchrow(
        "SELECT slug, person_wording FROM events WHERE id = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
        event_id, client_id,
    )
    if not ev_row:
        raise ValueError("Событие не найдено или не принадлежит клиенту")
    event_slug = ev_row["slug"]
    # Запасное имя карточки: у премии — «Номинант», а не «Спикер».
    fallback_name = wording(ev_row["person_wording"])["title"]

    # Найти или создать коллаба
    coll_row = await db.fetchrow(
        "SELECT id, access_code FROM collaborators WHERE contact_id = $1",
        contact_id,
    )
    if coll_row:
        collaborator_id = coll_row["id"]
        access_code = coll_row["access_code"]
    else:
        access_code = await _generate_unique_access_code(db)
        # Имя из contacts.name (бот upsert'нул имя из TG/VK при /start).
        collaborator_id = await db.fetchval(
            # ⚠️ is_company = FALSE ЯВНО. Спикер, который записался сам, —
            # это ЧЕЛОВЕК. NULL в этом поле трактуется как «компания» (так
            # устроена карточка: `is_company !== false`), и человек получал
            # форму с двумя логотипами вместо фото и точки лица.
            """INSERT INTO collaborators
                 (contact_id, name, access_code, created_by_client_id, is_company)
               VALUES ($1, $2, $3, $4, FALSE)
               RETURNING id""",
            contact_id, (contact_name or fallback_name).strip() or fallback_name,
            access_code, client_id,
        )

    # Уже добавлен в событие?
    existing_cse = await db.fetchval(
        "SELECT id FROM event_collaborators WHERE speaker_id = $1 AND event_id = $2",
        collaborator_id, event_id,
    )
    if existing_cse:
        # Участие могло не создаться, когда карточку завели до 2026-08-27, —
        # доставляем его и на повторном заходе.
        from app.services.collaborator_participant import ensure_collaborator_participant
        await ensure_collaborator_participant(
            db, event_id=event_id, collaborator_id=collaborator_id)
        return collaborator_id, access_code, event_slug, True

    # role='speaker' + стартовые тумблеры из настроек СОБЫТИЯ (миграция 336) —
    # та же точка, что у «Нового спикера» и «Добавить из базы».
    # ⚠️ Партнёрка у самозаписавшихся остаётся выключенной независимо от общей
    # настройки: человек пришёл по ссылке сам, агитировать его в партнёры до
    # явного решения клиента нельзя (миграция 123).
    from app.services.speaker_defaults import default_show_flags
    flags = await default_show_flags(db, event_id, 'speaker')
    new_ec_id = await db.fetchval(
        """INSERT INTO event_collaborators
             (speaker_id, event_id, role,
              is_commercial, is_visible, sort_order,
              show_topic_field, show_gift_after_speech_field, show_knowledge_base_field,
              show_notes_field, show_partner_registration_link)
           VALUES ($1, $2, 'speaker', FALSE, TRUE, 0, $3, $4, $5, $6, FALSE)
           RETURNING id""",
        collaborator_id, event_id,
        flags["show_topic_field"], flags["show_gift_after_speech_field"],
        flags["show_knowledge_base_field"], flags["show_notes_field"],
    )
    # Привязываем к этапам «по умолчанию» (conf_conferences.default_speaker_stage_ids)
    try:
        from app.api.modules.conference import apply_default_speaker_stages
        await apply_default_speaker_stages(new_ec_id, event_id, db)
    except Exception:
        pass
    # Карточка в событии = участник события (см. collaborator_participant).
    from app.services.collaborator_participant import ensure_collaborator_participant
    await ensure_collaborator_participant(
        db, event_id=event_id, collaborator_id=collaborator_id)
    return collaborator_id, access_code, event_slug, False
