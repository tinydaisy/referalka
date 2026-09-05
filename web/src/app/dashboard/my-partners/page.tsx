'use client'

/**
 * Раздел «Моя партнёрка» — свои партнёры клиента (миграции 346–348).
 *
 * ⚠️ Не путать с «Партнёрка ПЛЮСОНа» (/dashboard/partner-program): там клиент
 * сам партнёр платформы и получает кэшбэк. Здесь наоборот — у него свои
 * партнёры, и деньги им платит ОН САМ (решение № 1). Платформа считает
 * вознаграждение и показывает, кому сколько.
 *
 * Три подраздела (№ 41): Настройки, Партнёры, Продажи.
 *
 * ⚠️ Гейт стоит и на пункте меню, и ЗДЕСЬ: страница открывается по прямой
 * ссылке, замка в сайдбаре недостаточно.
 */

import { Suspense, useEffect, useState } from 'react'
import { Handshake, Loader2, Check, Users, Wallet, Settings2, Info } from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import FeatureLock from '@/components/FeatureLock'
import { useUrlTab } from '@/hooks/useUrlTab'

type Tab = 'settings' | 'partners' | 'sales'

const money = (v: any) =>
  (Number(v) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽'

const dt = (v: any) =>
  v ? new Date(v).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—'

// ⚠️ Страница без динамического сегмента + useUrlTab (внутри useSearchParams)
// ОБЯЗАНА быть в Suspense, иначе падает вся сборка проекта.
export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Загрузка…</div>}>
      <MyPartnersPage />
    </Suspense>
  )
}

function MyPartnersPage() {
  const { me } = useMe()
  const [tab, setTab] = useUrlTab<Tab>('tab', 'settings',
    ['settings', 'partners', 'sales'] as const)
  const hasFeature = (me?.features || []).includes('partner_program')

  return (
    <div className="p-4 md:p-6 max-w-6xl">
      <div className="flex items-center gap-3 mb-1">
        <Handshake className="text-[#25455D]" size={24} />
        <h1 className="text-2xl font-bold text-[#25455D]">Моя партнёрка</h1>
      </div>
      <p className="text-slate-500 text-sm mb-5">
        Ваши партнёры рекомендуют ваши события и продукты и получают вознаграждение.
        Платформа считает, кому сколько; выплаты вы делаете сами.
      </p>

      {!hasFeature ? (
        <FeatureLock anyOf={['partner_program']} />
      ) : (
        <>
          <div className="flex gap-1 border-b border-slate-200 mb-5 overflow-x-auto">
            {([
              ['settings', 'Настройки', Settings2],
              ['partners', 'Партнёры', Users],
              ['sales', 'Продажи', Wallet],
            ] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  tab === key
                    ? 'border-[#25455D] text-[#25455D]'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>

          {tab === 'settings' && <SettingsTab />}
          {tab === 'partners' && <PartnersTab />}
          {tab === 'sales' && <SalesTab />}
        </>
      )}
    </div>
  )
}

/* ─── Настройки ─────────────────────────────────────────────────────────── */

function SettingsTab() {
  const [data, setData] = useState<any>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.partnerProgram.settings().then(setData).catch(() => setData({}))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await api.partnerProgram.saveSettings({
        partner_default_reward_kind: data.partner_default_reward_kind || null,
        partner_default_reward_value: data.partner_default_reward_value
          ? Number(data.partner_default_reward_value) : null,
        // ⚠️ Ограничиваем здесь же: у колонки CHECK 1..10, и без обрезки
        // ввод «50» возвращался ошибкой базы без объяснения.
        partner_levels: Math.min(10, Math.max(1, Number(data.partner_levels) || 1)),
        partner_level_decay: data.partner_level_decay
          ? Number(data.partner_level_decay) : null,
        partner_payout_mode: data.partner_payout_mode || 'passive',
        tab_label_partner: data.tab_label_partner || null,
      })
      alert('Сохранено')
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally { setSaving(false) }
  }

  if (!data) return <Loading />

  const set = (k: string, v: any) => setData({ ...data, [k]: v })
  const isPassive = (data.partner_payout_mode || 'passive') === 'passive'

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Режим выплат — главная настройка, от неё зависит вся механика */}
      <Card title="Кому платить вознаграждение">
        <div className="space-y-2">
          <Radio
            checked={isPassive}
            onChange={() => set('partner_payout_mode', 'passive')}
            title="Закреплённому партнёру — со всех покупок человека"
            hint="Партнёр привёл человека один раз и получает со всех его будущих покупок. Так проще набирать партнёров: доход растёт сам."
          />
          <Radio
            checked={!isPassive}
            onChange={() => set('partner_payout_mode', 'active')}
            title="Тому, кто привёл на эту покупку"
            hint="Платим за конкретную рекомендацию. За самостоятельную повторную покупку не платит никто — человека на неё никто не приводил."
          />
        </div>
        <Note>
          Режим один на весь кабинет: партнёр должен понимать правила целиком,
          а не гадать, по какому принципу считается каждая покупка.
        </Note>
      </Card>

      <Card title="Вознаграждение по умолчанию">
        <div className="flex gap-2 items-start flex-wrap">
          <select
            value={data.partner_default_reward_kind || ''}
            onChange={e => set('partner_default_reward_kind', e.target.value || null)}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
            style={{ flex: '0 0 9rem' }}
          >
            <option value="">Не задано</option>
            <option value="percent">Процент</option>
            <option value="fixed">Рублей</option>
          </select>
          <input
            type="number"
            min={0}
            step="0.01"
            value={data.partner_default_reward_value ?? ''}
            onChange={e => set('partner_default_reward_value', e.target.value)}
            placeholder={data.partner_default_reward_kind === 'fixed' ? '3000' : '10'}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
            style={{ flex: '1 1 auto', minWidth: 0 }}
          />
        </div>
        <Note>
          Действует на все тарифы. У отдельного тарифа можно задать своё — оно
          главнее. Процент удобен, когда цена меняется; рубли — когда у тарифа
          большие расходы и отдаёте ровно оговорённую сумму.
        </Note>
      </Card>

      {/* ⚠️ Уровни существуют ТОЛЬКО в первом режиме. Во втором на покупке
          записан один человек — вверх идти не из чего, и настройка была бы
          обманом: клиент задал бы «3 уровня», а работал бы один.
          Раньше блок показывался всегда с предупреждением — прячем целиком. */}
      {isPassive && (
      <Card title="Уровни">
        <div className="flex gap-2 items-start flex-wrap">
          <label className="text-sm text-slate-600" style={{ flex: '1 1 12rem' }}>
            Сколько уровней
            <input
              type="number" min={1} max={10}
              value={data.partner_levels ?? 1}
              onChange={e => set('partner_levels', e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm text-slate-600" style={{ flex: '1 1 12rem' }}>
            Следующий уровень меньше в … раз
            <input
              type="number" min={1} step="0.5"
              value={data.partner_level_decay ?? ''}
              onChange={e => set('partner_level_decay', e.target.value)}
              placeholder="4"
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
        </div>
        <Note>
          Второй уровень получает тот, кто привёл самого партнёра. Оставьте
          «во сколько раз» пустым — и уровень будет один.
        </Note>
      </Card>
      )}

      <Card title="Название вкладки в приложении">
        <input
          value={data.tab_label_partner ?? ''}
          onChange={e => set('tab_label_partner', e.target.value)}
          placeholder="Партнёру"
          maxLength={20}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
        />
      </Card>

      <button onClick={save} disabled={saving} className="btn-gold">
        {saving ? 'Сохраняем…' : 'Сохранить'}
      </button>
    </div>
  )
}

/* ─── Партнёры ──────────────────────────────────────────────────────────── */

function PartnersTab() {
  const [items, setItems] = useState<any[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  const load = () =>
    api.partnerProgram.partners()
      .then(r => setItems(r.partners || []))
      .catch(() => setItems([]))

  useEffect(() => { load() }, [])

  const payout = async (p: any) => {
    if (!confirm(
      `Отметить выплату партнёру ${p.name || ''} на сумму ${money(p.due)}?\n\n` +
      `Закроются все начисления, накопленные на этот момент. Продажи, которые ` +
      `придут позже, останутся неоплаченными.`
    )) return
    setBusy(p.id)
    try {
      const r = await api.partnerProgram.payout(p.id)
      if (r.empty) alert('Нечего выплачивать')
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось отметить выплату')
    } finally { setBusy(null) }
  }

  if (!items) return <Loading />
  if (!items.length) return <Empty text="Партнёров пока нет." />

  return (
    <div className="space-y-3">
      {items.map(p => (
        <div key={p.id} className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex flex-wrap gap-4 justify-between items-start">
            <div className="min-w-0">
              <div className="font-semibold text-[#25455D]">
                {p.name || 'Без имени'}
                {!p.is_active && (
                  <span className="ml-2 text-xs text-slate-400">отключён</span>
                )}
              </div>
              <div className="text-xs text-slate-500 mt-0.5 break-all">
                {[p.email, p.phone].filter(Boolean).join(' · ') || '—'}
              </div>
              <div className="text-xs text-slate-400 mt-1">
                С нами с {dt(p.accepted_at)} · приведено: {p.people}
                {p.payout_mode && ` · личный режим: ${
                  p.payout_mode === 'passive' ? 'закреплённому' : 'за рекомендацию'}`}
              </div>
            </div>

            <div className="flex gap-5 items-start">
              {/* ⚠️ Две суммы — РАЗНЫЕ вещи, подписаны явно (№ 41). */}
              <Sum label="Принёс" value={p.turnover} hint="оборот покупок" />
              <Sum label="К выплате" value={p.due} accent hint="ещё не выплачено" />
              <button
                onClick={() => payout(p)}
                disabled={busy === p.id || !Number(p.due)}
                className="btn-primary text-sm disabled:opacity-40"
              >
                {busy === p.id ? '…' : <><Check size={14} className="inline mr-1" />Выплачено</>}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ─── Продажи ───────────────────────────────────────────────────────────── */

function SalesTab() {
  const [items, setItems] = useState<any[] | null>(null)

  useEffect(() => {
    api.partnerProgram.sales()
      .then(r => setItems(r.sales || []))
      .catch(() => setItems([]))
  }, [])

  if (!items) return <Loading />
  if (!items.length) return <Empty text="Продаж пока нет." />

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[720px]">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="py-2 pr-3">Дата</th>
            <th className="py-2 pr-3">Что купили</th>
            <th className="py-2 pr-3">Покупатель</th>
            <th className="py-2 pr-3">Партнёр</th>
            <th className="py-2 pr-3 text-right">Сумма</th>
            <th className="py-2 pr-3 text-right">Начислено</th>
            <th className="py-2">Выплата</th>
          </tr>
        </thead>
        <tbody>
          {items.map(s => (
            <tr key={s.id} className="border-b border-slate-100">
              <td className="py-2 pr-3 whitespace-nowrap text-slate-500">{dt(s.created_at)}</td>
              <td className="py-2 pr-3">
                {s.source_title || '—'}
                {s.level > 1 && (
                  <span className="ml-1 text-xs text-slate-400">{s.level}-й уровень</span>
                )}
              </td>
              <td className="py-2 pr-3">{s.buyer_name || '—'}</td>
              <td className="py-2 pr-3">{s.partner_name || '—'}</td>
              <td className="py-2 pr-3 text-right whitespace-nowrap">{money(s.base_amount)}</td>
              <td className="py-2 pr-3 text-right whitespace-nowrap font-medium">
                {money(s.amount)}
              </td>
              <td className="py-2 whitespace-nowrap">
                {s.is_paid
                  ? <span className="text-emerald-600">выплачено {dt(s.payout_at)}</span>
                  : <span className="text-slate-400">не выплачено</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ─── Мелочи ────────────────────────────────────────────────────────────── */

function Card({ title, children }: { title: string; children: any }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="font-semibold text-[#25455D] mb-3">{title}</div>
      {children}
    </div>
  )
}

function Radio({ checked, onChange, title, hint }: any) {
  return (
    <label className={`flex gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
      checked ? 'border-[#25455D] bg-[#25455D]/5' : 'border-slate-200 hover:bg-slate-50'
    }`}>
      <input type="radio" checked={checked} onChange={onChange} className="mt-1" />
      <span>
        <span className="block text-sm font-medium text-slate-800">{title}</span>
        <span className="block text-xs text-slate-500 mt-0.5">{hint}</span>
      </span>
    </label>
  )
}

function Note({ children, warn }: { children: any; warn?: boolean }) {
  return (
    <div className={`mt-3 text-xs flex gap-2 rounded-lg p-2.5 ${
      warn ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-600'
    }`}>
      <Info size={14} className="shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  )
}

function Sum({ label, value, accent, hint }: any) {
  return (
    <div className="text-right">
      <div className="text-[11px] text-slate-400 uppercase tracking-wide">{label}</div>
      <div className={`font-semibold whitespace-nowrap ${accent ? 'text-[#25455D]' : 'text-slate-700'}`}>
        {money(value)}
      </div>
      <div className="text-[11px] text-slate-400">{hint}</div>
    </div>
  )
}

const Loading = () => (
  <div className="flex items-center gap-2 text-slate-400 py-10">
    <Loader2 className="animate-spin" size={18} /> Загрузка…
  </div>
)

const Empty = ({ text }: { text: string }) => (
  // ⚠️ Ноль не объясняем (№ 31): пустой раздел — просто пусто, без оправданий.
  <div className="text-slate-400 py-10 text-sm">{text}</div>
)
