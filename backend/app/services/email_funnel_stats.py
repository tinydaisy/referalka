"""Воронка email-рассылки — одна точка расчёта для общих и событийных рассылок.

Четыре цифры, все по УНИКАЛЬНЫМ адресам получателей:

  отправлено — скольким адресам попытались отправить
  доставлено — почта получателя приняла письмо (broadcast_log.status='sent')
  открыли    — загрузился 1×1 пиксель внутри письма
  кликнули   — перешли по ссылке из письма

⚠️ «Открыли» СОЗНАТЕЛЬНО включает прокси-предзагрузки (Gmail, Apple Mail
Privacy, Яндекс, Rambler). Gmail показывает картинки только через свой
GoogleImageProxy — если их отбрасывать, у половины базы открытий будет ноль,
и метрика превращается в мусор (реально наблюдали 0.5% open rate). Так же
считают GetCourse и Mailchimp. Цифра завышена на 30–50%, поэтому рядом
отдаём `opened_human` — те же открытия без прокси, и `clicked` — её
подделать прокси не может, это самая честная метрика вовлечённости.
"""
import asyncpg


_SQL = """
WITH em AS (
    SELECT bl.id, bl.platform_user_id, bl.status
      FROM broadcast_log bl
      JOIN channels ch ON ch.id = bl.channel_id
     WHERE bl.schedule_id = $1 AND ch.platform_slug = 'email'
)
SELECT
    (SELECT COUNT(DISTINCT platform_user_id) FROM em)                       AS sent,
    (SELECT COUNT(DISTINCT platform_user_id) FROM em WHERE status = 'sent') AS delivered,
    (SELECT COUNT(DISTINCT em.platform_user_id) FROM em
       JOIN email_open_log eo ON eo.broadcast_log_id = em.id)               AS opened,
    (SELECT COUNT(DISTINCT em.platform_user_id) FROM em
       JOIN email_open_log eo ON eo.broadcast_log_id = em.id
      WHERE eo.is_proxy = FALSE)                                            AS opened_human,
    (SELECT COUNT(DISTINCT em.platform_user_id) FROM em
       JOIN email_click_log ec ON ec.broadcast_log_id = em.id)              AS clicked
"""


async def email_funnel_stats(db: asyncpg.Connection, schedule_id: int) -> dict | None:
    """Воронка по рассылке. None — если email-получателей у рассылки не было."""
    row = await db.fetchrow(_SQL, schedule_id)
    if not row or not row["sent"]:
        return None
    return dict(row)
