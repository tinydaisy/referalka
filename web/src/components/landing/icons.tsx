'use client'

/**
 * Иконки для карточек лендинга (ценности, «чем отличаемся»).
 *
 * Берём готовый набор lucide-react — он уже в проекте (используется во всём
 * дашборде). Свои SVG рисовать не нужно: там больше тысячи иконок, единые по
 * толщине линий и сетке. Здесь отобраны ~60 подходящих для продающих страниц
 * и сгруппированы по смыслу, чтобы клиент не листал весь каталог.
 *
 * Иконка рисуется в круге с металлической заливкой из цвета иконок темы —
 * так она совпадает по стилю с кнопками и заголовками.
 *
 * Ключ (`key`) хранится в карточке блока: items[i].icon. Пусто — иконки нет.
 */
import {
  Handshake, Users, Share2, Network, MessagesSquare, HeartHandshake,
  TrendingUp, BarChart3, Rocket, Target, Trophy, Award, Medal, Crown,
  Lightbulb, Sparkles, Brain, Zap, Flame, Star, Gem, Wand2,
  BookOpen, GraduationCap, Library, ScrollText, FileText, Presentation,
  Shield, ShieldCheck, Lock, BadgeCheck, CircleCheck, ThumbsUp,
  Gift, Wallet, Banknote, CreditCard, PiggyBank, ShoppingBag,
  Clock, CalendarDays, Timer, Hourglass,
  Mic, Video, Radio, Headphones, Camera, Podcast,
  Globe, MapPin, Compass, Map, Plane,
  Heart, Smile, Sun, Eye, Infinity as InfinityIcon, Anchor, Mountain, Leaf,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface IconDef {
  key: string
  label: string
  group: string
  Icon: LucideIcon
}

export const CARD_ICONS: IconDef[] = [
  // ── Люди и связи ──────────────────────────────────────────────────────
  { key: 'handshake',     label: 'Рукопожатие',   group: 'Люди и связи', Icon: Handshake },
  { key: 'heart-hands',   label: 'Забота',        group: 'Люди и связи', Icon: HeartHandshake },
  { key: 'users',         label: 'Сообщество',    group: 'Люди и связи', Icon: Users },
  { key: 'share',         label: 'Обмен',         group: 'Люди и связи', Icon: Share2 },
  { key: 'network',       label: 'Сеть',          group: 'Люди и связи', Icon: Network },
  { key: 'chats',         label: 'Общение',       group: 'Люди и связи', Icon: MessagesSquare },

  // ── Рост и результат ──────────────────────────────────────────────────
  { key: 'trending',      label: 'Рост',          group: 'Рост и результат', Icon: TrendingUp },
  { key: 'chart',         label: 'Показатели',    group: 'Рост и результат', Icon: BarChart3 },
  { key: 'rocket',        label: 'Запуск',        group: 'Рост и результат', Icon: Rocket },
  { key: 'target',        label: 'Цель',          group: 'Рост и результат', Icon: Target },
  { key: 'trophy',        label: 'Победа',        group: 'Рост и результат', Icon: Trophy },
  { key: 'award',         label: 'Награда',       group: 'Рост и результат', Icon: Award },
  { key: 'medal',         label: 'Медаль',        group: 'Рост и результат', Icon: Medal },
  { key: 'crown',         label: 'Статус',        group: 'Рост и результат', Icon: Crown },

  // ── Идеи и энергия ────────────────────────────────────────────────────
  { key: 'bulb',          label: 'Идея',          group: 'Идеи и энергия', Icon: Lightbulb },
  { key: 'sparkles',      label: 'Вдохновение',   group: 'Идеи и энергия', Icon: Sparkles },
  { key: 'brain',         label: 'Мышление',      group: 'Идеи и энергия', Icon: Brain },
  { key: 'zap',           label: 'Энергия',       group: 'Идеи и энергия', Icon: Zap },
  { key: 'flame',         label: 'Драйв',         group: 'Идеи и энергия', Icon: Flame },
  { key: 'star',          label: 'Звезда',        group: 'Идеи и энергия', Icon: Star },
  { key: 'gem',           label: 'Ценность',      group: 'Идеи и энергия', Icon: Gem },
  { key: 'wand',          label: 'Магия',         group: 'Идеи и энергия', Icon: Wand2 },

  // ── Знания ────────────────────────────────────────────────────────────
  { key: 'book',          label: 'Книга',         group: 'Знания', Icon: BookOpen },
  { key: 'graduation',    label: 'Обучение',      group: 'Знания', Icon: GraduationCap },
  { key: 'library',       label: 'База знаний',   group: 'Знания', Icon: Library },
  { key: 'scroll',        label: 'Наследие',      group: 'Знания', Icon: ScrollText },
  { key: 'file',          label: 'Материалы',     group: 'Знания', Icon: FileText },
  { key: 'presentation',  label: 'Выступление',   group: 'Знания', Icon: Presentation },

  // ── Доверие ───────────────────────────────────────────────────────────
  { key: 'shield',        label: 'Защита',        group: 'Доверие', Icon: Shield },
  { key: 'shield-check',  label: 'Надёжность',    group: 'Доверие', Icon: ShieldCheck },
  { key: 'lock',          label: 'Приватность',   group: 'Доверие', Icon: Lock },
  { key: 'badge-check',   label: 'Проверено',     group: 'Доверие', Icon: BadgeCheck },
  { key: 'check',         label: 'Галочка',       group: 'Доверие', Icon: CircleCheck },
  { key: 'thumbs-up',     label: 'Одобрение',     group: 'Доверие', Icon: ThumbsUp },

  // ── Деньги и подарки ──────────────────────────────────────────────────
  { key: 'gift',          label: 'Подарок',       group: 'Деньги и подарки', Icon: Gift },
  { key: 'wallet',        label: 'Кошелёк',       group: 'Деньги и подарки', Icon: Wallet },
  { key: 'banknote',      label: 'Доход',         group: 'Деньги и подарки', Icon: Banknote },
  { key: 'card',          label: 'Оплата',        group: 'Деньги и подарки', Icon: CreditCard },
  { key: 'piggy',         label: 'Накопления',    group: 'Деньги и подарки', Icon: PiggyBank },
  { key: 'bag',           label: 'Продажи',       group: 'Деньги и подарки', Icon: ShoppingBag },

  // ── Время ─────────────────────────────────────────────────────────────
  { key: 'clock',         label: 'Время',         group: 'Время', Icon: Clock },
  { key: 'calendar',      label: 'Расписание',    group: 'Время', Icon: CalendarDays },
  { key: 'timer',         label: 'Скорость',      group: 'Время', Icon: Timer },
  { key: 'hourglass',     label: 'Срок',          group: 'Время', Icon: Hourglass },

  // ── Медиа ─────────────────────────────────────────────────────────────
  { key: 'mic',           label: 'Микрофон',      group: 'Медиа', Icon: Mic },
  { key: 'video',         label: 'Видео',         group: 'Медиа', Icon: Video },
  { key: 'radio',         label: 'Эфир',          group: 'Медиа', Icon: Radio },
  { key: 'podcast',       label: 'Подкаст',       group: 'Медиа', Icon: Podcast },
  { key: 'headphones',    label: 'Наушники',      group: 'Медиа', Icon: Headphones },
  { key: 'camera',        label: 'Съёмка',        group: 'Медиа', Icon: Camera },

  // ── Масштаб ───────────────────────────────────────────────────────────
  { key: 'globe',         label: 'Мир',           group: 'Масштаб', Icon: Globe },
  { key: 'map-pin',       label: 'Место',         group: 'Масштаб', Icon: MapPin },
  { key: 'compass',       label: 'Направление',   group: 'Масштаб', Icon: Compass },
  { key: 'map',           label: 'Маршрут',       group: 'Масштаб', Icon: Map },
  { key: 'plane',         label: 'Путешествие',   group: 'Масштаб', Icon: Plane },
  { key: 'mountain',      label: 'Вершина',       group: 'Масштаб', Icon: Mountain },

  // ── Характер ──────────────────────────────────────────────────────────
  { key: 'heart',         label: 'Сердце',        group: 'Характер', Icon: Heart },
  { key: 'smile',         label: 'Лёгкость',      group: 'Характер', Icon: Smile },
  { key: 'sun',           label: 'Оптимизм',      group: 'Характер', Icon: Sun },
  { key: 'eye',           label: 'Видение',       group: 'Характер', Icon: Eye },
  { key: 'infinity',      label: 'Бесконечность', group: 'Характер', Icon: InfinityIcon },
  { key: 'anchor',        label: 'Опора',         group: 'Характер', Icon: Anchor },
  { key: 'leaf',          label: 'Рост природы',  group: 'Характер', Icon: Leaf },
]

export const ICON_KEYS = new Set(CARD_ICONS.map(i => i.key))

/** Группы в порядке появления — для выпадающего выбора в конструкторе. */
export const ICON_GROUPS: string[] = CARD_ICONS.reduce((acc: string[], i) => {
  if (!acc.includes(i.group)) acc.push(i.group)
  return acc
}, [])

/**
 * Иконка в круге с металлической (или сплошной) заливкой.
 * Символ — тёмный, чтобы читался на светлом металле.
 */
export function CardIcon({
  iconKey, color, metallic = true, size = 88, symbolColor = '#25455D',
}: {
  iconKey: string
  color: string
  metallic?: boolean
  size?: number
  symbolColor?: string
  /** Больше не нужен — оставлен, чтобы не ломать существующие вызовы. */
  id?: string
}) {
  const def = CARD_ICONS.find(i => i.key === iconKey)
  if (!def) return null
  const Icon = def.Icon
  return (
    <span
      className="inline-flex items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        background: metallic
          ? `linear-gradient(180deg, ${shade(color, -45)}, ${color}, ${shade(color, 30)}, ${color}, ${shade(color, -45)})`
          : color,
      }}
    >
      <Icon size={Math.round(size * 0.46)} strokeWidth={2} color={symbolColor} />
    </span>
  )
}

/** Минус — темнее, плюс — светлее (к белому). */
function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex || '#FFCFA4'
  const n = parseInt(m[1], 16)
  const f = (v: number) => pct >= 0
    ? Math.round(v + (255 - v) * (pct / 100))
    : Math.round(v * (1 + pct / 100))
  return `#${[f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]
    .map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`
}
