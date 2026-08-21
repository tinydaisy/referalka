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

function Table({ p }: { p: Period }) {
  if (p.rows.length === 0) return null
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: DARK, marginBottom: 6 }}>
        {p.label}
        <span style={{ fontWeight: 400, color: '#7a8c9c' }}>
          {' '}· {p.days === 0
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
            <tr style={{ background: '#fdf6ef', fontWeight: 700, color: DARK }}>
              <td style={{ padding: '9px 10px' }}>Итого</td>
              <td style={{ padding: '9px 10px', textAlign: 'right' }}>{p.total.visits}</td>
              <td style={{ padding: '9px 10px', textAlign: 'right' }}>{p.total.delivered}</td>
              <td style={{ padding: '9px 10px', textAlign: 'right' }}>{p.total.fresh}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function SpeakerGiftStats({
  load,
  forSpeaker = false,
}: {
  /** Загрузчик — у дашборда и кабинета разные эндпоинты, данные одинаковые. */
  load: () => Promise<GiftStats>
  /** true — экран спикера: обращение на «вы», совет писать организатору. */
  forSpeaker?: boolean
}) {
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
      <div style={{ fontSize: 13, color: '#5c7589', background: '#fdf6ef', border: `1px solid ${PEACH}`, padding: 12, borderRadius: 10 }}>
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
      {data.periods.map(p => <Table key={p.days} p={p} />)}
    </div>
  )
}
