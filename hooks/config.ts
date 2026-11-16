import type { EngineInterface } from 'claude-code'

import { DEFAULT_CONFIG, sanitizeConfig } from './settings'
import type { HubConfig } from './settings'
import type { Platform } from './terminal'

export const DATA_DIR = 'lookout'
export const LEGACY_DATA_DIRS = ['hub', 'docket'] as const

export async function homeDir($: EngineInterface): Promise<string | null> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? null
}

export async function hubFile($: EngineInterface, ...parts: string[]): Promise<string | null> {
  const home = await homeDir($)
  return home ? [home, '.claude', DATA_DIR, ...parts].join('/') : null
}

export type { Platform } from './terminal'
let platformCache: Platform | null = null

export async function platform($: EngineInterface): Promise<Platform> {
  if (platformCache) return platformCache
  if (await $.env.get('USERPROFILE')) {
    platformCache = 'windows'
    return platformCache
  }
  try {
    const result = await $.process.run(['uname', '-s'], { timeoutMs: 3000 })
    platformCache = result.stdout.trim() === 'Darwin' ? 'mac' : 'linux'
  } catch {
    platformCache = 'linux'
  }
  return platformCache
}

const CONFIG_TTL_MS = 10_000
let configCache: { at: number; value: HubConfig } | null = null

export async function loadConfig($: EngineInterface): Promise<HubConfig> {
  const now = await $.clock.now()
  if (configCache && now - configCache.at < CONFIG_TTL_MS) return configCache.value
  let value = DEFAULT_CONFIG
  try {
    const path = await hubFile($, 'config.json')
    if (path) value = sanitizeConfig(JSON.parse(await $.fs.read(path)))
  } catch {}
  configCache = { at: now, value }
  return value
}

export async function saveConfig($: EngineInterface, change: (config: HubConfig) => HubConfig): Promise<void> {
  configCache = null
  const next = sanitizeConfig(change(structuredClone(await loadConfig($))))
  const path = await hubFile($, 'config.json')
  if (!path) return
  await $.fs.write(path, `${JSON.stringify(next, null, 2)}\n`)
  configCache = { at: await $.clock.now(), value: next }
}
