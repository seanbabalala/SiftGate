import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

export const defaultLocale = 'en'
export const localeStorageKey = 'siftgate-dashboard-locale'
export const localeNamespaces = [
  'common',
  'dashboard',
  'alerts',
  'pricing',
  'logs',
  'nodes',
  'routing',
  'budget',
  'analytics',
  'agents',
  'apiKeys',
  'login',
] as const

export const supportedLocales = [
  { code: 'en', flag: '🇺🇸', name: 'English', shortName: 'EN' },
  { code: 'zh', flag: '🇨🇳', name: '简体中文', shortName: '简' },
  { code: 'zh-TW', flag: '🇹🇼', name: '繁體中文', shortName: '繁' },
  { code: 'ja', flag: '🇯🇵', name: '日本語', shortName: 'JA' },
  { code: 'ko', flag: '🇰🇷', name: '한국어', shortName: 'KO' },
  { code: 'th', flag: '🇹🇭', name: 'ไทย', shortName: 'TH' },
  { code: 'es', flag: '🇪🇸', name: 'Español', shortName: 'ES' },
] as const

export type SupportedLocale = (typeof supportedLocales)[number]['code']
type LocaleNamespace = (typeof localeNamespaces)[number]
type LocaleResourceBundle = Record<LocaleNamespace, Record<string, unknown>>
type LocaleJsonModule = { default: Record<string, unknown> }

export const supportedLocaleCodes = supportedLocales.map((locale) => locale.code)
const localeLoaders = import.meta.glob('./locales/*/*.json') as Record<
  string,
  () => Promise<LocaleJsonModule>
>
const loadedLocales = new Set<SupportedLocale>()

export function isSupportedLocale(value: string): value is SupportedLocale {
  return supportedLocaleCodes.includes(value as SupportedLocale)
}

export function normalizeLocale(value: string | undefined | null): SupportedLocale {
  if (!value) {
    return defaultLocale
  }

  const normalized = value.replace('_', '-')
  if (isSupportedLocale(normalized)) {
    return normalized
  }

  const languageOnly = normalized.split('-')[0]
  return isSupportedLocale(languageOnly) ? languageOnly : defaultLocale
}

export const i18nReady = initializeI18n()

export async function ensureLocaleResources(locale: SupportedLocale): Promise<void> {
  if (loadedLocales.has(locale)) {
    return
  }
  const resources = await loadLocaleResources(locale)
  for (const [namespace, bundle] of Object.entries(resources)) {
    i18n.addResourceBundle(locale, namespace, bundle, true, true)
  }
  loadedLocales.add(locale)
}

export async function changeDashboardLanguage(locale: string): Promise<void> {
  const normalized = normalizeLocale(locale)
  await ensureLocaleResources(normalized)
  await i18n.changeLanguage(normalized)
}

async function initializeI18n(): Promise<void> {
  const initialLocale = detectInitialLocale()
  const resources: Partial<Record<SupportedLocale, LocaleResourceBundle>> = {
    [defaultLocale]: await loadLocaleResources(defaultLocale),
  }
  loadedLocales.add(defaultLocale)

  if (initialLocale !== defaultLocale) {
    resources[initialLocale] = await loadLocaleResources(initialLocale)
    loadedLocales.add(initialLocale)
  }

  await i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      defaultNS: 'common',
      detection: {
        caches: ['localStorage'],
        lookupLocalStorage: localeStorageKey,
        order: ['localStorage', 'navigator', 'htmlTag'],
      },
      fallbackLng: defaultLocale,
      interpolation: {
        escapeValue: false,
      },
      lng: initialLocale,
      keySeparator: false,
      load: 'currentOnly',
      lowerCaseLng: false,
      ns: localeNamespaces,
      resources,
      returnNull: false,
      supportedLngs: supportedLocaleCodes,
    })

  setDocumentLocale(i18n.language)
}

async function loadLocaleResources(locale: SupportedLocale): Promise<LocaleResourceBundle> {
  const entries = await Promise.all(
    localeNamespaces.map(async (namespace) => {
      const loader = localeLoaders[`./locales/${locale}/${namespace}.json`]
      if (!loader) {
        throw new Error(`Missing locale bundle: ${locale}/${namespace}`)
      }
      const module = await loader()
      return [namespace, module.default] as const
    }),
  )
  return Object.fromEntries(entries) as LocaleResourceBundle
}

function detectInitialLocale(): SupportedLocale {
  if (typeof window === 'undefined') {
    return defaultLocale
  }

  const storedLocale = window.localStorage.getItem(localeStorageKey)
  if (storedLocale) {
    return normalizeLocale(storedLocale)
  }

  const navigatorLocale = window.navigator.languages?.[0] || window.navigator.language
  return normalizeLocale(navigatorLocale || document.documentElement.lang)
}

function setDocumentLocale(locale: string | undefined): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = normalizeLocale(locale)
  }
}

i18n.on('languageChanged', (locale) => {
  setDocumentLocale(locale)
})

export { i18n }
