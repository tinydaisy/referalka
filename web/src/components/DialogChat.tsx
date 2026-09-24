'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Send, Pencil, Trash2, Check, X, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'

type Msg = {
  id: number
  platform: string
  channel_id: number | null
  platform_user_id: string
  direction: 'in' | 'out'
  author_kind: 'contact' | 'bot' | 'operator'
  text: string | null
  media_url: string | null
  media_kind: string | null
  platform_message_id: string | null
  is_deleted: boolean
  error: string | null
  sent_at: string
  edited_at: string | null
}

const PLATFORM_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  vk: 'ВКонтакте',
  max: 'MAX',
  instagram: 'Instagram',
}
const PLATFORM_SHORT: Record<string, string> = {
  telegram: 'TG', vk: 'VK', max: 'MAX', instagram: 'IG',
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru', {
      timeZone: 'Europe/Moscow',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    }) + ' МСК'
  } catch { return iso }
}

const MEDIA_LABEL: Record<string, string> = {
  photo: '🖼 Фото', video: '🎬 Видео', document: '📎 Файл',
  audio: '🎵 Аудио', voice: '🎤 Голосовое (не обрабатывается)',
  sticker: '🩷 Стикер', other: '📎 Вложение',
}

export default function DialogChat({
  contactId,
  contactName,
  availablePlatforms,
  dialogsApi,
}: {
  contactId: number
  contactName: string
  availablePlatforms: string[] // платформы, где у контакта есть аккаунт (для отправки)
  // ⚠️⚠️ НАБОР МЕТОДОВ — ПАРАМЕТРОМ (23.09.2026). Тот же экран переписки
  // нужен в кабинете ВНЕДРЕНЦА, а клиентские ручки `/dialogs/*` ему закрыты:
  // у него свои, `/tech/dialogs/*`. Своя копия компонента там выглядела бы
  // иначе и разъехалась бы по поведению — уже так и вышло, пока копия была.
  // Не передан — работаем клиентскими, как раньше.
  dialogsApi?: {
    messages: (id: number) => Promise<any>
    reply: (id: number, body: { platform: string; text: string }) => Promise<any>
    edit?: (id: number, text: string) => Promise<any>
    remove?: (id: number) => Promise<any>
  }
}) {
  // ⚠️ Правка и удаление есть не везде: у внедренца их нет, и кнопки тогда
  // прятать — иначе нажатие молча падает.
  const A = dialogsApi || api.dialogs
  const canEdit = !!(A as any).edit
  const canDelete = !!(A as any).remove
  const [messages, setMessages] = useState<Msg[]>([])
  const [chatPlatforms, setChatPlatforms] = useState<string[]>([])
  // Непрочитанные по площадкам на момент ОТКРЫТИЯ диалога: {telegram: 2, max: 1}.
  // ⚠️ Снимок, а не живая величина — открытие переписки её тут же обнуляет
  // на сервере. Держим, чтобы человек видел, где были новые сообщения, и понял,
  // какую вкладку смотреть.
  const [unreadBy, setUnreadBy] = useState<Record<string, number>>({})
  // Открытая на весь экран картинка (просмотр по клику), null — закрыт.
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await A.messages(contactId)
      setMessages(r.messages || [])
      setChatPlatforms(r.platforms || [])
      setUnreadBy(r.unread_by_platform || {})
    } catch { /* пусто */ } finally {
      setLoading(false)
    }
  }, [contactId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    // прокрутка вниз после загрузки/отправки
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, loading])

  // На какую платформу слать ответ: активная вкладка → иначе первая, где есть переписка,
  // → иначе первая доступная у контакта.
  const replyPlatform =
    activeTab !== 'all' ? activeTab
      : (chatPlatforms[0] || availablePlatforms[0] || 'telegram')

  const canReply = availablePlatforms.includes(replyPlatform)

  const visible = activeTab === 'all'
    ? messages
    : messages.filter(m => m.platform === activeTab)

  async function send() {
    const t = text.trim()
    if (!t || sending) return
    setSending(true)
    try {
      await A.reply(contactId, { platform: replyPlatform, text: t })
      setText('')
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось отправить')
    } finally {
      setSending(false)
    }
  }

  async function saveEdit(id: number) {
    const t = editText.trim()
    if (!t) return
    try {
      await (A as any).edit(id, t)
      setEditingId(null)
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось изменить')
    }
  }

  async function remove(id: number) {
    if (!confirm('Удалить это сообщение у получателя?')) return
    try {
      await (A as any).remove(id)
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось удалить')
    }
  }

  // Вкладки = платформы переписки + платформы, где у контакта есть аккаунт
  // (чтобы можно было начать диалог даже без истории).
  const tabs = Array.from(new Set([...chatPlatforms, ...availablePlatforms]))

  return (
    <div className="flex flex-col h-full">
      {/* Заголовок чата + вкладки платформ */}
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {tabs.length > 1 && (
            <button
              onClick={() => setActiveTab('all')}
              className={`text-xs px-2.5 py-1 rounded-full font-medium ${activeTab === 'all' ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600'}`}
            >Все</button>
          )}
          {tabs.map(p => (
            <button
              key={p}
              onClick={() => setActiveTab(p)}
              className={`text-xs px-2.5 py-1 rounded-full font-medium inline-flex items-center gap-1.5 ${activeTab === p ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600'}`}
            >
              {PLATFORM_LABEL[p] || p}
              {/* Сколько новых сообщений было на этой площадке, когда диалог
                  открыли. У человека может быть три площадки сразу, и без
                  цифры непонятно, в какую вкладку смотреть. */}
              {!!unreadBy[p] && (
                <span
                  title={`Новых сообщений: ${unreadBy[p]}`}
                  className="min-w-[16px] text-center text-[10px] font-bold px-1 py-0.5 rounded-full"
                  style={{ background: '#FFCFA4', color: '#25455D' }}
                >
                  {unreadBy[p]}
                </span>
              )}
            </button>
          ))}
          {tabs.length === 0 && (
            <span className="text-xs text-gray-400">Переписки пока нет</span>
          )}
        </div>
        <button onClick={load} className="text-gray-400 hover:text-[#25455D] shrink-0" title="Обновить">
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Лента */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2 bg-gray-50 scroll-visible">
        {loading ? (
          <div className="text-center text-gray-400 text-sm py-8">Загрузка…</div>
        ) : visible.length === 0 ? (
          <div className="text-center text-gray-400 text-sm py-8">
            Здесь появится история переписки с этим человеком.<br />
            Когда он напишет в ваш бот — сообщение попадёт сюда, и вы сможете ответить.
          </div>
        ) : (
          visible.map(m => {
            const out = m.direction === 'out'
            const isOperator = m.author_kind === 'operator'
            return (
              <div key={m.id} className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm relative group ${
                  out
                    ? (isOperator ? 'bg-[#25455D] text-white' : 'bg-blue-100 text-gray-700')
                    : 'bg-white border border-gray-200 text-gray-800'
                }`}>
                  {/* метка автора / платформы */}
                  <div className={`text-[10px] mb-0.5 ${
                    isOperator ? 'text-white/60' : 'text-gray-400'
                  }`}>
                    {out ? (isOperator ? 'Вы' : 'Бот (авто)') : 'Клиент'}
                    {' · '}{PLATFORM_SHORT[m.platform] || m.platform}
                  </div>

                  {m.is_deleted ? (
                    <span className="italic opacity-60">сообщение удалено</span>
                  ) : (
                    <>
                      {/* Картинку показываем САМОЙ КАРТИНКОЙ, а не подписью со
                          ссылкой: человек прислал фото — его надо видеть, не
                          открывая вкладку. Клик по ней открывает оригинал. */}
                      {m.media_kind === 'photo' && m.media_url && (
                        // ⚠️ Клик открывает просмотр ВНУТРИ кабинета, а не
                        // ссылку на файл. Ссылка вела в хранилище, и браузер
                        // не показывал картинку, а скачивал её (у .webp это
                        // особенно заметно) — приходилось лезть в загрузки.
                        <button
                          type="button"
                          onClick={() => setLightbox(m.media_url!)}
                          className="block mb-1 cursor-zoom-in"
                          title="Открыть крупнее"
                        >
                          <img
                            src={m.media_url}
                            alt="Фото"
                            loading="lazy"
                            className="rounded-lg max-w-[220px] max-h-[220px] w-auto h-auto object-cover"
                          />
                        </button>
                      )}
                      {m.media_kind && !(m.media_kind === 'photo' && m.media_url) && (
                        <div className={`text-xs mb-1 ${isOperator ? 'text-white/80' : 'text-gray-500'}`}>
                          {m.media_url ? (
                            <a href={m.media_url} target="_blank" rel="noreferrer" className="underline">
                              {MEDIA_LABEL[m.media_kind] || MEDIA_LABEL.other}
                            </a>
                          ) : (
                            <>
                              {MEDIA_LABEL[m.media_kind] || MEDIA_LABEL.other}
                              {/* ⚠️ Честно говорим, что файла нет. Раньше тут
                                  висело просто «Фото», и выглядело как будто
                                  оно должно открыться — а открывать нечего:
                                  ссылки мессенджеров живут около часа, и файл
                                  сохраняется у нас. Не сохранился — потерян. */}
                              <span className="opacity-60"> — файл не сохранился</span>
                            </>
                          )}
                        </div>
                      )}
                      {editingId === m.id ? (
                        <div className="flex flex-col gap-1">
                          <textarea
                            className="text-gray-800 text-sm rounded-lg p-2 w-60 max-w-full border"
                            rows={2}
                            value={editText}
                            onChange={e => setEditText(e.target.value)}
                          />
                          <div className="flex gap-1 justify-end">
                            <button onClick={() => saveEdit(m.id)} className="p-1 rounded bg-green-500 text-white"><Check size={14} /></button>
                            <button onClick={() => setEditingId(null)} className="p-1 rounded bg-gray-300 text-gray-700"><X size={14} /></button>
                          </div>
                        </div>
                      ) : (
                        m.text && <div className="whitespace-pre-wrap break-words">{m.text}</div>
                      )}
                    </>
                  )}

                  <div className={`text-[10px] mt-0.5 flex items-center gap-1 ${isOperator ? 'text-white/50' : 'text-gray-300'}`}>
                    {fmtTime(m.sent_at)}
                    {m.edited_at && <span>· изм.</span>}
                    {m.error && <span className="text-red-400" title={m.error}>· не доставлено</span>}
                  </div>

                  {/* действия над своим сообщением */}
                  {/* ⚠️ Кнопки только там, где методы есть: у внедренца
                      правки и удаления нет, и нажатие падало бы молча. */}
                  {isOperator && !m.is_deleted && editingId !== m.id
                   && (canEdit || canDelete) && (
                    <div className="absolute -top-2 -left-2 hidden group-hover:flex gap-0.5">
                      {canEdit && (
                      <button
                        onClick={() => { setEditingId(m.id); setEditText(m.text || '') }}
                        className="p-1 rounded-full bg-white border shadow text-gray-500 hover:text-[#25455D]"
                        title="Изменить"
                      ><Pencil size={11} /></button>
                      )}
                      {canDelete && (
                      <button
                        onClick={() => remove(m.id)}
                        className="p-1 rounded-full bg-white border shadow text-gray-500 hover:text-red-500"
                        title="Удалить"
                      ><Trash2 size={11} /></button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Поле ввода */}
      <div className="border-t border-gray-100 p-2.5 shrink-0 bg-white">
        {!canReply && tabs.length > 0 && (
          <div className="text-[11px] text-amber-600 mb-1.5 px-1">
            У контакта нет аккаунта в {PLATFORM_LABEL[replyPlatform] || replyPlatform} — ответить туда нельзя.
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            className="flex-1 resize-none text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:border-[#25455D] max-h-28"
            rows={1}
            placeholder={canReply ? `Написать в ${PLATFORM_LABEL[replyPlatform] || replyPlatform}…` : 'Нет канала для ответа'}
            value={text}
            disabled={!canReply}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          />
          <button
            onClick={send}
            disabled={sending || !text.trim() || !canReply}
            className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-white disabled:opacity-40"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
            title="Отправить (Enter)"
          >
            <Send size={16} />
          </button>
        </div>
        {/* Файлы из переписки попадают в файловое хранилище платформы. Согласно
            п. 7.9 Оферты документы с персональными данными туда загружать
            нельзя — предупреждаем клиента, чтобы он не собирал их через бот. */}
        <div className="text-[11px] text-gray-400 mt-1.5 px-1 leading-snug">
          Не собирайте в переписке документы с персональными данными — сканы паспортов,
          медицинские и финансовые документы. Согласно п. 7.9 Оферты ответственность за
          их загрузку в хранилище платформы несёт владелец кабинета.
        </div>
      </div>

      {/* Просмотр картинки во весь экран. ⚠️ Это ЛАЙТБОКС, а не форма — по
          правилу проекта он закрывается и кликом по фону тоже: терять здесь
          нечего, а закрывать привычнее всего именно так. */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 cursor-zoom-out"
        >
          <img
            src={lightbox}
            alt="Фото"
            onClick={e => e.stopPropagation()}
            className="max-w-full max-h-full rounded-lg object-contain cursor-default"
          />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center"
            title="Закрыть"
          >
            <X size={18} />
          </button>
          {/* Оригинал открывается отдельной ссылкой — на случай, если нужно
              рассмотреть в полном размере или сохранить себе. */}
          <a
            href={lightbox}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/80 hover:text-white underline"
          >
            Открыть оригинал
          </a>
        </div>
      )}
    </div>
  )
}
