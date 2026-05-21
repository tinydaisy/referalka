// Welcome-экран после первой регистрации (миграция 057).
// Показывается один раз: когда is_registered стало true, а welcomed_at пуст.
// После клика «Перейти к программе» — POST /participants/{id}/welcomed
// и больше не показывается.
import { markParticipantWelcomed } from '../api'
import { useChatGate } from './ChatGate'
import VipButton from './VipButton'

interface Props {
  event: any                  // данные события (для названия и chat_url)
  participantId: number       // event_participant.id для отметки welcomed_at
  raffleEnabled: boolean      // показывать ли плитку «Розыгрыш»
  referralEnabled: boolean    // показывать ли плитку «Игра» (партнёрская программа)
  tgUser: any                 // нужен для проверки подписки на каналы соорганизаторов
  onContinue: () => void      // переход на «Программу»
  onVipClick?: (vipUrl: string) => void | Promise<void>  // открытие VIP-ссылки с партнёрским параметром
}

const TILE_BG = 'linear-gradient(45deg, rgba(37,69,93,0.04), rgba(255,207,164,0.10))'

export default function WelcomePage({ event, participantId, raffleEnabled, referralEnabled, tgUser, onContinue, onVipClick }: Props) {
  const chatUrl: string | null = event?.chat_url || event?.chat_url_tg || event?.chat_url_vk || event?.chat_url_max || null
  const eventTitle = event?.title || 'события'
  const vipUrl: string = (event?.vip_url || '').trim()
  const vipLabel: string = (event?.vip_button_label || '').trim() || 'Расшириться до VIP-тарифа'
  const { openChat, modal, loading } = useChatGate(event, tgUser)

  async function handleContinue() {
    try { await markParticipantWelcomed(participantId) } catch (_) { /* offline ok */ }
    onContinue()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <div className="grad-header" style={{ padding: '24px 18px 22px', textAlign: 'center' }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%',
          background: '#FFCFA4', margin: '0 auto 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 6px 18px rgba(255,207,164,0.4)',
        }}>
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#25455D" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h1 style={{ color: 'white', fontSize: 22, fontWeight: 800, lineHeight: 1.2 }}>
          Поздравляем с регистрацией!
        </h1>
        <p style={{ color: 'rgba(255,207,164,0.9)', fontSize: 13, marginTop: 6, fontWeight: 500 }}>
          Вы записаны на «{eventTitle}»
        </p>
      </div>

      <div style={{ padding: '18px 16px 24px', flex: 1 }}>
        {chatUrl && (
          <div style={{
            background: '#FFCFA4', borderRadius: 16, padding: '16px 16px 14px',
            marginBottom: 16, boxShadow: '0 4px 14px rgba(255,207,164,0.35)',
          }}>
            <div style={{ color: '#25455D', fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
              Войдите в чат события
            </div>
            <div style={{ color: '#25455D', fontSize: 12, fontWeight: 500, lineHeight: 1.45, opacity: 0.85 }}>
              Там вас ждут подарки за регистрацию, нетворкинг с другими участниками
              и оперативные ответы организатора.
            </div>
            <button onClick={openChat} disabled={loading} style={{
              marginTop: 12, width: '100%', padding: '10px 14px',
              background: '#25455D', color: 'white', border: 'none',
              borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer',
              opacity: loading ? 0.7 : 1,
            }}>
              {loading ? 'Проверяем подписку…' : 'Перейти в чат'}
            </button>
          </div>
        )}
        {modal}

        {vipUrl && (
          <VipButton
            label={vipLabel}
            url={vipUrl}
            onClick={onVipClick || ((u) => { window.open(u, '_blank', 'noopener,noreferrer') })}
            style={{ marginBottom: 16 }}
          />
        )}

        <p style={{ color: '#25455D', fontSize: 13, fontWeight: 600, margin: '4px 0 10px' }}>
          А ещё в Mini App вас ждёт:
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Tile
            icon="📅"
            title="Программа"
            text="Расписание по дням и кнопка входа в эфир, когда событие идёт."
          />
          {referralEnabled && (
            <Tile
              icon="🎯"
              title="Подарки"
              text="Приглашайте друзей по своей партнёрской ссылке и забирайте подарки за приведённых."
            />
          )}
          {raffleEnabled && (
            <Tile
              icon="🎟"
              title="Розыгрыш"
              text="Билеты за регистрацию и кодовые слова со спикеров. В конце — розыгрыш призов."
            />
          )}
          <Tile
            icon="🌐"
            title="Экосистема"
            text="Продукты и материалы от организатора — платно и бесплатно."
          />
        </div>

        <button onClick={handleContinue} style={{
          marginTop: 20, width: '100%', padding: '13px 16px',
          background: 'linear-gradient(45deg, #25455D, #0a1520)',
          color: 'white', border: 'none', borderRadius: 14,
          fontSize: 15, fontWeight: 700, cursor: 'pointer',
        }}>
          Перейти к программе
        </button>
      </div>
    </div>
  )
}

function Tile({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <div style={{
      background: TILE_BG, borderRadius: 14, padding: '12px 14px',
      display: 'flex', gap: 12, alignItems: 'flex-start',
      border: '1px solid rgba(37,69,93,0.06)',
    }}>
      <div style={{ fontSize: 22, lineHeight: 1, marginTop: 2 }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: '#25455D', fontSize: 13, fontWeight: 700, marginBottom: 2 }}>
          {title}
        </div>
        <div style={{ color: '#25455D', fontSize: 12, fontWeight: 500, lineHeight: 1.4, opacity: 0.8 }}>
          {text}
        </div>
      </div>
    </div>
  )
}
