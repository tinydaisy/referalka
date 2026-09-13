// Интро — страница после первой регистрации (миграция 057).
//
// ⚠️ У НЕЁ ДВА СОСТОЯНИЯ, и они ведут себя по-разному (мигр. 344):
//
//  1. ОБЫЧНОЕ (подписка не требуется) — навигация по вкладкам: «тут подарки,
//     тут программа, тут о проекте». Все вкладки открыты, ходить можно куда
//     угодно. Показывается ОДИН РАЗ: ушёл с неё — welcomed_at проставлен,
//     больше не увидит.
//
//  2. ТРЕБОВАНИЕ ПОДПИСКИ (events.sub_check_at_registration) — вместо плиток
//     список каналов и кнопка «Я подписался — проверить». Остальные вкладки
//     ВИДНЫ, но под замком: уйти с интро нельзя, пока не подписался.
//     Показывается при КАЖДОМ заходе, пока проверка не пройдена.
//
// ⚠️ Отметка о пройденной проверке (event_participants.sub_checked_at) НЕ
// снимается при отписке: требуем подписку до ПЕРВОГО факта. Иначе человек,
// отписавшийся через месяц, потерял бы доступ к программе события, на которое
// давно зарегистрирован.
//
// ⚠️ Почему подписку вообще просят здесь, а не при запуске: модерация
// ВКонтакте запрещает просить её до того, как человек увидел функции
// (п.1.1.2 правил Mini Apps). После регистрации — можно.
import { useState } from 'react'
import { markParticipantWelcomed, checkRegistrationGate } from '../api'
import { useChatGate } from './ChatGate'
import { getPlatform } from '../platform'
import VipButton from './VipButton'

interface Props {
  event: any                  // данные события (для названия и chat_url)
  participantId: number       // event_participant.id для отметки welcomed_at
  raffleEnabled: boolean      // показывать ли плитку «Розыгрыш»
  referralEnabled: boolean    // показывать ли плитку «Игра» (партнёрская программа)
  tgUser: any                 // нужен для проверки подписки на каналы соорганизаторов
  onContinue: () => void      // переход на «Программу»
  onVipClick?: (vipUrl: string) => void | Promise<void>  // открытие VIP-ссылки с партнёрским параметром
  /** Каналы, на которые надо подписаться. Пусто — обычное интро с плитками. */
  gateChannels?: { name: string; tg_channel_url: string | null }[]
  /** Проверить подписку заново. Вернёт true — гейт пройден, интро закрывается. */
  onGateRecheck?: () => Promise<boolean>
  /** Контакт — нужен, чтобы отметка легла на нужного участника. */
  contactId?: number | null
  eventId?: number
}

const TILE_BG = 'linear-gradient(45deg, rgba(37,69,93,0.04), rgba(var(--peach-rgb), 0.10))'

export default function WelcomePage({
  event, participantId, raffleEnabled, referralEnabled, tgUser, onContinue, onVipClick,
  gateChannels, onGateRecheck, contactId, eventId,
}: Props) {
  // Требуется подписка → показываем список каналов вместо плиток-навигации.
  const gateOn = !!(gateChannels && gateChannels.length)
  const [checking, setChecking] = useState(false)
  const [gateMsg, setGateMsg] = useState('')
  const chatUrl: string | null = event?.chat_url || event?.chat_url_tg || event?.chat_url_vk || event?.chat_url_max || null
  const eventTitle = event?.title || 'события'
  const vipUrl: string = (event?.vip_url || '').trim()
  const vipLabel: string = (event?.vip_button_label || '').trim() || 'Расшириться до VIP-тарифа'
  // Какая кнопка красная (миграция 117). На Welcome чат всегда — отдельная
  // peach-плашка (это онбординг, не «Программа»), а VIP красится по выбору
  // клиента: 'vip' → красная (дефолт), 'chat' | 'none' → тёмно-синяя.
  const vipAccent: 'red' | 'blue' = event?.accent_button === 'vip' || !event?.accent_button ? 'red' : 'blue'
  // Плитки интро обязаны называться ТАК ЖЕ, как вкладки внизу, — иначе человек
  // читает «Программа», а в меню видит «Подробности» и не понимает, куда идти.
  // Источник тот же, что у BottomNav в EventPage: clients.tab_label_* (мигр. 185).
  const labelProgram   = (event?.tab_label_program   || '').trim() || 'Программа'
  // ⚠️ Дефолты обязаны совпадать с NAV_REGISTERED в EventPage — иначе у клиента
  // без своих названий плитка и вкладка снова разойдутся («Подарки»/«Привилегии»).
  const labelGame      = (event?.tab_label_game      || '').trim() || 'Привилегии'
  const labelEcosystem = (event?.tab_label_ecosystem || '').trim() || 'О нас'
  const { openChat, modal, loading } = useChatGate(event, tgUser)

  async function handleContinue() {
    try { await markParticipantWelcomed(participantId) } catch (_) { /* offline ok */ }
    onContinue()
  }

  /** «Я подписался — проверить»: спросить у площадки заново. */
  async function recheck() {
    setChecking(true)
    setGateMsg('')
    try {
      // Родитель знает, чем проверять, и сам обновит состояние при успехе.
      if (onGateRecheck) {
        const ok = await onGateRecheck()
        if (!ok) setGateMsg('Пока не вижу подписки. Подпишитесь и нажмите ещё раз.')
        return
      }
      // Запасной путь, если родитель обработчик не передал.
      const p = getPlatform()
      const uid = p.user?.id || tgUser?.id
      if (!eventId || !uid) return
      const r: any = await checkRegistrationGate(eventId, p.name, uid, contactId)
      if (r?.allowed) { await handleContinue(); return }
      setGateMsg('Пока не вижу подписки. Подпишитесь и нажмите ещё раз.')
    } catch (_) {
      // ⚠️ Сбой проверки НЕ запирает человека: он уже зарегистрирован, и
      // отказать ему из-за нашей сетевой ошибки нельзя.
      setGateMsg('Не удалось проверить. Попробуйте ещё раз.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <div className="grad-header" style={{ padding: '24px 18px 22px', textAlign: 'center' }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%',
          background: 'var(--peach)', margin: '0 auto 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 6px 18px rgba(var(--peach-rgb), 0.4)',
        }}>
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--dark)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h1 style={{ color: 'white', fontSize: 22, fontWeight: 800, lineHeight: 1.2 }}>
          Поздравляем с регистрацией!
        </h1>
        <p style={{ color: 'rgba(var(--peach-rgb), 0.9)', fontSize: 13, marginTop: 6, fontWeight: 500 }}>
          Вы записаны на «{eventTitle}»
        </p>
      </div>

      <div style={{ padding: '18px 16px 24px', flex: 1 }}>
        {chatUrl && (
          <div style={{
            background: 'var(--peach)', borderRadius: 16, padding: '16px 16px 14px',
            marginBottom: 16, boxShadow: '0 4px 14px rgba(var(--peach-rgb), 0.35)',
          }}>
            <div style={{ color: 'var(--dark)', fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
              Войдите в чат события
            </div>
            <div style={{ color: 'var(--dark)', fontSize: 12, fontWeight: 500, lineHeight: 1.45, opacity: 0.85 }}>
              Там вас ждут подарки за регистрацию, нетворкинг с другими участниками
              и оперативные ответы организатора.
            </div>
            <button onClick={openChat} disabled={loading} style={{
              marginTop: 12, width: '100%', padding: '10px 14px',
              background: 'var(--dark)', color: 'white', border: 'none',
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
            accent={vipAccent}
            onClick={onVipClick || ((u) => { window.open(u, '_blank', 'noopener,noreferrer') })}
            style={{ marginBottom: 16 }}
          />
        )}

        {gateOn ? (
          <>
            {/* ⚠️ Список каналов + «Я подписался — проверить». Кнопки «Перейти
                к программе» тут НЕТ: пока подписки нет, уходить некуда —
                остальные вкладки под замком. */}
            <p style={{ color: 'var(--dark)', fontSize: 14, fontWeight: 700, margin: '4px 0 4px' }}>
              Чтобы попасть в кабинет участника — подпишитесь:
            </p>
            <p style={{ color: 'var(--dark)', fontSize: 12, fontWeight: 500, opacity: 0.75, margin: '0 0 12px', lineHeight: 1.45 }}>
              Там анонсы и материалы организатора. Проверим один раз — дальше кабинет открыт навсегда.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              {gateChannels!.map((c, i) => (
                <a
                  key={i}
                  href={c.tg_channel_url || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    if (!c.tg_channel_url) { e.preventDefault(); return }
                    // Внутри мессенджера обычная ссылка открывается не всегда —
                    // ведём через адаптер площадки.
                    e.preventDefault()
                    getPlatform().openExternal(c.tg_channel_url)
                  }}
                  style={{
                    background: TILE_BG, borderRadius: 14, padding: '12px 14px',
                    display: 'flex', gap: 12, alignItems: 'center',
                    border: '1px solid rgba(37,69,93,0.06)',
                    textDecoration: 'none',
                  }}
                >
                  <div style={{
                    flex: '0 0 auto', width: 26, height: 26, borderRadius: '50%',
                    background: 'var(--peach)', color: 'var(--dark)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 800,
                  }}>{i + 1}</div>
                  <div style={{ flex: 1, minWidth: 0, color: 'var(--dark)', fontSize: 13, fontWeight: 700 }}>
                    {c.name}
                  </div>
                  <div style={{ color: 'var(--dark)', opacity: 0.5, fontSize: 18 }}>›</div>
                </a>
              ))}
            </div>

            {gateMsg && (
              <p style={{ color: '#c0392b', fontSize: 12, fontWeight: 600, margin: '0 0 10px' }}>
                {gateMsg}
              </p>
            )}

            <button onClick={recheck} disabled={checking} style={{
              width: '100%', padding: '13px 16px',
              background: 'var(--gradient)',
              color: 'white', border: 'none', borderRadius: 14,
              fontSize: 15, fontWeight: 700, cursor: 'pointer',
              opacity: checking ? 0.7 : 1,
            }}>
              {checking ? 'Проверяем…' : 'Я подписался — проверить'}
            </button>
          </>
        ) : (
        <>
        <p style={{ color: 'var(--dark)', fontSize: 13, fontWeight: 600, margin: '4px 0 10px' }}>
          В этом приложении у вас:
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Tile
            icon="📅"
            title={labelProgram}
            text="Все подробности, важная информация и ссылки"
          />
          {referralEnabled && (
            <Tile
              icon="🎯"
              title={labelGame}
              text="Делитесь своей партнерской ссылкой с друзьями и получайте дополнительные привилегии"
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
            title={labelEcosystem}
            text="Информация о нас"
          />
        </div>

        <button onClick={handleContinue} style={{
          marginTop: 20, width: '100%', padding: '13px 16px',
          background: 'var(--gradient)',
          color: 'white', border: 'none', borderRadius: 14,
          fontSize: 15, fontWeight: 700, cursor: 'pointer',
        }}>
          Перейти к программе
        </button>
        </>
        )}
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
        <div style={{ color: 'var(--dark)', fontSize: 13, fontWeight: 700, marginBottom: 2 }}>
          {title}
        </div>
        <div style={{ color: 'var(--dark)', fontSize: 12, fontWeight: 500, lineHeight: 1.4, opacity: 0.8 }}>
          {text}
        </div>
      </div>
    </div>
  )
}
