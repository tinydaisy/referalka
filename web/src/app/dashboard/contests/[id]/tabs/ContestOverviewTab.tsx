'use client'
import { useState } from 'react'
import { Save } from 'lucide-react'
import { api } from '@/lib/api'
import PublicLinks from '@/components/PublicLinks'
import SharePreviewField from '@/components/SharePreviewField'

export default function ContestOverviewTab({
  event, eventId, onReload,
}: {
  event: any
  eventId: number
  onReload: () => Promise<void>
}) {
  const [title, setTitle] = useState(event.title || '')
  const [description, setDescription] = useState(event.description || '')
  const [descriptionPostRegister, setDescriptionPostRegister] = useState(event.description_post_register || '')
  // Подпись карточки события в мессенджере (мигр. 503). Пусто → умолчание.
  const [sharePreviewText, setSharePreviewText] = useState(event.share_preview_text || '')
  // «Ссылка на голосование» сохраняется в events.landing_url — это сторонний
  // лендинг голосования (у конкурса нет вебинарной комнаты). Mini App в режиме
  // контеста показывает её плиткой «Перейти к голосованию».
  const [votingUrl, setVotingUrl] = useState(event.landing_url || '')
  const [startAt, setStartAt] = useState(toLocalInput(event.start_at))
  const [endAt, setEndAt] = useState(toLocalInput(event.end_at))
  // Текст кнопки на встроенном лендинге (миграция 212). Пусто → «КАК ГОЛОСОВАТЬ?».
  const [landingCtaLabel, setLandingCtaLabel] = useState(event.landing_cta_label || '')
  // Дубль кнопки под описанием (миграция 314): длинный текст уводит верхнюю кнопку за экран.
  const [landingCtaRepeat, setLandingCtaRepeat] = useState<boolean>(!!event.landing_cta_repeat)
  // Регистрация без формы: TRUE (дефолт у конкурсов) → клик по кнопке сразу
  // заводит участника по Telegram-аккаунту. FALSE → показывается форма контактов.
  const [skipContactForm, setSkipContactForm] = useState<boolean>(!!event.skip_contact_form)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function toLocalInput(iso: string | null | undefined) {
    if (!iso) return ''
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  async function handleSave() {
    setSaving(true); setErr(null)
    try {
      const payload: any = {}
      const t = title.trim()
      if (t !== (event.title || ''))                            payload.title = t || null
      const d = description.trim()
      if (d !== (event.description || ''))                      payload.description = d || null
      const dpr = descriptionPostRegister.trim()
      if (dpr !== (event.description_post_register || ''))      payload.description_post_register = dpr || null
      const spt = sharePreviewText.trim()
      if (spt !== (event.share_preview_text || ''))             payload.share_preview_text = spt || null
      const v = votingUrl.trim()
      if (v !== (event.landing_url || ''))                      payload.landing_url = v || null
      const startIso = startAt ? new Date(startAt).toISOString() : null
      const eventStartIso = event.start_at ? new Date(event.start_at).toISOString() : null
      if (startIso !== eventStartIso)                           payload.start_at = startIso
      const endIso = endAt ? new Date(endAt).toISOString() : null
      const eventEndIso = event.end_at ? new Date(event.end_at).toISOString() : null
      if (endIso !== eventEndIso)                               payload.end_at = endIso
      const lcl = landingCtaLabel.trim()
      if (lcl !== (event.landing_cta_label || ''))              payload.landing_cta_label = lcl || null
      if (landingCtaRepeat !== !!event.landing_cta_repeat)      payload.landing_cta_repeat = landingCtaRepeat
      if (skipContactForm !== !!event.skip_contact_form)        payload.skip_contact_form = skipContactForm

      if (Object.keys(payload).length === 0) {
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 1800)
        return
      }
      await api.events.update(eventId, payload)
      await onReload()
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1800)
    } catch (e: any) {
      setErr(e.message || 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* 1) ПАРАМЕТРЫ */}
      <div className="bg-white rounded-2xl border card-border p-6">
        <h2 className="block-title mb-4">Параметры конкурса</h2>

        <div className="space-y-4">
          <Field label="Название конкурса">
            <input value={title} onChange={e => setTitle(e.target.value)}
                   className="input" placeholder="Премия Forbes Woman" />
          </Field>

          <Field
            label="Описание для лендинга"
            hint={'Продающий текст. Показывается на лендинге конкурса (веб-странице и в Mini App до регистрации). Можно использовать HTML: <b>, <i>, <a href="...">, <br>, <ul><li>, <h3>.'}
          >
            <textarea value={description} onChange={e => setDescription(e.target.value)}
                      rows={4} className="input"
                      placeholder="Расскажите голосующему о конкурсе — пара предложений. Поддерживается HTML." />
          </Field>

          <Field
            label="Описание после регистрации"
            hint={'Инструкция: как именно проголосовать. Показывается в Mini App на вкладке «Программа» под кнопками голосования и чата. Можно использовать HTML: <b>, <i>, <a>, <br>, <ul><li>. В простом тексте ссылки http(s) кликабельны автоматически.'}
          >
            <textarea value={descriptionPostRegister} onChange={e => setDescriptionPostRegister(e.target.value)}
                      rows={5} className="input"
                      placeholder="1) Перейдите на сайт премии 2) Найдите номинацию … 3) Нажмите ПРОГОЛОСОВАТЬ …" />
          </Field>

          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Старт голосования">
              <input type="datetime-local" value={startAt} onChange={e => setStartAt(e.target.value)}
                     className="input" />
            </Field>
            <Field label="Окончание голосования">
              <input type="datetime-local" value={endAt} onChange={e => setEndAt(e.target.value)}
                     className="input" />
            </Field>
          </div>
        </div>
      </div>

      {/* 2) НАСТРОЙКИ СТРАНИЦЫ РЕГИСТРАЦИИ */}
      <div className="bg-white rounded-2xl border card-border p-6 space-y-5">
        <h2 className="block-title">Настройки страницы регистрации</h2>

        <Field
          label="Текст кнопки на лендинге"
          hint="Главная кнопка на лендинге конкурса. Пусто — будет «КАК ГОЛОСОВАТЬ?»."
        >
          <input value={landingCtaLabel} onChange={e => setLandingCtaLabel(e.target.value)}
                 className="input" maxLength={40} placeholder="КАК ГОЛОСОВАТЬ?" />
        </Field>

        {/* ⚠️ Кнопка дублируется ПОД описанием, а не заменяет верхнюю: у длинного
            описания верхняя кнопка уезжает за экран, и человек, дочитавший до
            конца, остаётся без действия. */}
        <label
          className={`flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
            landingCtaRepeat
              ? 'border-[#25455D] bg-[#25455D]/5'
              : 'border-gray-200 hover:border-gray-300'
          }`}>
          <input type="checkbox" checked={landingCtaRepeat}
            onChange={(e) => setLandingCtaRepeat(e.target.checked)}
            className="mt-0.5 accent-[#25455D]" />
          <div>
            <p className="text-sm font-medium text-gray-900">
              Повторить кнопку под описанием
            </p>
            <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
              При длинном описании кнопка вверху уезжает — дочитавший не увидит,
              что делать дальше.
            </p>
          </div>
        </label>

        <label
          className={`flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
            skipContactForm
              ? 'border-[#25455D] bg-[#25455D]/5'
              : 'border-gray-200 hover:border-gray-300'
          }`}>
          <input type="checkbox" checked={skipContactForm}
            onChange={(e) => setSkipContactForm(e.target.checked)}
            className="mt-0.5 accent-[#25455D]" />
          <div>
            <p className="text-sm font-medium text-gray-900">
              Регистрировать без ввода контактных данных
            </p>
            <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
              Включено — клик по кнопке на лендинге сразу пускает человека в кабинет:
              участник создаётся по Telegram-аккаунту, без формы с именем, email и телефоном.
              Выключено — сначала показывается форма контактов.
            </p>
          </div>
        </label>
      </div>

      {/* 3) ССЫЛКИ — всё остальное, что раньше лежало в «Описании» */}
      <div className="bg-white rounded-2xl border card-border p-6">
        <h2 className="block-title mb-4">Ссылки</h2>

        <div className="space-y-4">
          <Field label="Ссылка на голосование" hint="Появится плиткой «Перейти к голосованию» в Mini App.">
            <input value={votingUrl} onChange={e => setVotingUrl(e.target.value)}
                   className="input" placeholder="https://forbes.ru/vote/..." />
          </Field>
        </div>
      </div>

      {/* Карточка ссылки в мессенджере (мигр. 503) — вплотную к публичным
          ссылкам: человек копирует ссылку и тут же видит, как она будет
          выглядеть в чате. */}
      <div className="bg-white rounded-2xl border card-border p-6">
        <SharePreviewField
          value={sharePreviewText}
          onChange={setSharePreviewText}
          title={title || event.title}
          startAt={event.start_at}
          posterUrl={event?.share_poster_url || event?.poster_url}
        />
      </div>

      {/* 4) ПУБЛИЧНЫЕ ССЫЛКИ — выбор типа сохраняется общей кнопкой ниже */}
      <PublicLinks
        slug={event?.slug}
        eventId={eventId}
        onSlugSaved={onReload}
        eventStatus={event?.status}
        disabledPlatforms={event?.disabled_platforms || []}
      />

      {/* Save bar — в самом низу страницы */}
      {err && <div className="text-sm text-red-600">{err}</div>}
      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving}
                className="flex items-center gap-2 px-5 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <Save size={16} />
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </button>
        {savedFlash && <span className="text-sm text-green-600">Сохранено ✓</span>}
      </div>

      <style jsx>{`
        .input {
          width: 100%;
          padding: 0.5rem 0.75rem;
          border: 1px solid #d1d5db;
          border-radius: 0.5rem;
          font-size: 0.875rem;
          outline: none;
        }
        .input:focus {
          border-color: #25455D;
          box-shadow: 0 0 0 3px rgba(37, 69, 93, 0.1);
        }
        .block-title {
          font-size: 0.875rem;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #25455D;
        }
      `}</style>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  )
}
