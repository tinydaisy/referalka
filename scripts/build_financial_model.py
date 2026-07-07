"""
Генератор финансовой модели ПЛЮСОН в Excel (редакция 2026-07-01).
Все итоговые ячейки — формулы, не статичные числа.
Запуск: python3 scripts/build_financial_model.py
Результат: financial_model.xlsx в корне проекта

Актуальные вводные (правила пользователя):
- Тарифы из БД: Профи 1990 ₽, Экстра 2990 ₽. Аддон Коллабораторная 1000 ₽.
- Сценарий портфеля: 90% Профи+Коллабораторная (2990), 10% Профи (1990). ARPU = 2890 ₽.
- Сервер: 1000 ₽/мес (Beget 4 ГБ). Маркетинг: 0 на старте (вводим позже).
- Сотрудник: 30 000 ₽/мес в мес 1-3, 50 000 ₽/мес с мес 4.
- Налог СТУПЕНЧАТЫЙ: 4% (НПД) пока годовая выручка ≤ 2.4 млн ₽ → 6% (УСН) после.
- Эквайринг СТУПЕНЧАТЫЙ: 0% пока накопленный оборот ≤ 150 000 ₽ → 2.9% после.
- Партнёрка: 10% всегда.
- Цель: чистая прибыль 500 000 ₽/мес.
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
GOAL_FILL = PatternFill("solid", fgColor="D6F5D6")
THIN = Side(border_style="thin", color="999999")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

MONEY_FMT = '#,##0 "₽"'
PERCENT_FMT = '0.0%'
INT_FMT = '#,##0'


def style_header(cell):
    cell.fill = HEADER_FILL
    cell.font = HEADER_FONT
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
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


wb = Workbook()

# ============================================================
# ЛИСТ: ПАРАМЕТРЫ
# ============================================================
ws = wb.active
ws.title = "Параметры"

ws["A1"] = "ПАРАМЕТРЫ ФИНМОДЕЛИ ПЛЮСОН (2026-07-01)"
ws["A1"].font = Font(bold=True, size=14, color="25455D")
ws.merge_cells("A1:C1")
ws["A2"] = "Голубые ячейки — редактируемые входные параметры. Остальное считается формулами."
ws["A2"].font = Font(italic=True, size=10, color="666666")
ws.merge_cells("A2:C2")

P = {}  # ссылки на именованные ячейки
row = 4


def section(title):
    global row
    ws.cell(row=row, column=1, value=title)
    style_subheader(ws.cell(row=row, column=1))
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=3)
    row += 1
    ws.cell(row=row, column=1, value="Параметр")
    ws.cell(row=row, column=2, value="Значение")
    ws.cell(row=row, column=3, value="Комментарий")
    for c in range(1, 4):
        style_header(ws.cell(row=row, column=c))
    row += 1


def param(key, label, value, fmt, comment):
    global row
    ws.cell(row=row, column=1, value=label)
    style_cell(ws.cell(row=row, column=1))
    c = ws.cell(row=row, column=2, value=value)
    c.number_format = fmt
    style_input(c)
    ws.cell(row=row, column=3, value=comment)
    style_cell(ws.cell(row=row, column=3))
    P[key] = f"Параметры!$B${row}"
    row += 1


section("ЦЕНЫ И ПОРТФЕЛЬ КЛИЕНТОВ")
param("price_pro", "Профи, ₽/мес", 1990, MONEY_FMT, "Тариф pro из БД")
param("price_collab", "Аддон Коллабораторная, ₽/мес", 1000, MONEY_FMT, "Модуль-аддон collab_hub")
param("share_full", "Доля 'Профи+Коллаборатор.'", 0.9, PERCENT_FMT, "90% берут аддон")
param("share_pro_only", "Доля 'только Профи'", 0.1, PERCENT_FMT, "10% без аддона")
# ARPU
ws.cell(row=row, column=1, value="ARPU средний, ₽/мес")
c = ws.cell(row=row, column=2,
            value=f"=({P['price_pro']}+{P['price_collab']})*{P['share_full']}+{P['price_pro']}*{P['share_pro_only']}")
c.number_format = MONEY_FMT
style_total(ws.cell(row=row, column=1)); style_total(c)
P["arpu"] = f"Параметры!$B${row}"
ws.cell(row=row, column=3, value="Средний чек на клиента (формула)")
style_cell(ws.cell(row=row, column=3))
row += 2

section("ПОСТОЯННЫЕ РАСХОДЫ, ₽/мес")
param("server", "Сервер (Beget 4ГБ + R2 + домены)", 1000, MONEY_FMT, "194.156.119.17")
param("staff_1_3", "Сотрудник, мес 1-3", 30000, MONEY_FMT, "Один человек, старт")
param("staff_4plus", "Сотрудник, мес 4+", 50000, MONEY_FMT, "Повышение с 4-го месяца")
param("marketing", "Маркетинг (вводим позже)", 0, MONEY_FMT, "0 на старте, включить когда прибыль стабильна")
row += 1

section("ПЕРЕМЕННЫЕ РАСХОДЫ (% с выручки)")
param("tax_low", "Налог НПД (до лимита)", 0.04, PERCENT_FMT, "4% пока годовая выручка ≤ лимита НПД")
param("tax_high", "Налог УСН (после лимита)", 0.06, PERCENT_FMT, "6% после превышения лимита НПД")
param("npd_limit", "Лимит НПД, ₽/год", 2400000, MONEY_FMT, "Порог самозанятости — 2.4 млн ₽/год")
param("acq_rate", "Эквайринг (после порога)", 0.029, PERCENT_FMT, "2.9% после первых 150к оборота")
param("acq_free", "Беспроцентный оборот, ₽", 150000, MONEY_FMT, "Первые 150к оборота — эквайринг 0%")
param("partner", "Партнёрская программа", 0.10, PERCENT_FMT, "10% пожизненно с платежа приведённого клиента")
row += 1

section("ЦЕЛЬ")
param("goal_profit", "Целевая чистая прибыль, ₽/мес", 500000, MONEY_FMT, "Когда достигаем этой прибыли")

autosize(ws, [40, 20, 52])

# ============================================================
# ЛИСТ: ПОМЕСЯЧНАЯ МОДЕЛЬ ПЕРВОГО ГОДА
# ============================================================
wm = wb.create_sheet("Год по месяцам")
wm["A1"] = "ПЕРВЫЙ ГОД ПО МЕСЯЦАМ"
wm["A1"].font = Font(bold=True, size=14, color="25455D")
wm.merge_cells("A1:J1")
wm["A2"] = ("Голубой столбец 'Клиентов' — редактируемый прогноз набора базы. "
            "Налог и эквайринг переключаются формулами по порогам. Сотрудник 30к (мес1-3) / 50к (мес4+).")
wm["A2"].font = Font(italic=True, size=10, color="666666")
wm.merge_cells("A2:J2")

row = 4
headers = ["Месяц", "Клиентов\n(накоплено)", "Выручка", "Оборот с\nначала", "Налог\n%",
           "Эквайр.\n%", "Перем.\nрасходы", "Постоянные", "Прибыль\nмесяца", "Прибыль\nнакопл."]
for i, h in enumerate(headers, 1):
    style_header(wm.cell(row=row, column=i, value=h))
row += 1

# прогноз набора клиентов по месяцам (input, голубой) — консервативный органический рост
clients_forecast = [10, 20, 32, 45, 60, 78, 98, 120, 145, 172, 200, 230]
first = row
for m, cl in enumerate(clients_forecast, 1):
    r = row
    wm.cell(row=r, column=1, value=f"Мес {m}")
    style_cell(wm.cell(row=r, column=1))
    # клиенты (input)
    c = wm.cell(row=r, column=2, value=cl); c.number_format = INT_FMT; style_input(c)
    # выручка = клиенты × ARPU
    c = wm.cell(row=r, column=3, value=f"=B{r}*{P['arpu']}"); c.number_format = MONEY_FMT; style_cell(c)
    # оборот с начала года (накопительно)
    if m == 1:
        c = wm.cell(row=r, column=4, value=f"=C{r}")
    else:
        c = wm.cell(row=r, column=4, value=f"=D{r-1}+C{r}")
    c.number_format = MONEY_FMT; style_cell(c)
    # налог %: если накопл. годовой оборот > лимит НПД → высокий, иначе низкий
    c = wm.cell(row=r, column=5, value=f"=IF(D{r}>{P['npd_limit']},{P['tax_high']},{P['tax_low']})")
    c.number_format = PERCENT_FMT; style_cell(c)
    # эквайринг %: если оборот с начала > беспроцентный порог → ставка, иначе 0
    c = wm.cell(row=r, column=6, value=f"=IF(D{r}>{P['acq_free']},{P['acq_rate']},0)")
    c.number_format = PERCENT_FMT; style_cell(c)
    # переменные расходы = выручка × (налог% + эквайр% + партнёрка%)
    c = wm.cell(row=r, column=7, value=f"=C{r}*(E{r}+F{r}+{P['partner']})")
    c.number_format = MONEY_FMT; style_cell(c)
    # постоянные = сервер + сотрудник(по месяцу) + маркетинг
    staff = P['staff_1_3'] if m <= 3 else P['staff_4plus']
    c = wm.cell(row=r, column=8, value=f"={P['server']}+{staff}+{P['marketing']}")
    c.number_format = MONEY_FMT; style_cell(c)
    # прибыль месяца
    c = wm.cell(row=r, column=9, value=f"=C{r}-G{r}-H{r}")
    c.number_format = MONEY_FMT; style_cell(c)
    # прибыль накопленная
    if m == 1:
        c = wm.cell(row=r, column=10, value=f"=I{r}")
    else:
        c = wm.cell(row=r, column=10, value=f"=J{r-1}+I{r}")
    c.number_format = MONEY_FMT; style_total(c)
    row += 1

autosize(wm, [8, 12, 14, 14, 9, 9, 14, 14, 14, 15])
wm.row_dimensions[4].height = 42

# ============================================================
# ЛИСТ: СЦЕНАРИИ ПО ЧИСЛУ КЛИЕНТОВ + ЦЕЛЬ 500К
# ============================================================
ws3 = wb.create_sheet("Сценарии и цель")
ws3["A1"] = "СЦЕНАРИИ ПО ЧИСЛУ КЛИЕНТОВ"
ws3["A1"].font = Font(bold=True, size=14, color="25455D")
ws3.merge_cells("A1:G1")
ws3["A2"] = "Постоянка взята для фазы 'сотрудник 50к'. Налог/эквайринг — установившиеся ставки для этого масштаба."
ws3["A2"].font = Font(italic=True, size=10, color="666666")
ws3.merge_cells("A2:G2")

row = 4
headers = ["Клиентов", "Выручка/мес", "Перем.\nрасходы", "Постоянные", "Прибыль/мес", "Прибыль/год", "Маржа %"]
for i, h in enumerate(headers, 1):
    style_header(ws3.cell(row=row, column=i, value=h))
row += 1

# фикс постоянка для сценариев = сервер + сотрудник 50к
fixed_ref = f"({P['server']}+{P['staff_4plus']}+{P['marketing']})"

scen = [22, 50, 70, 100, 150, 200, 230, 235, 250, 300]
for cl in scen:
    r = row
    c = ws3.cell(row=r, column=1, value=cl); c.number_format = INT_FMT; style_input(c)
    # выручка
    c = ws3.cell(row=r, column=2, value=f"=A{r}*{P['arpu']}"); c.number_format = MONEY_FMT; style_cell(c)
    # налог: годовая выручка = выручка×12; если > лимит → 6% иначе 4%
    tax = f"IF(B{r}*12>{P['npd_limit']},{P['tax_high']},{P['tax_low']})"
    # эквайринг на этом масштабе всегда после порога → полная ставка
    var = f"=B{r}*({tax}+{P['acq_rate']}+{P['partner']})"
    c = ws3.cell(row=r, column=3, value=var); c.number_format = MONEY_FMT; style_cell(c)
    # постоянные
    c = ws3.cell(row=r, column=4, value=f"={fixed_ref}"); c.number_format = MONEY_FMT; style_cell(c)
    # прибыль/мес
    c = ws3.cell(row=r, column=5, value=f"=B{r}-C{r}-D{r}"); c.number_format = MONEY_FMT
    # подсветить достижение цели
    if cl in (230, 235):
        style_total(ws3.cell(row=r, column=1))
        for col in range(1, 8):
            ws3.cell(row=r, column=col).fill = GOAL_FILL
    style_cell(c)
    # прибыль/год
    c = ws3.cell(row=r, column=6, value=f"=E{r}*12"); c.number_format = MONEY_FMT; style_cell(c)
    # маржа
    c = ws3.cell(row=r, column=7, value=f"=IFERROR(E{r}/B{r},0)"); c.number_format = PERCENT_FMT; style_cell(c)
    row += 1

row += 2
ws3.cell(row=row, column=1, value="РАСЧЁТ: СКОЛЬКО КЛИЕНТОВ ДО ЦЕЛИ").font = Font(bold=True, size=12, color="25455D")
ws3.merge_cells(start_row=row, start_column=1, end_row=row, end_column=7)
row += 1
ws3.cell(row=row, column=1, value="Параметр"); ws3.cell(row=row, column=2, value="Значение")
for c in (1, 2):
    style_header(ws3.cell(row=row, column=c))
row += 1

# маржа с клиента при установившемся режиме (налог 6%, эквайринг 2.9%, партнёрка 10% = 18.9%)
ws3.cell(row=row, column=1, value="Переменные (устоявшиеся): налог 6% + эквайр 2.9% + партнёрка 10%")
c = ws3.cell(row=row, column=2, value=f"={P['tax_high']}+{P['acq_rate']}+{P['partner']}")
c.number_format = PERCENT_FMT; style_cell(ws3.cell(row=row, column=1)); style_cell(c)
var_row = row; row += 1

ws3.cell(row=row, column=1, value="Маржа с 1 клиента, ₽/мес")
c = ws3.cell(row=row, column=2, value=f"={P['arpu']}*(1-B{var_row})")
c.number_format = MONEY_FMT; style_cell(ws3.cell(row=row, column=1)); style_cell(c)
margin_row = row; row += 1

ws3.cell(row=row, column=1, value="Постоянные (сервер + сотрудник 50к), ₽/мес")
c = ws3.cell(row=row, column=2, value=f"={fixed_ref}")
c.number_format = MONEY_FMT; style_cell(ws3.cell(row=row, column=1)); style_cell(c)
fix_row = row; row += 1

ws3.cell(row=row, column=1, value="КЛИЕНТОВ ДО ЦЕЛИ 500 000 ₽/мес")
c = ws3.cell(row=row, column=2, value=f"=ROUNDUP(({P['goal_profit']}+B{fix_row})/B{margin_row},0)")
c.number_format = INT_FMT
style_total(ws3.cell(row=row, column=1)); style_total(c)
ws3.cell(row=row, column=1).fill = GOAL_FILL; c.fill = GOAL_FILL
row += 1

ws3.cell(row=row, column=1, value="Выручка при этом, ₽/мес")
goal_clients_row = row - 1
c = ws3.cell(row=row, column=2, value=f"=B{goal_clients_row}*{P['arpu']}")
c.number_format = MONEY_FMT; style_cell(ws3.cell(row=row, column=1)); style_cell(c)

autosize(ws3, [46, 18, 14, 14, 14, 16, 10])

# ============================================================
# ЛИСТ: BEGET VPS (справочник масштабирования)
# ============================================================
wb_ = wb.create_sheet("Сервер Beget")
wb_["A1"] = "СЕРВЕР: ТЕКУЩИЙ ТАРИФ И КОГДА РАСШИРЯТЬ"
wb_["A1"].font = Font(bold=True, size=14, color="25455D")
wb_.merge_cells("A1:F1")

row = 3
for i, h in enumerate(["Клиентов", "Конфигурация Beget", "RAM", "Цена ₽/мес", "% от выручки", "Триггер"], 1):
    style_header(wb_.cell(row=row, column=i, value=h))
row += 1

server_rows = [
    ("сейчас ✅", "Тариф 4: 2 CPU / 40 ГБ (ТЕКУЩИЙ)", "4 ГБ", 1000, "~1%", "RAM-проблема решена, build не падает"),
    ("до 100-150", "Тариф 4 тянет", "4 ГБ", 1000, "0.5%", "Запас есть, ничего не менять"),
    ("150-250", "Тариф 5 + БД на отдельный VPS", "6 ГБ", 3700, "0.5%", "Когда RAM 4ГБ кончится, БД конкурирует за память"),
    ("250-400", "Тариф 6 + БД + Celery отдельно", "12 ГБ", 5800, "0.4%", "Один сервер не тянет всё"),
    ("400-700", "Тариф 7 + кластер + LB", "16 ГБ", 11000, "0.4%", "Потолок Beget"),
    ("700+", "Yandex Cloud / Selectel managed", "—", 30000, "0.7%", "Beget мал, переезд в облако"),
]
for cl, cfg, ram, price, pct, trig in server_rows:
    r = row
    wb_.cell(row=r, column=1, value=cl); wb_.cell(row=r, column=2, value=cfg)
    wb_.cell(row=r, column=3, value=ram)
    c = wb_.cell(row=r, column=4, value=price); c.number_format = MONEY_FMT
    wb_.cell(row=r, column=5, value=pct); wb_.cell(row=r, column=6, value=trig)
    for col in range(1, 7):
        style_cell(wb_.cell(row=r, column=col))
        wb_.cell(row=r, column=col).alignment = Alignment(wrap_text=True, vertical="top")
    if "сейчас" in cl:
        for col in range(1, 7):
            wb_.cell(row=r, column=col).fill = GOAL_FILL
    wb_.row_dimensions[r].height = 32
    row += 1

autosize(wb_, [12, 34, 8, 12, 12, 42])

# ============================================================
# ЛИСТ: ИНСТРУКЦИЯ (первым)
# ============================================================
wi = wb.create_sheet("Как пользоваться", 0)
wi["A1"] = "ФИНМОДЕЛЬ ПЛЮСОН — как пользоваться"
wi["A1"].font = Font(bold=True, size=14, color="25455D")
wi.merge_cells("A1:B1")

lines = [
    ("", ""),
    ("Принцип", "Все ИТОГИ — формулы. Меняешь любой ГОЛУБОЙ input — всё пересчитывается."),
    ("", ""),
    ("Цвета", ""),
    ("Голубые ячейки", "Редактируемые вводные (цены, доли, расходы, прогноз клиентов)"),
    ("Жёлтые", "Заголовки разделов"),
    ("Светло-оранжевые", "Ключевые итоги (формулы)"),
    ("Зелёные", "Достижение цели 500к / текущий сервер"),
    ("", ""),
    ("Листы", ""),
    ("1. Параметры", "Все вводные в одном месте: цены, портфель, расходы, ставки, пороги, цель"),
    ("2. Год по месяцам", "Первый год помесячно. Налог 4%→6% и эквайринг 0%→2.9% переключаются сами по порогам"),
    ("3. Сценарии и цель", "Прибыль по числу клиентов + расчёт: сколько клиентов до 500к/мес"),
    ("4. Сервер Beget", "Текущий тариф и когда расширять по числу клиентов"),
    ("", ""),
    ("ГЛАВНЫЕ ЦИФРЫ (на текущих вводных)", ""),
    ("ARPU", "2 890 ₽/мес (90% Профи+Коллаборатор. 2990, 10% Профи 1990)"),
    ("Постоянка старт (мес1-3)", "31 000 ₽ (сервер 1000 + сотрудник 30к)"),
    ("Постоянка (мес4+)", "51 000 ₽ (сервер 1000 + сотрудник 50к)"),
    ("Безубыточность", "13 клиентов (мес1-3) / 22 клиента (мес4+)"),
    ("Цель 500 000 ₽/мес", "≈ 235 клиентов (устоявшийся режим: налог 6% + эквайр 2.9% + партнёрка 10%)"),
    ("", ""),
    ("ПОРОГИ (переключаются в формулах)", ""),
    ("Налог 4%→6%", "После 2.4 млн ₽ годовой выручки (≈70 клиентов). Лимит НПД."),
    ("Эквайринг 0%→2.9%", "После первых 150 000 ₽ оборота (пробивается на 1-2 месяце)"),
    ("Маркетинг", "0 на старте. Вводить ~на 35-40 клиентах из прибыли (поставить в 'Параметры')"),
]
r = 2
for label, value in lines:
    if label == "" and value == "":
        r += 1; continue
    if value == "":
        c = wi.cell(row=r, column=1, value=label)
        c.font = Font(bold=True, size=11, color="25455D")
        wi.merge_cells(start_row=r, start_column=1, end_row=r, end_column=2)
    else:
        wi.cell(row=r, column=1, value=label).font = Font(bold=True)
        wi.cell(row=r, column=2, value=value)
    r += 1
autosize(wi, [30, 74])

wb.save(OUT_PATH)
print(f"OK: {OUT_PATH}")
