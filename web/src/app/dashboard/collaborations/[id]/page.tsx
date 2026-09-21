'use client'
import { useState, useEffect, useRef } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import { CharCount, overClass, POSITIONING_LIMIT, useAchLimit } from '@/components/FieldLimits'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, ExternalLink, Check, AlertTriangle, X, Mail, Phone, User as UserIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'
import { ImageThumb } from '@/components/ImagePreview'
import FileUploader from '@/components/FileUploader'
import FocalPointPicker from '@/components/FocalPointPicker'
import { TelegramChannelField } from '@/components/TelegramChannelField'
import MediaAssetsField, { MediaAsset } from '@/components/MediaAssetsField'
import { validateSocialLinks } from '@/lib/validateSocialLinks'
import CollaboratorPostersField from '@/components/CollaboratorPostersField'

const IMPORTANT_FIELDS: { key: string; label: string }[] = [
  { key: 'name', label: 'Имя и фамилия' },
  { key: 'title', label: 'Должность / специализация' },
  { key: 'achievements', label: 'Регалии' },
  { key: 'photo_url', label: 'Фото' },
  // poster_url — теперь библиотека из 0..N афиш. Признак «заполнено» = есть
  // хоть одна афиша. Backend отдаёт posters_count в _COLLAB_SELECT.
  { key: 'posters_count', label: 'Афиша' },
  { key: 'tg_channel_url', label: 'Ссылка на Telegram-канал' },
  { key: 'tg_channel_id', label: 'ID канала' },
  { key: 'personal_tg_id', label: 'ID личного аккаунта' },
  { key: 'personal_tg_username', label: 'Ник личного аккаунта' },
]

function getMissingFields(form: any): string[] {
  return IMPORTANT_FIELDS
    .filter(f => {
      const v = form[f.key]
      if (Array.isArray(v)) return v.length === 0
      if (typeof v === 'number') return v <= 0
      return !v || String(v).trim() === ''
    })
    .map(f => f.label)
}

function WarningPopup({ missing, onClose }: { missing: string[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])
  return (
    <div ref={ref} className="absolute right-0 top-full mt-2 z-50 bg-white border border-amber-200 rounded-2xl shadow-lg p-4 w-72">
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold text-sm text-gray-900">Не заполнены важные поля</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-0.5 rounded"><X size={14} /></button>
      </div>
      <ul className="space-y-1.5">
        {missing.map(label => (
          <li key={label} className="flex items-center gap-2 text-sm text-gray-700">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function CollaborationPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const { t } = useLang()
  const collaboratorId = parseInt(params.id)
  // ⚠️ Лимит регалий — настройка КЛИЕНТА (миграция 420), а не константа:
  // счётчик обязан показывать то, по чему потом откажет сохранение.
  const ACHIEVEMENTS_LIMIT = useAchLimit()
  const [form, setForm] = useState<any>(null)
  const [achievementsText, setAchievementsText] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [showWarning, setShowWarning] = useState(false)
  const [chanTab, setChanTab] = useUrlTab<'telegram' | 'vk' | 'max'>('chan', 'telegram', ['telegram', 'vk', 'max'])

  useEffect(() => {
    api.collaborators.get(collaboratorId)
      .then(r => {
        // ⚠️ В `name` из API лежит «Фамилия Имя» (для списков поиска).
        // В ФОРМУ кладём чистое имя из first_name, иначе клиент увидит склейку.
        setForm({ ...r.collaborator, name: r.collaborator.first_name ?? r.collaborator.name })
        const ach = r.collaborator.achievements
        setAchievementsText(Array.isArray(ach) ? ach.join('\n') : (ach || ''))
      })
      .catch(() => router.push('/dashboard/collaborations'))
      .finally(() => setLoading(false))
  }, [collaboratorId])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f: any) => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // Соцсети — только полной ссылкой (https://…), не ником.
    const socialErr = validateSocialLinks([
      ['Telegram-канал', form.tg_channel_url],
      ['ВКонтакте', form.vk_url],
      ['MAX', form.max_url],
      ['Нельзяграм', form.instagram_url],
      ['Сайт', form.website_url],
    ])
    if (socialErr) { setError(socialErr); return }
    setSaving(true); setError(''); setSaved(false)
    try {
      if ((form.title || '').length > POSITIONING_LIMIT) {
        alert(`Позиционирование слишком длинное — сократите на ${(form.title || '').length - POSITIONING_LIMIT} символов`)
        return
      }
      if (achievementsText.length > ACHIEVEMENTS_LIMIT) {
        alert(`Регалии слишком длинные — сократите на ${achievementsText.length - ACHIEVEMENTS_LIMIT} символов`)
        return
      }
      const achievements = achievementsText
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
      const updates = {
        name: form.name,
        last_name: form.last_name || null,
        // ⚠️ Явный вид карточки (миграция 425). По умолчанию в форме галочка
        // стоит, поэтому у новых карточек партнёров сразу верный показ.
        is_company: form.is_company !== false,
        title: form.title,
        achievements,
        photo_url: form.photo_url,
        cutout_photo_url: form.cutout_photo_url ?? '',
        // Точки лица (миграция 434) — у каждого фото своя.
        photo_focal: form.photo_focal ?? null,
        cutout_photo_focal: form.cutout_photo_focal ?? null,
        // Логотип компании для светлого фона (миграция 450).
        logo_on_light_url: form.logo_on_light_url ?? null,
        // Приближение кадра по формам (миграция 451).
        crop_zoom_circle: form.crop_zoom_circle ?? null,
        crop_zoom_square: form.crop_zoom_square ?? null,
        crop_zoom_portrait: form.crop_zoom_portrait ?? null,
        crop_dx_circle: form.crop_dx_circle ?? null,
        crop_dy_circle: form.crop_dy_circle ?? null,
        crop_dx_square: form.crop_dx_square ?? null,
        crop_dy_square: form.crop_dy_square ?? null,
        crop_dx_portrait: form.crop_dx_portrait ?? null,
        crop_dy_portrait: form.crop_dy_portrait ?? null,
        photo_folder_url: form.photo_folder_url,
        video_folder_url: form.video_folder_url,
        video_url: form.video_url || null,
        tg_channel_url: form.tg_channel_url,
        instagram_url: form.instagram_url,
        website_url: form.website_url,
        tg_channel_id: form.tg_channel_id,
        vk_url: form.vk_url ?? '',
        max_url: form.max_url ?? '',
        vk_channel_id: form.vk_channel_id ?? '',
        max_channel_id: form.max_channel_id ?? '',
        personal_tg_id: form.personal_tg_id,
        personal_tg_username: form.personal_tg_username,
        assistant_tg_username: form.assistant_tg_username,
        media_assets: Array.isArray(form.media_assets) ? form.media_assets : [],
      }
      await api.collaborators.update(collaboratorId, updates)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-brand rounded-full border-t-transparent animate-spin" />
      </div>
    )
  }
  if (!form) return null

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-8">
        <Link href="/dashboard/collaborations" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex items-center gap-3 flex-1">
          {form.photo_url && (
            <ImageThumb url={form.photo_url} alt={form.name} focal={form.photo_focal ?? null} />
          )}
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{[form.name, form.last_name].filter(Boolean).join(' ')}</h1>
            {form.title && <p className="text-gray-500 text-sm">{form.title}</p>}
            {form.contact_id && (
              <Link
                href={`/dashboard/clients?contact=${form.contact_id}`}
                className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline mt-1"
              >
                <UserIcon size={11} />
                <span>Карточка контакта</span>
                <ExternalLink size={10} />
              </Link>
            )}
          </div>
        </div>
        {(() => {
          const missing = getMissingFields(form)
          if (missing.length === 0) return null
          return (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowWarning(v => !v)}
                className="p-2 rounded-xl hover:bg-amber-50 transition-colors"
                title="Не заполнены важные поля"
              >
                <AlertTriangle size={20} className="text-amber-400" />
              </button>
              {showWarning && (
                <WarningPopup missing={missing} onClose={() => setShowWarning(false)} />
              )}
            </div>
          )
        })()}
      </div>

      {/* Вырезка на прозрачном фоне (миграция 362).
          ⚠️ Это ЗАГОТОВКА для афиш, а не готовая картинка — потому и отдельно
          от «Фото для сайта» и от библиотеки афиш. Стоит выше остального:
          макеты собираются из неё, и искать её среди полей формы неудобно.
          ⚠️ Шахматка под картинкой — чтобы прозрачность было ВИДНО: на белом
          фоне вырезка и обычное фото с белой заливкой выглядят одинаково, и
          подменённый JPEG обнаружился бы только в готовой афише. */}
      <div className="mb-6 bg-white rounded-2xl border card-border shadow-sm p-6">
        <h2 className="font-semibold text-gray-900 mb-1">Фото на прозрачном фоне</h2>
        <p className="text-xs text-gray-500 mb-3">
          Вырезка человека без фона — из неё собираются афиши. Нужен <b>PNG</b> с
          прозрачностью: JPEG её не хранит, и вместо фигуры в афишу попадёт белый
          прямоугольник. Клетка под картинкой — это фон страницы, он виден сквозь
          прозрачные места.
        </p>
        <div className="cutout-checker rounded-xl">
          <FileUploader
            mode="single"
            kind="speaker_cutout"
            collaboratorId={collaboratorId}
            value={form.cutout_photo_url || null}
            onChange={u => {
              setForm((f: any) => ({ ...f, cutout_photo_url: u || '' }))
              // ⚠️ Сохраняем СРАЗУ: блок стоит выше формы и её кнопки
              // «Сохранить». Человек загрузил вырезку, увидел её на месте и
              // ушёл со страницы — без этого файл остался бы в хранилище,
              // а поле в базе пустым.
              api.collaborators.update(collaboratorId, { cutout_photo_url: u || '' })
                 .catch((e: any) => setError(e?.message || 'Не удалось сохранить фото'))
            }}
            accept="image/png,image/webp"
            aspectClass="aspect-square"
            emptyText="Перетащите сюда PNG без фона"
            buttonLabel="Загрузить"
          />
        </div>
        {/* Точка лица на ВЫРЕЗКЕ (миграция 434) — своя, отдельно от основного
            фото: вырезка кадрирована иначе, человек на ней обычно в полный рост. */}
        {form.cutout_photo_url && (
          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Где лицо на вырезке</label>
            <FocalPointPicker
              url={form.cutout_photo_url}
              value={form.cutout_photo_focal ?? null}
              onChange={v => {
                setForm((f: any) => ({ ...f, cutout_photo_focal: v }))
                // Сохраняем сразу — по той же причине, что и саму вырезку:
                // блок стоит выше кнопки «Сохранить».
                api.collaborators.update(collaboratorId, { cutout_photo_focal: v || '' })
                   .catch((e: any) => setError(e?.message || 'Не удалось сохранить точку'))
              }}
              hint="Нужна, когда вырезка встаёт в рамку — в карточках и афишах с масками."
            />
          </div>
        )}
        {/* ⚠️ Стиль шахматки переехал в globals.css: тот же блок вырезки есть
            и в профиле спикера, открытом из конференции. Две копии разъехались
            бы при первой правке. */}
      </div>

      {/* Привязка к контакту в общей базе — коллаб = расширение контакта (миграция 086) */}
      {form.contact_id && (
        <div className="mb-6 bg-blue-50 border border-blue-200 rounded-2xl p-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="text-xs font-semibold text-blue-900 uppercase tracking-wide">
              Контакт в общей базе
            </div>
            <Link href={`/dashboard/clients?contact=${form.contact_id}`}
                  className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline shrink-0">
              Открыть карточку <ExternalLink size={11} />
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span className="inline-flex items-center gap-1.5 text-gray-800">
              <UserIcon size={14} className="text-blue-600" />
              <span>{form.contact_name || form.name}</span>
            </span>
            {form.contact_email ? (
              <a href={`mailto:${form.contact_email}`}
                 className="inline-flex items-center gap-1.5 text-gray-800 hover:text-blue-700">
                <Mail size={14} className="text-blue-600" />
                <span className="break-all">{form.contact_email}</span>
              </a>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-gray-400 italic">
                <Mail size={14} /> email не заполнен
              </span>
            )}
            {form.contact_phone ? (
              <a href={`tel:${form.contact_phone}`}
                 className="inline-flex items-center gap-1.5 text-gray-800 hover:text-blue-700">
                <Phone size={14} className="text-blue-600" />
                <span>{form.contact_phone}</span>
              </a>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-gray-400 italic">
                <Phone size={14} /> телефон не заполнен
              </span>
            )}
          </div>
          <p className="text-[11px] text-blue-700 mt-2">
            Email и телефон редактируются в карточке контакта (раздел «Контакты»). Здесь только просмотр.
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.basicInfo}</h2>
          {/* Имя и фамилия — РАЗНЫЕ поля (миграция 302): по фамилии сортируются
              списки людей, из одной строки её достоверно не вытащить.
              Пустая фамилия — норма: у компаний и партнёров-организаций её нет. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Имя</label>
              <input type="text" value={form.name || ''} onChange={set('name')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Фамилия</label>
              {/* ⚠️ Подсказки «у компании оставьте пустым» больше НЕТ: вид
                  карточки решает галочка ниже, а не фамилия (миграция 425).
                  Прежняя подсказка обманывала — заполненная фамилия у бренда
                  ломала показ логотипа. */}
              <input type="text" value={form.last_name || ''} onChange={set('last_name')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>

          {/* Вид карточки на лендинге: логотип целиком на белом (компания)
              или фото квадратом (человек). */}
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-gray-200 p-3">
            <input
              type="checkbox"
              checked={form.is_company !== false}
              onChange={e => setForm((f: any) => ({ ...f, is_company: e.target.checked }))}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
            />
            <span className="text-sm">
              <span className="font-medium text-gray-700">Компания</span>
              <span className="mt-0.5 block text-xs text-gray-500">
                Уберите галочку, если ваш партнёр — человек. У компании логотип
                показывается целиком на белом поле, у человека — фото квадратом,
                как у спикеров.
              </span>
            </span>
          </label>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.position}</label>
            <input type="text" value={form.title || ''} onChange={set('title')}
              className={`w-full px-4 py-2.5 rounded-xl border text-sm focus:outline-none focus:border-brand ${overClass(form.title || '', POSITIONING_LIMIT) || 'border-gray-200'}`} />
            <CharCount value={form.title || ''} limit={POSITIONING_LIMIT} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.achievements}</label>
            <textarea value={achievementsText} onChange={e => setAchievementsText(e.target.value)} rows={5}
              placeholder={'Регалия 1\nРегалия 2\nРегалия 3'}
              className={`w-full px-4 py-2.5 rounded-xl border text-sm focus:outline-none focus:border-brand resize-y ${overClass(achievementsText, ACHIEVEMENTS_LIMIT) || 'border-gray-200'}`} />
            <CharCount value={achievementsText} limit={ACHIEVEMENTS_LIMIT} />
          </div>
        </div>

        <div className="bg-white rounded-2xl border card-border shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.media}</h2>
          {/* ⚠️⚠️ У КОМПАНИИ — ДВА ЛОГОТИПА, у человека — фото (миграция 450).
              Раньше поле было одно, и на афише переключатель «для тёмного /
              для светлого фона» партнёров не касался вовсе: брать было нечего,
              все логотипы оставались светлыми и на белом фоне пропадали. */}
          {form.is_company !== false ? (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Логотип для ТЁМНОГО фона
                </label>
                <p className="text-xs text-gray-500 mb-2">
                  Знак для афиш на тёмном фоне. Обычно светлый или цветной.
                </p>
                <FileUploader
                  mode="single"
                  kind="speaker_photo"
                  collaboratorId={collaboratorId}
                  value={form.photo_url || null}
                  onChange={u => setForm((f: any) => ({ ...f, photo_url: u || '' }))}
                  accept="image/*"
                  aspectClass="aspect-video"
                  emptyText="Перетащите сюда логотип"
                  buttonLabel="Загрузить"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Логотип для СВЕТЛОГО фона
                </label>
                <p className="text-xs text-gray-500 mb-2">
                  Тёмная версия того же знака. Не загрузите — на светлой афише возьмётся
                  тот, что для тёмного фона, и он может слиться с фоном.
                </p>
                <FileUploader
                  mode="single"
                  kind="speaker_photo"
                  collaboratorId={collaboratorId}
                  value={form.logo_on_light_url || null}
                  onChange={u => setForm((f: any) => ({ ...f, logo_on_light_url: u || '' }))}
                  accept="image/*"
                  aspectClass="aspect-video"
                  emptyText="Перетащите сюда логотип"
                  buttonLabel="Загрузить"
                />
              </div>
            </>
          ) : (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Фото для сайта</label>
            <FileUploader
              mode="single"
              kind="speaker_photo"
              collaboratorId={collaboratorId}
              value={form.photo_url || null}
              onChange={u => setForm((f: any) => ({ ...f, photo_url: u || '' }))}
              accept="image/*"
              aspectClass="aspect-square"
              emptyText="Перетащите сюда фото"
              buttonLabel="Загрузить"
            />
            {/* Точка лица (миграция 434): по ней кадрируются все миниатюры —
                на сайте, в Mini App и на афишах. ⚠️ Только у ЧЕЛОВЕКА: у
                логотипа лицо не ищут, он показывается целиком. */}
            {form.photo_url && (
              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">Где лицо на фото</label>
                <FocalPointPicker
                  url={form.photo_url}
                  value={form.photo_focal ?? null}
                  onChange={v => setForm((f: any) => ({ ...f, photo_focal: v }))}
                  zooms={form}
                  onZoomChange={z => setForm((f: any) => ({ ...f, ...z }))}
                  hint="Эти настройки берёт афиша: круглая, квадратная и прямоугольная маски встанут ровно так, как видно здесь."
                />
              </div>
            )}
          </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Афиши (библиотека)</label>
            <CollaboratorPostersField collaboratorId={collaboratorId} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Индивидуальное видео</label>
            <p className="text-xs text-gray-400 mb-2">
              Один файл (mp4/webm/mov, до 100 МБ) — будет доступен на скачивание этому спикеру в его кабинете во вкладке «Материалы».
            </p>
            <FileUploader
              mode="single"
              kind="speaker_video"
              collaboratorId={collaboratorId}
              value={form.video_url || null}
              onChange={u => setForm((f: any) => ({ ...f, video_url: u || '' }))}
              accept="video/*"
              aspectClass="aspect-video"
              emptyText="Видео не загружено"
              buttonLabel="Загрузить видео"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.photoFolder}</label>
              <input type="url" value={form.photo_folder_url || ''} onChange={set('photo_folder_url')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.videoFolder}</label>
              <input type="url" value={form.video_folder_url || ''} onChange={set('video_folder_url')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border card-border shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.contacts}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.instagram}</label>
            <input type="url" value={form.instagram_url || ''} onChange={set('instagram_url')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.website}</label>
            <input type="url" value={form.website_url || ''} onChange={set('website_url')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border card-border shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">Медийные активы</h2>
          <MediaAssetsField
            value={Array.isArray(form.media_assets) ? form.media_assets as MediaAsset[] : []}
            onChange={next => setForm((f: any) => ({ ...f, media_assets: next }))}
          />
        </div>

        <div className="bg-white rounded-2xl border card-border shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.accounts}</h2>
          <p className="text-sm text-gray-500 -mt-1">Каналы коллаборатора для проверки подписки при входе в чат события.</p>

          {/* Вкладки площадок */}
          <div className="flex gap-1 border-b border-gray-200">
            {([
              { k: 'telegram', label: 'Telegram' },
              { k: 'vk', label: 'VK' },
              { k: 'max', label: 'MAX' },
            ] as const).map(tt => (
              <button
                key={tt.k}
                type="button"
                onClick={() => setChanTab(tt.k)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  chanTab === tt.k
                    ? 'border-[#25455D] text-[#25455D]'
                    : 'border-transparent text-gray-400 hover:text-gray-600'
                }`}
              >
                {tt.label}
                {((tt.k === 'telegram' && form.tg_channel_url) ||
                  (tt.k === 'vk' && form.vk_url) ||
                  (tt.k === 'max' && form.max_url)) && (
                  <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 align-middle" />
                )}
              </button>
            ))}
          </div>

          {chanTab === 'telegram' && (
            <TelegramChannelField
              title="Telegram канал коллаборатора"
              mode="single"
              value={{ url: form.tg_channel_url || '', chatId: form.tg_channel_id || '' }}
              onChange={(next) => setForm((f: any) => ({ ...f, tg_channel_url: next.url, tg_channel_id: next.chatId }))}
            />
          )}

          {chanTab === 'vk' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Ссылка на VK-сообщество</label>
              <input type="url" value={form.vk_url || ''} onChange={set('vk_url')}
                placeholder="https://vk.com/club..."
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
              <p className="text-xs text-gray-500 mt-1">ID сообщества для проверки подписки определится автоматически при сохранении.{form.vk_channel_id ? ` Сейчас: ${form.vk_channel_id}` : ''}</p>
            </div>
          )}

          {chanTab === 'max' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Ссылка на MAX-канал</label>
              <input type="url" value={form.max_url || ''} onChange={set('max_url')}
                placeholder="https://max.ru/..."
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
              <label className="block text-sm font-medium text-gray-700 mb-1.5 mt-3">ID MAX-канала (для проверки подписки)</label>
              <input type="text" value={form.max_channel_id || ''} onChange={set('max_channel_id')}
                placeholder="-71606981728842"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
              <p className="text-xs text-gray-500 mt-1">MAX не отдаёт ID по ссылке — впишите вручную. Бот должен быть админом канала, иначе проверка подписки не сработает.</p>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.personalAccountId}</label>
            <input type="text" value={form.personal_tg_id || ''} onChange={set('personal_tg_id')}
              placeholder="123456789"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.personalAccountUsername}</label>
              <input type="text" value={form.personal_tg_username || ''} onChange={set('personal_tg_username')}
                placeholder="@username"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.assistantAccount}</label>
              <div className="flex items-center w-full rounded-xl border border-gray-200 focus-within:border-brand overflow-hidden">
                <span className="pl-4 pr-1 text-sm text-gray-400 select-none">@</span>
                <input type="text"
                  value={form.assistant_tg_username || ''}
                  onChange={(e) => {
                    const v = e.target.value.replace(/^@+/, '').trim()
                    setForm((f: any) => ({ ...f, assistant_tg_username: v }))
                  }}
                  className="flex-1 pr-4 py-2.5 text-sm focus:outline-none" />
              </div>
              <p className="text-xs text-gray-500 mt-1.5">
                Только ник, без @. Ассистент сможет получить код доступа к кабинету спикера через бот.
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">{error}</div>
        )}

        <div className="flex gap-3 items-center">
          <button type="submit" disabled={saving}
            className={`btn-gold flex-1 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 ${saving ? 'btn-loading' : ''}`}>
            {saving ? <><Spinner /> {t.common.saving}</> : <><Save size={16} /> {t.common.save}</>}
          </button>
          <Link href="/dashboard/collaborations"
            className="px-6 py-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
            {t.common.back}
          </Link>
          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-green-600">
              <Check size={15} /> {t.common.saved}
            </span>
          )}
        </div>
      </form>
    </div>
  )
}
