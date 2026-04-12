import { useState, useEffect } from 'react'
import { getCommercial } from '../api'

const MOCK_ITEMS = [
  {
    id: 1, type: 'service', title: 'Стратегическая сессия с Марго',
    description: 'Личная консультация 60 минут по вашей реферальной стратегии',
    is_paid: true, action_url: '#'
  },
  {
    id: 2, type: 'material', title: 'Гайд по реферальному маркетингу',
    description: 'PDF-руководство с примерами и шаблонами',
    is_paid: false, action_url: '#'
  },
  {
    id: 3, type: 'service', title: 'Мастер-группа ПЛЮСОН',
    description: 'Закрытое сообщество предпринимателей, использующих реферальные механики',
    is_paid: true, action_url: '#'
  },
]

interface Props { event: any }

export default function ServicesTab({ event }: Props) {
  const [items, setItems] = useState(MOCK_ITEMS)

  useEffect(() => {
    if (!event?.id) return
    getCommercial(event.id)
      .then(r => { if (r.items?.length) setItems(r.items) })
      .catch(() => {})
  }, [event?.id])

  const services = items.filter(i => i.type === 'service')
  const materials = items.filter(i => i.type === 'material')

  return (
    <div className="fade-in" style={{ padding: '8px 16px 16px' }}>
      {services.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <p style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
            Услуги
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {services.map(item => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}

      {materials.length > 0 && (
        <div>
          <p style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
            Материалы и продукты
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {materials.map(item => (
              <ItemCard key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}

      {items.length === 0 && (
        <div style={{ textAlign: 'center', paddingTop: 40 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🛍️</div>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>
            Организатор пока не добавил услуги и предложения
          </p>
        </div>
      )}
    </div>
  )
}

function ItemCard({ item }: { item: any }) {
  return (
    <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{
        width: 40, height: 40, borderRadius: 10, flexShrink: 0,
        background: 'linear-gradient(45deg, #25455D, #0a1520)',
        border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18
      }}>
        {item.type === 'service' ? '💼' : '📄'}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <p style={{ color: 'white', fontSize: 14, fontWeight: 600 }}>{item.title}</p>
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 10, flexShrink: 0,
            ...(item.is_paid
              ? { background: 'rgba(255,207,164,0.12)', color: 'var(--peach)', border: '1px solid rgba(255,207,164,0.2)' }
              : { background: 'rgba(34,197,94,0.12)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.2)' })
          }}>
            {item.is_paid ? 'Платно' : 'Бесплатно'}
          </span>
        </div>
        {item.description && (
          <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.4, marginBottom: 10 }}>
            {item.description}
          </p>
        )}
        {item.action_url && (
          <a href={item.action_url} target="_blank" rel="noreferrer"
            className="btn btn-sm btn-outline"
            style={{ display: 'inline-block', width: 'auto', textDecoration: 'none' }}>
            Узнать подробнее →
          </a>
        )}
      </div>
    </div>
  )
}
