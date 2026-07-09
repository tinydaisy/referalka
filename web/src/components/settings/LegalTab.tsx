'use client'

/**
 * Вкладка «Юридические данные и политика» в дашборде клиента.
 *
 * Что внутри:
 * 1. Форма юр-данных (ИП/ООО/физлицо, ФИО/наименование, ИНН, адрес, контакт оператора).
 *    Обязательные поля помечены — без них нельзя опубликовать политику.
 * 2. Большая текстовая область для текста политики обработки персональных данных.
 *    Шаблон-пример выводится подсказкой.
 * 3. Кнопка «Опубликовать политику» — создаёт новую версию.
 *    Заблокирована пока юр-данные не заполнены полностью или текст < 100 символов.
 * 4. Под кнопкой — текущая версия и дата публикации + ссылка на публичную страничку.
 */
import { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

type LegalForm = '' | 'individual' | 'ip' | 'ooo' | 'other'

type LegalData = {
  legal_form: LegalForm
  legal_name: string
  legal_inn: string
  legal_inn_label: string
  legal_ogrn: string
  legal_address: string
  legal_operator_email: string
  legal_operator_phone: string
  privacy_policy_text: string
  privacy_policy_version: number
  privacy_policy_published_at: string | null
  legal_data_complete: boolean
  missing_legal_fields: string[]
}

const FORM_LABELS: Record<LegalForm, string> = {
  '':           '— выбрать —',
  individual:   'Самозанятый',
  ip:           'Индивидуальный предприниматель',
  ooo:          'Юридическое лицо (ООО / АО / другое)',
  other:        'Другая форма',
}

const FIELD_LABELS: Record<string, string> = {
  legal_form: 'Форма',
  legal_name: 'ФИО / Наименование',
  legal_inn: 'ИНН',
  legal_address: 'Адрес',
  legal_operator_email: 'Email оператора',
}

const POLICY_PLACEHOLDER = `Пример текста политики:

1. Общие положения
Настоящая Политика определяет порядок обработки персональных данных,
которые Оператор (см. реквизиты внизу страницы) получает от субъектов
персональных данных (далее — Пользователи) при использовании настоящего
сайта.

2. Какие данные обрабатываются
- Имя
- Email
- Телефон
- Telegram / VK / MAX идентификаторы
- Информация о подписках на мероприятия

3. Цели обработки
- Регистрация на мероприятия
- Информирование о новостях и предложениях (только при согласии)
- Восстановление доступа к личному кабинету

4. Срок хранения и условия отзыва согласия
Данные хранятся до отзыва согласия. Пользователь может в любой момент
отозвать согласие, перейдя по ссылке отписки в письме или направив запрос
на email оператора, указанный внизу страницы.

5. Передача третьим лицам
Данные не передаются третьим лицам, за исключением случаев, прямо
предусмотренных законодательством РФ.

6. Защита данных
Оператор обеспечивает технические и организационные меры защиты
персональных данных от несанкционированного доступа.`

export default function LegalTab() {
  const [data, setData] = useState<LegalData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [clientId, setClientId] = useState<number | null>(null)
  const [editingInnLabel, setEditingInnLabel] = useState(false)

  const auth = (): Record<string, string> => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('plusson_token') : null
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  // Декодируем client_id из JWT для построения публичной ссылки
  useEffect(() => {
    try {
      const token = localStorage.getItem('plusson_token')
      if (token) {
        const payload = JSON.parse(atob(token.split('.')[1]))
        setClientId(parseInt(payload.sub))
      }
    } catch {}
  }, [])

  const load = async () => {
    setError(null)
    try {
      const r = await fetch(`${API_BASE}/api/v1/clients/me/legal-and-policy`, {
        headers: { ...auth() },
      })
      if (!r.ok) throw new Error((await r.json()).detail || 'Ошибка загрузки')
      setData(await r.json())
    } catch (e: any) {
      setError(e.message)
    }
  }

  useEffect(() => { load() }, [])

  const set = (k: keyof LegalData) => (e: any) => {
    if (!data) return
    setData({ ...data, [k]: e.target.value })
  }

  const save = async () => {
    if (!data) return
    setSaving(true); setError(null)
    try {
      const r = await fetch(`${API_BASE}/api/v1/clients/me/legal-and-policy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...auth() },
        body: JSON.stringify({
          legal_form: data.legal_form || null,
          legal_name: data.legal_name || null,
          legal_inn: data.legal_inn || null,
          legal_inn_label: data.legal_inn_label || null,
          legal_ogrn: data.legal_ogrn || null,
          legal_address: data.legal_address || null,
          legal_operator_email: data.legal_operator_email || null,
          legal_operator_phone: data.legal_operator_phone || null,
          privacy_policy_text: data.privacy_policy_text || null,
        }),
      })
      if (!r.ok) throw new Error((await r.json()).detail || 'Ошибка сохранения')
      setData(await r.json())
      setSavedAt(Date.now())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const publish = async () => {
    if (!data) return
    if (!confirm('Опубликовать новую версию политики? Существующие согласия пользователей останутся связаны со старой версией.')) return
    setPublishing(true); setError(null)
    try {
      // 1) Сначала сохраняем текущий текст и юр-данные (черновик).
      //    Без этого publish использует старый текст из БД.
      const saveResp = await fetch(`${API_BASE}/api/v1/clients/me/legal-and-policy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...auth() },
        body: JSON.stringify({
          legal_form: data.legal_form || null,
          legal_name: data.legal_name || null,
          legal_inn: data.legal_inn || null,
          legal_inn_label: data.legal_inn_label || null,
          legal_ogrn: data.legal_ogrn || null,
          legal_address: data.legal_address || null,
          legal_operator_email: data.legal_operator_email || null,
          legal_operator_phone: data.legal_operator_phone || null,
          privacy_policy_text: data.privacy_policy_text || null,
        }),
      })
      if (!saveResp.ok) throw new Error((await saveResp.json()).detail || 'Не удалось сохранить перед публикацией')

      // 2) Публикуем актуальный текст
      const r = await fetch(`${API_BASE}/api/v1/clients/me/policy/publish`, {
        method: 'POST',
        headers: { ...auth() },
      })
      if (!r.ok) throw new Error((await r.json()).detail || 'Не удалось опубликовать')
      const res = await r.json()
      alert(`Политика опубликована, версия ${res.version}`)
      load()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setPublishing(false)
    }
  }

  if (!data) {
    return <div className="text-sm text-gray-500">Загрузка...</div>
  }

  const publicUrl = clientId ? `${typeof window !== 'undefined' ? window.location.origin : ''}/c/${clientId}/privacy` : ''

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm">
          {error}
        </div>
      )}

      {/* Юр-данные */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <h3 className="font-semibold text-gray-800 mb-1">Юридические данные оператора персональных данных</h3>
        <p className="text-xs text-gray-500 mb-5">
          По 152-ФЗ обязательно для публикации политики. Эти данные показываются внизу публичной странички политики.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Форма *</label>
            <select value={data.legal_form} onChange={set('legal_form')}
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm">
              {(Object.keys(FORM_LABELS) as LegalForm[]).map(f => (
                <option key={f} value={f}>{FORM_LABELS[f]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">ФИО / Наименование *</label>
            <input type="text" value={data.legal_name || ''} onChange={set('legal_name')}
              placeholder="ИП Иванов Иван Иванович"
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
          </div>
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              {editingInnLabel ? (
                <input
                  type="text"
                  autoFocus
                  value={data.legal_inn_label || ''}
                  onChange={set('legal_inn_label')}
                  onBlur={() => setEditingInnLabel(false)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setEditingInnLabel(false) }}
                  placeholder="ИНН"
                  className="px-2 py-1 border border-brand/40 rounded-lg text-sm font-medium w-32 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              ) : (
                <label className="text-sm font-medium text-gray-700">
                  {(data.legal_inn_label || '').trim() || 'ИНН'} *
                </label>
              )}
              <span className="text-[11px] text-gray-400">
                из другой страны? переименуйте
              </span>
              <button
                type="button"
                onClick={() => setEditingInnLabel(v => !v)}
                title="Переименовать поле (напр. УНП для Беларуси)"
                className="text-gray-400 hover:text-brand transition-colors">
                <Pencil size={13} />
              </button>
            </div>
            <input type="text" value={data.legal_inn || ''} onChange={set('legal_inn')}
              placeholder="цифры или буквы (напр. УНП РБ)"
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">ОГРН / ОГРНИП</label>
            <input type="text" value={data.legal_ogrn || ''} onChange={set('legal_ogrn')}
              placeholder="опционально"
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Адрес *</label>
            <input type="text" value={data.legal_address || ''} onChange={set('legal_address')}
              placeholder="г. Москва, ул. ..."
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email оператора *</label>
            <input type="email" value={data.legal_operator_email || ''} onChange={set('legal_operator_email')}
              placeholder="privacy@your-domain.ru"
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Телефон оператора</label>
            <input type="text" value={data.legal_operator_phone || ''} onChange={set('legal_operator_phone')}
              placeholder="опционально"
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
          </div>
        </div>
        {data.missing_legal_fields.length > 0 && (
          <div className="mt-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
            ⚠️ Не заполнены обязательные поля: {data.missing_legal_fields.map(f => f === 'legal_inn' ? ((data.legal_inn_label || '').trim() || 'ИНН') : (FIELD_LABELS[f] || f)).join(', ')}
          </div>
        )}
      </div>

      {/* Текст политики */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <h3 className="font-semibold text-gray-800 mb-1">Текст политики обработки персональных данных</h3>
        <p className="text-xs text-gray-500 mb-4">
          Минимум 100 символов. После «Опубликовать» текст становится публично доступным по адресу:{' '}
          {publicUrl && (
            <a href={publicUrl} target="_blank" rel="noreferrer" className="text-brand underline">{publicUrl}</a>
          )}
        </p>
        <textarea value={data.privacy_policy_text || ''} onChange={set('privacy_policy_text')}
          rows={20} placeholder={POLICY_PLACEHOLDER}
          className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono" />
        <div className="mt-3 text-xs text-gray-500">
          Длина: {(data.privacy_policy_text || '').length} симв.
          {data.privacy_policy_version > 0 && data.privacy_policy_published_at && (
            <> · Опубликовано: версия {data.privacy_policy_version} от {new Date(data.privacy_policy_published_at).toLocaleString('ru-RU')}</>
          )}
        </div>
      </div>

      <div className="flex gap-3">
        <button onClick={save} disabled={saving}
          className="px-6 py-3 bg-brand text-white rounded-xl text-sm font-medium disabled:opacity-50">
          {saving ? 'Сохранение...' : 'Сохранить черновик'}
        </button>
        <button onClick={publish}
          disabled={publishing || !data.legal_data_complete || (data.privacy_policy_text || '').length < 100}
          title={!data.legal_data_complete ? 'Заполните юр-данные' : (data.privacy_policy_text || '').length < 100 ? 'Текст < 100 символов' : ''}
          className="px-6 py-3 bg-peach text-darkblue rounded-xl text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed">
          {publishing ? 'Публикую...' : 'Опубликовать политику'}
        </button>
        {savedAt && Date.now() - savedAt < 3000 && (
          <span className="text-sm text-green-600 self-center">✓ Сохранено</span>
        )}
      </div>
    </div>
  )
}
