# Шаблоны рассылок конференции

## Шаблон 1 — за 5 минут до старта выступления

**Тип:** `pre_start`  
**Когда:** за 5 минут до `conf_sessions.start_datetime`  
**Кому:** все зарегистрированные участники конференции

**Фото:** индивидуальная афиша спикера (`collaborators.photo_url` или отдельное поле афиши)

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

*`gift_title` → `conf_speaker_events.gift_after_speech_title`*  
*`gift_url` → `conf_speaker_events.gift_after_speech_url`*

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
