'use client'

// Блок «Главные кнопки» — настройка двух CTA-кнопок в Mini App
// (VIP-тариф и Чат события). Используется на странице «Основное»
// мероприятий, конкурсов и на вкладке «Настройки» конференции/турнира.
//
// Поле «Акцент» определяет, какая из кнопок рисуется красным градиентом;
// вторая остаётся тёмно-синей. По умолчанию (NULL в БД) — VIP красная
// (текущее поведение продукта до миграции 117).

import { CSSProperties } from 'react'

export type AccentButton = 'vip' | 'chat' | 'none'

export function normalizeAccent(v: any): AccentButton {
  return v === 'chat' || v === 'none' ? v : 'vip'
}

interface Props {
  vipLabel: string
  chatLabel: string
  accent: AccentButton
  onVipLabel: (v: string) => void
  onChatLabel: (v: string) => void
  onAccent: (v: AccentButton) => void
}

export default function MainButtonsBlock({
  vipLabel, chatLabel, accent, onVipLabel, onChatLabel, onAccent,
}: Props) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
      <div>
        <h2 className="block-title">Главные кнопки в Mini App</h2>
        <p className="text-xs text-gray-400 mt-1">
          Заголовки кнопок VIP-тарифа и чата на «Программе» события. Выберите,
          какая из них рисуется красным цветом — это привлекает к ней внимание.
        </p>
      </div>

      <Field label="Текст кнопки VIP-тарифа" hint="По умолчанию — «Расшириться до VIP-тарифа». Кнопка появится только если выше задана ссылка на оплату.">
        <input value={vipLabel} onChange={e => onVipLabel(e.target.value)}
               className="mb-input" placeholder="Расшириться до VIP-тарифа"
               maxLength={64} />
      </Field>

      <Field label="Заголовок кнопки чата" hint="По умолчанию — «Чат события». Кнопка появится только если задана ссылка на чат хотя бы для одной платформы.">
        <input value={chatLabel} onChange={e => onChatLabel(e.target.value)}
               className="mb-input" placeholder="Чат события"
               maxLength={64} />
      </Field>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Какая кнопка красная
        </label>
        <div className="space-y-2">
          {OPTS.map(opt => (
            <label key={opt.value} style={radioRow(accent === opt.value)}>
              <input type="radio" name="accent_button"
                checked={accent === opt.value}
                onChange={() => onAccent(opt.value)}
                className="mt-0.5 accent-[#25455D]" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900">{opt.label}</span>
                  <Swatch which={opt.value} />
                </div>
                <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      <style jsx>{`
        .block-title {
          font-size: 0.875rem;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #25455D;
        }
        .mb-input {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1px solid #d1d5db;
          border-radius: 0.5rem;
          font-size: 0.875rem;
          outline: none;
        }
        .mb-input:focus {
          border-color: #25455D;
          box-shadow: 0 0 0 3px rgba(37, 69, 93, 0.1);
        }
      `}</style>
    </div>
  )
}

const OPTS: { value: AccentButton; label: string; desc: string }[] = [
  { value: 'vip',  label: 'Кнопка VIP-тарифа',  desc: 'Красная VIP, чат тёмно-синий. Подходит, когда основная цель — продать тариф.' },
  { value: 'chat', label: 'Кнопка чата',        desc: 'Красный чат, VIP тёмно-синий. Подходит, когда главное — затянуть в нетворкинг и обсуждение.' },
  { value: 'none', label: 'Без акцента',        desc: 'Обе кнопки тёмно-синие. Спокойный вариант, без яркого CTA.' },
]

function radioRow(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '12px 14px',
    borderRadius: 12,
    border: `2px solid ${active ? '#25455D' : '#e5e7eb'}`,
    background: active ? 'rgba(37,69,93,0.05)' : 'white',
    cursor: 'pointer',
    transition: 'all 0.15s',
  }
}

function Swatch({ which }: { which: AccentButton }) {
  // Маленькие плашки-индикаторы, как кнопка будет выглядеть.
  const tiles: { bg: string; key: string }[] =
    which === 'vip'
      ? [{ bg: 'linear-gradient(135deg, #7f1d1d, #ef4444)', key: 'vip-red' },
         { bg: 'linear-gradient(135deg, #25455D, #0a1520)', key: 'chat-blue' }]
      : which === 'chat'
      ? [{ bg: 'linear-gradient(135deg, #25455D, #0a1520)', key: 'vip-blue' },
         { bg: 'linear-gradient(135deg, #7f1d1d, #ef4444)', key: 'chat-red' }]
      : [{ bg: 'linear-gradient(135deg, #25455D, #0a1520)', key: 'vip-blue' },
         { bg: 'linear-gradient(135deg, #25455D, #0a1520)', key: 'chat-blue' }]
  return (
    <span style={{ display: 'inline-flex', gap: 4, marginLeft: 4 }}>
      {tiles.map(t => (
        <span key={t.key} style={{
          width: 22, height: 12, borderRadius: 3, background: t.bg, display: 'inline-block',
          border: '1px solid rgba(0,0,0,0.08)',
        }} />
      ))}
    </span>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}
