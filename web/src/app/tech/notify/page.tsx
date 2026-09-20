'use client'

/**
 * Уведомления внедренцу: личка в боте + отдельная группа.
 *
 * ⚠️⚠️ ШЛЁМ В ОБА МЕСТА СРАЗУ, а не «или-или» (владелец, 19.09.2026). У лички
 * свойство «увижу быстро», у группы — «не потеряется и видят коллеги».
 *
 * ⚠️ Личка привязывается ССЫЛКОЙ, а не вводом id: подпись в ссылке не даёт
 * подставить чужой id и увести себе чужие уведомления. Поэтому поля для ввода
 * личного id здесь нет вовсе.
 */
import { useEffect, useState } from 'react'
import { Check, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

const KIND_LABEL: Record<string, string> = {
  question: 'Вопрос от клиента',
  lead: 'Новый лид — зашёл в бота',
  trial: 'Новый триал',
  payment: 'Новая оплата',
  expiring: 'Подписка истекает через 3 дня',
  expired: 'Подписка истекла',
}

export default function TechNotifyPage() {
  const [d, setD] = useState<any>(null)
  const [chatId, setChatId] = useState('')
  const [kinds, setKinds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    const r: any = await api.tech.notifySettings()
    setD(r)
    setChatId(r.chat_id || '')
    setKinds(r.kinds || [])
  }

  useEffect(() => { load().catch(() => {}) }, [])

  async function save() {
    setBusy(true)
    setError('')
    try {
      await api.tech.saveNotifySettings({
        notify_chat_id: chatId.trim() || null,
        notify_kinds: kinds,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
      await load()
    } catch (e: any) {
      setError(e?.message || 'Не удалось сохранить')
    } finally {
      setBusy(false)
    }
  }

  if (!d) return <div className="p-4 text-sm text-gray-400 md:p-8">Загружаем…</div>

  return (
    <div className="p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">Уведомления</h1>
      <p className="mb-5 max-w-2xl text-sm text-gray-500">
        События по вашим клиентам приходят в двух местах сразу: вам в личку и
        в рабочую группу — чтобы точно не пропустить.
      </p>

      {/* ── Личка ─────────────────────────────────────────────────────── */}
      <div className="mb-4 rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-gray-800">
            Личные сообщения в боте
          </span>
          {d.linked && (
            <span className="inline-flex items-center gap-1 rounded bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
              <Check size={12} /> подключено
            </span>
          )}
        </div>

        {d.linked ? (
          <p className="text-sm text-gray-500">
            Уведомления приходят вам в @pluson_bot. На вопрос клиента можно
            ответить прямо оттуда — <b>ответьте на уведомление реплаем</b>, и
            текст уйдёт человеку на его площадку.
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm text-gray-500">
              Нажмите кнопку — откроется бот, и связь установится сама.
              Вводить ничего не нужно.
            </p>
            <a href={d.link_url} target="_blank" rel="noreferrer"
               className="btn-gold inline-flex items-center gap-2">
              Подключить личные уведомления <ExternalLink size={15} />
            </a>
          </>
        )}
      </div>

      {/* ── Группа ────────────────────────────────────────────────────── */}
      <div className="mb-4 rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-1 text-sm font-semibold text-gray-800">
          Рабочая группа
        </div>
        <p className="mb-3 text-sm text-gray-500">
          Создайте группу в Telegram, добавьте туда <b>@pluson_bot</b> и
          отправьте в ней команду <code className="rounded bg-gray-100 px-1">/getmyid</code> —
          бот пришлёт ID. Вставьте его сюда.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input value={chatId} onChange={e => setChatId(e.target.value)}
                 placeholder="-1001234567890"
                 className="w-56 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" />
          {chatId && (
            <button onClick={() => setChatId('')}
                    className="text-xs text-gray-500 underline">убрать</button>
          )}
        </div>
      </div>

      {/* ── Что слать ─────────────────────────────────────────────────── */}
      <div className="mb-4 rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-3 text-sm font-semibold text-gray-800">
          Что присылать
        </div>
        <div className="space-y-2.5">
          {(d.all_kinds || []).map((k: any) => (
            <label key={k.id} className="flex cursor-pointer items-start gap-2.5">
              <input type="checkbox" checked={kinds.includes(k.id)}
                     onChange={e => setKinds(e.target.checked
                       ? [...kinds, k.id]
                       : kinds.filter(x => x !== k.id))}
                     className="mt-1 shrink-0" />
              <span className="text-sm text-gray-700">
                {KIND_LABEL[k.id] || k.id}
                {/* Тег — часть сообщения: по нему ищут в телефоне. */}
                <span className="ml-1.5 font-mono text-[11px] text-gray-400">
                  {k.tag}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy} className="btn-gold">
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
        {saved && <span className="text-sm text-green-700">Сохранено</span>}
      </div>
    </div>
  )
}
