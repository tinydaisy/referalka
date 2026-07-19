# -*- coding: utf-8 -*-
# спикеры: (name, ec)
S=[("Евгений Асхадулин",337),("Надежда Берлиба",333),("Татьяна Довгая",365),("Рогожина Ирина",343),
("Svetlana Kashaeva",348),("Елена Калиман",355),("Ольга Переверова",347),("Артемида Эпштейн",330),
("Марго Царская",350),("Марина Буза",357),("Наталья Фалеткина",344),("Ольга Самоленкова",361),
("Лилия Гришина",340),("Светлана Житкевич",351),("Ольга Завадская",335),("Ирина Рендаревская",338),
("Анна Шидловская",353),("Марина Николаева Ψ",331),("Нурия Карычева",342),("Ксения Морарь",336),
("Элла Тот",332)]
# жюри: name, ec, tg, early(до 13:00), live(сидит в эфире)
J=[("Ева Ротганг",189,"evarotgangidea",True,True),
("Полина Тараскина",167,"PTaraskina",True,True),
("Наталья Барвинская",171,"Natalya_Barvinskaya",False,True),
("Ольга Радкевич",168,"radkevichol",False,True),
("Александра Горбачева",246,"AleksaPozhar",False,True),
("Анастасия Котова",157,"stkotova_pro",False,True),
("Владислав Хорошилов",162,"HorosSekret",False,True),
("Анна Кулькова",242,"AnnaKulkovaPsi",False,True),
("Алексей Филиппов",192,"filippovsales",False,True),
("Валерия Бочарникова",188,"valeriiia22",False,True),
("Александр Скворцов",191,"Assesandr",False,True),
("Евгения Романовская",149,"evaromanovskaya",False,True),
("Хелен Даймонд",159,"helen_diamond",False,True),
("Алёна Мишурко",158,"alena_mishurko",False,True),
("Мария Башкатова",241,"mari_bash",False,False)]  # не в эфире
# конфликты: jury_ec -> {speaker_ec}
CONF={246:{361,335,353,338,365,333,357,347,351,355,343,331},155:{330},191:{340},241:{342},171:{348},167:{337}}

START=10*60; SLOT=10; BREAK=5; STEP=SLOT+BREAK
def hhmm(m): return f"{m//60:02d}:{m%60:02d}"

# --- ПОРЯДОК: Артемида последняя, Асхадулин ~13:30 ---
arte=[x for x in S if x[1]==330][0]
ash=[x for x in S if x[1]==337][0]
rest=[x for x in S if x[1] not in (330,337)]
# 21 слот, 4 блока 5/5/5/6, паузы по 10 мин после 5,10,15
# позиции слотов -> время
def build_times():
    t=START; times=[]; n=0
    for bi,size in enumerate([5,5,5,6]):
        for k in range(size):
            times.append(t); t+=STEP; n+=1
        if bi<3: t+=10
    return times
T=build_times()
# найти слот с началом 13:30 (или ближайший)
target=13*60+30
idx_ash=min(range(len(T)),key=lambda i:abs(T[i]-target))
order=[None]*21
order[idx_ash]=ash
order[20]=arte
ri=0
for i in range(21):
    if order[i] is None:
        order[i]=rest[ri]; ri+=1

BLOCKS=[5,5,5,6]
# группы по 4, Башкатова добавляется как 4-й "заочный" голос там где нужно
GR=[["Ева Ротганг","Наталья Барвинская","Ольга Радкевич","Алёна Мишурко"],
    ["Полина Тараскина","Анастасия Котова","Хелен Даймонд","Александра Горбачева"],
    ["Владислав Хорошилов","Анна Кулькова","Алексей Филиппов","Александра Горбачева"],
    ["Валерия Бочарникова","Александр Скворцов","Евгения Романовская","Мария Башкатова"]]
ECJ={j[0]:j[1] for j in J}; TG={j[0]:j[2] for j in J}; LIVE={j[0]:j[4] for j in J}

print("ПРОГРАММА 21 ИЮЛЯ — Соревновательные эфиры (7 мин выступление, 3 мин вопросы жюри)")
print("Старт 10:00 · слот 10 мин · перерыв 5 мин · 21 спикер\n")
i=0; load={}; problems=[]
for bi,size in enumerate(BLOCKS):
    grp=GR[bi]; sl=[]
    for k in range(size):
        sl.append((order[i],T[i])); i+=1
    live=[g for g in grp if LIVE[g]]
    print(f"БЛОК {bi+1} · {hhmm(sl[0][1])}–{hhmm(sl[-1][1]+SLOT)}")
    print(f"  ЖЮРИ: " + ", ".join(f"{g}" + ("" if LIVE[g] else " (заочно, по записи)") for g in grp))
    for (sp,st) in sl:
        bad=[g for g in grp if sp[1] in CONF.get(ECJ[g],set())]
        mark="  ⚠ КОНФЛИКТ: "+", ".join(bad) if bad else ""
        if bad: problems.append((sp[0],bad))
        print(f"     {hhmm(st)}–{hhmm(st+SLOT)}  {sp[0]}{mark}")
    for g in grp: load[g]=load.get(g,0)+size
    if bi<3: print(f"     ⏸ {hhmm(sl[-1][1]+STEP)}–{hhmm(sl[-1][1]+STEP+10)}  представление жюри / смена состава")
    print()
print("НАГРУЗКА:")
for n,c in sorted(load.items(),key=lambda x:-x[1]):
    print(f"  {n:<22} {c} спикеров ≈ {c*15//60}ч{c*15%60:02d}м" + ("" if LIVE[n] else "  (заочно)"))
if problems:
    print("\n⚠ КОНФЛИКТЫ (жюри оценивает своего приведённого):")
    for s,b in problems: print(f"   {s} ← {', '.join(b)}")
