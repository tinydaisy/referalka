'use client'

/**
 * Редактор пунктов навигации по чату события (шаблон рассылки `chat_nav`).
 *
 * ⚠️ Зачем отдельный редактор, а не обычный текст шаблона. Ссылки в этом посте
 * РАЗНЫЕ на каждой площадке: в чат ВКонтакте нужна вэкашная, в Telegram —
 * телеграмная, а бот у клиента подключён не везде. Вписать это руками в текст
 * нельзя — поэтому пункт хранит не ссылку, а ЕЁ ВИД, а сама ссылка
 * подставляется при отправке (backend/app/services/chat_nav.py).
 *
 * ⚠️ Пункт без ссылки НЕ попадает в сообщение, и нумерация считается уже
 * после отсева — поэтому номера здесь показаны как предварительные: человек
 * должен видеть, что «Правила» без ссылки просто выпадут, а не сломают счёт.
 */
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import LeadMagnetPicker from '@/components/LeadMagnetPicker'
import PlatformLogo from '@/components/PlatformLogo'

const PLATFORM_NAME: Record<string, string> = {
  telegram: 'Telegram', vk: 'ВКонтакте', max: 'MAX',
}

export type NavKind = 'vip' | 'cabinet' | 'support' | 'rules' | 'link' | 'magnet'

export interface NavItem {
  kind: NavKind
  label?: string
  /** Для kind='link' — одна ссылка на все площадки. */
  url?: string
  /**
   * Для kind='rules' — своя ссылка на КАЖДУЮ площадку: правила лежат в закрепе
   * конкретного чата, а чат у Telegram, ВК и MAX разный.
   */
  urls?: { telegram?: string; vk?: string; max?: string }
  /** Для kind='magnet': 'm' — лид-магнит, 'p' — пакет. */
  magnet_kind?: 'm' | 'p'
  magnet_id?: number
  magnet_slug?: string
}

const KIND_META: Record<NavKind, { label: string; hint: string }> = {
  vip: {
    label: 'Тариф события',
    hint: 'Ссылка из настроек события («Описание» → ссылка на VIP-тариф). Не заполнена — пункт не появится.',
  },
  cabinet: {
    label: 'Кабинет участника (подарки)',
    hint: 'Ведёт на вкладку с подарками в кабинете. Mini App или веб-версия — по вашей настройке для каждой площадки. Кто не зарегистрирован — тому предложат регистрацию.',
  },
  support: {
    label: 'Тех.поддержка',
    hint: 'Открывает поддержку в боте той площадки, где человек читает чат.',
  },
  rules: {
    label: 'Правила чата',
    hint: 'Ссылка на закреплённый пост с правилами — своя в каждом чате. Где не заполнено, пункт не появится.',
  },
  link: {
    label: 'Своя ссылка',
    hint: 'Любой адрес, одинаковый на всех площадках.',
  },
  magnet: {
    label: 'Лид-магнит',
    hint: 'Ссылка на воронку магнита в боте его владельца — под площадку читателя.',
  },
}

/** Порядок в меню «добавить пункт»: сверху то, что нужно почти всем. */
const ADD_ORDER: NavKind[] = ['magnet', 'link', 'rules', 'cabinet', 'vip', 'support']

interface Props {
  value: NavItem[]
  onChange: (next: NavItem[]) => void
}

export default function ChatNavEditor({ value, onChange }: Props) {
  const items = value || []

  const patch = (i: number, next: Partial<NavItem>) =>
    onChange(items.map((it, k) => (k === i ? { ...it, ...next } : it)))

  const remove = (i: number) => onChange(items.filter((_, k) => k !== i))

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  const add = (kind: NavKind) =>
    onChange([...items, {
      kind,
      label: '',
      ...(kind === 'link' ? { url: '' } : {}),
      ...(kind === 'rules' ? { urls: {} } : {}),
    }])

  /**
   * Попадёт ли пункт в сообщение. Для «ручных» видов это видно сразу — есть
   * ссылка или нет; остальные резолвятся на сервере, и обещать за них нельзя.
   */
  const willShow = (it: NavItem): boolean => {
    // Правила: достаточно ссылки хотя бы на одной площадке — там пункт и
    // появится, а на остальных его не будет (и это правильно).
    if (it.kind === 'rules') return Object.values(it.urls || {}).some(u => (u || '').trim())
    if (it.kind === 'link') return !!(it.url || '').trim()
    if (it.kind === 'magnet') return !!it.magnet_id
    return true
  }

  // Предварительная нумерация — как в готовом сообщении: выпавшие не считаются.
  let shown = 0

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <label className="text-xs text-gray-500">Пункты навигации</label>
        <span className="text-[11px] text-gray-400">
          Пункт без ссылки не попадёт в сообщение — нумерация не собьётся
        </span>
      </div>

      {items.length === 0 && (
        <div className="text-sm text-gray-500 border border-dashed border-gray-300 rounded-xl px-4 py-5 text-center">
          Пунктов пока нет. Добавьте первый — кнопки ниже.
        </div>
      )}

      {items.map((it, i) => {
        const meta = KIND_META[it.kind] || KIND_META.link
        const active = willShow(it)
        if (active) shown += 1
        return (
          <div
            key={i}
            className={`rounded-xl border-2 p-3 space-y-2 ${active ? 'border-[#25455D]/20' : 'border-dashed border-gray-300 bg-gray-50'}`}
          >
            <div className="flex items-center gap-2">
              <span
                className="text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0"
                style={active
                  ? { background: '#FFCFA4', color: '#25455D' }
                  : { background: '#E5E7EB', color: '#6B7280' }}
              >
                {active ? `${shown}` : '—'}
              </span>
              <span className="text-sm font-semibold" style={{ color: '#25455D' }}>
                {meta.label}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                        className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-30"
                        title="Выше">
                  <ArrowUp className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1}
                        className="p-1.5 rounded-lg hover:bg-gray-100 disabled:opacity-30"
                        title="Ниже">
                  <ArrowDown className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => remove(i)}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-red-500"
                        title="Удалить пункт">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <input
              value={it.label || ''}
              onChange={e => patch(i, { label: e.target.value })}
              placeholder="Подпись пункта — что увидит человек"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400"
            />

            {/* ⚠️ Правила чата — ССЫЛКА НА КАЖДУЮ ПЛОЩАДКУ ОТДЕЛЬНО: это закреп
                внутри конкретного чата, а чат у Telegram, ВК и MAX свой. Одна
                ссылка на всех увела бы человека в чужой чат, где его нет. */}
            {it.kind === 'rules' && (
              <div className="space-y-1.5">
                {(['telegram', 'vk', 'max'] as const).map(pl => (
                  <div key={pl} className="flex items-center gap-2">
                    {/* Логотип площадки — общим компонентом: кружок с буквой
                        читается как заглушка, а MAX по первой букве не узнать. */}
                    <span className="shrink-0" title={PLATFORM_NAME[pl]}>
                      <PlatformLogo slug={pl} size={22} />
                    </span>
                    <input
                      type="url"
                      value={(it.urls || {})[pl] || ''}
                      onChange={e => patch(i, { urls: { ...(it.urls || {}), [pl]: e.target.value } })}
                      placeholder="Ссылка на закреп с правилами в этом чате"
                      className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400"
                    />
                  </div>
                ))}
                <p className="text-[11px] text-gray-500 leading-snug">
                  Заполните те площадки, где есть чат. В остальных пункт просто не появится —
                  чужую ссылку не подставляем, чтобы не отправить человека в чат, где его нет.
                </p>
              </div>
            )}

            {it.kind === 'link' && (
              <input
                type="url"
                value={it.url || ''}
                onChange={e => patch(i, { url: e.target.value })}
                placeholder="https://…"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400"
              />
            )}

            {it.kind === 'magnet' && (
              <LeadMagnetPicker
                value={it.magnet_id
                  ? { kind: it.magnet_kind === 'p' ? 'package' : 'magnet', id: it.magnet_id }
                  : null}
                onPick={v => patch(i, {
                  magnet_id: v?.id,
                  magnet_kind: v?.kind === 'package' ? 'p' : 'm',
                  // slug подставит сервер при сохранении: пикер его не знает.
                  magnet_slug: undefined,
                })}
              />
            )}

            <p className="text-[11px] text-gray-500 leading-snug">{meta.hint}</p>
          </div>
        )
      })}

      <div className="flex flex-wrap gap-2 pt-1">
        {ADD_ORDER.map(k => (
          <button
            key={k}
            type="button"
            onClick={() => add(k)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm hover:bg-gray-50"
            style={{ color: '#25455D' }}
          >
            <Plus className="w-3.5 h-3.5" />
            {KIND_META[k].label}
          </button>
        ))}
      </div>
    </div>
  )
}
