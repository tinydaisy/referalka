'use client'

/**
 * Подвкладка «Приветствие → На почту».
 *
 * Что внутри:
 * - Переключатель «Включить приветственное письмо»
 * - Поле Subject (только для email)
 * - Текст письма с поддержкой плейсхолдеров
 *
 * Письмо отправляется при первой регистрации участника во все доступные
 * каналы — email, Telegram, VK, MAX. Дедуп через welcome_email_sent_at.
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { type RichTextEditorHandle } from '@/components/RichTextEditor'

interface Props {
  event: any
  eventId: number
  onReload: () => void
}

export default function WelcomeEmailTab({ event, eventId, onReload }: Props) {
  const [enabled, setEnabled] = useState<boolean>(event.welcome_enabled || false)
  const [subject, setSubject] = useState<string>(event.welcome_email_subject || '')
  const [body, setBody] = useState<string>(event.welcome_text || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editorRef = useRef<RichTextEditorHandle>(null)

  useEffect(() => {
    setEnabled(event.welcome_enabled || false)
    setSubject(event.welcome_email_subject || '')
    setBody(event.welcome_text || '')
  }, [event])

  async function save() {
    setSaving(true); setError(null); setSaved(false)
    try {
      try { (document.activeElement as HTMLElement)?.blur?.() } catch {}
      await new Promise(r => setTimeout(r, 50))

      const refValue = editorRef.current?.getValue() ?? ''
      const liveBody = refValue || body
      setBody(liveBody)

      const plain = (liveBody || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
      if (enabled && !plain) {
        setError('Заполните «Текст приветствия» — без него письмо не уйдёт. То, что вы видите серым курсивом — это подсказка-пример, не реальный текст.')
        setSaving(false)
        return
      }

      const payload = {
        welcome_enabled: enabled,
        welcome_email_subject: subject || null,
        welcome_text: liveBody || null,
      }
      await api.events.update(eventId, payload)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
      onReload()
    } catch (e: any) {
      setError(e?.message || 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  const placeholders = [
    { code: '{name}',              hint: 'Имя участника' },
    { code: '{event_title}',       hint: 'Название события' },
    { code: '{event_date}',        hint: 'Дата старта (МСК)' },
    { code: '{event_landing_url}', hint: 'Веб-лендинг события' },
    { code: '{tg_url}',            hint: 'Ссылка в TG Mini App' },
    { code: '{vk_url}',            hint: 'Ссылка в VK (если есть)' },
  ]

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-gray-700 leading-relaxed">
        <b>Что это:</b> при первой регистрации на событие участнику автоматически
        отправляется приветственное письмо <b>на email</b> — если email у него указан.
        Один раз, повторов нет. В Telegram, VK и MAX это приветствие не уходит.
      </div>

      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
          className="mt-1 w-5 h-5 rounded border-gray-300" />
        <div>
          <div className="font-medium text-gray-900">Отправлять приветственное письмо</div>
          <div className="text-sm text-gray-500">
            Если выключено — никаких приветственных сообщений после регистрации не идёт.
          </div>
        </div>
      </label>

      {!enabled && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
          Приветствие выключено — никто не получит письмо при регистрации.
          Текст и тема ниже <b>не удалены</b>, они сохранятся в БД. Включите галочку,
          чтобы рассылка возобновилась.
        </div>
      )}

      <div className={enabled ? '' : 'opacity-60'}>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Тема письма (только для email)
          </label>
          <input type="text" value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="Добро пожаловать на «Название события» 🎉"
            className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
          <div className="text-xs text-gray-500 mt-1">
            В TG/VK/MAX заголовок становится первой строкой жирным. В email — темой письма.
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Текст приветствия
          </label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Привет, {name}! Спасибо за регистрацию на «{event_title}». Доступ к программе и материалам — по ссылке: {tg_url}"
            rows={12}
            className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm leading-relaxed font-sans"
            style={{ resize: 'vertical', minHeight: '240px' }}
          />
          <div className="text-xs text-gray-500 mt-1">
            Длина: {(body || '').trim().length} символов. Поддерживаются ссылки https://...
          </div>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <div className="text-sm font-semibold text-gray-700 mb-2">Плейсхолдеры</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {placeholders.map(p => (
              <div key={p.code} className="flex items-baseline gap-2">
                <code className="px-1.5 py-0.5 bg-white border border-gray-200 rounded text-gray-800">
                  {p.code}
                </code>
                <span className="text-gray-500">— {p.hint}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 text-sm">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving}
          className="px-6 py-3 bg-brand text-white rounded-xl text-sm font-medium disabled:opacity-50">
          {saving ? 'Сохранение...' : 'Сохранить'}
        </button>
        {saved && <span className="text-sm text-green-600">✓ Сохранено</span>}
      </div>
    </div>
  )
}
