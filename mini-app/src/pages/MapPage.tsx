/**
 * Экран «Место проведения» — карта офлайн-события внутри Mini App.
 *
 * ⚠️⚠️ КАРТА ОТКРЫВАЕТСЯ ЗДЕСЬ, А НЕ В БРАУЗЕРЕ (решение владельца).
 * Уводить человека из мессенджера нельзя: выброшенный наружу часто не
 * возвращается и теряет контекст события — то же правило, по которому форма
 * заказа сделана окном внутри Mini App, а не переходом на сайт. Наружу уходит
 * только явное «Построить маршрут», когда человек к этому готов.
 *
 * ⚠️⚠️ КАРТА ЯНДЕКСА, И БЕЗ КЛЮЧА. У Google Maps встраивание требует API-ключа
 * с привязанным платёжным аккаунтом: клиенту пришлось бы его заводить, нам —
 * хранить, а в России часть посетителей карту всё равно не откроет. Яндекс
 * отдаёт карту обычным iframe по тексту адреса — ни ключей, ни оплаты.
 */
import { getPlatform } from '../platform'

const PEACH = '#FFCFA4'

export default function MapPage({
  address, title, onBack,
}: {
  /** Адрес как его вписал организатор — из `events.address`. */
  address: string
  /** Название события — в шапке, чтобы человек понимал, куда попал. */
  title?: string
  onBack: () => void
}) {
  const q = encodeURIComponent(address)
  // ⚠️ Ссылка на Яндекс.Карты, а не на приложение: у человека может не быть
  // установленных карт, и `yandexmaps://` открыл бы пустоту. Веб-ссылка сама
  // предложит открыть приложение, если оно есть.
  const mapsUrl = `https://yandex.ru/maps/?text=${q}`

  return (
    <div className="fade-in">
      <div style={{
        padding: '14px 18px',
        background: 'var(--gradient)',
        color: 'white', position: 'relative', overflow: 'hidden',
        margin: '-16px -16px 0', borderRadius: 0,
      }}>
        <button onClick={onBack}
                style={{
                  background: 'rgba(var(--peach-rgb), 0.15)', border: 'none', color: 'white',
                  width: 36, height: 36, borderRadius: 10, cursor: 'pointer', fontSize: 20,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
          ‹
        </button>
        <div style={{
          marginTop: 14, fontSize: 10, color: PEACH, fontWeight: 700,
          letterSpacing: 1.5, textTransform: 'uppercase',
        }}>
          Место проведения
        </div>
        {title && (
          <h1 style={{ fontSize: 20, fontWeight: 800, marginTop: 4, lineHeight: 1.2 }}>
            {title}
          </h1>
        )}
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', marginTop: 6, lineHeight: 1.4 }}>
          {address}
        </p>
      </div>

      {/* ⚠️ Высота фиксированная, а не «на весь экран»: под картой обязана
          помещаться кнопка маршрута — иначе на невысоких экранах до неё
          пришлось бы листать, и человек её не найдёт. */}
      <div style={{
        margin: '14px 0 0', borderRadius: 16, overflow: 'hidden',
        border: '1px solid var(--border)',
      }}>
        <iframe
          src={`https://yandex.ru/map-widget/v1/?text=${q}&z=16`}
          width="100%" height={360} frameBorder="0"
          style={{ border: 0, display: 'block' }}
          title="Карта места проведения"
          allowFullScreen
        />
      </div>

      <button
        onClick={() => getPlatform().openExternal(mapsUrl)}
        style={{
          width: '100%', marginTop: 14, padding: '14px 16px',
          background: 'var(--gradient-135)', color: 'white',
          border: 'none', borderRadius: 14, cursor: 'pointer',
          fontSize: 15, fontWeight: 800,
        }}>
        Построить маршрут
      </button>

      <p style={{
        fontSize: 11, opacity: 0.7, marginTop: 10, textAlign: 'center',
        lineHeight: 1.4, color: 'var(--text)',
      }}>
        Откроется в Яндекс.Картах — там можно построить маршрут от вашего места.
      </p>
    </div>
  )
}
