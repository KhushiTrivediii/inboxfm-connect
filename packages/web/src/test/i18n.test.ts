import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { i18n, i18nUtils } from '@/lib/i18n'

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every((val) => typeof val === 'string')
}

describe('i18n runtime and crowdin localization pipeline (#177)', () => {
  it('initializes i18n with English as the fallback and active language', () => {
    expect(i18n.isInitialized).toBe(true)
    expect(i18nUtils.getLanguage()).toBe('en')
  })

  it('translates core header and sidebar navigation keys and proves key existence', () => {
    const coreKeys = [
      'Overview',
      'Integrations',
      'Connections',
      'Actions',
      'Triggers',
      'Trigger Bindings',
      'Scheduled Tasks',
      'MCP Hub',
      'Activity',
      'Developers',
      'API Keys',
      'Settings',
      'Developer Console',
      'Search integrations, tools, routes...',
      'Dev Environment',
      'Sign out',
      'Developer',
      'InboxFM Main Project',
    ]

    for (const key of coreKeys) {
      // Prove that keys actually exist in the dictionary and do not pass vacuously
      expect(i18n.exists(key)).toBe(true)
      expect(i18n.t(key)).toBe(key)
    }

    // Confirm missing keys return false on existence checks
    expect(i18n.exists('non_existent_key_untranslated_12345')).toBe(false)
  })

  it('translates command palette resource-search keys and proves key existence', () => {
    const paletteKeys = [
      'Search resources, integrations, routes...',
      'Loading resources...',
      'No results found.',
      'Connections',
      'Trigger Bindings',
      'Scheduled Tasks',
      'Recent Executions',
      'Integrations',
      'Navigation',
      'Monitoring & Platform',
      'Overview Dashboard',
      'Integrations Catalog',
      'Connections & Credentials',
      'Actions & Tool Discovery',
      'Triggers & Event Capabilities',
      'MCP Server & Tools',
      'Activity & Execution Logs',
      'Developer SDK & API Reference',
      'Project Settings',
      'Command Palette',
      'Search for resources, integrations, and navigation commands',
    ]

    for (const key of paletteKeys) {
      expect(i18n.exists(key)).toBe(true)
      expect(i18n.t(key)).toBe(key)
    }

    // Interpolated fallback label for executions without a prompt
    expect(i18n.exists('Execution {{id}}...')).toBe(true)
    expect(i18n.t('Execution {{id}}...', { id: 'exec_abc' })).toBe('Execution exec_abc...')
  })

  it('changes language and falls back to English when a language bundle is absent', async () => {
    await i18nUtils.changeLanguage('fr')
    expect(i18nUtils.getLanguage()).toBe('fr')

    // With no French bundle present, translations fall back to English values
    expect(i18n.t('Overview')).toBe('Overview')
    expect(i18n.t('Developer')).toBe('Developer')

    // Also support object signature { language: 'en' }
    await i18nUtils.changeLanguage({ language: 'en' })
    expect(i18nUtils.getLanguage()).toBe('en')
  })

  it('validates crowdin.yml declares a real, valid source translation file', () => {
    const crowdinPath = path.resolve(__dirname, '../../../../crowdin.yml')
    expect(fs.existsSync(crowdinPath)).toBe(true)

    const crowdinContent = fs.readFileSync(crowdinPath, 'utf8')
    const sourceMatch = crowdinContent.match(/source:\s*(packages\/web\/public\/locales\/en\/translation\.json)/)
    expect(sourceMatch).not.toBeNull()

    const relativeSource = sourceMatch![1]
    const absoluteSource = path.resolve(__dirname, '../../../../', relativeSource)
    expect(fs.existsSync(absoluteSource)).toBe(true)

    const rawJson = fs.readFileSync(absoluteSource, 'utf8')
    const parsed: unknown = JSON.parse(rawJson)

    // Validate type using type guard without casting
    expect(isStringRecord(parsed)).toBe(true)
    if (!isStringRecord(parsed)) {
      throw new Error('Parsed translation file is not a valid Record<string, string>')
    }

    expect(Object.keys(parsed).length).toBeGreaterThan(2000)

    // Key UI strings must exist in the source translation file
    expect(parsed['Overview']).toBe('Overview')
    expect(parsed['Integrations']).toBe('Integrations')
    expect(parsed['Connections']).toBe('Connections')
    expect(parsed['Scheduled Tasks']).toBe('Scheduled Tasks')
    expect(parsed['Trigger Bindings']).toBe('Trigger Bindings')
    expect(parsed['Search integrations, tools, routes...']).toBe('Search integrations, tools, routes...')
    expect(parsed['InboxFM Main Project']).toBe('InboxFM Main Project')
  })
})
