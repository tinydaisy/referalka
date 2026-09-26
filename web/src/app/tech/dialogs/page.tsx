'use client'

/**
 * Диалоги внедренца — его клиенты и переписка с ними.
 *
 * ⚠️⚠️ ЭКРАН ПЕРЕПИСКИ — ОБЩИЙ (`components/DialogChat`, 23.09.2026). Раньше
 * здесь была своя самодельная лента: без вкладок площадок, без границ
 * сообщений, с бледной строкой ввода — по виду нельзя было понять, загрузилось
 * ли вообще. Теперь тот же компонент, что в карточке контакта у клиента:
 * вкладки площадок сверху, пузыри сообщений, вложения, выбор «куда ответить».
 *
 * ⚠️ Методы передаются ПАРАМЕТРОМ (`dialogsApi`): клиентские ручки
 * `/dialogs/*` внедренцу закрыты, у него свои `/tech/dialogs/*`. Копия
 * компонента под второй набор снова разъехалась бы по виду и поведению.
 *
 * ⚠️⚠️ ЗДЕСЬ ВСЕ ЕГО КЛИЕНТЫ, а не только написавшие. Клиент без переписки
 * тоже в списке: ему как раз и нужно написать первым.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import DialogChat from '@/components/DialogChat'
import DialogClientCard from '@/components/tech/DialogClientCard'

const PLATFORM_RU: Record<string, string> = {
  telegram: 'Telegram', vk: 'ВК', max: 'MAX', email: 'почта',
}

/**
 * ⚠️⚠️ ОТ ЧЬЕГО ИМЕНИ ПЕРЕПИСКА (владелец, 26.09.2026). Внедренцы путались:
 * думали, что они помощники в боте iVision, а пишут клиентам ПЛЮСОНа из его
 * каналов. Список каналов — из базы (сервисный кабинет), не из кода.
 */
function OurChannels({ channels }: { channels: any[] }) {
  if (!channels.length) return null
  return (
    <div className="border-b border-[#FFCFA4] bg-[#FFCFA4]/30 px-4 py-3 text-xs text-[#25455D]">
      <div className="mb-1 font-semibold">
        Вы отвечаете от имени ПЛЮСОНа, а не iVision
      </div>
      <div className="space-y-0.5">
        {channels.map((c: any) => (
          <div key={c.platform}>
            {PLATFORM_LABEL[c.platform] || c.platform}:{' '}
            {c.url
              ? <a href={c.url} target="_blank" rel="noreferrer" className="font-medium underline">{c.label}</a>
              : <span className="font-medium">{c.label}</span>}
            {c.outgoing_only && <span className="text-[#25455D]/60"> — только отправка, ответы на почту не приходят</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

const PLATFORM_LABEL: Record<string, string> = {
  telegram: 'Telegram-бот', max: 'MAX-бот', vk: 'Сообщество ВК', email: 'Почта',
}

/** Когда было последнее сообщение — коротко. */
function when(iso?: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
}

export default function TechDialogsPage() {
  const [list, setList] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<number | null>(null)
  const [opening, setOpening] = useState(false)
  const [ourChannels, setOurChannels] = useState<any[]>([])

  const load = () =>
    api.tech.dialogs()
      .then((r: any) => setList(r.dialogs || []))
      .catch(() => setList([]))
      .finally(() => setLoading(false))

  useEffect(() => { load() }, [])
  useEffect(() => {
    api.tech.ourChannels().then((r: any) => setOurChannels(r.channels || [])).catch(() => {})
  }, [])

  /** ⚠️ У клиента, который ни разу не писал в бот, контакта нет вовсе
   *  (`contact_id === null`) — заводим его на лету, иначе строка в списке
   *  есть, а открыть и написать нечего. */
  async function openDialog(d: any) {
    if (d.contact_id) { setOpenId(d.contact_id); return }
    if (!d.platform_client_id) return
    setOpening(true)
    try {
      const r: any = await api.tech.startDialog(d.platform_client_id)
      if (r?.contact_id) { setOpenId(r.contact_id); load() }
    } catch (e: any) {
      alert(e?.message || 'Не удалось открыть разговор')
    } finally { setOpening(false) }
  }

  const current = list.find(d => d.contact_id === openId)

  // ⚠️ Куда можно писать: у того, кто ещё не писал, площадок переписки нет —
  // берём каналы самого человека, иначе отправлять будет некуда.
  const available: string[] = current?.where_to_write || []

  return (
    <div className="flex h-screen">
      {/* ── Список слева ──────────────────────────────────────────────── */}
      <div className="w-full max-w-sm shrink-0 overflow-y-auto border-r border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3">
          <h1 className="text-lg font-bold text-gray-900">Диалоги</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            Ваши клиенты. Можно написать первым — выберите человека.
          </p>
        </div>
        <OurChannels channels={ourChannels} />

        {loading ? (
          <div className="p-6 text-center text-sm text-gray-400">Загружаем…</div>
        ) : !list.length ? (
          <div className="p-6 text-center text-sm text-gray-500">
            За вами пока не закреплён ни один клиент.
          </div>
        ) : list.map(d => (
          <button key={d.contact_id ?? `c${d.platform_client_id}`}
                  onClick={() => openDialog(d)}
                  disabled={opening}
                  className={`w-full border-b border-gray-50 px-4 py-3 text-left transition disabled:opacity-60 ${
                    openId === d.contact_id ? 'bg-gray-50' : 'hover:bg-gray-50'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-gray-900">
                {d.name || 'Без имени'}
              </span>
              <span className="shrink-0 text-xs text-gray-400">{when(d.last_at)}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="truncate text-xs text-gray-500">
                {d.last_at ? (
                  <>
                    {d.last_direction === 'out' ? 'Вы: ' : ''}
                    {d.last_text || (d.last_media_kind ? `[${d.last_media_kind}]` : '')}
                  </>
                ) : (
                  <span className="text-gray-400">
                    Ещё не писали
                    {d.where_to_write?.length
                      ? ` · можно: ${d.where_to_write
                          .map((p: string) => PLATFORM_RU[p] || p).join(', ')}`
                      : ''}
                  </span>
                )}
              </span>
              {d.unread > 0 && (
                <span className="ml-auto shrink-0 rounded-full bg-[#FFCFA4] px-1.5 text-[11px] font-bold text-[#0a1520]">
                  {d.unread}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* ── Переписка в середине ──────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden bg-gray-50">
        {!openId ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-400">
            Выберите человека слева — откроется переписка.
          </div>
        ) : (
          <DialogChat
            key={openId}
            contactId={openId}
            contactName={current?.name || 'Клиент'}
            availablePlatforms={available}
            /* ⚠️ Свой набор ручек: клиентские `/dialogs/*` внедренцу закрыты.
               Правки и удаления у него нет — кнопки скроются сами. */
            dialogsApi={{
              messages: (id: number) => api.tech.dialogMessages(id),
              reply: (id: number, body: { platform: string; text: string }) =>
                api.tech.replyDialog(id, body),
            }}
          />
        )}
      </div>

      {/* ── Карточка человека справа ──────────────────────────────────────
          ⚠️ ТОЛЬКО ЧТЕНИЕ: кто это, как ещё с ним связаться, платит ли,
          что настроено. Раньше ради этого приходилось уходить из диалога.
          ⚠️ На узком экране прячем: три колонки туда не помещаются, а
          переписка важнее справки. */}
      {openId && (
        <div className="hidden w-80 shrink-0 overflow-hidden border-l border-gray-200 xl:block">
          <DialogClientCard key={openId} contactId={openId} ourChannels={ourChannels} />
        </div>
      )}
    </div>
  )
}
