import { atom, read, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'
import type { On } from './on'

import type { HubCounts, Snapshot } from '../types'
import { basename, parseGit, segments, statusRows, widthOf } from './format'
import { paletteFor } from './palettes'
import type { CustomSkin } from './palettes'
import { hubFile, loadConfig } from './config'
import { installedPlugins } from './integrations'
import { availableUpdate } from './update'

export const snapshot = atom({ plugin: 'lookout', key: 'statusSnapshot' } as const, null as Snapshot | null)
const cacheTaxText = atom({ plugin: 'lookout', key: 'cacheTaxText' } as const, null as string | null)

async function cacheTaxShown($: EngineInterface): Promise<boolean> {
  const f = (await loadConfig($)).features
  return f.statusLine.on && f.cacheTax.on && (await installedPlugins($)).has('cache-tax')
}

type SkinsView = { prefs?: { skin?: string }; custom?: Record<string, CustomSkin>; isLight?: boolean }

async function readSkins($: EngineInterface): Promise<SkinsView> {
  const view: SkinsView = {}
  try {
    view.prefs = ((await $.state.get({ plugin: 'skins', key: 'prefs' } as never)) as { value?: SkinsView['prefs'] }).value
    view.custom = ((await $.state.get({ plugin: 'skins', key: 'custom' } as never)) as { value?: SkinsView['custom'] }).value
    view.isLight = ((await $.state.get({ plugin: 'skins', key: 'isLight' } as never)) as { value?: boolean }).value
  } catch {}
  return view
}

async function skinsShown($: EngineInterface): Promise<boolean> {
  return (await loadConfig($)).features.skinsColors.on && (await installedPlugins($)).has('skins')
}


const REFRESH_MS = 30_000

async function gitInfo($: EngineInterface, cwd: string) {
  try {
    const { exitCode, stdout } = await $.process.run(
      ['git', '-C', cwd, '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
      { timeoutMs: 2000 },
    )
    return exitCode === 0 ? parseGit(stdout) : undefined
  } catch {
    return undefined
  }
}

type HubSummary = { at: number; sessions: { sessionId: string; status?: string; waitingOnPerson?: boolean }[] }

async function hubCounts($: EngineInterface): Promise<HubCounts | undefined> {
  try {
    const path = await hubFile($, 'summary.json')
    if (!path) return undefined
    const summary = JSON.parse(await $.fs.read(path)) as HubSummary
    if ((await $.clock.now()) - summary.at > 5 * 60_000) return undefined
    const self = await $.session.id()
    const others = summary.sessions.filter(one => one.sessionId !== self)
    return {
      others: others.length,
      waiting: others.filter(one => one.waitingOnPerson).length,
      working: others.filter(one => !one.waitingOnPerson && one.status === 'busy').length,
    }
  } catch {
    return undefined
  }
}

async function refresh($: EngineInterface) {
  if (!(await loadConfig($)).features.statusLine.on) return
  const cacheTax = (await cacheTaxShown($)) ? ((await read($, cacheTaxText)) ?? undefined) : undefined
  const [model, cwd, usage, hub, newer] = await Promise.all([
    $.session.model().catch(() => undefined),
    $.session.cwd().catch(() => undefined),
    $.session.usage().catch(() => undefined),
    hubCounts($),
    availableUpdate($),
  ])
  const next: Snapshot = {
    model,
    folder: cwd ? basename(cwd) : undefined,
    git: cwd ? await gitInfo($, cwd) : undefined,
    ctx:
      usage?.context.percent !== undefined
        ? { percent: usage.context.percent, tokens: usage.context.tokens }
        : undefined,
    limits: (usage?.rateLimits ?? []).map(l => ({ kind: l.kind, percent: l.percentUsed, resetsAt: l.resetsAt })),
    costUsd: usage?.cost?.usd,
    hub,
    cacheTax,
    update: newer,
  }
  await update($, snapshot, () => next)
}

const quietly = (p: Promise<unknown>) => p.catch(() => undefined)


let timer: Timer | undefined

export async function statusStart($: EngineInterface): Promise<void> {
  timer?.cancel()
  timer = $.clock.every(REFRESH_MS, () => void quietly(refresh($)))
  await quietly(refresh($))
}

export async function statusTurn($: EngineInterface): Promise<void> {
  await quietly(refresh($))
}

export function statusAfterTool($: EngineInterface): void {
  void quietly(refresh($))
}

export const registerStatus = (on: On): void => {

  // The hint line under the prompt: the status first, the engine's hint dimmed after it.
  on('ui.status', async ($, e, next) => {
    if (next.origin.plugin !== 'cache-tax' || !(await cacheTaxShown($))) return next(e)
    const text = e.text?.replace(/\s+/g, ' ').trim() || null
    await update($, cacheTaxText, () => text)
    void quietly(refresh($))
    return { value: undefined }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!(await loadConfig($)).features.statusLine.on) return next(e)
    const s = await read($, snapshot)
    if (s === null) return next(e)

    const useSkins = await skinsShown($)
    const { prefs, custom, isLight } = useSkins ? await readSkins($) : ({} as SkinsView)
    const palette = paletteFor(prefs?.skin ?? 'gruvbox', custom ?? {}, isLight ?? false)

    const { Box, Text } = $.ui.resolve(e)
    const groups = segments(s, new Date())

    // The engine draws marks beside this line, so keep a margin off the terminal's width.
    const hint = e.props.hint ? `   ${e.props.hint}` : ''
    const rows = statusRows(groups, (e.viewport?.columns ?? 200) - 12, [...hint].length)
    // On two rows the engine's hint goes to the shorter one, usually the first.
    const hintRow = rows.length === 2 && widthOf(groups, rows[0] ?? []) <= widthOf(groups, rows[1] ?? []) ? 0 : rows.length - 1
    return (
      <Box flexDirection="column">
        {rows.map((row, r) => (
          <Text key={`row${r}`} wrap="truncate-end">
            {row.flatMap((i, k) => [
              ...(k ? [<Text key={`sep${i}`} color={palette.muted} dimColor>{' │ '}</Text>] : []),
              ...(groups[i] ?? []).map((seg, j) => (
                <Text key={`${i}.${j}`} color={palette[seg.slot]} bold={seg.bold} dimColor={seg.dim}>
                  {seg.text}
                </Text>
              )),
            ])}
            {r === hintRow && hint ? (
              <Text key="hint" color={palette.muted} dimColor>
                {hint}
              </Text>
            ) : null}
          </Text>
        ))}
      </Box>
    )
  })
}
