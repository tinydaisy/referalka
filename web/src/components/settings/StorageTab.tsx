'use client'

/**
 * Настройки → «Файловое хранилище».
 *
 * Две страницы в одном компоненте (без роутинга — состояние `view`):
 *   'summary' — сколько занято, из чего складывается, подключение своего Cloud.ru
 *   'details' — список всех файлов со стрелкой «назад» и переходом в раздел
 *
 * ⚠️ Цифры берём с бэкенда (/storage/usage и /storage/files) и НИЧЕГО не
 * считаем в браузере: размер файла и его принадлежность знает только сервер.
 */
import { useEffect, useState } from 'react'
import {
  HardDrive, ChevronLeft, ExternalLink, Loader2, Search,
  Cloud, Info, ArrowRight,
} from 'lucide-react'

type Usage = {
  used_bytes: number; quota_bytes: number
  used_human: string; quota_human: string; used_percent: number
}
type FileRow = {
  id: number; kind: string; kind_label: string; url: string
  size_bytes: number; size_human: string; created_at: string | null
  place: string; event_id: number | null; event_title: string | null
  link: string | null; is_temp: boolean
}
type Group = { place: string; link: string | null; count: number; size_bytes: number; size_human: string }
type KindStat = { label: string; count: number; size_bytes: number; size_human: string }

const API = process.env.NEXT_PUBLIC_API_URL || ''

export default function StorageTab() {
  const [view, setView] = useState<'summary' | 'details'>('summary')
  const [usage, setUsage] = useState<Usage | null>(null)
  const [files, setFiles] = useState<FileRow[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [byKind, setByKind] = useState<KindStat[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) return
    const h = { Authorization: `Bearer ${token}` }
    Promise.all([
      fetch(`${API}/api/v1/storage/usage`, { headers: h }).then(r => r.ok ? r.json() : null),
      fetch(`${API}/api/v1/storage/files`, { headers: h }).then(r => r.ok ? r.json() : null),
    ]).then(([u, f]) => {
      if (u) setUsage(u)
      if (f) { setFiles(f.files || []); setGroups(f.groups || []); setByKind(f.by_kind || []) }
    }).finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400">
        <Loader2 size={20} className="animate-spin mr-2" /> Загружаем…
      </div>
    )
  }

  // ── Страница «Детализация» ────────────────────────────────────────────────
  if (view === 'details') {
    const needle = q.trim().toLowerCase()
    const shown = needle
      ? files.filter(f =>
          f.kind_label.toLowerCase().includes(needle) ||
          f.place.toLowerCase().includes(needle))
      : files

    return (
      <div className="space-y-4">
        <button onClick={() => setView('summary')}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800">
          <ChevronLeft size={16} /> Назад к хранилищу
        </button>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="font-semibold text-gray-800">Что занимает место</h3>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={q} onChange={e => setQ(e.target.value)}
              placeholder="Найти по названию или событию"
              className="pl-8 pr-3 py-2 text-sm rounded-lg border border-gray-200 w-64 max-w-full" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium">Файл</th>
                  <th className="text-left px-4 py-2.5 font-medium">Где используется</th>
                  <th className="text-right px-4 py-2.5 font-medium">Размер</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {shown.map(f => (
                  <tr key={f.id} className="border-t border-gray-50 hover:bg-gray-50/60">
                    <td className="px-4 py-2.5">
                      <a href={f.url} target="_blank" rel="noreferrer"
                        className="text-gray-800 hover:text-brand">{f.kind_label}</a>
                      {f.is_temp && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                          удалится через 24 ч
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{f.place}</td>
                    <td className="px-4 py-2.5 text-right text-gray-700 whitespace-nowrap">{f.size_human}</td>
                    <td className="px-4 py-2.5 text-right">
                      {f.link && (
                        <a href={f.link}
                          className="inline-flex items-center gap-1 text-xs text-brand hover:underline whitespace-nowrap">
                          Перейти <ArrowRight size={12} />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">Ничего не нашлось</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-xs text-gray-400">Всего файлов: {files.length}</p>
      </div>
    )
  }

  // ── Страница «Хранилище» ──────────────────────────────────────────────────
  const pct = usage?.used_percent ?? 0
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'gradient-bg'
  const maxGroup = groups[0]?.size_bytes || 1

  return (
    <div className="space-y-5">
      {/* Занято */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-start gap-3 mb-5">
          <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
            <HardDrive size={18} className="text-white" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-800">Файловое хранилище</h3>
            <p className="text-sm text-gray-500 mt-0.5">
              Афиши, фото спикеров, картинки лендингов, видео, уроки и записи эфиров.
            </p>
          </div>
        </div>

        <div className="flex items-baseline justify-between mb-2">
          <div className="text-lg text-gray-800">
            <span className="font-semibold">{usage?.used_human}</span>
            <span className="text-gray-400 text-sm"> из {usage?.quota_human}</span>
          </div>
          <div className={`text-sm font-medium ${
            pct >= 90 ? 'text-red-600' : pct >= 70 ? 'text-amber-600' : 'text-gray-500'}`}>
            {pct}%
          </div>
        </div>
        <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        {pct >= 90 && (
          <p className="text-xs text-red-600 mt-2">
            Хранилище почти заполнено. Удалите ненужные файлы или подключите своё хранилище — оно ниже.
          </p>
        )}

        <button onClick={() => setView('details')}
          className="btn-primary mt-5 px-4 py-2.5 rounded-xl text-sm font-medium inline-flex items-center gap-2">
          Детализация <ArrowRight size={14} />
        </button>
      </div>

      {/* Из чего складывается */}
      {groups.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h4 className="font-semibold text-gray-800 mb-4">Что занимает больше всего</h4>
          <div className="space-y-3">
            {groups.slice(0, 6).map(g => (
              <div key={g.place}>
                <div className="flex items-baseline justify-between text-sm mb-1 gap-3">
                  <span className="text-gray-700 truncate">{g.place}</span>
                  <span className="text-gray-500 whitespace-nowrap shrink-0">
                    {g.size_human} · {g.count} файл{g.count % 10 === 1 && g.count % 100 !== 11 ? '' : 'ов'}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full gradient-bg"
                    style={{ width: `${Math.max(3, (g.size_bytes / maxGroup) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
          {byKind.length > 0 && (
            <div className="mt-5 pt-4 border-t border-gray-100 flex flex-wrap gap-2">
              {byKind.slice(0, 8).map(k => (
                <span key={k.label}
                  className="text-xs px-2.5 py-1 rounded-lg bg-gray-50 text-gray-600 border border-gray-100">
                  {k.label} · {k.size_human}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Своё хранилище */}
      <OwnStorageBlock />
    </div>
  )
}

/**
 * Подключение собственного хранилища Cloud.ru.
 *
 * ⚠️ Реферальная ссылка приходит с бэкенда (/public/storage-promo), а не зашита
 * в код: она меняется, и ради её правки не должно требоваться выкладывать фронт.
 */
function OwnStorageBlock() {
  const [promo, setPromo] = useState<{ ref_url: string; free_gb: number } | null>(null)

  useEffect(() => {
    fetch(`${API}/api/v1/public/storage-promo`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setPromo(d))
      .catch(() => {})
  }, [])

  if (!promo?.ref_url) return null

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg bg-[#F1F6FA] border border-[#B9CEDD] flex items-center justify-center shrink-0">
          <Cloud size={18} className="text-[#25455D]" />
        </div>
        <div className="flex-1">
          <h4 className="font-semibold text-gray-800">Своё хранилище — {promo.free_gb} ГБ бесплатно</h4>
          <p className="text-sm text-gray-500 mt-0.5">
            Подключите бесплатное хранилище Cloud.ru — файлы будут храниться у вас,
            а место в ПЛЮСОНе перестанет заканчиваться.
          </p>
        </div>
      </div>

      <div className="flex items-start gap-2 text-[13px] text-gray-600 bg-gray-50 rounded-xl px-3.5 py-3 mb-4">
        <Info size={14} className="mt-0.5 shrink-0 text-gray-400" />
        <div className="space-y-1">
          <p><b>Как подключить:</b></p>
          <p>1. Зарегистрируйтесь в Cloud.ru по кнопке ниже — {promo.free_gb} ГБ даются бесплатно.</p>
          <p>2. Создайте хранилище (Object Storage) с публичным доступом на чтение.</p>
          <p>3. Создайте ключ доступа и пришлите его нам — мы подключим.</p>
        </div>
      </div>

      <a href={promo.ref_url} target="_blank" rel="noreferrer"
        className="btn-gold inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold">
        Подключить бесплатно <ExternalLink size={14} />
      </a>
    </div>
  )
}
