'use client'

/**
 * Шаг 2: получить три значения и связать хранилище с ПЛЮСОНом.
 *
 * ⚠️ Структура статьи: СНАЧАЛА цель («нужны три значения») и куда их вставить,
 * и только ПОТОМ — как получить каждое. Обратный порядок (сначала двадцать
 * экранов настройки, в конце «а теперь вставьте») человек не дочитывает: он не
 * понимает, ради чего всё это делает.
 */
import Link from 'next/link'
import { Crumbs, Hero, Step, Note, Warn, Accent, Screenshot } from '../_article'
import { ArrowRight, ExternalLink } from 'lucide-react'

const S = '/help/cloud-storage'
const CLOUD = 'https://console.cloud.ru'

export default function CloudStorageConnectPage() {
  return (
    <div className="max-w-3xl pb-24">
      <Crumbs section="Первичная настройка" sectionHref="/dashboard/help/s/setup"
              title="Шаг 2 — Связать с ПЛЮСОН" />

      <Hero
        title="Шаг 2 — Свяжите хранилище с ПЛЮСОНом"
        subtitle="Нужно получить в Cloud.ru три значения и вставить их в ПЛЮСОН. Занимает минут 10."
      />

      <Accent title="Ваша цель — получить три значения">
        <ol className="mt-1 space-y-1.5">
          <li><b>1. ID тенанта</b> — номер вашего хранилища в Cloud.ru</li>
          <li><b>2. Key ID</b> — ключ доступа</li>
          <li><b>3. Key Secret</b> — секретный ключ</li>
        </ol>
        <p className="mt-2">
          Вставите их в{' '}
          <Link href="/dashboard/settings?tab=storage" className="underline">
            Настройки → Файловое хранилище
          </Link>{' '}
          — и всё, дальше ПЛЮСОН настроит хранилище сам.
        </p>
      </Accent>

      <div className="my-5 rounded-2xl border border-gray-200 bg-white p-5">
        <p className="mb-3 text-[15px] text-gray-700">
          Откройте Cloud.ru в соседней вкладке и выполняйте шаги ниже по порядку.
        </p>
        <a href={CLOUD} target="_blank" rel="noreferrer"
           className="btn-gold inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold">
          Перейти в Cloud.ru <ExternalLink size={15} />
        </a>
      </div>

      <h2 className="mt-8 mb-3 text-lg font-bold" style={{ color: '#25455D' }}>
        Сначала создайте хранилище
      </h2>

      <Step step="1" title="Создайте бакет">
        <p>
          В кабинете нажмите <b>«Создать ресурс»</b> — зелёную кнопку справа в карточке
          проекта. В списке выберите <b>«Бакет объектного хранилища»</b>.
        </p>
        <Screenshot src={`${S}/05-create-resource.jpg`}
          alt="Кнопка «Создать ресурс» в кабинете Cloud.ru"
          caption="Кнопка «Создать ресурс» — справа в карточке проекта" />
        <Screenshot src={`${S}/06-bucket-menu.jpg`}
          alt="Список ресурсов с пунктом «Бакет объектного хранилища»"
          caption="Выбираем «Бакет объектного хранилища»" />

        <p className="mt-3">В форме заполните два поля, остальное не трогайте:</p>
        <ul className="mt-2 space-y-1.5 text-[15px] text-gray-700">
          <li>• <b>Название</b> — латиницей, например <code className="rounded bg-gray-100 px-1">pluson</code>.</li>
          <li>• <b>Глобальное название</b> — готовую строку подсказывает ПЛЮСОН
            в разделе «Файловое хранилище», скопируйте её оттуда.</li>
        </ul>

        <Warn title="Глобальное название обязательно">
          Cloud.ru помечает его как «Опционально», но без него ваши картинки
          не откроются у посетителей: файлы отдаются только по глобальному имени.
        </Warn>

        <Screenshot src={`${S}/07-bucket-form.jpg`}
          alt="Форма создания бакета: название и глобальное название"
          caption="Заполняем оба названия → «Создать»" />
      </Step>

      <Step step="2" title="Включите публичный доступ">
        <p>
          Отмотайте главную страницу вниз, нажмите на название своего хранилища.
          В меню слева выберите <b>«Bucket Policy»</b>, включите тумблер
          <b> «Публичный доступ к бакету»</b> и нажмите <b>«Сохранить»</b>.
        </p>
        <Screenshot src={`${S}/10-bucket-menu-policy.jpg`}
          alt="Меню бакета с пунктом Bucket Policy"
          caption="Пункт «Bucket Policy» в меню слева" />
        <Screenshot src={`${S}/11-public-access.jpg`}
          alt="Включённый тумблер публичного доступа и кнопка «Сохранить»"
          caption="Включаем тумблер, политику ниже не трогаем, жмём «Сохранить»" />

        <Note title="Что означает «публичный»">
          Только то, что файл можно скачать по прямой ссылке — иначе браузер посетителя
          не покажет ваши афиши. Загружать и удалять файлы по-прежнему можете лишь вы.
        </Note>
      </Step>

      <h2 className="mt-8 mb-3 text-lg font-bold" style={{ color: '#25455D' }}>
        Теперь получите три значения
      </h2>

      <Step step="3" title="Значение 1 — ID тенанта">
        <p>
          Откройте своё хранилище, в меню слева выберите <b>«Object Storage API»</b>.
          Скопируйте строку <b>«ID тенанта»</b> — длинную, с дефисами.
        </p>
        <Screenshot src={`${S}/13-api-params.jpg`}
          alt="Страница «Object Storage API» со строками Endpoint, ID тенанта, Регион"
          caption="Строка «ID тенанта» — первое из трёх значений" />
      </Step>

      <Step step="4" title="Значения 2 и 3 — Key ID и Key Secret">
        <p>
          Нажмите на свой аватар в правом верхнем углу, затем на <b>шестерёнку</b> рядом
          с именем. Откройте вкладку <b>«Ключи доступа»</b> → <b>«Создать ключ доступа»</b>.
        </p>
        <Screenshot src={`${S}/14-my-credentials.jpg`}
          alt="Меню аккаунта с шестерёнкой"
          caption="Аватар → шестерёнка" />
        <Screenshot src={`${S}/15-access-keys.jpg`}
          alt="Вкладка «Ключи доступа»"
          caption="Вкладка «Ключи доступа»" />

        <p className="mt-3">В окне создания заполните:</p>
        <ul className="mt-2 space-y-1.5 text-[15px] text-gray-700">
          <li>• <b>Описание</b> — <code className="rounded bg-gray-100 px-1">Хранилище файлов ПЛЮСОН</code></li>
          <li>• <b>Время жизни ключа</b> — <b>«Бессрочно»</b></li>
        </ul>

        <Warn title="Только «Бессрочно»">
          Временный ключ действует от 15 минут до суток. Выберете его — и через день
          загрузка файлов перестанет работать, а причина будет неочевидна.
        </Warn>

        <Screenshot src={`${S}/17-key-lifetime.jpg`}
          alt="Окно создания ключа с полем «Время жизни ключа»"
          caption="Описание + «Бессрочно» → «Создать»" />

        <p className="mt-3">
          После создания появятся <b>Key ID</b> и <b>Key Secret</b> — это второе и третье
          значения.
        </p>

        <Warn title="Key Secret показывают один раз">
          Закроете окно — посмотреть снова нельзя, придётся создавать новый ключ.
          Скопируйте сразу и вставьте в ПЛЮСОН, не откладывая.
        </Warn>

        <Screenshot src={`${S}/18-key-shown.jpg`}
          alt="Созданный ключ: Key ID и Key Secret"
          caption="Копируем обе строки" />
      </Step>

      <div className="mt-6 rounded-2xl border-2 p-5" style={{ borderColor: '#FFCFA4' }}>
        <div className="font-semibold text-gray-800">Все три значения на руках</div>
        <p className="mt-1 text-[15px] text-gray-600">
          Вставьте их в ПЛЮСОН — мы проверим связь и покажем проверочную картинку.
        </p>
        <Link href="/dashboard/settings?tab=storage"
              className="btn-gold mt-3 inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold">
          Вставить значения в ПЛЮСОН <ArrowRight size={15} />
        </Link>
      </div>
    </div>
  )
}
