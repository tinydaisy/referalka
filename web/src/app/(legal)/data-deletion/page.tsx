/**
 * Как удалить свои данные — обязательная страница для приложения Meta.
 *
 * ⚠️ Meta требует её отдельным адресом (Настройки → Основное → «Удаление
 * данных пользователей»). Без неё приложение не публикуется, а вместо
 * инструкции там стояла заглушка `https://www.facebook.com/`.
 *
 * ⚠️ Это ИНСТРУКЦИЯ, а не юридический документ: живёт обычной страницей, а не
 * в `platform_legal_docs`. Версионировать её незачем, а держать в базе значит
 * заставлять владельца править текст через админку ради пары абзацев.
 */
// ⚠️ Почта сервиса, а НЕ личная почта владельца: страница публичная, её
// видят подписчики клиентов и проверяющие Meta.
const SUPPORT_EMAIL = 'ivision.command@gmail.com'

export const metadata = {
  title: 'Удаление данных — iViSiON: ПЛЮСОН',
  description: 'Как удалить свои персональные данные из сервиса iViSiON: ПЛЮСОН.',
}

export default function DataDeletionPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold text-[#25455D] mb-2">Удаление данных</h1>
      <p className="text-sm text-gray-500 mb-6">
        Здесь описано, как удалить свои данные из сервиса iViSiON: ПЛЮСОН.
      </p>

      <div className="space-y-6 text-sm text-gray-700 leading-relaxed">
        <section>
          <h2 className="font-semibold text-[#25455D] mb-2">Если вы владелец кабинета</h2>
          <p>
            Напишите нам на{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-600 hover:underline">
              {SUPPORT_EMAIL}
            </a>{' '}
            с адреса, на который зарегистрирован кабинет. Мы удалим кабинет и все
            связанные с ним данные в течение 30 дней и подтвердим это письмом.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-[#25455D] mb-2">
            Если вы подписчик или участник события
          </h2>
          <p className="mb-2">
            Ваши данные хранит организатор, который вас пригласил, — мы обрабатываем их
            по его поручению. Поэтому:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>напишите организатору напрямую — он удалит вас из своей базы сам;</li>
            <li>
              либо напишите нам на{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-600 hover:underline">
                {SUPPORT_EMAIL}
              </a>
              , указав, у какого организатора вы состоите, — мы передадим запрос и
              проследим, что он выполнен.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-semibold text-[#25455D] mb-2">
            Если вы писали нам в Instagram
          </h2>
          <p>
            Данные из переписки — ваше имя пользователя и текст сообщений. Чтобы их
            удалить, напишите нам на{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-600 hover:underline">
              {SUPPORT_EMAIL}
            </a>{' '}
            и укажите свой ник в Instagram. Отдельно отзывать доступ приложению не
            нужно, но вы можете сделать это в настройках Instagram — раздел
            «Приложения и сайты».
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-[#25455D] mb-2">Сколько это занимает</h2>
          <p>
            Мы отвечаем в течение 3 рабочих дней и удаляем данные не позднее 30 дней с
            момента обращения. Часть сведений может остаться в резервных копиях — они
            перезаписываются автоматически и не используются.
          </p>
        </section>

        <p className="text-xs text-gray-400 pt-2">
          Подробнее о том, какие данные мы обрабатываем, — в{' '}
          <a href="/privacy" className="text-blue-600 hover:underline">
            Политике обработки персональных данных
          </a>
          .
        </p>
      </div>
    </div>
  )
}
