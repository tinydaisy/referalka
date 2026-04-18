// Система интернационализации (i18n) для поддержки русского и английского языков
export type Language = 'ru' | 'en'

export const translations = {
  ru: {
    // Страницы аутентификации
    auth: {
      login: {
        title: 'Войдите в кабинет',
        subtitle: 'Управляйте событиями и аналитикой',
        email: 'Email',
        password: 'Пароль',
        submit: 'Войти',
        submitting: 'Входим...',
        noAccount: 'Нет аккаунта?',
        register: 'Зарегистрироваться',
        adminLink: 'Войти как администратор',
        showPassword: 'Показать пароль',
        hidePassword: 'Скрыть пароль',
      },
      register: {
        title: 'Создать аккаунт',
        subtitle: 'Начните управлять своими событиями',
        email: 'Email',
        password: 'Пароль',
        name: 'Имя',
        submit: 'Зарегистрироваться',
        submitting: 'Регистрируемся...',
        haveAccount: 'Уже есть аккаунт?',
        login: 'Войти',
      },
    },
    // Ошибки
    errors: {
      'Что-то пошло не так': 'Что-то пошло не так',
      'Не найдено': 'Не найдено. Проверьте правильность email и пароля',
      'Unauthorized': 'Неверный email или пароль',
      'already_exists': 'Этот email уже зарегистрирован',
      'invalid_email': 'Неверный формат email',
      'invalid_password': 'Пароль слишком короткий (минимум 8 символов)',
      'network_error': 'Ошибка сети. Проверьте подключение к интернету',
      'backend_unavailable': 'Сервер недоступен. Попробуйте позже',
      'fetch_failed': 'Ошибка при отправке данных',
    },
  },
  en: {
    // Authentication pages
    auth: {
      login: {
        title: 'Sign in',
        subtitle: 'Manage your events and analytics',
        email: 'Email',
        password: 'Password',
        submit: 'Sign in',
        submitting: 'Signing in...',
        noAccount: "Don't have an account?",
        register: 'Sign up',
        adminLink: 'Sign in as admin',
        showPassword: 'Show password',
        hidePassword: 'Hide password',
      },
      register: {
        title: 'Create account',
        subtitle: 'Start managing your events',
        email: 'Email',
        password: 'Password',
        name: 'Name',
        submit: 'Sign up',
        submitting: 'Signing up...',
        haveAccount: 'Already have an account?',
        login: 'Sign in',
      },
    },
    // Errors
    errors: {
      'Что-то пошло не так': 'Something went wrong',
      'Не найдено': 'Not found. Check your email and password',
      'Unauthorized': 'Invalid email or password',
      'already_exists': 'This email is already registered',
      'invalid_email': 'Invalid email format',
      'invalid_password': 'Password is too short (minimum 8 characters)',
      'network_error': 'Network error. Check your internet connection',
      'backend_unavailable': 'Server unavailable. Try again later',
      'fetch_failed': 'Error sending data',
    },
  },
}

// Определить язык пользователя
export function getUserLanguage(): Language {
  if (typeof window === 'undefined') return 'ru'
  const saved = localStorage.getItem('language') as Language
  if (saved) return saved
  const browserLang = navigator.language.split('-')[0]
  return (browserLang === 'en' ? 'en' : 'ru') as Language
}

// Установить язык
export function setUserLanguage(lang: Language) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('language', lang)
  }
}

// Получить перевод
export function t(path: string, lang: Language = getUserLanguage()): string {
  const keys = path.split('.')
  let value: any = translations[lang]

  for (const key of keys) {
    if (value && typeof value === 'object') {
      value = value[key]
    } else {
      return path // Вернуть исходный путь если перевод не найден
    }
  }

  return typeof value === 'string' ? value : path
}

// Перевести сообщение об ошибке с fallback на английский
export function translateError(message: string, lang: Language = getUserLanguage()): string {
  // Если сообщение содержит детали от бэкенда, попытаться распарсить
  const detail = message.includes('value_error') ? 'invalid_email' : message

  // Найти в переводах
  const translated = translations[lang].errors[detail as keyof typeof translations.ru.errors]
  if (translated) return translated

  // Fallback на английский если на русском не найдено
  if (lang === 'ru') {
    const enTranslated = translations.en.errors[detail as keyof typeof translations.en.errors]
    if (enTranslated) return enTranslated
  }

  // Вернуть исходное сообщение
  return message
}
