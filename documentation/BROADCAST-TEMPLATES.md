# Шаблоны рассылок конференции

> ⚠️ **Файл описывает первоначальный замысел шаблонов и местами отстал от кода.** Актуальные типы шаблонов, правила генерации и полный список плейсхолдеров — в CLAUDE.md (раздел «Рассылки — единый движок») и в [message_builder.py](../backend/app/services/message_builder.py). Здесь исправлены только фактические ошибки по схеме БД.

## Шаблон 1 — за 5 минут до старта выступления

**Тип:** `5min_before` *(в старой редакции файла назывался `pre_start` — переименован миграцией 060)*
**Когда:** за 5 минут до начала слота спикера
⚠️ Время слота — **`conf_sessions.start_time`, строка `HH:MM` (тип `text`), МСК по соглашению**. Колонок `start_datetime`/`end_datetime` в `conf_sessions` **нет** (удалены миграцией 048). День берётся из `conf_sessions.day` / `conf_days`.
**Кому:** все зарегистрированные участники конференции

**Фото:** афиша спикера из библиотеки `collaborator_posters` (через `event_collaborators.poster_id`, fallback — первая в библиотеке), либо фото коллаба `collaborators.photo_url` — выбор задаётся `broadcast_templates.speaker_photo_mode` (`poster`/`photo`, миграция 202) и тумблером `event_collaborators.use_photo_instead_of_poster` (миграция 237)

**Текст:**
```
Через 5 минут выступает {speaker_name}

Тема: «{speaker_topic}»

Заходи в эфир, получай полезный контент и находи секретный код для розыгрыша!
👇👇👇
{stream_url}
```

**Кнопка:** `СМОТРЕТЬ ЭФИР` → `{stream_url}`

---

## Шаблон 2 — за 10 минут до конца выступления

**Тип:** `gift`  
**Когда:** за 10 минут до `conf_sessions.end_datetime`  
**Кому:** все зарегистрированные участники конференции

**Фото:** нет

**Текст:**
```
🎁 {speaker_name}: Подарки

{gift_title}

{gift_url}
```

*`gift_title` и `gift_url` → таблица **`event_collaborator_lead_magnets`** (`manual_title` / `manual_url`, либо название лид-магнита по `lead_magnet_id` / `package_id`).*

> ⚠️ Раньше здесь было написано «`conf_speaker_events.gift_after_speech_title/url`». **Таблицы `conf_speaker_events` не существует** (это `event_collaborators`), а колонки `gift_after_speech_*` удалены 2026-07-30: у спикера может быть несколько подарков, поэтому они вынесены в отдельную таблицу.

---

## Переменные шаблонов

| Переменная | Откуда берётся |
|---|---|
| `{speaker_name}` | `collaborators.name` |
| `{speaker_topic}` | `conf_speaker_topics.topic` (тема спикера) |
| `{stream_url}` | `conf_conferences.stream_url_day_1` или `stream_url_day_2` — по номеру дня сессии |
| `{gift_title}` | `conf_sessions.gift_description` (название) |
| `{gift_url}` | уточнить — отдельное поле? |

---

## Открытые вопросы

- [ ] Подарок спикера — где хранится ссылка? В `conf_sessions.gift_description` только текст или там и ссылка?
- [ ] Рассылка — всем участникам конференции или только определённого дня/потока?
- [ ] Фото для шаблона 1 — `collaborators.photo_url` или отдельная афиша спикера?
