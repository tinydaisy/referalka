'use client'
import { useState, useEffect, useRef } from 'react'
import { useParams } from 'next/navigation'
import { Edit2, Eye, X, ChevronDown, ChevronUp, Send, CheckCircle, XCircle, Loader2, Plus, Trash2, Copy } from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import BroadcastChannelPicker from '@/components/BroadcastChannelPicker'
import BroadcastMediaPicker from '@/components/BroadcastMediaPicker'
import ChatNavEditor from '@/components/ChatNavEditor'

type TypeDef = {
  type: string
  title: string
  hint: string
  variables: string[]
  hasSpeaker?: boolean
  showPhoto?: boolean
}

// {vip_url} — ссылка на оплату VIP-тарифа — доступна во ВСЕХ шаблонах,
// поэтому добавляется в variables каждого типа автоматически (см. ниже).
const TYPE_DEFS_RAW: TypeDef[] = [
  {
    type: 'pre_conf',
    title: 'Анонс знакомства со спикерами',
    hint: 'Отправляется за день до старта. Рассказывает о конференции и призывает зарегистрироваться. Фото — горизонтальная афиша.',
    variables: ['{conf_title}', '{conf_date}', '{conf_description}', '{landing_url}'],
    showPhoto: true,
  },
  {
    type: 'speaker_intro',
    title: 'Знакомство со спикером',
    hint: 'Рассылается участникам для представления спикера. Фото — афиша спикера. Текст генерируется автоматически из данных спикера.',
    variables: ['{speaker_name}', '{speaker_role}', '{speaker_slot_topic}', '{speaker_socials}', '{speaker_tg}', '{speaker_instagram}', '{speaker_topic}', '{speaker_topic_full}', '{speaker_topic_desc}', '{speaker_time}', '{speaker_date}', '{speaker_datetime}', '{speaker_achievements}', '{speaker_bio}', '{speaker_positioning}', '{speaker_card_link}', '{speaker_material}', '{speaker_notes}', '{gift_after_speech_title}', '{gift_raffle_title}', '{landing_url}'],
    hasSpeaker: true,
    showPhoto: true,
  },
  {
    type: 'expert_day',
    title: 'Экспертный день (вопросы эксперту)',
    hint: 'Анонс сессии вопросов-ответов с экспертом. Раскладывается по каждому выбранному коллабу (жюри/спикер/организатор), как знакомство со спикером. Ссылка на чат события подставляется автоматически.',
    variables: ['{speaker_name}', '{speaker_role}', '{speaker_positioning}', '{speaker_ask_topics}', '{speaker_tg_username}', '{speaker_socials}', '{speaker_tg}', '{speaker_instagram}', '{speaker_achievements}', '{speaker_topic}', '{speaker_topic_full}', '{speaker_topic_desc}', '{speaker_time}', '{speaker_date}', '{speaker_datetime}', '{speaker_bio}', '{speaker_card_link}', '{speaker_material}', '{event_chat_tg}', '{event_chat_vk}', '{event_chat_max}', '{brand_name}', '{landing_url}'],
    hasSpeaker: true,
    showPhoto: true,
  },
  {
    type: '5min_before',
    title: 'За 5 минут до выступления спикера',
    hint: 'Только для конференции. Отправляется за 5 минут до начала выступления каждого спикера (per-session). Фото — афиша спикера.',
    variables: ['{speaker_name}', '{speaker_topic}', '{speaker_topic_full}', '{speaker_topic_desc}', '{speaker_time}', '{speaker_date}', '{speaker_datetime}', '{speaker_role}', '{speaker_socials}', '{speaker_achievements}', '{speaker_bio}', '{speaker_positioning}', '{speaker_card_link}', '{speaker_material}', '{speaker_notes}', '{stream_url}'],
    hasSpeaker: true,
    showPhoto: true,
  },
  {
    type: 'speakers_call',
    title: 'Спикеру: «вы следующие» (в чат спикеров)',
    hint: 'Уходит В ЧАТ СПИКЕРОВ (не участникам) за 15 минут до выступления по программе — на каждого спикера отдельно. Кто выступает, во сколько, ссылки на эфир и кто готовится следом. Чат спикеров задаётся в «Описании» события, раздел «Чаты и каналы события».',
    variables: ['{speaker_name}', '{speaker_tg_username}', '{speaker_time}', '{speaker_topic}', '{speaker_when}', '{speaker_join_url}', '{stream_url}', '{next_speaker_name}', '{next_speaker_tg_username}', '{next_speaker_time}'],
    hasSpeaker: true,
  },
  {
    type: 'speakers_day',
    title: 'Спикерам: программа дня (в чат спикеров)',
    hint: 'Уходит В ЧАТ СПИКЕРОВ (не участникам) за сутки до дня программы — своя рассылка на каждый день. Тайминг выступлений: время, имя, ник в Telegram. Чат спикеров задаётся в «Описании» события.',
    variables: ['{day_program_speakers}', '{day_date}', '{day_number}', '{day_title}', '{conf_title}'],
  },
  {
    type: 'event_live',
    title: 'За 5 минут до старта мероприятия',
    hint: 'Только для мероприятия. Отправляется за 5 минут до старта эфира мероприятия. Фото — афиша события.',
    variables: ['{conf_title}', '{stream_url}'],
    showPhoto: true,
  },
  {
    type: '30min_before',
    title: 'За 30 минут до старта',
    hint: 'За 30 минут до старта ДНЯ программы (у события с днями — на каждый день) или до старта мероприятия. Кнопка → ссылка на эфир.',
    variables: ['{conf_title}', '{day_title}', '{day_number}', '{day_date}', '{day_datetime}', '{day_program}', '{day_program_with_links}', '{stream_url}', '{support_platform}'],
    showPhoto: true,
  },
  {
    type: 'gift',
    title: 'Подарок спикера',
    hint: 'Отправляется за 10 минут до конца выступления. Без фото.',
    variables: ['{speaker_name}', '{gift_title}', '{gift_url}', '{speaker_material}'],
    hasSpeaker: true,
    showPhoto: false,
  },
  {
    type: '2h_before_unreg',
    title: 'За 2 часа (не зарегистрирован)',
    hint: 'Для тех, кто ещё не зарегистрирован. У события с днями — на каждый день программы. Кнопка и ссылка — на лендинг регистрации.',
    variables: ['{conf_title}', '{day_title}', '{day_number}', '{day_date}', '{day_datetime}', '{day_program}', '{day_program_with_links}', '{landing_url}', '{stream_url}', '{support_platform}'],
    showPhoto: true,
  },
  {
    type: '2h_before_reg',
    title: 'За 2 часа (зарегистрирован)',
    hint: 'Для уже зарегистрированных. У события с днями — на каждый день программы. Эфира ещё нет — можно предложить позвать друзей через партнёрский кабинет ({game_link}).',
    variables: ['{conf_title}', '{day_title}', '{day_number}', '{day_date}', '{day_datetime}', '{day_program}', '{day_program_with_links}', '{game_link}', '{landing_url}', '{stream_url}', '{support_platform}'],
    showPhoto: true,
  },
  {
    type: 'day_before_09_12_unreg',
    title: 'За сутки в 09:12 МСК (не зарегистрирован)',
    hint: 'За сутки до дня в 09:12 МСК. У события с днями — накануне КАЖДОГО дня программы, с программой этого дня. Кнопка → лендинг регистрации.',
    variables: ['{conf_title}', '{day_title}', '{day_number}', '{day_date}', '{day_datetime}', '{day_program}', '{day_program_with_links}', '{landing_url}', '{support_platform}'],
    showPhoto: true,
  },
  {
    type: 'day_before_09_12_reg',
    title: 'За сутки в 09:12 МСК (зарегистрирован)',
    hint: 'За сутки до дня в 09:12 МСК. У события с днями — накануне КАЖДОГО дня программы, с программой этого дня. Кнопка → партнёрский кабинет ({game_link}).',
    variables: ['{conf_title}', '{day_title}', '{day_number}', '{day_date}', '{day_datetime}', '{day_program}', '{day_program_with_links}', '{game_link}', '{support_platform}'],
    showPhoto: true,
  },
  {
    type: 'day_live',
    title: 'Начинаем День события',
    hint: 'Отправляется за 5 минут до старта КАЖДОГО дня программы. Кнопка → ссылка на эфир.',
    variables: ['{conf_title}', '{day_title}', '{day_number}', '{day_date}', '{day_datetime}', '{day_program}', '{day_program_with_links}', '{stream_url}', '{support_platform}'],
    showPhoto: true,
  },
  {
    type: 'day_end',
    title: 'День события — итоги дня',
    hint: 'Отправляется по окончании дня. Автоматически вставляет список подарков всех спикеров этого дня.',
    variables: ['{conf_title}', '{day_title}', '{day_number}', '{day_ordinal}', '{day_date}', '{day_program}', '{next_day_mention}', '{raffle_url}', '{day_speakers_gifts}', '{support_platform}'],
    showPhoto: true,
  },
  {
    type: 'vip_offer',
    title: 'Продажа VIP-тарифа',
    hint: 'Произвольная рассылка (например, продажа VIP-тарифа после итогов дня). Время отправки задаётся вручную в очереди. По умолчанию уходит по всей базе клиента.',
    variables: ['{first_name}'],
    showPhoto: true,
  },
  {
    type: 'chat_nav',
    title: 'Навигация по чату (закреп)',
    hint: 'Один пост со всеми ссылками — уходит в чат события и закрепляется. Пункты настраиваются ниже: ссылки подставляются под площадку каждого чата (в чат ВКонтакте — вэкашные, в Telegram — телеграмные). Участникам в личку не уходит. Время отправки задаётся вручную в очереди.',
    variables: [],
    showPhoto: true,
  },
]

// {vip_url} доступен во всех типах — добавляем его в variables каждого шаблона,
// если ещё нет (чтобы кнопка-вставка плейсхолдера была в любом редакторе).
const TYPE_DEFS: TypeDef[] = TYPE_DEFS_RAW.map(d => ({
  ...d,
  variables: d.variables.includes('{vip_url}') ? d.variables : [...d.variables, '{vip_url}'],
}))

// ─── Группы шаблонов в списке ────────────────────────────────────────────────
// Три полосы: про спикеров → общие о событии → в чат спикеров.
// ⚠️ Первые две различаются ТИПОМ (это смысл рассылки), третья — флагом
// send_to_speakers_chat (это адресат). Смешивать признаки нельзя: шаблон про
// спикера может уходить и участникам, и в чат команды.
const SPEAKER_TOPIC_TYPES = new Set([
  'speaker_intro',   // знакомство со спикером
  'pre_conf',        // анонс знакомств — тоже про спикеров
  'expert_day',      // экспертный день конкретного человека
  '5min_before',     // «выступает такой-то»
  'gift',            // подарок спикера — перечень подарков
  'day_end',         // итоги дня: там {day_speakers_gifts} — подарки всех
                     // спикеров дня одним списком, это про них, а не про событие
])

type TplGroup = 'speaker_topic' | 'general' | 'speakers_chat'

function tplGroup(t: any): TplGroup {
  if (t?.send_to_speakers_chat) return 'speakers_chat'
  return SPEAKER_TOPIC_TYPES.has(t?.type) ? 'speaker_topic' : 'general'
}

const GROUP_ORDER: TplGroup[] = ['speaker_topic', 'general', 'speakers_chat']

const GROUP_META: Record<TplGroup, { title: string; hint?: string }> = {
  speaker_topic: { title: 'Шаблоны участникам: про спикеров',
                   hint: 'Анонсы спикеров, их выступлений и подарков.' },
  general:       { title: 'Шаблоны участникам: общие о событии',
                   hint: 'Напоминания о старте, итоги дня, продажа тарифа.' },
  speakers_chat: { title: 'Шаблоны в чат спикеров',
                   hint: 'Служебные сообщения команде. Участникам события не уходят — чат задаётся в «Описании» события, раздел «Чаты и каналы события».' },
}

const ALL_VARIABLES: { name: string; desc: string }[] = [
  { name: '{speaker_name}', desc: 'Имя спикера' },
  { name: '{speaker_role}', desc: 'Роль спикера (Спикер / Хедлайнер / Жюри и т.п.)' },
  { name: '{speaker_tg_username}', desc: 'Личный ник спикера в Telegram (@username, кликабельный). Пусто — строка убирается' },
  { name: '{speaker_socials}', desc: 'Все соцсети спикера списком (личный Telegram, TG-канал, VK, MAX, Instagram, сайт)' },
  { name: '{speaker_tg}', desc: 'Telegram-канал спикера' },
  { name: '{speaker_instagram}', desc: 'Нельзяграм спикера' },
  { name: '{speaker_topic}', desc: 'Тема выступления — только НАЗВАНИЕ (одна строка). Идёт в программу и в тему письма' },
  { name: '{speaker_topic_full}', desc: 'Тема + описание («что будет на выступлении») через пустую строку. Для тела рассылки' },
  { name: '{speaker_topic_desc}', desc: 'Только описание темы — с жирным заголовком «Что будет:» и переносом строки. Когда название уже стоит рядом' },
  { name: '{speaker_slot_topic}', desc: 'Слот + тема одной строкой: «дата/время (жирным): тема». Нет слота — только тема (без двоеточия). Нет ни того, ни другого — строка убирается' },
  { name: '{speaker_time}', desc: 'Время выступления спикера («14:30–15:00 МСК»). Не задано — строка убирается' },
  { name: '{speaker_date}', desc: 'Дата выступления спикера («6 июля»). Не задана — строка убирается' },
  { name: '{speaker_datetime}', desc: 'Дата и время выступления («6 июля, 14:30–15:00 МСК»). Не задано — строка убирается' },
  { name: '{speaker_achievements}', desc: 'Регалии спикера (строки через · )' },
  { name: '{speaker_bio}', desc: 'Биография / «о себе» спикера' },
  { name: '{speaker_positioning}', desc: 'Позиционирование спикера (должность/титул)' },
  { name: '{speaker_card_link}', desc: 'Ссылка на карточку спикера (веб или Mini App — по настройке события)' },
  { name: '{speaker_material}', desc: 'Материал спикера в базу знаний. Раскрывается сам: «Уже сейчас вам доступен полезный материал: "Название"» + ссылка. Нет ссылки — строка убирается' },
  { name: '{speaker_notes}', desc: 'Заметки спикера (в «Экспертном дне» — тематика вопросов, которую спикер пишет сам в кабинете). Пусто — строка убирается' },
  { name: '{speaker_ask_topics}', desc: 'Раскрывается сам: жирный заголовок «С какими темами и вопросами можно обратиться?» + список вопросов из поля коллаба. Пусто — блок убирается целиком' },
  { name: '{event_chat_tg}', desc: 'Ссылка на Telegram-чат события. Пусто — строка убирается' },
  { name: '{event_chat_vk}', desc: 'Ссылка на VK-чат события. Пусто — строка убирается' },
  { name: '{event_chat_max}', desc: 'Ссылка на MAX-чат события. Пусто — строка убирается' },
  { name: '{gift_after_speech_title}', desc: 'Подарок на эфире' },
  { name: '{gift_raffle_title}', desc: 'Подарок для розыгрыша' },
  { name: '{gift_title}', desc: 'Название подарка (из поля «Подарок» сессии)' },
  { name: '{gift_url}', desc: 'Ссылка на подарок' },
  { name: '{stream_url}', desc: 'Ссылка на эфир (вебинарная комната дня) — для ЗРИТЕЛЕЙ' },
  { name: '{speaker_join_url}', desc: 'Ссылка входа СПИКЕРА в эфир (Zoom) — не то же, что эфир для зрителей. Задаётся у каждого дня в разделе «Вебинары». Не задана — строка убирается' },
  { name: '{next_speaker_name}', desc: 'Имя следующего по программе спикера (кто выступает после текущего в этот же день). Следующего нет — строка убирается' },
  { name: '{next_speaker_tg_username}', desc: 'Ник следующего спикера в Telegram (@username). Пусто — убирается только сам ник, строка остаётся' },
  { name: '{next_speaker_time}', desc: 'Время выступления следующего спикера («15:00–15:30 МСК»)' },
  { name: '{landing_url}', desc: 'Ссылка на лендинг регистрации' },
  { name: '{brand_name}', desc: 'Бренд клиента (из настроек; работает в любом типе рассылки)' },
  { name: '{conf_title}', desc: 'Название конференции' },
  { name: '{day_number}', desc: 'Номер дня (1, 2, 3…)' },
  { name: '{day_title}', desc: 'Заголовок дня из программы («День 1 — Соревновательные эфиры»). Если заголовка нет — «День N»' },
  { name: '{day_ordinal}', desc: 'Номер дня словом (первом, втором…)' },
  { name: '{day_date}', desc: 'Дата дня конференции' },
  { name: '{day_datetime}', desc: 'Дата дня + время старта («13 июля в 10:00 МСК»)' },
  { name: '{event_when}', desc: 'Когда событие: «Сегодня в 10:00 МСК» / «Завтра в 10:00 МСК», а если позже — «13 июля в 10:00 МСК». Работает в любой рассылке события' },
  { name: '{speaker_when}', desc: 'Когда выступает спикер: «Сегодня в 14:30 МСК» / «Завтра в 14:30 МСК», иначе «13 июля в 14:30 МСК». Нужен шаблон со спикером или привязка к слоту' },
  { name: '{support_platform}', desc: 'Служба поддержки — ОДИН контакт своей площадки: в Telegram — телеграм, в VK — ВК, в MAX — MAX' },
  { name: '{support_links}', desc: 'Служба поддержки — ВСЕ каналы списком (ВК, Telegram, MAX), по строке на каждый' },
  { name: '{support_command}', desc: 'Ссылка ДЛЯ КНОПКИ «Тех.поддержка» — клик открывает бота и показывает все контакты поддержки. Вставлять в поле URL кнопки, не в текст' },
  { name: '{day_program}', desc: 'Программа дня (список спикеров и тем)' },
  { name: '{day_program_speakers}', desc: 'Тайминг дня ДЛЯ СПИКЕРОВ: «10:30–10:55 — Иван Петров (@ivan)». Без тем и ролей — только время, имя и ник. Для рассылок в чат спикеров' },
  { name: '{day_program_with_links}', desc: 'Программа дня, но имена спикеров — ссылками на их карточки' },
  { name: '{next_day_mention}', desc: 'Фраза про следующую встречу (авто: завтра/дата, пусто если последний день)' },
  { name: '{raffle_url}', desc: 'Ссылка на розыгрыш' },
  { name: '{day_speakers_gifts}', desc: 'Список подарков спикеров за день' },
  { name: '{first_name}', desc: 'Имя получателя (персонализация)' },
  { name: '{game_link}', desc: 'Личная ссылка получателя на вкладку «Игра» события (партнёрский кабинет)' },
  { name: '{vip_url}', desc: 'Ссылка на оплату VIP-тарифа (та же, что у VIP-кнопки в Mini App)' },
]

// Описание плейсхолдера по имени — для подсказки (title) на кнопках-вставках.
const VAR_DESC: Record<string, string> = Object.fromEntries(
  ALL_VARIABLES.map(v => [v.name, v.desc])
)

// Построчный список плейсхолдеров с расшифровкой. Любой плейсхолдер можно
// вставить в ЛЮБОЙ шаблон (бэк подставит его, если данные для него есть).
// «Частые для этого типа» показываем сверху, остальные — под спойлером.
function PlaceholderPicker({ common, onInsert }: { common: string[]; onInsert: (v: string) => void }) {
  const [showAll, setShowAll] = useState(false)
  const commonSet = new Set(common)
  const commonVars = ALL_VARIABLES.filter(v => commonSet.has(v.name))
  const otherVars = ALL_VARIABLES.filter(v => !commonSet.has(v.name))
  const Row = ({ name, desc }: { name: string; desc: string }) => (
    <button type="button" onClick={() => onInsert(name)}
      className="w-full flex items-start gap-2 text-left px-2 py-1 rounded-lg hover:bg-gray-100">
      <code className="text-xs bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5 font-mono text-[#25455D] shrink-0">{name}</code>
      <span className="text-xs text-gray-500 leading-snug">{desc}</span>
    </button>
  )
  return (
    <div className="mt-2 border border-gray-100 rounded-xl p-2 bg-gray-50/50">
      <div className="text-xs text-gray-400 mb-1 px-1">Вставить плейсхолдер (клик добавит в текст):</div>
      <div className="space-y-0.5">
        {commonVars.map(v => <Row key={v.name} name={v.name} desc={v.desc} />)}
      </div>
      <button type="button" onClick={() => setShowAll(s => !s)}
        className="text-xs text-[#25455D] underline mt-1 px-1">
        {showAll ? 'Скрыть остальные' : `Показать все плейсхолдеры (ещё ${otherVars.length})`}
      </button>
      {showAll && (
        <div className="space-y-0.5 mt-1 border-t border-gray-100 pt-1">
          {otherVars.map(v => <Row key={v.name} name={v.name} desc={v.desc} />)}
        </div>
      )}
    </div>
  )
}

// Роли коллабораторов для выбора в шаблоне «Знакомство со спикерами».
// Подписи площадок в списке ссылок, когда своей площадки нет и даём чужие.
// Держим в синхроне с share_links.PLATFORM_LABEL на бэке.
const PLATFORM_LABEL_RU: Record<string, string> = {
  telegram: 'Через Телеграм', max: 'Через МАКС', vk: 'Через ВК',
}
const MULTI_LINK_ORDER = ['telegram', 'max', 'vk']

const INTRO_ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'headliner', label: 'Хедлайнеры' },
  { value: 'speaker', label: 'Спикеры' },
  { value: 'jury', label: 'Жюри' },
  { value: 'organizer', label: 'Организаторы' },
  { value: 'partner', label: 'Партнёры' },
]

const INCLUDE_LABELS: Record<string, string> = {
  all_event: 'Все участники конфы',
  registered_event: 'Зарегистрированные участники',
  paid_event: 'Оплатившие',
  unpaid_event: 'Имеют неоплаченный заказ',
  all_client: 'Вся база клиента',
}

const EXCLUDE_LABELS: Record<string, string> = {
  none: 'никого не исключать',
  registered_event: 'зарег. участников',
  unregistered_event: 'незарег. участников',
  paid_event: 'оплативших',
  unpaid_event: 'имеющих неоплаченный заказ',
  all_event: 'всех участников конфы',
}

function audienceLabel(inc: string, exc: string): string {
  const incLabel = INCLUDE_LABELS[inc] || inc
  if (!exc || exc === 'none') return incLabel
  return `${incLabel} − ${EXCLUDE_LABELS[exc] || exc}`
}

const emptyForm = {
  name: '', type: '5min_before', subject: '', text: '', photo_url: '',
  video_url: '', media_type: null as 'photo' | 'video' | null,
  button_text: '', button_url: '', audience_include: 'all_event', audience_exclude: 'none',
  intro_start_time: '11:00', intro_interval_min: 15, intro_days_before: 1,
  intro_roles: null as string[] | null,
  send_to_event_chats: false,
  send_to_client_chats: false,
  send_to_private_chats: false,
  send_to_speakers_chat: false,
  speaker_photo_mode: 'poster',
  custom_day_ref: '', custom_time: '12:00',
  // Привязка кастомного шаблона: 'day' — день программы (как было),
  // 'slot' — выступление спикера, 'none' — без привязки (своя дата+время).
  custom_bind_kind: 'day' as 'none' | 'day' | 'slot',
  custom_slot_session_id: null as number | null,
  custom_slot_offset_min: 0,
  custom_fire_at: '',
  // target_channel_ids: null = «по всем каналам клиента» (default),
  // [] = никуда не слать, [N,M] = только эти channel_id.
  target_channel_ids: null as number[] | null,
}

// Превью с гарантированным плейсхолдером при битом URL.
// Без этого `<img onError>` просто скрывается и пользователь видит пустоту.
function PreviewImage({ src, placeholder }: { src: string; placeholder: string }) {
  const [errored, setErrored] = useState(false)
  if (errored) {
    return (
      <div className="w-full h-20 rounded-xl mb-2 flex items-center justify-center text-xs text-gray-400"
        style={{ background: '#e8e8e8' }}>
        {placeholder} (не загрузилась)
      </div>
    )
  }
  return (
    <img src={src} alt=""
      className="w-full rounded-xl mb-2"
      style={{ maxHeight: '400px', objectFit: 'contain', background: '#f0f0f0' }}
      onError={() => setErrored(true)}
    />
  )
}

// Типы, которых на событии может быть НЕСКОЛЬКО → их можно дублировать.
// Должно совпадать с DUPLICABLE_TYPES на бэке (modules/broadcasts.py).
const DUPLICABLE_TYPES = ['custom', 'expert_day', 'speaker_intro']

const CUSTOM_PLACEHOLDERS = [
  '{conf_title}', '{conf_date}', '{conf_description}',
  '{day_number}', '{day_title}', '{day_date}', '{day_datetime}',
  '{day_program}', '{day_program_with_links}',
  '{stream_url}', '{landing_url}', '{raffle_url}',
  '{first_name}', '{vip_url}', '{support_platform}',
  // «Сегодня в 14:30 МСК» / «Завтра в 14:30 МСК», иначе обычная дата+время.
  '{event_when}', '{speaker_when}',
  // Работают, если шаблон привязан к слоту спикера.
  '{speaker_name}', '{speaker_topic}', '{speaker_topic_full}', '{speaker_topic_desc}', '{speaker_achievements}',
  '{speaker_time}', '{speaker_date}', '{speaker_datetime}',
]

// Дата дня "YYYY-MM-DD" → "6 июля" без new Date() (UTC-парс уводит на сутки).
const _TPL_DM = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
function fmtTplDay(d?: string | null): string {
  if (!d) return ''
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${parseInt(m[3], 10)} ${_TPL_DM[parseInt(m[2], 10) - 1]}` : ''
}

function customDayRefLabel(ref: string, confDays: number[]): string {
  if (!ref) return ''
  if (ref.startsWith('before_')) return `За ${ref.split('_')[1]} дня до конференции`
  if (ref.startsWith('day_')) return `День ${ref.split('_')[1]}`
  if (ref.startsWith('after_')) return `Через ${ref.split('_')[1]} дня после конференции`
  return ref
}

// Подпись привязки в карточке шаблона: «День 2 в 12:00» / «Слот: Иванов…» / дата.
function customBindLabel(tpl: any, sessions: any[], confDays: number[]): string {
  const kind = tpl.custom_bind_kind || 'day'
  if (kind === 'none') {
    if (!tpl.custom_fire_at) return 'Дата не задана'
    const d = new Date(tpl.custom_fire_at)
    return `${d.getDate()} ${_TPL_DM[d.getMonth()]} в ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (kind === 'slot') {
    const s = sessions.find((x: any) => x.id === tpl.custom_slot_session_id)
    if (!s) return 'Слот удалён из программы'
    const t = String(s.start_time || '').slice(0, 5)
    const off = Number(tpl.custom_slot_offset_min || 0)
    const offLabel = off === 0 ? 'в момент старта' : (off < 0 ? `за ${-off} мин до` : `через ${off} мин после`)
    return `${s.speaker_name || s.title || `Слот #${s.id}`}${s.day ? `, День ${s.day}` : ''}${t ? ` ${t} МСК` : ''} — ${offLabel}`
  }
  return `${customDayRefLabel(tpl.custom_day_ref || '', confDays)} в ${tpl.custom_time || '—'}`
}

// Превью {event_when}/{speaker_when}: «Сегодня в 14:30 МСК» / «Завтра в …»,
// иначе «6 июля в 14:30 МСК». Без года и без секунд. Дата — "YYYY-MM-DD".
function relativeWhenPreview(dayDate?: string | null, hhmm?: string | null): string {
  if (!dayDate) return ''
  const m = String(dayDate).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ''
  const t = hhmm ? String(hhmm).slice(0, 5) : ''
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const today = new Date()
  const ref = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const delta = Math.round((target.getTime() - ref.getTime()) / 86400000)
  const dayPart = delta === 0 ? 'Сегодня'
    : delta === 1 ? 'Завтра'
    : `${target.getDate()} ${_TPL_DM[target.getMonth()]}`
  return t ? `${dayPart} в ${t} МСК` : dayPart
}

// ISO из БД → значение для <input type="datetime-local"> (локальное «YYYY-MM-DDTHH:MM»).
function toLocalInputValue(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

// Проверка привязки перед сохранением. Возвращает текст ошибки или '' если всё ок.
function validateBinding(f: any): string {
  const kind = f.custom_bind_kind || 'day'
  if (kind === 'slot') {
    if (!f.custom_slot_session_id) return 'Выберите слот программы (выступление спикера)'
    return ''
  }
  if (kind === 'none') {
    if (!f.custom_fire_at) return 'Укажите дату и время отправки'
    return ''
  }
  if (!f.custom_day_ref) return 'Выберите день отправки'
  if (!f.custom_time || !/^\d{1,2}:\d{2}$/.test(f.custom_time)) return 'Укажите время в формате HH:MM'
  return ''
}

// Поля привязки для payload. Шлём ВСЕ — бэк по custom_bind_kind сам решает,
// что применить, а чего не касаться (переключение режима обнуляет лишнее).
function bindingPayload(f: any) {
  const kind = f.custom_bind_kind || 'day'
  return {
    custom_bind_kind: kind,
    custom_day_ref: f.custom_day_ref || null,
    custom_time: f.custom_time || null,
    custom_slot_session_id: kind === 'slot' ? (f.custom_slot_session_id ?? null) : null,
    custom_slot_offset_min: kind === 'slot' ? Number(f.custom_slot_offset_min || 0) : null,
    custom_fire_at: kind === 'none' ? (f.custom_fire_at || null) : null,
  }
}

// Выбор привязки кастомного шаблона — один блок на обе модалки (создание и правка).
function CustomBindingFields({ form, setForm, dayRefOptions, sessions }: {
  form: any
  setForm: (f: any) => void
  dayRefOptions: { value: string; label: string }[]
  sessions: any[]
}) {
  const kind: 'none' | 'day' | 'slot' = form.custom_bind_kind || 'day'
  const slots = sessions
    .filter((s: any) => s.start_time)
    .sort((a: any, b: any) => (a.day - b.day) || String(a.start_time || '').localeCompare(String(b.start_time || '')))

  const KINDS: { value: 'day' | 'slot' | 'none'; label: string; hint: string }[] = [
    { value: 'day', label: 'К дню программы', hint: 'Уйдёт в выбранный день конференции в указанное время.' },
    { value: 'slot', label: 'К выступлению спикера', hint: 'Время считается от слота в программе. В тексте работают {speaker_name}, {speaker_time}, {speaker_topic} и афиша спикера.' },
    { value: 'none', label: 'Без привязки', hint: 'Просто дата и время — не зависит от программы.' },
  ]
  const active = KINDS.find(k => k.value === kind)!

  return (
    <div className="border border-gray-100 rounded-xl p-3 bg-gray-50 space-y-3">
      <div>
        <p className="text-xs font-medium text-gray-600 mb-2">🔗 К чему привязать рассылку</p>
        <div className="grid grid-cols-3 gap-1.5">
          {KINDS.map(k => (
            <button
              key={k.value}
              type="button"
              onClick={() => setForm({ ...form, custom_bind_kind: k.value })}
              className={`px-2 py-2 rounded-lg text-xs font-medium border transition ${
                kind === k.value
                  ? 'border-[#25455D] bg-white text-[#25455D] shadow-sm'
                  : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
              }`}>
              {k.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-gray-500 mt-1.5 leading-snug">{active.hint}</p>
      </div>

      {kind === 'day' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">День отправки</label>
            <select
              value={form.custom_day_ref || ''}
              onChange={e => setForm({ ...form, custom_day_ref: e.target.value })}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
              {dayRefOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Время (МСК / таймзона клиента)</label>
            <input
              type="time"
              value={form.custom_time || '12:00'}
              onChange={e => setForm({ ...form, custom_time: e.target.value })}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white" />
          </div>
        </div>
      )}

      {kind === 'slot' && (
        <div className="space-y-2">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Слот программы</label>
            <select
              value={form.custom_slot_session_id ?? ''}
              onChange={e => setForm({ ...form, custom_slot_session_id: e.target.value ? Number(e.target.value) : null })}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
              <option value="">— выберите выступление —</option>
              {slots.map((s: any) => {
                const t = String(s.start_time || '').slice(0, 5)
                const who = s.speaker_name || s.title || `Слот #${s.id}`
                return (
                  <option key={s.id} value={s.id}>
                    {s.day ? `День ${s.day}, ` : ''}{t ? `${t} МСК — ` : ''}{who}
                  </option>
                )
              })}
            </select>
            {slots.length === 0 && (
              <p className="text-[11px] text-amber-600 mt-1">
                В программе пока нет слотов со временем — добавьте их во вкладке «Программа».
              </p>
            )}
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Когда отправить</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step={5}
                value={form.custom_slot_offset_min ?? 0}
                onChange={e => setForm({ ...form, custom_slot_offset_min: Number(e.target.value) })}
                className="w-24 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white" />
              <span className="text-xs text-gray-500">минут от начала выступления</span>
            </div>
            <p className="text-[11px] text-gray-500 mt-1 leading-snug">
              Минус — раньше старта (−5 = «за 5 минут до выступления»), плюс — позже, 0 — ровно в момент старта.
            </p>
          </div>
        </div>
      )}

      {kind === 'none' && (
        <div>
          <label className="text-xs text-gray-500 mb-1 block">Дата и время отправки</label>
          <input
            type="datetime-local"
            value={form.custom_fire_at || ''}
            onChange={e => setForm({ ...form, custom_fire_at: e.target.value })}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white" />
        </div>
      )}
    </div>
  )
}

export default function TemplatesPage() {
  const { id } = useParams()
  const eventId = Number(id)
  // publicBase — домен клиента: эти ссылки уходят получателям рассылки.
  const { me, publicBase } = useMe()
  // Сегменты по оплате — только при фиче платных тарифов события.
  const hasPayments = (me?.features || []).includes('event_tariffs')
  // База чатов клиента (общие/личные каналы) — только с фичей broadcast_chats (Экстра/vip).
  // «В чаты события» доступна всем — её НЕ гейтим.
  const hasChatsFeature = (me?.features || []).includes('broadcast_chats')

  const [templates, setTemplates] = useState<any[]>([])
  const [speakers, setSpeakers] = useState<any[]>([])
  // Свёрнутые группы шаблонов («для участников» / «в чат спикеров»).
  // Обе развёрнуты по умолчанию: свёрнутый по умолчанию список выглядит как
  // «шаблонов нет», и человек идёт создавать второй такой же.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [editModal, setEditModal] = useState<any>(null)
  const [createModal, setCreateModal] = useState(false)
  // Модалка выбора при «Добавить шаблон»: новый с нуля / из готовых.
  const [addChoiceModal, setAddChoiceModal] = useState(false)
  const [presets, setPresets] = useState<any[]>([])
  const [presetsLoading, setPresetsLoading] = useState(false)
  const [form, setForm] = useState({ ...emptyForm })
  const [previewModal, setPreviewModal] = useState<{ tpl: any; def: TypeDef } | null>(null)
  const [previewSpeakerId, setPreviewSpeakerId] = useState<number | null>(null)
  // Площадка превью (вкладки Telegram/VK/MAX) — ссылка воронки подарка зависит от неё.
  const [previewPlatform, setPreviewPlatform] = useState<'telegram' | 'vk' | 'max' | 'email'>('telegram')
  const [varsOpen, setVarsOpen] = useState(false)
  const [testModal, setTestModal] = useState<{ def: TypeDef; tpl: any } | null>(null)
  const [testSending, setTestSending] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)
  const [testDay, setTestDay] = useState(1)
  const [confDays, setConfDays] = useState<number[]>([1])
  const [confDaysData, setConfDaysData] = useState<any[]>([])
  const [confData, setConfData] = useState<any>(null)
  const [eventData, setEventData] = useState<any>(null)
  const [confSessions, setConfSessions] = useState<any[]>([])
  const [confPosters, setConfPosters] = useState<{ horizontal: string[]; vertical: string[]; square: string[] }>({
    horizontal: [], vertical: [], square: [],
  })
  // Афиши дней события (event_posters.day = N). Дневные шаблоны берут афишу
  // своего дня; если у дня афиши нет — общую афишу события.
  const [dayPosters, setDayPosters] = useState<any[]>([])
  const [previewRegistered, setPreviewRegistered] = useState(false)

  useEffect(() => {
    api.conference.templates.list(eventId).then(r => setTemplates(r.templates || [])).catch(() => {})
    api.conference.speakers.list(eventId).then(r => setSpeakers(
      [...(r.speakers || [])].sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '', 'ru'))
    )).catch(() => {})
    api.conference.days.list(eventId).then(r => {
      const days = r.days || []
      const dayNums = days.map((d: any) => d.day_number).sort((a: number, b: number) => a - b)
      if (dayNums.length > 0) setConfDays(dayNums)
      setConfDaysData(days)
    }).catch(() => {})
    api.conference.get(eventId).then(r => setConfData(r.conference)).catch(() => {})
    api.events.get(eventId).then(r => setEventData(r.event || r)).catch(() => {})
    api.conference.sessions.list(eventId).then(r => setConfSessions(r.sessions || [])).catch(() => {})
    // Афиши лежат в event_posters. ОБЩИЕ (day = null) идут в confPosters, афиши
    // ДНЕЙ (day = N) — отдельно: в превью дневных шаблонов подставляется афиша
    // выбранного дня, как и при реальной отправке (фото шаблона → афиша дня →
    // общая афиша; внутри группы square > horizontal > vertical).
    api.referralProgram.posters.list(eventId).then(r => {
      const items = r.items || []
      const common = items.filter((p: any) => p.day == null)
      setConfPosters({
        horizontal: common.filter((p: any) => p.orientation === 'horizontal').map((p: any) => p.url),
        vertical:   common.filter((p: any) => p.orientation === 'vertical').map((p: any) => p.url),
        square:     common.filter((p: any) => p.orientation === 'square').map((p: any) => p.url),
      })
      setDayPosters(items.filter((p: any) => p.day != null))
    }).catch(() => {})
  }, [eventId])

  async function save() {
    try {
      const mt = (form as any).media_type as 'photo' | 'video' | null
      const isCustomTpl = (form as any).type === 'custom'
      if (isCustomTpl) {
        const bindErr = validateBinding(form as any)
        if (bindErr) { alert(bindErr); return }
      }
      const payload: any = {
        ...form,
        text: form.text || '',
        // Не отправляем фото и видео одновременно — оставляем выбранный тип.
        photo_url: mt === 'photo' ? ((form as any).photo_url || null) : null,
        video_url: mt === 'video' ? ((form as any).video_url || null) : null,
        media_type: mt,
        audience_include: (form as any).audience_include || 'all_event',
        audience_exclude: (form as any).audience_exclude || 'none',
        // ⚠️ Без подстановки '11:00': поле общее на все типы, и у «за сутки»
        // (09:12) / анонса знакомства (10:43) свой час по умолчанию на сервере.
        // Пустая строка (а не null) — это ЯВНАЯ очистка времени: у «итогов дня»
        // так возвращаются к расчёту «через 30 минут после конца программы».
        intro_start_time: (form as any).intro_start_time ?? '',
        intro_interval_min: (form as any).intro_interval_min || 15,
        intro_days_before: (form as any).intro_days_before || 1,
        // Общие/личные чаты — только с фичей broadcast_chats. Без неё принудительно false,
        // чтобы старое включённое значение не «прилипло» при сохранении.
        send_to_client_chats: hasChatsFeature ? !!(form as any).send_to_client_chats : false,
        send_to_private_chats: hasChatsFeature ? !!(form as any).send_to_private_chats : false,
        // Привязка — только у кастомных. У остальных типов custom_bind_kind не
        // шлём вовсе, чтобы бэк не трогал эти поля (см. model_fields_set).
        ...(isCustomTpl ? bindingPayload(form as any) : {}),
        // Пункты навигации — ТОЛЬКО у chat_nav. У остальных типов поле не шлём
        // вовсе: бэк различает «не прислали» и «прислали пусто» (model_fields_set),
        // и лишняя отправка затёрла бы чужие пункты пустотой.
        ...((form as any).type === 'chat_nav'
          ? { nav_items: (form as any).nav_items || [], pin_in_chat: !!(form as any).pin_in_chat }
          : {}),
      }
      if (!isCustomTpl) delete payload.custom_bind_kind
      // target_channel_ids: null = «не трогаем текущее значение в БД»,
      // массив = заменяем целиком. Picker всегда приводит null → массив после
      // первичной отрисовки, поэтому здесь обычно уже массив.
      if ((form as any).target_channel_ids !== null && (form as any).target_channel_ids !== undefined) {
        payload.target_channel_ids = (form as any).target_channel_ids
      }
      await api.conference.templates.update(eventId, editModal.id, payload)
      // Перечитываем список целиком, а не подменяем строку ответом PATCH: GET
      // дополняет шаблоны данными, которых в ответе PATCH нет (дефолтная афиша
      // события и т.п.). Иначе карточка после сохранения показывала старый снимок.
      const fresh = await api.conference.templates.list(eventId)
      setTemplates(fresh.templates || [])
      setEditModal(null)
    } catch (e: any) {
      alert(e.message)
    }
  }

  // Кнопка «Добавить шаблон» → модалка выбора (новый / из готовых).
  function openAddChoice() {
    setAddChoiceModal(true)
    setPresetsLoading(true)
    api.conference.templates.presets(eventId)
      .then(r => setPresets(r.presets || []))
      .catch(() => setPresets([]))
      .finally(() => setPresetsLoading(false))
  }

  // Создать новый шаблон с нуля (кастомный).
  function openCreate() {
    setAddChoiceModal(false)
    setForm({
      ...emptyForm,
      type: 'custom',
      audience_include: 'all_event',
      audience_exclude: 'none',
      custom_bind_kind: 'day',
      custom_day_ref: confDays[0] ? `day_${confDays[0]}` : 'before_1',
      custom_time: '12:00',
      custom_slot_session_id: null,
      custom_slot_offset_min: 0,
      custom_fire_at: '',
    } as any)
    setCreateModal(true)
  }

  // Добавить готовый шаблон (с дефолтным текстом) по типу пресета.
  async function addPreset(type: string) {
    try {
      const res = await api.conference.templates.createFromPreset(eventId, type)
      setTemplates([...templates, res])
      setAddChoiceModal(false)
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function createCustom() {
    try {
      const f = form as any
      if (!f.name || !f.name.trim()) {
        alert('Введите название шаблона')
        return
      }
      const bindErr = validateBinding(f)
      if (bindErr) {
        alert(bindErr)
        return
      }
      const payload: any = {
        name: f.name,
        type: 'custom',
        subject: f.subject || null,
        text: f.text || '',
        photo_url: f.media_type === 'photo' ? (f.photo_url || null) : null,
        video_url: f.media_type === 'video' ? (f.video_url || null) : null,
        media_type: f.media_type,
        button_text: f.button_text || null,
        button_url: f.button_url || null,
        audience_include: f.audience_include || 'all_event',
        audience_exclude: f.audience_exclude || 'none',
        ...bindingPayload(f),
        send_to_event_chats: !!f.send_to_event_chats,
        // Чат спикеров — доступен всем, как и чат события (это чат ЭТОГО события).
        send_to_speakers_chat: !!(f as any).send_to_speakers_chat,
        // Общие/личные чаты — только с фичей broadcast_chats.
        send_to_client_chats: hasChatsFeature ? !!f.send_to_client_chats : false,
        send_to_private_chats: hasChatsFeature ? !!f.send_to_private_chats : false,
      }
      if (f.target_channel_ids !== null && f.target_channel_ids !== undefined) {
        payload.target_channel_ids = f.target_channel_ids
      }
      const res = await api.conference.templates.create(eventId, payload)
      setTemplates([...templates, res])
      setCreateModal(false)
    } catch (e: any) {
      alert(e.message)
    }
  }

  // Копия шаблона со всеми настройками (текст, тайминг, аудитория, каналы).
  // Сразу открываем её на правку — обычно копию делают, чтобы что-то поменять.
  async function duplicateTemplate(tplId: number) {
    try {
      const copy = await api.conference.templates.duplicate(eventId, tplId)
      const fresh = await api.conference.templates.list(eventId)
      setTemplates(fresh.templates || [])
      const created = (fresh.templates || []).find((x: any) => x.id === copy.id) || copy
      openEdit(created)
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function removeTemplate(tplId: number, tplName?: string) {
    // Уже поставленные в очередь рассылки НЕ удаляются: у них свой снимок текста,
    // а связь с шаблоном просто обнуляется (FK ON DELETE SET NULL). Типовой шаблон
    // потом можно вернуть кнопкой «Добавить шаблон» (готовые пресеты).
    const name = tplName ? `«${tplName}»` : 'шаблон'
    if (!confirm(
      `Удалить ${name}?\n\n` +
      'Рассылки, уже стоящие в очереди, останутся и уйдут как есть — удаляется только сам шаблон. ' +
      'Добавить его обратно можно кнопкой «Добавить шаблон».'
    )) return
    try {
      await api.conference.templates.delete(eventId, tplId)
      setTemplates(templates.filter((x: any) => x.id !== tplId))
    } catch (e: any) {
      alert(e.message)
    }
  }

  /** Пункты навигации из ответа API → массив. JSONB может прийти строкой. */
  function parseNavItems(raw: any): any[] {
    if (!raw) return []
    if (Array.isArray(raw)) return raw
    if (typeof raw === 'string') {
      try {
        const v = JSON.parse(raw)
        return Array.isArray(v) ? v : []
      } catch { return [] }
    }
    return []
  }

  function openEdit(t: any) {
    setEditModal(t)
    setForm({
      name: t.name,
      type: t.type,
      subject: t.subject || '',
      text: (t.text || '').replace(/\\n/g, '\n'),
      photo_url: t.photo_url || '',
      video_url: t.video_url || '',
      media_type: (t.media_type || (t.photo_url ? 'photo' : null)) as 'photo' | 'video' | null,
      button_text: t.button_text || '',
      button_url: t.button_url || '',
      audience_include: t.audience_include || 'all_event',
      audience_exclude: t.audience_exclude || 'none',
      intro_start_time: t.intro_start_time
        || (t.type === 'pre_conf' ? '10:43'
          : String(t.type || '').startsWith('day_before_09_12') ? '09:12' : '11:00'),
      intro_interval_min: t.intro_interval_min || 15,
      intro_days_before: t.intro_days_before || 1,
      intro_roles: Array.isArray(t.intro_roles) ? t.intro_roles : null,
      send_to_event_chats: !!t.send_to_event_chats,
      send_to_client_chats: !!t.send_to_client_chats,
      send_to_private_chats: !!t.send_to_private_chats,
      send_to_speakers_chat: !!t.send_to_speakers_chat,
      speaker_photo_mode: t.speaker_photo_mode || 'poster',
      custom_bind_kind: t.custom_bind_kind || 'day',
      custom_day_ref: t.custom_day_ref || '',
      custom_time: t.custom_time || '12:00',
      custom_slot_session_id: t.custom_slot_session_id ?? null,
      custom_slot_offset_min: t.custom_slot_offset_min ?? 0,
      // datetime-local хочет "YYYY-MM-DDTHH:MM" в локальном времени.
      custom_fire_at: t.custom_fire_at ? toLocalInputValue(t.custom_fire_at) : '',
      target_channel_ids: Array.isArray(t.target_channel_ids) ? t.target_channel_ids : null,
      // Навигация по чату. ⚠️ JSONB иногда приходит строкой — разбираем, иначе
      // редактор получил бы строку вместо списка и показал «пунктов нет».
      nav_items: parseNavItems(t.nav_items),
      // Закреп по умолчанию включён: навигация без закрепа утонет в чате.
      pin_in_chat: t.pin_in_chat !== false,
    } as any)
  }

  async function openPreview(tpl: any, def: TypeDef) {
    // Ждём актуальных данных из БД перед открытием превью.
    // Спикеров тоже перезагружаем — чтобы свежий подарок (ручной/ПЛЮСОН)
    // подставлялся при смене спикера в модалке БЕЗ перезагрузки страницы.
    const [daysR, confR, sessionsR, speakersR] = await Promise.all([
      api.conference.days.list(eventId).catch(() => ({ days: [] })),
      api.conference.get(eventId).catch(() => ({ conference: null })),
      api.conference.sessions.list(eventId).catch(() => ({ sessions: [] })),
      api.conference.speakers.list(eventId).catch(() => ({ speakers: [] })),
    ])
    const days = daysR.days || []
    const dayNums = days.map((d: any) => d.day_number).sort((a: number, b: number) => a - b)
    if (dayNums.length > 0) setConfDays(dayNums)
    setConfDaysData(days)
    // ⚠️ День превью — ПЕРВЫЙ РЕАЛЬНЫЙ день программы, а не «1». У турнира дни идут
    // 2, 3, 4, 6… — при дефолтном testDay=1 такого дня нет, и превью показывало
    // заглушки «[программа дня]» вместо настоящей программы.
    if (dayNums.length > 0 && !dayNums.includes(testDay)) setTestDay(dayNums[0])
    if (confR.conference) setConfData(confR.conference)
    setConfSessions(sessionsR.sessions || [])
    const freshSpeakers = [...(speakersR.speakers || [])].sort(
      (a: any, b: any) => (a.name || '').localeCompare(b.name || '', 'ru'))
    setSpeakers(freshSpeakers)
    setPreviewModal({ tpl, def })
    setPreviewSpeakerId(freshSpeakers[0]?.id ?? null)
  }

  function openTest(tpl: any, def: TypeDef) {
    setTestModal({ tpl, def })
    setTestResult(null)
    setTestDay(confDays[0] ?? 1)
  }

  async function runTest() {
    if (!testModal) return
    setTestSending(true)
    setTestResult(null)
    try {
      const ALL_DAYS_TYPES = ['2h_before_unreg', '2h_before_reg', 'day_live', 'day_end']
      const SINGLE_DAY_TYPES: string[] = []
      const isDayAllType = ALL_DAYS_TYPES.includes(testModal.def.type)
      const isDaySingleType = SINGLE_DAY_TYPES.includes(testModal.def.type)
      if (isDayAllType) {
        // Шлём для всех дней
        const allDetails: any[] = []
        for (const d of confDays) {
          const r = await api.conference.templates.test(eventId, testModal.tpl.id, d)
          if (r.details) allDetails.push(...r.details)
        }
        setTestResult({ ok: true, sent: allDetails.length, details: allDetails })
      } else if (isDaySingleType) {
        // Шлём только для выбранного дня
        const r = await api.conference.templates.test(eventId, testModal.tpl.id, testDay)
        setTestResult(r)
      } else {
        const res = await api.conference.templates.test(eventId, testModal.tpl.id, testDay)
        setTestResult(res)
      }
    } catch (e: any) {
      setTestResult({ ok: false, error: e.message })
    } finally {
      setTestSending(false)
    }
  }

  const currentType = TYPE_DEFS.find(d => d.type === form.type)
  const previewSpeaker = previewSpeakerId ? speakers.find(s => s.id === previewSpeakerId) : null

  // Ссылка эфира — ГОТОВАЯ с сервера (confData.stream_links), считается тем же
  // резолвером, что при отправке: сторонний вебинар → его адрес, наша комната →
  // pluson.ru/webinar/{slug}/{day}, комнаты нет → пусто.
  // ⚠️ Сами адрес НЕ склеиваем: раньше фронт всегда рисовал нашу комнату, даже
  // когда её не создавали или когда эфир идёт на стороннем сервисе.
  function getStreamUrl(day?: number): string {
    const links = (confData as any)?.stream_links || {}
    return String(links[String(day ?? 1)] || '')
  }

  // Нет комнаты у дня → в превью ругаемся красным, а не подставляем выдумку.
  // Смотрим на САМ шаблон (tpl), а не на открытый редактор: превью можно
  // открыть, ничего не редактируя.
  function streamMissing(tpl: any, day?: number): boolean {
    const usesStream = String(tpl?.text || '').includes('{stream_url}')
      || String(tpl?.button_url || '').includes('{stream_url}')
    return usesStream && !getStreamUrl(day)
  }

  function getGameLink(): string {
    // Превью {game_link}: уходит к уже зарегистрированным — pid не нужен, их реферер
    // уже учтён при регистрации. В реальной рассылке ссылка строится в Celery
    // через СВОЙ бот клиента. Здесь превью: есть свой бот — показываем его, иначе
    // веб-страницу события (системный @pluson_bot в превью не показываем — 2026-07-08).
    const slug = eventData?.slug || '{slug}'
    const handle = (eventData as any)?.client_bot_handle || (confData as any)?.client_bot_handle || ''
    if (handle) return `https://telegram.me/${handle}?startapp=ref_pg${slug}_tabgame`
    return `${publicBase}/event/${slug}#game`
  }

  // Ссылка на воронку подарка-лид-магнита по площадке (тот же формат, что бэк
  // build_funnel_landing_links). kind: 'm' лид-магнит | 'p' пакет.
  // Приоритет по площадке рассылки: max→vk→tg, vk→max→tg, tg→max→vk.
  function giftFunnelLink(kind: string, slug: string, platform: 'telegram' | 'vk' | 'max' | 'email'): string {
    const bh = (me as any)?.bot_handles || {}
    const vkApp = (me as any)?.vk_app_id
    const tg = bh.telegram ? `https://telegram.me/${String(bh.telegram).replace(/^@/, '')}?start=${kind}_${slug}` : ''
    const vk = (bh.vk && vkApp) ? `https://vk.com/app${vkApp}#${kind}_${slug}` : ''
    const max = bh.max ? `https://max.ru/${String(bh.max).replace(/^@/, '')}?start=${kind}_${slug}` : ''
    const links: Record<string, string> = { telegram: tg, vk, max }
    const order = platform === 'max' ? ['max', 'vk', 'telegram']
      : platform === 'vk' ? ['vk', 'max', 'telegram']
      : ['telegram', 'max', 'vk']
    for (const p of order) if (links[p]) return links[p]
    return ''
  }

  // {landing_url} — страница регистрации события. ⚠️ Тот же порядок, что на
  // сервере (resolve_landing_url): способ регистрации главнее, а не «есть ли
  // сторонний адрес». Раньше подставлялся только сторонний сайт, и у события
  // со встроенным лендингом плейсхолдер уходил ПУСТЫМ.
  function landingUrl(): string {
    const slug = (confData as any)?.event_slug || ''
    const ext = ((confData as any)?.event_landing_url || '').trim()
    const mode = (confData as any)?.registration_mode
    const form = slug ? `${publicBase}/event/${slug}/register` : ''
    if (mode === 'external') return ext || form
    if (mode === 'landing') return slug ? `${publicBase}/e/${slug}` : form
    if (mode === 'form') return form
    // Способ не задан (старые события) — как раньше: сторонний, иначе форма.
    return ext || form
  }

  // {signup_link} — ссылка «Зарегистрироваться» в боте площадки получателя.
  // ⚠️ Формат ref_pg{slug}, как в «Публичных ссылках»: evsignup_ — это
  // callback уже нажатой кнопки ВНУТРИ бота, обработчика /start с таким
  // аргументом нет, и ссылка вела в никуда.
  function signupLink(platform: 'telegram' | 'vk' | 'max' | 'email'): string {
    const bh = (me as any)?.bot_handles || {}
    const slug = (confData as any)?.event_slug || ''
    const payload = `ref_pg${slug}`
    // ⚠️ Режим площадки (Mini App / бот) — как на сервере
    // (share_links.build_event_signup_links). Превью строило ТОЛЬКО бот-ссылки
    // и настройку «Вход через Мини-апп» не спрашивало: клиент видел одно, а
    // человеку уходило другое.
    const lm = (me as any)?.link_modes || {}
    const isApp = (p: string) => lm[p] === 'miniapp'
    const vkAppId = (me as any)?.vk_app_id
    const tg = bh.telegram
      ? (isApp('telegram')
          ? `https://telegram.me/${String(bh.telegram).replace(/^@/, '')}?startapp=${payload}`
          : `https://telegram.me/${String(bh.telegram).replace(/^@/, '')}?start=${payload}`)
      : ''
    // ⚠️ У ВК Mini App живёт по НОМЕРУ приложения: без него — бот-ссылка.
    const vk = bh.vk
      ? (isApp('vk') && vkAppId
          ? `https://vk.com/app${vkAppId}#${payload}`
          : `https://vk.me/${String(bh.vk).replace(/^@/, '')}?ref=${payload}`)
      : ''
    const max = bh.max
      ? (isApp('max')
          ? `https://max.ru/${String(bh.max).replace(/^@/, '')}?startapp=${payload}`
          : `https://max.ru/${String(bh.max).replace(/^@/, '')}?start=${payload}`)
      : ''
    const links: Record<string, string> = { telegram: tg, vk, max }
    // ⚠️ Выключенные у события площадки исключаем — ровно как сервер при
    // отправке. Иначе в превью на вкладке ВК стояла вк-ссылка, хотя ВК у
    // события снят галочкой и человека надо уводить в MAX.
    for (const p of ((confData as any)?.disabled_platforms || [])) links[p] = ''
    // Правило то же, что на сервере (share_links.pick_signup_link): своя
    // площадка → только она; своей нет (нет бота или площадка выключена) →
    // ВСЕ имеющиеся с подписью, чтобы никто не остался без рабочей ссылки.
    if (links[platform]) return links[platform]
    const rest = MULTI_LINK_ORDER.filter(p => links[p]).map(p => `${PLATFORM_LABEL_RU[p]}: ${links[p]}`)
    if (rest.length) return rest.join('\n')
    // Своего бота нет ни на одной площадке — уводим на веб-страницу регистрации
    // (тот же фолбэк, что на сервере), иначе кнопка была бы пустой.
    return landingUrl()
  }

  // Ссылка подарка-магнита для превью.
  // ⚠️ Берём ГОТОВЫЕ ссылки владельца магнита (owner_links с сервера): подарок
  // выдаётся через бот ТОГО, ЧЕЙ ЭТО ПОДАРОК, а не того, кто шлёт рассылку.
  // Раньше собиралось из своих ботов — чужой подарок вёл в свой бот.
  // Ручной подарок — прямая ссылка как есть.
  function giftMagnetUrl(g: any, platform: 'telegram' | 'vk' | 'max' | 'email'): string {
    const ol = g?.owner_links
    if (ol) {
      // Правило то же, что при отправке (share_links.pick_gift_funnel_link):
      // есть ссылка на площадке получателя → только она; своей нет (у спикера,
      // скажем, нет ВК) → ВСЕ имеющиеся с подписью площадки.
      if (ol[platform]) return String(ol[platform])
      const rest = MULTI_LINK_ORDER.filter(p => ol[p]).map(p => `${PLATFORM_LABEL_RU[p]}: ${ol[p]}`)
      if (rest.length) return rest.join('\n')
    }
    if (g?.funnel_slug && g?.funnel_kind) return giftFunnelLink(g.funnel_kind, g.funnel_slug, platform)
    return g?.url || ''
  }

  function renderPreviewText(text: string, speaker: any | null, tplType?: string, day?: number, platform: 'telegram' | 'vk' | 'max' | 'email' = 'telegram', navItems?: any[]): string {
    if (!text) return ''
    // Нормализуем литеральные \n на случай старых данных из БД
    let out = text.replace(/\\n/g, '\n')
    // {signup_link} — зависит от площадки получателя, поэтому раскрываем
    // здесь же, а не в общем списке плейсхолдеров.
    out = out.replace(/\{signup_link\}/g, signupLink(platform))

    // {chat_nav_items} — пункты навигации по чату. ⚠️ Настоящие ссылки строит
    // СЕРВЕР (у каждой площадки свой бот, у магнита — бот его владельца), здесь
    // их взять неоткуда. Поэтому показываем состав и порядок пунктов, а вместо
    // адреса — подпись, что подставится при отправке. Иначе в превью висел бы
    // сырой {chat_nav_items}, и человек не понял бы, что получится.
    if (out.includes('{chat_nav_items}')) {
      // ⚠️ Пункты приходят ПАРАМЕТРОМ, а не из form: превью открывается для
      // ЛЮБОГО шаблона из списка, а form в этот момент хранит другой (или
      // ничего). Из формы брать можно только когда превью показывает её же.
      const items: any[] = parseNavItems(navItems ?? (form as any)?.nav_items)
      const KIND_PREVIEW: Record<string, string> = {
        vip: 'ссылка на тариф события',
        cabinet: 'ссылка на кабинет участника (подарки)',
        support: 'ссылка на тех.поддержку',
        magnet: 'ссылка на лид-магнит',
      }
      let n = 0
      const lines = items.map((it: any) => {
        const manual = it?.kind === 'rules' || it?.kind === 'link'
        const url = (it?.url || '').trim()
        // Пункт без ссылки не уходит вовсе — и в превью его тоже не показываем.
        if (manual && !url) return null
        if (it?.kind === 'magnet' && !it?.magnet_id) return null
        n += 1
        const label = (it?.label || '').trim()
        const shown = manual ? url : `<i>${KIND_PREVIEW[it?.kind] || 'ссылка'}</i>`
        return label ? `${n}.${label}\n${shown}` : `${n}.${shown}`
      }).filter(Boolean)
      out = lines.length
        ? out.replace(/\{chat_nav_items\}/g, lines.join('\n\n'))
        : out.replace(/^.*\{chat_nav_items\}.*$\n?/gm, '')
    }

    if (speaker) {
      const giftTitle = (speaker.gift_after_speech_title || '').trim()
      const giftUrl = (speaker.gift_after_speech_url || '').trim()
      const rawTg = (speaker.personal_tg_username || '').trim()
      const tgUrl = rawTg ? '@' + rawTg.replace(/^@+/, '') : ''
      const giftRaffle = (speaker.gift_raffle_title || '').trim()

      if (tplType === 'speaker_intro' || tplType === 'expert_day') {
        const ROLE_MAP: Record<string, string> = { speaker: 'Спикер', headliner: 'Хедлайнер', partner: 'Партнёр', organizer: 'Организатор', jury: 'Жюри' }
        const roleLabel = ROLE_MAP[speaker.role] || 'Спикер'
        const tgChannel = (speaker.tg_channel_url || '').trim()
        const insta = (speaker.instagram_url || '').trim()
        const achList: string[] = (speaker.achievements || []).filter((a: string) => a && a.trim())
        // Все темы спикера через перенос строки (раньше брали только первую,
        // и у спикеров с темами на каждый день вторая «терялась»).
        const topicsArr: string[] = (Array.isArray(speaker.topics) && speaker.topics.length > 0)
          ? speaker.topics.map((t: any) => (t?.topic || '').trim()).filter(Boolean)
          : ((speaker.topic || '').trim() ? [(speaker.topic || '').trim()] : [])
        const topic = topicsArr.join('\n')
        // {speaker_topic_full} — название + описание через пустую строку.
        const topicFullArr: string[] = (Array.isArray(speaker.topics) && speaker.topics.length > 0)
          ? speaker.topics.map((t: any) => {
              const n = (t?.topic || '').trim()
              const d = (t?.description || '').trim()
              return n ? (d ? `${n}\n\n${d}` : n) : ''
            }).filter(Boolean)
          : topicsArr
        const topicFull = topicFullArr.join('\n\n')
        // {speaker_topic_desc} — только описания (с заголовком «Что будет:»).
        const topicDescRaw: string = (Array.isArray(speaker.topics) && speaker.topics.length > 0)
          ? speaker.topics.map((t: any) => (t?.description || '').trim()).filter(Boolean).join('\n\n')
          : ''
        const topicDesc = topicDescRaw ? `<b>Что будет:</b>\n${topicDescRaw}` : ''
        const achText = achList.map((a: string) => `• ${a}`).join('\n')
        if (!topicDescRaw) out = out.replace(/^[^\n]*\{speaker_topic_desc\}[^\n]*\n?/gm, '')

        // Сначала убираем строки с пустыми плейсхолдерами (пока они ещё в тексте)
        if (!topic) {
          // _full первым — {speaker_topic} является его подстрокой.
          out = out.replace(/^[^\n]*\{speaker_topic_full\}[^\n]*\n?/gm, '')
          out = out.replace(/^[^\n]*\{speaker_topic\}[^\n]*\n?/gm, '')
        }
        if (!achText) {
          out = out.replace(/^[^\n]*О спикере[^\n]*\n?/gm, '')
          out = out.replace(/^[^\n]*\{speaker_achievements\}[^\n]*\n?/gm, '')
        }
        if (!giftTitle) out = out.replace(/^[^\n]*\{gift_after_speech_title\}[^\n]*\n?/gm, '')
        if (!giftRaffle) out = out.replace(/^[^\n]*\{gift_raffle_title\}[^\n]*\n?/gm, '')
        if (!tgChannel) out = out.replace(/^[^\n]*\{speaker_tg\}[^\n]*\n?/gm, '')
        if (!insta) out = out.replace(/^[^\n]*\{speaker_instagram\}[^\n]*\n?/gm, '')
        // {speaker_socials} — все соцсети спикера списком (личный TG, TG-канал, VK,
        // MAX, Instagram, сайт). Старый синоним оставлен для совместимости.
        const socialsLines: string[] = []
        if (tgUrl) socialsLines.push(tgUrl)
        if (tgChannel) socialsLines.push(tgChannel)
        const vkU = (speaker.vk_url || '').trim(); if (vkU) socialsLines.push(vkU)
        const maxU = (speaker.max_url || '').trim(); if (maxU) socialsLines.push(maxU)
        if (insta) socialsLines.push(insta)
        const siteU = (speaker.website_url || '').trim(); if (siteU) socialsLines.push(siteU)
        const socialsBlock = socialsLines.join('\n')
        if (!socialsBlock) {
          out = out.replace(/^[^\n]*\{speaker_personal_tg\}[^\n]*\n?/gm, '')
          out = out.replace(/^[^\n]*\{speaker_socials\}[^\n]*\n?/gm, '')
        }
        // {speaker_tg_username} — только личный @ник спикера в Telegram.
        if (!tgUrl) out = out.replace(/^[^\n]*\{speaker_tg_username\}[^\n]*\n?/gm, '')

        // Потом подставляем значения
        out = out
          .replace(/\{speaker_tg_username\}/g, tgUrl)
          .replace(/\{speaker_personal_tg\}/g, socialsBlock)
          .replace(/\{speaker_socials\}/g, socialsBlock)
          .replace(/\{speaker_name\}/g, speaker.name || '')
          .replace(/\{speaker_role\}/g, roleLabel)
          .replace(/\{speaker_topic_full\}/g, topicFull)
          .replace(/\{speaker_topic_desc\}/g, topicDesc)
          .replace(/\{speaker_topic\}/g, topic)
          .replace(/\{speaker_achievements\}/g, achText)
          .replace(/\{gift_after_speech_title\}/g, giftTitle)
          .replace(/\{gift_raffle_title\}/g, giftRaffle)
          .replace(/\{landing_url\}/g, landingUrl())
        if (tgChannel) out = out.replace(/\{speaker_tg\}/g, `<b>Тг канал:</b> ${tgChannel}`)
        if (insta) out = out.replace(/\{speaker_instagram\}/g, `<b>Нельзяграм:</b> ${insta}`)

        out = out.replace(/\n{3,}/g, '\n\n').trim()
      } else if (tplType === 'gift') {
        // Убираем строки с переменными подарка — заменим всё блоком по правилам
        out = out.replace(/^.*\{gift_title\}.*$\n?/gm, '')
        out = out.replace(/^.*\{gift_url\}.*$\n?/gm, '')

        // Список подарков-лид-магнитов спикера (до 4, миграция 200). Приоритет
        // ручному подарку; иначе показываем все магниты «Название\nссылка».
        // ⚠️ Подарков может быть СКОЛЬКО УГОДНО и любого вида — и ручные, и
        // плюсоновские, одновременно. Раньше ручной подарок глушил весь список
        // магнитов (показывался только он), а магнитов брался только первый.
        const magnets: Array<{ title: string; url: string }> = (Array.isArray(speaker.gift_magnets) ? speaker.gift_magnets : [])
          .filter((g: any) => g && g.name)
          .map((g: any) => ({ title: g.name, url: giftMagnetUrl(g, platform) }))
        // Одиночный ручной подарок (старые поля) — в тот же список, без дублей.
        if (giftTitle && !magnets.some((m) => m.title === giftTitle)) {
          magnets.unshift({ title: giftTitle, url: giftUrl || '' })
        }
        let giftBlock = ''
        if (magnets.length) {
          giftBlock = magnets.map((g) => (g.url ? `${g.title}\n${g.url}` : g.title)).join('\n\n')
        } else if (!giftTitle) {
          giftBlock = tgUrl
            ? `🎁 Чтобы забрать материалы — пишите в личку ${tgUrl}`
            : `🎁 Чтобы забрать материалы — напишите спикеру в личку`
        } else if (!giftUrl) {
          giftBlock = tgUrl ? `${giftTitle}\nПишите в личку ${tgUrl}` : giftTitle
        } else {
          giftBlock = `${giftTitle}\n${giftUrl}`
        }
        out = out.trimEnd() + '\n\n' + giftBlock
        out = out
          .replace(/\{speaker_name\}/g, speaker.name || '')
          .replace(/\{speaker_topic_full\}/g, ((Array.isArray(speaker.topics) && speaker.topics.length > 0)
            ? speaker.topics.map((t: any) => {
                const n = (t?.topic || '').trim(); const d = (t?.description || '').trim()
                return n ? (d ? `${n}\n\n${d}` : n) : ''
              }).filter(Boolean).join('\n\n')
            : speaker.topic) || 'уточняется')
          .replace(/\{speaker_topic_desc\}/g, (() => {
            const d = (Array.isArray(speaker.topics) && speaker.topics.length > 0)
              ? speaker.topics.map((t: any) => (t?.description || '').trim()).filter(Boolean).join('\n\n') : ''
            return d ? `<b>Что будет:</b>\n${d}` : ''
          })())
          .replace(/\{speaker_topic\}/g, ((Array.isArray(speaker.topics) && speaker.topics.length > 0) ? speaker.topics.map((t: any) => t?.topic || '').filter(Boolean).join('\n') : speaker.topic) || 'уточняется')
          .replace(/\{stream_url\}/g, getStreamUrl(day))
      } else {
        // pre_start и другие спикерские шаблоны
        if (giftUrl) {
          out = out.replace(/\{gift_url\}/g, giftUrl)
        } else {
          out = out.replace(/^.*\{gift_url\}.*$\n?/gm, '')
        }
        if (giftTitle) {
          out = out.replace(/\{gift_title\}/g, giftTitle)
          out = out.replace(/\{gift_after_speech_title\}/g, giftTitle)
        } else {
          out = out.replace(/^.*\{gift_title\}.*$\n?/gm, '')
          out = out.replace(/^.*\{gift_after_speech_title\}.*$\n?/gm, '')
        }
        if (giftRaffle) {
          out = out.replace(/\{gift_raffle_title\}/g, giftRaffle)
        } else {
          out = out.replace(/^.*\{gift_raffle_title\}.*$\n?/gm, '')
        }
        out = out
          .replace(/\{speaker_name\}/g, speaker.name || '')
          .replace(/\{speaker_topic_full\}/g, ((Array.isArray(speaker.topics) && speaker.topics.length > 0)
            ? speaker.topics.map((t: any) => {
                const n = (t?.topic || '').trim(); const d = (t?.description || '').trim()
                return n ? (d ? `${n}\n\n${d}` : n) : ''
              }).filter(Boolean).join('\n\n')
            : speaker.topic) || 'уточняется')
          .replace(/\{speaker_topic_desc\}/g, (() => {
            const d = (Array.isArray(speaker.topics) && speaker.topics.length > 0)
              ? speaker.topics.map((t: any) => (t?.description || '').trim()).filter(Boolean).join('\n\n') : ''
            return d ? `<b>Что будет:</b>\n${d}` : ''
          })())
          .replace(/\{speaker_topic\}/g, ((Array.isArray(speaker.topics) && speaker.topics.length > 0) ? speaker.topics.map((t: any) => t?.topic || '').filter(Boolean).join('\n') : speaker.topic) || 'уточняется')
          .replace(/\{stream_url\}/g, getStreamUrl(day))
      }

      // {speaker_material} — материал спикера в базу знаний.
      // Материал есть ТОЛЬКО при заполненной ссылке (пробелы = пусто). Нет ссылки →
      // материала нет, строку убираем (даже если название задано). Формат:
      //   Уже сейчас вам доступен полезный материал: "Название"
      //   Ссылка
      const kbT = (speaker.knowledge_base_title || '').trim()
      const kbU = (speaker.knowledge_base_url || '').trim()
      const material = !kbU
        ? ''
        : (kbT
            ? `Уже сейчас вам доступен полезный материал: "${kbT}"\n${kbU}`
            : `Уже сейчас вам доступен полезный материал:\n${kbU}`)
      if (out.includes('{speaker_material}')) {
        out = material
          ? out.replace(/\{speaker_material\}/g, material)
          : out.replace(/^[^\n]*\{speaker_material\}[^\n]*\n?/gm, '')
      }

      // {speaker_notes} — заметки спикера (шпаргалка под этого спикера в событии).
      // Пусто → убираем строку с плейсхолдером; едино для всех спикерских шаблонов.
      const notes = (speaker.notes || '').trim()
      if (out.includes('{speaker_notes}')) {
        out = notes
          ? out.replace(/\{speaker_notes\}/g, notes)
          : out.replace(/^[^\n]*\{speaker_notes\}[^\n]*\n?/gm, '')
      }

      // {speaker_time}/{speaker_date}/{speaker_datetime} — слот выступления спикера
      // (первая его сессия в программе). Не задано — строка убирается.
      const MONTHS_SLOT = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
      // ⚠️ Сначала ищем слот ВЫБРАННОГО в превью дня, и только если его нет —
      // первый по всей программе. У спикера с выступлениями в нескольких днях
      // (Марго — в четырёх) превью показывало время чужого дня: выбран день 4
      // (11:00–11:25), а в тексте стояло 11:00–11:30 из дня 1.
      const allSlots = [...confSessions]
        .filter((s: any) => s.speaker_id === speaker.id)
        .sort((a: any, b: any) => (a.day - b.day) || String(a.start_time || '').localeCompare(String(b.start_time || '')))
      const slot = allSlots.find((s: any) => s.day === day) || allSlots[0]
      const slotStart = slot ? String(slot.start_time || '').slice(0, 5) : ''
      const slotEnd = slot ? String(slot.end_time || '').slice(0, 5) : ''
      const slotDayObj = slot ? confDaysData.find((x: any) => x.day_number === slot.day) : null
      const slotTime = slotStart ? (slotEnd ? `${slotStart}–${slotEnd} МСК` : `${slotStart} МСК`) : ''
      let slotDate = ''
      if (slotDayObj?.day_date) {
        const dd = new Date(slotDayObj.day_date + 'T12:00:00')
        slotDate = `${dd.getDate()} ${MONTHS_SLOT[dd.getMonth()]}`
      }
      const slotDatetime = (slotDate && slotTime) ? `${slotDate}, ${slotTime}` : (slotDate || slotTime)
      // {speaker_when}: «Сегодня/Завтра в HH:MM МСК», иначе «6 июля в HH:MM МСК».
      const slotWhen = relativeWhenPreview(slotDayObj?.day_date, slotStart)
      const slotMap: Record<string, string> = {
        speaker_time: slotTime, speaker_date: slotDate, speaker_datetime: slotDatetime,
        speaker_when: slotWhen,
      }
      for (const [k, v] of Object.entries(slotMap)) {
        const re = new RegExp('\\{' + k + '\\}', 'g')
        if (out.match(re)) {
          out = v ? out.replace(re, v) : out.replace(new RegExp('^[^\\n]*\\{' + k + '\\}[^\\n]*\\n?', 'gm'), '')
        }
      }

      // ── speakers_call: ник спикера, вход в зум и СЛЕДУЮЩИЙ по программе ──
      // ⚠️ {speaker_tg_username} выше раскрывается только в ветке speaker_intro /
      // expert_day, а «вы следующие» попадает в общий else — без этого блока ник,
      // зум и «Готовится…» уходили в превью сырыми (как на скриншоте).
      if (tplType === 'speakers_call') {
        // Ник текущего спикера. Пусто → убираем только «(...)», а не строку:
        // в заголовке рядом стоит {speaker_name}, он значимый.
        if (!tgUrl) out = out.replace(/ \(\{speaker_tg_username\}\)/g, '')
        out = out.replace(/\{speaker_tg_username\}/g, tgUrl)

        // Вход спикера в зум — поле ДНЯ этого слота (webinar_rooms.speaker_join_url).
        const joinDay = day
        const joinUrl = String(
          confDaysData.find((x: any) => x.day_number === joinDay)?.speaker_join_url || ''
        ).trim()
        out = joinUrl
          ? out.replace(/\{speaker_join_url\}/g, joinUrl)
          // Ссылка на отдельной строке под подписью «Ссылка для входа (Zoom):» —
          // убираем и подпись, иначе останется заголовок без ссылки.
          : out.replace(/^[^\n]*:[ \t]*\n[^\n]*\{speaker_join_url\}[^\n]*\n?/gm, '')
               .replace(/^[^\n]*\{speaker_join_url\}[^\n]*\n?/gm, '')

        // ⚠️ У спикера слоты бывают в НЕСКОЛЬКИХ днях (Марго — в четырёх), а
        // общий `slot` выше берёт первый по всей программе. Для «вы следующие»
        // нужен слот ВЫБРАННОГО в превью дня, иначе показывались бы время и
        // сосед из другого дня. Нет слота в этом дне — падаем на общий.
        const daySlot = [...confSessions]
          .filter((x: any) => x.speaker_id === speaker.id && x.day === day)
          .sort((a: any, b: any) => String(a.start_time || '').localeCompare(String(b.start_time || '')))[0]
          || slot

        // Следующий слот со спикером В ТОМ ЖЕ дне (как на бэке).
        const nx = daySlot
          ? [...confSessions]
              .filter((x: any) => x.day === daySlot.day && x.speaker_id
                && String(x.start_time || '') > String(daySlot.start_time || ''))
              .sort((a: any, b: any) => String(a.start_time || '').localeCompare(String(b.start_time || '')))[0]
          : null
        const nxSpeaker = nx ? speakers.find((sp: any) => sp.id === nx.speaker_id) : null
        const nxName = (nxSpeaker?.name || '').trim()
        const nxRawTg = (nxSpeaker?.personal_tg_username || '').trim()
        const nxTg = nxRawTg ? '@' + nxRawTg.replace(/^@+/, '') : ''
        const nxStart = nx ? String(nx.start_time || '').slice(0, 5) : ''
        const nxEnd = nx ? String(nx.end_time || '').slice(0, 5) : ''
        const nxTime = nxStart ? (nxEnd ? `${nxStart}–${nxEnd} МСК` : `${nxStart} МСК`) : ''
        if (!nxName) {
          // Последний слот дня → строки «Готовится…» нет вовсе.
          for (const k of ['next_speaker_name', 'next_speaker_tg_username', 'next_speaker_time']) {
            out = out.replace(new RegExp('^[^\\n]*\\{' + k + '\\}[^\\n]*\\n?', 'gm'), '')
          }
        } else {
          if (!nxTg) out = out.replace(/ \(\{next_speaker_tg_username\}\)/g, '')
          out = out
            .replace(/\{next_speaker_name\}/g, nxName)
            .replace(/\{next_speaker_tg_username\}/g, nxTg)
            .replace(/\{next_speaker_time\}/g, nxTime)
        }
      }

      // Глобальные плейсхолдеры: {brand_name} + {event_chat_tg|vk|max}.
      // Пусто → убираем строку; едино для всех спикерских шаблонов (в т.ч. expert_day).
      const chatMap: Record<string, string> = {
        event_chat_tg: (confData?.chat_url_tg || '').trim(),
        event_chat_vk: (confData?.chat_url_vk || '').trim(),
        event_chat_max: (confData?.chat_url_max || '').trim(),
      }
      for (const [k, v] of Object.entries(chatMap)) {
        const re = new RegExp('\\{' + k + '\\}', 'g')
        if (out.match(re)) {
          out = v ? out.replace(re, v) : out.replace(new RegExp('^[^\\n]*\\{' + k + '\\}[^\\n]*\\n?', 'gm'), '')
        }
      }
      out = out.replace(/\{brand_name\}/g, confData?.event_brand_name || eventData?.brand_name || '[бренд]')

      out = out.replace(/\n{3,}/g, '\n\n').trim()
    }

    const d = day ?? testDay
    const dayObj = confDaysData.find((x: any) => x.day_number === d)
    // Для конференции — данные из conf_days/conf_conferences. Для мероприятия —
    // прямые поля events.title / events.landing_url.
    // ⚠️ Ссылка эфира — ТОЛЬКО через getStreamUrl (готовые stream_links с
    // сервера: сторонний вебинар или наша комната). Поля conf_days.stream_url
    // больше нет — дневные шаблоны («за 30 минут», «старт дня», «за 2 часа»)
    // показывали заглушку «[ссылка на эфир]», хотя комната задана.
    const realStreamUrl = getStreamUrl(d)
    // Ссылка регистрации приходит с бэка уже готовой (registration_link): она
    // учитывает способ регистрации события и НЕ бывает пустой. Сторонний
    // landing_url — фолбэк для старых ответов API.
    const realRegUrl = confData?.registration_link
      || confData?.event_landing_url || eventData?.landing_url || ''
    const realConfTitle = confData?.event_title || confData?.title || eventData?.title || '[Название события]'
    const realDayDate = dayObj?.day_date
      ? new Date(dayObj.day_date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
      : `День ${d}`

    // Строим программу дня из сессий
    const daySessions = confSessions.filter((s: any) => s.day === d)
    const ROLE_LABELS: Record<string, string> = { headliner: 'Хедлайнер', partner: 'Партнёр', organizer: 'Организатор', jury: 'Жюри' }
    const dayProgram = daySessions.length > 0
      ? daySessions.map((s: any) => {
          const fmt = (v: string) => v ? String(v).slice(0, 5) : ''
          const timeStart = fmt(s.start_time)
          const timeEnd = fmt(s.end_time)
          let timePart = ''
          if (timeStart && timeEnd) timePart = `${timeStart}-${timeEnd} МСК`
          else if (timeStart) timePart = `${timeStart} МСК`
          const topic = s.title || ''
          const name = s.speaker_name || ''
          const role = s.speaker_role
          const roleLabel = ROLE_LABELS[role] ? ` — ${ROLE_LABELS[role]}` : ''
          const speakerPart = name ? ` (<b>${name}${roleLabel}</b>)` : ''
          const boldTime = timePart ? `<b>${timePart}</b>` : ''
          return `${boldTime}: ${topic}${speakerPart}`.trim()
        }).join('\n')
      : '[программа дня]'

    // {day_program_speakers} — тайминг ДЛЯ ЧАТА СПИКЕРОВ: «10:30–10:55 — Иван (@ivan)».
    // ⚠️ Формат обязан совпадать с бэком (_day_program_for_speakers в
    // message_builder.py): превью — вторая реализация подстановки, и разойтись
    // им нельзя, иначе клиент увидит одно, а уйдёт другое.
    // Только слоты СО СПИКЕРОМ: без имени строка бессмысленна.
    const dayProgramSpeakers = (() => {
      const lines = daySessions
        .filter((s: any) => (s.speaker_name || '').trim())
        .map((s: any) => {
          const fmt = (v: string) => v ? String(v).slice(0, 5) : ''
          const a = fmt(s.start_time), b = fmt(s.end_time)
          const when = a && b ? `${a}–${b}` : a
          if (!when) return ''
          const sp = speakers.find((x: any) => x.id === s.speaker_id)
          const rawTg = (sp?.personal_tg_username || '').trim().replace(/^@+/, '')
          const who = rawTg ? `${s.speaker_name} (@${rawTg})` : s.speaker_name
          return `<b>${when}</b> — ${who}`
        })
        .filter(Boolean)
      return lines.length ? lines.join('\n') : '[тайминг выступлений]'
    })()

    const ORDINALS: Record<number, string> = { 1: 'первом', 2: 'втором', 3: 'третьем', 4: 'четвёртом', 5: 'пятом' }
    const dayOrdinal = ORDINALS[d] || `${d}-м`
    const realRaffleUrl = confData?.raffle_url || ''

    // Подарки спикеров дня для превью.
    // Должно совпадать с backend/app/services/collaborator_sort.py — то же группирование.
    // Внутри группы здесь сортируем по priority — данных о реальных «приведённых» в
    // превью нет (это статичный мок), поэтому отдельный ключ referrals не учитывается.
    const roleOrder = (s: any) => {
      const r = s.speaker_role, c = s.is_commercial
      if (r === 'organizer')                       return 1
      if (c && r === 'jury')                       return 2
      if (c && r === 'headliner')                  return 3
      if (c && r === 'speaker')                    return 4
      if (c && r === 'general_partner')            return 5
      if (c && r === 'partner')                    return 6
      if (r === 'jury')                            return 7
      if (r === 'headliner')                       return 8
      if (r === 'speaker')                         return 9
      if (r === 'general_partner')                 return 10
      if (r === 'partner')                         return 11
      return 12
    }
    // ⚠️ ОДИН спикер — ОДИН блок подарков. Список строится из СЕССИЙ дня, а у
    // спикера их может быть несколько (у Марго Форбс — 2 в первый день и 3 во
    // второй) — без этого его подарки повторялись столько же раз. На бэкенде
    // то же самое делает DISTINCT ON (cse.id) в message_builder.
    const seenGiftSpeakers = new Set<any>()
    const speakerGiftBlocks = [...daySessions]
      .filter((s: any) => s.speaker_name && !s.exclude_gift_from_broadcast)
      .filter((s: any) => {
        const key = s.speaker_id ?? s.speaker_name
        if (seenGiftSpeakers.has(key)) return false
        seenGiftSpeakers.add(key)
        return true
      })
      .sort((a: any, b: any) => {
        const g = roleOrder(a) - roleOrder(b)
        if (g !== 0) return g
        return (a.priority ?? 60) - (b.priority ?? 60)
      })
      .map((s: any) => {
        const tg = (s.personal_tg_username || '').trim()
        const tgMention = tg ? '@' + tg.replace(/^@+/, '') : ''
        // ⚠️ Подарки берём из СПИСКА (ручные + плюсоновские, сколько угодно),
        // как при отправке. Раньше смотрели только на одиночное поле
        // gift_after_speech_title — у всех выходило «пишите в личку», хотя
        // подарки заданы. Плюсоновский подарок ведёт в бот ЕГО ВЛАДЕЛЬЦА.
        const list: Array<{ title: string; url: string }> = (Array.isArray(s.gift_magnets) ? s.gift_magnets : [])
          .filter((g: any) => g && g.title)
          .map((g: any) => ({ title: String(g.title), url: giftMagnetUrl(g, platform) }))
        const single = (s.gift_after_speech_title || '').trim()
        if (single && !list.some((g) => g.title === single)) {
          list.unshift({ title: single, url: (s.gift_after_speech_url || '').trim() })
        }
        // Подарка нет вовсе — спикера в перечне не показываем (как на бэке),
        // чтобы не было мусорных строк «пишите в личку».
        if (!list.length) return ''
        const body = list.length > 1
          ? list.map((g, i) => (g.url ? `${i + 1}. ${g.title}\n${g.url}` : `${i + 1}. ${g.title}`)).join('\n\n')
          : (list[0].url ? `${list[0].title}\n${list[0].url}`
              : `${list[0].title}${tgMention ? '\nПишите в личку ' + tgMention : ''}`)
        return `🎁 <b>${s.speaker_name}:</b>\n${body}`
      })
      .filter(Boolean)
    const daySpeakersGifts = speakerGiftBlocks.join('\n\n')

    // Умная фраза про следующий день
    const MONTHS_RU = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
    const nextDaySessions = confSessions.filter((s: any) => s.day === d + 1)
    let nextDayMention = ''
    const nextDayObj = confDaysData.find((x: any) => x.day_number === d + 1)
    if (nextDaySessions.length > 0 && nextDaySessions[0].start_time && nextDayObj?.day_date) {
      const nextTime = String(nextDaySessions[0].start_time).slice(0, 5)
      const curDayObj = confDaysData.find((x: any) => x.day_number === d)
      let diffDays = 999
      if (curDayObj?.day_date) {
        const [ny, nm, nd] = String(nextDayObj.day_date).slice(0, 10).split('-').map(Number)
        const [cy, cm, cd] = String(curDayObj.day_date).slice(0, 10).split('-').map(Number)
        diffDays = Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(cy, cm - 1, cd)) / 86400000)
      }
      const [ny, nm, nd] = String(nextDayObj.day_date).slice(0, 10).split('-').map(Number)
      const when = diffDays === 1 ? 'завтра' : `${nd} ${MONTHS_RU[nm - 1]}`
      nextDayMention = `Встречаемся ${when} в ${nextTime} МСК на День ${d + 1}.`
    }

    const confDay1 = confDaysData.find((x: any) => x.day_number === 1)
    const confDay1Date = confDay1?.day_date
      ? new Date(confDay1.day_date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
      : ''
    const realConfDesc = eventData?.description || ''

    // {day_title} — заголовок дня из программы (conf_days.title), fallback «День N».
    // Так же, как на бэке (message_builder), — без отсебятины.
    const realDayTitle = (dayObj?.title || '').trim() || `День ${d}`
    // {day_datetime} — дата дня + время старта первой сессии.
    const firstStart = daySessions.length > 0 && daySessions[0].start_time
      ? String(daySessions[0].start_time).slice(0, 5) : ''
    const realDayDatetime = dayObj?.day_date
      ? (firstStart ? `${realDayDate} в ${firstStart} МСК` : realDayDate)
      : realDayDate
    // {support_platform} — контакт поддержки. В реальной рассылке подставляется контакт
    // ТОЙ площадки, куда уходит сообщение; в превью показываем телеграм-контакт.
    const supportLink = (me?.work_tg_username || me?.work_vk || me?.work_max || '').trim()
      || '[ссылка на поддержку]'

    // {event_when} — «Сегодня/Завтра в HH:MM МСК», иначе «6 июля в HH:MM МСК».
    // В превью считаем от дня, выбранного переключателем дней.
    const realEventWhen = relativeWhenPreview(
      dayObj?.day_date || eventData?.start_at?.slice(0, 10),
      firstStart || (eventData?.start_at ? String(eventData.start_at).slice(11, 16) : ''),
    )

    out = out
      .replace(/\{event_when\}/g, realEventWhen || '[дата и время события]')
      .replace(/\{conf_title\}/g, realConfTitle)
      .replace(/\{conf_date\}/g, confDay1Date || '[дата конференции]')
      .replace(/\{conf_description\}/g, realConfDesc || '[описание конференции]')
      .replace(/\{day_number\}/g, String(d))
      .replace(/\{day_ordinal\}/g, dayOrdinal)
      .replace(/\{day_title\}/g, realDayTitle)
      .replace(/\{day_datetime\}/g, realDayDatetime)
      .replace(/\{day_date\}/g, realDayDate)
      .replace(/\{support_platform\}/g, supportLink)
      .replace(/\{support_link\}/g, supportLink)
      .replace(/\{support_links\}/g, [me?.work_tg_username, me?.work_vk, me?.work_max].filter((x: any) => x && x.trim()).join('\n') || '[контакты поддержки]')
      // ⚠️ Порядок важен: {day_program_speakers} и {day_program_with_links}
      // содержат {day_program} как подстроку — их подставляем ПЕРВЫМИ.
      .replace(/\{day_program_speakers\}/g, dayProgramSpeakers)
      .replace(/\{day_program_with_links\}/g, dayProgram)
      .replace(/\{day_program\}/g, dayProgram)
      .replace(/\{next_day_mention\}/g, nextDayMention)
      .replace(/\{raffle_url\}/g, realRaffleUrl || '🔗 [ссылка на розыгрыш]')
      .replace(/\{day_speakers_gifts\}/g, daySpeakersGifts)
      .replace(/\{stream_url\}/g, realStreamUrl || '[ссылка на эфир]')
      .replace(/\{landing_url\}/g, realRegUrl || '[ссылка на регистрацию]')
      .replace(/\{vip_url\}/g, eventData?.vip_url || '[ссылка на оплату VIP]')
      .replace(/\{game_link\}/g, getGameLink())
      .replace(/\{gift_url\}/g, '🔗 [ссылка на подарок]')
      .replace(/\{gift_title\}/g, '[название подарка]')
      .replace(/\{gift_after_speech_title\}/g, '[подарок на эфире]')
      .replace(/\{gift_raffle_title\}/g, '[подарок для розыгрыша]')
      .replace(/\{speaker_name\}/g, '[Имя спикера]')
      .replace(/\{speaker_tg\}/g, '')
      .replace(/\{speaker_personal_tg\}/g, '')
      .replace(/\{speaker_tg_username\}/g, '')
      .replace(/\{speaker_socials\}/g, '')
      .replace(/^[^\n]*\{speaker_time\}[^\n]*\n?/gm, '')
      .replace(/^[^\n]*\{speaker_date\}[^\n]*\n?/gm, '')
      .replace(/^[^\n]*\{speaker_datetime\}[^\n]*\n?/gm, '')
      .replace(/\{speaker_positioning\}/g, '')
      .replace(/\{speaker_notes\}/g, '')
      .replace(/\{event_chat_tg\}/g, '')
      .replace(/\{event_chat_vk\}/g, '')
      .replace(/\{event_chat_max\}/g, '')
      .replace(/\{brand_name\}/g, confData?.event_brand_name || eventData?.brand_name || '[бренд]')
      .replace(/\{speaker_topic_full\}/g, '[тема с описанием]')
      .replace(/\{speaker_topic_desc\}/g, '[описание темы]')
      .replace(/\{speaker_topic\}/g, '[тема]')
      .replace(/\{speaker_achievements\}/g, '')
      .replace(/\{first_name\}/g, '[Имя]')

    // Убираем незамененные переменные если пустые
    if (!nextDayMention) out = out.replace(/^.*\{next_day_mention\}.*$\n?/gm, '')
    if (!daySpeakersGifts) out = out.replace(/^.*\{day_speakers_gifts\}.*$\n?/gm, '')
    // Схлопываем 3+ пустых строки подряд
    out = out.replace(/\n{3,}/g, '\n\n')
    return out.trim()
  }

  const customTemplates = templates.filter(t => t.type === 'custom')

  // Варианты «за N дней», «День N», «через N дней» для выпадающего списка.
  // confDays приходит из БД как массив номеров дней ([1, 2, 3] для трёхдневной конфы).
  const dayRefOptions: { value: string; label: string }[] = [
    { value: 'before_3', label: 'За 3 дня до конференции' },
    { value: 'before_2', label: 'За 2 дня до конференции' },
    { value: 'before_1', label: 'За 1 день до конференции' },
    ...confDays.map(n => ({ value: `day_${n}`, label: `День ${n}` })),
    { value: 'after_1', label: 'Через 1 день после конференции' },
    { value: 'after_2', label: 'Через 2 дня после конференции' },
    { value: 'after_3', label: 'Через 3 дня после конференции' },
  ]

  function customDayToTestDay(ref: string): number {
    if (!ref) return confDays[0] ?? 1
    if (ref.startsWith('day_')) return Number(ref.split('_')[1])
    if (ref.startsWith('after_')) return confDays[confDays.length - 1] ?? 1
    return confDays[0] ?? 1
  }

  const CUSTOM_DEF: TypeDef = {
    type: 'custom',
    title: 'Кастомный шаблон',
    hint: '',
    variables: CUSTOM_PLACEHOLDERS,
    showPhoto: true,
    // Кастомный шаблон можно привязать к слоту спикера — тогда в тексте работают
    // {speaker_*}. Селектор спикера в превью нужен, чтобы это увидеть.
    hasSpeaker: true,
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Шаблоны создаются автоматически. Отредактируйте тексты — плейсхолдеры вида{' '}
        <code className="text-xs bg-gray-100 rounded px-1">{'{speaker_name}'}</code> подставятся при отправке.
        Потом перейдите в «Очередь рассылок» и нажмите «Создать из программы».
      </p>

      <div className="mb-4 flex justify-end">
        <button
          onClick={openAddChoice}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm text-white font-medium shadow-sm"
          style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}
        >
          <Plus size={15} /> Добавить шаблон
        </button>
      </div>

      {/* Памятка переменных */}
      <div className="mb-6 border border-gray-200 rounded-2xl overflow-hidden">
        <button
          onClick={() => setVarsOpen(v => !v)}
          className="w-full flex items-center justify-between px-5 py-3.5 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
        >
          <span className="text-sm font-medium text-gray-700">📋 Памятка по переменным</span>
          {varsOpen ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
        </button>
        {varsOpen && (
          /* columns (не grid): алфавит сверху вниз по левому столбцу, потом правый */
          <div className="px-5 py-4 sm:columns-2 gap-x-6">
            {[...ALL_VARIABLES].sort((a, b) => a.name.localeCompare(b.name)).map(v => (
              <div key={v.name} className="flex items-baseline gap-2 mb-2 break-inside-avoid">
                <code className="text-xs bg-blue-50 text-blue-700 border border-blue-100 rounded px-1.5 py-0.5 font-mono shrink-0">{v.name}</code>
                <span className="text-xs text-gray-500">{v.desc}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-4">
        {templates
          .filter(t => t.type !== 'custom')
          .slice()
          .sort((a, b) => {
            // ⚠️ Сначала по ГРУППЕ (про спикеров → общие → в чат спикеров).
            // В сплошном списке служебные сообщения команде теряются среди
            // рассылок по аудитории, и их путают — человек открывает
            // «Программу дня», думая, что она уйдёт зрителям.
            const ag = GROUP_ORDER.indexOf(tplGroup(a))
            const bg = GROUP_ORDER.indexOf(tplGroup(b))
            if (ag !== bg) return ag - bg
            const ai = TYPE_DEFS.findIndex(d => d.type === a.type)
            const bi = TYPE_DEFS.findIndex(d => d.type === b.type)
            const av = ai === -1 ? 999 : ai
            const bv = bi === -1 ? 999 : bi
            return av - bv
          })
          .map((tpl, idx, arr) => {
            const def: TypeDef = TYPE_DEFS.find(d => d.type === tpl.type)
              || { type: tpl.type, title: tpl.name, hint: '', variables: [], showPhoto: false }
            // Заголовки групп — перед первой карточкой каждой группы.
            const gKey = tplGroup(tpl)
            const prevKey = idx > 0 ? tplGroup(arr[idx - 1]) : null
            const firstOfGroup = idx === 0 || prevKey !== gKey
            // Заголовки и сворачивание — только когда групп реально больше
            // одной: при сплошном списке подпись и стрелка лишние.
            const hasBoth = new Set(arr.map(tplGroup)).size > 1
            const collapsed = hasBoth && !!collapsedGroups[gKey]
            const gMeta = GROUP_META[gKey]
            // ⚠️ Свёрнутая группа: обёртку прячем ЦЕЛИКОМ, кроме той, что несёт
            // заголовок. Пустые обёртки остались бы в потоке и получили отступ
            // от space-y-4 — под полосой тянулся бы столбик пустот.
            if (collapsed && !firstOfGroup) return null
            return (
              <div key={tpl.id}>
                {/* Заголовок группы — персиковая полоса во всю ширину. Она же
                    кнопка: клик сворачивает группу. Персик (#FFCFA4) — акцентный
                    цвет бренда, полоса режет список надвое заметнее любой
                    разделительной линии. */}
                {firstOfGroup && hasBoth && (
                  <button type="button"
                    onClick={() => setCollapsedGroups(p => ({ ...p, [gKey]: !p[gKey] }))}
                    className={`w-full text-left rounded-xl px-4 py-3 mb-3 flex items-center gap-2.5 transition-colors hover:brightness-95 ${idx > 0 ? 'mt-8' : ''}`}
                    style={{ background: '#FFCFA4' }}>
                    <ChevronDown size={16}
                      className={`shrink-0 text-[#25455D] transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                    <span className="min-w-0">
                      <span className="block text-sm font-bold uppercase tracking-wide text-[#25455D]">
                        {gMeta.title}
                        <span className="ml-2 font-semibold normal-case opacity-70">
                          {arr.filter(x => tplGroup(x) === gKey).length}
                        </span>
                      </span>
                      {gMeta.hint && (
                        <span className="block text-xs text-[#25455D]/70 mt-0.5">{gMeta.hint}</span>
                      )}
                    </span>
                  </button>
                )}
              {!collapsed && (
              <div className="bg-white rounded-2xl border card-border p-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    {/* Название — то, что клиент задал в шаблоне (tpl.name из БД).
                        Раньше показывалось статичное def.title из TYPE_DEFS — своё
                        название после переименования не подхватывалось. Типовое
                        назначение шаблона остаётся подписью ниже. */}
                    <h4 className="font-semibold text-gray-800">{tpl.name || def.title}</h4>
                    {tpl.name && tpl.name !== def.title && (
                      <p className="text-[11px] text-gray-400 mt-0.5">{def.title}</p>
                    )}
                    {def.hint && <p className="text-xs text-gray-400 mt-0.5">{def.hint}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    <button onClick={() => openTest(tpl, def)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-emerald-700 font-medium border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 transition-colors">
                      <Send size={13} /> Протестировать
                    </button>
                    <button onClick={() => openPreview(tpl, def)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-gray-600 font-medium border border-gray-200 hover:bg-gray-50 transition-colors">
                      <Eye size={13} /> Просмотреть
                    </button>
                    <button onClick={() => openEdit(tpl)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-white font-medium"
                      style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                      <Edit2 size={13} /> Редактировать
                    </button>
                    {/* Дублировать — только типы, которых может быть несколько.
                        Копия сохраняет текст, тайминг, аудиторию и каналы: удобно
                        сделать второе «Знакомство» под другую аудиторию. */}
                    {DUPLICABLE_TYPES.includes(tpl.type) && (
                      <button onClick={() => duplicateTemplate(tpl.id)}
                        title="Сделать копию этого шаблона"
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-gray-600 font-medium border border-gray-200 hover:bg-gray-50 transition-colors">
                        <Copy size={13} /> Дублировать
                      </button>
                    )}
                    {/* Удалять можно и типовые шаблоны — вернуть их потом можно
                        кнопкой «Добавить шаблон» (готовые пресеты). Авто-сид
                        срабатывает только когда шаблонов ноль, так что удалённый
                        сам не вернётся. */}
                    <button onClick={() => removeTemplate(tpl.id, tpl.name || def.title)}
                      title="Удалить шаблон"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-red-600 font-medium border border-red-200 hover:bg-red-50 transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                <div className="bg-gray-50 rounded-xl p-4">
                  {/* Тема (subject) — в email это тема письма, в TG/VK/MAX первая жирная
                      строка. В снимке её не показывали, и было не видно, что она вообще
                      задана: приходилось лезть в редактор. */}
                  {tpl.subject && (
                    <p className="text-xs text-gray-900 font-semibold font-mono mb-2 pb-2 border-b border-gray-200">
                      <span className="text-gray-400 font-sans font-normal mr-1.5">Тема:</span>
                      {tpl.subject}
                    </p>
                  )}
                  <p className="text-xs text-gray-700 whitespace-pre-wrap font-mono mb-3">{(tpl.text || '').replace(/\\n/g, '\n')}</p>
                  <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                    {tpl.photo_url ? (
                      <span>📷 Своё фото</span>
                    ) : def.showPhoto ? (
                      <span className="text-blue-500">📸 Афиша подставится автоматически</span>
                    ) : null}
                    {tpl.button_text && (
                      <span>
                        🔘 Кнопка: «{tpl.button_text}»
                        {tpl.button_url && (
                          <span className="ml-1 text-gray-400 text-xs font-normal">({tpl.button_url})</span>
                        )}
                      </span>
                    )}
                    <span className="text-indigo-500 font-medium">
                      👥 {audienceLabel(tpl.audience_include || 'all_event', tpl.audience_exclude || 'none')}
                    </span>
                  </div>
                </div>
              </div>
              )}
              </div>
            )
          })}
      </div>

      {customTemplates.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-500 mb-3 uppercase tracking-wide">Ваши шаблоны</h3>
          <div className="space-y-4">
            {customTemplates.map(tpl => (
              <div key={tpl.id} className="bg-white rounded-2xl border card-border p-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <h4 className="font-semibold text-gray-800">{tpl.name}</h4>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {(tpl.custom_bind_kind || 'day') === 'slot' ? '🎤' : '⏰'}{' '}
                      {customBindLabel(tpl, confSessions, confDays)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    <button
                      onClick={() => {
                        // Привязка к слоту → превью показываем на дне этого слота.
                        const slot = (tpl.custom_bind_kind === 'slot')
                          ? confSessions.find((s: any) => s.id === tpl.custom_slot_session_id)
                          : null
                        setTestDay(slot?.day || customDayToTestDay(tpl.custom_day_ref || ''))
                        // Спикер слота — чтобы в превью раскрылись {speaker_*}.
                        if (slot?.speaker_id) setPreviewSpeakerId(slot.speaker_id)
                        setPreviewModal({ tpl, def: { ...CUSTOM_DEF, title: tpl.name } })
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-gray-600 font-medium border border-gray-200 hover:bg-gray-50 transition-colors">
                      <Eye size={13} /> Просмотреть
                    </button>
                    <button onClick={() => openEdit(tpl)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-white font-medium"
                      style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                      <Edit2 size={13} /> Редактировать
                    </button>
                    <button onClick={() => removeTemplate(tpl.id, tpl.name)}
                      title="Удалить шаблон"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-red-600 font-medium border border-red-200 hover:bg-red-50 transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                <div className="bg-gray-50 rounded-xl p-4">
                  {tpl.media_type === 'video' && tpl.video_url ? (
                    <video src={tpl.video_url} controls className="w-full max-h-40 rounded-lg mb-3 bg-black" />
                  ) : tpl.photo_url ? (
                    <img src={tpl.photo_url} alt="" className="w-full max-h-40 object-contain rounded-lg mb-3"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  ) : null}
                  {/* Тема (subject) — в email тема письма, в TG/VK/MAX первая жирная строка. */}
                  {tpl.subject && (
                    <p className="text-xs text-gray-900 font-semibold font-mono mb-2 pb-2 border-b border-gray-200">
                      <span className="text-gray-400 font-sans font-normal mr-1.5">Тема:</span>
                      {tpl.subject}
                    </p>
                  )}
                  <p className="text-xs text-gray-700 whitespace-pre-wrap font-mono mb-3">{(tpl.text || '').replace(/\\n/g, '\n')}</p>
                  <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                    {tpl.media_type === 'video' && tpl.video_url && <span>🎬 Своё видео</span>}
                    {tpl.media_type !== 'video' && tpl.photo_url && <span>📷 Своё фото</span>}
                    {tpl.button_text && (
                      <span>
                        🔘 Кнопка: «{tpl.button_text}»
                        {tpl.button_url && (
                          <span className="ml-1 text-gray-400 text-xs font-normal">({tpl.button_url})</span>
                        )}
                      </span>
                    )}
                    <span className="text-indigo-500 font-medium">
                      👥 {audienceLabel(tpl.audience_include || 'all_event', tpl.audience_exclude || 'none')}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Модалка редактирования */}
      {editModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto scroll-visible">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">Редактировать шаблон</h3>
              <button onClick={() => setEditModal(null)}><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Название</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400" />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  Заголовок (опционально)
                </label>
                <input
                  value={(form as any).subject || ''}
                  onChange={e => setForm({ ...form, subject: e.target.value } as any)}
                  placeholder="Тема для email + жирная первая строка для TG/VK/MAX"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400"
                />
                <p className="text-[11px] text-gray-500 mt-1 leading-snug">
                  В email становится темой письма. В Telegram/VK/MAX — первая жирная строка перед основным текстом.
                </p>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Текст сообщения</label>
                <textarea
                  value={form.text || ''}
                  onChange={(e) => setForm({ ...form, text: e.target.value })}
                  placeholder="Используйте плейсхолдеры {conf_title}, {day_number}, {first_name} и т.п. Можно HTML-теги <b>, <i>, <a href>."
                  rows={12}
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-gray-400 font-mono leading-relaxed resize-y"
                />
                <p className="text-[11px] text-gray-500 mt-1 leading-snug">
                  Жирный, курсив, подчёркивание и ссылки. Telegram и MAX покажут как есть. В&nbsp;ВКонтакте
                  форматирование не работает — останется только чистый текст и&nbsp;ссылки.
                </p>
                {currentType && (
                  <PlaceholderPicker
                    common={currentType.variables}
                    onInsert={(v) => setForm({ ...form, text: form.text + v })}
                  />
                )}
              </div>
              {/* Навигация по чату: пункты со ссылками под площадку. Текст выше
                  остаётся шапкой поста, пункты встают на место плейсхолдера. */}
              {(form as any).type === 'chat_nav' && (
                <div className="border-t border-gray-100 pt-4">
                  <ChatNavEditor
                    value={(form as any).nav_items || []}
                    onChange={(next) => setForm({ ...(form as any), nav_items: next })}
                  />
                  <label className="flex items-start gap-2 mt-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={(form as any).pin_in_chat !== false}
                      onChange={e => setForm({ ...(form as any), pin_in_chat: e.target.checked })}
                      className="mt-0.5"
                    />
                    <span className="text-sm" style={{ color: '#25455D' }}>
                      Закрепить сообщение в чате
                      <span className="block text-[11px] text-gray-500 leading-snug">
                        Работает во всех трёх площадках. Бот должен быть администратором чата —
                        иначе сообщение просто придёт без закрепа.
                      </span>
                    </span>
                  </label>
                </div>
              )}
              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  Медиа (опционально) — фото или видео. Если пусто, для дневных шаблонов подставится афиша.
                </label>
                <BroadcastMediaPicker
                  value={{
                    photo_url: form.media_type === 'photo' ? (form.photo_url || null) : null,
                    video_url: form.media_type === 'video' ? (form.video_url || null) : null,
                    media_type: form.media_type,
                  }}
                  onChange={(v) => setForm({ ...form, photo_url: v.photo_url || '', video_url: v.video_url || '', media_type: v.media_type } as any)}
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Видео в Telegram проигрывается прямо в сообщении; в VK/MAX/email — ссылкой.
                </p>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-500">Кнопка (опционально)</label>
                  {(form.button_text || form.button_url) && (
                    <button type="button"
                      onClick={() => setForm({ ...form, button_text: '', button_url: '' })}
                      className="text-xs text-red-500 hover:text-red-700 font-medium">✕ Убрать кнопку</button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input value={form.button_text} onChange={e => setForm({ ...form, button_text: e.target.value })}
                    placeholder="Текст кнопки, напр. Войти в эфир"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                  <input value={form.button_url} onChange={e => setForm({ ...form, button_url: e.target.value })}
                    placeholder="{stream_url} или https://..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none font-mono" />
                </div>
                <p className="text-[11px] text-gray-400 mt-1">Чтобы убрать кнопку — очистите оба поля или нажмите «Убрать кнопку».</p>
              </div>
              {/* Настройки кастомного шаблона — к чему привязать и когда отправлять */}
              {editModal?.type === 'custom' && (
                <CustomBindingFields
                  form={form}
                  setForm={(f: any) => setForm(f)}
                  dayRefOptions={dayRefOptions}
                  sessions={confSessions}
                />
              )}

              {/* Время отправки для рассылок «за сутки» и анонса знакомства.
                  ⚠️ Раньше час был зашит в коде (09:12 / 10:43) и задать своё
                  было негде — прошедшее время молча пропускалось. */}
              {(editModal?.type === 'day_before_09_12_unreg'
                || editModal?.type === 'day_before_09_12_reg'
                || editModal?.type === 'pre_conf'
                || editModal?.type === 'day_end') && (
                <div className="border border-blue-100 rounded-xl p-3 bg-blue-50">
                  <label className="text-xs font-medium text-blue-700 mb-1 block">
                    ⏰ Время отправки (МСК)
                  </label>
                  <input
                    type="time"
                    value={(form as any).intro_start_time
                      || (editModal?.type === 'pre_conf' ? '10:43'
                        : editModal?.type === 'day_end' ? '' : '09:12')}
                    onChange={e => setForm({ ...form, intro_start_time: e.target.value } as any)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white"
                  />
                  <p className="text-[11px] text-gray-500 mt-1">
                    {editModal?.type === 'pre_conf'
                      ? 'Накануне первого дня, в это время.'
                      : editModal?.type === 'day_end'
                      ? 'В этот же день, в указанное время. Оставьте пустым — уйдёт через 30 минут после конца программы дня.'
                      : 'Накануне дня события, в это время.'}
                  </p>
                </div>
              )}

              {/* Настройки расписания для Знакомства со спикером и Экспертного дня */}
              {(editModal?.type === 'speaker_intro' || editModal?.type === 'expert_day') && (
                <div className="border border-blue-100 rounded-xl p-3 bg-blue-50 space-y-3">
                  <p className="text-xs font-medium text-blue-700">
                    {editModal?.type === 'expert_day' ? '⏰ Расписание Экспертного дня' : '⏰ Расписание знакомств со спикерами'}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Время старта (МСК)</label>
                      <input
                        type="time"
                        value={(form as any).intro_start_time || '11:00'}
                        onChange={e => setForm({ ...form, intro_start_time: e.target.value } as any)}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Интервал (мин)</label>
                      <input
                        type="number"
                        min={5} max={120}
                        value={(form as any).intro_interval_min || 15}
                        onChange={e => setForm({ ...form, intro_interval_min: Number(e.target.value) } as any)}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Отправить за</label>
                    <select
                      value={(form as any).intro_days_before || 1}
                      onChange={e => setForm({ ...form, intro_days_before: Number(e.target.value) } as any)}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white"
                    >
                      <option value={1}>за 1 день до конференции</option>
                      <option value={2}>за 2 дня до конференции</option>
                      <option value={3}>за 3 дня до конференции</option>
                      <option value={4}>за 4 дня до конференции</option>
                      <option value={5}>за 5 дней до конференции</option>
                      <option value={6}>за 6 дней до конференции</option>
                      <option value={7}>за 7 дней до конференции</option>
                    </select>
                  </div>

                  {/* Выбор ролей: для кого формировать знакомство.
                      null/undefined = все роли (по умолчанию). */}
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">{editModal?.type === 'expert_day' ? 'Кого анонсировать (роли)' : 'Знакомить с (роли)'}</label>
                    <div className="flex flex-wrap gap-2">
                      {INTRO_ROLE_OPTIONS.map(r => {
                        const cur: string[] | null = (form as any).intro_roles ?? null
                        // null = все выбраны
                        const checked = cur === null ? true : cur.includes(r.value)
                        return (
                          <label key={r.value}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white cursor-pointer text-sm">
                            <input type="checkbox" checked={checked}
                              onChange={() => {
                                const base: string[] = cur === null
                                  ? INTRO_ROLE_OPTIONS.map(o => o.value)  // разворачиваем «все» в явный список
                                  : [...cur]
                                const next = checked
                                  ? base.filter(v => v !== r.value)
                                  : [...base, r.value]
                                setForm({ ...form, intro_roles: next } as any)
                              }}
                              className="w-4 h-4 accent-[#25455D]" />
                            {r.label}
                          </label>
                        )
                      })}
                    </div>
                    <p className="text-[11px] text-gray-500 mt-1">
                      Отмеченные роли попадут в рассылку знакомства при «Сформировать из программы». По умолчанию — все.
                    </p>
                  </div>
                </div>
              )}

              {/* Источник фото — только для спикерских шаблонов с фото человека */}
              {(editModal?.type === 'speaker_intro' || editModal?.type === 'expert_day' || editModal?.type === '5min_before') && (
                <div className="border border-gray-100 rounded-xl p-3 bg-gray-50 space-y-2">
                  <p className="text-xs font-medium text-gray-600">🖼 Какое фото спикера брать</p>
                  {/* ⚠️ ТРИ ИСТОЧНИКА, а не два. «Просто фото» было
                      двусмысленным: под событие можно загрузить свой снимок
                      (карикатуру), и выбрать именно профильный было нельзя. */}
                  <div className="grid grid-cols-1 gap-2">
                    {[
                      { value: 'poster', label: '🎨 Готовая афиша спикера' },
                      { value: 'photo_profile', label: '👤 Фото из профиля спикера' },
                      { value: 'photo_event', label: '🖼 Фото для этого события' },
                    ].map(opt => {
                      // ⚠️ Старое значение 'photo' показываем как «для этого
                      // события»: оно и раньше отдавало фото события, если оно
                      // было. Так уже настроенные шаблоны не меняют поведение.
                      const raw = (form as any).speaker_photo_mode || 'poster'
                      const cur = raw === 'photo' ? 'photo_event' : raw
                      const active = cur === opt.value
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setForm({ ...form, speaker_photo_mode: opt.value } as any)}
                          className={`flex-1 py-2 rounded-lg text-sm font-medium border ${active ? 'text-white border-transparent' : 'bg-white text-gray-600 border-gray-200'}`}
                          style={active ? { background: 'linear-gradient(45deg,#25455D,#0a1520)' } : undefined}
                        >
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-[11px] text-gray-500">
                    <b>Готовая афиша</b> — собранная афиша спикера из его библиотеки.<br />
                    <b>Фото из профиля</b> — снимок, который загрузил сам спикер.<br />
                    <b>Фото для этого события</b> — то, что вы подготовили под конференцию
                    (карточка спикера → «Выступление» → «Другие фото для афиш»).<br />
                    Если выбранного нет — возьмётся ближайшее из остальных. Задали фото
                    у самого шаблона — берётся оно.
                  </p>
                </div>
              )}

              {/* ⚠️ У рассылки в чат спикеров выбирать нечего: получатель ОДИН
                  и задан в настройках события (раздел «Чаты и каналы события»).
                  Аудитория, каналы и галочки чатов тут только сбивали бы — можно
                  было снять нужную галочку или выставить аудиторию, которой всё
                  равно ничего не уйдёт. Показываем вместо них пояснение. */}
              {(form as any).type === 'speakers_call' ? (
                <div className="border rounded-xl p-3 space-y-1.5"
                     style={{ borderColor: '#FFCFA4', background: '#FFF7F0' }}>
                  <p className="text-xs font-semibold text-gray-800">Уходит только в чат спикеров</p>
                  <p className="text-[11px] text-gray-600 leading-relaxed">
                    Участникам события эта рассылка не отправляется. Получатель —
                    чат спикеров, он задаётся один раз в «Описании» события, раздел
                    «Чаты и каналы события» (Telegram / ВКонтакте / MAX — уйдёт во все
                    заполненные). Выбирать чат или аудиторию здесь не нужно.
                  </p>
                </div>
              ) : /* ⚠️ Аудитория и чаты у навигации ЗАФИКСИРОВАНЫ на сервере
                      (только чат события, в личку никому). Показывать селекторы
                      значило бы предлагать выбор, которого нет. */
                (form as any).type === 'chat_nav' ? (
                <div className="border rounded-xl p-3 space-y-1.5"
                     style={{ borderColor: '#FFCFA4', background: '#FFF7F0' }}>
                  <p className="text-xs font-semibold text-gray-800">Уходит только в чат события</p>
                  <p className="text-[11px] text-gray-600 leading-relaxed">
                    Участникам в личку эта рассылка не отправляется. Получатель — чат
                    события, он выбирается в «Описании» события, раздел «Чаты и каналы
                    события» (уйдёт во все заполненные площадки, в каждой — со своими
                    ссылками). Время отправки задаётся вручную в очереди.
                  </p>
                </div>
              ) : (<>
              <div className="border border-gray-100 rounded-xl p-3 bg-gray-50 space-y-2">
                <p className="text-xs font-medium text-gray-600">👥 Аудитория рассылки</p>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Включить</label>
                  <select
                    value={(form as any).audience_include || 'all_event'}
                    onChange={e => setForm({ ...form, audience_include: e.target.value } as any)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="all_event">Все участники конфы</option>
                    <option value="registered_event">Зарегистрированные участники</option>
                    {hasPayments && <option value="paid_event">Оплатившие</option>}
                    {hasPayments && <option value="unpaid_event">Имеют неоплаченный заказ</option>}
                    <option value="all_client">Вся база клиента (все события)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Исключить</label>
                  <select
                    value={(form as any).audience_exclude || 'none'}
                    onChange={e => setForm({ ...form, audience_exclude: e.target.value } as any)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="none">Никого не исключать</option>
                    <option value="registered_event">Зарегистрированных участников</option>
                    <option value="unregistered_event">Незарегистрированных участников</option>
                    {hasPayments && <option value="paid_event">Оплативших</option>}
                    {hasPayments && <option value="unpaid_event">Имеющих неоплаченный заказ</option>}
                    <option value="all_event">Всех участников конфы</option>
                  </select>
                </div>
                <p className="text-xs text-indigo-600 font-medium pt-1">
                  Итого: {audienceLabel((form as any).audience_include || 'all_event', (form as any).audience_exclude || 'none')}
                </p>
              </div>

              <BroadcastChannelPicker
                value={(form as any).target_channel_ids ?? null}
                onChange={(next) => setForm({ ...form, target_channel_ids: next } as any)}
              />

              {/* Три независимые галочки: чаты события / общие чаты / личные каналы. */}
              <label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
                <input type="checkbox"
                  checked={!!(form as any).send_to_event_chats}
                  onChange={e => setForm({ ...form, send_to_event_chats: e.target.checked } as any)}
                  className="w-4 h-4 mt-0.5 accent-[#25455D]" />
                <span>
                  <span className="block text-sm text-gray-800 font-medium">Отправлять в чаты события</span>
                  <span className="block text-[11px] text-gray-500 mt-0.5">
                    В групповые чаты этого события (заданы в настройках события).
                  </span>
                </span>
              </label>
              {/* Чат СПИКЕРОВ — отдельный от чата участников (миграция 431).
                  Доступен всем, как и чат события: это чат ЭТОГО события. */}
              <label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
                <input type="checkbox"
                  checked={!!(form as any).send_to_speakers_chat}
                  onChange={e => setForm({ ...form, send_to_speakers_chat: e.target.checked } as any)}
                  className="w-4 h-4 mt-0.5 accent-[#25455D]" />
                <span>
                  <span className="block text-sm text-gray-800 font-medium">Отправлять в чат спикеров</span>
                  <span className="block text-[11px] text-gray-500 mt-0.5">
                    В закрытый чат команды — задаётся в «Описании» события, раздел
                    «Чаты и каналы события». Участникам такое сообщение не уходит.
                  </span>
                </span>
              </label>
              {hasChatsFeature && (<label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
                <input type="checkbox"
                  checked={!!(form as any).send_to_client_chats}
                  onChange={e => setForm({ ...form, send_to_client_chats: e.target.checked } as any)}
                  className="w-4 h-4 mt-0.5 accent-[#25455D]" />
                <span>
                  <span className="block text-sm text-gray-800 font-medium">Отправлять в общие чаты</span>
                  <span className="block text-[11px] text-gray-500 mt-0.5">
                    В общие группы/каналы из базы чатов (Каналы → «Группы/Каналы для рассылок», без галочки «Личный»).
                  </span>
                </span>
              </label>)}
              {hasChatsFeature && (<label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
                <input type="checkbox"
                  checked={!!(form as any).send_to_private_chats}
                  onChange={e => setForm({ ...form, send_to_private_chats: e.target.checked } as any)}
                  className="w-4 h-4 mt-0.5 accent-[#25455D]" />
                <span>
                  <span className="block text-sm text-gray-800 font-medium">Отправлять в личные каналы</span>
                  <span className="block text-[11px] text-gray-500 mt-0.5">
                    В каналы из базы чатов, помеченные галочкой «Личный».
                  </span>
                </span>
              </label>)}
              </>)}
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={save}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                Сохранить
              </button>
              <button onClick={() => setEditModal(null)}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка выбора: новый шаблон с нуля или готовый из списка */}
      {addChoiceModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto scroll-visible">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">Добавить шаблон</h3>
              <button onClick={() => setAddChoiceModal(false)}><X size={18} /></button>
            </div>

            <button
              onClick={openCreate}
              className="w-full flex items-center gap-3 p-4 rounded-xl border border-gray-200 hover:border-gray-400 hover:bg-gray-50 transition-colors text-left mb-4">
              <span className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0 text-white"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                <Plus size={18} />
              </span>
              <span>
                <span className="block font-medium text-gray-800 text-sm">Создать новый</span>
                <span className="block text-xs text-gray-400">Пустой шаблон — свой текст, день и время отправки</span>
              </span>
            </button>

            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
              Или выберите готовый
            </div>
            {presetsLoading ? (
              <div className="py-6 text-center text-sm text-gray-400">Загрузка…</div>
            ) : presets.length === 0 ? (
              <div className="py-6 text-center text-sm text-gray-400">
                Все готовые шаблоны уже добавлены
              </div>
            ) : (
              <div className="space-y-2">
                {presets.map(p => (
                  <button key={p.type}
                    onClick={() => addPreset(p.type)}
                    className="w-full flex items-start gap-3 p-3 rounded-xl border border-gray-200 hover:border-gray-400 hover:bg-gray-50 transition-colors text-left">
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium text-gray-800 text-sm">{p.name}</span>
                      {p.text && (
                        <span className="block text-xs text-gray-400 mt-0.5 line-clamp-2">
                          {(p.text || '').replace(/<[^>]+>/g, '').slice(0, 120)}…
                        </span>
                      )}
                    </span>
                    <Plus size={15} className="text-gray-400 shrink-0 mt-0.5" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Модалка создания кастомного шаблона */}
      {createModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto scroll-visible">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">Новый шаблон</h3>
              <button onClick={() => setCreateModal(false)}><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Название</label>
                <input value={(form as any).name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="Например: «Напоминание за день»"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400" />
              </div>

              <CustomBindingFields
                form={form}
                setForm={(f: any) => setForm(f)}
                dayRefOptions={dayRefOptions}
                sessions={confSessions}
              />

              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  Заголовок (опционально)
                </label>
                <input
                  value={(form as any).subject || ''}
                  onChange={e => setForm({ ...form, subject: e.target.value } as any)}
                  placeholder="Тема для email + жирная первая строка для TG/VK/MAX"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400"
                />
                <p className="text-[11px] text-gray-500 mt-1 leading-snug">
                  В email становится темой письма. В Telegram/VK/MAX — первая жирная строка перед основным текстом.
                </p>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Текст сообщения</label>
                <textarea
                  value={(form as any).text || ''}
                  onChange={(e) => setForm({ ...form, text: e.target.value } as any)}
                  placeholder="Используйте плейсхолдеры {conf_title}, {day_number}, {first_name} и т.п. Можно HTML-теги <b>, <i>, <a href>."
                  rows={10}
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-gray-400 font-mono leading-relaxed resize-y"
                />
                <p className="text-[11px] text-gray-500 mt-1 leading-snug">
                  Жирный, курсив, подчёркивание и ссылки. Telegram и MAX покажут как есть. В&nbsp;ВКонтакте
                  форматирование не работает — останется только чистый текст и&nbsp;ссылки.
                </p>
                <PlaceholderPicker
                  common={CUSTOM_PLACEHOLDERS}
                  onInsert={(v) => setForm({ ...form, text: ((form as any).text || '') + v } as any)}
                />
              </div>

              <div>
                <label className="text-xs text-gray-500 mb-1 block">Медиа (опционально) — фото или видео</label>
                <BroadcastMediaPicker
                  value={{
                    photo_url: (form as any).media_type === 'photo' ? ((form as any).photo_url || null) : null,
                    video_url: (form as any).media_type === 'video' ? ((form as any).video_url || null) : null,
                    media_type: (form as any).media_type,
                  }}
                  onChange={(v) => setForm({ ...form, photo_url: v.photo_url || '', video_url: v.video_url || '', media_type: v.media_type } as any)}
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Видео в Telegram проигрывается прямо в сообщении; в VK/MAX/email — ссылкой.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-gray-500">Кнопка (опционально)</label>
                  {((form as any).button_text || (form as any).button_url) && (
                    <button type="button"
                      onClick={() => setForm({ ...form, button_text: '', button_url: '' } as any)}
                      className="text-xs text-red-500 hover:text-red-700 font-medium">✕ Убрать кнопку</button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input value={(form as any).button_text}
                    onChange={e => setForm({ ...form, button_text: e.target.value })}
                    placeholder="Текст кнопки, напр. «Зарегистрироваться»"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                  <input value={(form as any).button_url}
                    onChange={e => setForm({ ...form, button_url: e.target.value })}
                    placeholder="{landing_url} или https://..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none font-mono" />
                </div>
              </div>

              <div className="border border-gray-100 rounded-xl p-3 bg-gray-50 space-y-2">
                <p className="text-xs font-medium text-gray-600">👥 По какой базе отправлять</p>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Включить</label>
                  <select
                    value={(form as any).audience_include || 'all_event'}
                    onChange={e => setForm({ ...form, audience_include: e.target.value } as any)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="all_event">Все участники конфы</option>
                    <option value="registered_event">Зарегистрированные участники</option>
                    {hasPayments && <option value="paid_event">Оплатившие</option>}
                    {hasPayments && <option value="unpaid_event">Имеют неоплаченный заказ</option>}
                    <option value="all_client">Вся база клиента (все события)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Исключить</label>
                  <select
                    value={(form as any).audience_exclude || 'none'}
                    onChange={e => setForm({ ...form, audience_exclude: e.target.value } as any)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="none">Никого не исключать</option>
                    <option value="registered_event">Зарегистрированных участников</option>
                    <option value="unregistered_event">Незарегистрированных участников</option>
                    {hasPayments && <option value="paid_event">Оплативших</option>}
                    {hasPayments && <option value="unpaid_event">Имеющих неоплаченный заказ</option>}
                    <option value="all_event">Всех участников конфы</option>
                  </select>
                </div>
                <p className="text-xs text-indigo-600 font-medium pt-1">
                  Итого: {audienceLabel((form as any).audience_include || 'all_event', (form as any).audience_exclude || 'none')}
                </p>
              </div>

              <BroadcastChannelPicker
                value={(form as any).target_channel_ids ?? null}
                onChange={(next) => setForm({ ...form, target_channel_ids: next } as any)}
              />

              {/* ⚠️ Чаты СОБЫТИЯ и чат СПИКЕРОВ — здесь же, а не только в
                  редактировании. Раньше в создании их не было: клиент делал
                  рассылку, она уходила мимо чатов, и он лез править только что
                  созданный шаблон. Это событийные рассылки — чаты события им
                  нужны по определению. Доступны всем: это чаты ЭТОГО события,
                  фича broadcast_chats тут ни при чём. */}
              <label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
                <input type="checkbox"
                  checked={!!(form as any).send_to_event_chats}
                  onChange={e => setForm({ ...form, send_to_event_chats: e.target.checked } as any)}
                  className="w-4 h-4 mt-0.5 accent-[#25455D]" />
                <span>
                  <span className="block text-sm text-gray-800 font-medium">Отправлять в чаты события</span>
                  <span className="block text-[11px] text-gray-500 mt-0.5">
                    В групповые чаты этого события (заданы в «Описании» события).
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
                <input type="checkbox"
                  checked={!!(form as any).send_to_speakers_chat}
                  onChange={e => setForm({ ...form, send_to_speakers_chat: e.target.checked } as any)}
                  className="w-4 h-4 mt-0.5 accent-[#25455D]" />
                <span>
                  <span className="block text-sm text-gray-800 font-medium">Отправлять в чат спикеров</span>
                  <span className="block text-[11px] text-gray-500 mt-0.5">
                    В закрытый чат команды — задаётся в «Описании» события, раздел
                    «Чаты и каналы события». Участникам такое сообщение не уходит.
                  </span>
                </span>
              </label>

              {/* Галочка: слать ещё и в общую базу чатов клиента (только с фичей broadcast_chats) */}
              {hasChatsFeature && (<label className="flex items-start gap-2.5 p-3 rounded-xl border border-gray-200 bg-gray-50 cursor-pointer">
                <input type="checkbox"
                  checked={!!(form as any).send_to_client_chats}
                  onChange={e => setForm({ ...form, send_to_client_chats: e.target.checked } as any)}
                  className="w-4 h-4 mt-0.5 accent-[#25455D]" />
                <span>
                  <span className="block text-sm text-gray-800 font-medium">Отправлять в общие чаты</span>
                  <span className="block text-[11px] text-gray-500 mt-0.5">
                    Ещё и в группы/каналы из вашей базы чатов (Каналы → «Группы/Каналы для рассылок»).
                  </span>
                </span>
              </label>)}
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={createCustom}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                Создать
              </button>
              <button onClick={() => setCreateModal(false)}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка предпросмотра */}
      {previewModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 max-h-[90vh] overflow-y-auto scroll-visible">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800 text-sm">Предпросмотр: {previewModal.def.title}</h3>
              <button onClick={() => setPreviewModal(null)}><X size={18} /></button>
            </div>

            {/* Выбор дня — только для дневных шаблонов */}
            {confDays.length > 1 && !['pre_conf', 'speaker_intro', 'expert_day', '5min_before', 'gift'].includes(previewModal.def.type) && (
              <div className="mb-3">
                <label className="text-xs text-gray-500 mb-1.5 block">День конференции</label>
                <div className="flex flex-wrap gap-2">
                  {confDays.map(d => {
                    const _dd = confDaysData.find((x: any) => x.day_number === d)
                    const _lbl = fmtTplDay(_dd?.day_date)
                    return (
                    <button key={d} onClick={() => setTestDay(d)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${testDay === d ? 'text-white border-transparent' : 'text-gray-600 border-gray-200 bg-white hover:bg-gray-50'}`}
                      style={testDay === d ? { background: 'linear-gradient(45deg,#25455D,#0a1520)' } : {}}>
                      {_lbl ? `День · ${_lbl}` : `День ${d}`}
                    </button>
                  )})}
                </div>
              </div>
            )}

            {/* ⚠️ Вкладки площадок — у ВСЕХ шаблонов, а не только у подарочных.
                От площадки зависит любая ссылка в тексте: регистрация, кабинет,
                подарок, чат — они ведут в бота клиента на своей площадке.
                Клиент должен видеть, что реально уйдёт человеку в TG, VK и MAX. */}
            <div className="mb-4">
                <label className="text-xs text-gray-500 mb-1.5 block">Площадка получателя:</label>
                <div className="flex gap-1">
                  {/* ⚠️ Email — полноценная площадка рассылки, и текст там
                      отличается: {signup_link} разворачивается в ВСЕ ссылки
                      площадок с подписями (у мессенджера — только своя), а
                      кнопка «Зарегистрироваться» становится тремя. Без этой
                      вкладки клиент не видел, что уйдёт на почту, и проверял
                      письмо вслепую. */}
                  {([['telegram', 'Telegram'], ['vk', 'VK'], ['max', 'MAX'], ['email', 'Email']] as const).map(([pk, label]) => (
                    <button key={pk} onClick={() => setPreviewPlatform(pk)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition ${
                        previewPlatform === pk ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                      }`}>
                      {label}
                    </button>
                  ))}
              </div>
            </div>

            {/* Выбор спикера — для шаблонов со спикером */}
            {previewModal.def.hasSpeaker && speakers.length > 0 && (
              <div className="mb-4">
                <label className="text-xs text-gray-500 mb-1 block">Посмотреть как у спикера:</label>
                <select
                  value={previewSpeakerId ?? ''}
                  onChange={e => setPreviewSpeakerId(Number(e.target.value) || null)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white"
                >
                  <option value="">— без замены переменных —</option>
                  {speakers.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* ⚠️ Нет комнаты эфира — ссылка в рассылке уйдёт ПУСТОЙ. Ругаемся
                явно, иначе клиент узнает об этом только от получателей. */}
            {streamMissing(previewModal.tpl, testDay) && (
              <div className="mb-3 rounded-xl border-2 border-red-400 bg-red-50 p-3">
                <p className="text-sm font-semibold text-red-700">
                  Нет ссылки на эфир!
                </p>
                <p className="text-xs text-red-600 mt-1 leading-relaxed">
                  У этого дня не создана вебинарная комната, поэтому
                  <b> {'{stream_url}'} </b> подставится пустым — люди не смогут зайти.
                  Откройте вкладку «Вебинар» и создайте комнату либо укажите
                  ссылку на сторонний вебинар.
                </p>
              </div>
            )}

            {/* Имитация Telegram-сообщения */}
            <div className="bg-[#effdde] rounded-2xl rounded-tr-sm p-3 shadow-sm">
              {/* Видео шаблона (если выбрано) — приоритет над афишей */}
              {previewModal.tpl.media_type === 'video' && previewModal.tpl.video_url && (
                <video src={previewModal.tpl.video_url} controls
                  className="w-full max-h-48 rounded-xl mb-2 bg-black" />
              )}
              {/* Фото */}
              {previewModal.def.showPhoto && previewModal.tpl.media_type !== 'video' && (() => {
                // Конференционные/событийные шаблоны: афиша события (не спикера).
                // Спикерская афиша подставляется только для шаблонов со спикером.
                const isEventLevelTpl = previewModal.def.type.startsWith('day_')
                  || previewModal.def.type === 'pre_conf'
                  || previewModal.def.type === '2h_before_unreg'
                  || previewModal.def.type === '2h_before_reg'
                  || previewModal.def.type === '30min_before'
                  || previewModal.def.type === 'event_live'
                // Афиша: тот же приоритет, что и в бэке (get_day_event_photo) —
                // афиша ДНЯ превью → общая афиша события. Внутри группы:
                // square > horizontal > vertical.
                const pickByOrientation = (arr: any[]) =>
                  arr.find(p => p.orientation === 'square')?.url
                  || arr.find(p => p.orientation === 'horizontal')?.url
                  || arr.find(p => p.orientation === 'vertical')?.url
                const dayPoster = pickByOrientation(dayPosters.filter(p => Number(p.day) === Number(testDay)))
                const commonPoster = confPosters.square[0] || confPosters.horizontal[0] || confPosters.vertical[0]
                const eventPoster = dayPoster || commonPoster
                const speakerPoster = previewSpeaker?.cse_poster_url || previewSpeaker?.speaker_poster_url || previewSpeaker?.poster_url
                const speakerPhoto = previewSpeaker?.photo_url
                // Режим фото: 'photo' → сначала фото коллаба, 'poster' (default) → афиша.
                const photoMode = previewModal.tpl.speaker_photo_mode || 'poster'
                const speakerMedia = photoMode === 'photo'
                  ? (speakerPhoto || speakerPoster)
                  : (speakerPoster || speakerPhoto)
                // Для спикерских шаблонов приоритет: фото шаблона → выбранный источник.
                // Афиша события НЕ подставляется (как в бэке).
                const photoSrc = previewModal.tpl.photo_url
                  || (isEventLevelTpl ? eventPoster : speakerMedia)
                const placeholder = isEventLevelTpl
                  ? '📸 Афиша события'
                  : (speakers.length > 0 ? '📸 Афиша или фото спикера' : '📸 Афиша события')
                return photoSrc ? (
                  <PreviewImage key={photoSrc} src={photoSrc} placeholder={placeholder} />
                ) : (
                  <div className="w-full h-20 rounded-xl mb-2 flex items-center justify-center text-xs text-gray-400"
                    style={{ background: '#e8e8e8' }}>
                    {placeholder}
                  </div>
                )
              })()}
              {/* Тема (subject) — как в письме/жирная первая строка. Плейсхолдеры резолвим. */}
              {previewModal.tpl.subject && (
                <p className="text-sm font-bold text-gray-900 mb-2"
                  dangerouslySetInnerHTML={{ __html: renderPreviewText(
                    previewModal.tpl.subject,
                    previewModal.def.hasSpeaker ? previewSpeaker : null,
                    previewModal.def.type, testDay, previewPlatform
                  )}} />
              )}
              <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed"
                dangerouslySetInnerHTML={{ __html: renderPreviewText(
                  previewModal.tpl.text,
                  previewModal.def.hasSpeaker ? previewSpeaker : null,
                  previewModal.def.type,
                  testDay,
                  previewPlatform,
                  previewModal.tpl.nav_items
                )}} />
              {previewModal.tpl.button_text && (() => {
                // ⚠️ В ПИСЬМЕ кнопка с {signup_link} разворачивается в ТРИ — по
                // одной на площадку (tasks/broadcast.py). Ограничение «один
                // адрес в кнопке» идёт от Telegram, к письму оно не относится.
                // Показываем это и в превью, иначе клиент проверяет одну
                // кнопку, а человеку приходит три.
                const isEmail = previewPlatform === 'email'
                const rawUrl = (previewModal.tpl.button_url || '').trim()
                const bh = (me as any)?.bot_handles || {}
                if (isEmail && rawUrl === '{signup_link}') {
                  // Подписи — те же, что в боевой рассылке и тесте
                  // (tasks/broadcast.py, modules/broadcasts.py).
                  const BTN_LABEL: Record<string, string> = {
                    telegram: 'Зарегистрироваться через ТГ',
                    max: 'Зарегистрироваться через МАХ',
                    vk: 'Зарегистрироваться через ВК',
                  }
                  const per = (['telegram', 'max', 'vk'] as const)
                    .filter(p => bh[p])
                    .map(p => ({ label: BTN_LABEL[p], url: signupLink(p) }))
                  if (per.length) {
                    return (
                      <div className="mt-3 space-y-2">
                        {per.map(b => (
                          <div key={b.label}>
                            <div className="w-full py-2 px-3 rounded-xl text-center text-sm font-medium text-blue-600 bg-white border border-gray-200">
                              {b.label}
                            </div>
                            <p className="text-xs text-gray-400 mt-1 text-center break-all">{b.url}</p>
                          </div>
                        ))}
                      </div>
                    )
                  }
                }
                return (
                  <div className="mt-3">
                    <div className="w-full py-2 px-3 rounded-xl text-center text-sm font-medium text-blue-600 bg-white border border-gray-200">
                      {previewModal.tpl.button_text}
                    </div>
                    {previewModal.tpl.button_url && (
                      <p className="text-xs text-gray-400 mt-1 text-center break-all">
                        {renderPreviewText(
                          previewModal.tpl.button_url,
                          previewModal.def.hasSpeaker ? previewSpeaker : null,
                          previewModal.def.type,
                          testDay,
                          previewPlatform
                        )}
                      </p>
                    )}
                  </div>
                )
              })()}
            </div>

            <button onClick={() => setPreviewModal(null)}
              className="w-full mt-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* Модалка тестирования */}
      {testModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto scroll-visible">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">Тест: {testModal.def.title}</h3>
              <button onClick={() => setTestModal(null)}><X size={18} /></button>
            </div>

            {['pre_conf', 'gift', 'speaker_intro', 'expert_day', '5min_before', '2h_before_unreg', '2h_before_reg', 'day_live', 'day_end', '30min_before', 'event_live'].includes(testModal.def.type) ? (
              <>
                <p className="text-sm text-gray-600 mb-4">
                  {testModal.def.type === 'pre_conf' && 'Отправит анонс знакомства со спикерами с горизонтальной афишей, описанием конференции и ссылкой на регистрацию на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === 'gift' && 'Отправит сообщения о подарке для каждого спикера выбранного дня (по порядку программы) на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === 'speaker_intro' && 'Отправит «Знакомство со спикером» для каждого спикера выбранного дня (с фото афиши) на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === '5min_before' && 'Отправит «Анонс спикера» для каждого спикера выбранного дня (с реальной ссылкой на эфир и фото) на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === '2h_before_unreg' && `Отправит сообщение для незарегистрированных для каждого дня конференции. Итого ${confDays.length} сообщений на каждый тестовый аккаунт.`}
                  {testModal.def.type === '2h_before_reg' && `Отправит сообщение для зарегистрированных для каждого дня конференции. Итого ${confDays.length} сообщений на каждый тестовый аккаунт.`}
                  {testModal.def.type === 'day_live' && `Отправит сообщение о старте эфира для каждого дня конференции. Итого ${confDays.length} сообщений на каждый тестовый аккаунт.`}
                  {testModal.def.type === 'day_end' && `Отправит итоги дня для каждого дня конференции. Итого ${confDays.length} сообщений на каждый тестовый аккаунт.`}
                  {testModal.def.type === '30min_before' && 'Отправит сообщение «за 30 минут до старта» на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === 'event_live' && 'Отправит сообщение «за 5 минут до старта эфира» на тестовые Telegram ID из настроек.'}
                </p>

                {!testResult && (() => {
                  // «Все дни» — только для типов, которые шлются по каждому дню конференции.
                  // 30min_before / event_live / спикерские — единичная тестовая отправка.
                  const MULTI_DAY = ['2h_before_unreg', '2h_before_reg', 'day_live', 'day_end']
                  const isMultiDay = MULTI_DAY.includes(testModal.def.type) && confDays.length > 0
                  return (
                  <>
                    {isMultiDay && (
                      <p className="text-xs text-gray-400 mb-4">Будет отправлено для каждого из {confDays.length} дней</p>
                    )}
                    <button
                      onClick={runTest}
                      disabled={testSending}
                      className="w-full py-2.5 rounded-xl text-sm font-medium text-white flex items-center justify-center gap-2"
                      style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)', opacity: testSending ? 0.7 : 1 }}
                    >
                      {testSending
                        ? <><Loader2 size={15} className="animate-spin" /> Отправляем...</>
                        : <><Send size={15} /> {isMultiDay ? `Отправить тест — все дни (${confDays.length} сообщений)` : 'Отправить тест'}</>
                      }
                    </button>
                  </>
                  )
                })()}
                {testResult && testResult.ok && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-emerald-700 mb-3 flex items-center gap-2">
                      <CheckCircle size={16} /> День {testDay} — отправлено {testResult.sent} спикеров
                    </p>
                    {testResult.details?.map((d: any, i: number) => (
                      <div key={i} className="bg-gray-50 rounded-xl px-3 py-2">
                        <p className="text-xs font-medium text-gray-700 mb-1">{d.speaker}</p>
                        <div className="flex flex-wrap gap-2">
                          {d.results?.map((r: any, j: number) => (
                            <span key={j} className={`text-xs flex items-center gap-1 ${r.ok ? 'text-emerald-600' : 'text-red-500'}`}>
                              {r.ok ? <CheckCircle size={11} /> : <XCircle size={11} />}
                              {r.chat_id}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                    <button onClick={() => { setTestResult(null) }}
                      className="w-full mt-2 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                      Отправить ещё раз
                    </button>
                  </div>
                )}
                {testResult && !testResult.ok && (
                  <div className="bg-red-50 rounded-xl p-3 flex items-start gap-2 text-sm text-red-700">
                    <XCircle size={16} className="shrink-0 mt-0.5" />
                    {testResult.message || testResult.error || 'Ошибка отправки'}
                  </div>
                )}
              </>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
                Тестовая отправка для этого шаблона пока не реализована.
              </div>
            )}

            <button onClick={() => setTestModal(null)}
              className="w-full mt-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
              Закрыть
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
