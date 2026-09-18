'use client'

/**
 * Блок «Чат спикеров» — закрытый служебный чат команды события.
 *
 * ⚠️ ЗДЕСЬ ID ВВОДИТСЯ ВРУЧНУЮ, а не выбирается из базы чатов клиента
 * (как в EventChatsField). Причина: база чатов — это чаты для рассылок по
 * аудитории, их заводят осознанно и надолго. Чат спикеров служебный, часто
 * создаётся под конкретное событие, и засорять им общую базу незачем.
 * Организатор берёт ID командой /getmyid прямо в чате — она работает во всех
 * трёх площадках и отдаёт «ID этого чата».
 *
 * Поле «Ссылка на чат» — ТОЛЬКО СПРАВОЧНО, нигде в отправке не участвует:
 * чтобы из кабинета быстро открыть нужный чат, а не искать его по площадкам.
 *
 * Родитель хранит value/onChange и сам собирает PATCH.
 */
import { useState } from 'react'

export type SpeakersChatPlatform = 'telegram' | 'vk' | 'max'

export interface SpeakersChatValue {
  tgChatId: string
  vkChatId: string
  maxChatId: string
  tgChatUrl: string
  vkChatUrl: string
  maxChatUrl: string
}

interface Props {
  value: SpeakersChatValue
  onChange: (next: SpeakersChatValue) => void
  /** «Чат спикеров» / «Чат спикеров/номинантов» — у премий и турниров своё слово. */
  label: string
}

const PLATFORM_META: Record<SpeakersChatPlatform, {
  label: string; badge: string; color: string
  idKey: keyof SpeakersChatValue; urlKey: keyof SpeakersChatValue
  placeholder: string; hint: string
}> = {
  telegram: {
    label: 'Telegram', badge: 'TG', color: '#229ED9',
    idKey: 'tgChatId', urlKey: 'tgChatUrl',
    placeholder: '-1001234567890',
    hint: 'У групп ID начинается с минуса — так и вставляйте, вместе с ним.',
  },
  vk: {
    label: 'ВКонтакте', badge: 'VK', color: '#0077FF',
    idKey: 'vkChatId', urlKey: 'vkChatUrl',
    placeholder: '2000000001',
    hint: 'У беседы ВК длинный ID вида 2000000001 — команда покажет именно его.',
  },
  max: {
    label: 'MAX', badge: 'MAX', color: '#F45D22',
    idKey: 'maxChatId', urlKey: 'maxChatUrl',
    placeholder: '-1234567890',
    hint: 'Вставьте ID ровно так, как его показала команда.',
  },
}

export default function SpeakersChatField({ value, onChange, label }: Props) {
  const [activeTab, setActiveTab] = useState<SpeakersChatPlatform>('telegram')
  const set = (k: keyof SpeakersChatValue, v: string) => onChange({ ...value, [k]: v })

  const meta = PLATFORM_META[activeTab]
  const anyFilled = [value.tgChatId, value.vkChatId, value.maxChatId]
    .some(v => !!String(v || '').trim())

  return (
    <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-3">
      <div>
        <label className="block text-sm font-semibold text-gray-800">{label}</label>
        <p className="text-xs text-gray-500 mt-1">
          Закрытый чат вашей команды — отдельно от чата участников. Бот присылает
          туда служебные напоминания по программе: за 15 минут до выступления —
          «вы следующие» с временем, ссылкой входа в зум и тем, кто готовится следом.
          Заполните ту площадку, где у вас живёт чат — можно несколько, сообщение
          уйдёт в каждую заполненную.
        </p>
      </div>

      {/* Вкладки площадок: зелёная точка на заполненной */}
      <div className="flex gap-1 border-b border-gray-200">
        {(['telegram', 'vk', 'max'] as const).map(platform => {
          const m = PLATFORM_META[platform]
          const filled = !!String(value[m.idKey] || '').trim()
          const isActive = activeTab === platform
          return (
            <button key={platform} type="button" onClick={() => setActiveTab(platform)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive ? 'border-[#25455D] text-[#25455D]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              <span className="inline-flex items-center justify-center w-7 h-5 rounded text-[9px] font-bold text-white shrink-0"
                    style={{ background: m.color }}>{m.badge}</span>
              {m.label}
              {filled && <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Чат указан" />}
            </button>
          )
        })}
      </div>

      <div className="bg-white border border-gray-200 rounded p-3 space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            ID чата ({meta.label})
          </label>
          <input
            value={String(value[meta.idKey] || '')}
            onChange={e => set(meta.idKey, e.target.value.trim())}
            placeholder={meta.placeholder}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-mono focus:outline-none focus:border-brand" />
          <p className="text-xs text-gray-400 mt-1">{meta.hint}</p>
        </div>

        {/* Мини-инструкция — здесь же, а не в справке: человек настраивает чат
            ровно в этот момент, и уходить за ответом ему некуда. */}
        <div className="rounded-lg bg-[#FFF7F0] border border-[#FFCFA4] p-3">
          <p className="text-xs font-semibold text-gray-800 mb-1.5">Как узнать ID чата</p>
          <ol className="text-xs text-gray-700 space-y-1 list-decimal list-inside leading-relaxed">
            <li>Добавьте своего бота в этот чат.</li>
            <li>
              Сделайте его <b>администратором</b> — без прав админа бот не сможет
              писать в чат.
            </li>
            <li>
              Отправьте в чате команду <code className="px-1 py-0.5 rounded bg-white border border-gray-200 font-mono">/getmyid</code> —
              бот ответит «ID этого чата».
            </li>
            <li>Скопируйте этот ID и вставьте в поле выше.</li>
          </ol>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Ссылка на чат
            <span className="text-gray-400 font-normal ml-1">— для справки</span>
          </label>
          <input
            value={String(value[meta.urlKey] || '')}
            onChange={e => set(meta.urlKey, e.target.value)}
            placeholder="https://t.me/..."
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          <p className="text-xs text-gray-400 mt-1">
            Нигде не используется — просто чтобы быстро открыть чат из кабинета.
            Сообщения бот шлёт по ID выше.
          </p>
        </div>
      </div>

      {!anyFilled && (
        <p className="text-xs text-gray-400 italic">
          Чат не указан — напоминания «вы следующие» отправляться не будут.
        </p>
      )}
    </div>
  )
}
