'use client'

/**
 * Ведение новостей платформы: список, черновик → публикация, рассылка.
 *
 * ⚠️ ОДИН компонент на две точки входа — админку `/admin/news` и кабинет
 * сервисного клиента `/dashboard/platform-news`. Второй копии быть не должно:
 * они разъедутся, и человек из поддержки будет работать не так, как владелец.
 *
 * ⚠️ Публикация и рассылка — РАЗНЫЕ действия, каждое со своим подтверждением.
 * Опубликованную с опечаткой новость можно снять с публикации, а разосланное
 * письмо не отзывается.
 */
import { useEffect, useState } from 'react'
import { Megaphone, Pencil, Trash2, Send, Mail, Eye, EyeOff } from 'lucide-react'
import { api } from '@/lib/api'
import HtmlTextArea from '@/components/HtmlTextArea'
import FileUploader from '@/components/FileUploader'
import SafeHtml from '@/components/SafeHtml'

const BRAND = '#25455D'

type News = {
  id: number
  title: string
  body: string
  image_url: string | null
  status: 'draft' | 'published' | 'archived'
  published_at: string | null
  mail_subject: string | null
  mail_body: string | null
  email_sent_at: string | null
  email_sent_count: number
  bot_sent_at: string | null
  bot_sent_count: number
  read_count: number
}

type Form = {
  title: string
  body: string
  image_url: string | null
  mail_subject: string
  mail_body: string
}

const EMPTY: Form = { title: '', body: '', image_url: null, mail_subject: '', mail_body: '' }

function fmt(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Moscow',
    })
  } catch { return '' }
}

export default function NewsManager() {
  const [list, setList] = useState<News[]>([])
  const [recipients, setRecipients] = useState({ email: 0, email_unsubscribed: 0 })
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<Form>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)

  function load() {
    api.platformNews.list()
      .then((r: any) => {
        setList(r?.news || [])
        setRecipients(r?.recipients || { email: 0, email_unsubscribed: 0 })
      })
      .catch((e: any) => alert(e?.message || 'Не удалось загрузить новости'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  function startCreate() {
    setForm(EMPTY)
    setEditingId('new')
  }

  function startEdit(n: News) {
    setForm({
      title: n.title,
      body: n.body || '',
      image_url: n.image_url,
      mail_subject: n.mail_subject || '',
      mail_body: n.mail_body || '',
    })
    setEditingId(n.id)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) { alert('Впишите заголовок новости'); return }
    setSaving(true)
    try {
      const payload = {
        title: form.title.trim(),
        body: form.body,
        image_url: form.image_url,
        mail_subject: form.mail_subject,
        mail_body: form.mail_body,
      }
      if (editingId === 'new') await api.platformNews.create(payload)
      else if (typeof editingId === 'number') await api.platformNews.update(editingId, payload)
      setEditingId(null)
      load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  async function togglePublish(n: News) {
    const publishing = n.status !== 'published'
    if (publishing) {
      const ok = confirm(
        `Опубликовать новость «${n.title}»?\n\n` +
        'Её сразу увидят ВСЕ клиенты платформы: плашкой вверху кабинета и в колокольчике. ' +
        'Отменить показ можно только сняв с публикации — кто уже увидел, тот увидел.'
      )
      if (!ok) return
    }
    setBusyId(n.id)
    try {
      await api.platformNews.update(n.id, { status: publishing ? 'published' : 'draft' })
      load()
    } catch (e: any) {
      alert(e?.message || 'Не получилось')
    } finally {
      setBusyId(null)
    }
  }

  async function sendEmail(n: News) {
    const again = n.email_sent_at
      ? `\n\n⚠️ Письмо по этой новости уже отправляли ${fmt(n.email_sent_at)} (${n.email_sent_count}). Отправить ЕЩЁ РАЗ?`
      : ''
    const ok = confirm(
      `Отправить новость «${n.title}» на почту клиентов?\n\n` +
      `Получат ${recipients.email} кабинетов.` +
      (recipients.email_unsubscribed ? ` Отписались от новостей: ${recipients.email_unsubscribed}.` : '') +
      '\n\nПисьмо нельзя отозвать.' + again
    )
    if (!ok) return
    setBusyId(n.id)
    try {
      await api.platformNews.sendEmail(n.id)
      alert('Рассылка запущена. Письма уходят с паузой — обновите список через пару минут, там будет итог.')
      load()
    } catch (e: any) {
      alert(e?.message || 'Не получилось запустить рассылку')
    } finally {
      setBusyId(null)
    }
  }

  async function sendBot(n: News) {
    const again = n.bot_sent_at
      ? `\n\n⚠️ В бот по этой новости уже отправляли ${fmt(n.bot_sent_at)} (${n.bot_sent_count}). Отправить ЕЩЁ РАЗ?`
      : ''
    const ok = confirm(
      `Отправить новость «${n.title}» в личку клиентам через @pluson_bot?\n\n` +
      'Дойдёт не всем: только тем, кто писал боту и у кого в кабинете указан ' +
      'ник Telegram. Сколько дошло — покажем после отправки.' + again
    )
    if (!ok) return
    setBusyId(n.id)
    try {
      await api.platformNews.sendBot(n.id)
      alert('Отправка запущена. Обновите список через пару минут — там будет итог.')
      load()
    } catch (e: any) {
      alert(e?.message || 'Не получилось запустить отправку')
    } finally {
      setBusyId(null)
    }
  }

  async function remove(n: News) {
    if (!confirm(`Удалить новость «${n.title}»? Это навсегда.`)) return
    try {
      await api.platformNews.delete(n.id)
      load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось удалить')
    }
  }

  return (
    <div className="pb-24 max-w-4xl">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg text-white"
               style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <Megaphone size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Новости ПЛЮСОНа</h1>
            <p className="text-sm text-gray-500 mt-1">
              Опубликованную новость видят все клиенты: плашкой вверху кабинета и в колокольчике.
              Рассылка на почту и в бот — отдельными кнопками.
            </p>
          </div>
        </div>
        {editingId === null && (
          <button onClick={startCreate} className="btn-gold px-4 py-2.5 rounded-xl text-sm font-semibold shrink-0">
            + Новость
          </button>
        )}
      </div>

      {editingId !== null && (
        <form onSubmit={save} className="mb-6 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
          <div>
            <label className="block text-sm font-semibold mb-1" style={{ color: BRAND }}>Заголовок</label>
            <input
              value={form.title}
              onChange={e => setForm({ ...form, title: e.target.value })}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-1" style={{ color: BRAND }}>Текст</label>
            <HtmlTextArea
              value={form.body}
              onChange={v => setForm({ ...form, body: v })}
              rows={6}
            />
            <div className="mt-1 text-xs text-gray-500">
              Ссылки можно просто вставить адресом — они станут кликабельными сами.
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-1" style={{ color: BRAND }}>
              Картинка <span className="font-normal text-gray-500">— необязательно</span>
            </label>
            <FileUploader
              mode="single"
              kind="news_media"
              value={form.image_url}
              onChange={url => setForm({ ...form, image_url: url })}
              aspectClass="aspect-video"
              emptyText="Перетащите картинку сюда"
            />
            <div className="mt-1 text-xs text-gray-500">
              Видна на странице новостей и в письме. В плашку и колокольчик не помещается —
              там только заголовок и текст.
            </div>
          </div>

          <div className="rounded-xl bg-gray-50 border border-gray-200 p-4 space-y-3">
            <div className="text-sm font-semibold" style={{ color: BRAND }}>Текст для рассылки</div>
            <div className="text-xs text-gray-500 -mt-2">
              Оставьте пустым — уйдёт то же, что в новости. Заполните, если в письме нужна
              другая формулировка.
            </div>
            <input
              value={form.mail_subject}
              onChange={e => setForm({ ...form, mail_subject: e.target.value })}
              placeholder="Тема письма"
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm"
            />
            <HtmlTextArea
              value={form.mail_body}
              onChange={v => setForm({ ...form, mail_body: v })}
              rows={4}
            />
          </div>

          <div className="flex gap-2">
            <button type="submit" disabled={saving}
                    className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50">
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
            <button type="button" onClick={() => setEditingId(null)}
                    className="px-5 py-2.5 rounded-xl text-sm font-semibold border border-gray-300 text-gray-600">
              Отмена
            </button>
          </div>
          {editingId === 'new' && (
            <div className="text-xs text-gray-500">
              Новость создаётся черновиком — клиенты её не видят. Опубликовать можно после сохранения.
            </div>
          )}
        </form>
      )}

      {loading && <div className="text-sm text-gray-400">Загружаем…</div>}

      {!loading && list.length === 0 && editingId === null && (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-center text-gray-500">
          Новостей пока нет. Нажмите «+ Новость», чтобы написать первую.
        </div>
      )}

      <div className="space-y-3">
        {list.map(n => {
          const published = n.status === 'published'
          return (
            <div key={n.id} className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                      published ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                      {published ? 'Опубликована' : n.status === 'archived' ? 'В архиве' : 'Черновик'}
                    </span>
                    {published && n.published_at && (
                      <span className="text-xs text-gray-400">{fmt(n.published_at)}</span>
                    )}
                    {published && (
                      <span className="text-xs text-gray-400">· прочитали {n.read_count}</span>
                    )}
                  </div>
                  <div className="font-bold mt-1.5" style={{ color: BRAND }}>{n.title}</div>
                  {n.body && (
                    <SafeHtml html={n.body} className="mt-1 text-sm text-gray-600 line-clamp-3" />
                  )}
                  <div className="mt-2 text-xs text-gray-500 space-y-0.5">
                    {n.email_sent_at && <div>Почта: {fmt(n.email_sent_at)} — {n.email_sent_count}</div>}
                    {n.bot_sent_at && <div>Бот: {fmt(n.bot_sent_at)} — {n.bot_sent_count}</div>}
                  </div>
                </div>
                {n.image_url && (
                  <img src={n.image_url} alt="" className="w-24 h-16 object-cover rounded-lg shrink-0" />
                )}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => togglePublish(n)}
                  disabled={busyId === n.id}
                  className={`px-3 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-1.5
                              disabled:opacity-50 ${published
                                ? 'border border-gray-300 text-gray-600'
                                : 'btn-gold'}`}
                >
                  {published ? <><EyeOff size={15} /> Снять с публикации</> : <><Eye size={15} /> Опубликовать</>}
                </button>

                {published && (
                  <>
                    <button onClick={() => sendEmail(n)} disabled={busyId === n.id}
                            className="px-3 py-2 rounded-lg text-sm font-semibold border border-gray-300
                                       text-gray-700 inline-flex items-center gap-1.5 disabled:opacity-50">
                      <Mail size={15} /> На почту
                    </button>
                    <button onClick={() => sendBot(n)} disabled={busyId === n.id}
                            className="px-3 py-2 rounded-lg text-sm font-semibold border border-gray-300
                                       text-gray-700 inline-flex items-center gap-1.5 disabled:opacity-50">
                      <Send size={15} /> В бот
                    </button>
                  </>
                )}

                <button onClick={() => startEdit(n)}
                        className="px-3 py-2 rounded-lg text-sm border border-gray-300 text-gray-600
                                   inline-flex items-center gap-1.5">
                  <Pencil size={15} /> Изменить
                </button>
                <button onClick={() => remove(n)}
                        className="px-3 py-2 rounded-lg text-sm border border-red-200 text-red-600
                                   inline-flex items-center gap-1.5">
                  <Trash2 size={15} /> Удалить
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
