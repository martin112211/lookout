import type { EngineInterface } from 'claude-code'

import { hubFile, homeDir, loadConfig } from './config'

const DAY_MS = 24 * 60 * 60_000

let ownVersion: string | null = null
export async function pluginVersion($: EngineInterface): Promise<string> {
  if (ownVersion) return ownVersion
  try {
    ownVersion = String((JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }).version ?? '0.0.0')
  } catch {
    ownVersion = '0.0.0'
  }
  return ownVersion
}

export type UpdateInfo = { checkedAt: number; latest?: string; how?: string; error?: string }

// A running server without a version predates the handshake, so it counts as older.
export function isOlderVersion(running: string | undefined, installed: string): boolean {
  if (!running) return true
  const a = running.split('.').map(part => Number.parseInt(part, 10) || 0)
  const b = installed.split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}

/** Highest release in `git ls-remote --tags` output: `v1.2.3` or `lookout--v1.2.3` (as `claude plugin tag` names them). */
export function latestTag(lsRemote: string): string | undefined {
  let best: string | undefined
  for (const line of lsRemote.split(/\r?\n/)) {
    const match = /refs\/tags\/(?:lookout--)?v(\d+\.\d+\.\d+)$/.exec(line.trim())
    const found = match?.[1]
    if (found && (!best || isOlderVersion(best, found))) best = found
  }
  return best
}

type Source = { url: string; how: string }

async function updateSource($: EngineInterface): Promise<Source | null> {
  const home = await homeDir($)
  try {
    const known = JSON.parse(await $.fs.read(`${home}/.claude/plugins/known_marketplaces.json`)) as Record<string, { source?: { source?: string; repo?: string; url?: string } }>
    const source = known.lookout?.source
    const how = 'claude plugin marketplace update lookout, then claude plugin update lookout@lookout'
    if (source?.source === 'github' && source.repo && /^[\w.-]+\/[\w.-]+$/.test(source.repo)) return { url: `https://github.com/${source.repo}.git`, how }
    if (source?.url && /^https:\/\//.test(source.url)) return { url: source.url, how }
  } catch {}
  const origin = await $.process.run(['git', '-C', $.plugin.root, 'remote', 'get-url', 'origin'], { timeoutMs: 5000 }).catch(() => null)
  const url = origin?.exitCode === 0 ? origin.stdout.trim() : ''
  return /^https:\/\//.test(url) ? { url, how: `git pull in ${$.plugin.root}` } : null
}

/** At most once a day and only when switched on: the newest release tag of the repository Lookout came from. */
export async function checkForUpdate($: EngineInterface): Promise<UpdateInfo | null> {
  if (!(await loadConfig($)).features.updateCheck.on) return null
  const path = await hubFile($, 'update.json')
  if (!path) return null
  let saved: UpdateInfo | null = null
  try {
    saved = JSON.parse(await $.fs.read(path)) as UpdateInfo
  } catch {}
  const now = await $.clock.now()
  if (saved && now - saved.checkedAt < DAY_MS) return saved
  const source = await updateSource($)
  const info: UpdateInfo = { checkedAt: now, how: source?.how }
  if (!source) info.error = 'no https source to check'
  else {
    const result = await $.process
      .run(['git', 'ls-remote', '--tags', '--refs', source.url], { timeoutMs: 15_000, env: { GIT_TERMINAL_PROMPT: '0' } })
      .catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
    if (result.exitCode === 0) info.latest = latestTag(result.stdout)
    else info.error = result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 200) || `exit ${result.exitCode}`
  }
  await $.fs.write(path, `${JSON.stringify(info)}\n`)
  return info
}

/** The newer version to point at, from the last check; nothing when the check is off or this one is current. */
export async function availableUpdate($: EngineInterface): Promise<string | undefined> {
  if (!(await loadConfig($)).features.updateCheck.on) return undefined
  const path = await hubFile($, 'update.json')
  if (!path) return undefined
  try {
    const saved = JSON.parse(await $.fs.read(path)) as UpdateInfo
    return saved.latest && isOlderVersion(await pluginVersion($), saved.latest) ? saved.latest : undefined
  } catch {
    return undefined
  }
}
