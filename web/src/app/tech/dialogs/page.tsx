'use client'

/**
 * Диалоги внедренца — его клиенты и переписка с ними.
 *
 * ⚠️⚠️ ЗДЕСЬ ВСЕ ЕГО КЛИЕНТЫ, а не только написавшие (23.09.2026). Раньше
 * разговоры раздавали вручную, и раздел пустовал; теперь основание одно — чей
 * клиент, того и разговор. Клиент без переписки тоже в списке: ему как раз и
 * нужно написать первым.
 *
 * ⚠️ Отбор делает БЭКЕНД по `clients.tech_specialist_id`: здесь фильтра нет и
 * быть не должно — он обходится прямым запросом.
 *
 * ⚠️ Два столбца, а не переход на отдельную страницу: разбирая вопросы, человек
 * прыгает между разговорами, и возврат в список каждый раз мешал бы.
 */
import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { api } from '@/lib/api'

const when = (v?: string | null) => {
  if (!v) return ''
  const d = new Date(v)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ru-RU')
}

export default function TechDialogsPage() {
  const [list, setList] = useState<any[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [thread, setThread] = useState<any>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)

  const load = () =>
    api.tech.dialogs().then((r: any) => setList(r.dialogs || [])).catch(() => {})

  useEffect(() => { load() }, [])

  /** Открыть разговор. ⚠️ У клиента, который ни разу не писал в бот, контакта
   *  нет вовсе (`contact_id === null`) — заводим его на лету, иначе строка в
   *  списке есть, а открыть и написать нечего. */
  async function openDialog(d: any) {
    if (d.contact_id) { setOpenId(d.contact_id); return }
    if (!d.platform_client_id) return
    try {
      const r: any = await api.tech.startDialog(d.platform_client_id)
      if (r?.contact_id) { setOpenId(r.contact_id); load() }
    } catch (e: any) {
      alert(e?.message || 'Не удалось открыть разговор')
    }
  }

  useEffect(() => {
    if (!openId) return
    api.tech.dialogMessages(openId)
      .then((r: any) => { setThread(r); load() })   // список обновляем: счётчик погас
      .catch(() => {})
  }, [openId])

  // Прокрутка к последнему сообщению: при открытии человек должен видеть конец
  // разговора, а не начало.
  useEffect(() => { bottom.current?.scrollIntoView() }, [thread])

  async function send() {
    const t = text.trim()
    if (!t || !openId) return
    // Площадка — та, на которой человек написал последним: отвечать надо туда,
    // откуда пришёл вопрос.
    //
    // ⚠️ Переписки может не быть вовсе (пишем первыми). Тогда берём первый
    // доступный канал этого человека, а НЕ «telegram» по умолчанию: у части
    // клиентов телеграма нет, и сообщение уходило бы в никуда.
    const current = list.find((x: any) => x.contact_id === openId)
    const fallback = (current?.where_to_write || []).find((p: string) =>
      ['telegram', 'vk', 'max', 'email'].includes(p))
    const platform = thread?.messages?.slice(-1)[0]?.platform || fallback
    if (!platform) { alert('Этому человеку некуда написать'); return }
    setSending(true)
    try {
      await api.tech.replyDialog(openId, { platform, text: t })
      setText('')
      const r: any = await api.tech.dialogMessages(openId)
      setThread(r)
    } catch (e: any) {
      alert(e?.message || 'Не отправилось')
    } finally { setSending(false) }
  }

  return (
    <div className="flex h-screen">
      <div className="w-80 shrink-0 overflow-y-auto border-r border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3">
          <div className="font-semibold text-gray-900">Диалоги</div>
          <div className="text-xs text-gray-500">Вопросы в @pluson_bot</div>
        </div>
        {!list.length ? (
          /* ⚠️ Текст поменялся вместе с логикой (23.09.2026): разговоры больше
             не «назначают» — здесь все ваши клиенты, и пусто тут может быть
             только если клиентов нет вовсе. */
          <div className="p-6 text-center text-sm text-gray-500">
            За вами пока не закреплён ни один клиент.
          </div>
        ) : list.map(d => (
          <button key={d.contact_id ?? `c${d.platform_client_id}`}
                  onClick={() => openDialog(d)}
                  className={`w-full border-b border-gray-50 px-4 py-3 text-left transition ${
                    openId === d.contact_id ? 'bg-gray-50' : 'hover:bg-gray-50'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-gray-900">
                {d.name || 'Без имени'}
              </span>
              <span className="shrink-0 text-xs text-gray-400">{when(d.last_at)}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="truncate text-xs text-gray-500">
                {/* ⚠️ Переписки может НЕ БЫТЬ вовсе: в списке теперь все свои
                    клиенты, в том числе те, кому ещё не писали. Вместо пустой
                    строки показываем, куда ему можно написать. */}
                {d.last_at ? (
                  <>
                    {d.last_direction === 'out' ? 'Вы: ' : ''}
                    {d.last_text || (d.last_media_kind ? `[${d.last_media_kind}]` : '')}
                  </>
                ) : (d.where_to_write?.length
                  ? <span className="text-gray-400">
                      Ещё не писали · можно: {d.where_to_write
                        .map((p: string) => ({ telegram: 'Telegram', vk: 'ВК',
                                               max: 'MAX', email: 'почта' }[p] || p))
                        .join(', ')}
                    </span>
                  : <span className="text-gray-400">Ещё не писали</span>)}
              </span>
              {d.unread > 0 && (
                <span className="ml-auto shrink-0 rounded-full bg-[#FFCFA4] px-1.5 text-[11px] font-bold text-[#0a1520]">
                  {d.unread}
                </span>
              )}
            </div>
            {/* Клиент платформы или просто человек с вопросом — отвечать надо
                по-разному, и это должно быть видно сразу. */}
            {d.platform_client_id && (
              <span className="mt-1 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                клиент ПЛЮСОНа
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-1 flex-col bg-gray-50">
        {!openId ? (
          <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
            Выберите разговор слева
          </div>
        ) : (<>
          <div className="border-b border-gray-200 bg-white px-5 py-3">
            <div className="font-semibold text-gray-900">
              {thread?.contact?.name || 'Без имени'}
            </div>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto p-5 scroll-visible">
            {(thread?.messages || []).map((m: any) => (
              <div key={m.id}
                   className={`max-w-[70%] rounded-2xl px-4 py-2 text-sm ${
                     m.direction === 'out'
                       ? 'ml-auto bg-[#25455D] text-white'
                       : 'bg-white text-gray-900 shadow-sm'}`}>
                {m.text}
                {m.media_kind && !m.text && (
                  <span className="italic opacity-70">[{m.media_kind}]</span>
                )}
                <div className={`mt-1 text-[11px] ${
                  m.direction === 'out' ? 'text-white/60' : 'text-gray-400'}`}>
                  {when(m.sent_at)}
                  {m.error && <span className="ml-1 text-red-400">не доставлено</span>}
                </div>
              </div>
            ))}
            <div ref={bottom} />
          </div>

          <div className="flex gap-2 border-t border-gray-200 bg-white p-4">
            <input
              value={text} onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              placeholder="Написать…"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            <button onClick={send} disabled={sending || !text.trim()}
                    className="btn-gold px-4 py-2 text-sm">
              <Send size={15} />
            </button>
          </div>
        </>)}
      </div>
    </div>
  )
}
