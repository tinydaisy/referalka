'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Edit2, Trash2, Eye, ExternalLink, X } from 'lucide-react'
import { api } from '@/lib/api'

type TypeDef = {
  type: string
  title: string
  hint: string
  variables: string[]
}

const TYPE_DEFS: TypeDef[] = [
  {
    type: 'pre_start',
    title: 'Анонс спикера',
    hint: 'Отправляется за 5 минут до начала выступления. Фото — афиша спикера.',
    variables: ['{speaker_name}', '{speaker_topic}', '{stream_url}'],
  },
  {
    type: 'gift',
    title: 'Подарок спикера',
    hint: 'Отправляется за 10 минут до конца выступления.',
    variables: ['{speaker_name}', '{gift_title}', '{gift_url}', '{speaker_contacts}'],
  },
  {
    type: 'day_start_30min',
    title: 'День конференции — за 30 минут до старта',
    hint: 'Отправляется за 30 минут до начала дня. Фото — горизонтальная афиша конференции.',
    variables: ['{conf_title}', '{day_number}', '{day_date}', '{day_program}', '{stream_url}'],
  },
  {
    type: 'day_live',
    title: 'День конференции — старт эфира',
    hint: 'Отправляется в момент начала дня конференции.',
    variables: ['{conf_title}', '{day_number}', '{stream_url}'],
  },
  {
    type: 'day_end',
    title: 'День конференции — итоги дня',
    hint: 'Отправляется по окончании дня. Автоматически вставляет список подарков всех спикеров этого дня.',
    variables: ['{conf_title}', '{day_ordinal}', '{next_day_number}', '{next_day_start_time}', '{raffle_url}', '{day_speakers_gifts}'],
  },
]

const emptyForm = { name: '', type: 'pre_start', text: '', photo_url: '', button_text: '', button_url: '' }

export default function TemplatesPage() {
  const { id } = useParams()
  const eventId = Number(id)

  const [templates, setTemplates] = useState<any[]>([])
  const [modal, setModal] = useState<any>(null)
  const [form, setForm] = useState({ ...emptyForm })

  useEffect(() => {
    api.conference.templates.list(eventId).then(r => setTemplates(r.templates || []))
  }, [eventId])

  async function save() {
    try {
      const res = await api.conference.templates.update(eventId, modal.id, form)
      setTemplates(templates.map((x: any) => x.id === modal.id ? res : x))
      setModal(null)
    } catch (e: any) {
      alert(e.message)
    }
  }

  function edit(t: any) {
    setModal(t)
    setForm({
      name: t.name,
      type: t.type,
      text: t.text || '',
      photo_url: t.photo_url || '',
      button_text: t.button_text || '',
      button_url: t.button_url || '',
    })
  }

  const currentType = TYPE_DEFS.find(d => d.type === form.type)

  return (
    <div>
      <p className="text-sm text-gray-500 mb-6">
        5 шаблонов создаются автоматически. Здесь вы можете отредактировать тексты — плейсхолдеры
        вида <code className="text-xs bg-gray-100 rounded px-1">{'{speaker_name}'}</code> подставятся
        автоматически при отправке. Потом перейдите в «Очередь рассылок» и нажмите «Создать из программы».
      </p>

      <div className="space-y-4">
        {TYPE_DEFS.map(def => {
          const tpl = templates.find(t => t.type === def.type)
          return (
            <div key={def.type} className="bg-white rounded-2xl border border-gray-100 p-5">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <h4 className="font-semibold text-gray-800">{def.title}</h4>
                  <p className="text-xs text-gray-400 mt-0.5">{def.hint}</p>
                </div>
                {tpl && (
                  <button onClick={() => edit(tpl)}
                    className="shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm text-white font-medium"
                    style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                    <Edit2 size={13} /> Редактировать
                  </button>
                )}
              </div>

              {!tpl ? (
                <div className="py-8 text-center text-gray-400 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                  <Edit2 size={22} className="mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Шаблон ещё не создан — обновите страницу</p>
                </div>
              ) : (
                <TemplateCard t={tpl} variables={def.variables} />
              )}
            </div>
          )
        })}
      </div>

      {/* Модалка редактирования */}
      {modal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">Редактировать шаблон</h3>
              <button onClick={() => setModal(null)}><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Название</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400" />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Текст сообщения</label>
                <textarea value={form.text} onChange={e => setForm({ ...form, text: e.target.value })}
                  rows={10} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none resize-y font-mono" />
                {currentType && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="text-xs text-gray-400 mr-1">Переменные:</span>
                    {currentType.variables.map(v => (
                      <button key={v} type="button"
                        onClick={() => setForm({ ...form, text: form.text + v })}
                        className="text-xs bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg px-2 py-0.5 font-mono text-gray-600">
                        {v}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  Фото (URL) — если пусто, подставится афиша: для анонса спикера — афиша спикера, для «за 30 мин» — горизонтальная афиша конференции
                </label>
                <input value={form.photo_url} onChange={e => setForm({ ...form, photo_url: e.target.value })}
                  placeholder="https://..."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Текст кнопки</label>
                  <input value={form.button_text} onChange={e => setForm({ ...form, button_text: e.target.value })}
                    placeholder="Войти в эфир"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Ссылка кнопки</label>
                  <input value={form.button_url} onChange={e => setForm({ ...form, button_url: e.target.value })}
                    placeholder="{stream_url} или https://..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none font-mono" />
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={save}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                Сохранить
              </button>
              <button onClick={() => setModal(null)}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TemplateCard({ t, variables }: { t: any; variables: string[] }) {
  return (
    <div className="bg-gray-50 rounded-xl p-4">
      <p className="text-sm text-gray-700 whitespace-pre-wrap font-mono text-xs mb-3">{t.text}</p>
      <div className="flex flex-wrap gap-3 text-xs text-gray-500">
        {t.photo_url ? (
          <span className="flex items-center gap-1"><Eye size={11} /> Своё фото</span>
        ) : (
          <span className="flex items-center gap-1 text-blue-500">📸 Афиша подставится автоматически</span>
        )}
        {t.button_text && (
          <span className="flex items-center gap-1">
            <ExternalLink size={11} /> Кнопка: «{t.button_text}»
          </span>
        )}
      </div>
    </div>
  )
}
