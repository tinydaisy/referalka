# -*- coding: utf-8 -*-
import itertools, random
S=[("Евгений Асхадулин",337),("Надежда Берлиба",333),("Татьяна Довгая",365),("Рогожина Ирина",343),
("Svetlana Kashaeva",348),("Елена Калиман",355),("Ольга Переверова",347),("Артемида Эпштейн",330),
("Марго Царская",350),("Марина Буза",357),("Наталья Фалеткина",344),("Ольга Самоленкова",361),
("Лилия Гришина",340),("Светлана Житкевич",351),("Ольга Завадская",335),("Ирина Рендаревская",338),
("Анна Шидловская",353),("Марина Николаева Ψ",331),("Нурия Карычева",342),("Ксения Морарь",336),
("Элла Тот",332)]
LIVE={"Ева Ротганг":True,"Полина Тараскина":True,"Наталья Барвинская":True,"Ольга Радкевич":True,
"Александра Горбачева":True,"Анастасия Котова":True,"Владислав Хорошилов":True,"Анна Кулькова":True,
"Алексей Филиппов":True,"Валерия Бочарникова":True,"Александр Скворцов":True,"Евгения Романовская":True,
"Хелен Даймонд":True,"Алёна Мишурко":True,"Мария Башкатова":False}
ECJ={"Ева Ротганг":189,"Полина Тараскина":167,"Наталья Барвинская":171,"Ольга Радкевич":168,
"Александра Горбачева":246,"Анастасия Котова":157,"Владислав Хорошилов":162,"Анна Кулькова":242,
"Алексей Филиппов":192,"Валерия Бочарникова":188,"Александр Скворцов":191,"Евгения Романовская":149,
"Хелен Даймонд":159,"Алёна Мишурко":158,"Мария Башкатова":241}
TG={"Ева Ротганг":"evarotgangidea","Полина Тараскина":"PTaraskina","Наталья Барвинская":"Natalya_Barvinskaya",
"Ольга Радкевич":"radkevichol","Александра Горбачева":"AleksaPozhar","Анастасия Котова":"stkotova_pro",
"Владислав Хорошилов":"HorosSekret","Анна Кулькова":"AnnaKulkovaPsi","Алексей Филиппов":"filippovsales",
"Валерия Бочарникова":"valeriiia22","Александр Скворцов":"Assesandr","Евгения Романовская":"evaromanovskaya",
"Хелен Даймонд":"helen_diamond","Алёна Мишурко":"alena_mishurko","Мария Башкатова":"mari_bash"}
CONF={246:{361,335,353,338,365,333,357,347,351,355,343,331},191:{340},241:{342},171:{348},167:{337}}
START=10*60;SLOT=10;STEP=15
def hhmm(m):return f"{m//60:02d}:{m%60:02d}"
BLOCKS=[5,5,5,6]
def times():
    t=START;out=[]
    for bi,sz in enumerate(BLOCKS):
        for k in range(sz): out.append(t);t+=STEP
        if bi<3:t+=10
    return out
T=times()
# Горбачёву -> в блок 1 (там меньше всего её людей? проверим все расстановки групп)
GROUPS_BASE=[
 ["Ева Ротганг","Наталья Барвинская","Ольга Радкевич","Алёна Мишурко"],
 ["Полина Тараскина","Анастасия Котова","Хелен Даймонд","Мария Башкатова"],
 ["Владислав Хорошилов","Анна Кулькова","Алексей Филиппов","Александра Горбачева"],
 ["Валерия Бочарникова","Александр Скворцов","Евгения Романовская","Александра Горбачева"],
]
target=13*60+30
idx_ash=min(range(21),key=lambda i:abs(T[i]-target))
def conflicts(order,groups):
    bad=[];i=0
    for bi,sz in enumerate(BLOCKS):
        for k in range(sz):
            sp=order[i];i+=1
            for g in groups[bi]:
                if sp[1] in CONF.get(ECJ[g],set()): bad.append((sp[0],g))
    return bad
best=None
rnd=random.Random(7)
arte=[x for x in S if x[1]==330][0]; ash=[x for x in S if x[1]==337][0]
rest=[x for x in S if x[1] not in (330,337)]
for attempt in range(200000):
    r=rest[:]; rnd.shuffle(r)
    order=[None]*21; order[idx_ash]=ash; order[20]=arte
    ri=0
    for i in range(21):
        if order[i] is None: order[i]=r[ri]; ri+=1
    c=conflicts(order,GROUPS_BASE)
    if best is None or len(c)<len(best[1]):
        best=(order,c)
        if not c: break
order,c=best
print(f"Конфликтов: {len(c)}\n")
print("ПРОГРАММА 21 ИЮЛЯ — Соревновательные эфиры (7 мин выступление, 3 мин вопросы жюри)")
print("Старт 10:00 · слот 10 мин · перерыв 5 мин · 21 спикер · 4 жюри на каждого\n")
i=0;load={}
for bi,sz in enumerate(BLOCKS):
    grp=GROUPS_BASE[bi]; sl=[]
    for k in range(sz): sl.append((order[i],T[i]));i+=1
    print(f"БЛОК {bi+1} · {hhmm(sl[0][1])}–{hhmm(sl[-1][1]+SLOT)}")
    print("  ЖЮРИ: "+", ".join(f"{g} @{TG[g]}"+("" if LIVE[g] else " ⟨заочно, по записи⟩") for g in grp))
    for (sp,st) in sl: print(f"     {hhmm(st)}–{hhmm(st+SLOT)}   {sp[0]}")
    for g in grp: load[g]=load.get(g,0)+sz
    if bi<3: print(f"     ⏸ {hhmm(sl[-1][1]+STEP)}–{hhmm(sl[-1][1]+STEP+10)}   представление жюри / смена состава")
    print()
print("НАГРУЗКА:")
for n,cn in sorted(load.items(),key=lambda x:-x[1]):
    print(f"  {n:<22} {cn} спикеров ≈ {cn*15//60}ч{cn*15%60:02d}м"+("" if LIVE[n] else "  (заочно)"))
if c:
    print("\n⚠ ОСТАВШИЕСЯ КОНФЛИКТЫ:")
    for s,g in c: print(f"   {s} ← {g}")
