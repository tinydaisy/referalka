/**
 * Вкладка «Партнёру» в Хабе (решения № 2, 3, 4).
 *
 * Показывает партнёру его ссылки и заработок, а не-партнёру — приглашение
 * в программу. Кому вкладка вообще видна, решает клиент настройкой
 * `partner_tab_visibility` (см. Hub).
 *
 * ⚠️ Сам кабинет партнёра живёт в вебе (`/my`, раздел «Партнёру»): там вход по
 * коду на почту и полноценные списки. Здесь — витрина внутри мессенджера, где
 * человек уже опознан по аккаунту площадки, поэтому ссылки видны сразу, без
 * входа. Дублировать веб-кабинет в Mini App не нужно: разъедется.
 *
 * ⚠️ Ноль не объясняем (№ 31): пустой раздел — просто пусто.
 */
import { useEffect, useState } from 'react'
import { getPartnerMiniApp } from '../api'
import { getPlatformName } from '../platform'

const DARK = 'var(--dark)'
const PEACH = 'var(--peach)'

interface Props {
  clientId: number
  tgUser: any
}

const money = (v: any) =>
  (Number(v) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽'

export default function PartnerTab({ clientId, tgUser }: Props) {
  const [data, setData] = useState<any>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    const uid = tgUser?.id ? String(tgUser.id) : ''
    if (!uid) { setData({ is_partner: false }); return }
    // ⚠️ Площадку передаём явно: один и тот же код работает в TG, VK и MAX,
    // и по одному лишь id человека не найти — id-пространства у площадок свои.
    getPartnerMiniApp(clientId, getPlatformName(), uid)
      .then(setData)
      .catch(() => setData({ is_partner: false }))
  }, [clientId, tgUser?.id])

  const copy = (text: string, key: string) => {
    navigator.clipboard?.writeText(text)
      .then(() => { setCopied(key); setTimeout(() => setCopied(null), 1500) })
      .catch(() => {})
  }

  if (!data) {
    return <div style={{ padding: 24, color: '#8a96a3' }}>Загружаем…</div>
  }

  // Не партнёр — приглашение. Кабинет открывается в браузере: там вход по коду
  // на почту, оферта и налоговый статус — в мессенджере такое собирать негде.
  if (!data.is_partner) {
    return (
      <div style={{ padding: '24px 16px' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🤝</div>
        <div style={{ fontWeight: 800, fontSize: 20, color: DARK, marginBottom: 8 }}>
          Рекомендуйте и зарабатывайте
        </div>
        <div style={{ color: '#5b6a78', fontSize: 14, lineHeight: 1.5, marginBottom: 20 }}>
          Получите личные ссылки на события и продукты. Человек покупает по вашей
          ссылке — вам начисляется вознаграждение.
        </div>
        {data.cabinet_url && (
          <a href={data.cabinet_url} target="_blank" rel="noreferrer"
             style={{
               display: 'block', textAlign: 'center', padding: '14px 20px',
               borderRadius: 14, background: PEACH, color: DARK,
               fontWeight: 800, textDecoration: 'none',
             }}>
            Стать партнёром
          </a>
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 16px 24px' }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <Stat label="К выплате" value={money(data.due)} />
        <Stat label="Продаж" value={String(data.sales_count ?? 0)} />
      </div>

      <div style={{
        background: '#f4f7fa', borderRadius: 12, padding: 12,
        fontSize: 13, color: '#5b6a78', marginBottom: 18, lineHeight: 1.45,
      }}>
        {data.payout_mode === 'passive'
          ? <>Вознаграждение идёт со <b>всех покупок</b> людей, которых вы привели.</>
          : <>Вознаграждение идёт за <b>каждую покупку по вашей рекомендации</b>.</>}
      </div>

      {(data.items || []).length === 0 ? (
        <div style={{ color: '#8a96a3', fontSize: 14 }}>Пока нечего рекомендовать.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(data.items || []).map((it: any) => (
            <div key={`${it.kind}-${it.id}`} style={{
              background: '#fff', borderRadius: 14, padding: 12,
              boxShadow: '0 1px 3px rgba(16,32,48,.08)',
            }}>
              <div style={{ fontWeight: 700, color: DARK, marginBottom: 6 }}>
                {it.title}
              </div>
              <div style={{
                fontSize: 12, color: '#8a96a3', wordBreak: 'break-all',
                marginBottom: 8,
              }}>{it.link}</div>
              <button
                onClick={() => copy(it.link, `${it.kind}-${it.id}`)}
                style={{
                  width: '100%', padding: '10px 14px', borderRadius: 10,
                  border: 'none', background: DARK, color: '#fff',
                  fontWeight: 700, fontSize: 14, cursor: 'pointer',
                }}
              >
                {copied === `${it.kind}-${it.id}` ? 'Скопировано ✓' : 'Скопировать ссылку'}
              </button>
            </div>
          ))}
        </div>
      )}

      {data.cabinet_url && (
        <a href={data.cabinet_url} target="_blank" rel="noreferrer"
           style={{
             display: 'block', textAlign: 'center', marginTop: 18,
             padding: '12px 16px', borderRadius: 12,
             border: '1px solid #dde5ec', color: DARK,
             fontWeight: 700, fontSize: 14, textDecoration: 'none',
           }}>
          Открыть полный кабинет
        </a>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      flex: 1, background: '#fff', borderRadius: 12, padding: 12,
      boxShadow: '0 1px 3px rgba(16,32,48,.08)',
    }}>
      <div style={{ fontSize: 11, color: '#8a96a3', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, color: DARK }}>{value}</div>
    </div>
  )
}
