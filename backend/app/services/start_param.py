"""Разбор стартового параметра ссылки — ОДНА точка на весь проект.

Форматы: `ref_pg{slug}[_pid{code}][_src{utm}][_cid{n}][_ct{n}][_tab{name}][_q{flag}][_land][_nolend][_live][_reg][_spk{n}]`,
а также `m_{slug}…`, `p_{slug}…`, `evl_{slug}…` — хвост у всех устроен одинаково.

⚠️⚠️ ЗНАЧЕНИЕ МАРКЕРА МОЖЕТ СОДЕРЖАТЬ `_` — и это не редкость (23.09.2026).
Раньше каждое место резало payload по `_` и брало один кусок: `_pidtg_392695076`
превращался в `pid` = `tg`. Реферала с таким кодом не находили, и человек
записывался как «пришёл сам» — ровно это случилось с переходом по ссылке
Элины Бутенко (`ref_pgivision9_pidtg_392695076_cid1`) на событии 89. Таких
реф-кодов в базе 95 штук — это апрельский импорт (`tg_<id>`, `sp_<hash>`).

Поэтому значение собирается ЖАДНО: всё до следующего известного маркера
склеивается обратно через `_`. Код `tg_392695076` доезжает целиком.

Молча ошибаться тут нельзя — потерянный реферал не виден никому: ни человеку,
ни рефоводу, ни в отчётах. Поэтому разбор один на всех, а не «примерно такой же»
в каждом обработчике.
"""
from __future__ import annotations

from typing import Optional

# Маркеры со ЗНАЧЕНИЕМ: префикс → (имя поля, длина префикса).
# Порядок важен при проверке «начинается ли кусок с маркера»: более длинные
# префиксы идут раньше, иначе `pid` съел бы `pg`-проверку и наоборот.
_VALUE_MARKERS: tuple[tuple[str, str], ...] = (
    ("nolend", "_flag_nolend"),  # флаг без значения, ловим раньше `no`/`n`-префиксов
    ("land", "_flag_land"),
    ("live", "_flag_live"),
    ("reg", "_flag_reg"),
    ("pid", "pid"),
    ("src", "src"),
    ("cid", "cid"),
    ("tab", "tab"),
    ("spk", "spk"),
    ("pg", "pg"),
    ("ct", "ct"),
    ("q", "q"),
)

# Флаги без значения — отдельным множеством, чтобы не путать со значениями.
_BARE_FLAGS = {"land", "nolend", "live", "reg"}


def _is_marker_start(chunk: str) -> bool:
    """Начинается ли кусок с известного маркера (значит, значение кончилось)."""
    if chunk in _BARE_FLAGS:
        return True
    for prefix, _name in _VALUE_MARKERS:
        if prefix in _BARE_FLAGS:
            continue
        if chunk.startswith(prefix) and len(chunk) > len(prefix):
            return True
    return False


def split_markers(rest: str) -> list[str]:
    """Режет хвост payload на куски-маркеры, СКЛЕИВАЯ значения с `_` внутри.

    `pidtg_392695076_cid1` → `['pidtg_392695076', 'cid1']`, а не три огрызка.
    Кусок, который сам по себе не маркер, прилипает к предыдущему.
    """
    if not rest:
        return []
    out: list[str] = []
    for piece in rest.split("_"):
        if not out:
            out.append(piece)
            continue
        if _is_marker_start(piece):
            out.append(piece)
        else:
            # Хвост значения предыдущего маркера — возвращаем `_` на место.
            out[-1] = f"{out[-1]}_{piece}"
    return out


def split_payload(payload: str, prefix: str) -> tuple[str, list[str]]:
    """Снимает префикс (`ref_pg`, `m_`, `p_`, `evl_`) → (slug, куски-маркеры).

    ⚠️ Сам slug `_` содержать не может — он всегда первый кусок.
    """
    rest = payload[len(prefix):] if payload.startswith(prefix) else payload
    if not rest:
        return "", []
    head, _sep, tail = rest.partition("_")
    return head, split_markers(tail)


def marker_value(chunk: str, prefix: str) -> Optional[str]:
    """Значение маркера, если кусок им является. Иначе None."""
    if chunk.startswith(prefix) and len(chunk) > len(prefix):
        return chunk[len(prefix):]
    return None


def parse_pid_src(rest: str) -> tuple[Optional[str], Optional[str]]:
    """Короткий путь для обработчиков, которым нужны только `pid` и `src`."""
    pid: Optional[str] = None
    src: Optional[str] = None
    for chunk in split_markers(rest):
        v = marker_value(chunk, "pid")
        if v is not None:
            pid = v
            continue
        v = marker_value(chunk, "src")
        if v is not None:
            src = v
    return pid, src
