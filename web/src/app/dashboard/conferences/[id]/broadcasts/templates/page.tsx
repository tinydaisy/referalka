'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Plus, Edit2, Trash2, Eye, ExternalLink, X } from 'lucide-react'
import { api } from '@/lib/api'

const DEFAULT_TEXTS: Record<string, string> = {
  pre_start: `Через 5 минут выступает {speaker_name}

Тема: «{speaker_topic}»

Заходи в эфир, получай полезный контент и находи секретный код для розыгрыша!
👇👇👇
{stream_url}`,
  gift: `🎁 {speaker_name}: Подарки

{gift_title}

{gift_url}`,
}

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

  function openNew(type: string) {
    setForm({ ...emptyForm, type, text: DEFAULT_TEXTS[type] || '',
      name: type === 'pre_start' ? 'Анонс спикера (за 5 мин)' : 'Подарок спикера (за 10 мин)',
      button_text: type === 'pre_start' ? 'СМОТРЕТЬ ЭФИР' : '',
    })
    setModal('new')
  }

  async function save() {
    try {
      if (modal === 'new') {
        const res = await api.conference.templates.create(eventId, form)
        setTemplates([...templates, res])
      } else {
        const res = await api.conference.templates.update(eventId, modal.id, form)
        setTemplates(templates.map((x: any) => x.id === modal.id ? res : x))
      }
      setModal(null)
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function del(id: number) {
    if (!confirm('Удалить шаблон?')) return
    await api.conference.templates.delete(eventId, id)
    setTemplates(templates.filter((x: any) => x.id !== id))
  }

  const preStart = templates.filter(t => t.type === 'pre_start')
  const gift = templates.filter(t => t.type === 'gift')

  return (
    <div>
      <p className="text-sm text-gray-500 mb-6">
        Создайте два шаблона — один для анонса спикера (за 5 мин до старта), второй для подарка (за 10 мин до конца).
        Потом перейдите в «Очередь рассылок» и нажмите «Создать из программы».
      </p>

      {/* Шаблон 1 — pre_start */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h4 className="font-semibold text-gray-800">Анонс спикера</h4>
            <p className="text-xs text-gray-400">Отправляется за 5 минут до начала выступления</p>
          </div>
          {preStart.length === 0 && (
            <button onClick={() => openNew('pre_start')}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm text-white font-medium"
              style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
              <Plus size={13} /> Создать шаблон
            </button>
          )}
        </div>
        {preStart.length === 0 ? (
          <div className="py-8 text-center text-gray-400 bg-white rounded-2xl border border-dashed border-gray-200">
            <Edit2 size={24} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">Шаблон не создан</p>
          </div>
        ) : (
          <TemplateCard t={preStart[0]} onEdit={() => { setModal(preStart[0]); setForm({ name: preStart[0].name, type: preStart[0].type, text: preStart[0].text || '', photo_url: preStart[0].photo_url || '', button_text: preStart[0].button_text || '', button_url: preStart[0].button_url || '' }) }} onDelete={() => del(preStart[0].id)} />
        )}
      </div>

      {/* Шаблон 2 — gift */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h4 className="font-semibold text-gray-800">Подарок спикера</h4>
            <p className="text-xs text-gray-400">Отправляется за 10 минут до конца выступления</p>
          </div>
          {gift.length === 0 && (
            <button onClick={() => openNew('gift')}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm text-white font-medium"
              style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
              <Plus size={13} /> Создать шаблон
            </button>
          )}
        </div>
        {gift.length === 0 ? (
          <div className="py-8 text-center text-gray-400 bg-white rounded-2xl border border-dashed border-gray-200">
            <Edit2 size={24} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">Шаблон не создан</p>
          </div>
        ) : (
          <TemplateCard t={gift[0]} onEdit={() => { setModal(gift[0]); setForm({ name: gift[0].name, type: gift[0].type, text: gift[0].text || '', photo_url: gift[0].photo_url || '', button_text: gift[0].button_text || '', button_url: gift[0].button_url || '' }) }} onDelete={() => del(gift[0].id)} />
        )}
      </div>

      {/* Блок переменных */}
      <div className="bg-gray-50 rounded-xl p-4 border border-gray-100">
        <p className="text-xs font-semibold text-gray-600 mb-2">Доступные переменные</p>
        <div className="flex flex-wrap gap-2">
          {['{speaker_name}', '{speaker_topic}', '{stream_url}', '{gift_title}', '{gift_url}', '{start_time}', '{end_time}'].map(v => (
            <span key={v} className="text-xs bg-white border border-gray-200 rounded-lg px-2 py-1 font-mono text-gray-600">{v}</span>
          ))}
        </div>
      </div>

      {/* Модалка */}
      {modal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">{modal === 'new' ? 'Новый шаблон' : 'Редактировать шаблон'}</h3>
              <button onClick={() => setModal(null)}><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Название</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400" />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Тип</label>
                <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value, text: DEFAULT_TEXTS[e.target.value] || form.text })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none">
                  <option value="pre_start">Анонс (за 5 мин до старта)</option>
                  <option value="gift">Подарок (за 10 мин до конца)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Текст сообщения</label>
                <textarea value={form.text} onChange={e => setForm({ ...form, text: e.target.value })}
                  rows={7} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none resize-none font-mono" />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Фото (URL) — если пусто, берётся афиша спикера</label>
                <input value={form.photo_url} onChange={e => setForm({ ...form, photo_url: e.target.value })}
                  placeholder="https://..."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Текст кнопки</label>
                  <input value={form.button_text} onChange={e => setForm({ ...form, button_text: e.target.value })}
                    placeholder="СМОТРЕТЬ ЭФИР"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Ссылка кнопки</label>
                  <input value={form.button_url} onChange={e => setForm({ ...form, button_url: e.target.value })}
                    placeholder="https://..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
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

function TemplateCard({ t, onEdit, onDelete }: { t: any; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-800 mb-2">{t.name}</p>
          {t.text && (
            <p className="text-sm text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 mb-2 font-mono text-xs">{t.text}</p>
          )}
          <div className="flex flex-wrap gap-3 text-xs text-gray-400">
            {t.photo_url && <span className="flex items-center gap-1"><Eye size={11} /> Есть фото</span>}
            {t.button_text && <span className="flex items-center gap-1"><ExternalLink size={11} /> Кнопка: {t.button_text}</span>}
            {!t.photo_url && t.type === 'pre_start' && <span className="text-blue-400">📸 Фото — афиша спикера</span>}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <button onClick={onEdit} className="p-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-700">
            <Edit2 size={13} />
          </button>
          <button onClick={onDelete} className="p-1.5 border border-red-100 rounded-lg text-red-400 hover:text-red-600">
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
