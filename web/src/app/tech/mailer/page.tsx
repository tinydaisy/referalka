'use client'

/**
 * Авторассыльщик — доступ внедренца в mailer.pluson.ru (миграция 517).
 *
 * ⚠️ Аккаунт выдаёт владелец кнопкой в админке, сам внедренец его не заводит.
 * Нет аккаунта — кнопка «Запросить доступ» открывает личку владельца в
 * Telegram с готовым текстом (ник задаётся в настройках раздела техспецов).
 */
import { useEffect, useState } from 'react'
import { Eye, EyeOff, Copy, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

function CopyRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [show, setShow] = useState(!secret)
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div className="mb-1 text-xs text-gray-500">{label}</div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-sm">
          {show ? value : '••••••••••'}
        </div>
        {secret && (
          <button onClick={() => setShow(!show)} title={show ? 'Скрыть' : 'Показать'}
                  className="rounded-lg border border-gray-200 p-2 text-gray-500 hover:bg-gray-50">
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
        <button onClick={() => {
                  navigator.clipboard?.writeText(value)
                  setCopied(true); setTimeout(() => setCopied(false), 1500)
                }}
                title="Скопировать"
                className="rounded-lg border border-gray-200 p-2 text-gray-500 hover:bg-gray-50">
          {copied ? <span className="px-0.5 text-xs text-green-700">✓</span> : <Copy size={16} />}
        </button>
      </div>
    </div>
  )
}

export default function TechMailerPage() {
  const [d, setD] = useState<any>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.tech.mailer().then(setD).catch((e: any) => setError(e?.message || 'Не удалось загрузить'))
  }, [])

  if (!d) return <div className="p-4 text-sm text-gray-400 md:p-8">{error || 'Загружаем…'}</div>

  return (
    <div className="p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">Авторассыльщик</h1>
      <p className="mb-5 max-w-2xl text-sm text-gray-500">
        Сервис рассылок для ваших клиентов. Входите в него по данным ниже.
      </p>

      <div className="max-w-xl space-y-4 rounded-xl bg-white p-5 shadow-sm">
        {d.has_account ? (
          <>
            <CopyRow label="Почта (логин)" value={d.email} />
            {d.password ? (
              <>
                <CopyRow label="Пароль" value={d.password} secret />
                <div className="text-xs text-gray-400">
                  Это пароль, выданный при создании аккаунта. Если вы поменяли его
                  в самом Авторассыльщике — здесь останется старый.
                </div>
              </>
            ) : (
              <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                Аккаунт на эту почту уже был создан раньше — входите своим паролем.
                Забыли его — восстановите на странице входа.
              </div>
            )}
            <a href={d.login_url} target="_blank" rel="noreferrer"
               className="btn-gold inline-flex items-center gap-2 px-5 py-2 text-sm">
              Открыть Авторассыльщик <ExternalLink size={15} />
            </a>
          </>
        ) : (
          <>
            <div className="text-sm text-gray-700">
              {d.blocked
                ? 'Доступ в Авторассыльщик закрыт.'
                : 'У вас пока нет доступа в Авторассыльщик.'}
            </div>
            {!d.blocked && (d.request_url ? (
              <a href={d.request_url} target="_blank" rel="noreferrer"
                 className="btn-gold inline-flex items-center gap-2 px-5 py-2 text-sm">
                Запросить доступ <ExternalLink size={15} />
              </a>
            ) : (
              <div className="text-sm text-gray-500">Напишите руководителю, чтобы выдали доступ.</div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
