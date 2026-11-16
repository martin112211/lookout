import type { EngineInterface } from 'claude-code'

import { homeDir } from './config'

const TTL_MS = 60_000
let cache: { at: number; names: Set<string> } | null = null

export async function installedPlugins($: EngineInterface): Promise<Set<string>> {
  const now = await $.clock.now()
  if (cache && now - cache.at < TTL_MS) return cache.names
  const names = new Set<string>()
  try {
    const home = await homeDir($)
    if (home) {
      const installed = JSON.parse(await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`)) as { plugins?: Record<string, unknown> }
      let enabled: Record<string, boolean> = {}
      try {
        enabled = (JSON.parse(await $.fs.read(`${home}/.claude/settings.json`)) as { enabledPlugins?: Record<string, boolean> }).enabledPlugins ?? {}
      } catch {}
      for (const id of Object.keys(installed.plugins ?? {})) {
        if (enabled[id] === false) continue
        names.add(id.split('@')[0] ?? id)
      }
    }
  } catch {}
  cache = { at: now, names }
  return names
}
