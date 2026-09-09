'use client'
import { useState } from 'react'
import Link from 'next/link'
import { BookOpen, ExternalLink, ImageOff } from 'lucide-react'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function CollabCardInstructionPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help/s/collab-hub" className="text-sm text-gray-400 hover:text-gray-700">Коллабораторная</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Как создать карточку коллаборатора</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Как создать карточку коллаборатора</h1>
          <p className="text-sm text-gray-500 mt-1">
            Заполните профиль и карточку, опубликуйте её в каталоге — и другие организаторы
            смогут найти вас и предложить совместный эфир.
          </p>
        </div>
      </div>

      <div className="rounded-xl border p-4 mb-4 flex items-start gap-3 bg-blue-50 border-blue-200">
        <div className="text-xl flex-shrink-0">💡</div>
        <div>
          <div className="text-sm font-semibold text-gray-800">Зачем это нужно</div>
          <p className="text-xs text-gray-700 mt-1">
            Коллабораторная — это каталог организаторов и экспертов внутри ПЛЮСОНа.
            Пока ваша карточка не опубликована, вас в каталоге не видно: предложить
            коллаборацию вам никто не сможет. Заполнение занимает 10–15 минут и делается один раз.
          </p>
        </div>
      </div>

      <Section step="1" title="Заполнить фото и регалии о себе в настройках общих">
        <p className="text-sm text-gray-700">
          Откройте <b>Настройки → Mini App → Основатель</b>. Здесь живут данные, которые
          видят все: ваше фото, имя, позиционирование и регалии (факты в цифрах).
        </p>
        <p className="text-sm text-gray-700 mt-2">
          Это общий профиль — он подтягивается и в карточку коллаборатора, и в Mini App
          ваших событий. Заполнять дважды не нужно.
        </p>
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="text-xs font-semibold text-amber-900 mb-1">Что заполнить обязательно</div>
          <ul className="text-xs text-amber-800 space-y-1 list-disc pl-4">
            <li><b>Фото</b> — по нему вас узнают в каталоге</li>
            <li><b>Имя и позиционирование</b> — одна строка, чем вы занимаетесь</li>
            <li><b>Регалии</b> — цифры и достижения, они добавляют доверия</li>
          </ul>
        </div>
        <Screenshot
          src="/help/collab-card/01-profile-settings.jpg"
          alt="Настройки, вкладка Mini App, карточка основателя"
          caption="Настройки → Mini App → Основатель: фото, позиционирование и регалии"
        />
      </Section>

      <Section step="2" title="Заполнить свою карточку для коллабораторной">
        <p className="text-sm text-gray-700">
          Перейдите в <b>Коллабораторная (Хаб) → Моя карточка</b>. Это отдельная страница:
          то, что увидят другие организаторы, когда будут искать партнёра.
        </p>
        <p className="text-sm text-gray-700 mt-2">
          Здесь заполните <b>«Категория»</b>, <b>«Ниша»</b> (ниш можно отметить несколько —
          так вас найдут по любой из них), <b>«Город»</b> и — самое важное — блок
          <b> «Что предлагаете партнёрам»</b>. Именно ради него открывают карточку.
        </p>
        <div className="mt-3 rounded-lg border p-3" style={{ borderColor: PEACH, background: 'rgba(255,207,164,0.22)' }}>
          <div className="text-xs font-semibold mb-1" style={{ color: BRAND }}>Про медийные активы</div>
          <p className="text-xs" style={{ color: BRAND }}>
            Добавьте свои каналы и сообщества с числом подписчиков — система сама посчитает
            общий охват и покажет его на карточке. Без активов плашка охвата не появится.
          </p>
        </div>
        <Screenshot
          src="/help/collab-card/02-my-card.jpg"
          alt="Коллабораторная (Хаб), пункт меню Моя карточка"
          caption="Коллабораторная (Хаб) → Моя карточка"
        />
      </Section>

      <Section step="3" title="Опубликовать карточку в каталоге">
        <p className="text-sm text-gray-700">
          Заполнили — прокрутите страницу вниз и нажмите <b>«Опубликовать в каталоге»</b>.
          Пока кнопка не нажата, карточка сохранена, но в каталоге её никто не видит.
        </p>
        <Screenshot
          src="/help/collab-card/03-publish.jpg"
          alt="Кнопки Сохранить и Опубликовать в каталоге"
          caption="Внизу страницы: «Сохранить», рядом — «Опубликовать в каталоге»"
        />
      </Section>

      <Section step="4" title="Убедиться, что карточка опубликована">
        <p className="text-sm text-gray-700">
          После публикации кнопка меняется на зелёную отметку <b>«Опубликована в каталоге»</b>,
          а под ней появляется ссылка «Скрыть из каталога». Если видите её — всё получилось,
          вас уже можно найти.
        </p>
        <Screenshot
          src="/help/collab-card/04-published.jpg"
          alt="Отметка Опубликована в каталоге"
          caption="Зелёная отметка «Опубликована в каталоге» — карточка видна другим организаторам"
        />

        <div className="mt-4 rounded-xl border p-4 flex items-start gap-3 bg-green-50 border-green-200">
          <div className="text-xl flex-shrink-0">✅</div>
          <div>
            <div className="text-sm font-semibold text-gray-800">Готово</div>
            <p className="text-xs text-gray-700 mt-1">
              Карточка в каталоге. Теперь можно искать партнёров самому —{' '}
              <Link href="/dashboard/help/collab-find" className="text-blue-600 hover:underline">
                Как найти коллаборатора и предложить совместный эфир
              </Link>
            </p>
          </div>
        </div>

        <div className="mt-5 p-4 bg-gray-50 rounded-xl border border-gray-200">
          <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
          <p className="text-sm text-gray-600">
            Напишите в поддержку —{' '}
            <Link href={SUPPORT_URL} className="text-blue-600 hover:underline inline-flex items-center gap-1">
              {SUPPORT_LABEL} <ExternalLink size={12}/>
            </Link>
          </p>
        </div>
      </Section>
    </div>
  )
}

function Section({ step, title, children }: { step: string; title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border card-border p-5 mb-4 shadow-sm">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
             style={{ background: PEACH, color: BRAND }}>
          {step}
        </div>
        <h2 className="text-base font-bold" style={{ color: BRAND }}>{title}</h2>
      </div>
      <div className="pl-11">{children}</div>
    </section>
  )
}

function Screenshot({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const [errored, setErrored] = useState(false)
  if (errored) {
    return (
      <div className="mt-3 rounded-xl border border-dashed border-gray-300 bg-gray-50 p-4 flex items-start gap-3">
        <ImageOff size={20} className="text-gray-400 flex-shrink-0 mt-0.5" />
        <div>
          <div className="text-xs font-mono text-gray-500 break-all">{src}</div>
          {caption && <div className="text-xs text-gray-500 mt-1 italic">{caption}</div>}
          <div className="text-xs text-gray-400 mt-1">Скриншот будет добавлен</div>
        </div>
      </div>
    )
  }
  return (
    <figure className="mt-3">
      <img
        src={src}
        alt={alt}
        onError={() => setErrored(true)}
        className="max-h-[420px] w-auto max-w-full rounded-xl border border-gray-200 shadow-sm"
      />
      {caption && (
        <figcaption className="text-xs text-gray-500 mt-2 italic">{caption}</figcaption>
      )}
    </figure>
  )
}
