"""
Где у клиента управляется DNS — определяем по NS-записям домена.

Зачем: клиенту показывается «добавьте CNAME → pluson.ru», и дальше он один
на один с интерфейсом своего регистратора. Панели у всех разные, раздел
называется по-разному («Управление зоной», «DNS-записи», «Ресурсные записи»),
и половина обращений в поддержку — «а куда это вписывать». Зная NS, мы
показываем название его панели, прямую ссылку в нужный раздел и шаги именно
для неё.

⚠️ Автоматически прописать записи за клиента нельзя (разбор 2026-09-19).
У Reg.ru API авторизуется логином и паролем ОТ АККАУНТА — не токеном с
ограниченными правами: чтобы мы прописали запись, клиент должен отдать
доступ, которым можно и домен увести. Плюс белый список IP, который он всё
равно настраивает руками. OAuth/делегирования у российских регистраторов
нет, международный стандарт Domain Connect они не поддерживают. Поэтому
помогаем инструкцией, а не автоматикой.

⚠️ Сопоставляем по СУФФИКСУ имени NS, а не по точному совпадению: у одного
провайдера серверов несколько и нумерация меняется (ns1/ns2/ns3.reg.ru,
dns1/dns2.timeweb.ru). Точное совпадение пришлось бы дописывать после
каждого их изменения — и оно бы молча переставало срабатывать.
"""
from __future__ import annotations

from typing import Optional


class Provider:
    """Один DNS-хостер: как узнать и что показать клиенту."""

    def __init__(self, key: str, title: str, ns_suffixes: list[str],
                 panel_url: str, steps: list[str], note: str = ""):
        self.key = key                    # машинный идентификатор
        self.title = title                # как называем в кабинете
        self.ns_suffixes = ns_suffixes    # по чему узнаём
        self.panel_url = panel_url        # прямая ссылка в раздел DNS
        self.steps = steps                # шаги именно для этой панели
        self.note = note                  # особенность, на которой спотыкаются

    def as_dict(self) -> dict:
        return {
            "key": self.key,
            "title": self.title,
            "panel_url": self.panel_url,
            "steps": self.steps,
            "note": self.note,
        }


# ⚠️ Ссылки ведут в РАЗДЕЛ, а не на конкретный домен: адрес карточки домена
# содержит его внутренний id, которого мы не знаем. Лучше открыть список
# доменов, чем дать ссылку, которая упадёт в 404.
PROVIDERS: list[Provider] = [
    Provider(
        key="regru",
        title="Рег.ру",
        ns_suffixes=["reg.ru", "regru.ru", "reg.com"],
        panel_url="https://www.reg.ru/user/domain_list",
        steps=[
            "Откройте список доменов и нажмите на нужный домен",
            "Вкладка «DNS-серверы и управление зоной»",
            "Блок «Управление зоной» → «Добавить запись»",
        ],
        note="Если домен на хостинге Рег.ру, зона может редактироваться в "
             "панели хостинга (ISPmanager), а не в личном кабинете.",
    ),
    Provider(
        key="timeweb",
        title="Timeweb",
        ns_suffixes=["timeweb.ru", "timeweb.org", "tw1.ru", "timeweb.cloud"],
        panel_url="https://hosting.timeweb.ru/domains",
        steps=[
            "Раздел «Домены и поддомены»",
            "Нажмите на домен → «DNS-записи»",
            "«Добавить запись»",
        ],
    ),
    Provider(
        key="beget",
        title="Beget",
        ns_suffixes=["beget.com", "beget.ru", "beget.pro"],
        panel_url="https://cp.beget.com/dns",
        steps=[
            "Раздел «DNS» в панели управления",
            "Выберите домен слева",
            "Добавьте запись в нужный блок (A или CNAME)",
        ],
    ),
    Provider(
        key="cloudflare",
        title="Cloudflare",
        ns_suffixes=["ns.cloudflare.com"],
        panel_url="https://dash.cloudflare.com/",
        steps=[
            "Выберите домен → раздел «DNS» → «Records»",
            "«Add record»",
            "Переключите Proxy status в «DNS only» (серое облако)",
        ],
        note="⚠️ Оранжевое облако (Proxy) для этой записи нужно ВЫКЛЮЧИТЬ — "
             "иначе сертификат не выпустится, а у части посетителей из России "
             "сайт будет открываться медленно или не открываться вовсе.",
    ),
    Provider(
        key="nicru",
        title="RU-CENTER (nic.ru)",
        ns_suffixes=["nic.ru", "ncc.ru", "nic.net.ru"],
        panel_url="https://www.nic.ru/manager/",
        steps=[
            "Раздел «Услуги» → «DNS-хостинг»",
            "Откройте зону нужного домена",
            "«Добавить запись»",
        ],
    ),
    Provider(
        key="yandex",
        title="Яндекс 360 / Yandex Cloud",
        ns_suffixes=["yandex.net", "yandex.ru", "yandexcloud.net"],
        panel_url="https://connect.yandex.ru/portal/admin/domains",
        steps=[
            "Яндекс 360 для бизнеса → «Домены»",
            "Откройте домен → «DNS-записи»",
            "«Добавить запись»",
        ],
    ),
    Provider(
        key="selectel",
        title="Selectel",
        ns_suffixes=["selectel.org", "selectel.ru"],
        panel_url="https://my.selectel.ru/network/dns",
        steps=[
            "Раздел «DNS-хостинг»",
            "Откройте зону домена",
            "«Добавить запись»",
        ],
    ),
    Provider(
        key="sprinthost",
        title="Sprinthost",
        ns_suffixes=["sprinthost.ru"],
        panel_url="https://sprinthost.ru/panel/domains",
        steps=[
            "Раздел «Домены»",
            "Нажмите на домен → «Управление DNS»",
            "«Добавить запись»",
        ],
    ),
    Provider(
        key="hostland",
        title="Hostland",
        ns_suffixes=["hostland.ru", "hostland.net"],
        panel_url="https://panel.hostland.ru/",
        steps=[
            "Раздел «Домены» → «DNS-записи»",
            "Выберите домен",
            "«Добавить запись»",
        ],
    ),
    Provider(
        key="mchost",
        title="McHost",
        ns_suffixes=["mchost.ru"],
        panel_url="https://mchost.ru/billing/",
        steps=[
            "Раздел «Домены»",
            "Откройте домен → «Управление зоной»",
            "«Добавить запись»",
        ],
    ),
    Provider(
        key="ihc",
        title="IHC (ihc.ru)",
        ns_suffixes=["ihc.ru"],
        panel_url="https://cp.ihc.ru/",
        steps=[
            "Раздел «Домены» → «DNS-записи»",
            "Выберите домен",
            "«Добавить запись»",
        ],
    ),
    Provider(
        key="godaddy",
        title="GoDaddy",
        ns_suffixes=["domaincontrol.com", "godaddy.com"],
        panel_url="https://dcc.godaddy.com/control/dnsmanagement",
        steps=[
            "My Products → Domains → DNS",
            "«Add New Record»",
        ],
    ),
    Provider(
        key="namecheap",
        title="Namecheap",
        ns_suffixes=["registrar-servers.com", "namecheaphosting.com"],
        panel_url="https://ap.www.namecheap.com/domains/list/",
        steps=[
            "Domain List → Manage",
            "Вкладка «Advanced DNS»",
            "«Add New Record»",
        ],
    ),
]


def detect(ns_records: list[str] | None) -> Optional[dict]:
    """Кто управляет DNS домена. None — провайдер неизвестен.

    ⚠️ None — это нормальный и частый случай (свой DNS-сервер, редкий
    хостер, корпоративная зона). Кабинет тогда показывает общую инструкцию,
    как показывал раньше, — а не ошибку и не пустое место.
    """
    for ns in ns_records or []:
        host = (ns or "").strip().lower().rstrip(".")
        if not host:
            continue
        for p in PROVIDERS:
            for suffix in p.ns_suffixes:
                # Именно «оканчивается на .suffix» либо равно ему: простой
                # поиск подстроки дал бы ложное совпадение на чужом домене
                # вида ns1.reg.ru.example.com.
                if host == suffix or host.endswith("." + suffix):
                    return p.as_dict()
    return None
