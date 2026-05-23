"""
Генератор финансовой модели ПЛЮСОН в Excel.
Все итоговые ячейки — формулы, не статичные числа.
Запуск: python3 scripts/build_financial_model.py
Результат: financial_model.xlsx в корне проекта
"""
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

OUT_PATH = "financial_model.xlsx"

# ====== Стили ======
HEADER_FILL = PatternFill("solid", fgColor="25455D")
HEADER_FONT = Font(bold=True, color="FFFFFF", size=12)
SUBHEADER_FILL = PatternFill("solid", fgColor="FFCFA4")
SUBHEADER_FONT = Font(bold=True, color="000000", size=11)
TOTAL_FILL = PatternFill("solid", fgColor="FFF4E6")
TOTAL_FONT = Font(bold=True, size=11)
INPUT_FILL = PatternFill("solid", fgColor="E8F4F8")
THIN = Side(border_style="thin", color="999999")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

MONEY_FMT = '#,##0 "₽"'
PERCENT_FMT = '0.0%'
INT_FMT = '#,##0'


def style_header(cell):
    cell.fill = HEADER_FILL
    cell.font = HEADER_FONT
    cell.alignment = Alignment(horizontal="center", vertical="center")
    cell.border = BORDER


def style_subheader(cell):
    cell.fill = SUBHEADER_FILL
    cell.font = SUBHEADER_FONT
    cell.alignment = Alignment(horizontal="left", vertical="center")
    cell.border = BORDER


def style_total(cell):
    cell.fill = TOTAL_FILL
    cell.font = TOTAL_FONT
    cell.border = BORDER


def style_input(cell):
    cell.fill = INPUT_FILL
    cell.border = BORDER


def style_cell(cell):
    cell.border = BORDER


def autosize(ws, widths):
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w


# ====== Workbook ======
wb = Workbook()

# ============================================================
# ЛИСТ 1: ПАРАМЕТРЫ (вводные, всё остальное от них считается)
# ============================================================
ws = wb.active
ws.title = "Параметры"

ws["A1"] = "ПАРАМЕТРЫ ФИНАНСОВОЙ МОДЕЛИ ПЛЮСОН"
ws["A1"].font = Font(bold=True, size=14, color="25455D")
ws.merge_cells("A1:C1")

ws["A2"] = "Голубые ячейки — редактируемые входные параметры. Всё остальное считается формулами."
ws["A2"].font = Font(italic=True, size=10, color="666666")
ws.merge_cells("A2:C2")

row = 4
ws.cell(row=row, column=1, value="Раздел").value = "ЦЕНЫ ТАРИФОВ"
style_subheader(ws.cell(row=row, column=1))
ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=3)
row += 1

ws.cell(row=row, column=1, value="Параметр")
ws.cell(row=row, column=2, value="Значение")
ws.cell(row=row, column=3, value="Комментарий")
for c in range(1, 4):
    style_header(ws.cell(row=row, column=c))
row += 1

# Цены тарифов (именованные ячейки для удобства)
prices = [
    ("price_start", "Цена СТАРТ, ₽/мес", 990, "Базовый тариф без конференций — основная масса клиентов"),
    ("price_pro", "Цена ПРОФИ, ₽/мес", 2490, "С конференциями, общий бот"),
    ("price_vip", "Цена VIP, ₽/мес", 3900, "Свой брендированный бот — доступен по цене и для несильно крупных"),
    ("share_start", "Доля СТАРТ в портфеле", 0.6, "Мелкие эксперты без команды — основной сегмент"),
    ("share_pro", "Доля ПРОФИ в портфеле", 0.3, "Те, кто делает конференции"),
    ("share_vip", "Доля VIP в портфеле", 0.1, "За свой бот по такой цене — берут охотно"),
]

price_rows = {}
for key, label, value, comment in prices:
    ws.cell(row=row, column=1, value=label)
    c = ws.cell(row=row, column=2, value=value)
    c.number_format = PERCENT_FMT if "Доля" in label else MONEY_FMT
    style_input(c)
    ws.cell(row=row, column=3, value=comment)
    style_cell(ws.cell(row=row, column=1))
    style_cell(ws.cell(row=row, column=3))
    price_rows[key] = row
    row += 1

# Проверка суммы долей
ws.cell(row=row, column=1, value="Проверка: сумма долей = 100%")
ws.cell(row=row, column=1).font = Font(italic=True, size=10)
formula = f"=B{price_rows['share_start']}+B{price_rows['share_pro']}+B{price_rows['share_vip']}"
c = ws.cell(row=row, column=2, value=formula)
c.number_format = PERCENT_FMT
c.font = Font(italic=True, size=10)
row += 2

# Расходы постоянные
ws.cell(row=row, column=1).value = "ПОСТОЯННЫЕ РАСХОДЫ (₽/мес на старте)"
style_subheader(ws.cell(row=row, column=1))
ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=3)
row += 1

ws.cell(row=row, column=1, value="Статья")
ws.cell(row=row, column=2, value="₽/мес")
ws.cell(row=row, column=3, value="Комментарий")
for c in range(1, 4):
    style_header(ws.cell(row=row, column=c))
row += 1

infra = [
    ("VPS прод Beget (тариф 2: 1 CPU / 2 ГБ / 15 ГБ)", 510, "194.156.119.17 — текущий"),
    ("VPS dev Beget (тариф 1: 1 CPU / 1 ГБ / 10 ГБ)", 330, "62.113.98.30 — текущий"),
    ("Резервный VPS / отказоустойчивость", 0, "Опционально — можно добавить позже"),
    ("Cloudflare R2 (стартовый объём)", 200, "Растёт линейно с числом клиентов"),
    ("Email-сервис (Unisender/SendPulse)", 700, "Верификация, восстановление"),
    ("Домены", 200, "pluson.ru + резервные"),
    ("Бэкапы БД (внешнее хранилище)", 500, "B2 / Selectel"),
]
infra_first = row
for label, value, comment in infra:
    ws.cell(row=row, column=1, value=label)
    c = ws.cell(row=row, column=2, value=value)
    c.number_format = MONEY_FMT
    style_input(c)
    ws.cell(row=row, column=3, value=comment)
    style_cell(ws.cell(row=row, column=1))
    style_cell(ws.cell(row=row, column=3))
    row += 1
infra_last = row - 1

ws.cell(row=row, column=1, value="ИТОГО инфраструктура")
c = ws.cell(row=row, column=2, value=f"=SUM(B{infra_first}:B{infra_last})")
c.number_format = MONEY_FMT
style_total(ws.cell(row=row, column=1))
style_total(c)
infra_total_row = row
row += 2

# ФОТ
ws.cell(row=row, column=1).value = "ФОТ (₽/мес)"
style_subheader(ws.cell(row=row, column=1))
ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=3)
row += 1

fot = [
    ("Тех. специалист + поддержка", 30000, "Один человек на старте"),
    ("Марго (продюсер/основатель)", 0, "В долю на старте"),
    ("Дизайнер/копирайтер (фриланс)", 0, "По нужде"),
]
fot_first = row
for label, value, comment in fot:
    ws.cell(row=row, column=1, value=label)
    c = ws.cell(row=row, column=2, value=value)
    c.number_format = MONEY_FMT
    style_input(c)
    ws.cell(row=row, column=3, value=comment)
    style_cell(ws.cell(row=row, column=1))
    style_cell(ws.cell(row=row, column=3))
    row += 1
fot_last = row - 1

ws.cell(row=row, column=1, value="ИТОГО ФОТ")
c = ws.cell(row=row, column=2, value=f"=SUM(B{fot_first}:B{fot_last})")
c.number_format = MONEY_FMT
style_total(ws.cell(row=row, column=1))
style_total(c)
fot_total_row = row
row += 2

# Маркетинг
ws.cell(row=row, column=1).value = "МАРКЕТИНГ (₽/мес фиксированный)"
style_subheader(ws.cell(row=row, column=1))
ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=3)
row += 1

mkt = [
    ("Реклама в Telegram-каналах", 20000, "Закупка постов"),
    ("Контент (соцсети, рассылки)", 10000, "Тексты, баннеры, видео"),
    ("PR / выступления / конференции", 10000, "Продвижение Марго как эксперта"),
]
mkt_first = row
for label, value, comment in mkt:
    ws.cell(row=row, column=1, value=label)
    c = ws.cell(row=row, column=2, value=value)
    c.number_format = MONEY_FMT
    style_input(c)
    ws.cell(row=row, column=3, value=comment)
    style_cell(ws.cell(row=row, column=1))
    style_cell(ws.cell(row=row, column=3))
    row += 1
mkt_last = row - 1

ws.cell(row=row, column=1, value="ИТОГО маркетинг (фикс)")
c = ws.cell(row=row, column=2, value=f"=SUM(B{mkt_first}:B{mkt_last})")
c.number_format = MONEY_FMT
style_total(ws.cell(row=row, column=1))
style_total(c)
mkt_total_row = row
row += 2

# Переменные расходы (% с выручки)
ws.cell(row=row, column=1).value = "ПЕРЕМЕННЫЕ РАСХОДЫ (% с выручки)"
style_subheader(ws.cell(row=row, column=1))
ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=3)
row += 1

variables = [
    ("usn", "УСН 6%", 0.06, "Налог УСН доходы"),
    ("acquiring", "Эквайринг", 0.04, "4% — Юкасса/CloudPayments"),
    ("partner_payouts", "Партнёрская программа (выплаты)", 0.10, "10% пожизненно — с КАЖДОГО платежа клиента"),
]
var_first = row
var_rows = {}
for key, label, value, comment in variables:
    ws.cell(row=row, column=1, value=label)
    c = ws.cell(row=row, column=2, value=value)
    c.number_format = PERCENT_FMT
    style_input(c)
    ws.cell(row=row, column=3, value=comment)
    style_cell(ws.cell(row=row, column=1))
    style_cell(ws.cell(row=row, column=3))
    var_rows[key] = row
    row += 1
var_last = row - 1

ws.cell(row=row, column=1, value="ИТОГО переменные расходы (с каждого ₽)")
c = ws.cell(row=row, column=2, value=f"=SUM(B{var_first}:B{var_last})")
c.number_format = PERCENT_FMT
style_total(ws.cell(row=row, column=1))
style_total(c)
var_total_row = row
row += 2

# Сводный блок постоянных расходов
ws.cell(row=row, column=1).value = "ИТОГО ПОСТОЯННЫХ РАСХОДОВ В МЕСЯЦ"
style_subheader(ws.cell(row=row, column=1))
ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=3)
row += 1

ws.cell(row=row, column=1, value="Инфра + ФОТ + Маркетинг")
c = ws.cell(row=row, column=2, value=f"=B{infra_total_row}+B{fot_total_row}+B{mkt_total_row}")
c.number_format = MONEY_FMT
style_total(ws.cell(row=row, column=1))
style_total(c)
fixed_total_row = row
row += 1

# Сохраняем для других листов
PARAMS = {
    "price_start": f"Параметры!$B${price_rows['price_start']}",
    "price_pro": f"Параметры!$B${price_rows['price_pro']}",
    "price_vip": f"Параметры!$B${price_rows['price_vip']}",
    "share_start": f"Параметры!$B${price_rows['share_start']}",
    "share_pro": f"Параметры!$B${price_rows['share_pro']}",
    "share_vip": f"Параметры!$B${price_rows['share_vip']}",
    "infra_total": f"Параметры!$B${infra_total_row}",
    "fot_total": f"Параметры!$B${fot_total_row}",
    "mkt_total": f"Параметры!$B${mkt_total_row}",
    "var_total": f"Параметры!$B${var_total_row}",
    "fixed_total": f"Параметры!$B${fixed_total_row}",
}

autosize(ws, [42, 18, 50])

# ============================================================
# ЛИСТ 2: ТАРИФЫ (структура и формулы средней цены)
# ============================================================
ws2 = wb.create_sheet("Тарифы")

ws2["A1"] = "ТАРИФНАЯ СЕТКА"
ws2["A1"].font = Font(bold=True, size=14, color="25455D")
ws2.merge_cells("A1:E1")

row = 3
headers = ["Параметр", "СТАРТ", "ПРОФИ", "VIP", "Корпоративный"]
for i, h in enumerate(headers, 1):
    c = ws2.cell(row=row, column=i, value=h)
    style_header(c)
row += 1

tariff_rows = [
    ("Цена, ₽/мес", f"={PARAMS['price_start']}", f"={PARAMS['price_pro']}", f"={PARAMS['price_vip']}", "от 49 900 ₽"),
    ("Цена, ₽/год (-15-17%)", None, None, None, None),
    ("Свой бот в Telegram", "Нет", "Нет", "Да", "Несколько"),
    ("Модуль «Конференции»", "Нет", "Да", "Да", "Да"),
    ("Лимит контактов в базе", 1000, 5000, 25000, "Безлимит"),
    ("Доплата за рост базы, ₽", "+500/+1000", "+500/+1000", "+800/+5000", "По договору"),
    ("Лимит событий в месяц", 10, "Безлимит", "Безлимит", "Безлимит"),
    ("Лимит рассылок в месяц", 30, 150, "Безлимит", "Безлимит"),
    ("Объём файлов (R2)", "100 МБ", "2 ГБ", "15 ГБ", "По договору"),
    ("Поддержка SLA", "24 ч email", "8 ч чат", "1 ч личный", "Менеджер"),
    ("Партнёрская программа (рефералка)", "Да", "Да", "Да", "Да"),
]

tariff_first = row
for r in tariff_rows:
    label = r[0]
    ws2.cell(row=row, column=1, value=label)
    style_cell(ws2.cell(row=row, column=1))
    if label == "Цена, ₽/год (-15-17%)":
        # Формулы со скидкой
        for col_idx, key in [(2, "price_start"), (3, "price_pro"), (4, "price_vip")]:
            f = f"={PARAMS[key]}*12*0.85"
            cell = ws2.cell(row=row, column=col_idx, value=f)
            cell.number_format = MONEY_FMT
            style_cell(cell)
        ws2.cell(row=row, column=5, value="По договору")
        style_cell(ws2.cell(row=row, column=5))
    else:
        for col_idx in range(2, 6):
            v = r[col_idx - 1]
            cell = ws2.cell(row=row, column=col_idx, value=v)
            if isinstance(v, str) and v.startswith("="):
                cell.number_format = MONEY_FMT
            elif label == "Цена, ₽/мес":
                cell.number_format = MONEY_FMT
            elif label.startswith("Лимит") and isinstance(v, (int, float)):
                cell.number_format = INT_FMT
            style_cell(cell)
    row += 1

row += 2
ws2.cell(row=row, column=1, value="СРЕДНИЙ ARPU (взвешенно по долям)").font = Font(bold=True, size=11)
ws2.merge_cells(start_row=row, start_column=1, end_row=row, end_column=5)
row += 1

ws2.cell(row=row, column=1, value="Формула")
ws2.cell(row=row, column=2, value="Значение")
for c in [1, 2]:
    style_header(ws2.cell(row=row, column=c))
row += 1

ws2.cell(row=row, column=1, value="ARPU = СТАРТ×доля + ПРОФИ×доля + VIP×доля")
arpu_formula = (
    f"={PARAMS['price_start']}*{PARAMS['share_start']}"
    f"+{PARAMS['price_pro']}*{PARAMS['share_pro']}"
    f"+{PARAMS['price_vip']}*{PARAMS['share_vip']}"
)
c = ws2.cell(row=row, column=2, value=arpu_formula)
c.number_format = MONEY_FMT
style_total(ws2.cell(row=row, column=1))
style_total(c)
arpu_row = row
row += 1

ws2.cell(row=row, column=1, value="Чистая маржа на клиенте (после переменных)")
margin_formula = f"=B{arpu_row}*(1-{PARAMS['var_total']})"
c = ws2.cell(row=row, column=2, value=margin_formula)
c.number_format = MONEY_FMT
style_total(ws2.cell(row=row, column=1))
style_total(c)
margin_row = row

# Сохраним ссылки на лист тарифов
PARAMS["arpu"] = f"Тарифы!$B${arpu_row}"
PARAMS["margin_per_client"] = f"Тарифы!$B${margin_row}"

autosize(ws2, [40, 22, 22, 22, 22])

# ============================================================
# ЛИСТ 3: СЦЕНАРИИ РОСТА
# ============================================================
ws3 = wb.create_sheet("Сценарии роста")

ws3["A1"] = "СЦЕНАРИИ РОСТА (P&L по числу клиентов)"
ws3["A1"].font = Font(bold=True, size=14, color="25455D")
ws3.merge_cells("A1:H1")

ws3["A2"] = "Постоянные расходы (инфра + ФОТ) растут ступенями по числу клиентов"
ws3["A2"].font = Font(italic=True, size=10, color="666666")
ws3.merge_cells("A2:H2")

row = 4
headers = [
    "Клиентов",
    "Выручка/мес",
    "Перем. расходы",
    "Инфра расш. (надбавка)",
    "Доп. ФОТ (надбавка)",
    "Постоянные итого",
    "Прибыль/мес",
    "Маржа %",
]
for i, h in enumerate(headers, 1):
    c = ws3.cell(row=row, column=i, value=h)
    style_header(c)
row += 1

# Сценарии: число клиентов → надбавки на инфру и ФОТ (отдельные input-ячейки)
# Базовое — 0 надбавки. На больших масштабах — растут.
scenarios = [
    (10, 0, 0),           # текущая инфра, ничего не докупаем
    (53, 0, 0),           # ТОЧКА БЕЗУБЫТОЧНОСТИ
    (75, 0, 0),           # текущая инфра ещё тянет, прибыль уверенная
    (100, 500, 0),        # переход прода на тариф Beget 4 (990 вместо 510), команда та же
    (150, 1500, 30000),   # тариф 5 + 1 доп. спец
    (250, 3500, 60000),   # тариф 6 + отдельный VPS под БД, команда 3 чел
    (500, 17000, 150000), # тариф 7 + managed PG, команда 4-5 чел
    (1000, 50000, 300000),# cloud (Yandex/Selectel), команда 7-8
]

scen_first = row
for clients, infra_extra, fot_extra in scenarios:
    # A: клиенты (input)
    c = ws3.cell(row=row, column=1, value=clients)
    c.number_format = INT_FMT
    style_input(c)
    # B: выручка = клиенты × ARPU
    f_revenue = f"=A{row}*{PARAMS['arpu']}"
    c = ws3.cell(row=row, column=2, value=f_revenue)
    c.number_format = MONEY_FMT
    style_cell(c)
    # C: переменные расходы = выручка × % переменных
    f_var = f"=B{row}*{PARAMS['var_total']}"
    c = ws3.cell(row=row, column=3, value=f_var)
    c.number_format = MONEY_FMT
    style_cell(c)
    # D: надбавка к инфре (input)
    c = ws3.cell(row=row, column=4, value=infra_extra)
    c.number_format = MONEY_FMT
    style_input(c)
    # E: надбавка к ФОТ (input)
    c = ws3.cell(row=row, column=5, value=fot_extra)
    c.number_format = MONEY_FMT
    style_input(c)
    # F: постоянные итого = базовые постоянные + надбавки
    f_fixed = f"={PARAMS['fixed_total']}+D{row}+E{row}"
    c = ws3.cell(row=row, column=6, value=f_fixed)
    c.number_format = MONEY_FMT
    style_cell(c)
    # G: прибыль = выручка - переменные - постоянные
    f_profit = f"=B{row}-C{row}-F{row}"
    c = ws3.cell(row=row, column=7, value=f_profit)
    c.number_format = MONEY_FMT
    style_cell(c)
    # H: маржа = прибыль / выручка
    f_margin = f"=IFERROR(G{row}/B{row},0)"
    c = ws3.cell(row=row, column=8, value=f_margin)
    c.number_format = PERCENT_FMT
    style_cell(c)
    row += 1

autosize(ws3, [12, 18, 18, 22, 22, 22, 18, 12])

# ============================================================
# ЛИСТ 4: ТОЧКА БЕЗУБЫТОЧНОСТИ
# ============================================================
ws4 = wb.create_sheet("Безубыточность")

ws4["A1"] = "РАСЧЁТ ТОЧКИ БЕЗУБЫТОЧНОСТИ"
ws4["A1"].font = Font(bold=True, size=14, color="25455D")
ws4.merge_cells("A1:C1")

ws4["A2"] = "При каком числе клиентов выручка покрывает все постоянные + переменные расходы"
ws4["A2"].font = Font(italic=True, size=10, color="666666")
ws4.merge_cells("A2:C2")

row = 4
items = [
    ("Постоянные расходы, ₽/мес", f"={PARAMS['fixed_total']}", MONEY_FMT, "Из листа Параметры"),
    ("Средний ARPU, ₽/мес", f"={PARAMS['arpu']}", MONEY_FMT, "Из листа Тарифы"),
    ("Доля переменных расходов", f"={PARAMS['var_total']}", PERCENT_FMT, "Налог + эквайринг + партнёры"),
    ("Чистая маржа на 1 клиента", None, MONEY_FMT, "ARPU × (1 − переменные)"),
    ("ТОЧКА БЕЗУБЫТОЧНОСТИ (клиентов)", None, INT_FMT, "Постоянные ÷ маржа на клиента"),
    ("Минимальная выручка для безубыточности", None, MONEY_FMT, "Клиенты × ARPU"),
]

bep_rows = {}
for i, (label, formula, fmt, comment) in enumerate(items):
    ws4.cell(row=row, column=1, value=label)
    style_cell(ws4.cell(row=row, column=1))
    if formula:
        c = ws4.cell(row=row, column=2, value=formula)
    elif label.startswith("Чистая маржа"):
        c = ws4.cell(row=row, column=2, value=f"=B{bep_rows['arpu']}*(1-B{bep_rows['var']})")
        bep_rows["margin"] = row
    elif label.startswith("ТОЧКА"):
        c = ws4.cell(row=row, column=2, value=f"=ROUNDUP(B{bep_rows['fixed']}/B{bep_rows['margin']},0)")
        bep_rows["bep"] = row
    elif label.startswith("Минимальная выручка"):
        c = ws4.cell(row=row, column=2, value=f"=B{bep_rows['bep']}*B{bep_rows['arpu']}")
    c.number_format = fmt
    style_cell(c)
    if "ТОЧКА" in label or "Минимальная" in label:
        style_total(ws4.cell(row=row, column=1))
        style_total(c)
    ws4.cell(row=row, column=3, value=comment)
    style_cell(ws4.cell(row=row, column=3))

    # Запоминаем ключевые строки
    if "Постоянные" in label and "расходы" in label:
        bep_rows["fixed"] = row
    elif "ARPU" in label:
        bep_rows["arpu"] = row
    elif "переменных" in label:
        bep_rows["var"] = row
    row += 1

autosize(ws4, [42, 22, 50])

# ============================================================
# ЛИСТ 5: СЕБЕСТОИМОСТЬ КЛИЕНТА (инфра на одного)
# ============================================================
ws5 = wb.create_sheet("Себестоимость клиента")

ws5["A1"] = "СЕБЕСТОИМОСТЬ ОДНОГО КЛИЕНТА (инфра-расходы)"
ws5["A1"].font = Font(bold=True, size=14, color="25455D")
ws5.merge_cells("A1:F1")

ws5["A2"] = "Сколько ПЛЮСОН тратит на инфру в зависимости от размера клиента"
ws5["A2"].font = Font(italic=True, size=10, color="666666")
ws5.merge_cells("A2:F2")

row = 4
headers = ["Размер клиента", "Контактов", "Файлы (МБ)", "R2 ₽/мес", "Доля CPU/RAM ₽/мес", "Итого ₽/мес"]
for i, h in enumerate(headers, 1):
    c = ws5.cell(row=row, column=i, value=h)
    style_header(c)
row += 1

# Параметры R2: $0.015/ГБ × курс
ws5.cell(row=row + 100, column=1, value="").value = ""  # placeholder

# Курс доллара и тариф R2 — input на листе
ws5.cell(row=20, column=1, value="Параметры (input)")
ws5.cell(row=20, column=1).font = Font(bold=True)

ws5.cell(row=21, column=1, value="Курс USD → RUB")
c_rate = ws5.cell(row=21, column=2, value=95)
c_rate.number_format = '#,##0.00'
style_input(c_rate)
rate_ref = "$B$21"

ws5.cell(row=22, column=1, value="Тариф R2 за ГБ хранения, $/мес")
c_r2 = ws5.cell(row=22, column=2, value=0.015)
c_r2.number_format = '#,##0.0000'
style_input(c_r2)
r2_ref = "$B$22"

# Размеры клиентов
sizes = [
    ("Микро",   500,    50,   0.5),  # доля CPU/RAM в ₽: оценка
    ("Малый",   3000,   200,  3),
    ("Средний", 15000,  1000, 15),
    ("Крупный", 50000,  5000, 80),
    ("Огромный",150000, 20000,400),
]

cost_first = row
for label, contacts, files_mb, cpu_cost in sizes:
    ws5.cell(row=row, column=1, value=label)
    style_cell(ws5.cell(row=row, column=1))
    c = ws5.cell(row=row, column=2, value=contacts)
    c.number_format = INT_FMT
    style_input(c)
    c = ws5.cell(row=row, column=3, value=files_mb)
    c.number_format = INT_FMT
    style_input(c)
    # R2 ₽/мес = (МБ/1024) × тариф_$ × курс
    f_r2 = f"=(C{row}/1024)*{r2_ref}*{rate_ref}"
    c = ws5.cell(row=row, column=4, value=f_r2)
    c.number_format = MONEY_FMT
    style_cell(c)
    # Доля CPU/RAM (input — экспертная оценка)
    c = ws5.cell(row=row, column=5, value=cpu_cost)
    c.number_format = MONEY_FMT
    style_input(c)
    # Итого
    f_total = f"=D{row}+E{row}"
    c = ws5.cell(row=row, column=6, value=f_total)
    c.number_format = MONEY_FMT
    style_total(c)
    row += 1

autosize(ws5, [18, 14, 14, 16, 22, 16])

# ============================================================
# ЛИСТ 6: ТАРИФЫ BEGET VPS (справочник)
# ============================================================
ws_beg = wb.create_sheet("Тарифы Beget VPS")

ws_beg["A1"] = "СПРАВОЧНИК ТАРИФОВ BEGET VPS"
ws_beg["A1"].font = Font(bold=True, size=14, color="25455D")
ws_beg.merge_cells("A1:G1")

ws_beg["A2"] = "Источник: https://beget.com/ru/vps. Цены округлены, проверять перед покупкой."
ws_beg["A2"].font = Font(italic=True, size=10, color="666666")
ws_beg.merge_cells("A2:G2")

row = 4
headers = ["Тариф", "CPU", "RAM, ГБ", "SSD/NVMe, ГБ", "Цена, ₽/мес", "Где используется сейчас", "Когда переходить"]
for i, h in enumerate(headers, 1):
    c = ws_beg.cell(row=row, column=i, value=h)
    style_header(c)
row += 1

beget_tariffs = [
    ("Тариф 1", 1, 1, 10, 330, "DEV (62.113.98.30)", "—"),
    ("Тариф 2", 1, 2, 15, 510, "ПРОД (194.156.119.17)", "—"),
    ("Тариф 3", 2, 2, 30, 810, "—", "Под Celery worker / отдельный сервис"),
    ("Тариф 4", 2, 4, 40, 990, "—", "Прод при 100+ клиентах ИЛИ под БД"),
    ("Тариф 5", 4, 6, 80, 2040, "—", "Прод при 150-200 клиентах"),
    ("Тариф 6", 6, 12, 150, 3600, "—", "Прод при 200-400 клиентах"),
    ("Тариф 7", 8, 16, 220, 5490, "—", "Прод при 400-700 клиентах (потолок Beget)"),
    ("Cloud", "—", "—", "—", "от 15000", "—", "При 500+ клиентах (Yandex Cloud / Selectel managed)"),
]

for tariff_data in beget_tariffs:
    label, cpu, ram, ssd, price, current, when = tariff_data
    ws_beg.cell(row=row, column=1, value=label).font = Font(bold=True)
    ws_beg.cell(row=row, column=2, value=cpu)
    ws_beg.cell(row=row, column=3, value=ram)
    ws_beg.cell(row=row, column=4, value=ssd)
    c = ws_beg.cell(row=row, column=5, value=price)
    if isinstance(price, (int, float)):
        c.number_format = MONEY_FMT
    ws_beg.cell(row=row, column=6, value=current)
    ws_beg.cell(row=row, column=7, value=when)
    for col in range(1, 8):
        style_cell(ws_beg.cell(row=row, column=col))
    # Подсветим текущие тарифы
    if "DEV" in current or "ПРОД" in current:
        for col in range(1, 8):
            ws_beg.cell(row=row, column=col).fill = TOTAL_FILL
    row += 1

row += 2
ws_beg.cell(row=row, column=1, value="ЛОГИКА МАСШТАБИРОВАНИЯ").font = Font(bold=True, size=12, color="25455D")
ws_beg.merge_cells(start_row=row, start_column=1, end_row=row, end_column=7)
row += 2

scaling_logic = [
    ("До 50 клиентов", "Текущий тариф 2 (510₽) тянет. PostgreSQL + FastAPI + Next.js + Mini App + Redis + Celery — впритык, но работает."),
    ("50-100 клиентов", "Прод → тариф 4 (990₽, 4 ГБ RAM). Экономим на одном Beget-сервере, БД ещё рядом."),
    ("100-200 клиентов", "Прод → тариф 5 (2040₽, 6 ГБ). Опционально вынести БД на отдельный VPS (тариф 3 = 810₽). Итого ~2850₽/мес."),
    ("200-400 клиентов", "Прод → тариф 6 (3600₽, 12 ГБ). БД отдельно (тариф 4 = 990₽). Celery отдельно (тариф 3 = 810₽). Итого ~5400₽/мес."),
    ("400-700 клиентов", "Прод → тариф 7 (5490₽, 16 ГБ — это потолок Beget). БД на тарифе 4-5. Celery cluster из 2-3 VPS. Итого ~10000-12000₽/мес."),
    ("700+ клиентов", "Beget уже мал. Переезд на Yandex Cloud / Selectel managed PostgreSQL + S3-совместимое хранилище. От 30 000-50 000 ₽/мес."),
]

for stage, desc in scaling_logic:
    c = ws_beg.cell(row=row, column=1, value=stage)
    c.font = Font(bold=True)
    style_cell(c)
    c = ws_beg.cell(row=row, column=2, value=desc)
    c.alignment = Alignment(wrap_text=True, vertical="top")
    style_cell(c)
    ws_beg.merge_cells(start_row=row, start_column=2, end_row=row, end_column=7)
    ws_beg.row_dimensions[row].height = 35
    row += 1

autosize(ws_beg, [16, 8, 10, 14, 14, 28, 50])

# ============================================================
# ЛИСТ 7: ИНСТРУКЦИЯ
# ============================================================
ws6 = wb.create_sheet("Как пользоваться", 0)

ws6["A1"] = "ФИНАНСОВАЯ МОДЕЛЬ ПЛЮСОН — инструкция"
ws6["A1"].font = Font(bold=True, size=14, color="25455D")
ws6.merge_cells("A1:B1")

instructions = [
    ("", ""),
    ("Что это", "Финмодель сервиса ПЛЮСОН с тарифами, расходами, точкой безубыточности"),
    ("", ""),
    ("Принцип", "Все ИТОГИ — формулы. Меняешь любой синий input — пересчитывается всё"),
    ("", ""),
    ("Голубые ячейки", "Редактируемые входные параметры (цены, расходы, доли тарифов)"),
    ("Жёлтые ячейки", "Заголовки разделов"),
    ("Светло-оранжевые", "Итоговые суммы и ключевые цифры (формулы)"),
    ("Синие ячейки", "Заголовки таблиц"),
    ("", ""),
    ("Листы", ""),
    ("1. Параметры", "Все вводные: цены тарифов, доли в портфеле, статьи расходов"),
    ("2. Тарифы", "Структура тарифов + расчёт среднего ARPU и маржи на клиента"),
    ("3. Сценарии роста", "P&L при 10/24/50/100/200/300/500/1000 клиентов"),
    ("4. Безубыточность", "Расчёт минимального числа клиентов"),
    ("5. Себестоимость клиента", "Сколько стоит один клиент в инфре"),
    ("6. Тарифы Beget VPS", "Справочник всех 7 тарифов Beget — куда расти"),
    ("", ""),
    ("С чего начать", "Открой лист «Параметры» и проверь цены/расходы. Поменяешь — всё пересчитается"),
    ("", ""),
    ("Ключевые формулы", ""),
    ("ARPU", "= цена×доля по каждому тарифу, сумма по трём тарифам"),
    ("Маржа на клиенте", "= ARPU × (1 − переменные расходы)"),
    ("Точка безубыточности", "= постоянные расходы ÷ маржа на клиенте"),
    ("Прибыль (сценарий)", "= клиентов × ARPU − переменные − постоянные − надбавки на масштаб"),
]

row = 2
for label, value in instructions:
    if label == "" and value == "":
        row += 1
        continue
    if value == "":
        c = ws6.cell(row=row, column=1, value=label)
        c.font = Font(bold=True, size=11, color="25455D")
        ws6.merge_cells(start_row=row, start_column=1, end_row=row, end_column=2)
    else:
        ws6.cell(row=row, column=1, value=label).font = Font(bold=True)
        ws6.cell(row=row, column=2, value=value)
    row += 1

autosize(ws6, [22, 70])

# Сохранение
wb.save(OUT_PATH)
print(f"OK: {OUT_PATH}")
