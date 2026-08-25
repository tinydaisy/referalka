// Кнопка оплаты VIP-тарифа. При нажатии запускает async-колбэк
// (redirectToVip в EventPage), пока тот резолвится — на кнопке крутится
// спиннер вместо текста. Это нужно потому что redirectToVip уходит во
// внешний браузер через openLink (Telegram WebApp иногда заметно
// «думает» перед открытием системного браузера, и пользователь успевает
// кликнуть второй раз).
//
// Цвет управляется пропом `accent` (миграция 117): 'red' — старая
// красная схема, 'blue' — тёмно-синяя в одном стиле с кнопкой чата.
// Какая из кнопок (VIP или Чат) красная — выбирает клиент в дашборде в
// поле events.accent_button.

import { useState, CSSProperties } from 'react'

interface Props {
  label: string
  url: string
  onClick: (url: string) => void | Promise<void>
  style?: CSSProperties
  accent?: 'red' | 'blue'
}

export default function VipButton({ label, url, onClick, style, accent = 'red' }: Props) {
  const [busy, setBusy] = useState(false)

  async function handle() {
    if (busy) return
    setBusy(true)
    try {
      await onClick(url)
    } finally {
      // Небольшая задержка перед сбросом — пока браузер открывается,
      // не давать перерендеру моргнуть текстом обратно.
      setTimeout(() => setBusy(false), 800)
    }
  }

  const isRed = accent === 'red'
  const palette: CSSProperties = isRed
    ? {
        // ⚠️ Акцентная кнопка берёт заливку из темы клиента (--cta-bg).
        // По умолчанию там красный градиент платформы — вид не меняется;
        // с включёнными фирменными цветами приезжает кнопка клиента вместе
        // со своей рамкой. Раньше здесь был захардкожен пятистопный красный,
        // и главная кнопка экрана оставалась чужой при фирменной теме.
        background: 'var(--cta-bg)',
        color: 'var(--cta-text)',
        boxShadow: '0 4px 14px rgba(220,38,38,0.45)',
        border: 'var(--cta-border-width) solid var(--cta-border)',
      }
    : {
        background: 'var(--gradient-135)',
        boxShadow: '0 4px 14px rgba(37,69,93,0.35)',
        border: '1px solid rgba(10,21,32,0.5)',
      }

  return (
    <button
      type="button"
      onClick={handle}
      disabled={busy}
      style={{
        display: 'block', width: '100%', cursor: busy ? 'wait' : 'pointer',
        color: '#FFFFFF',
        borderRadius: 14, padding: '16px 16px', marginBottom: 12,
        textAlign: 'center', fontWeight: 900, fontSize: 15,
        letterSpacing: 1.2, textTransform: 'uppercase',
        textShadow: '0 1px 2px rgba(0,0,0,0.35)',
        opacity: busy ? 0.9 : 1,
        ...palette,
        ...style,
      }}
    >
      {busy ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <Spinner />
          Открываем…
        </span>
      ) : label}
    </button>
  )
}

function Spinner() {
  return (
    <>
      <span
        style={{
          width: 16, height: 16,
          border: '2px solid rgba(255,255,255,0.35)',
          borderTopColor: '#FFFFFF',
          borderRadius: '50%',
          display: 'inline-block',
          animation: 'vip-spin 0.7s linear infinite',
        }}
      />
      <style>{`@keyframes vip-spin { to { transform: rotate(360deg); } }`}</style>
    </>
  )
}
