import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const localesRoot = join(root, 'src/locales')
const baseLocale = 'en'
const translatedLocales = ['zh', 'zh-TW', 'ja', 'ko', 'th', 'es']
const allLocales = [baseLocale, ...translatedLocales]
const namespaces = [
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
]
const localeValues = Object.fromEntries(
  allLocales.map((locale) => [
    locale,
    Object.fromEntries(namespaces.map((namespace) => [namespace, readLocaleJson(locale, namespace)])),
  ]),
)

for (const namespace of namespaces) {
  const value = localeValues[baseLocale][namespace]
  const keys = flattenKeys(value)

  for (const key of keys) {
    if (typeof readPath(value, key) !== 'string') {
      throw new Error(`${baseLocale}/${namespace}.json contains a non-string leaf at ${key}`)
    }
  }

  for (const locale of translatedLocales) {
    const translated = localeValues[locale][namespace]
    const translatedKeys = flattenKeys(translated)

    for (const key of translatedKeys) {
      if (typeof readPath(translated, key) !== 'string') {
        throw new Error(`${locale}/${namespace}.json contains a non-string leaf at ${key}`)
      }
    }

    assertSameKeys(`${baseLocale}/${namespace}.json`, keys, `${locale}/${namespace}.json`, translatedKeys)
  }
}

const allLocaleKeys = new Set(
  namespaces.flatMap((namespace) => flattenKeys(localeValues[baseLocale][namespace])),
)
const sourceFiles = walk(join(root, 'src')).filter((filePath) => /\.(ts|tsx)$/.test(filePath))
const usedLiteralKeys = collectUsedLiteralKeys(join(root, 'src'))
const missing = usedLiteralKeys.filter((key) => !hasLocaleKey(allLocaleKeys, key))
const languageSwitcherSource = readFileSync(
  join(root, 'src/components/i18n/LanguageSwitcher.tsx'),
  'utf8',
)

if (missing.length > 0) {
  throw new Error(`Missing English i18n keys:\n${missing.map((key) => `  - ${key}`).join('\n')}`)
}

validateLanguageSwitcher(languageSwitcherSource)
const hardcodedCopyFindings = collectHardcodedEnglishCopy(sourceFiles)
const criticalGroups = validateCriticalKeyGroups()
const fallbackGate = collectEnglishFallbacks()
const fallbackFindings = fallbackGate.findings

if (hardcodedCopyFindings.length > 0) {
  throw new Error(
    [
      'Hardcoded English UI copy found. Move visible copy into locale JSON before shipping:',
      ...hardcodedCopyFindings.map(
        (finding) => `  - ${finding.file}:${finding.line} ${finding.kind}: "${finding.text}"`,
      ),
    ].join('\n'),
  )
}

if (fallbackFindings.length > 0) {
  throw new Error(
    [
      'Non-English locales contain English fallback copy. Translate these locale values:',
      ...fallbackFindings.map(
        (finding) => `  - ${finding.locale}/${finding.namespace}.json ${finding.key}: "${finding.text}"`,
      ),
    ].join('\n'),
  )
}

console.log(
  [
    `Open-source Dashboard i18n validated: ${allLocales.join(', ')} locales, ${namespaces.length} namespaces, ${usedLiteralKeys.length} literal keys.`,
    `Quality gates: ${sourceFiles.length} TS/TSX files scanned for hardcoded English UI copy; ${criticalGroups.checklist} checklist keys, ${criticalGroups.sidebar} sidebar keys, and ${criticalGroups.onboarding} onboarding keys verified across all locales; English fallback scan covered ${fallbackGate.comparisons} translated values with ${fallbackGate.allowed} technical literals allowed.`,
  ].join('\n'),
)

function readLocaleJson(locale, namespace) {
  const filePath = join(localesRoot, locale, `${namespace}.json`)

  if (!existsSync(filePath)) {
    throw new Error(`Missing locale file: ${filePath}`)
  }

  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function flattenKeys(value, prefix = '') {
  return Object.entries(value)
    .flatMap(([key, nested]) => {
      const path = prefix ? `${prefix}.${key}` : key

      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return flattenKeys(nested, path)
      }

      return [path]
    })
    .sort()
}

function readPath(value, path) {
  if (Object.prototype.hasOwnProperty.call(value, path)) {
    return value[path]
  }

  return path.split('.').reduce((current, key) => current?.[key], value)
}

function hasLocaleKey(keys, key) {
  if (key.includes(':')) {
    return hasLocaleKey(keys, key.split(':').slice(1).join(':'))
  }

  return keys.has(key) || keys.has(`${key}_one`) || keys.has(`${key}_other`)
}

function collectUsedLiteralKeys(srcRoot) {
  const keys = new Set()
  const pattern = /\bt\(\s*['"]([^'"]+)['"]/g

  for (const filePath of sourceFiles.length > 0 ? sourceFiles : walk(srcRoot).filter((path) => /\.(ts|tsx)$/.test(path))) {
    const source = readFileSync(filePath, 'utf8')
    for (const match of source.matchAll(pattern)) {
      keys.add(match[1])
    }
  }

  return Array.from(keys).sort()
}

function collectHardcodedEnglishCopy(files) {
  const findings = []
  const visibleAttributeNames = new Set(['aria-label', 'alt', 'label', 'placeholder', 'title'])

  for (const filePath of files) {
    const source = readFileSync(filePath, 'utf8')
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )

    visit(sourceFile)

    function visit(node) {
      if (ts.isJsxText(node)) {
        addFinding('jsx text', node, node.getText(sourceFile))
      }

      if (
        ts.isJsxExpression(node) &&
        node.expression &&
        (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression))
      ) {
        addFinding('jsx expression', node.expression, node.expression.text)
      }

      if (
        ts.isJsxAttribute(node) &&
        visibleAttributeNames.has(node.name.getText(sourceFile)) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
      ) {
        addFinding(`${node.name.getText(sourceFile)} attribute`, node.initializer, node.initializer.text)
      }

      ts.forEachChild(node, visit)
    }

    function addFinding(kind, node, value) {
      const text = normalizeCopy(value)
      if (!looksLikeEnglishUiCopy(text)) {
        return
      }

      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      findings.push({
        file: filePath.replace(`${root}/`, ''),
        line: position.line + 1,
        kind,
        text,
      })
    }
  }

  return findings
}

function collectEnglishFallbacks() {
  const findings = []
  let comparisons = 0
  let allowed = 0

  for (const namespace of namespaces) {
    const english = localeValues[baseLocale][namespace]
    const keys = flattenKeys(english)

    for (const key of keys) {
      const englishValue = readPath(english, key)
      if (!looksLikeEnglishUiCopy(englishValue)) {
        continue
      }

      for (const locale of translatedLocales) {
        const translatedValue = readPath(localeValues[locale][namespace], key)
        comparisons += 1

        if (translatedValue === englishValue) {
          if (isAllowedIdenticalLocaleValue(key, englishValue)) {
            allowed += 1
            continue
          }

          findings.push({ locale, namespace, key, text: englishValue })
        }
      }
    }
  }

  return { findings, comparisons, allowed }
}

function validateCriticalKeyGroups() {
  const sidebarSource = readFileSync(join(root, 'src/components/layout/Sidebar.tsx'), 'utf8')
  const dashboardSource = readFileSync(join(root, 'src/pages/DashboardPage.tsx'), 'utf8')
  const checklistKeys = collectTKeys(dashboardSource).filter(
    (key) => key.startsWith('onboarding.steps.') ||
      key.startsWith('onboarding.actions.') ||
      key.startsWith('onboarding.status.') ||
      key.startsWith('onboarding.docs.') ||
      key.startsWith('onboarding.summary.') ||
      key === 'onboarding.title' ||
      key === 'onboarding.description' ||
      key === 'onboarding.progress' ||
      key === 'onboarding.privacy' ||
      key === 'onboarding.values.pending',
  )
  const sidebarKeys = [
    ...collectLabelKeys(sidebarSource),
    ...collectTKeys(sidebarSource).filter(
      (key) => key.startsWith('nav.') || key.startsWith('sidebar.') || key.startsWith('status.') || key.startsWith('action.'),
    ),
  ]
  const onboardingKeys = []

  for (const filePath of sourceFiles) {
    const source = readFileSync(filePath, 'utf8')
    onboardingKeys.push(...collectTKeys(source).filter((key) => key.includes('onboarding')))
  }

  assertCriticalKeys('Dashboard checklist', checklistKeys)
  assertCriticalKeys('Sidebar navigation', sidebarKeys)
  assertCriticalKeys('Onboarding copy', onboardingKeys)

  return {
    checklist: new Set(checklistKeys).size,
    sidebar: new Set(sidebarKeys).size,
    onboarding: new Set(onboardingKeys).size,
  }

  function assertCriticalKeys(label, keys) {
    const uniqueKeys = Array.from(new Set(keys)).sort()
    if (uniqueKeys.length === 0) {
      throw new Error(`${label} i18n gate did not find any keys to validate.`)
    }

    for (const key of uniqueKeys) {
      const namespace = namespaceForKey(key)
      if (!namespace) {
        throw new Error(`${label} key is not present in the English locale matrix: ${key}`)
      }

      for (const locale of allLocales) {
        const value = readPath(localeValues[locale][namespace], stripNamespacePrefix(key))
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new Error(`${label} key is missing in ${locale}/${namespace}.json: ${key}`)
        }
      }
    }
  }
}

function collectTKeys(source) {
  return Array.from(source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g), (match) => match[1])
}

function collectLabelKeys(source) {
  return Array.from(source.matchAll(/\blabelKey:\s*['"]([^'"]+)['"]/g), (match) => match[1])
}

function namespaceForKey(key) {
  const normalizedKey = stripNamespacePrefix(key)
  return namespaces.find((namespace) => {
    const keys = flattenKeys(localeValues[baseLocale][namespace])
    return hasLocaleKey(new Set(keys), normalizedKey)
  })
}

function stripNamespacePrefix(key) {
  return key.includes(':') ? key.split(':').slice(1).join(':') : key
}

function normalizeCopy(value) {
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/\{\{[^}]+\}\}/g, '')
    .trim()
}

function looksLikeEnglishUiCopy(value) {
  if (typeof value !== 'string') {
    return false
  }

  const text = normalizeCopy(value)
  if (text.length < 18) {
    return false
  }

  if (/^https?:\/\//.test(text) || /^[A-Z0-9_./:-]+$/.test(text)) {
    return false
  }

  const words = text.match(/[A-Za-z][A-Za-z']+/g) || []
  if (words.length < 3) {
    return false
  }

  const lowerCaseWords = words.filter((word) => /[a-z]/.test(word)).length
  return lowerCaseWords >= 2
}

function isAllowedIdenticalLocaleValue(key, value) {
  const text = normalizeCopy(value)

  return (
    key.endsWith('.configFile') ||
    text === 'gateway.config.yaml' ||
    text === 'Chat Completions (OpenAI)' ||
    /^gpt-[\w.-]+/.test(text) ||
    text.includes('claude-') ||
    text.startsWith('{') ||
    key.includes('placeholders.routingHint') ||
    key.includes('placeholders.directModel')
  )
}

function validateLanguageSwitcher(source) {
  for (const languageName of [
    'English',
    '简体中文',
    '繁體中文',
    '日本語',
    '한국어',
    'ไทย',
    'Español',
  ]) {
    if (!readFileSync(join(root, 'src/i18n.ts'), 'utf8').includes(`name: '${languageName}'`)) {
      throw new Error(`Missing supported language label: ${languageName}`)
    }
  }

  if (!source.includes('localStorage.setItem(localeStorageKey, locale)')) {
    throw new Error('LanguageSwitcher must persist selections to localStorage.')
  }

  if (!source.includes('role="menu"') || !source.includes('role="menuitemradio"')) {
    throw new Error('LanguageSwitcher must expose the language list as an accessible menu.')
  }

  if (source.includes('<select')) {
    throw new Error('LanguageSwitcher should use the unified click-to-expand menu, not <select>.')
  }
}

function assertSameKeys(baseLabel, baseKeys, translatedLabel, translatedKeys) {
  const baseSet = new Set(baseKeys)
  const translatedSet = new Set(translatedKeys)
  const missing = baseKeys.filter((key) => !translatedSet.has(key))
  const extra = translatedKeys.filter((key) => !baseSet.has(key))

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      [
        `${translatedLabel} keys do not match ${baseLabel}.`,
        missing.length > 0 ? `Missing:\n${missing.map((key) => `  - ${key}`).join('\n')}` : '',
        extra.length > 0 ? `Extra:\n${extra.map((key) => `  - ${key}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const filePath = join(dir, entry)
    const stats = statSync(filePath)
    return stats.isDirectory() ? walk(filePath) : [filePath]
  })
}
