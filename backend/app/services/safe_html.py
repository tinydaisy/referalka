"""Безопасный показ текста, который клиент написал с разметкой.

Зачем. Регалии основателя и блоки карточки Хаба клиент пишет тегами
(`<b>жирный</b>`) — так же, как тексты рассылок. На страницах, которые
собираются на сервере (витрина `/o/{client_id}`), такой текст раньше
экранировался целиком: человек видел «<b>Регалии:</b>» вместо жирного.

⚠️ Просто вставить строку в HTML нельзя — это дыра: в поле могло оказаться
что угодно (импорт, старые записи, чужой API). Поэтому оставляем ТОЛЬКО
безопасные теги форматирования и вычищаем остальное.

Тот же набор тегов, что у показа в кабинете (`web/src/components/SafeHtml.tsx`)
и у редактора в режиме `web` — списки, абзацы, ссылки, выделение. Ни
`<script>`, ни `<iframe>`, ни обработчики событий (`onclick`) не проходят.
"""
import html as _html
import re

# Разрешённые теги — только оформление текста.
_ALLOWED = {
    'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'a', 'br', 'code', 'pre',
    'ul', 'ol', 'li', 'p', 'h2', 'h3', 'blockquote',
}
# Теги, внутри которых содержимое опасно само по себе — вырезаем вместе с телом.
_DROP_WITH_BODY = ('script', 'style', 'iframe', 'object', 'embed')

_TAG_RE = re.compile(r'<\s*(/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*)?)/?\s*>')
_HREF_RE = re.compile(r'href\s*=\s*("([^"]*)"|\'([^\']*)\')', re.I)
_SAFE_SCHEME_RE = re.compile(r'^\s*(https?:|mailto:|tel:|/|#)', re.I)


def looks_like_html(s: str) -> bool:
    """Есть ли в строке разметка. Пусто/обычный текст → False."""
    return bool(s) and bool(re.search(r'</?[a-zA-Z][^>]*>', s))


def safe_html(s) -> str:
    """Вернуть строку, пригодную для вставки в HTML-страницу.

    Обычный текст (без тегов) экранируется целиком и получает `<br>` вместо
    переносов строк — иначе регалии, введённые по одной на строку, слиплись бы
    в сплошную простыню.
    """
    raw = str(s if s is not None else '')
    if not raw.strip():
        return ''

    if not looks_like_html(raw):
        return _html.escape(raw).replace('\n', '<br>')

    # 1. Вырезаем опасные блоки вместе с содержимым.
    out = raw
    for tag in _DROP_WITH_BODY:
        out = re.sub(rf'<\s*{tag}\b.*?<\s*/\s*{tag}\s*>', '', out, flags=re.I | re.S)
        out = re.sub(rf'<\s*/?\s*{tag}\b[^>]*>', '', out, flags=re.I)

    # 2. Экранируем ВСЁ, а разрешённые теги возвращаем обратно. Так любой
    #    неучтённый синтаксис остаётся текстом и не может стать разметкой.
    def _keep(m: re.Match) -> str:
        closing, tag, attrs = m.group(1), m.group(2).lower(), m.group(3) or ''
        if tag not in _ALLOWED:
            return _html.escape(m.group(0))
        if tag == 'a' and not closing:
            href = ''
            hm = _HREF_RE.search(attrs)
            if hm:
                href = (hm.group(2) or hm.group(3) or '').strip()
            # Ссылки только на понятные схемы: «javascript:» и подобное — мимо.
            if href and _SAFE_SCHEME_RE.match(href):
                safe_href = _html.escape(href, quote=True)
                return f'<a href="{safe_href}" target="_blank" rel="noopener noreferrer">'
            return '<a>'
        return f'<{"/" if closing else ""}{tag}>'

    placeholders: list[str] = []

    def _stash(m: re.Match) -> str:
        placeholders.append(_keep(m))
        return f'\x00{len(placeholders) - 1}\x00'

    out = _TAG_RE.sub(_stash, out)
    out = _html.escape(out)
    for i, tag_html in enumerate(placeholders):
        out = out.replace(_html.escape(f'\x00{i}\x00'), tag_html).replace(f'\x00{i}\x00', tag_html)

    # ⚠️ Переносы строк сохраняем и в тексте С ТЕГАМИ. Регалии пишут по одной
    # на строку, а пара <b> внутри не должна превращать их в сплошную простыню:
    # в HTML «\n» — обычный пробел. Не трогаем, если человек уже разметил текст
    # блочно (<p>/<ul>/<br>) — там переносы служат только читаемости исходника.
    if not re.search(r'<\s*(br|p|ul|ol|li|h2|h3|blockquote)\b', out, re.I):
        out = out.replace('\n', '<br>')
    return out
