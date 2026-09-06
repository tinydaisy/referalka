/**
 * Выбор тарифа — что открывается по кнопке участия, когда способ регистрации
 * «простая форма» и у события заданы тарифы.
 *
 * ⚠️ Кнопка участия («Хочу») — это ПЕРЕХОД, сама по себе она не про тарифы.
 * Куда вести, решает способ регистрации: сторонний лендинг → туда, наш
 * лендинг → туда, простая форма → форма регистрации. Тарифы вклиниваются
 * ровно в последнюю ветку: сначала выбор варианта участия, форма — после
 * него. Иначе человек «регистрируется» бесплатно там, где участие продаётся
 * (прод: событие 8 с единственным тарифом 5000 ₽).
 *
 * ⚠️ Платный тариф ведёт на СУЩЕСТВУЮЩУЮ страницу заказа
 * `{домен клиента}/e/{slug}/order/{id}` — там оплата, «Это вы?» и приём
 * данных. Второго механизма оплаты не заводим.
 */
import { useState } from 'react'

export interface Tariff {
  id: number
  title: string
  description?: string | null
  price: number
  old_price?: number | null
  discount_percent?: number | null
}

interface Props {
  event: any
  tariffs: Tariff[]
  /** Реф-код приведшего и метка источника — их нельзя терять при переходе. */
  partnerId?: string
  utmSource?: string
  contactId?: number
  onClose: () => void
  /** Выбран бесплатный тариф → обычная форма регистрации. */
  onFree: () => void
}

function money(v: number) {
  return `${Math.round(v).toLocaleString('ru-RU')} ₽`
}

export default function TariffPicker({
  event, tariffs, partnerId, utmSource, contactId, onClose, onFree,
}: Props) {
  const [going, setGoing] = useState(false)

  async function pick(t: Tariff) {
    if (going) return
    if ((t.price || 0) <= 0) { onFree(); return }

    setGoing(true)
    // ⚠️ Адрес — на ДОМЕНЕ КЛИЕНТА (у него может быть свой), поэтому берём
    // готовый public_base с бэкенда, а не литерал pluson.ru.
    const base = String(event?.client_public_base || '').replace(/\/+$/, '')
    const path = `/e/${encodeURIComponent(event?.slug || '')}/order/${t.id}`
    const qs = new URLSearchParams()
    // ⚠️ Контакт и реф-код тащим с собой: без них человек на странице заказа
    // станет «новым», а приведший его — никем.
    if (contactId) qs.set('c', String(contactId))
    if (partnerId) qs.set('pid', partnerId)
    if (utmSource) qs.set('utm_source', utmSource)
    const q = qs.toString()
    const url = base + path + (q ? `?${q}` : '')

    const { getPlatform } = await import('../platform')
    getPlatform().openExternal(url)
    setGoing(false)
  }

  return (
    // ⚠️ Окно закрывается только кнопкой «Отмена» — правило проекта для форм.
    <div className="modal-bg">
      <div className="modal-sheet">
        <h2>Выберите вариант участия</h2>

        {tariffs.map(t => {
          const free = (t.price || 0) <= 0
          return (
            <div key={t.id} style={{
              border: '1.5px solid rgba(255,255,255,.14)',
              borderRadius: 14, padding: 14, marginBottom: 12,
            }}>
              <div style={{
                display: 'flex', alignItems: 'baseline',
                justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
              }}>
                <div style={{ fontSize: 15, fontWeight: 800 }}>{t.title}</div>
                <div style={{ fontSize: 15, fontWeight: 800, whiteSpace: 'nowrap' }}>
                  {free ? 'Бесплатно' : money(t.price)}
                  {!free && t.old_price ? (
                    <span style={{
                      marginLeft: 7, fontSize: 12.5, fontWeight: 600,
                      opacity: .6, textDecoration: 'line-through',
                    }}>{money(t.old_price)}</span>
                  ) : null}
                  {!free && t.discount_percent ? (
                    <span style={{
                      marginLeft: 7, fontSize: 11.5, fontWeight: 800,
                      background: 'var(--peach)', color: '#25455D',
                      borderRadius: 6, padding: '2px 6px',
                    }}>{`−${t.discount_percent}%`}</span>
                  ) : null}
                </div>
              </div>

              {t.description ? (
                <div style={{
                  marginTop: 8, fontSize: 13, lineHeight: 1.5,
                  color: 'var(--muted)', whiteSpace: 'pre-wrap',
                }}>{t.description}</div>
              ) : null}

              <button
                className="btn btn-primary"
                style={{ marginTop: 12 }}
                disabled={going}
                onClick={() => pick(t)}
              >{free ? 'Записаться' : 'Оформить'}</button>
            </div>
          )
        })}

        <button
          onClick={onClose}
          disabled={going}
          style={{
            width: '100%', marginTop: 4, padding: 12, background: 'none',
            border: 'none', color: 'var(--muted)', fontSize: 14,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >Отмена</button>
      </div>
    </div>
  )
}
