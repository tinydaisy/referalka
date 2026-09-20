"""
Тексты сообщений о бонусном доступе в ПЛЮСОН (миграция 308).

ОДНО место на все каналы: письмо и бот получают один и тот же текст —
различается только оформление ссылки (в письме она кликается сама, в боте
идёт кнопкой). Держать тексты в двух местах нельзя: разъедутся, и человек
получит разные обещания в почте и в мессенджере.

⚠️ ЦИФРЫ НЕ ХАРДКОДЯТСЯ. Срок бонуса приходит из тарифа (`bonus_days`),
длительность триала — из настроек (`tariffs.trial.default_duration_days` +
`referral_program_settings.trial_bonus_days`). Поменяли бонус в админке —
письмо само напишет новое число.

⚠️ ИМЯ ДАРИТЕЛЯ НЕ СКЛОНЯЕМ. Не «от Марго Форбс» (с любым другим именем
получится «от Анна Иванова»), а отдельной строкой «Подарок от: Имя, Бренд».
Формулировка работает с любым именем.

⚠️ ОТ КОГО И ЗА ЧТО — обязательно в теле. Сообщение приходит и в бот
КЛИЕНТА тоже; без этой строки оно выглядит как посторонняя реклама
платформы в чужом боте, и жалобы пойдут клиенту.
"""
from typing import Optional

# Куда писать по вопросам сервиса. Это поддержка ПЛЮСОНА, а не клиента:
# бонус выдаём мы, и разбираться с доступом тоже нам.
SUPPORT_TG = "https://t.me/pluson_bot"
SUPPORT_MAX = "https://max.ru/id890306512862_1_bot"

SIGNATURE = "С уважением, команда iViSiON: ПЛЮСОН & Марго Форбс"


def _plural_days(n: int) -> str:
    """«30 дней», «1 день», «3 дня» — иначе письмо звучит машинно."""
    n = int(n)
    if 11 <= n % 100 <= 14:
        return f"{n} дней"
    last = n % 10
    if last == 1:
        return f"{n} день"
    if last in (2, 3, 4):
        return f"{n} дня"
    return f"{n} дней"


def _giver(owner_name: Optional[str], brand_name: Optional[str]) -> str:
    """«Подарок от: Марго Форбс, iViSiON». Бренд — только если задан."""
    who = (owner_name or "").strip()
    brand = (brand_name or "").strip()
    if brand and brand.lower() != who.lower():
        return f"Подарок от: {who}, {brand}" if who else f"Подарок от: {brand}"
    return f"Подарок от: {who}" if who else ""


def _footer() -> str:
    return (
        "По всем вопросам работы с сервисом обращайтесь:\n\n"
        f"Телеграм: {SUPPORT_TG}\n\n"
        f"МАКС: {SUPPORT_MAX}\n\n"
        f"{SIGNATURE}"
    )


def _join(*blocks: str) -> str:
    """Склейка через ПУСТУЮ строку — так текст читается и в почте, и в боте."""
    return "\n\n".join(b.strip() for b in blocks if b and b.strip())


# ── 1. Куплен тариф с бонусом, кабинета в ПЛЮСОНе нет ────────────────────
def purchase_new(*, tariff_title: str, owner_name, brand_name,
                 feature_name: Optional[str], days: int,
                 trial_days: int, link: str) -> tuple[str, str]:
    what = [f"— Подписка к системе автоматизации на {_plural_days(trial_days)} "
            f"(готовые воронки, рассылки, чат-боты, лендинги, вебинары и многое другое)"]
    if feature_name:
        what.append(f"— «{feature_name}» на {_plural_days(days)}")

    body = _join(
        "Здравствуйте!",
        f"Вы приобрели «{tariff_title}».",
        _giver(owner_name, brand_name),
        "В бонус вы получили доступ в iViSiON: ПЛЮСОН:",
        "\n\n".join(what),
        "Чтобы получить доступ, перейдите по ссылке — мы заведём вам кабинет, "
        "и отсчёт дней начнётся с этого момента:",
        link,
        "Ссылка сработает один раз.",
        _footer(),
    )
    return "Ваш бонус — доступ в iViSiON: ПЛЮСОН", body


# ── 2. Куплен тариф с бонусом, кабинет уже есть ──────────────────────────
def purchase_existing(*, tariff_title: str, owner_name, brand_name,
                      feature_name: Optional[str], days: int,
                      had_module: bool, extra_days: int, link: str) -> tuple[str, str]:
    # ⚠️ Разделяем «модуль уже был» и «модуля не было»: система это знает
    # точно и не должна писать «если у вас был» — это звучит как отписка.
    parts = []
    if feature_name and had_module:
        parts.append(f"— «{feature_name}» — ещё {_plural_days(days)}. "
                     f"Оплаченные ранее дни не сгорят: срок прибавится к текущему.")
    elif feature_name:
        parts.append(f"— «{feature_name}» на {_plural_days(days)} — "
                     f"подключим к вашему кабинету.")
    # ⚠️ Действующему клиенту полный триал не положен (он для новых), но и
    # с пустыми руками оставлять нельзя — даём те же 3 дня продления, что и
    # в подарке. Правило одно на все случаи.
    if extra_days:
        parts.append(f"— {_plural_days(extra_days)} к вашей текущей подписке "
                     f"в iViSiON: ПЛЮСОН.")
    what = "\n\n".join(parts) or f"Доступ в iViSiON: ПЛЮСОН на {_plural_days(days)}."

    body = _join(
        "Здравствуйте!",
        f"Вы приобрели «{tariff_title}».",
        _giver(owner_name, brand_name),
        "В бонус вы получили:",
        what,
        "Чтобы активировать, перейдите по ссылке — отсчёт дней начнётся с этого момента:",
        link,
        "Ссылка сработает один раз.",
        _footer(),
    )
    return "Ваш бонус — доступ в iViSiON: ПЛЮСОН", body


# ── 3. Подарок «триал», человек в ПЛЮСОНе новый ──────────────────────────
def gift_new(*, owner_name, brand_name, reason: str,
             trial_days: int, base_days: int, link: str) -> tuple[str, str]:
    body = _join(
        "Здравствуйте!",
        reason,                      # напр. «Вы пригласили 3 друзей.»
        _giver(owner_name, brand_name),
        "Вы получаете доступ в iViSiON: ПЛЮСОН — платформу для организаторов "
        "и экспертов (готовые воронки, рассылки, чат-боты, лендинги, вебинары "
        "и многое другое).",
        f"{_plural_days(trial_days)} бесплатного доступа вместо стандартных "
        f"{_plural_days(base_days)}.",
        "Регистрируйтесь по ссылке — дни активируются сами:",
        link,
        _footer(),
    )
    return f"Ваш подарок — {_plural_days(trial_days)} в iViSiON: ПЛЮСОН", body


# ── 4. Подарок «триал», кабинет уже есть ─────────────────────────────────
def gift_existing(*, owner_name, brand_name, reason: str,
                  trial_days: int, extra_days: int, link: str) -> tuple[str, str]:
    body = _join(
        "Здравствуйте!",
        reason,
        _giver(owner_name, brand_name),
        "Мы видим, что кабинет в ПЛЮСОНе у вас уже есть — и ценим, что вы с нами.",
        f"Подарок «{_plural_days(trial_days)} бесплатного доступа» рассчитан на тех, "
        f"кто ещё не пользовался ПЛЮСОНом, поэтому мы добавим "
        f"{_plural_days(extra_days)} к вашей текущей подписке.",
        "Для активации перейдите по ссылке:",
        link,
        "Ссылка сработает один раз.",
        _footer(),
    )
    return "Ваш подарок — доступ в iViSiON: ПЛЮСОН", body


# ── Напоминание о неактивированном бонусе ────────────────────────────────
def reminder(*, subject_line: str, what: str, link: str, days_left: int) -> tuple[str, str]:
    """⚠️ Напоминание — короткое. Человек уже читал подробности в первом
    письме; повтор простыни раздражает и ведёт в спам."""
    tail = (f"Ссылка сгорит через {_plural_days(days_left)}."
            if days_left > 0 else "Это последний день, когда ссылка работает.")
    body = _join(
        "Здравствуйте!",
        f"Напоминаем: вас ждёт {what} — доступ пока не активирован.",
        "Перейдите по ссылке, чтобы забрать:",
        link,
        tail,
        _footer(),
    )
    return subject_line, body


# ── Строка «Бонус:» под тарифом на лендинге ──────────────────────────────
def tariff_bonus_line(*, feature_name: Optional[str], days: int,
                      trial_days: int, extra_days: int) -> str:
    """Готовая строка для карточки тарифа на лендинге.

    ⚠️ Собирается АВТОМАТИЧЕСКИ из настройки тарифа, а не пишется руками в
    описании. Иначе текст врёт: клиент однажды написал «1 месяц», потом
    поменял срок в настройке — а описание осталось старым.

    ⚠️ Обязательно названы ОБА случая — «для новых» и «для действующих».
    Иначе человек с кабинетом решит, что его обманули: он ждал 30 дней, а
    получит 3.

    Пусто → строки нет (у тарифа бонус не настроен).
    """
    lines = tariff_bonus_lines(feature_name=feature_name, days=days,
                               trial_days=trial_days, extra_days=extra_days)
    return " + ".join(lines)


def tariff_bonus_lines(*, feature_name: Optional[str], days: int,
                       trial_days: int, extra_days: int) -> list[str]:
    """Бонусы тарифа ОТДЕЛЬНЫМИ строками — по одной плашке на бонус.

    ⚠️ Модуль и подписка ПЛЮСОН — это два разных подарка, и в карточке они
    должны читаться как два. Склеенные через «+» в одно предложение, они
    давали плашку в четыре строки, где не видно, что подарков два.

    ⚠️ Подписка попадает сюда и без модуля: тариф может дарить только
    доступ к ПЛЮСОНу. Раньше такой бонус не показывался вовсе.
    """
    lines: list[str] = []
    if feature_name:
        lines.append(f"Доступ к модулю «{feature_name}» на {_plural_days(days)}")
    if trial_days:
        lines.append(
            f"{_plural_days(trial_days)} доступа к iViSiON: ПЛЮСОН для новых клиентов "
            f"или + {_plural_days(extra_days)} продления для действующих "
            f"(система автоматизации привлечения клиентов для экспертов, спикеров "
            f"и организаторов)"
        )
    return lines
