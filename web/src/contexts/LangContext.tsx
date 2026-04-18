'use client'
import { createContext, useContext, useState, useEffect } from 'react'
import { ru } from '@/i18n/ru'
import { en } from '@/i18n/en'

export type Lang = 'ru' | 'en'
export type Dict = typeof ru

const dicts = { ru, en } as const

const LangContext = createContext<{
  lang: Lang
  t: Dict
  setLang: (l: Lang) => void
}>({ lang: 'ru', t: ru, setLang: () => {} })

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('ru')

  useEffect(() => {
    const saved = localStorage.getItem('plusson_lang') as Lang | null
    if (saved === 'en' || saved === 'ru') setLangState(saved)
  }, [])

  function setLang(l: Lang) {
    setLangState(l)
    localStorage.setItem('plusson_lang', l)
  }

  return (
    <LangContext.Provider value={{ lang, t: dicts[lang], setLang }}>
      {children}
    </LangContext.Provider>
  )
}

export function useLang() {
  return useContext(LangContext)
}
