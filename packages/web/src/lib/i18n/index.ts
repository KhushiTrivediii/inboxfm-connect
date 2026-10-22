import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import HttpBackend from 'i18next-http-backend'
import { initReactI18next } from 'react-i18next'
import enTranslation from '../../../public/locales/en/translation.json'

const defaultLanguage = 'en'

const resources = {
  en: {
    translation: enTranslation,
  },
}

void i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: defaultLanguage,
    load: 'languageOnly',
    resources,
    backend: {
      loadPath: '/locales/{{lng}}/{{ns}}.json',
    },
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
    returnNull: false,
  })

function changeLanguage(arg: string | { language: string }): Promise<unknown> {
  const language = typeof arg === 'string' ? arg : arg.language
  return i18n.changeLanguage(language)
}

function getLanguage(): string {
  const lang = i18n.language || defaultLanguage
  return lang.split('-')[0]
}

export const i18nUtils = {
  changeLanguage,
  getLanguage,
}

export { i18n }
export default i18n
