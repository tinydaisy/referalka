'use client'

/**
 * Админка → «Плюсоновский лид-магнит» (миграция 472).
 *
 * Один экран на всю платформу: текст предложения ПЛЮСОНа и то, куда ведёт
 * прямая ссылка подарка. Сохранил здесь — поменялось у всех клиентов разом.
 *
 * ⚠️ Клиент этот текст у себя не правит (форма в кабинете показывает его
 * только для чтения, и сервер правку тоже не примет): иначе он разъехался бы
 * по сотням кабинетов, и обновить его одним движением стало бы нельзя.
 */

import { useEffect, useState } from 'react'
import { Gift, AlertCircle, Check, Users, MousePointerClick, UserPlus } from 'lucide-react'
import { api } from '@/lib/api'

type Delivery = 'direct' | 'funnel'
type Visibility = 'testing' | 'all'

export default function AdminPlussonLeadMagnetPage() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [delivery, setDelivery] = useState<Delivery>('direct')
  const [visibility, setVisibility] = useState<Visibility>('testing')

  function apply(r: any) {
    setData(r)
    setName(r.name || '')
    setDescription(r.description || '')
    setDelivery((r.delivery as Delivery) || 'direct')
    setVisibility((r.visibility as Visibility) || 'testing')
  }

  useEffect(() => {
    api.adminPlussonLeadMagnet.get()
      .then(apply)
      .catch((e: any) => setErr(e?.message || 'Не удалось загрузить'))
      .finally(() => setLoading(false))
  }, [])

  async function save() {
    setSaving(true); setErr(''); setSaved(false)
    try {
      apply(await api.adminPlussonLeadMagnet.update({
        name: name.trim(),
        description: description.trim(),
        delivery,
        visibility,
      }))
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e: any) {
      setErr(e?.message || 'Не удалось сохранить')
    }
    setSaving(false)
  }

  if (loading) return <div className="text-gray-500">Загрузка…</div>

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2 mb-2">
        <Gift size={22} /> Плюсоновский лид-магнит
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Подарок, который лежит в кабинете у каждого клиента: он раздаёт своей
        аудитории доступ к ПЛЮСОНу и получает за пришедших реферальные
        начисления. Ссылку клиент не настраивает — её собирает сервер под
        площадку человека и с его реф-кодом.
      </p>

      {/* Цифры: сколько экземпляров живёт и что подарок принёс */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { icon: Users, label: 'Видят сейчас', value: data?.visible ?? 0 },
          { icon: MousePointerClick, label: 'Переходов', value: data?.clicks ?? 0 },
          { icon: UserPlus, label: 'Зарегистрировались', value: data?.signups ?? 0 },
          { icon: AlertCircle, label: 'Без подарка', value: data?.missing ?? 0 },
        ].map(({ icon: Icon, label, value }) => (
          <div key={label} className="bg-white rounded-xl border border-gray-200 p-4">
            <Icon size={16} className="text-gray-400 mb-2" />
            <div className="text-2xl font-bold text-gray-900">{value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {(data?.missing ?? 0) > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 flex gap-3 items-start">
          <AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-900">
            <b>У {data.missing} клиентов подарка нет.</b> Так быть не должно:
            подарок заводится в обеих точках создания кабинета, других нет.
            Значит создание сорвалось на уровне базы — скажите, разберёмся и
            раздадим.
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Название
          </label>
          <textarea
            value={name} onChange={e => setName(e.target.value)} rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#FFCFA4] focus:border-transparent text-sm"
          />
          <p className="text-xs text-gray-500 mt-1.5">
            Это первое, что человек видит в списке подарков. Меняете здесь —
            меняется у всех {data?.magnets ?? 0} клиентов сразу.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Описание
          </label>
          <textarea
            value={description} onChange={e => setDescription(e.target.value)} rows={4}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#FFCFA4] focus:border-transparent text-sm"
          />
          <p className="text-xs text-gray-500 mt-1.5">
            Что человек получит. Можно оставить пустым.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Кому показывать
          </label>
          <div className="space-y-2">
            {([
              {
                v: 'testing' as Visibility,
                title: 'Пока только мне — админскому и сервисному аккаунту',
                text: 'Обкатка. Подарок уже лежит у всех клиентов, но в их кабинетах не показывается.',
              },
              {
                v: 'all' as Visibility,
                title: 'Всем клиентам',
                text: 'Появится у всех разом, у каждого со своей ссылкой. Ничего заново раздавать не надо.',
              },
            ]).map(o => (
              <label
                key={o.v}
                className={`flex gap-3 p-3.5 rounded-xl border cursor-pointer ${
                  visibility === o.v ? 'border-[#FFCFA4] bg-[#FFF9F3]' : 'border-gray-200'
                }`}
              >
                <input
                  type="radio" name="visibility" checked={visibility === o.v}
                  onChange={() => setVisibility(o.v)} className="mt-1"
                />
                <div>
                  <div className="text-sm font-semibold text-gray-900">{o.title}</div>
                  <div className="text-xs text-gray-600 mt-0.5">{o.text}</div>
                </div>
              </label>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Прячется только показ — сам подарок есть у всех {data?.magnets ?? 0} клиентов.
            Переключили на «всем» → увидят сразу, со своими накопленными ссылками.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Куда ведёт прямая ссылка подарка
          </label>
          <div className="space-y-2">
            {([
              {
                v: 'direct' as Delivery,
                title: 'Сразу в бот ПЛЮСОНа',
                text: 'Один клик — и человек у нас. Дальше его ведёт наша команда. Клиенту он в базу не попадает.',
              },
              {
                v: 'funnel' as Delivery,
                title: 'Через бот клиента',
                text: 'Сначала человек заходит в бот клиента и становится его контактом, а уже там получает ссылку на ПЛЮСОН. На один шаг длиннее.',
              },
            ]).map(o => (
              <label
                key={o.v}
                className={`flex gap-3 p-3.5 rounded-xl border cursor-pointer ${
                  delivery === o.v ? 'border-[#FFCFA4] bg-[#FFF9F3]' : 'border-gray-200'
                }`}
              >
                <input
                  type="radio" name="delivery" checked={delivery === o.v}
                  onChange={() => setDelivery(o.v)} className="mt-1"
                />
                <div>
                  <div className="text-sm font-semibold text-gray-900">{o.title}</div>
                  <div className="text-xs text-gray-600 mt-0.5">{o.text}</div>
                </div>
              </label>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Когда подарок выдаётся <b>внутри бота</b> — за рефералов, в воронке
            события, в инфо о бренде — режим ни на что не влияет: человек уже в
            боте и уже контакт клиента, ему просто приходит ссылка.
          </p>
        </div>

        {err && (
          <div className="text-sm text-red-600 flex items-center gap-2">
            <AlertCircle size={15} /> {err}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={save} disabled={saving || !name.trim()}
            className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60"
          >
            {saving ? 'Сохраняю…' : 'Сохранить'}
          </button>
          {saved && (
            <span className="text-sm text-green-600 flex items-center gap-1.5">
              <Check size={15} /> Обновлено у всех клиентов
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
