"""
Разворачивает <div>-обёртки в текстах уроков.

⚠️ Из-за них абзацы схлопывались в сплошную строку. SafeHtml (наш очиститель
разметки) не пропускает <div> и заменяет его на ГОЛЫЙ ТЕКСТ (node.textContent).
Вместе с обёрткой уничтожается вся разметка внутри — <p> и <br> тоже. На
экране «…инсайты от видео-материалов2. в рабочей тетради» вместо трёх строк.

GetCourse оборачивает так 76 текстовых блоков из 338.

Что делает скрипт: снимает внешние <div> (в том числе вложенные), сохраняя всё
содержимое. Если внутри не осталось блочной разметки вовсе — переносы строк
превращаются в <br>, иначе текст всё равно слипнется.

⚠️ Никаких <ol>/<ul> НЕ создаём: там, где автор набрал «1.», «2.» руками, это
его текст, и превращать его в список — менять содержимое, а не чинить показ.

Запуск:
    python3 fix_div_wrappers.py                 # правит export.json
    python3 fix_div_wrappers.py --dry-run
"""
import argparse
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
EXPORT = os.path.join(HERE, "export.json")

# Блочные теги, которые сами дают перенос строки.
_BLOCK_RE = re.compile(r"<\s*(br|p|ul|ol|li|h2|h3|blockquote)\b", re.I)


def unwrap_divs(html: str) -> str:
    """
    Снимает <div>…</div>, сохраняя содержимое И переносы строк.

    ⚠️ Просто удалить <div> нельзя. В части уроков GetCourse использует его
    КАК СТРОКУ — каждая строка обёрнута в свой <div> (программа конференции:
    <div>Имя спикера</div><div>Тема выступления: …</div>). Удаление без замены
    склеивает их в «Владимир ШадураТема выступления:».

    Поэтому закрывающий </div> превращаем в <p>-границу, а пустые обёртки,
    не дававшие переноса, схлопываем. Лишние подряд идущие <br> убираем.
    """
    if not html:
        return html
    # Закрывающий div = конец строки. Открывающий просто убираем.
    out = re.sub(r"</div\s*>", "<br>", html, flags=re.I)
    out = re.sub(r"<div[^>]*>", "", out, flags=re.I)
    # Обёртка вокруг блочного тега давала лишний перенос — он не нужен.
    out = re.sub(r"(</(?:p|ul|ol|li|h2|h3|blockquote)\s*>)\s*(?:<br\s*/?>\s*)+",
                 r"\1", out, flags=re.I)
    # Хвостовые и сдвоенные переносы.
    out = re.sub(r"(?:<br\s*/?>\s*){3,}", "<br><br>", out, flags=re.I)
    out = re.sub(r"(?:\s*<br\s*/?>)+\s*$", "", out, flags=re.I)
    return out.strip()


def keep_line_breaks(html: str) -> str:
    """
    Если блочной разметки не осталось, а переносы строк есть — делаем из них
    <br>. Иначе HTML схлопнет их в пробел и текст слипнется.
    """
    if _BLOCK_RE.search(html):
        return html
    if "\n" not in html:
        return html
    parts = [p.strip() for p in html.split("\n")]
    return "<br>".join(p for p in parts if p)


def fix(html: str) -> str:
    return keep_line_breaks(unwrap_divs(html))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", default=EXPORT)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(args.export, encoding="utf-8") as f:
        data = json.load(f)

    changed = []
    for t in data:
        for les in t["lessons"]:
            for b in les["blocks"]:
                if b["kind"] != "text":
                    continue
                before = b.get("body") or ""
                after = fix(before)
                if after != before:
                    changed.append((les["title"][:45], len(before), len(after)))
                    if not args.dry_run:
                        b["body"] = after

    print(f"текстовых блоков исправлено: {len(changed)}")
    for title, a, b_ in changed[:12]:
        print(f"  {title:<47} {a} → {b_}")

    if args.dry_run:
        print("\n(dry-run: файл не изменён)")
        return

    with open(args.export, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"\nсохранено: {args.export}")


if __name__ == "__main__":
    main()
