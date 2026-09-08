'use client'

/**
 * Карточка одного партнёра клиента — `/dashboard/my-partners/{partnerId}`.
 *
 * Зачем отдельная страница, а не разворот в списке: сеть по уровням — это
 * полноценный разрез с вкладками, и в строке списка ему тесно. Партнёров у
 * клиента бывают сотни; открытая гармошка на такой длине превращает список
 * в простыню, по которой не видно ни одной карточки целиком.
 *
 * ⚠️ Отдельного эндпоинта «дай партнёра по id» НЕТ и заводить его не нужно:
 * карточка берётся из того же `GET /partner-program/partners`, что и список.
 * Свой SELECT под одну страницу разошёлся бы со списком в подсчёте сумм —
 * а «Принёс» и «К выплате» считаются там непросто (оборот не обнуляется
 * выплатой, к выплате — только `payout_id IS NULL`).
 */

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Check, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'
import FeatureLock from '@/components/FeatureLock'

const money = (v: any) =>
  (Number(v) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽'

const dt = (v: any) =>
  v ? new Date(v).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—'

export default function PartnerPage() {
  // ⚠️ Next 14.2: параметры через useParams(), не через use(params).
  const params = useParams()
  const partnerId = Number(params?.partnerId)
  const router = useRouter()
  const { me } = useMe()
  const hasFeature = (me?.features || []).includes('partner_program')

  const [partner, setPartner] = useState<any | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = () =>
    api.partnerProgram.partners()
      .then(r => {
        const found = (r.partners || []).find((p: any) => Number(p.id) === partnerId)
        setPartner(found || null)
        setMissing(!found)
      })
      .catch(() => setMissing(true))

  useEffect(() => { if (partnerId) load() }, [partnerId])

  const payout = async () => {
    if (!partner) return
    if (!confirm(
      `Отметить выплату партнёру ${partner.name || ''} на сумму ${money(partner.due)}?\n\n` +
      `Закроются все начисления, накопленные на этот момент. Продажи, которые ` +
      `придут позже, останутся неоплаченными.`
    )) return
    setBusy(true)
    try {
      const r = await api.partnerProgram.payout(partner.id)
      if (r.empty) alert('Нечего выплачивать')
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось отметить выплату')
    } finally { setBusy(false) }
  }

  if (!hasFeature) {
    return (
      <div className="p-4 md:p-6 max-w-6xl">
        <FeatureLock anyOf={['partner_program']} />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl">
      <button
        onClick={() => router.push('/dashboard/my-partners?tab=partners')}
        className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#25455D] mb-4"
      >
        <ArrowLeft size={15} /> К списку партнёров
      </button>

      {missing ? (
        <div className="bg-white border border-slate-200 rounded-xl p-6 text-slate-500">
          Такого партнёра у вас нет.
        </div>
      ) : !partner ? (
        <div className="flex items-center gap-2 text-slate-400 py-8">
          <Loader2 className="animate-spin" size={16} /> Загружаем…
        </div>
      ) : (
        <>
          <div className="bg-white border border-slate-200 rounded-xl p-4 md:p-5 mb-5">
            <div className="flex flex-wrap gap-4 justify-between items-start">
              <div className="min-w-0">
                <h1 className="text-xl font-bold text-[#25455D]">
                  {partner.name || 'Без имени'}
                  {!partner.is_active && (
                    <span className="ml-2 text-xs font-normal text-slate-400">отключён</span>
                  )}
                </h1>
                <div className="text-sm text-slate-500 mt-1 break-all">
                  {[partner.email, partner.phone].filter(Boolean).join(' · ') || '—'}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  С нами с {dt(partner.accepted_at)} · приведено: {partner.people}
                  {partner.payout_mode && ` · личный режим: ${
                    partner.payout_mode === 'passive'
                      ? 'закреплённому' : 'за рекомендацию'}`}
                </div>
              </div>

              <div className="flex gap-5 items-start">
                {/* ⚠️ Две суммы — РАЗНЫЕ вещи, подписаны явно (№ 41). */}
                <Sum label="Принёс" value={partner.turnover} hint="оборот покупок" />
                <Sum label="К выплате" value={partner.due} accent hint="ещё не выплачено" />
                <button
                  onClick={payout}
                  disabled={busy || !Number(partner.due)}
                  className="btn-primary text-sm disabled:opacity-40"
                >
                  {busy ? '…' : <><Check size={14} className="inline mr-1" />Выплачено</>}
                </button>
              </div>
            </div>
          </div>

          <h2 className="text-sm font-semibold text-[#25455D] mb-2">Сеть партнёра</h2>
          <PartnerNetwork partnerId={partnerId} />
        </>
      )}
    </div>
  )
}

function Sum({ label, value, hint, accent }: {
  label: string; value: any; hint?: string; accent?: boolean
}) {
  return (
    <div className="text-right">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-lg font-semibold ${accent ? 'text-[#25455D]' : 'text-slate-600'}`}>
        {money(value)}
      </div>
      {hint && <div className="text-[11px] text-slate-400">{hint}</div>}
    </div>
  )
}

/**
 * Сеть конкретного партнёра по уровням — то же, что видит он сам в своём
 * кабинете. ⚠️ Клиент должен видеть тот же разрез: иначе разговор «почему мне
 * начислено столько» вести не с чем.
 */
function PartnerNetwork({ partnerId }: { partnerId: number }) {
  const [data, setData] = useState<{ levels: number; network: any[] } | null>(null)
  const [level, setLevel] = useState(1)

  useEffect(() => {
    api.partnerProgram.network(partnerId)
      .then(r => setData({ levels: Number(r.levels) || 1, network: r.network || [] }))
      .catch(() => setData({ levels: 1, network: [] }))
  }, [partnerId])

  if (!data) return <div className="text-xs text-slate-400">Загружаем сеть…</div>

  const rows = data.network.filter(n => Number(n.level) === level)

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      {/* ⚠️ Уровни показываем ВСЕГДА до `partner_levels`, даже если на уровне
          пусто: иначе не видно, что уровень вообще существует и там просто
          никого нет — выглядит как пропажа настройки. */}
      <div className="flex gap-1.5 flex-wrap mb-3">
        {Array.from({ length: data.levels }, (_, i) => i + 1).map(n => (
          <button
            key={n}
            onClick={() => setLevel(n)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
              level === n
                ? 'bg-[#25455D] text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {n}-й уровень · {data.network.filter(x => Number(x.level) === n).length}
          </button>
        ))}
      </div>

      {!rows.length ? (
        <div className="text-xs text-slate-500">На этом уровне пока никого нет.</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map(n => (
            <div key={n.partner_id}
                 className="flex flex-wrap gap-3 justify-between items-center
                            bg-slate-50 rounded-lg px-3 py-2">
              <div className="min-w-0">
                {/* Провалиться можно и вглубь сети — у партнёра второго уровня
                    своя сеть, и смотреть её незачем возвращаться в список. */}
                <a href={`/dashboard/my-partners/${n.partner_id}`}
                   className="text-sm text-[#25455D] hover:underline">
                  {n.name || 'Без имени'}
                </a>
                {!n.is_active && (
                  <span className="ml-2 text-xs text-slate-400">отключён</span>
                )}
                <div className="text-xs text-slate-400 break-all">
                  {[n.email, n.phone].filter(Boolean).join(' · ') || '—'}
                  {n.accepted_at && ` · с ${dt(n.accepted_at)}`}
                </div>
              </div>
              <div className="flex gap-4 text-xs shrink-0">
                <div className="text-right">
                  <div className="text-slate-400">Принёс</div>
                  <div className="text-[#25455D] font-medium">{money(n.turnover)}</div>
                </div>
                <div className="text-right">
                  <div className="text-slate-400">К выплате</div>
                  <div className="text-[#25455D] font-medium">{money(n.due)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
