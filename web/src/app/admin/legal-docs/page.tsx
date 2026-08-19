'use client'

/**
 * Правовые документы платформы (миграция 317): Публичная оферта, Политика
 * обработки персональных данных, Оферта партнёрской программы.
 *
 * ⚠️ Редактор намеренно ПРОСТОЙ — обычная textarea, без форматирования.
 * Юридический текст правится целиком (заменой из файла), а не по абзацам;
 * визуальный редактор здесь только мешал бы, ломая нумерацию пунктов и
 * пробелы при вставке из документа.
 *
 * ⚠️ Версия документа — дата редакции (ГГГГ-ММ-ДД). Она фиксируется клиенту
 * при регистрации (clients.offer_accepted_version), поэтому менять её нужно
 * только при существенной правке: по ней видно, с какой редакцией человек
 * согласился. Исправили опечатку — версию не трогаем.
 */
import { useEffect, useState } from 'react'
import { FileText, Check, AlertCircle, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

type Doc = {
  slug: string
  title: string
  body: string
  version: string | null
  updated_at: string
}

// Публичный адрес каждого документа — чтобы можно было сразу открыть и увидеть,
// что видит клиент по ссылке из формы регистрации.
const PUBLIC_URL: Record<string, string> = {
  offer: '/offer',
  privacy: '/privacy',
  partner_offer: '/partner-offer',
}

const HINT: Record<string, string> = {
  offer: 'Ссылка на этот документ стоит в чекбоксе «Я принимаю условия Публичной оферты» при регистрации клиента.',
  privacy: 'Ссылка стоит в чекбоксе согласия на обработку персональных данных при регистрации клиента.',
  partner_offer: 'Условия партнёрской программы. На документ ссылается раздел 15 Публичной оферты.',
}

export default function AdminLegalDocsPage() {
  const [docs, setDocs] = useState<Doc[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [active, setActive] = useState<string>('offer')

  // Правки держим локально и отправляем по кнопке: юридический текст длинный,
  // автосохранение на каждое нажатие клавиши тут ни к чему.
  const [draft, setDraft] = useState<Record<string, { body: string; version: string }>>({})
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  function load() {
    setLoading(true)
    api.adminLegalDocs.list()
      .then((rows: any) => {
        setDocs(rows)
        const d: Record<string, { body: string; version: string }> = {}
        rows.forEach((r: Doc) => { d[r.slug] = { body: r.body || '', version: r.version || '' } })
        setDraft(d)
        setLoading(false)
      })
      .catch((e: any) => { setErr(e?.message || 'Не удалось загрузить'); setLoading(false) })
  }

  useEffect(() => { load() }, [])

  const doc = docs.find(d => d.slug === active)
  const cur = draft[active] || { body: '', version: '' }
  const dirty = !!doc && (cur.body !== (doc.body || '') || cur.version !== (doc.version || ''))

  async function save() {
    if (!doc) return
    setSaving(true); setErr(''); setSavedAt(null)
    try {
      const updated: any = await api.adminLegalDocs.update(doc.slug, {
        body: cur.body,
        version: cur.version.trim() || null,
      })
      setDocs(docs.map(d => (d.slug === doc.slug ? updated : d)))
      setSavedAt(new Date().toLocaleTimeString('ru-RU'))
    } catch (e: any) {
      setErr(e?.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="p-6 text-gray-500">Загрузка…</div>

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center gap-2 mb-1">
        <FileText size={20} className="text-[#25455D]" />
        <h1 className="text-xl font-semibold text-[#25455D]">Правовые документы</h1>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        Документы самой платформы. Текст вставляется целиком, без форматирования.
      </p>

      {err && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{err}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {docs.map(d => (
          <button
            key={d.slug}
            onClick={() => setActive(d.slug)}
            className={`px-3.5 py-2 rounded-xl text-sm transition ${
              active === d.slug
                ? 'text-white'
                : 'bg-white border border-gray-200 text-gray-700 hover:border-gray-300'
            }`}
            style={active === d.slug ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : {}}
          >
            {d.title}
            {!(d.body || '').trim() && (
              <span className={`ml-2 text-xs ${active === d.slug ? 'opacity-70' : 'text-amber-600'}`}>
                не заполнен
              </span>
            )}
          </button>
        ))}
      </div>

      {doc && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <div className="text-xs text-gray-500 mb-4 leading-snug">{HINT[doc.slug]}</div>

          <div className="flex flex-wrap items-end gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Редакция от</label>
              <input
                type="text"
                value={cur.version}
                onChange={e => setDraft({ ...draft, [active]: { ...cur, version: e.target.value } })}
                placeholder="2026-06-14"
                className="w-40 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#25455D]"
              />
              <div className="text-[11px] text-gray-400 mt-1">
                Дата в формате ГГГГ-ММ-ДД. Записывается клиенту при регистрации.
              </div>
            </div>
            <a
              href={PUBLIC_URL[doc.slug]}
              target="_blank"
              rel="noopener"
              className="flex items-center gap-1.5 text-sm text-[#25455D] underline pb-2"
            >
              Открыть публичную страницу <ExternalLink size={14} />
            </a>
          </div>

          <label className="block text-sm font-medium text-gray-700 mb-1">Текст документа</label>
          <textarea
            value={cur.body}
            onChange={e => setDraft({ ...draft, [active]: { ...cur, body: e.target.value } })}
            spellCheck={false}
            className="w-full h-[60vh] border border-gray-200 rounded-xl px-3 py-2.5 text-sm font-mono leading-relaxed focus:outline-none focus:border-[#25455D]"
            placeholder="Вставьте текст документа целиком…"
          />
          <div className="text-[11px] text-gray-400 mt-1">
            {cur.body.length.toLocaleString('ru-RU')} символов.
            Переносы строк и пустые строки между абзацами сохраняются как есть.
          </div>

          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={save}
              disabled={saving || !dirty}
              className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40"
            >
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
            {savedAt && (
              <span className="flex items-center gap-1.5 text-sm text-emerald-700">
                <Check size={15} /> Сохранено в {savedAt}
              </span>
            )}
            {dirty && !saving && !savedAt && (
              <span className="text-sm text-amber-600">Есть несохранённые изменения</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
