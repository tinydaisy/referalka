'use client'

/**
 * Статистика переходов по подаркам спикера — ОДИН компонент на два экрана:
 * карточку спикера в дашборде (смотрит организатор) и кабинет спикера.
 *
 * ⚠️ Два экрана держим на одном компоненте намеренно: спикер сверяет свои цифры
 * с организатором, и расхождение в вёрстке читается как расхождение в данных.
 */

import { useEffect, useState } from 'react'

const DARK = '#25455D'
const PEACH = '#FFCFA4'

type Row = {
  title: string
  is_package: boolean
  visits: number
  delivered: number
  fresh: number
}

type Period = {
  days: number
  from: string
  to: string
  label: string
  rows: Row[]
  total: { visits: number; delivered: number; fresh: number }
}

export type GiftStats = {
  available: boolean
  reason?: string
  from_date: string | null
  program_end?: string
  periods: Period[]
}

function Table({ p, accent, headText }: { p: Period; accent: string; headText: string }) {
  if (p.rows.length === 0) return null
  return (
    // ⚠️ Каждый период — ОТДЕЛЬНАЯ карточка. Раньше три таблицы шли подряд
    // и сливались: было не понять, где кончается один период и начинается
    // следующий, а даты терялись мелким шрифтом.
    <div style={{
      background: '#fff', border: '1px solid #dbe4ec', borderRadius: 14,
      padding: '16px 18px', marginBottom: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 19, fontWeight: 700, color: DARK }}>{p.label}</span>
        <span style={{ fontSize: 13, color: '#7a8c9c' }}>
          · {p.days === 0
            ? 'за само событие'
            : p.days === 3
              ? 'плюс 3 дня после'
              : 'плюс неделя после'}
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 420 }}>
          <thead>
            <tr style={{ background: '#f4f7f9', color: '#5c7589' }}>
              <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600 }}>Подарок</th>
              <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>Перешли</th>
              <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>Забрали</th>
              <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>Новых</th>
            </tr>
          </thead>
          <tbody>
            {/* «Всего» — ПЕРВОЙ строкой: сначала общая цифра, потом её разбор.
                Внизу её приходилось искать под списком подарков. */}
            <tr style={{ background: accent, fontWeight: 700, color: headText }}>
              <td style={{ padding: '11px 10px', fontSize: 14 }}>Всего</td>
              <td style={{ padding: '11px 10px', textAlign: 'right', fontSize: 15 }}>{p.total.visits}</td>
              <td style={{ padding: '11px 10px', textAlign: 'right', fontSize: 15 }}>{p.total.delivered}</td>
              <td style={{ padding: '11px 10px', textAlign: 'right', fontSize: 15 }}>{p.total.fresh}</td>
            </tr>
            {p.rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #eef2f5' }}>
                <td style={{ padding: '8px 10px', color: DARK }}>
                  {r.title}
                  {r.is_package && (
                    <span style={{ marginLeft: 6, fontSize: 11, color: '#7a8c9c' }}>пакет</span>
                  )}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{r.visits}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.delivered}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.fresh}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function SpeakerGiftStats({
  load,
  forSpeaker = false,
  accent = PEACH,
}: {
  /** Загрузчик — у дашборда и кабинета разные эндпоинты, данные одинаковые. */
  load: () => Promise<GiftStats>
  /** true — экран спикера: обращение на «вы», совет писать организатору. */
  forSpeaker?: boolean
  /** Акцентный цвет из темы клиента. В дашборде — фирменный персиковый. */
  accent?: string
}) {
  // Текст на акцентной плашке: на тёмном фоне белый, на светлом — тёмный.
  const headText = (() => {
    const hex = (accent || '').replace('#', '')
    const n = parseInt(hex.length === 3 ? hex.split('').map(x => x + x).join('') : hex, 16)
    if (Number.isNaN(n)) return DARK
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
    return lum < 0.6 ? '#fff' : DARK
  })()
  const [data, setData] = useState<GiftStats | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    load().then(setData).catch(e => setErr(String(e?.message || e)))
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div style={{ fontSize: 13, color: '#a83e1c' }}>Не удалось загрузить статистику</div>
  if (!data) return <div style={{ fontSize: 13, color: '#7a8c9c' }}>Загружаем…</div>

  // Слота с датой нет — отсчитывать не от чего. Пишем словами, а не рисуем нули.
  if (!data.available) {
    return (
      <div style={{ fontSize: 13, color: '#5c7589', background: '#f4f7f9', padding: 12, borderRadius: 10 }}>
        {forSpeaker
          ? 'Статистика появится, когда организатор поставит ваше выступление в программу — переходы считаются со дня эфира.'
          : 'У спикера нет слота в программе — переходы считать не от чего. Поставьте выступление в программу.'}
      </div>
    )
  }

  // Подарки есть, но все ручные (не из ПЛЮСОНа) — считать нечего.
  const hasRows = data.periods.some(p => p.rows.length > 0)
  if (!hasRows) {
    return (
      <div style={{ fontSize: 13, color: headText, background: accent, padding: 12, borderRadius: 10 }}>
        {forSpeaker
          ? <>Переходы по вашим подаркам не считаются: вы дали свои ссылки, не из ПЛЮСОНа.
              Чтобы видеть статистику, попросите организатора включить подсчёт переходов.</>
          : <>У спикера свои ссылки на подарки, не из ПЛЮСОНа — переходы по ним не считаются.
              Включите подсчёт переходов, чтобы видеть цифры.</>}
      </div>
    )
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: '#5c7589', marginBottom: 12 }}>
        <b>Перешли</b> — открыли подарок. <b>Забрали</b> — дошли до получения файла.{' '}
        <b>Новых</b> — попали в базу впервые, их привёл{forSpeaker ? 'о ваше выступление' : ' этот спикер'}.
      </div>
      {data.periods.map(p => <Table key={p.days} p={p} accent={accent} headText={headText} />)}
    </div>
  )
}
