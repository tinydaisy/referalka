'use client'

/**
 * Автонастройка Telegram «под ключ» — вкладка в разделе «Каналы» (миграция 364).
 *
 * Клиент вводит имя будущего бота, оплачивает разовую услугу и видит живой
 * статус: создаём бота → привязываем приложение → заводим группу → передаём
 * права. Дальше два его действия — зайти в бота и вступить в группу.
 *
 * ⚠️ Экран сам обновляется раз в 5 секунд, пока настройка идёт. Без этого
 * клиент смотрит в застывший экран и решает, что услуга не работает.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'
import { StepZero } from '@/components/channels/StepZero'
import { useMe } from '@/hooks/useMe'
import {
  AUTOSETUP_STEPS, AUTOSETUP_FROM_CLIENT, AUTOSETUP_NOT_INCLUDED,
} from '@/lib/autosetupSteps'
import {
  AlertTriangle, ArrowRight, Check, Clock, Copy, Loader2, XCircle,
  MessageSquare, RotateCw, Sparkles, Users,
} from 'lucide-react'

type Step = { at: string; step: string; ok: boolean; text: string }
type Order = {
  id: number
  status: string
  setup_state: string
  setup_error?: string | null
  setup_log?: Step[]
  bot_username?: string | null
  bot_title?: string | null
  group_invite_link?: string | null
  claim_deadline?: string | null
  steps?: Record<string, boolean>
  /** Процесс пошёл — поля формы больше не редактируются (см. `locked` на бэке). */
  locked?: boolean
}
type State = {
  service: {
    name: string; tagline?: string; description?: string
    bullet_points: string[]; price: number
    coming_soon: boolean; payable: boolean
  }
  order?: Order
  queue_position?: number | null
  /** Сколько всего задач сейчас в очереди и в работе (по всей платформе). */
  queue_total?: number | null
  telegram_username?: string | null
  /** Заполнена ли «Служба заботы» — по ней решаем, подставлять ли туда ник. */
  support_filled?: boolean
  /** Ник службы заботы (без «@») — показываем в поле, чтобы человек видел настроенное. */
  support_username?: string | null
  /** Ник Telegram-канала основателя (без «@») — по нему идёт проверка подписки. */
  channel_username?: string | null
  suggestions: string[]
  claim_days: number
  /** Почта кабинета и подтверждена ли она. Без подтверждения запуск закрыт:
   *  письмо — единственный способ позвать человека забрать права на бота. */
  email?: string | null
  email_verified?: boolean
  /** @handle уже подключённого главного telegram-бота, если он есть. */
  existing_main_bot?: string | null
  /** Демо-заготовки, созданные автонастройкой (миграция 411) — их показывает
   *  итог со ссылкой «проверьте выдачу на себе». */
  demo_magnets?: { id: number; name: string; slug: string; num: number; link?: string | null }[]
  /** Почему заказ ещё ждёт: 'limit' — выжидаем предел площадки (время известно),
   *  'slots' — впереди другие заказы, 'queue' — подбираем аккаунт. */
  queue_wait?: { reason: 'limit' | 'slots' | 'queue'; back_at?: string | null } | null
}

// Пока настройка идёт — обновляем экран часто; когда всё замерло — редко.
const POLL_ACTIVE_MS = 5000
const POLL_IDLE_MS = 30000

/**
 * Отметка «приветствие уже показывали» — С НОМЕРОМ ВЕРСИИ В КЛЮЧЕ.
 *
 * ⚠️⚠️ ВЕРСИЯ ОБЯЗАТЕЛЬНА. Без неё человек, однажды нажавший «Начать», НИКОГДА
 * больше не увидит приветствие — даже переписанное заново. Поймано сразу:
 * владелец нажала «Начать» на первой редакции текста, и новый текст ей бы уже
 * не показался, хотя правился он именно по её замечанию.
 *
 * ⚠️ Переписали текст приветствия — ПОДНИМИТЕ ЦИФРУ. Тогда экран покажется
 * заново всем, кто видел прежнюю редакцию.
 */
const WELCOME_KEY_BASE = 'plusson_autosetup_welcome_v2'
/**
 * Ключ отметки — С ID КЛИЕНТА (16.09.2026).
 *
 * ⚠️⚠️ Общий ключ на браузер — ошибка: человек завёл ВТОРОЙ кабинет в том же
 * браузере, а приветствие ему больше не показывалось — отметка осталась от
 * первого. Выглядит как «приветствие исчезло у новых пользователей», хотя у
 * настоящего нового (другой браузер) оно есть. Для владельца это ровно так и
 * выглядело: она пересоздала кабинет и экран пропал.
 */
const welcomeKey = (clientId?: number | null) =>
  clientId ? `${WELCOME_KEY_BASE}_${clientId}` : WELCOME_KEY_BASE

export default function AutoSetupTab() {
  const [state, setState] = useState<State | null>(null)
  const [loading, setLoading] = useState(true)
  const [username, setUsername] = useState('')
  const [title, setTitle] = useState('')
  const [checking, setChecking] = useState(false)
  const [nameCheck, setNameCheck] = useState<{ free: boolean; message: string } | null>(null)
  const [starting, setStarting] = useState(false)
  /** Ссылка на канал клиента — спрашивается при запуске, идёт в «Каналы основателя». */
  /**
   * Услуга ещё не открыта этому кабинету (ручка ответила 403).
   *
   * ⚠️ Это НЕ ошибка: пока идёт обкатка, услуга раздаётся по коду доступа,
   * и у большинства кабинетов её нет. Раньше такой ответ глотался молча, и
   * вкладка рисовала пустоту — человек видел белый экран без объяснений.
   */
  const [noAccess, setNoAccess] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true)
      const data = await api.tgAutosetup.get()
      setState(data)
      setNoAccess(false)
      if (!username && data?.suggestions?.length) setUsername(data.suggestions[0])
    } catch (e: any) {
      // 403 — доступа нет: показываем экран с вводом кода, а не пустоту.
      // Сверяем по КОДУ ответа, а не по тексту: текст правится в бэкенде
      // без оглядки на фронт, и проверка по нему тихо перестанет срабатывать.
      if (e?.status === 403) setNoAccess(true)
    } finally {
      setLoading(false)
    }
  }, [username])

  /**
   * Ник в Telegram — правится ПРЯМО ЗДЕСЬ, а не в Настройках.
   *
   * ⚠️ Раньше здесь висела плашка «укажите ник в Настройках»: человек уходил
   * в другой раздел, искал нужную вкладку и часто не возвращался. Поле в
   * кабинете НЕобязательное и лежит отдельно — значит закрыть этот пробел
   * должна сама настройка «под ключ», раз без ника права передать некому.
   *
   * ⚠️ Сохраняется СРАЗУ в двух местах: ник профиля и «Служба заботы»
   * (см. saveNick) — иначе останется незаполненным то, ради чего услуга
   * и делается.
   */
  // ⚠️ `null` = поле не трогали, показываем ник из настроек. Пустая строка —
  // это «стёрли руками», и её нельзя путать с «не редактировали».
  const [nick, setNick] = useState<string | null>(null)
  // Черновики двух других обязательных полей. null — «не трогали»: тогда
  // показываем значение из настроек, и любая правка в Настройках сразу видна.
  const [supportNick, setSupportNick] = useState<string | null>(null)
  const [chanNick, setChanNick] = useState<string | null>(null)
  const [savingNick, setSavingNick] = useState(false)
  const [nickSaved, setNickSaved] = useState(false)
  const [nickError, setNickError] = useState<string | null>(null)
  // ⚠️ Обычная переменная, а не состояние: состояние применяется к СЛЕДУЮЩЕЙ
  // перерисовке, и сразу после `saveNick` в нём ещё старое значение —
  // задача ушла бы в очередь при неудачном сохранении.
  const nickErrorRef = useRef<string | null>(null)
  // ⚠️ Блок итога на длинной странице оказывается ниже экрана: человек ждал
  // результата, настройка завершилась — а он видит всё те же поля и не
  // понимает, что уже готово. Скроллим к итогу ОДИН раз, когда он появился.
  const doneRef = useRef<HTMLDivElement | null>(null)
  const scrolledToDone = useRef(false)
  /**
   * ШАГ 3 — экран между передачей прав и поздравлением.
   *
   * ⚠️⚠️ Права уходят АВТОМАТИЧЕСКИ через минуту после создания группы (в
   * группу человека добавляет сам сервисный аккаунт, и этого уже достаточно
   * для `_finish_setup`). Из-за этого экран перескакивал сразу на зелёный
   * итог, и два шага — юрданные и бот в канал — человек не успевал увидеть
   * вовсе: «я не успела настроить ИНН и не успела выставить канал».
   *
   * Теперь настройка `done` → показываем Шаг 3, а поздравление держим, пока
   * не нажали «Завершить».
   *
   * ⚠️ Отметка в localStorage и С НОМЕРОМ ЗАКАЗА в ключе: это состояние
   * ЭКРАНА (что человек уже прочитал), а не данные кабинета. Новый заказ —
   * новый ключ, и Шаг 3 показывается заново, как и должен.
   */
  const [step3Done, setStep3Done] = useState<boolean | null>(null)
  const step3Ref = useRef<HTMLDivElement | null>(null)
  // ⚠️ Каталог готовых решений пока открыт не всем (фича `ready_solutions`).
  // Кнопку показываем только тем, у кого раздел есть: иначе человек нажмёт и
  // упрётся в пустую вкладку — хуже, чем если бы кнопки не было вовсе.
  const { me } = useMe()
  const hasSolutions = (me?.features || []).includes('ready_solutions')
  /**
   * Имя для приветствия — ТОЛЬКО первое слово.
   *
   * ⚠️ `me.name` приходит склеенным с фамилией (миграция 381). «Маргарита
   * Форбс! Добрейшего-богатейшего…» звучит как обращение из налоговой —
   * в живом приветствии нужно одно имя.
   *
   * ⚠️ Имени может не быть вовсе (кабинет заведён по почте): тогда строка
   * начинается сразу с «Добрейшего-богатейшего», без пустого обращения
   * и без висящего восклицательного знака.
   */
  const firstName = (() => {
    // ⚠️ Первая буква — заглавная: имя в кабинете человек вводит как попало
    // («тест маврго», «екатерина»), а в приветствии строчная буква сразу
    // читается как небрежность. Остальные буквы НЕ трогаем — иначе сломаем
    // составные имена вроде «Анна-Мария».
    const w = (me?.name || '').trim().split(/\s+/)[0] || ''
    return w ? w[0].toUpperCase() + w.slice(1) : ''
  })()

  /** Итоговое значение поля: черновик, если трогали, иначе — из настроек. */
  const effNick    = (nick        ?? (state?.telegram_username || '')).trim().replace(/^@/, '')
  const effSupport = (supportNick ?? (state?.support_username  || '')).trim().replace(/^@/, '')
  const effChannel = (chanNick    ?? (state?.channel_username  || '')).trim().replace(/^@/, '')
  /** Все три обязательных поля заполнены — от этого зависит вид блока и запуск. */
  const allFilled = !!(effNick && effSupport && effChannel)

  /** Ставит ошибку и в состояние (для показа), и в переменную (для проверки сразу). */
  const putNickError = (msg: string | null) => { nickErrorRef.current = msg; setNickError(msg) }

  const saveNick = async () => {
    // ⚠️ ВСЕ ТРИ ПОЛЯ ОБЯЗАТЕЛЬНЫ: без ника некому передать бота, без службы
    // заботы не заработает «Тех. поддержка» в боте и на лендинге, без канала —
    // проверка подписки в воронках подарков. Услуга ради этого и делается.
    if (!effNick || !effSupport || !effChannel) {
      putNickError('Заполните все три поля — они нужны для настройки')
      return
    }
    setSavingNick(true); putNickError(null); setNickSaved(false)
    try {
      // ⚠️⚠️ ПИШЕМ ТОЛЬКО ТО, ЧТО ЧЕЛОВЕК ТРОНУЛ (`?? null` = не трогали).
      // Иначе форма перезаписала бы уже настроенное теми же значениями —
      // безобидно на вид, но у службы заботы это затёрло бы отдельный аккаунт
      // поддержки, а у канала — первый из нескольких «каналов основателя».
      const patch: any = {}
      if (nick !== null)        patch.telegram_username = effNick
      // Служба заботы хранится ССЫЛКОЙ — так это поле заполняется во всём
      // проекте; наружу мы показываем ник, внутрь пишем ссылку.
      if (supportNick !== null) patch.work_tg_username = `https://telegram.me/${effSupport}`
      if (Object.keys(patch).length) await api.auth.updateMe(patch)

      // Канал живёт не в профиле, а в «Каналах основателя» — своя ручка.
      if (chanNick !== null) {
        await api.tgAutosetup.saveChannel(effChannel)
      }

      setNickSaved(true)
      setNick(null); setSupportNick(null); setChanNick(null)
      await load(true)
    } catch (e: any) {
      putNickError(e?.message || 'Не удалось сохранить')
    } finally {
      setSavingNick(false)
    }
  }

  // ⚠️ Ввода кода здесь НЕТ: он живёт в ОДНОМ месте — в карточке услуги на
  // странице «Подписка». Держать вторую форму значило бы чинить обе.

  /**
   * Отметки «я это сделал» — их ставит сам клиент.
   *
   * ⚠️ Нужны потому, что автоматика срабатывает не всегда: бот услуги не
   * слушается процессом до его перезапуска, а вступление в группу проходит
   * мимо нас, если человек вступил сам (у большинства закрыты настройки
   * приватности, и добавить его мы не можем). По этим отметкам фоновая задача
   * передаёт права.
   */
  const [confirming, setConfirming] = useState<'bot' | 'group' | 'channel' | null>(null)

  /**
   * Ответ на подтверждение шага — показывается ПОД шагом, а не в alert.
   *
   * ⚠️ Нужен из-за канала: там мы не верим на слово, а спрашиваем у Telegram,
   * админ ли бот. Ответ «подтвердили» / «подтвердить не удалось» человек должен
   * увидеть там же, где нажимал, — alert закрывается и не оставляет следа.
   */
  const [stepNote, setStepNote] = useState<
    { step: string; ok: boolean; text: string } | null
  >(null)

  /**
   * Расхождение ников: вписан один аккаунт, а в бота вошли другим.
   *
   * ⚠️ За человека НЕ решаем (решение владельца 16.09.2026): показываем выбор —
   * «передать на тот, которым вошёл» или «войду другим». Молчаливая подмена
   * ника означала бы, что бот уходит не на тот аккаунт, который человек указал,
   * и он об этом не узнает.
   */
  const [mismatch, setMismatch] = useState<
    { entered: string; expected: string; text: string } | null
  >(null)

  /**
   * «Настроить ещё одного бота» — открывает форму поверх завершённого заказа.
   *
   * ⚠️ Нужно потому, что завершённый заказ теперь НЕ пропадает с экрана: итог
   * виден всегда, а значит форма сама не откроется. Раньше её «открывало»
   * исчезновение заказа — то есть ровно тот баг, из-за которого казалось,
   * что настройка сбросилась.
   */
  const [startAnother, setStartAnother] = useState(false)

  /**
   * Приветственный экран — ПЕРВОЕ И ЕДИНСТВЕННОЕ, что видит новый человек.
   *
   * ⚠️⚠️ Раньше сразу после регистрации открывалась форма с десятком полей, и
   * человек не понимал, куда попал и зачем всё это. Теперь сначала короткое
   * «что это и зачем», кнопка «Начать» — и только потом поля.
   *
   * ⚠️ `null` = ещё не прочитали localStorage. Важно отличать от `false`:
   * иначе на первом кадре мигнёт форма, которую мы как раз прячем.
   */
  const [welcomeDone, setWelcomeDone] = useState<boolean | null>(null)
  // ⚠️ Ждём `me`: до него неизвестно, ЧЕЙ это кабинет, и можно прочитать
  // чужую отметку. Пока `welcomeDone` равно `null`, на экране нет ни
  // приветствия, ни формы — мигания не будет.
  //
  // ⚠️⚠️ НО ЖДЁМ САМ ОТВЕТ, А НЕ ОБЯЗАТЕЛЬНО `id`. При сбое запроса `useMe`
  // отдаёт объект БЕЗ `id` (см. `.catch` в хуке) — с условием «нет id → выход»
  // экран завис бы навсегда: ни приветствия, ни полей. Тогда читаем по общему
  // ключу: хуже, чем по кабинету, но лучше пустого экрана.
  useEffect(() => {
    if (!me) return
    try {
      setWelcomeDone(localStorage.getItem(welcomeKey(me.id)) === '1')
    } catch {
      // Приватный режим / запрет хранилища — приветствие просто не запомнится.
      setWelcomeDone(false)
    }
  }, [me])
  const startWelcome = () => {
    try { localStorage.setItem(welcomeKey(me?.id), '1') } catch { /* см. выше */ }
    setWelcomeDone(true)
  }

  const confirmStep = async (step: 'bot' | 'group' | 'channel',
                             acceptEntered = false) => {
    setConfirming(step)
    setStepNote(null)
    try {
      let res: any
      if (step === 'bot') res = await api.tgAutosetup.confirmStartedBot(acceptEntered)
      else if (step === 'group') res = await api.tgAutosetup.confirmJoinedGroup()
      else res = await api.tgAutosetup.confirmChannel()
      // Вошли не тем аккаунтом — спрашиваем, а не отмечаем шаг молча.
      if (res?.mismatch) {
        setMismatch({
          entered: res.entered_username || '',
          expected: res.expected_username || '',
          text: res.message || '',
        })
        return
      }
      setMismatch(null)
      // Бэкенд отвечает `verified:false` + текстом, когда подтвердить не вышло.
      if (res?.message) {
        setStepNote({ step, ok: res.verified !== false, text: res.message })
      }
      await load(true)
    } catch (e: any) {
      setStepNote({ step, ok: false, text: e?.message || 'Не удалось отметить шаг' })
    } finally {
      setConfirming(null)
    }
  }

  /**
   * ⚠️⚠️ ПОЧТА ПЕРЕЕХАЛА В ШАГ НОЛЬ (18.09.2026). Здесь были состояния и
   * функции повторной отправки письма и кнопки «Я подтвердила» — вся эта
   * работа теперь в компоненте `StepZero`, который идёт ПЕРЕД формой запуска.
   * Держать вторую точку с тем же требованием значило бы просить человека об
   * одном и том же дважды и чинить потом в двух местах.
   */

  /**
   * ⚠️⚠️ ШАГ НОЛЬ — ПЕРВЫЙ ШАГ НАСТРОЙКИ (18.09.2026, решение владельца).
   * Пока почта не подтверждена и человек не зашёл хотя бы в одного нашего
   * бота, остальные шаги не показываем вовсе: без канала связи услуга встаёт
   * молча на первом же действии, которое требуется от клиента.
   *
   * ⚠️ `null` — «ещё не знаем»: до ответа сервера не показываем ни шаг ноль,
   * ни форму, иначе экран мигает тем, что через мгновение спрячется.
   */
  const [zeroReady, setZeroReady] = useState<boolean | null>(null)

  /**
   * ⚠️⚠️ РОЛЬ НОВОГО БОТА, когда у клиента УЖЕ есть главный (18.09.2026).
   *
   * Раньше решалось молча: есть главный — новый заводился рассылочным.
   * Человек покупал «настроим бота», получал бота, который не ведёт НИ ОДНОЙ
   * воронки, и не понимал, почему в нём ничего не работает.
   *
   * ⚠️ По умолчанию 'broadcast' — прежнее, безопасное поведение: работающего
   * бота не трогаем, пока человек сам не выберет иначе.
   */
  const [botRole, setBotRole] = useState<'main' | 'broadcast'>('broadcast')

  /** Передать права немедленно — кнопка в конце списка действий. */
  const [transferring, setTransferring] = useState(false)
  /**
   * ⚠️⚠️ ОТВЕТ НА НАЖАТИЕ — ПРЯМО ПОД КНОПКОЙ, И КНОПКА НЕ «ОТЖИМАЕТСЯ».
   *
   * Ручка `transfer-now` только БУДИТ фоновую задачу и отвечает мгновенно —
   * сама передача идёт в Telegram 20-30 секунд. Раньше `transferring`
   * сбрасывался сразу после ответа: кнопка моргала и возвращалась в прежний
   * вид, ничего не писалось. Человек не понимал, нажалась она вообще или нет
   * («она отжатая, ничего не пишется, не стала бледной»).
   *
   * Теперь: нажали → кнопка остаётся заблокированной с подписью «Передаём…»,
   * под ней появляется строка о том, что идёт и сколько ждать. Снимаем блок
   * только когда права реально переданы (это видит опрос) или при ошибке.
   */
  const [transferNote, setTransferNote] = useState<string | null>(null)

  /**
   * Правка ника канала ПРЯМО НА ШАГЕ «добавьте бота в канал».
   *
   * ⚠️⚠️ На живом заказе 12 в профиле стоял `margoforbs_bot` вместо
   * `margoforbs_business`: бот был админом настоящего канала, а проверка
   * искала его в несуществующем — и отказ повторялся по кругу. Поправить было
   * негде: поле жило в другом разделе кабинета. Теперь оно здесь же.
   */
  const [chanFix, setChanFix] = useState<string | null>(null)
  const [savingChan, setSavingChan] = useState(false)
  const [chanFixNote, setChanFixNote] = useState<{ ok: boolean; text: string } | null>(null)
  const saveChanFix = async () => {
    const nick = (chanFix ?? '').trim().replace(/^@/, '')
    if (!nick) return
    setSavingChan(true); setChanFixNote(null)
    try {
      await api.tgAutosetup.saveChannel(nick)
      setChanFixNote({ ok: true, text: `Сохранили: @${nick}. Теперь нажмите «Добавил — проверьте».` })
      setChanFix(null)
      await load(true)
    } catch (e: any) {
      // Бэкенд проверяет, что канал существует и что это канал, — текст оттуда.
      setChanFixNote({ ok: false, text: e?.message || 'Не удалось сохранить ник' })
    } finally {
      setSavingChan(false)
    }
  }
  const transferNow = async () => {
    setTransferring(true)
    setTransferNote('Запустили передачу — обычно занимает до полуминуты. '
      + 'Не закрывайте страницу, статус обновится сам.')
    try {
      await api.tgAutosetup.transferNow()
      await load(true)
    } catch (e: any) {
      setTransferring(false)
      setTransferNote(null)
      alert(e?.message || 'Не удалось запустить передачу')
    }
    // ⚠️ `finally` НЕТ намеренно: блок с кнопки снимает опрос, когда увидит
    // `bot_transferred`. Сбросить здесь — вернуть ту же неясность.
  }

  // ⚠️ Снимаем блок с кнопки передачи, когда права РЕАЛЬНО переданы — это
  // видит опрос. Без этого кнопка осталась бы «Передаём…» навсегда: сама
  // ручка отвечает мгновенно и о результате ничего не знает.
  useEffect(() => {
    if (state?.order?.steps?.bot_transferred) {
      setTransferring(false)
      setTransferNote(null)
    }
  }, [state?.order?.steps?.bot_transferred])

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Автообновление статуса.
  useEffect(() => {
    const st = state?.order?.setup_state
    const active = st === 'queued' || st === 'running' || st === 'awaiting_user'
    const delay = active ? POLL_ACTIVE_MS : POLL_IDLE_MS
    timer.current = setTimeout(() => load(true), delay)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [state, load])

  // ⚠️ Прокрутка — ОДИН раз (`scrolledToDone`). Экран обновляется сам каждые
  // 5–30 секунд, и без замка страницу дёргало бы вниз при каждом обновлении,
  // пока человек читает.
  //
  // ⚠️ Скроллим к ТОМУ, ЧТО СЕЙЧАС ПОКАЗАНО: после передачи прав это Шаг 3, а
  // не поздравление (оно ждёт «Завершить»). Без этого прокрутка целилась в
  // пустой `doneRef` и не срабатывала вовсе — человек не замечал, что экран
  // сменился.
  // ⚠️ Отметку «нажал Завершить» читаем ЗДЕСЬ, из `state`, а не из `order`:
  // `order` вычисляется ниже ранних возвратов (loading/noAccess), и хук,
  // поставленный там, нарушил бы порядок хуков React при первой отрисовке.
  useEffect(() => {
    const id = state?.order?.id
    if (!id) return
    try { setStep3Done(localStorage.getItem(`plusson_autosetup_step3_${id}`) === '1') }
    catch { setStep3Done(false) }
  }, [state?.order?.id])

  useEffect(() => {
    if (state?.order?.setup_state !== 'done') return
    if (scrolledToDone.current) return
    const target = step3Ref.current || doneRef.current
    if (!target) return
    scrolledToDone.current = true
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // ⚠️ Зависимость только от `state`: `showStep3`/`showDone` объявлены ниже
    // (после ранних возвратов), и ссылка на них здесь — ошибка «use before
    // declaration», роняющая сборку. Экран обновляется опросом каждые 5 секунд,
    // так что эффект всё равно переотработает, когда блок появится в DOM.
  }, [state, step3Done])

  const checkName = async () => {
    setChecking(true); setNameCheck(null)
    try {
      const r = await api.tgAutosetup.checkName(username)
      setNameCheck({ free: !!r.free, message: r.message || '' })
    } catch {
      setNameCheck({ free: false, message: 'Не удалось проверить, попробуйте ещё раз' })
    } finally {
      setChecking(false)
    }
  }

  const start = async () => {
    // ⚠️⚠️ ПОЛЯ СОХРАНЯЮТСЯ ЗДЕСЬ, отдельной кнопки «Сохранить» нет.
    // Она сбивала с толку: человек нажимал и не понимал, куда сохранилось —
    // в кабинет уже или только «в форму». Теперь точка одна: нажал «Поставить
    // в очередь» — данные легли в настройки кабинета, и об этом говорит лог.
    if (!effNick || !effSupport || !effChannel) {
      putNickError('Заполните все три поля — они нужны для настройки')
      return
    }
    setStarting(true)
    putNickError(null)
    try {
      await saveNick()
      // ⚠️ Дальше идём, только если сохранение прошло: `saveNick` ставит
      // `nickError` и ничего не бросает, поэтому проверяем результат сами —
      // иначе задача уйдёт в очередь с неприменёнными настройками.
      if (nickErrorRef.current) { setStarting(false); return }

      const r = await api.tgAutosetup.start(
        username, title || undefined, effChannel || undefined,
        state.existing_main_bot ? botRole : undefined)
      if (r.payment_url) { window.location.href = r.payment_url; return }
      await load()
    } catch (e: any) {
      alert(e?.message || 'Не получилось запустить настройку')
    } finally {
      setStarting(false)
    }
  }

  if (loading && !state) {
    return (
      <div className="flex items-center gap-2 text-gray-500 py-12 justify-center">
        <Loader2 size={18} className="animate-spin" /> Загружаем…
      </div>
    )
  }

  /**
   * Услуга ещё не открыта — показываем, ЧТО она делает, и куда идти за ней.
   *
   * ⚠️⚠️ ФОРМЫ КОДА ЗДЕСЬ НЕТ НАМЕРЕННО. Код вводится в ОДНОМ месте — в
   * карточке услуги на странице «Подписка», рядом с остальными покупками.
   * Два места ввода означали бы, что человек ищет, где именно «правильно»
   * подключить, и оба надо чинить при каждой правке.
   */
  if (noAccess) {
    return (
      /* ⚠️ БЕЗ `max-w-*`: ширину и поля задаёт DashboardLayout
         (`max-w-6xl mx-auto px-4 …`). Своё ограничение поверх неё не
         «выравнивает», а РЕЖЕТ страницу ещё уже — у клиента полэкрана пустует. */
      <div>
        <div className="rounded-2xl p-6 text-white"
             style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <div className="flex items-start gap-3">
            <Sparkles size={22} style={{ color: '#FFCFA4' }} className="mt-1 shrink-0" />
            <div className="flex-1">
              <h2 className="text-xl font-bold">Автонастройка ПЛЮСОНа и экспресс-подключение</h2>
              <p className="text-white/80 text-sm mt-1">
                Настроим Telegram за вас — вам останется два нажатия.
              </p>

              <p className="text-white/60 text-xs uppercase tracking-wide mt-5 mb-2">
                Что сделаем за вас
              </p>
              <ul className="space-y-1.5">
                {AUTOSETUP_STEPS.map((b, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-white/85">
                    <Check size={15} style={{ color: '#FFCFA4' }} className="mt-0.5 shrink-0" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>

              <p className="text-white/60 text-xs uppercase tracking-wide mt-5 mb-2">
                От вас — два действия
              </p>
              <ul className="space-y-1.5">
                {AUTOSETUP_FROM_CLIENT.map((b, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-white/85">
                    <span className="shrink-0 mt-0.5 w-[15px] text-center text-xs font-bold"
                          style={{ color: '#FFCFA4' }}>{i + 1}</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>

              <ul className="mt-5 space-y-1.5">
                {AUTOSETUP_NOT_INCLUDED.map((b, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-white/55">
                    <span className="shrink-0 mt-0.5">—</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>

              {/* ⚠️ «Бесплатно · Скоро будет» — честное состояние: цена 0, но
                  услуга ещё в обкатке и всем не открыта. */}
              <div className="mt-5 flex items-center gap-3 flex-wrap">
                <div className="text-2xl font-bold" style={{ color: '#FFCFA4' }}>
                  Бесплатно
                </div>
                <span className="px-2.5 py-1 rounded-lg text-xs font-semibold"
                      style={{ background: '#FFCFA4', color: '#25455D' }}>
                  СКОРО БУДЕТ
                </span>
              </div>

              <p className="mt-4 text-sm text-white/70 leading-relaxed">
                Пока подключаем по промокоду — за ним{' '}
                <Link href={SUPPORT_URL} className="underline hover:text-white"
                      style={{ color: '#FFCFA4' }}>
                  обратитесь в тех.поддержку
                </Link>
                .
              </p>

              {/* ⚠️ Ведём ТОЧНО К КАРТОЧКЕ услуги (#service-tg_autosetup), а не
                  на верх страницы подписки: там тарифы, модули и история, и
                  услугу пришлось бы искать прокруткой. Якорь у карточки есть. */}
              <Link href="/dashboard/subscription#service-tg_autosetup"
                    className="btn-gold inline-block mt-4 px-5 py-2.5 text-sm font-semibold">
                Подключить по промокоду
              </Link>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!state) return null

  /**
   * ⚠️⚠️ ЗАКАЗА НЕТ — ЭТО `{}`, А НЕ `undefined`.
   *
   * `_order_out` на бэкенде при отсутствии заказа возвращает ПУСТОЙ ОБЪЕКТ.
   * В JavaScript `{}` — истина, поэтому проверка «заказа нет» (`!order`) не
   * срабатывала, и форма ввода имени бота не рисовалась ВООБЩЕ: человек с
   * выданной услугой видел только тёмную витрину и не мог ничего запустить.
   *
   * Приводим к `undefined` по наличию `id` — единственного поля, которое есть
   * у настоящего заказа всегда.
   */
  const order = state.order?.id ? state.order : undefined
  const st = order?.setup_state
  const inProgress = st === 'queued' || st === 'running'
  /**
   * ⚠️ `failed` ПОКАЗЫВАЕМ ТАК ЖЕ, как «ждём ваших действий».
   *
   * Состояния `failed` в списке не было вовсе, и экран становился ПУСТЫМ:
   * человек нажимал «Передать мне», задача останавливалась после двух попыток
   * — и всё исчезало. Ни чек-листа, ни причины, ни кнопки повторить.
   *
   * На деле сорвался ОДИН шаг (передача прав), а бот и группа уже созданы и
   * работают. Значит показывать надо то же самое, только с красной причиной
   * и возможностью повторить.
   */
  const failedTransfer = st === 'failed'
  const waitingUser = st === 'awaiting_user' || failedTransfer
  const finished = st === 'done'
  const expired = st === 'expired'
  /**
   * Форма закрыта на правку — процесс уже пошёл.
   *
   * ⚠️ Признак считает БЭКЕНД (`_order_out.locked`): экран и сервер должны
   * одинаково понимать, что значит «уже поздно менять». Здесь только
   * подстраховка на случай старого ответа без поля.
   */
  const locked = order?.locked ?? (inProgress || waitingUser)

  /**
   * Показать приветствие вместо полей.
   *
   * ⚠️ Только НОВИЧКУ: есть заказ (в работе, готовый, сгоревший) — человек уже
   * в процессе, приветствовать поздно, ему нужен статус. Пока `welcomeDone`
   * равно `null` (localStorage ещё не прочитан) полей тоже не показываем —
   * иначе форма мигает на первом кадре ровно в том виде, который мы прячем.
   */
  const showWelcome = !order && welcomeDone === false

  /**
   * ⚠️⚠️ ШАГ НОЛЬ ПОКАЗЫВАЕМ ТОЛЬКО НОВИЧКУ — И ТОЛЬКО ПОСЛЕ ПРИВЕТСТВИЯ.
   *
   * ⚠️ `!order` обязателен (решение владельца 18.09.2026): у кого настройка уже
   * идёт или завершена — ничего не меняется. Иначе человек с заказом в работе
   * увидел бы вместо своего статуса новый экран и решил, что настройка
   * сбросилась. Именно так сейчас висят заказы Влады и Екатерины.
   */
  const showStepZero = !order && welcomeDone === true && zeroReady !== true

  /**
   * Поля и форма запуска — когда приветствие пройдено И шаг ноль закрыт.
   *
   * ⚠️ У существующего заказа (`!!order`) условие про шаг ноль не действует:
   * человек уже в процессе, задерживать его нечем.
   */
  const introPassed = !!order || (welcomeDone === true && zeroReady === true)

  /**
   * ШАГ 3 — между передачей прав и поздравлением.
   *
   * ⚠️⚠️ Права уходят АВТОМАТИЧЕСКИ, через минуту после создания группы (в
   * группу человека добавляет сам сервисный аккаунт, и этого уже достаточно
   * для `_finish_setup`). Поэтому экран перескакивал на зелёный итог, а шаги
   * «юрданные» и «бот в канал» человек не успевал даже увидеть.
   *
   * Теперь: настройка `done` → показываем Шаг 3, а поздравление держим, пока
   * не нажали «Завершить». Отметка про завершение — в localStorage: это
   * состояние ЭКРАНА (что человек уже прочитал), а не данные кабинета.
   */
  /** Шаг 3 виден: настройка завершена, но человек ещё не нажал «Завершить». */
  const showStep3 = finished && step3Done === false && !startAnother
  /** Поздравление — только ПОСЛЕ «Завершить». */
  const showDone = finished && step3Done === true && !startAnother
  const finishSetup = () => {
    try {
      if (order?.id) localStorage.setItem(`plusson_autosetup_step3_${order.id}`, '1')
    } catch { /* приватный режим — просто не запомнится */ }
    setStep3Done(true)
  }

  /**
   * Сколько действий реально осталось человеку — ровно столько карточек ниже.
   *
   * ⚠️ Заголовок «осталось одно действие» стоял намертво и противоречил тому,
   * что видно под ним: там бывает до трёх шагов. Считаем то же самое, чем
   * управляется показ карточек, — иначе цифра снова разойдётся с экраном.
   */
  const stepsLeft = order ? [
    !!order.bot_username && !order.steps?.client_started_bot,
    !!order.steps?.group_created && !order.steps?.client_joined,
    !!order.bot_username && !order.steps?.channel_linked,
  ].filter(Boolean).length : 0

  /**
   * ⚠️ ОПЛАЧЕННЫЙ ЗАКАЗ ГЛАВНЕЕ РЫЧАГА «СКОРО».
   *
   * `coming_soon` закрывает ПРОДАЖУ (нет кнопки оплаты), а не саму услугу.
   * Раньше по нему пряталась и форма ввода имени бота — и клиент, которому
   * услугу уже выдали (оплата мимо кассы, отметка админом), видел «Услуга
   * скоро появится» и не мог ничего запустить. Поймано у клиента 174.
   *
   * `status='paid'` — единственный признак, что человеку услуга положена;
   * `setup_state` тут не годится: у нового заказа он `new`, как и у ещё
   * не оплаченного.
   */
  const paid = order?.status === 'paid'

  /**
   * ⚠️⚠️ УСЛУГА ДОСТУПНА — ЗНАЧИТ ФОРМА ОТКРЫТА, даже если заказа ещё нет.
   *
   * Здесь была ошибка: доступ определялся по ОПЛАЧЕННОМУ ЗАКАЗУ (`paid`).
   * Но при выдаче по коду заказа нет вовсе — есть только фича, а заказ
   * рождается уже при запуске настройки. Из-за этого человек вводил код,
   * получал доступ и всё равно видел «СКОРО» без единой кнопки.
   *
   * Признак доступа — сам факт, что эта ручка ответила: `_assert_feature`
   * отдаёт 403 всем, у кого фичи нет, и до отрисовки дело не доходит
   * (показывается экран ввода кода). Значит `coming_soon` здесь означает
   * ровно одно: продажа за деньги закрыта — а доступ у человека уже есть,
   * и прятать по нему форму нельзя.
   */

  return (
    /* ⚠️⚠️ БЕЗ `max-w-*` НА КОРНЕ (правило владельца). Ширину и поля задаёт
       обёртка кабинета DashboardLayout: `max-w-6xl mx-auto px-4 sm:px-6 lg:px-8`.
       Здесь стоял `max-w-3xl` — это ~768px внутри 1152px обёртки, то есть треть
       экрана пустовала. Эталон — events/page.tsx и broadcasts/page.tsx: корень
       без ограничений ширины. */
    <div>
      {/*
        ⚠️ ТЁМНОЙ ВИТРИНЫ ЗДЕСЬ НЕТ НАМЕРЕННО.

        До этого экрана доходит только тот, у кого услуга УЖЕ подключена:
        без доступа ручка отдаёт 403 и рисуется отдельный экран «Скоро будет»
        с описанием и переходом в «Подписку». Значит рассказывать здесь, что
        входит в услугу и сколько она стоит, некому — человек за этим уже
        пришёл. Блок на пол-экрана только отодвигал вниз то, ради чего
        открывают вкладку: поля ника и имени бота.
      */}

      {/*
        ─── Ник в Telegram: спрашиваем и сохраняем ЗДЕСЬ ЖЕ ───

        ⚠️ Раньше тут висела плашка «укажите ник в Настройках»: человек уходил
        в другой раздел, искал вкладку и часто не возвращался. Поле в кабинете
        необязательное — значит закрыть пробел должна сама настройка «под ключ»:
        без ника некому передать права на бота и группу.

        ⚠️ Ник показываем и когда он УЖЕ есть — с просьбой проверить: в кабинет
        его мог вписать кто угодно (или это ник другого человека), а ошибка
        всплывёт в самом конце, когда бот уже создан и передавать его будет
        некому. Поправленное сохраняется сразу, без ухода со страницы.
      */}
      {/* ⚠️⚠️ ПРИВЕТСТВИЕ — И БОЛЬШЕ НИЧЕГО НА ЭКРАНЕ (решение владельца
          16.09.2026). Раньше человек, только что зарегистрировавшийся, попадал
          сюда и видел СРАЗУ кучу полей: «непонятно, что к чему», «хреновая туча
          каких-то полей». Первый экран должен объяснить, что это и зачем, —
          и всё. Поля появляются только после «Начать».

          ⚠️ Показываем ОДИН РАЗ и только тому, у кого заказа ещё нет: человек,
          вернувшийся дозаполнить, видит сразу поля — иначе приветствие на
          третьем заходе только мешает. Отметка живёт в localStorage, потому
          что это вопрос удобства экрана, а не данные кабинета. */}
      {showWelcome && (
        <div className="rounded-2xl p-7 sm:p-10 mb-5 text-white"
             style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          {/* ⚠️⚠️ ТЕКСТ ВЛАДЕЛЬЦА — ДОСЛОВНО, НЕ ПЕРЕПИСЫВАТЬ.
              Первая версия была «причёсана» мной в связную речь: смысл тот же,
              слова мои. Владелец на это прямо указала — «я другой текст тебе
              присылала». Тон здесь и есть ценность: живой, на «ты с задачей»,
              со смайликом и тройным восклицательным. Правки — только от
              владельца, не «для стройности». */}
          {/* ⚠️ КРУПНО И С ВОЗДУХОМ. Мелкий плотный текст владелец физически
              не читает («всё, что мелко, я вообще не смогла прочитать»).
              Здесь: заголовок 30–40px, абзацы 18–20px, между абзацами —
              двойной отступ (mt-7), а не слипшиеся строки. */}
          <h2 className="text-3xl sm:text-4xl font-bold leading-tight">
            {firstName ? `${firstName}! ` : ''}Добрейшего-богатейшего
            и добро-пожаловать в ПЛЮСОН от iViSiON!!!
          </h2>

          <p className="text-xl sm:text-2xl font-bold mt-7"
             style={{ color: '#FFCFA4' }}>
            Это сервис автонастройки!
          </p>

          <p className="text-lg sm:text-xl text-white mt-7 leading-relaxed">
            Если вы из тех, кто не любит ничего технического — но хочет, чтобы
            всё заработало САМО, — вам сюда.
          </p>

          <p className="text-lg sm:text-xl text-white/95 mt-7 leading-relaxed">
            Мы тоже хотим, чтобы вы сэкономили время и нервы. И уже сегодня
            у вас заработали и чат-боты, и воронки. И вы могли максимально
            комфортно автоматизировать до 90% технических задач для привлечения
            клиентов.
          </p>

          <p className="text-lg sm:text-xl text-white/95 mt-7 leading-relaxed">
            Просто заполните несколько полей про себя — мы разложим это всё
            по нужным настройкам. И создадим для вас бот, канал уведомлений
            и сделаем всё то, что у вас обычно вызывает сопротивление :)
          </p>

          <p className="text-2xl sm:text-3xl font-bold mt-7"
             style={{ color: '#FFCFA4' }}>
            Это бесплатно.
          </p>

          <p className="text-lg sm:text-xl text-white mt-7">
            Нажмите на кнопку «Начать»
          </p>
          {/* ⚠️ Главное действие экрана — крупно и капсом: это единственное,
              что человек должен здесь нажать. */}
          <button onClick={startWelcome}
                  className="btn-gold mt-8 px-16 py-5 text-2xl font-bold uppercase tracking-wide">
            Начать
          </button>
        </div>
      )}

      {/* ─── ШАГ НОЛЬ: почта + бот поддержки ───
          ⚠️⚠️ ПЕРВЫЙ ШАГ НАСТРОЙКИ, сразу после приветствия (решение владельца
          18.09.2026). Пока он не пройден, остальные шаги не показываем вовсе:
          без рабочего канала связи услуга встаёт молча на первом же действии,
          которое требуется от клиента (зайти в бота, открыть приватность).

          ⚠️ Разметка — общий компонент StepZero: его же показывает демо-
          страница /dashboard/help/step-zero-preview. Копии быть не должно.

          ⚠️ Тем, у кого настройка уже идёт или завершена, шаг НЕ показывается
          (`!order` внутри `showStepZero`) — иначе человек увидел бы вместо
          своего статуса новый экран и решил, что настройка сбросилась. */}
      {showStepZero && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 mb-5">
          <StepZero title="Шаг 1. Прежде чем начать"
                    onReady={ready => setZeroReady(ready)} />
        </div>
      )}

      {/* ─── Три обязательных поля: ваш ник, служба заботы, канал ─── */}
      {/*
        ⚠️⚠️ ПОКАЗЫВАЕМ ВСЕГДА, а не только при пустом нике. Раньше блок стоял
        под `!order`: у клиента с уже оплаченным заказом он исчезал целиком, и
        поправить данные перед запуском было негде — человек видел форму имени
        бота и не понимал, куда делись остальные поля.

        ⚠️ Все три ОБЯЗАТЕЛЬНЫ: без ника некому передать бота, без службы заботы
        не заработает «Тех. поддержка» в боте и на лендинге, без канала —
        проверка подписки в воронках подарков. Услуга ради этого и делается.

        ⚠️ Показываем НИКАМИ, а не ссылками: человек вводил ник, ссылку он не
        писал и знать её не обязан. В базе служба заботы хранится ссылкой —
        преобразуем на входе и выходе.
      */}
      {/* ⚠️⚠️ ПОСЛЕ ПОСТАНОВКИ В ОЧЕРЕДЬ ПОЛЯ НЕ РЕДАКТИРУЮТСЯ (16.09.2026).
          Раньше форма оставалась живой: написано «Сохранено», задача пошла в
          работу — а поля по-прежнему правились. Человек их менял, ничего не
          происходило (данные уже ушли в прогон), и выходило, что интерфейс
          соврал. Теперь идёт работа → показываем ЧТО записано, без полей. */}
      {!finished && !startAnother && locked && (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 mb-5">
          <p className="text-base font-semibold text-gray-900">Данные записаны</p>
          <p className="text-sm text-gray-600 mt-1">
            Задача уже в работе — правки в этих полях ничего не изменят.
            Поменять можно в настройках кабинета.
          </p>
          <div className="mt-3 space-y-2">
            <LockedRow label="Ваш Telegram" value={effNick}
                       where="Настройки → «Профиль»" />
            <LockedRow label="Telegram службы заботы" value={effSupport}
                       where="Настройки → «Профиль»" />
            <LockedRow label="Telegram-канал" value={effChannel}
                       where="Mini App → «Основатель»" />
          </div>
        </div>
      )}

      {introPassed && (startAnother || (!finished && !locked)) && (
        <div className={`rounded-xl border px-5 py-4 mb-5 ${
          allFilled ? 'border-gray-200 bg-white' : 'border-amber-300 bg-amber-50'}`}>
          <div className="flex gap-3">
            {!allFilled && (
              <AlertTriangle size={20} className="text-amber-600 shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0">
              {/* ⚠️ КРУПНЕЕ, ЧЕМ БЫЛО. Подписи на 12px («text-xs») клиент
                  физически не прочитал — «всё, что мелко, я вообще не смогла
                  прочитать, хотя сижу в 20 сантиметрах от компа». Базовый
                  размер здесь 14px и выше, серого мелкого текста нет. */}
              <p className={`text-base font-semibold ${
                allFilled ? 'text-gray-900' : 'text-amber-900'}`}>
                Введите или скорректируйте данные
              </p>
              <p className={`text-sm mt-1 ${
                allFilled ? 'text-gray-600' : 'text-amber-900'}`}>
                Проставим их в настройках кабинета, когда поставите задачу
                в очередь. Все три обязательны.
              </p>

              {/* ⚠️ Первые два поля — в ДВЕ КОЛОНКИ: это пара «кому передать
                  бота» / «кому писать за помощью», их сравнивают глазами
                  (часто это один и тот же аккаунт). Канал — отдельная строка
                  ниже: он не про людей, а про проверку подписки.
                  На телефоне колонки складываются в одну (`sm:`). */}
              <div className="mt-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                <NickField
                  label="Ваш Telegram"
                  hint="На этот аккаунт передадим права на бота и группу"
                  value={effNick}
                  filled={!!state.telegram_username}
                  onChange={v => { setNick(v); setNickSaved(false); putNickError(null) }}
                />
                <NickField
                  label="Telegram службы заботы"
                  hint="По нему люди напишут вам из бота и с лендинга — можно тот же аккаунт"
                  value={effSupport}
                  filled={!!state.support_username}
                  onChange={v => { setSupportNick(v); setNickSaved(false); putNickError(null) }}
                />
                </div>
                <NickField
                  label="Никнейм вашего Telegram-канала"
                  hint="Нужен ПУБЛИЧНЫЙ канал: по нему заработает проверка подписки в воронках подарков"
                  value={effChannel}
                  filled={!!state.channel_username}
                  onChange={v => { setChanNick(v); setNickSaved(false); putNickError(null) }}
                />
              </div>

              {nickSaved && (
                <p className="mt-2 text-sm text-green-700 flex items-center gap-1.5">
                  <Check size={15} /> Сохранено
                </p>
              )}
              {nickError && (
                <p className="mt-2 text-sm text-red-600 flex items-center gap-1.5">
                  <AlertTriangle size={15} /> {nickError}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── Форма запуска ─── */}
      {/*
        ⚠️ Показываем и ОПЛАЧЕННОМУ заказу, у которого ещё нет имени бота.
        Так выглядит услуга, выданная админом без денег: заказ есть, статус
        `paid`, `setup_state='new'` — то есть человеку остаётся только назвать
        бота. Условие `!order` прятало форму, и запустить настройку было нечем.
      */}
      {introPassed && (!order || startAnother || (paid && !order.bot_username && !inProgress
                   && !waitingUser && !finished)) && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="font-semibold text-gray-900 mb-1">Как назвать бота</h3>
          {/* ⚠️ Про оплату не пишем: сюда попадает только тот, у кого услуга
              уже подключена. */}
          <p className="text-sm text-gray-500 mb-1">
            Имя латиницей, заканчивается на «bot». Проверим, свободно ли оно,
            прежде чем ставить задачу в очередь.
          </p>
          {/* ⚠️ Длину очереди показываем ДО запуска: человек сразу понимает,
              ждать ему минуту или дольше, и не пишет в поддержку «почему не
              начинается». */}
          {!!state.queue_total && state.queue_total > 0 && (
            <p className="text-sm text-gray-500 mb-4">
              Сейчас в очереди {state.queue_total}{' '}
              {state.queue_total === 1 ? 'задача' : state.queue_total < 5 ? 'задачи' : 'задач'}
              {' '}— вы встанете следующим.
            </p>
          )}
          {!state.queue_total && <div className="mb-4" />}

          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Адрес бота
          </label>
          <div className="flex gap-2">
            <div className="flex-1 flex items-center rounded-lg border border-gray-300 px-3 focus-within:border-gray-400">
              <span className="text-gray-400 select-none">@</span>
              <input
                value={username}
                onChange={e => { setUsername(e.target.value.trim()); setNameCheck(null) }}
                placeholder="medialift_bot"
                className="flex-1 py-2.5 px-1 outline-none text-sm"
              />
            </div>
            <button onClick={checkName} disabled={checking || !username}
                    className="btn-primary px-4 whitespace-nowrap">
              {checking ? <Loader2 size={15} className="animate-spin" /> : 'Проверить'}
            </button>
          </div>

          {!!state.suggestions?.length && (
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              <span className="text-xs text-gray-400 py-1">Например:</span>
              {state.suggestions.map(s => (
                <button key={s} onClick={() => { setUsername(s); setNameCheck(null) }}
                        className="text-xs px-2 py-1 rounded-md border border-gray-200 text-gray-600 hover:border-gray-400">
                  {s}
                </button>
              ))}
            </div>
          )}

          {nameCheck && (
            <div className={`mt-3 text-sm flex items-center gap-2 ${
              nameCheck.free ? 'text-green-700' : 'text-red-600'}`}>
              {nameCheck.free ? <Check size={15} /> : <AlertTriangle size={15} />}
              {nameCheck.message}
            </div>
          )}

          <label className="block text-sm font-medium text-gray-700 mt-5 mb-1.5">
            Название бота <span className="text-gray-400 font-normal">— как его увидят люди</span>
          </label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Клуб МедиаЛифт"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-gray-400"
          />

          {/* ⚠️⚠️ ССЫЛКУ НА КАНАЛ СПРАШИВАЕМ ЗДЕСЬ, В НАЧАЛЕ.
              Поймать канал автоматически нельзя: апдейт о добавлении бота
              доходит, только пока бот в поллинге, а бот услуги создан позже его
              старта. На живом заказе клиент бота в канал добавил, а система об
              этом не узнала и писала «не удалось подтвердить».
              ⚠️ Ссылка идёт в «Каналы основателя» — по ним работает проверка
              подписки в воронках лид-магнитов и гейт в чатах. Без неё «настройка
              под ключ» оставляет эту часть пустой. */}
          {/* ⚠️ Условие про 3 дня показываем ДО оплаты, а не после — иначе споры. */}
          <div className="mt-5 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-600">
            После настройки нужно будет <b>зайти в бота и вступить в группу</b> —
            это два нажатия. Забрать бота нужно в течение {state.claim_days} дней:
            иначе он удаляется, и настройку придётся запустить заново
            (повторно платить не нужно).
          </div>

          {/* ⚠️⚠️ ПОЧТА — ОБЯЗАТЕЛЬНОЕ УСЛОВИЕ ЗАПУСКА (решение владельца).
              Через пару минут настройка упрётся в шаг, который делает сам
              человек: зайти в бота и принять права. Позвать его туда можно
              только письмом — в боте его ещё нет, а кабинет он обычно уже
              закрыл. Тот же отказ продублирован на сервере: кнопку легко
              обойти запросом мимо интерфейса. */}
          {/* ⚠️⚠️ КРУПНО И С КНОПКОЙ (16.09.2026). Плашка была набрана 12-м
              кеглем серым по жёлтому — клиент её физически не прочитал. И
              отправляла «в плашку вверху кабинета» за действием, которое можно
              сделать прямо здесь: ручка `resendVerifyEmail` уже есть, своей не
              заводим. Про «Спам» — отдельной заметной строкой: письмо чаще
              всего именно там. */}
          {/* ⚠️⚠️ ПЛАШКА ПРО ПОЧТУ ОТСЮДА УБРАНА (18.09.2026). Подтверждение
              почты переехало в ШАГ НОЛЬ — он идёт перед этой формой, и до сюда
              доходит только тот, у кого почта уже подтверждена. Держать здесь
              вторую точку с тем же требованием значило бы показывать человеку
              одно и то же дважды и чинить потом в двух местах. */}

          {/* ⚠️⚠️ У КЛИЕНТА УЖЕ ЕСТЬ БОТ — СПРАШИВАЕМ, КТО ИЗ НИХ ГЛАВНЫЙ.
              Раньше это решалось за него молча (новый шёл рассылочным), и
              человек получал бота, не ведущего ни одной воронки. Молча забрать
              воронки у работающего — не лучше. Выбирает владелец. */}
          {state.existing_main_bot && (
            <div className="mt-4 rounded-xl border-2 p-4" style={{ borderColor: '#FFCFA4' }}>
              <p className="text-base font-semibold text-gray-900">
                У вас уже есть бот @{state.existing_main_bot}
              </p>
              <p className="text-sm text-gray-600 mt-1">
                Кем сделать нового? Главный может быть только один.
              </p>
              <div className="mt-3 space-y-2">
                <label className="flex items-start gap-2.5 cursor-pointer p-3 rounded-lg border"
                       style={{ borderColor: botRole === 'broadcast' ? '#FFCFA4' : '#e5e7eb',
                                background: botRole === 'broadcast' ? '#FFF8F0' : '#fff' }}>
                  <input type="radio" name="botrole" className="mt-1"
                         checked={botRole === 'broadcast'}
                         onChange={() => setBotRole('broadcast')} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-gray-900">
                      Для рассылок
                    </span>
                    <span className="block text-xs text-gray-600 mt-0.5">
                      Воронки, регистрации и приложение остаются
                      у @{state.existing_main_bot}. Новый бот — отдельная база
                      подписчиков, чтобы делать по ней рассылки.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2.5 cursor-pointer p-3 rounded-lg border"
                       style={{ borderColor: botRole === 'main' ? '#FFCFA4' : '#e5e7eb',
                                background: botRole === 'main' ? '#FFF8F0' : '#fff' }}>
                  <input type="radio" name="botrole" className="mt-1"
                         checked={botRole === 'main'}
                         onChange={() => setBotRole('main')} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-gray-900">
                      Главный — отвечает за всё
                    </span>
                    <span className="block text-xs text-gray-600 mt-0.5">
                      Новый бот забирает воронки, регистрации, приветствия и
                      приложение. @{state.existing_main_bot} останется
                      подключённым, но только для рассылок.
                    </span>
                  </span>
                </label>
              </div>
            </div>
          )}

          <button
            onClick={start}
            // ⚠️ Запуск требует ВСЕ ТРИ поля, а не только ник: без службы
            // заботы и канала настройка дойдёт до конца и оставит их пустыми —
            // то есть не сделает половину того, ради чего услуга покупалась.
            // ⚠️ Проверки почты здесь БОЛЬШЕ НЕТ: до этой формы доходит только
            // тот, кто прошёл шаг ноль (почта подтверждена + есть бот). На
            // сервере тот же отказ остался — кнопку легко обойти запросом мимо
            // интерфейса, и эта защита снимается не здесь.
            disabled={starting || !nameCheck?.free || !allFilled}
            className="btn-gold w-full mt-4 py-3 disabled:opacity-50"
          >
            {/* ⚠️ Про деньги здесь не пишем. До этого экрана доходит только
                тот, у кого услуга уже подключена, — платить ему нечего, а
                «Настроить за 0 ₽» читалось как сбой. Кнопка ставит задачу в
                очередь, о чём и говорит подпись.
                ⚠️ Не завязываемся на `paid`: при выдаче по промокоду заказа
                нет, и ветка «оплатить» включалась у того, кто уже подключён. */}
            {starting ? 'Ставим в очередь…' : 'Поставить в очередь на автонастройку'}
          </button>
          {!nameCheck?.free && (
            <p className="text-xs text-gray-400 mt-2 text-center">
              Сначала проверьте, свободно ли имя
            </p>
          )}
        </div>
      )}

      {/* ─── Очередь ─── */}
      {/* ⚠️ Чек-лист виден С НАЧАЛА и заполняется по ходу: человек должен
          видеть ОБЪЁМ работы, а не только то, что уже сделано. */}
      {(inProgress || waitingUser) && order && (
        <ServiceChecklist steps={order.steps}
                          botUsername={order.bot_username}
                          groupLink={order.group_invite_link}
                          supportFilled={state.support_filled}
                          nickFilled={!!state.telegram_username}
                          channelFilled={!!state.channel_username}
                          log={order.setup_log} />
      )}

      {inProgress && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 mb-5">
          <div className="flex items-center gap-2.5 mb-3">
            <Loader2 size={18} className="animate-spin" style={{ color: '#25455D' }} />
            <div className="font-semibold text-gray-900">
              {st === 'queued' ? 'Вы в очереди' : 'Настраиваем…'}
            </div>
          </div>
          {/*
            ⚠️ Показываем НОМЕР В ОЧЕРЕДИ ЦИФРОЙ, а не только словами.
            Настройка идёт минутами, и без цифры экран выглядит зависшим:
            человек решает, что услуга не работает, и пишет в поддержку.
            По номеру видно движение — обновил страницу, номер уменьшился.
          */}
          {/* ⚠️ ГОВОРИМ, ЧТО ИМЕННО ПРОИСХОДИТ И СКОЛЬКО ЖДАТЬ. Настройка идёт
              минутами, и без этого экран выглядит зависшим: человек решает,
              что услуга сломалась, и уходит со страницы — а уйти как раз
              нельзя, через пару минут от него потребуется действие. */}
          {st === 'queued' && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
              {state.queue_position && state.queue_position > 1 ? (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-[#25455D]">
                      {state.queue_position}
                    </span>
                    <span className="text-sm text-gray-600">
                      — ваш номер в очереди
                      {!!state.queue_total && state.queue_total > 1 && (
                        <span className="text-gray-400"> из {state.queue_total}</span>
                      )}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1.5">
                    Перед вами {state.queue_position - 1} — начнём, как только
                    освободится место. Обычно это несколько минут.
                  </p>
                </>
              ) : state.queue_wait?.reason === 'limit' ? (
                /* ⚠️ Причину называем ЧЕСТНО, но не перекладываем на Telegram
                   («вас ограничили» — неправда, ограничение на нашем служебном
                   аккаунте) и не пишем «все менеджеры заняты» — звучит как
                   поломка. Время берём настоящее, из `cooldown_until`. */
                <p className="text-sm text-gray-700">
                  Ваш бот — следующий в очереди. У площадки Telegram есть предел
                  на количество ботов, создаваемых за раз: выжидаем его и
                  продолжим
                  {state.queue_wait.back_at
                    ? <> в {new Date(state.queue_wait.back_at).toLocaleTimeString('ru-RU',
                        { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })} МСК</>
                    : ' автоматически'}
                  {' '}— от вас ничего не нужно.
                </p>
              ) : state.queue_wait?.reason === 'slots' ? (
                <p className="text-sm text-gray-700">
                  Заявка в работе. Создаём ботов по очереди — как только дойдёт
                  до вашего, сразу продолжим и напишем.
                </p>
              ) : (
                <p className="text-sm text-gray-700">
                  Подбираем свободного настройщика — это занимает до минуты.
                </p>
              )}
              <p className="text-xs text-gray-400 mt-1.5">
                Страница обновляется сама — можно не перезагружать.
              </p>
            </div>
          )}
          {st === 'running' && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
              <p className="text-sm text-gray-700">
                Создаём бота и настраиваем его — обычно 2–3 минуты.
              </p>
              <p className="text-sm text-gray-600 mt-1.5">
                <b>Не уходите со страницы:</b> когда бот будет готов, вам нужно
                будет зайти в него и принять права владельца. Мы также напишем
                об этом на почту.
              </p>
            </div>
          )}
          {/* ⚠️ Второго списка шагов здесь НЕТ намеренно — отчёт о работе один,
              выше (ServiceChecklist). Два списка про одно и то же расходились. */}
        </div>
      )}

      {/* ─── Что осталось сделать клиенту ─── */}
      {waitingUser && order && (
        <div className="rounded-xl border-2 p-5 mb-5" style={{ borderColor: '#FFCFA4' }}>
          {/* ⚠️⚠️ ЭКРАН ЦЕЛИКОМ ЗАВИСИТ ОТ ТОГО, ИДЁТ ЛИ НАСТРОЙКА.
              «Почти готово — осталось одно действие» и «занимает меньше минуты»
              висели и на ОСТАНОВЛЕННОЙ настройке, а под ними — шаги «зайдите в
              бота», «вступите в группу» и галочки «Сделала». Человек читал бодрое
              обещание, делал шаги, которые ничего не дают (задача остановлена).
              Остановилось — так и пишем, но даём причину и кнопку доделать. */}
          {failedTransfer ? (
            <>
              {/* ⚠️⚠️ ОСТАНОВКА — НЕ ТУПИК, А «МОЖНО ДОДЕЛАТЬ» (17.09.2026).
                  Здесь стоял финальный текст «передали задачу в тех.поддержку»
                  и единственная ссылка — на поддержку. Кнопку повтора пряталo
                  условие `!failedTransfer` ниже, хотя ручка `transfer-now`
                  ИМЕННО такие заказы и умеет доделывать: она ищет и `failed`,
                  снимает стоп и обнуляет счётчик попыток. Получалось, что
                  способ есть, а человек его не видит и ждёт поддержку.
                  Заказ 8 так простоял двое суток. */}
              <h3 className="font-bold text-gray-900 mb-1">
                Настройка остановилась — можно доделать
              </h3>
              <p className="text-sm text-gray-500 mb-4">
                Что успели сделать — показано выше, это никуда не денется.
                Остался один шаг: прочитайте причину ниже, сделайте,
                что там написано, и нажмите «Доделать настройку».
              </p>
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 mb-3">
                <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
                <div className="text-sm text-amber-900">
                  {/* Причина уже по-русски и с инструкцией — её готовит
                      _human_error / GROUP_PRIVACY_HINT на бэкенде. */}
                  {order.setup_error || 'Не удалось выполнить один из шагов'}
                </div>
              </div>
              {/* ⚠️ Кнопка ведёт в ту же ручку, что и обычная передача: своей
                  логики на фронте нет, иначе две реализации разойдутся. */}
              <div className="flex flex-wrap items-center gap-3">
                {/* ⚠️ Бот может быть УЖЕ передан, а споткнуться только группа
                    (так на заказе 8). Звать это «передать права на бота» —
                    сбивать с толку: человек видит, что бот у него, и решает,
                    что кнопка не про него. Называем по тому, что осталось. */}
                <button onClick={transferNow} disabled={transferring}
                        className="btn-gold px-5 py-2.5 text-base font-semibold disabled:opacity-50 inline-flex items-center gap-2">
                  {transferring
                    ? <><Loader2 size={16} className="animate-spin" /> Доделываем…</>
                    : <><RotateCw size={16} />
                        {order.steps?.bot_transferred
                          ? 'Доделать — права на группу'
                          : 'Доделать настройку'}</>}
                </button>
                <Link href={SUPPORT_URL} className="text-sm underline text-gray-600">
                  {SUPPORT_LABEL}
                </Link>
              </div>
              {transferNote && (
                <div className="mt-3 text-sm text-gray-700">{transferNote}</div>
              )}
            </>
          ) : (
            <>
              {/* ⚠️⚠️ ЗАГОЛОВОК СЧИТАЕТ ОСТАВШИЕСЯ ШАГИ, А НЕ ВРЁТ ПРО «ОДНО».
                  «Осталось одно действие» стояло намертво, а ниже висели четыре
                  карточки — заголовок противоречил тому, что человек видел
                  прямо под ним. Считаем ровно то, что показано ниже. */}
              <h3 className="font-bold text-gray-900 mb-1">
                {stepsLeft === 0
                  ? 'Почти готово'
                  : stepsLeft === 1
                    ? 'Почти готово — осталось одно действие'
                    : `Почти готово — осталось ${stepsLeft} ${
                        stepsLeft < 5 ? 'действия' : 'действий'}`}
              </h3>
              {/* ⚠️ Прямо говорим, КАК мы поймём, что человек это сделал. Раньше
                  было «мы увидим ваши действия» — оставалось гадать, надо ли где-то
                  нажать галочку. Никаких галочек: бот узнаёт клиента по нику из
                  кабинета и отмечает шаг сам. */}
              <p className="text-sm text-gray-500 mb-4">
                Нажмите «Запустить» в своём боте — мы узнаем вас по нику
                <b> @{state.telegram_username?.replace(/^@/, '') || '…'}</b> из настроек,
                отметим шаг сами и передадим вам права владельца. Обычно занимает
                меньше минуты.
              </p>

              {/* ⚠️⚠️ КАЖДЫЙ ШАГ — ТОЛЬКО ЕСЛИ ОН ФИЗИЧЕСКИ ВОЗМОЖЕН.
                  Раньше все три карточки рисовались безусловно, и на заказе без
                  созданной группы человек видел «Вступите по ссылке» и галочку
                  «Сделала» — при том, что ссылки не существует. Просить о
                  невозможном нельзя: шаг показываем, когда есть куда идти. */}
              {!!order.bot_username && (
                <ActionRow
                  done={!!order.steps?.client_started_bot}
                  title="Зайдите в своего бота и нажмите «Запустить»"
                  hint="Проверим, что вы вошли, и передадим вам права владельца"
                  doneHint="Сделано — передаём вам права на бота"
                  href={`https://telegram.me/${order.bot_username}`}
                  label={`@${order.bot_username}`}
                  icon={<MessageSquare size={16} />}
                  onConfirm={() => confirmStep('bot')}
                  confirming={confirming === 'bot'}
                  note={stepNote?.step === 'bot' ? stepNote : null}
                  extra={mismatch ? (
                    /* ⚠️ Вошли не тем аккаунтом — спрашиваем, а не решаем
                       за человека: бот уйдёт НАВСЕГДА на тот ник, который
                       выберут здесь. */
                    <div className="mt-3 ml-10 rounded-lg border-2 px-4 py-3"
                         style={{ borderColor: '#FFCFA4' }}>
                      <p className="text-sm text-gray-900 font-medium">
                        {mismatch.text}
                      </p>
                      <div className="flex flex-wrap gap-2 mt-3">
                        <button
                          onClick={() => confirmStep('bot', true)}
                          disabled={confirming === 'bot'}
                          className="btn-gold px-4 py-2 text-sm disabled:opacity-50">
                          Передать на @{mismatch.entered}
                        </button>
                        <button
                          onClick={() => setMismatch(null)}
                          className="btn-primary px-4 py-2 text-sm">
                          Войду другим
                        </button>
                      </div>
                      <p className="text-sm text-gray-600 mt-2.5">
                        Выбрали «войду другим»? Нажмите кнопку перехода в бота
                        выше, войдите нужным аккаунтом и нажмите «Сделано».
                      </p>
                    </div>
                  ) : null}
                />
              )}

              {!!order.steps?.group_created && (
                <ActionRow
                  done={!!order.steps?.client_joined}
                  title="Группа уведомлений"
                  hint="Вступите по ссылке — после этого сделаем вас админом"
                  doneHint="Вы в группе. Ссылка продублирована в Настройках → «Каналы уведомлений»"
                  href={order.group_invite_link || undefined}
                  label="Перейти в группу"
                  icon={<Users size={16} />}
                  onConfirm={() => confirmStep('group')}
                  confirming={confirming === 'group'}
                  note={stepNote?.step === 'group' ? stepNote : null}
                />
              )}

              {/* ⚠️⚠️ КАНАЛ И ЮРДАННЫЕ ПЕРЕЕХАЛИ В ШАГ 3 (16.09.2026).
                  Они стояли здесь, но настройка успевает закончиться за
                  2-3 минуты — права передаются автоматически, как только
                  система САМА добавила человека в группу. Экран перескакивал
                  на зелёный итог, и оба шага «улетали»: владелец не успела
                  ни ИНН заполнить, ни канал подключить. Теперь они идут
                  ПОСЛЕ передачи прав, отдельным экраном, который не даёт
                  завершить настройку, пока бот не в админах канала. */}
            </>
          )}

          {/* ─── Шаг 4: передать права ───
              ⚠️ Кнопка нужна, хотя передачу делает и фоновая задача: она ходит
              раз в минуту, и человек, отметивший шаги, смотрит в неизменившийся
              экран и не понимает — ждать или сломалось. Кнопка даёт явное
              действие. Своей логики передачи здесь нет: она «будит» ту же
              задачу, чтобы не разошлись две реализации.

              ⚠️⚠️ ПРИ ОСТАНОВЛЕННОЙ НАСТРОЙКЕ КНОПКИ НЕТ. Она висела и там:
              человек жал «Передать мне» на задаче, которая уже закрыта после
              двух неудач, — нажатие ничего не меняло. Плюс внутри блока
              печаталась та же `setup_error`, что и в шапке провала, и «служебный
              аккаунт заморожен» показывалось ДВАЖДЫ. Причина — одна, вверху. */}
          {!order.steps?.bot_transferred && !failedTransfer && (
            <div className="rounded-lg border-2 px-4 py-3 mb-2.5"
                 style={{ borderColor: '#FFCFA4' }}>
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center shrink-0">
                  <ArrowRight size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-base font-semibold text-gray-900">
                    Передать права на бота и группу
                  </div>
                  {/* ⚠️ Прямо говорим, что произойдёт БЕЗ нажатия: права
                      уходят сами, ближайшей фоновой задачей. Раньше человек
                      думал, что без кнопки ничего не случится, и ждал. */}
                  <div className="text-sm text-gray-600 mt-0.5">
                    Если не нажмёте — бот будет передан вам через минуту
                  </div>
                </div>
                <button onClick={transferNow} disabled={transferring}
                        className="btn-gold px-5 py-2.5 text-base font-semibold whitespace-nowrap disabled:opacity-50">
                  {transferring ? 'Передаём…' : 'Передать сейчас'}
                </button>
              </div>

              {/*
                ⚠️ ОТВЕТ — ПРЯМО ЗДЕСЬ, ПОД КНОПКОЙ.
                Раньше причина неудачи выводилась внизу страницы и только в
                одном случае: человек нажимал «Передать мне», ждал, и НИЧЕГО не
                происходило — ни ошибки, ни объяснения. Экран выглядел
                сломанным. Ответ должен быть там же, где действие.
              */}
              {order.setup_error && (
                <div className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2.5">
                  <XCircle size={16} className="text-red-600 shrink-0 mt-0.5" />
                  <div className="text-sm text-red-800">
                    {order.setup_error}
                    <div className="mt-1.5">
                      <Link href={SUPPORT_URL} className="underline font-medium">
                        Написать в тех.поддержку
                      </Link>
                    </div>
                  </div>
                </div>
              )}
              {/* ⚠️ Ответ на нажатие — ЗДЕСЬ ЖЕ, под кнопкой, а не наверху
                  страницы: человек смотрит в это место и наверх не листает. */}
              {transferNote && !order.steps?.bot_transferred && (
                <div className="mt-3 flex items-start gap-2 rounded-lg px-3 py-2.5"
                     style={{ background: 'rgba(255, 207, 164, 0.3)' }}>
                  <Loader2 size={16} className="animate-spin shrink-0 mt-0.5"
                           style={{ color: '#25455D' }} />
                  <div className="text-sm font-medium text-gray-900">
                    {transferNote}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ⚠️ «Заберите бота» убрано: человек не понимал, что от него нужно —
              казалось, что есть какое-то отдельное действие «забрать». Забрать
              = зайти в бота, то есть тот же первый шаг. Так и пишем. */}
          {/* ⚠️ Срок «зайдите до…» на ОСТАНОВЛЕННОЙ настройке не показываем:
              торопить человека к действию, которое уже ничего не изменит,
              бессмысленно — сначала разбирается поддержка. */}
          {/* ⚠️ ПЛАШКА ПОДДЕРЖКИ — В САМОМ НИЗУ, НАД БЛОКОМ ПРО СРОК (решение
              владельца 16.09.2026). Стояла выше, среди шагов, и перебивала их. */}
          <SupportBlock />

          {order.claim_deadline && !order.steps?.bot_transferred && !failedTransfer && (
            <div className="mt-4 flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <Clock size={15} className="mt-0.5 shrink-0" />
              <span>
                Зайдите в бота до {new Date(order.claim_deadline).toLocaleDateString('ru-RU', {
                  day: 'numeric', month: 'long',
                })} — иначе он удалится, и настройку придётся запустить заново
                (платить повторно не нужно).
              </span>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          ШАГ 3 — ПОСЛЕ ПЕРЕДАЧИ ПРАВ, ДО ПОЗДРАВЛЕНИЯ (16.09.2026)

          ⚠️⚠️ ЗАЧЕМ ОТДЕЛЬНЫЙ ЭКРАН. Права на бота уходят автоматически, как
          только система сама добавила человека в группу, — через минуту после
          её создания. Экран перескакивал сразу на зелёный итог, и два важных
          шага «улетали»: человек не успевал ни юрданные заполнить, ни бота в
          канал добавить. Теперь между передачей и поздравлением стоит этот
          экран, и поздравление не показывается, пока не нажали «Завершить».

          ⚠️⚠️ БОТ В КАНАЛЕ — ОБЯЗАТЕЛЕН, БЕЗ ВЫХОДА. Воронки лид-магнитов
          проверяют подписку на канал основателя: пока бот не админ, ссылки
          блокируются и материал не выдаётся вовсе
          (`lead-magnets/page.tsx`, ветка `blocked`). Отпустить человека без
          этого — отдать ему нерабочий кабинет.
          ══════════════════════════════════════════════════════════════════ */}
      {showStep3 && order && (
        <div ref={step3Ref} className="rounded-xl border-2 p-5 sm:p-6 mb-5 scroll-mt-4"
             style={{ borderColor: '#FFCFA4' }}>
          <h3 className="text-2xl sm:text-3xl font-bold text-gray-900">
            Шаг 3. Осталось два дела
          </h3>
          <p className="text-base text-gray-700 mt-2">
            Бот <b>@{order.bot_username}</b> уже ваш. Без этих двух шагов
            воронки и регистрации работать не будут.
          </p>

          {/* ── Юрданные ── */}
          <div className="mt-6">
            <PolicyStep
              published={!!order.steps?.policy_published}
              skipped={!!order.steps?.policy_skipped}
              onDone={() => load(true)}
              defaultEmail={state.email}
            />
          </div>

          {/* ── Бот в канал: ОБЯЗАТЕЛЬНО ── */}
          <div className="mt-4 rounded-lg border-2 px-4 py-4"
               style={{ borderColor: order.steps?.channel_linked ? '#86efac' : '#FFCFA4' }}>
            <div className="flex items-start gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                order.steps?.channel_linked ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-400'}`}>
                {order.steps?.channel_linked ? <Check size={17} /> : <Users size={17} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-base font-semibold text-gray-900">
                  Добавьте бота <b>@{order.bot_username}</b> в свой канал
                </div>
                {order.steps?.channel_linked ? (
                  <div className="text-sm text-green-800 mt-1">
                    Канал подключён — воронки заработали.
                  </div>
                ) : (
                  <>
                    <div className="text-sm text-gray-700 mt-1 leading-relaxed">
                      Администратором, с правом «Публикация сообщений».
                      Без этого воронка не проверит подписку и подарок
                      не выдастся — материал просто не придёт человеку.
                    </div>

                    {/* ⚠️⚠️ ПОЛЕ КАНАЛА — ПРЯМО ЗДЕСЬ (требование владельца
                        16.09.2026). Человек видит, КАКОЙ ник у нас записан, и
                        может тут же его исправить. На живом заказе 12 в
                        профиле стоял `margoforbs_bot` вместо
                        `margoforbs_business` — бот был админом настоящего
                        канала, а проверка искала его в несуществующем, и
                        отказ повторялся по кругу. Поправить было негде: поле
                        жило в другом разделе кабинета. */}
                    <div className="mt-3">
                      <label className="block text-sm font-medium text-gray-800 mb-1.5">
                        Ваш канал — ник, куда добавляли бота
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <div className="flex-1 min-w-[200px] flex items-center rounded-lg border border-gray-300 bg-white px-3">
                          <span className="text-gray-400 select-none">@</span>
                          <input
                            value={chanFix ?? (state.channel_username || '')}
                            onChange={e => setChanFix(e.target.value.trim().replace(/^@/, ''))}
                            placeholder="ваш_канал"
                            className="flex-1 py-2.5 px-1 outline-none text-sm bg-transparent"
                          />
                        </div>
                        <button onClick={saveChanFix}
                                disabled={savingChan || !(chanFix ?? '').trim()}
                                className="btn-primary px-4 py-2.5 text-sm disabled:opacity-40">
                          {savingChan ? 'Сохраняем…' : 'Сохранить ник'}
                        </button>
                      </div>
                      <p className="text-sm text-gray-500 mt-1.5">
                        Это ник КАНАЛА (как в адресе t.me/ваш_канал), а не бота.
                      </p>
                      {chanFixNote && (
                        <p className={`text-sm mt-2 ${
                          chanFixNote.ok ? 'text-green-700' : 'text-red-600'}`}>
                          {chanFixNote.text}
                        </p>
                      )}
                    </div>

                    <button onClick={() => confirmStep('channel')}
                            disabled={confirming === 'channel'}
                            className="btn-gold mt-4 px-6 py-3 text-base font-semibold disabled:opacity-50">
                      {confirming === 'channel' ? 'Проверяем…' : 'Добавил — проверьте'}
                    </button>
                    {stepNote?.step === 'channel' && (
                      <div className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2.5 border ${
                        stepNote.ok ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                        {stepNote.ok
                          ? <Check size={15} className="text-green-600 shrink-0 mt-0.5" />
                          : <XCircle size={15} className="text-red-600 shrink-0 mt-0.5" />}
                        <div className={`text-sm ${stepNote.ok ? 'text-green-800' : 'text-red-800'}`}>
                          {stepNote.text}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* ── Завершить ── */}
          <div className="mt-6">
            <button onClick={finishSetup}
                    disabled={!order.steps?.channel_linked}
                    className="btn-gold px-10 py-4 text-lg font-bold uppercase disabled:opacity-40 disabled:cursor-not-allowed">
              Завершить настройку
            </button>
            {!order.steps?.channel_linked && (
              <p className="text-sm text-gray-600 mt-2">
                Кнопка откроется, когда бот будет админом канала.
              </p>
            )}
          </div>

          <SupportBlock />
        </div>
      )}

      {/* ─── Готово ───
          ⚠️ `showDone`, а НЕ `finished`: поздравление ждёт нажатия «Завершить»
          на Шаге 3, и скрывается целиком, когда человек начал настраивать
          нового бота (`startAnother`) — раньше зелёный блок торчал внизу под
          открытой формой, и экран выглядел как две настройки сразу. */}
      {showDone && order && (
        /* ⚠️ ЯКОРЬ + ПРОКРУТКА: страница длинная, и готовый итог оказывался
           ниже экрана — человек его просто не видел и не понимал, что делать
           дальше. Скроллим сюда сами, как только настройка завершилась. */
        <div ref={doneRef}
             className="rounded-xl border border-green-300 bg-green-50 p-5 sm:p-6 mb-5 scroll-mt-4">
          {/* ⚠️⚠️ КРУПНО И С ПРЯМЫМ УКАЗАНИЕМ, ЧТО ДЕЛАТЬ (правило владельца).
              Было «Поздравляем — всё готово!» 16-м кеглем и пояснение серым
              14-м: «твоя хуйня под готово не читабельна». Раз человек должен
              что-то проверить — это и пишем, крупно. */}
          <h3 className="text-2xl sm:text-3xl font-bold text-green-900">
            Поздравляем!
          </h3>
          <p className="text-xl sm:text-2xl font-bold text-green-900 mt-1">
            ПРОВЕРЬТЕ, ЧТО МЫ НАСТРОИЛИ
          </p>
          <p className="text-base text-green-900/90 mt-3">
            Всё прописано в кабинете. Вот что у вас теперь есть:
          </p>

          {/* ⚠️ ИТОГ СПИСКОМ СО ССЫЛКАМИ, а не одной фразой «всё готово».
              Человек только что отдал данные и ждёт результата — ему нужно
              видеть, ЧТО именно получилось и куда нажать. */}
          <ol className="mt-4 space-y-3">
            <DoneItem n={1} title="Ваш бот"
                      href={`https://t.me/${order.bot_username}`}
                      linkText={`@${order.bot_username}`}
                      hint="Зайдите и нажмите «Открыть приложение» — увидите кабинет глазами участника." />

            {order.group_invite_link && (
              <DoneItem n={2} title="Канал уведомлений"
                        href={order.group_invite_link}
                        linkText="Открыть группу"
                        hint="Мы сохранили её в кабинете — заявки и регистрации придут сюда. Закрепите её у себя в Telegram, чтобы не потерять." />
            )}

            {(state.demo_magnets || []).map((d, i) => (
              <DoneItem key={d.id}
                        n={(order.group_invite_link ? 3 : 2) + i}
                        title={d.num === 1
                          ? 'Тестовый лид-магнит'
                          : 'Запись на консультацию'}
                        href={d.link || '/dashboard/lead-magnets'}
                        linkText={d.link ? 'Проверить выдачу' : 'Открыть'}
                        hint={d.num === 1
                          ? 'Нажмите ссылку и пройдите путь как человек со стороны — так видно, что получит ваш подписчик. Потом замените название, описание и файл на свои.'
                          : 'Человек подписывается на канал и получает ссылку, чтобы написать вам в личку. Замените текст на свой.'}
                        editHref="/dashboard/lead-magnets" />
            ))}

            {/* ⚠️ Витрина «О нас» — отдельным пунктом: она наполняется теми же
                заготовками, но живёт в ДРУГОМ разделе кабинета (Mini App →
                «Продукты»), и без этой строки человек про неё не узнает.
                Ссылка ведёт в Mini App сразу на нужную вкладку
                (`ref_tabecosystem`) — можно посмотреть глазами участника. */}
            <DoneItem n={(order.group_invite_link ? 3 : 2)
                          + (state.demo_magnets || []).length}
                      title="Раздел «О нас» в Mini App"
                      href={`https://t.me/${order.bot_username}?startapp=ref_tabecosystem`}
                      linkText="Посмотреть глазами участника"
                      hint="Мы наполнили его: два бесплатных материала и «Стратегическая сессия» со ссылкой в вашу личку. Замените тексты на свои."
                      editHref="/dashboard/mini-app?tab=products" />
          </ol>

          {/* ⚠️⚠️ ПОЛИТИКА — ОТДЕЛЬНЫМ БЛОКОМ В РЕЗУЛЬТАТАХ (правило владельца).
              Опубликована → говорим, что текст универсальный и где его править:
              это юридический документ с ИНН клиента, он вправе знать, что текст
              типовой. Не настроена → ПЕРСИКОВЫМ как незакрытый хвост, а не
              зелёным: собирать регистрации и анкеты без неё нельзя. */}
          {order.steps?.policy_published ? (
            <div className="mt-4 rounded-lg bg-white border border-green-200 px-4 py-3.5">
              <p className="text-base font-semibold text-gray-900">
                Политика обработки персональных данных — опубликована
              </p>
              <p className="text-sm text-gray-700 mt-1">
                Текст универсальный. Можете изменить его тут:{' '}
                <Link href="/dashboard/settings?tab=legal" className="underline font-medium">
                  «Настройки → Юридические данные»
                </Link>.
              </p>
            </div>
          ) : (
            <div className="mt-4 rounded-lg border-2 px-4 py-3.5"
                 style={{ borderColor: '#FFCFA4', background: 'rgba(255, 207, 164, 0.18)' }}>
              <p className="text-base font-bold text-gray-900">
                Юридические данные — не настроены
              </p>
              <p className="text-sm text-gray-800 mt-1 leading-relaxed">
                Без политики обработки персональных данных нельзя регистрировать
                людей на эфиры и собирать анкеты. Заполнить:{' '}
                <Link href="/dashboard/settings?tab=legal" className="underline font-medium">
                  «Настройки → Юридические данные»
                </Link>.
              </p>
            </div>
          )}

          <p className="mt-4 text-sm text-gray-600">
            По всем вопросам — <Link href="/dashboard/help"
              className="font-medium text-[#25455D] underline">
              наша техподдержка
            </Link>.
          </p>

          {/* ⚠️⚠️ КНОПКА «НАСТРОИТЬ ЕЩЁ ОДНОГО» — ОБЯЗАТЕЛЬНА С 16.09.2026.
              Раньше завершённый заказ ПРОПАДАЛ с экрана (ручка его не
              отдавала) — и форма запуска открывалась сама собой. Это и была
              та самая поломка «всё сбросилось»: человек видел чистую форму
              вместо итога. Теперь итог остаётся на месте, а запуск новой
              настройки — явное действие, а не побочный эффект исчезновения. */}
          <div className="mt-4 pt-4 border-t border-green-200">
            <button onClick={() => setStartAnother(true)}
                    className="text-sm font-medium text-[#25455D] underline">
              Настроить ещё одного бота
            </button>
          </div>
        </div>
      )}

      {/* ⚠️⚠️ «ЧТО ДАЛЬШЕ» — ВНЕ ЗЕЛЁНОГО БЛОКА (решение владельца 16.09.2026).
          Зелёный блок — это РЕЗУЛЬТАТЫ настройки, а каталог готовых решений к
          результатам не относится: это следующий шаг работы, а не то, что мы
          настроили. Внутри он читался как ещё один пункт итога. */}
      {showDone && order && (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-5 mb-5">
          <p className="text-xl font-bold text-gray-900">
            Что дальше?
          </p>
          <p className="text-base text-gray-700 mt-2 leading-relaxed">
            Хотите провести бесплатный эфир и собрать людей руками аудитории?
            Или упаковать свой продукт и открывать доступ к материалам?
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {hasSolutions && (
              <Link href="/dashboard/autosetup?tab=solutions"
                    className="btn-gold px-5 py-2.5 text-base font-semibold">
                Посмотреть каталог готовых решений
              </Link>
            )}
            <Link href="/dashboard/help"
                  className={hasSolutions
                    ? 'text-base font-medium text-[#25455D] underline'
                    : 'btn-gold px-5 py-2.5 text-base font-semibold'}>
              {hasSolutions ? 'или напишите нам — поможем' : 'Напишите нам — поможем'}
            </Link>
          </div>
        </div>
      )}

      {/* ─── Сгорело ─── */}
      {expired && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-5 mb-5">
          <div className="flex items-center gap-2 font-bold text-amber-900 mb-2">
            <AlertTriangle size={18} /> Бот удалён
          </div>
          <p className="text-sm text-amber-900/80 mb-4">
            {order?.setup_error || 'Бота не забрали за 3 дня, и он был удалён.'}
          </p>
          <button onClick={() => window.location.reload()} className="btn-gold px-5 py-2.5">
            Запустить настройку заново — бесплатно
          </button>
        </div>
      )}

      {/* ⚠️ ЗДЕСЬ БЫЛ ПОВТОР ТЕКСТА ОШИБКИ — УБРАН. Та же причина уже показана
          под кнопкой «Передать мне» (там, где человек нажимал), и внизу
          страницы она выглядела вторым, отдельным сбоем. */}
    </div>
  )
}

/** Строка «что сделать» с галочкой готовности. */
/**
 * Чек-лист услуги: ВСЕ обещанные шаги сразу, галочки — по мере выполнения.
 *
 * ⚠️ Показывается С НАЧАЛА настройки, а не по факту сделанного. Раньше внизу
 * копился только список уже выполненного, и объём работы был не виден: человек
 * не понимал, что вообще происходит и сколько ещё осталось. Здесь он видит
 * весь перечень и как он заполняется — это и есть подтверждение услуги.
 *
 * ⚠️ Шаги берутся из ОТМЕТОК ЗАКАЗА (`order.steps`), а не из текстового лога:
 * лог — это лента сообщений, по ней нельзя понять, что именно уже готово.
 */
/**
 * Отчёт о работе — ЕДИНСТВЕННЫЙ на экране.
 *
 * ⚠️⚠️ ВТОРОГО СПИСКА БЫТЬ НЕ ДОЛЖНО. Раньше рядом жил ещё и построчный лог
 * (`SetupLog`), и они РАСХОДИЛИСЬ: чек-лист рисовался по галочкам заказа, а лог
 * — по фактическим записям, причём в другом порядке. Человек видел два разных
 * рассказа об одной и той же работе («так группа создана или нет?») и не знал,
 * какому верить. Оставлен этот: у него есть ссылки «проверить», которых в логе
 * не было. Точность лога перенесена сюда — см. `failed` ниже.
 */
/** Пункт итога: что получилось, куда нажать и что с этим делать.
 *
 * ⚠️ У каждого пункта ОБЯЗАТЕЛЬНО есть ссылка и пояснение: «всё готово» без
 * них не говорит человеку ничего — он не знает, где теперь его бот, куда
 * придут заявки и что нужно заменить на своё.
 */
function DoneItem({ n, title, href, linkText, hint, editHref }: {
  n: number
  title: string
  href: string
  linkText: string
  hint: string
  editHref?: string
}) {
  // Внешние ссылки (t.me, приглашение в группу) открываем новой вкладкой,
  // внутренние разделы кабинета — обычным переходом.
  const external = /^https?:\/\//.test(href)
  return (
    <li className="rounded-lg bg-white border border-green-200 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full
                         bg-green-100 text-xs font-bold text-green-800">
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">{title}</p>
          <p className="text-xs text-gray-600 mt-1 leading-relaxed">{hint}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {external ? (
              <a href={href} target="_blank" rel="noreferrer"
                 className="text-sm font-medium text-[#25455D] underline break-all">
                {linkText}
              </a>
            ) : (
              <Link href={href}
                    className="text-sm font-medium text-[#25455D] underline">
                {linkText}
              </Link>
            )}
            {editHref && (
              <Link href={editHref} className="text-xs text-gray-500 underline">
                Изменить настройки
              </Link>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}


function ServiceChecklist({ steps, botUsername, groupLink, supportFilled,
                           nickFilled, channelFilled, log }: {
  steps?: Record<string, boolean>
  botUsername?: string | null
  groupLink?: string | null
  supportFilled?: boolean
  /** Поле уже заполнено в кабинете — для заказов, созданных до появления шага. */
  nickFilled?: boolean
  channelFilled?: boolean
  log?: Step[]
}) {
  const s = steps || {}

  // ⚠️ Ошибки берём ИЗ ЛОГА и раскладываем по своим пунктам — за этим лог и был
  // нужнее: он один показывал, ЧТО именно не получилось. Тексты приходят уже
  // по-русски (см. _human_error на бэкенде); английских имён исключений быть
  // не должно — если что-то просочилось, это баг бэкенда, а не фронта.
  const failedByStep: Record<string, string> = {}
  for (const e of log || []) {
    if (!e.ok && e.step) failedByStep[e.step] = e.text
  }

  /**
   * ⚠️⚠️ ШАГИ, У КОТОРЫХ НЕТ СВОЕЙ ОТМЕТКИ В ЗАКАЗЕ, БЕРЁМ ИЗ ЛОГА.
   *
   * «Служба заботы» отмечалась по `support_filled` — а это ТЕКУЩЕЕ состояние
   * поля в настройках, а не работа ЭТОГО заказа. У клиента, заполнившего его
   * на прошлой попытке, шестой пункт горел зелёным, когда бот ещё только
   * создавался: первые пять серые, шестой зелёный — выглядело так, будто
   * настройка началась с середины (поймано на живом заказе 09.09.2026).
   *
   * Лог принадлежит заказу, поэтому не врёт: пункт зеленеет ровно тогда, когда
   * шаг реально отработал в этом прогоне.
   */
  const doneByStep = new Set(
    (log || []).filter(e => e.ok && e.step).map(e => e.step)
  )

  /**
   * Поле «Служба заботы» уже было заполнено — мы его НЕ трогали.
   *
   * ⚠️ У части клиентов поддержку ведёт не владелец, а отдельный аккаунт, и
   * затирать эту настройку нельзя (правило в `_run_setup`). Значит и в отчёте
   * писать «Заполнили» нельзя — человек решит, что мы подменили ему контакт.
   * Отличаем по тексту записи: своей отметки в `steps` у шага нет.
   */
  const keptSupport = (log || []).some(
    e => e.step === 'support' && e.ok && e.text.includes('уже заполнена')
  )

  const rows: {
    done: boolean; text: string; proof?: string; proofLabel?: string
    /** Ключ шага в логе — по нему подтягивается ошибка. */
    key?: string
  }[] = [
    // ⚠️⚠️ РАССТАНОВКА ПОЛЕЙ — ПЕРВЫЕ ПУНКТЫ, И ЭТО НЕ КОСМЕТИКА.
    // Это самая безопасная часть услуги: она ничего не создаёт во внешнем мире
    // и не может «наполовину получиться». Бэкенд делает её первой (см.
    // start_setup), поэтому и в отчёте она обязана стоять первой — иначе
    // список читается вразнобой: нижние пункты зеленеют раньше верхних.
    //
    // ⚠️ Отметка ИЗ ЛОГА ЗАКАЗА (`fields_*`), а не по текущему состоянию
    // настроек: поле могло быть заполнено до услуги, и тогда пункт горел бы
    // зелёным ещё до запуска — та же ошибка, что была со «Службой заботы».
    //
    // ⚠️ Ссылка ведёт ровно туда, КУДА ЭТО ЛЕГЛО, а не в «Настройки» вообще:
    // человек должен проверить за нами, а не искать нужную вкладку.
    // ⚠️ Смотрим И на лог, И на факт в кабинете: у заказов, созданных ДО
    // появления этих шагов, записи в логе нет — но поле давно заполнено, и
    // серый кружок там читался бы как «не сделано».
    { done: doneByStep.has('fields_own') || !!nickFilled,
      text: 'Записали ваш Telegram в профиль',
      proof: '/dashboard/settings?tab=profile', proofLabel: 'Проверить' },
    { done: doneByStep.has('fields_support') || !!supportFilled,
      // Подпись честная: поле могло быть уже заполнено, и мы его не трогали.
      text: (log || []).some(e => e.step === 'fields_support' && e.text.includes('уже была заполнена'))
        ? 'Служба заботы уже была заполнена — оставили вашу'
        : 'Записали Telegram службы заботы',
      proof: '/dashboard/settings?tab=profile', proofLabel: 'Проверить' },
    { done: doneByStep.has('fields_channel') || !!channelFilled,
      text: 'Записали ваш канал в «Каналы основателя»',
      // ⚠️ Каналы основателя живут во вкладке «Основатель» раздела Mini App,
      // а НЕ в «Каналах» — там «Каналы для рассылок», другое место.
      proof: '/dashboard/mini-app?tab=owner', proofLabel: 'Проверить' },
    { done: !!s.bot_created, text: 'Создали вашего бота', key: 'bot',
      proof: botUsername ? `https://telegram.me/${botUsername}` : undefined,
      proofLabel: botUsername ? `@${botUsername}` : undefined },
    // ⚠️ Свой флаг, а не «раз бот создан, значит подключён»: подключение к
    // кабинету — отдельное действие, и оно может не пройти само по себе.
    { done: !!s.bot_channel_linked, text: 'Подключили бота к кабинету', key: 'channel',
      proof: '/dashboard/channels?tab=bots', proofLabel: 'Проверить' },
    { done: !!s.miniapp_linked, text: 'Привязали приложение (Mini App)', key: 'miniapp',
      proof: '/dashboard/mini-app', proofLabel: 'Проверить' },
    { done: !!s.group_created, text: 'Создали закрытую группу для уведомлений',
      key: 'group', proof: groupLink || undefined, proofLabel: 'Открыть группу' },
    { done: !!s.group_in_settings, text: 'Прописали группу в настройках кабинета',
      proof: '/dashboard/settings?tab=tech', proofLabel: 'Проверить' },
    // ⚠️ Отметка ИЗ ЛОГА ЗАКАЗА, а не по `support_filled`: то поле показывает
    // текущее состояние настроек и зеленело от прошлой попытки — пункт горел,
    // ⚠️⚠️ ПОРЯДОК ПУНКТОВ — КАК РАБОТАЕТ МАШИНА, А НЕ КАК УДОБНО ЧИТАТЬ.
    // «Вы вступили в группу» стояло ПОСЛЕ передачи прав, хотя в группу человек
    // попадает сразу при её создании (в логе — «Вы добавлены в группу и
    // назначены админом», ещё до захода в бота). Из-за этого нижние пункты
    // зеленели раньше верхних, и отчёт выглядел дырявым — будто часть шагов
    // пропущена. Список обязан читаться сверху вниз без «прыжков».
    { done: !!s.client_joined, text: 'Вы вступили в группу',
      proof: groupLink || undefined, proofLabel: groupLink ? 'Открыть группу' : undefined },
    { done: !!s.group_transferred, text: 'Сделали вас админом группы',
      proof: groupLink || undefined, proofLabel: groupLink ? 'Открыть группу' : undefined },
    { done: !!s.client_started_bot, text: 'Вы зашли в бота',
      proof: botUsername ? `https://telegram.me/${botUsername}` : undefined,
      proofLabel: botUsername ? `@${botUsername}` : undefined },
    // ⚠️ Отдельным пунктом: тестовые ID — то, ради чего мы ловим заход в бота.
    // По ним работает кнопка «Отправить тест» в рассылках; человек об этом не
    // знает и не понимает, откуда они взялись, — показываем, где смотреть.
    { done: !!s.client_started_bot, text: 'Записали ваш Telegram для тестов рассылок',
      proof: '/dashboard/settings?tab=tech', proofLabel: 'Проверить' },
    // ⚠️⚠️ ДЕЙСТВИЯ ЧЕЛОВЕКА ИДУТ ДО ПЕРЕДАЧИ ПРАВ, А НЕ ПОСЛЕ.
    // «Вы добавили бота в админы канала» стояло ПОСЛЕДНИМ, после «Передали вам
    // права» — то есть после финала настройки. Человек добавляет бота в канал
    // ДО передачи (это один из шагов, которые он отмечает галочкой), и пункт
    // обязан стоять там же по порядку, иначе список снова читается вразнобой.
    { done: !!s.channel_linked, text: 'Вы добавили бота в админы канала',
      proof: '/dashboard/channels?tab=chats', proofLabel: 'Проверить' },
    // ⚠️⚠️ ПОЛИТИКА — В ПЕРЕЧНЕ С САМОГО НАЧАЛА (требование владельца
    // 16.09.2026). Шаг был только в списке действий НИЖЕ, а в этом отчёте его
    // не было вовсе — человек читал «Что делаем за вас» и про ИНН с политикой
    // не узнавал: «нет реквизитов ИНН так же».
    // ⚠️ Пропуск — тоже закрытый пункт, но с другой подписью: шаг
    // необязательный, и делать вид, что он «не сделан», неверно.
    { done: !!s.policy_published || !!s.policy_skipped,
      text: s.policy_skipped && !s.policy_published
        ? 'Политику конфиденциальности вы настроите сами'
        : 'Составили и опубликовали политику конфиденциальности (по вашему ИНН)',
      proof: '/dashboard/settings?tab=legal', proofLabel: 'Проверить' },
    // Передача прав — ПОСЛЕДНИЙ шаг: им настройка и заканчивается.
    { done: !!s.bot_transferred, text: 'Передали вам права на бота', key: 'transfer',
      proof: 'https://telegram.me/BotFather', proofLabel: 'BotFather' },
  ]
  const doneCount = rows.filter(r => r.done).length

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 mb-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="font-semibold text-gray-900">Что делаем за вас</h3>
        <span className="text-sm text-gray-500 shrink-0">
          {doneCount} из {rows.length}
        </span>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => {
          // Ошибка показывается только у НЕсделанного шага: сорвалось, потом
          // получилось — говорить об этом уже незачем.
          const err = !r.done && r.key ? failedByStep[r.key] : undefined
          return (
            <div key={i}>
              <div className="flex items-center gap-2.5 text-sm">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                  r.done ? 'bg-green-500 text-white'
                         : err ? 'bg-red-100 text-red-600' : 'bg-gray-100'}`}>
                  {r.done ? <Check size={12} />
                          : err ? <XCircle size={12} />
                                : <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />}
                </span>
                <span className={r.done ? 'text-gray-800' : err ? 'text-red-700' : 'text-gray-400'}>
                  {r.text}
                </span>
                {/* ⚠️ Ссылка-подтверждение: чтобы человек мог УБЕДИТЬСЯ, что шаг
                    действительно выполнен, а не поверить на слово. */}
                {r.done && r.proof && (
                  <a href={r.proof}
                     target={r.proof.startsWith('http') ? '_blank' : undefined}
                     rel="noreferrer"
                     className="text-xs text-[#25455D] underline shrink-0 ml-auto">
                    {r.proofLabel || 'Открыть'}
                  </a>
                )}
              </div>
              {/* ⚠️ Причина — прямо под своим пунктом, а не отдельным списком
                  внизу: иначе непонятно, к какому шагу она относится. Рядом —
                  выход в поддержку: сам человек тут ничего не починит. */}
              {err && (
                <div className="ml-[30px] mt-1 text-xs text-red-600">
                  {err}{' · '}
                  {/* ⚠️ Адрес поддержки — только из SUPPORT_URL, руками не
                      прописывать: он один на весь кабинет. */}
                  <Link href={SUPPORT_URL} className="underline">
                    {SUPPORT_LABEL}
                  </Link>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Шаг, который делает САМ КЛИЕНТ: перейти по ссылке и отметить галочкой.
 *
 * ⚠️⚠️ ГАЛОЧКУ СТАВИТ ЧЕЛОВЕК, А НЕ ТОЛЬКО АВТОМАТИКА.
 *
 * Автоматика есть, но срабатывает не всегда:
 *   • заход в бота ловится, лишь пока бот слушается процессом `plusson-bot`,
 *     а бот услуги создан позже его старта — до перезапуска сервиса сообщения
 *     до нас не доходят (поймано на живом заказе: человек нажал «Запустить»,
 *     отметки нет, настройка встала);
 *   • вступление в группу приходит апдейтом `chat_member`, но только пока наш
 *     аккаунт в группе; добавить человека мы часто вообще не можем — у него
 *     закрыты настройки приватности, и он вступает сам.
 *
 * Поэтому: перешёл → отметил галочкой → по ней запускается передача прав.
 * Автоматика остаётся: сработала раньше — галочка уже стоит.
 */
function ActionRow({ done, title, hint, doneHint, href, label, icon,
                     onConfirm, confirming, note, extra }: {
  done: boolean; title: string; hint: string
  /** Что написать, когда шаг уже сделан. Пусто → «Сделано». */
  doneHint?: string
  href?: string; label: string; icon: React.ReactNode
  /** Отметить шаг выполненным. Нет — галочка не показывается. */
  onConfirm?: () => void
  confirming?: boolean
  /**
   * Ответ на нажатие «Сделано» — прямо под шагом.
   *
   * ⚠️ Нужен там, где мы ПРОВЕРЯЕМ, а не верим на слово (заход в бота, бот в
   * админах канала): человек должен видеть «подтвердили» или «подтвердить не
   * удалось» там же, где нажимал. Раньше ответ уходил в alert и не оставлял следа.
   */
  note?: { ok: boolean; text: string } | null
  /** Дополнительный блок под шагом — например выбор при расхождении ников. */
  extra?: React.ReactNode
}) {
  return (
    <div className={`rounded-lg border px-4 py-3 mb-2.5 ${
      done ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-center gap-3">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
          done ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-400'}`}>
          {done ? <Check size={15} /> : icon}
        </div>
        <div className="flex-1 min-w-0">
          {/* ⚠️ Подписи КРУПНЕЕ (14px вместо 12px): мелкий серый текст клиент
              не прочитал вовсе — см. правило в шапке файла. */}
          <div className={`text-sm font-semibold ${done ? 'text-green-900' : 'text-gray-900'}`}>
            {title}
          </div>
          <div className="text-sm text-gray-600 mt-0.5">
            {done ? (doneHint || 'Сделано') : hint}
          </div>
        </div>
        {/* ⚠️ Кнопка остаётся и у ВЫПОЛНЕННОГО шага: после вступления в группу
            попасть в неё было неоткуда — ссылку человек уже закрыл, а по
            chat_id в Telegram не вступишь. */}
        {href && (
          <a href={href} target="_blank" rel="noreferrer"
             className={`px-3 py-2 text-sm whitespace-nowrap flex items-center gap-1.5 rounded-lg ${
               done
                 ? 'border border-green-300 text-green-800 hover:bg-green-100'
                 : 'btn-primary'}`}>
            {label} <ArrowRight size={14} />
          </a>
        )}
      </div>

      {/* Отметка «я это сделал» — под строкой, чтобы не тесниться с кнопкой.
          ⚠️ «СДЕЛАНО», а не «Сделала»: кнопку видят все клиенты, и женский род
          подходит не каждому. Безличная форма годится всем. */}
      {!done && onConfirm && (
        <label className="flex items-center gap-2.5 mt-3 pl-10 cursor-pointer select-none">
          <input type="checkbox" checked={false} disabled={confirming}
                 onChange={() => onConfirm()}
                 className="w-5 h-5 rounded border-gray-300 cursor-pointer" />
          <span className="text-sm font-medium text-gray-800">
            {confirming ? 'Проверяем…' : 'Сделано'}
          </span>
        </label>
      )}

      {/* Ответ проверки — под шагом, с крестом при неудаче и выходом в заботу. */}
      {note && (
        <div className={`mt-3 ml-10 flex items-start gap-2 rounded-lg px-3 py-2.5 border ${
          note.ok ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          {note.ok
            ? <Check size={15} className="text-green-600 shrink-0 mt-0.5" />
            : <XCircle size={15} className="text-red-600 shrink-0 mt-0.5" />}
          <div className={`text-sm ${note.ok ? 'text-green-800' : 'text-red-800'}`}>
            {note.text}
            {!note.ok && (
              <div className="mt-1.5">
                <Link href={SUPPORT_URL} className="underline font-medium">
                  {SUPPORT_LABEL}
                </Link>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Доп. блок под шагом — выбор при расхождении ников. */}
      {extra}
    </div>
  )
}


/**
 * Записанное значение поля, когда правка уже невозможна.
 *
 * ⚠️ Показываем ЧТО записано и ГДЕ это поменять — вместо живого поля, которое
 * принимает ввод, но ни на что не влияет: задача уже ушла в работу.
 */
function LockedRow({ label, value, where }: {
  label: string; value: string; where: string
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5">
      <span className="text-sm text-gray-500">{label}:</span>
      <span className="text-sm font-semibold text-gray-900">
        {value ? `@${value}` : '—'}
      </span>
      <span className="text-sm text-gray-400 ml-auto">{where}</span>
    </div>
  )
}


/**
 * Шаг 3 услуги: юр-данные → политика конфиденциальности.
 *
 * ⚠️⚠️ ЗАЧЕМ ЭТО В АВТОНАСТРОЙКЕ (решение владельца 16.09.2026). Политика
 * обработки персональных данных обязательна по 152-ФЗ каждому, кто собирает
 * контакты через бота и лендинг. Раздел в кабинете для неё есть, но на
 * 16.09.2026 его не заполнил НИ ОДИН клиент — значит сам собой он не
 * заполняется. Услуга «под ключ» закрывает и это: человек вводит ИНН и
 * название, остальное платформа делает сама.
 *
 * ⚠️ ШАГ НЕОБЯЗАТЕЛЬНЫЙ — есть «Пропустить». Данные юрлица есть не у всех под
 * рукой, и упираться в них посреди настройки бота человек не должен. Пропуск
 * запоминается, и итог честно скажет «настройте самостоятельно».
 */
function PolicyStep({ published, skipped, onDone, defaultEmail }: {
  published: boolean; skipped: boolean; onDone: () => void
  /** Почта кабинета — подставляем в поле оператора, чтобы не вводить заново. */
  defaultEmail?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState('ip')
  const [name, setName] = useState('')
  const [inn, setInn] = useState('')
  const [address, setAddress] = useState('')
  // ⚠️ Почта ПО УМОЛЧАНИЮ — из кабинета (решение владельца 16.09.2026):
  // человек её только что подтверждал, второй раз спрашивать незачем.
  // Поле остаётся правимым: у части клиентов для обращений по 152-ФЗ
  // отдельный адрес.
  const [email, setEmail] = useState(defaultEmail || '')
  // Почта приходит асинхронно — подставляем, когда она появилась и человек
  // поле ещё не трогал (иначе затёрли бы его ввод).
  const touchedEmail = useRef(false)
  useEffect(() => {
    if (!touchedEmail.current && defaultEmail && !email) setEmail(defaultEmail)
  }, [defaultEmail]) // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (published) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 mb-2.5">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-full bg-green-500 text-white flex items-center justify-center shrink-0">
            <Check size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-green-900">
              Политика конфиденциальности опубликована
            </div>
            <div className="text-sm text-green-800 mt-0.5">
              Текст универсальный. Хотите под себя — поправьте в «Настройки →
              Юридические данные».
            </div>
          </div>
        </div>
      </div>
    )
  }

  const save = async () => {
    setBusy(true); setErr(null)
    try {
      await api.tgAutosetup.savePolicy({
        legal_form: form, legal_name: name.trim(), legal_inn: inn.trim(),
        legal_address: address.trim(), legal_operator_email: email.trim(),
      })
      onDone()
    } catch (e: any) {
      setErr(e?.message || 'Не удалось опубликовать политику')
    } finally {
      setBusy(false)
    }
  }

  const skip = async () => {
    setBusy(true)
    try { await api.tgAutosetup.skipPolicy(); onDone() }
    catch (e: any) { setErr(e?.message || 'Не получилось') }
    finally { setBusy(false) }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 mb-2.5">
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center shrink-0">
          <Sparkles size={15} />
        </div>
        <div className="flex-1 min-w-0">
          {/* ⚠️ Название и пояснение — по требованию владельца: человек должен
              видеть, ЗАЧЕМ это, а не «дайте ИНН непонятно почему». */}
          <div className="text-base font-semibold text-gray-900">
            Настроим юридические данные
          </div>
          <div className="text-sm text-gray-700 mt-1 leading-relaxed">
            {skipped
              ? 'Шаг пропущен — настроите сами в «Настройки → Юридические данные»'
              : 'Чтобы регистрировать людей на эфиры и собирать анкеты, нужна политика обработки персональных данных — этого требует закон. Заполните ИНН и название, остальное сделаем сами.'}
          </div>
        </div>
        {!open && (
          <button onClick={() => setOpen(true)}
                  className="btn-primary px-4 py-2 text-sm whitespace-nowrap">
            {skipped ? 'Всё же настроить' : 'Настроить'}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-800 mb-1.5">
              Кто вы по документам
            </label>
            <select value={form} onChange={e => setForm(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-gray-400">
              <option value="ip">Индивидуальный предприниматель</option>
              <option value="individual">Самозанятый (НПД)</option>
              <option value="ooo">Юридическое лицо (ООО / АО)</option>
              <option value="other">Другая форма</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-800 mb-1.5">
              Название полностью
            </label>
            <input value={name} onChange={e => setName(e.target.value)}
                   placeholder={form === 'ooo' ? 'ООО «Ромашка»'
                     : form === 'individual' ? 'Пупкин Василий Иванович'
                     : 'ИП Пупкин Василий Иванович'}
                   className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-gray-400" />
            <p className="mt-1 text-sm text-gray-500">
              {form === 'ooo' ? 'Например: ООО «Ромашка»'
                : form === 'individual' ? 'Самозанятые пишут ФИО: Пупкин Василий Иванович'
                : 'Например: ИП Пупкин Василий Иванович'}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-800 mb-1.5">
                ИНН
              </label>
              <input value={inn} onChange={e => setInn(e.target.value)}
                     placeholder="770123456789"
                     className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-gray-400" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-800 mb-1.5">
                Email для обращений
              </label>
              <input value={email}
                     onChange={e => { touchedEmail.current = true; setEmail(e.target.value) }}
                     placeholder="mail@example.ru"
                     className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-gray-400" />
              <p className="mt-1 text-sm text-gray-500">
                Подставили почту кабинета — можете поправить.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-800 mb-1.5">
              Адрес
            </label>
            <input value={address} onChange={e => setAddress(e.target.value)}
                   placeholder="г. Москва, ул. Примерная, д. 1"
                   className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-gray-400" />
          </div>

          {err && (
            <p className="text-sm text-red-600 flex items-start gap-1.5">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" /> {err}
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button onClick={save} disabled={busy}
                    className="btn-gold px-5 py-2.5 text-sm disabled:opacity-50">
              {busy ? 'Публикуем…' : 'Опубликовать политику'}
            </button>
            {/* ⚠️ «Пропустить» — равноправная кнопка, а не мелкая ссылка:
                данных юрлица может не быть под рукой, и человек не должен
                застревать здесь посреди настройки бота. */}
            <button onClick={skip} disabled={busy}
                    className="btn-primary px-5 py-2.5 text-sm disabled:opacity-50">
              Пропустить шаг
            </button>
          </div>
          <p className="text-sm text-gray-500">
            Пропустите — настроите сами в «Настройки → Юридические данные».
          </p>
        </div>
      )}
    </div>
  )
}


/**
 * Плашка «не получается — напишите в поддержку».
 *
 * ⚠️⚠️ ЗАМЕТНАЯ, А НЕ МЕЛКАЯ ССЫЛКА (решение владельца 16.09.2026). Стоит на
 * шаге, где человек застревает: он сделал всё, что просили, а система его не
 * видит. Мелкая серая строчка здесь бесполезна — её просто не читают.
 */
function SupportBlock() {
  return (
    <div className="mt-4 rounded-xl px-4 py-3.5 flex flex-wrap items-center gap-3"
         style={{ background: 'rgba(255, 207, 164, 0.35)' }}>
      <p className="text-sm font-medium text-gray-900 flex-1 min-w-[200px]">
        Что-то не получается? Напишите нам в техподдержку — поможем
      </p>
      <Link href={SUPPORT_URL} className="btn-primary px-4 py-2 text-sm whitespace-nowrap">
        Написать в поддержку
      </Link>
    </div>
  )
}

// ⚠️⚠️ ЗДЕСЬ БЫЛ ВТОРОЙ СПИСОК ШАГОВ (`SetupLog`) — УДАЛЁН, НЕ ВОЗВРАЩАТЬ.
//
// Он показывал те же шаги, что и `ServiceChecklist`, но по другим данным и в
// другом порядке — и они расходились: человек видел два отчёта об одной работе
// и спрашивал, какому верить. Плюс лог печатал сырые имена ошибок
// (`FrozenMethodInvalidError`), непонятные никому, кроме разработчика.
//
// Что было в нём ценного и куда переехало:
//   • точные причины неудач → в `ServiceChecklist`, строкой под своим пунктом;
//   • русские формулировки ошибок → `_human_error` в backend/app/tasks/tg_setup.py.
//
// Сами записи `setup_log` в базе остаются — они нужны поддержке и разбору.


/**
 * Поле ввода ника Telegram с приставкой «@».
 *
 * ⚠️ Один компонент на все три поля: они отличаются только подписью, и три
 * копии одинаковой вёрстки разъехались бы при первой же правке.
 *
 * ⚠️ Значение показывается НИКОМ даже если в базе лежит ссылка: человек вводил
 * ник, ссылку он не писал и знать её не обязан.
 */
function NickField({
  label, hint, value, filled, onChange, onEnter,
}: {
  label: string
  hint: string
  value: string
  /** Уже настроено в кабинете — подсказываем это, чтобы человек не гадал. */
  filled: boolean
  onChange: (v: string) => void
  /** Необязателен: сохранение идёт при постановке в очередь, не по Enter. */
  onEnter?: () => void
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">
        {label}
        {filled && <span className="ml-2 font-normal text-green-700">уже указано</span>}
      </label>
      <div className="flex items-center rounded-lg border border-gray-300 bg-white px-3 focus-within:border-gray-400">
        <span className="text-gray-400 select-none">@</span>
        <input
          value={value}
          onChange={e => onChange(e.target.value.trim().replace(/^@/, ''))}
          onKeyDown={e => { if (e.key === 'Enter') onEnter?.() }}
          placeholder="ник_без_собаки"
          className="flex-1 py-2.5 px-1 outline-none text-sm bg-transparent"
        />
      </div>
      <p className="mt-1 text-xs text-gray-500">{hint}</p>
    </div>
  )
}
