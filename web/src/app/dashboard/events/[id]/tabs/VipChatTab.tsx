'use client'
import { useState } from 'react'
import { api } from '@/lib/api'

interface Props {
  event: any
  eventId: number
  onReload: () => Promise<void>
}

const BRAND = '#25455D'

export default function VipChatTab({ event, eventId, onReload }: Props) {
  const [form, setForm] = useState({
    has_vip_tariff:               !!event.has_vip_tariff,
    vip_price:                    event.vip_price ?? '',
    vip_url:                      event.vip_url ?? '',
    vip_title:                    event.vip_title ?? '',
    vip_description:              event.vip_description ?? '',
    chat_url:                     event.chat_url ?? '',
    chat_subscriptions_required:  !!event.chat_subscriptions_required,
    chat_member_count_label:      event.chat_member_count_label ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  function set<K extends keyof typeof form>(k: K, v: any) { setForm(f => ({ ...f, [k]: v })) }

  async function save() {
    setSaving(true)
    try {
      await api.events.update(eventId, {
        has_vip_tariff:               form.has_vip_tariff,
        vip_price:                    form.vip_price === '' ? null : Number(form.vip_price),
        vip_url:                      form.vip_url || null,
        vip_title:                    form.vip_title || null,
        vip_description:              form.vip_description || null,
        chat_url:                     form.chat_url || null,
        chat_subscriptions_required:  form.chat_subscriptions_required,
        chat_member_count_label:      form.chat_member_count_label || null,
      })
      await onReload()
      setSavedAt(Date.now()); setTimeout(() => setSavedAt(null), 2000)
    } catch (e: any) {
      alert(e.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-8 pb-24">
      {/* === VIP === */}
      <section>
        <h2 className="text-lg font-bold mb-1" style={{ color: BRAND }}>VIP-тариф</h2>
        <p className="text-sm text-gray-500 mb-4">
          Если включить — в Mini App над программой появится золотая кнопка «Оплатить VIP-тариф»,
          а в Итогах конференции — «Купить VIP-тариф с записями».
        </p>

        <label className="flex items-center gap-2 mb-4 cursor-pointer">
          <input type="checkbox" checked={form.has_vip_tariff}
                 onChange={e => set('has_vip_tariff', e.target.checked)} />
          <span className="text-sm font-medium">Включить VIP-тариф для этого события</span>
        </label>

        {form.has_vip_tariff && (
          <div className="space-y-3 pl-6 border-l-2" style={{ borderColor: '#FFCFA4' }}>
            <Field label="Название тарифа" hint="По умолчанию «VIP-доступ»">
              <input type="text" className="input" value={form.vip_title}
                     onChange={e => set('vip_title', e.target.value)}
                     placeholder="VIP-доступ" maxLength={80} />
            </Field>

            <Field label="Цена в рублях" hint="Только число, например 29000 = 29 000 ₽">
              <input type="number" className="input w-40" value={form.vip_price}
                     onChange={e => set('vip_price', e.target.value)}
                     placeholder="29000" />
            </Field>

            <Field label="Ссылка для оплаты" hint="Куда переходит участник по нажатию кнопки">
              <input type="url" className="input" value={form.vip_url}
                     onChange={e => set('vip_url', e.target.value)}
                     placeholder="https://..." />
            </Field>

            <Field label="Что входит" hint="Несколько строк — что получит участник за VIP">
              <textarea className="input min-h-[100px]" value={form.vip_description}
                        onChange={e => set('vip_description', e.target.value)}
                        placeholder="Чат со спикерами, нетворкинг, материалы навсегда" />
            </Field>
          </div>
        )}
      </section>

      {/* === ЧАТ === */}
      <section>
        <h2 className="text-lg font-bold mb-1" style={{ color: BRAND }}>Общий чат</h2>
        <p className="text-sm text-gray-500 mb-4">
          Если задать ссылку — в Mini App в программе появится плитка «Чат» с кнопкой «Вступить».
        </p>

        <div className="space-y-3">
          <Field label="Ссылка на чат" hint="Telegram-чат или другой канал общения для участников">
            <input type="url" className="input" value={form.chat_url}
                   onChange={e => set('chat_url', e.target.value)}
                   placeholder="https://t.me/..." />
          </Field>

          <Field label="Сколько человек написать" hint="Произвольная подпись под названием чата (например «900+ человек»)">
            <input type="text" className="input w-60" value={form.chat_member_count_label}
                   onChange={e => set('chat_member_count_label', e.target.value)}
                   placeholder="900+ человек" maxLength={40} />
          </Field>

          <label className="flex items-start gap-2 cursor-pointer pt-1">
            <input type="checkbox" className="mt-1" checked={form.chat_subscriptions_required}
                   onChange={e => set('chat_subscriptions_required', e.target.checked)} />
            <div>
              <div className="text-sm font-medium">Требовать подписку на спикеров для входа в чат</div>
              <div className="text-xs text-gray-500 mt-0.5">
                Если включено — Mini App покажет участнику чек-лист подписок перед входом в чат.
                Кнопка «Вступить» активна только когда все галки стоят.
              </div>
            </div>
          </label>
        </div>
      </section>

      {/* === Сохранение === */}
      <div className="sticky bottom-4 flex items-center gap-3">
        <button onClick={save} disabled={saving}
                className="px-6 py-2.5 rounded-xl text-white font-medium shadow-lg disabled:opacity-50"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
        {savedAt && <span className="text-sm text-green-600">✓ Сохранено</span>}
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {hint && <p className="text-xs text-gray-500 mb-1.5">{hint}</p>}
      {children}
    </div>
  )
}
