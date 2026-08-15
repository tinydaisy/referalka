'use client'
import { useEffect, useState } from 'react'
import { Percent, AlertCircle, Check } from 'lucide-react'
import { api } from '@/lib/api'

export default function AdminReferralSettingsPage() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')

  const [percent, setPercent] = useState('10')
  // Закрытый чат Коллабораторной (миграция 264) — отдельная сущность, но
  // держим на этой же странице: заводить ради одного поля свой экран незачем.
  const [chatUrl, setChatUrl] = useState('')       // Telegram
  const [chatUrlMax, setChatUrlMax] = useState('') // MAX (миграция 266)
  const [chatSaving, setChatSaving] = useState(false)
  const [chatSaved, setChatSaved] = useState(false)
  const [signupUntil, setSignupUntil] = useState('')
  const [accrualUntil, setAccrualUntil] = useState('')
  // Сколько дней триала добавляет реф-ссылка поверх базы тарифа (миграция 306).
  const [trialBonus, setTrialBonus] = useState('23')

  function load() {
    setLoading(true)
    api.adminReferralSettings.get()
      .then((r: any) => {
        setData(r)
        setPercent(String(r.percent))
        setSignupUntil(r.signup_until || '')
        setAccrualUntil(r.accrual_until || '')
        setTrialBonus(String(r.trial_bonus_days ?? 23))
        setLoading(false)
      })
      .catch((e: any) => { setErr(e?.message || 'Не удалось загрузить'); setLoading(false) })
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    api.adminCollabHubSettings.get()
      .then((r: any) => { setChatUrl(r?.chat_url || ''); setChatUrlMax(r?.chat_url_max || '') })
      .catch(() => {})
  }, [])

  async function saveChat() {
    setChatSaving(true); setChatSaved(false); setErr('')
    try {
      await api.adminCollabHubSettings.update({
        chat_url: chatUrl.trim(),
        chat_url_max: chatUrlMax.trim(),
      })
      setChatSaved(true)
      setTimeout(() => setChatSaved(false), 2500)
    } catch (e: any) {
      setErr(e?.message || 'Не удалось сохранить ссылку на чат')
    } finally { setChatSaving(false) }
  }

  async function save() {
    setSaving(true); setErr(''); setSaved(false)
    try {
      const r: any = await api.adminReferralSettings.update({
        percent: Number(percent),
        signup_until: signupUntil,
        accrual_until: accrualUntil,
        trial_bonus_days: Number(trialBonus),
      })
      setData(r)
      setTrialBonus(String(r.trial_bonus_days ?? trialBonus))
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e: any) {
      setErr(e?.message || 'Не удалось сохранить')
    }
    setSaving(false)
  }

  if (loading) return <div className="text-gray-500">Загрузка…</div>

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2 mb-2">
        <Percent size={22} /> Реферальная программа
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Ставка кэшбэка с оплат приведённых людей и то, насколько длиннее триал
        у тех, кто пришёл по реф-ссылке.
      </p>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 flex gap-3">
        <AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
        <div className="text-sm text-amber-900">
          <b>Изменения действуют только на будущих приведённых.</b> У тех, кто уже
          зарегистрировался, ставка и срок начислений заморожены на момент их
          регистрации — понизив процент сейчас, вы не тронете старые обещания.
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Процент бонусов
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number" min={0} max={100} value={percent}
              onChange={e => setPercent(e.target.value)}
              className="w-28 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#FFCFA4] focus:border-transparent"
            />
            <span className="text-gray-500">% с каждой оплаты приведённого</span>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Бонус к триалу за реф-ссылку
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number" min={0} max={365} value={trialBonus}
              onChange={e => setTrialBonus(e.target.value)}
              className="w-28 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#FFCFA4] focus:border-transparent"
            />
            <span className="text-gray-500">дней сверх базового триала</span>
          </div>
          <p className="text-xs text-gray-500 mt-1.5">
            Пришёл сам, без ссылки — <b>{data?.trial_base_days ?? 7} дней</b>.
            Пришёл по реф-ссылке — <b>{(data?.trial_base_days ?? 7) + (Number(trialBonus) || 0)} дней</b>.
            Базовый срок меняется в тарифе «Триал Профи», здесь — только надбавка.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Набор по этой ставке — до
          </label>
          <input
            type="date" value={signupUntil}
            onChange={e => setSignupUntil(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#FFCFA4] focus:border-transparent"
          />
          <p className="text-xs text-gray-500 mt-1.5">
            Кто зарегистрируется по эту дату включительно — получит текущий процент.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Начисления идут — до
          </label>
          <input
            type="date" value={accrualUntil}
            onChange={e => setAccrualUntil(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#FFCFA4] focus:border-transparent"
          />
          <p className="text-xs text-gray-500 mt-1.5">
            После этой даты бонусы с приведённых по текущей ставке начисляться перестанут.
          </p>
        </div>

        {err && <div className="text-sm text-red-600">{err}</div>}

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={save} disabled={saving}
            className="px-5 py-2.5 rounded-lg bg-[#25455D] text-white text-sm font-medium hover:bg-[#1c3547] disabled:opacity-60"
          >
            {saving ? 'Сохраняю…' : 'Сохранить'}
          </button>
          {saved && (
            <span className="text-sm text-green-700 flex items-center gap-1.5">
              <Check size={16} /> Сохранено
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mt-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{data?.referred_total ?? 0}</div>
          <div className="text-xs text-gray-500 mt-1">Всего приведённых</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="text-2xl font-bold text-green-700">{data?.referred_active ?? 0}</div>
          <div className="text-xs text-gray-500 mt-1">Начисления активны</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-400">{data?.referred_expired ?? 0}</div>
          <div className="text-xs text-gray-500 mt-1">Срок вышел</div>
        </div>
      </div>

      {/* Закрытый чат Коллабораторной */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mt-6">
        <h2 className="font-semibold text-gray-900">Закрытый чат Коллабораторной</h2>
        <p className="text-sm text-gray-500 mt-1">
          Ссылки-приглашения. Пункт «Закрытый чат» в разделе Коллабораторная
          открывает страницу с кнопками на заполненные площадки. Пусты обе —
          пункта в меню нет.
        </p>
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 w-20 shrink-0">Telegram</span>
            <input
              value={chatUrl}
              onChange={e => setChatUrl(e.target.value)}
              placeholder="https://t.me/+..."
              className="flex-1 min-w-[240px] px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 w-20 shrink-0">MAX</span>
            <input
              value={chatUrlMax}
              onChange={e => setChatUrlMax(e.target.value)}
              placeholder="https://max.ru/join/..."
              className="flex-1 min-w-[240px] px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <button
            onClick={saveChat}
            disabled={chatSaving}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
            style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}
          >
            {chatSaving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          {chatSaved && (
            <span className="inline-flex items-center gap-1 text-sm text-green-700">
              <Check size={15} /> Сохранено
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
