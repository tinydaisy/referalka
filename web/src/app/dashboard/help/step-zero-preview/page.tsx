'use client'

/**
 * ДЕМО «шага ноль» — чтобы посмотреть экран отдельно от автонастройки.
 *
 * ⚠️ РАЗМЕТКА ЗДЕСЬ НЕ ДУБЛИРУЕТСЯ: страница показывает тот же компонент
 * `StepZero`, что и вкладка автонастройки. Своя копия разошлась бы с боевой
 * на первой же правке текста.
 *
 * ⚠️ Страница НЕ подключена к меню — открывается только по прямой ссылке.
 * Шаг уже работает в автонастройке (первым шагом, после приветствия), эта
 * страница осталась для быстрой проверки экрана без запуска услуги.
 */

import { useState } from 'react'
import Link from 'next/link'
import { ShieldCheck, ArrowRight } from 'lucide-react'
import { StepZero } from '@/components/channels/StepZero'

const BRAND = '#25455D'

export default function StepZeroPreviewPage() {
  const [ready, setReady] = useState(false)

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">
          Дашборд
        </Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Демо: шаг ноль</span>
      </div>

      <div className="flex items-start gap-3 mb-2">
        <div className="p-2 rounded-lg text-white shrink-0"
             style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <ShieldCheck size={22} />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>
            Шаг ноль — как он выглядит
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Тот же экран, что стоит первым шагом в автонастройке.
          </p>
        </div>
      </div>

      <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900 mb-6">
        Демо-страница для проверки экрана. В меню её нет — боевой шаг живёт
        в разделе «Автонастройка».
      </div>

      {/* ⚠️ `showContinue` обязателен: с 18.09 `onReady` приходит ТОЛЬКО по
          нажатию кнопки внутри компонента — автоперехода больше нет. Без неё
          блок ниже не открылся бы никогда. */}
      <StepZero onReady={setReady} showContinue />

      <div className="rounded-2xl border-2 p-5 mt-4"
           style={{ borderColor: ready ? '#86efac' : '#e5e7eb',
                    background: ready ? '#f0fdf4' : '#fff' }}>
        {ready ? (
          <>
            <div className="font-semibold text-green-800 mb-1">
              Готово — можно приступать
            </div>
            <div className="text-sm text-green-700 mb-3">
              Почта подтверждена, связь с вами есть — шаг пройден.
            </div>
            <Link href="/dashboard/autosetup"
                  className="btn-gold inline-flex items-center gap-2 px-5 py-2.5 text-base font-semibold">
              Перейти к настройке <ArrowRight size={17} />
            </Link>
          </>
        ) : (
          <div className="text-sm text-gray-500">
            Кнопка откроется, когда почта подтверждена и вы зашли хотя бы
            в одного бота.
          </div>
        )}
      </div>
    </div>
  )
}
