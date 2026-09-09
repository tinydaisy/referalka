'use client'
import { useEffect, useState } from 'react'
import { Users, TrendingUp, Info, HelpCircle } from 'lucide-react'
import { api } from '@/lib/api'

/** Отчёт по привлечению в КОЛЛАБ-событии: кто из организаторов сколько привёл.
 *
 *  ⚠️ Видят все организаторы, и видят всех — в этом смысл Win-Win: обмен
 *  аудиториями честен, только когда вклад каждого на виду.
 *
 *  Считается вживую, по ходу события. Таблица hub_collab_history наполняется
 *  лишь при завершении коллабы, поэтому до финала по ней отчёт не построить.
 */

interface OrgRow {
  client_id: number
  name: string | null
  /** Прежнее поле «привёл» — только по реф-кодам. Оставлено для совместимости. */
  brought: number
  /** По ЛИЧНОЙ ссылке организатора. */
  by_ref: number
  /** По ссылке кого-то из его базы: спикера, партнёра, участника. */
  by_speaker: number
  /** Без ссылки, но контакт в его базе: из бота, из календаря событий. */
  self_came: number
  /** Итог: все трое. По нему и считается Win-Win. */
  total: number
  coefficient: number | null
  is_me: boolean
}

/** Поимённо: кто раздавал ссылки. Чаще всего это спикеры, а не организаторы. */
interface RefRow {
  contact_id: number
  name: string | null
  ref_code: string
  client_id: number | null
  client_name: string | null
  brought: number
  clicked: number
}

/** ⚠️ Win-Win — фирменный персиковый (#FFCFA4 на белом не читается, поэтому
 *  берём тёмный янтарь того же семейства) и жирный: это главная цифра отчёта,
 *  и в ряду серых чисел она должна выделяться сама, без отдельного блока. */
const COEF_STYLE: React.CSSProperties = { color: '#B45309' }

export default function CollabReportTab({ eventId }: { eventId: number }) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<OrgRow[]>([])
  const [refs, setRefs] = useState<RefRow[]>([])
  const [total, setTotal] = useState(0)
  const [broughtTotal, setBroughtTotal] = useState(0)
  const [withoutRef, setWithoutRef] = useState(0)
  const [err, setErr] = useState('')
  // Формула Win-Win — раскрывается по значку «?» у заголовка столбца.
  const [showFormula, setShowFormula] = useState(false)

  useEffect(() => {
    setLoading(true)
    api.collabHub.attractionReport(eventId)
      .then((r: any) => {
        setRows(r.organizers || [])
        setRefs(r.referrers || [])
        setTotal(r.participants_total || 0)
        setBroughtTotal(r.brought_total || 0)
        setWithoutRef(r.without_referrer || 0)
      })
      .catch((e: any) => setErr(e?.message || 'Не удалось загрузить отчёт'))
      .finally(() => setLoading(false))
  }, [eventId])

  if (loading) return <div className="py-16 text-center text-gray-400">Загружаем…</div>
  if (err) return <div className="py-8 text-center text-red-600 text-sm">{err}</div>

  return (
    <div className="space-y-4">
      {/* Сводка */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-2xl font-bold text-gray-900">{total}</div>
          <div className="text-xs text-gray-500 mt-1">Всего участников</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-2xl font-bold text-gray-900">{broughtTotal}</div>
          <div className="text-xs text-gray-500 mt-1">Зарегистрировались</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-2xl font-bold text-gray-400">{withoutRef}</div>
          {/* ⚠️ Раньше здесь было «пришли без чьей-то ссылки» — но такие люди
              теперь засчитываются организатору, в чьей они базе. Остаток —
              это не дошедшие до регистрации. */}
          <div className="text-xs text-gray-500 mt-1">Не зарегистрировались</div>
        </div>
      </div>

      {/* Таблица организаторов.
          ⚠️ Отдельных карточек с рейтингом сверху НЕ заводим: коэффициент уже
          стоит столбцом в этой таблице, и дублировать ту же цифру рядом —
          лишний экран. Вместо этого выделяем сам столбец. */}
      <div className="bg-white rounded-2xl border card-border shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <Users size={17} className="text-gray-400" />
          {/* ⚠️ «От кого сколько ЗАРЕГИСТРИРОВАЛОСЬ», а не «кто сколько привёл»:
              в счёт идут только дошедшие до регистрации. Прежний заголовок
              обещал одно, а таблица показывала другое — человек видел «привёл 1»
              там, где в базе организатора четыре участника, и считал это
              ошибкой. */}
          <h3 className="font-semibold text-gray-800">
            От кого сколько зарегистрировалось
          </h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-xs uppercase">
                <th className="text-left px-5 py-3 font-medium">Организатор</th>
                {/* ⚠️ Три источника, откуда пришёл человек. Раньше стоял один
                    итог, и было непонятно, из чего он сложился. */}
                <th className="text-right px-4 py-3 font-medium">По реф-коду</th>
                <th className="text-right px-4 py-3 font-medium">От рефовода</th>
                <th className="text-right px-4 py-3 font-medium">Из базы</th>
                <th className="text-right px-4 py-3 font-medium">Итого</th>
                {/* ⚠️ Формула — по значку «?», а не текстом рядом: она нужна
                    один раз, чтобы понять цифру, и не должна каждый раз
                    занимать место в шапке. */}
                <th className="text-right px-5 py-3 font-medium">
                  <button type="button" onClick={() => setShowFormula(v => !v)}
                          className="inline-flex items-center gap-1 hover:text-gray-700"
                          title="Как считается Win-Win">
                    Win-Win
                    <HelpCircle size={13} className={showFormula ? 'text-gray-700' : 'text-gray-400'} />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.client_id} className={`border-t border-gray-50 ${r.is_me ? 'bg-amber-50/40' : ''}`}>
                  <td className="px-5 py-3 text-gray-800">
                    {r.name || `Клиент #${r.client_id}`}
                    {r.is_me && <span className="ml-2 text-xs text-gray-400">— вы</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">{r.by_ref ?? 0}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{r.by_speaker ?? 0}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{r.self_came ?? 0}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">
                    {r.total ?? r.brought}
                  </td>
                  <td className="px-5 py-3 text-right font-bold text-base"
                      style={r.coefficient === null ? undefined : COEF_STYLE}>
                    {r.coefficient === null
                      ? <span className="text-gray-300 font-normal">—</span>
                      : r.coefficient.toFixed(2)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-gray-400">Организаторов пока нет</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {/* Расшифровка Win-Win — по клику на «?» в шапке столбца.
            ⚠️ Считаем на ЖИВЫХ числах этого события: абстрактная формула
            «моё ÷ среднее» не отвечает на вопрос «почему у меня именно 3.00». */}
        {showFormula && (
          <div className="px-5 py-4 border-t border-gray-100 bg-amber-50/50 text-sm text-gray-700 space-y-2">
            <p className="font-semibold text-gray-900">Как считается Win-Win</p>
            <p className="font-mono text-xs bg-white border border-amber-200 rounded-lg px-3 py-2">
              коэффициент = мои приведённые ÷ (все приведённые ÷ число организаторов)
            </p>
            <p>Проще: <b>моё число ÷ среднее по организаторам</b>.</p>
            {rows.length > 0 && (
              <p className="text-gray-600">
                Сейчас в этом событии: всего приведённых <b>{rows.reduce((s, r) => s + (r.total ?? 0), 0)}</b>,
                организаторов <b>{rows.length}</b>, значит среднее —{' '}
                <b>{(rows.reduce((s, r) => s + (r.total ?? 0), 0) / rows.length).toFixed(2)}</b>.
                {(() => {
                  const me = rows.find(r => r.is_me)
                  const avg = rows.reduce((s, r) => s + (r.total ?? 0), 0) / rows.length
                  if (!me || !avg) return null
                  return <> У вас {me.total} ÷ {avg.toFixed(2)} = <b>{(me.total / avg).toFixed(2)}</b>.</>
                })()}
              </p>
            )}
            <div className="pt-1 space-y-1 text-gray-600">
              <p><b>1.00</b> — сработали вровень с партнёрами, справедливая доля.</p>
              <p><b>Больше 1</b> — вытянули коллабу на себе. <b>Меньше 1</b> — есть куда расти.</p>
              <p>Число партнёров на коэффициент не влияет: вдвоём или вчетвером поровну — всегда 1.00.</p>
              <p className="text-gray-500">
                ⚠️ Проценты не используем: при них вдвоём поровну давало 50%, а
                вчетвером — 25%, то есть за большее число партнёров наказывало.
              </p>
              <p className="text-gray-500">
                ⚠️ На малых числах коэффициент скачет: один человек против нулей
                у партнёров даст 3.00. Показатель осмыслен, когда людей десятки.
              </p>
            </div>
          </div>
        )}

        <div className="px-5 py-3 bg-gray-50/70 border-t border-gray-100 text-xs text-gray-500 space-y-1">
          <p>
            <b>По реф-коду</b> — по вашей личной ссылке. <b>От рефовода</b> — по
            ссылке кого-то из вашей базы: спикера, партнёра, участника.
            <b> Из базы</b> — зашёл без ссылки, но он уже ваш контакт: из вашего
            бота или из календаря ваших событий.
          </p>
          <p>
            ⚠️ Во всех столбцах — <b>только зарегистрировавшиеся</b>. Человек
            зашёл, но регистрацию не завершил — он в плитке «Не зарегистрировались»
            сверху и ни в один столбец не попадает.
          </p>
          <p>
            Win-Win считается от <b>«Итого»</b>: человек в любом случае приходит
            через чей-то бот и попадает в чью-то базу — это и есть приведённая
            аудитория.
          </p>
        </div>
      </div>

      {/* ── Поимённо: кто раздавал ссылки ─────────────────────────────────
          ⚠️ Рефовод ≠ организатор. Чаще всего людей приводит СПИКЕР или
          обычный участник, а по итоговой цифре организатора этого не видно. */}
      {refs.length > 0 && (
        <div className="bg-white rounded-2xl border card-border shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
            <TrendingUp size={17} className="text-gray-400" />
            {/* Здесь как раз видно обе цифры — сколько перешло и сколько
                дошло до регистрации, поэтому «приводил» уместно. */}
            <h3 className="font-semibold text-gray-800">
              Кто раздавал ссылки
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-xs uppercase">
                  <th className="text-left px-5 py-3 font-medium">Рефовод</th>
                  <th className="text-left px-4 py-3 font-medium">Чья база</th>
                  <th className="text-right px-4 py-3 font-medium">Перешли</th>
                  <th className="text-right px-5 py-3 font-medium">Зарегистрировались</th>
                </tr>
              </thead>
              <tbody>
                {refs.map(r => (
                  <tr key={r.contact_id} className="border-t border-gray-50">
                    <td className="px-5 py-3 text-gray-800">
                      <a href={`/dashboard/clients?contact=${r.contact_id}`}
                         target="_blank" rel="noopener"
                         className="hover:text-[#25455D] hover:underline">
                        {r.name || `Контакт #${r.contact_id}`}
                      </a>
                      <span className="ml-2 text-[11px] text-gray-400 font-mono">{r.ref_code}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs">
                      {r.client_name || <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-400">{r.clicked}</td>
                    <td className="px-5 py-3 text-right font-semibold text-gray-900">{r.brought}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-5 py-3 bg-gray-50/70 border-t border-gray-100 text-xs text-gray-500">
            «Чья база» — организатор, которому принадлежит контакт рефовода:
            его приведённые засчитываются этой команде. «Перешли» — открыли
            событие по ссылке; «Зарегистрировались» — дошли до регистрации,
            только они идут в рейтинг.
          </div>
        </div>
      )}

      {/* ⚠️ Формула Win-Win переехала под значок «?» в шапке столбца — здесь
          её больше нет, иначе одно и то же объяснение стояло бы дважды. */}
      <div className="bg-blue-50/60 border border-blue-100 rounded-xl p-4 flex gap-3">
        <Info size={17} className="text-blue-400 shrink-0 mt-0.5" />
        <div className="text-sm text-gray-700">
          <p>
            «Привёл» — человек пришёл через вас и <b>зарегистрировался</b> на
            событие: по вашей ссылке, по ссылке вашего спикера или из вашей базы.
            Просто открыл и ушёл — не считается.
            После завершения коллабы это значение попадёт в вашу карточку
            в Коллабораторной. Как считается Win-Win — по значку «?» в таблице.
          </p>
        </div>
      </div>
    </div>
  )
}
