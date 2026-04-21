'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Edit2, Eye, X, ChevronDown, ChevronUp } from 'lucide-react'
import { api } from '@/lib/api'

type TypeDef = {
  type: string
  title: string
  hint: string
  variables: string[]
  hasSpeaker?: boolean
  showPhoto?: boolean
}

const TYPE_DEFS: TypeDef[] = [
  {
    type: 'speaker_intro',
    title: 'Знакомство со спикером',
    hint: 'Рассылается участникам для представления спикера. Фото — афиша спикера.',
    variables: ['{speaker_name}', '{speaker_tg}', '{speaker_topic}', '{speaker_achievements}', '{gift_after_speech_title}', '{gift_raffle_title}'],
    hasSpeaker: true,
    showPhoto: true,
  },
  {
    type: 'pre_start',
    title: 'Анонс спикера',
    hint: 'Отправляется за 5 минут до начала выступления. Фото — афиша спикера.',
    variables: ['{speaker_name}', '{speaker_topic}', '{stream_url}'],
    hasSpeaker: true,
    showPhoto: true,
  },
  {
    type: 'gift',
    title: 'Подарок спикера',
    hint: 'Отправляется за 10 минут до конца выступления. Без фото.',
    variables: ['{speaker_name}', '{gift_title}', '{gift_url}'],
    hasSpeaker: true,
    showPhoto: false,
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

const ALL_VARIABLES: { name: string; desc: string }[] = [
  { name: '{speaker_name}', desc: 'Имя спикера' },
  { name: '{speaker_tg}', desc: 'Telegram-канал спикера' },
  { name: '{speaker_topic}', desc: 'Тема выступления' },
  { name: '{speaker_achievements}', desc: 'Регалии спикера (строки через · )' },
  { name: '{gift_after_speech_title}', desc: 'Подарок на эфире' },
  { name: '{gift_raffle_title}', desc: 'Подарок для розыгрыша' },
  { name: '{gift_title}', desc: 'Название подарка (из поля «Подарок» сессии)' },
  { name: '{gift_url}', desc: 'Ссылка на подарок' },
  { name: '{stream_url}', desc: 'Ссылка на эфир' },
  { name: '{conf_title}', desc: 'Название конференции' },
  { name: '{day_number}', desc: 'Номер дня (1, 2, 3…)' },
  { name: '{day_ordinal}', desc: 'Номер дня словом (первом, втором…)' },
  { name: '{day_date}', desc: 'Дата дня конференции' },
  { name: '{day_program}', desc: 'Программа дня (список спикеров и тем)' },
  { name: '{next_day_number}', desc: 'Номер следующего дня' },
  { name: '{next_day_start_time}', desc: 'Время начала следующего дня' },
  { name: '{raffle_url}', desc: 'Ссылка на розыгрыш' },
  { name: '{day_speakers_gifts}', desc: 'Список подарков спикеров за день' },
]

const emptyForm = { name: '', type: 'pre_start', text: '', photo_url: '', button_text: '', button_url: '' }

export default function TemplatesPage() {
  const { id } = useParams()
  const eventId = Number(id)

  const [templates, setTemplates] = useState<any[]>([])
  const [speakers, setSpeakers] = useState<any[]>([])
  const [editModal, setEditModal] = useState<any>(null)
  const [form, setForm] = useState({ ...emptyForm })
  const [previewModal, setPreviewModal] = useState<{ tpl: any; def: TypeDef } | null>(null)
  const [previewSpeakerId, setPreviewSpeakerId] = useState<number | null>(null)
  const [varsOpen, setVarsOpen] = useState(false)

  useEffect(() => {
    api.conference.templates.list(eventId).then(r => setTemplates(r.templates || []))
    api.conference.speakers.list(eventId).then(r => setSpeakers(r.speakers || []))
  }, [eventId])

  async function save() {
    try {
      const res = await api.conference.templates.update(eventId, editModal.id, form)
      setTemplates(templates.map((x: any) => x.id === editModal.id ? res : x))
      setEditModal(null)
    } catch (e: any) {
      alert(e.message)
    }
  }

  function openEdit(t: any) {
    setEditModal(t)
    setForm({
      name: t.name,
      type: t.type,
      text: t.text || '',
      photo_url: t.photo_url || '',
      button_text: t.button_text || '',
      button_url: t.button_url || '',
    })
  }

  function openPreview(tpl: any, def: TypeDef) {
    setPreviewModal({ tpl, def })
    setPreviewSpeakerId(speakers[0]?.id ?? null)
  }

  const currentType = TYPE_DEFS.find(d => d.type === form.type)
  const previewSpeaker = previewSpeakerId ? speakers.find(s => s.id === previewSpeakerId) : null

  function renderPreviewText(text: string, speaker: any | null, tplType?: string): string {
    if (!text) return ''
    // Нормализуем литеральные \n на случай старых данных из БД
    let out = text.replace(/\\n/g, '\n')

    if (speaker) {
      const giftTitle = (speaker.gift_after_speech_title || '').trim()
      const giftUrl = (speaker.gift_after_speech_url || '').trim()
      const tgUrl = (speaker.tg_channel_url || '').trim()
      const achievements = (speaker.achievements || []).map((a: string) => `· ${a}`).join('\n')
      const giftRaffle = (speaker.gift_raffle_title || '').trim()

      // Правила блока подарка (для шаблона gift)
      if (tplType === 'gift') {
        // Убираем строки с переменными подарка — заменим всё блоком по правилам
        out = out.replace(/^.*\{gift_title\}.*$\n?/gm, '')
        out = out.replace(/^.*\{gift_url\}.*$\n?/gm, '')

        let giftBlock = ''
        if (!giftTitle) {
          // Нет подарка — ссылка на личку
          giftBlock = tgUrl
            ? `🎁 Чтобы забрать материалы — пишите в личку ${tgUrl}`
            : `🎁 Чтобы забрать материалы — напишите спикеру в личку`
        } else if (!giftUrl) {
          // Есть название, нет ссылки
          giftBlock = tgUrl
            ? `${giftTitle}\nПишите в личку ${tgUrl}`
            : giftTitle
        } else {
          // Есть и название и ссылка
          giftBlock = `${giftTitle}\n${giftUrl}`
        }
        out = out.trimEnd() + '\n\n' + giftBlock
      } else {
        // Стандартная логика для других шаблонов
        if (giftUrl) {
          out = out.replace(/\{gift_url\}/g, giftUrl)
        } else {
          out = out.replace(/^.*\{gift_url\}.*$\n?/gm, '')
        }
        if (giftTitle) {
          out = out.replace(/\{gift_title\}/g, giftTitle)
          out = out.replace(/\{gift_after_speech_title\}/g, giftTitle)
        } else {
          out = out.replace(/^.*\{gift_title\}.*$\n?/gm, '')
          out = out.replace(/^.*\{gift_after_speech_title\}.*$\n?/gm, '')
        }
      }

      // Telegram-канал
      if (tgUrl) {
        out = out.replace(/\{speaker_tg\}/g, `Тг канал: ${tgUrl}`)
      } else {
        out = out.replace(/^.*\{speaker_tg\}.*$\n?/gm, '')
      }

      // Регалии
      if (achievements) {
        out = out.replace(/\{speaker_achievements\}/g, achievements)
      } else {
        out = out.replace(/^.*\{speaker_achievements\}.*$\n?/gm, '')
      }

      // Подарок для розыгрыша
      if (giftRaffle) {
        out = out.replace(/\{gift_raffle_title\}/g, giftRaffle)
      } else {
        out = out.replace(/^.*\{gift_raffle_title\}.*$\n?/gm, '')
      }

      out = out
        .replace(/\{speaker_name\}/g, speaker.name || '')
        .replace(/\{speaker_topic\}/g, speaker.topics?.[0]?.topic || speaker.topic || 'уточняется')
        .replace(/\{stream_url\}/g, '🔗 [ссылка на эфир]')
    }

    out = out
      .replace(/\{conf_title\}/g, '[Название конференции]')
      .replace(/\{day_number\}/g, '1')
      .replace(/\{day_ordinal\}/g, 'первом')
      .replace(/\{day_date\}/g, '01 января')
      .replace(/\{day_program\}/g, '[программа дня]')
      .replace(/\{next_day_number\}/g, '2')
      .replace(/\{next_day_start_time\}/g, '10:00')
      .replace(/\{raffle_url\}/g, '🔗 [ссылка на розыгрыш]')
      .replace(/\{day_speakers_gifts\}/g, '[подарки спикеров дня]')
      .replace(/\{stream_url\}/g, '🔗 [ссылка на эфир]')
      .replace(/\{gift_url\}/g, '🔗 [ссылка на подарок]')
      .replace(/\{gift_title\}/g, '[название подарка]')
      .replace(/\{gift_after_speech_title\}/g, '[подарок на эфире]')
      .replace(/\{gift_raffle_title\}/g, '[подарок для розыгрыша]')
      .replace(/\{speaker_name\}/g, '[Имя спикера]')
      .replace(/\{speaker_tg\}/g, '')
      .replace(/\{speaker_topic\}/g, '[тема]')
      .replace(/\{speaker_achievements\}/g, '')

    // Схлопываем 3+ пустых строки подряд
    out = out.replace(/\n{3,}/g, '\n\n')
    return out.trim()
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Шаблоны создаются автоматически. Отредактируйте тексты — плейсхолдеры вида{' '}
        <code className="text-xs bg-gray-100 rounded px-1">{'{speaker_name}'}</code> подставятся при отправке.
        Потом перейдите в «Очередь рассылок» и нажмите «Создать из программы».
      </p>

      {/* Памятка переменных */}
      <div className="mb-6 border border-gray-200 rounded-2xl overflow-hidden">
        <button
          onClick={() => setVarsOpen(v => !v)}
          className="w-full flex items-center justify-between px-5 py-3.5 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
        >
          <span className="text-sm font-medium text-gray-700">📋 Памятка по переменным</span>
          {varsOpen ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
        </button>
        {varsOpen && (
          <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            {ALL_VARIABLES.map(v => (
              <div key={v.name} className="flex items-baseline gap-2">
                <code className="text-xs bg-blue-50 text-blue-700 border border-blue-100 rounded px-1.5 py-0.5 font-mono shrink-0">{v.name}</code>
                <span className="text-xs text-gray-500">{v.desc}</span>
              </div>
            ))}
          </div>
        )}
      </div>

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
                <div className="flex gap-2 shrink-0">
                  {tpl && (
                    <button onClick={() => openPreview(tpl, def)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-gray-600 font-medium border border-gray-200 hover:bg-gray-50 transition-colors">
                      <Eye size={13} /> Просмотреть
                    </button>
                  )}
                  {tpl && (
                    <button onClick={() => openEdit(tpl)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-white font-medium"
                      style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                      <Edit2 size={13} /> Редактировать
                    </button>
                  )}
                </div>
              </div>

              {!tpl ? (
                <div className="py-8 text-center text-gray-400 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                  <Edit2 size={22} className="mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Шаблон ещё не создан — обновите страницу</p>
                </div>
              ) : (
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs text-gray-700 whitespace-pre-wrap font-mono mb-3 line-clamp-4">{tpl.text}</p>
                  <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                    {tpl.photo_url ? (
                      <span>📷 Своё фото</span>
                    ) : def.showPhoto ? (
                      <span className="text-blue-500">📸 Афиша подставится автоматически</span>
                    ) : null}
                    {tpl.button_text && <span>🔘 Кнопка: «{tpl.button_text}»</span>}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Модалка редактирования */}
      {editModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">Редактировать шаблон</h3>
              <button onClick={() => setEditModal(null)}><X size={18} /></button>
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
                    <span className="text-xs text-gray-400 mr-1">Вставить:</span>
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
                  Фото (URL) — если пусто, подставится афиша автоматически
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
              <button onClick={() => setEditModal(null)}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка предпросмотра */}
      {previewModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800 text-sm">Предпросмотр: {previewModal.def.title}</h3>
              <button onClick={() => setPreviewModal(null)}><X size={18} /></button>
            </div>

            {/* Выбор спикера для шаблонов со спикером */}
            {previewModal.def.hasSpeaker && speakers.length > 0 && (
              <div className="mb-4">
                <label className="text-xs text-gray-500 mb-1 block">Посмотреть как у спикера:</label>
                <select
                  value={previewSpeakerId ?? ''}
                  onChange={e => setPreviewSpeakerId(Number(e.target.value) || null)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white"
                >
                  <option value="">— без замены переменных —</option>
                  {speakers.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Имитация Telegram-сообщения */}
            <div className="bg-[#effdde] rounded-2xl rounded-tr-sm p-3 shadow-sm">
              {/* Фото — только для шаблонов с showPhoto */}
              {previewModal.def.showPhoto && (() => {
                const photoSrc = previewModal.tpl.photo_url || previewSpeaker?.poster_url
                return photoSrc ? (
                  <img
                    src={photoSrc}
                    alt=""
                    className="w-full rounded-xl mb-2"
                    style={{ maxHeight: '400px', objectFit: 'contain', background: '#f0f0f0' }}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <div className="w-full h-24 rounded-xl mb-2 flex items-center justify-center text-xs text-gray-400"
                    style={{ background: '#e8e8e8' }}>
                    📸 Афиша спикера
                  </div>
                )
              })()}
              <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                {renderPreviewText(
                  previewModal.tpl.text,
                  previewModal.def.hasSpeaker ? previewSpeaker : null,
                  previewModal.def.type
                )}
              </p>
              {previewModal.tpl.button_text && (
                <div className="mt-3">
                  <div className="w-full py-2 px-3 rounded-xl text-center text-sm font-medium text-blue-600 bg-white border border-gray-200">
                    {previewModal.tpl.button_text}
                  </div>
                </div>
              )}
            </div>

            <button onClick={() => setPreviewModal(null)}
              className="w-full mt-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
              Закрыть
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
