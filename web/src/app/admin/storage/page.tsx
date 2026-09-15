'use client'

/**
 * Админка → «Файловое хранилище платформы».
 *
 * ⚠️ Отличие от клиентского раздела (Настройки → Файловое хранилище): тот
 * показывает файлы ОДНОГО кабинета по таблице учёта. Этот читает бакет целиком
 * и показывает то, чего в учёте нет вовсе — служебные файлы платформы, ручные
 * заливки мимо кабинетов и осиротевшие записи. Ради них раздел и нужен.
 */
import { useEffect, useState, Suspense } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import { HardDrive, Loader2, AlertTriangle, Users, Server, FileWarning } from 'lucide-react'

const API = process.env.NEXT_PUBLIC_API_URL || ''

type ClientRow = {
  client_id: number; name: string; files: number
  bytes: number; size_human: string
  untracked_bytes: number; untracked_human: string | null
}
type SvcGroup = { group: string; files: number; bytes: number; size_human: string }
type SvcFile = { key: string; size_bytes: number; size_human: string; group: string }
type Orphan = { key: string; client_id: number; name: string; size_human: string }
type Data = {
  total_files: number; total_bytes: number; total_human: string
  clients_bytes: number; clients_human: string
  service_bytes: number; service_human: string
  clients: ClientRow[]; service_groups: SvcGroup[]; service_files: SvcFile[]
  orphans: Orphan[]; orphans_bytes: number
}


// ⚠️⚠️ ОБЯЗАТЕЛЬНАЯ ОБЁРТКА. У страницы нет динамического сегмента, поэтому
// Next пререндерит её на сборке, а `useUrlTab` читает адрес (`useSearchParams`)
// — на пререндеренной странице это требует <Suspense>, иначе падает сборка
// ВСЕГО проекта. ⚠️ `tsc` такую ошибку не ловит, только сборка.
export default function AdminStoragePage() {
  return (
    <Suspense fallback={null}>
      <AdminStoragePageInner />
    </Suspense>
  )
}

function AdminStoragePageInner() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useUrlTab<'clients' | 'service' | 'orphans'>('tab', 'clients', ['clients', 'service', 'orphans'])

  useEffect(() => {
    const token = localStorage.getItem('plusson_admin_token') || localStorage.getItem('plusson_token')
    // ⚠️ Без токена сразу показываем причину: иначе запрос уйдёт без заголовка,
    // вернётся 401, и человек будет смотреть на «Читаем хранилище…» без объяснения.
    if (!token) { setError('Не удалось определить вход — войдите в админку заново.'); return }
    fetch(`${API}/api/v1/admin/storage`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Ошибка загрузки')
        return r.json()
      })
      .then(setData)
      .catch(e => setError(e.message))
  }, [])

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
      </div>
    )
  }
  if (!data) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        <Loader2 size={20} className="mr-2 animate-spin" /> Читаем хранилище…
      </div>
    )
  }

  const pctClients = data.total_bytes ? (data.clients_bytes / data.total_bytes) * 100 : 0
  const maxClient = data.clients[0]?.bytes || 1

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-800">Файловое хранилище платформы</h1>
        <p className="mt-1 text-sm text-gray-500">
          Данные читаются напрямую из хранилища — видно и то, чего нет в учёте клиентов.
        </p>
      </div>

      {/* Сводка */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card icon={<HardDrive size={16} />} label="Всего в хранилище"
              value={data.total_human} sub={`${data.total_files} файлов`} />
        <Card icon={<Users size={16} />} label="Файлы клиентов"
              value={data.clients_human} sub={`${Math.round(pctClients)}% объёма`} />
        <Card icon={<Server size={16} />} label="Служебные платформы"
              value={data.service_human} sub="бэкапы и ручные заливки" />
      </div>

      {data.orphans.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <FileWarning size={16} className="mt-0.5 shrink-0" />
          <span>
            {data.orphans.length} записей учёта без файла в хранилище — квота у этих клиентов
            завышена. Починить: <code className="rounded bg-white/60 px-1">reconcile_storage.py --apply</code>
          </span>
        </div>
      )}

      {/* Вкладки */}
      <div className="flex flex-wrap gap-2">
        {([['clients', `Клиенты (${data.clients.length})`],
           ['service', `Служебные (${data.service_groups.length})`],
           ['orphans', `Без файла (${data.orphans.length})`]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              tab === k ? 'bg-brand text-white' : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'clients' && (
        <div className="overflow-hidden rounded-2xl border card-border bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Клиент</th>
                  <th className="px-4 py-2.5 text-left font-medium">Доля</th>
                  <th className="px-4 py-2.5 text-right font-medium">Файлов</th>
                  <th className="px-4 py-2.5 text-right font-medium">Объём</th>
                </tr>
              </thead>
              <tbody>
                {data.clients.map(c => (
                  <tr key={c.client_id} className="border-t border-gray-50 hover:bg-gray-50/60">
                    <td className="px-4 py-2.5">
                      <a href={`/admin/clients?search=${c.client_id}`} className="text-gray-800 hover:text-brand">
                        {c.name}
                      </a>
                      <span className="ml-2 text-xs text-gray-400">#{c.client_id}</span>
                      {c.untracked_human && (
                        <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                          вне учёта {c.untracked_human}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 w-40">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                        <div className="h-full rounded-full gradient-bg"
                          style={{ width: `${Math.max(3, (c.bytes / maxClient) * 100)}%` }} />
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-500">{c.files}</td>
                    <td className="px-4 py-2.5 text-right font-medium text-gray-700 whitespace-nowrap">{c.size_human}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'service' && (
        <div className="space-y-4">
          <div className="rounded-2xl border card-border bg-white p-5 shadow-sm">
            <h3 className="mb-3 font-semibold text-gray-800">По папкам</h3>
            <div className="flex flex-wrap gap-2">
              {data.service_groups.map(g => (
                <span key={g.group}
                  className="rounded-lg border border-gray-100 bg-gray-50 px-2.5 py-1 text-xs text-gray-600">
                  {g.group}/ · {g.size_human} · {g.files} файл.
                </span>
              ))}
            </div>
            <p className="mt-3 text-xs text-gray-400">
              Это файлы вне папок клиентов — бэкапы базы и то, что заливалось в хранилище вручную.
              В квоты кабинетов они не входят.
            </p>
          </div>
          <div className="overflow-hidden rounded-2xl border card-border bg-white shadow-sm">
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="sticky top-0 bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">Файл</th>
                    <th className="px-4 py-2.5 text-right font-medium">Размер</th>
                  </tr>
                </thead>
                <tbody>
                  {data.service_files.map(f => (
                    <tr key={f.key} className="border-t border-gray-50">
                      <td className="px-4 py-2 font-mono text-[11px] text-gray-600 break-all">{f.key}</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap text-gray-700">{f.size_human}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'orphans' && (
        <div className="overflow-hidden rounded-2xl border card-border bg-white shadow-sm">
          {data.orphans.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-400">
              Всё сходится — записей без файла нет.
            </p>
          ) : (
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Файл</th>
                  <th className="px-4 py-2.5 text-left font-medium">Клиент</th>
                  <th className="px-4 py-2.5 text-right font-medium">Размер</th>
                </tr>
              </thead>
              <tbody>
                {data.orphans.map(o => (
                  <tr key={o.key} className="border-t border-gray-50">
                    <td className="px-4 py-2 font-mono text-[11px] text-gray-600 break-all">{o.key}</td>
                    <td className="px-4 py-2 text-gray-700">{o.name}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap text-gray-700">{o.size_human}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

function Card({ icon, label, value, sub }: { icon: any; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border card-border bg-white p-5 shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-gray-400">
        {icon}<span className="text-xs uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-2xl font-semibold text-gray-800">{value}</div>
      <div className="mt-0.5 text-xs text-gray-400">{sub}</div>
    </div>
  )
}
