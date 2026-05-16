import { useChatGate } from '../components/ChatGate'
import { trackLinkClick } from '../api'

const PEACH = '#FFCFA4'
const DARK  = '#25455D'

// Авто-линкификация: «...текст https://foo.bar/x текст...» → React-узлы
// с обычными <a> на http(s)-ссылках. Без HTML-инъекций (передаём строки и
// React.createElement, не dangerouslySetInnerHTML).
const URL_RE = /(https?:\/\/[^\s<>"']+)/gi
function linkify(text: string): React.ReactNode[] {
  if (!text) return []
  const parts: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const url = m[0]
    parts.push(
      <a key={parts.length} href={url} target="_blank" rel="noreferrer"
         style={{ color: DARK, textDecoration: 'underline', wordBreak: 'break-word' }}>
        {url}
      </a>
    )
    last = m.index + url.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export default function ContestProgramTab({
  event, tgUser,
}: {
  event: any
  tgUser: any
  refreshKey?: number
}) {
  const description: string = event?.description || ''
  const hasVotingUrl  = !!event?.stream_url
  const hasChat       = !!event?.chat_url

  const { openChat: openChatWithCheck, modal: chatModal, loading: chatLoading } = useChatGate(event, tgUser)

  return (
    <div style={{ padding: '14px 16px 100px' }}>
      {/* Описание конкурса с авто-линкификацией http(s) */}
      {description ? (
        <div style={{
          background: 'white', borderRadius: 14, padding: 16,
          marginBottom: 12, color: DARK, fontSize: 14, lineHeight: 1.55,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {description.split('\n').map((line, i) => (
            <div key={i}>{linkify(line)}</div>
          ))}
        </div>
      ) : (
        <div style={{
          background: 'white', borderRadius: 14, padding: 16,
          marginBottom: 12, color: '#9aa3ad', fontSize: 13, lineHeight: 1.55,
          textAlign: 'center',
        }}>
          Описание конкурса появится здесь, когда организатор его добавит.
        </div>
      )}

      {/* Кнопка «Перейти к голосованию» */}
      {hasVotingUrl && (
        <a href={event.stream_url} target="_blank" rel="noreferrer"
           onClick={() => trackLinkClick(event?.slug, tgUser)}
           style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: PEACH, color: DARK,
          borderRadius: 14, padding: 14, textDecoration: 'none',
          marginBottom: 10, fontWeight: 800,
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: 'rgba(37,69,93,0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={DARK} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4"/>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 900 }}>Перейти к голосованию</div>
            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2, fontWeight: 600 }}>
              Открыть страницу с голосованием
            </div>
          </div>
          <div style={{ fontSize: 24, color: DARK, fontWeight: 600, marginRight: 4 }}>›</div>
        </a>
      )}

      {/* Чат голосующих и партнёров — заменяет «Чат события» в обычных событиях */}
      {hasChat && (
        <button onClick={openChatWithCheck} disabled={chatLoading} style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: 'linear-gradient(135deg, #25455D, #0a1520)', color: 'white',
          borderRadius: 14, padding: 14, marginBottom: 12,
          border: 0, cursor: 'pointer', width: '100%', textAlign: 'left',
          fontFamily: 'inherit',
          opacity: chatLoading ? 0.7 : 1,
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: 'rgba(255,207,164,0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={PEACH} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800 }}>Чат голосующих и партнёров</div>
            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
              {chatLoading ? 'Проверяем подписку…' : 'Нетворкинг и обсуждение конкурса'}
            </div>
          </div>
          <div style={{ fontSize: 24, color: PEACH, fontWeight: 600, marginRight: 4 }}>›</div>
        </button>
      )}

      {chatModal}
    </div>
  )
}
